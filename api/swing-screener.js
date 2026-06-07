/**
 * Swing Screener Konglo 3-7D — Vercel Serverless Endpoint
 *
 * Modes:
 *   GET /api/swing-screener              → read cached results from Supabase
 *   GET /api/swing-screener?action=refresh → cron-protected: run deterministic scan + AI confirmation
 *
 * Environment variables used:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — database
 *   CRON_SECRET — cron authentication
 *   SCREENER_AI_API_KEY — AI confirmation (server-side only)
 *   SCREENER_AI_BASE_URL — OpenAI-compatible endpoint
 *   SCREENER_AI_MODEL — model name
 *   SCREENER_AI_MAX_CANDIDATES — max tickers sent to AI (default 15)
 *   SCREENER_AI_MAX_OUTPUT_TOKENS — max tokens for AI response (default 700)
 */

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const action = req.query.action || null;

    // === REFRESH MODE (cron-protected) ===
    if (action === 'refresh') {
      return await handleRefresh(req, res, supabase);
    }

    // === READ MODE: return cached screener data ===
    return await handleRead(req, res, supabase);

  } catch (e) {
    console.error('swing-screener exception:', e.message);
    return res.status(200).json({ success: false, error: 'Terjadi kesalahan.' });
  }
};

// ============================================================
// READ HANDLER — return cached data from Supabase
// ============================================================
async function handleRead(req, res, supabase) {
  const { data: meta } = await supabase
    .from('swing_screener_meta')
    .select('*')
    .eq('id', 'latest')
    .maybeSingle();

  const { data: rows, error: rowErr } = await supabase
    .from('swing_screener_latest')
    .select('*')
    .order('score', { ascending: false });

  if (rowErr) {
    return res.status(200).json({ success: false, error: 'Gagal memuat data screener.' });
  }

  return res.status(200).json({
    success: true,
    meta: meta || { calculated_at: null, status: 'pending', message: 'Awaiting first calculation.', universe_count: 0, scanned_count: 0, failed_count: 0, ai_called_count: 0 },
    results: rows || []
  });
}

