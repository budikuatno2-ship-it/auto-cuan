/**
 * Auto-Cuan Quote API — Yahoo Finance Lite + Board/FCA + News/Katalis
 * Fetches daily OHLCV + calculates MA20/50/100/200, RSI14, Volume metrics.
 * Also fetches board classification from Supabase REST (no SDK).
 * Optionally fetches cached news/katalis summary (includeNews=1).
 * Returns compact JSON summary with board + optional news data.
 * Yahoo cache: 5-minute TTL. Board cache: 12-hour TTL. News cache: 30-day TTL (Supabase).
 */

var dtEngine = require('../lib/daytrade-screener-engine');
var idxTick = require('../lib/idx-tick-normalization');
var latestPriceResolver = require('../lib/latest-price-resolver');
var dailyContextBuilder = require('../lib/daily-market-context-builder');

var quoteCache = {};
var QUOTE_CACHE_TTL = 5 * 60 * 1000;

var boardCache = {};
var BOARD_CACHE_TTL = 12 * 60 * 60 * 1000;

var NEWS_CACHE_TTL_DAYS = 30;
var NEWS_PERIOD = '6m';

function hasLoggedInHeaders(req) {
  var username = String((req.headers && req.headers['x-username']) || '').trim().toLowerCase();
  var userId = String((req.headers && req.headers['x-user-id']) || '').trim();
  return !!((username && username !== 'guest') || (userId && userId.length > 10));
}

function redactAdvancedQuoteFields(result) {
  if (!result) return result;
  if (result.respectZone) delete result.respectZone;
  if (result.tradingPlan) {
    delete result.tradingPlan.half_candle_level;
    delete result.tradingPlan.half_candle_label;
    delete result.tradingPlan.half_candle_note;
    delete result.tradingPlan.half_candle_chase_risk;
    delete result.tradingPlan.refinement_notes;
    delete result.tradingPlan.respect_zone_notes;
    delete result.tradingPlan.respect_quality_score;
    delete result.tradingPlan.respect_quality_label;
    delete result.tradingPlan.respect_quality_factors;
    delete result.tradingPlan.respect_invalid_reason;
    delete result.tradingPlan.bearish_respect_warning;
  }
  return result;
}

async function fetchFreshScreenerLatestPrice(ticker) {
  var base = String(process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!base || !key) return { price: null, stale: true, diagnostic: 'supabase_not_configured' };
  var rows = {};
  await Promise.all(latestPriceResolver.SOURCES.map(async function(source) {
    try {
      var url = base + '/rest/v1/' + source.table + '?ticker=eq.' + encodeURIComponent(ticker) + '&limit=1';
      var response = await fetch(url, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
      if (!response.ok) return;
      var data = await response.json();
      rows[source.table] = data && data[0] || null;
    } catch (_) { /* a missing fallback table must not break quotes */ }
  }));
  return latestPriceResolver.resolveLatestPrice(rows, { now: new Date().toISOString() });
}

// ============================================================
// DAILY MARKET CONTEXT ACTION — GET /api/quote?action=daily-market-context&ticker=BBCA
// Additive read-only action folded into this endpoint (rather than a new
// api/*.js file) to preserve the project's fixed Vercel function count.
// Independent from the Yahoo quote path above; does not touch or reuse the
// quoteCache/boardCache TTL state.
// ============================================================
function normalizeDailyContextTicker(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\.JK$/, '');
}

async function handleDailyMarketContextAction(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  var ticker = normalizeDailyContextTicker(req.query && req.query.ticker);
  if (!ticker || !/^[A-Z]{1,6}$/.test(ticker)) {
    return res.status(400).json({ success: false, error: 'Parameter ticker wajib diisi dan valid.' });
  }

  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ success: false, error: 'Database belum dikonfigurasi.' });
  }

  try {
    var { createClient } = require('@supabase/supabase-js');
    var supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    var context = await dailyContextBuilder.buildContextForTicker(supabase, ticker, {});

    // Add cached 52W context when the additive columns are available.
    // If migration has not been applied yet, keep the existing endpoint alive.
    var cached52w = await supabase
      .from('stock_daily_features')
      .select('high_52w,distance_to_high_52w_pct')
      .eq('ticker', ticker)
      .limit(1);

    if (!cached52w.error && cached52w.data && cached52w.data[0]) {
      context.technical.high_52w = cached52w.data[0].high_52w;
      context.technical.distance_to_high_52w_pct =
        cached52w.data[0].distance_to_high_52w_pct;
    } else {
      context.technical.high_52w = null;
      context.technical.distance_to_high_52w_pct = null;
    }

    return res.status(200).json({ success: true, context: context });
  } catch (error) {
    return res.status(200).json({
      success: false,
      error: 'Gagal memuat konteks pasar harian.',
      diagnostic: error && error.message
    });
  }
}


async function handleDailyMarketContextListAction(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({
      success: false,
      error: 'Database belum dikonfigurasi.'
    });
  }

  try {
    var { createClient } = require('@supabase/supabase-js');
    var supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    var selectWith52w =
      'ticker,as_of_trade_date,last_price,rsi_14,rsi_state,' +
      'high_52w,distance_to_high_52w_pct,' +
      'volume_ratio_vs_7d_avg,foreign_net_today,foreign_net_7d,data_freshness';

    var result = await supabase
      .from('stock_daily_features')
      .select(selectWith52w)
      .order('ticker', { ascending: true })
      .limit(1000);

    // Safe rollout fallback: preview remains usable even before the additive
    // migration is applied. 52W fields simply show N/A until then.
    if (result.error) {
      result = await supabase
        .from('stock_daily_features')
        .select(
          'ticker,as_of_trade_date,last_price,rsi_14,rsi_state,' +
          'volume_ratio_vs_7d_avg,foreign_net_today,foreign_net_7d,data_freshness'
        )
        .order('ticker', { ascending: true })
        .limit(1000);

      if (!result.error) {
        result.data = (result.data || []).map(function(row) {
          return Object.assign({}, row, {
            high_52w: null,
            distance_to_high_52w_pct: null
          });
        });
      }
    }

    if (result.error) {
      throw new Error(result.error.message);
    }

    var rows = result.data || [];
    var latestAsOf = null;

    rows.forEach(function(row) {
      if (row.as_of_trade_date &&
          (!latestAsOf || row.as_of_trade_date > latestAsOf)) {
        latestAsOf = row.as_of_trade_date;
      }
    });

    return res.status(200).json({
      success: true,
      as_of: latestAsOf,
      count: rows.length,
      rows: rows
    });
  } catch (error) {
    return res.status(200).json({
      success: false,
      error: 'Gagal memuat ranking konteks pasar harian.',
      diagnostic: error && error.message
    });
  }
}

