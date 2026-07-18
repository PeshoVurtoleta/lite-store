# Changelog

All notable changes to `@zakkster/lite-store` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-16

### Added

- **`reconcile(s, next, opts?)`** — structural diff-apply for wholesale data
  replacement (a server refetch, `lite-query` integration). Patches `s` in place
  so its contents deep-equal `next`, mutating only the leaves that actually
  differ, instead of `s.x = fresh` — which disposes every signal under `s.x` and
  re-fires every observer of it.
  - Objects patch keys present in `next` (recursing into same-shape nested
    objects/arrays so their proxy identity and signals survive) and delete keys
    absent from it.
  - Arrays reconcile **positionally by default** (index `i` patched against
    `next[i]`, each row's target and signals preserved) — the zero-GC path.
  - **`opts.key`** (a property name like `"id"`, or `(item) => keyValue`) matches
    rows **by identity** across reorder / insert / removal, so a moved row keeps
    its whole signal subtree and only its index signal fires. The key applies to
    every array reached during the walk.
  - Runs **untracked** (never subscribes) and inside one **`batch`** (a
    multi-field consumer never observes a torn, half-applied snapshot).
  - Not `produce` and not a rollback primitive: no draft, no throw-to-discard.

### Fixed

Found by the adversarial suite below before 1.1.0 shipped. Every entry is a bug
that passed the original 1.1.0 tests.

- **Array shrink paths leaked signals.** `pop` / `shift` / `splice` / `fill` /
  `copyWithin` / `length = n` fired the right signals but never disposed the rows
  they shed. Those signals stayed checked out of the pool forever — unreachable
  from the store, so not even `dispose(s)` could reclaim them. A capped feed
  (push one, shed one) bled the pool indefinitely; it now holds a flat ledger.
- **`in` could not see existence.** Existence is now tracked on its own signal
  lane, so adding a key whose value is `undefined`, or deleting a key that
  already held `undefined`, re-fires an `in` consumer — the value lane cannot
  see either, since `Object.is(undefined, undefined)` suppresses the fire. Both
  lanes are coalesced into one propagation, so a mutation that flips existence
  *and* value still re-runs the consumer exactly once. The lane is allocated
  lazily: a store nobody probes with `in` pays nothing.
- **Frozen data made a store unreadable.** A frozen target's own properties are
  non-writable and non-configurable, so the proxy `get` invariant forbids
  returning a child proxy — the engine threw. Frozen subtrees are now handed
  back as-is (they cannot change, so they need no reactivity) and no longer
  deaden their reactive siblings.
- **`length` assignment ignored the spec.** A bare `| 0` accepted `length = 4.5`
  and `length = -1` (both `RangeError` per spec) and mangled `length = 2**32-1`
  (legal). Now ToUint32 with round-trip validation.
- **Array method identity churned.** `s.push !== s.push`: every access minted a
  fresh closure, so a hot `s.rows.push(x)` loop allocated one per call and
  identity-keyed consumers (memo deps, `===` guards) never settled. Wrappers are
  now cached per store node.
- **`store(alreadyAStore)` built a proxy-of-a-proxy** — one dataset with two
  metas, two signal sets and two identities. It is now idempotent.
- **`snapshot()` overflowed on cycles.** A self-reference, mutual reference or
  diamond recursed until the stack blew. It is now cycle-safe and reproduces the
  original's sharing topology instead of exploding it into a tree.
- **`reconcile()` treated `__proto__` as data.** `reconcile` is documented as the
  "apply the server refetch" path, so its input is untrusted by construction —
  and `JSON.parse` mints `__proto__` as a real own property. A hostile payload
  reached `Object.prototype`. Those keys are now skipped in both directions.
- **Keyed `reconcile()` aliased rows on duplicate keys.** Two `next` rows sharing
  a key both claimed the same old row, so two slots ended up backed by one
  target and patching `rows[i]` silently rewrote `rows[j]`. Each old row is now
  claimed by at most one new row.

### Verified

- **Gate:** replacing 1000 rows where 3 changed fires exactly 3 effects, with the
  signal pool flat (0 allocations, 0 disposals) against `lite-signal`'s `stats()`
  counters. Keyed reorder keeps every row's proxy identity and signal subtree.
- 19 new tests (`test/Reconcile.test.js`) plus the adversarial regression suite
  (`test/Torture.test.js`); **129 tests total**, `node --test`.
- No read-path cost: `store` read/splice benchmarks are unchanged, and array
  `push` measures ~6% faster from the cached method wrappers (interleaved A/B,
  median of 7).

### Honest non-claim

- Keyed reconcile builds a transient `Map` / `Set` / scratch array (JS-heap
  handles the pool counters do not see). Positional reconcile of a same-shape
  refetch allocates nothing on either the pool or the JS heap.

### Torture

- `test/Torture.test.js` — adversarial regression suite, part of the normal
  `npm test`. Every case is one of the bugs listed under **Fixed**, named by the
  failure mode it defends. Pool accounting is asserted against a **fixed-ceiling**
  registry: a roomy `onCapacityExceeded: "grow"` pool turns a hard leak into an
  invisible bleed.
- `bench/torture/reconcile-fuzzer.mjs` (opt-in: `npm run test:torture`) — seeded,
  oracle-checked fuzz: deep random mutation convergence (snapshot === next),
  keyed reorder/insert/remove preserving surviving-row target identity,
  duplicate-key slot disjointness over a deliberately tiny keyspace, a long
  same-shape refetch that stays pool-flat, a bounded feed that must return its
  nodes under a hard ceiling, and hostile `__proto__` payloads. Scale with
  `TORTURE_SCALE`. Dev-only; not in `files[]`.

## [1.0.0] - 2026-06

### Added

- Initial release. Fine-grained reactivity for plain objects and arrays on
  `@zakkster/lite-signal`: `store`, `unwrap`, `snapshot`, `dispose`.
- WeakMap-cached proxies with lazy per-key signals (a property becomes reactive
  only on its first read inside a reactive context — plain reads allocate
  nothing), proxy identity preserved across reads, and cycle-safe subtree
  disposal on overwrite.
- Full array-mutator coverage (`push`/`pop`/`shift`/`unshift`/`splice`/`sort`/
  `reverse`/`fill`/`copyWithin`) firing only tracked indices, plus `length`
  truncation/extension semantics.
- Opaque-by-default for non-plain prototypes (Date, Map, Set, RegExp, class
  instances). 75 tests, `node --test`.