// ============================================================
// REFRESH HANDLER — cron-protected deterministic scan + AI
// ============================================================
async function handleRefresh(req, res, supabase) {
  // Verify cron secret
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) {
    return res.status(200).json({ success: false, error: 'Refresh not configured.' });
  }

  const authHeader = req.headers.authorization || '';
  const providedSecret = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (providedSecret !== CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  try {
    // 1. Read universe from sector_hot_group_members
    const { data: members, error: mErr } = await supabase
      .from('sector_hot_group_members')
      .select('group_code, ticker, stock_name')
      .eq('is_active', true);

    if (mErr || !members || members.length === 0) {
      await updateMeta(supabase, { universe_count: 0, scanned_count: 0, failed_count: 0, ai_called_count: 0, status: 'failed', message: 'No active members found.' });
      return res.status(200).json({ success: false, error: 'No active members.' });
    }

    // Deduplicate tickers (a ticker can belong to multiple groups, pick first group)
    const tickerMap = {};
    members.forEach(function(m) {
      if (!tickerMap[m.ticker]) {
        tickerMap[m.ticker] = { ticker: m.ticker, group_code: m.group_code, stock_name: m.stock_name };
      }
    });
    const universe = Object.values(tickerMap);
    const universeCount = universe.length;

    // 2. Fetch candle data and calculate indicators for each ticker
    var scannedCount = 0;
    var failedCount = 0;
    var results = [];

    for (var i = 0; i < universe.length; i++) {
      var item = universe[i];
      scannedCount++;
      try {
        var candles = await fetchCandles(item.ticker);
        if (!candles || candles.length < 55) {
          failedCount++;
          continue;
        }
        var analysis = calculateIndicators(candles);
        var scoring = scoreAndClassify(analysis);
        results.push({
          ticker: item.ticker,
          group_code: item.group_code,
          stock_name: item.stock_name,
          ...analysis,
          ...scoring
        });
      } catch (e) {
        failedCount++;
      }
      // Rate limit: 250ms between Yahoo requests
      if (i < universe.length - 1) {
        await delay(250);
      }
    }

    // If ALL failed, do not wipe cache
    if (results.length === 0) {
      await updateMeta(supabase, { universe_count: universeCount, scanned_count: scannedCount, failed_count: failedCount, ai_called_count: 0, status: 'failed', message: 'All ticker fetches failed.' });
      return res.status(200).json({ success: false, error: 'All fetches failed.' });
    }

    // 3. AI Confirmation for top candidates
    var aiCalledCount = 0;
    var maxCandidates = parseInt(process.env.SCREENER_AI_MAX_CANDIDATES || '15', 10);
    var aiCandidates = results
      .filter(function(r) { return r.score >= 78; })
      .sort(function(a, b) { return b.score - a.score; })
      .slice(0, maxCandidates);

    if (aiCandidates.length > 0 && process.env.SCREENER_AI_API_KEY) {
      var aiResults = await callAIConfirmation(aiCandidates);
      aiCalledCount = aiCandidates.length;

      // Merge AI results back
      var aiMap = {};
      if (aiResults && aiResults.length) {
        aiResults.forEach(function(ar) { aiMap[ar.ticker] = ar; });
      }

      results = results.map(function(r) {
        var ai = aiMap[r.ticker];
        if (ai) {
          r.ai_status = ai.ai_status || null;
          r.ai_reason = ai.ai_reason || null;
          r.ai_red_flags = ai.ai_red_flags || [];
          // Downgrade if AI rejects
          if (ai.ai_status === 'REJECT' && r.status === 'Swing Ready') {
            r.final_status = 'Watchlist';
          } else if (ai.ai_status === 'CAUTION' && r.status === 'Swing Ready') {
            r.final_status = r.status; // keep but mark caution
          } else {
            r.final_status = r.status;
          }
        } else {
          r.final_status = r.status;
        }
        return r;
      });
    } else {
      // No AI — final_status = status
      results = results.map(function(r) { r.final_status = r.status; return r; });
    }

    // 4. Upsert results to Supabase
    var now = new Date().toISOString();
    var upsertRows = results.map(function(r) {
      return {
        ticker: r.ticker,
        group_code: r.group_code,
        stock_name: r.stock_name,
        last_price: r.last_price,
        change_pct: r.change_pct,
        ma20: r.ma20,
        ma50: r.ma50,
        rsi14: r.rsi14,
        volume_ratio_avg20: r.volume_ratio_avg20,
        support: r.support,
        resistance: r.resistance,
        entry_low: r.entry_low,
        entry_high: r.entry_high,
        stop_loss: r.stop_loss,
        tp1: r.tp1,
        tp2: r.tp2,
        risk_reward: r.risk_reward,
        score: r.score,
        status: r.status,
        invalidation: r.invalidation,
        ai_status: r.ai_status || null,
        ai_reason: r.ai_reason || null,
        ai_red_flags: r.ai_red_flags || null,
        final_status: r.final_status,
        calculated_at: now
      };
    });

    // Delete old data and insert fresh (simpler than upsert for full refresh)
    await supabase.from('swing_screener_latest').delete().neq('ticker', '');
    if (upsertRows.length > 0) {
      await supabase.from('swing_screener_latest').insert(upsertRows);
    }

    // 5. Update meta
    await updateMeta(supabase, {
      universe_count: universeCount,
      scanned_count: scannedCount,
      failed_count: failedCount,
      ai_called_count: aiCalledCount,
      status: 'ok',
      message: 'Refresh completed. Scanned: ' + scannedCount + ', Results: ' + results.length + ', AI: ' + aiCalledCount
    });

    return res.status(200).json({
      success: true,
      message: 'Refresh completed.',
      universe_count: universeCount,
      scanned_count: scannedCount,
      failed_count: failedCount,
      results_count: results.length,
      ai_called_count: aiCalledCount
    });

  } catch (e) {
    console.error('swing-screener refresh error:', e.message);
    await updateMeta(supabase, { universe_count: 0, scanned_count: 0, failed_count: 0, ai_called_count: 0, status: 'failed', message: 'Refresh error: ' + e.message });
    return res.status(200).json({ success: false, error: 'Refresh failed: ' + e.message });
  }
}