module.exports = async function handler(req, res) {
  if (req.query && req.query.action === 'daily-market-context-list') {
    return handleDailyMarketContextListAction(req, res);
  }

  if (req.query && req.query.action === 'daily-market-context') {
    return handleDailyMarketContextAction(req, res);
  }

  var ticker = null;
  try {
    var allowAdvancedEntryAnalysis = hasLoggedInHeaders(req);
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
    // Normalize IHSG aliases to canonical 'IHSG'
    if (ticker === 'JKSE' || ticker === 'JCI' || ticker === 'COMPOSITE') ticker = 'IHSG';
    if (!/^[A-Z]{3,5}$/.test(ticker) && ticker !== 'IHSG') {
      return res.status(400).json({ error: 'Format ticker tidak valid.' });
    }

    // IHSG/Index: skip board data, use ^JKSE for Yahoo
    var isIndex = (ticker === 'IHSG');
    var portfolioPriceOnly = req.query && req.query.portfolio === '1';

    // Run Yahoo quote and Supabase board in parallel first
    var baseResults = await Promise.all([
      fetchYahooQuote(ticker),
      isIndex ? Promise.resolve(makeIndexBoard(ticker)) : fetchBoardData(ticker)
    ]);

    var quoteResult = baseResults[0] ? JSON.parse(JSON.stringify(baseResults[0])) : baseResults[0];
    var boardResult = baseResults[1];

    // A manual Portfolio refresh must not reuse the Yahoo in-memory quote cache.
    // Prefer the same fresh screener latest rows used by Day Trade/Swing displays.
    if (portfolioPriceOnly && !isIndex) {
      var latest = await fetchFreshScreenerLatestPrice(ticker);
      if (latest.price) {
        quoteResult.last = latest.price;
        quoteResult.price_source = latest.price_source;
        quoteResult.price_date = latest.price_date;
        quoteResult.price_age_hours = latest.price_age_hours;
        quoteResult.price_stale = false;
      } else {
        quoteResult.price_stale = true;
        quoteResult.price_diagnostic = latest.diagnostic;
      }
    }

    // Attach board to quote result
    quoteResult.board = boardResult;

    // Fetch news after board is available (uses companyName for better search)
    if (includeNews) {
      var companyName = (boardResult && boardResult.companyName) || null;
      var newsResult = await fetchNewsData(ticker, companyName);
      quoteResult.news = newsResult;
    }

    // === SETUP LABEL CALCULATION (deterministic) ===
    quoteResult.setupLabel = calculateSetupLabel(quoteResult, boardResult);

    // === AUTO-CUAN SCORE CALCULATION (deterministic, server-side) ===
    quoteResult.autoCuanScore = calculateAutoCuanScore(quoteResult, boardResult);

    // === BREAKOUT / BREAKDOWN CONFIRMATION (deterministic) ===
    quoteResult.breakoutConfirmation = calculateBreakoutConfirmation(quoteResult, boardResult);

    // === RISK GUARD (deterministic, conservative risk assessment) ===
    quoteResult.riskGuard = calculateRiskGuard(quoteResult, boardResult);

    // === RESPECT ZONE ANALYSIS (multi-window candle + volume) ===
    if (quoteResult.success && quoteResult._candles && quoteResult._candles.length >= 10) {
      var rzResult = dtEngine.detectRespectZones(quoteResult._candles);
      quoteResult.respectZone = { notes: rzResult.notes || [] };

      // Refined trading plan using respect zones
      var pivot = quoteResult.pivot;
      if (pivot && pivot.support1 && pivot.resistance1) {
        var baseLevels = {
          entry_low: pivot.support1,
          entry_high: Math.round((pivot.pivotPoint + pivot.support1) / 2),
          stop_loss: pivot.support2 || Math.round(pivot.support1 * 0.97),
          tp1: pivot.resistance1,
          tp2: pivot.resistance2 || Math.round(pivot.resistance1 * 1.02),
          risk_reward: null
        };
        // Calculate initial RR
        var midEntry = (baseLevels.entry_low + baseLevels.entry_high) / 2;
        var risk = midEntry - baseLevels.stop_loss;
        if (risk > 0) baseLevels.risk_reward = Math.round(((baseLevels.tp1 - midEntry) / risk) * 100) / 100;

        var refined = dtEngine.refineLevelsWithRespectZones(baseLevels, quoteResult._candles, quoteResult.last, 'analysis');
        if (refined) {
          quoteResult.tradingPlan = {
            entry_1: Math.max(refined.entry_low, refined.entry_high),
            entry_2: Math.min(refined.entry_low, refined.entry_high),
            stop_loss: refined.stop_loss,
            target_1: Math.min(refined.tp1, refined.tp2 || refined.tp1),
            target_2: Math.max(refined.tp1, refined.tp2 || refined.tp1),
            risk_reward: refined.risk_reward,
            refinement_notes: refined.refinement_notes || null,
            respect_zone_notes: refined.respect_zone_notes || null,
            half_candle_level: refined.half_candle_level || null,
            half_candle_label: refined.half_candle_label || null,
            half_candle_note: refined.half_candle_note || null,
            half_candle_chase_risk: refined.half_candle_chase_risk || false,
            respect_quality_score: refined.respect_quality_score,
            respect_quality_label: refined.respect_quality_label || null,
            respect_quality_factors: refined.respect_quality_factors || [],
            respect_invalid_reason: refined.respect_invalid_reason || null,
            bearish_respect_warning: refined.bearish_respect_warning || null
          };
        }
      }

      // BSJP potential (strict conditions)
      if (quoteResult.autoCuanScore && quoteResult.last) {
        var bsjpCheck = {
          daytrade_score: quoteResult.autoCuanScore.score || 0,
          risk_reward: quoteResult.tradingPlan ? quoteResult.tradingPlan.risk_reward : 0,
          status: (quoteResult.setupLabel && quoteResult.setupLabel.status) || '',
          refinement_notes: quoteResult.tradingPlan ? quoteResult.tradingPlan.refinement_notes : ''
        };
        var bsjpAnalysis = { volume_ratio_20d: quoteResult.volumeVsAvg20 || 0, change_pct: quoteResult.priceChange1D || 0, distance_to_breakout_pct: null };
        var bsjpLabel = dtEngine.detectBsjpPotential ? dtEngine.detectBsjpPotential(bsjpCheck, bsjpAnalysis) : null;
        if (bsjpLabel) quoteResult.bsjpLabel = bsjpLabel;
      }
    }

    // Remove internal candles from response (too large)
    delete quoteResult._candles;

    // === V6: RISK LABEL + TICK NORMALIZATION on tradingPlan ===
    if (quoteResult.tradingPlan) {
      var _tp = quoteResult.tradingPlan;
      // Apply IDX tick normalization to trading plan levels
      var _tpTickResult = idxTick.normalizeLevelsToIdxTicks({
        entry_low: Math.min(_tp.entry_1 || 0, _tp.entry_2 || 0),
        entry_high: Math.max(_tp.entry_1 || 0, _tp.entry_2 || 0),
        stop_loss: _tp.stop_loss,
        tp1: _tp.target_1,
        tp2: _tp.target_2,
        risk_reward: _tp.risk_reward
      }, { mode: 'swing' });
      if (_tpTickResult.tick_normalized) {
        _tp.entry_1 = _tpTickResult.entry_high;
        _tp.entry_2 = _tpTickResult.entry_low;
        _tp.stop_loss = _tpTickResult.stop_loss;
        _tp.target_1 = _tpTickResult.tp1;
        _tp.target_2 = _tpTickResult.tp2;
        _tp.risk_reward = _tpTickResult.risk_reward;
      }
      _tp.tick_normalized = _tpTickResult.tick_normalized;

      // Risk label for the trading plan
      var _boardStr = (boardResult && boardResult.board) || null;
      var _riskLbl = idxTick.calculateRiskLabel({
        risk_reward: _tp.risk_reward,
        mode: 'swing',
        volume_ratio_20d: quoteResult.volumeVsAvg20,
        board: _boardStr,
        is_fca: boardResult ? boardResult.isFca : false,
        rsi14: quoteResult.rsi14,
        chase_distance_pct: _tp.entry_1 > 0 ? Math.max(0, ((quoteResult.last - _tp.entry_1) / _tp.entry_1) * 100) : 0
      });
      quoteResult.riskLabel = _riskLbl;
    }

    if (!allowAdvancedEntryAnalysis) redactAdvancedQuoteFields(quoteResult);
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

  // Map ticker to Yahoo Finance symbol
  var symbol;
  if (ticker === 'IHSG') {
    symbol = '%5EJKSE'; // ^JKSE (URL-encoded)
  } else {
    symbol = ticker + '.JK';
  }
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

  // === VOLUME INTELLIGENCE (3D / 7D) ===
  var volumeAvg3 = calcMA(volumeArr, 3);
  var volumeAvg7 = calcMA(volumeArr, 7);
  var volumeVsAvg3 = (volumeAvg3 && volumeAvg3 > 0) ? Math.round((latest.volume / volumeAvg3) * 100) / 100 : null;
  var volumeVsAvg7 = (volumeAvg7 && volumeAvg7 > 0) ? Math.round((latest.volume / volumeAvg7) * 100) / 100 : null;

  // Previous close and price change
  var prevClose = candles.length >= 2 ? candles[candles.length - 2].close : null;
  var priceChange1D = (prevClose != null && prevClose > 0) ? Math.round(((latest.close - prevClose) / prevClose) * 10000) / 100 : null;

  // Volume trend classification
  var volumeTrend = classifyVolumeTrend(volumeArr);

  // Price-volume interpretation
  var priceVolumeReading = interpretPriceVolume(priceChange1D, volumeVsAvg7, latest.close, prevClose);

  var lastPrice = latest.close;
  var priceVsMA = [];
  if (ma20 !== null) priceVsMA.push((lastPrice >= ma20 ? 'above' : 'below') + ' MA20');
  if (ma50 !== null) priceVsMA.push((lastPrice >= ma50 ? 'above' : 'below') + ' MA50');
  if (ma100 !== null) priceVsMA.push((lastPrice >= ma100 ? 'above' : 'below') + ' MA100');
  if (ma200 !== null) priceVsMA.push((lastPrice >= ma200 ? 'above' : 'below') + ' MA200');

  var result = {
    success: true,
    ticker: ticker,
    symbol: ticker === 'IHSG' ? '^JKSE' : symbol,
    isIndex: ticker === 'IHSG',
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
    volumeAvg3: volumeAvg3 ? Math.round(volumeAvg3) : null,
    volumeAvg7: volumeAvg7 ? Math.round(volumeAvg7) : null,
    volumeVsAvg3: volumeVsAvg3,
    volumeVsAvg7: volumeVsAvg7,
    prevClose: prevClose,
    priceChange1D: priceChange1D,
    volumeTrend: volumeTrend,
    priceVolumeReading: priceVolumeReading,
    priceVsMA: priceVsMA.join(', '),
    totalCandles: candles.length,
    note: 'Data Historis T-1'
  };

  // === PIVOT POINT CALCULATION (Classic) from T-1 completed candle ===
  var prevH = latest.high;
  var prevL = latest.low;
  var prevC = latest.close;
  var prevO = latest.open;
  var pivotPoint = idxTick.roundToIdxTick((prevH + prevL + prevC) / 3, 'nearest');
  var ohlcPivot = idxTick.roundToIdxTick((prevO + prevH + prevL + prevC) / 4, 'nearest');
  var range = prevH - prevL;
  var r1 = idxTick.roundToIdxTick((2 * pivotPoint) - prevL, 'up');
  var s1 = idxTick.roundToIdxTick((2 * pivotPoint) - prevH, 'down');
  var r2 = idxTick.roundToIdxTick(pivotPoint + range, 'up');
  var s2 = idxTick.roundToIdxTick(pivotPoint - range, 'down');

  // Post-normalization ordering validation
  if (s1 != null && s2 != null && s2 >= s1) { s2 = s1 - idxTick.getIdxTickSize(s1); }
  if (r1 != null && r2 != null && r2 <= r1) { r2 = r1 + idxTick.getIdxTickSize(r1); }

  result.pivot = {
    pivotPoint: pivotPoint,
    ohlcPivot: ohlcPivot,
    resistance1: r1,
    resistance2: r2,
    support1: s1,
    support2: s2,
    prevOpen: prevO,
    prevHigh: prevH,
    prevLow: prevL,
    prevClose: prevC,
    pivotMethod: 'classic',
    pivotSourceDate: latest.date,
    flatRange: (range === 0 || range < 1),
    tickNormalized: true
  };

  // === FIBONACCI INTELLIGENCE (from OHLCV candles) ===
  result.fibonacci = calculateFibonacciLevels(candles);

  // Store candles for respect zone analysis (will be deleted before response)
  result._candles = candles;

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

// Special board object for index symbols (IHSG etc.)
// Not a stock — no board/FCA/speculative penalties apply.
function makeIndexBoard(ticker) {
  return {
    success: true,
    companyName: ticker === 'IHSG' ? 'Indeks Harga Saham Gabungan' : ticker,
    board: 'INDEX',
    isFca: false,
    isIndex: true,
    minPriceGuard: 0,
    note: 'Indeks pasar — bukan emiten individual',
    source: 'index_special_case'
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
async function fetchNewsData(ticker, companyName) {
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
        var gmResult = await fetchNewsFromGemini(GEMINI_API_KEY, ticker, companyName);
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
        var gmResult2 = await fetchNewsFromGemini(GEMINI_API_KEY, ticker, companyName);
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
        var gmResult3 = await fetchNewsFromGemini(GEMINI_API_KEY, ticker, companyName);
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

// === GEMINI: FETCH NEWS SUMMARY (with Google Search grounding + multi-query) ===
async function fetchNewsFromGemini(apiKey, ticker, companyName) {
  var diag = { configured: true, called: true, groundingEnabled: true, httpStatus: null, ok: false, finishReason: null, wasTruncated: false, maxOutputTokensUsed: 4096, rawTextLength: 0, rawTextPreview: '', hasGroundingMetadata: false, groundingChunkCount: 0, parsedJson: false, parsedFrom: null, parseFailureReason: null, salvageAttempted: false, salvageSuccess: false, salvageReason: null, queryVariantsUsed: [], itemCountRaw: 0, itemCountValid: 0, errorType: null, reason: '' };

  // Build search context with multiple query variants for better coverage
  var searchContext = ticker + '.JK saham IDX';
  if (companyName) searchContext += ', ' + companyName;

  var queryVariants = [
    ticker + ' berita saham terbaru',
    ticker + ' katalis ' + ticker + '.JK',
    ticker + ' keterbukaan informasi IDX',
    ticker + ' laporan keuangan',
    ticker + ' aksi korporasi BEI',
    ticker + ' IDX news',
    ticker + '.JK news'
  ];
  if (companyName) {
    var shortName = companyName.replace(/\s*Tbk\.?/i, '').trim();
    queryVariants.push(shortName + ' IDX berita');
    queryVariants.push(shortName + ' saham keterbukaan informasi');
    queryVariants.push(shortName + ' laporan keuangan');
  }
  diag.queryVariantsUsed = queryVariants;

  // Compact prompt — force short output to avoid MAX_TOKENS truncation
  var prompt = 'Search: ' + searchContext + '. Queries: ' + queryVariants.slice(0, 5).join(', ') + '.\n\n' +
    'Return JSON array only. No markdown. No explanation. No code fence. Max 2 items.\n' +
    '[{"date":"YYYY-MM-DD","title":"max 80 chars","source":"media","url":"url or null","summary":"max 15 words Indonesian","possibleImpact":"positive|negative|neutral|mixed"}]\n' +
    'If no news: []. Title max 80 chars. Summary max 15 words.';

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 4096
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

    // Capture finish reason
    diag.finishReason = candidates[0].finishReason || null;
    diag.wasTruncated = (diag.finishReason === 'MAX_TOKENS');

    // Check for grounding metadata
    var groundingMeta = candidates[0].groundingMetadata || null;
    if (groundingMeta) {
      diag.hasGroundingMetadata = true;
      var gChunks = groundingMeta.groundingChunks || groundingMeta.searchEntryPoint && [] || [];
      diag.groundingChunkCount = gChunks.length;
    }
    // Also check citationMetadata
    var citationMeta = candidates[0].citationMetadata || null;

    // Concatenate all text parts from response
    var textParts = [];
    var parts = (candidates[0].content && candidates[0].content.parts) || [];
    for (var pi = 0; pi < parts.length; pi++) {
      if (parts[pi].text) textParts.push(parts[pi].text);
    }
    var text = textParts.join('');
    diag.rawTextLength = text.length;
    diag.rawTextPreview = text.slice(0, 240);

    // Clean markdown code fences globally
    var cleaned = text.replace(/```json/gi, '').replace(/```/gi, '').trim();

    // Detect "no news" plain text responses
    var noNewsPatterns = /tidak ada berita|tidak ditemukan|no relevant|no news|no significant|belum ada|tidak tersedia|empty array|\[\s*\]/i;
    if (cleaned.length < 100 && noNewsPatterns.test(cleaned)) {
      diag.errorType = 'no_news_text';
      diag.reason = 'provider says no relevant news';
      diag.parsedFrom = 'plain_unavailable';
      return { items: [], _diag: diag };
    }

    // Strategy 1: Try extracting JSON array (greedy — handles truncation better)
    var parsed = null;
    var jsonArrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (jsonArrayMatch) {
      try {
        parsed = JSON.parse(jsonArrayMatch[0]);
        if (Array.isArray(parsed)) { diag.parsedFrom = 'json_array'; }
        else { parsed = null; }
      } catch (e) {
        // JSON might be truncated — try salvage
        diag.salvageAttempted = true;
        parsed = salvageTruncatedJsonArray(jsonArrayMatch[0], ticker);
        if (parsed && parsed.length > 0) { diag.parsedFrom = 'salvage_truncated'; diag.salvageSuccess = true; diag.salvageReason = 'extracted from truncated array'; }
      }
    }

    // Strategy 2: Try JSON object with items/news/data/results
    if (!parsed) {
      var jsonObjMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonObjMatch) {
        try {
          var obj = JSON.parse(jsonObjMatch[0]);
          if (obj && Array.isArray(obj.items)) { parsed = obj.items; diag.parsedFrom = 'json_object_items'; }
          else if (obj && Array.isArray(obj.news)) { parsed = obj.news; diag.parsedFrom = 'json_object_news'; }
          else if (obj && Array.isArray(obj.data)) { parsed = obj.data; diag.parsedFrom = 'json_object_data'; }
          else if (obj && Array.isArray(obj.results)) { parsed = obj.results; diag.parsedFrom = 'json_object_results'; }
        } catch (e) { /* not valid JSON object */ }
      }
    }

    // Strategy 3: Parse entire cleaned text
    if (!parsed) {
      try {
        var full = JSON.parse(cleaned);
        if (Array.isArray(full)) { parsed = full; diag.parsedFrom = 'full_json'; }
        else if (full && Array.isArray(full.items)) { parsed = full.items; diag.parsedFrom = 'full_json_items'; }
      } catch (e) { /* not valid JSON */ }
    }

    // Strategy 4: Salvage fields from text (regex extraction — especially for MAX_TOKENS truncation)
    if (!parsed) {
      diag.salvageAttempted = true;
      parsed = salvageFieldsFromText(cleaned, ticker);
      if (parsed && parsed.length > 0) { diag.parsedFrom = 'salvage_fields'; diag.salvageSuccess = true; diag.salvageReason = diag.wasTruncated ? 'MAX_TOKENS truncation recovery' : 'regex field extraction'; }
    }

    // Strategy 5: Extract from grounding metadata
    if ((!parsed || parsed.length === 0) && groundingMeta) {
      var metaChunks = groundingMeta.groundingChunks || [];
      var supports = groundingMeta.groundingSupports || [];
      var groundingItems = [];

      for (var gi = 0; gi < metaChunks.length && groundingItems.length < 2; gi++) {
        var chunk = metaChunks[gi];
        var web = chunk.web || chunk;
        if (web.title || web.uri) {
          var supportText = '';
          // Try to find matching support text
          for (var si = 0; si < supports.length && !supportText; si++) {
            var seg = supports[si];
            if (seg.segment && seg.segment.text) supportText = seg.segment.text;
          }
          groundingItems.push({
            date: null,
            title: (web.title || 'News ' + ticker).slice(0, 200),
            source: web.uri ? web.uri.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : null,
            url: web.uri || null,
            summary: supportText || web.title || ('Berita terkait ' + ticker),
            possibleImpact: 'neutral'
          });
        }
      }
      if (groundingItems.length > 0) {
        parsed = groundingItems;
        diag.parsedFrom = 'grounding_metadata';
      }
    }

    // No parseable content
    if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
      if (noNewsPatterns.test(cleaned)) {
        diag.errorType = 'no_news_text';
        diag.reason = 'provider says no relevant news (in longer text)';
        diag.parsedFrom = 'plain_unavailable';
      } else {
        diag.errorType = 'parse_error';
        diag.parseFailureReason = 'no JSON array/object/salvageable content found';
        diag.reason = 'parse_failed';
        diag.parsedFrom = 'failed';
      }
      return { items: [], _diag: diag };
    }

    diag.parsedJson = true;
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

// === SALVAGE: Try to parse truncated JSON array ===
function salvageTruncatedJsonArray(text, ticker) {
  var items = [];

  // Strategy A: Find complete JSON objects {key:val, key:val}
  var objMatches = text.match(/\{[^{}]*\}/g);
  if (objMatches) {
    for (var i = 0; i < objMatches.length && items.length < 2; i++) {
      try {
        var item = JSON.parse(objMatches[i]);
        if (item && item.title) items.push(item);
      } catch (e) { /* skip malformed */ }
    }
  }

  // Strategy B: If no complete objects, try to extract fields from truncated text
  if (items.length === 0) {
    var dateMatch = text.match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
    var titleMatch = text.match(/"title"\s*:\s*"([^"]{5,}?)"/);
    var sourceMatch = text.match(/"source"\s*:\s*"([^"]{2,}?)"/);
    var summaryMatch = text.match(/"summary"\s*:\s*"([^"]{5,}?)"/);
    var urlMatch = text.match(/"url"\s*:\s*"(https?:\/\/[^"]*?)"/);
    var impactMatch = text.match(/"possibleImpact"\s*:\s*"(positive|negative|neutral|mixed)"/);

    if (titleMatch && sourceMatch) {
      items.push({
        date: dateMatch ? dateMatch[1] : null,
        title: titleMatch[1].slice(0, 200),
        source: sourceMatch[1].slice(0, 100),
        url: (urlMatch && urlMatch[1].length < 300 && !urlMatch[1].includes('vertexaisearch.cloud.google')) ? urlMatch[1] : null,
        summary: summaryMatch ? summaryMatch[1].slice(0, 300) : ('Berita terkait ' + (ticker || 'saham') + ': ' + titleMatch[1].slice(0, 60)),
        possibleImpact: impactMatch ? impactMatch[1] : 'neutral'
      });
    }
  }

  return items.length > 0 ? items : null;
}

