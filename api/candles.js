/**
 * Auto-Cuan Candles API — Yahoo Finance OHLCV for chart rendering
 * Returns 1-year daily candles + compact latest metrics.
 * In-memory cache with 5-minute TTL.
 */

var cache = {};
var CACHE_TTL = 5 * 60 * 1000;
var MAX_CACHE_ENTRIES = 500;

function setBoundedCache(key, data) {
  var keys = Object.keys(cache);
  if (keys.length >= MAX_CACHE_ENTRIES) {
    var now = Date.now();
    var oldestKey = keys[0];
    var oldestTime = Infinity;
    var evicted = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var entry = cache[k];
      if (entry && (now - entry.timestamp > CACHE_TTL)) {
        delete cache[k];
        evicted = true;
      } else if (entry && entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = k;
      }
    }
    if (!evicted && cache[oldestKey]) {
      delete cache[oldestKey];
    }
  }
  cache[key] = { data: data, timestamp: Date.now() };
}

var t1Policy = require('../lib/chart-t1-policy');
var patternDetector = require('../lib/pattern-abcd').detectAbcdPattern;
var classicPatternDetector = require('../lib/classic-chart-patterns').detectClassicChartPatterns;
var adminSession = require('../lib/admin-session');
var { createRateLimiter, clientAddress } = require('../lib/request-rate-limit');
var clock = { now: function() { return new Date(); } };

// Unauthenticated, and each unique ticker triggers a live Yahoo Finance fetch
// beyond the 5-minute cache. Same reasoning as api/quote.js's limiter: bound
// scripted ticker sweeps that would otherwise hammer the upstream provider.
var candlesLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

// BUG-CAN-01: akses Pattern Map/Classic Patterns adalah hak setiap sesi admin
// yang sah, bukan milik satu username yang di-hardcode. Memeriksa nama personal
// mematikan fitur visualisasi pattern untuk seluruh akun admin lain.
function hasPatternMapAccess(req) {
  var auth = adminSession.requireAdminSession(req);
  return auth.ok === true;
}

function responseForRequest(data, req) {
  if (!data || typeof data !== 'object' || hasPatternMapAccess(req)) return data;
  var publicData = Object.assign({}, data);
  delete publicData.patternMap;
  delete publicData.pattern_map_meta;
  delete publicData.classicPatterns;
  delete publicData.classic_pattern_meta;
  return publicData;
}

function setPrivateResponseHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
}

