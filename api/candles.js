/**
 * Auto-Cuan Candles API — Yahoo Finance OHLCV for chart rendering
 * Returns 1-year daily candles + compact latest metrics.
 * In-memory cache with 5-minute TTL.
 */

var cache = {};
var CACHE_TTL = 5 * 60 * 1000;

module.exports = async function handler(req, res) {
  try {
    var ticker = null;

    if (req.method === 'GET') {
      ticker = req.query && req.query.ticker;
    } else if (req.method === 'POST') {
      var body = req.body || {};
      ticker = body.ticker;
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!ticker) {
      return res.status(400).json({ error: 'Parameter ticker wajib diisi.' });
    }

    ticker = String(ticker).toUpperCase().trim().replace(/\.JK$/i, '');
    // Normalize IHSG aliases
    if (ticker === 'JKSE' || ticker === 'JCI' || ticker === 'COMPOSITE') ticker = 'IHSG';
    if (!/^[A-Z]{3,5}$/.test(ticker)) {
      return res.status(400).json({ error: 'Format ticker tidak valid.' });
    }

    var cached = cache[ticker];
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return res.status(200).json(cached.data);
    }

    // Map ticker to Yahoo Finance symbol
    var symbol;
    if (ticker === 'IHSG') {
      symbol = '%5EJKSE'; // ^JKSE (URL-encoded)
    } else {
      symbol = ticker + '.JK';
    }
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=1y&interval=1d';

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
      return res.status(200).json({ success: false, ticker: ticker, error: 'Gagal mengambil data.' });
    }
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'HTTP ' + response.status });
    }

    var json;
    try { json = await response.json(); } catch (e) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Gagal parsing.' });
    }

    var chartResult = json && json.chart && json.chart.result && json.chart.result[0];
    if (!chartResult || !chartResult.timestamp) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Data tidak ditemukan.' });
    }

    var timestamps = chartResult.timestamp || [];
    var indicators = chartResult.indicators && chartResult.indicators.quote && chartResult.indicators.quote[0];
    if (!indicators) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'OHLCV kosong.' });
    }

    var opens = indicators.open || [];
    var highs = indicators.high || [];
    var lows = indicators.low || [];
    var closes = indicators.close || [];
    var volumes = indicators.volume || [];

    var candles = [];
    for (var i = 0; i < timestamps.length; i++) {
      var c = closes[i], o = opens[i], h = highs[i], l = lows[i], v = volumes[i];
      if (c != null && o != null && h != null && l != null && !isNaN(c)) {
        candles.push({
          time: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open: Math.round(o * 100) / 100,
          high: Math.round(h * 100) / 100,
          low: Math.round(l * 100) / 100,
          close: Math.round(c * 100) / 100,
          volume: v || 0
        });
      }
    }

    if (candles.length === 0) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Tidak ada candle valid.' });
    }

    // Calculate latest metrics
    var closePrices = candles.map(function(c) { return c.close; });
    var volumeArr = candles.map(function(c) { return c.volume; });
    var latest = candles[candles.length - 1];

    var result = {
      success: true,
      ticker: ticker,
      source: 'Data Historis T-1',
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
        volumeAvg20: calcMA(volumeArr, 20) ? Math.round(calcMA(volumeArr, 20)) : null,
        volumeVsAvg20: calcVolumeRatio(volumeArr, latest.volume, 20)
      },
      candles: candles
    };

    cache[ticker] = { data: result, timestamp: Date.now() };
    return res.status(200).json(result);

  } catch (err) {
    console.error('candles error:', err);
    return res.status(200).json({ success: false, ticker: 'unknown', error: 'Kesalahan internal.' });
  }
};

function calcMA(prices, period) {
  if (!prices || prices.length < period) return null;
  var slice = prices.slice(prices.length - period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) sum += slice[i];
  return Math.round((sum / period) * 100) / 100;
}

function calcRSI(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  var gains = 0, losses = 0;
  for (var i = closes.length - period; i < closes.length; i++) {
    var diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  var avgGain = gains / period;
  var avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  return Math.round((100 - (100 / (1 + rs))) * 100) / 100;
}

function calcVolumeRatio(volumeArr, latestVol, period) {
  var avg = calcMA(volumeArr, period);
  if (!avg || avg <= 0) return null;
  return Math.round((latestVol / avg) * 100) / 100;
}
