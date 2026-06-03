/**
 * Auto-Cuan Quote API — Yahoo Finance Lite
 * Fetches daily OHLCV + calculates MA20/50/100/200, RSI14, Volume metrics
 * Returns compact JSON summary only.
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

    var cacheKey = ticker;
    var cached = cache[cacheKey];
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return res.status(200).json(cached.data);
    }

    var symbol = ticker + '.JK';
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=1y&interval=1d';

    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 8000);

    var response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: controller.signal
      });
    } catch (fetchErr) {
      clearTimeout(timeout);
      return res.status(200).json({ success: false, ticker: ticker, error: 'Gagal mengambil data.', note: 'Data Historis T-1' });
    }
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'HTTP ' + response.status, note: 'Data Historis T-1' });
    }

    var json;
    try { json = await response.json(); } catch (e) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Gagal parsing.', note: 'Data Historis T-1' });
    }

    var chartResult = json && json.chart && json.chart.result && json.chart.result[0];
    if (!chartResult || !chartResult.timestamp) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Data tidak ditemukan.', note: 'Data Historis T-1' });
    }

    var timestamps = chartResult.timestamp || [];
    var indicators = chartResult.indicators && chartResult.indicators.quote && chartResult.indicators.quote[0];
    if (!indicators || timestamps.length === 0) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'OHLCV kosong.', note: 'Data Historis T-1' });
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
        candles.push({ close: Math.round(c * 100) / 100, open: Math.round(o * 100) / 100, high: Math.round(h * 100) / 100, low: Math.round(l * 100) / 100, volume: v || 0, date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10) });
      }
    }

    if (candles.length === 0) {
      return res.status(200).json({ success: false, ticker: ticker, error: 'Tidak ada candle valid.', note: 'Data Historis T-1' });
    }

    var latest = candles[candles.length - 1];
    var closePrices = candles.map(function(c) { return c.close; });
    var volumeArr = candles.map(function(c) { return c.volume; });

    var ma20 = calcMA(closePrices, 20);
    var ma50 = calcMA(closePrices, 50);
    var ma100 = calcMA(closePrices, 100);
    var ma200 = calcMA(closePrices, 200);
    var rsi14 = calcRSI(closePrices, 14);
    var volumeAvg20 = calcMA(volumeArr, 20);
    var volumeVsAvg20 = (volumeAvg20 && volumeAvg20 > 0) ? Math.round((latest.volume / volumeAvg20) * 100) / 100 : null;

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
      rsi14: rsi14,
      volumeAvg20: volumeAvg20 ? Math.round(volumeAvg20) : null,
      volumeVsAvg20: volumeVsAvg20,
      priceVsMA: priceVsMA.join(', '),
      totalCandles: candles.length,
      note: 'Data Historis T-1'
    };

    cache[cacheKey] = { data: result, timestamp: Date.now() };
    return res.status(200).json(result);

  } catch (err) {
    console.error('quote error:', err);
    return res.status(200).json({ success: false, ticker: ticker || 'unknown', error: 'Kesalahan internal.', note: 'Data Historis T-1' });
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
