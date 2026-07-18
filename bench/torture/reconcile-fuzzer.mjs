/**
 * bench/torture/reconcile-fuzzer.mjs — seeded, oracle-checked reconcile() soak.
 *
 * Not a benchmark — CRASH + CORRECTNESS detection for reconcile(s, next, opts?):
 *
 *   - STRUCTURAL FUZZ  random deep mutations (leaf edits, key add/remove, array
 *     push/pop/splice/reorder, shape flips); after every step snapshot(s) must
 *     deep-equal the oracle `next`.
 *   - KEYED IDENTITY   a keyed array under random insert/remove/reorder must stay
 *     correctly ordered AND every surviving row must keep its target identity (the
 *     zero-GC keyed promise: a moved row is patched in place, not rebuilt).
 *   - DUPLICATE KEYS   a keyed array whose keys are drawn from a SMALL keyspace
 *     (so duplicates are routine) must keep every slot independent — patching
 *     rows[i] must never bleed into rows[j] via a shared target.
 *   - ZERO-GC REFETCH  a long run of same-shape refetches (only leaf values change)
 *     must not grow the signal pool.
 *   - BOUNDED CHURN    a feed that pushes and sheds rows to hold a fixed cap must
 *     hold a flat node ledger under a HARD-CEILING registry — shrink paths have to
 *     return their signals, not merely stop firing them.
 *   - HOSTILE PAYLOAD  reconcile() is the "apply the server refetch" path, so its
 *     input is untrusted by construction: `__proto__` in a JSON body must not
 *     reach Object.prototype.
 *
 * Exit code: 0 on clean run, 1 on any assertion failure.
 * Usage: node bench/torture/reconcile-fuzzer.mjs        (TORTURE_SCALE=10 to crank)
 *
 * NOTE: the roomy onCapacityExceeded:"grow" default registry keeps the structural
 * fuzz from colliding with the 1,024-node ceiling — but a growable pool turns a
 * hard leak into an invisible bleed, so every scenario that asserts pool maths
 * installs its own fixed-ceiling registry via inRegistry() instead.
 */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { effect, stats, createRegistry, setDefaultRegistry } from "@zakkster/lite-signal";
import { store, unwrap, snapshot, dispose, reconcile } from "../../Store.js";

const GROW = () => createRegistry({ maxNodes: 1 << 20, maxLinks: 1 << 22, onCapacityExceeded: "grow" });
setDefaultRegistry(GROW());
const SCALE = Math.max(1, Number(process.env.TORTURE_SCALE) || 1);

/** Run `fn` against an isolated fixed-ceiling registry, then hand the pool back. */
function inRegistry(config, fn) {
    setDefaultRegistry(createRegistry(config));
    try { return fn(); } finally { setDefaultRegistry(GROW()); }
}

function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const ri = (rand, n) => Math.floor(rand() * n);

function randLeaf(rand) {
    const k = ri(rand, 4);
    if (k === 0) return ri(rand, 1000);
    if (k === 1) return rand() < 0.5;
    if (k === 2) return "s" + ri(rand, 100);
    return null;
}
function randValue(rand, depth) {
    if (depth <= 0 || rand() < 0.45) return randLeaf(rand);
    if (rand() < 0.5) {
        const a = []; for (let i = 0, n = ri(rand, 5); i < n; i++) a.push(randValue(rand, depth - 1)); return a;
    }
    const o = {}; for (let i = 0, n = ri(rand, 5); i < n; i++) o["k" + i] = randValue(rand, depth - 1); return o;
}
function mutate(rand, root) {
    const next = clone(root);
    for (let s = 0, steps = 1 + ri(rand, 4); s < steps; s++) mutateOnce(rand, { box: next }, "box", 3);
    return next;
}
function mutateOnce(rand, parent, key, budget) {
    const node = parent[key];
    if (budget > 0 && node && typeof node === "object") {
        const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
        if (keys.length && rand() < 0.6) return mutateOnce(rand, node, keys[ri(rand, keys.length)], budget - 1);
    }
    if (Array.isArray(node)) {
        const op = ri(rand, 6);
        if (op === 0) node.push(randValue(rand, 2));
        else if (op === 1 && node.length) node.pop();
        else if (op === 2) node.unshift(randValue(rand, 2));
        else if (op === 3 && node.length) node.splice(ri(rand, node.length), 1);
        else if (op === 4 && node.length > 1) { const i = ri(rand, node.length), j = ri(rand, node.length); const t = node[i]; node[i] = node[j]; node[j] = t; }
        else if (node.length) node[ri(rand, node.length)] = randValue(rand, 2);
        else node.push(randValue(rand, 2));
    } else if (node && typeof node === "object") {
        const keys = Object.keys(node); const op = ri(rand, 4);
        if (op === 0) node["k" + ri(rand, 8)] = randValue(rand, 2);
        else if (op === 1 && keys.length) delete node[keys[ri(rand, keys.length)]];
        else if (keys.length) node[keys[ri(rand, keys.length)]] = randValue(rand, 2);
        else node["k" + ri(rand, 8)] = randValue(rand, 2);
    } else {
        parent[key] = rand() < 0.3 ? randValue(rand, 2) : randLeaf(rand);
    }
}

