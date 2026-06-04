/**
 * Auto-Cuan Quote API — Yahoo Finance Lite + Board/FCA from Supabase
 * Fetches daily OHLCV + calculates MA20/50/100/200, RSI14, Volume metrics
 * Also fetches board classification from Supabase REST (no SDK).
 * Returns compact JSON summary with board data included.
 * Yahoo cache: 5-minute TTL. Board cache: 12-hour TTL.
 */

var quoteCache = {};
var QUOTE_CACHE_TTL = 5 * 60 * 1000;

var boardCache = {};
var BOARD_CACHE_TTL = 12 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  var ticker = null;
  try {
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

    // Run Yahoo quote and Supabase board fetch in parallel
    var results = await Promise.all([
      fetchYahooQuote(ticker),
      fetchBoardData(ticker)
    ]);

    var quoteResult = results[0];
    var boardResult = results[1];

    // Attach board to quote result
    quoteResult.board = boardResult;

    return res.status(200).json(quoteResult);

  } catch (err) {
    console.error('quote error:', err);
    return res.status(200).json({
      success: false,
      ticker: ticker || 'unknown',
      error: 'Kesalahan internal.',
      note: 'Data Historis T-1',
      board: makeBoardNotFound(ticker || 'unknown')
    });
  }
};

// ===== YAHOO QUOTE FETCH =====
async function fetchYahooQuote(ticker) {
  // Check quote cache
  var cached = quoteCache[ticker];
  if (cached && (Date.now() - cached.timestamp < QUOTE_CACHE_TTL)) {
    return cached.data;
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
    return { success: false, ticker: ticker, error: 'Gagal mengambil data.', note: 'Data Historis T-1' };
  }
  clearTimeout(timeout);

  if (!response.ok) {
    return { success: false, ticker: ticker, error: 'HTTP ' + response.status, note: 'Data Historis T-1' };
  }

  var json;
  try { json = await response.json(); } catch (e) {
    return { success: false, ticker: ticker, error: 'Gagal parsing.', note: 'Data Historis T-1' };
  }

  var chartResult = json && json.chart && json.chart.result && json.chart.result[0];
  if (!chartResult || !chartResult.timestamp) {
    return { success: false, ticker: ticker, error: 'Data tidak ditemukan.', note: 'Data Historis T-1' };
  }

  var timestamps = chartResult.timestamp || [];
  var indicators = chartResult.indicators && chartResult.indicators.quote && chartResult.indicators.quote[0];
  if (!indicators || timestamps.length === 0) {
    return { success: false, ticker: ticker, error: 'OHLCV kosong.', note: 'Data Historis T-1' };
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
    return { success: false, ticker: ticker, error: 'Tidak ada candle valid.', note: 'Data Historis T-1' };
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

  quoteCache[ticker] = { data: result, timestamp: Date.now() };
  return result;
}

// ===== SUPABASE BOARD FETCH =====
async function fetchBoardData(ticker) {
  // Check board cache
  var cached = boardCache[ticker];
  if (cached && (Date.now() - cached.timestamp < BOARD_CACHE_TTL)) {
    return cached.data;
  }

  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return makeBoardNotFound(ticker);
  }

  var url = SUPABASE_URL + '/rest/v1/stock_boards?ticker=eq.' + ticker + '&is_active=eq.true&limit=1';

  var response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json'
      }
    });
  } catch (fetchErr) {
    return makeBoardNotFound(ticker);
  }

  if (!response.ok) {
    return makeBoardNotFound(ticker);
  }

  var rows;
  try { rows = await response.json(); } catch (e) {
    return makeBoardNotFound(ticker);
  }

  if (!rows || rows.length === 0) {
    var notFound = makeBoardNotFound(ticker);
    boardCache[ticker] = { data: notFound, timestamp: Date.now() };
    return notFound;
  }

  var row = rows[0];
  var boardResult = {
    success: true,
    companyName: row.company_name || null,
    board: row.board || 'UNKNOWN',
    isFca: !!row.is_fca,
    minPriceGuard: row.min_price_guard != null ? row.min_price_guard : 50,
    note: row.note || getBoardNote(row.board)
  };

  boardCache[ticker] = { data: boardResult, timestamp: Date.now() };
  return boardResult;
}

function makeBoardNotFound(ticker) {
  return {
    success: false,
    companyName: null,
    board: 'UNKNOWN',
    isFca: false,
    minPriceGuard: 50,
    note: 'Board/FCA belum tersedia'
  };
}

function getBoardNote(board) {
  switch (board) {
    case 'UTAMA': return 'Papan Utama';
    case 'PENGEMBANGAN': return 'Papan Pengembangan';
    case 'AKSELERASI': return 'Papan Akselerasi';
    case 'PEMANTAUAN_KHUSUS': return 'Papan Pemantauan Khusus';
    case 'EKONOMI_BARU': return 'Papan Ekonomi Baru';
    default: return '';
  }
}

// ===== CALCULATION HELPERS =====
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
