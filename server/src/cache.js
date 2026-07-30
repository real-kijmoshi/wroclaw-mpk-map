'use strict';

/** Minimal LRU map — enough for caching serialised route shapes. */
class LruCache {
  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    // Re-insert so the most recently used key sits at the end.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    return value;
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { LruCache };