// ============================================================
// TECHNICAL INDICATOR CALCULATIONS
// ============================================================

function calculateIndicators(candles) {
  var closes = candles.map(function(c) { return c.close; });
  var highs = candles.map(function(c) { return c.high; });
  var lows = candles.map(function(c) { return c.low; });
  var volumes = candles.map(function(c) { return c.volume; });

  var lastIdx = closes.length - 1;
  var last_price = closes[lastIdx];
  var prev_close = closes[lastIdx - 1];
  var change_pct = prev_close > 0 ? round2((last_price - prev_close) / prev_close * 100) : 0;

  var ma20 = calcMA(closes, 20);
  var ma50 = calcMA(closes, 50);
  var rsi14 = calcRSI(closes, 14);
  var volAvg20 = calcMA(volumes, 20);
  var volume_ratio_avg20 = volAvg20 > 0 ? round2(volumes[lastIdx] / volAvg20) : 0;

  // Support: lowest low of last 20 candles
  var recent20Lows = lows.slice(-20);
  var support = Math.min.apply(null, recent20Lows);

  // Resistance: highest high of last 20 candles
  var recent20Highs = highs.slice(-20);
  var resistance = Math.max.apply(null, recent20Highs);

  // Alternative support: use swing lows (simplified: 2nd lowest of last 30 days)
  var recent30Lows = lows.slice(-30).sort(function(a, b) { return a - b; });
  var support2 = recent30Lows.length >= 3 ? recent30Lows[2] : support; // 3rd lowest as more robust support

  // Use the higher of support candidates as the primary support (more meaningful)
  var primarySupport = Math.max(support, support2 * 0.99);
  // But never higher than current price
  if (primarySupport >= last_price) {
    primarySupport = support;
  }

  // Entry area: between support/MA20 area and slightly above
  var entryBase = Math.max(primarySupport, ma20 ? ma20 * 0.99 : primarySupport);
  var entry_low = round0(Math.min(entryBase, last_price * 0.98));
  var entry_high = round0(last_price * 1.005);

  // Stop loss: below primary support, max 5% from entry midpoint
  var entryMid = (entry_low + entry_high) / 2;
  var sl_candidate = round0(primarySupport * 0.985);
  var sl_max = round0(entryMid * 0.95); // max 5% below entry
  var stop_loss = Math.max(sl_candidate, sl_max);
  // If SL is above entry, force it below
  if (stop_loss >= entry_low) {
    stop_loss = round0(entry_low * 0.965);
  }

  // TP1: nearest resistance
  var tp1 = round0(resistance);
  // TP2: extended resistance (resistance + half range above)
  var range = resistance - primarySupport;
  var tp2 = round0(resistance + range * 0.5);

  // Risk/Reward calculation
  var risk = entryMid - stop_loss;
  var reward1 = tp1 - entryMid;
  var risk_reward = risk > 0 ? round2(reward1 / risk) : 0;

  // Invalidation level
  var invalidation = 'Close < ' + round0(stop_loss);

  // Detect distribution candle (large red candle with high volume)
  var lastCandle = candles[lastIdx];
  var bodySize = Math.abs(lastCandle.close - lastCandle.open);
  var totalRange = lastCandle.high - lastCandle.low;
  var isLargeRed = lastCandle.close < lastCandle.open && bodySize > totalRange * 0.6 && volumes[lastIdx] > volAvg20 * 1.5;

  // Detect overextended (price far above MA20)
  var overextended = ma20 > 0 ? (last_price - ma20) / ma20 > 0.08 : false;

  return {
    last_price: round0(last_price),
    change_pct: change_pct,
    ma20: ma20 ? round0(ma20) : null,
    ma50: ma50 ? round0(ma50) : null,
    rsi14: rsi14 ? round2(rsi14) : null,
    volume_ratio_avg20: volume_ratio_avg20,
    support: round0(primarySupport),
    resistance: round0(resistance),
    entry_low: entry_low,
    entry_high: entry_high,
    stop_loss: stop_loss,
    tp1: tp1,
    tp2: tp2,
    risk_reward: risk_reward,
    invalidation: invalidation,
    _isLargeRed: isLargeRed,
    _overextended: overextended,
    _belowMA50: ma50 ? last_price < ma50 : false,
    _belowSupport: last_price < primarySupport,
    _slDistance: risk > 0 && entryMid > 0 ? round2(risk / entryMid * 100) : 99
  };
}

