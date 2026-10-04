'use strict';

class Cache {
  constructor(maxSize = 300) { this.maxSize = maxSize; this.entries = new Map(); this.pending = new Map(); }
  async get(key, ttl, loader) {
    const entry = this.entries.get(key);
    if (entry && entry.until > Date.now()) {
      this.entries.delete(key); this.entries.set(key, entry);
      return entry.value;
    }
    this.entries.delete(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = Promise.resolve().then(loader).then(value => {
      // Avoid caching missing pages or temporary empty stream results.
      if (value != null && (!Array.isArray(value) || value.length)) {
        this.entries.delete(key);
        if (this.entries.size >= this.maxSize) this.entries.delete(this.entries.keys().next().value);
        this.entries.set(key, { value, until: Date.now() + ttl });
      }
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

module.exports = { Cache, mapLimit };
