'use strict';

/**
 * Growable typed-array builders for GTFS ingest.
 *
 * Collecting a million stop-time rows in a JS array and then copying it with
 * `Int32Array.from(...)` holds two copies of the numbers at peak — the JS
 * array's tagged slots and the typed array it becomes. These builders grow a
 * typed array in place and hand back an exact-size copy, so the ingest peak
 * holds the collection buffer plus one final copy, and none of the values is
 * ever a boxed JS number.
 */

const DEFAULT_INITIAL = 1 << 10;

class GrowableInt32Array {
  /**
   * @param {number} [initialCapacity]
   */
  constructor(initialCapacity = DEFAULT_INITIAL) {
    this.buffer = new Int32Array(Math.max(1, initialCapacity));
    this.length = 0;
  }

  push(value) {
    if (this.length === this.buffer.length) {
      const next = new Int32Array(this.buffer.length * 2);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer[this.length] = value;
    this.length += 1;
  }

  /** Exact-size Int32Array of the values pushed so far. */
  toArray() {
    return this.buffer.slice(0, this.length);
  }

  /**
   * Sort the collected values with `compare` and return them as an exact-size
   * Int32Array. Sorts in place on the used prefix — nothing extra is allocated
   * beyond the final copy.
   *
   * @param {(a: number, b: number) => number} compare
   */
  takeSorted(compare) {
    const used = this.buffer.subarray(0, this.length);
    used.sort(compare);
    return used.slice();
  }
}

class GrowableFloat64Array {
  /**
   * @param {number} [initialCapacity]
   */
  constructor(initialCapacity = DEFAULT_INITIAL) {
    this.buffer = new Float64Array(Math.max(1, initialCapacity));
    this.length = 0;
  }

  push(value) {
    if (this.length === this.buffer.length) {
      const next = new Float64Array(this.buffer.length * 2);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer[this.length] = value;
    this.length += 1;
  }

  /** Exact-size Float64Array of the values pushed so far. */
  toArray() {
    return this.buffer.slice(0, this.length);
  }
}

module.exports = { GrowableFloat64Array, GrowableInt32Array };
