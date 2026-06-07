/**
 * Sektor Hot / Grup Konglomerat Hot — Vercel Serverless Endpoint
 *
 * Modes (existing — unchanged):
 *   GET /api/sector-hot                  → list all groups summary
 *   GET /api/sector-hot?group=CODE       → single group detail + members
 *   GET /api/sector-hot?action=refresh   → cron-protected: refresh sektor hot data
 *
 * Modes (new — screener swing konglo):
 *   GET /api/sector-hot?action=screener           → read cached screener data (login-only)
 *   GET /api/sector-hot?action=refresh-screener   → cron-protected: run screener scan + AI
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — database
 *   CRON_SECRET — cron authentication
 *   SCREENER_AI_API_KEY — AI confirmation (server-side only, never exposed)
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
    const groupCode = req.query.group || null;

    // === SCREENER READ MODE (login-gated) ===
    if (action === 'screener') {
      return await handleScreenerRead(req, res, supabase);
    }

    // === SCREENER REFRESH MODE (cron-protected) ===
    if (action === 'refresh-screener') {
      // ai=1 enables AI confirmation, ai=0 or missing = deterministic only
      var enableAI = req.query.ai === '1';
      return await handleScreenerRefresh(req, res, supabase, enableAI);
    }

    // === NON-KONGLO SCREENER: ORCHESTRATOR (GitHub Actions protected) ===
    if (action === 'nk-screener-run') {
      return await handleNkScreenerRun(req, res, supabase);
    }

    // === NON-KONGLO SCREENER: READ (login-gated, same as Konglo screener) ===
    if (action === 'nk-screener-results') {
      return await handleNkScreenerResults(req, res, supabase);
    }

    // === SEKTOR HOT REFRESH MODE (cron-protected, existing) ===
    if (action === 'refresh') {
      return await handleRefresh(req, res, supabase);
    }

    // === DETAIL MODE: single group + members (existing) ===
    if (groupCode) {
      const code = String(groupCode).toUpperCase().trim();

      const { data: groupData, error: groupErr } = await supabase
        .from('sector_hot_latest')
        .select('*')
        .eq('group_code', code)
        .maybeSingle();

      if (groupErr) {
        return res.status(200).json({ success: false, error: 'Gagal memuat data grup.' });
      }

      const { data: membersData, error: membersErr } = await supabase
        .from('sector_hot_members_latest')
        .select('*')
        .eq('group_code', code)
        .order('calculated_at', { ascending: false });

      if (membersErr) {
        return res.status(200).json({ success: false, error: 'Gagal memuat data member.' });
      }

      const { data: mappingData } = await supabase
        .from('sector_hot_group_members')
        .select('ticker, sort_order')
        .eq('group_code', code)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      const sortMap = {};
      if (mappingData) {
        mappingData.forEach(function(m) { sortMap[m.ticker] = m.sort_order; });
      }

      const sortedMembers = (membersData || []).sort(function(a, b) {
        const sa = sortMap[a.ticker] != null ? sortMap[a.ticker] : 999;
        const sb = sortMap[b.ticker] != null ? sortMap[b.ticker] : 999;
        return sa - sb;
      });

      return res.status(200).json({
        success: true,
        group: groupData || null,
        members: sortedMembers
      });
    }

    // === LIST MODE: all groups summary + meta (existing) ===
    const { data: metaData } = await supabase
      .from('sector_hot_meta')
      .select('*')
      .eq('id', 'latest')
      .maybeSingle();

    const { data: groupsData, error: groupsErr } = await supabase
      .from('sector_hot_latest')
      .select('*')
      .order('avg_change_pct', { ascending: false });

    if (groupsErr) {
      return res.status(200).json({ success: false, error: 'Gagal memuat data sektor.' });
    }

    const groups = (groupsData || []).sort(function(a, b) {
      const aChg = a.avg_change_pct != null ? a.avg_change_pct : -9999;
      const bChg = b.avg_change_pct != null ? b.avg_change_pct : -9999;
      if (bChg !== aChg) return bChg - aChg;
      const aVol = a.avg_volume_ratio != null ? a.avg_volume_ratio : 0;
      const bVol = b.avg_volume_ratio != null ? b.avg_volume_ratio : 0;
      if (bVol !== aVol) return bVol - aVol;
      return (a.group_name || '').localeCompare(b.group_name || '');
    });

    return res.status(200).json({
      success: true,
      meta: metaData || { calculated_at: null, status: 'pending', message: 'Awaiting first calculation.', scanned_count: 0, failed_count: 0 },
      groups: groups
    });

  } catch (e) {
    console.error('sector-hot exception:', e);
    return res.status(200).json({ success: false, error: 'Terjadi kesalahan: ' + e.message });
  }
};

// ============================================================
// SCREENER READ — login-gated via X-User-Id header
// ============================================================
async function handleScreenerRead(req, res, supabase) {
  // Server-side access control via X-User-Id (UUID) and X-Username headers
  // Frontend sends both: UUID if available, username always
  var rawUserId = (req.headers['x-user-id'] || '').trim();
  var rawUsername = (req.headers['x-username'] || '').trim().toLowerCase();

  if (!rawUserId && !rawUsername) {
    return res.status(403).json({ success: false, error: 'Login diperlukan untuk mengakses Screener.' });
  }
  if (rawUsername === 'guest') {
    return res.status(403).json({ success: false, error: 'Login diperlukan untuk mengakses Screener.' });
  }

  var userData = null;

  // 1. Try lookup by UUID if it looks valid
  if (rawUserId && rawUserId.includes('-') && rawUserId.length > 30) {
    var r1 = await supabase
      .from('app_users')
      .select('id, username, is_approved, is_blocked')
      .eq('id', rawUserId)
      .maybeSingle();
    if (r1.data) userData = r1.data;
  }

  // 2. Fallback: lookup by username
  if (!userData && rawUsername && rawUsername.length >= 2) {
    var r2 = await supabase
      .from('app_users')
      .select('id, username, is_approved, is_blocked')
      .eq('username', rawUsername)
      .maybeSingle();
    if (r2.data) userData = r2.data;
  }

  // 3. Fallback: try ilike match for username (case-insensitive safety)
  if (!userData && rawUsername && rawUsername.length >= 2) {
    var r3 = await supabase
      .from('app_users')
      .select('id, username, is_approved, is_blocked')
      .ilike('username', rawUsername)
      .maybeSingle();
    if (r3.data) userData = r3.data;
  }

  if (!userData) {
    return res.status(403).json({ success: false, error: 'User tidak ditemukan. Pastikan akun terdaftar.' });
  }

  if (userData.is_blocked) {
    return res.status(403).json({ success: false, error: 'Akun diblokir.' });
  }

  if (userData.is_approved === false) {
    return res.status(403).json({ success: false, error: 'Akun belum di-approve.' });
  }

  // User verified — return cached screener data
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
// SCREENER REFRESH — cron-protected
// ============================================================
async function handleScreenerRefresh(req, res, supabase, enableAI) {
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
      await updateScreenerMeta(supabase, { universe_count: 0, scanned_count: 0, failed_count: 0, ai_called_count: 0, status: 'failed', message: 'No active members found.' });
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
        var candles = await fetchScreenerCandles(item.ticker);
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
          last_price: analysis.last_price,
          change_pct: analysis.change_pct,
          ma20: analysis.ma20,
          ma50: analysis.ma50,
          rsi14: analysis.rsi14,
          volume_ratio_avg20: analysis.volume_ratio_avg20,
          support: analysis.support,
          resistance: analysis.resistance,
          entry_low: analysis.entry_low,
          entry_high: analysis.entry_high,
          stop_loss: analysis.stop_loss,
          tp1: analysis.tp1,
          tp2: analysis.tp2,
          risk_reward: analysis.risk_reward,
          invalidation: analysis.invalidation,
          score: scoring.score,
          status: scoring.status,
          status_reason: scoring.status_reason
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
      await updateScreenerMeta(supabase, { universe_count: universeCount, scanned_count: scannedCount, failed_count: failedCount, ai_called_count: 0, status: 'failed', message: 'All ticker fetches failed.' });
      return res.status(200).json({ success: false, error: 'All fetches failed.' });
    }

    // 3. AI Confirmation for radar candidates (only if enableAI=true)
    //    Radar = READY, REBOUND, WATCH (exclude INVALID/UNKNOWN)
    //    Priority: READY > REBOUND > WATCH, then higher score
    //    Batched: smaller groups to avoid finish_reason=length
    var aiCalledCount = 0;
    var aiAttempted = 0;
    var aiEligibleCount = 0;
    var aiSkippedCount = 0;
    var aiDiagnostic = '';
    var aiResponseDebug = null;
    var aiParseDebug = null;
    var maxCandidates = parseInt(process.env.SCREENER_AI_MAX_CANDIDATES || '30', 10);
    var aiBatchSize = parseInt(process.env.SCREENER_AI_BATCH_SIZE || '5', 10);
    var maxOutputTokens = parseInt(process.env.SCREENER_AI_MAX_OUTPUT_TOKENS || '2000', 10);
    var aiModelUsed = process.env.SCREENER_AI_MODEL || 'deepseek-v4-flash';

    // Filter: only radar statuses using normalized canonical values
    var aiEligible = results.filter(function(r) {
      var canonical = normalizeScreenerStatus(r.status);
      return canonical === 'READY' || canonical === 'REBOUND' || canonical === 'WATCH';
    });
    aiEligibleCount = aiEligible.length;

    // Priority sort: READY=1, REBOUND=2, WATCH=3, then score desc
    aiEligible.sort(function(a, b) {
      var pa = getCanonicalPriority(a.status);
      var pb = getCanonicalPriority(b.status);
      if (pa !== pb) return pa - pb;
      return b.score - a.score;
    });

    // Apply safety cap (dynamic count up to env-configured max)
    var aiCandidates = aiEligible.slice(0, maxCandidates);
    aiSkippedCount = Math.max(0, aiEligibleCount - aiCandidates.length);

    // Batch tracking
    var aiBatchCount = 0;
    var aiBatchesAttempted = 0;
    var aiBatchesSucceeded = 0;
    var aiBatchesFailed = 0;
    var aiBatchDiagnostics = [];
    var aiUsageDebug = null;

    if (enableAI && aiCandidates.length > 0 && process.env.SCREENER_AI_API_KEY) {
      aiAttempted = aiCandidates.length;

      // Split candidates into batches
      var batches = [];
      for (var bi = 0; bi < aiCandidates.length; bi += aiBatchSize) {
        batches.push(aiCandidates.slice(bi, bi + aiBatchSize));
      }
      aiBatchCount = batches.length;

      var allAIResults = [];
      var lastUsage = null;

      for (var batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        aiBatchesAttempted++;
        var batchCandidates = batches[batchIdx];
        var batchTickers = batchCandidates.map(function(c) { return c.ticker; });

        var aiResult = await callAIConfirmation(batchCandidates);

        // Collect usage from last batch for diagnostics
        if (aiResult.usage) lastUsage = aiResult.usage;

        if (aiResult.data && aiResult.data.length > 0) {
          aiBatchesSucceeded++;
          allAIResults = allAIResults.concat(aiResult.data);
          aiBatchDiagnostics.push('Batch ' + (batchIdx + 1) + '/' + batches.length + ': OK ' + aiResult.data.length + ' items (' + batchTickers.join(',') + ')');
        } else {
          aiBatchesFailed++;
          var batchDiag = 'Batch ' + (batchIdx + 1) + '/' + batches.length + ': FAILED (' + batchTickers.join(',') + ') — ' + (aiResult.diagnostic || 'unknown');
          aiBatchDiagnostics.push(batchDiag);
          // Capture debug from first failed batch only
          if (!aiResponseDebug && aiResult.ai_response_debug) aiResponseDebug = aiResult.ai_response_debug;
          if (!aiParseDebug && aiResult.ai_parse_debug) aiParseDebug = aiResult.ai_parse_debug;
        }

        // Small delay between batches to avoid rate limiting
        if (batchIdx < batches.length - 1) {
          await delay(500);
        }
      }

      // Set usage debug from last available
      if (lastUsage) {
        aiUsageDebug = {
          prompt_tokens: lastUsage.prompt_tokens || 0,
          completion_tokens: lastUsage.completion_tokens || 0,
          total_tokens: lastUsage.total_tokens || 0,
          cached_tokens: lastUsage.cached_tokens || lastUsage.prompt_cache_hit_tokens || 0,
          finish_reason: lastUsage._finish_reason || 'n/a'
        };
      }

      // Merge AI results back — normalize ticker matching (case-insensitive, trim, remove .JK)
      var aiMap = {};
      if (allAIResults.length > 0) {
        allAIResults.forEach(function(ar) {
          if (ar && ar.ticker && ar.ai_status) {
            var normalizedTicker = String(ar.ticker).trim().toUpperCase().replace(/\.JK$/i, '');
            aiMap[normalizedTicker] = ar;
          }
        });
      }

      // Track unmatched AI tickers for diagnostics
      var matchedTickers = [];

      results = results.map(function(r) {
        var normalizedR = String(r.ticker).trim().toUpperCase();
        var ai = aiMap[normalizedR];
        if (ai) {
          r.ai_status = String(ai.ai_status).toUpperCase().trim();
          // Normalize ai_status to expected values
          if (r.ai_status !== 'CONFIRMED' && r.ai_status !== 'CAUTION' && r.ai_status !== 'REJECT') {
            r.ai_status = null; // invalid value, skip
          } else {
            r.ai_reason = ai.ai_reason || null;
            r.ai_red_flags = Array.isArray(ai.ai_red_flags) ? ai.ai_red_flags : [];
            aiCalledCount++;
            matchedTickers.push(normalizedR);
            // Downgrade if AI rejects
            if (r.ai_status === 'REJECT' && r.status === 'Swing Ready') {
              r.final_status = 'Watchlist';
            } else if (r.ai_status === 'CAUTION' && r.status === 'Swing Ready') {
              r.final_status = r.status;
            } else {
              r.final_status = r.status;
            }
          }
        }
        if (!r.final_status) r.final_status = r.status;
        return r;
      });

      // Build diagnostic summary
      aiDiagnostic = 'Batches: ' + aiBatchesSucceeded + '/' + aiBatchCount + ' succeeded.';
      if (allAIResults.length > 0 && aiCalledCount === 0) {
        aiDiagnostic += ' | Ticker match failed. AI returned: ' + allAIResults.slice(0, 3).map(function(a) { return a.ticker; }).join(',') + '. Expected: ' + aiCandidates.slice(0, 3).map(function(c) { return c.ticker; }).join(',');
      } else if (aiCalledCount > 0) {
        aiDiagnostic += ' | Matched ' + aiCalledCount + '/' + allAIResults.length + ' tickers.';
      }
      if (aiSkippedCount > 0) {
        aiDiagnostic += ' | Skipped ' + aiSkippedCount + ' eligible candidates (cap=' + maxCandidates + ').';
      }

    } else if (!enableAI) {
      aiDiagnostic = 'AI disabled for this refresh (ai=0).';
      results = results.map(function(r) { r.final_status = r.status; return r; });
    } else if (aiCandidates.length > 0 && !process.env.SCREENER_AI_API_KEY) {
      aiDiagnostic = 'AI skipped: SCREENER_AI_API_KEY not configured.';
      results = results.map(function(r) { r.final_status = r.status; return r; });
    } else {
      aiDiagnostic = aiEligibleCount === 0 ? 'No radar candidates (all Invalid).' : 'No eligible candidates after filtering.';
      results = results.map(function(r) { r.final_status = r.status; return r; });
    }

    // 4. Save results to Supabase
    var now = new Date().toISOString();
    var savedCount = 0;
    var saveError = null;

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
        status_reason: r.status_reason || null,
        ai_status: r.ai_status || null,
        ai_reason: r.ai_reason || null,
        ai_red_flags: r.ai_red_flags ? '{' + r.ai_red_flags.map(function(f) { return '"' + String(f).replace(/"/g, '\\"') + '"'; }).join(',') + '}' : null,
        final_status: r.final_status,
        calculated_at: now
      };
    });

    if (upsertRows.length > 0) {
      // Delete old data first
      var { error: delError } = await supabase.from('swing_screener_latest').delete().neq('ticker', '');
      if (delError) {
        console.error('Screener delete error:', delError.message);
        saveError = 'Delete failed: ' + delError.message;
      }

      if (!saveError) {
        // Insert in batches of 50 to avoid payload limits
        var batchSize = 50;
        for (var b = 0; b < upsertRows.length; b += batchSize) {
          var batch = upsertRows.slice(b, b + batchSize);
          var { error: insError, data: insData } = await supabase.from('swing_screener_latest').insert(batch).select('ticker');
          if (insError) {
            console.error('Screener insert error (batch ' + b + '):', insError.message, insError.details, insError.hint);
            saveError = 'Insert failed: ' + insError.message + (insError.details ? ' | ' + insError.details : '') + (insError.hint ? ' | Hint: ' + insError.hint : '');
            break;
          }
          savedCount += (insData ? insData.length : batch.length);
        }
      }
    }

    // 5. Update meta — only mark ok if rows were saved
    var metaStatus = savedCount > 0 ? 'ok' : 'failed';
    var metaMsg = 'Scanned: ' + scannedCount + ', Generated: ' + results.length + ', Saved: ' + savedCount + ', AI: ' + aiCalledCount + '/' + aiAttempted;
    if (aiDiagnostic) metaMsg += ' | AI: ' + aiDiagnostic;
    if (saveError) metaMsg += ' | Error: ' + saveError;

    await updateScreenerMeta(supabase, {
      universe_count: universeCount,
      scanned_count: scannedCount,
      failed_count: failedCount,
      ai_called_count: aiCalledCount,
      status: metaStatus,
      message: metaMsg
    });

    return res.status(200).json({
      success: savedCount > 0,
      message: savedCount > 0 ? 'Screener refresh completed.' : 'Refresh failed to save rows.',
      ai_enabled: enableAI,
      ai_model_used: aiModelUsed,
      ai_max_candidates_used: maxCandidates,
      ai_max_output_tokens_used: maxOutputTokens,
      ai_batch_size: aiBatchSize,
      universe_count: universeCount,
      scanned_count: scannedCount,
      generated_count: results.length,
      saved_count: savedCount,
      failed_count: failedCount,
      ai_eligible_count: aiEligibleCount,
      ai_attempted: aiAttempted,
      ai_called_count: aiCalledCount,
      ai_candidates_sent: aiCandidates.map(function(c) { return c.ticker; }),
      ai_skipped_count: aiSkippedCount,
      ai_batch_count: aiBatchCount,
      ai_batches_attempted: aiBatchesAttempted,
      ai_batches_succeeded: aiBatchesSucceeded,
      ai_batches_failed: aiBatchesFailed,
      ai_batch_diagnostics: aiBatchDiagnostics.length > 0 ? aiBatchDiagnostics : undefined,
      ai_usage_debug: aiUsageDebug || undefined,
      ai_diagnostic: aiDiagnostic,
      ai_response_debug: aiResponseDebug || undefined,
      ai_parse_debug: aiParseDebug || undefined,
      save_error: saveError || null
    });

  } catch (e) {
    console.error('screener refresh error:', e.message);
    await updateScreenerMeta(supabase, { universe_count: 0, scanned_count: 0, failed_count: 0, ai_called_count: 0, status: 'failed', message: 'Refresh error: ' + e.message });
    return res.status(200).json({ success: false, error: 'Screener refresh failed: ' + e.message });
  }
}

// ============================================================
// SEKTOR HOT REFRESH HANDLER (existing — unchanged)
// ============================================================
async function handleRefresh(req, res, supabase) {
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
    const { data: groups, error: gErr } = await supabase
      .from('sector_hot_groups')
      .select('group_code, group_name, owner_label')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (gErr || !groups || groups.length === 0) {
      await updateMeta(supabase, 0, 0, 'failed', 'No active groups found.');
      return res.status(200).json({ success: false, error: 'No active groups.' });
    }

    const { data: members, error: mErr } = await supabase
      .from('sector_hot_group_members')
      .select('group_code, ticker, stock_name, member_type, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (mErr || !members || members.length === 0) {
      await updateMeta(supabase, 0, 0, 'failed', 'No active members found.');
      return res.status(200).json({ success: false, error: 'No active members.' });
    }

    const uniqueTickers = [];
    const tickerSet = {};
    members.forEach(function(m) {
      if (!tickerSet[m.ticker]) { tickerSet[m.ticker] = true; uniqueTickers.push(m.ticker); }
    });

    const quoteCache = {};
    var scannedCount = 0;
    var failedCount = 0;

    for (var i = 0; i < uniqueTickers.length; i++) {
      var ticker = uniqueTickers[i];
      scannedCount++;
      try {
        var quote = await fetchYahooQuote(ticker);
        if (quote) { quoteCache[ticker] = quote; }
        else { failedCount++; }
      } catch (e) { failedCount++; }
      if (i < uniqueTickers.length - 1) {
        await delay(200);
      }
    }

    if (failedCount === scannedCount) {
      await updateMeta(supabase, scannedCount, failedCount, 'failed', 'All ticker fetches failed.');
      return res.status(200).json({ success: false, error: 'All fetches failed.', scannedCount: scannedCount, failedCount: failedCount });
    }

    const now = new Date().toISOString();
    var groupsProcessed = 0;

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var groupMembers = members.filter(function(m) { return m.group_code === group.group_code; });
      if (groupMembers.length === 0) continue;

      var memberRows = [];
      var validCount = 0;
      var totalChangePct = 0;
      var totalVolRatio = 0;
      var topTicker = null;
      var topChangePct = -Infinity;

      for (var m = 0; m < groupMembers.length; m++) {
        var member = groupMembers[m];
        var q = quoteCache[member.ticker];

        memberRows.push({
          group_code: group.group_code,
          ticker: member.ticker,
          stock_name: member.stock_name,
          last_price: q ? q.lastPrice : null,
          change_pct: q ? q.changePct : null,
          volume_today: q ? q.volumeToday : null,
          avg_volume_30d: q ? q.avgVolume30d : null,
          volume_ratio_30d: q ? q.volumeRatio30d : null,
          member_type: member.member_type,
          calculated_at: now
        });

        if (q) {
          validCount++;
          totalChangePct += q.changePct;
          totalVolRatio += q.volumeRatio30d;
          if (q.changePct > topChangePct) { topChangePct = q.changePct; topTicker = member.ticker; }
        }
      }

      await supabase.from('sector_hot_members_latest').upsert(memberRows, { onConflict: 'group_code,ticker' });

      var avgChangePct = validCount > 0 ? Math.round((totalChangePct / validCount) * 100) / 100 : null;
      var avgVolRatio = validCount > 0 ? Math.round((totalVolRatio / validCount) * 100) / 100 : null;

      await supabase.from('sector_hot_latest').upsert([{
        group_code: group.group_code,
        group_name: group.group_name,
        owner_label: group.owner_label,
        avg_change_pct: avgChangePct,
        stock_count: groupMembers.length,
        valid_count: validCount,
        top_ticker: topTicker,
        top_change_pct: topChangePct !== -Infinity ? Math.round(topChangePct * 100) / 100 : null,
        avg_volume_ratio: avgVolRatio,
        calculated_at: now,
        status: validCount > 0 ? 'ok' : 'no_data',
        message: null
      }], { onConflict: 'group_code' });

      groupsProcessed++;
    }

    await updateMeta(supabase, scannedCount, failedCount, 'ok', 'Refresh completed. Groups: ' + groupsProcessed);

    return res.status(200).json({
      success: true,
      message: 'Refresh completed.',
      scannedCount: scannedCount,
      failedCount: failedCount,
      groupsProcessed: groupsProcessed
    });

  } catch (e) {
    console.error('sector-hot refresh error:', e.message);
    await updateMeta(supabase, 0, 0, 'failed', 'Refresh error: ' + e.message);
    return res.status(200).json({ success: false, error: 'Refresh failed: ' + e.message });
  }
}

// ============================================================
// SCREENER: TECHNICAL INDICATOR CALCULATIONS
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

  var ma20 = calcScreenerMA(closes, 20);
  var ma50 = calcScreenerMA(closes, 50);
  var rsi14 = calcScreenerRSI(closes, 14);
  var volAvg20 = calcScreenerMA(volumes, 20);
  var volume_ratio_avg20 = volAvg20 > 0 ? round2(volumes[lastIdx] / volAvg20) : 0;

  // Support: lowest low of last 20 candles
  var recent20Lows = lows.slice(-20);
  var support = Math.min.apply(null, recent20Lows);

  // Resistance: highest high of last 20 candles
  var recent20Highs = highs.slice(-20);
  var resistance = Math.max.apply(null, recent20Highs);

  // Alternative support: 3rd lowest of last 30 days
  var recent30Lows = lows.slice(-30).sort(function(a, b) { return a - b; });
  var support2 = recent30Lows.length >= 3 ? recent30Lows[2] : support;

  var primarySupport = Math.max(support, support2 * 0.99);
  if (primarySupport >= last_price) {
    primarySupport = support;
  }

  // Entry area
  var entryBase = Math.max(primarySupport, ma20 ? ma20 * 0.99 : primarySupport);
  var entry_low = round0(Math.min(entryBase, last_price * 0.98));
  var entry_high = round0(last_price * 1.005);

  // Stop loss
  var entryMid = (entry_low + entry_high) / 2;
  var sl_candidate = round0(primarySupport * 0.985);
  var sl_max = round0(entryMid * 0.95);
  var stop_loss = Math.max(sl_candidate, sl_max);
  if (stop_loss >= entry_low) {
    stop_loss = round0(entry_low * 0.965);
  }

  // TP levels
  var tp1 = round0(resistance);
  var range = resistance - primarySupport;
  var tp2 = round0(resistance + range * 0.5);

  // Risk/Reward
  var risk = entryMid - stop_loss;
  var reward1 = tp1 - entryMid;
  var risk_reward = risk > 0 ? round2(reward1 / risk) : 0;

  var invalidation = 'Close < ' + round0(stop_loss);

  // Detect distribution candle
  var lastCandle = candles[lastIdx];
  var bodySize = Math.abs(lastCandle.close - lastCandle.open);
  var totalRange = lastCandle.high - lastCandle.low;
  var isLargeRed = lastCandle.close < lastCandle.open && bodySize > totalRange * 0.6 && volumes[lastIdx] > volAvg20 * 1.5;

  // Detect overextended
  var overextended = ma20 > 0 ? (last_price - ma20) / ma20 > 0.08 : false;

  return {
    last_price: round0(last_price),
    change_pct: change_pct,
    ma20: ma20 !== null ? round0(ma20) : null,
    ma50: ma50 !== null ? round0(ma50) : null,
    rsi14: rsi14 !== null ? round2(rsi14) : null,
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
// SCREENER: SCORING & CLASSIFICATION
// ============================================================

function scoreAndClassify(data) {
  var score = 50;

  // TREND
  if (data.ma20 && data.last_price >= data.ma20) score += 10;
  else if (data.ma20 && data.last_price >= data.ma20 * 0.98) score += 5;
  else score -= 5;

  if (data.ma50 && data.last_price >= data.ma50) score += 10;
  else if (data.ma50 && data.last_price >= data.ma50 * 0.97) score += 3;
  else score -= 10;

  // MOMENTUM / RSI
  if (data.rsi14 !== null) {
    if (data.rsi14 >= 45 && data.rsi14 <= 68) score += 15;
    else if (data.rsi14 >= 40 && data.rsi14 < 45) score += 8;
    else if (data.rsi14 > 68 && data.rsi14 <= 75) score += 5;
    else if (data.rsi14 >= 30 && data.rsi14 < 40) score += 3;
    else if (data.rsi14 > 75) score -= 5;
    else score -= 10;
  }

  // VOLUME
  if (data.volume_ratio_avg20 >= 1.5) score += 15;
  else if (data.volume_ratio_avg20 >= 1.2) score += 12;
  else if (data.volume_ratio_avg20 >= 0.8) score += 5;
  else score -= 5;

  // RISK/REWARD
  if (data.risk_reward >= 2.5) score += 15;
  else if (data.risk_reward >= 2.0) score += 12;
  else if (data.risk_reward >= 1.5) score += 8;
  else if (data.risk_reward >= 1.0) score += 3;
  else score -= 5;

  // PENALTIES
  if (data._isLargeRed) score -= 15;
  if (data._overextended) score -= 10;
  if (data._belowSupport) score -= 15;
  if (data._slDistance > 5) score -= 8;

  score = Math.max(0, Math.min(100, score));

  // CLASSIFICATION with hard filters and reason tracking
  var status = 'Invalid';
  var status_reason = '';

  // Check hard filters for Swing Ready
  var passesAllHardFilters = true;
  var failReasons = [];

  if (score < 80) { passesAllHardFilters = false; failReasons.push('Score < 80'); }
  if (!(data.ma20 && data.last_price >= data.ma20 * 0.99)) { passesAllHardFilters = false; failReasons.push('Di bawah MA20'); }
  if (!(data.ma50 && data.last_price >= data.ma50)) { passesAllHardFilters = false; failReasons.push('Di bawah MA50'); }
  if (!(data.rsi14 !== null && data.rsi14 >= 45 && data.rsi14 <= 68)) {
    passesAllHardFilters = false;
    if (data.rsi14 === null) failReasons.push('RSI tidak tersedia');
    else if (data.rsi14 > 68) failReasons.push('RSI terlalu tinggi');
    else if (data.rsi14 < 45) failReasons.push('RSI terlalu rendah');
    else failReasons.push('RSI tidak ideal');
  }
  if (!(data.volume_ratio_avg20 >= 1.0)) { passesAllHardFilters = false; failReasons.push('Volume belum cukup'); }
  if (!(data.risk_reward >= 1.5)) { passesAllHardFilters = false; failReasons.push('RR kurang layak'); }
  if (!(data._slDistance <= 5)) { passesAllHardFilters = false; failReasons.push('SL terlalu jauh'); }
  if (data._isLargeRed) { passesAllHardFilters = false; failReasons.push('Candle distribusi'); }
  if (data._overextended) { passesAllHardFilters = false; failReasons.push('Overextended'); }
  if (data._belowSupport) { passesAllHardFilters = false; failReasons.push('Breakdown support'); }

  if (passesAllHardFilters) {
    status = 'Swing Ready';
    status_reason = 'Setup lengkap: trend, momentum, volume, RR layak.';
  } else if (data.rsi14 !== null && data.rsi14 >= 30 && data.rsi14 <= 40 &&
             data.last_price > data.support &&
             data.volume_ratio_avg20 >= 0.8 &&
             score >= 40) {
    status = 'Rebound Speculative';
    status_reason = 'Potensi rebound dari support. Risiko tinggi.';
  } else if (score >= 65) {
    status = 'Watchlist';
    // Build reason from first 2 fail reasons
    status_reason = failReasons.length > 0 ? 'Tunggu: ' + failReasons.slice(0, 2).join(', ') : 'Menunggu konfirmasi.';
  } else {
    status = 'Invalid';
    status_reason = failReasons.length > 0 ? failReasons.slice(0, 2).join(', ') : 'Setup tidak memenuhi kriteria.';
  }

  return { score: score, status: status, status_reason: status_reason };
}

// ============================================================
// SCREENER: AI CONFIRMATION (server-side only)
// ============================================================

async function callAIConfirmation(candidates) {
  var apiKey = process.env.SCREENER_AI_API_KEY;
  var baseUrl = process.env.SCREENER_AI_BASE_URL || 'https://api.codecrafters.id/v1';
  var model = process.env.SCREENER_AI_MODEL || 'deepseek-v4-flash';
  var maxTokens = parseInt(process.env.SCREENER_AI_MAX_OUTPUT_TOKENS || '2000', 10);

  if (!apiKey) return { data: [], diagnostic: 'API key missing.' };

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

  var systemPrompt = 'Kamu adalah analis teknikal saham IDX. Validasi kandidat swing trading 3-7 hari. ATURAN OUTPUT: 1) Return HANYA valid JSON array, bisa langsung di-parse oleh JSON.parse. 2) Semua key harus pakai double-quote. 3) Semua string value harus pakai double-quote. 4) Tidak boleh trailing comma. 5) Tidak boleh komentar. 6) Tidak boleh markdown atau penjelasan. Contoh format valid: [{"ticker":"BBCA","ai_status":"CONFIRMED","ai_reason":"Trend kuat di atas MA20","ai_red_flags":[],"final_status":"Swing Ready"}]';

  var userPrompt = 'Validasi kandidat berikut. Gunakan ticker PERSIS tanpa .JK.\n' + JSON.stringify(summaries) + '\n\nReturn HANYA JSON array. Setiap item: {"ticker":"...","ai_status":"CONFIRMED/CAUTION/REJECT","ai_reason":"...","ai_red_flags":[...],"final_status":"..."}. Jangan tambahkan teks lain.';

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
        temperature: 0.2
      })
    });

    if (!response.ok) {
      var errStatus = response.status;
      var errText = '';
      try { errText = await response.text(); } catch(e2) {}
      console.error('Screener AI API error: HTTP ' + errStatus);
      return { data: [], diagnostic: 'AI HTTP ' + errStatus + '. Length: ' + (errText ? errText.length : 0) + '. Body: ' + (errText ? errText.substring(0, 120) : '(empty)') };
    }

    var rawText = await response.text();
    var data;
    try {
      data = JSON.parse(rawText);
    } catch (jsonErr) {
      return { data: [], diagnostic: 'AI response not JSON. Length: ' + rawText.length + '. Start: ' + rawText.substring(0, 120) };
    }

    // Extract content from multiple possible response formats
    var content = null;
    var responseKeys = Object.keys(data || {}).join(',');
    var extractPath = '';

    // Deep inspection of choices[0] for diagnostics
    var choice0 = (data.choices && data.choices[0]) || null;
    var choice0Keys = choice0 ? Object.keys(choice0).join(',') : 'n/a';
    var msg = (choice0 && choice0.message) || null;
    var msgKeys = msg ? Object.keys(msg).join(',') : 'n/a';
    var finishReason = choice0 ? (choice0.finish_reason || choice0.stop_reason || 'n/a') : 'n/a';

    // Try extracting from choices[0].message fields
    if (msg) {
      // Standard: message.content (string)
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        content = msg.content;
        extractPath = 'choices[0].message.content';
      }
      // DeepSeek: message.content is array [{type:"text", text:"..."}]
      if (!content && Array.isArray(msg.content) && msg.content.length > 0) {
        var textParts = msg.content.filter(function(p) { return p && (p.type === 'text' || p.text); });
        if (textParts.length > 0) {
          content = textParts.map(function(p) { return p.text || ''; }).join('');
          extractPath = 'choices[0].message.content[].text (array)';
        }
      }
      // DeepSeek reasoning models: message.reasoning_content
      if (!content && typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
        content = msg.reasoning_content;
        extractPath = 'choices[0].message.reasoning_content';
      }
      // Alternative: message.text
      if (!content && typeof msg.text === 'string' && msg.text.length > 0) {
        content = msg.text;
        extractPath = 'choices[0].message.text';
      }
    }

    // choices[0].text (completions format)
    if (!content && choice0 && typeof choice0.text === 'string' && choice0.text.length > 0) {
      content = choice0.text;
      extractPath = 'choices[0].text';
    }

    // choices[0].delta.content (streaming leftover)
    if (!content && choice0 && choice0.delta && typeof choice0.delta.content === 'string' && choice0.delta.content.length > 0) {
      content = choice0.delta.content;
      extractPath = 'choices[0].delta.content';
    }

    // data.output_text
    if (!content && typeof data.output_text === 'string' && data.output_text.length > 0) {
      content = data.output_text;
      extractPath = 'output_text';
    }

    // data.output[0].content[0].text or data.output[0].text
    if (!content && data.output && Array.isArray(data.output) && data.output[0]) {
      var out0 = data.output[0];
      if (out0.content && Array.isArray(out0.content) && out0.content[0] && out0.content[0].text) {
        content = out0.content[0].text;
        extractPath = 'output[0].content[0].text';
      } else if (typeof out0.text === 'string' && out0.text.length > 0) {
        content = out0.text;
        extractPath = 'output[0].text';
      }
    }

    // data.content / data.result / data.response
    if (!content && data.content && typeof data.content === 'string' && data.content.length > 0) {
      content = data.content;
      extractPath = 'content';
    }
    if (!content && data.result) {
      content = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
      extractPath = 'result';
    }
    if (!content && data.response) {
      content = typeof data.response === 'string' ? data.response : JSON.stringify(data.response);
      extractPath = 'response';
    }

    if (!content) {
      // Build structured debug object for safe inspection
      var msgContentVal = msg ? String(msg.content).substring(0, 80) : 'n/a';
      var msgContentType = msg ? (msg.content === null ? 'null' : Array.isArray(msg.content) ? 'array(' + msg.content.length + ')' : typeof msg.content + '(' + String(msg.content).length + ')') : 'n/a';
      var reasoningType = (msg && msg.reasoning_content != null) ? typeof msg.reasoning_content + '(' + String(msg.reasoning_content).length + ')' : 'absent';
      var reasoningPreview = (msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) ? msg.reasoning_content.substring(0, 80) : null;

      var debugObj = {
        http_status: 200,
        content_type: response.headers.get('content-type') || 'unknown',
        raw_length: rawText.length,
        json_parse_ok: true,
        top_keys: responseKeys,
        choices_length: data.choices ? data.choices.length : 0,
        choice0_keys: choice0Keys,
        finish_reason: finishReason,
        message_exists: !!msg,
        message_keys: msgKeys,
        message_role: msg ? msg.role : 'n/a',
        message_content_type: msgContentType,
        message_content_length: (msg && msg.content != null) ? String(msg.content).length : 0,
        message_content_is_null: msg ? msg.content === null : 'n/a',
        message_content_is_empty_string: msg ? msg.content === '' : 'n/a',
        message_content_preview: msgContentVal,
        reasoning_content_type: reasoningType,
        reasoning_content_length: (msg && msg.reasoning_content != null) ? String(msg.reasoning_content).length : 0,
        reasoning_content_preview: reasoningPreview,
        text_type: (msg && msg.text != null) ? typeof msg.text + '(' + String(msg.text).length + ')' : 'absent',
        choice0_text_type: (choice0 && choice0.text != null) ? typeof choice0.text + '(' + String(choice0.text).length + ')' : 'absent',
        delta_keys: (choice0 && choice0.delta) ? Object.keys(choice0.delta).join(',') : 'absent',
        refusal_exists: (msg && msg.refusal != null) ? String(msg.refusal).substring(0, 50) : false,
        tool_calls_exists: (msg && msg.tool_calls) ? msg.tool_calls.length : false,
        extract_path_attempted: 'all_failed'
      };

      return {
        data: [],
        diagnostic: 'AI content empty. See ai_response_debug for details.',
        ai_response_debug: debugObj,
        usage: data.usage ? Object.assign({}, data.usage, { _finish_reason: finishReason }) : { _finish_reason: finishReason }
      };
    }

    var jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // Try to extract JSON array even if there's text before/after it
    var arrayStart = jsonStr.indexOf('[');
    var arrayEnd = jsonStr.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1);
    }

    var parsed;
    var firstParseError = null;
    var repairAttempted = false;

    // Step A: Try strict JSON.parse
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      firstParseError = parseErr.message;
    }

    // Step B: If failed, try conservative repair
    if (!parsed) {
      repairAttempted = true;
      try {
        var repaired = jsonStr
          // Fix unquoted keys: word followed by colon → "word":
          .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
          // Fix single-quoted strings → double quotes (simple cases)
          .replace(/'([^'\\]*)'/g, '"$1"')
          // Remove trailing commas before } or ]
          .replace(/,\s*([}\]])/g, '$1');
        parsed = JSON.parse(repaired);
      } catch (repairErr) {
        // Step C: Final attempt — try to extract individual objects
        try {
          // Match patterns like {..."ticker"..."ai_status"...}
          var objMatches = jsonStr.match(/\{[^{}]*\}/g);
          if (objMatches && objMatches.length > 0) {
            var manualParsed = [];
            for (var oi = 0; oi < objMatches.length; oi++) {
              var objStr = objMatches[oi]
                .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
                .replace(/'([^'\\]*)'/g, '"$1"')
                .replace(/,\s*([}\]])/g, '$1');
              try {
                manualParsed.push(JSON.parse(objStr));
              } catch (e3) { /* skip unparseable objects */ }
            }
            if (manualParsed.length > 0) {
              parsed = manualParsed;
            }
          }
        } catch (e4) { /* give up */ }

        if (!parsed) {
          return {
            data: [],
            diagnostic: 'AI JSON parse failed after repair.',
            ai_parse_debug: {
              extract_path: extractPath,
              content_length: content.length,
              array_start_found: arrayStart >= 0,
              array_end_found: arrayEnd > arrayStart,
              first_parse_error: firstParseError,
              repair_attempted: true,
              second_parse_error: repairErr.message,
              raw_preview_300: jsonStr.substring(0, 300)
            },
            usage: data.usage ? Object.assign({}, data.usage, { _finish_reason: finishReason }) : { _finish_reason: finishReason }
          };
        }
      }
    }

    if (!Array.isArray(parsed)) {
      return { data: [], diagnostic: 'AI response not array. Type: ' + typeof parsed, usage: data.usage ? Object.assign({}, data.usage, { _finish_reason: finishReason }) : { _finish_reason: finishReason } };
    }

    return { data: parsed, diagnostic: 'OK. Received ' + parsed.length + ' items via ' + extractPath + '. finishReason: ' + finishReason + (repairAttempted ? '. JSON repaired.' : ''), usage: data.usage ? Object.assign({}, data.usage, { _finish_reason: finishReason }) : { _finish_reason: finishReason } };
  } catch (e) {
    console.error('Screener AI confirmation error:', e.message);
    return { data: [], diagnostic: 'AI exception: ' + e.message };
  }
}

