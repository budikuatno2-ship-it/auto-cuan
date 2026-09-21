'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  recordRequest,
  recordCacheHit,
  getAiTelemetryStats,
  resetAiTelemetryStats
} = require('../lib/ai-telemetry');

test('BUG-AIT-01: getAiTelemetryStats must include cacheHitRate in camelCase aliases', () => {
  resetAiTelemetryStats();
  recordRequest();
  recordCacheHit();
  const stats = getAiTelemetryStats();
  assert.strictEqual(typeof stats.cacheHitRate, 'number', 'stats.cacheHitRate must be defined as a number, got undefined');
});

test('BUG-AIT-02: recordCacheHit must maintain consistent totalRequests or bound cache_hit_rate <= 1.0', () => {
  resetAiTelemetryStats();
  recordCacheHit();
  const stats = getAiTelemetryStats();
  assert.ok(stats.total_requests >= stats.cache_hits, `total_requests (${stats.total_requests}) must be at least cache_hits (${stats.cache_hits})`);
});