module.exports = async function handler(req, res) {
  setPrivateResponseHeaders(res);
  if (!candlesLimiter.check(clientAddress(req))) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  try {
    var ticker = null;
    var reqRange = null;

    if (req.method === 'GET') {
      ticker = req.query && req.query.ticker;
      reqRange = req.query && req.query.range;
    } else if (req.method === 'POST') {
      var body = req.body || {};
      ticker = body.ticker;
      reqRange = body.range;
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!ticker) {
      return res.status(400).json({ error: 'Parameter ticker wajib diisi.' });
    }

    ticker = String(ticker).toUpperCase().trim().replace(/\.JK$/i, '');
    // Normalize IHSG aliases
    if (ticker === 'JKSE' || ticker === 'JCI' || ticker === 'COMPOSITE') ticker = 'IHSG';
    // BUG-CAN-03: simbol benchmark resmi BEI memuat angka (LQ45, IDX30, ^JKSE),
    // sehingga pola huruf-saja menolak instrumen perbandingan utama bursa.
    if (!/^[A-Z0-9]{3,6}$/.test(ticker)) {
      return res.status(400).json({ success: false, error: 'Format ticker tidak valid.' });
    }

    var validRanges = ['1y', '2y', '3y', '5y', 'max'];
    var cleanRange = (typeof reqRange === 'string' && validRanges.indexOf(reqRange.toLowerCase().trim()) >= 0)
      ? reqRange.toLowerCase().trim()
      : '5y';
    var cacheKey = ticker + '_' + cleanRange;

    var cached = cache[cacheKey];
    var requestJakartaToday = t1Policy.formatJakartaDate(clock.now());
    if (cached && cached.data && cached.data.jakarta_today === requestJakartaToday && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return res.status(200).json(responseForRequest(cached.data, req));
    }

    var candles = [];
    var cutoff = null;
    var candleSource = 'Data Historis T-1';

    // 1. Primary for IHSG: read local disk cache (data/daily-candles/IHSG.json)
    if (ticker === 'IHSG') {
      var fs = require('fs');
      var path = require('path');
      var ihsgDiskPath = path.join(process.cwd(), 'data', 'daily-candles', 'IHSG.json');
      if (fs.existsSync(ihsgDiskPath)) {
        try {
          var rawDisk = JSON.parse(fs.readFileSync(ihsgDiskPath, 'utf8'));
          if (rawDisk && Array.isArray(rawDisk.candles) && rawDisk.candles.length >= 20) {
            var diskCandles = [];
            for (var k = 0; k < rawDisk.candles.length; k++) {
              var dc = rawDisk.candles[k];
              var dDate = String(dc.date || dc.time || '').slice(0, 10);
              var dO = Number(dc.open), dH = Number(dc.high), dL = Number(dc.low), dC = Number(dc.close);
              var dV = Number(dc.volume);
              if (/^\d{4}-\d{2}-\d{2}$/.test(dDate) && Number.isFinite(dO) && Number.isFinite(dH) && Number.isFinite(dL) && Number.isFinite(dC)) {
                diskCandles.push({
                  time: dDate,
                  open: Math.round(dO * 100) / 100,
                  high: Math.round(dH * 100) / 100,
                  low: Math.round(dL * 100) / 100,
                  close: Math.round(dC * 100) / 100,
                  volume: Number.isFinite(dV) && dV > 0 ? dV : null,
                  value: dc.value != null ? Number(dc.value) : null
                });
              }
            }
            if (diskCandles.length >= 20) {
              var diskCutoff = t1Policy.retainCompletedCandles(diskCandles, clock.now());
              if (diskCutoff.candles.length >= 20 && diskCutoff.metadata.t1_status !== 'STALE') {
                candles = diskCutoff.candles;
                cutoff = diskCutoff;
                candleSource = 'Data Historis T-1';
              }
            }
          }
        } catch (_) {}
      }
    }

    // 2. Fallback to Yahoo Finance if candles not resolved from disk
    if (!candles || candles.length === 0) {
      if (ticker === 'IHSG') {
        candleSource = 'fallback';
      }
      var symbol;
      if (ticker === 'IHSG') {
        symbol = '%5EJKSE'; // ^JKSE (URL-encoded)
      } else {
        symbol = ticker + '.JK';
      }
      var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=' + cleanRange + '&interval=1d';

      var controller = new AbortController();
      var timeout = setTimeout(function() { controller.abort(); }, 10000);

      var response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: controller.signal
        });
      } catch (fetchErr) {
        clearTimeout(timeout);
        return res.status(502).json({ success: false, ticker: ticker, error: 'Gagal mengambil data.' });
      }
      clearTimeout(timeout);

      if (!response.ok) {
        return res.status(502).json({ success: false, ticker: ticker, error: 'HTTP ' + response.status });
      }

      var json;
      try { json = await response.json(); } catch (e) {
        return res.status(502).json({ success: false, ticker: ticker, error: 'Gagal parsing.' });
      }

      var chartResult = json && json.chart && json.chart.result && json.chart.result[0];
      if (!chartResult || !chartResult.timestamp) {
        return res.status(200).json(Object.assign({ success: false, ticker: ticker, error: 'Data tidak ditemukan.' }, t1Policy.buildMetadata(null, clock.now())));
      }

      var timestamps = chartResult.timestamp || [];
      var indicators = chartResult.indicators && chartResult.indicators.quote && chartResult.indicators.quote[0];
      if (!indicators) {
        return res.status(200).json(Object.assign({ success: false, ticker: ticker, error: 'OHLCV kosong.' }, t1Policy.buildMetadata(null, clock.now())));
      }

      var opens = indicators.open || [];
      var highs = indicators.high || [];
      var lows = indicators.low || [];
      var closes = indicators.close || [];
      var volumes = indicators.volume || [];

      for (var i = 0; i < timestamps.length; i++) {
        var c = closes[i], o = opens[i], h = highs[i], l = lows[i], v = volumes[i];
        // Skip candles that are incomplete, null, or have zero/negative price (e.g. unfinalized day close)
        if (c == null || o == null || h == null || l == null) continue;
        var timestampSeconds = t1Policy.normalizeUnixTimestampSeconds(timestamps[i]);
        var candleDate = timestampSeconds == null ? null : t1Policy.formatJakartaDate(new Date(timestampSeconds * 1000));
        // BUG-CAN-02: setiap field OHLC harus finite; nilai nol/negatif dan high < low
        // ditolak agar tidak ada candle rusak yang masuk ke indikator.
        var oNum = Number(o), hNum = Number(h), lNum = Number(l), cNum = Number(c);
        if (candleDate &&
            Number.isFinite(oNum) && oNum > 0 &&
            Number.isFinite(hNum) && hNum > 0 &&
            Number.isFinite(lNum) && lNum >= 0 &&
            Number.isFinite(cNum) && cNum > 0 &&
            hNum >= lNum) {
          candles.push({
            time: candleDate,
            open: Math.round(oNum * 100) / 100,
            high: Math.round(hNum * 100) / 100,
            low: Math.round(lNum * 100) / 100,
            close: Math.round(cNum * 100) / 100,
            volume: Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null
          });
        }
      }

      cutoff = t1Policy.retainCompletedCandles(candles, clock.now());
      candles = cutoff.candles;
    }

    if (candles.length === 0) {
      return res.status(200).json(Object.assign({ success: false, ticker: ticker, error: 'Tidak ada candle harian selesai sebelum tanggal Jakarta hari ini.' }, cutoff.metadata));
    }

    // Calculate latest metrics
    var closePrices = candles.map(function(c) { return c.close; });
    var volumeArr = candles.map(function(c) { return c.volume; });
    var latest = candles[candles.length - 1];

    var result = Object.assign({
      success: true,
      ticker: ticker,
      source: candleSource,
      totalCandles: candles.length,
      latest: {
        date: latest.time,
        last: latest.close,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        volume: latest.volume
      },
      metrics: {
        ma20: calcMA(closePrices, 20),
        ma50: calcMA(closePrices, 50),
        ma100: calcMA(closePrices, 100),
        ma200: calcMA(closePrices, 200),
        rsi14: calcRSI(closePrices, 14),
        volumeAvg20: calcMA(volumeArr, 20) != null ? Math.round(calcMA(volumeArr, 20)) : null,
        volumeVsAvg20: calcVolumeRatio(volumeArr, latest.volume, 20)
      },
      candles: candles
    }, cutoff.metadata);

    // Geometry consumes only the finalized candle array above. Its failure is
    // isolated so Technical Chart retains the normal successful response.
    try {
      var patternResult = patternDetector(candles, { ticker: ticker, dataDate: cutoff.metadata.actual_data_date });
      result.patternMap = patternResult.candidate || null;
      result.pattern_map_meta = {
        engine: 'abcd-t1-v1', status: patternResult.candidate ? 'found' : 'none',
        reason: String(patternResult.reason || 'no_pattern').slice(0, 64)
      };
    } catch (detectorError) {
      result.patternMap = null;
      result.pattern_map_meta = { engine: 'abcd-t1-v1', status: 'none', reason: 'detector_error' };
    }

    // Classic formations are separate from ABCD geometry. They provide
    // context/ranking only and deliberately do not fabricate Pattern Map lines.
    try {
      var classicResult = classicPatternDetector(candles.slice(-90), { ticker: ticker, dataDate: cutoff.metadata.actual_data_date });
      result.classicPatterns = classicResult.patterns || [];
      result.classic_pattern_meta = {
        engine: classicResult.rule_version || 'classic-chart-patterns-v1',
        status: result.classicPatterns.length ? 'found' : 'none',
        count: result.classicPatterns.length,
        score_adjustment: classicResult.score_adjustment || 0,
        diagnostics: classicResult.diagnostics || []
      };
    } catch (classicError) {
      result.classicPatterns = [];
      result.classic_pattern_meta = { engine:'classic-chart-patterns-v1', status:'none', count:0, score_adjustment:0, diagnostics:['detector_error'] };
    }

    // Cache the complete deterministic result once, then apply the signed-session
    // response policy per request. This prevents a guest/non-admin cache hit from
    // receiving Pattern geometry while keeping Technical Chart caching unchanged.
    setBoundedCache(cacheKey, result);
    return res.status(200).json(responseForRequest(result, req));

  } catch (err) {
    console.error('candles error:', err);
    return res.status(500).json({ success: false, ticker: 'unknown', error: 'Kesalahan internal.' });
  }
};

