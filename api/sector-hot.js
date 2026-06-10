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
 * Modes (Day Trade Screener v1):
 *   GET /api/sector-hot?action=daytrade-screener           → read latest Day Trade results (public)
 *   GET /api/sector-hot?action=daytrade-screener-run       → protected: run Day Trade scan (Bearer CRON_SECRET)
 *
 * Modes (Public Screener Share):
 *   GET /api/sector-hot?action=create-screener-share-link  → protected: generate 1-day share token (Bearer CRON_SECRET)
 *   GET /api/sector-hot?action=public-screener-share&token=TOKEN → public: read-only screener data (HMAC validated)
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — database
 *   CRON_SECRET — cron authentication
 *   SCREENER_AI_API_KEY — AI confirmation (server-side only, never exposed)
 *   SCREENER_AI_ENABLED — 'true' to enable AI confirmation (default: disabled)
 *   SCREENER_AI_BASE_URL — OpenAI-compatible endpoint
 *   SCREENER_AI_MODEL — model name
 *   SCREENER_AI_MAX_CANDIDATES — max tickers sent to AI (default 15)
 *   SCREENER_AI_MAX_OUTPUT_TOKENS — max tokens for AI response (default 700)
 */

const { createClient } = require('@supabase/supabase-js');
const dtEngine = require('../lib/daytrade-screener-engine');

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

    // === DAY TRADE SCREENER: READ (public — returns latest results) ===
    if (action === 'daytrade-screener') {
      return await handleDayTradeScreenerRead(req, res, supabase);
    }

    // === DAY TRADE SCREENER: RUN (Bearer CRON_SECRET protected) ===
    if (action === 'daytrade-screener-run') {
      return await handleDayTradeScreenerRun(req, res, supabase);
    }

    // === PUBLIC SCREENER SHARE: CREATE (admin/CRON_SECRET protected) ===
    if (action === 'create-screener-share-link') {
      return await handleCreateScreenerShareLink(req, res);
    }

    // === PUBLIC SCREENER SHARE: READ (token-validated, read-only) ===
    if (action === 'public-screener-share') {
      return await handlePublicScreenerShare(req, res, supabase);
    }

    // === SEKTOR HOT REFRESH MODE (cron-protected, existing) ===
    if (action === 'refresh') {
      return await handleRefresh(req, res, supabase);
    }

    // === DEBUG: member diagnostics for a specific group (Preview QA only) ===
    if (action === 'debug-members') {
      var debugGroup = String(req.query.group || '').toUpperCase().trim();
      if (!debugGroup) return res.status(200).json({ success: false, error: 'group parameter required' });
      var dbMapping = await supabase.from('sector_hot_group_members').select('ticker, stock_name, member_type, is_active, sort_order').eq('group_code', debugGroup);
      var dbLatest = await supabase.from('sector_hot_latest').select('*').eq('group_code', debugGroup).maybeSingle();
      var dbMembers = await supabase.from('sector_hot_members_latest').select('*').eq('group_code', debugGroup);
      var membersRows = dbMembers.data || [];
      var withLastPrice = membersRows.filter(function(r) { return r.last_price != null; }).length;
      var withChangePct = membersRows.filter(function(r) { return r.change_pct != null; }).length;
      var withVolume = membersRows.filter(function(r) { return r.volume_today != null; }).length;
      var withRatio = membersRows.filter(function(r) { return r.volume_ratio_30d != null; }).length;
      return res.status(200).json({
        success: true,
        group_code: debugGroup,
        mapping: { data: dbMapping.data, error: dbMapping.error ? dbMapping.error.message : null, active_count: (dbMapping.data || []).filter(function(m){return m.is_active;}).length },
        latest_header: { data: dbLatest.data, error: dbLatest.error ? dbLatest.error.message : null },
        members_latest: { row_count: membersRows.length, with_last_price: withLastPrice, with_change_pct: withChangePct, with_volume: withVolume, with_ratio: withRatio, error: dbMembers.error ? dbMembers.error.message : null, sample: membersRows.length > 0 ? membersRows[0] : null, field_names: membersRows.length > 0 ? Object.keys(membersRows[0]) : [] },
        conclusion: withLastPrice > 0 ? 'DB_HAS_DATA' : (membersRows.length > 0 ? 'ROWS_EXIST_BUT_NULL_FIELDS' : 'NO_ROWS_IN_DB')
      });
    }

    // === DETAIL MODE: single group + members (existing) ===
    if (groupCode) {
      const code = String(groupCode).toUpperCase().trim();

      // Resilient fetch: capture data + errors but never hard-fail the whole page.
      var groupData = null, membersData = null, mappingData = null;
      var detailDiagnostics = { groupError: null, membersError: null, mappingError: null };

      try {
        const gRes = await supabase
          .from('sector_hot_latest')
          .select('*')
          .eq('group_code', code)
          .maybeSingle();
        if (gRes.error) detailDiagnostics.groupError = gRes.error.message;
        else groupData = gRes.data;
      } catch (e) { detailDiagnostics.groupError = e.message; }

      try {
        const mRes = await supabase
          .from('sector_hot_members_latest')
          .select('*')
          .eq('group_code', code)
          .order('calculated_at', { ascending: false });
        if (mRes.error) detailDiagnostics.membersError = mRes.error.message;
        else membersData = mRes.data;
      } catch (e) { detailDiagnostics.membersError = e.message; }

      try {
        const mapRes = await supabase
          .from('sector_hot_group_members')
          .select('ticker, stock_name, member_type, sort_order')
          .eq('group_code', code)
          .eq('is_active', true)
          .order('sort_order', { ascending: true });
        if (mapRes.error) detailDiagnostics.mappingError = mapRes.error.message;
        else mappingData = mapRes.data;
      } catch (e) { detailDiagnostics.mappingError = e.message; }

      const sortMap = {};
      if (mappingData) {
        mappingData.forEach(function(m) { sortMap[m.ticker] = m.sort_order; });
      }

      // Merge: use sector_hot_members_latest data where available,
      // fill in missing members from mapping (so all active members always appear)
      var finalMembers;
      var membersMap = {};
      if (membersData && membersData.length > 0) {
        membersData.forEach(function(m) { membersMap[m.ticker] = m; });
      }
      if (mappingData && mappingData.length > 0) {
        finalMembers = mappingData.map(function(m) {
          var existing = membersMap[m.ticker];
          if (existing && existing.last_price != null) {
            // Use existing market data row
            existing._sort = m.sort_order != null ? m.sort_order : 999;
            return existing;
          }
          // Fallback: mapping member without market data
          return {
            group_code: code,
            ticker: m.ticker,
            stock_name: m.stock_name || m.ticker,
            last_price: null,
            change_pct: null,
            volume_today: null,
            avg_volume_30d: null,
            volume_ratio_30d: null,
            member_type: m.member_type || 'Member',
            calculated_at: null,
            _sort: m.sort_order != null ? m.sort_order : 999
          };
        });
        finalMembers.sort(function(a, b) { return (a._sort || 999) - (b._sort || 999); });
      } else if (membersData && membersData.length > 0) {
        finalMembers = membersData.sort(function(a, b) {
          const sa = sortMap[a.ticker] != null ? sortMap[a.ticker] : 999;
          const sb = sortMap[b.ticker] != null ? sortMap[b.ticker] : 999;
          return sa - sb;
        });
      } else {
        finalMembers = [];
      }

      // Synthesize a minimal group header from mapping if sector_hot_latest has no row yet.
      // This prevents the frontend "Gagal memuat detail grup" when only mapping exists.
      if (!groupData && mappingData && mappingData.length > 0) {
        groupData = {
          group_code: code,
          group_name: code,
          owner_label: null,
          avg_change_pct: null,
          stock_count: mappingData.length,
          valid_count: 0,
          top_ticker: null,
          top_change_pct: null,
          avg_volume_ratio: null,
          status: 'no_data',
          message: 'Header belum dihitung. Jalankan refresh Sektor Hot.'
        };
      }

      // Success as long as we have a group header OR active members.
      var detailSuccess = !!(groupData || (finalMembers && finalMembers.length > 0));

      var membersWithData = finalMembers.filter(function(m) { return m.last_price != null; }).length;

      return res.status(200).json({
        success: detailSuccess,
        group: groupData || null,
        members: finalMembers,
        members_count: finalMembers.length,
        members_with_market_data_count: membersWithData,
        sample_member: finalMembers.length > 0 ? finalMembers[0] : undefined,
        field_names_returned: finalMembers.length > 0 ? Object.keys(finalMembers[0]) : undefined,
        diagnostics: (detailDiagnostics.groupError || detailDiagnostics.membersError || detailDiagnostics.mappingError) ? detailDiagnostics : undefined,
        error: detailSuccess ? undefined : 'Grup tidak ditemukan atau belum ada data mapping.'
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

    // BUG 1 FIX: Only show groups that have >= 1 active member in the mapping.
    // Hides zero-active groups (e.g. SINARMAS_HISTORICAL_MERGER after FREN was
    // set inactive) even if a stale sector_hot_latest row still exists.
    const { data: activeMembersList } = await supabase
      .from('sector_hot_group_members')
      .select('group_code')
      .eq('is_active', true);
    const activeGroupCounts = {};
    (activeMembersList || []).forEach(function(m) { activeGroupCounts[m.group_code] = (activeGroupCounts[m.group_code] || 0) + 1; });

    const filteredGroups = (groupsData || []).filter(function(g) {
      return activeGroupCounts[g.group_code] > 0;
    });

    const groups = filteredGroups.sort(function(a, b) {
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
    var screenerFailedTickers = [];
    var results = [];

    for (var i = 0; i < universe.length; i++) {
      var item = universe[i];
      scannedCount++;
      try {
        var candles = await fetchScreenerCandles(item.ticker);
        if (!candles || !Array.isArray(candles) || candles.length < 55) {
          failedCount++;
          screenerFailedTickers.push({ ticker: item.ticker, reason: !candles ? 'no_data' : 'insufficient_candles_' + (candles ? candles.length : 0) });
          continue;
        }
        var analysis = calculateIndicators(candles);
        if (!analysis || !analysis.last_price) { failedCount++; screenerFailedTickers.push({ ticker: item.ticker, reason: 'analysis_failed' }); continue; }
        var scoring = scoreAndClassify(analysis);

        // Compute transaction value metrics from candle data
        var _txCandles = candles || [];
        var _txLastIdx = _txCandles.length - 1;
        var _txValue1d = _txLastIdx >= 0 ? (_txCandles[_txLastIdx].close || 0) * (_txCandles[_txLastIdx].volume || 0) : 0;
        var _txLast3 = _txCandles.slice(-3);
        var _avgTxValue3d = _txLast3.length > 0 ? _txLast3.map(function(d) { return (d.close || 0) * (d.volume || 0); }).reduce(function(a, b) { return a + b; }, 0) / _txLast3.length : 0;
        var _txLast7 = _txCandles.slice(-7);
        var _avgTxValue7d = _txLast7.length > 0 ? _txLast7.map(function(d) { return (d.close || 0) * (d.volume || 0); }).reduce(function(a, b) { return a + b; }, 0) / _txLast7.length : 0;
        var _txLast20 = _txCandles.slice(-20);
        var _avgTxValue20d = _txLast20.length > 0 ? _txLast20.map(function(d) { return (d.close || 0) * (d.volume || 0); }).reduce(function(a, b) { return a + b; }, 0) / _txLast20.length : 0;

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
          status_reason: scoring.status_reason,
          tx_value_1d: Math.round(_txValue1d),
          avg_tx_value_3d: Math.round(_avgTxValue3d),
          avg_tx_value_7d: Math.round(_avgTxValue7d),
          avg_tx_value_20d: Math.round(_avgTxValue20d)
        });
      } catch (e) {
        failedCount++;
        screenerFailedTickers.push({ ticker: item.ticker, reason: 'exception: ' + (e.message || 'unknown').substring(0, 80) });
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
    var maxCandidates = parseInt(process.env.SCREENER_AI_MAX_CANDIDATES || '40', 10);
    var maxOutputTokens = parseInt(process.env.SCREENER_AI_MAX_OUTPUT_TOKENS || '800', 10);
    var aiModelUsed = process.env.SCREENER_AI_MODEL || 'deepseek-v4-flash';
    // Cost-efficient: max 2 API calls total, split candidates into 2 halves
    var AI_MAX_CALLS = 2;

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
    var aiApiCallCount = 0;
    var aiMissingTickers = [];
    var batches = [];

    var aiFeatureEnabled = process.env.SCREENER_AI_ENABLED === 'true'; // default: disabled
    if (enableAI && aiFeatureEnabled && aiCandidates.length > 0 && process.env.SCREENER_AI_API_KEY) {
      aiAttempted = aiCandidates.length;

      // Split into max 2 bulk calls (cost-efficient)
      if (aiCandidates.length <= 20) {
        batches = [aiCandidates]; // 1 call for <= 20 candidates
      } else {
        var mid = Math.ceil(aiCandidates.length / 2);
        batches = [aiCandidates.slice(0, mid), aiCandidates.slice(mid)];
      }
      aiBatchCount = batches.length;

      var allAIResults = [];
      var lastUsage = null;

      for (var batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        aiBatchesAttempted++;
        aiApiCallCount++;
        var batchCandidates = batches[batchIdx];
        var batchTickers = batchCandidates.map(function(c) { return c.ticker; });

        var aiResult = await callAIConfirmation(batchCandidates);

        // Collect usage from last batch for diagnostics
        if (aiResult.usage) lastUsage = aiResult.usage;

        if (aiResult.data && aiResult.data.length > 0) {
          aiBatchesSucceeded++;
          allAIResults = allAIResults.concat(aiResult.data);
          aiBatchDiagnostics.push('OK ' + aiResult.data.length + '/' + batchTickers.length + ' tickers');
        } else {
          // Bulk call failed — retry with shorter prompt (strip non-essential fields)
          await delay(2000);
          aiApiCallCount++;
          var retryResult = await callAIConfirmation(batchCandidates);
          if (retryResult.data && retryResult.data.length > 0) {
            aiBatchesSucceeded++;
            allAIResults = allAIResults.concat(retryResult.data);
            aiBatchDiagnostics.push('RETRY OK ' + retryResult.data.length + '/' + batchTickers.length + ' tickers');
          } else {
            aiBatchesFailed++;
            aiBatchDiagnostics.push('FAILED ' + batchTickers.length + ' tickers: ' + batchTickers.slice(0, 5).join(',') + (batchTickers.length > 5 ? '...' : ''));
            if (!aiResponseDebug && (aiResult.ai_response_debug || retryResult.ai_response_debug)) {
              aiResponseDebug = aiResult.ai_response_debug || retryResult.ai_response_debug;
            }
          }
        }

        // Delay between bulk calls
        if (batchIdx < batches.length - 1) {
          await delay(1500);
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

      // Mark AI-eligible tickers that failed (not in aiMap) as FAILED
      // Track missing tickers for diagnostics
      var aiCandidateTickers = {};
      aiCandidates.forEach(function(c) { aiCandidateTickers[c.ticker.toUpperCase()] = true; });
      results = results.map(function(r) {
        var normalizedR = String(r.ticker).trim().toUpperCase();
        if (aiCandidateTickers[normalizedR] && !r.ai_status) {
          r.ai_status = 'FAILED';
          r.ai_reason = 'AI tidak mengembalikan hasil untuk ticker ini.';
          aiMissingTickers.push(r.ticker);
        }
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
        ai_red_flags: (r.ai_red_flags && Array.isArray(r.ai_red_flags) && r.ai_red_flags.length > 0) ? '{' + r.ai_red_flags.map(function(f) { return '"' + String(f).replace(/"/g, '\\"') + '"'; }).join(',') + '}' : null,
        final_status: r.final_status,
        tx_value_1d: r.tx_value_1d || null,
        avg_tx_value_3d: r.avg_tx_value_3d || null,
        avg_tx_value_7d: r.avg_tx_value_7d || null,
        avg_tx_value_20d: r.avg_tx_value_20d || null,
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
    if (screenerFailedTickers.length > 0) {
      metaMsg += ' | Failed(' + screenerFailedTickers.length + '): ' + screenerFailedTickers.slice(0, 5).map(function(f) { return f.ticker + '(' + f.reason + ')'; }).join(', ');
    }
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
      ai_batch_size: batches.length > 0 ? Math.ceil(aiCandidates.length / batches.length) : 0,
      universe_count: universeCount,
      scanned_count: scannedCount,
      generated_count: results.length,
      saved_count: savedCount,
      failed_count: failedCount,
      screener_failed_tickers: screenerFailedTickers.length > 0 ? screenerFailedTickers : undefined,
      ai_eligible_count: aiEligibleCount,
      ai_attempted: aiAttempted,
      ai_called_count: aiCalledCount,
      ai_candidates_sent: aiCandidates.map(function(c) { return c.ticker; }),
      ai_skipped_count: aiSkippedCount,
      ai_batch_count: aiBatchCount,
      ai_batches_attempted: aiBatchesAttempted,
      ai_batches_succeeded: aiBatchesSucceeded,
      ai_batches_failed: aiBatchesFailed,
      ai_api_call_count: aiApiCallCount,
      ai_cost_saving_mode: true,
      ai_output_format: 'line_protocol',
      ai_success_count: aiCalledCount,
      ai_failed_count: aiBatchesFailed > 0 ? aiAttempted - aiCalledCount - aiMissingTickers.length : 0,
      ai_missing_count: aiMissingTickers.length,
      ai_missing_tickers: aiMissingTickers.length > 0 ? aiMissingTickers : undefined,
      ai_failed_tickers: aiBatchDiagnostics.filter(function(d) { return d.startsWith('FAILED'); }).length > 0 ? aiBatchDiagnostics.filter(function(d) { return d.startsWith('FAILED'); }) : undefined,
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
    return res.status(200).json({
      success: false,
      error: 'Screener refresh failed: ' + e.message,
      error_message: e.message,
      error_stack: e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : null,
      error_phase: 'screener_refresh_main',
      failed_tickers: typeof failedCount !== 'undefined' ? failedCount : null,
      scanned_so_far: typeof scannedCount !== 'undefined' ? scannedCount : null,
      results_so_far: typeof results !== 'undefined' ? results.length : null
    });
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
    var failedTickers = [];

    for (var i = 0; i < uniqueTickers.length; i++) {
      var ticker = uniqueTickers[i];
      scannedCount++;
      try {
        var quote = await fetchYahooQuote(ticker);
        if (quote) { quoteCache[ticker] = quote; }
        else { failedCount++; failedTickers.push(ticker); }
      } catch (e) { failedCount++; failedTickers.push(ticker); }
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
    var memberUpsertErrors = [];
    var memberRowsAttempted = 0;
    var memberRowsInserted = 0;
    var zeroActiveGroupsCleaned = 0;
    var sampleMemberRow = null;

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var groupMembers = members.filter(function(m) { return m.group_code === group.group_code; });
      if (groupMembers.length === 0) {
        // Group has no active members (e.g. only delisted tickers like FREN).
        // Clean up stale latest rows so it does not linger as an empty hot group.
        await supabase.from('sector_hot_latest').delete().eq('group_code', group.group_code);
        await supabase.from('sector_hot_members_latest').delete().eq('group_code', group.group_code);
        zeroActiveGroupsCleaned++;
        continue;
      }

      var memberRows = [];
      var validCount = 0;
      var totalChangePct = 0;
      var totalVolRatio = 0;
      var topTicker = null;
      var topChangePct = -Infinity;

      for (var m = 0; m < groupMembers.length; m++) {
        var member = groupMembers[m];
        var q = quoteCache[member.ticker];

        // Normalize member_type for sector_hot_members_latest which has
        // CHECK constraint IN ('ANCHOR', 'Member'). V2 mapping uses CORE/AFFILIATE/RADAR.
        var normalizedMemberType = (member.member_type === 'CORE' || member.member_type === 'ANCHOR') ? 'ANCHOR' : 'Member';

        // Always insert a row for each active member.
        // Valid quote data populates fields; failed quotes get null fields.
        memberRows.push({
          group_code: group.group_code,
          ticker: member.ticker,
          stock_name: member.stock_name,
          last_price: q ? q.lastPrice : null,
          change_pct: q ? q.changePct : null,
          volume_today: q ? q.volumeToday : null,
          avg_volume_30d: q ? q.avgVolume30d : null,
          volume_ratio_30d: q ? q.volumeRatio30d : null,
          member_type: normalizedMemberType,
          calculated_at: now
        });

        if (q) {
          validCount++;
          totalChangePct += q.changePct;
          totalVolRatio += q.volumeRatio30d;
          if (q.changePct > topChangePct) { topChangePct = q.changePct; topTicker = member.ticker; }
        }
      }

      if (memberRows.length > 0) {
        memberRowsAttempted += memberRows.length;
        if (!sampleMemberRow) sampleMemberRow = memberRows[0];
        // Delete old rows then insert fresh ones. No .select() chain (avoids
        // RLS/returning issues that caused silent insert failures on Preview).
        var delResult = await supabase.from('sector_hot_members_latest').delete().eq('group_code', group.group_code);
        if (delResult.error) {
          memberUpsertErrors.push(group.group_code + '_DEL: ' + delResult.error.message);
        }
        var memberInsert = await supabase.from('sector_hot_members_latest').insert(memberRows);
        if (memberInsert.error) {
          memberUpsertErrors.push(group.group_code + ': ' + memberInsert.error.message + (memberInsert.error.details ? ' | ' + memberInsert.error.details : '') + (memberInsert.error.hint ? ' | hint: ' + memberInsert.error.hint : ''));
        } else {
          memberRowsInserted += memberRows.length;
        }
      }

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
      failedTickers: failedTickers.length > 0 ? failedTickers : undefined,
      memberUpsertErrors: memberUpsertErrors.length > 0 ? memberUpsertErrors : undefined,
      memberInsertErrors: memberUpsertErrors.length > 0 ? memberUpsertErrors : undefined,
      memberRowsAttempted: memberRowsAttempted,
      memberRowsInserted: memberRowsInserted,
      zeroActiveGroupsCleaned: zeroActiveGroupsCleaned,
      sample_member: sampleMemberRow || undefined,
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
  var opens = candles.map(function(c) { return c.open; });
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

  // Entry area — precision-based, tight actionable zone
  // Range width based on price level (IDX tick-size awareness)
  var pctWidth = 0.015; // default 1.5%
  if (last_price < 200) pctWidth = 0.02;
  else if (last_price < 1000) pctWidth = 0.015;
  else if (last_price < 5000) pctWidth = 0.012;
  else pctWidth = 0.008;

  var entryBase = Math.max(primarySupport, ma20 ? ma20 * 0.99 : primarySupport);
  // Entry_low: near support/MA but capped close to current price (max 3% below)
  var entry_low = round0(Math.min(entryBase, last_price * (1 - pctWidth)));
  if (entry_low < last_price * 0.97) entry_low = round0(last_price * 0.97);
  var entry_high = round0(entry_low + last_price * pctWidth);

  // === ATR14 CALCULATION (V2 Guard A4) ===
  var atr14 = null;
  if (candles.length >= 15) {
    var trSum = 0;
    var trCount = 0;
    for (var ai = lastIdx - 13; ai <= lastIdx; ai++) {
      if (ai < 1) continue;
      var trHigh = highs[ai] - lows[ai];
      var trHighPrev = Math.abs(highs[ai] - closes[ai - 1]);
      var trLowPrev = Math.abs(lows[ai] - closes[ai - 1]);
      var tr = Math.max(trHigh, trHighPrev, trLowPrev);
      trSum += tr;
      trCount++;
    }
    if (trCount > 0) atr14 = trSum / trCount;
  }

  // Stop loss — ATR-aware (V2 Guard A4)
  var entryMid = (entry_low + entry_high) / 2;
  var sl_candidate = round0(primarySupport * 0.985);
  var sl_max = round0(entryMid * 0.95);
  var stop_loss = Math.max(sl_candidate, sl_max);
  if (stop_loss >= entry_low) {
    stop_loss = round0(entry_low * 0.965);
  }

  // ATR-based SL refinement: use 1.5x ATR as guard
  var atrSlUsed = false;
  if (atr14 && atr14 > 0) {
    var atrStop = round0(entryMid - (1.5 * atr14));
    // Only tighten if existing SL is too far; don't widen excessively
    var existingSlDist = entryMid - stop_loss;
    var atrSlDist = entryMid - atrStop;
    if (existingSlDist > atrSlDist * 1.3 && atrStop < entry_low && atrStop > entryMid * 0.92) {
      // Tighten: ATR says existing SL is too far
      stop_loss = atrStop;
      atrSlUsed = true;
    } else if (atrSlDist > existingSlDist * 1.5 && atrStop > entryMid * 0.92) {
      // ATR says SL may be too close for this volatility — slightly widen
      var widened = round0(entryMid - (1.2 * atr14));
      if (widened < entry_low && widened > entryMid * 0.92) {
        stop_loss = Math.min(widened, stop_loss);
      }
    }
  }

  // Final SL safety: max 5% from entry
  if (stop_loss < entryMid * 0.95) {
    stop_loss = round0(entryMid * 0.95);
  }
  if (stop_loss >= entry_low) {
    stop_loss = round0(entry_low * 0.965);
  }

  // TP levels
  var tp1 = round0(resistance);
  var range = resistance - primarySupport;
  var tp2 = round0(resistance + range * 0.5);

  // Risk/Reward — recalculated after ATR adjustment
  var risk = entryMid - stop_loss;
  var reward1 = tp1 - entryMid;
  var risk_reward = risk > 0 ? round2(reward1 / risk) : 0;

  var invalidation = 'Close < ' + round0(stop_loss);

  // === V2 CANDLE ANALYSIS (A1 + A2) ===
  var lastCandle = candles[lastIdx];
  var candleOpen = lastCandle.open;
  var candleHigh = lastCandle.high;
  var candleLow = lastCandle.low;
  var candleClose = lastCandle.close;
  var candleRange = candleHigh - candleLow;
  var body = Math.abs(candleClose - candleOpen);
  var upperShadow = candleHigh - Math.max(candleOpen, candleClose);
  var lowerShadow = Math.min(candleOpen, candleClose) - candleLow;
  var closePosition = candleRange > 0 ? (candleClose - candleLow) / candleRange : 0.5;
  var volRatio = volAvg20 > 0 ? volumes[lastIdx] / volAvg20 : 0;
  var isBullish = candleClose > candleOpen;

  // A1: Volume Accumulation vs Distribution
  var isAccumulation = isBullish && closePosition >= 0.55 && volRatio >= 1.0;
  var isDistribution = false;
  var distributionStrength = 0; // 0=none, 1=mild, 2=strong
  if (!isBullish && volRatio >= 1.5) { isDistribution = true; distributionStrength = volRatio >= 2.0 ? 2 : 1; }
  else if (volRatio >= 2.0 && closePosition < 0.5) { isDistribution = true; distributionStrength = 2; }
  else if (upperShadow > body * 1.5 && volRatio >= 1.5) { isDistribution = true; distributionStrength = body > 0 && upperShadow > body * 2.0 ? 2 : 1; }
  else if (upperShadow > body * 2.0 && closePosition < 0.6) { isDistribution = true; distributionStrength = 1; }

  // Legacy isLargeRed (kept for backward compat in scoring — now subsumed by distribution guard)
  var bodySize = body;
  var totalRange = candleRange;
  var isLargeRed = !isBullish && bodySize > totalRange * 0.6 && volumes[lastIdx] > volAvg20 * 1.5;

  // A2: Candle Rejection / Indecision
  var bodyRatio = candleRange > 0 ? body / candleRange : 0.5;
  var isDoji = bodyRatio < 0.25 && volRatio < 1.3;
  var isStrongRejection = upperShadow > body * 2.0 && closePosition < 0.6 && volRatio >= 1.2;

  // Detect overextended (V2: stricter threshold for Konglo: >10% above MA20)
  var overextended = ma20 > 0 ? (last_price - ma20) / ma20 > 0.10 : false;
  // V2 A6: distance above MA20 for Wait Pullback
  var distAboveMA20Pct = ma20 > 0 ? round2((last_price - ma20) / ma20 * 100) : 0;

  // === V2 Trend Strength Proxy (A5 — light bonus/penalty only) ===
  // NOTE: This is a lightweight DX-based proxy, NOT full Wilder-smoothed ADX14.
  // Used only for ±3-5 bonus/penalty. Not exposed to UI as "ADX14".
  var trendStrengthProxy = null;
  if (candles.length >= 28) {
    try {
      var plusDMs = [];
      var minusDMs = [];
      var trs = [];
      for (var di = 1; di <= lastIdx; di++) {
        var trH = highs[di] - lows[di];
        var trHP = Math.abs(highs[di] - closes[di - 1]);
        var trLP = Math.abs(lows[di] - closes[di - 1]);
        trs.push(Math.max(trH, trHP, trLP));
        var upMove = highs[di] - highs[di - 1];
        var downMove = lows[di - 1] - lows[di];
        plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
      }
      if (trs.length >= 14) {
        // Simple 14-period averages (not full Wilder smoothing)
        var startI = trs.length - 14;
        var sumTR = 0, sumPlusDM = 0, sumMinusDM = 0;
        for (var si = startI; si < trs.length; si++) {
          sumTR += trs[si];
          sumPlusDM += plusDMs[si];
          sumMinusDM += minusDMs[si];
        }
        var avgTR14 = sumTR / 14;
        var plusDI = avgTR14 > 0 ? (sumPlusDM / 14) / avgTR14 * 100 : 0;
        var minusDI = avgTR14 > 0 ? (sumMinusDM / 14) / avgTR14 * 100 : 0;
        var diSum = plusDI + minusDI;
        var dx = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;
        trendStrengthProxy = round2(dx);
      }
    } catch (e) { trendStrengthProxy = null; } // Fail silently
  }

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
    _slDistance: risk > 0 && entryMid > 0 ? round2(risk / entryMid * 100) : 99,
    // V2 Guard fields
    _isAccumulation: isAccumulation,
    _isDistribution: isDistribution,
    _distributionStrength: distributionStrength,
    _isDoji: isDoji,
    _isStrongRejection: isStrongRejection,
    _volRatio: round2(volRatio),
    _closePosition: round2(closePosition),
    _upperShadow: upperShadow,
    _body: body,
    _atr14: atr14 ? round2(atr14) : null,
    _atrSlUsed: atrSlUsed,
    _adx14: trendStrengthProxy,
    _distAboveMA20Pct: distAboveMA20Pct
  };
}

// ============================================================
// SCREENER: SCORING & CLASSIFICATION
// ============================================================

function scoreAndClassify(data) {
  var score = 50;
  var v2Notes = []; // Collect V2 guard notes for status_reason

  // TREND
  if (data.ma20 && data.last_price >= data.ma20) score += 10;
  else if (data.ma20 && data.last_price >= data.ma20 * 0.98) score += 5;
  else score -= 5;

  if (data.ma50 && data.last_price >= data.ma50) score += 10;
  else if (data.ma50 && data.last_price >= data.ma50 * 0.97) score += 3;
  else score -= 10;

  // MOMENTUM / RSI — V2 Guard A3: widened realistic range
  if (data.rsi14 !== null) {
    if (data.rsi14 >= 45 && data.rsi14 <= 70) score += 15;        // V2: widened from 68 to 70
    else if (data.rsi14 >= 40 && data.rsi14 < 45) score += 8;     // early accumulation
    else if (data.rsi14 > 70 && data.rsi14 <= 75) score += 5;     // momentum ok but caution
    else if (data.rsi14 >= 30 && data.rsi14 < 40) score += 3;     // oversold zone
    else if (data.rsi14 > 75 && data.rsi14 <= 80) score -= 5;     // V2: gradual penalty
    else if (data.rsi14 > 80) score -= 12;                         // V2: strong overbought penalty
    else score -= 10;                                               // extreme low
  }

  // VOLUME — V2 Guard A1: Volume bonus conditional on accumulation/distribution
  if (data._isAccumulation) {
    // Full volume bonus — bullish candle with good close position
    if (data.volume_ratio_avg20 >= 1.5) score += 15;
    else if (data.volume_ratio_avg20 >= 1.2) score += 12;
    else if (data.volume_ratio_avg20 >= 0.8) score += 5;
    else score -= 5;
  } else if (data._isDistribution) {
    // V2: Distribution candle — reduce or negate volume bonus, apply penalty
    if (data._distributionStrength >= 2) {
      // Strong distribution: no volume bonus + penalty
      score -= 15;
      v2Notes.push('Volume tinggi tetapi candle distribusi/rejection. Hati-hati false breakout.');
    } else {
      // Mild distribution: reduced bonus + small penalty
      score -= 8;
      v2Notes.push('Volume meningkat dengan tekanan jual. Waspadai distribusi.');
    }
  } else {
    // Normal candle (no strong signal either way) — standard volume bonus
    if (data.volume_ratio_avg20 >= 1.5) score += 12;  // slightly reduced vs accumulation
    else if (data.volume_ratio_avg20 >= 1.2) score += 10;
    else if (data.volume_ratio_avg20 >= 0.8) score += 5;
    else score -= 5;
  }

  // RISK/REWARD
  if (data.risk_reward >= 2.5) score += 15;
  else if (data.risk_reward >= 2.0) score += 12;
  else if (data.risk_reward >= 1.5) score += 8;
  else if (data.risk_reward >= 1.0) score += 3;
  else score -= 5;

  // === V2 Guard A2: Candle Rejection / Indecision penalty ===
  if (data._isStrongRejection) {
    score -= 12;
    v2Notes.push('Upper shadow besar dengan volume tinggi. Entry jangan dikejar.');
  } else if (data._isDoji) {
    score -= 5;
    v2Notes.push('Candle indecision/doji. Tunggu konfirmasi arah.');
  }

  // === V2 Guard A5: Trend strength proxy (lightweight DX-based, NOT full ADX14) ===
  if (data._adx14 !== null) {
    if (data._adx14 > 25) { score += 5; }          // Strong trend
    else if (data._adx14 > 20) { score += 3; }     // Moderate trend
    else if (data._adx14 < 15) { score -= 5; }     // Weak/no trend
    else if (data._adx14 < 18) { score -= 3; }     // Below threshold
  }

  // PENALTIES (legacy + enhanced)
  if (data._isLargeRed && !data._isDistribution) score -= 15; // avoid double-penalty with distribution guard
  if (data._overextended) score -= 10;
  if (data._belowSupport) score -= 15;
  if (data._slDistance > 5) score -= 8;

  // V2 Guard A4: ATR SL note
  if (data._atrSlUsed) {
    v2Notes.push('SL disesuaikan berbasis volatilitas ATR.');
  }
  if (data._slDistance > 5) {
    v2Notes.push('Risk terlalu jauh dari entry. Tunggu setup lebih dekat.');
  }

  // V2 Guard A6: Wait Pullback for overextended above MA20 (>10%)
  if (data._distAboveMA20Pct > 12) {
    score -= 5; // additional penalty beyond _overextended
    v2Notes.push('Harga sudah jauh di atas MA20 (+' + data._distAboveMA20Pct.toFixed(1) + '%). Tunggu pullback, jangan chase.');
  }

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
  // V2 Guard A3: RSI range for Swing Ready widened to 45-70, but >75 blocks, >80 hard block
  if (!(data.rsi14 !== null && data.rsi14 >= 45 && data.rsi14 <= 70)) {
    passesAllHardFilters = false;
    if (data.rsi14 === null) failReasons.push('RSI tidak tersedia');
    else if (data.rsi14 > 80) failReasons.push('RSI overbought (' + data.rsi14.toFixed(0) + ')');
    else if (data.rsi14 > 70) failReasons.push('RSI tinggi (' + data.rsi14.toFixed(0) + ')');
    else if (data.rsi14 < 45) failReasons.push('RSI terlalu rendah');
    else failReasons.push('RSI tidak ideal');
  }
  // V2: RSI >80 absolute block
  if (data.rsi14 !== null && data.rsi14 > 80) { passesAllHardFilters = false; if (failReasons.indexOf('RSI overbought (' + data.rsi14.toFixed(0) + ')') < 0) failReasons.push('RSI overbought'); }
  if (!(data.volume_ratio_avg20 >= 1.0)) { passesAllHardFilters = false; failReasons.push('Volume belum cukup'); }
  if (!(data.risk_reward >= 1.5)) { passesAllHardFilters = false; failReasons.push('RR kurang layak'); }
  if (!(data._slDistance <= 5)) { passesAllHardFilters = false; failReasons.push('SL terlalu jauh'); }
  if (data._isLargeRed) { passesAllHardFilters = false; failReasons.push('Candle distribusi'); }
  // V2 Guard A1: Strong distribution blocks Swing Ready
  if (data._isDistribution && data._distributionStrength >= 2) { passesAllHardFilters = false; failReasons.push('Distribusi kuat'); }
  // V2 Guard A2: Strong rejection blocks Swing Ready
  if (data._isStrongRejection) { passesAllHardFilters = false; failReasons.push('Candle rejection kuat'); }
  if (data._overextended) { passesAllHardFilters = false; failReasons.push('Overextended'); }
  // V2 Guard A6: >10% above MA20 blocks Swing Ready for Konglo
  if (data._distAboveMA20Pct > 10) { passesAllHardFilters = false; failReasons.push('Jauh di atas MA20'); }
  if (data._belowSupport) { passesAllHardFilters = false; failReasons.push('Breakdown support'); }

  if (passesAllHardFilters) {
    status = 'Swing Ready';
    status_reason = 'Setup lengkap: trend, momentum, volume, RR layak.';
  } else if (data._distAboveMA20Pct > 10 && score >= 55) {
    // V2 Guard A6: Overextended — Wait Pullback
    status = 'Watchlist';
    status_reason = 'Harga jauh di atas MA20 (+' + data._distAboveMA20Pct.toFixed(1) + '%). Tunggu pullback.';
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

  // Append V2 guard notes to status_reason
  if (v2Notes.length > 0) {
    status_reason += ' | ' + v2Notes.join(' ');
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
  var maxTokens = parseInt(process.env.SCREENER_AI_MAX_OUTPUT_TOKENS || '800', 10);

  if (!apiKey) return { data: [], diagnostic: 'API key missing.' };

  // Compact line protocol: ticker|status|score|last|chg|rsi|vol|tx1d|entry|sl|tp1|tp2|rr
  var inputLines = candidates.map(function(c) {
    var tx1dB = c.tx_value_1d ? (c.tx_value_1d / 1e9).toFixed(1) + 'B' : '-';
    return c.ticker + '|' + (c.status || '-').replace('Swing Ready', 'READY').replace('Watchlist', 'WATCH').replace('Rebound Speculative', 'REBOUND').replace('Invalid', 'INV') + '|' + c.score + '|' + c.last_price + '|' + (c.change_pct || 0) + '|' + (c.rsi14 || '-') + '|' + c.volume_ratio_avg20 + '|' + tx1dB + '|' + c.entry_low + '-' + c.entry_high + '|' + c.stop_loss + '|' + c.tp1 + '|' + c.tp2 + '|' + c.risk_reward;
  });

  var systemPrompt = 'You are an IDX swing 3-7D validator. Return ONLY compact lines.\nFormat: TICKER|STATUS|CODES\nSTATUS: C=CONFIRMED, W=CAUTION, R=REJECT.\nCODES max 3 from: TREND_OK,TREND_WEAK,RSI_OK,RSI_LOW,RSI_HIGH,VOL_OK,VOL_WEAK,VALUE_OK,RR_OK,RR_LOW,ENTRY_OK,ENTRY_FAR,OVEREXT,SUPPORT,BREAKOUT,REBOUND.\nReturn exactly one line per ticker, same order as input. No JSON. No markdown. No extra text.';

  var userPrompt = 'Validate:\n' + inputLines.join('\n');

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
        temperature: 0
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

    // === LINE PROTOCOL PARSER ===
    // Expected format: TICKER|STATUS|CODES (one per line)
    // STATUS: C=CONFIRMED, W=CAUTION, R=REJECT
    var contentClean = content.replace(/```[a-z]*\s*/g, '').replace(/```\s*/g, '').trim();
    var outputLines = contentClean.split('\n').filter(function(l) { return l.trim().length > 0 && l.includes('|'); });

    if (outputLines.length === 0) {
      // Fallback: try JSON parse if model returned JSON despite instructions
      try {
        var jsonFallback = JSON.parse(contentClean.substring(contentClean.indexOf('['), contentClean.lastIndexOf(']') + 1));
        if (Array.isArray(jsonFallback) && jsonFallback.length > 0) {
          return { data: jsonFallback, diagnostic: 'Fallback JSON parsed. ' + jsonFallback.length + ' items.', usage: data.usage ? Object.assign({}, data.usage, { _finish_reason: finishReason }) : { _finish_reason: finishReason } };
        }
      } catch (e) { /* not JSON either */ }

      return { data: [], diagnostic: 'AI output has no parseable lines. Content length: ' + content.length + '. Preview: ' + content.substring(0, 100), usage: data.usage ? Object.assign({}, data.usage, { _finish_reason: finishReason }) : { _finish_reason: finishReason } };
    }

    // Parse each line: TICKER|STATUS|CODES
    var codeToReason = {
      'TREND_OK': 'Trend bagus', 'TREND_WEAK': 'Trend lemah',
      'RSI_OK': 'RSI sehat', 'RSI_LOW': 'RSI rendah', 'RSI_HIGH': 'RSI tinggi',
      'VOL_OK': 'Volume kuat', 'VOL_WEAK': 'Volume lemah',
      'VALUE_OK': 'Value aktif', 'RR_OK': 'RR valid', 'RR_LOW': 'RR rendah',
      'ENTRY_OK': 'Entry baik', 'ENTRY_FAR': 'Entry belum ideal',
      'OVEREXT': 'Overextended', 'SUPPORT': 'Dekat support',
      'BREAKOUT': 'Breakout setup', 'REBOUND': 'Rebound setup'
    };

    var parsed = [];
    for (var li = 0; li < outputLines.length; li++) {
      var parts = outputLines[li].trim().split('|');
      if (parts.length < 2) continue;
      var ticker = parts[0].trim().toUpperCase().replace(/\.JK$/i, '');
      var statusCode = parts[1].trim().toUpperCase();
      var codes = parts.length >= 3 ? parts[2].trim().split(',').slice(0, 3) : [];

      var aiStatus = 'CAUTION';
      if (statusCode === 'C' || statusCode === 'CONFIRMED') aiStatus = 'CONFIRMED';
      else if (statusCode === 'R' || statusCode === 'REJECT') aiStatus = 'REJECT';
      else aiStatus = 'CAUTION';

      var reasonParts = codes.map(function(c) { return codeToReason[c.trim()] || c.trim(); });
      var aiReason = reasonParts.join(', ') || aiStatus;

      parsed.push({ ticker: ticker, ai_status: aiStatus, ai_reason: aiReason, ai_red_flags: codes.filter(function(c) { var ct = c.trim(); return ct === 'TREND_WEAK' || ct === 'RSI_LOW' || ct === 'RSI_HIGH' || ct === 'VOL_WEAK' || ct === 'RR_LOW' || ct === 'ENTRY_FAR' || ct === 'OVEREXT'; }) });
    }

    return { data: parsed, diagnostic: 'Line protocol OK. Parsed ' + parsed.length + ' items. finishReason: ' + finishReason, usage: data.usage ? Object.assign({}, data.usage, { _finish_reason: finishReason }) : { _finish_reason: finishReason } };
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
// PUBLIC SCREENER SHARE LINK — HMAC Token (no DB required)
// ============================================================

/**
 * Helper: get the signing secret for share tokens.
 * Prefers SHARE_LINK_SECRET, falls back to CRON_SECRET.
 * Returns null if neither is configured.
 */
function getShareSigningSecret() {
  return process.env.SHARE_LINK_SECRET || process.env.CRON_SECRET || null;
}

/**
 * Create a signed share token (CRON_SECRET or admin-authenticated).
 * Token is HMAC-SHA256 signed with share signing secret.
 * Expires at end of current WIB day (23:59:59 WIB).
 */
async function handleCreateScreenerShareLink(req, res) {
  // Auth: require CRON_SECRET
  var CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) {
    return res.status(200).json({ success: false, error: 'Not configured.' });
  }
  var authHeader = req.headers.authorization || '';
  var providedSecret = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (providedSecret !== CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  var SHARE_SECRET = getShareSigningSecret();
  if (!SHARE_SECRET) {
    return res.status(200).json({ success: false, error: 'Share link signing secret not configured (need SHARE_LINK_SECRET or CRON_SECRET).' });
  }

  // Calculate WIB date
  var now = new Date();
  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  var wibNow = new Date(wibMs);
  var wibDateStr = wibNow.toISOString().slice(0, 10); // YYYY-MM-DD in WIB
  var expiryWib = new Date(wibDateStr + 'T23:59:59+07:00');

  // === COMPACT TOKEN: YYMMDD-<16char_base64url_hmac> ===
  var crypto = require('crypto');
  var yy = wibDateStr.slice(2, 4);
  var mm = wibDateStr.slice(5, 7);
  var dd = wibDateStr.slice(8, 10);
  var dateCode = yy + mm + dd; // e.g. "260610"
  var hmacInput = 'screener_share:' + dateCode;
  var fullHmac = crypto.createHmac('sha256', SHARE_SECRET).update(hmacInput).digest();
  var shortSig = fullHmac.slice(0, 12).toString('base64url'); // 12 bytes = 16 chars base64url
  var compactToken = dateCode + '-' + shortSig;

  // Build compact URL (primary)
  var baseUrl = req.headers['x-forwarded-host'] || req.headers.host || '';
  var protocol = req.headers['x-forwarded-proto'] || 'https';
  var shareUrl = protocol + '://' + baseUrl + '/?s=' + compactToken;

  // Also generate legacy long token for backward compat
  var payload = { scope: 'screener_public_share', sections: ['konglo', 'non_konglo', 'daytrade'], date: wibDateStr, exp: Math.floor(expiryWib.getTime() / 1000) };
  var payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  var legacySig = crypto.createHmac('sha256', SHARE_SECRET).update(payloadB64).digest('base64url');
  var legacyUrl = protocol + '://' + baseUrl + '/?share=screener&token=' + payloadB64 + '.' + legacySig;

  return res.status(200).json({
    success: true,
    url: shareUrl,
    compact_token: compactToken,
    legacy_url: legacyUrl,
    expires_at: expiryWib.toISOString(),
    expires_label: wibDateStr + ' 23:59 WIB',
    date: wibDateStr
  });
}

/**
 * Validate share token and return read-only screener data.
 * No login required. Token must be valid HMAC + not expired.
 */
async function handlePublicScreenerShare(req, res, supabase) {
  var token = (req.query.token || '').trim();
  if (!token) {
    return res.status(200).json({ success: false, error: 'Token tidak ditemukan.', expired: true });
  }

  var SHARE_SECRET = getShareSigningSecret();
  if (!SHARE_SECRET) {
    return res.status(200).json({ success: false, error: 'Share link tidak dikonfigurasi.' });
  }

  var crypto = require('crypto');
  var isValid = false;
  var tokenDate = null; // YYYY-MM-DD

  // === TRY COMPACT FORMAT: YYMMDD-<16char_sig> ===
  var compactMatch = token.match(/^(\d{6})-([A-Za-z0-9_-]{16})$/);
  if (compactMatch) {
    var dateCode = compactMatch[1]; // YYMMDD
    var providedSig = compactMatch[2];

    // Reconstruct date
    var yy = dateCode.slice(0, 2);
    var mm = dateCode.slice(2, 4);
    var dd = dateCode.slice(4, 6);
    tokenDate = '20' + yy + '-' + mm + '-' + dd;

    // Check if today in WIB
    var nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
    var todayWib = nowWib.toISOString().slice(0, 10);
    if (tokenDate !== todayWib) {
      return res.status(200).json({ success: false, error: 'Link sudah kedaluwarsa. Minta link baru.', expired: true });
    }

    // Verify HMAC (timing-safe comparison)
    var hmacInput = 'screener_share:' + dateCode;
    var expectedHmac = crypto.createHmac('sha256', SHARE_SECRET).update(hmacInput).digest();
    var expectedSig = expectedHmac.slice(0, 12).toString('base64url');

    try {
      isValid = crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig));
    } catch (e) {
      isValid = (providedSig === expectedSig);
    }

    if (!isValid) {
      return res.status(200).json({ success: false, error: 'Link tidak valid.', expired: true });
    }
  }
  // === LEGACY FORMAT: payloadB64.signature ===
  else {
    var parts = token.split('.');
    if (parts.length !== 2) {
      return res.status(200).json({ success: false, error: 'Token format invalid.', expired: true });
    }

    var payloadB64 = parts[0];
    var providedLegacySig = parts[1];

    // Verify HMAC
    var expectedLegacySig = crypto.createHmac('sha256', SHARE_SECRET).update(payloadB64).digest('base64url');
    if (providedLegacySig !== expectedLegacySig) {
      return res.status(200).json({ success: false, error: 'Link tidak valid.', expired: true });
    }

    // Decode payload
    var payload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    } catch (e) {
      return res.status(200).json({ success: false, error: 'Token rusak.', expired: true });
    }

    if (payload.scope !== 'screener_public_share') {
      return res.status(200).json({ success: false, error: 'Token scope invalid.', expired: true });
    }

    // Check expiry
    var nowTs = Math.floor(Date.now() / 1000);
    if (payload.exp && nowTs > payload.exp) {
      return res.status(200).json({ success: false, error: 'Link sudah kedaluwarsa. Minta link baru.', expired: true });
    }

    isValid = true;
    tokenDate = payload.date;
  }

  if (!isValid) {
    return res.status(200).json({ success: false, error: 'Link tidak valid.', expired: true });
  }

  // Token valid — calculate expiry for display
  var expiryDisplay = tokenDate ? tokenDate + ' 23:59 WIB' : null;
  var expiryIso = tokenDate ? new Date(tokenDate + 'T23:59:59+07:00').toISOString() : null;

  // Fetch read-only screener data
  var result = { success: true, expires_at: expiryIso, date: tokenDate, sections: ['konglo', 'non_konglo', 'daytrade'] };

  // Konglo Screener latest
  var { data: kongloMeta } = await supabase.from('swing_screener_meta').select('*').eq('id', 'latest').maybeSingle();
  var { data: kongloRows } = await supabase.from('swing_screener_latest').select('*').order('score', { ascending: false });
  result.konglo = { meta: kongloMeta || null, results: kongloRows || [] };

  // Non-Konglo Screener latest
  var { data: nkMeta } = await supabase.from('swing_screener_non_konglo_meta').select('*').eq('id', 'latest').maybeSingle();
  var { data: nkRows } = await supabase.from('swing_screener_non_konglo_latest').select('*').order('rank', { ascending: true });
  result.non_konglo = { meta: nkMeta || null, results: nkRows || [] };

  // Day Trade Screener latest
  var { data: dtMeta } = await supabase.from('daytrade_screener_meta').select('*').eq('id', 'latest').maybeSingle();
  var { data: dtRows } = await supabase.from('daytrade_screener_latest').select('*').order('daytrade_score', { ascending: false }).limit(50);
  result.daytrade = { meta: dtMeta || null, results: dtRows || [] };

  return res.status(200).json(result);
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

  // 2. Time-window note (informational only — no longer blocks authenticated manual runs)
  // All calls here are already authenticated via CRON_SECRET (verified above).
  // Cron/schedule is disabled. Only manual runners (Streamlit, GitHub Actions) call this.
  // Removing hard block so manual testing works anytime.
  var _nkOutsideWindow = !isWithinNkRunWindow();
  var _nkTimeNote = _nkOutsideWindow ? 'Manual run outside recommended window (19:30-21:30 WIB, Mon-Fri).' : null;

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

  // force=1 with scanning status: start a CLEAN fresh run
  // This safely clears stale jobs/staging from a crashed previous run.
  // handleNkScreenerStart already deletes old jobs + staging for today's runDate.
  // Latest published rows (swing_screener_non_konglo_latest) are NOT wiped here —
  // they are only replaced during finalize after new results are ready.
  if (req.query.force === '1' && meta.status === 'scanning') {
    return await handleNkScreenerStart(req, res, supabase);
  }

  // If scanning (without force), process next batch
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

    // Check if there are still-stuck processing jobs (block finalize)
    const { data: processingJobs } = await supabase
      .from('swing_screener_non_konglo_jobs')
      .select('id')
      .eq('run_date', runDate)
      .eq('status', 'processing')
      .limit(1);

    if (processingJobs && processingJobs.length > 0) {
      return res.status(200).json({
        success: false,
        error: 'Batch masih dalam status processing (kemungkinan timeout). Gunakan force=1 untuk reset.',
        step: 'blocked',
        processing_count: processingJobs.length
      });
    }

    // No pending, no processing → finalize
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

  // Get excluded tickers (tickers already in Konglo groups — only active members)
  const { data: kongloMembers } = await supabase
    .from('sector_hot_group_members')
    .select('ticker')
    .eq('is_active', true);
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

  // Create batches of 8 (smaller to avoid Vercel timeout)
  const BATCH_SIZE = 8;
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
  var stagingError = null;
  if (results.length > 0) {
    var { error: upsErr } = await supabase
      .from('swing_screener_non_konglo_staging')
      .upsert(results, { onConflict: 'run_date,ticker' });
    if (upsErr) {
      stagingError = upsErr.message + (upsErr.details ? ' | ' + upsErr.details : '');
    }
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
    failed: failedCount,
    staging_error: stagingError || null
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
    return res.status(200).json({ success: false, error: 'Failed to read staging.', staging_error: stagErr.message });
  }

  // Count total staging rows for diagnostics
  var { count: totalStagingCount } = await supabase
    .from('swing_screener_non_konglo_staging')
    .select('*', { count: 'exact', head: true })
    .eq('run_date', runDate);

  // If no candidates passed filters, do NOT mark as published
  if (!topCandidates || topCandidates.length === 0) {
    await updateNkMeta(supabase, {
      status: 'failed',
      published_count: 0,
      message: 'No candidates passed filters. Staging count: ' + (totalStagingCount || 0)
    });
    return res.status(200).json({
      success: false,
      step: 'finalize',
      error: 'No candidates passed filters.',
      published: 0,
      staging_count: totalStagingCount || 0,
      run_date: runDate
    });
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
      tx_value_1d: c.tx_value_1d,
      avg_tx_value_3d: c.avg_tx_value_3d,
      avg_tx_value_7d: c.avg_tx_value_7d,
      traded_days_20d: c.traded_days_20d,
      score: c.score,
      grade: c.grade,
      risk_reward: c.risk_reward,
      volume_ratio_avg20: c.volume_ratio_avg20,
      status: c.status,
      status_reason: c.status_reason,
      setup_type: c.setup_type,
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

  // Only mark as "published" if insert succeeded AND rows > 0
  await updateNkMeta(supabase, {
    status: 'published',
    published_count: publishedCount,
    message: 'Published ' + publishedCount + ' top candidates. Staging: ' + (totalStagingCount || 0),
    calculated_at: new Date().toISOString()
  });

  return res.status(200).json({
    success: true,
    step: 'finalize',
    published: publishedCount,
    staging_count: totalStagingCount || 0,
    run_date: runDate,
    top_ticker: publishedCount > 0 ? topCandidates[0].ticker : null,
    top_score: publishedCount > 0 ? topCandidates[0].score : null
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

    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutoCuan/1.0)' },
      signal: controller.signal
    });
    clearTimeout(fetchTimeout);
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

    // Transaction value 1d, avg 3d, avg 7d
    const txValue1d = validDays[lastIdx].close * validDays[lastIdx].volume;
    const last3 = validDays.slice(-3);
    const avgTxValue3d = last3.map(d => d.close * d.volume).reduce((a, b) => a + b, 0) / last3.length;
    const last7 = validDays.slice(-7);
    const avgTxValue7d = last7.map(d => d.close * d.volume).reduce((a, b) => a + b, 0) / last7.length;

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
    const pullbackEntryHigh = support + (resistance - support) * 0.382;

    // Distance from current price to ideal pullback entry zone
    const distanceAboveEntry = pullbackEntryHigh > 0 ? ((lastClose - pullbackEntryHigh) / pullbackEntryHigh) * 100 : 0;
    const priceInEntryZone = lastClose <= pullbackEntryHigh * 1.03; // within 3% of entry high

    // Detect setup type
    var setupType = 'speculative';
    if (priceInEntryZone && rsi14 !== null && rsi14 >= 30 && rsi14 <= 45) {
      setupType = 'rebound';
    } else if (priceInEntryZone || (ma20 && lastClose >= ma20 * 0.97 && lastClose <= ma20 * 1.03)) {
      setupType = 'pullback';
    } else if (lastClose >= resistance * 0.97 && volumeRatioAvg20 >= 1.2) {
      setupType = 'breakout';
    } else if (ma20 && lastClose > ma20 * 1.05) {
      setupType = 'wait_pullback';
    } else {
      setupType = 'watchlist';
    }

    // Entry/SL based on setupType
    // RULE: For non-breakout setups, entry MUST be at or below current price.
    // Use percentage-based precision for tight actionable zones.
    var pctWidth = 0.015; // default 1.5%
    if (lastClose < 200) pctWidth = 0.02;
    else if (lastClose < 1000) pctWidth = 0.015;
    else if (lastClose < 5000) pctWidth = 0.012;
    else pctWidth = 0.008;

    var entryLow, entryHigh, stopLoss;
    var range = resistance - support;

    if (setupType === 'rebound') {
      // Tight entry near support
      entryLow = Math.round(support);
      entryHigh = Math.round(support + lastClose * pctWidth);
      if (entryHigh > lastClose) entryHigh = Math.round(lastClose);
      stopLoss = Math.round(support * 0.96);
    } else if (setupType === 'pullback') {
      // Tight entry near MA20 pullback zone
      var pullbackCenter = ma20 ? Math.min(ma20, lastClose) : lastClose * 0.98;
      entryLow = Math.round(pullbackCenter * (1 - pctWidth * 0.5));
      entryHigh = Math.round(pullbackCenter * (1 + pctWidth * 0.5));
      // Validate: must not be above current price
      if (entryLow > lastClose) {
        entryLow = Math.round(lastClose * (1 - pctWidth));
        entryHigh = Math.round(lastClose);
        setupType = 'wait_pullback';
      }
      stopLoss = Math.round(entryLow * 0.95);
    } else if (setupType === 'breakout') {
      // Breakout trigger: entry IS above current price (intentional)
      entryLow = Math.round(resistance * 0.98);
      entryHigh = Math.round(resistance * (1 + pctWidth));
      stopLoss = Math.round(resistance * 0.95);
    } else {
      // wait_pullback, watchlist, speculative — tight zone at/below current price
      entryLow = Math.round(lastClose * (1 - pctWidth));
      entryHigh = Math.round(lastClose);
      stopLoss = Math.round(entryLow * 0.96);
    }

    // Final safety: for non-breakout, clamp entry to not exceed current price
    if (setupType !== 'breakout' && entryLow > lastClose) {
      entryLow = Math.round(lastClose * (1 - pctWidth));
      entryHigh = Math.round(lastClose);
      stopLoss = Math.round(entryLow * 0.96);
      setupType = 'speculative';
    }

    // TP based on Fibonacci levels of the 20d range
    const tp1 = Math.round(support + (resistance - support) * 0.618);
    const tp2 = Math.round(resistance);

    // === ENTRY-DISTANCE GUARD ===
    // Calculate entry_distance_pct from ACTUAL entry_high (not Fib zone)
    // This measures how far current price is above the computed entry area.
    var entryDistancePct = entryHigh > 0 ? ((lastClose - entryHigh) / entryHigh) * 100 : 0;
    // Preserve original distance for scoring/catatan before recalculation
    var originalEntryDistancePct = entryDistancePct;

    // If entry is far below current price (>5%), force recalculate entry
    // to be near current price and reclassify setup type.
    // This prevents BULL/BUVA/WIFI/INET-like cases where entry is 15-25% below.
    if (setupType !== 'breakout' && entryDistancePct > 5) {
      // Reclassify: price has moved far above computed entry
      if (entryDistancePct > 8) {
        setupType = 'wait_pullback';
      }
      // Recalculate entry to realistic current-price zone (tight, near last price)
      entryLow = Math.round(lastClose * (1 - pctWidth));
      entryHigh = Math.round(lastClose);
      stopLoss = Math.round(entryLow * 0.96);
    }

    // Risk/Reward based on actual entry (current-price-aware)
    const entryMid = (entryLow + entryHigh) / 2;
    const riskAmt = entryMid - stopLoss;
    const rewardAmt = tp1 - entryMid;
    const riskReward = riskAmt > 0 ? rewardAmt / riskAmt : 0;

    // Penalty signals (matching Konglo screener technical equivalence)
    const lastCandle = validDays[lastIdx];
    const candleBody = Math.abs(lastCandle.close - lastCandle.open);
    const candleRange = lastCandle.high - lastCandle.low;
    const isLargeRed = lastCandle.close < lastCandle.open && candleBody > candleRange * 0.6 && volumeRatioAvg20 >= 1.2;
    const overextended = ma20 && lastClose > ma20 * 1.12; // >12% above MA20 (wider for non-konglo)
    const belowSupport = lastClose < support;
    const slDistance = stopLoss > 0 ? ((entryMid - stopLoss) / entryMid) * 100 : 0;

    // === V2 CANDLE ANALYSIS for Non-Konglo (A1 + A2) ===
    const nkOpen = lastCandle.open;
    const nkHigh = lastCandle.high;
    const nkLow = lastCandle.low;
    const nkClose = lastCandle.close;
    const nkUpperShadow = nkHigh - Math.max(nkOpen, nkClose);
    const nkClosePosition = candleRange > 0 ? (nkClose - nkLow) / candleRange : 0.5;
    const nkIsBullish = nkClose > nkOpen;
    const nkVolRatio = volumeRatioAvg20;

    // A1: Accumulation vs Distribution
    const nkIsAccumulation = nkIsBullish && nkClosePosition >= 0.55 && nkVolRatio >= 1.0;
    let nkIsDistribution = false;
    let nkDistributionStrength = 0;
    if (!nkIsBullish && nkVolRatio >= 1.5) { nkIsDistribution = true; nkDistributionStrength = nkVolRatio >= 2.0 ? 2 : 1; }
    else if (nkVolRatio >= 2.0 && nkClosePosition < 0.5) { nkIsDistribution = true; nkDistributionStrength = 2; }
    else if (nkUpperShadow > candleBody * 1.5 && nkVolRatio >= 1.5) { nkIsDistribution = true; nkDistributionStrength = nkUpperShadow > candleBody * 2.0 ? 2 : 1; }
    else if (nkUpperShadow > candleBody * 2.0 && nkClosePosition < 0.6) { nkIsDistribution = true; nkDistributionStrength = 1; }

    // A2: Candle Rejection / Indecision
    const nkBodyRatio = candleRange > 0 ? candleBody / candleRange : 0.5;
    const nkIsDoji = nkBodyRatio < 0.25 && nkVolRatio < 1.3;
    const nkIsStrongRejection = nkUpperShadow > candleBody * 2.0 && nkClosePosition < 0.6 && nkVolRatio >= 1.2;

    // A6: distance above MA20 for Wait Pullback
    const nkDistAboveMA20Pct = ma20 > 0 ? ((lastClose - ma20) / ma20) * 100 : 0;

    return {
      closes: closesArr,
      lastPrice: lastClose,
      changePct,
      tradedDays20d,
      avgTxValue20d,
      txValue1d,
      avgTxValue3d,
      avgTxValue7d,
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
      setupType,
      // Penalty flags
      isLargeRed: isLargeRed,
      overextended: overextended,
      belowSupport: belowSupport,
      slDistance: slDistance,
      distanceAboveEntry: distanceAboveEntry,
      priceInEntryZone: priceInEntryZone,
      entryDistancePct: Number(originalEntryDistancePct.toFixed(2)),
      last_price: lastClose,
      change_pct: Number(changePct.toFixed(2)),
      volume_ratio_avg20: Number(volumeRatioAvg20.toFixed(2)),
      // V2 Guard fields
      nkIsAccumulation: nkIsAccumulation,
      nkIsDistribution: nkIsDistribution,
      nkDistributionStrength: nkDistributionStrength,
      nkIsDoji: nkIsDoji,
      nkIsStrongRejection: nkIsStrongRejection,
      nkDistAboveMA20Pct: Number(nkDistAboveMA20Pct.toFixed(2))
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

  // 1. TREND (same as Konglo: MA20 +10/+5/-5, MA50 softened)
  if (q.ma20 && q.lastPrice >= q.ma20) { score += 10; components.push('close>MA20'); }
  else if (q.ma20 && q.lastPrice >= q.ma20 * 0.98) { score += 5; components.push('close~MA20'); }
  else { score -= 5; if (q.ma20) components.push('close<MA20'); }

  if (q.ma50 && q.lastPrice >= q.ma50) { score += 10; components.push('close>MA50'); }
  else if (q.ma50 && q.lastPrice >= q.ma50 * 0.97) { score += 3; }
  else if (q.ma50 && q.lastPrice >= q.ma50 * 0.95) { score += 0; }
  else { score -= 3; if (q.ma50) components.push('close<MA50'); }

  // Bonus: price in/near actionable entry zone (+3)
  if (q.priceInEntryZone) { score += 3; components.push('near entry'); }

  // 2. MOMENTUM / RSI — V2 Guard A3: widened realistic range (same as Konglo V2)
  if (q.rsi14 !== null) {
    if (q.rsi14 >= 45 && q.rsi14 <= 70) { score += 15; components.push('RSI ' + q.rsi14.toFixed(1) + ' ideal'); }
    else if (q.rsi14 >= 40 && q.rsi14 < 45) { score += 8; components.push('RSI ' + q.rsi14.toFixed(1) + ' netral'); }
    else if (q.rsi14 > 70 && q.rsi14 <= 75) { score += 5; components.push('RSI ' + q.rsi14.toFixed(1) + ' kuat'); }
    else if (q.rsi14 >= 30 && q.rsi14 < 40) { score += 3; components.push('RSI ' + q.rsi14.toFixed(1) + ' oversold zone'); }
    else if (q.rsi14 > 75 && q.rsi14 <= 80) { score -= 5; components.push('RSI ' + q.rsi14.toFixed(1) + ' overbought'); }
    else if (q.rsi14 > 80) { score -= 12; components.push('RSI ' + q.rsi14.toFixed(1) + ' overbought kuat'); }
    else { score -= 10; components.push('RSI ' + q.rsi14.toFixed(1) + ' extreme'); }
  }

  // 3. VOLUME — V2 Guard A1: conditional on accumulation/distribution
  if (q.nkIsAccumulation) {
    // Full volume bonus — bullish with good close position
    if (q.volumeRatioAvg20 >= 1.5) { score += 15; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x akumulasi'); }
    else if (q.volumeRatioAvg20 >= 1.2) { score += 12; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x above avg'); }
    else if (q.volumeRatioAvg20 >= 0.8) { score += 5; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x normal'); }
    else { score -= 5; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x rendah'); }
  } else if (q.nkIsDistribution) {
    // V2: Distribution — reduced/negated bonus + penalty
    if (q.nkDistributionStrength >= 2) {
      score -= 15; components.push('distribusi kuat vol ' + q.volumeRatioAvg20.toFixed(2) + 'x');
    } else {
      score -= 8; components.push('distribusi ringan vol ' + q.volumeRatioAvg20.toFixed(2) + 'x');
    }
  } else {
    // Normal candle — standard volume bonus (slightly reduced)
    if (q.volumeRatioAvg20 >= 1.5) { score += 12; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x tinggi'); }
    else if (q.volumeRatioAvg20 >= 1.2) { score += 10; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x above avg'); }
    else if (q.volumeRatioAvg20 >= 0.8) { score += 5; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x normal'); }
    else { score -= 5; components.push('vol ' + q.volumeRatioAvg20.toFixed(2) + 'x rendah'); }
  }

  // 4. RISK/REWARD (same as Konglo: +15/+12/+8/+3/-5)
  if (q.riskReward >= 2.5) { score += 15; components.push('RR ' + q.riskReward.toFixed(2) + ' baik'); }
  else if (q.riskReward >= 2.0) { score += 12; components.push('RR ' + q.riskReward.toFixed(2)); }
  else if (q.riskReward >= 1.5) { score += 8; components.push('RR ' + q.riskReward.toFixed(2) + ' minimal'); }
  else if (q.riskReward >= 1.0) { score += 3; }
  else { score -= 5; }

  // 5. PENALTIES (same as Konglo: -15/-10/-15/-8) — V2: avoid double-penalty with distribution
  if (q.isLargeRed && !q.nkIsDistribution) { score -= 15; components.push('candle distribusi'); }
  if (q.overextended && q.setupType !== 'breakout') { score -= 10; components.push('overextended'); }
  if (q.belowSupport) { score -= 15; components.push('breakdown support'); }
  if (q.slDistance > 5) { score -= 8; components.push('SL jauh ' + q.slDistance.toFixed(1) + '%'); }

  // V2 Guard A2: Candle Rejection / Indecision penalty
  if (q.nkIsStrongRejection) { score -= 12; components.push('rejection candle kuat'); }
  else if (q.nkIsDoji) { score -= 5; components.push('candle indecision'); }

  // V2 Guard A6: Wait Pullback for overextended above MA20 (>12% for non-konglo)
  if (q.nkDistAboveMA20Pct > 12) { score -= 5; components.push('jauh di atas MA20 +' + q.nkDistAboveMA20Pct.toFixed(1) + '%'); }

  // 5b. ENTRY-DISTANCE PENALTY (strengthened guard)
  // Use entryDistancePct (from actual entry_high) for realistic penalty
  var edPct = q.entryDistancePct || 0;
  if (edPct > 10) { score -= 15; components.push('entry distance +' + edPct.toFixed(1) + '% — jangan chase'); }
  else if (edPct > 8) { score -= 10; components.push('entry distance +' + edPct.toFixed(1) + '%'); }
  else if (edPct > 5) { score -= 6; components.push('entry moderat +' + edPct.toFixed(1) + '%'); }
  // Legacy distanceAboveEntry (Fib-based) — softer supplemental penalty
  if (q.distanceAboveEntry > 20) { score -= 3; components.push('jauh dari Fib entry'); }

  // 6. LIQUIDITY BONUS (small tie-breaker, max +5 pts)
  var txB = q.avgTxValue20d / 1e9;
  if (txB >= 50) score += 5;
  else if (txB >= 30) score += 3;
  else if (txB >= 20) score += 2;

  // 7. VALUE ACTIVITY BONUS (max +8)
  if (q.avgTxValue7d && q.avgTxValue20d && q.avgTxValue7d > q.avgTxValue20d * 1.3) { score += 5; components.push('recent accumulation'); }
  if (q.txValue1d && q.avgTxValue7d && q.txValue1d > q.avgTxValue7d * 1.5) { score += 3; components.push('today active'); }

  // 8. SETUP TYPE BONUS
  if ((q.setupType === 'pullback' || q.setupType === 'rebound') && q.priceInEntryZone) { score += 3; components.push('setup ' + q.setupType + ' near entry'); }

  score = Math.max(0, Math.min(100, score));

  // GRADE (same thresholds)
  var grade = 'D';
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';

  // STATUS CLASSIFICATION (same logic as Konglo scoreAndClassify)
  // ENHANCED: entry-distance guard prevents far-entry candidates from being actionable
  var status = 'Invalid';
  var statusReason = '';
  var failReasons = [];
  var edPctClassify = q.entryDistancePct || 0;

  // Swing Ready hard filters (matching Konglo V2, score threshold 75)
  var passesAllHardFilters = true;
  if (score < 75) { passesAllHardFilters = false; failReasons.push('Score < 75'); }
  if (!(q.ma20 && q.lastPrice >= q.ma20 * 0.99)) { passesAllHardFilters = false; failReasons.push('Di bawah MA20'); }
  if (!(q.ma50 && q.lastPrice >= q.ma50)) { passesAllHardFilters = false; failReasons.push('Di bawah MA50'); }
  // V2 Guard A3: RSI range widened to 45-70 for Swing Ready
  if (!(q.rsi14 !== null && q.rsi14 >= 45 && q.rsi14 <= 70)) {
    passesAllHardFilters = false;
    if (q.rsi14 === null) failReasons.push('RSI N/A');
    else if (q.rsi14 > 80) failReasons.push('RSI overbought (' + q.rsi14.toFixed(0) + ')');
    else if (q.rsi14 > 70) failReasons.push('RSI tinggi (' + q.rsi14.toFixed(0) + ')');
    else if (q.rsi14 < 45) failReasons.push('RSI rendah');
  }
  // V2: RSI >80 absolute block
  if (q.rsi14 !== null && q.rsi14 > 80) { passesAllHardFilters = false; }
  if (!(q.volumeRatioAvg20 >= 1.0)) { passesAllHardFilters = false; failReasons.push('Vol < 1x'); }
  if (!(q.riskReward >= 1.5)) { passesAllHardFilters = false; failReasons.push('RR kurang'); }
  if (q.slDistance > 5) { passesAllHardFilters = false; failReasons.push('SL jauh'); }
  if (q.isLargeRed) { passesAllHardFilters = false; failReasons.push('Candle distribusi'); }
  // V2 Guard A1: Strong distribution blocks Swing Ready
  if (q.nkIsDistribution && q.nkDistributionStrength >= 2) { passesAllHardFilters = false; failReasons.push('Distribusi kuat'); }
  // V2 Guard A2: Strong rejection blocks Swing Ready
  if (q.nkIsStrongRejection) { passesAllHardFilters = false; failReasons.push('Candle rejection'); }
  if (q.overextended && q.setupType !== 'breakout') { passesAllHardFilters = false; failReasons.push('Overextended'); }
  if (q.belowSupport) { passesAllHardFilters = false; failReasons.push('Breakdown'); }
  // ENTRY-DISTANCE HARD FILTER: >5% above entry = NOT immediately actionable
  if (edPctClassify > 5) { passesAllHardFilters = false; failReasons.push('Entry distance +' + edPctClassify.toFixed(1) + '%'); }
  if (!q.priceInEntryZone && q.distanceAboveEntry > 10) { passesAllHardFilters = false; failReasons.push('Price jauh dari Fib entry'); }
  // V2 Guard A6: >12% above MA20 blocks Swing Ready for Non-Konglo
  if (q.nkDistAboveMA20Pct > 12) { passesAllHardFilters = false; failReasons.push('Jauh di atas MA20'); }
  // Breakout trigger: entry above current price — NOT immediate Swing Ready
  if (q.setupType === 'breakout') { passesAllHardFilters = false; failReasons.push('Breakout trigger (wait konfirmasi)'); }
  // wait_pullback setup — by definition not immediately actionable
  if (q.setupType === 'wait_pullback') { passesAllHardFilters = false; failReasons.push('Wait pullback'); }

  if (passesAllHardFilters) {
    status = 'Swing Ready';
    if (q.priceInEntryZone) {
      statusReason = 'Price near entry area, setup lengkap dan actionable.';
    } else {
      statusReason = 'Setup lengkap: trend, momentum, volume, RR layak.';
    }
  } else if (q.setupType === 'wait_pullback' || edPctClassify > 8) {
    // WAIT_PULLBACK: price too far above entry — not actionable now
    status = 'Wait Pullback';
    statusReason = 'Entry terlewat — tunggu pullback, jangan chase. Entry distance: +' + edPctClassify.toFixed(1) + '%.';
  } else if (edPctClassify > 5 && score >= 55) {
    // Moderate distance — mark as Wait Pullback if score is decent
    status = 'Wait Pullback';
    statusReason = 'Harga sudah di atas entry area (+' + edPctClassify.toFixed(1) + '%). Tunggu pullback ke area entry.';
  } else if (q.rsi14 !== null && q.rsi14 >= 30 && q.rsi14 <= 42 &&
             q.lastPrice > q.support && q.volumeRatioAvg20 >= 0.8 && score >= 40) {
    status = 'Rebound Speculative';
    statusReason = 'Near support, potensi rebound. Konfirmasi bounce + volume.';
  } else if (score >= 60) {
    status = 'Watchlist';
    if (q.distanceAboveEntry > 10) {
      statusReason = 'Wait pullback ke entry area. ' + (failReasons.length > 0 ? failReasons.slice(0, 2).join(', ') : '');
    } else {
      statusReason = failReasons.length > 0 ? 'Tunggu: ' + failReasons.slice(0, 2).join(', ') : 'Menunggu konfirmasi.';
    }
  } else {
    status = 'Speculative';
    statusReason = failReasons.length > 0 ? failReasons.slice(0, 2).join(', ') : 'Setup belum memenuhi kriteria.';
  }

  // TASK 6: Improved status_reason format
  // "[SetupType] Vol X.XXx, Tx1D RpXB, Avg7D RpXB, RSI XX.X, RR X.XX. [Entry interpretation]. [Status explanation]"
  var setupTypeLabel = 'Speculative';
  if (q.setupType === 'pullback') setupTypeLabel = 'Pullback';
  else if (q.setupType === 'rebound') setupTypeLabel = 'Rebound';
  else if (q.setupType === 'breakout') setupTypeLabel = 'Breakout';
  else if (q.setupType === 'wait_pullback') setupTypeLabel = 'Wait Pullback';
  else if (q.setupType === 'watchlist') setupTypeLabel = 'Watchlist';

  var tx1dB = q.txValue1d ? (q.txValue1d / 1e9).toFixed(1) : '0.0';
  var avg7dB = q.avgTxValue7d ? (q.avgTxValue7d / 1e9).toFixed(1) : '0.0';

  var metricLine = '[' + setupTypeLabel + '] Vol ' + q.volumeRatioAvg20.toFixed(2) + 'x, Tx1D Rp' + tx1dB + 'B, Avg7D Rp' + avg7dB + 'B';
  if (q.rsi14 !== null) metricLine += ', RSI ' + q.rsi14.toFixed(1);
  metricLine += ', RR ' + q.riskReward.toFixed(2);

  // Entry interpretation based on setupType and distance
  var entryNote = '';
  if (q.setupType === 'wait_pullback' || edPctClassify > 8) {
    entryNote = ' Entry distance: +' + edPctClassify.toFixed(1) + '%. Tunggu pullback. Jangan chase.';
  } else if (edPctClassify > 5) {
    entryNote = ' Entry distance: +' + edPctClassify.toFixed(1) + '%. Harga sudah jauh dari entry area.';
  } else if (q.setupType === 'rebound' && q.priceInEntryZone) {
    entryNote = ' Entry rebound near support.';
  } else if (q.setupType === 'pullback' && q.priceInEntryZone) {
    entryNote = ' Entry pullback actionable.';
  } else if (q.setupType === 'breakout') {
    entryNote = ' BREAKOUT TRIGGER above current price — wait konfirmasi breakout.';
  } else if (edPctClassify <= 2) {
    entryNote = ' Entry dekat.';
  } else if (edPctClassify <= 5) {
    entryNote = ' Entry moderat (+' + edPctClassify.toFixed(1) + '%).';
  } else {
    entryNote = ' Price jauh dari entry ideal.';
  }

  statusReason = metricLine + '.' + entryNote + ' ' + statusReason;

  // Compute avg_volume_20d
  var avgVolume20d = (q.lastPrice > 0) ? Math.round(q.avgTxValue20d / q.lastPrice) : 0;

  return {
    score: score,
    grade: grade,
    status: status,
    status_reason: statusReason,
    setup_type: q.setupType,
    last_price: q.last_price,
    change_pct: q.change_pct,
    avg_volume_20d: avgVolume20d,
    avg_transaction_value_20d: Math.round(q.avgTxValue20d),
    tx_value_1d: Math.round(q.txValue1d || 0),
    avg_tx_value_3d: Math.round(q.avgTxValue3d || 0),
    avg_tx_value_7d: Math.round(q.avgTxValue7d || 0),
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


// ============================================================
// DAY TRADE SCREENER v1 — READ (public, returns latest results)
// ============================================================
async function handleDayTradeScreenerRead(req, res, supabase) {
  try {
    // Read meta
    var { data: meta, error: metaErr } = await supabase
      .from('daytrade_screener_meta')
      .select('*')
      .eq('id', 'latest')
      .maybeSingle();

    if (metaErr) {
      // Table may not exist yet — graceful fallback
      return res.status(200).json({
        success: true,
        meta: { calculated_at: null, status: 'not_configured', message: 'Day Trade Screener belum dikonfigurasi. Jalankan migration SQL terlebih dahulu.' },
        results: []
      });
    }

    // Read latest results — Top 50 for default display
    var { data: rows, error: rowErr } = await supabase
      .from('daytrade_screener_latest')
      .select('*')
      .order('daytrade_score', { ascending: false })
      .limit(50);

    if (rowErr) {
      return res.status(200).json({
        success: true,
        meta: meta || { calculated_at: null, status: 'not_configured', message: 'Tabel daytrade_screener_latest belum ada.' },
        results: []
      });
    }

    // Sort by status priority (actionable first), then score desc
    var statusPriority = { 'READY_BREAKOUT': 1, 'PRE_SPIKE_WATCH': 2, 'MOMENTUM_CONTINUATION': 3, 'RECLAIM_CANDIDATE': 4, 'WAIT_PULLBACK': 5, 'SPECULATIVE': 6, 'AVOID': 7 };
    var sortedRows = (rows || []).sort(function(a, b) {
      var pa = statusPriority[a.status] || 8;
      var pb = statusPriority[b.status] || 8;
      if (pa !== pb) return pa - pb;
      return (b.daytrade_score || 0) - (a.daytrade_score || 0);
    });

    return res.status(200).json({
      success: true,
      meta: meta || { calculated_at: null, status: 'pending', message: 'Awaiting first calculation.', universe_count: 0, scanned_count: 0, failed_count: 0, published_count: 0 },
      results: sortedRows,
      updated_at: meta ? meta.calculated_at : null,
      calculated_at: meta ? meta.calculated_at : null,
      status: meta ? meta.status : 'pending'
    });
  } catch (e) {
    return res.status(200).json({ success: false, error: 'Gagal memuat Day Trade Screener: ' + e.message, results: [] });
  }
}

// ============================================================
// DAY TRADE SCREENER v1 — RUN (Bearer CRON_SECRET protected)
// ============================================================
async function handleDayTradeScreenerRun(req, res, supabase) {
  // 1. Verify CRON_SECRET
  var CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) {
    return res.status(200).json({ success: false, error: 'Day Trade run not configured (CRON_SECRET missing).' });
  }

  var authHeader = req.headers.authorization || '';
  var providedSecret = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (providedSecret !== CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  // 2. Determine run mode
  var modeOverride = req.query.mode || null;
  var runMode = dtEngine.getRunMode(modeOverride);
  var runDate = dtEngine.getWibDateStr();
  var BATCH_SIZE = 50;
  var batchIndex = parseInt(req.query.batch || '0', 10);

  // 3. Read current meta state
  var { data: meta } = await supabase
    .from('daytrade_screener_meta')
    .select('*')
    .eq('id', 'latest')
    .maybeSingle();

  var runId;

  // 4. If batch > 0 and meta is scanning, continue existing run
  if (batchIndex > 0 && meta && meta.status === 'scanning') {
    runId = meta.run_id || ('dt-' + runDate + '-' + Date.now().toString(36));
  } else if (batchIndex === 0) {
    // Starting fresh
    runId = 'dt-' + runDate + '-' + Date.now().toString(36);

    // Check if already running (prevent accidental double-start)
    if (meta && meta.status === 'scanning' && req.query.force !== '1') {
      return res.status(200).json({
        success: false,
        status: 'already_running',
        run_id: meta.run_id,
        message: 'Day Trade scan sedang berjalan. Gunakan force=1 untuk override.',
        meta: meta
      });
    }

    // Check if already published today (unless force=1)
    if (meta && meta.status === 'published' && meta.run_date === runDate && req.query.force !== '1') {
      return res.status(200).json({
        success: true,
        status: 'already_done',
        run_id: meta.run_id,
        message: 'Day Trade sudah di-publish hari ini (' + runDate + '). Gunakan force=1 untuk refresh.',
        meta: meta
      });
    }

    // Initialize meta for new run
    await updateDtMeta(supabase, {
      status: 'scanning',
      run_date: runDate,
      run_mode: runMode,
      run_id: runId,
      universe_count: 0,
      scanned_count: 0,
      failed_count: 0,
      passed_count: 0,
      published_count: 0,
      top_count: 0,
      message: 'Building universe...'
    });
  } else {
    // batch > 0 but meta is not scanning — stale request
    runId = 'dt-' + runDate + '-' + Date.now().toString(36);
  }

  // 5. Build universe
  var universeResult = await dtEngine.buildDayTradeUniverse(supabase);
  if (universeResult.error || universeResult.tickers.length === 0) {
    await updateDtMeta(supabase, { status: 'failed', message: 'Universe kosong: ' + (universeResult.error || 'No tickers') });
    return res.status(200).json({
      success: false,
      status: 'failed',
      run_id: runId,
      message: 'Failed to build universe: ' + (universeResult.error || 'No tickers found.')
    });
  }

  var universe = universeResult.tickers;
  var universeCount = universe.length;
  var batchCount = Math.ceil(universeCount / BATCH_SIZE);
  var startIdx = batchIndex * BATCH_SIZE;
  var endIdx = Math.min(startIdx + BATCH_SIZE, universeCount);

  // Update universe_count on first batch
  if (batchIndex === 0) {
    await updateDtMeta(supabase, {
      universe_count: universeCount,
      message: 'Scanning batch 1/' + batchCount + ' (' + universeCount + ' tickers)...'
    });
  }

  if (startIdx >= universeCount) {
    // All batches already processed — finalize
    return await finalizeDtScreener(req, res, supabase, runId, runDate, runMode, universeCount, batchCount, meta);
  }

  // 6. Process this batch
  var batchTickers = universe.slice(startIdx, endIdx);
  var batchResult = await dtEngine.runDayTradeBatch(batchTickers, runMode);
  var results = batchResult.results;
  var failedTickers = batchResult.failed;

  // 7. Save batch results to daytrade_screener_latest immediately (upsert per ticker)
  //    Only keep candidates with score >= 50
  var passedResults = results.filter(function(r) { return r.daytrade_score >= 50; });
  var now = new Date().toISOString();
  var batchSaveError = null;

  // On first batch, clear old data
  if (batchIndex === 0) {
    var { error: delErr } = await supabase.from('daytrade_screener_latest').delete().neq('ticker', '');
    if (delErr) batchSaveError = 'Delete failed: ' + delErr.message;
  }

  // Insert passed results for this batch
  if (!batchSaveError && passedResults.length > 0) {
    var batchRows = passedResults.map(function(r) {
      return {
        ticker: r.ticker,
        stock_name: r.stock_name || r.ticker,
        board: r.board || null,
        status: r.status,
        setup: r.setup,
        daytrade_score: r.daytrade_score,
        liquidity_score: r.liquidity_score,
        prespike_score: r.prespike_score,
        momentum_score: r.momentum_score,
        risk_reward_score: r.risk_reward_score,
        trend_score: r.trend_score,
        penalty_score: r.penalty_score,
        last_price: r.last_price,
        change_pct: r.change_pct,
        open_price: r.open_price,
        high_price: r.high_price,
        low_price: r.low_price,
        volume_today: r.volume_today,
        value_today: r.value_today,
        avg_volume_20d: r.avg_volume_20d,
        avg_value_7d: r.avg_value_7d,
        volume_ratio_20d: r.volume_ratio_20d,
        rsi14: r.rsi14,
        ma20: r.ma20,
        ma50: r.ma50,
        resistance: r.resistance,
        support: r.support,
        range_position: r.range_position,
        distance_to_breakout_pct: r.distance_to_breakout_pct,
        entry_low: r.entry_low,
        entry_high: r.entry_high,
        stop_loss: r.stop_loss,
        tp1: r.tp1,
        tp2: r.tp2,
        risk_reward: r.risk_reward,
        invalidation: r.invalidation,
        time_plan: r.time_plan,
        notes: r.notes,
        run_mode: runMode,
        calculated_at: now,
        run_id: runId
      };
    });

    var { error: insErr } = await supabase.from('daytrade_screener_latest').insert(batchRows);
    if (insErr) {
      batchSaveError = 'Insert failed: ' + insErr.message + (insErr.details ? ' | ' + insErr.details : '');
    }
  }

  // 8. Accumulate meta counts
  var prevScanned = (meta && meta.status === 'scanning') ? (meta.scanned_count || 0) : 0;
  var prevFailed = (meta && meta.status === 'scanning') ? (meta.failed_count || 0) : 0;
  var prevPassed = (meta && meta.status === 'scanning') ? (meta.passed_count || 0) : 0;
  // On first batch, reset accumulators
  var totalScanned = (batchIndex === 0 ? 0 : prevScanned) + batchTickers.length;
  var totalFailed = (batchIndex === 0 ? 0 : prevFailed) + failedTickers.length;
  var totalPassed = (batchIndex === 0 ? 0 : prevPassed) + passedResults.length;

  var isLastBatch = (endIdx >= universeCount);

  if (isLastBatch) {
    // Finalize: trim to top 50 by score, delete extras
    return await finalizeDtScreener(req, res, supabase, runId, runDate, runMode, universeCount, batchCount, {
      scanned_count: totalScanned,
      failed_count: totalFailed,
      passed_count: totalPassed
    });
  }

  // Update meta with accumulated progress
  await updateDtMeta(supabase, {
    status: 'scanning',
    run_id: runId,
    universe_count: universeCount,
    scanned_count: totalScanned,
    failed_count: totalFailed,
    passed_count: totalPassed,
    message: 'Batch ' + (batchIndex + 1) + '/' + batchCount + ' done. Scanned ' + totalScanned + '/' + universeCount + '. Passed: ' + totalPassed + '.'
  });

  return res.status(200).json({
    success: true,
    status: 'running',
    run_id: runId,
    run_mode: runMode,
    run_date: runDate,
    batch_index: batchIndex,
    batch_count: batchCount,
    universe_count: universeCount,
    scanned_count: totalScanned,
    failed_count: totalFailed,
    passed_count: totalPassed,
    message: 'Batch ' + (batchIndex + 1) + '/' + batchCount + ' done. Scanned ' + totalScanned + '/' + universeCount + '.',
    next_batch: batchIndex + 1,
    batch_save_error: batchSaveError || null,
    failed_tickers: failedTickers.length > 0 ? failedTickers.slice(0, 10) : undefined
  });
}

// ============================================================
// DAY TRADE SCREENER — FINALIZE (trim to top 50, update status)
// ============================================================
async function finalizeDtScreener(req, res, supabase, runId, runDate, runMode, universeCount, batchCount, counters) {
  // Read all rows currently in daytrade_screener_latest, keep only top 50 by score
  var { data: allRows, error: readErr } = await supabase
    .from('daytrade_screener_latest')
    .select('ticker, daytrade_score, status')
    .order('daytrade_score', { ascending: false });

  var totalPassed = allRows ? allRows.length : 0;
  var savedCount = Math.min(totalPassed, 50);

  // If more than 50 rows, delete extras (keep top 50)
  if (allRows && allRows.length > 50) {
    var tickersToRemove = allRows.slice(50).map(function(r) { return r.ticker; });
    if (tickersToRemove.length > 0) {
      await supabase.from('daytrade_screener_latest').delete().in('ticker', tickersToRemove);
    }
    savedCount = 50;
  }

  // Top count: READY + PRE_SPIKE
  var topCount = allRows ? allRows.slice(0, 50).filter(function(r) {
    return r.status === 'READY_BREAKOUT' || r.status === 'PRE_SPIKE_WATCH';
  }).length : 0;

  var totalScanned = counters ? (counters.scanned_count || universeCount) : universeCount;
  var totalFailed = counters ? (counters.failed_count || 0) : 0;

  // Update meta to published
  await updateDtMeta(supabase, {
    status: 'published',
    run_date: runDate,
    run_mode: runMode,
    run_id: runId,
    universe_count: universeCount,
    scanned_count: totalScanned,
    failed_count: totalFailed,
    passed_count: totalPassed,
    published_count: savedCount,
    top_count: topCount,
    message: 'Scan complete. Published ' + savedCount + ' candidates. Top ' + topCount + ' actionable.'
  });

  // Save run history
  try {
    await supabase.from('daytrade_screener_runs').insert([{
      run_id: runId,
      run_date: runDate,
      run_mode: runMode,
      status: 'published',
      universe_count: universeCount,
      scanned_count: totalScanned,
      failed_count: totalFailed,
      passed_count: totalPassed,
      published_count: savedCount,
      message: batchCount + ' batches complete. Published top ' + savedCount + '.',
      completed_at: new Date().toISOString()
    }]);
  } catch (e) { /* non-critical */ }

  return res.status(200).json({
    success: true,
    status: 'published',
    run_id: runId,
    run_mode: runMode,
    run_date: runDate,
    calculated_at_wib: dtEngine.getWibTimeStr(),
    batch_count: batchCount,
    universe_count: universeCount,
    scanned_count: totalScanned,
    failed_count: totalFailed,
    passed_count: totalPassed,
    saved_count: savedCount,
    published_count: savedCount,
    top_count: topCount,
    message: 'Day Trade Screener run complete. Top ' + savedCount + ' published.'
  });
}

// ============================================================
// DAY TRADE META HELPER
// ============================================================
async function updateDtMeta(supabase, fields) {
  var row = {
    id: 'latest',
    updated_at: new Date().toISOString()
  };
  if (fields.status !== undefined) row.status = fields.status;
  if (fields.run_date !== undefined) row.run_date = fields.run_date;
  if (fields.run_mode !== undefined) row.run_mode = fields.run_mode;
  if (fields.run_id !== undefined) row.run_id = fields.run_id;
  if (fields.universe_count !== undefined) row.universe_count = fields.universe_count;
  if (fields.scanned_count !== undefined) row.scanned_count = fields.scanned_count;
  if (fields.failed_count !== undefined) row.failed_count = fields.failed_count;
  if (fields.passed_count !== undefined) row.passed_count = fields.passed_count;
  if (fields.published_count !== undefined) row.published_count = fields.published_count;
  if (fields.top_count !== undefined) row.top_count = fields.top_count;
  if (fields.message !== undefined) row.message = fields.message;
  if (fields.status === 'published' || fields.status === 'scanning') {
    row.calculated_at = new Date().toISOString();
  }

  try {
    await supabase.from('daytrade_screener_meta').upsert([row], { onConflict: 'id' });
  } catch (e) {
    console.error('updateDtMeta error:', e.message);
  }
}