// ============================================================
// SCORING & CLASSIFICATION ENGINE
// ============================================================

function scoreAndClassify(data) {
  var score = 50; // base score

  // === TREND (max +20) ===
  if (data.ma20 && data.last_price >= data.ma20) score += 10;
  else if (data.ma20 && data.last_price >= data.ma20 * 0.98) score += 5;
  else score -= 5;

  if (data.ma50 && data.last_price >= data.ma50) score += 10;
  else if (data.ma50 && data.last_price >= data.ma50 * 0.97) score += 3;
  else score -= 10;

  // === MOMENTUM / RSI (max +15) ===
  if (data.rsi14 !== null) {
    if (data.rsi14 >= 45 && data.rsi14 <= 68) score += 15;
    else if (data.rsi14 >= 40 && data.rsi14 < 45) score += 8;
    else if (data.rsi14 > 68 && data.rsi14 <= 75) score += 5;
    else if (data.rsi14 >= 30 && data.rsi14 < 40) score += 3; // rebound zone
    else if (data.rsi14 > 75) score -= 5; // overbought
    else score -= 10; // oversold < 30
  }

  // === VOLUME (max +15) ===
  if (data.volume_ratio_avg20 >= 1.5) score += 15;
  else if (data.volume_ratio_avg20 >= 1.2) score += 12;
  else if (data.volume_ratio_avg20 >= 0.8) score += 5;
  else score -= 5; // very low volume

  // === RISK/REWARD (max +15) ===
  if (data.risk_reward >= 2.5) score += 15;
  else if (data.risk_reward >= 2.0) score += 12;
  else if (data.risk_reward >= 1.5) score += 8;
  else if (data.risk_reward >= 1.0) score += 3;
  else score -= 5;

  // === STRUCTURE / PENALTIES ===
  if (data._isLargeRed) score -= 15;
  if (data._overextended) score -= 10;
  if (data._belowSupport) score -= 15;
  if (data._slDistance > 5) score -= 8;

  // Clamp score 0-100
  score = Math.max(0, Math.min(100, score));

  // === CLASSIFICATION ===
  var status = 'Invalid';

  if (score >= 80 &&
      data.ma20 && data.last_price >= data.ma20 * 0.99 &&
      data.ma50 && data.last_price >= data.ma50 &&
      data.rsi14 !== null && data.rsi14 >= 45 && data.rsi14 <= 68 &&
      data.risk_reward >= 1.5 &&
      data._slDistance <= 5 &&
      !data._isLargeRed &&
      !data._overextended &&
      !data._belowSupport) {
    status = 'Swing Ready';
  } else if (score >= 65 && score < 80) {
    status = 'Watchlist';
  } else if (data.rsi14 !== null && data.rsi14 >= 30 && data.rsi14 <= 40 &&
             data.last_price > data.support &&
             data.volume_ratio_avg20 >= 0.8 &&
             score >= 40) {
    status = 'Rebound Speculative';
  } else {
    status = 'Invalid';
  }

  // Edge case: score >= 80 but failed strict criteria → downgrade to Watchlist
  if (score >= 80 && status !== 'Swing Ready') {
    status = 'Watchlist';
  }

  return { score: score, status: status };
}