// === SALVAGE: Extract news fields from plain text ===
function salvageFieldsFromText(text, ticker) {
  var items = [];

  // Try regex for JSON-like field patterns (handles truncated/malformed JSON)
  var dateMatch = text.match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
  var titleMatch = text.match(/"title"\s*:\s*"([^"]{5,}?)"/i);
  var sourceMatch = text.match(/"source"\s*:\s*"([^"]{2,}?)"/i);
  var summaryMatch = text.match(/"summary"\s*:\s*"([^"]{5,}?)"/i);
  var urlMatch = text.match(/"url"\s*:\s*"(https?:\/\/[^"]*?)"/i);
  var impactMatch = text.match(/"possibleImpact"\s*:\s*"(positive|negative|neutral|mixed)"/i) || text.match(/"impact"\s*:\s*"(positive|negative|neutral|mixed)"/i);

  // Need at least title + source to salvage
  if (titleMatch && sourceMatch) {
    var cleanUrl = (urlMatch && urlMatch[1].length < 300 && !urlMatch[1].includes('vertexaisearch.cloud.google')) ? urlMatch[1] : null;
    items.push({
      date: dateMatch ? dateMatch[1] : null,
      title: titleMatch[1].slice(0, 200),
      source: sourceMatch[1].slice(0, 100),
      url: cleanUrl,
      summary: summaryMatch ? summaryMatch[1].slice(0, 300) : ('Berita terkait ' + (ticker || 'saham') + ': ' + titleMatch[1].slice(0, 60)),
      possibleImpact: impactMatch ? impactMatch[1] : 'neutral'
    });

    // Try to find a second item (look for second occurrence)
    var remaining = text.substring(text.indexOf(titleMatch[0]) + titleMatch[0].length);
    var title2 = remaining.match(/"title"\s*:\s*"([^"]{5,}?)"/i);
    var source2 = remaining.match(/"source"\s*:\s*"([^"]{2,}?)"/i);
    if (title2 && source2 && title2[1] !== titleMatch[1]) {
      var date2 = remaining.match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
      var summary2 = remaining.match(/"summary"\s*:\s*"([^"]{5,}?)"/i);
      var impact2 = remaining.match(/"possibleImpact"\s*:\s*"(positive|negative|neutral|mixed)"/i);
      items.push({
        date: date2 ? date2[1] : null,
        title: title2[1].slice(0, 200),
        source: source2[1].slice(0, 100),
        url: null,
        summary: summary2 ? summary2[1].slice(0, 300) : ('Berita terkait ' + (ticker || 'saham') + ': ' + title2[1].slice(0, 60)),
        possibleImpact: impact2 ? impact2[1] : 'neutral'
      });
    }
  }

  return items.length > 0 ? items : null;
}

// === SHARED NEWS VALIDATION + LIMIT ===
function validateAndLimitNews(parsed) {
  if (!Array.isArray(parsed)) return [];
  var valid = [];
  for (var i = 0; i < parsed.length && valid.length < 2; i++) {
    var item = parsed[i];
    if (item && item.title && item.summary) {
      var impactVal = item.possibleImpact || item.impact || 'neutral';
      valid.push({
        date: item.date || null,
        title: String(item.title).slice(0, 200),
        source: item.source || null,
        url: item.url || null,
        summary: String(item.summary).slice(0, 300),
        possibleImpact: ['positive', 'negative', 'neutral', 'mixed'].indexOf(impactVal) >= 0 ? impactVal : 'neutral'
      });
    }
  }
  return valid;
}

