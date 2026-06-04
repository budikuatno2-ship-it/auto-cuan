/**
 * Auto-Cuan Quote API — Yahoo Finance Lite + Board/FCA + News/Katalis
 * Fetches daily OHLCV + calculates MA20/50/100/200, RSI14, Volume metrics.
 * Also fetches board classification from Supabase REST (no SDK).
 * Optionally fetches cached news/katalis summary (includeNews=1).
 * Returns compact JSON summary with board + optional news data.
 * Yahoo cache: 5-minute TTL. Board cache: 12-hour TTL. News cache: 30-day TTL (Supabase).
 */

var quoteCache = {};
var QUOTE_CACHE_TTL = 5 * 60 * 1000;

var boardCache = {};
var BOARD_CACHE_TTL = 12 * 60 * 60 * 1000;

var NEWS_CACHE_TTL_DAYS = 30;
var NEWS_PERIOD = '6m';

module.exports = async function handler(req, res) {
  var ticker = null;
  try {
    var includeNews = false;

    if (req.method === 'GET') {
      ticker = req.query && req.query.ticker;
      includeNews = req.query && req.query.includeNews === '1';
    } else if (req.method === 'POST') {
      var body = req.body || {};
      ticker = body.ticker;
      includeNews = body.includeNews === '1' || body.includeNews === 1 || body.includeNews === true;
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

    // Run Yahoo quote, Supabase board, and optionally news in parallel
    var fetches = [
      fetchYahooQuote(ticker),
      fetchBoardData(ticker)
    ];
    if (includeNews) {
      fetches.push(fetchNewsData(ticker));
    }

    var results = await Promise.all(fetches);

    var quoteResult = results[0];
    var boardResult = results[1];
    var newsResult = includeNews ? results[2] : null;

    // Attach board to quote result
    quoteResult.board = boardResult;

    // Attach news if requested
    if (includeNews) {
      quoteResult.news = newsResult;
    }

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

// ===== NEWS PROVIDER COOLDOWN (in-memory, per serverless instance) =====
var _newsCooldown = {};
var NEWS_COOLDOWN_MS = 45 * 60 * 1000; // 45 minutes
var COOLDOWN_HTTP_CODES = [401, 402, 403, 429, 503];

function isProviderCoolingDown(providerName) {
  var cd = _newsCooldown[providerName];
  if (!cd) return false;
  if (Date.now() < cd.until) return true;
  delete _newsCooldown[providerName]; // expired
  return false;
}

function setProviderCooldown(providerName, httpStatus, reason) {
  _newsCooldown[providerName] = {
    until: Date.now() + NEWS_COOLDOWN_MS,
    httpStatus: httpStatus,
    reason: reason,
    setAt: new Date().toISOString()
  };
}

function getCooldownDebug(providerName) {
  var cd = _newsCooldown[providerName];
  if (!cd) return { cooldownActive: false };
  if (Date.now() >= cd.until) { delete _newsCooldown[providerName]; return { cooldownActive: false }; }
  return { cooldownActive: true, cooldownReason: cd.reason, cooldownUntil: new Date(cd.until).toISOString() };
}

// ===== NEWS/KATALIS FETCH (Supabase cache + CodeCrafters/Gemini) =====
async function fetchNewsData(ticker) {
  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  var NEWS_PROVIDER = process.env.NEWS_PROVIDER || '';
  var CC_NEWS_KEY = process.env.CODECRAFTERS_NEWS_API_KEY;
  var CC_NEWS_URL = process.env.CODECRAFTERS_NEWS_BASE_URL;
  var CC_NEWS_MODEL = process.env.CODECRAFTERS_NEWS_MODEL || 'gemini-3.5-flash-free';
  var NEWS_DEBUG = process.env.NEWS_DEBUG === 'true';

  var ccCooldown = getCooldownDebug('codecrafters');
  var gmCooldown = getCooldownDebug('official_gemini');

  var debug = {
    newsProvider: NEWS_PROVIDER || 'default_official_gemini',
    providerTried: [],
    providerUsed: null,
    codeCraftersNewsConfigured: !!(CC_NEWS_KEY && CC_NEWS_URL),
    officialGeminiConfigured: !!GEMINI_API_KEY,
    groundingEnabled: true,
    cacheChecked: false,
    cacheHit: false,
    cooldown: { codecrafters: ccCooldown, official_gemini: gmCooldown },
    reason: ''
  };

  // 1. Check Supabase cache first
  if (SUPABASE_URL && SUPABASE_KEY) {
    debug.cacheChecked = true;
    var cached = await getCachedNews(SUPABASE_URL, SUPABASE_KEY, ticker);
    if (cached !== null) {
      debug.cacheHit = true;
      debug.reason = 'cache_valid';
      var r1 = { success: true, items: cached, source: 'cache' };
      if (NEWS_DEBUG) r1._debug = debug;
      return r1;
    }
    debug.reason = 'cache_miss_or_expired';
  } else {
    debug.reason = 'supabase_not_configured';
  }

  // 2. Fetch news based on NEWS_PROVIDER setting (with cooldown checks)
  var newsItems = null;
  var providerResults = {};

  if (NEWS_PROVIDER === 'codecrafters') {
    if (CC_NEWS_KEY && CC_NEWS_URL) {
      if (isProviderCoolingDown('codecrafters')) {
        providerResults.codecrafters = { configured: true, called: false, providerSkippedDueToCooldown: true, errorType: 'cooldown', reason: 'provider cooling down' };
      } else {
        debug.providerTried.push('codecrafters');
        var ccResult = await fetchNewsFromCodeCrafters(CC_NEWS_KEY, CC_NEWS_URL, CC_NEWS_MODEL, ticker);
        providerResults.codecrafters = ccResult._diag;
        if (isValidNewsResult(ccResult.items)) {
          newsItems = ccResult.items;
          debug.providerUsed = 'codecrafters';
        } else {
          if (ccResult._diag.httpStatus && COOLDOWN_HTTP_CODES.indexOf(ccResult._diag.httpStatus) >= 0) {
            setProviderCooldown('codecrafters', ccResult._diag.httpStatus, 'HTTP ' + ccResult._diag.httpStatus);
          }
          debug.reason = (debug.reason ? debug.reason + ',' : '') + 'codecrafters_no_valid_results';
        }
      }
    } else {
      providerResults.codecrafters = { configured: false, called: false, errorType: 'not_configured', reason: 'missing env' };
      debug.reason = (debug.reason ? debug.reason + ',' : '') + 'codecrafters_not_configured';
    }

  } else if (NEWS_PROVIDER === 'official_gemini') {
    if (GEMINI_API_KEY) {
      if (isProviderCoolingDown('official_gemini')) {
        providerResults.official_gemini = { configured: true, called: false, groundingEnabled: true, providerSkippedDueToCooldown: true, errorType: 'cooldown', reason: 'provider cooling down' };
      } else {
        debug.providerTried.push('official_gemini');
        var gmResult = await fetchNewsFromGemini(GEMINI_API_KEY, ticker);
        providerResults.official_gemini = gmResult._diag;
        if (isValidNewsResult(gmResult.items)) {
          newsItems = gmResult.items;
          debug.providerUsed = 'official_gemini';
        } else {
          if (gmResult._diag.httpStatus && COOLDOWN_HTTP_CODES.indexOf(gmResult._diag.httpStatus) >= 0) {
            setProviderCooldown('official_gemini', gmResult._diag.httpStatus, 'HTTP ' + gmResult._diag.httpStatus);
          }
          debug.reason = (debug.reason ? debug.reason + ',' : '') + 'official_gemini_no_valid_results';
        }
      }
    } else {
      providerResults.official_gemini = { configured: false, called: false, errorType: 'not_configured', reason: 'missing env' };
      debug.reason = (debug.reason ? debug.reason + ',' : '') + 'official_gemini_not_configured';
    }

  } else if (NEWS_PROVIDER === 'auto') {
    // Try CodeCrafters first (with cooldown), fallback to official Gemini
    if (CC_NEWS_KEY && CC_NEWS_URL) {
      if (isProviderCoolingDown('codecrafters')) {
        providerResults.codecrafters = { configured: true, called: false, providerSkippedDueToCooldown: true, errorType: 'cooldown', reason: 'provider cooling down' };
      } else {
        debug.providerTried.push('codecrafters');
        var ccResult2 = await fetchNewsFromCodeCrafters(CC_NEWS_KEY, CC_NEWS_URL, CC_NEWS_MODEL, ticker);
        providerResults.codecrafters = ccResult2._diag;
        if (isValidNewsResult(ccResult2.items)) {
          newsItems = ccResult2.items;
          debug.providerUsed = 'codecrafters';
        } else {
          if (ccResult2._diag.httpStatus && COOLDOWN_HTTP_CODES.indexOf(ccResult2._diag.httpStatus) >= 0) {
            setProviderCooldown('codecrafters', ccResult2._diag.httpStatus, 'HTTP ' + ccResult2._diag.httpStatus);
          }
        }
      }
    } else {
      providerResults.codecrafters = { configured: false, called: false, errorType: 'not_configured', reason: 'missing env' };
    }
    if (!newsItems && GEMINI_API_KEY) {
      if (isProviderCoolingDown('official_gemini')) {
        providerResults.official_gemini = { configured: true, called: false, groundingEnabled: true, providerSkippedDueToCooldown: true, errorType: 'cooldown', reason: 'provider cooling down' };
      } else {
        debug.providerTried.push('official_gemini');
        var gmResult2 = await fetchNewsFromGemini(GEMINI_API_KEY, ticker);
        providerResults.official_gemini = gmResult2._diag;
        if (isValidNewsResult(gmResult2.items)) {
          newsItems = gmResult2.items;
          debug.providerUsed = 'official_gemini';
        } else {
          if (gmResult2._diag.httpStatus && COOLDOWN_HTTP_CODES.indexOf(gmResult2._diag.httpStatus) >= 0) {
            setProviderCooldown('official_gemini', gmResult2._diag.httpStatus, 'HTTP ' + gmResult2._diag.httpStatus);
          }
          debug.reason = (debug.reason ? debug.reason + ',' : '') + 'auto_all_providers_failed';
        }
      }
    } else if (!newsItems && !GEMINI_API_KEY) {
      providerResults.official_gemini = { configured: false, called: false, errorType: 'not_configured', reason: 'missing env' };
    }
    if (!newsItems && !GEMINI_API_KEY && !(CC_NEWS_KEY && CC_NEWS_URL)) {
      debug.reason = (debug.reason ? debug.reason + ',' : '') + 'no_providers_configured';
    }

  } else {
    // Default: official Gemini with grounding (backward compatible)
    if (GEMINI_API_KEY) {
      if (isProviderCoolingDown('official_gemini')) {
        providerResults.official_gemini = { configured: true, called: false, groundingEnabled: true, providerSkippedDueToCooldown: true, errorType: 'cooldown', reason: 'provider cooling down' };
      } else {
        debug.providerTried.push('official_gemini');
        var gmResult3 = await fetchNewsFromGemini(GEMINI_API_KEY, ticker);
        providerResults.official_gemini = gmResult3._diag;
        if (isValidNewsResult(gmResult3.items)) {
          newsItems = gmResult3.items;
          debug.providerUsed = 'official_gemini';
        } else {
          if (gmResult3._diag.httpStatus && COOLDOWN_HTTP_CODES.indexOf(gmResult3._diag.httpStatus) >= 0) {
            setProviderCooldown('official_gemini', gmResult3._diag.httpStatus, 'HTTP ' + gmResult3._diag.httpStatus);
          }
          debug.reason = (debug.reason ? debug.reason + ',' : '') + 'official_gemini_no_valid_results';
        }
      }
    } else {
      providerResults.official_gemini = { configured: false, called: false, errorType: 'not_configured', reason: 'missing env' };
      debug.reason = (debug.reason ? debug.reason + ',' : '') + 'gemini_not_configured';
    }
  }

  // Attach provider results to debug
  debug.providerResults = providerResults;

  // 3. No valid news from any provider — do NOT cache failed/empty results
  if (!newsItems || newsItems.length === 0) {
    if (!debug.reason || debug.reason === 'cache_miss_or_expired') {
      debug.reason = (debug.reason ? debug.reason + ',' : '') + 'no_valid_results';
    }
    var rEmpty = { success: false, items: [], note: 'News/katalis belum tersedia.' };
    if (NEWS_DEBUG) rEmpty._debug = debug;
    return rEmpty;
  }

  // 4. Save valid news to Supabase cache
  if (SUPABASE_URL && SUPABASE_KEY) {
    await saveCachedNews(SUPABASE_URL, SUPABASE_KEY, ticker, newsItems);
  }

  debug.reason = 'success';
  var rOk = { success: true, items: newsItems, source: debug.providerUsed || 'unknown' };
  if (NEWS_DEBUG) rOk._debug = debug;
  return rOk;
}

// === NEWS VALIDATION ===
function isValidNewsItem(item) {
  if (!item || !item.title || !item.summary) return false;
  // source OR url is enough (url preferred but source+title+summary is valid)
  if (!item.source && !item.url) return false;
  return true;
}

function isValidNewsResult(items) {
  if (!items || !Array.isArray(items) || items.length === 0) return false;
  for (var i = 0; i < items.length; i++) {
    if (isValidNewsItem(items[i])) return true;
  }
  return false;
}

// === CODECRAFTERS NEWS PROVIDER (OpenAI-compatible) ===
async function fetchNewsFromCodeCrafters(apiKey, baseUrl, model, ticker) {
  var diag = { configured: true, called: true, httpStatus: null, ok: false, rawTextLength: 0, parsedJson: false, itemCountRaw: 0, itemCountValid: 0, errorType: null, reason: '' };

  var prompt = 'Kamu adalah research assistant untuk saham Indonesia (IDX/BEI). ' +
    'Cari berita/katalis penting saham ' + ticker + '.JK (ticker IDX: ' + ticker + ') dalam 6 bulan terakhir.\n\n' +
    'Return HANYA valid JSON array (max 2 items). Setiap item harus memiliki format:\n' +
    '{\n' +
    '  "date": "YYYY-MM-DD",\n' +
    '  "title": "judul singkat berita",\n' +
    '  "source": "nama media/sumber",\n' +
    '  "url": "link lengkap jika tersedia, atau null",\n' +
    '  "summary": "ringkasan 1-2 kalimat dampak ke saham",\n' +
    '  "impact": "positive" | "negative" | "neutral" | "mixed"\n' +
    '}\n\n' +
    'Prioritas:\n' +
    '1. Berita paling relevan dari 0-3 bulan terakhir (jika ada)\n' +
    '2. Satu berita tambahan dari 3-6 bulan terakhir (jika relevan)\n\n' +
    'Rules:\n' +
    '- Max 2 items\n' +
    '- Sertakan source (nama media) untuk setiap item. URL jika tersedia.\n' +
    '- Jika tidak ada berita yang bisa diverifikasi, return empty array: []\n' +
    '- Jangan karang berita. Jika tidak yakin, return []\n' +
    '- Jangan include full article text\n' +
    '- Fokus: corporate action, akuisisi, dividen, right issue, perubahan papan, kinerja keuangan, kontrak baru, regulasi\n' +
    '- Return HANYA JSON array, tanpa markdown, tanpa explanation\n' +
    '- Jika ticker tidak dikenal atau tidak ada berita, return: []';

  var url = (baseUrl || 'https://api.codecrafters.id/v1') + '/chat/completions';
  var payload = {
    model: model || 'gemini-3.5-flash-free',
    messages: [
      { role: 'system', content: 'You are a stock news research assistant for Indonesian stocks (IDX/BEI). Return only valid JSON.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 1024,
    stream: false
  };

  try {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 20000);

    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);

    diag.httpStatus = response.status;
    if (!response.ok) { diag.errorType = 'http_error'; diag.reason = 'HTTP ' + response.status; return { items: [], _diag: diag }; }
    diag.ok = true;

    var result = await response.json();
    var choices = result.choices || [];
    if (choices.length === 0 || !choices[0].message || !choices[0].message.content) { diag.errorType = 'empty_response'; diag.reason = 'no choices/content'; return { items: [], _diag: diag }; }

    var text = choices[0].message.content.trim();
    diag.rawTextLength = text.length;
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    var jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) { diag.errorType = 'parse_error'; diag.reason = 'no JSON array found in text'; return { items: [], _diag: diag }; }

    var parsed = JSON.parse(jsonMatch[0]);
    diag.parsedJson = true;
    if (!Array.isArray(parsed)) { diag.errorType = 'parse_error'; diag.reason = 'parsed but not array'; return { items: [], _diag: diag }; }
    diag.itemCountRaw = parsed.length;

    var valid = validateAndLimitNews(parsed);
    diag.itemCountValid = valid.length;
    if (valid.length === 0) { diag.errorType = 'invalid_items'; diag.reason = 'items parsed but none valid (need title+summary+source/url)'; }
    else { diag.reason = 'ok'; }
    return { items: valid, _diag: diag };
  } catch (e) {
    diag.errorType = e.name === 'AbortError' ? 'timeout' : 'exception';
    diag.reason = e.name === 'AbortError' ? 'request timeout' : (e.message || '').slice(0, 100);
    return { items: [], _diag: diag };
  }
}

// === SUPABASE NEWS CACHE: READ ===
async function getCachedNews(supabaseUrl, supabaseKey, ticker) {
  try {
    var url = supabaseUrl + '/rest/v1/stock_news_cache?ticker=eq.' + ticker + '&period=eq.' + NEWS_PERIOD + '&limit=1';
    var response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) return null;
    var rows = await response.json();
    if (!rows || rows.length === 0) return null;

    var row = rows[0];
    // Check expiry
    if (row.expires_at) {
      var expiresAt = new Date(row.expires_at);
      if (expiresAt <= new Date()) return null; // expired
    } else {
      // Fallback: check created_at + TTL
      var createdAt = new Date(row.created_at);
      var expiryDate = new Date(createdAt.getTime() + NEWS_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
      if (expiryDate <= new Date()) return null;
    }

    // Only return cache if it has valid items; empty arrays are not valid cache
    var items = row.items || [];
    if (!Array.isArray(items) || items.length === 0) return null;
    return items;
  } catch (e) {
    return null;
  }
}

// === SUPABASE NEWS CACHE: WRITE (UPSERT) ===
async function saveCachedNews(supabaseUrl, supabaseKey, ticker, items) {
  try {
    var now = new Date();
    var expiresAt = new Date(now.getTime() + NEWS_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

    var payload = {
      ticker: ticker,
      period: NEWS_PERIOD,
      items: items,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    };

    var url = supabaseUrl + '/rest/v1/stock_news_cache';
    await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    // Silent fail — cache write is non-critical
  }
}

// === GEMINI: FETCH NEWS SUMMARY (with Google Search grounding) ===
async function fetchNewsFromGemini(apiKey, ticker) {
  var diag = { configured: true, called: true, groundingEnabled: true, httpStatus: null, ok: false, rawTextLength: 0, parsedJson: false, itemCountRaw: 0, itemCountValid: 0, errorType: null, reason: '' };

  var prompt = 'Kamu adalah research assistant untuk saham Indonesia (IDX/BEI). ' +
    'Gunakan Google Search untuk mencari berita/katalis penting saham ' + ticker + '.JK (ticker IDX: ' + ticker + ') dalam 6 bulan terakhir.\n\n' +
    'Return HANYA valid JSON array (max 2 items). Setiap item harus memiliki format:\n' +
    '{\n' +
    '  "date": "YYYY-MM-DD",\n' +
    '  "title": "judul singkat berita",\n' +
    '  "source": "nama media/sumber",\n' +
    '  "url": "link jika tersedia, atau null",\n' +
    '  "summary": "ringkasan 1-2 kalimat dampak ke saham",\n' +
    '  "impact": "positive" | "negative" | "neutral" | "mixed"\n' +
    '}\n\n' +
    'Prioritas:\n' +
    '1. Berita paling relevan dari 0-3 bulan terakhir (jika ada)\n' +
    '2. Satu berita tambahan dari 3-6 bulan terakhir (jika relevan)\n\n' +
    'Rules:\n' +
    '- Max 2 items\n' +
    '- Sertakan source (nama media) untuk setiap item. URL jika tersedia.\n' +
    '- Jika tidak ada berita relevan, return empty array: []\n' +
    '- Jangan karang berita. Jika tidak yakin, return []\n' +
    '- Jangan include full article text\n' +
    '- Fokus: corporate action, akuisisi, dividen, right issue, perubahan papan, kinerja keuangan, kontrak baru, regulasi\n' +
    '- Return HANYA JSON array, tanpa markdown, tanpa explanation\n' +
    '- Jika ticker tidak dikenal atau tidak ada berita, return: []';

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 1024
    }
  };

  try {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 20000);

    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);

    diag.httpStatus = response.status;
    if (!response.ok) { diag.errorType = 'http_error'; diag.reason = 'HTTP ' + response.status; return { items: [], _diag: diag }; }
    diag.ok = true;

    var result = await response.json();
    var candidates = result.candidates || [];
    if (candidates.length === 0) { diag.errorType = 'empty_response'; diag.reason = 'no candidates'; return { items: [], _diag: diag }; }

    // Gemini with grounding may return multiple parts; concatenate text parts
    var textParts = [];
    var parts = (candidates[0].content && candidates[0].content.parts) || [];
    for (var pi = 0; pi < parts.length; pi++) {
      if (parts[pi].text) textParts.push(parts[pi].text);
    }
    var text = textParts.join('');
    diag.rawTextLength = text.length;

    // Clean markdown code fences if present
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Try to extract JSON array from response (may have surrounding text with grounding)
    var jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) { diag.errorType = 'parse_error'; diag.reason = 'no JSON array found in text'; return { items: [], _diag: diag }; }

    var parsed = JSON.parse(jsonMatch[0]);
    diag.parsedJson = true;
    if (!Array.isArray(parsed)) { diag.errorType = 'parse_error'; diag.reason = 'parsed but not array'; return { items: [], _diag: diag }; }
    diag.itemCountRaw = parsed.length;

    var valid = validateAndLimitNews(parsed);
    diag.itemCountValid = valid.length;
    if (valid.length === 0) { diag.errorType = 'invalid_items'; diag.reason = 'items parsed but none valid (need title+summary+source/url)'; }
    else { diag.reason = 'ok'; }
    return { items: valid, _diag: diag };
  } catch (e) {
    diag.errorType = e.name === 'AbortError' ? 'timeout' : 'exception';
    diag.reason = e.name === 'AbortError' ? 'request timeout' : (e.message || '').slice(0, 100);
    return { items: [], _diag: diag };
  }
}

// === SHARED NEWS VALIDATION + LIMIT ===
function validateAndLimitNews(parsed) {
  if (!Array.isArray(parsed)) return [];
  var valid = [];
  for (var i = 0; i < parsed.length && valid.length < 2; i++) {
    var item = parsed[i];
    if (item && item.title && item.summary) {
      valid.push({
        date: item.date || null,
        title: String(item.title).slice(0, 200),
        source: item.source || null,
        url: item.url || null,
        summary: String(item.summary).slice(0, 300),
        impact: ['positive', 'negative', 'neutral', 'mixed'].indexOf(item.impact) >= 0 ? item.impact : 'neutral'
      });
    }
  }
  return valid;
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