// ============================================================
// AI CONFIRMATION (low-cost, server-side only)
// ============================================================

async function callAIConfirmation(candidates) {
  var apiKey = process.env.SCREENER_AI_API_KEY;
  var baseUrl = process.env.SCREENER_AI_BASE_URL || 'https://api.codecrafters.id/v1';
  var model = process.env.SCREENER_AI_MODEL || 'deepseek-v4-flash';
  var maxTokens = parseInt(process.env.SCREENER_AI_MAX_OUTPUT_TOKENS || '700', 10);

  if (!apiKey) return [];

  // Build compact summaries (no raw candles, cost-efficient)
  var summaries = candidates.map(function(c) {
    return {
      ticker: c.ticker,
      last: c.last_price,
      chg: c.change_pct + '%',
      ma20: c.ma20,
      ma50: c.ma50,
      rsi: c.rsi14,
      vol_ratio: c.volume_ratio_avg20,
      support: c.support,
      resistance: c.resistance,
      entry: c.entry_low + '-' + c.entry_high,
      sl: c.stop_loss,
      tp1: c.tp1,
      tp2: c.tp2,
      rr: c.risk_reward,
      score: c.score,
      status: c.status
    };
  });

  var systemPrompt = 'Kamu adalah analis teknikal saham IDX. Tugasmu: validasi kandidat swing trading 3-7 hari. Output HANYA JSON array. Untuk setiap ticker, berikan: ticker, ai_status (CONFIRMED/CAUTION/REJECT), ai_reason (1 kalimat bahasa Indonesia), ai_red_flags (array string pendek). Jangan tambahkan narasi. Jangan recommend beli. Gunakan bahasa: pantau, waspadai, invalid jika.';

  var userPrompt = 'Validasi kandidat swing berikut:\n' + JSON.stringify(summaries) + '\n\nOutput JSON array saja.';

  try {
    var response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      console.error('AI API error:', response.status);
      return [];
    }

    var data = await response.json();
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return [];

    // Parse JSON from response (may have markdown wrapping)
    var jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('AI confirmation error:', e.message);
    return [];
  }
}

// ============================================================
// YAHOO FINANCE FETCHER (60-day daily OHLCV)
// ============================================================

async function fetchCandles(ticker) {
  var symbol = ticker + '.JK';
  var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=90d&interval=1d&includePrePost=false';

  var response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });

  if (!response.ok) return null;

  var data = await response.json();
  var result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) return null;

  var timestamps = result.timestamp || [];
  var indicators = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!indicators) return null;

  var opens = indicators.open || [];
  var highs = indicators.high || [];
  var lows = indicators.low || [];
  var closes = indicators.close || [];
  var volumes = indicators.volume || [];

  var candles = [];
  for (var i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && opens[i] != null && highs[i] != null && lows[i] != null && volumes[i] != null) {
      candles.push({
        time: timestamps[i],
        open: opens[i],
        high: highs[i],
        low: lows[i],
        close: closes[i],
        volume: volumes[i]
      });
    }
  }

  return candles.length >= 20 ? candles : null;
}

// ============================================================
// HELPERS
// ============================================================

function calcMA(arr, period) {
  if (!arr || arr.length < period) return null;
  var slice = arr.slice(arr.length - period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) sum += slice[i];
  return sum / period;
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
  return 100 - (100 / (1 + rs));
}

function round2(val) { return Math.round(val * 100) / 100; }
function round0(val) { return Math.round(val); }
function delay(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

async function updateMeta(supabase, fields) {
  await supabase.from('swing_screener_meta').upsert([{
    id: 'latest',
    calculated_at: new Date().toISOString(),
    universe_count: fields.universe_count || 0,
    scanned_count: fields.scanned_count || 0,
    failed_count: fields.failed_count || 0,
    ai_called_count: fields.ai_called_count || 0,
    status: fields.status || 'pending',
    message: fields.message || null,
    updated_at: new Date().toISOString()
  }], { onConflict: 'id' });
}
