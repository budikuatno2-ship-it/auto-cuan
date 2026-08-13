(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PatternMap = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var POINT_NAMES = ['X', 'A', 'B', 'C', 'D'];
  var LEVEL_NAMES = ['confirmation', 'invalidation', 'tp1', 'tp2', 'currentPrice'];
  var EMPTY_MESSAGE = 'Belum ada pattern yang dapat divisualisasikan untuk saham ini.';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Pattern figures are rendered locally as inline SVG by pattern-visual.js.
  // Everything that existed here to build a Chart.js config, POST it to
  // quickchart.io, cache the returned PNG blob and pick a raster resolution per
  // viewport has been removed with that dependency: no part of Auto-Cuan sends
  // ticker, price series or pattern geometry to a third-party service, and an
  // SVG needs no devicePixelRatio choice to stay crisp.

  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  function boundedText(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && /^[\w .:/+\-]+$/.test(value);
  }
  function validDate(value) {
    if (!DATE_RE.test(String(value || ''))) return false;
    var date = new Date(value + 'T00:00:00Z');
    return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function normalizeTicker(value) { return String(value || '').trim().toUpperCase().replace(/\.JK$/, ''); }
  function validCandle(candle) {
    return plain(candle) && validDate(candle.time) && ['open', 'high', 'low', 'close'].every(function(key) { return finite(candle[key]); }) &&
      candle.high >= candle.open && candle.high >= candle.close && candle.high >= candle.low &&
      candle.low <= candle.open && candle.low <= candle.close && candle.low <= candle.high;
  }
  function sameCandle(left, right) {
    return validCandle(left) && validCandle(right) && left.time === right.time &&
      ['open', 'high', 'low', 'close'].every(function(key) { return left[key] === right[key]; });
  }

  // This validates a renderer contract; it never detects a pattern or derives a level.
  function validateCandidate(candidate, context) {
    if (!plain(candidate) || !plain(context)) return { valid: false, reason: 'untrusted_object' };
    if (!boundedText(candidate.id, 80)) return { valid: false, reason: 'invalid_id' };
    if (!boundedText(candidate.ruleVersion, 80)) return { valid: false, reason: 'invalid_rule_version' };
    if (!boundedText(candidate.name, 100) || !boundedText(candidate.status, 32)) return { valid: false, reason: 'invalid_identity' };
    if (!boundedText(candidate.provenance, 160)) return { valid: false, reason: 'missing_provenance' };
    var ticker = normalizeTicker(candidate.ticker);
    if (!/^[A-Z]{3,5}$/.test(ticker) || ticker !== normalizeTicker(context.ticker)) return { valid: false, reason: 'ticker_mismatch' };
    if (candidate.timeframe !== '1D' || context.timeframe !== '1D') return { valid: false, reason: 'unsupported_timeframe' };
    if (!validDate(candidate.dataDate) || candidate.dataDate !== context.dataDate) return { valid: false, reason: 'data_date_mismatch' };
    if (!Array.isArray(candidate.candles) || !Array.isArray(context.candles) || candidate.candles.length < 5 || candidate.candles.length !== context.candles.length) {
      return { valid: false, reason: 'candle_set_mismatch' };
    }
    for (var i = 0; i < candidate.candles.length; i++) {
      if (!validCandle(candidate.candles[i])) return { valid: false, reason: 'invalid_ohlc' };
      if (i && candidate.candles[i - 1].time >= candidate.candles[i].time) return { valid: false, reason: 'unordered_candles' };
    }
    for (var sourceIndex = 0; sourceIndex < candidate.candles.length; sourceIndex++) {
      if (!sameCandle(candidate.candles[sourceIndex], context.candles[sourceIndex])) return { valid: false, reason: 'candle_set_mismatch' };
    }
    if (candidate.candles[candidate.candles.length - 1].time !== candidate.dataDate) return { valid: false, reason: 'candle_date_mismatch' };
    if (!plain(candidate.points)) return { valid: false, reason: 'missing_points' };
    var priorDate = null;
    for (var p = 0; p < POINT_NAMES.length; p++) {
      var point = candidate.points[POINT_NAMES[p]];
      if (!plain(point) || !validDate(point.time) || !finite(point.value) || !Number.isInteger(point.candleIndex)) return { valid: false, reason: 'invalid_pivot' };
      if (point.priceField !== 'high' && point.priceField !== 'low') return { valid: false, reason: 'invalid_pivot_price_field' };
      if (priorDate && priorDate >= point.time) return { valid: false, reason: 'unordered_pivots' };
      if (point.candleIndex < 0 || point.candleIndex >= candidate.candles.length || candidate.candles[point.candleIndex].time !== point.time) {
        return { valid: false, reason: 'pivot_outside_source' };
      }
      if (point.value !== candidate.candles[point.candleIndex][point.priceField]) return { valid: false, reason: 'pivot_price_mismatch' };
      priorDate = point.time;
    }
    if (!plain(candidate.prz) || !finite(candidate.prz.low) || !finite(candidate.prz.high) || candidate.prz.low > candidate.prz.high) {
      return { valid: false, reason: 'invalid_prz' };
    }
    for (var l = 0; l < LEVEL_NAMES.length; l++) if (!finite(candidate[LEVEL_NAMES[l]])) return { valid: false, reason: 'invalid_level' };
    if (candidate.status === 'confirmed') {
      var evidence = candidate.confirmationEvidence;
      if (!plain(evidence) || !boundedText(evidence.type, 80) || !validDate(evidence.date) || evidence.date > candidate.dataDate) {
        return { valid: false, reason: 'missing_confirmation_evidence' };
      }
    }
    return { valid: true, ticker: ticker };
  }

  function publicPatternData(candidate, context) {
    var validation = validateCandidate(candidate, context);
    if (!validation.valid) return null;
    var points = {};
    POINT_NAMES.forEach(function(name) {
      points[name] = { time: candidate.points[name].time, value: candidate.points[name].value,
        candleIndex: candidate.points[name].candleIndex, priceField: candidate.points[name].priceField };
    });
    return {
      id: candidate.id, ruleVersion: candidate.ruleVersion, name: candidate.name, status: candidate.status,
      provenance: candidate.provenance, ticker: validation.ticker, timeframe: '1D', dataDate: candidate.dataDate,
      points: points, candles: candidate.candles.map(function(c) { return { x: c.time, o: c.open, h: c.high, l: c.low, c: c.close }; }),
      prz: { low: candidate.prz.low, high: candidate.prz.high }, confirmation: candidate.confirmation,
      invalidation: candidate.invalidation, tp1: candidate.tp1, tp2: candidate.tp2, currentPrice: candidate.currentPrice
    };
  }

  function lineDataset(label, points, color, dash, width) {
    return { type: 'line', label: label, data: points, parsing: false, borderColor: color,
      backgroundColor: color, borderWidth: width || 2, borderDash: dash || [], pointRadius: 3, fill: false };
  }
  function horizontal(data, value) {
    return [{ x: data.candles[0].x, y: value }, { x: data.candles[data.candles.length - 1].x, y: value }];
  }
  // Levels read as bare colours in a legend. Printing the price next to the name
  // makes every annotation self-describing at a glance, on any screen size.
  function levelLabel(name, value) {
    if (value == null || value === '') return name;
    var number = Number(value);
    if (!Number.isFinite(number)) return name;
    return name + '  ' + number.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  return { EMPTY_MESSAGE: EMPTY_MESSAGE, validateCandidate: validateCandidate,
    publicPatternData: publicPatternData, levelLabel: levelLabel };
});

// Browser-only authorization gate. The legacy query/window preview switches in
// index.html are intentionally ignored here: only a current server-verified,
// signed admin session may expose or render Pattern Map.
(function installPatternMapAdminGate(root) {
  'use strict';
  if (!root || !root.document || typeof root.fetch !== 'function') return;

  var state = {
    allowed: false,
    expiresAt: 0,
    request: null,
    version: 0,
    expiryTimer: null
  };
  var originalRenderPatternTab = typeof root.renderPatternTab === 'function' ? root.renderPatternTab : null;
  var originalLogout = typeof root.logout === 'function' ? root.logout : null;
  var originalEnterApp = typeof root.enterApp === 'function' ? root.enterApp : null;

  function getElement(id) { return root.document.getElementById(id); }

  function setSelected(tab, selected) {
    if (!tab) return;
    if (typeof root.setChartTabSelected === 'function') {
      root.setChartTabSelected(tab, selected);
      return;
    }
    tab.setAttribute('aria-selected', String(selected));
    tab.classList.toggle('bg-emerald-500', selected);
    tab.classList.toggle('text-black', selected);
    tab.classList.toggle('bg-dark-700', !selected);
    tab.classList.toggle('text-gray-300', !selected);
  }

  function clearExpiryTimer() {
    if (state.expiryTimer != null && typeof root.clearTimeout === 'function') root.clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
  }

  function switchToTechnical(hidePatternTab) {
    var technicalTab = getElement('technicalChartTab');
    var patternTab = getElement('patternChartTab');
    var technicalPanel = getElement('chartPageContainer');
    var patternPanel = getElement('patternPageContainer');
    if (technicalPanel) technicalPanel.classList.remove('hidden');
    if (patternPanel) patternPanel.classList.add('hidden');
    if (patternTab) patternTab.classList.toggle('hidden', hidePatternTab === true);
    setSelected(technicalTab, true);
    setSelected(patternTab, false);
  }

  function cancelAccessRequest() {
    if (state.request && state.request.controller) state.request.controller.abort();
    state.request = null;
  }

  function denyAccess() {
    state.version += 1;
    cancelAccessRequest();
    clearExpiryTimer();
    state.allowed = false;
    state.expiresAt = 0;
    switchToTechnical(true);
    if (typeof root.resetPatternMap === 'function') root.resetPatternMap();
    return false;
  }

  function hasFreshAccess() {
    if (state.allowed !== true || !Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now()) {
      if (state.allowed === true) denyAccess();
      return false;
    }
    return true;
  }

  function grantAccess(expiresAt) {
    clearExpiryTimer();
    state.allowed = true;
    state.expiresAt = expiresAt;
    var patternTab = getElement('patternChartTab');
    if (patternTab) {
      patternTab.classList.remove('hidden');
      patternTab.textContent = 'Pattern Map';
    }
    if (typeof root.setTimeout === 'function') {
      state.expiryTimer = root.setTimeout(function() { denyAccess(); }, Math.max(0, expiresAt - Date.now() + 25));
    }
    return true;
  }

  function refreshAccess(force) {
    if (force !== true && hasFreshAccess()) return Promise.resolve(true);
    if (state.request) {
      if (force !== true) return state.request.promise;
      cancelAccessRequest();
    }

    var requestVersion = ++state.version;
    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var options = {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pattern_map_access' })
    };
    if (controller) options.signal = controller.signal;

    var promise = root.fetch('/api/admin-users', options).then(function(response) {
      if (!response || !response.ok) return null;
      return response.json();
    }).then(function(data) {
      if (requestVersion !== state.version) return false;
      var expiresAt = data && Date.parse(data.expires_at);
      var allowed = Boolean(data && data.success === true && data.allowed === true && data.access === 'admin' &&
        String(data.username || '').toLowerCase() === 'budi' && Number.isFinite(expiresAt) && expiresAt > Date.now());
      return allowed ? grantAccess(expiresAt) : denyAccess();
    }).catch(function(error) {
      if (requestVersion !== state.version || error && error.name === 'AbortError') return false;
      return denyAccess();
    }).finally(function() {
      if (state.request && state.request.version === requestVersion) state.request = null;
    });

    state.request = { promise: promise, controller: controller, version: requestVersion };
    return promise;
  }

  root.patternMapPreviewEnabled = function() {
    return hasFreshAccess();
  };

  root.applyPatternMapPreviewPolicy = function() {
    if (!hasFreshAccess()) {
      switchToTechnical(true);
      return false;
    }
    var patternTab = getElement('patternChartTab');
    if (patternTab) patternTab.classList.remove('hidden');
    return true;
  };

  root.showChartTab = function(tab) {
    if (tab !== 'pattern') {
      if (!hasFreshAccess()) {
        switchToTechnical(true);
        return true;
      }
      switchToTechnical(false);
      return true;
    }

    return refreshAccess(true).then(function(allowed) {
      if (!allowed || !hasFreshAccess()) return false;
      var technicalTab = getElement('technicalChartTab');
      var patternTab = getElement('patternChartTab');
      var technicalPanel = getElement('chartPageContainer');
      var patternPanel = getElement('patternPageContainer');
      if (technicalPanel) technicalPanel.classList.add('hidden');
      if (patternPanel) patternPanel.classList.remove('hidden');
      if (patternTab) patternTab.classList.remove('hidden');
      setSelected(technicalTab, false);
      setSelected(patternTab, true);
      return Promise.resolve(root.renderPatternTab()).then(function() { return true; });
    });
  };

  root.renderPatternTab = function() {
    return refreshAccess(false).then(function(allowed) {
      if (!allowed || !hasFreshAccess() || !originalRenderPatternTab) return false;
      return originalRenderPatternTab.apply(root, []);
    });
  };

  root.initPatternMapPreview = function() {
    denyAccess();
    return refreshAccess(true);
  };

  if (originalLogout) {
    root.logout = function() {
      denyAccess();
      return originalLogout.apply(root, arguments);
    };
  }

  if (originalEnterApp) {
    root.enterApp = function() {
      var result = originalEnterApp.apply(root, arguments);
      Promise.resolve(result).finally(function() { refreshAccess(true); });
      return result;
    };
  }

  root.PatternMapAdminAccess = Object.freeze({
    refresh: refreshAccess,
    isAllowed: hasFreshAccess,
    deny: denyAccess
  });

  function boot() {
    denyAccess();
    refreshAccess(true);
  }

  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot);
  else boot();

  if (typeof root.addEventListener === 'function') {
    root.addEventListener('focus', function() { refreshAccess(true); });
    root.addEventListener('storage', function(event) {
      if (!event || ['autocuan_logged_in', 'autocuan_user', 'autocuan_is_admin'].indexOf(event.key) < 0) return;
      if (event.newValue == null || event.newValue === 'false' || event.newValue === 'guest') denyAccess();
      else refreshAccess(true);
    });
  }
  if (typeof root.document.addEventListener === 'function') {
    root.document.addEventListener('visibilitychange', function() {
      if (root.document.visibilityState === 'visible') refreshAccess(true);
    });
  }
})(typeof window !== 'undefined' ? window : null);