// ============================================================
// SCREENER: YAHOO FINANCE FETCHER (90-day OHLCV)
// ============================================================

async function fetchScreenerCandles(ticker) {
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
      candles.push({ time: timestamps[i], open: opens[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i] });
    }
  }

  return candles.length >= 20 ? candles : null;
}

// ============================================================
// SEKTOR HOT: YAHOO FINANCE FETCHER (existing)
// ============================================================

async function fetchYahooQuote(ticker) {
  var symbol = ticker + '.JK';
  var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=60d&interval=1d&includePrePost=false';

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

  var closes = indicators.close || [];
  var volumes = indicators.volume || [];

  var validDays = [];
  for (var i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && volumes[i] != null) {
      validDays.push({ close: closes[i], volume: volumes[i] });
    }
  }

  if (validDays.length < 2) return null;

  var latest = validDays[validDays.length - 1];
  var prev = validDays[validDays.length - 2];

  var lastPrice = latest.close;
  var prevClose = prev.close;
  var changePct = prevClose > 0 ? ((lastPrice - prevClose) / prevClose) * 100 : 0;
  var volumeToday = latest.volume;

  var histDays = validDays.slice(0, -1).slice(-30);
  var avgVolume30d = 0;
  if (histDays.length > 0) {
    var totalVol = histDays.reduce(function(sum, d) { return sum + d.volume; }, 0);
    avgVolume30d = totalVol / histDays.length;
  }

  var volumeRatio30d = avgVolume30d > 0 ? volumeToday / avgVolume30d : 0;

  return {
    lastPrice: Math.round(lastPrice * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    volumeToday: volumeToday,
    avgVolume30d: Math.round(avgVolume30d),
    volumeRatio30d: Math.round(volumeRatio30d * 100) / 100
  };
}

