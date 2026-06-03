/**
 * Auto-Cuan Quote API — Yahoo Finance Lite
 * Fetches daily OHLCV + calculates MA20/50/100/200
 * Returns compact JSON summary only.
 * In-memory cache with 5-minute TTL.
 */

// Simple in-memory cache (resets on cold start, which is fine)
var cache = {};
var CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

    // Normalize ticker
    ticker = String(ticker).toUpperCase().trim().replace(/\.JK$/i, '');
    if (!/^[A-Z]{3,5}$/.test(ticker)) {
      return res.status(400).json({ error: 'Format ticker tidak valid.' });
    }

    // Check cache
    var cacheKey = ticker;
    var cached = cache[cacheKey];
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return res.status(200).json(cached.data);
    }

    // Fetch from Yahoo Finance chart endpoint
    var symbol = ticker + '.JK';
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=1y&interval=1d';

    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 8000);

    var response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: controller.signal
      });
    } catch (fetchErr) {
      clearTimeout(timeout);
      return res.status(200).json({
        success: false,
        ticker: ticker,
        error: 'Gagal mengambil data dari Yahoo Finance.',
        note: 'Yahoo Finance unofficial/delayed'
      });
    }
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(200).json({
        success: false,
        ticker: ticker,
        error: 'Yahoo Finance tidak merespons (HTTP ' + response.status + ').',
        note: 'Yahoo Finance unofficial/delayed'
      });
    }

    var json;
    try {
      json = await response.json();
    } catch (parseErr) {
      return res.status(200).json({
        success: false,
        ticker: ticker,
        error: 'Gagal parsing respons Yahoo Finance.',
        note: 'Yahoo Finance unofficial/delayed'
      });
    }

    // Parse chart data
    var chartResult = json && json.chart && json.chart.result && json.chart.result[0];
    if (!chartResult) {
      return res.status(200).json({
        success: false,
        ticker: ticker,
        error: 'Data chart tidak ditemukan untuk ' + ticker + '.JK.',
        note: 'Yahoo Finance unofficial/delayed'
      });
    }

    var timestamps = chartResult.timestamp || [];
    var indicators = chartResult.indicators && chartResult.indicators.quote && chartResult.indicators.quote[0];
    if (!indicators || timestamps.length === 0) {
      return res.status(200).json({
        success: false,
        ticker: ticker,
        error: 'Data OHLCV kosong.',
        note: 'Yahoo Finance unofficial/delayed'
      });
    }

    var opens = indicators.open || [];
    var highs = indicators.high || [];
    var lows = indicators.low || [];
    var closes = indicators.close || [];
    var volumes = indicators.volume || [];

    // Build valid candles (filter out nulls)
    var candles = [];
    for (var i = 0; i < timestamps.length; i++) {
      var c = closes[i];
      var o = opens[i];
      var h = highs[i];
      var l = lows[i];
      var v = volumes[i];
      if (c != null && o != null && h != null && l != null && !isNaN(c)) {
        candles.push({
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open: Math.round(o * 100) / 100,
          high: Math.round(h * 100) / 100,
          low: Math.round(l * 100) / 100,
          close: Math.round(c * 100) / 100,
          volume: v || 0
        });
      }
    }

    if (candles.length === 0) {
      return res.status(200).json({
        success: false,
        ticker: ticker,
        error: 'Tidak ada candle valid.',
        note: 'Yahoo Finance unofficial/delayed'
      });
    }

    // Latest candle
    var latest = candles[candles.length - 1];

    // Calculate Moving Averages
    var closePrices = candles.map(function(c) { return c.close; });
    var ma20 = calcMA(closePrices, 20);
    var ma50 = calcMA(closePrices, 50);
    var ma100 = calcMA(closePrices, 100);
    var ma200 = calcMA(closePrices, 200);

    // Price vs MA position
    var lastPrice = latest.close;
    var priceVsMA = [];
    if (ma20 !== null) priceVsMA.push((lastPrice >= ma20 ? 'above' : 'below') + ' MA20');
    if (ma50 !== null) priceVsMA.push((lastPrice >= ma50 ? 'above' : 'below') + ' MA50');
    if (ma100 !== null) priceVsMA.push((lastPrice >= ma100 ? 'above' : 'below') + ' MA100');
    if (ma200 !== null) priceVsMA.push((lastPrice >= ma200 ? 'above' : 'below') + ' MA200');

    var result = {
      success: true,
      ticker: ticker,
      symbol: symbol,
      latestBarDate: latest.date,
      last: lastPrice,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      volume: latest.volume,
      ma20: ma20,
      ma50: ma50,
      ma100: ma100,
      ma200: ma200,
      priceVsMA: priceVsMA.join(', '),
      totalCandles: candles.length,
      note: 'Yahoo Finance unofficial/delayed'
    };

    // Store in cache
    cache[cacheKey] = { data: result, timestamp: Date.now() };

    return res.status(200).json(result);

  } catch (err) {
    console.error('quote error:', err);
    return res.status(200).json({
      success: false,
      ticker: ticker || 'unknown',
      error: 'Terjadi kesalahan internal.',
      note: 'Yahoo Finance unofficial/delayed'
    });
  }
};

// Calculate Simple Moving Average from the end of prices array
function calcMA(prices, period) {
  if (!prices || prices.length < period) return null;
  var slice = prices.slice(prices.length - period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) {
    sum += slice[i];
  }
  return Math.round((sum / period) * 100) / 100;
}