// ===== CALCULATION HELPERS =====
function roundPrice(val) {
  if (val == null || isNaN(val)) return null;
  return Math.round(val);
}

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


// ===== SETUP LABEL CALCULATOR (deterministic) =====
function calculateSetupLabel(quote, board) {
  if (!quote || !quote.success) {
    return { status: null, confidence: 'low', reasons: ['Data quote tidak tersedia'], validIf: '-', invalidIf: '-', flags: ['no_data'] };
  }

  var price = quote.last;
  var ma20 = quote.ma20;
  var ma50 = quote.ma50;
  var ma100 = quote.ma100;
  var ma200 = quote.ma200;
  var rsi = quote.rsi14;
  var volVsAvg = quote.volumeVsAvg20;
  var pivot = quote.pivot;
  var r1 = pivot ? pivot.resistance1 : null;
  var r2 = pivot ? pivot.resistance2 : null;
  var s1 = pivot ? pivot.support1 : null;
  var s2 = pivot ? pivot.support2 : null;
  var pivotPoint = pivot ? pivot.pivotPoint : null;
  var flatRange = pivot ? pivot.flatRange : false;

  // Board risk assessment
  var boardRisk = 'normal';
  if (board && board.success) {
    var b = board.board;
    if (b === 'PEMANTAUAN_KHUSUS' || board.isFca) boardRisk = 'high';
    else if (b === 'AKSELERASI') boardRisk = 'elevated';
  }

  // Helper: check if price is below a MA (null-safe)
  function belowMA(maVal) { return maVal != null && price < maVal; }
  function aboveMA(maVal) { return maVal != null && price >= maVal; }
  function nearLevel(level, tolerancePct) {
    if (level == null || level === 0) return false;
    var diff = Math.abs(price - level) / level;
    return diff <= (tolerancePct || 0.02); // default 2%
  }

  // Count how many MAs price is below
  var masBelow = 0;
  var masTotal = 0;
  if (ma20 != null) { masTotal++; if (belowMA(ma20)) masBelow++; }
  if (ma50 != null) { masTotal++; if (belowMA(ma50)) masBelow++; }
  if (ma100 != null) { masTotal++; if (belowMA(ma100)) masBelow++; }
  if (ma200 != null) { masTotal++; if (belowMA(ma200)) masBelow++; }

  var reasons = [];
  var flags = [];
  var confidence = 'medium';

  // === PRIORITY 1: Avoid Dulu ===
  // High board risk overrides everything
  if (boardRisk === 'high') {
    reasons.push('Board: Pemantauan Khusus / FCA');
    flags.push('high_board_risk');
    return {
      status: 'Avoid Dulu',
      confidence: 'high',
      reasons: reasons,
      validIf: 'Keluar dari Papan Pemantauan Khusus dan teknikal membaik',
      invalidIf: 'Tetap di papan pemantauan / likuiditas memburuk',
      flags: flags
    };
  }

  // All MAs below + RSI weak
  if (masTotal >= 3 && masBelow >= masTotal && rsi != null && rsi < 40) {
    reasons.push('Price di bawah semua MA utama');
    reasons.push('RSI ' + rsi + ' (bearish)');
    if (volVsAvg != null && volVsAvg < 1.0) reasons.push('Volume lemah (' + volVsAvg + 'x avg)');
    flags.push('below_all_ma', 'rsi_weak');
    return {
      status: 'Avoid Dulu',
      confidence: 'high',
      reasons: reasons,
      validIf: 'RSI > 50 dan price kembali above MA20',
      invalidIf: 'Breakdown lebih dalam / RSI terus turun',
      flags: flags
    };
  }

  // === PRIORITY 2: Bearish Continuation ===
  if (masBelow >= 2 && belowMA(ma20) && belowMA(ma50)) {
    var bearishSignals = 0;
    if (rsi != null && rsi < 45) bearishSignals++;
    if (pivotPoint != null && price < pivotPoint) bearishSignals++;
    if (s1 != null && price < s1) bearishSignals++;
    if (volVsAvg != null && volVsAvg >= 1.0) bearishSignals++; // volume on decline = selling pressure

    if (bearishSignals >= 2) {
      reasons.push('Price di bawah MA20 dan MA50');
      if (rsi != null && rsi < 45) reasons.push('RSI ' + rsi + ' (lemah)');
      if (pivotPoint != null && price < pivotPoint) reasons.push('Price di bawah pivot');
      if (s1 != null && price < s1) reasons.push('Breakdown di bawah S1');
      flags.push('bearish_continuation');
      return {
        status: 'Bearish Continuation',
        confidence: bearishSignals >= 3 ? 'high' : 'medium',
        reasons: reasons,
        validIf: 'Price kembali above MA20 dan RSI > 50',
        invalidIf: 'Terus breakdown di bawah S2 / volume jual makin besar',
        flags: flags
      };
    }
  }

  // === PRIORITY 3: High Risk Speculative ===
  if (boardRisk === 'elevated') {
    reasons.push('Board: Akselerasi (risiko tinggi)');
    flags.push('elevated_board_risk');
    var hasNews = !!(quote.news && quote.news.success && quote.news.items && quote.news.items.length > 0);
    if (hasNews) {
      reasons.push('Ada katalis/news tapi teknikal belum terkonfirmasi');
      flags.push('has_catalyst');
    }
    return {
      status: 'High Risk Speculative',
      confidence: 'medium',
      reasons: reasons,
      validIf: 'Teknikal breakout confirmed dan volume meningkat',
      invalidIf: 'Gagal sustain di atas MA20 / volume kering',
      flags: flags
    };
  }

  // Low price stock with high volatility
  if (price != null && price <= 100 && masBelow >= 2) {
    reasons.push('Harga sangat rendah (Rp ' + price + ')');
    reasons.push('Volatilitas tinggi, risiko likuiditas');
    flags.push('low_price_stock');
    return {
      status: 'High Risk Speculative',
      confidence: 'medium',
      reasons: reasons,
      validIf: 'Volume meningkat signifikan dan price above MA20',
      invalidIf: 'Volume kering / terus sideways di harga rendah',
      flags: flags
    };
  }

  // === PRIORITY 4: Breakout Watch ===
  if (aboveMA(ma20) && rsi != null && rsi >= 50 && rsi <= 70 && volVsAvg != null && volVsAvg >= 1.2) {
    var nearR1 = nearLevel(r1, 0.03);
    var nearR2 = nearLevel(r2, 0.03);
    var aboveR1 = r1 != null && price >= r1;

    if (nearR1 || nearR2 || aboveR1) {
      reasons.push('Price di atas MA20 dan dekat/above R1');
      reasons.push('RSI ' + rsi + ' (bullish momentum)');
      reasons.push('Volume ' + volVsAvg + 'x avg (di atas rata-rata)');
      flags.push('breakout_watch', 'volume_confirm');
      return {
        status: 'Breakout Watch',
        confidence: boardRisk === 'normal' ? 'high' : 'medium',
        reasons: reasons,
        validIf: 'Close di atas R1 dengan volume > 1.5x avg',
        invalidIf: 'Rejection di R1 / volume turun drastis',
        flags: flags
      };
    }

    // Above MA20 with good volume/RSI but not near resistance yet
    reasons.push('Price di atas MA20');
    reasons.push('RSI ' + rsi + ' (bullish)');
    reasons.push('Volume ' + volVsAvg + 'x avg');
    flags.push('breakout_watch');
    return {
      status: 'Breakout Watch',
      confidence: 'medium',
      reasons: reasons,
      validIf: 'Approach R1/R2 dengan volume sustained',
      invalidIf: 'Price kembali di bawah MA20 / volume menurun',
      flags: flags
    };
  }

  // === PRIORITY 5: Rebound Watch ===
  if (rsi != null && rsi >= 35 && rsi <= 50) {
    var nearSupport = nearLevel(s1, 0.03) || nearLevel(s2, 0.03) || nearLevel(ma20, 0.03) || nearLevel(ma50, 0.03);
    var notAllBelow = masBelow < masTotal; // at least one MA still above

    if (nearSupport && notAllBelow) {
      reasons.push('Price dekat area support (S1/S2/MA)');
      reasons.push('RSI ' + rsi + ' (potensi rebound zone)');
      if (volVsAvg != null && volVsAvg >= 0.8) reasons.push('Volume cukup (' + volVsAvg + 'x avg)');
      flags.push('rebound_watch');
      return {
        status: 'Rebound Watch',
        confidence: nearLevel(s1, 0.02) || nearLevel(ma20, 0.02) ? 'medium' : 'low',
        reasons: reasons,
        validIf: 'Bounce dari support + RSI naik di atas 50 + volume meningkat',
        invalidIf: 'Breakdown di bawah S2 / RSI terus turun di bawah 30',
        flags: flags
      };
    }
  }

  // === PRIORITY 6: Speculative Watch ===
  var hasNewsCatalyst = !!(quote.news && quote.news.success && quote.news.items && quote.news.items.length > 0);
  if (hasNewsCatalyst && volVsAvg != null && volVsAvg >= 1.0) {
    var trendWeak = (rsi == null || rsi < 50) || belowMA(ma20);
    if (trendWeak) {
      reasons.push('Ada katalis/news');
      reasons.push('Volume aktif (' + volVsAvg + 'x avg)');
      reasons.push('Tapi konfirmasi trend belum kuat (RSI/MA belum bullish)');
      flags.push('speculative_watch', 'has_catalyst');
      return {
        status: 'Speculative Watch',
        confidence: 'low',
        reasons: reasons,
        validIf: 'Price above MA20 + RSI > 50 + volume sustained',
        invalidIf: 'News tidak ada follow-up / price gagal sustain',
        flags: flags
      };
    }
  }

  // === PRIORITY 7: Sideways / No Trade (default fallback) ===
  reasons.push('Price dalam range antara support dan resistance');
  if (volVsAvg != null && volVsAvg < 1.0) reasons.push('Volume lemah (' + volVsAvg + 'x avg)');
  if (rsi != null && rsi >= 45 && rsi <= 55) reasons.push('RSI ' + rsi + ' (netral)');
  if (!hasNewsCatalyst) reasons.push('Tidak ada katalis jelas');
  flags.push('sideways');

  // Adjust confidence
  if (flatRange) {
    confidence = 'low';
    flags.push('flat_range');
    reasons.push('Range T-1 flat, pivot kurang informatif');
  }

  return {
    status: 'Sideways / No Trade',
    confidence: confidence,
    reasons: reasons,
    validIf: 'Breakout di atas R1 atau breakdown di bawah S1 dengan volume',
    invalidIf: 'Tetap sideways tanpa katalis baru',
    flags: flags
  };
}