// ============================================================
// SHARED HELPERS
// ============================================================

/**
 * Normalize any screener status string to a canonical value.
 * Handles exact internal values, short codes, UI labels, and edge cases.
 * Returns: 'READY' | 'REBOUND' | 'WATCH' | 'INVALID' | 'UNKNOWN'
 */
function normalizeScreenerStatus(status) {
  if (!status || typeof status !== 'string') return 'UNKNOWN';
  var s = status.trim().toUpperCase();
  // Exact internal values (from scoreAndClassify)
  if (s === 'SWING READY' || s === 'READY') return 'READY';
  if (s === 'REBOUND SPECULATIVE' || s === 'REBOUND SPEC.' || s === 'REBOUND SPEC' || s === 'REBOUND') return 'REBOUND';
  if (s === 'WATCHLIST' || s === 'WATCH') return 'WATCH';
  if (s === 'INVALID') return 'INVALID';
  return 'UNKNOWN';
}

/**
 * Get sort priority based on canonical status.
 * Lower number = higher priority for AI analysis.
 */
function getCanonicalPriority(status) {
  var canonical = normalizeScreenerStatus(status);
  if (canonical === 'READY') return 1;
  if (canonical === 'REBOUND') return 2;
  if (canonical === 'WATCH') return 3;
  return 4;
}