function structuralFuzz() {
    const ITERS = 4000 * SCALE;
    let total = 0;
    for (let seed = 1; seed <= 4; seed++) {
        const rand = rng(seed * 0x9e3779b1);
        let oracle = randValue(rand, 3);
        if (oracle === null || typeof oracle !== "object") oracle = { root: oracle };
        const s = store(clone(oracle));
        for (let i = 0; i < ITERS / 4; i++) {
            const next = mutate(rand, oracle);
            reconcile(s, next);
            assert.deepEqual(snapshot(s), next, `seed ${seed} iter ${i}`);
            oracle = next; total++;
        }
        dispose(s);
    }
    return `${total.toLocaleString()} mutations across 4 seeds`;
}

function keyedIdentityFuzz() {
    const ITERS = 3000 * SCALE;
    const rand = rng(0xC0FFEE);
    let nextId = 0;
    const mkRow = () => ({ id: nextId++, v: ri(rand, 1000) });
    let rows = []; for (let i = 0; i < 6; i++) rows.push(mkRow());
    const s = store(rows.map(clone));
    const targetOf = new Map();
    const capture = () => { targetOf.clear(); for (let i = 0; i < s.length; i++) targetOf.set(s[i].id, unwrap(s[i])); };
    capture();
    for (let i = 0; i < ITERS; i++) {
        const op = ri(rand, 6);
        if (op === 0) rows.splice(ri(rand, rows.length + 1), 0, mkRow());
        else if (op === 1 && rows.length > 1) rows.splice(ri(rand, rows.length), 1);
        else if (op === 2 && rows.length > 1) { const a = ri(rand, rows.length), b = ri(rand, rows.length); const t = rows[a]; rows[a] = rows[b]; rows[b] = t; }
        else if (op === 3 && rows.length) { const a = ri(rand, rows.length), b = ri(rand, rows.length); const [lo, hi] = a < b ? [a, b] : [b, a]; rows = rows.slice(0, lo).concat(rows.slice(lo, hi + 1).reverse(), rows.slice(hi + 1)); }
        else if (rows.length) { const idx = ri(rand, rows.length); rows[idx] = { ...rows[idx], v: ri(rand, 1000) }; }

        const survivors = new Set(rows.map((r) => r.id));
        reconcile(s, rows.map(clone), { key: "id" });
        assert.deepEqual(snapshot(s), rows, `keyed iter ${i} content`);
        for (let j = 0; j < s.length; j++) {
            const id = s[j].id;
            if (targetOf.has(id)) assert.equal(unwrap(s[j]), targetOf.get(id), `row ${id} target preserved at iter ${i}`);
        }
        for (const id of [...targetOf.keys()]) if (!survivors.has(id)) targetOf.delete(id);
        capture();
    }
    dispose(s);
    return `${ITERS.toLocaleString()} keyed reorders, identity held`;
}

function zeroGcRefetch() {
    const N = 300;
    const rand = rng(0x5EED);
    const base = []; for (let i = 0; i < N; i++) base.push({ id: i, v: 0, tag: "t" + (i & 7) });
    const s = store(base.map(clone));
    let sink = 0; for (let i = 0; i < N; i++) sink += s[i].v; void sink;
    const warm = base.map(clone);
    for (let w = 0; w < 3; w++) { for (const r of warm) r.v = ri(rand, 100); reconcile(s, warm.map(clone)); }
    const b0 = stats();
    const CYCLES = 2000 * SCALE;
    for (let c = 0; c < CYCLES; c++) { for (let i = 0; i < N; i++) warm[i].v = c ^ i; reconcile(s, warm.map(clone)); }
    const b1 = stats();
    assert.equal(b1.poolGrowths - b0.poolGrowths, 0, "pool grew during refetch churn");
    assert.equal(b1.totalAllocations - b0.totalAllocations, 0, "nodes allocated during refetch churn");
    assert.equal(b1.totalDisposals - b0.totalDisposals, 0, "nodes disposed during refetch churn");
    dispose(s);
    return `${CYCLES.toLocaleString()} refetches over ${N} rows, pool flat`;
}