// ===== AUTO-CUAN SCORE CALCULATOR (deterministic, server-side) =====
function calculateAutoCuanScore(quote, board) {
  if (!quote || !quote.success) {
    return { score: 0, grade: 'E', confidence: 'low', components: { trend: 0, momentum: 0, volume: 0, pivot: 0, catalyst: 0, risk: 0 }, reasons: ['Data quote tidak tersedia'], warnings: ['no_data'] };
  }

  var price = quote.last;
  var ma20 = quote.ma20;
  var ma50 = quote.ma50;
  var ma100 = quote.ma100;
  var ma200 = quote.ma200;
  var rsi = quote.rsi14;
  var volVsAvg = quote.volumeVsAvg20;
  var pivot = quote.pivot;
  var r1 = pivot ? pivot.resistance1 : null;
  var s1 = pivot ? pivot.support1 : null;
  var s2 = pivot ? pivot.support2 : null;
  var pivotPoint = pivot ? pivot.pivotPoint : null;
  var flatRange = pivot ? pivot.flatRange : false;
  var isGreenCandle = price >= quote.open;

  var reasons = [];
  var warnings = [];
  var confidence = 'medium';

  // === TREND COMPONENT (0-25) ===
  var trend = 0;
  if (ma20 != null && price >= ma20) { trend += 7; }
  if (ma50 != null && price >= ma50) { trend += 6; }
  if (ma100 != null && price >= ma100) { trend += 6; }
  if (ma200 != null && price >= ma200) { trend += 6; }

  // Track MA count for confidence
  var maCount = 0;
  if (ma20 != null) maCount++;
  if (ma50 != null) maCount++;
  if (ma100 != null) maCount++;
  if (ma200 != null) maCount++;

  if (maCount === 0) {
    trend = 10; // neutral if no MA data
    warnings.push('MA data tidak lengkap');
  } else if (trend === 0) {
    reasons.push('Trend bearish: price below semua MA');
  } else if (trend >= 20) {
    reasons.push('Trend bullish: price above MA utama');
  } else {
    reasons.push('Trend mixed');
  }

  // === MOMENTUM COMPONENT (0-20) ===
  var momentum = 0;
  if (rsi != null) {
    if (rsi >= 55 && rsi <= 65) { momentum = 18; reasons.push('RSI ' + rsi + ' bullish momentum'); }
    else if (rsi > 65 && rsi <= 70) { momentum = 15; reasons.push('RSI ' + rsi + ' kuat tapi mendekati overbought'); }
    else if (rsi >= 50 && rsi < 55) { momentum = 13; reasons.push('RSI ' + rsi + ' netral-positif'); }
    else if (rsi >= 45 && rsi < 50) { momentum = 10; reasons.push('RSI ' + rsi + ' netral'); }
    else if (rsi >= 35 && rsi < 45) { momentum = 7; reasons.push('RSI ' + rsi + ' lemah'); }
    else if (rsi > 70 && rsi <= 80) { momentum = 10; reasons.push('RSI ' + rsi + ' overbought risk'); warnings.push('RSI overbought'); }
    else if (rsi > 80) { momentum = 6; reasons.push('RSI ' + rsi + ' extreme overbought'); warnings.push('RSI extreme overbought'); }
    else if (rsi < 35 && rsi >= 25) { momentum = 5; reasons.push('RSI ' + rsi + ' oversold belum confirm reversal'); }
    else if (rsi < 25) { momentum = 3; reasons.push('RSI ' + rsi + ' deeply oversold'); warnings.push('RSI deeply oversold'); }
    else { momentum = 10; }
  } else {
    momentum = 8;
    warnings.push('RSI tidak tersedia');
  }

  // === VOLUME COMPONENT (0-20) ===
  var volume = 0;
  if (volVsAvg != null) {
    if (volVsAvg >= 1.5 && isGreenCandle) { volume = 20; reasons.push('Volume sangat tinggi + green (' + volVsAvg + 'x)'); }
    else if (volVsAvg >= 1.2 && isGreenCandle) { volume = 16; reasons.push('Volume di atas avg + green (' + volVsAvg + 'x)'); }
    else if (volVsAvg >= 1.5 && !isGreenCandle) { volume = 6; reasons.push('Volume tinggi tapi red candle (' + volVsAvg + 'x) — tekanan jual'); warnings.push('Volume tinggi + red candle'); }
    else if (volVsAvg >= 1.2 && !isGreenCandle) { volume = 8; reasons.push('Volume cukup tapi red candle (' + volVsAvg + 'x)'); }
    else if (volVsAvg >= 0.8 && volVsAvg < 1.2) { volume = 12; reasons.push('Volume normal (' + volVsAvg + 'x)'); }
    else if (volVsAvg >= 0.5 && volVsAvg < 0.8) { volume = 7; reasons.push('Volume di bawah rata-rata (' + volVsAvg + 'x)'); }
    else if (volVsAvg < 0.5) { volume = 3; reasons.push('Volume sangat lemah (' + volVsAvg + 'x)'); warnings.push('Likuiditas rendah'); }
    else { volume = 10; }
  } else {
    volume = 8;
    warnings.push('Volume data tidak lengkap');
  }

  // === PIVOT COMPONENT (0-15) ===
  var pivotScore = 0;
  if (pivotPoint != null && !flatRange) {
    if (price >= pivotPoint) { pivotScore += 5; }
    if (r1 != null && price >= r1) { pivotScore += 5; reasons.push('Price di atas R1'); }
    else if (r1 != null && price >= pivotPoint) { pivotScore += 3; }
    if (s1 != null && price < s1) { pivotScore = Math.max(0, pivotScore - 3); warnings.push('Price di bawah S1'); }
    if (s2 != null && price < s2) { pivotScore = 0; warnings.push('Price di bawah S2'); }

    // Bonus for being near support with positive momentum
    if (s1 != null && Math.abs(price - s1) / s1 <= 0.02 && rsi != null && rsi >= 40) {
      pivotScore += 3;
    }
    pivotScore = Math.min(15, pivotScore);
  } else if (flatRange) {
    pivotScore = 5; // reduced confidence
    warnings.push('Pivot range flat, level kurang informatif');
  } else {
    pivotScore = 7; // neutral if no pivot
  }

  // === CATALYST COMPONENT (0-10) ===
  var catalyst = 0;
  var newsData = quote.news;
  if (newsData && newsData.success && newsData.items && newsData.items.length > 0) {
    var positiveCount = 0;
    var negativeCount = 0;
    for (var i = 0; i < newsData.items.length; i++) {
      var impact = newsData.items[i].possibleImpact || newsData.items[i].impact || 'neutral';
      if (impact === 'positive') positiveCount++;
      else if (impact === 'negative') negativeCount++;
    }
    if (positiveCount > 0 && negativeCount === 0) { catalyst = 9; reasons.push('Katalis positif'); }
    else if (negativeCount > 0 && positiveCount === 0) { catalyst = 1; reasons.push('Katalis negatif'); warnings.push('News negatif'); }
    else if (positiveCount > 0 && negativeCount > 0) { catalyst = 5; reasons.push('Katalis mixed'); }
    else { catalyst = 4; } // neutral news
  } else {
    catalyst = 3; // no news = slightly below neutral, do not penalize heavily
  }

  // === RISK PENALTY (0 to -30) ===
  var risk = 0;
  if (board && board.success) {
    var b = board.board;
    if (b === 'PEMANTAUAN_KHUSUS' || board.isFca) {
      risk -= 25;
      warnings.push('Papan Pemantauan Khusus / FCA');
    } else if (b === 'AKSELERASI') {
      risk -= 12;
      warnings.push('Papan Akselerasi — likuiditas ketat');
    } else if (b === 'UNKNOWN') {
      risk -= 5;
    }
    // UTAMA, PENGEMBANGAN, EKONOMI_BARU = no penalty
  }
  // Low price penalty
  if (price != null && price <= 50) { risk -= 8; warnings.push('Harga sangat rendah'); }
  else if (price != null && price <= 100) { risk -= 4; warnings.push('Harga rendah'); }
  // Extreme RSI penalty (already captured in momentum but add risk warning)
  if (rsi != null && rsi > 80) { risk -= 5; }
  if (rsi != null && rsi < 25) { risk -= 5; }
  // Very weak volume penalty
  if (volVsAvg != null && volVsAvg < 0.3) { risk -= 5; }

  risk = Math.max(-30, risk);

  // === TOTAL SCORE ===
  var rawScore = trend + momentum + volume + pivotScore + catalyst + risk;
  var score = Math.max(0, Math.min(100, rawScore));

  // === GRADE ===
  var grade;
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'E';

  // === CONFIDENCE ===
  if (maCount < 2 || rsi == null || volVsAvg == null) confidence = 'low';
  else if (maCount >= 3 && rsi != null && volVsAvg != null && !flatRange) confidence = 'high';
  else confidence = 'medium';

  return {
    score: score,
    grade: grade,
    confidence: confidence,
    components: {
      trend: trend,
      momentum: momentum,
      volume: volume,
      pivot: pivotScore,
      catalyst: catalyst,
      risk: risk
    },
    reasons: reasons.slice(0, 5),
    warnings: warnings.slice(0, 4)
  };
}