function calcScreenerMA(arr, period) {
  if (!arr || arr.length < period) return null;
  var slice = arr.slice(arr.length - period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) sum += slice[i];
  return sum / period;
}

function calcScreenerRSI(closes, period) {
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

async function updateMeta(supabase, scannedCount, failedCount, status, message) {
  await supabase.from('sector_hot_meta').upsert([{
    id: 'latest',
    calculated_at: new Date().toISOString(),
    scanned_count: scannedCount,
    failed_count: failedCount,
    status: status,
    message: message,
    updated_at: new Date().toISOString()
  }], { onConflict: 'id' });
}

async function updateScreenerMeta(supabase, fields) {
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


// ============================================================
// NON-KONGLO SWING SCREENER v1 — Functions
// ============================================================

function verifyCronSecret(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const secret = process.env.CRON_SECRET || '';
  if (!secret || !token) return false;
  return token === secret;
}

function isWithinNkRunWindow() {
  // Valid window: Mon-Fri 19:30-21:30 WIB (UTC+7)
  const now = new Date();
  const wibOffset = 7 * 60; // minutes
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const wibMinutes = utcMinutes + wibOffset;
  const wibHour = Math.floor((wibMinutes % 1440) / 60);
  const wibMin = wibMinutes % 60;
  const wibDay = now.getUTCDay(); // 0=Sun ... 6=Sat
  // Adjust day if WIB crosses midnight
  const adjustedDay = (wibMinutes >= 1440) ? (wibDay + 1) % 7 : wibDay;

  // Must be Mon(1)-Fri(5)
  if (adjustedDay < 1 || adjustedDay > 5) return false;

  const totalMin = wibHour * 60 + wibMin;
  // 19:30 = 1170, 21:30 = 1290
  return totalMin >= 1170 && totalMin <= 1290;
}

function getWibDateString() {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 10);
}

// --- ORCHESTRATOR ---
async function handleNkScreenerRun(req, res, supabase) {
  // 1. Verify CRON_SECRET
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  // 2. Time-window guard (bypass with force=1)
  if (req.query.force !== '1' && !isWithinNkRunWindow()) {
    return res.status(200).json({ success: false, error: 'Di luar waktu operasi (19:30-21:30 WIB, Mon-Fri).', skipped: true });
  }

  const step = req.query.step || 'auto';

  // Manual step routing
  if (step === 'start') return await handleNkScreenerStart(req, res, supabase);
  if (step === 'batch') return await handleNkScreenerBatch(req, res, supabase);
  if (step === 'finalize') return await handleNkScreenerFinalize(req, res, supabase);

  // Auto mode: determine next action from meta
  const { data: meta } = await supabase
    .from('swing_screener_non_konglo_meta')
    .select('*')
    .eq('id', 'latest')
    .maybeSingle();

  const runDate = getWibDateString();

  // If no meta or different date or status is idle/published → start fresh
  if (!meta || meta.run_date !== runDate || meta.status === 'published' || meta.status === 'idle') {
    return await handleNkScreenerStart(req, res, supabase);
  }

  // If scanning, process next batch
  if (meta.status === 'scanning') {
    // Check if pending batches exist
    const { data: pendingJobs } = await supabase
      .from('swing_screener_non_konglo_jobs')
      .select('id')
      .eq('run_date', runDate)
      .eq('status', 'pending')
      .limit(1);

    if (pendingJobs && pendingJobs.length > 0) {
      return await handleNkScreenerBatch(req, res, supabase);
    }

    // No pending → check if all done
    const { data: failedJobs } = await supabase
      .from('swing_screener_non_konglo_jobs')
      .select('id')
      .eq('run_date', runDate)
      .eq('status', 'failed')
      .limit(1);

    // All batches done (none pending, possibly some failed) → finalize
    return await handleNkScreenerFinalize(req, res, supabase);
  }

  // If already finalizing or failed (retry finalize from staging)
  if (meta.status === 'finalizing' || meta.status === 'failed') {
    return await handleNkScreenerFinalize(req, res, supabase);
  }

  return res.status(200).json({ success: true, message: 'No action needed.', meta });
}

// --- START: build universe, create batches ---
async function handleNkScreenerStart(req, res, supabase) {
  const runDate = getWibDateString();

  // Update meta to scanning
  await updateNkMeta(supabase, { status: 'scanning', run_date: runDate, message: 'Building universe...', universe_count: 0, scanned_count: 0, failed_count: 0, published_count: 0 });

  // Get excluded tickers (tickers already in Konglo groups)
  const { data: kongloMembers } = await supabase
    .from('sector_hot_group_members')
    .select('ticker');
  const excludedTickers = new Set((kongloMembers || []).map(m => m.ticker));

  // Get eligible stocks from stock_boards
  const { data: boardStocks, error: boardErr } = await supabase
    .from('stock_boards')
    .select('ticker, board')
    .in('board', ['UTAMA', 'PENGEMBANGAN']);

  if (boardErr || !boardStocks) {
    await updateNkMeta(supabase, { status: 'failed', message: 'Gagal memuat stock_boards: ' + (boardErr ? boardErr.message : 'no data') });
    return res.status(200).json({ success: false, error: 'Failed to load stock_boards.' });
  }

  // Filter out Konglo tickers
  const universe = boardStocks.filter(s => !excludedTickers.has(s.ticker));

  if (universe.length === 0) {
    await updateNkMeta(supabase, { status: 'failed', message: 'Universe kosong setelah filter.' });
    return res.status(200).json({ success: false, error: 'Empty universe.' });
  }

  await updateNkMeta(supabase, { status: 'scanning', run_date: runDate, universe_count: universe.length, message: 'Creating batches...' });

  // Clear old jobs and staging for this run_date
  await supabase.from('swing_screener_non_konglo_jobs').delete().eq('run_date', runDate);
  await supabase.from('swing_screener_non_konglo_staging').delete().eq('run_date', runDate);

  // Create batches of 15
  const BATCH_SIZE = 15;
  const batches = [];
  for (let i = 0; i < universe.length; i += BATCH_SIZE) {
    const batch = universe.slice(i, i + BATCH_SIZE);
    batches.push({
      run_date: runDate,
      batch_index: Math.floor(i / BATCH_SIZE),
      tickers: batch.map(s => s.ticker),
      boards: batch.reduce((acc, s) => { acc[s.ticker] = s.board; return acc; }, {}),
      status: 'pending',
      created_at: new Date().toISOString()
    });
  }

  const { error: insertErr } = await supabase
    .from('swing_screener_non_konglo_jobs')
    .insert(batches);

  if (insertErr) {
    await updateNkMeta(supabase, { status: 'failed', message: 'Gagal membuat batch jobs: ' + insertErr.message });
    return res.status(200).json({ success: false, error: 'Failed to create batch jobs.' });
  }

  await updateNkMeta(supabase, { status: 'scanning', message: `Created ${batches.length} batches for ${universe.length} tickers.` });

  return res.status(200).json({
    success: true,
    step: 'start',
    universe_count: universe.length,
    batch_count: batches.length,
    batch_size: BATCH_SIZE
  });
}

// --- BATCH: process next pending batch ---
async function handleNkScreenerBatch(req, res, supabase) {
  const runDate = getWibDateString();

  // Get next pending batch
  const { data: jobs } = await supabase
    .from('swing_screener_non_konglo_jobs')
    .select('*')
    .eq('run_date', runDate)
    .eq('status', 'pending')
    .order('batch_index', { ascending: true })
    .limit(1);

  if (!jobs || jobs.length === 0) {
    return res.status(200).json({ success: true, message: 'No pending batches.', step: 'batch' });
  }

  const job = jobs[0];
  const tickers = job.tickers || [];
  const boards = job.boards || {};

  // Mark job as processing
  await supabase
    .from('swing_screener_non_konglo_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', job.id);

  const results = [];
  let failedCount = 0;

  for (const ticker of tickers) {
    try {
      const quoteData = await fetchNkQuoteData(ticker);
      if (!quoteData || !quoteData.closes || quoteData.closes.length < 20) {
        failedCount++;
        continue;
      }

      // Apply hard filters
      const passesFilter = applyNkHardFilters(quoteData);
      if (!passesFilter) continue;

      // Calculate score
      const scored = calculateNkSetupScore(quoteData);
      scored.ticker = ticker;
      scored.board = boards[ticker] || 'UNKNOWN';
      scored.run_date = runDate;
      scored.calculated_at = new Date().toISOString();

      results.push(scored);
    } catch (e) {
      failedCount++;
    }
  }

  // Upsert scored candidates into staging (idempotent on run_date + ticker)
  if (results.length > 0) {
    await supabase
      .from('swing_screener_non_konglo_staging')
      .upsert(results, { onConflict: 'run_date,ticker' });
  }

  // Mark job complete
  await supabase
    .from('swing_screener_non_konglo_jobs')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      result_count: results.length,
      failed_count: failedCount
    })
    .eq('id', job.id);

  // Update meta scanned count
  const { data: meta } = await supabase
    .from('swing_screener_non_konglo_meta')
    .select('scanned_count, failed_count')
    .eq('id', 'latest')
    .maybeSingle();

  await updateNkMeta(supabase, {
    scanned_count: (meta ? meta.scanned_count : 0) + tickers.length,
    failed_count: (meta ? meta.failed_count : 0) + failedCount,
    message: `Batch ${job.batch_index} done: ${results.length} passed, ${failedCount} failed.`
  });

  return res.status(200).json({
    success: true,
    step: 'batch',
    batch_index: job.batch_index,
    processed: tickers.length,
    passed: results.length,
    failed: failedCount
  });
}

