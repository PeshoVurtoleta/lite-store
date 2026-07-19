/**
 * test/Torture.test.js — adversarial regression suite for @zakkster/lite-store.
 *
 * Every test here is a bug that shipped-and-passed the v1.1.0 suite. They are
 * grouped by the invariant they defend, and each one names the failure mode it
 * would have caught, because a torture test whose purpose is forgotten gets
 * deleted the first time it goes red.
 *
 * The default registry is deliberately LEFT AT ITS DEFAULT CEILING for the pool
 * tests. Installing a roomy `onCapacityExceeded: "grow"` registry — which is
 * what bench/torture/reconcile-fuzzer.mjs does — converts a hard node-pool leak
 * into an invisible slow bleed. Pool accounting must be asserted against a fixed
 * ledger, never against a pool that is allowed to paper over the deficit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { effect, batch, stats, createRegistry, setDefaultRegistry } from "@zakkster/lite-signal";
import { store, unwrap, snapshot, dispose, reconcile } from "../Store.js";

/** Deterministic PRNG (mulberry32) — a failing seed is a reproducible bug report. */
function rng(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Run `fn` against an isolated registry so pool math can't be polluted by neighbours. */
function inRegistry(config, fn) {
    const prev = createRegistry(config);
    setDefaultRegistry(prev);
    try { return fn(); } finally { setDefaultRegistry(createRegistry(config)); }
}

const rows = (n, f = (i) => ({ id: i, v: i })) => Array.from({ length: n }, (_, i) => f(i));

/** Materialise array holes as `undefined` so hole-vs-undefined isn't the thing under test. */
function dense(v) {
    if (Array.isArray(v)) { const out = new Array(v.length); for (let i = 0; i < v.length; i++) out[i] = dense(v[i]); return out; }
    if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
        const out = {}; for (const k of Object.keys(v)) out[k] = dense(v[k]); return out;
    }
    return v;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Node-pool accounting: every path that drops a row must release its signals
// ───────────────────────────────────────────────────────────────────────────

test("pool: every array-shrink path disposes the rows it sheds", async (t) => {
    // v1.1.0: splice/pop/shift/length= fired the right signals but never called
    // disposeSubtree on the departed rows. The signals stayed checked out of the
    // pool forever, unreachable from the store — so not even dispose(s) could
    // reclaim them. Only `delete` and the plain set trap got this right.
    const paths = {
        "splice": (s) => s.rows.splice(0, 25),
        "pop x25": (s) => { for (let i = 0; i < 25; i++) s.rows.pop(); },
        "shift x25": (s) => { for (let i = 0; i < 25; i++) s.rows.shift(); },
        "length = 25": (s) => { s.rows.length = 25; },
        "delete x25": (s) => { for (let i = 0; i < 25; i++) delete s.rows[i]; },
        "reconcile positional": (s) => reconcile(s, { rows: rows(25) }),
        "reconcile keyed": (s) => reconcile(s, { rows: rows(25) }, { key: "id" }),
    };

    for (const [name, mutate] of Object.entries(paths)) {
        await t.test(name, () => {
            inRegistry({ maxNodes: 4096 }, () => {
                const s = store({ rows: rows(50) });
                const stop = effect(() => { JSON.stringify(s); });
                const before = stats();
                mutate(s);
                const after = stats();
                stop();
                const released = after.totalDisposals - before.totalDisposals;
                assert.ok(
                    released >= 75,
                    `${name}: dropped 25 rows x 3 signals but released only ${released} nodes ` +
                    `(active ${before.activeNodes} -> ${after.activeNodes}) — orphaned signals`,
                );
            });
        });
    }
});

test("pool: bounded feed (push + shift) reaches a flat steady state", () => {
    // The canonical chat/log/telemetry pattern. Under v1.1.0 this threw
    // CapacityError after ~375 ticks even though the feed never exceeded 100 rows.
    inRegistry({ maxNodes: 4096 }, () => {
        const s = store({ feed: [] });
        const stop = effect(() => {
            const f = s.feed;
            for (let i = 0; i < f.length; i++) { f[i].id; f[i].text; }
        });
        let steady = 0;
        for (let tick = 0; tick < 20000; tick++) {
            s.feed.push({ id: tick, text: "m" + tick });
            if (s.feed.length > 100) s.feed.shift();
            if (tick === 5000) steady = stats().activeNodes;
        }
        const end = stats().activeNodes;
        stop();
        assert.equal(end, steady, `node count drifted ${steady} -> ${end} over 15k ticks — leak`);
    });
});

test("aliasing one object into two slots is unsupported (documented, pinned)", () => {
    // Shrink paths dispose what they shed without an O(length) residency scan —
    // proving non-residency measured ~50x on a 10k-row splice. This matches what
    // the set trap has always done: `s.rows[0] = x` disposes the old row's
    // signals with no aliasing check either. So parking one object at two indices
    // means dropping either copy deafens the other. Clone the row instead.
    inRegistry({ maxNodes: 4096 }, () => {
        const row = { id: 1, v: "shared" };
        const s = store({ rows: [row, row] });
        let seen = null;
        const stop = effect(() => { seen = s.rows[0].v; });
        assert.equal(seen, "shared");
        s.rows.pop();
        s.rows[0].v = "updated";
        stop();
        assert.equal(seen, "shared", "aliased-row disposal semantics changed — update the docs deliberately");
    });
});

test("pool: dispose(s) reclaims everything after churn", () => {
    inRegistry({ maxNodes: 4096 }, () => {
        const s = store({ rows: rows(20) });
        const stop = effect(() => { JSON.stringify(s); });
        s.rows.splice(0, 10);
        stop();
        dispose(s);
        assert.equal(stats().activeNodes, 0, "dispose(s) left nodes checked out of the pool");
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. reconcile() convergence
// ───────────────────────────────────────────────────────────────────────────

test("reconcile keyed: duplicate keys must not alias one row into two slots", () => {
    // v1.1.0 built key -> row once and never consumed it, so N new rows sharing a
    // key all reused the SAME target object. The array then held one object at two
    // indices: writing rows[0].v silently rewrote rows[1].v, and the last patch won
    // for every slot. Silent, and corrupts data rather than throwing.
    const s = store({ rows: [{ id: 1, v: "a" }] });
    reconcile(s, { rows: [{ id: 1, v: "x" }, { id: 1, v: "y" }] }, { key: "id" });
    const raw = unwrap(s).rows;
    assert.notEqual(raw[0], raw[1], "same row object aliased into two slots");
    assert.deepEqual(snapshot(s).rows, [{ id: 1, v: "x" }, { id: 1, v: "y" }]);
});

test("reconcile keyed: duplicate keys already present in the store", () => {
    const s = store({ rows: [{ id: 1, v: "a" }, { id: 1, v: "b" }] });
    reconcile(s, { rows: [{ id: 1, v: "x" }] }, { key: "id" });
    assert.deepEqual(snapshot(s).rows, [{ id: 1, v: "x" }]);
});

test("reconcile keyed: converges under duplicate-prone keyspaces (fuzz)", () => {
    // The shipped fuzzer only ever generated unique ids, which is exactly the
    // case that works. Drawing ids from a small space made 179/300 seeds diverge.
    inRegistry({ maxNodes: 1 << 16, onCapacityExceeded: "grow" }, () => {
        for (let seed = 1; seed <= 200; seed++) {
            const r = rng(seed);
            const mk = (n) => rows(n, () => ({ id: (r() * 12) | 0, v: (r() * 100) | 0, tags: [(r() * 5) | 0] }));
            const s = store({ rows: mk((r() * 8) | 0) });
            const stop = effect(() => { JSON.stringify(s); });
            for (let round = 0; round < 8; round++) {
                const next = { rows: mk((r() * 8) | 0) };
                reconcile(s, structuredClone(next), { key: "id" });
                assert.deepEqual(snapshot(s), next, `seed ${seed} round ${round}: keyed reconcile did not converge`);
            }
            stop();
        }
    });
});

test("reconcile: __proto__ in a payload is never treated as data", () => {
    // JSON.parse mints `__proto__` as a real own property. reconcileObject walked
    // it, sameShape() waved Object.prototype through as "a plain object", and the
    // recursion wrote attacker keys onto every object in the realm. reconcile() is
    // the documented "apply a server refetch" path, so the payload is untrusted
    // by construction.
    const hostile = JSON.parse('{"rows":[{"id":1}],"__proto__":{"pwned":true}}');
    const s = store({ rows: [{ id: 1 }] });
    reconcile(s, hostile);
    assert.equal({}.pwned, undefined, "prototype pollution via reconcile()");
    assert.equal(Object.getPrototypeOf(unwrap(s)), Object.prototype);
});

test("reconcile: positional path converges and preserves row identity (fuzz)", () => {
    inRegistry({ maxNodes: 1 << 16, onCapacityExceeded: "grow" }, () => {
        for (let seed = 1; seed <= 200; seed++) {
            const r = rng(seed);
            const mk = (n) => rows(n, () => ({ id: (r() * 12) | 0, v: (r() * 100) | 0 }));
            const s = store({ rows: mk((r() * 8) | 0) });
            const stop = effect(() => { JSON.stringify(s); });
            for (let round = 0; round < 8; round++) {
                const next = { rows: mk((r() * 8) | 0) };
                reconcile(s, structuredClone(next));
                assert.deepEqual(snapshot(s), next, `seed ${seed} round ${round}: positional reconcile did not converge`);
            }
            stop();
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Cycles
// ───────────────────────────────────────────────────────────────────────────

test("snapshot: self-cycle does not blow the stack", () => {
    // Cycle-safety is a headline feature of the store and disposeSubtree handles
    // it — snapshot() did not, and overflowed the stack on the very shape the
    // README uses as its cycle example.
    const s = store({ a: 1 });
    s.self = s;
    const snap = snapshot(s);
    assert.equal(snap.a, 1);
    assert.equal(snap.self, snap, "snapshot should reproduce the cycle, not explode it");
});

test("snapshot: mutual and diamond references keep their topology", () => {
    const a = store({ n: "a" });
    const b = store({ n: "b" });
    a.b = b; b.a = a;
    const sa = snapshot(a);
    assert.equal(sa.b.a, sa, "mutual cycle not preserved");

    const shared = { v: 1 };
    const d = store({ x: shared, y: shared });
    const sd = snapshot(d);
    assert.equal(sd.x, sd.y, "diamond sharing was duplicated into two clones");
});

test("snapshot: deep chain does not overflow", () => {
    let root = {}; let cur = root;
    for (let i = 0; i < 2000; i++) { cur.next = {}; cur = cur.next; }
    assert.doesNotThrow(() => snapshot(store(root)));
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Identity
// ───────────────────────────────────────────────────────────────────────────

test("store() is idempotent on an existing proxy", () => {
    // store(store(o)) built a proxy-of-a-proxy: two metas, two signal sets and two
    // identities for one piece of data. Trivially reachable via store(s.nested).
    const o = { a: 1 };
    const s1 = store(o);
    assert.equal(store(s1), s1, "store(store(o)) !== store(o)");
    assert.equal(unwrap(store(s1)), o);

    const nested = store({ inner: { v: 1 } });
    assert.equal(store(nested.inner), nested.inner);
});

test("array methods have stable identity and allocate once per key", () => {
    // Each `.push` access minted a fresh closure — a per-call allocation on the
    // hottest path in the library, and `s.push !== s.push`.
    const s = store([1]);
    assert.equal(s.push, s.push, "fresh closure allocated on every .push access");
    assert.equal(s.splice, s.splice);
    const detached = s.push;
    detached(2);
    assert.deepEqual(unwrap(s), [1, 2]);
});

// ───────────────────────────────────────────────────────────────────────────
// 5. `in` tracking: absent and present-but-undefined are different facts
// ───────────────────────────────────────────────────────────────────────────

test("`in` re-fires when a key is added with value undefined", () => {
    // The has trap tracked the VALUE lane only. Adding a key whose value is
    // undefined leaves that lane at Object.is(undefined, undefined) — suppressed —
    // so `'x' in s` consumers never re-ran.
    const s = store({});
    let runs = 0, present = null;
    const stop = effect(() => { present = "x" in s; runs++; });
    const before = runs;
    s.x = undefined;
    stop();
    assert.ok(runs > before, "effect did not re-run after s.x = undefined");
    assert.equal(present, true);
});

test("`in` re-fires when an undefined-valued key is deleted", () => {
    const s = store({ x: undefined });
    let runs = 0, present = null;
    const stop = effect(() => { present = "x" in s; runs++; });
    const before = runs;
    delete s.x;
    stop();
    assert.ok(runs > before, "effect did not re-run after delete s.x");
    assert.equal(present, false);
});

test("`in` subscribes to presence only, not to value", () => {
    // BEHAVIOUR CHANGE vs v1.1.0, deliberate. v1.1.0 tracked `in` on the value
    // lane, so "dark" -> "light" woke every `in` consumer even though presence
    // never changed. lite-crdt's map.has() compiles straight to `k in proj` and
    // its suite asserts fine-grained behaviour, so the value lane is a spurious
    // wake there — and one that double-fires on delete once the existence lane
    // exists. `in` is a presence question; it answers on the presence lane.
    const s = store({ x: 1 });
    let runs = 0;
    const stop = effect(() => { "x" in s; runs++; });
    const settled = runs;
    s.x = 2;
    assert.equal(runs, settled, "value change must not wake an `in` consumer");
    delete s.x;
    stop();
    assert.equal(runs, settled + 1, "presence flip must wake it exactly once");
});

test("`in` sees the flips the value lane is blind to", () => {
    // The reason the existence lane has to exist at all: Object.is suppresses
    // undefined -> undefined, so neither of these is visible on the value lane.
    const add = store({});
    let addRuns = 0;
    const stopAdd = effect(() => { "x" in add; addRuns++; });
    add.x = undefined;                       // absent -> present, value undefined
    stopAdd();
    assert.equal(addRuns, 2, "adding an undefined-valued key must re-fire `in`");

    const del = store({ x: undefined });
    let delRuns = 0;
    const stopDel = effect(() => { "x" in del; delRuns++; });
    delete del.x;                            // present -> absent, value undefined
    stopDel();
    assert.equal(delRuns, 2, "deleting an undefined-valued key must re-fire `in`");
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Array length: spec conformance
// ───────────────────────────────────────────────────────────────────────────

test("array length assignment follows ToUint32 + RangeError semantics", () => {
    // `real | 0` silently truncated 4.5 to 4, turned 2**32-1 into -1 (spurious
    // RangeError on a legal length), and let -1 through to the engine.
    assert.throws(() => { store([1, 2, 3]).length = 4.5; }, RangeError, "length = 4.5 must RangeError");
    assert.throws(() => { store([1, 2, 3]).length = -1; }, RangeError, "length = -1 must RangeError");
    assert.throws(() => { store([1, 2, 3]).length = NaN; }, RangeError);

    const big = store([1, 2, 3]);
    big.length = 4294967295;
    assert.equal(big.length, 4294967295, "2**32-1 is a legal length");

    const coerce = store([1, 2, 3]);
    coerce.length = "2";
    assert.equal(coerce.length, 2);
});

// ───────────────────────────────────────────────────────────────────────────
// 7. Frozen data
// ───────────────────────────────────────────────────────────────────────────

test("frozen containers stay readable", () => {
    // A frozen object's props are non-writable AND non-configurable, so the `get`
    // proxy invariant forbids returning a child proxy. v1.1.0 returned one anyway
    // and the engine threw — a frozen config subtree made the store unreadable.
    assert.doesNotThrow(() => {
        const s = store(Object.freeze({ cfg: { host: "db" } }));
        assert.equal(s.cfg.host, "db");
    });
    const cfg = Object.freeze({ db: { host: "x", port: 5432 } });
    const s = store({ cfg, live: 1 });
    assert.equal(s.cfg.db.port, 5432);
    assert.deepEqual(snapshot(s), { cfg: { db: { host: "x", port: 5432 } }, live: 1 });
});

test("a frozen subtree does not deaden its reactive siblings", () => {
    const s = store({ cfg: Object.freeze({ a: { b: 1 } }), live: 0 });
    let seen = null;
    const stop = effect(() => { s.cfg.a.b; seen = s.live; });
    s.live = 5;
    stop();
    assert.equal(seen, 5);
});

// ───────────────────────────────────────────────────────────────────────────
// 8. Differential fuzz: a store must behave exactly like the plain value
// ───────────────────────────────────────────────────────────────────────────

test("array mutators match plain-array semantics (differential fuzz)", () => {
    const OPS = [
        ["push", (a, r) => a.push({ id: (r() * 1000) | 0, v: (r() * 100) | 0 })],
        ["pop", (a) => a.pop()],
        ["shift", (a) => a.shift()],
        ["unshift", (a, r) => a.unshift({ id: (r() * 1000) | 0, v: 1 })],
        ["splice-del", (a, r) => a.splice((r() * (a.length + 1)) | 0, (r() * 3) | 0)],
        ["splice-ins", (a, r) => a.splice((r() * (a.length + 1)) | 0, 0, { id: (r() * 1000) | 0, v: 1 })],
        ["splice-neg", (a, r) => a.splice(-((r() * 3) | 0) - 1, (r() * 2) | 0)],
        ["reverse", (a) => a.reverse()],
        ["sort", (a) => a.sort((x, y) => (x.id || 0) - (y.id || 0))],
        ["setidx", (a, r) => { if (a.length) a[(r() * a.length) | 0] = { id: (r() * 1000) | 0, v: 9 }; }],
        ["setfield", (a, r) => { const x = a.length ? a[(r() * a.length) | 0] : null; if (x) x.v = (r() * 100) | 0; }],
        ["delidx", (a, r) => { if (a.length) delete a[(r() * a.length) | 0]; }],
        ["shrink", (a, r) => { a.length = Math.max(0, a.length - ((r() * 3) | 0)); }],
        ["fill", (a, r) => { if (a.length) a.fill({ id: -1, v: 0 }, (r() * a.length) | 0); }],
        ["copyWithin", (a) => { if (a.length > 1) a.copyWithin(0, 1); }],
    ];

    inRegistry({ maxNodes: 1 << 16, onCapacityExceeded: "grow" }, () => {
        for (let seed = 1; seed <= 200; seed++) {
            const r = rng(seed);
            const initial = rows(6, (i) => ({ id: i, v: i * 10 }));
            const s = store(structuredClone(initial));
            const mirror = structuredClone(initial);
            const stop = effect(() => {
                for (let i = 0; i < s.length; i++) { const x = s[i]; if (x) { x.id; x.v; } }
            });
            const trail = [];
            for (let step = 0; step < 50; step++) {
                const [name, fn] = OPS[(r() * OPS.length) | 0];
                trail.push(name);
                fn(s, rng(seed * 7919 + step));
                fn(mirror, rng(seed * 7919 + step));
                // Holes are normalised on both sides: `delete arr[i]` leaves a
                // real hole in the mirror, while snapshot() densifies it to
                // `undefined` (see the sparse-array test below). That difference
                // is a documented property of snapshot, not a mutator bug.
                assert.deepEqual(
                    dense(snapshot(s)), dense(mirror),
                    `seed ${seed} step ${step}: store diverged from plain array after [${trail.slice(-5).join(", ")}]`,
                );
            }
            stop();
        }
    });
});

test("no observer is left stale after a random mutation burst (fuzz)", () => {
    inRegistry({ maxNodes: 1 << 16, onCapacityExceeded: "grow" }, () => {
        for (let seed = 1; seed <= 150; seed++) {
            const r = rng(seed);
            const s = store({ rows: rows(5) });
            let seen = [];
            const stop = effect(() => {
                seen = [];
                for (let i = 0; i < s.rows.length; i++) seen.push(s.rows[i] ? s.rows[i].v : null);
            });
            for (let step = 0; step < 25; step++) {
                const arr = s.rows;
                switch ((r() * 6) | 0) {
                    case 0: arr.push({ id: step, v: step }); break;
                    case 1: arr.pop(); break;
                    case 2: arr.shift(); break;
                    case 3: arr.splice((r() * (arr.length + 1)) | 0, (r() * 2) | 0); break;
                    case 4: if (arr.length) arr[(r() * arr.length) | 0].v = step; break;
                    case 5: arr.reverse(); break;
                }
            }
            const truth = unwrap(s).rows.map((x) => (x ? x.v : null));
            stop();
            assert.deepEqual(seen, truth, `seed ${seed}: effect observed a stale view of the array`);
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 9. Batching under churn
// ───────────────────────────────────────────────────────────────────────────

test("batched shrink+grow bursts collapse to a single propagation", () => {
    const s = store({ rows: rows(10) });
    let runs = 0;
    const stop = effect(() => { s.rows.length; runs++; });
    const before = runs;
    batch(() => {
        s.rows.splice(0, 5);
        s.rows.push({ id: 99, v: 99 });
        s.rows.shift();
        s.rows.length = 3;
    });
    stop();
    assert.equal(runs - before, 1, `expected 1 propagation, got ${runs - before}`);
});

// ───────────────────────────────────────────────────────────────────────────
// 10. Documented behaviours worth pinning (not bugs — contracts)
// ───────────────────────────────────────────────────────────────────────────

test("snapshot() densifies sparse arrays (documented, pinned)", () => {
    // `delete s[1]` leaves a real hole in the target; snapshot() writes every
    // index and hands back a dense array with `undefined` in the gap. Consistent
    // with JSON.stringify's treatment, and cheaper than hole-preserving copies —
    // but it is an observable difference from the underlying array.
    const s = store([1, 2, 3]);
    delete s[1];
    assert.equal(1 in unwrap(s), false, "target should keep the hole");
    const snap = snapshot(s);
    assert.equal(1 in snap, true, "snapshot is dense");
    assert.equal(snap[1], undefined);
});

test("array mutators return raw targets, not proxies (documented, pinned)", () => {
    // s[0] hands back a proxy; s.pop() hands back the raw object. Mutating the
    // popped value is therefore non-reactive — correct, since it has left the
    // store, but it is an asymmetry worth knowing about.
    const s = store([{ id: 1 }]);
    const popped = s.pop();
    assert.equal(popped[Symbol.iterator], undefined);
    assert.equal(Object.getPrototypeOf(popped), Object.prototype);
});

test("Object.keys() is not reactive to key addition (documented, pinned)", () => {
    // No ownKeys trap: iteration tracks the keys it READS, not the key SET. A
    // newly added key is invisible to an effect that only enumerated. Documented
    // in llms.txt; pinned here so a future ownKeys trap is a deliberate change.
    const s = store({ a: 1 });
    let runs = 0;
    const stop = effect(() => { Object.keys(s); runs++; });
    const before = runs;
    s.b = 2;
    stop();
    assert.equal(runs, before, "key addition unexpectedly re-fired an Object.keys consumer");
});

test("hand-rolled non-writable+non-configurable props still break `get` (known limit)", () => {
    // Object.freeze() is handled (meta.frozen). A property made non-writable AND
    // non-configurable via defineProperty on an otherwise-extensible object is
    // not — detecting it needs a descriptor lookup on every read, which the hot
    // path can't afford. Pinned so the limit is explicit rather than a surprise.
    const raw = {};
    Object.defineProperty(raw, "x", { value: { a: 1 }, writable: false, configurable: false, enumerable: true });
    const s = store(raw);
    assert.throws(() => s.x, TypeError);
});