// ===== BREAKOUT / BREAKDOWN CONFIRMATION (deterministic) =====
function calculateBreakoutConfirmation(quote, board) {
  if (!quote || !quote.success) {
    return { status: null, confidence: 'low', breakoutLevel: null, breakdownLevel: null, validIf: '-', invalidIf: '-', reasons: ['Data quote tidak tersedia'], warnings: ['no_data'], flags: ['no_data'] };
  }

  var price = quote.last;
  var open = quote.open;
  var ma20 = quote.ma20;
  var ma50 = quote.ma50;
  var rsi = quote.rsi14;
  var volVsAvg = quote.volumeVsAvg20;
  var pivot = quote.pivot;
  var r1 = pivot ? pivot.resistance1 : null;
  var r2 = pivot ? pivot.resistance2 : null;
  var s1 = pivot ? pivot.support1 : null;
  var s2 = pivot ? pivot.support2 : null;
  var pivotPoint = pivot ? pivot.pivotPoint : null;
  var flatRange = pivot ? pivot.flatRange : false;
  var isGreenCandle = price >= open;

  // Board risk
  var boardRisk = 'normal';
  if (board && board.success) {
    if (board.board === 'PEMANTAUAN_KHUSUS' || board.isFca) boardRisk = 'high';
    else if (board.board === 'AKSELERASI') boardRisk = 'elevated';
  }

  var reasons = [];
  var warnings = [];
  var flags = [];
  var confidence = 'medium';

  // Determine breakout and breakdown levels
  var breakoutLevel = r1;
  var breakdownLevel = s1 || pivotPoint;

  // If R1 is already breached, use R2 as next breakout target
  if (r1 != null && price > r1 && r2 != null) {
    breakoutLevel = r2;
  }
  // If S1 is already breached, use S2 as next breakdown level
  if (s1 != null && price < s1 && s2 != null) {
    breakdownLevel = s2;
  }

  // Helper: near a level (within tolerance %)
  function nearLevel(level, pct) {
    if (level == null || level === 0) return false;
    return Math.abs(price - level) / level <= (pct || 0.02);
  }

  // === PRIORITY 1: Confirmed Breakout ===
  if (r1 != null && price > r1 && volVsAvg != null && volVsAvg >= 1.5 && rsi != null && rsi >= 50 && rsi <= 70 && ma20 != null && price > ma20 && boardRisk !== 'high') {
    reasons.push('Price breakout di atas R1 (' + r1 + ')');
    reasons.push('Volume kuat ' + volVsAvg + 'x avg');
    reasons.push('RSI ' + rsi + ' (bullish tanpa extreme)');
    if (price > ma20) reasons.push('Price di atas MA20');
    flags.push('confirmed_breakout', 'volume_confirm');
    confidence = volVsAvg >= 2.0 ? 'high' : 'medium';

    return {
      status: 'Confirmed Breakout',
      confidence: confidence,
      breakoutLevel: breakoutLevel,
      breakdownLevel: breakdownLevel,
      validIf: 'Sustain di atas ' + r1 + ' pada close berikutnya dengan volume tetap tinggi',
      invalidIf: 'Kembali di bawah ' + r1 + ' (false breakout) atau volume drop drastis',
      reasons: reasons,
      warnings: warnings,
      flags: flags
    };
  }

  // === PRIORITY 2: Breakout Watch ===
  if (ma20 != null && price >= ma20 && rsi != null && rsi >= 48 && rsi <= 70 && volVsAvg != null && volVsAvg >= 1.2 && boardRisk !== 'high') {
    var nearR1 = nearLevel(r1, 0.03);
    var aboveR1 = r1 != null && price > r1;

    if (nearR1 || aboveR1) {
      reasons.push('Price mendekati/di atas R1 (' + r1 + ')');
    } else {
      reasons.push('Price di atas MA20, momentum naik');
    }
    reasons.push('Volume ' + volVsAvg + 'x avg');
    reasons.push('RSI ' + rsi);
    flags.push('breakout_watch');

    // Not yet confirmed because volume < 1.5 or other condition not met
    if (aboveR1 && volVsAvg < 1.5) {
      warnings.push('Volume belum cukup kuat untuk konfirmasi penuh');
    }

    return {
      status: 'Breakout Watch',
      confidence: nearR1 || aboveR1 ? 'medium' : 'low',
      breakoutLevel: breakoutLevel,
      breakdownLevel: breakdownLevel,
      validIf: 'Close di atas ' + (r1 || 'resistance') + ' dengan volume > 1.5x avg',
      invalidIf: 'Rejection di resistance / gagal sustain di atas MA20',
      reasons: reasons,
      warnings: warnings,
      flags: flags
    };
  }

  // === PRIORITY 3: Rejection Risk ===
  if (r1 != null && nearLevel(r1, 0.03)) {
    var rejectionSignals = 0;
    if (volVsAvg != null && volVsAvg < 1.0) rejectionSignals++;
    if (!isGreenCandle) rejectionSignals++;
    if (rsi != null && rsi > 70) rejectionSignals++;
    if (price < open) rejectionSignals++; // closed lower than open = red candle at resistance

    if (rejectionSignals >= 2) {
      reasons.push('Price di area R1 (' + r1 + ') tapi momentum lemah');
      if (volVsAvg != null && volVsAvg < 1.0) reasons.push('Volume lemah (' + volVsAvg + 'x)');
      if (!isGreenCandle) reasons.push('Candle merah di resistance');
      if (rsi != null && rsi > 70) { reasons.push('RSI ' + rsi + ' overbought'); warnings.push('RSI overbought'); }
      flags.push('rejection_risk');

      return {
        status: 'Rejection Risk',
        confidence: rejectionSignals >= 3 ? 'high' : 'medium',
        breakoutLevel: breakoutLevel,
        breakdownLevel: breakdownLevel,
        validIf: 'Breakout besok dengan volume besar (bisa false rejection)',
        invalidIf: 'Turun di bawah pivot atau MA20 — konfirmasi rejection',
        reasons: reasons,
        warnings: warnings,
        flags: flags
      };
    }
  }

  // === PRIORITY 4: Breakdown Risk ===
  var belowMA20 = ma20 != null && price < ma20;
  var belowMA50 = ma50 != null && price < ma50;
  var belowPivot = pivotPoint != null && price < pivotPoint;
  var belowS1 = s1 != null && price < s1;

  if ((belowMA20 && belowMA50) || belowS1) {
    var breakdownSignals = 0;
    if (belowMA20) breakdownSignals++;
    if (belowMA50) breakdownSignals++;
    if (belowPivot) breakdownSignals++;
    if (belowS1) breakdownSignals++;
    if (rsi != null && rsi < 45) breakdownSignals++;

    if (breakdownSignals >= 2) {
      if (belowS1) reasons.push('Price di bawah S1 (' + s1 + ')');
      if (belowMA20) reasons.push('Price di bawah MA20');
      if (belowMA50) reasons.push('Price di bawah MA50');
      if (rsi != null && rsi < 45) reasons.push('RSI ' + rsi + ' lemah');
      flags.push('breakdown_risk');
      if (belowS1 && s2 != null && price < s2) {
        flags.push('below_s2');
        warnings.push('Price sudah di bawah S2');
      }

      return {
        status: 'Breakdown Risk',
        confidence: breakdownSignals >= 4 ? 'high' : 'medium',
        breakoutLevel: breakoutLevel,
        breakdownLevel: breakdownLevel,
        validIf: 'Recovery di atas ' + (pivotPoint || 'pivot') + ' dan MA20 dengan volume',
        invalidIf: 'Lanjut turun di bawah ' + (s2 || s1 || 'support') + ' — downtrend berlanjut',
        reasons: reasons,
        warnings: warnings,
        flags: flags
      };
    }
  }

  // === PRIORITY 5: Sideways / Wait (default) ===
  reasons.push('Price dalam range antara support dan resistance');
  if (volVsAvg != null && volVsAvg < 1.0) reasons.push('Volume belum mendukung (' + volVsAvg + 'x)');
  if (rsi != null && rsi >= 45 && rsi <= 55) reasons.push('RSI ' + rsi + ' netral');
  flags.push('sideways_wait');

  if (flatRange) {
    confidence = 'low';
    warnings.push('Pivot range flat, level breakout/breakdown kurang informatif');
    flags.push('flat_range');
  }

  return {
    status: 'Sideways / Wait',
    confidence: confidence,
    breakoutLevel: breakoutLevel,
    breakdownLevel: breakdownLevel,
    validIf: 'Breakout di atas ' + (r1 || 'resistance') + ' ATAU breakdown di bawah ' + (s1 || 'support') + ' dengan volume',
    invalidIf: 'Tetap sideways tanpa katalis atau volume baru',
    reasons: reasons,
    warnings: warnings,
    flags: flags
  };
}