// --- FINALIZE: publish Top 15 ---
async function handleNkScreenerFinalize(req, res, supabase) {
  const runDate = getWibDateString();

  // Check for pending/failed batches — do NOT finalize if unresolved
  const { data: pendingJobs } = await supabase
    .from('swing_screener_non_konglo_jobs')
    .select('id')
    .eq('run_date', runDate)
    .in('status', ['pending', 'processing']);

  if (pendingJobs && pendingJobs.length > 0) {
    return res.status(200).json({ success: false, error: 'Cannot finalize: pending/processing batches remain.', pending: pendingJobs.length });
  }

  await updateNkMeta(supabase, { status: 'finalizing', message: 'Publishing top 15...' });

  // Get top 15 from staging by score desc
  const { data: topCandidates, error: stagErr } = await supabase
    .from('swing_screener_non_konglo_staging')
    .select('*')
    .eq('run_date', runDate)
    .order('score', { ascending: false })
    .limit(15);

  if (stagErr) {
    await updateNkMeta(supabase, { status: 'failed', message: 'Gagal membaca staging: ' + stagErr.message });
    return res.status(200).json({ success: false, error: 'Failed to read staging.' });
  }

  // Clear latest table and insert top 15
  // NOTE: This is not a true DB transaction (two separate calls).
  // If insert fails after delete, meta stays in "finalizing" (not "published").
  // User can retry nk-screener-run&force=1 to re-attempt finalize from staging.
  var { error: delErr } = await supabase.from('swing_screener_non_konglo_latest').delete().neq('ticker', '');
  if (delErr) {
    await updateNkMeta(supabase, { status: 'failed', message: 'Gagal menghapus latest: ' + delErr.message });
    return res.status(200).json({ success: false, error: 'Failed to clear latest table.' });
  }

  var publishedCount = 0;

  if (topCandidates && topCandidates.length > 0) {
    const publishRows = topCandidates.map((c, idx) => ({
      rank: idx + 1,
      ticker: c.ticker,
      board: c.board,
      last_price: c.last_price,
      change_pct: c.change_pct,
      avg_volume_20d: c.avg_volume_20d,
      avg_transaction_value_20d: c.avg_transaction_value_20d,
      traded_days_20d: c.traded_days_20d,
      score: c.score,
      grade: c.grade,
      risk_reward: c.risk_reward,
      volume_ratio_avg20: c.volume_ratio_avg20,
      status: c.status,
      status_reason: c.status_reason,
      ma20: c.ma20,
      ma50: c.ma50,
      rsi14: c.rsi14,
      entry_low: c.entry_low,
      entry_high: c.entry_high,
      stop_loss: c.stop_loss,
      tp1: c.tp1,
      tp2: c.tp2,
      support: c.support,
      resistance: c.resistance,
      published_at: new Date().toISOString(),
      run_date: runDate
    }));

    var { error: insErr } = await supabase.from('swing_screener_non_konglo_latest').insert(publishRows);
    if (insErr) {
      // Insert failed — meta stays as "finalizing", NOT "published"
      // User can retry and finalize will re-attempt from staging
      await updateNkMeta(supabase, { status: 'failed', message: 'Gagal publish Top 15: ' + insErr.message });
      return res.status(200).json({ success: false, error: 'Failed to publish. Retry will re-attempt from staging.' });
    }
    publishedCount = publishRows.length;
  }

  // Only mark as "published" if insert succeeded
  await updateNkMeta(supabase, {
    status: 'published',
    published_count: publishedCount,
    message: 'Published ' + publishedCount + ' top candidates.',
    calculated_at: new Date().toISOString()
  });

  return res.status(200).json({
    success: true,
    step: 'finalize',
    published: publishedCount
  });
}

