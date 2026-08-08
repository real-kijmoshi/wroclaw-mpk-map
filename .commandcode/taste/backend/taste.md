- Communicates via detailed written task specs with explicit required semantics, architecture guidance, test lists, and "do not break" constraints. Confidence: 0.6
- At continuation points mid-task, prefers terse, polite signals ("carry on pls") rather than re-explaining or demanding full status reports — trusts the work to resume from where it left off. Confidence: 0.75# Taste — Backend / Engineering
- Prefers transactional/atomic state updates: build a candidate snapshot separately, fully parse/index/validate it, then atomically swap it in — never mutate the live/active state in place during a refresh. Confidence: 0.9
- Prioritizes correctness and availability; on any failure the previous good state must stay fully intact and keep serving requests (fail-safe design, no partial old/new data). Confidence: 0.8
- Cache invalidation must be tied to data generations and happen only after a successful commit — never clear caches merely because a refresh started. Confidence: 0.8
- Avoids arbitrary long TTLs for time-sensitive cached data; time-sensitive output must not go stale across requests even if other cache keys (e.g. position) are unchanged. Confidence: 0.7
- Prefers the smallest robust design over elaborate architectures ("Prefer the smallest robust design"). Confidence: 0.7
- Wants strong, explicit test coverage for correctness-critical changes — enumerates failure modes, atomicity guarantees, and cache-invalidation edge cases to be tested. Confidence: 0.7
- Keeps the server stack dependency-light: no Redis, no database, no external infrastructure; prefers in-memory solutions. Confidence: 0.6
- Preserves existing optimizations, public API wire formats, and behaviors when refactoring — no gratuitous rewrites or breaking changes ("do not mutate the public wire format for convenience"). Confidence: 0.6
- Communicates via detailed written task specs with explicit required semantics, architecture guidance, test lists, and "do not break" constraints. Confidence: 0.6

### Testing & cache design
- Uses the Node.js native test runner (`node:test` with `describe`/`it` and `node:assert/strict`) rather than a third-party framework — tests run via `node --test test/*.test.js`. Confidence: 0.95
- Writes deterministic tests for time-sensitive logic by injecting `now`/TTL/revision/generation into the cache constructor and methods rather than sleeping on the real clock or mocking `Date`. Confidence: 0.85
- Asserts rejections with a matching regex (`assert.rejects(() => store.refresh(), /pattern/)`) rather than catching and re-throwing. Confidence: 0.8
- Specialized caches extend the shared `LruCache` base class (e.g. `VehicleDetailCache extends LruCache`) instead of being built from scratch or wrapping it opaquely. Confidence: 0.75
