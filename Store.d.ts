/**
 * @zakkster/lite-store — type declarations.
 *
 * The proxy returned by `store(initial)` is typed *as* the initial value, so
 * existing snippets that mutate plain objects/arrays type-check unchanged.
 * There is no separate `Store<T>` wrapper type — the value IS the proxy.
 */

/**
 * Wrap a plain object or array in a reactive store. Returns a Proxy that
 * looks and behaves like the original — direct mutation, normal property
 * access — with the addition that reads inside a reactive context
 * (effect/computed/watch) become reactive dependencies and writes fire
 * the corresponding effects.
 *
 * @throws {TypeError} If `initial` is not a plain object or array.
 */
export declare function store<T extends object>(initial: T): T;

/**
 * Return the underlying target object of a store. Reads through `unwrap` are
 * NOT tracked, even inside a reactive context.
 *
 * Pass-through behaviour: if `s` is not a store, it is returned unchanged.
 */
export declare function unwrap<T>(s: T): T;

/**
 * Return a deep plain-data copy of a store's contents. Recursively unwraps
 * nested proxies and clones their targets.
 *
 * Non-plain prototypes (Date, Map, Set, class instances) are copied by
 * reference, not cloned — matching the opaque-by-default model.
 */
export declare function snapshot<T>(s: T): T;

/**
 * Release every signal in the store's subtree back to lite-signal's pool.
 * After dispose, further mutations are silent (no signal exists to fire);
 * reads inside new reactive contexts re-allocate signals (zombie reactivation —
 * documented; the underlying target is still mutable).
 */
export declare function dispose(s: object): void;

/** Options for {@link reconcile}. */
export interface ReconcileOptions {
    /**
     * Match array rows by identity across reorder / insert / removal instead of
     * by position. A property name (`"id"`) or a key function (`(item) => key`).
     * Applies to every array reached during the walk. Omit for positional
     * (index-keyed) reconciliation — the default.
     */
    key?: string | ((item: any) => unknown);
}

/**
 * Structural diff-apply. Patch `s` in place so its contents deep-equal `next`,
 * mutating only the leaves that actually differ — instead of `s.x = next`, which
 * disposes every signal under `s.x` and re-fires every observer of it.
 *
 * Objects patch present keys (recursing into same-shape nested containers) and
 * delete absent ones. Arrays reconcile positionally by default; pass `opts.key`
 * to match rows by identity so a moved row keeps its signal subtree and only its
 * index signal fires. Runs untracked and batched.
 *
 * @throws {TypeError} If `s` is not a store proxy, `next` is not plain, or the
 *   container shapes are incompatible (object vs array).
 */
export declare function reconcile<T extends object>(s: T, next: T, opts?: ReconcileOptions): T;
