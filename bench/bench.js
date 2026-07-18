/**
 * @zakkster/lite-store — benchmark harness.
 *
 * Honest measurements. Each benchmark runs in three modes:
 *   - plain    : direct mutation on a raw object/array (the floor)
 *   - store    : through the lite-store proxy outside any reactive context (the proxy tax)
 *   - reactive : through the proxy inside an effect (the reactive cost)
 *
 * The shape of the gap between plain and store tells you the proxy overhead.
 * The shape of the gap between store and reactive tells you the cost of being
 * actually reactive — which is the cost you pay for the feature, not for the
 * library being there.
 *
 * Run: `npm run bench`  (or: `node bench/bench.js`)
 */

import { effect, batch, stats, createRegistry, setDefaultRegistry } from "@zakkster/lite-signal";
import { store, dispose } from "../Store.js";

setDefaultRegistry(createRegistry({ maxNodes: 1 << 17 }));      // ~131k

const N_WARMUP = 1000;
const N_RUNS   = 5;
const fmt = (n) => (n >= 1000 ? n.toFixed(0).padStart(10) : n.toFixed(3).padStart(10));

function bench(label, fn, iters) {
    // warmup
    for (let i = 0; i < N_WARMUP; i++) fn(i);
    // measure
    const samples = [];
    for (let r = 0; r < N_RUNS; r++) {
        const t0 = performance.now();
        for (let i = 0; i < iters; i++) fn(i);
        samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(N_RUNS / 2)];
    const opsPerSec = (iters / median) * 1000;
    console.log(`  ${label.padEnd(48)} ${fmt(median)} ms   ${fmt(opsPerSec)} ops/s`);
}

function section(title) {
    console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ── 1. Property read ────────────────────────────────────────────────────────
section("property read (1M iterations)");
{
    const raw = { a: 1, b: 2, c: 3 };
    bench("plain object  read .a", (i) => { const x = raw.a; return x; }, 1_000_000);

    const s = store({ a: 1, b: 2, c: 3 });
    bench("store (untracked)  read .a", (i) => { const x = s.a; return x; }, 1_000_000);

    let sink = 0;
    const stop = effect(() => { sink = s.a; });
    bench("store (under effect)  read .a", (i) => { const x = s.a; return x; }, 1_000_000);
    stop();
}

// ── 2. Property write ───────────────────────────────────────────────────────
section("property write (no observers · 100k iterations)");
{
    const raw = { a: 0 };
    bench("plain object  write .a", (i) => { raw.a = i; }, 100_000);

    const s = store({ a: 0 });
    bench("store (no signal allocated)  write .a", (i) => { s.a = i; }, 100_000);

    // Allocate the signal once via a one-shot effect, then dispose it.
    const s2 = store({ a: 0 });
    let _ = 0;
    const stop = effect(() => { _ = s2.a; });
    bench("store (signal allocated, 1 subscriber)  write .a", (i) => { s2.a = i; }, 100_000);
    stop();
    dispose(s2);
}

// ── 3. Nested read ──────────────────────────────────────────────────────────
section("nested read · 3 levels (1M iterations)");
{
    const raw = { a: { b: { c: 42 } } };
    bench("plain object  read .a.b.c", () => { const x = raw.a.b.c; }, 1_000_000);

    const s = store({ a: { b: { c: 42 } } });
    bench("store (untracked)  read .a.b.c", () => { const x = s.a.b.c; }, 1_000_000);

    let sink = 0;
    const stop = effect(() => { sink = s.a.b.c; });
    bench("store (under effect)  read .a.b.c", () => { const x = s.a.b.c; }, 1_000_000);
    stop();
}

// ── 4. Array push ───────────────────────────────────────────────────────────
section("array push · single observer on length (10k pushes)");
{
    const raw = [];
    bench("plain array  push", (i) => { raw.push(i); }, 10_000);

    const s = store({ items: [] });
    bench("store array  push (no observers)", (i) => { s.items.push(i); }, 10_000);

    const s2 = store({ items: [] });
    let len = 0;
    const stop = effect(() => { len = s2.items.length; });
    bench("store array  push (length observed)", (i) => { s2.items.push(i); }, 10_000);
    stop();
    dispose(s2);
}

// ── 5. Array splice ────────────────────────────────────────────────────────
section("array splice · 10 tracked indices on 10k-element array (1k splices)");
{
    const raw = Array.from({ length: 10_000 }, (_, i) => i);
    bench("plain array  splice(0, 1) + push(x)", (i) => { raw.splice(0, 1); raw.push(i); }, 1_000);

    const s = store({ items: Array.from({ length: 10_000 }, (_, i) => i) });
    // Track 10 random indices so the sparse splice iteration has real work
    const stops = [];
    for (let k = 0; k < 10; k++) {
        const idx = (Math.random() * 10_000) | 0;
        let sink;
        stops.push(effect(() => { sink = s.items[idx]; }));
    }
    bench("store array  splice(0, 1) + push(x)  [10 tracked]", (i) => {
        s.items.splice(0, 1);
        s.items.push(i);
    }, 1_000);
    for (const stop of stops) stop();
    dispose(s);
}

// ── 6. Mass write under batch ──────────────────────────────────────────────
section("batched mass write · 600 cells (1k iterations)");
{
    const raw = Array.from({ length: 600 }, () => ({ v: 0 }));
    bench("plain  600 writes", (i) => {
        for (let k = 0; k < 600; k++) raw[k].v = i;
    }, 1_000);

    const s = store({ cells: Array.from({ length: 600 }, () => ({ v: 0 })) });
    // One effect per cell — matches the demo's setup
    const stops = [];
    let sink = 0;
    for (let k = 0; k < 600; k++) {
        const idx = k;
        stops.push(effect(() => { sink = s.cells[idx].v; }));
    }
    bench("store (600 effects)  600 writes  [unbatched]", (i) => {
        for (let k = 0; k < 600; k++) s.cells[k].v = i;
    }, 100);
    bench("store (600 effects)  600 writes  [batch()]", (i) => {
        batch(() => {
            for (let k = 0; k < 600; k++) s.cells[k].v = i;
        });
    }, 1_000);
    for (const stop of stops) stop();
    dispose(s);
}

// ── 7. Registry footprint ──────────────────────────────────────────────────
section("registry footprint");
{
    const before = stats();
    const big = store({
        cells: Array.from({ length: 10_000 }, () => ({ v: 0 })),
    });
    const after_create = stats();
    console.log(`  10k-cell store created · signals delta: ${after_create.signals - before.signals}`);

    let sink = 0;
    const stop = effect(() => { sink = big.cells[5000].v; });
    const after_one = stats();
    console.log(`  ... after 1 tracked read of cells[5000].v · signals delta: ${after_one.signals - before.signals}`);

    stop();
    dispose(big);
    const after_dispose = stats();
    console.log(`  ... after dispose · signals delta: ${after_dispose.signals - before.signals}`);
}

console.log();
