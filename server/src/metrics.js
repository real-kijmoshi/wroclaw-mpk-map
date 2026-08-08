'use strict';

const { performance } = require('node:perf_hooks');

/**
 * A bounded rolling metric: just enough to describe a hot path without
 * holding any history. Each record folds into latest / EWMA / max / count,
 * so memory is O(1) no matter how long the process runs.
 */
class Metric {
  constructor({ alpha = 0.3 } = {}) {
    this.alpha = alpha;
    this.count = 0;
    this.latest = null;
    this.ewma = null;
    this.max = null;
  }

  record(value) {
    if (!Number.isFinite(value)) return;
    this.latest = value;
    this.ewma = this.ewma === null ? value : this.alpha * value + (1 - this.alpha) * this.ewma;
    if (this.max === null || value > this.max) this.max = value;
    this.count += 1;
  }

  reset() {
    this.count = 0;
    this.latest = null;
    this.ewma = null;
    this.max = null;
  }

  /** @returns {{ latest: number|null, ewma: number|null, max: number|null, count: number }} */
  snapshot() {
    return { latest: this.latest, ewma: this.ewma, max: this.max, count: this.count };
  }
}

/**
 * Time one synchronous operation and return both the result and the elapsed
 * milliseconds, so callers can time a stage without unwrapping a tuple
 * manually: `const { ms, result } = timeSync(() => this.#buildRoutes(zip));`
 */
const timeSync = (fn) => {
  const startedAt = performance.now();
  const result = fn();
  return { ms: performance.now() - startedAt, result };
};

/**
 * Time one async operation the same way as `timeSync`.
 */
const timeAsync = async (fn) => {
  const startedAt = performance.now();
  const result = await fn();
  return { ms: performance.now() - startedAt, result };
};

module.exports = { Metric, timeAsync, timeSync };
