/**
 * @zakkster/lite-store v1.1.0
 * --------------------
 * Fine-grained reactivity for objects and arrays, built on @zakkster/lite-signal.
 *
 * Architecture: WeakMap-cached proxies + lazy per-key signals. A property only
 * becomes reactive (gets a signal node) the first time it's read inside an
 * effect / computed / watch. Plain reads outside reactive contexts allocate
 * nothing — the lazy allocation falls out of the `isTracking()` gate that
 * lite-signal v1.1.3 exposes.
 *
 * Mutation model: direct (s.user.name = "X" works). Coalesce multi-writes by
 * wrapping in lite-signal's `batch(fn)`. There is no `produce` and no
 * transactional rollback in v1 — naming a thing `produce` borrows Immer's
 * sandbox semantics, and re-implementing Immer's draft machinery would trade
 * the lean/zero-GC brand for an expectation that doesn't fit a directly-
 * mutable proxy.
 *
 * Disposal: overwriting a key disposes the old subtree's signals (proactive
 * walk over the proxy's signal/child maps, NOT over the raw target). Walks
 * a `Set<meta>` to (a) terminate on cycles, and (b) skip the meta whose set
 * trap initiated the walk — without that, `s.self = null` on a cyclic store
 * would wipe the very signals the rest of the store is bound to.
 *
 * Opaque-by-default for non-plain prototypes (Date, Map, Set, RegExp, class
 * instances). They are tracked at the parent's key only; mutating them
 * internally does not fire signals. A future `lite-collections` package can
 * ship ReactiveMap/ReactiveSet for the rare cases that need them.
 *
 * Public surface: {@link store}, {@link unwrap}, {@link snapshot}, {@link dispose},
 * {@link reconcile}.
 */

import { signal, batch, dispose as disposeSignal, isTracking, untrack } from "@zakkster/lite-signal";

/** Sentinel key exposing the proxy's metadata to internal helpers and `unwrap`. */
const META = Symbol("lite-store/meta");

/** Sentinel for "keyed reconcile found no reusable row" (distinct from `undefined`). */
const UNCLAIMED = Symbol("lite-store/unclaimed");

/** target → meta. WeakMap so dropping every reference reclaims the meta. */
const metaOf = new WeakMap();
/** target → proxy. Same lifetime as metaOf; preserves proxy identity. */
const proxyOf = new WeakMap();

/**
 * True iff `v` is a plain object or array — the only shapes we proxy.
 * Class instances, Date, Map, Set, RegExp, Promise are deliberately opaque.
 * @private
 */