// ===== RISK GUARD v1 (deterministic, conservative risk assessment) =====
// Purpose: Prevent aggressive wording for risky stocks.
// Conservative by design — floors ensure speculative/low-price stocks cannot be rated "Low" without strong evidence.
function calculateRiskGuard(quote, board) {
  if (!quote || !quote.success) {
    return {
      level: 'Unknown',
      riskScore: 50,
      actionBias: 'Wait Confirmation',
      reasons: ['Data quote tidak tersedia'],
      warnings: ['no_data'],
      floors: { applied: false }
    };
  }

  var price = quote.last;
  var rsi = quote.rsi14;
  var volVsAvg = quote.volumeVsAvg20;
  var setupLabel = quote.setupLabel;
  var autoCuanScore = quote.autoCuanScore;
  var breakoutConf = quote.breakoutConfirmation;

  var reasons = [];
  var warnings = [];
  var riskScore = 0; // 0 = no risk, 100 = maximum risk

  // === BOARD RISK ASSESSMENT (with safe normalization) ===
  var boardInfo = normalizeBoardSafe(board);
  var boardLevel = boardInfo.level; // 'normal', 'elevated', 'high', 'unknown'
  var boardLabel = boardInfo.label;

  // === BASE RISK FROM BOARD ===
  // INDEX: skip all board/stock-specific penalties
  if (boardLevel === 'index') {
    // For indices (IHSG), only assess based on technicals — no board/price/speculative penalties
    var indexReasons = [];
    var indexWarnings = [];
    var indexScore = 0;

    // Only technical weakness matters for indices
    if (rsi != null && rsi < 35) {
      indexScore += 8;
      indexReasons.push('RSI ' + rsi + ' — momentum indeks lemah');
    }
    if (volVsAvg != null && volVsAvg < 0.5) {
      indexScore += 5;
      indexReasons.push('Volume indeks rendah (' + volVsAvg + 'x avg)');
    }

    // Setup label risk for index
    var idxSetupStatus = (setupLabel && setupLabel.status) ? setupLabel.status : null;
    if (idxSetupStatus === 'Bearish Continuation' || idxSetupStatus === 'Avoid Dulu') {
      indexScore += 15;
      indexReasons.push('Kondisi teknikal indeks: ' + idxSetupStatus);
    } else if (idxSetupStatus === 'Breakdown Risk') {
      indexScore += 12;
      indexReasons.push('Indeks dalam area breakdown risk');
    }

    // Breakout confirmation for index
    var idxBreakout = (breakoutConf && breakoutConf.status) ? breakoutConf.status : null;
    if (idxBreakout === 'Breakdown Risk') {
      indexScore += 10;
      indexReasons.push('Indeks di bawah support utama');
    }

    indexScore = Math.max(0, Math.min(100, indexScore));
    var indexLevel = indexScore >= 45 ? 'High' : indexScore >= 25 ? 'Medium' : indexScore >= 10 ? 'Low' : 'Very Low';
    var indexBias = indexLevel === 'High' ? 'Cautious' : indexLevel === 'Medium' ? 'Wait Confirmation' : 'Normal Watch';

    return {
      level: indexLevel,
      riskScore: indexScore,
      actionBias: indexBias,
      reasons: indexReasons.length > 0 ? indexReasons : ['Indeks — analisis berbasis teknikal saja'],
      warnings: indexWarnings,
      floors: { applied: false, trigger: null, minimumScore: null },
      catalystReduction: 0,
      boardInfo: {
        boardLevel: 'index',
        boardLabel: 'Indeks Pasar',
        source: 'index_special_case'
      }
    };
  }

  if (boardLevel === 'high') {
    // PEMANTAUAN_KHUSUS / FCA — hard override
    return {
      level: 'Very High',
      riskScore: 90,
      actionBias: 'Avoid Dulu',
      reasons: ['Board: ' + boardLabel + ' — FCA/Pemantauan Khusus', 'Likuiditas sangat terbatas', 'Risiko delisting / suspensi'],
      warnings: ['fca_override', 'hard_avoid'],
      floors: { applied: true, trigger: 'PEMANTAUAN_KHUSUS/FCA hard override' }
    };
  }

  if (boardLevel === 'elevated') {
    riskScore += 25;
    reasons.push('Board: ' + boardLabel + ' — likuiditas ketat, risiko tinggi');
    warnings.push('board_akselerasi');
  } else if (boardLevel === 'unknown') {
    riskScore += 10;
    reasons.push('Board data tidak tersedia/stale — risiko tidak diketahui');
    warnings.push('board_unknown');
  }
  // UTAMA/PENGEMBANGAN/EKONOMI_BARU: no board penalty

  // === PRICE RISK ===
  if (price != null) {
    if (price <= 50) {
      riskScore += 20;
      reasons.push('Harga sangat rendah (Rp ' + price + ') — area gocap/near-gocap');
      warnings.push('very_low_price');
    } else if (price <= 100) {
      riskScore += 15;
      reasons.push('Harga rendah (Rp ' + price + ') — speculative area');
      warnings.push('low_price');
    } else if (price <= 200) {
      riskScore += 8;
      reasons.push('Harga masih low-price (Rp ' + price + ') — perlu konfirmasi kuat');
      warnings.push('low_price_area');
    }
  }

  // === SETUP LABEL RISK ===
  var setupStatus = (setupLabel && setupLabel.status) ? setupLabel.status : null;
  if (setupStatus === 'High Risk Speculative') {
    riskScore += 20;
    reasons.push('Setup Label: High Risk Speculative');
    warnings.push('high_risk_speculative_label');
  } else if (setupStatus === 'Speculative Watch') {
    riskScore += 12;
    reasons.push('Setup Label: Speculative Watch — catalyst ada tapi konfirmasi lemah');
    warnings.push('speculative_watch_label');
  } else if (setupStatus === 'Avoid Dulu') {
    riskScore += 25;
    reasons.push('Setup Label: Avoid Dulu — kondisi teknikal bearish');
    warnings.push('avoid_label');
  } else if (setupStatus === 'Bearish Continuation') {
    riskScore += 20;
    reasons.push('Setup Label: Bearish Continuation — trend turun berlanjut');
    warnings.push('bearish_continuation_label');
  } else if (setupStatus === 'Breakdown Risk') {
    riskScore += 15;
    reasons.push('Setup Label: breakdown risk terdeteksi');
  } else if (setupStatus === 'Sideways / No Trade') {
    riskScore += 5;
  }
  // Breakout Watch, Rebound Watch = low additional risk

  // === BREAKOUT CONFIRMATION RISK ===
  var breakoutStatus = (breakoutConf && breakoutConf.status) ? breakoutConf.status : null;
  if (breakoutStatus === 'Breakdown Risk') {
    riskScore += 15;
    reasons.push('Breakout Confirmation: Breakdown Risk — harga di bawah support');
    warnings.push('breakdown_risk');
  } else if (breakoutStatus === 'Rejection Risk') {
    riskScore += 8;
    reasons.push('Breakout Confirmation: Rejection Risk — momentum lemah di resistance');
  }

  // === AUTO-CUAN SCORE RISK ===
  var grade = (autoCuanScore && autoCuanScore.grade) ? autoCuanScore.grade : null;
  var score = (autoCuanScore && autoCuanScore.score != null) ? autoCuanScore.score : null;
  if (grade === 'E') {
    riskScore += 18;
    reasons.push('Auto-Cuan Grade E (score ' + score + '/100) — very weak setup');
    warnings.push('grade_e');
  } else if (grade === 'D') {
    riskScore += 12;
    reasons.push('Auto-Cuan Grade D (score ' + score + '/100) — weak setup');
    warnings.push('grade_d');
  } else if (grade === 'C') {
    riskScore += 5;
    if (setupStatus === 'Speculative Watch' || setupStatus === 'High Risk Speculative') {
      riskScore += 5;
      reasons.push('Auto-Cuan Grade C + speculative label — mixed setup');
    }
  }
  // Grade B/A = low risk contribution

  // === TECHNICAL WEAKNESS ===
  if (rsi != null && rsi < 35) {
    riskScore += 5;
    reasons.push('RSI ' + rsi + ' — momentum sangat lemah');
  }
  if (volVsAvg != null && volVsAvg < 0.5) {
    riskScore += 5;
    reasons.push('Volume sangat rendah (' + volVsAvg + 'x avg) — likuiditas lemah');
    warnings.push('very_low_volume');
  }

  // === POSITIVE CATALYST REDUCTION (capped, respects floors) ===
  var catalystReduction = 0;
  var newsData = quote.news;
  if (newsData && newsData.success && newsData.items && newsData.items.length > 0) {
    var positiveCount = 0;
    var negativeCount = 0;
    for (var i = 0; i < newsData.items.length; i++) {
      var impact = newsData.items[i].possibleImpact || newsData.items[i].impact || 'neutral';
      if (impact === 'positive') positiveCount++;
      else if (impact === 'negative') negativeCount++;
    }
    if (positiveCount > 0 && negativeCount === 0) {
      // Positive catalyst: reduce risk by max 5 points
      catalystReduction = Math.min(5, positiveCount * 3);
      reasons.push('Katalis positif terdeteksi (pengurangan risiko terbatas -' + catalystReduction + ')');
    } else if (negativeCount > 0 && positiveCount === 0) {
      riskScore += 5;
      reasons.push('Katalis negatif terdeteksi');
      warnings.push('negative_catalyst');
    }
    // Mixed catalyst: no reduction
  }

  // Apply catalyst reduction BEFORE floor enforcement
  riskScore = riskScore - catalystReduction;

  // === RISK FLOORS (minimum levels — cannot be reduced by catalyst) ===
  var floorApplied = false;
  var floorTrigger = null;
  var minimumScore = 0;

  // Floor: PEMANTAUAN_KHUSUS/FCA already handled above (hard override)

  // Floor: Akselerasi board → minimum Medium
  if (boardLevel === 'elevated') {
    minimumScore = Math.max(minimumScore, 30);
    if (!floorTrigger) floorTrigger = 'Board AKSELERASI → minimum Medium';
  }

  // Floor: price <= 200 → minimum Medium unless technicals clearly strong and liquidity excellent
  if (price != null && price <= 200) {
    var technicalsStrong = (rsi != null && rsi >= 55) && (volVsAvg != null && volVsAvg >= 1.5);
    var gradeGood = (grade === 'A' || grade === 'B');
    if (!(technicalsStrong && gradeGood)) {
      minimumScore = Math.max(minimumScore, 25);
      if (!floorTrigger) floorTrigger = 'Price <= 200 tanpa konfirmasi kuat → minimum Medium';
    }
  }

  // Floor: Speculative Watch → minimum Medium, actionBias Wait Confirmation
  if (setupStatus === 'Speculative Watch') {
    minimumScore = Math.max(minimumScore, 25);
    if (!floorTrigger) floorTrigger = 'Setup Speculative Watch → minimum Medium';
  }

  // Floor: High Risk Speculative → minimum High
  if (setupStatus === 'High Risk Speculative') {
    minimumScore = Math.max(minimumScore, 45);
    if (!floorTrigger) floorTrigger = 'Setup High Risk Speculative → minimum High';
  }

  // Floor: Avoid Dulu or Bearish Continuation → minimum High
  if (setupStatus === 'Avoid Dulu' || setupStatus === 'Bearish Continuation') {
    minimumScore = Math.max(minimumScore, 50);
    if (!floorTrigger) floorTrigger = 'Setup ' + setupStatus + ' → minimum High';
  }

  // Floor: Breakdown Risk (from breakoutConfirmation) → minimum High
  if (breakoutStatus === 'Breakdown Risk') {
    minimumScore = Math.max(minimumScore, 45);
    if (!floorTrigger) floorTrigger = 'Breakout Confirmation Breakdown Risk → minimum High';
  }

  // Floor: Auto-Cuan Grade D or E → minimum High
  if (grade === 'D' || grade === 'E') {
    minimumScore = Math.max(minimumScore, 45);
    if (!floorTrigger) floorTrigger = 'Grade ' + grade + ' → minimum High';
  }

  // Floor: Grade C with speculative label → minimum Medium
  if (grade === 'C' && (setupStatus === 'Speculative Watch' || setupStatus === 'High Risk Speculative')) {
    minimumScore = Math.max(minimumScore, 30);
    if (!floorTrigger) floorTrigger = 'Grade C + speculative label → minimum Medium';
  }

  // Enforce floor
  if (riskScore < minimumScore) {
    riskScore = minimumScore;
    floorApplied = true;
  }

  // Clamp to 0-100 (natural floor — catalyst cannot make risk negative)
  if (riskScore < 0) {
    riskScore = 0;
    // This is natural clamping, not a policy floor
  }
  riskScore = Math.min(100, riskScore);

  // === DETERMINE LEVEL ===
  var level;
  if (riskScore >= 75) level = 'Very High';
  else if (riskScore >= 45) level = 'High';
  else if (riskScore >= 25) level = 'Medium';
  else if (riskScore >= 10) level = 'Low';
  else level = 'Very Low';

  // === DETERMINE ACTION BIAS ===
  var actionBias;
  if (level === 'Very High') {
    actionBias = 'Avoid Dulu';
  } else if (level === 'High') {
    actionBias = 'Small Position Only';
  } else if (level === 'Medium') {
    // Speculative Watch or waiting confirmation
    if (setupStatus === 'Speculative Watch' || setupStatus === 'Rebound Watch') {
      actionBias = 'Wait Confirmation';
    } else {
      actionBias = 'Wait Confirmation';
    }
  } else if (level === 'Low') {
    actionBias = 'Normal Watch';
  } else {
    actionBias = 'Normal Watch';
  }

  // Override actionBias for specific setup labels
  if (setupStatus === 'Speculative Watch' && level === 'Medium') {
    actionBias = 'Wait Confirmation';
  }
  if (setupStatus === 'High Risk Speculative') {
    actionBias = 'Small Position Only';
  }

  return {
    level: level,
    riskScore: riskScore,
    actionBias: actionBias,
    reasons: reasons.slice(0, 6),
    warnings: warnings.slice(0, 5),
    floors: {
      applied: floorApplied,
      trigger: floorTrigger || null,
      minimumScore: minimumScore > 0 ? minimumScore : null
    },
    catalystReduction: catalystReduction,
    boardInfo: {
      boardLevel: boardLevel,
      boardLabel: boardLabel,
      source: (board && board.success) ? 'supabase' : 'unavailable'
    }
  };
}

