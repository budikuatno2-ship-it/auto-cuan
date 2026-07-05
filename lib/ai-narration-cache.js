'use strict';

/**
 * AI Narration Cache — In-memory TTL cache for narrated messages.
 *
 * Cache key includes: notification_type + ticker + category/status + price levels + data hash.
 * Prevents redundant Gemini calls for the same event/data.
 *
 * Environment:
 *   GEMINI_NARRATION_CACHE_TTL_MS — TTL in ms (default: 900000 = 15 minutes)
 */

const crypto = require('node:crypto');

// In-memory store: Map<string, { text: string, expiresAt: number }>
const _cache = new Map();

/**
 * Get cache TTL from env (default 15 minutes).
 * @returns {number}
 */
function getCacheTtlMs() {
  const val = parseInt(process.env.GEMINI_NARRATION_CACHE_TTL_MS, 10);
  return isFinite(val) && val > 0 ? val : 900000;
}

/**
 * Build a deterministic cache key from notification data.
 * Includes type, ticker, status/category, and a content hash of price levels.
 *
 * @param {object} params
 * @param {string} params.type - Notification type (e.g., 'new_signal', 'tp1_hit', 'sl_hit', etc.)
 * @param {string} params.ticker - Stock ticker
 * @param {string} [params.category] - Category/status
 * @param {object} [params.data] - Relevant price levels and status values to hash
 * @returns {string}
 */
function buildCacheKey(params) {
  const parts = [
    String(params.type || 'unknown'),
    String(params.ticker || '').toUpperCase(),
    String(params.category || params.status || '')
  ];

  // Hash the data object to capture price level changes
  if (params.data && typeof params.data === 'object') {
    const sorted = JSON.stringify(params.data, Object.keys(params.data).sort());
    const hash = crypto.createHash('md5').update(sorted).digest('hex').slice(0, 12);
    parts.push(hash);
  }

  return parts.join('|');
}

/**
 * Get a cached narration if valid.
 * @param {string} key
 * @returns {string|null} - Cached text or null if miss/expired
 */
function get(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.text;
}

/**
 * Store a narration in cache.
 * @param {string} key
 * @param {string} text
 */
function set(key, text) {
  const ttl = getCacheTtlMs();
  _cache.set(key, { text: text, expiresAt: Date.now() + ttl });
}

/**
 * Clear all cache entries (useful for testing).
 */
function clear() {
  _cache.clear();
}

/**
 * Get current cache size (for diagnostics).
 * @returns {number}
 */
function size() {
  return _cache.size;
}

/**
 * Evict expired entries (housekeeping, called occasionally).
 * @returns {number} Number of entries evicted
 */
function evictExpired() {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of _cache) {
    if (now > entry.expiresAt) {
      _cache.delete(key);
      evicted++;
    }
  }
  return evicted;
}

module.exports = {
  buildCacheKey,
  get,
  set,
  clear,
  size,
  evictExpired,
  getCacheTtlMs
};
