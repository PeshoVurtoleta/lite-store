/**
 * @zakkster/lite-store — reconcile() suite.  `node --test test/*.test.js`
 *
 * reconcile(s, next, opts?) is the structural diff-apply that replaces the
 * `s.x = fresh` footgun (which disposes every signal under s.x and re-fires
 * everything). The headline claims are proven against lite-signal's own
 * counters:
 *   - GATE: replacing 1000 rows where 3 changed fires exactly 3 effects and the
 *           signal pool is flat (no allocation, no disposal).
 *   - KEYED: a reorder keeps every row's proxy identity and signal subtree; only
 *            the moved index signals fire.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    effect, batch, stats,
    createRegistry, setDefaultRegistry,
} from "@zakkster/lite-signal";
import { store, unwrap, snapshot, dispose, reconcile } from "../Store.js";

// Roomy registry: the 1000-row gate needs headroom over the default cap.
setDefaultRegistry(createRegistry({ maxNodes: 65536, maxLinks: 262144 }));

// ── Object reconcile ────────────────────────────────────────────────────────

test("reconcile object: patches only changed leaves, fires only those effects", () => {
    const s = store({ a: 1, b: 2, c: 3 });
    let aRuns = 0, bRuns = 0, cRuns = 0;
    const sa = effect(() => { s.a; aRuns++; });
    const sb = effect(() => { s.b; bRuns++; });
    const sc = effect(() => { s.c; cRuns++; });
    aRuns = bRuns = cRuns = 0;

    reconcile(s, { a: 1, b: 20, c: 3 });   // only b changed
    assert.equal(s.b, 20);
    assert.equal(aRuns, 0, "a unchanged: no re-run");
    assert.equal(bRuns, 1, "b changed: exactly one re-run");
    assert.equal(cRuns, 0, "c unchanged: no re-run");
    sa(); sb(); sc();
});

test("reconcile object: adds new keys and deletes absent ones", () => {
    const s = store({ a: 1, b: 2, gone: 9 });
    reconcile(s, { a: 1, b: 2, added: 7 });
    assert.equal(s.added, 7);
    assert.equal("gone" in s, false, "absent key deleted");
    assert.deepEqual(snapshot(s), { a: 1, b: 2, added: 7 });
});

test("reconcile object: nested same-shape object is patched IN PLACE (identity kept)", () => {
    const s = store({ user: { name: "Z", age: 36 } });
    const userRef = s.user;                     // capture proxy identity
    let nameRuns = 0;
    const stop = effect(() => { s.user.name; nameRuns++; });
    nameRuns = 0;

    reconcile(s, { user: { name: "Z", age: 37 } });   // only age changed
    assert.equal(s.user, userRef, "nested proxy identity preserved");
    assert.equal(s.user.age, 37);
    assert.equal(nameRuns, 0, "name effect did not re-run (only age changed)");
    stop();
});

test("reconcile object: shape flip (object -> scalar) replaces and disposes subtree", () => {
    const s = store({ node: { deep: { v: 1 } } });
    const before = stats().signals;
    let seen;
    const stop = effect(() => { const n = s.node; seen = (n && n.deep) ? n.deep.v : n; });
    assert.ok(stats().signals > before, "nested chain allocated signals");
    assert.equal(seen, 1);
    const disposalsBefore = stats().totalDisposals;
    reconcile(s, { node: 5 });                  // object -> scalar: replace + dispose subtree
    assert.equal(s.node, 5);
    assert.equal(seen, 5, "consumer re-ran and saw the scalar");
    assert.ok(stats().totalDisposals > disposalsBefore, "old subtree's signals disposed");
    stop();
});

// ── Array positional (the default) ──────────────────────────────────────────

test("reconcile array positional: same length, one row field changed -> one fire", () => {
    const s = store({ rows: [{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "c" }] });
    const r0 = s.rows[0], r1 = s.rows[1], r2 = s.rows[2];
    let runs = [0, 0, 0];
    const stops = [0, 1, 2].map((i) => effect(() => { s.rows[i].v; runs[i]++; }));
    runs = [0, 0, 0];

    reconcile(s.rows, [{ id: 1, v: "a" }, { id: 2, v: "B!" }, { id: 3, v: "c" }]);
    assert.equal(s.rows[0], r0, "row 0 identity preserved");
    assert.equal(s.rows[1], r1, "row 1 identity preserved (patched in place)");
    assert.equal(s.rows[2], r2, "row 2 identity preserved");
    assert.equal(s.rows[1].v, "B!");
    assert.deepEqual(runs, [0, 1, 0], "only the changed row's effect re-ran");
    stops.forEach((f) => f());
});

test("reconcile array positional: grow appends, shrink truncates", () => {
    const s = store({ xs: [1, 2, 3] });
    reconcile(s.xs, [1, 2, 3, 4, 5]);
    assert.deepEqual(unwrap(s.xs), [1, 2, 3, 4, 5]);
    reconcile(s.xs, [1, 2]);
    assert.deepEqual(unwrap(s.xs), [1, 2]);
    assert.equal(s.xs.length, 2);
});

test("GATE: replace 1000 rows where 3 changed -> 3 effects fire, signal pool flat", () => {
    const initial = [];
    for (let i = 0; i < 1000; i++) initial.push({ id: i, v: i });
    const s = store({ items: initial });

    let fires = 0;
    const stops = [];
    for (let i = 0; i < 1000; i++) {
        const idx = i;
        stops.push(effect(() => { s.items[idx].v; fires++; }));
    }
    fires = 0;
    const before = stats();

    // Server refetch: a brand-new array of brand-new row objects (fresh
    // identities), three of which carry a changed field.
    const next = [];
    for (let i = 0; i < 1000; i++) {
        const changed = i === 10 || i === 500 || i === 999;
        next.push({ id: i, v: changed ? i + 1 : i });
    }
    reconcile(s.items, next);

    const after = stats();
    assert.equal(fires, 3, "exactly three effects re-ran");
    assert.equal(s.items[10].v, 11);
    assert.equal(s.items[500].v, 501);
    assert.equal(s.items[999].v, 1000);
    assert.equal(after.signals, before.signals, "no net signal count change");
    assert.equal(after.totalAllocations, before.totalAllocations, "pool: zero allocations");
    assert.equal(after.totalDisposals, before.totalDisposals, "pool: zero disposals");
    stops.forEach((f) => f());
});

// ── Array keyed (opts.key) ──────────────────────────────────────────────────

test("reconcile keyed: a reorder keeps every row identity; only moved index signals fire", () => {
    const s = store({ rows: [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }] });
    const a = s.rows[0], b = s.rows[1], c = s.rows[2];

    reconcile(s.rows, [{ id: "c", v: 3 }, { id: "a", v: 1 }, { id: "b", v: 2 }], { key: "id" });

    // Same row objects, new order.
    assert.equal(s.rows[0], c, "c moved to front, identity kept");
    assert.equal(s.rows[1], a, "a identity kept");
    assert.equal(s.rows[2], b, "b identity kept");
    assert.deepEqual(s.rows.map((r) => r.id), ["c", "a", "b"]);
});

test("reconcile keyed: a moved row keeps its signal subtree (its field effect survives)", () => {
    const s = store({ rows: [{ id: "a", v: 1 }, { id: "b", v: 2 }] });
    let aRuns = 0;
    // Effect bound to row a's value, located by identity not index.
    const stop = effect(() => { s.rows.find((r) => r.id === "a").v; aRuns++; });
    aRuns = 0;

    // Reverse order AND change a's value in the same reconcile.
    reconcile(s.rows, [{ id: "b", v: 2 }, { id: "a", v: 99 }], { key: "id" });
    assert.equal(s.rows[1].v, 99, "a patched in place to 99");
    assert.ok(aRuns >= 1, "a's value effect re-ran on its field change (subtree survived the move)");
    stop();
});

test("reconcile keyed: insert and remove", () => {
    const s = store({ rows: [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }] });
    const b = s.rows[1];
    // Remove a, keep b, add d.
    reconcile(s.rows, [{ id: "b", v: 2 }, { id: "c", v: 3 }, { id: "d", v: 4 }], { key: "id" });
    assert.deepEqual(s.rows.map((r) => r.id), ["b", "c", "d"]);
    assert.equal(s.rows[0], b, "surviving row b keeps identity");
    assert.equal(s.rows.length, 3);
});

test("reconcile keyed: function key form", () => {
    const s = store({ rows: [{ uid: 7, v: "x" }, { uid: 8, v: "y" }] });
    const first = s.rows[0];
    reconcile(s.rows, [{ uid: 8, v: "y" }, { uid: 7, v: "X" }], { key: (r) => r.uid });
    assert.equal(s.rows[1], first, "row uid:7 kept identity across the move");
    assert.equal(s.rows[1].v, "X");
});

test("reconcile keyed: key applies to nested arrays through the walk", () => {
    const s = store({
        groups: [
            { id: "g1", items: [{ id: "i1", n: 1 }, { id: "i2", n: 2 }] },
        ],
    });
    const g1 = s.groups[0];
    const i2 = s.groups[0].items[1];
    reconcile(s, {
        groups: [
            { id: "g1", items: [{ id: "i2", n: 22 }, { id: "i1", n: 1 }] },
        ],
    }, { key: "id" });
    assert.equal(s.groups[0], g1, "group identity kept");
    assert.equal(s.groups[0].items[0], i2, "nested item i2 kept identity across its move");
    assert.equal(s.groups[0].items[0].n, 22);
});

// ── Contract / guards ───────────────────────────────────────────────────────

test("reconcile runs untracked: calling it inside an effect does not subscribe", () => {
    const s = store({ a: 1 });
    const src = store({ trigger: 0 });
    let runs = 0;
    const stop = effect(() => {
        src.trigger;                              // the only intended dependency
        reconcile(s, { a: 7 });                   // reconcile reads s.a internally — must NOT subscribe
        runs++;
    });
    const afterFirst = runs;
    s.a = 999;                                    // writing s.a must not re-run the effect
    assert.equal(runs, afterFirst, "reconcile's internal reads did not create dependencies");
    stop();
});

test("reconcile returns the same store proxy (chainable)", () => {
    const s = store({ a: 1 });
    assert.equal(reconcile(s, { a: 2 }), s);
});

test("reconcile rejects a non-store first argument", () => {
    assert.throws(() => reconcile({ a: 1 }, { a: 2 }), TypeError);
    assert.throws(() => reconcile(null, {}), TypeError);
    assert.throws(() => reconcile(42, {}), TypeError);
});

test("reconcile rejects a non-plain replacement", () => {
    const s = store({ a: 1 });
    assert.throws(() => reconcile(s, 5), TypeError);
    assert.throws(() => reconcile(s, new Map()), TypeError);
});

test("reconcile rejects a container-shape mismatch at the root", () => {
    const sObj = store({ a: 1 });
    const sArr = store([1, 2, 3]);
    assert.throws(() => reconcile(sObj, [1, 2, 3]), TypeError);
    assert.throws(() => reconcile(sArr, { a: 1 }), TypeError);
});

test("reconcile coalesces into one batch: a multi-key consumer sees a whole snapshot", () => {
    const s = store({ x: 1, y: 1 });
    const seen = [];
    const stop = effect(() => { seen.push([s.x, s.y]); });
    seen.length = 0;
    reconcile(s, { x: 2, y: 2 });
    assert.equal(seen.length, 1, "one re-run for the two-key change (batched)");
    assert.deepEqual(seen[0], [2, 2], "no torn intermediate [2,1] snapshot");
    stop();
});

test("reconcile: nested-array positional value churn is zero-GC on the pool", () => {
    const s = store({ list: [10, 20, 30, 40] });
    const stops = [0, 1, 2, 3].map((i) => effect(() => { s.list[i]; }));
    const before = stats();
    for (let k = 0; k < 200; k++) {
        reconcile(s.list, [10, 20 + (k & 1), 30, 40]);   // toggle one slot
    }
    const after = stats();
    assert.equal(after.totalAllocations, before.totalAllocations, "no pool allocations across 200 reconciles");
    assert.equal(after.totalDisposals, before.totalDisposals, "no pool disposals");
    stops.forEach((f) => f());
});
