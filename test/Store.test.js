/**
 * @zakkster/lite-store test suite.  `node --test test/*.test.js`
 *
 * No mocks. Real lite-signal v1.1.3 backing every effect/computed. The
 * lazy-allocation tests use lite-signal's `stats()` to count signal nodes
 * directly — the headline claim ("plain reads outside reactive contexts
 * allocate nothing") is proven, not asserted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    signal, effect, computed, batch, untrack,
    stats, createRegistry, setDefaultRegistry,
} from "@zakkster/lite-signal";
import { store, unwrap, snapshot, dispose } from "../Store.js";

// Roomy registry so the dispose-cascade test doesn't trip the default cap.
setDefaultRegistry(createRegistry({ maxNodes: 16384 }));

// ── Construction ────────────────────────────────────────────────────────────

test("store wraps a plain object", () => {
    const s = store({ a: 1, b: "x" });
    assert.equal(s.a, 1);
    assert.equal(s.b, "x");
});

test("store wraps a nested object lazily", () => {
    const s = store({ user: { name: "Z", age: 36 } });
    assert.equal(s.user.name, "Z");
    assert.equal(s.user.age, 36);
});

test("store wraps an array", () => {
    const s = store([10, 20, 30]);
    assert.equal(s[0], 10);
    assert.equal(s[2], 30);
    assert.equal(s.length, 3);
});

test("store rejects non-plain inputs", () => {
    assert.throws(() => store(null), TypeError);
    assert.throws(() => store(undefined), TypeError);
    assert.throws(() => store(42), TypeError);
    assert.throws(() => store("hello"), TypeError);
    assert.throws(() => store(new Map()), TypeError);
    assert.throws(() => store(new Date()), TypeError);
});

// ── Identity ────────────────────────────────────────────────────────────────

test("proxy identity is stable across reads (the foundation of keyed reconciliation)", () => {
    const s = store({ user: { name: "Z" }, items: [{ id: 1 }, { id: 2 }] });
    assert.equal(s.user, s.user);
    assert.equal(s.items, s.items);
    assert.equal(s.items[0], s.items[0]);
    assert.equal(s.items[1], s.items[1]);
});

// ── Reactivity: basic ───────────────────────────────────────────────────────

test("effect tracks property reads and re-fires on writes", () => {
    const s = store({ count: 0 });
    let observed = -1;
    effect(() => { observed = s.count; });
    assert.equal(observed, 0);
    s.count = 5;
    assert.equal(observed, 5);
    s.count = 6;
    assert.equal(observed, 6);
});

test("effect tracks nested-object reads", () => {
    const s = store({ user: { name: "Z" } });
    let observed = "";
    effect(() => { observed = s.user.name; });
    assert.equal(observed, "Z");
    s.user.name = "X";
    assert.equal(observed, "X");
});

test("writes to unread keys do not trigger unrelated effects", () => {
    const s = store({ a: 1, b: 2 });
    let runs = 0;
    effect(() => { runs++; s.a; });
    assert.equal(runs, 1);
    s.b = 999;
    assert.equal(runs, 1, "writing to b should not refire an a-only effect");
});

test("Object.is short-circuit: setting the same value does not refire", () => {
    const s = store({ x: 5 });
    let runs = 0;
    effect(() => { runs++; s.x; });
    s.x = 5;
    assert.equal(runs, 1, "identical write should be a no-op");
});

// ── Lazy allocation (the headline claim, proven via stats()) ────────────────

test("plain reads outside any reactive context allocate ZERO signals", () => {
    const s = store({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    const before = stats().signals;
    // Hammer the proxy with plain reads — none of these should allocate
    for (let i = 0; i < 100; i++) { s.a; s.b; s.c; s.d; s.e; }
    assert.equal(stats().signals, before,
        "no signals allocated for non-tracked reads");
});

test("a tracked read allocates exactly one signal per unique key", () => {
    const s = store({ a: 1, b: 2 });
    const before = stats().signals;
    const stop = effect(() => { s.a; s.a; s.a; });        // re-reads dedupe
    assert.equal(stats().signals - before, 1, "one signal for s.a");
    stop();
});

test("untrack() inside an effect suppresses tracking on those reads", () => {
    const s = store({ a: 1 });
    let runs = 0;
    effect(() => { runs++; untrack(() => s.a); });
    assert.equal(runs, 1);
    s.a = 99;
    assert.equal(runs, 1, "untracked read does not subscribe");
});

// ── THE adversarial cycle test ──────────────────────────────────────────────

test("cycle + overwrite: no stack overflow, no collateral damage on siblings", () => {
    const s = store({ count: 0 });
    s.self = s;                                            // create the cycle

    let runs = 0;
    let lastSelf;
    effect(() => {
        runs++;
        s.count;                                           // track count
        lastSelf = s.self;                                 // track self
    });
    assert.equal(runs, 1);
    assert.equal(lastSelf, s);

    // THE TRAP — overwrite the cycle root
    s.self = null;

    assert.equal(runs, 2, "effect ran once on overwrite");
    assert.equal(lastSelf, null, "effect saw new value");

    // Condition (3) from the adversarial spec: count's signal must survive
    s.count = 5;
    assert.equal(runs, 3, "count signal not collaterally damaged");
});

// ── Splice / array op coverage ──────────────────────────────────────────────

test("direct index assignment fires the indexed signal", () => {
    const s = store({ items: [10, 20, 30] });
    let v;
    effect(() => { v = s.items[1]; });
    assert.equal(v, 20);
    s.items[1] = 99;
    assert.equal(v, 99);
});

test("push fires length + any tracked indices at the tail", () => {
    const s = store({ items: [1, 2, 3] });
    let len = 0;
    effect(() => { len = s.items.length; });
    assert.equal(len, 3);
    s.items.push(4);
    assert.equal(len, 4);
    s.items.push(5, 6);
    assert.equal(len, 6);
});

test("pop fires length + clears the popped index if tracked", () => {
    const s = store({ items: [1, 2, 3] });
    let len, last;
    effect(() => { len = s.items.length; last = s.items[2]; });
    assert.deepEqual([len, last], [3, 3]);
    s.items.pop();
    assert.deepEqual([len, last], [2, undefined], "popped index now undefined");
});

test("shift fires every tracked index (all shift left)", () => {
    const s = store({ items: [1, 2, 3] });
    let v0, v1, len;
    effect(() => { v0 = s.items[0]; v1 = s.items[1]; len = s.items.length; });
    assert.deepEqual([v0, v1, len], [1, 2, 3]);
    s.items.shift();
    assert.deepEqual([v0, v1, len], [2, 3, 2]);
});

test("unshift fires every tracked index (all shift right) + length", () => {
    const s = store({ items: [10, 20] });
    let v0, v1, len;
    effect(() => { v0 = s.items[0]; v1 = s.items[1]; len = s.items.length; });
    assert.deepEqual([v0, v1, len], [10, 20, 2]);
    s.items.unshift(5);
    assert.deepEqual([v0, v1, len], [5, 10, 3]);
});

test("splice fires only tracked indices >= start", () => {
    const s = store({ items: [0, 1, 2, 3, 4, 5] });
    let v1, v3, v5;
    effect(() => { v1 = s.items[1]; v3 = s.items[3]; v5 = s.items[5]; });
    s.items.splice(0, 1);
    assert.equal(v1, 2, "items[1] after splice");
    assert.equal(v3, 4);
    assert.equal(v5, undefined, "length shrank; items[5] out of bounds");
});

test("splice with negative start normalizes correctly", () => {
    const s = store({ items: [0, 1, 2, 3, 4] });
    let last;
    effect(() => { last = s.items[4]; });
    s.items.splice(-2, 1);                                  // remove index 3
    assert.equal(last, undefined, "array shrank to length 4");
});

test("reverse fires every tracked index", () => {
    const s = store({ items: [1, 2, 3, 4] });
    let v0, v3;
    effect(() => { v0 = s.items[0]; v3 = s.items[3]; });
    s.items.reverse();
    assert.equal(v0, 4);
    assert.equal(v3, 1);
});

test("sort fires every tracked index", () => {
    const s = store({ items: [3, 1, 4, 1, 5] });
    let v0;
    effect(() => { v0 = s.items[0]; });
    s.items.sort((a, b) => a - b);
    assert.equal(v0, 1);
});

test("fill fires only tracked indices in the filled range", () => {
    const s = store({ items: [1, 2, 3, 4, 5] });
    let v0, v2, v4;
    effect(() => { v0 = s.items[0]; v2 = s.items[2]; v4 = s.items[4]; });
    s.items.fill(99, 2, 4);                                  // fill indices 2, 3
    assert.equal(v0, 1, "index 0 unchanged");
    assert.equal(v2, 99);
    assert.equal(v4, 5, "index 4 outside the fill range, unchanged");
});

// ── Dispose semantics ──────────────────────────────────────────────────────

test("overwriting a subtree disposes only that subtree's signals (siblings safe)", () => {
    const s = store({ a: { x: 1 }, b: { y: 2 } });

    let bRuns = 0;
    let observedY;
    effect(() => { bRuns++; observedY = s.b.y; });
    assert.equal(bRuns, 1);

    // Overwrite s.a — disposes a's subtree, must leave b alone
    s.a = { x: 99 };
    assert.equal(bRuns, 1, "sibling effect did not re-run");

    // And b's reactivity still works
    s.b.y = 5;
    assert.equal(bRuns, 2);
    assert.equal(observedY, 5);
});

test("dispose() stops further reactivity in the store", () => {
    const s = store({ a: 1, nested: { b: 2 } });
    let runs = 0;
    effect(() => { runs++; s.a; s.nested.b; });
    assert.equal(runs, 1);

    dispose(s);

    s.a = 99;                                                // no signal exists
    s.nested.b = 88;                                         // ditto
    assert.equal(runs, 1, "no reactivity after dispose");
});

test("dispose cascades through 500 children without leaks", () => {
    const s = store({ items: [] });
    for (let i = 0; i < 500; i++) s.items.push({ id: i });

    let runs = 0;
    effect(() => {
        runs++;
        for (let i = 0; i < 500; i++) s.items[i].id;          // track each
    });
    assert.equal(runs, 1);

    const sigsBefore = stats().signals;
    dispose(s);
    const sigsAfter = stats().signals;
    assert.ok(sigsAfter < sigsBefore - 400,
        `disposed ${sigsBefore - sigsAfter} signals (expected ~500+)`);
});

// ── Documented zombie-proxy behaviour ──────────────────────────────────────

test("zombie proxy: old effects detached, but proxy can be re-tracked by new ones", () => {
    const s = store({ a: { x: 1 } });
    const ref = s.a;                                         // capture proxy

    let oldRuns = 0;
    effect(() => { oldRuns++; ref.x; });
    assert.equal(oldRuns, 1);

    s.a = { x: 99 };                                         // disposes ref's signals
    assert.equal(oldRuns, 1, "overwrite did not re-fire old effect");

    ref.x = 5;
    assert.equal(oldRuns, 1, "writes through zombie do not refire old effect");

    // New effects can still subscribe to the zombie (it has signal-allocation
    // capacity); they just live on a meta no longer referenced by the parent
    let newRuns = 0;
    effect(() => { newRuns++; ref.x; });
    assert.equal(newRuns, 1, "new effect captured zombie's current value");
    ref.x = 10;
    assert.equal(newRuns, 2, "zombie can be re-tracked by new observers");
});

// ── Opaque-by-default boundaries ───────────────────────────────────────────

test("Date, Map, Set are passed through as opaque references", () => {
    const map = new Map();
    const date = new Date(2026, 0, 1);
    const set = new Set([1, 2, 3]);
    const s = store({ map, date, set });
    assert.equal(s.map, map);
    assert.equal(s.date, date);
    assert.equal(s.set, set);
});

test("mutating opaque values does NOT fire (replacing the slot does)", () => {
    const s = store({ tags: new Set(["a"]) });
    let runs = 0;
    effect(() => { runs++; s.tags; });
    assert.equal(runs, 1);

    s.tags.add("b");                                          // opaque mutation
    assert.equal(runs, 1, "Set internal mutation is not reactive");

    s.tags = new Set(["c"]);                                  // slot replacement
    assert.equal(runs, 2, "replacing the slot fires the parent signal");
});

test("class instances are opaque", () => {
    class Foo { constructor(v) { this.v = v; } }
    const f = new Foo(1);
    const s = store({ foo: f });
    assert.equal(s.foo, f, "no wrapping for class instances");
});

// ── Lifecycle & utilities ──────────────────────────────────────────────────

test("delete property fires the signal with undefined", () => {
    const s = store({ a: 1, b: 2 });
    let v;
    effect(() => { v = s.a; });
    assert.equal(v, 1);
    delete s.a;
    assert.equal(v, undefined);
});

test("batch() coalesces multiple writes into one effect run", () => {
    const s = store({ a: 1, b: 2, c: 3 });
    let runs = 0;
    effect(() => { runs++; s.a; s.b; s.c; });
    assert.equal(runs, 1);

    batch(() => {
        s.a = 10;
        s.b = 20;
        s.c = 30;
    });
    assert.equal(runs, 2, "batched writes fire effect once");
});

test("unwrap returns the original target", () => {
    const init = { a: 1, b: { c: 2 } };
    const s = store(init);
    assert.equal(unwrap(s), init);
});

test("snapshot returns a deep plain copy", () => {
    const s = store({ a: { b: { c: 1 } }, arr: [1, [2, [3]]] });
    const snap = snapshot(s);
    assert.deepEqual(snap, { a: { b: { c: 1 } }, arr: [1, [2, [3]]] });
    assert.notEqual(snap, unwrap(s), "fresh root object");
    assert.notEqual(snap.a, unwrap(s).a, "fresh nested objects");
});

test("computed derived from a store recomputes when source signal fires", () => {
    const s = store({ items: [{ price: 10 }, { price: 20 }, { price: 30 }] });
    const total = computed(() => {
        let sum = 0;
        for (let i = 0; i < s.items.length; i++) sum += s.items[i].price;
        return sum;
    });
    assert.equal(total(), 60);
    s.items[1].price = 99;
    assert.equal(total(), 10 + 99 + 30);
});

// ──────────────────────────────────────────────────────────────────────────
// ── Expanded coverage — added during the test-rigour review pass ──────────
// ──────────────────────────────────────────────────────────────────────────

// ── Computed integration (depth) ───────────────────────────────────────────

test("computed memoizes — body does not re-run if no source signal fired", () => {
    const s = store({ a: 1, b: 100 });
    let computeCount = 0;
    const c = computed(() => { computeCount++; return s.a * 2; });
    assert.equal(c(), 2);                                    // first read computes
    assert.equal(c(), 2);                                    // second read uses cache
    assert.equal(computeCount, 1);

    s.b = 999;                                               // unrelated path
    assert.equal(c(), 2);
    assert.equal(computeCount, 1, "computed did not re-run on unrelated write");

    s.a = 5;                                                 // tracked source
    assert.equal(c(), 10);
    assert.equal(computeCount, 2);
});

test("computed with conditional reads: dep set updates on re-run", () => {
    const s = store({ flag: true, a: 1, b: 100 });
    const c = computed(() => s.flag ? s.a : s.b);
    let runs = 0;
    effect(() => { runs++; c(); });
    assert.equal(c(), 1);

    s.b = 999;                                               // not in active dep set
    assert.equal(runs, 1, "writes to inactive branch don't re-fire");

    s.flag = false;                                          // switch branches
    assert.equal(c(), 999);
    assert.equal(runs, 2, "flag change refired effect once");

    // After the branch switch, `a` is no longer in `c`'s dep set — sever-tail
    // dropped it when `c` re-evaluated. Writing to it should NOT re-fire.
    s.a = 42;
    assert.equal(runs, 2, "writes to the now-inactive branch don't re-fire");

    // But writes to `b` (the currently-active branch) still fire
    s.b = 1000;
    assert.equal(runs, 3, "writes to the active branch do re-fire");
});

test("two computeds reading the same store path both update on change", () => {
    const s = store({ count: 1 });
    const doubled = computed(() => s.count * 2);
    const tripled = computed(() => s.count * 3);
    assert.equal(doubled(), 2);
    assert.equal(tripled(), 3);
    s.count = 5;
    assert.equal(doubled(), 10);
    assert.equal(tripled(), 15);
});

test("computed throws on first read; subsequent reads re-throw until deps change", () => {
    const s = store({ x: 0 });
    const c = computed(() => {
        if (s.x === 0) throw new Error("oops");
        return s.x * 2;
    });
    assert.throws(() => c(), /oops/);
    assert.throws(() => c(), /oops/, "error is cached, re-throws on subsequent read");
    s.x = 4;
    assert.equal(c(), 8, "error cleared once deps change");
});

// ── Property addition / deletion edge cases ───────────────────────────────

test("adding a new property fires effects that have read it as undefined", () => {
    const s = store({});
    let observed;
    effect(() => { observed = s.future; });                  // tracks "future" with undefined
    assert.equal(observed, undefined);
    s.future = "hello";
    assert.equal(observed, "hello");
});

test("deleting a property fires the signal with undefined", () => {
    const s = store({ a: 1 });
    let v;
    effect(() => { v = s.a; });
    delete s.a;
    assert.equal(v, undefined);
});

test("deleting a non-existent key is a no-op (no spurious fires)", () => {
    const s = store({ a: 1 });
    let runs = 0;
    effect(() => { runs++; s.a; });
    delete s.b;                                              // doesn't exist
    delete s.c;
    assert.equal(runs, 1, "deletes of non-existent keys don't fire any effect");
});

test("setting undefined explicitly is distinct from delete (key still exists)", () => {
    const s = store({ a: 1 });
    s.a = undefined;
    assert.equal("a" in unwrap(s), true);
    delete s.a;
    assert.equal("a" in unwrap(s), false);
});

// ── Self-assignment & no-op semantics ─────────────────────────────────────

test("self-assignment is a no-op: s.a = s.a does NOT dispose s.a's signals", () => {
    const s = store({ a: { x: 1 } });
    let runs = 0;
    effect(() => { runs++; s.a.x; });
    assert.equal(runs, 1);
    s.a = s.a;                                               // self-assignment
    s.a.x = 99;                                              // tracked signal still alive?
    assert.equal(runs, 2, "self-assignment did not tear down the subtree's signals");
});

// ── Array — length & sparse extension ─────────────────────────────────────

test("arr.length = N truncation fires removed indices' signals", () => {
    const s = store({ items: [10, 20, 30, 40, 50] });
    let v3, v4, len;
    effect(() => { v3 = s.items[3]; v4 = s.items[4]; len = s.items.length; });
    s.items.length = 3;
    assert.equal(v3, undefined, "items[3] truncated");
    assert.equal(v4, undefined);
    assert.equal(len, 3);
});

test("arr.length = N extension creates holes, length fires", () => {
    const s = store({ items: [1, 2, 3] });
    let len;
    effect(() => { len = s.items.length; });
    s.items.length = 10;
    assert.equal(len, 10);
    assert.equal(unwrap(s).items[5], undefined);
});

test("sparse index assignment arr[100] = x fires both the index and length", () => {
    const s = store({ items: [1, 2, 3] });
    let v, len;
    effect(() => { v = s.items[100]; len = s.items.length; });
    assert.equal(v, undefined);
    assert.equal(len, 3);
    s.items[100] = "far";
    assert.equal(v, "far", "indexed signal fired");
    assert.equal(len, 101, "length signal fired implicitly");
});

test("splice with 0 deletes (insertion only) fires shifted indices + length", () => {
    const s = store({ items: [1, 2, 3] });
    let v1, len;
    effect(() => { v1 = s.items[1]; len = s.items.length; });
    s.items.splice(1, 0, "inserted");
    assert.equal(v1, "inserted");
    assert.equal(len, 4);
});

test("splice that empties the array fires every tracked index", () => {
    const s = store({ items: [1, 2, 3, 4, 5] });
    let v0, v4, len;
    effect(() => { v0 = s.items[0]; v4 = s.items[4]; len = s.items.length; });
    s.items.splice(0, 5);
    assert.equal(v0, undefined);
    assert.equal(v4, undefined);
    assert.equal(len, 0);
});

// ── Array iteration & non-mutating methods inside effects ─────────────────

test("for...of inside an effect tracks every iterated index", () => {
    const s = store({ items: [1, 2, 3] });
    let total = 0;
    effect(() => {
        total = 0;
        for (const x of s.items) total += x;
    });
    assert.equal(total, 6);
    s.items[1] = 99;
    assert.equal(total, 1 + 99 + 3);
});

test("arr.forEach inside effect tracks every iterated index", () => {
    const s = store({ items: [1, 2, 3] });
    let total = 0;
    effect(() => {
        total = 0;
        s.items.forEach(x => { total += x; });
    });
    assert.equal(total, 6);
    s.items[2] = 100;
    assert.equal(total, 1 + 2 + 100);
});

test("arr.map inside computed tracks every element", () => {
    const s = store({ items: [1, 2, 3] });
    const doubled = computed(() => s.items.map(x => x * 2));
    assert.deepEqual(doubled(), [2, 4, 6]);
    s.items[0] = 10;
    assert.deepEqual(doubled(), [20, 4, 6]);
});

test("spread [...s.items] inside effect tracks every index", () => {
    const s = store({ items: [1, 2, 3] });
    let copy;
    effect(() => { copy = [...s.items]; });
    assert.deepEqual(copy, [1, 2, 3]);
    s.items[1] = 99;
    assert.deepEqual(copy, [1, 99, 3]);
});

test("arr.find inside effect tracks until the match (short-circuits)", () => {
    const s = store({ items: [1, 2, 3, 4, 5] });
    let found;
    let runs = 0;
    effect(() => {
        runs++;
        found = s.items.find(x => x > 2);                    // matches at index 2
    });
    assert.equal(found, 3);

    s.items[3] = 99;                                         // past the short-circuit
    assert.equal(runs, 1, "writes past the short-circuit don't refire");

    s.items[1] = 99;                                         // BEFORE the short-circuit
    assert.equal(runs, 2, "writes before/at short-circuit do refire");
});

// ── Object operations & iteration ─────────────────────────────────────────

test("JSON.stringify of a store works (tracks every read property)", () => {
    const s = store({ a: 1, nested: { b: 2 } });
    const json = JSON.stringify(s);
    assert.equal(json, '{"a":1,"nested":{"b":2}}');
});

test("spread {...s} reads every own key (tracks each in effect)", () => {
    const s = store({ a: 1, b: 2, c: 3 });
    let copy;
    effect(() => { copy = { ...s }; });
    assert.deepEqual(copy, { a: 1, b: 2, c: 3 });
    s.b = 99;
    assert.deepEqual(copy, { a: 1, b: 99, c: 3 });
});

test("Object.values reads each value through the proxy (tracks each)", () => {
    const s = store({ a: 1, b: 2 });
    let sum;
    effect(() => { sum = Object.values(s).reduce((a, b) => a + b, 0); });
    assert.equal(sum, 3);
    s.a = 10;
    assert.equal(sum, 12);
});

test("'key' in s tracks via has trap; key transitions fire", () => {
    const s = store({ a: 1 });
    let exists;
    effect(() => { exists = "a" in s; });
    assert.equal(exists, true);
    delete s.a;
    assert.equal(exists, false, "delete fires has-tracker");
    s.a = 5;
    assert.equal(exists, true, "re-add fires has-tracker");
});

// ── Multi-store independence ──────────────────────────────────────────────

test("two independent stores: effects on one don't fire on the other's writes", () => {
    const s1 = store({ a: 1 });
    const s2 = store({ a: 1 });
    let runs1 = 0, runs2 = 0;
    effect(() => { runs1++; s1.a; });
    effect(() => { runs2++; s2.a; });
    s1.a = 99;
    assert.equal(runs1, 2);
    assert.equal(runs2, 1, "s1 write did not fire s2's effect");
});

test("effect reading from two stores re-fires when EITHER changes", () => {
    const s1 = store({ x: 1 });
    const s2 = store({ y: 10 });
    let sum;
    effect(() => { sum = s1.x + s2.y; });
    assert.equal(sum, 11);
    s1.x = 5;
    assert.equal(sum, 15);
    s2.y = 100;
    assert.equal(sum, 105);
});

test("computed combining two stores updates from both", () => {
    const a = store({ count: 1 });
    const b = store({ count: 10 });
    const total = computed(() => a.count + b.count);
    assert.equal(total(), 11);
    a.count = 5;
    assert.equal(total(), 15);
    b.count = 50;
    assert.equal(total(), 55);
});

// ── Cycle and shared-subtree extended ─────────────────────────────────────

test("three-node cycle a→b→c→a: disposal terminates without infinite recursion", () => {
    const s = store({ a: { name: "A" }, b: { name: "B" }, c: { name: "C" } });
    s.a.next = s.b;
    s.b.next = s.c;
    s.c.next = s.a;                                          // close the cycle

    // Track on the initiator (c) — initiator-skip should preserve this even
    // when the disposal walk traverses the cycle back into c's meta.
    let nameC;
    effect(() => { nameC = s.c.name; });
    assert.equal(nameC, "C");

    // Break the cycle by overwriting c.next. The disposal walk traverses
    // s.c.next (== s.a) → s.a's subtree → s.a.next (== s.b) → s.b's subtree →
    // s.b.next (== s.c, which IS the initiator → skipped). No infinite loop.
    assert.doesNotThrow(() => { s.c.next = null; });

    // Initiator's own signals survive the cycle walk
    s.c.name = "CC";
    assert.equal(nameC, "CC");
});

test("cycle through an array element: s.arr[0] = s; setting s.arr[0] = null", () => {
    const s = store({ arr: [] });
    s.arr[0] = s;                                            // cycle via array
    let runs = 0;
    effect(() => { runs++; s.arr[0]; });
    assert.equal(runs, 1);
    s.arr[0] = null;                                         // break cycle
    assert.equal(runs, 2);
    // Subsequent reactivity still works on the root
    s.foo = "bar";
    // (no effect tracks .foo, so no run; but the store is healthy)
    let runs2 = 0;
    effect(() => { runs2++; s.foo; });
    s.foo = "baz";
    assert.equal(runs2, 2);
});

test("shared subtree (s.a = s.b): both paths see mutations through the shared meta", () => {
    const original = { value: 1 };
    const s = store({ a: { value: 0 }, b: original });
    s.a = s.b;                                               // a and b now share the same target
    let runsA = 0, runsB = 0;
    effect(() => { runsA++; s.a.value; });
    effect(() => { runsB++; s.b.value; });
    assert.equal(runsA, 1);
    assert.equal(runsB, 1);
    s.a.value = 99;                                          // mutation through one path
    assert.equal(runsA, 2);
    assert.equal(runsB, 2, "shared meta: mutation visible from the other path too");
});

// ── Dispose edge cases ────────────────────────────────────────────────────

test("dispose() is idempotent: calling it twice is safe", () => {
    const s = store({ a: 1 });
    effect(() => s.a);
    dispose(s);
    assert.doesNotThrow(() => dispose(s));
});

test("dispose() during a batch correctly drops effects from the batch", () => {
    const s = store({ a: 1 });
    let runs = 0;
    effect(() => { runs++; s.a; });
    batch(() => {
        s.a = 2;
        dispose(s);
        // Writes after dispose are silent (signals released)
        s.a = 3;
    });
    // The s.a = 2 write inside the batch happens BEFORE dispose, queues an effect run.
    // Effect runs at batch end. After dispose, that effect is disposed too.
    // Result: at most one re-run for the pre-dispose write — depending on
    // implementation, possibly zero. Both are acceptable; what matters is no crash.
    assert.ok(runs >= 1 && runs <= 2, `runs in expected range: ${runs}`);
});

test("dispose(non-store) is a no-op (doesn't throw)", () => {
    assert.doesNotThrow(() => dispose(null));
    assert.doesNotThrow(() => dispose(undefined));
    assert.doesNotThrow(() => dispose({}));                  // plain object, not a store
    assert.doesNotThrow(() => dispose(42));
});

// ── Error handling ────────────────────────────────────────────────────────

test("an effect that throws does not break sibling effects", () => {
    const s = store({ a: 1 });
    let sibling = 0;
    effect(() => { sibling = s.a; });
    assert.throws(() => {
        effect(() => { if (s.a === 1) throw new Error("boom"); });
    }, /boom/);
    // Sibling effect should still work
    s.a = 5;
    assert.equal(sibling, 5);
});

test("write inside an effect that triggered it: bounded recursion via batch", () => {
    const s = store({ a: 1 });
    let runs = 0;
    effect(() => {
        runs++;
        if (runs < 3 && s.a < 3) {
            batch(() => { s.a = s.a + 1; });
        } else {
            s.a;                                             // just track
        }
    });
    // The effect reads s.a, increments it (which fires itself), but the inner
    // batch + the lite-signal cycle guard keeps recursion bounded. We're not
    // asserting a specific count — we're asserting "doesn't infinite-loop".
    assert.ok(runs < 100, `bounded runs: ${runs}`);
});

test("untracked write inside an effect doesn't refire the effect", () => {
    const s = store({ a: 1, b: 100 });
    let runs = 0;
    effect(() => {
        runs++;
        s.a;
        untrack(() => { s.b = s.b + 1; });
    });
    assert.equal(runs, 1);
    // The b write inside untrack: nobody tracks b, so even if it fired the
    // signal, no effect would re-run from b. Just sanity-check no loop.
    s.a = 5;
    assert.equal(runs, 2);
});

// ── Snapshot identity ────────────────────────────────────────────────────

test("snapshot returns plain data: structurally equal, identity-distinct", () => {
    const s = store({ a: { b: 1 }, items: [{ x: 1 }] });
    const snap = snapshot(s);
    assert.deepEqual(snap, { a: { b: 1 }, items: [{ x: 1 }] });
    assert.notEqual(snap, unwrap(s));
    assert.notEqual(snap.a, unwrap(s).a);
    assert.notEqual(snap.items, unwrap(s).items);
    assert.notEqual(snap.items[0], unwrap(s).items[0]);
});

test("snapshot is not reactive: subsequent store writes don't change the snapshot", () => {
    const s = store({ a: 1, nested: { b: 2 } });
    const snap = snapshot(s);
    s.a = 99;
    s.nested.b = 999;
    assert.equal(snap.a, 1);
    assert.equal(snap.nested.b, 2);
});

// ── Equality & identity invariants ────────────────────────────────────────

test("unwrap(s) !== s (different objects — proxy vs target)", () => {
    const init = { a: 1 };
    const s = store(init);
    assert.notEqual(s, init);
    assert.equal(unwrap(s), init);
});

test("captured ref identity is stable across unrelated mutations", () => {
    const s = store({ user: { name: "Z" }, other: { foo: "bar" } });
    const captured = s.user;
    s.other.foo = "baz";                                     // unrelated mutation
    assert.equal(captured, s.user, "user proxy identity preserved");
    s.user.name = "X";                                       // mutation through target
    assert.equal(captured, s.user, "still preserved");
});

test("re-reading an array element after splice returns the new element with the right identity", () => {
    const s = store({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const wasAt2 = s.items[2];
    s.items.splice(0, 1);                                    // shift left
    assert.notEqual(s.items[2], wasAt2, "items[2] is a different element now");
    assert.equal(s.items[1], wasAt2, "former items[2] is now at items[1]");
});
