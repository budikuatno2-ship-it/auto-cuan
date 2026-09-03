'use strict';

let _stats = {
  totalRequests: 0,
  cacheHits: 0,
  geminiCalls: 0,
  localFallbacks: 0,
  totalLatencyMs: 0,
  latencyCount: 0
};

function recordRequest() {
  _stats.totalRequests++;
}

function recordCacheHit() {
  _stats.cacheHits++;
}

function recordGeminiCall(latencyMs) {
  _stats.geminiCalls++;
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0) {
    _stats.totalLatencyMs += latencyMs;
    _stats.latencyCount++;
  }
}

function recordLocalFallback() {
  _stats.localFallbacks++;
}

function getAiTelemetryStats() {
  const avgLatencyMs = _stats.latencyCount > 0
    ? Math.round((_stats.totalLatencyMs / _stats.latencyCount) * 100) / 100
    : 0;
  const cacheHitRate = _stats.totalRequests > 0
    ? Math.round((_stats.cacheHits / _stats.totalRequests) * 10000) / 10000
    : 0;

  return {
    total_requests: _stats.totalRequests,
    cache_hits: _stats.cacheHits,
    gemini_calls: _stats.geminiCalls,
    local_fallbacks: _stats.localFallbacks,
    average_latency_ms: avgLatencyMs,
    cache_hit_rate: cacheHitRate,
    // CamelCase aliases
    totalRequests: _stats.totalRequests,
    cacheHits: _stats.cacheHits,
    geminiCalls: _stats.geminiCalls,
    localFallbacks: _stats.localFallbacks,
    avgLatencyMs: avgLatencyMs,
    last_updated: new Date().toISOString()
  };
}

function resetAiTelemetryStats() {
  _stats = {
    totalRequests: 0,
    cacheHits: 0,
    geminiCalls: 0,
    localFallbacks: 0,
    totalLatencyMs: 0,
    latencyCount: 0
  };
}

module.exports = {
  recordRequest,
  recordCacheHit,
  recordGeminiCall,
  recordLocalFallback,
  getAiTelemetryStats,
  resetAiTelemetryStats
};
