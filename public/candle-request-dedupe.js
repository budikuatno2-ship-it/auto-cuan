'use strict';
/**
 * TASK E — shared in-flight candle request dedupe (browser only).
 *
 * Two independent UI features request the exact same `/api/candles?ticker=X`
 * during one Analisis navigation:
 *   - b3-liquidity-inject.js (header liquidity badge)
 *   - unified-cockpit-runtime.js (chart load)
 *
 * This helper coalesces concurrent identical requests into one network call and
 * shares the parsed response with all callers. It is a pure transport wrapper:
 * no data mutation, no persistence, no provider/quota logic, no secrets.
 */
(function (root) {
  'use strict';
  if (!root || root.__AUTOCUAN_CANDLE_DEDUPE__) return;

  var inflight = Object.create(null);
  var TTL_MS = 5000; // short-lived: never mask a genuinely refreshed candle set

  function keyFor(url) {
    try {
      var u = new URL(String(url), root.location ? root.location.href : 'http://localhost/');
      return u.pathname + '?' + u.searchParams.toString();
    } catch (_) {
      return String(url);
    }
  }

  function fetchCandlesOnce(url, options) {
    var key = keyFor(url);
    var now = Date.now();
    var hit = inflight[key];
    if (hit && (now - hit.at) < TTL_MS && hit.promise) return hit.promise;

    var promise = root.fetch(url, options).then(function (response) {
      // Cache the Response clone so every caller can parse it independently.
      var clone = (response && typeof response.clone === 'function') ? response.clone() : response;
      return { response: response, clone: clone };
    }).catch(function (err) {
      if (inflight[key] && inflight[key].promise === promise) delete inflight[key];
      throw err;
    });

    inflight[key] = { at: now, promise: promise };
    return promise;
  }

  root.__AUTOCUAN_CANDLE_DEDUPE__ = {
    fetchCandlesOnce: fetchCandlesOnce,
    keyFor: keyFor,
    _inflight: inflight
  };
})(typeof window !== 'undefined' ? window : this);