module.exports.__test = {
  clock: clock,
  clearCache: function() { cache = {}; },
  setPatternDetector: function(detector) { patternDetector = detector; },
  resetPatternDetector: function() { patternDetector = require('../lib/pattern-abcd').detectAbcdPattern; },
  setClassicPatternDetector: function(detector) { classicPatternDetector = detector; },
  resetClassicPatternDetector: function() { classicPatternDetector = require('../lib/classic-chart-patterns').detectClassicChartPatterns; },
  hasPatternMapAccess: hasPatternMapAccess,
  responseForRequest: responseForRequest,
  calcMA: calcMA,
  calcRSI: calcRSI,
  calcVolumeRatio: calcVolumeRatio
};

function calcMA(prices, period) {
  if (!prices || prices.length < period || !period || period <= 0) return null;
  var slice = prices.slice(prices.length - period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) {
    var raw = slice[i];
    if (raw == null || raw === '') return null;
    var p = Number(raw);
    if (!Number.isFinite(p)) return null;
    sum += p;
  }
  var ma = sum / period;
  return Number.isFinite(ma) ? Math.round(ma * 100) / 100 : null;
}

// FIX-19: Wilder's Smoothing (RMA) — exact TradingView / `lib/daily-rsi` parity.
// The previous SMA-over-window version drifted 3-5 points from the canonical
// reference used by the daily market-context layer.
function calcRSI(closes, period) {
  var p = Number(period);
  if (!Array.isArray(closes) || !Number.isFinite(p) || p <= 0) return null;
  if (closes.length < p + 1) return null;

  var values = new Array(closes.length);
  for (var i = 0; i < closes.length; i++) {
    var raw = closes[i];
    if (raw == null || raw === '') return null;
    var num = Number(raw);
    if (!Number.isFinite(num)) return null;
    values[i] = num;
  }

  var gains = [];
  var losses = [];
  for (var j = 1; j < values.length; j++) {
    var delta = values[j] - values[j - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }

  var avgGain = 0;
  var avgLoss = 0;
  for (var k = 0; k < p; k++) {
    avgGain += gains[k];
    avgLoss += losses[k];
  }
  avgGain /= p;
  avgLoss /= p;

  for (var m = p; m < gains.length; m++) {
    avgGain = (avgGain * (p - 1) + gains[m]) / p;
    avgLoss = (avgLoss * (p - 1) + losses[m]) / p;
  }

  if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) return null;
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  var rs = avgGain / avgLoss;
  if (!Number.isFinite(rs)) return 100;
  var rsi = 100 - (100 / (1 + rs));
  return Number.isFinite(rsi) ? Math.round(rsi * 100) / 100 : null;
}

// Volume ratio vs the trailing `period`-bar average. The averaging window is
// defined by test/chart-t1-candles.test.js (the SSOT for this endpoint): the
// reported volumeAvg20 includes the latest bar, and volumeVsAvg20 is that same
// latest volume divided by it. Kept as-is to preserve that contract.
function calcVolumeRatio(volumeArr, latestVol, period) {
  var avg = calcMA(volumeArr, period);
  if (!avg || avg <= 0 || !Number.isFinite(avg)) return 0;
  var vol = Number(latestVol);
  if (!Number.isFinite(vol) || vol <= 0) return 0;
  var ratio = vol / avg;
  return Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : 0;
}
