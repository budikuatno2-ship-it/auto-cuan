(function () {
  'use strict';

  if (window.__AUTOCUAN_FAST_WATCHER_WEB_REFRESH__) return;
  window.__AUTOCUAN_FAST_WATCHER_WEB_REFRESH__ = true;

  var POLL_INTERVAL_MS = 20000;
  var timer = null;
  var inFlight = false;
  var lastSignature = null;

  function currentScreenerType() {
    return String(window._currentScreenerType || '').toLowerCase();
  }

  function canRefresh() {
    return document.visibilityState === 'visible' &&
      currentScreenerType() === 'daytrade' &&
      !window._dtPollInterval;
  }

  function resultSignature(data) {
    var rows = data && Array.isArray(data.results) ? data.results : [];
    var compact = rows.map(function (row) {
      return [
        row && row.ticker,
        row && row.status,
        row && row.run_mode,
        row && row.run_id,
        row && row.calculated_at,
        row && row.last_price,
        row && row.daytrade_score
      ];
    });
    return JSON.stringify(compact);
  }

  function renderLatest(data) {
    window._dtScreenerCache = data;
    if (typeof window.updateDtMetaUI === 'function') {
      try { window.updateDtMetaUI(data.meta || {}); } catch (_) {}
    }
    if (typeof window.renderDtTable === 'function') {
      try { window.renderDtTable(data.results || [], data); } catch (_) {}
    }
    if (typeof window.renderDtCardGrid === 'function') {
      try { window.renderDtCardGrid(data.results || [], data); } catch (_) {}
    }
    if (typeof window.CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(new window.CustomEvent('autocuan:fast-watcher-web-refresh', {
          detail: {
            result_count: Array.isArray(data.results) ? data.results.length : 0,
            refreshed_at: Date.now()
          }
        }));
      } catch (_) {}
    }
  }

  async function refreshNow() {
    if (inFlight || !canRefresh()) return { refreshed: false, reason: inFlight ? 'in_flight' : 'inactive' };
    inFlight = true;
    try {
      if (lastSignature == null && window._dtScreenerCache) {
        lastSignature = resultSignature(window._dtScreenerCache);
      }
      var response = await fetch('/api/sector-hot?action=daytrade-screener&fw_live=' + Date.now(), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!response.ok) return { refreshed: false, reason: 'http_' + response.status };
      var data = await response.json().catch(function () { return null; });
      if (!data || data.success !== true) return { refreshed: false, reason: 'invalid_payload' };
      if (data.meta && data.meta.status === 'scanning') return { refreshed: false, reason: 'full_screener_running' };

      var signature = resultSignature(data);
      if (signature === lastSignature) return { refreshed: false, reason: 'unchanged' };
      lastSignature = signature;
      renderLatest(data);
      return { refreshed: true, reason: 'changed' };
    } catch (_) {
      return { refreshed: false, reason: 'request_failed' };
    } finally {
      inFlight = false;
    }
  }

  function tick() {
    if (canRefresh()) refreshNow();
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, POLL_INTERVAL_MS);
    setTimeout(tick, 1500);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') tick();
  });
  window.addEventListener('beforeunload', stop, { once: true });

  window.AutoCuanFastWatcherRefresh = {
    refreshNow: refreshNow,
    start: start,
    stop: stop,
    getState: function () {
      return {
        poll_interval_ms: POLL_INTERVAL_MS,
        in_flight: inFlight,
        active: Boolean(timer),
        last_signature_ready: lastSignature != null
      };
    }
  };

  start();
})();
