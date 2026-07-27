(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PatternMap = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var POINT_NAMES = ['X', 'A', 'B', 'C', 'D'];
  var EMPTY_MESSAGE = 'Belum ada pattern yang dapat divisualisasikan untuk saham ini.';

  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

  // A label is not geometry. Only a versioned candidate with all five trusted
  // pivots is drawable; this adapter deliberately performs no pattern detection.
  function hasDrawableGeometry(candidate) {
    if (!candidate || !candidate.id || !candidate.ruleVersion || !candidate.points) return false;
    if (!Array.isArray(candidate.candles) || !candidate.candles.length) return false;
    return POINT_NAMES.every(function(name) {
      var point = candidate.points[name];
      return point && /^\d{4}-\d{2}-\d{2}$/.test(String(point.time || '')) && finite(point.value);
    });
  }

  function publicPatternData(candidate) {
    if (!hasDrawableGeometry(candidate)) return null;
    return {
      id: String(candidate.id), ruleVersion: String(candidate.ruleVersion),
      name: String(candidate.name || 'Pattern'), status: String(candidate.status || 'candidate'),
      ticker: String(candidate.ticker || ''), timeframe: String(candidate.timeframe || '1D'),
      dataDate: String(candidate.dataDate || ''), points: candidate.points,
      candles: candidate.candles.map(function(c) {
        return { x: c.time, o: c.open, h: c.high, l: c.low, c: c.close };
      }),
      prz: candidate.prz || null, confirmation: candidate.confirmation,
      invalidation: candidate.invalidation, tp1: candidate.tp1, tp2: candidate.tp2,
      currentPrice: candidate.currentPrice
    };
  }

  function lineDataset(label, points, color, dash) {
    return { type: 'line', label: label, data: points, parsing: false, borderColor: color,
      backgroundColor: color, borderWidth: 2, borderDash: dash || [], pointRadius: 3, fill: false };
  }

  function buildQuickChartConfig(candidate) {
    var data = publicPatternData(candidate);
    if (!data) return null;
    var legs = POINT_NAMES.map(function(name) {
      return { x: data.points[name].time, y: data.points[name].value, pointName: name };
    });
    var datasets = [
      { type: 'candlestick', label: data.ticker, data: data.candles, color: { up: '#10b981', down: '#ef4444', unchanged: '#94a3b8' } },
      lineDataset('X-A-B-C-D', legs, '#38bdf8')
    ];
    var levels = [['Confirmation', data.confirmation, '#22c55e'], ['Invalidation', data.invalidation, '#ef4444'],
      ['TP1', data.tp1, '#f59e0b'], ['TP2', data.tp2, '#fbbf24'], ['Current', data.currentPrice, '#e2e8f0']];
    levels.forEach(function(level) {
      if (finite(level[1])) datasets.push(lineDataset(level[0], [
        { x: data.candles[0].x, y: level[1] }, { x: data.candles[data.candles.length - 1].x, y: level[1] }
      ], level[2], [6, 4]));
    });
    if (data.prz && finite(data.prz.low) && finite(data.prz.high)) {
      datasets.push({ type: 'line', label: 'PRZ', data: data.candles.map(function(c) { return { x: c.x, y: data.prz.low }; }),
        borderColor: 'rgba(168,85,247,.7)', backgroundColor: 'rgba(168,85,247,.16)', fill: '+1', pointRadius: 0 });
      datasets.push({ type: 'line', label: 'PRZ upper', data: data.candles.map(function(c) { return { x: c.x, y: data.prz.high }; }),
        borderColor: 'rgba(168,85,247,.7)', pointRadius: 0 });
    }
    return { type: 'candlestick', data: { datasets: datasets }, options: { responsive: false, animation: false,
      plugins: { title: { display: true, text: data.name + ' • ' + data.ticker + ' • T-1 ' + data.dataDate }, legend: { display: true } },
      scales: { x: { type: 'time', time: { unit: 'day' } } } } };
  }

  function cacheKey(candidate) {
    return [candidate.ticker, candidate.dataDate, candidate.id, candidate.ruleVersion].map(String).join('|');
  }

  function RequestManager(fetchImpl) {
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
    this.active = null;
  }
  RequestManager.prototype.cancel = function() {
    if (this.active) this.active.controller.abort();
    this.active = null;
  };
  RequestManager.prototype.render = async function(candidate) {
    var config = buildQuickChartConfig(candidate);
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
      body: JSON.stringify({ width: 1200, height: 700, format: 'png', backgroundColor: '#111827', chart: config })
    }).then(function(response) {
      if (!response.ok) throw new Error('QuickChart HTTP ' + response.status);
      return response.blob();
    }).then(function(blob) {
      if (self.active !== token) return { obsolete: true };
      var result = { blob: blob, key: key };
      self.cache.set(key, result);
      self.active = null;
      return result;
    }).catch(function(error) {
      if (self.active === token) self.active = null;
      if (error && error.name === 'AbortError') return { obsolete: true };
      return { error: true, message: 'Pattern Map belum dapat dimuat. Technical Chart tetap dapat digunakan.' };
    });
    this.active = token;
    return token.promise;
  };

  return { EMPTY_MESSAGE: EMPTY_MESSAGE, hasDrawableGeometry: hasDrawableGeometry,
    publicPatternData: publicPatternData, buildQuickChartConfig: buildQuickChartConfig,
    cacheKey: cacheKey, RequestManager: RequestManager };
});