// === SAFE BOARD NORMALIZATION ===
// Only treat as AKSELERASI if actual board string explicitly matches.
// Do not infer from unrelated text.
function normalizeBoardSafe(board) {
  if (!board || !board.success) {
    return { level: 'unknown', label: 'Board data unavailable/stale' };
  }

  var b = board.board;
  if (!b || typeof b !== 'string') {
    return { level: 'unknown', label: 'Board field empty' };
  }

  // Normalize to uppercase for comparison
  var upper = b.toUpperCase().trim();

  // INDEX — special case for IHSG/market indices
  // No board penalty, no FCA, no speculative risk
  if (upper === 'INDEX' || board.isIndex === true) {
    return { level: 'index', label: 'Indeks Pasar' };
  }

  // FCA / Pemantauan Khusus — hard override
  if (upper === 'PEMANTAUAN_KHUSUS' || board.isFca === true) {
    return { level: 'high', label: 'Pemantauan Khusus / FCA' };
  }

  // Akselerasi — only exact match, never infer
  if (upper === 'AKSELERASI') {
    return { level: 'elevated', label: 'Papan Akselerasi' };
  }

  // Normal boards — safe
  if (upper === 'UTAMA') {
    return { level: 'normal', label: 'Papan Utama' };
  }
  if (upper === 'PENGEMBANGAN') {
    return { level: 'normal', label: 'Papan Pengembangan' };
  }
  if (upper === 'EKONOMI_BARU') {
    return { level: 'normal', label: 'Papan Ekonomi Baru' };
  }

  // UNKNOWN or anything else — treat as unknown, do not falsely assign
  return { level: 'unknown', label: 'Board: ' + b + ' (tidak dikenali)' };
}


// ===== VOLUME INTELLIGENCE HELPERS =====

/**
 * Classify volume trend from recent 7 days of volume data.
 * Returns: 'spike', 'rising', 'falling', 'drying_up', 'normal'
 */
function classifyVolumeTrend(volumeArr) {
  if (!volumeArr || volumeArr.length < 7) return 'normal';
  var recent7 = volumeArr.slice(-7);
  var recent3 = volumeArr.slice(-3);
  var avg7 = recent7.reduce(function(s, v) { return s + v; }, 0) / 7;
  var avg3 = recent3.reduce(function(s, v) { return s + v; }, 0) / 3;
  var latest = volumeArr[volumeArr.length - 1];

  if (avg7 <= 0) return 'normal';

  var latestRatio = latest / avg7;
  var recentRatio = avg3 / avg7;

  // Spike: latest volume > 2x avg7
  if (latestRatio > 2.0) return 'spike';
  // Rising: 3-day avg notably above 7-day avg
  if (recentRatio > 1.3) return 'rising';
  // Drying up: latest volume < 0.4x avg7
  if (latestRatio < 0.4) return 'drying_up';
  // Falling: 3-day avg notably below 7-day avg
  if (recentRatio < 0.7) return 'falling';
  return 'normal';
}

/**
 * Interpret price-volume relationship.
 * Returns a compact interpretation string in Indonesian.
 */
function interpretPriceVolume(priceChange1D, volumeVsAvg7, lastClose, prevClose) {
  if (priceChange1D == null || volumeVsAvg7 == null) return null;

  var priceUp = priceChange1D > 0.3;
  var priceDown = priceChange1D < -0.3;
  var sideways = !priceUp && !priceDown;
  var volUp = volumeVsAvg7 > 1.2;
  var volDown = volumeVsAvg7 < 0.8;

  if (priceUp && volUp) return 'Minat beli menguat — kenaikan harga didukung volume di atas rata-rata.';
  if (priceUp && volDown) return 'Kenaikan belum meyakinkan — volume tidak ikut naik.';
  if (priceDown && volUp) return 'Tekanan jual masih kuat — penurunan harga disertai volume besar.';
  if (priceDown && volDown) return 'Tekanan jual mulai mereda — volume ikut menurun, tapi belum otomatis bullish.';
  if (sideways && volUp) return 'Ada aktivitas akumulasi/distribusi — harga stagnan tapi volume naik, tunggu arah breakout/breakdown.';
  if (sideways && volDown) return 'Market sepi — harga dan volume sama-sama flat, sinyal lemah.';
  // Default
  if (priceUp) return 'Harga naik dengan volume normal.';
  if (priceDown) return 'Harga turun dengan volume normal.';
  return 'Harga dan volume relatif stabil.';
}



// ===== FIBONACCI INTELLIGENCE =====

/**
 * Calculate Fibonacci retracement levels from OHLCV candles.
 * Uses last 60 candles (or available if fewer) to find swing high/low.
 * Minimum 10 candles required.
 * Returns null if insufficient data.
 */
function calculateFibonacciLevels(candles) {
  if (!candles || !Array.isArray(candles) || candles.length < 10) return null;

  // Use last 60 candles (or all available)
  var lookback = Math.min(60, candles.length);
  var recentCandles = candles.slice(-lookback);

  // Find swing high and swing low from lookback window
  var swingHigh = -Infinity;
  var swingLow = Infinity;
  var swingHighIdx = -1;
  var swingLowIdx = -1;

  for (var i = 0; i < recentCandles.length; i++) {
    var c = recentCandles[i];
    if (c == null || c.high == null || c.low == null || c.close == null) continue;
    if (isNaN(c.high) || isNaN(c.low)) continue;

    if (c.high > swingHigh) {
      swingHigh = c.high;
      swingHighIdx = i;
    }
    if (c.low < swingLow) {
      swingLow = c.low;
      swingLowIdx = i;
    }
  }

  // Validate swing points
  if (swingHigh === -Infinity || swingLow === Infinity) return null;
  if (swingHigh <= swingLow) return null;

  var fibRange = swingHigh - swingLow;
  if (fibRange <= 0) return null;

  // Get latest close for position analysis
  var latestCandle = recentCandles[recentCandles.length - 1];
  if (!latestCandle || latestCandle.close == null || isNaN(latestCandle.close)) return null;
  var latestClose = latestCandle.close;

  // Determine trend context
  // If swing high came AFTER swing low → uptrend retracement context
  // If swing low came AFTER swing high → downtrend retracement context
  var fibTrend;
  if (swingHighIdx > swingLowIdx) {
    // Price went up first, then retracing — upward context
    fibTrend = 'upward_retracement';
  } else {
    // Price went down first — downward context
    fibTrend = 'downward_retracement';
  }

  // Refine trend based on latest close position
  var closePosition = (latestClose - swingLow) / fibRange; // 0 = at low, 1 = at high
  if (closePosition > 0.7) {
    fibTrend = 'upward_retracement'; // near highs
  } else if (closePosition < 0.3) {
    fibTrend = 'downward_retracement'; // near lows
  }

  // Calculate Fibonacci levels
  // For upward retracement: levels measured from swing high down
  // fib236 = swingHigh - 0.236 * range (closest to high)
  // fib786 = swingHigh - 0.786 * range (closest to low)
  var fib236 = idxTick.roundToIdxTick(swingHigh - 0.236 * fibRange, 'nearest');
  var fib382 = idxTick.roundToIdxTick(swingHigh - 0.382 * fibRange, 'nearest');
  var fib500 = idxTick.roundToIdxTick(swingHigh - 0.500 * fibRange, 'nearest');
  var fib618 = idxTick.roundToIdxTick(swingHigh - 0.618 * fibRange, 'nearest');
  var fib786 = idxTick.roundToIdxTick(swingHigh - 0.786 * fibRange, 'nearest');

  // Find nearest Fibonacci level
  var fibLevels = [
    { level: fib236, label: 'Fib 23.6%', ratio: 0.236 },
    { level: fib382, label: 'Fib 38.2%', ratio: 0.382 },
    { level: fib500, label: 'Fib 50%', ratio: 0.500 },
    { level: fib618, label: 'Fib 61.8%', ratio: 0.618 },
    { level: fib786, label: 'Fib 78.6%', ratio: 0.786 }
  ];

  var nearest = findNearestFibLevel(latestClose, fibLevels);
  var positionReading = interpretFibonacciPosition(latestClose, fibTrend, nearest, fibLevels, swingHigh, swingLow);

  // Invalidation level: depends on trend context
  var invalidationLevel;
  if (fibTrend === 'upward_retracement') {
    // Breakdown below Fib 61.8% weakens rebound scenario
    invalidationLevel = fib618;
  } else {
    // Breakout above Fib 38.2% weakens downtrend scenario
    invalidationLevel = fib382;
  }

  return {
    swingHigh: roundPrice(swingHigh),
    swingLow: roundPrice(swingLow),
    trend: fibTrend,
    lookbackCandles: lookback,
    levels: {
      fib236: fib236,
      fib382: fib382,
      fib500: fib500,
      fib618: fib618,
      fib786: fib786
    },
    nearestLevel: nearest ? nearest.level : null,
    nearestLabel: nearest ? nearest.label : null,
    positionReading: positionReading,
    invalidationLevel: invalidationLevel
  };
}

/**
 * Find the nearest Fibonacci level to the current close price.
 */
function findNearestFibLevel(close, fibLevels) {
  if (close == null || !fibLevels || fibLevels.length === 0) return null;

  var nearest = null;
  var minDist = Infinity;

  for (var i = 0; i < fibLevels.length; i++) {
    var fl = fibLevels[i];
    if (fl.level == null) continue;
    var dist = Math.abs(close - fl.level);
    if (dist < minDist) {
      minDist = dist;
      nearest = fl;
    }
  }

  return nearest;
}

/**
 * Interpret Fibonacci position and generate a reading in Indonesian.
 */
function interpretFibonacciPosition(close, trend, nearest, fibLevels, swingHigh, swingLow) {
  if (!nearest || close == null) return null;

  var label = nearest.label;
  var level = nearest.level;
  var distPct = level > 0 ? Math.round(Math.abs(close - level) / level * 10000) / 100 : 0;

  // Close is very near the level (within 2%)
  var isNear = distPct <= 2;
  var isAbove = close > level;

  if (trend === 'upward_retracement') {
    if (isNear) {
      if (nearest.ratio <= 0.382) {
        return 'Harga berada dekat area ' + label + ', area ini bisa menjadi support dinamis jika rebound masih sehat.';
      } else if (nearest.ratio <= 0.5) {
        return 'Harga berada di area ' + label + ', level psikologis penting. Rebound masih mungkin jika volume mendukung.';
      } else if (nearest.ratio <= 0.618) {
        return 'Harga sudah retrace cukup dalam ke ' + label + '. Area golden ratio ini krusial untuk menentukan arah selanjutnya.';
      } else {
        return 'Harga retrace sangat dalam ke ' + label + '. Skenario rebound melemah, risiko breakdown meningkat.';
      }
    } else if (isAbove) {
      return 'Harga berada di atas ' + label + ' (' + level + '), masih dalam zona retracement sehat.';
    } else {
      return 'Harga sudah menembus ke bawah ' + label + ' (' + level + '), tekanan bearish meningkat.';
    }
  } else {
    // downward_retracement
    if (isNear) {
      if (nearest.ratio <= 0.382) {
        return 'Harga mendekati ' + label + ' dari bawah, area ini bisa menjadi resistance jika downtrend masih dominan.';
      } else if (nearest.ratio <= 0.618) {
        return 'Harga berada di area ' + label + ', level ini krusial sebagai resistance dinamis.';
      } else {
        return 'Harga sudah recover cukup tinggi ke ' + label + '. Jika tembus, potensi reversal meningkat.';
      }
    } else if (isAbove) {
      return 'Harga di atas ' + label + ' (' + level + '), ada potensi recovery lebih lanjut.';
    } else {
      return 'Harga masih di bawah ' + label + ' (' + level + '), tekanan jual masih dominan.';
    }
  }
}

module.exports.__test = { normalizeDailyContextTicker: normalizeDailyContextTicker };
