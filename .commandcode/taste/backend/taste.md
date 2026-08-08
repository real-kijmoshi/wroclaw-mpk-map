# Taste — Backend / Engineering

- Performance instrumentation must use bounded O(1) per-metric state (latest, EWMA, max, count — no unbounded history or arrays), sample expensive measurements (e.g. memory) only at meaningful build/poll boundaries rather than than a continuous background timer, and avoid measurably slowing hot paths (few sub-µs timing calls, e.g. `performance.now()`). Confidence: 0.85
- Times distinct pipeline stages separately (e.g. fetch, normalize, merge, describe, snapshot) rather than wrapping the whole operation in a single timer and copying that one value into multiple metrics. Confidence: 0.85
- Keeps a separate metric set per independent subsystem/poll cycle (e.g. Open Data polling vs. the primary MPK polling) rather than conflating their timings into one shared block. Confidence: 0.8
- On failure, records the overall poll duration but does not record per-stage timings for stages that never executed — last successful stage values are preserved rather than overwritten, and no NaN/Infinity is ever stored. Confidence: 0.8
- Factors shared cross-cutting utilities (e.g. rolling metrics) into a very small, dependency-free internal helper module with a minimal API (`record`/`snapshot`); does not build an observability framework. Confidence: 0.75
- Communicates via detailed written task specs with explicit required semantics, architecture guidance, test lists, and "do not break" constraints. Confidence: 0.6
- At continuation points mid-task, prefers terse, polite signals ("carry on pls") rather than re-explaining or demanding full status reports — trusts the work to resume from where it left off. Confidence: 0.75
- Prefers transactional/atomic state updates: build a candidate snapshot separately, fully parse/index/validate it, then atomically swap it in — never mutate the live/active state in place during a refresh. Confidence: 0.9
- Prioritizes correctness and availability; on any failure the previous good state must stay fully intact and keep serving requests (fail-safe design, no partial old/new data). Confidence: 0.8
- Cache invalidation must be tied to data generations and happen only after a successful commit — never clear caches merely because a refresh started. Confidence: 0.8
- Version/generation counters used for cache invalidation must be strictly monotonic and never recycled (even across a reset), so stale cache entries can never be mistaken for a fresh generation after a rebuild. Confidence: 0.75
- Avoids arbitrary long TTLs for time-sensitive cached data; time-sensitive output must not go stale across requests even if other cache keys (e.g. position) are unchanged. Confidence: 0.7
- Prefers the smallest robust design over elaborate architectures ("Prefer the smallest robust design"). Confidence: 0.7
- Wants strong, explicit test coverage for correctness-critical changes — enumerates failure modes, atomicity guarantees, and cache-invalidation edge cases to be tested. Confidence: 0.7
- Keeps the server stack dependency-light: no Redis, no database, no external infrastructure; prefers in-memory solutions. Confidence: 0.6
- Preserves existing optimizations, public API wire formats, and behaviors when refactoring — no gratuitous rewrites or breaking changes ("do not mutate the public wire format for convenience"). Confidence: 0.6

### Testing & cache design
- Uses the Node.js native test runner (`node:test` with `describe`/`it` and `node:assert/strict`) rather than a third-party framework — tests run via `node --test test/*.test.js`. Confidence: 0.95
- Writes deterministic tests for time-sensitive logic by injecting `now`/TTL/revision/generation into the cache constructor and methods rather than sleeping on the real clock or mocking `Date`. Confidence: 0.85
- Asserts rejections with a matching regex (`assert.rejects(() => store.refresh(), /pattern/)`) rather than catching and re-throwing. Confidence: 0.8
- Specialized caches extend the shared `LruCache` base class (e.g. `VehicleDetailCache extends LruCache`) instead of being built from scratch or wrapping it opaquely. Confidence: 0.75
- Avoid modifying CI configuration as part of feature work; the user manages CI separately and doesn't want it touched. Confidence: 0.65
- Prefers in-house, dependency-free test helpers over adding undeclared or transitively-resolved test utilities (e.g. writing a tiny fake clock instead of pulling in a timer library); reverts package.json changes not strictly required by the task. Confidence: 0.75
- Syntax-checks changed source files with `node --check` before running the test suite as a fast pre-gate. Confidence: 0.65
- Avoids external monitoring services and specialized search/indexing libraries (e.g. Elasticsearch, SQLite FTS, Fuse.js, third-party observability stacks); prefers lightweight in-house solutions and a dependency-free stack. Confidence: 0.85
- Precomputes derived/normalized data once at load or index time and reuses a single shared function for both indexing and querying, instead of recomputing the same derivation per query. Confidence: 0.8
- Does not expose internal/normalized/derived fields, secrets, upstream request bodies, or raw upstream data through API responses; keeps responses compact and free of implementation details. Confidence: 0.8
- For final task delivery, expects a comprehensive structured report covering: approach/structure chosen, the bug reproduced and fixed, metrics added, estimated instrumentation overhead, tests added, and files changed. Confidence: 0.7
- Expects final reports to include before/after complexity analysis and an explicit list of any optimizations deliberately skipped (with rationale) — not just what was changed. Confidence: 0.8
- Writes true HTTP-level regression tests (not just helper/unit tests) that exercise the full request/response cycle, and ensures they demonstrably fail against the old buggy behavior to prove they are genuine regression guards. Confidence: 0.8
- Expects final reports to follow a specific numbered structure: root cause, old vs. new architecture, semantics of new counters, fields considered public content, root cause of lag, ordering after fix, HTTP cache policy before/after, regression tests added, end-to-end scenario result, files changed, and confirmation that existing optimizations/API formats were not changed. Confidence: 0.7