// --- READ: cached results (login-gated) ---
async function handleNkScreenerResults(req, res, supabase) {
  // Replicate same auth check as handleScreenerRead
  var rawUserId = (req.headers['x-user-id'] || '').trim();
  var rawUsername = (req.headers['x-username'] || '').trim().toLowerCase();

  if (!rawUserId && !rawUsername) {
    return res.status(403).json({ success: false, error: 'Login diperlukan untuk mengakses Screener.' });
  }
  if (rawUsername === 'guest') {
    return res.status(403).json({ success: false, error: 'Login diperlukan untuk mengakses Screener.' });
  }

  var userData = null;

  // 1. Try lookup by UUID if it looks valid
  if (rawUserId && rawUserId.includes('-') && rawUserId.length > 30) {
    var r1 = await supabase
      .from('app_users')
      .select('id, username, is_approved, is_blocked')
      .eq('id', rawUserId)
      .maybeSingle();
    if (r1.data) userData = r1.data;
  }

  // 2. Fallback: lookup by username
  if (!userData && rawUsername && rawUsername.length >= 2) {
    var r2 = await supabase
      .from('app_users')
      .select('id, username, is_approved, is_blocked')
      .eq('username', rawUsername)
      .maybeSingle();
    if (r2.data) userData = r2.data;
  }

  // 3. Fallback: try ilike match for username (case-insensitive safety)
  if (!userData && rawUsername && rawUsername.length >= 2) {
    var r3 = await supabase
      .from('app_users')
      .select('id, username, is_approved, is_blocked')
      .ilike('username', rawUsername)
      .maybeSingle();
    if (r3.data) userData = r3.data;
  }

  if (!userData) {
    return res.status(403).json({ success: false, error: 'User tidak ditemukan. Pastikan akun terdaftar.' });
  }

  if (userData.is_blocked) {
    return res.status(403).json({ success: false, error: 'Akun diblokir.' });
  }

  if (userData.is_approved === false) {
    return res.status(403).json({ success: false, error: 'Akun belum di-approve.' });
  }

  // User verified — return cached NK screener data
  const { data: meta } = await supabase
    .from('swing_screener_non_konglo_meta')
    .select('*')
    .eq('id', 'latest')
    .maybeSingle();

  const { data: rows, error: rowErr } = await supabase
    .from('swing_screener_non_konglo_latest')
    .select('*')
    .order('rank', { ascending: true });

  if (rowErr) {
    return res.status(200).json({ success: false, error: 'Gagal memuat data screener non-konglo.' });
  }

  return res.status(200).json({
    success: true,
    meta: meta || { calculated_at: null, status: 'idle', message: 'Awaiting first calculation.', universe_count: 0, scanned_count: 0, failed_count: 0, published_count: 0 },
    results: rows || []
  });
}

