'use strict';

/**
 * Auto-Cuan High-Performance In-Memory TTL Cache
 *
 * Provides sub-millisecond in-memory caching with:
 * - Configurable TTL per entry (default: 30,000 ms)
 * - Bounded maximum capacity with LRU eviction to prevent memory leaks
 * - Hit/Miss statistics and cache headers support
 * - Exact and prefix-based invalidation
 */

class InMemoryTtlCache {
  constructor(options = {}) {
    this.defaultTtlMs = options.defaultTtlMs || 30 * 1000;
    this.maxEntries = options.maxEntries || 500;
    this.store = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
      invalidations: 0
    };
  }

  get(key) {
    if (!key) return null;
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.store.delete(key);
      this.stats.misses++;
      return null;
    }

    // Refresh position for LRU
    this.store.delete(key);
    this.store.set(key, entry);
    this.stats.hits++;
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!key || value === undefined) return;
    const ttl = (typeof ttlMs === 'number' && ttlMs > 0) ? ttlMs : this.defaultTtlMs;
    const expiresAt = Date.now() + ttl;

    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      // Evict oldest entry (first item in Map)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        this.stats.evictions++;
      }
    }

    this.store.set(key, { value, expiresAt, createdAt: Date.now() });
    this.stats.sets++;
  }

  has(key) {
    return this.get(key) !== null;
  }

  invalidate(keyOrPrefix) {
    if (!keyOrPrefix) return 0;
    let count = 0;
    if (this.store.has(keyOrPrefix)) {
      this.store.delete(keyOrPrefix);
      count++;
    } else {
      for (const key of this.store.keys()) {
        if (key.startsWith(keyOrPrefix)) {
          this.store.delete(key);
          count++;
        }
      }
    }
    this.stats.invalidations += count;
    return count;
  }

  clear() {
    const size = this.store.size;
    this.store.clear();
    this.stats.invalidations += size;
  }

  async getOrSet(key, computeFn, ttlMs) {
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    const computed = await computeFn();
    if (computed !== undefined && computed !== null) {
      this.set(key, computed, ttlMs);
    }
    return computed;
  }

  getStats() {
    return {
      ...this.stats,
      size: this.store.size,
      maxEntries: this.maxEntries,
      defaultTtlMs: this.defaultTtlMs
    };
  }
}

// Global shared instances for hot endpoints
const hotQuoteCache = new InMemoryTtlCache({ defaultTtlMs: 30 * 1000, maxEntries: 300 });
const hotMarketStructureCache = new InMemoryTtlCache({ defaultTtlMs: 30 * 1000, maxEntries: 50 });
const hotSectorCache = new InMemoryTtlCache({ defaultTtlMs: 30 * 1000, maxEntries: 100 });

module.exports = {
  InMemoryTtlCache,
  hotQuoteCache,
  hotMarketStructureCache,
  hotSectorCache
};
