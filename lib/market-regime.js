'use strict';

function toNum(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandle(c) {
  if (!c) return null;
  var close = toNum(c.close);
  if (close == null) return null;
  return { close: close, date: c.date || c.datetime || c.timestamp || c.time || c.t || null };
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  var slice = values.slice(-period);
  return slice.reduce(function(a, b) { return a + b; }, 0) / period;
}

function round4(v) {
  return v == null ? null : Number(v.toFixed(4));
}

function evaluateMarketRegime(candles) {
  var cleaned = (Array.isArray(candles) ? candles : []).map(normalizeCandle).filter(Boolean);
  if (cleaned.length < 20) {
    return {
      market_regime_label: 'MARKET_UNKNOWN',
      market_regime_score_adjustment: 0,
      market_regime_notes: 'Data IHSG belum cukup untuk MA20.',
      market_regime_close: cleaned.length ? cleaned[cleaned.length - 1].close : null,
      market_regime_ma20: null,
      market_regime_ma50: null,
      market_regime_source: 'IHSG'
    };
  }

  var closes = cleaned.map(function(c) { return c.close; });
  var close = closes[closes.length - 1];
  var ma20 = sma(closes, 20);
  var ma50 = sma(closes, 50);
  var label = 'NEUTRAL';
  var adjustment = 0;
  var notes = [];

  if (ma50 != null) {
    if (close > ma20 && ma20 >= ma50) {
      label = 'RISK_ON';
      adjustment = 2;
      notes.push('IHSG close di atas MA20 dan MA20 >= MA50.');
    } else if (close < ma20 && ma20 < ma50) {
      label = 'RISK_OFF';
      adjustment = -4;
      notes.push('IHSG close di bawah MA20 dan MA20 < MA50.');
    } else {
      notes.push('Trend IHSG mixed antara close, MA20, dan MA50.');
    }
  } else if (ma20 != null) {
    if (close > ma20) {
      label = 'RISK_ON';
      adjustment = 1;
      notes.push('IHSG close di atas MA20; MA50 belum tersedia.');
    } else if (close < ma20) {
      label = 'RISK_OFF';
      adjustment = -2;
      notes.push('IHSG close di bawah MA20; MA50 belum tersedia.');
    } else {
      notes.push('IHSG sejajar MA20; MA50 belum tersedia.');
    }
  }

  return {
    market_regime_label: label,
    market_regime_score_adjustment: adjustment,
    market_regime_notes: notes.join(' '),
    market_regime_close: round4(close),
    market_regime_ma20: round4(ma20),
    market_regime_ma50: round4(ma50),
    market_regime_source: 'IHSG'
  };
}

function applyMarketRegimeScore(score, regime) {
  var base = toNum(score);
  if (base == null) base = 0;
  var adj = regime && toNum(regime.market_regime_score_adjustment) != null ? Number(regime.market_regime_score_adjustment) : 0;
  return Math.max(0, Math.min(100, base + adj));
}

async function fetchIhsgDailyCandles(options) {
  options = options || {};
  var timeoutMs = options.timeoutMs || 12000;
  if (typeof fetch !== 'function') return [];
  var ac = new AbortController();
  var timer = setTimeout(function() { ac.abort(); }, timeoutMs);
  try {
    var url = 'https://query2.finance.yahoo.com/v8/finance/chart/%5EJKSE?range=90d&interval=1d&includePrePost=false';
    var response = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return [];
    var data = await response.json();
    var result = data && data.chart && data.chart.result && data.chart.result[0];
    var q = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
    var ts = result && result.timestamp || [];
    if (!q) return [];
    var candles = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.close[i] != null) candles.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: q.close[i] });
    }
    return candles;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function getMarketRegime(options) {
  options = options || {};
  try {
    var candles = Array.isArray(options.candles) ? options.candles : await fetchIhsgDailyCandles(options);
    return evaluateMarketRegime(candles);
  } catch (e) {
    return {
      market_regime_label: 'MARKET_UNKNOWN',
      market_regime_score_adjustment: 0,
      market_regime_notes: 'Data IHSG tidak tersedia; market regime diabaikan.',
      market_regime_source: 'IHSG'
    };
  }
}

module.exports = {
  evaluateMarketRegime: evaluateMarketRegime,
  applyMarketRegimeScore: applyMarketRegimeScore,
  fetchIhsgDailyCandles: fetchIhsgDailyCandles,
  getMarketRegime: getMarketRegime
};