function isPlain(v) {
    if (v === null || typeof v !== "object") return false;
    if (Array.isArray(v)) return true;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/**
 * True iff `k` is a canonical array-index string ("0", "1", "42").
 * "01" and "-1" and "1.5" and "length" all return false. Used to filter
 * the signal map during array mutations so we fire only integer-keyed
 * subscribers, not "length" or string properties someone may have hung
 * off the array.
 * @private
 */
function isIntKey(k) {
    if (typeof k !== "string" || k.length === 0) return false;
    const first = k.charCodeAt(0);
    if (first === 48) return k.length === 1;                 // "0" only, not "01"
    if (first < 49 || first > 57) return false;              // first char must be 1..9
    for (let i = 1; i < k.length; i++) {
        const c = k.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
}

/**
 * Lazy proxy factory. Returns the cached proxy if one exists, else creates a
 * new meta + proxy pair and caches both. Proxy identity is preserved across
 * reads — `s.foo === s.foo` is always true.
 * @private
 */
function wrap(target) {
    if (!isPlain(target)) return target;
    const cached = proxyOf.get(target);
    if (cached) return cached;
    // A frozen target's own properties are non-writable AND non-configurable,
    // so the `get` invariant forbids returning anything but the actual value —
    // handing back a child proxy makes the engine throw and the store becomes
    // unreadable. Frozen data can't change, so it needs no reactivity anyway.
    const meta = {
        target,
        sigs: new Map(),
        kids: new Map(),
        hasSigs: undefined,
        ops: undefined,
        frozen: Object.isFrozen(target),
    };
    metaOf.set(target, meta);
    const proxy = new Proxy(target, makeHandler(meta));
    proxyOf.set(target, proxy);
    return proxy;
}

/**
 * Walk a subtree disposing every signal in every meta's `sigs` map, then
 * clearing `kids`. The `seen` set serves two purposes:
 *   1. Cycle termination — without it `s.self = s` recurses forever.
 *   2. Initiator skip — pre-seed `seen` with the meta whose set trap initiated
 *      the walk, so cyclic references back to "ourselves" don't blow away
 *      signals that the rest of the store still depends on.
 * @private
 */
function disposeSubtree(root, initiator) {
    const seen = new Set();
    if (initiator) seen.add(initiator);
    (function recurse(m) {
        if (seen.has(m)) return;
        seen.add(m);
        for (const sig of m.sigs.values()) disposeSignal(sig);
        m.sigs.clear();
        if (m.hasSigs !== undefined) {
            for (const sig of m.hasSigs.values()) disposeSignal(sig);
            m.hasSigs.clear();
        }
        for (const child of m.kids.values()) recurse(child);
        m.kids.clear();
    })(root);
}

/**
 * Allocate-or-reuse the signal for `meta.key`, returning the signal accessor.
 * Caller is responsible for gating this behind `isTracking()`.
 * @private
 */
function trackKey(meta, key, value) {
    let sig = meta.sigs.get(key);
    if (sig === undefined) {
        sig = signal(value);
        meta.sigs.set(key, sig);
    }
    return sig;
}

/**
 * Fire a key's signal if one was ever allocated. Reads through lite-signal's
 * own Object.is equality check, so no-op writes don't waste an effect run.
 * @private
 */
function fireKey(meta, key, value) {
    const sig = meta.sigs.get(key);
    if (sig !== undefined) sig.set(value);
}

/**
 * Allocate-or-reuse the EXISTENCE signal for `key` — a separate lane from the
 * value signal in `meta.sigs`, because `undefined` and "absent" are the same
 * value but not the same fact. Lazily allocates `meta.hasSigs` on the first
 * tracked `in` check, so a store nobody probes with `in` never pays for it.
 * @private
 */
function trackHas(meta, key, exists) {
    let m = meta.hasSigs;
    if (m === undefined) m = meta.hasSigs = new Map();
    let sig = m.get(key);
    if (sig === undefined) {
        sig = signal(exists);
        m.set(key, sig);
    }
    return sig;
}

/**
 * Fire a key's existence signal if anyone ever probed it with `in`.
 * @private
 */
function fireHas(meta, key, exists) {
    const m = meta.hasSigs;
    if (m === undefined) return;
    const sig = m.get(key);
    if (sig !== undefined) sig.set(exists);
}

/**
 * Release the signal subtree of a single value that has just LEFT array `t`.
 * Scalars and never-proxied objects cost one typeof plus one WeakMap miss, so a
 * scalar array pays essentially nothing.
 *
 * No residency scan: if the SAME object is parked at two indices, dropping one
 * disposes the signals the other is still bound to. That is deliberate — it is
 * exactly what the set trap has always done on `s.rows[0] = x`, and proving
 * non-residency would cost an O(length) scan on every shrink, which measured
 * ~50x on a 10k-row array. Aliasing one object into two slots of a store array
 * is unsupported; clone the row instead.
 * @private
 */
function disposeDetachedOne(meta, v) {
    if (v === null || typeof v !== "object") return;
    const cm = metaOf.get(v);
    if (cm === undefined || cm === meta) return;
    disposeSubtree(cm, meta);
}

/**
 * Batch form of {@link disposeDetachedOne} for ops that shed several rows at
 * once (splice, length truncation, fill). O(removed), not O(length).
 * @private
 */
function disposeDetachedMany(meta, removed) {
    for (let i = 0; i < removed.length; i++) disposeDetachedOne(meta, removed[i]);
}

/**
 * copyWithin overwrites in place, so a row can be evicted without the length
 * changing and a survivor can end up duplicated. It is the one shrink path where
 * "was here before, isn't now" genuinely needs a residency check — and it is
 * rare enough to pay for one.
 * @private
 */
function disposeEvicted(meta, before, t) {
    let present = null;
    for (let i = 0; i < before.length; i++) {
        const v = before[i];
        const cm = metaOf.get(v);
        if (cm === undefined || cm === meta) continue;
        if (present === null) {
            present = new Set();
            for (let j = 0; j < t.length; j++) {
                const e = t[j];
                if (e !== null && typeof e === "object") present.add(e);
            }
        }
        if (present.has(v)) continue;
        disposeSubtree(cm, meta);
    }
}

/**
 * Collect the rows in `t[from..to)` that own signals, so the caller can release
 * them after the mutation lands. Returns null when there is nothing to release,
 * so the overwhelmingly common "nothing was tracked" path allocates nothing.
 * @private
 */
function collectTracked(t, from, to) {
    let out = null;
    for (let i = from; i < to; i++) {
        const e = t[i];
        if (e !== null && typeof e === "object" && metaOf.has(e)) (out || (out = [])).push(e);
    }
    return out;
}

/**
 * Build the Proxy handler bound to a specific meta. One handler object per
 * meta — keeps the inline-cache shape monomorphic for V8.
 * @private
 */
function makeHandler(meta) {
    return {
        get(t, k) {
            // META sentinel: internal access for unwrap / dispose / .[META] reads
            if (k === META) return meta;
            // Symbol keys (Symbol.iterator, custom symbols): pass straight through
            if (typeof k === "symbol") return Reflect.get(t, k);
            // Array mutating methods: hand out the wrapped version that batches
            // and fires the right index/length signals after the underlying op
            // Cached per meta: `s.push === s.push` holds, and a hot loop calling
            // `s.push(x)` no longer mints a fresh closure on every access.
            if (Array.isArray(t) && Object.prototype.hasOwnProperty.call(ARRAY_OPS, k)) {
                let ops = meta.ops;
                if (ops === undefined) ops = meta.ops = new Map();
                let fn = ops.get(k);
                if (fn === undefined) {
                    fn = ARRAY_OPS[k](t, meta);
                    ops.set(k, fn);
                }
                return fn;
            }

            const v = t[k];

            // LAZY allocation: only create the signal if a reactive observer
            // is on the stack. Outside any effect/computed/watch this is a free
            // boolean check followed by a plain property read.
            if (isTracking()) {
                const sig = trackKey(meta, k, v);
                sig();                                            // subscribe via read
            }

            // Wrap nested plain objects/arrays lazily; cache child meta on
            // parent so dispose walks find it.
            if (isPlain(v) && !meta.frozen) {
                const childProxy = wrap(v);
                meta.kids.set(k, metaOf.get(v));
                return childProxy;
            }

            return v;
        },

        set(t, k, v) {
            // Symbol keys: pass through without tracking
            if (typeof k === "symbol") return Reflect.set(t, k, v);

            const old = t[k];

            // Unwrap if the assigned value is itself a proxy from this store —
            // we always store underlying targets, never proxies, so identity
            // and snapshot stay consistent.
            const real = (v !== null && typeof v === "object" && v[META] !== undefined)
                ? v[META].target
                : v;

            // Self-assignment short-circuit. Without this, `s.a = s.a` would
            // pass equality (no signal fire — correct) but then enter the
            // dispose path and tear down s.a's signal subtree (incorrect).
            // Object.is matches lite-signal's own equality semantics.
            if (Object.is(old, real)) {
                // Equal values, but "absent" and "present-and-undefined" are
                // different facts. Only pay for the `in` probe when the value is
                // undefined AND somebody is actually watching existence.
                if (real !== undefined || meta.hasSigs === undefined || (k in t)) return true;
                t[k] = real;
                fireHas(meta, k, true);
                return true;
            }

            // Array length tracking: capture pre-state so we can detect both
            // direct length assignment and implicit length extension from
            // sparse-index writes (`arr[100] = x` when length was 5).
            const isArr = Array.isArray(t);
            const oldArrLen = isArr ? t.length : 0;

            // Direct length assignment on an array. Truncation requires firing
            // every tracked index in [newLen, oldLen) with undefined — those
            // slots no longer exist. Extension creates holes; tracked indices
            // in the new range read undefined which is already their value.
            if (isArr && k === "length") {
                // ToUint32 with round-trip validation: `length = 4.5` and
                // `length = -1` are RangeErrors per spec, and `length = 2**32-1`
                // is legal — a bare `| 0` got all three wrong.
                const num = +real;
                const newLen = num >>> 0;
                if (newLen !== num) throw new RangeError("Invalid array length");
                // Snapshot the tail BEFORE truncating; afterwards those slots are gone.
                const shed = newLen < oldArrLen ? collectTracked(t, newLen, oldArrLen) : null;
                t.length = newLen;
                if (newLen < oldArrLen) {
                    for (const [sk, sig] of meta.sigs) {
                        if (isIntKey(sk)) {
                            const idx = +sk;
                            if (idx >= newLen) sig.set(undefined);
                        }
                    }
                }
                fireKey(meta, "length", newLen);
                // Release the shed tail's signals — otherwise every truncation
                // orphans them: unreachable from the store, so not even
                // `dispose(s)` can get them back.
                if (shed !== null) disposeDetachedMany(meta, shed);
                return true;
            }

            const hadKey = meta.hasSigs === undefined ? true : (k in t);

            t[k] = real;

            if (!hadKey) fireHas(meta, k, true);

            // Fire BEFORE dispose: effects that read the key see the new value
            // and re-run synchronously (or queue under batch). Disposing the
            // old subtree afterwards is safe — its signals are no longer
            // observed by the live effects.
            fireKey(meta, k, real);

            // Sparse-index writes bump length implicitly. The set trap above
            // saw key="100", not key="length", so we have to detect and fire
            // length manually.
            if (isArr && t.length !== oldArrLen) {
                fireKey(meta, "length", t.length);
            }

            // Dispose the old value's subtree IF it was a proxied object AND
            // it isn't us (cycle protection — see disposeSubtree).
            const oldMeta = isPlain(old) ? metaOf.get(old) : null;
            if (oldMeta && oldMeta !== meta) {
                disposeSubtree(oldMeta, meta);
            }
            meta.kids.delete(k);

            return true;
        },

        deleteProperty(t, k) {
            if (typeof k === "symbol") return Reflect.deleteProperty(t, k);

            const old = t[k];
            const had = k in t;
            delete t[k];

            if (had) {
                fireKey(meta, k, undefined);
                fireHas(meta, k, false);
            }

            const oldMeta = isPlain(old) ? metaOf.get(old) : null;
            if (oldMeta && oldMeta !== meta) {
                disposeSubtree(oldMeta, meta);
            }
            meta.kids.delete(k);

            return true;
        },

        has(t, k) {
            // `in` asks a presence question, so it subscribes to the EXISTENCE
            // lane only. It deliberately does not touch the value lane: a key
            // going "dark" -> "light" does not change whether it is present, and
            // waking `in` consumers for it is a spurious re-fire. The dedicated
            // lane is also what lets `in` see the two flips the value lane is
            // blind to — adding a key whose value is `undefined`, and deleting a
            // key that already held `undefined`, both of which Object.is
            // suppresses on the value lane.
            if (typeof k !== "symbol" && isTracking()) trackHas(meta, k, Reflect.has(t, k))();
            return Reflect.has(t, k);
        },
    };
}

/**
 * Array mutator wrappers. Each wraps the underlying Array.prototype method in
 * `batch(...)` and then iterates `meta.sigs` — the lazy signal map is already
 * a sparse tracker of "which indices anyone is watching", so we walk it once
 * and fire only the relevant subset. This is the smart-conservative strategy:
 * O(tracked indices), not O(array length).
 * @private
 */
const ARRAY_OPS = {
    push: (t, meta) => (...items) => batch(() => {
        const oldLen = t.length;
        const result = Array.prototype.push.apply(t, items);
        for (const [k, sig] of meta.sigs) {
            if (k === "length") { sig.set(t.length); continue; }
            if (isIntKey(k)) {
                const idx = +k;
                if (idx >= oldLen) sig.set(t[idx]);              // newly inserted indices
            }
        }
        return result;
    }),

    pop: (t, meta) => () => batch(() => {
        const result = Array.prototype.pop.call(t);
        for (const [k, sig] of meta.sigs) {
            if (k === "length") { sig.set(t.length); continue; }
            if (isIntKey(k)) {
                const idx = +k;
                if (idx >= t.length) sig.set(undefined);        // now out of bounds
            }
        }
        disposeDetachedOne(meta, result);
        return result;
    }),

    shift: (t, meta) => () => batch(() => {
        const result = Array.prototype.shift.call(t);
        for (const [k, sig] of meta.sigs) {
            if (k === "length") { sig.set(t.length); continue; }
            if (isIntKey(k)) sig.set(t[+k]);                    // every index shifted
        }
        disposeDetachedOne(meta, result);
        return result;
    }),

    unshift: (t, meta) => (...items) => batch(() => {
        const result = Array.prototype.unshift.apply(t, items);
        for (const [k, sig] of meta.sigs) {
            if (k === "length") { sig.set(t.length); continue; }
            if (isIntKey(k)) sig.set(t[+k]);
        }
        return result;
    }),

    splice: (t, meta) => (start, del, ...add) => batch(() => {
        // Normalize start to the actual position splice will use, so our key
        // filter matches what mutated. Mirrors Array.prototype.splice spec.
        const len = t.length;
        let s = start | 0;
        if (s < 0) s = Math.max(0, len + s);
        if (s > len) s = len;

        const result = Array.prototype.splice.call(t, start, del, ...add);
        for (const [k, sig] of meta.sigs) {
            if (k === "length") { sig.set(t.length); continue; }
            if (isIntKey(k)) {
                const idx = +k;
                if (idx >= s) sig.set(t[idx]);
            }
        }
        disposeDetachedMany(meta, result);
        return result;
    }),

    reverse: (t, meta) => () => batch(() => {
        const result = Array.prototype.reverse.call(t);
        for (const [k, sig] of meta.sigs) {
            if (isIntKey(k)) sig.set(t[+k]);
        }
        return result;
    }),

    sort: (t, meta) => (cmp) => batch(() => {
        const result = Array.prototype.sort.call(t, cmp);
        for (const [k, sig] of meta.sigs) {
            if (isIntKey(k)) sig.set(t[+k]);
        }
        return result;
    }),

    fill: (t, meta) => (value, start, end) => batch(() => {
        const len = t.length;
        let s = start === undefined ? 0 : (start | 0);
        let e = end === undefined ? len : (end | 0);
        if (s < 0) s = Math.max(0, len + s);
        if (e < 0) e = Math.max(0, len + e);
        if (e > len) e = len;
        const shed = collectTracked(t, s, e);
        const result = Array.prototype.fill.call(t, value, start, end);
        for (const [k, sig] of meta.sigs) {
            if (isIntKey(k)) {
                const idx = +k;
                if (idx >= s && idx < e) sig.set(t[idx]);
            }
        }
        if (shed !== null) disposeDetachedMany(meta, shed);
        return result;
    }),

    copyWithin: (t, meta) => (target, start, end) => batch(() => {
        // Conservative: any tracked index may have shifted; fire all of them.
        // Could be made more precise — copyWithin's affected range is
        // [target, target + (end - start)] — but copyWithin is rare and the
        // saving isn't worth the spec-tracking complexity in v1.
        const shed = collectTracked(t, 0, t.length);
        const result = Array.prototype.copyWithin.call(t, target, start, end);
        for (const [k, sig] of meta.sigs) {
            if (isIntKey(k)) sig.set(t[+k]);
        }
        if (shed !== null) disposeEvicted(meta, shed, t);
        return result;
    }),
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Wrap a plain object or array in a reactive store. Returns a Proxy that
 * looks and behaves like the original — direct mutation, normal property
 * access, all standard JS semantics — with the addition that reads inside
 * a reactive context (effect/computed/watch) become reactive dependencies
 * and writes fire the corresponding effects.
 *
 * @template T
 * @param {T} initial Plain object or array.
 * @returns {T} A proxy typed as T.
 * @throws {TypeError} If `initial` is not a plain object or array.
 */
export function store(initial) {
    // Idempotent: re-storing a proxy must not build a proxy-of-a-proxy, which
    // would give the same data two metas, two signal sets, and two identities.
    if (initial !== null && typeof initial === "object" && initial[META] !== undefined) {
        return initial;
    }
    if (!isPlain(initial)) {
        throw new TypeError("store(): expected a plain object or array");
    }
    return wrap(initial);
}

/**
 * Return the underlying target object of a store. Reads through the META
 * sentinel are NOT tracked — `unwrap(s).foo` is the escape hatch for non-
 * reactive access to the raw data.
 *
 * @template T
 * @param {T} s Store proxy (or any value; non-stores pass through).
 * @returns {T} The underlying target (same reference passed to `store()`).
 */
export function unwrap(s) {
    if (s === null || typeof s !== "object") return s;
    const m = s[META];
    return m ? m.target : s;
}

/**
 * Return a deep plain-data copy of a store's contents. Recursively unwraps
 * nested proxies and clones their targets. Useful for serialization,
 * persistence, structural comparison, or feeding to libraries that don't
 * tolerate proxies.
 *
 * Non-plain prototypes (Date, Map, Set, class instances) are copied by
 * reference, not cloned — matches the opaque-by-default model.
 *
 * @template T
 * @param {T} s
 * @returns {T}
 */
export function snapshot(s) {
    return snapClone(unwrap(s), new Map());
}

/**
 * Cycle-safe deep clone. The `seen` map is registered with the fresh container
 * BEFORE its children are walked, so a back-reference resolves to the clone
 * rather than recursing forever — and the clone reproduces the original's
 * sharing/cycle topology instead of exploding it into a tree.
 * @private
 */
function snapClone(t, seen) {
    if (t === null || typeof t !== "object") return t;
    if (!isPlain(t)) return t;                    // opaque prototypes: by reference
    const hit = seen.get(t);
    if (hit !== undefined) return hit;
    if (Array.isArray(t)) {
        const out = new Array(t.length);
        seen.set(t, out);
        for (let i = 0; i < t.length; i++) out[i] = snapClone(unwrap(t[i]), seen);
        return out;
    }
    const out = {};
    seen.set(t, out);
    for (const k of Object.keys(t)) out[k] = snapClone(unwrap(t[k]), seen);
    return out;
}

/**
 * Release every signal in the store's subtree back to lite-signal's pool.
 * After dispose, further mutations are silent (no signal exists to fire);
 * reads inside new reactive contexts re-allocate signals (zombie reactivation —
 * documented; the underlying target is still mutable). Call this at the end
 * of a component / scope / test to keep the node pool's active count honest.
 *
 * @param {object} s Store proxy.
 */
export function dispose(s) {
    if (s === null || typeof s !== "object") return;
    const m = s[META];
    if (m) disposeSubtree(m);
}

// ─── reconcile ──────────────────────────────────────────────────────────────

/**
 * Ensure `childTarget` has a meta (wrapping it if it was never read reactively)
 * and record it on the parent's `kids` so a later dispose walk finds it. Returns
 * the child meta, ready to recurse into. The wrap allocates one meta on first
 * touch — the same "first touch of a key" cost the store charges everywhere.
 * @private
 */
function childMetaFor(parentMeta, key, childTarget) {
    let cm = metaOf.get(childTarget);
    if (cm === undefined) { wrap(childTarget); cm = metaOf.get(childTarget); }
    parentMeta.kids.set(key, cm);
    return cm;
}

/**
 * True iff both are plain AND the same container kind (both arrays or both
 * objects). A shape flip (object→array at the same key) is NOT a recurse; it's
 * a replace, so the old subtree's signals dispose and the new value is wrapped
 * fresh.
 * @private
 */
function sameShape(a, b) {
    return isPlain(a) && isPlain(b) && Array.isArray(a) === Array.isArray(b);
}

/**
 * Reconcile one meta's target toward `next`, dispatching array vs object. A
 * container-shape mismatch at the root of a reconcile is a programmer error: a
 * store can't turn from an object into an array in place without discarding the
 * signals bound to it — assign through the parent key instead.
 * @private
 */
function reconcileNode(meta, next, keyFn) {
    if (!isPlain(next)) {
        throw new TypeError("reconcile(): replacement must be a plain object or array");
    }
    const tArr = Array.isArray(meta.target);
    const nArr = Array.isArray(next);
    if (tArr !== nArr) {
        throw new TypeError(
            "reconcile(): cannot reconcile an " + (tArr ? "array" : "object") +
            " against an " + (nArr ? "array" : "object") +
            " — assign through the parent key instead",
        );
    }
    if (tArr) {
        if (keyFn) reconcileArrayKeyed(meta, next, keyFn);
        else reconcileArrayPositional(meta, next, keyFn);
    } else {
        reconcileObject(meta, next, keyFn);
    }
}

/**
 * Object reconcile via the proxy's own set/delete traps: patch keys present in
 * `next` (recursing into same-shape nested containers to preserve their
 * identity and signals), delete keys absent from `next`. Every write routes
 * through the trap, so the Object.is short-circuit suppresses no-op fires and
 * replaced subtrees dispose exactly as a direct assignment would.
 * @private
 */
function reconcileObject(meta, next, keyFn) {
    const target = meta.target;
    const proxy = proxyOf.get(target);
    for (const k in next) {
        if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
        // `__proto__` is an accessor alias for [[Prototype]], not a data key.
        // JSON.parse DOES mint it as an own property, so a hostile payload
        // reaching reconcile would otherwise recurse into Object.prototype
        // (which is plain, so sameShape() waves it through) and write attacker
        // keys onto every object in the realm.
        if (k === "__proto__") continue;
        const cur = target[k];
        const nv = next[k];
        if (sameShape(cur, nv)) reconcileNode(childMetaFor(meta, k, cur), nv, keyFn);
        else if (!Object.is(cur, nv)) proxy[k] = nv;
    }
    // Delete keys absent from `next`. Deletes are deferred (so mutating the
    // object doesn't disturb the for-in walk) and the scratch array is allocated
    // ONLY when there is something to delete — the refetch-with-same-shape gate
    // path, where nothing is deleted, allocates nothing here.
    let del = null;
    for (const k in target) {
        if (k === "__proto__") continue;
        if (!Object.prototype.hasOwnProperty.call(next, k)) (del || (del = [])).push(k);
    }
    if (del) for (let i = 0; i < del.length; i++) delete proxy[del[i]];
}

/**
 * Positional (index-keyed) array reconcile — the default. Index i in the store
 * is patched against index i in `next`: same-shape rows recurse in place (their
 * target and signals survive; only changed leaves fire), scalar/replaced slots
 * write through the trap. Length changes truncate (disposing the dropped tail's
 * subtrees) or extend through the trap. This is the zero-GC path: a refetch that
 * returns fresh row objects with the same positions fires only the leaves that
 * differ and pulls nothing from the pool.
 * @private
 */
function reconcileArrayPositional(meta, next, keyFn) {
    const target = meta.target;
    const proxy = proxyOf.get(target);
    const oldLen = target.length;
    const newLen = next.length;
    const lim = newLen < oldLen ? newLen : oldLen;
    for (let i = 0; i < lim; i++) {
        const cur = target[i];
        const nv = next[i];
        if (sameShape(cur, nv)) reconcileNode(childMetaFor(meta, "" + i, cur), nv, keyFn);
        else if (!Object.is(cur, nv)) proxy[i] = nv;
    }
    if (newLen < oldLen) proxy.length = newLen;
    else if (newLen > oldLen) for (let i = oldLen; i < newLen; i++) proxy[i] = next[i];
}

/**
 * Keyed array reconcile (opts.key). Rows are matched across the old and new
 * arrays by key, so a moved row keeps its target and its whole signal subtree —
 * only its index signal fires. Matched same-shape rows recurse in place; rows
 * present before but gone now have their subtrees disposed; genuinely-new rows
 * enter as raw values (wrapped lazily on first read). This uses privileged
 * internal access (target + fireKey) rather than the set trap, because the trap
 * would dispose a row the instant it's overwritten at its old index — wrong when
 * that row has merely moved.
 * @private
 */
function reconcileArrayKeyed(meta, next, keyFn) {
    const target = meta.target;
    const oldLen = target.length;
    const newLen = next.length;

    // key -> current row. Duplicate keys spill into `dupes` (allocated only if
    // duplicates exist) so that each old row can be claimed by AT MOST ONE new
    // row. Without the claim discipline, two `next` rows sharing a key both
    // reuse the same target object and the array ends up aliasing one row into
    // two slots — writes to one silently rewrite the other. Scalars key by their
    // own value so a mixed/scalar array still reconciles sensibly.
    const oldByKey = new Map();
    let dupes = null;
    for (let i = 0; i < oldLen; i++) {
        const cur = target[i];
        const k = isPlain(cur) ? keyFn(cur) : cur;
        if (!oldByKey.has(k)) {
            oldByKey.set(k, cur);
        } else {
            if (dupes === null) dupes = new Map();
            let chain = dupes.get(k);
            if (chain === undefined) dupes.set(k, chain = []);
            chain.push(cur);
        }
    }
    // Sentinel: distinguishes "no row claimed" from "claimed a row whose value
    // happens to be undefined".
    const claim = (k) => {
        if (oldByKey.has(k)) {
            const v = oldByKey.get(k);
            oldByKey.delete(k);
            return v;
        }
        if (dupes !== null) {
            const chain = dupes.get(k);
            if (chain !== undefined && chain.length > 0) return chain.shift();
        }
        return UNCLAIMED;
    };

    // Build the reconciled sequence, patching reused rows in place.
    const reused = new Set();
    const out = new Array(newLen);
    for (let j = 0; j < newLen; j++) {
        const nv = next[j];
        const k = isPlain(nv) ? keyFn(nv) : nv;
        const cur = claim(k);
        if (cur !== UNCLAIMED && sameShape(cur, nv)) {
            reconcileNode(childMetaFor(meta, "" + j, cur), nv, keyFn);
            out[j] = cur;
            reused.add(cur);
        } else {
            out[j] = nv;
        }
    }

    // Dispose the signal subtrees of rows dropped from the array. The seen-set
    // in disposeSubtree tolerates a row reachable from more than one stale kid.
    for (let i = 0; i < oldLen; i++) {
        const cur = target[i];
        if (isPlain(cur) && !reused.has(cur)) {
            const cm = metaOf.get(cur);
            if (cm && cm !== meta) disposeSubtree(cm, meta);
        }
    }

    // Commit the sequence to the raw target, firing only indices whose element
    // identity actually changed (moves + replacements + fresh rows), then length.
    for (let i = 0; i < newLen; i++) {
        if (!Object.is(target[i], out[i])) {
            target[i] = out[i];
            fireKey(meta, "" + i, out[i]);
            // Stale kid entries are harmless (get trap repopulates on read;
            // disposeSubtree dedups), so only clear kids for non-reused slots.
            if (!reused.has(out[i])) meta.kids.delete("" + i);
        }
    }
    if (newLen < oldLen) {
        for (let i = newLen; i < oldLen; i++) { fireKey(meta, "" + i, undefined); meta.kids.delete("" + i); }
        target.length = newLen;
    }
    if (newLen !== oldLen) fireKey(meta, "length", newLen);
}

/**
 * Structural diff-apply. Patch `s` in place so its contents deep-equal `next`,
 * mutating only the leaves that actually differ — instead of `s.x = next`, which
 * disposes every signal under `s.x` and re-fires every observer of it. The
 * reactive win: a server refetch that changes three fields out of a thousand
 * rows fires three effects, disposes nothing, and allocates nothing from the
 * pool.
 *
 * Objects: keys in `next` are patched (recursing into same-shape nested
 * containers); keys absent from `next` are deleted. Arrays reconcile
 * positionally by default — index `i` patched against index `i`, each row's
 * target and signals preserved. Pass `opts.key` (a property name like `"id"`,
 * or `(item) => keyValue`) to match rows by identity across reorder / insert /
 * removal, so a moved row keeps its subtree and only its index signal fires; the
 * key applies to every array reached during the walk.
 *
 * Runs untracked (never subscribes) and inside one `batch`, so every leaf fire
 * coalesces into a single propagation and a multi-field consumer never observes
 * a torn, half-applied snapshot.
 *
 * Not a rollback primitive and not `produce`: there is no draft and no throw-to-
 * discard. Reconcile is the "make the store equal this fresh value, cheaply"
 * operation; a mid-walk throw (e.g. a `keyFn` that throws) leaves the
 * partially-applied writes in place, same as any mutable JS.
 *
 * @template T
 * @param {T} s A store proxy (root or a nested proxy).
 * @param {T} next Plain replacement data of the same container shape as `s`.
 * @param {{ key?: string | ((item: any) => unknown) }} [opts]
 * @returns {T} `s`.
 * @throws {TypeError} If `s` is not a store proxy, `next` is not plain, or the
 *   container shapes are incompatible (object vs array).
 */
export function reconcile(s, next, opts) {
    if (s === null || typeof s !== "object" || s[META] === undefined) {
        throw new TypeError("reconcile(): first argument must be a store proxy");
    }
    const keyOpt = opts && opts.key;
    const keyFn = typeof keyOpt === "function"
        ? keyOpt
        : (typeof keyOpt === "string"
            ? (item) => (item == null ? item : item[keyOpt])
            : null);
    untrack(() => batch(() => reconcileNode(s[META], next, keyFn)));
    return s;
}