function duplicateKeyFuzz() {
    // keyedIdentityFuzz mints ids from a counter, so it only ever sees a unique
    // keyspace. Real payloads are not so kind: a paginated refetch that overlaps,
    // a join that fans out, or a plain server bug all produce repeated keys. If
    // the keyed walk claims one old row for several slots, the slots alias — and
    // patching rows[i] silently rewrites rows[j].
    const SEEDS = 60 * SCALE;
    const KEYSPACE = 4;
    let steps = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
        const rand = rng(seed * 0x85EBCA6B);
        const mkRow = () => ({ id: "k" + ri(rand, KEYSPACE), v: ri(rand, 1000) });
        let rows = []; for (let i = 0, n = 1 + ri(rand, 6); i < n; i++) rows.push(mkRow());
        const s = store(rows.map(clone));
        for (let i = 0; i < 40; i++) {
            const op = ri(rand, 4);
            if (op === 0) rows.splice(ri(rand, rows.length + 1), 0, mkRow());
            else if (op === 1 && rows.length > 1) rows.splice(ri(rand, rows.length), 1);
            else if (op === 2 && rows.length > 1) { const a = ri(rand, rows.length), b = ri(rand, rows.length); const t = rows[a]; rows[a] = rows[b]; rows[b] = t; }
            else if (rows.length) { const idx = ri(rand, rows.length); rows[idx] = { ...rows[idx], v: ri(rand, 1000) }; }

            reconcile(s, rows.map(clone), { key: "id" });
            assert.deepEqual(snapshot(s), rows, `dup-key seed ${seed} iter ${i} content`);

            // Slot independence: no two live slots may share a target object.
            const seen = new Set();
            for (let j = 0; j < s.length; j++) {
                const t = unwrap(s[j]);
                assert.ok(!seen.has(t), `dup-key seed ${seed} iter ${i}: slots alias one target`);
                seen.add(t);
            }
            steps++;
        }
        dispose(s);
    }
    return `${steps.toLocaleString()} keyed steps over a ${KEYSPACE}-key space, slots stayed disjoint`;
}

function boundedChurnPoolFlat() {
    // The zero-GC promise is not "steady state does not allocate" — it is "churn
    // returns what it took". A capped feed (push a row, shed the oldest) never
    // exceeds CAP rows, so its ledger must be flat no matter how long it runs.
    // Asserted under a HARD ceiling: with onCapacityExceeded:"grow" a leak here
    // reads as a pool that quietly doubles, which is exactly how it stays hidden.
    const CAP = 100;
    const TICKS = 10000 * SCALE;
    return inRegistry({ maxNodes: 4096, maxLinks: 16384 }, () => {
        const s = store({ feed: [] });
        // Signals are minted lazily inside isTracking(), so the read has to happen
        // under an effect — a bare loop measures nothing.
        const stop = effect(() => {
            const f = s.feed;
            for (let i = 0; i < f.length; i++) { f[i].id; f[i].v; f[i].tag; }
        });
        let settled = 0;
        for (let i = 0; i < TICKS; i++) {
            s.feed.push({ id: i, v: i, tag: "t" });
            if (s.feed.length > CAP) s.feed.shift();
            if (i === TICKS >> 2) settled = stats().activeNodes;
        }
        const after = stats().activeNodes;
        stop();
        assert.ok(settled > 0, "scenario allocated no nodes — the effect is not tracking the feed");
        assert.equal(after, settled, `bounded feed leaked ${after - settled} node(s) over ${TICKS} ticks`);
        dispose(s);
        return `${TICKS.toLocaleString()} push/shift ticks at cap ${CAP}, ledger flat at ${settled} nodes`;
    });
}

function hostilePayload() {
    // reconcile() is documented as the "apply the server refetch" entry point, so
    // its argument is untrusted by construction — and JSON.parse mints __proto__
    // as a real own property that a naive for-in walk will happily follow.
    const probe = {};
    const s = store({ rows: [{ id: 1, v: 1 }], meta: { page: 1 } });
    const payloads = [
        '{"rows":[{"id":1,"v":2}],"meta":{"page":2},"__proto__":{"pwned":1}}',
        '{"rows":[{"id":1,"v":3,"__proto__":{"pwned":1}}],"meta":{"page":3}}',
        '{"rows":[],"meta":{"__proto__":{"pwned":1}}}',
    ];
    for (const p of payloads) {
        reconcile(s, JSON.parse(p), { key: "id" });
        assert.equal(probe.pwned, undefined, `Object.prototype polluted by payload ${p}`);
        assert.equal(({}).pwned, undefined, `Object.prototype polluted by payload ${p}`);
    }
    assert.equal(Object.getPrototypeOf(unwrap(s)), Object.prototype, "store root reprototyped");
    dispose(s);
    return `${payloads.length} __proto__ payloads applied, prototype intact`;
}

const t0 = performance.now();
let failures = 0;
function run(name, fn) {
    const s = performance.now();
    try { const info = fn(); console.log(`  PASS ${name}${info ? " — " + info : ""} (${((performance.now() - s) / 1000).toFixed(2)}s)`); }
    catch (e) { failures++; console.error(`  FAIL ${name}: ${e.message}`); }
}

console.log(`lite-store reconcile() fuzzer (seeded, oracle-checked; scale ${SCALE})`);
run("structural mutation convergence", structuralFuzz);
run("keyed reorder identity preservation", keyedIdentityFuzz);
run("duplicate keys keep slots disjoint", duplicateKeyFuzz);
run("same-shape refetch is pool-flat", zeroGcRefetch);
run("bounded churn returns its nodes", boundedChurnPoolFlat);
run("hostile __proto__ payload is inert", hostilePayload);
console.log(`${failures ? "FAIL" : "PASS"}: ${failures} failure(s) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
process.exit(failures ? 1 : 0);
