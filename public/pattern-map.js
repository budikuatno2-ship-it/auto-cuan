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
      if (priorDate && priorDate >= point.time) return { valid: false, reason: 'unordered_pivots' };
      if (point.candleIndex < 0 || point.candleIndex >= candidate.candles.length || candidate.candles[point.candleIndex].time !== point.time) {
        return { valid: false, reason: 'pivot_outside_source' };
      }
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
      points[name] = { time: candidate.points[name].time, value: candidate.points[name].value, candleIndex: candidate.points[name].candleIndex };
    });
    return {
      id: candidate.id, ruleVersion: candidate.ruleVersion, name: candidate.name, status: candidate.status,
      provenance: candidate.provenance, ticker: validation.ticker, timeframe: '1D', dataDate: candidate.dataDate,
      points: points, candles: candidate.candles.map(function(c) { return { x: c.time, o: c.open, h: c.high, l: c.low, c: c.close }; }),
      prz: { low: candidate.prz.low, high: candidate.prz.high }, confirmation: candidate.confirmation,
      invalidation: candidate.invalidation, tp1: candidate.tp1, tp2: candidate.tp2, currentPrice: candidate.currentPrice
    };
  }

  function lineDataset(label, points, color, dash) {
    return { type: 'line', label: label, data: points, parsing: false, borderColor: color,
      backgroundColor: color, borderWidth: 2, borderDash: dash || [], pointRadius: 3, fill: false };
  }
  function horizontal(data, value) {
    return [{ x: data.candles[0].x, y: value }, { x: data.candles[data.candles.length - 1].x, y: value }];
  }

  function buildQuickChartConfig(candidate, context) {
    var data = publicPatternData(candidate, context);
    if (!data) return null;
    var legs = POINT_NAMES.map(function(name) { return { x: data.points[name].time, y: data.points[name].value }; });
    var datasets = [
      { type: 'candlestick', label: data.ticker, data: data.candles, parsing: false,
        color: { up: '#10b981', down: '#ef4444', unchanged: '#94a3b8' } },
      lineDataset('X-A-B-C-D', legs, '#38bdf8')
    ];
    [['Confirmation', data.confirmation, '#22c55e'], ['Invalidation', data.invalidation, '#ef4444'],
      ['TP1', data.tp1, '#f59e0b'], ['TP2', data.tp2, '#fbbf24'], ['Current', data.currentPrice, '#e2e8f0']].forEach(function(level) {
      datasets.push(lineDataset(level[0], horizontal(data, level[1]), level[2], [6, 4]));
    });
    // Upper precedes lower. The lower dataset fills exactly to the previous
    // dataset, producing a bounded [low, high] band instead of filling to axis.
    datasets.push({ type: 'line', label: 'PRZ upper', data: horizontal(data, data.prz.high), parsing: false,
      borderColor: 'rgba(168,85,247,.8)', pointRadius: 0, fill: false });
    datasets.push({ type: 'line', label: 'PRZ lower', data: horizontal(data, data.prz.low), parsing: false,
      borderColor: 'rgba(168,85,247,.8)', backgroundColor: 'rgba(168,85,247,.18)', pointRadius: 0,
      fill: { target: '-1', above: 'rgba(168,85,247,.18)', below: 'rgba(168,85,247,.18)' } });
    return { type: 'candlestick', data: { datasets: datasets }, options: { responsive: false, animation: false,
      plugins: { title: { display: true, text: data.name + ' • ' + data.ticker + ' • T-1 ' + data.dataDate }, legend: { display: true } },
      scales: { x: { type: 'time', time: { unit: 'day' } } } } };
  }

  function cacheKey(candidate) { return [candidate.ticker, candidate.dataDate, candidate.id, candidate.ruleVersion].map(String).join('|'); }
  function RequestManager(fetchImpl) { this.fetchImpl = fetchImpl; this.cache = new Map(); this.active = null; }
  RequestManager.prototype.cancel = function() { if (this.active) this.active.controller.abort(); this.active = null; };
  RequestManager.prototype.render = async function(candidate, context) {
    var config = buildQuickChartConfig(candidate, context);
    if (!config) return { empty: true, message: EMPTY_MESSAGE };
    var key = cacheKey(candidate);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.active && this.active.key === key) return this.active.promise;
    this.cancel();
    var controller = new AbortController();
    var token = { key: key, controller: controller };
    var self = this;
    token.promise = this.fetchImpl('https://quickchart.io/chart', { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'image/png' },
      body: JSON.stringify({ version: '4', width: 1200, height: 700, format: 'png', backgroundColor: '#111827', chart: config })
    }).then(function(response) {
      if (!response.ok) throw new Error('QuickChart HTTP ' + response.status);
      return response.blob();
    }).then(function(blob) {
      if (self.active !== token) return { obsolete: true };
      var result = { blob: blob, key: key };
      self.cache.set(key, result); self.active = null; return result;
    }).catch(function(error) {
      if (self.active === token) self.active = null;
      if (error && error.name === 'AbortError') return { obsolete: true };
      return { error: true, message: 'Pattern Map belum dapat dimuat. Technical Chart tetap dapat digunakan.' };
    });
    this.active = token;
    return token.promise;
  };

  return { EMPTY_MESSAGE: EMPTY_MESSAGE, validateCandidate: validateCandidate, publicPatternData: publicPatternData,
    buildQuickChartConfig: buildQuickChartConfig, cacheKey: cacheKey, RequestManager: RequestManager };
});
