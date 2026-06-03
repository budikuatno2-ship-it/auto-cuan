/**
 * Auto-Cuan Candles API — Yahoo Finance OHLCV for chart rendering
 * Returns 1-year daily candles for lightweight chart display.
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
    if (!/^[A-Z]{3,5}$/.test(ticker)) {
      return res.status(400).json({ error: 'Format ticker tidak valid.' });
    }

    // Check cache
    var cached = cache[ticker];
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return res.status(200).json(cached.data);
    }

    var symbol = ticker + '.JK';
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
      return res.status(200).json({ success: false, ticker: ticker, error: 'Gagal mengambil data dari Yahoo Finance.' });
    }
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Yahoo Finance HTTP ' + response.status });
    }

    var json;
    try { json = await response.json(); } catch (e) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Gagal parsing respons.' });
    }

    var chartResult = json && json.chart && json.chart.result && json.chart.result[0];
    if (!chartResult || !chartResult.timestamp) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Data tidak ditemukan.' });
    }

    var timestamps = chartResult.timestamp || [];
    var indicators = chartResult.indicators && chartResult.indicators.quote && chartResult.indicators.quote[0];
    if (!indicators) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Data OHLCV kosong.' });
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

    var result = {
      success: true,
      ticker: ticker,
      source: 'Yahoo Finance unofficial/delayed',
      totalCandles: candles.length,
      candles: candles
    };

    cache[ticker] = { data: result, timestamp: Date.now() };
    return res.status(200).json(result);

  } catch (err) {
    console.error('candles error:', err);
    return res.status(200).json({ success: false, ticker: 'unknown', error: 'Terjadi kesalahan internal.' });
  }
};