// --- META helper ---
async function updateNkMeta(supabase, fields) {
  const updateData = {
    id: 'latest',
    updated_at: new Date().toISOString()
  };
  if (fields.status !== undefined) updateData.status = fields.status;
  if (fields.run_date !== undefined) updateData.run_date = fields.run_date;
  if (fields.message !== undefined) updateData.message = fields.message;
  if (fields.universe_count !== undefined) updateData.universe_count = fields.universe_count;
  if (fields.scanned_count !== undefined) updateData.scanned_count = fields.scanned_count;
  if (fields.failed_count !== undefined) updateData.failed_count = fields.failed_count;
  if (fields.published_count !== undefined) updateData.published_count = fields.published_count;
  if (fields.calculated_at !== undefined) updateData.calculated_at = fields.calculated_at;

  await supabase.from('swing_screener_non_konglo_meta').upsert([updateData], { onConflict: 'id' });
}

// --- DATA FETCH: Yahoo 60d OHLCV ---
async function fetchNkQuoteData(ticker) {
  try {
    const symbol = ticker + '.JK';
    const now = Math.floor(Date.now() / 1000);
    const from = now - 60 * 86400; // 60 days back
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=${now}&interval=1d`;

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutoCuan/1.0)' }
    });
    if (!resp.ok) return null;

    const json = await resp.json();
    const result = json.chart && json.chart.result && json.chart.result[0];
    if (!result || !result.indicators || !result.indicators.quote || !result.indicators.quote[0]) return null;

    const quote = result.indicators.quote[0];
    const timestamps = result.timestamp || [];
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];

    // Filter out null days
    const validDays = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null && volumes[i] != null) {
        validDays.push({ ts: timestamps[i], open: opens[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i] });
      }
    }

    if (validDays.length < 20) return null;

    const lastIdx = validDays.length - 1;
    const lastClose = validDays[lastIdx].close;
    const prevClose = validDays[lastIdx - 1].close;
    const changePct = prevClose ? ((lastClose - prevClose) / prevClose) * 100 : 0;

    // Count traded days in last 20
    const last20 = validDays.slice(-20);
    const tradedDays20d = last20.filter(d => d.volume > 0).length;

    // Avg transaction value last 20d (approx: close * volume)
    const txValues = last20.map(d => d.close * d.volume);
    const avgTxValue20d = txValues.reduce((a, b) => a + b, 0) / txValues.length;

    // Volume ratio vs avg20
    const avgVol20 = last20.map(d => d.volume).reduce((a, b) => a + b, 0) / 20;
    const volumeRatioAvg20 = avgVol20 > 0 ? validDays[lastIdx].volume / avgVol20 : 0;

    // MA20, MA50
    const closesArr = validDays.map(d => d.close);
    const ma20 = nkCalcMA(closesArr, 20);
    const ma50 = closesArr.length >= 50 ? nkCalcMA(closesArr, 50) : null;

    // RSI14
    const rsi14 = nkCalcRSI(closesArr, 14);

    // Support/Resistance (20d low/high)
    const last20Lows = last20.map(d => d.low);
    const last20Highs = last20.map(d => d.high);
    const support = Math.min(...last20Lows);
    const resistance = Math.max(...last20Highs);

    // Entry area: between support and Fib 0.382 retracement of range
    const entryLow = support;
    const entryHigh = Math.min(lastClose, support + (resistance - support) * 0.382);

    // Stop loss: 3% below 20d support
    const stopLoss = Math.round(support * 0.97);

    // TP based on Fibonacci levels of the 20d range (not derived from fixed RR)
    const tp1 = Math.round(support + (resistance - support) * 0.618);
    const tp2 = Math.round(resistance);

    // Risk/Reward: reward = TP1 - entry midpoint, risk = entry midpoint - SL
    const entryMid = (entryLow + entryHigh) / 2;
    const riskAmt = entryMid - stopLoss;
    const rewardAmt = tp1 - entryMid;
    const riskReward = riskAmt > 0 ? rewardAmt / riskAmt : 0;

    // Penalty signals (matching Konglo screener technical equivalence)
    const lastCandle = validDays[lastIdx];
    const candleBody = Math.abs(lastCandle.close - lastCandle.open);
    const candleRange = lastCandle.high - lastCandle.low;
    const isLargeRed = lastCandle.close < lastCandle.open && candleBody > candleRange * 0.6 && volumeRatioAvg20 >= 1.2;
    const overextended = ma20 && lastClose > ma20 * 1.08; // >8% above MA20
    const belowSupport = lastClose < support;
    const slDistance = stopLoss > 0 ? ((entryMid - stopLoss) / entryMid) * 100 : 0;

    return {
      closes: closesArr,
      lastPrice: lastClose,
      changePct,
      tradedDays20d,
      avgTxValue20d,
      avgVol20: avgVol20,
      volumeRatioAvg20,
      ma20,
      ma50,
      rsi14,
      support,
      resistance,
      entryLow,
      entryHigh,
      stopLoss,
      tp1,
      tp2,
      riskReward,
      // Penalty flags
      isLargeRed: isLargeRed,
      overextended: overextended,
      belowSupport: belowSupport,
      slDistance: slDistance,
      last_price: lastClose,
      change_pct: Number(changePct.toFixed(2)),
      volume_ratio_avg20: Number(volumeRatioAvg20.toFixed(2))
    };
  } catch (e) {
    return null;
  }
}

// --- HARD FILTERS ---
function applyNkHardFilters(q) {
  if (!q) return false;
  if (q.lastPrice <= 50) return false;
  if (q.tradedDays20d < 15) return false;
  if (q.avgTxValue20d < 10_000_000_000) return false;
  if (q.riskReward < 1.5) return false;
  if (q.volumeRatioAvg20 < 0.7) return false;
  return true;
}

// --- SCORING: deterministic 0-100, same engine as Konglo ---
// Uses same base-50 additive/subtractive approach as scoreAndClassify (Konglo).
// Liquidity is a hard filter (already applied), so only adds a small tie-breaker bonus.
function calculateNkSetupScore(q) {
  var score = 50; // Same base as Konglo
  var components = [];

  // 1. TREND (same as Konglo: MA20 +10/+5/-5, MA50 +10/+3/-10)
  if (q.ma20 && q.lastPrice >= q.ma20) { score += 10; components.push('close>MA20'); }
  else if (q.ma20 && q.lastPrice >= q.ma20 * 0.98) { score += 5; components.push('close~MA20'); }
  else { score -= 5; if (q.ma20) components.push('close<MA20'); }

  if (q.ma50 && q.lastPrice >= q.ma50) { score += 10; components.push('close>MA50'); }
  else if (q.ma50 && q.lastPrice >= q.ma50 * 0.97) { score += 3; }
  else { score -= 10; if (q.ma50) components.push('close<MA50'); }

  // 2. MOMENTUM / RSI (same as Konglo: +15/+8/+5/+3/-5/-10)
  if (q.rsi14 !== null) {
    if (q.rsi14 >= 45 && q.rsi14 <= 68) { score += 15; components.push('RSI ' + q.rsi14.toFixed(1) + ' ideal'); }
    else if (q.rsi14 >= 40 && q.rsi14 < 45) { score += 8; components.push('RSI ' + q.rsi14.toFixed(1) + ' netral'); }
    else if (q.rsi14 > 68 && q.rsi14 <= 75) { score += 5; components.push('RSI ' + q.rsi14.toFixed(1) + ' kuat'); }
    else if (q.rsi14 >= 30 && q.rsi14 < 40) { score += 3; components.push('RSI ' + q.rsi14.toFixed(1) + ' oversold zone'); }
    else if (q.rsi14 > 75) { score -= 5; components.push('RSI ' + q.rsi14.toFixed(1) + ' overbought'); }
    else { score -= 10; components.push('RSI ' + q.rsi14.toFixed(1) + ' extreme'); }
  }

  // 3. VOLUME (same as Konglo: +15/+12/+5/-5)
  if (q.volumeRatioAvg20 >= 1.5) { score += 15; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x tinggi'); }
  else if (q.volumeRatioAvg20 >= 1.2) { score += 12; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x above avg'); }
  else if (q.volumeRatioAvg20 >= 0.8) { score += 5; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x normal'); }
  else { score -= 5; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x rendah'); }

  // 4. RISK/REWARD (same as Konglo: +15/+12/+8/+3/-5)
  if (q.riskReward >= 2.5) { score += 15; components.push('RR ' + q.riskReward.toFixed(2) + ' baik'); }
  else if (q.riskReward >= 2.0) { score += 12; components.push('RR ' + q.riskReward.toFixed(2)); }
  else if (q.riskReward >= 1.5) { score += 8; components.push('RR ' + q.riskReward.toFixed(2) + ' minimal'); }
  else if (q.riskReward >= 1.0) { score += 3; }
  else { score -= 5; }

  // 5. PENALTIES (same as Konglo: -15/-10/-15/-8)
  if (q.isLargeRed) { score -= 15; components.push('candle distribusi'); }
  if (q.overextended) { score -= 10; components.push('overextended'); }
  if (q.belowSupport) { score -= 15; components.push('breakdown support'); }
  if (q.slDistance > 5) { score -= 8; components.push('SL jauh ' + q.slDistance.toFixed(1) + '%'); }

  // 6. LIQUIDITY BONUS (small tie-breaker, max +5 pts — not a heavy component)
  var txB = q.avgTxValue20d / 1e9;
  if (txB >= 50) score += 5;
  else if (txB >= 30) score += 3;
  else if (txB >= 20) score += 2;
  // txB >= 10 (minimum hard filter) = no bonus, no penalty

  score = Math.max(0, Math.min(100, score));

  // GRADE (same thresholds)
  var grade = 'D';
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';

  // STATUS CLASSIFICATION (same logic as Konglo scoreAndClassify)
  var status = 'Invalid';
  var statusReason = '';
  var failReasons = [];

  // Swing Ready hard filters (matching Konglo)
  var passesAllHardFilters = true;
  if (score < 80) { passesAllHardFilters = false; failReasons.push('Score < 80'); }
  if (!(q.ma20 && q.lastPrice >= q.ma20 * 0.99)) { passesAllHardFilters = false; failReasons.push('Di bawah MA20'); }
  if (!(q.ma50 && q.lastPrice >= q.ma50)) { passesAllHardFilters = false; failReasons.push('Di bawah MA50'); }
  if (!(q.rsi14 !== null && q.rsi14 >= 45 && q.rsi14 <= 68)) {
    passesAllHardFilters = false;
    if (q.rsi14 === null) failReasons.push('RSI N/A');
    else if (q.rsi14 > 68) failReasons.push('RSI tinggi');
    else if (q.rsi14 < 45) failReasons.push('RSI rendah');
  }
  if (!(q.volumeRatioAvg20 >= 1.0)) { passesAllHardFilters = false; failReasons.push('Vol < 1x'); }
  if (!(q.riskReward >= 1.5)) { passesAllHardFilters = false; failReasons.push('RR kurang'); }
  if (q.slDistance > 5) { passesAllHardFilters = false; failReasons.push('SL jauh'); }
  if (q.isLargeRed) { passesAllHardFilters = false; failReasons.push('Candle distribusi'); }
  if (q.overextended) { passesAllHardFilters = false; failReasons.push('Overextended'); }
  if (q.belowSupport) { passesAllHardFilters = false; failReasons.push('Breakdown'); }

  if (passesAllHardFilters) {
    status = 'Swing Ready';
    statusReason = 'Setup lengkap: trend, momentum, volume, RR layak.';
  } else if (q.rsi14 !== null && q.rsi14 >= 30 && q.rsi14 <= 42 &&
             q.lastPrice > q.support && q.volumeRatioAvg20 >= 0.8 && score >= 40) {
    status = 'Rebound Speculative';
    statusReason = 'Potensi rebound dari support. Risiko tinggi.';
  } else if (score >= 65) {
    status = 'Watchlist';
    statusReason = failReasons.length > 0 ? 'Tunggu: ' + failReasons.slice(0, 2).join(', ') : 'Menunggu konfirmasi.';
  } else {
    status = 'Speculative';
    statusReason = failReasons.length > 0 ? failReasons.slice(0, 2).join(', ') : 'Setup belum memenuhi kriteria.';
  }

  // Prepend key metrics for auditability
  var metricLine = 'Vol ' + q.volumeRatioAvg20.toFixed(2) + 'x, Tx Rp' + txB.toFixed(1) + 'B';
  if (q.rsi14 !== null) metricLine += ', RSI ' + q.rsi14.toFixed(1);
  metricLine += ', RR ' + q.riskReward.toFixed(2);
  statusReason = metricLine + '. ' + statusReason;

  // Compute avg_volume_20d
  var avgVolume20d = (q.lastPrice > 0) ? Math.round(q.avgTxValue20d / q.lastPrice) : 0;

  return {
    score: score,
    grade: grade,
    status: status,
    status_reason: statusReason,
    last_price: q.last_price,
    change_pct: q.change_pct,
    avg_volume_20d: avgVolume20d,
    avg_transaction_value_20d: Math.round(q.avgTxValue20d),
    traded_days_20d: q.tradedDays20d,
    risk_reward: Number(q.riskReward.toFixed(2)),
    volume_ratio_avg20: q.volume_ratio_avg20,
    ma20: q.ma20 ? Number(q.ma20.toFixed(2)) : null,
    ma50: q.ma50 ? Number(q.ma50.toFixed(2)) : null,
    rsi14: q.rsi14 !== null ? Number(q.rsi14.toFixed(2)) : null,
    entry_low: Number(q.entryLow.toFixed(2)),
    entry_high: Number(q.entryHigh.toFixed(2)),
    stop_loss: Number(q.stopLoss.toFixed(2)),
    tp1: Number(q.tp1.toFixed(2)),
    tp2: Number(q.tp2.toFixed(2)),
    support: Number(q.support.toFixed(2)),
    resistance: Number(q.resistance.toFixed(2))
  };
}

// --- SMA helper ---
function nkCalcMA(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// --- RSI helper ---
function nkCalcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