### Differential testing & benchmarks
- Practices differential testing against a frozen-in-time reference implementation: before removing old logic, copies the previous algorithm verbatim into test helpers and asserts both produce identical output over generated/randomized cases. Confidence: 0.8
- Benchmark scripts must not depend on live network access; they synthesize data locally. Confidence: 0.85
- Expects benchmark scripts as a deliverable, run via `npm run`, reporting operations/sec (or total duration) and approximate temporary allocation behavior (heap deltas with `--expose-gc`). Confidence: 0.8
- Wants benchmark coverage across problem-size scales (e.g. ~10, ~100, ~1,000, ~10,000 items) plus realistic production-scale sizes, so asymptotic behavior is visible. Confidence: 0.75
- Benchmark scripts that compare an old vs. new implementation first assert numerical equivalence between the two on the same generated dataset (differential correctness check) before reporting any timings. Confidence: 0.8
- Benchmark output directly compares reference vs. optimized: labels each implementation, prints per-dataset timings, and reports a speedup ratio (e.g. `reference: X ms / optimized: Y ms / speedup: Zx`). Confidence: 0.8
- Generates synthetic benchmark datasets with realistic structure (multiple routes/lines and spatially-distributed vehicle positions) using a deterministic seed, never live network data. Confidence: 0.75
- Will accept a benchmark being skipped if it proves negligible or complicates correctness, provided the skip is explained in the final report. Confidence: 0.75

### Unicode & string processing
- Prefers Unicode-aware text processing (e.g. `\p{L}`/`\p{N}` Unicode property escapes with the `u` flag) over ASCII-only patterns like `[a-z0-9]` when handling non-Latin text such as Polish diacritics. Confidence: 0.9
- Avoids blindly transliterating non-Latin letters (e.g. `ł` is preserved rather than collapsed to `l`) unless intentional, lossy normalization is required; letters must remain letters when determining word boundaries. Confidence: 0.8

### Cache invalidation & HTTP caching
- Separates poll_revision from public_content_revision: poll_revision advances on every accepted poll (for internal freshness + vehicle-detail cache TTL), content/snapshot_revision advances only when /locations-visible state changes (drives body-cache + ETag invalidation). One quiet poll must not invalidate cached responses. Confidence: 0.85
- Checks underlying content freshness before returning any cached serialized body — a body-cache hit must never be served until the server has verified the fleet/public state it represents is still current. The combined state key is recomputed on every request; only if it is unchanged does the body cache get a chance to hit. Confidence: 0.85
- Uses `Cache-Control: public, no-cache` (storage allowed, revalidation required) for time-sensitive but cacheable endpoints like GTFS-derived shapes, rather than long max-age TTLs or disabling caching entirely — the smallest robust solution that still permits efficient 304 revalidation. Confidence: 0.8
- Does not disable body caching entirely as the permanent solution to a stale-cache problem; the fix is fresher invalidation logic, not removing the cache. Confidence: 0.8
- Prefers strong ETags (e.g. sha1 of the body) with manual `If-None-Match` comparison over relying on framework-provided weak ETags — the framework's weak ETag comparison did not produce 304s, so conditional requests re-downloaded the body every time. Confidence: 0.8
- Enumerates every field that participates in a public API response when deciding whether content changed, rather than maintaining an incomplete manual comparison — "account for every field that affects /locations." Confidence: 0.8

### Algorithmic & design conventions
- Prefers returning richer results (e.g. offset + segment index + sorted flag) so callers can reuse the located segment and avoid a second linear walk over the same data. Confidence: 0.7
- Requires documenting any change to timing/interval semantics (e.g. interval measured from completion instead of start) rather than silently changing operational behavior. Confidence: 0.8
- Owns "schedule the next poll" in exactly one place (a loop runner like `#runPollLoop`); the poll body itself never self-schedules and `start()` only launches that single runner, so a double `start()` or a `stop()` racing an in-flight poll cannot stack or orphan timers. Confidence: 0.8
- Detects availability/ready state via an explicit active-state reference (e.g. a committed snapshot ref, `hasActiveSnapshot`) rather than a monotonic counter such as `generation`, which survives resets and would otherwise falsely suggest usable data is live. Confidence: 0.8
- Prefers passing mutable state (e.g. source, stale) as explicit parameters to snapshot builders (`#rebuildSnapshot({ source, stale })`) rather than having the builder implicitly read mutable fields — makes ordering a non-issue and reduces hidden coupling. Confidence: 0.85
- Finalizes status updates (source, consecutiveFailures, etc.) before constructing the public snapshot, so the snapshot never lags one poll behind the tracker's actual state — "successful status must be finalized before public snapshot construction." Confidence: 0.85
