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
 *   POST /api/sector-hot?action=foreign-import-upload        → protected: upload foreign CSV (Bearer CRON_SECRET)
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
const candleEngine = require('../lib/candle-pattern-engine');
const idxTick = require('../lib/idx-tick-normalization');
const telegramNotifier = require('../lib/telegram-notifier');
const crypto = require('crypto');

const DAYTRADE_FULL_SCAN_STALE_LOCK_MS = 30 * 60 * 1000;
const DAYTRADE_RUNNING_SKIP_MESSAGE = 'Day Trade scan already running; skipped to avoid overlap.';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
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

    // === TELEGRAM WEBHOOK: /foreign TICKER lookup (uses this existing endpoint) ===
    if (action === 'telegram-webhook') {
      return await handleTelegramWebhook(req, res, supabase);
    }

    // === TELEGRAM DAILY TOP 5 / MONITOR (cron-protected) ===
    if (action === 'telegram-daily-picks') {
      return await handleTelegramDailyPicks(req, res, supabase);
    }

    // Top 5 automatic Telegram delivery is text-only; chart image endpoint routing is disabled.

    if (action === 'telegram-monitor-picks') {
      return await handleTelegramMonitorPicks(req, res, supabase);
    }

    // === WEB DASHBOARD TOP 5 / MONITOR (read-only, uses existing daily picks data) ===
    if (action === 'web-daily-picks') {
      return await handleWebDailyPicks(req, res, supabase);
    }

    if (action === 'web-top5-history') {
      return await handleWebTop5History(req, res, supabase);
    }

    if (action === 'web-top5-history-archive') {
      return await handleWebTop5HistoryArchive(req, res, supabase);
    }

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

    // === FOREIGN WATCHLIST IMPORT: UPLOAD CSV (Bearer CRON_SECRET protected) ===
    if (action === 'foreign-import-upload') {
      return await handleForeignImportUpload(req, res, supabase);
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

  var legacyBudiReadAllowed = isLegacyBudiReadAllowed(req);
  var userData = null;

  if (!legacyBudiReadAllowed) {
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

  // Derive swing labels and sort by tier priority
  var sortedRows = (rows || []).map(function(r) {
    var labels = deriveSwingLabels(r, 'konglo');
    r.swing_tier = labels.swing_tier;
    r.entry_timing = labels.entry_timing;
    r.tradeability = labels.tradeability;
    r.direction = labels.direction;
    return attachFreshness(enrichSignalQuality(r, 'Swing Konglo'), meta);
  });

  // Sort by swing_tier priority, then composite quality
  var swingTierPriority = { 'A_PLUS_SWING': 0, 'TRADE_CANDIDATE': 1, 'SWING_READY': 2, 'WATCHLIST': 3, 'REBOUND_CANDIDATE': 3, 'WAIT_PULLBACK': 5, 'SPECULATIVE': 6, 'INVALID': 7, 'AVOID': 8 };
  sortedRows.sort(function(a, b) {
    var pa = swingTierPriority[a.swing_tier] != null ? swingTierPriority[a.swing_tier] : 9;
    var pb = swingTierPriority[b.swing_tier] != null ? swingTierPriority[b.swing_tier] : 9;
    if (pa !== pb) return pa - pb;
    // Within same tier group: tradeability > score > RR > entry closeness
    var ta = a.tradeability === 'High' ? 0 : (a.tradeability === 'Medium' ? 1 : 2);
    var tb = b.tradeability === 'High' ? 0 : (b.tradeability === 'Medium' ? 1 : 2);
    if (ta !== tb) return ta - tb;
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    if ((b.risk_reward || 0) !== (a.risk_reward || 0)) return (b.risk_reward || 0) - (a.risk_reward || 0);
    // V4: Entry closeness tiebreaker (prefer price closer to entry)
    var aEntry = a.entry_high > 0 && a.last_price > 0 ? ((a.last_price - a.entry_high) / a.entry_high) * 100 : 99;
    var bEntry = b.entry_high > 0 && b.last_price > 0 ? ((b.last_price - b.entry_high) / b.entry_high) * 100 : 99;
    return aEntry - bEntry;
  });

  sortedRows = await enrichConfluenceRows(supabase, sortedRows, true);

  return res.status(200).json({
    success: true,
    meta: meta || { calculated_at: null, status: 'pending', message: 'Awaiting first calculation.', universe_count: 0, scanned_count: 0, failed_count: 0, ai_called_count: 0 },
    results: sortedRows
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

        // Respect zone detection and level refinement
        var _rzResult = dtEngine.detectRespectZones(candles);
        var _rzNotes = (_rzResult && _rzResult.notes && _rzResult.notes.length > 0) ? _rzResult.notes.join('; ') : null;

        // Refine levels using respect zones
        var _refinedLevels = null;
        var _refinementNotes = null;
        if (analysis.entry_low && analysis.stop_loss && analysis.tp1) {
          var _baseLvl = { entry_low: analysis.entry_low, entry_high: analysis.entry_high, stop_loss: analysis.stop_loss, tp1: analysis.tp1, tp2: analysis.tp2, risk_reward: analysis.risk_reward };
          _refinedLevels = dtEngine.refineLevelsWithRespectZones(_baseLvl, candles, analysis.last_price, 'konglo');
        }

        // === V6: IDX TICK NORMALIZATION (after respect zone refinement) ===
        var _finalEntry_low = _refinedLevels ? _refinedLevels.entry_low : analysis.entry_low;
        var _finalEntry_high = _refinedLevels ? _refinedLevels.entry_high : analysis.entry_high;
        var _finalStop_loss = _refinedLevels ? _refinedLevels.stop_loss : analysis.stop_loss;
        var _finalTp1 = _refinedLevels ? _refinedLevels.tp1 : analysis.tp1;
        var _finalTp2 = _refinedLevels ? _refinedLevels.tp2 : analysis.tp2;
        var _finalRR = _refinedLevels ? _refinedLevels.risk_reward : analysis.risk_reward;

        var _tickResult = idxTick.normalizeLevelsToIdxTicks(
          { entry_low: _finalEntry_low, entry_high: _finalEntry_high, stop_loss: _finalStop_loss, tp1: _finalTp1, tp2: _finalTp2, risk_reward: _finalRR, support: analysis.support, resistance: analysis.resistance },
          { mode: 'swing' }
        );
        if (_tickResult.tick_normalized) {
          _finalEntry_low = _tickResult.entry_low;
          _finalEntry_high = _tickResult.entry_high;
          _finalStop_loss = _tickResult.stop_loss;
          _finalTp1 = _tickResult.tp1;
          _finalTp2 = _tickResult.tp2;
          _finalRR = _tickResult.risk_reward;
        }

        // === V6: MTF CONTEXT ===
        var _mtfCtx = idxTick.deriveMultiTimeframeContext(candles);

        // === V6: VOLUME-PRICE ACTION ===
        var _lastC = candles[candles.length - 1];
        var _lcR = _lastC.high - _lastC.low;
        var _lcCP = _lcR > 0 ? (_lastC.close - _lastC.low) / _lcR : 0.5;
        var _lcBR = _lcR > 0 ? Math.abs(_lastC.close - _lastC.open) / _lcR : 0.5;
        var _vpaResult = idxTick.analyzeVolumePriceAction({
          volume_today: _lastC.volume || 0,
          avg_volume_20d: analysis._volAvg20 || 1,
          change_pct: analysis.change_pct,
          close_position: _lcCP,
          body_ratio: _lcBR,
          is_green: _lastC.close > _lastC.open,
          near_resistance: analysis.last_price >= analysis.resistance * 0.97,
          failed_breakout: false
        });

        // === V6: RISK LABEL ===
        var _chaseDist = _finalEntry_high > 0 ? ((analysis.last_price - _finalEntry_high) / _finalEntry_high) * 100 : 0;
        var _riskResult = idxTick.calculateRiskLabel({
          risk_reward: _finalRR,
          mode: 'swing',
          weekly_bias: _mtfCtx._weekly ? _mtfCtx._weekly.bias : null,
          monthly_bias: _mtfCtx._monthly ? _mtfCtx._monthly.bias : null,
          monthly_downtrend: _mtfCtx._monthly ? _mtfCtx._monthly.downtrend : false,
          volume_phase: _vpaResult.volume_phase,
          chase_distance_pct: Math.max(0, _chaseDist),
          supply_nearby: analysis.last_price >= analysis.resistance * 0.97,
          volume_ratio_20d: analysis.volume_ratio_avg20,
          board: null,
          avg_tx_value_7d: _avgTxValue7d,
          candle_failed_breakout: false,
          rsi14: analysis.rsi14,
          multi_timeframe_bias: _mtfCtx.multi_timeframe_bias
        });

        // === V6: QUALITY GRADE ===
        var _gradeResult = idxTick.calculateQualityGrade({
          risk_reward: _finalRR,
          risk_label: _riskResult.risk_label,
          volume_phase: _vpaResult.volume_phase,
          multi_timeframe_bias: _mtfCtx.multi_timeframe_bias,
          tick_normalized: _tickResult.tick_normalized,
          chase_distance_pct: Math.max(0, _chaseDist),
          volume_ratio_20d: analysis.volume_ratio_avg20,
          mode: 'swing'
        });
        var _planQuality = idxTick.derivePlanQuality({
          mode: 'swing',
          current_price: analysis.last_price,
          last_price: analysis.last_price,
          entry_low: _finalEntry_low,
          entry_high: _finalEntry_high,
          stop_loss: _finalStop_loss,
          tp1: _finalTp1,
          tp2: _finalTp2,
          support: _tickResult.tick_normalized ? _tickResult.support : analysis.support,
          resistance: _tickResult.tick_normalized ? _tickResult.resistance : analysis.resistance,
          risk_reward: _finalRR
        });
        var _riskV2Result = idxTick.deriveRiskLabelV2(Object.assign({}, _planQuality, {
          entry_status: null,
          risk_reward: _finalRR,
          liquidity_label: _avgTxValue7d >= 500000000 ? 'Liquid' : 'Likuiditas Tipis',
          volume_label: analysis.volume_ratio_avg20 >= 1 ? 'Volume valid' : 'Volume lemah'
        }));
        var _respectQuality = dtEngine.scoreRespectCandleQuality(candles, {
          entry_low: _finalEntry_low,
          entry_high: _finalEntry_high,
          stop_loss: _finalStop_loss,
          tp1: _finalTp1,
          tp2: _finalTp2,
          risk_reward: _finalRR,
          support: _tickResult.tick_normalized ? _tickResult.support : analysis.support,
          resistance: _tickResult.tick_normalized ? _tickResult.resistance : analysis.resistance,
          half_candle_level: _refinedLevels ? _refinedLevels.half_candle_level : null
        }, {
          multi_timeframe_bias: _mtfCtx.multi_timeframe_bias,
          rsi14: analysis.rsi14,
          avg_tx_value_7d: _avgTxValue7d,
          liquidity_label: _avgTxValue7d >= 500000000 ? 'Liquid' : 'Likuiditas Tipis'
        }) || {};

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
          support: _tickResult.tick_normalized ? _tickResult.support : analysis.support,
          resistance: _tickResult.tick_normalized ? _tickResult.resistance : analysis.resistance,
          entry_low: _finalEntry_low,
          entry_high: _finalEntry_high,
          stop_loss: _finalStop_loss,
          tp1: _finalTp1,
          tp2: _finalTp2,
          risk_reward: _finalRR,
          invalidation: analysis.invalidation,
          score: scoring.score,
          status: scoring.status,
          status_reason: scoring.status_reason,
          respect_zone_notes: _rzNotes,
          refinement_notes: _refinedLevels ? _refinedLevels.refinement_notes : null,
          half_candle_level: _refinedLevels ? _refinedLevels.half_candle_level : null,
          half_candle_label: _refinedLevels ? _refinedLevels.half_candle_label : null,
          half_candle_note: _refinedLevels ? _refinedLevels.half_candle_note : null,
          half_candle_chase_risk: _refinedLevels ? _refinedLevels.half_candle_chase_risk : false,
          respect_quality_score: _respectQuality.respect_quality_score,
          respect_quality_label: _respectQuality.respect_quality_label || null,
          respect_quality_factors: _respectQuality.respect_quality_factors || [],
          respect_invalid_reason: _respectQuality.respect_invalid_reason || null,
          bearish_respect_warning: _respectQuality.bearish_respect_warning || null,
          tx_value_1d: Math.round(_txValue1d),
          avg_tx_value_3d: Math.round(_avgTxValue3d),
          avg_tx_value_7d: Math.round(_avgTxValue7d),
          avg_tx_value_20d: Math.round(_avgTxValue20d),
          // V6 fields
          tick_normalized: _tickResult.tick_normalized,
          tick_notes: _tickResult.tick_notes,
          tf_1d_context: _mtfCtx.tf_1d_context,
          tf_2d_context: _mtfCtx.tf_2d_context,
          tf_3d_context: _mtfCtx.tf_3d_context,
          tf_5d_context: _mtfCtx.tf_5d_context,
          tf_10d_context: _mtfCtx.tf_10d_context,
          tf_20d_context: _mtfCtx.tf_20d_context,
          multi_timeframe_bias: _mtfCtx.multi_timeframe_bias,
          multi_timeframe_notes: _mtfCtx.multi_timeframe_notes,
          volume_signal: _vpaResult.volume_signal,
          volume_phase: _vpaResult.volume_phase,
          volume_notes: _vpaResult.volume_notes,
          risk_label: _riskResult.risk_label,
          risk_score: _riskResult.risk_score,
          risk_label_v2: _riskV2Result.risk_label_v2,
          risk_score_v2: _riskV2Result.risk_score_v2,
          risk_notes_v2: _riskV2Result.risk_notes_v2,
          risk_factors_v2: _riskV2Result.risk_factors_v2,
          quality_grade: _gradeResult.grade,
          grade_reason: _gradeResult.grade_reason,
          plan_quality_status: _planQuality.plan_quality_status,
          plan_quality_label: _planQuality.plan_quality_label,
          plan_quality_note: _planQuality.plan_quality_note,
          sl_quality_label: _planQuality.sl_quality_label,
          tp_quality_label: _planQuality.tp_quality_label,
          rr_quality_label: _planQuality.rr_quality_label
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
        calculated_at: now,
        // V6: Persisted context fields
        tf_1d_context: r.tf_1d_context || null,
        tf_2d_context: r.tf_2d_context || null,
        tf_3d_context: r.tf_3d_context || null,
        tf_5d_context: r.tf_5d_context || null,
        tf_10d_context: r.tf_10d_context || null,
        tf_20d_context: r.tf_20d_context || null,
        multi_timeframe_bias: r.multi_timeframe_bias || null,
        multi_timeframe_notes: r.multi_timeframe_notes || null,
        volume_phase: r.volume_phase || null,
        risk_label: r.risk_label || null,
        quality_grade: r.quality_grade || null
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
      save_error: saveError || null,
      telegram: savedCount > 0 ? await sendSwingKongloTelegramNotification(supabase, savedCount) : { skipped: true, reason: 'no_saved_rows' }
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

  // TP levels — V1.1 Swing TP: best probable swing target + gap detection
  var swingHigh10K = round0(Math.max.apply(null, highs.slice(-10)));
  var range = resistance - primarySupport;
  var atrForTP = atr14 || (range * 0.15);

  // === OVERHEAD GAP DETECTION (unfilled gap-down above current price) ===
  var overheadGap = null;
  var downsideGap = null;
  for (var gi = lastIdx - 1; gi >= Math.max(1, lastIdx - 19); gi--) {
    // Overhead gap: previous candle low > next candle high (gap-down left unfilled)
    var prevLow = lows[gi - 1];
    var currHigh = highs[gi];
    if (prevLow > currHigh && prevLow > last_price && !overheadGap) {
      // Gap zone: currHigh (lower boundary) to prevLow (upper boundary)
      // Only count if gap is meaningful (>0.3% of price)
      var gapSize = prevLow - currHigh;
      if (gapSize / last_price > 0.003) {
        overheadGap = { lower: round0(currHigh), upper: round0(prevLow), size: round0(gapSize) };
      }
    }
    // Downside gap: current candle low > previous candle high (gap-up left unfilled below)
    var currLow = lows[gi];
    var prevHigh2 = highs[gi - 1];
    if (currLow > prevHigh2 && prevHigh2 < last_price && !downsideGap) {
      var dGapSize = currLow - prevHigh2;
      if (dGapSize / last_price > 0.003) {
        downsideGap = { lower: round0(prevHigh2), upper: round0(currLow), size: round0(dGapSize) };
      }
    }
  }

  // === TP1: Best first swing target (not merely nearest tiny resistance) ===
  // Candidates ranked by quality for Swing:
  // 1. 20D resistance (primary if RR is good)
  // 2. Overhead gap lower boundary (if exists and closer)
  // 3. SwingHigh10 only if meaningful (gives RR >= 1.5 from entry)
  var tp1 = round0(resistance);
  var tp1Source = 'resistance_20d';

  // Check if swingHigh10 is too close (RR would be poor)
  var entryMidTP = entryMid;
  var riskForTP = entryMidTP - stop_loss;
  if (riskForTP <= 0) riskForTP = atrForTP;

  var swingHigh10RR = riskForTP > 0 ? (swingHigh10K - entryMidTP) / riskForTP : 0;
  var resistanceRR = riskForTP > 0 ? (resistance - entryMidTP) / riskForTP : 0;

  // Use swingHigh10 as TP1 only if it gives RR >= 1.5 AND is meaningfully below resistance
  if (swingHigh10K > entry_high && swingHigh10K < resistance * 0.97 && swingHigh10RR >= 1.5) {
    tp1 = swingHigh10K;
    tp1Source = 'swing_high_10d';
  }
  // Overhead gap lower boundary as TP1 if closer than resistance but still meaningful
  if (overheadGap && overheadGap.lower > entry_high && overheadGap.lower < tp1) {
    var gapRR = riskForTP > 0 ? (overheadGap.lower - entryMidTP) / riskForTP : 0;
    if (gapRR >= 1.5) {
      tp1 = overheadGap.lower;
      tp1Source = 'gap_lower';
    }
  }
  // If TP1 is too close (RR < 1.5), skip intermediate and use full resistance
  var tp1RR = riskForTP > 0 ? (tp1 - entryMidTP) / riskForTP : 0;
  if (tp1RR < 1.5 && resistance > entry_high) {
    tp1 = round0(resistance);
    tp1Source = 'resistance_20d';
  }
  // Final fallback: if TP1 still <= entry_high
  if (tp1 <= entry_high) {
    tp1 = round0(entryMidTP + atrForTP * 2.0);
    tp1Source = 'atr_measured';
  }

  // === TP2: Best probable extended swing target ===
  // Candidates: resistance, overhead gap upper, range extension
  var tp2 = round0(resistance + range * 0.38);
  var tp2Source = 'range_extension';

  // If overhead gap exists and upper boundary is above TP1
  if (overheadGap && overheadGap.upper > tp1) {
    tp2 = round0(overheadGap.upper);
    tp2Source = 'gap_upper';
  }
  // If tp1 already = resistance, tp2 = resistance + sensible extension (capped by ATR)
  if (tp1Source === 'resistance_20d' || tp1 >= resistance) {
    var tp2ext = round0(resistance + Math.min(range * 0.38, atrForTP * 3.0));
    if (tp2ext > tp2) tp2 = tp2ext;
  }
  // TP2 must be > TP1
  if (tp2 <= tp1) {
    tp2 = round0(tp1 + atrForTP * 1.0);
  }
  // Cap: TP2 cannot exceed entry + 5×ATR (prevent unrealistic for swing)
  var tp2Cap = round0(entryMidTP + atrForTP * 5.0);
  if (tp2 > tp2Cap && tp2 > resistance * 1.1) {
    tp2 = tp2Cap;
  }

  // Risk/Reward — recalculated after ATR adjustment
  var risk = entryMid - stop_loss;
  var reward1 = tp1 - entryMid;
  var risk_reward = risk > 0 ? round2(reward1 / risk) : 0;

  // === RR QUALITY GUARD (V1.1) ===
  // If RR > 5 and TP1 exceeds resistance without gap support, cap
  if (risk_reward > 5.0 && tp1 > resistance && tp1Source !== 'gap_lower') {
    tp1 = round0(resistance);
    reward1 = tp1 - entryMid;
    risk_reward = risk > 0 ? round2(reward1 / risk) : 0;
    tp1Source = 'resistance_20d_capped';
  }
  // If TP1 too close (RR < 1.2) after all logic, note for status_reason
  var tpNote = '';
  if (tp1Source === 'gap_lower' || tp1Source === 'gap_upper' || tp2Source === 'gap_upper') {
    tpNote = 'TP mempertimbangkan area gap atas yang belum tertutup.';
  } else if (tp1Source === 'swing_high_10d') {
    tpNote = 'TP1 ke swing high 10D valid.';
  } else if (tp1Source === 'resistance_20d') {
    tpNote = 'TP1 ke resistance 20D.';
  } else if (tp1Source === 'atr_measured') {
    tpNote = 'TP1 berbasis measured move ATR.';
  }
  if (downsideGap && tpNote) {
    tpNote += ' Ada gap bawah belum tertutup, waspadai pullback.';
  } else if (downsideGap) {
    tpNote = 'Ada gap bawah belum tertutup, waspadai pullback.';
  }
  if (risk_reward < 1.2 && risk_reward > 0) {
    tpNote = 'TP terlalu dekat, RR kurang layak. Setup diturunkan.';
  }

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
    _tpNote: tpNote || null,
    _overheadGap: overheadGap,
    _downsideGap: downsideGap,
    _adx14: trendStrengthProxy,
    _distAboveMA20Pct: distAboveMA20Pct,
    // V5: Candle Pattern Confirmation (computed at runtime, not DB)
    _candlePattern: (function() {
      var cpCtx = { volumeAvg20: volAvg20, support: primarySupport, resistance: resistance, ma20: ma20, rsi14: rsi14, changePct: change_pct, lastPrice: last_price };
      return candleEngine.detectPattern(candles.slice(-3), cpCtx);
    })()
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

  // === V5: Candle Pattern Confirmation (Konglo Swing) ===
  var _cp = data._candlePattern;
  var _cpScore = 0;
  if (_cp && _cp.pattern) {
    var _nearSup = data.support && data.last_price ? Math.abs(data.last_price - data.support) / data.support <= 0.03 : false;
    var _vr = data._volRatio || 0;

    // Positive Swing boosts
    if (_cp.pattern === 'Bullish Engulfing' && _nearSup) _cpScore += 5;
    else if (_cp.pattern === 'Bullish Engulfing') _cpScore += 3;
    if (_cp.pattern === 'Hammer' && _nearSup) _cpScore += 4;
    if (_cp.pattern === 'Dragonfly Doji' && _nearSup) _cpScore += 4;
    if (_cp.pattern === 'Morning Star') _cpScore += 5;
    if (_cp.pattern === 'Bullish Marubozu' && _vr >= 1.0) _cpScore += 4;
    if (_cp.pattern === 'Tweezer Bottom') _cpScore += 3;
    if (_cp.pattern === 'Three White Soldiers' && _cp.risk !== 'Overextended') _cpScore += 4;

    // Negative Swing downgrades
    if (_cp.pattern === 'Shooting Star') _cpScore -= 5;
    if (_cp.pattern === 'Hanging Man') _cpScore -= 4;
    if (_cp.pattern === 'Bearish Engulfing') _cpScore -= 6;
    if (_cp.pattern === 'Evening Star') _cpScore -= 6;
    if (_cp.pattern === 'Gravestone Doji') _cpScore -= 5;
    if (_cp.pattern === 'Three Black Crows') _cpScore -= 7;
    if (_cp.pattern === 'Distribution candle') _cpScore -= 6;
    if (_cp.pattern === 'Rejection candle') _cpScore -= 5;
    if (_cp.pattern === 'Failed breakout candle') _cpScore -= 5;
    if (_cp.pattern === 'Bearish Marubozu') _cpScore -= 5;

    // Cap candle contribution
    if (_cpScore > 6) _cpScore = 6;
    if (_cpScore < -8) _cpScore = -8;
    score += _cpScore;

    // Append note
    if (_cp.note && _cpScore !== 0) {
      v2Notes.push(_cp.note);
    }
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
  // V1.1: TP quality note (gap/swing target info)
  if (data._tpNote) {
    v2Notes.push(data._tpNote);
  }

  // V2 Guard A6: Wait Pullback for overextended above MA20 (>10%)
  if (data._distAboveMA20Pct > 12) {
    score -= 5; // additional penalty beyond _overextended
    v2Notes.push('Harga sudah jauh di atas MA20 (+' + data._distAboveMA20Pct.toFixed(1) + '%). Tunggu pullback, jangan chase.');
  }

  // === V3 SCORING ENHANCEMENTS ===
  // Entry closeness bonus: price near entry area is actionable
  if (data.entry_high && data.last_price) {
    var _entryDistPct = data.entry_high > 0 ? ((data.last_price - data.entry_high) / data.entry_high) * 100 : 0;
    if (_entryDistPct <= 2) score += 5;       // Very close to entry
    else if (_entryDistPct <= 4) score += 2;  // Moderate proximity
    else if (_entryDistPct > 8) score -= 5;   // Too far above entry — chase risk
    else if (_entryDistPct > 12) score -= 8;  // Extreme chase risk
  }

  // Close position health: bullish close above midpoint is positive
  if (data._closePosition >= 0.7 && data._volRatio >= 1.0) score += 3;    // Strong close
  else if (data._closePosition < 0.3 && data._volRatio >= 1.0) score -= 3; // Weak close with volume

  // Transaction value / liquidity tie-breaker (from stored tx_value_1d in results)
  // Not available at scoring time (scoring happens during refresh), but
  // close position and volume ratio already capture this signal adequately.

  score = Math.max(0, Math.min(100, score));

  // CLASSIFICATION with hard filters and reason tracking
  var status = 'Invalid';
  var status_reason = '';

  // Check hard filters for Swing Ready
  var passesAllHardFilters = true;
  var failReasons = [];

  if (score < 75) { passesAllHardFilters = false; failReasons.push('Score < 75'); }
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
    status = 'Wait Pullback';
    status_reason = 'Harga jauh di atas MA20 (+' + data._distAboveMA20Pct.toFixed(1) + '%). Tunggu pullback, jangan chase.';
  } else if (data._overextended && score >= 50) {
    status = 'Wait Pullback';
    status_reason = 'Overextended. Tunggu pullback ke area entry.';
  } else if (data.rsi14 !== null && data.rsi14 >= 30 && data.rsi14 <= 42 &&
             data.last_price > data.support &&
             data.volume_ratio_avg20 >= 0.8 &&
             score >= 40) {
    status = 'Rebound Speculative';
    status_reason = 'Potensi rebound dari support. Konfirmasi bounce + volume.';
  } else if (score >= 65) {
    status = 'Watchlist';
    // Build reason from first 2 fail reasons
    status_reason = failReasons.length > 0 ? 'Tunggu: ' + failReasons.slice(0, 2).join(', ') : 'Menunggu konfirmasi.';
  } else if (score >= 50) {
    status = 'Watchlist';
    status_reason = failReasons.length > 0 ? 'Pantau: ' + failReasons.slice(0, 2).join(', ') : 'Setup belum lengkap, pantau perkembangan.';
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
  // Derive swing labels for public share (Konglo)
  var kongloWithLabels = (kongloRows || []).map(function(r) { var lbl = deriveSwingLabels(r, 'konglo'); r.swing_tier = lbl.swing_tier; r.entry_timing = lbl.entry_timing; r.tradeability = lbl.tradeability; r.direction = lbl.direction; return attachFreshness(enrichSignalQuality(r, 'Swing Konglo'), kongloMeta); });
  var _swingPri = { 'A_PLUS_SWING': 0, 'TRADE_CANDIDATE': 1, 'SWING_READY': 2, 'WATCHLIST': 3, 'REBOUND_CANDIDATE': 3, 'WAIT_PULLBACK': 5, 'SPECULATIVE': 6, 'INVALID': 7, 'AVOID': 8 };
  kongloWithLabels.sort(function(a, b) { var pa = _swingPri[a.swing_tier] != null ? _swingPri[a.swing_tier] : 9; var pb = _swingPri[b.swing_tier] != null ? _swingPri[b.swing_tier] : 9; if (pa !== pb) return pa - pb; var ta = a.tradeability === 'High' ? 0 : (a.tradeability === 'Medium' ? 1 : 2); var tb = b.tradeability === 'High' ? 0 : (b.tradeability === 'Medium' ? 1 : 2); if (ta !== tb) return ta - tb; if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0); if ((b.risk_reward || 0) !== (a.risk_reward || 0)) return (b.risk_reward || 0) - (a.risk_reward || 0); var aE = a.entry_high > 0 && a.last_price > 0 ? ((a.last_price - a.entry_high) / a.entry_high) * 100 : 99; var bE = b.entry_high > 0 && b.last_price > 0 ? ((b.last_price - b.entry_high) / b.entry_high) * 100 : 99; return aE - bE; });
  result.konglo = { meta: kongloMeta || null, results: redactAdvancedScreenerRows(kongloWithLabels) };

  // Non-Konglo Screener latest
  var { data: nkMeta } = await supabase.from('swing_screener_non_konglo_meta').select('*').eq('id', 'latest').maybeSingle();
  var { data: nkRows } = await supabase.from('swing_screener_non_konglo_latest').select('*').order('rank', { ascending: true });
  // Derive swing labels for public share (Non-Konglo)
  var nkWithLabels = (nkRows || []).map(function(r) { var lbl = deriveSwingLabels(r, 'nonkonglo'); r.swing_tier = lbl.swing_tier; r.entry_timing = lbl.entry_timing; r.tradeability = lbl.tradeability; r.direction = lbl.direction; return attachFreshness(enrichSignalQuality(r, 'Swing Non-Konglo'), nkMeta); });
  nkWithLabels.sort(function(a, b) { var pa = _swingPri[a.swing_tier] != null ? _swingPri[a.swing_tier] : 9; var pb = _swingPri[b.swing_tier] != null ? _swingPri[b.swing_tier] : 9; if (pa !== pb) return pa - pb; var ta = a.tradeability === 'High' ? 0 : (a.tradeability === 'Medium' ? 1 : 2); var tb = b.tradeability === 'High' ? 0 : (b.tradeability === 'Medium' ? 1 : 2); if (ta !== tb) return ta - tb; if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0); if ((b.risk_reward || 0) !== (a.risk_reward || 0)) return (b.risk_reward || 0) - (a.risk_reward || 0); var aE = a.entry_high > 0 && a.last_price > 0 ? ((a.last_price - a.entry_high) / a.entry_high) * 100 : 99; var bE = b.entry_high > 0 && b.last_price > 0 ? ((b.last_price - b.entry_high) / b.entry_high) * 100 : 99; return aE - bE; });
  nkWithLabels.forEach(function(r, idx) { r.rank = idx + 1; });
  nkWithLabels = await enrichNonKongloHalfCandleDebt(nkWithLabels);
  result.non_konglo = { meta: nkMeta || null, results: redactAdvancedScreenerRows(nkWithLabels) };

  // Day Trade Screener latest
  var { data: dtMeta } = await supabase.from('daytrade_screener_meta').select('*').eq('id', 'latest').maybeSingle();
  var { data: dtRows } = await supabase.from('daytrade_screener_latest').select('*').order('daytrade_score', { ascending: false }).limit(50);
  // Derive labels for public share results
  var dtWithLabels = (dtRows || []).map(function(r) { var lbl = deriveDayTradeLabels(r); r.entry_timing = lbl.entry_timing; r.direction = lbl.direction; return attachFreshness(enrichSignalQuality(r, 'Day Trade'), dtMeta); });
  result.daytrade = { meta: dtMeta || null, results: redactAdvancedScreenerRows(dtWithLabels) };

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

function cleanFiniteNumber(value) {
  var n = Number(value);
  return isFinite(n) ? n : null;
}

function compactSafeText(value, fallback) {
  var s = String(value == null ? '' : value).replace(/undefined|null|NaN/g, '').replace(/\s+/g, ' ').trim();
  return s || (fallback || '-');
}

function classifyTrendAlignment(row) {
  var close = cleanFiniteNumber(row.last_price || row.close);
  var ma20 = cleanFiniteNumber(row.ma20);
  var ma50 = cleanFiniteNumber(row.ma50);
  if (close == null || ma20 == null || ma50 == null) return { trend_label: 'Trend Data Unavailable', trend_notes: 'MA20/MA50 belum cukup untuk konfirmasi trend.' };
  if (close > ma20 && ma20 >= ma50) return { trend_label: 'Bullish Trend', trend_notes: 'Close > MA20 >= MA50.' };
  if (close > ma20 && ma20 < ma50) return { trend_label: 'Improving Trend', trend_notes: 'Close > MA20, namun MA20 masih di bawah MA50.' };
  if (close < ma20 && ma20 < ma50) return { trend_label: 'Bearish Trend', trend_notes: 'Close < MA20 < MA50.' };
  return { trend_label: 'Weak Trend', trend_notes: 'Close masih di bawah salah satu MA utama.' };
}

function classifyVolumeThrust(row) {
  var ratio = cleanFiniteNumber(row.volume_ratio_20d || row.volume_ratio_avg20 || row.volume_ratio);
  var valueToday = cleanFiniteNumber(row.value_today || row.tx_value_1d);
  var avg7 = cleanFiniteNumber(row.avg_value_7d || row.avg_tx_value_7d);
  var close = cleanFiniteNumber(row.last_price || row.close);
  var open = cleanFiniteNumber(row.open);
  var change = cleanFiniteNumber(row.change_pct);
  var high = cleanFiniteNumber(row.high), low = cleanFiniteNumber(row.low);
  var green = (open != null && close != null) ? close >= open : (change != null ? change >= 0 : true);
  var closePos = (high != null && low != null && close != null && high > low) ? (close - low) / (high - low) : (green ? 0.7 : 0.3);
  var highVol = (ratio != null && ratio >= 1.2) || (valueToday != null && avg7 != null && valueToday > avg7 * 1.2);
  var lowVol = (ratio != null && ratio < 0.8) || (valueToday != null && avg7 != null && valueToday < avg7 * 0.8);
  var label = 'Neutral Volume';
  var notes = 'Volume relatif normal; tunggu konfirmasi lanjutan.';
  if (highVol && green && closePos >= 0.55) { label = 'Accumulation Volume'; notes = 'Volume di atas rata-rata dengan candle positif/close sehat.'; }
  else if (highVol && (!green || closePos <= 0.35)) { label = 'Distribution Volume'; notes = 'Volume tinggi muncul bersama tekanan jual atau close dekat low.'; }
  else if (highVol) { label = 'Strong Volume'; notes = 'Aktivitas volume/value di atas rata-rata.'; }
  else if (lowVol) { label = 'Weak Volume'; notes = 'Volume/value belum mengonfirmasi pergerakan harga.'; }
  return { volume_label: label, volume_notes: notes };
}

function derivePatternLabel(row) {
  var trend = row.trend_label || classifyTrendAlignment(row).trend_label;
  var vol = row.volume_label || classifyVolumeThrust(row).volume_label;
  var close = cleanFiniteNumber(row.last_price || row.close);
  var resistance = cleanFiniteNumber(row.resistance);
  var support = cleanFiniteNumber(row.support);
  var change = cleanFiniteNumber(row.change_pct);
  var ratio = cleanFiniteNumber(row.volume_ratio_20d || row.volume_ratio_avg20 || row.volume_ratio);
  if (close == null || resistance == null || support == null || resistance <= support) return { pattern_label: 'Insufficient Data', pattern_notes: 'Not enough candle history for pattern confirmation.' };
  var rangePct = (resistance - support) / close;
  var nearRes = close >= resistance * 0.96;
  var aboveRes = close > resistance * 1.005;
  if (aboveRes && (change == null || change < 0.5)) return { pattern_label: 'Failed Breakout', pattern_notes: 'Harga mencoba breakout tetapi konfirmasi candle belum kuat.' };
  if (nearRes && /Bullish|Improving/.test(trend) && /Accumulation|Strong/.test(vol)) return { pattern_label: 'Breakout Consolidation', pattern_notes: 'Harga dekat resistance dengan trend/volume membaik.' };
  if (nearRes && support > close * 0.88) return { pattern_label: 'Ascending Triangle', pattern_notes: 'Resistance relatif dekat dan support bertahan naik/ketat.' };
  if (rangePct <= 0.18 && /Bullish|Improving/.test(trend)) return { pattern_label: 'VCP-like Base', pattern_notes: 'Range makin ketat dan harga bertahan di area base.' };
  return { pattern_label: 'No Clear Pattern', pattern_notes: 'Belum ada pola deterministic yang cukup jelas.' };
}


async function fetchForeignConfluenceMap(supabase, tickers) {
  var out = {};
  var uniq = [];
  var seen = {};
  (tickers || []).forEach(function(t) {
    var safe = normalizeForeignTicker(t);
    if (safe && !seen[safe]) { seen[safe] = true; uniq.push(safe); }
  });
  if (uniq.length === 0) return out;
  try {
    for (var i = 0; i < uniq.length; i += 50) {
      var chunk = uniq.slice(i, i + 50);
      var res = await supabase.from('foreign_watchlist_daily').select('trade_date,ticker,foreign_net,close,nbsa').in('ticker', chunk).order('trade_date', { ascending: false });
      if (res.error) continue;
      var grouped = {};
      (res.data || []).forEach(function(r) {
        var t = normalizeForeignTicker(r.ticker);
        if (!grouped[t]) grouped[t] = [];
        if (grouped[t].length < 7) grouped[t].push(r);
      });
      Object.keys(grouped).forEach(function(t) { out[t] = deriveForeignConfluenceFromRows(grouped[t]); });
    }
  } catch (e) {}
  return out;
}

function deriveForeignConfluenceFromRows(rows) {
  rows = rows || [];
  if (rows.length === 0) return { foreign_1d: null, foreign_3d: null, foreign_7d: null, foreign_label: 'Foreign Data Unavailable', foreign_notes: 'Data foreign belum tersedia.' };
  var n1 = cleanFiniteNumber(rows[0].foreign_net) || 0;
  var n3 = rows.slice(0,3).reduce(function(a,r){ return a + (cleanFiniteNumber(r.foreign_net) || 0); },0);
  var n7 = rows.slice(0,7).reduce(function(a,r){ return a + (cleanFiniteNumber(r.foreign_net) || 0); },0);
  var latestClose = cleanFiniteNumber(rows[0].close);
  var oldestClose = cleanFiniteNumber(rows[Math.min(rows.length-1,6)].close) || latestClose;
  var priceRising = latestClose != null && oldestClose != null && latestClose >= oldestClose * 1.005;
  var priceMildDown = latestClose != null && oldestClose != null && latestClose >= oldestClose * 0.97;
  var signs = [n1,n3,n7].map(function(n){ return n > 0 ? 1 : (n < 0 ? -1 : 0); });
  var label = 'Foreign Neutral';
  if (n1 > 0 && n3 > 0 && n7 > 0 && priceRising) label = 'Foreign Accumulation';
  else if (n3 > 0 && n7 > 0 && priceMildDown) label = 'Foreign Absorption';
  else if (n1 < 0 && n3 < 0 && n7 < 0 && !priceMildDown) label = 'Foreign Distribution';
  else if (signs.indexOf(1) !== -1 && signs.indexOf(-1) !== -1) label = 'Foreign Mixed';
  return { foreign_1d: Math.round(n1), foreign_3d: Math.round(n3), foreign_7d: Math.round(n7), foreign_label: label, foreign_notes: 'Foreign 1D/3D/7D dihitung dari nbsa × close.' };
}

async function fetchForeignConfluence(supabase, ticker, lastPrice) {
  try {
    var safe = normalizeForeignTicker(ticker);
    if (!safe) return { foreign_1d: null, foreign_3d: null, foreign_7d: null, foreign_label: 'Foreign Data Unavailable', foreign_notes: 'Data foreign belum tersedia.' };
    var res = await supabase.from('foreign_watchlist_daily').select('trade_date,ticker,foreign_net,close,nbsa').eq('ticker', safe).order('trade_date', { ascending: false }).limit(7);
    var rows = res.data || [];
    if (res.error || rows.length === 0) return { foreign_1d: null, foreign_3d: null, foreign_7d: null, foreign_label: 'Foreign Data Unavailable', foreign_notes: 'Data foreign belum tersedia.' };
    var n1 = cleanFiniteNumber(rows[0].foreign_net) || 0;
    var n3 = rows.slice(0,3).reduce(function(a,r){ return a + (cleanFiniteNumber(r.foreign_net) || 0); },0);
    var n7 = rows.slice(0,7).reduce(function(a,r){ return a + (cleanFiniteNumber(r.foreign_net) || 0); },0);
    var latestClose = cleanFiniteNumber(rows[0].close) || cleanFiniteNumber(lastPrice);
    var oldestClose = cleanFiniteNumber(rows[Math.min(rows.length-1,6)].close) || latestClose;
    var priceRising = latestClose != null && oldestClose != null && latestClose >= oldestClose * 1.005;
    var priceMildDown = latestClose != null && oldestClose != null && latestClose >= oldestClose * 0.97;
    var signs = [n1,n3,n7].map(function(n){ return n > 0 ? 1 : (n < 0 ? -1 : 0); });
    var label = 'Foreign Neutral';
    if (n1 > 0 && n3 > 0 && n7 > 0 && priceRising) label = 'Foreign Accumulation';
    else if (n3 > 0 && n7 > 0 && priceMildDown) label = 'Foreign Absorption';
    else if (n1 < 0 && n3 < 0 && n7 < 0 && !priceMildDown) label = 'Foreign Distribution';
    else if (signs.indexOf(1) !== -1 && signs.indexOf(-1) !== -1) label = 'Foreign Mixed';
    return { foreign_1d: Math.round(n1), foreign_3d: Math.round(n3), foreign_7d: Math.round(n7), foreign_label: label, foreign_notes: 'Foreign 1D/3D/7D dihitung dari nbsa × close.' };
  } catch (e) { return { foreign_1d: null, foreign_3d: null, foreign_7d: null, foreign_label: 'Foreign Data Unavailable', foreign_notes: 'Data foreign belum tersedia.' }; }
}


async function enrichOneNonKongloHalfCandleDebt(row) {
  var r = Object.assign({}, row || {});
  try {
    var q = r && r.ticker ? await fetchNkQuoteData(r.ticker) : null;
    if (q && q.candles && q.candles.length >= 10 && r.entry_low && r.stop_loss && r.tp1) {
      var base = { entry_low: r.entry_low, entry_high: r.entry_high, stop_loss: r.stop_loss, tp1: r.tp1, tp2: r.tp2, risk_reward: r.risk_reward };
      var refined = dtEngine.refineLevelsWithRespectZones(base, q.candles, q.lastPrice || r.last_price, 'nonkonglo');
      if (refined && refined.risk_reward >= 1.5) {
        r.entry_low = refined.entry_low;
        r.entry_high = refined.entry_high;
        r.stop_loss = refined.stop_loss;
        r.tp1 = refined.tp1;
        r.tp2 = refined.tp2;
        r.risk_reward = refined.risk_reward;
      }
      var ticked = idxTick.normalizeLevelsToIdxTicks({ entry_low: r.entry_low, entry_high: r.entry_high, stop_loss: r.stop_loss, tp1: r.tp1, tp2: r.tp2, risk_reward: r.risk_reward, support: r.support, resistance: r.resistance }, { mode: 'swing' });
      if (ticked.tick_normalized) {
        r.entry_low = ticked.entry_low;
        r.entry_high = ticked.entry_high;
        r.stop_loss = ticked.stop_loss;
        r.tp1 = ticked.tp1;
        r.tp2 = ticked.tp2;
        r.risk_reward = ticked.risk_reward;
        r.support = ticked.support || r.support;
        r.resistance = ticked.resistance || r.resistance;
      }
      if (refined) {
        r.refinement_notes = refined.refinement_notes || r.refinement_notes || null;
        r.respect_zone_notes = refined.respect_zone_notes || r.respect_zone_notes || null;
        r.half_candle_level = refined.half_candle_level || null;
        r.half_candle_label = refined.half_candle_label || null;
        r.half_candle_note = refined.half_candle_note || null;
        r.half_candle_chase_risk = refined.half_candle_chase_risk || false;
        if (r.half_candle_chase_risk) {
          r.entry_timing = 'Wait for half-candle debt area';
          r.direction = 'Rawan chase setelah long candle';
          if (r.confidence === 'A+' || r.confidence === 'A') r.confidence = 'B';
        } else if (r.half_candle_label === 'Failed respect candle') {
          r.entry_timing = 'Tunggu reclaim 1/2 candle';
          r.direction = 'Confidence turun — respect candle gagal';
          if (r.confidence === 'A+' || r.confidence === 'A') r.confidence = 'B';
          else if (r.confidence === 'B') r.confidence = 'C';
        }
      }
    }
  } catch (e) {
    // Non-Konglo half-candle enrichment is best-effort; keep cached row if Yahoo/refinement fails.
  }
  return r;
}

async function enrichNonKongloHalfCandleDebt(rows) {
  rows = rows || [];
  var out = [];
  var batchSize = 5;
  for (var i = 0; i < rows.length; i += batchSize) {
    var batch = rows.slice(i, i + batchSize).map(enrichOneNonKongloHalfCandleDebt);
    var enriched = await Promise.all(batch);
    out = out.concat(enriched);
  }
  return out;
}

async function enrichConfluenceRows(supabase, rows, includeForeign) {
  rows = rows || [];
  var foreignMap = includeForeign ? await fetchForeignConfluenceMap(supabase, rows.map(function(r) { return r && r.ticker; })) : {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = Object.assign({}, rows[i]);
    Object.assign(r, classifyTrendAlignment(r));
    Object.assign(r, classifyVolumeThrust(r));
    Object.assign(r, derivePatternLabel(r));
    if (includeForeign) {
      Object.assign(r, foreignMap[normalizeForeignTicker(r.ticker)] || { foreign_1d: null, foreign_3d: null, foreign_7d: null, foreign_label: 'Foreign Data Unavailable', foreign_notes: 'Data foreign belum tersedia.' });
      if (r.confidence) {
        var confAfterForeign = deriveConfidenceTier(r, 'Swing');
        r.confidence = confAfterForeign.confidence;
        r.confidence_label = confAfterForeign.confidence_label;
        r.confidence_notes = confAfterForeign.confidence_notes;
      }
    }
    out.push(r);
  }
  return out;
}

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


// ============================================================
// TELEGRAM /foreign TICKER LOOKUP (Foreign Watchlist Import v1)
// ============================================================
function normalizeForeignTicker(input) {
  var ticker = String(input || '').trim().toUpperCase().replace(/\.JK$/, '');
  if (!/^[A-Z0-9]{2,12}$/.test(ticker)) return '';
  return ticker;
}


function parseForeignCsvLine(line) {
  var out = [];
  var cur = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(function(v) { return String(v || '').trim(); });
}

function parseForeignNumber(value, field, rowNum) {
  var raw = String(value == null ? '' : value).trim();
  if (raw === '') return null;
  var cleaned = raw.replace(/,/g, '');
  var n = Number(cleaned);
  if (!isFinite(n)) throw new Error('Invalid numeric value at row ' + rowNum + ' field ' + field + ': ' + raw);
  return n;
}

function normalizeForeignDate(value, rowNum) {
  var s = String(value || '').trim();
  var normalized = s;
  var mdY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdY) {
    var month = mdY[1].padStart(2, '0');
    var day = mdY[2].padStart(2, '0');
    normalized = mdY[3] + '-' + month + '-' + day;
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error('Invalid date at row ' + rowNum + ': ' + value);
  }
  var d = new Date(normalized + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== normalized) throw new Error('Invalid date at row ' + rowNum + ': ' + value);
  return normalized;
}

function getRawRequestBody(req) {
  if (typeof req.body === 'string') return Promise.resolve(req.body);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));
  if (req.body && typeof req.body === 'object') {
    if (typeof req.body.csv === 'string') return Promise.resolve(req.body.csv);
    if (typeof req.body.text === 'string') return Promise.resolve(req.body.text);
  }
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(Buffer.from(chunk)); });
    req.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function parseForeignImportCsv(csvText) {
  var text = String(csvText || '').replace(/^\uFEFF/, '');
  var lines = text.split(/\r?\n/).filter(function(line) { return line.trim() !== ''; });
  if (lines.length < 2) return [];

  var headers = parseForeignCsvLine(lines[0]).map(function(h) { return String(h || '').trim().replace(/^<|>$/g, '').toLowerCase(); });
  var required = ['date', 'ticker', 'open', 'high', 'low', 'close', 'volume', 'freq', 'valuasi', 'nbsa'];
  required.forEach(function(h) {
    if (headers.indexOf(h) === -1) throw new Error('Missing CSV column: ' + h);
  });

  var rows = [];
  var seen = {};
  for (var i = 1; i < lines.length; i++) {
    var rowNum = i + 1;
    var cols = parseForeignCsvLine(lines[i]);
    var obj = {};
    headers.forEach(function(h, idx) { obj[h] = cols[idx]; });
    var tradeDate = normalizeForeignDate(obj.date, rowNum);
    var ticker = normalizeForeignTicker(obj.ticker);
    if (!ticker) throw new Error('Invalid ticker at row ' + rowNum + ': ' + obj.ticker);
    var close = parseForeignNumber(obj.close, 'close', rowNum);
    var nbsa = parseForeignNumber(obj.nbsa, 'nbsa', rowNum);
    var key = tradeDate + '|' + ticker;
    if (seen[key]) throw new Error('Duplicate CSV row for ' + key + ' at row ' + rowNum);
    seen[key] = true;
    rows.push({
      trade_date: tradeDate,
      ticker: ticker,
      foreign_buy: null,
      foreign_sell: null,
      foreign_net: (nbsa == null || close == null) ? null : nbsa * close,
      close: close,
      volume: parseForeignNumber(obj.volume, 'volume', rowNum),
      freq: parseForeignNumber(obj.freq, 'freq', rowNum),
      valuasi: parseForeignNumber(obj.valuasi, 'valuasi', rowNum),
      nbsa: nbsa,
      source: 'csv',
      uploaded_at: new Date().toISOString()
    });
  }
  return rows;
}

async function deleteOldForeignRows(supabase, tickers) {
  var deleted = 0;
  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var dateRes = await supabase
      .from('foreign_watchlist_daily')
      .select('trade_date')
      .eq('ticker', ticker)
      .order('trade_date', { ascending: false });
    if (dateRes.error) throw new Error('Retention read failed for ' + ticker + ': ' + dateRes.error.message);

    var uniqueMap = {};
    var uniqueDates = [];
    (dateRes.data || []).forEach(function(r) {
      if (r.trade_date && !uniqueMap[r.trade_date]) {
        uniqueMap[r.trade_date] = true;
        uniqueDates.push(r.trade_date);
      }
    });
    var keepDates = uniqueDates.slice(0, 7);
    if (uniqueDates.length <= 7) continue;

    var oldRes = await supabase
      .from('foreign_watchlist_daily')
      .select('id')
      .eq('ticker', ticker)
      .not('trade_date', 'in', '(' + keepDates.join(',') + ')');
    if (oldRes.error) throw new Error('Retention lookup failed for ' + ticker + ': ' + oldRes.error.message);
    var oldIds = (oldRes.data || []).map(function(r) { return r.id; });
    if (oldIds.length === 0) continue;

    var delRes = await supabase.from('foreign_watchlist_daily').delete().in('id', oldIds);
    if (delRes.error) throw new Error('Retention delete failed for ' + ticker + ': ' + delRes.error.message);
    deleted += oldIds.length;
  }
  return deleted;
}

async function handleForeignImportUpload(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  if (!verifyCronSecret(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });

  var errors = [];
  try {
    var csvText = await getRawRequestBody(req);
    var rows = parseForeignImportCsv(csvText);
    if (rows.length === 0) {
      return res.status(200).json({ success: false, imported_count: 0, upserted_count: 0, deleted_old_count: 0, errors: ['CSV kosong atau tidak berisi data.'] });
    }

    var upsertRes = await supabase
      .from('foreign_watchlist_daily')
      .upsert(rows, { onConflict: 'trade_date,ticker' })
      .select('ticker,trade_date');
    if (upsertRes.error) throw new Error('Upsert failed: ' + upsertRes.error.message);

    var tickerMap = {};
    rows.forEach(function(r) { tickerMap[r.ticker] = true; });
    var tickers = Object.keys(tickerMap).sort();
    var deleted = await deleteOldForeignRows(supabase, tickers);

    return res.status(200).json({
      success: true,
      imported_count: rows.length,
      upserted_count: (upsertRes.data && upsertRes.data.length) || rows.length,
      deleted_old_count: deleted,
      errors: errors
    });
  } catch (err) {
    errors.push(err.message || String(err));
    return res.status(200).json({ success: false, imported_count: 0, upserted_count: 0, deleted_old_count: 0, errors: errors, error: errors[0] });
  }
}

function formatForeignNumber(value) {
  if (value == null || value === '') return 'N/A';
  var n = Number(value);
  if (!isFinite(n)) return String(value);
  return n.toLocaleString('id-ID', { maximumFractionDigits: 0 });
}

function formatForeignRupiah(value) {
  if (value == null || value === '') return 'N/A';
  var n = Number(value);
  if (!isFinite(n)) return String(value);
  var abs = Math.abs(n);
  var sign = n < 0 ? '-' : '';
  if (abs >= 1000000000) return sign + 'Rp ' + (abs / 1000000000).toFixed(1) + ' miliar';
  if (abs >= 1000000) return sign + 'Rp ' + (abs / 1000000).toFixed(1) + ' juta';
  if (abs >= 1000) return sign + 'Rp ' + (abs / 1000).toFixed(1) + ' ribu';
  return sign + 'Rp ' + abs.toLocaleString('id-ID', { maximumFractionDigits: 0 });
}

function formatForeignNetWithSide(value) {
  if (value == null || value === '') return 'N/A';
  var n = Number(value);
  if (!isFinite(n)) return String(value);
  var side = n > 0 ? 'net buy' : (n < 0 ? 'net sell' : 'netral');
  return formatForeignRupiah(n) + ' (' + side + ')';
}

function getForeignTrendLabel(net3d, net7d) {
  if (net3d > 0 && net7d > 0) return 'Accumulation';
  if (net3d < 0 && net7d < 0) return 'Distribution';
  return 'Mixed';
}

async function buildForeignLookupMessage(supabase, ticker) {
  var safeTicker = normalizeForeignTicker(ticker);
  if (!safeTicker) return 'Format salah. Gunakan: /foreign TICKER';

  var { data: rows, error } = await supabase
    .from('foreign_watchlist_daily')
    .select('trade_date,ticker,foreign_buy,foreign_sell,foreign_net,close,volume,freq,valuasi,nbsa')
    .eq('ticker', safeTicker)
    .order('trade_date', { ascending: false })
    .limit(7);

  if (error) return 'Gagal ambil data foreign untuk ' + safeTicker + '.';
  if (!rows || rows.length === 0) return 'Belum ada data foreign untuk ' + safeTicker + '. Upload CSV dulu.';

  var latest = rows[0];
  var net3d = rows.slice(0, 3).reduce(function(sum, r) { return sum + (Number(r.foreign_net) || 0); }, 0);
  var net7d = rows.slice(0, 7).reduce(function(sum, r) { return sum + (Number(r.foreign_net) || 0); }, 0);
  var trend = getForeignTrendLabel(net3d, net7d);

  return [
    'Foreign Watchlist — ' + safeTicker,
    'Latest date: ' + latest.trade_date,
    'Close: ' + formatForeignNumber(latest.close),
    'NBSA: ' + formatForeignNumber(latest.nbsa),
    'Foreign net: ' + formatForeignNetWithSide(latest.foreign_net),
    'Volume: ' + formatForeignNumber(latest.volume),
    'Freq: ' + formatForeignNumber(latest.freq),
    'Value: ' + formatForeignRupiah(latest.valuasi),
    rows.length >= 7 ? ('Trend 7 hari: ' + trend + ' (' + formatForeignNetWithSide(net7d) + ')') : ('Trend 7 hari: data belum lengkap (' + rows.length + '/7 hari)')
  ].join('\n');
}


function getWibDateString() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getWibHourString() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16) + ' WIB';
}



function isIdxRegularMarketOpenJakarta(now) {
  now = now || getJakartaNow();
  var day = now.getUTCDay();
  if (day < 1 || day > 5) return false;
  var minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= (9 * 60) && minutes <= (15 * 60 + 15);
}

function deriveFreshness(row, meta, opts) {
  opts = opts || {};
  row = row || {};
  meta = meta || {};
  var ts = row.freshness_timestamp || row.calculated_at || row.updated_at || row.last_updated_at || row.last_checked_at || row.first_sent_at || row.run_at || row.created_at || meta.calculated_at || meta.updated_at || meta.last_updated_at || meta.created_at || null;
  if (!ts) {
    return { freshness_label: 'Unknown', freshness_reason: 'Timestamp data tidak tersedia; freshness tidak bisa dipastikan.', freshness_age_minutes: null, freshness_priority: 99, freshness_is_stale: false };
  }
  var d = new Date(ts);
  if (isNaN(d.getTime())) {
    return { freshness_label: 'Unknown', freshness_reason: 'Timestamp data tidak bisa diparse; freshness tidak bisa dipastikan.', freshness_age_minutes: null, freshness_priority: 99, freshness_is_stale: false };
  }
  var now = new Date();
  var age = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
  var marketOpen = isIdxRegularMarketOpenJakarta();
  var dataDate = getJakartaDateFromTimestamp(ts);
  var today = getJakartaDateString();
  var closeSnapshot = !marketOpen && dataDate === today;
  if (closeSnapshot) {
    return { freshness_label: 'Market Close Snapshot', freshness_reason: 'Bursa sedang di luar jam reguler; data ditampilkan sebagai snapshot sesi/close terbaru yang tersedia.', freshness_age_minutes: age, freshness_priority: 3, freshness_is_stale: false };
  }
  if (marketOpen && age <= 45) return { freshness_label: 'Fresh', freshness_reason: 'Timestamp data masih dalam batas fresh saat jam bursa reguler (≤45 menit).', freshness_age_minutes: age, freshness_priority: 0, freshness_is_stale: false };
  if (marketOpen && age <= 120) return { freshness_label: 'Delayed', freshness_reason: 'Timestamp data sudah tertunda namun masih dalam rentang pemantauan (46–120 menit).', freshness_age_minutes: age, freshness_priority: 1, freshness_is_stale: false };
  if (marketOpen && age > 120) return { freshness_label: 'Stale', freshness_reason: 'Timestamp data lebih dari 120 menit saat jam bursa; validasi ulang harga/volume intraday sebelum eksekusi.', freshness_age_minutes: age, freshness_priority: 2, freshness_is_stale: true };
  if (dataDate !== today) return { freshness_label: 'Stale', freshness_reason: 'Data bukan dari tanggal WIB hari ini; gunakan sebagai referensi historis dan validasi ulang.', freshness_age_minutes: age, freshness_priority: 2, freshness_is_stale: true };
  return { freshness_label: 'Market Close Snapshot', freshness_reason: 'Bursa sedang di luar jam reguler; data hari ini ditampilkan sebagai snapshot terbaru.', freshness_age_minutes: age, freshness_priority: 3, freshness_is_stale: false };
}

function attachFreshness(row, meta) {
  var f = deriveFreshness(row, meta);
  row.freshness_label = f.freshness_label;
  row.freshness_reason = f.freshness_reason;
  row.freshness_age_minutes = f.freshness_age_minutes;
  row.freshness_priority = f.freshness_priority;
  row.freshness_is_stale = f.freshness_is_stale;
  var sf = idxTick.deriveSetupFreshness(row, meta);
  row.setup_age_minutes = sf.setup_age_minutes != null ? sf.setup_age_minutes : f.freshness_age_minutes;
  row.setup_age_hours = sf.setup_age_hours != null ? sf.setup_age_hours : (f.freshness_age_minutes != null ? Math.round((f.freshness_age_minutes / 60) * 100) / 100 : null);
  row.setup_freshness_status = f.freshness_is_stale ? 'NEEDS_REVALIDATION' : sf.setup_freshness_status;
  row.setup_freshness_label = f.freshness_is_stale ? 'Needs Revalidation' : sf.setup_freshness_label;
  row.setup_expiry_note = f.freshness_is_stale ? f.freshness_reason : sf.setup_expiry_note;
  if (f.freshness_is_stale) {
    var staleMsg = 'Data stale — validasi ulang harga/volume sebelum entry.';
    if (!row.stale_notes) row.stale_notes = staleMsg;
    if (!row.data_stale) row.data_stale = true;
    row.entry_quality_status = 'NEEDS_REVALIDATION';
    row.entry_quality_label = 'Needs Revalidation';
    row.entry_safety_note = staleMsg + ' Tidak ditampilkan sebagai Entry/Ready.';
    row.entry_status = 'NEEDS_REVALIDATION';
    row.entry_status_label = 'Needs Revalidation';
    row.entry_status_note = row.entry_safety_note;
    if (row.action_reason && row.action_reason.indexOf('validasi ulang') < 0) row.action_reason += ' ' + staleMsg;
    if (row.plan_reason && row.plan_reason.indexOf('validasi ulang') < 0) row.plan_reason += ' ' + staleMsg;
  }
  return row;
}

function getJakartaNow() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

function getJakartaDateString() {
  return getJakartaNow().toISOString().slice(0, 10);
}

function isJakartaWeekday() {
  var day = getJakartaNow().getUTCDay();
  return day >= 1 && day <= 5;
}

function getJakartaDateFromTimestamp(value) {
  if (!value) return null;
  var s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isFreshForJakartaDate(value, tradingDate) {
  return getJakartaDateFromTimestamp(value) === tradingDate;
}

function getPreviousJakartaTradingDateString(tradingDate) {
  var d = new Date(String(tradingDate) + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) return null;
  do { d = new Date(d.getTime() - 24 * 60 * 60 * 1000); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function buildReadinessItem(meta, latestRows, tradingDate, sourceFields) {
  meta = meta || null;
  latestRows = latestRows || [];
  sourceFields = sourceFields || [];
  var latest = null;
  if (meta) {
    for (var i = 0; i < sourceFields.length; i++) {
      if (meta[sourceFields[i]]) { latest = meta[sourceFields[i]]; break; }
    }
    if (!latest) latest = meta.run_date || meta.calculated_at || meta.updated_at;
  }
  if (!latest && latestRows[0]) latest = latestRows[0].calculated_at || latestRows[0].run_date || latestRows[0].trade_date || null;
  var status = meta && meta.status ? String(meta.status).toLowerCase() : '';
  var badStatus = ['failed', 'scanning', 'running', 'idle', 'pending'].indexOf(status) >= 0;
  var latestDate = getJakartaDateFromTimestamp(latest);
  var metaCount = meta ? (meta.published_count != null ? meta.published_count : (meta.top_count != null ? meta.top_count : (meta.scanned_count != null ? meta.scanned_count : null))) : null;
  var rowCount = latestRows.length > 0 && metaCount != null ? metaCount : latestRows.length;
  var hasLatestRows = latestRows.length > 0;
  var ready = !!latest && latestDate === tradingDate && hasLatestRows && !badStatus;
  return {
    ready: ready,
    latest_date_or_timestamp: latest || null,
    latest_date: latestDate,
    row_count: rowCount,
    has_latest_rows: hasLatestRows,
    has_meta: !!meta,
    status: status || null,
    status_allows_snapshot: !badStatus
  };
}

function screenerAllowsPreviousCloseSnapshot(item, previousTradingDate) {
  return !!(item && item.has_meta && item.has_latest_rows && item.status_allows_snapshot && item.latest_date === previousTradingDate);
}

async function getScreenerReadiness(supabase, options) {
  options = options || {};
  var tradingDate = getJakartaDateString();
  var dayMetaRes = await supabase.from('daytrade_screener_meta').select('run_date,calculated_at,updated_at,status,published_count,top_count').eq('id', 'latest').maybeSingle();
  var dayRowsRes = await supabase.from('daytrade_screener_latest').select('ticker,calculated_at,run_id').order('daytrade_score', { ascending: false }).limit(1);
  var kongloMetaRes = await supabase.from('swing_screener_meta').select('calculated_at,updated_at,status,scanned_count').eq('id', 'latest').maybeSingle();
  var kongloRowsRes = await supabase.from('swing_screener_latest').select('ticker,calculated_at').order('score', { ascending: false }).limit(1);
  var nkMetaRes = await supabase.from('swing_screener_non_konglo_meta').select('run_date,calculated_at,updated_at,status,published_count').eq('id', 'latest').maybeSingle();
  var nkRowsRes = await supabase.from('swing_screener_non_konglo_latest').select('ticker,calculated_at').order('rank', { ascending: true }).limit(1);

  var readiness = {
    day_trade: buildReadinessItem(dayMetaRes.data, dayRowsRes.data || [], tradingDate, ['run_date', 'calculated_at']),
    swing_konglo: buildReadinessItem(kongloMetaRes.data, kongloRowsRes.data || [], tradingDate, ['calculated_at']),
    swing_non_konglo: buildReadinessItem(nkMetaRes.data, nkRowsRes.data || [], tradingDate, ['run_date', 'calculated_at'])
  };
  var sameDayReady = readiness.day_trade.ready && readiness.swing_konglo.ready && readiness.swing_non_konglo.ready;
  var previousTradingDate = getPreviousJakartaTradingDateString(tradingDate);
  var previousCloseReady = screenerAllowsPreviousCloseSnapshot(readiness.day_trade, previousTradingDate)
    && screenerAllowsPreviousCloseSnapshot(readiness.swing_konglo, previousTradingDate)
    && screenerAllowsPreviousCloseSnapshot(readiness.swing_non_konglo, previousTradingDate);
  readiness.same_day_ready = sameDayReady;
  readiness.previous_trading_date = previousTradingDate;
  readiness.allowed_previous_close_snapshot = !!(!sameDayReady && options.allow_previous_close_snapshot && previousCloseReady);
  readiness.snapshot_mode = sameDayReady ? 'same_day' : (readiness.allowed_previous_close_snapshot ? 'previous_close_snapshot' : 'not_ready');
  readiness.ready = sameDayReady || readiness.allowed_previous_close_snapshot;
  readiness.trading_date = tradingDate;
  return readiness;
}

function pctFrom(base, value) {
  var b = toNum(base), v = toNum(value);
  return b && v ? Math.round(((v - b) / b * 100) * 10) / 10 : null;
}

function formatPct(v) { return v == null || !isFinite(v) ? '-' : (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }

function chartLink(ticker) { return 'https://www.tradingview.com/chart/?symbol=IDX:' + encodeURIComponent(String(ticker || '').toUpperCase()); }

function getEntry1(row) {
  var low = toNum(row.entry_low), high = toNum(row.entry_high);
  if (high != null && high > 0) return high;
  if (low != null && low > 0) return low;
  return toNum(row.last_price);
}

function getEntry2(row) {
  var low = toNum(row.entry_low), high = toNum(row.entry_high);
  if (low != null && low > 0) return low;
  if (high != null && high > 0) return high;
  return toNum(row.last_price);
}


function getMinTp1UpsideForCategory(category) {
  var cat = String(category || '').toLowerCase();
  var envName = cat.indexOf('day') >= 0 ? 'DAYTRADE_MIN_TP1_UPSIDE_PCT' : (cat.indexOf('non') >= 0 ? 'SWING_NON_KONGLO_MIN_TP1_UPSIDE_PCT' : 'SWING_KONGLO_MIN_TP1_UPSIDE_PCT');
  var fallback = cat.indexOf('day') >= 0 ? 3 : 5;
  var configured = toNum(process.env[envName]);
  return configured != null && configured >= 0 ? configured : fallback;
}


function getMinRRForCategory(category) {
  var cat = String(category || '').toLowerCase();
  return cat.indexOf('day') >= 0 ? 1.3 : 1.5;
}

function countWeekdaysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  var s = new Date(startDate + 'T00:00:00Z');
  var e = new Date(endDate + 'T00:00:00Z');
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || s > e) return null;
  var days = 0;
  for (var d = new Date(s.getTime()); d < e; d.setUTCDate(d.getUTCDate() + 1)) {
    var wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) days++;
  }
  return days;
}

function deriveStaleLiquidityLabels(row) {
  row = row || {};
  var latestDate = row.latest_date || row.last_trade_date || row.trade_date || row.run_date || row.calculated_at || row.updated_at || row.published_at;
  var dateStr = getJakartaDateFromTimestamp(latestDate);
  var today = getJakartaDateString();
  var staleDays = dateStr ? countWeekdaysBetween(dateStr, today) : null;
  var isStale = staleDays != null && staleDays > 0;
  var staleLabel = isStale ? 'Stale Data' : (dateStr ? 'Fresh Data' : 'Stale Check Limited');
  var staleNotes = dateStr ? ('Latest market data: ' + dateStr + (isStale ? ' (' + staleDays + ' trading day(s) behind).' : '.')) : 'Liquidity/stale check limited by available data.';

  var tradedDays = toNum(row.traded_days_20d);
  var valueToday = toNum(row.value_today || row.tx_value_1d || row.valuasi);
  var avg7 = toNum(row.avg_value_7d || row.avg_tx_value_7d);
  var freq = toNum(row.freq || row.frequency);
  var volumeRatio = toNum(row.volume_ratio_20d || row.volume_ratio_avg20 || row.volume_ratio);
  var notes = [];
  var volumeNotes = [];
  var hasLiquidityData = tradedDays != null || valueToday != null || avg7 != null || freq != null;
  var limited = !hasLiquidityData;
  var veryHighValue = (valueToday != null && valueToday >= 10000000000) || (avg7 != null && avg7 >= 10000000000);
  var moderateValue = (valueToday != null && valueToday >= 3000000000) || (avg7 != null && avg7 >= 3000000000);
  var lowValueToday = valueToday != null && valueToday < 750000000;
  var lowAvg7 = avg7 != null && avg7 < 1000000000;
  var risk = false;
  var moderate = false;
  if (tradedDays != null && tradedDays < 15) { risk = true; notes.push('Hari perdagangan 20D < 15.'); }
  if (!veryHighValue && lowValueToday && (avg7 == null || lowAvg7)) { risk = true; notes.push('Nilai transaksi harian sangat rendah.'); }
  if (!veryHighValue && lowAvg7 && (valueToday == null || lowValueToday)) { risk = true; notes.push('Rata-rata nilai transaksi 7D sangat rendah.'); }
  if (!veryHighValue && freq != null && freq < 1000) { risk = true; notes.push('Frekuensi transaksi rendah.'); }
  else if (!veryHighValue && freq != null && freq < 3000) moderate = true;
  if (!veryHighValue && !risk && !moderateValue) moderate = true;
  var volumeLabel = 'Volume normal';
  if (volumeRatio == null) { volumeLabel = 'Data volume terbatas'; volumeNotes.push('Data rasio volume belum tersedia.'); }
  else if (volumeRatio < 0.7) { volumeLabel = 'Volume belum konfirmasi'; volumeNotes.push('Volume belum mengonfirmasi pergerakan harga.'); }
  else if (volumeRatio < 1.0) { volumeLabel = 'Volume lemah'; volumeNotes.push('Volume masih di bawah rata-rata.'); }
  else if (volumeRatio >= 1.2) { volumeLabel = 'Volume kuat'; volumeNotes.push('Volume di atas rata-rata.'); }
  else { volumeNotes.push('Volume relatif normal.'); }
  var label = limited ? 'Likuiditas: Data terbatas' : (risk ? 'Likuiditas Tipis' : (moderate ? 'Likuiditas Sedang' : 'Liquid'));
  if (veryHighValue && !risk) label = 'Liquid';
  if (limited) notes.push('Data likuiditas terbatas.');
  return {
    liquidity_label: label,
    liquidity_notes: notes.join(' ') || (limited ? 'Data likuiditas terbatas.' : 'Likuiditas transaksi memadai.'),
    volume_confirmation_label: volumeLabel,
    volume_confirmation_notes: volumeNotes.join(' ') || 'Volume relatif normal.',
    stale_label: staleLabel,
    stale_notes: staleNotes,
    is_stale: !!isStale,
    stale_trading_days: staleDays,
    is_liquidity_risk: !!risk,
    liquidity_check_limited: !!limited,
    cannot_be_a_tier: !!(risk || (valueToday != null && valueToday < 3000000000) || (avg7 != null && avg7 < 3000000000) || (freq != null && freq < 3000))
  };
}

function getEntryWindow(category) {
  var isDay = String(category || '').toLowerCase().indexOf('day') >= 0;
  if (isDay) return { entry_window_label: '09:15–10:30 / 13:45–14:30', entry_window_notes: 'Best: 09:15–10:30 / 13:45–14:30 WIB. Avoid first 5–10 minutes after open, lunch break, and late pre-close entry unless already in plan.' };
  return { entry_window_label: 'Near planned entry zone', entry_window_notes: 'Entry valid near planned entry zone. Do not chase far above Entry 1. Prefer confirmation near close or after pullback.' };
}

function deriveConfidenceTier(row, category) {
  row = row || {};
  var rr = toNum(row.risk_reward) || 0;
  var minRR = getMinRRForCategory(category);
  var entry = getEntry1(row);
  var tp1 = toNum(row.tp1n || row.tp1);
  var upside = row.tp1_upside != null ? toNum(row.tp1_upside) : pctFrom(entry, tp1);
  var minUpside = getMinTp1UpsideForCategory(category);
  var score = toNum(row.combined_score || row.telegram_conviction_score || row.score || row.daytrade_score) || 0;
  var risk = normalizeTelegramRiskLabel(row.risk_label_v2 || row.risk_label || row.verified_risk_label).toUpperCase();
  var status = safeTelegramText(row.status || row.final_status || row.swing_tier, 100, '').toUpperCase();
  var trend = (row.trend_label || classifyTrendAlignment(row).trend_label || '').toUpperCase();
  var vol = (row.volume_label || classifyVolumeThrust(row).volume_label || '').toUpperCase();
  var liq = deriveStaleLiquidityLabels(row);
  var notes = [];
  var rrOk = rr >= minRR;
  var upsideOk = upside != null && upside >= minUpside;
  var setupStatusText = joinTelegramTexts([row.setup, row.setup_type, row.status, row.final_status, row.swing_tier]);
  var reasonText = joinTelegramTexts([row.telegram_verdict, row.verdict, row.reason, row.status_reason, row.notes, row.grade_reason, row.confidence_notes]);
  var reasonLower = reasonText.toLowerCase();
  var setupLower = setupStatusText.toLowerCase();
  var badReason = includesAny(reasonLower, ['skip', 'avoid', 'invalid', 'failed', 'distribusi', 'distribution', 'chase', 'late', 'telat']);
  var poorRRStatus = setupLower.indexOf('wait - poor rr') >= 0 || setupLower.indexOf('poor rr') >= 0;
  var invalidStatus = includesAny(setupLower, ['avoid', 'invalid', 'failed breakout']);
  var badStatus = status.indexOf('AVOID') >= 0 || status.indexOf('INVALID') >= 0 || invalidStatus;
  var bearish = trend.indexOf('BEARISH') >= 0;
  var weakTrend = trend.indexOf('WEAK') >= 0;
  var foreignDistribution = String(category || '').toLowerCase().indexOf('day') < 0 && String(row.foreign_label || '').toUpperCase().indexOf('FOREIGN DISTRIBUTION') >= 0;
  var weakVol = vol.indexOf('WEAK') >= 0 || vol.indexOf('DISTRIBUTION') >= 0;
  if (!rrOk) notes.push('Radar only — RR belum ideal.');
  if (!upsideOk) notes.push('TP1 upside belum memenuhi minimum.');
  if (liq.is_stale) notes.push('Data stale.');
  if (liq.is_liquidity_risk) notes.push('Likuiditas tipis.');
  if (risk === 'VERY HIGH RISK') notes.push('Very High Risk.');
  if (badStatus) notes.push('Setup/status avoid atau invalid.');
  if (badReason) notes.push('Verdict/reason kontradiktif untuk A-tier.');
  if (poorRRStatus) notes.push('Setup/status Poor RR.');
  if (weakTrend) notes.push('Trend lemah.');
  if (bearish) notes.push('Trend bearish.');
  if (foreignDistribution) notes.push('Foreign Distribution.');
  var tier = 'C';
  if (rrOk && upsideOk && !liq.is_stale && !liq.cannot_be_a_tier && risk !== 'VERY HIGH RISK' && !badStatus && !bearish && !weakTrend && !weakVol && score >= (String(category).indexOf('Day') >= 0 ? 75 : 72)) tier = 'A';
  else if (rrOk && upsideOk && !badStatus && !liq.is_liquidity_risk && risk !== 'VERY HIGH RISK' && score >= 58) tier = 'B';
  if (tier === 'A') {
    if (badReason || poorRRStatus) tier = 'C';
    else if (bearish) tier = (risk.indexOf('HIGH') >= 0 || reasonLower.indexOf('risk') >= 0) ? 'C' : 'B';
    else if (weakTrend || foreignDistribution) tier = 'B';
  }
  return { confidence: tier, confidence_label: tier === 'A' ? 'High Conviction' : (tier === 'B' ? 'Qualified' : 'Radar Only'), confidence_notes: notes.join(' ') || (tier === 'A' ? 'High conviction, konfirmasi kuat.' : (tier === 'B' ? 'Qualified, tunggu konfirmasi entry.' : 'Radar only, jangan agresif.')) };
}


function attachEntryStatus(row) {
  var r = row || {};
  var es = idxTick.deriveEntryStatus({
    current_price: r.current_price,
    last_price: r.last_price || r.lastn,
    close: r.close,
    entry_low: r.entry_low,
    entry_high: r.entry_high,
    entry1: r.entry1,
    entry2: r.entry2,
    entry_1: r.entry_1,
    entry_2: r.entry_2,
    stop_loss: r.stop_loss,
    sl: r.sl,
    tp1: r.tp1,
    tp1n: r.tp1n,
    target_1: r.target_1,
    tp2: r.tp2,
    tp2n: r.tp2n,
    target_2: r.target_2
  });
  r.entry_status = es.entry_status;
  r.entry_status_label = es.entry_status_label;
  r.entry_status_note = es.entry_status_note;
  r.entry_quality_status = es.entry_quality_status;
  r.entry_quality_label = es.entry_quality_label;
  r.entry_safety_note = es.entry_safety_note;
  r.entry_distance_pct = es.entry_distance_pct;
  r.chase_risk_label = es.chase_risk_label;
  Object.assign(r, idxTick.deriveBreakoutConfirmation(r));
  Object.assign(r, idxTick.deriveInvalidationDistance(r));
  var sanity = idxTick.validateTradingPlanSanity(r);
  r.trading_plan_valid = sanity.trading_plan_valid;
  r.trading_plan_status = sanity.trading_plan_status;
  r.trading_plan_note = sanity.trading_plan_note;
  var pq = idxTick.derivePlanQuality(Object.assign({}, r, {
    mode: /day/i.test(r.category || '') ? 'daytrade' : 'swing',
    rr_minimum: getMinRRForCategory(r.category)
  }));
  r.plan_quality_status = pq.plan_quality_status;
  r.plan_quality_label = pq.plan_quality_label;
  r.plan_quality_note = pq.plan_quality_note;
  r.sl_quality_label = pq.sl_quality_label;
  r.tp_quality_label = pq.tp_quality_label;
  r.rr_quality_label = pq.rr_quality_label;
  if ({ CHASE_RISK: true, EXTENDED: true, TP1_NEAR: true, TP1_HIT: true, TP2_HIT: true }[es.entry_status]) {
    if (r.confidence === 'A+' || r.confidence === 'A') r.confidence = es.entry_status === 'CHASE_RISK' ? 'B' : 'C';
    if (!r.telegram_verdict || /buy|beli/i.test(r.telegram_verdict)) r.telegram_verdict = 'Watchlist — Harga sudah menjauh dari entry, tunggu pullback.';
    if (!r.entry_timing || /entry|buy|beli/i.test(r.entry_timing)) r.entry_timing = 'Tunggu pullback — jangan chase';
  } else if (es.entry_status === 'INVALID_BELOW_SL') {
    r.confidence = 'C';
    r.telegram_verdict = 'Wait — setup invalid / SL kena.';
    r.entry_timing = 'Hindari — setup tidak valid';
  }
  var rv2 = idxTick.deriveRiskLabelV2(r);
  r.risk_label_v2 = rv2.risk_label_v2;
  r.risk_score_v2 = rv2.risk_score_v2;
  r.risk_notes_v2 = rv2.risk_notes_v2;
  r.risk_factors_v2 = rv2.risk_factors_v2;
  if (!sanity.trading_plan_valid) {
    r.confidence = 'C';
    r.telegram_verdict = 'Wait / Level belum rapi — ' + sanity.trading_plan_note;
    r.entry_timing = 'Wait — level belum rapi';
    r.plan_quality_status = 'INVALID';
    r.plan_quality_label = 'Wait / Level belum rapi';
    r.plan_quality_note = sanity.trading_plan_note;
  } else if (pq.plan_quality_status === 'INVALID') {
    r.confidence = 'C';
    r.telegram_verdict = 'Wait / Invalid — ' + pq.plan_quality_note;
    r.entry_timing = 'Hindari — setup tidak valid';
  } else if (pq.rr_quality_label === 'RR kurang menarik') {
    r.confidence = 'C';
    if (!r.telegram_verdict || /buy|beli/i.test(r.telegram_verdict)) r.telegram_verdict = 'Wait - Poor RR';
  } else if ((pq.sl_quality_label === 'SL terlalu mepet' || pq.tp_quality_label === 'TP terlalu jauh' || pq.tp_quality_label === 'TP ambisius') && (r.confidence === 'A+' || r.confidence === 'A')) {
    r.confidence = 'B';
  }
  idxTick.applyRiskV2ConfidenceGuard(r);
  var execReality = idxTick.deriveCandlePotentialRange(Object.assign({}, r, {
    previous_close: r.previous_close,
    prev_close: r.prev_close,
    prior_close: r.prior_close,
    close_prev: r.close_prev,
    prevClose: r.prevClose,
    previousClose: r.previousClose,
    current_price: r.current_price || r.last_price || r.lastn || r.close,
    mode: /day/i.test(r.category || '') ? 'daytrade' : 'swing'
  }));
  Object.assign(r, execReality);
  if (/day/i.test(r.category || '') && r.near_ara) {
    if (r.confidence === 'A+' || r.confidence === 'A') r.confidence = 'B';
    r.entry_timing = 'Watchlist — jangan chase dekat ARA';
    if (!r.telegram_verdict || /entry|buy|beli/i.test(r.telegram_verdict)) r.telegram_verdict = 'Watchlist — jangan chase dekat ARA.';
  }
  if (/day/i.test(r.category || '') && (r.tp1_beyond_ara || (r.candle_potential_high && (r.tp1 || r.tp1n) > r.candle_potential_high))) {
    if (r.confidence === 'A+' || r.confidence === 'A') r.confidence = 'B';
  }
  var sv = idxTick.deriveSignalVerdict(r);
  Object.assign(r, sv);
  if (sv.signal_confidence) r.confidence = sv.signal_confidence;
  if (r.entry_quality_status === 'NEEDS_REVALIDATION') {
    r.confidence = 'C';
    r.telegram_action_label = 'Needs revalidation';
    r.telegram_verdict = 'Needs Revalidation — data stale, validasi ulang harga/volume sebelum entry.';
    r.entry_timing = 'Needs Revalidation — jangan entry dari data stale';
  }
  return r;
}

function deriveRiskReasonDetails(row, category) {
  var r = row || {};
  var factors = [];
  function add(label) { if (label && factors.indexOf(label) === -1) factors.push(label); }
  var rr = toNum(r.risk_reward);
  var rrMin = getMinRRForCategory(category);
  var last = toNum(r.last_price || r.current_price || r.close);
  var entryLow = toNum(r.entry_low || r.entry1 || r.entry_1);
  var entryHigh = toNum(r.entry_high || r.entry2 || r.entry_2 || entryLow);
  var stop = toNum(r.stop_loss || r.sl);
  var vol = toNum(r.volume_ratio_20d || r.volume_ratio_avg20 || r.volume_today_vs_7d || r.volume_today_vs_3d || r.volume_ratio);
  var value = toNum(r.value_today || r.tx_value_1d || r.avg_tx_value_7d || r.avg_value_7d);
  var status = String(r.status || r.final_status || r.swing_tier || '').toUpperCase();
  var entryStatus = String(r.entry_status || '').toUpperCase();
  var notes = joinTelegramTexts([r.notes, r.status_reason, r.entry_timing, r.time_plan, r.telegram_verdict, r.candle_note, r.respect_zone_notes, r.entry_status_note, r.plan_quality_note, r.liquidity_notes, r.stale_notes]).toLowerCase();
  if (status === 'AVOID' || status === 'INVALID') add('Failed respect candle');
  if (rr != null && rr < rrMin) add('RR too low');
  if (last && stop && Math.abs(last - stop) / last <= 0.025) add('SL rawan noise');
  if (entryStatus === 'CHASE_RISK' || entryStatus === 'EXTENDED' || includesAny(notes, ['chase', 'telat', 'late', 'extended'])) add('Chase risk after long candle / half-candle debt not paid');
  else if (last && entryHigh && last > entryHigh && ((last - entryHigh) / entryHigh) > 0.04) add('Price too far from Entry 1');
  if (entryStatus === 'WAIT_PULLBACK' || entryStatus === 'ABOVE_ENTRY' || (last && entryLow && last > entryLow)) add('Entry not touched yet');
  if (includesAny(notes, ['failed respect', 'gagal respect', 'failed breakout', 'breakout gagal'])) add('Failed respect candle');
  if (includesAny(notes, ['below half', 'close below 1/2', 'close below half', 'reclaim 1/2', 'half candle'])) add('Close below 1/2 candle');
  if (includesAny(notes, ['near supply', 'resistance', 'tp1 near', 'dekat tp', 'dekat resistance'])) add('Near supply/resistance');
  if ((vol != null && vol < 0.8) || includesAny(notes, ['volume weak', 'volume lemah', 'weak volume', 'likuiditas lemah'])) add('Volume/liquidity weak');
  if (r.is_stale || includesAny(notes, ['stale', 'data lama'])) add('Stale data');
  if (String(r.board || '').toUpperCase().indexOf('PENGEMBANGAN') >= 0 || (value != null && value > 0 && value < 750000000) || r.is_liquidity_risk) add('Board/liquidity risk');
  if (includesAny(notes, ['volatile', 'long candle', 'candle risk', 'doji', 'marubozu']) || Math.abs(toNum(r.change_pct) || 0) >= 5) add('Candle risk / volatile candle');
  if (factors.length === 0) {
    var risk = normalizeTelegramRiskLabel(r.risk_label_v2 || r.verified_risk_label || r.risk_label);
    if (risk === 'Low Risk') add('RR cukup, entry area dekat');
    else if (risk === 'Medium Risk') add('RR cukup, tunggu konfirmasi entry');
    else add('Setup perlu konfirmasi lebih kuat');
  }
  r.risk_reason_factors = factors.slice(0, 4);
  r.risk_reason = factors.slice(0, 2).join(' + ');
  return r;
}

function enrichSignalQuality(row, category) {
  var r = Object.assign({}, row || {});
  attachEntryStatus(r);
  Object.assign(r, deriveStaleLiquidityLabels(r));
  Object.assign(r, getEntryWindow(category));
  var conf = deriveConfidenceTier(r, category);
  r.confidence = conf.confidence;
  r.confidence_label = conf.confidence_label;
  r.confidence_notes = conf.confidence_notes;
  r.rr_minimum = getMinRRForCategory(category);
  r.rr_gate_pass = (toNum(r.risk_reward) || 0) >= r.rr_minimum;
  if (!r.rr_gate_pass && !r.confidence_notes) r.confidence_notes = 'Radar only — RR belum ideal.';
  attachEntryStatus(r);
  deriveRiskReasonDetails(r, category);
  return r;
}

function applyPlanQualityConfidenceGuard(r) {
  if (!r) return r;
  if (r.plan_quality_status === 'INVALID') {
    r.confidence = 'C';
    if (!r.telegram_verdict || /buy|beli/i.test(r.telegram_verdict)) r.telegram_verdict = 'Wait / Invalid — ' + (r.plan_quality_note || 'Plan invalid.');
  } else if (r.rr_quality_label === 'RR kurang menarik') {
    r.confidence = 'C';
    if (!r.telegram_verdict || /buy|beli/i.test(r.telegram_verdict)) r.telegram_verdict = 'Wait - Poor RR';
  } else if ((r.sl_quality_label === 'SL terlalu mepet' || r.tp_quality_label === 'TP terlalu jauh' || r.tp_quality_label === 'TP ambisius') && (r.confidence === 'A+' || r.confidence === 'A')) {
    r.confidence = 'B';
  }
  return r;
}


function textHasFatalTopGuard(value) {
  var t = String(value || '').toLowerCase().replace(/[\s_\-]+/g, ' ').trim();
  return includesAny(t, [
    'failed respect',
    'gagal respect',
    'failed breakout',
    'breakout gagal',
    'distribution volume',
    'distribusi terdeteksi',
    'hard avoid',
    'setup avoid',
    'status avoid',
    'setup invalid',
    'invalid plan',
    'trading plan invalid',
    'level invalid'
  ]);
}

function hasAvoidGrade(candidate) {
  var r = candidate || {};
  return [r.confidence, r.grade, r.quality_grade, r.signal_confidence].some(function(v) {
    return String(v || '').trim().toUpperCase() === 'AVOID';
  });
}

function isHindariActionLabel(value) {
  var t = String(value || '').trim().toLowerCase();
  if (!t) return false;
  return /^hindari(\b|\s|[—\-:,.])/.test(t) || /(^|[—\-:,.]\s*)hindari(\b|\s|[—\-:,.])/.test(t);
}

function hasHindariAction(candidate) {
  var r = candidate || {};
  return [r.action, r.action_label, r.signal_action_label, r.telegram_action_label].some(isHindariActionLabel);
}

function isWeakOrFailedRespectLabel(value) {
  var t = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return t === 'weak' || t === 'ignore' || t === 'weak ignore' || includesAny(t, ['failed respect', 'gagal respect']);
}

function deriveFinalTopQualityGate(candidate, context) {
  var r = candidate || {};
  var chips = [];
  var adjustment = 0;
  function addChip(label, delta) {
    if (label && chips.indexOf(label) === -1) chips.push(label);
    adjustment += delta || 0;
  }
  function block(reason) {
    return { pass: false, hard_block: true, reason: reason, excluded_reason: 'Tidak lolos final quality gate: ' + reason + '.', quality_score_adjustment: adjustment, quality_chips: chips };
  }

  var signalAction = String(r.signal_action || '').trim().toUpperCase();
  var verdictText = joinTelegramTexts([r.signal_verdict, r.telegram_verdict, r.verdict]);
  var risk = normalizeTelegramRiskLabel(r.risk_label_v2 || r.risk_label || r.verified_risk_label).toLowerCase();
  var planStatus = String(r.plan_quality_status || '').trim().toUpperCase();
  var entryStatus = String(r.entry_status || '').trim().toUpperCase();
  var entryQuality = String(r.entry_quality_status || '').trim().toUpperCase();
  var liq = deriveStaleLiquidityLabels(r);
  var respect = String(r.respect_quality_label || '').trim().toLowerCase();
  var breakout = String(r.breakout_confirmation_status || '').trim().toLowerCase();
  var volumeLabel = String(r.volume_label || r.volume_confirmation_label || '').trim().toLowerCase();
  var patternLabel = String(r.pattern_label || '').trim().toLowerCase();
  var fatalText = joinTelegramTexts([r.notes, r.status_reason, r.entry_timing, r.time_plan, r.reason, r.action_reason, r.signal_reason, r.plan_quality_note]);

  if (hasAvoidGrade(r)) return block('Grade Avoid');
  if (signalAction === 'AVOID') return block('Signal action AVOID');
  if (hasHindariAction(r)) return block('Action Hindari');
  if (textHasFatalTopGuard(verdictText) || includesAny(verdictText.toLowerCase(), ['failed respect', 'failed breakout', 'distribusi terdeteksi', 'distribution volume'])) return block('Verdict mengandung fatal guard');
  if (risk === 'very high risk') return block('Very High Risk');
  if (planStatus === 'INVALID') return block('Trading plan invalid');
  if (r.trading_plan_valid === false) return block('Trading plan tidak valid');
  if (entryStatus === 'INVALID_BELOW_SL') return block('Entry invalid di bawah SL');
  if (entryQuality === 'NEEDS_REVALIDATION') return block('Entry perlu revalidasi');
  if (liq.stale_trading_days != null && liq.stale_trading_days > 2) return block('Data stale > 2 trading days');
  if (liq.is_liquidity_risk) return block('Likuiditas berisiko');
  if (isWeakOrFailedRespectLabel(respect)) return block('Respect candle Weak/Ignore');
  if (r.respect_invalid_reason) return block('Respect candle invalid: ' + safeTelegramText(r.respect_invalid_reason, 80, 'invalid'));
  if (r.false_breakout_risk === true && breakout.indexOf('confirmed') < 0) return block('False breakout risk belum confirmed');
  if (volumeLabel === 'distribution volume') return block('Distribution Volume');
  if (patternLabel === 'failed breakout') return block('Failed Breakout');
  if (textHasFatalTopGuard(fatalText)) return block('Catatan mengandung fatal guard');

  var trend = String(r.trend_label || '').toLowerCase();
  var foreign = String(r.foreign_label || '').toLowerCase();
  var rrLabel = String(r.rr_quality_label || '').toLowerCase();
  var slLabel = String(r.sl_quality_label || '').toLowerCase();
  var tpLabel = String(r.tp_quality_label || '').toLowerCase();
  var entryLabel = String(r.entry_status_label || r.entry_quality_label || '').toLowerCase();
  var noteText = joinTelegramTexts([r.notes, r.status_reason, r.entry_timing, r.time_plan, r.chase_risk_label, r.setup_expiry_note, r.breakout_confirmation_label]).toLowerCase();

  if (respect === 'valid respect') addChip('Valid Respect', 8);
  if (respect === 'strong respect') addChip('Strong Respect', 10);
  if (String(r.half_candle_label || '').toLowerCase().indexOf('valid') >= 0 || includesAny(noteText, ['pullback-to-midpoint valid', 'half-candle level respected'])) addChip('Half-candle respected', 6);
  if (patternLabel === 'vcp-like base') addChip('VCP-like Base', 7);
  if (patternLabel === 'breakout consolidation') addChip('Breakout Consolidation', 7);
  if (patternLabel === 'ascending triangle') addChip('Ascending Triangle', 7);
  if (volumeLabel === 'accumulation volume') addChip('Accumulation Volume', 8);
  if (volumeLabel === 'strong volume') addChip('Strong Volume', 6);
  if (trend === 'bullish trend') addChip('Bullish Trend', 7);
  if (trend === 'improving trend') addChip('Improving Trend', 4);
  if (foreign === 'foreign accumulation') addChip('Foreign Accumulation', 5);
  if (foreign === 'foreign absorption') addChip('Foreign Absorption', 4);
  if (breakout.indexOf('confirmed') >= 0) addChip('Breakout Confirmed', 6);
  if (includesAny(entryLabel, ['near entry', 'in entry', 'area entry'])) addChip('Entry near E1/E2', 5);
  if (rrLabel.indexOf('sehat') >= 0 || (toNum(r.risk_reward) || 0) >= getMinRRForCategory(r.category)) addChip('Healthy RR', 4);
  if (tpLabel.indexOf('realistis') >= 0) addChip('TP realistic', 3);

  if (includesAny(noteText, ['chase', 'extended', 'telat', 'late'])) addChip('Chase risk / Extended', -12);
  if (includesAny(noteText, ['needs close confirmation', 'close confirmation'])) addChip('Needs Close Confirmation', -5);
  if (volumeLabel === 'weak volume' || volumeLabel.indexOf('lemah') >= 0) addChip('Weak Volume', -7);
  if (trend === 'weak trend') addChip('Weak Trend', -7);
  if (foreign === 'foreign distribution') addChip('Foreign Distribution', -8);
  if (includesAny(noteText + ' ' + tpLabel, ['near supply', 'tp1 near', 'dekat tp', 'dekat resistance'])) addChip('Near supply / TP1 near', -6);
  if (slLabel.indexOf('rawan') >= 0 || includesAny(noteText, ['sl rawan noise'])) addChip('SL rawan noise', -5);
  if (includesAny(noteText, ['invalidation near', 'invalidasi dekat'])) addChip('Invalidation near', -5);
  if (includesAny(noteText, ['setup expired', 'needs revalidation'])) addChip('Setup expired / Needs Revalidation', -10);

  return { pass: true, hard_block: false, reason: chips.length ? chips.join(', ') : 'Final quality gate passed.', excluded_reason: null, quality_score_adjustment: adjustment, quality_chips: chips };
}

function applyFinalTopQualityGate(candidate, context) {
  var gate = deriveFinalTopQualityGate(candidate, context);
  if (candidate) {
    candidate.final_top_quality_gate = gate;
    candidate.quality_score_adjustment = gate.quality_score_adjustment;
    candidate.quality_chips = gate.quality_chips;
    candidate.excluded_reason = gate.excluded_reason;
    if (!gate.pass) {
      candidate.signal_action = 'AVOID';
      candidate.signal_action_label = 'Hindari';
      candidate.action_label = 'Hindari';
      candidate.signal_verdict = gate.excluded_reason;
      candidate.telegram_verdict = gate.excluded_reason;
    }
  }
  return gate;
}


function getPotentialRadarReason(candidate) {
  var r = candidate || {};
  var status = String(r.breakout_confirmation_status || r.entry_status || r.entry_quality_status || r.status || r.final_status || '').toUpperCase();
  var text = joinTelegramTexts([
    r.breakout_confirmation_label, r.breakout_confirmation_note, r.entry_timing, r.time_plan,
    r.chase_risk_label, r.setup_expiry_note, r.data_quality_label, r.data_quality_note,
    r.volume_label, r.volume_confirmation_label, r.mtf_label, r.trend_label, r.execution_reality_label, r.execution_reality_note, r.ara_arb_note, r.telegram_verdict,
    r.signal_verdict, r.verdict, r.notes, r.status_reason
  ]).toLowerCase();
  if (status === 'BREAKOUT_WATCH' || includesAny(text, ['breakout watch'])) return 'WATCH_BREAKOUT';
  if (status === 'NEEDS_CLOSE_CONFIRMATION' || includesAny(text, ['needs close confirmation', 'close confirmation', 'tunggu close', 'butuh close'])) return 'WAIT_CLOSE_CONFIRMATION';
  if (status === 'WAIT_PULLBACK' || includesAny(text, ['wait pullback', 'tunggu pullback'])) return 'WAIT_PULLBACK';
  if (status === 'CHASE_RISK' || status === 'EXTENDED' || includesAny(text, ['chase', 'extended', 'telat', 'late'])) return 'CHASE_RISK_MONITOR';
  if (includesAny(text, ['ara', 'arb', 'auto reject'])) return 'ARA_ARB_MONITOR';
  if (String(r.data_quality_status || '').toUpperCase() === 'NEEDS_REVALIDATION' || r.data_quality_needs_revalidation === true || includesAny(text, ['needs revalidation', 'perlu validasi ulang', 'missing reference'])) return 'DATA_NEEDS_REVALIDATION';
  if (includesAny(text, ['volume belum', 'volume confirmation', 'weak volume mulai', 'volume mulai'])) return 'VOLUME_CONFIRMATION_NEEDED';
  if (includesAny(text, ['mtf mixed', 'mixed timeframe'])) return 'MTF_MIXED';
  return 'WATCHLIST_MONITOR';
}

function candidatePassesPotentialRadarGate(candidate, mode) {
  if (!candidate || !candidate.ticker) return false;
  var r = candidate;
  var allText = joinTelegramTexts([
    r.status, r.final_status, r.verdict, r.signal_verdict, r.telegram_verdict, r.reason,
    r.status_reason, r.action_reason, r.signal_reason, r.excluded_reason, r.action,
    r.action_label, r.signal_action_label, r.telegram_action_label, r.signal_action,
    r.risk, r.risk_label, r.risk_label_v2, r.verified_risk_label, r.grade, r.quality_grade,
    r.liquidity_label, r.liquidity_notes, r.liquidity_status, r.volume_label,
    r.volume_confirmation_label, r.volume_notes, r.volume_confirmation_notes,
    r.plan_quality_label, r.plan_quality_note, r.data_quality_label, r.data_quality_note,
    r.entry_status_label, r.entry_status_note, r.invalidation_note
  ]).toLowerCase();
  var finalOnlyReject = includesAny(allText, ['tidak lolos final quality gate']);
  var radarStatusText = String(r.status || r.final_status || r.breakout_confirmation_status || r.entry_status || '').toUpperCase();
  var generatedWatchlistAvoid = includesAny(radarStatusText, ['WAIT_PULLBACK', 'BREAKOUT_WATCH', 'NEEDS_CLOSE_CONFIRMATION', 'PRE_SPIKE_WATCH']);
  if (!finalOnlyReject && !generatedWatchlistAvoid && (hasAvoidGrade(r) || hasHindariAction(r))) return false;
  if ((!finalOnlyReject && !generatedWatchlistAvoid && includesAny(allText, ['hindari', 'avoid'])) || includesAny(allText, ['very high risk', 'extreme risk', 'weak liquidity', 'likuiditas lemah', 'likuiditas tipis', 'weak volume', 'volume lemah', 'invalid plan', 'plan invalid', 'trading plan invalid', 'below sl', 'sl kena', 'invalidation hit', 'candle tidak valid', 'invalid candle', 'data rusak berat'])) return false;
  if (r.trading_plan_valid === false) return false;
  var risk = normalizeTelegramRiskLabel(r.risk_label_v2 || r.risk_label || r.verified_risk_label).toLowerCase();
  if (risk === 'very high risk') return false;
  var planStatus = String(r.plan_quality_status || r.trading_plan_status || '').trim().toUpperCase();
  if (planStatus === 'INVALID') return false;
  var entryStatus = String(r.entry_status || '').trim().toUpperCase();
  var entryQuality = String(r.entry_quality_status || '').trim().toUpperCase();
  if (entryStatus === 'INVALID_BELOW_SL' || entryQuality === 'INVALID_BELOW_SL') return false;
  var invalidationDistanceStatus = String(r.invalidation_distance_status || '').trim().toUpperCase();
  if (invalidationDistanceStatus === 'INVALID_BELOW_SL') return false;
  var dataQualityStatus = String(r.data_quality_status || '').trim().toUpperCase();
  if (dataQualityStatus === 'INVALID_CANDLE' || r.data_quality_valid === false) return false;
  var liq = deriveStaleLiquidityLabels(r);
  if (liq.is_liquidity_risk) return false;
  var entry1 = toNum(r.entry1) || getEntry1(r);
  var sl = toNum(r.sl || r.stop_loss);
  if (entry1 > 0 && sl > 0 && (toNum(r.last_price || r.lastn) || entry1) < sl) return false;
  var tp1 = toNum(r.tp1n || r.tp1);
  if (!(entry1 > 0) || !(sl > 0) || !(tp1 > 0)) return false;
  return true;
}

function candidatePassesRRGate(candidate) {
  return (toNum(candidate && candidate.risk_reward) || 0) >= getMinRRForCategory(candidate && candidate.category);
}

function publicTelegramSafetyTextHasReject(text) {
  return includesAny(String(text || '').toLowerCase(), [
    'hindari',
    'avoid',
    'rejected',
    'reject',
    'failed',
    'fail',
    'tidak lolos final quality gate',
    'below sl',
    'sl kena',
    'invalidation hit',
    'invalidation terlalu dekat',
    'terlalu mepet',
    'rawan noise',
    'riwayat data pendek',
    'reference price',
    'data perdagangan tidak utuh',
    'candle tidak valid',
    'corporate action',
    'perlu validasi ulang',
    'data tidak valid'
  ]);
}

function candidatePassesPublicTelegramSafetyGate(candidate, mode) {
  if (!candidate) return false;
  var finalGate = candidate.final_top_quality_gate || candidate.final_quality_gate || candidate.top_quality_gate || null;
  if (candidate.final_quality_pass === false ||
      candidate.final_gate_pass === false ||
      candidate.quality_gate_pass === false ||
      (finalGate && finalGate.pass === false)) return false;

  var statusVerdictText = joinTelegramTexts([
    candidate.status,
    candidate.final_status,
    candidate.verdict,
    candidate.signal_verdict,
    candidate.telegram_verdict,
    candidate.reason,
    candidate.status_reason,
    candidate.action_reason,
    candidate.signal_reason,
    candidate.excluded_reason,
    candidate.final_quality_status,
    candidate.final_gate_status,
    candidate.quality_gate_status,
    candidate.action
  ]);
  if (publicTelegramSafetyTextHasReject(statusVerdictText)) return false;

  var actionText = joinTelegramTexts([
    candidate.action_label,
    candidate.signal_action_label,
    candidate.telegram_action_label,
    candidate.action,
    candidate.signal_action
  ]);
  if (includesAny(actionText.toLowerCase(), ['hindari', 'avoid'])) return false;

  var executionStatus = String(candidate.execution_reality_status || '').trim().toUpperCase();
  if ({ UNKNOWN_LIMITS: true, NEAR_ARA: true, ARA_HIT: true, NEAR_ARB: true, ARB_HIT: true }[executionStatus]) return false;
  if (candidate.buy_execution_realistic === false || candidate.near_ara === true || candidate.ara_hit === true ||
      candidate.entry_near_ara === true || candidate.trigger_near_ara === true || candidate.near_arb === true ||
      candidate.arb_hit === true || candidate.sell_risk_near_arb === true) return false;
  var executionText = joinTelegramTexts([
    candidate.execution_reality_label,
    candidate.execution_reality_note,
    candidate.ara_arb_note,
    candidate.tp_realism_note
  ]).toLowerCase();
  if (includesAny(executionText, [
    'ara hit', 'near ara', 'arb hit', 'near arb', 'execution not realistic',
    'tidak realistis dieksekusi', 'tidak realistis', 'rawan auto reject',
    'mentok ara', 'mentok arb', 'dekat ara', 'dekat arb', 'rawan ara', 'rawan arb'
  ])) return false;

  var breakoutStatus = String(candidate.breakout_confirmation_status || '').trim().toUpperCase();
  if ({ FALSE_BREAKOUT_RISK: true, NEEDS_CLOSE_CONFIRMATION: true, BREAKOUT_WATCH: true }[breakoutStatus]) return false;
  if (candidate.false_breakout_risk === true) return false;
  var breakoutSafetyText = joinTelegramTexts([
    candidate.breakout_confirmation_label,
    candidate.breakout_confirmation_note,
    candidate.notes,
    candidate.status_reason,
    candidate.entry_timing,
    candidate.time_plan,
    candidate.telegram_verdict,
    candidate.action_label,
    candidate.signal_action_label,
    candidate.telegram_action_label,
    candidate.action,
    candidate.signal_action
  ]).toLowerCase();
  if (includesAny(breakoutSafetyText, [
    'false breakout',
    'needs close confirmation',
    'butuh close',
    'close confirmation',
    'close failed',
    'failed close',
    'close gagal',
    'gagal close',
    'gagal bertahan',
    'wick pierced',
    'pierce resistance'
  ])) return false;

  var dataQualityStatus = String(candidate.data_quality_status || '').trim().toUpperCase();
  if (candidate.data_quality_valid === false || candidate.data_quality_needs_revalidation === true) return false;
  if ({ SHORT_HISTORY: true, MISSING_REFERENCE: true, SPARSE_TRADING_DAYS: true, INVALID_CANDLE: true, CORPORATE_ACTION_RISK: true, NEEDS_REVALIDATION: true }[dataQualityStatus]) return false;
  var dataQualityText = joinTelegramTexts([
    candidate.data_quality_label,
    candidate.data_quality_note,
    candidate.data_quality_status
  ]).toLowerCase();
  if (includesAny(dataQualityText, [
    'riwayat data pendek',
    'reference price',
    'data perdagangan tidak utuh',
    'candle tidak valid',
    'corporate action',
    'perlu validasi ulang',
    'data tidak valid'
  ])) return false;

  var risk = normalizeTelegramRiskLabel(candidate.risk_label_v2 || candidate.risk_label || candidate.verified_risk_label).toLowerCase();
  if (risk === 'very high risk') return false;

  var invalidationDistanceStatus = String(candidate.invalidation_distance_status || '').trim().toUpperCase();
  if ({ INVALID_BELOW_SL: true, TOO_CLOSE_TO_SL: true }[invalidationDistanceStatus]) return false;

  var entryStatus = String(candidate.entry_status || '').trim().toUpperCase();
  var entryQuality = String(candidate.entry_quality_status || '').trim().toUpperCase();
  if ({ CHASE_RISK: true, EXTENDED: true, TP1_NEAR: true, TP1_HIT: true, TP2_HIT: true, INVALID_BELOW_SL: true, NEEDS_REVALIDATION: true }[entryStatus]) return false;
  if ({ CHASE_RISK: true, EXTENDED: true, TP1_NEAR: true, TP1_HIT: true, TP2_HIT: true, INVALID_BELOW_SL: true, NEEDS_REVALIDATION: true }[entryQuality]) return false;

  var freshnessStatus = safeTelegramText(candidate.setup_freshness_status || candidate.freshness_status || '', 80, '').toUpperCase();
  if (freshnessStatus === 'EXPIRED' || freshnessStatus === 'NEEDS_REVALIDATION') return false;
  if (candidate.is_stale === true || candidate.data_stale === true || candidate.freshness_is_stale === true || candidate.stale === true) return false;

  var freshnessText = joinTelegramTexts([
    candidate.setup_freshness_label,
    candidate.freshness_label,
    candidate.setup_expiry_note,
    candidate.stale_notes,
    candidate.freshness_note,
    candidate.freshness_status,
    candidate.setup_freshness_status
  ]);
  if (includesAny(freshnessText.toLowerCase(), ['stale', 'expired', 'needs revalidation', 'perlu validasi ulang', 'data basi', 'setup terlalu lama'])) return false;

  var liquidityText = joinTelegramTexts([
    candidate.liquidity_label,
    candidate.liquidity_notes,
    candidate.liquidity_status
  ]);
  if (candidate.is_liquidity_risk === true || includesAny(liquidityText.toLowerCase(), ['weak liquidity', 'likuiditas lemah', 'likuiditas tipis'])) return false;

  var volumeText = joinTelegramTexts([
    candidate.volume_label,
    candidate.volume_confirmation_label,
    candidate.volume_notes,
    candidate.volume_confirmation_notes
  ]);
  if (includesAny(volumeText.toLowerCase(), ['weak volume', 'volume lemah'])) return false;

  if (candidate.trading_plan_valid === false) return false;
  var planQualityStatus = String(candidate.plan_quality_status || candidate.trading_plan_status || '').trim().toUpperCase();
  if ({ INVALID: true, POOR_RR: true }[planQualityStatus]) return false;
  var guardText = joinTelegramTexts([
    candidate.action_guard_label,
    candidate.action_guard_status,
    candidate.plan_quality_label,
    candidate.plan_quality_note,
    candidate.entry_timing,
    candidate.time_plan,
    candidate.entry_status_label,
    candidate.entry_status_note,
    candidate.invalidation_distance_label,
    candidate.invalidation_note
  ]);
  if (publicTelegramSafetyTextHasReject(guardText)) return false;
  if (includesAny(guardText.toLowerCase(), ['level belum rapi', 'invalid plan', 'plan invalid', 'chase', 'extended', 'tp near', 'tp1 near'])) return false;

  if (mode !== 'daytrade') return applyFinalTopQualityGate(candidate, mode || 'public_telegram').pass;
  return true;
}

function candidateTelegramEligible(candidate) {
  if (!candidate || !candidatePassesRRGate(candidate) || !candidatePassesMinUpside(candidate)) return false;
  var q = deriveStaleLiquidityLabels(candidate);
  if (q.stale_trading_days != null && q.stale_trading_days > 2) return false;
  if (q.is_liquidity_risk) return false;
  return candidatePassesPublicTelegramSafetyGate(candidate, 'telegram');
}

function candidatePassesMinUpside(candidate) {
  if (!candidate || !candidate.ticker) return false;
  var entry = toNum(candidate.entry1) || getEntry1(candidate);
  var tp1 = toNum(candidate.tp1n || candidate.tp1);
  if (!(entry > 0) || !(tp1 > 0) || tp1 <= entry) return false;
  var upside = candidate.tp1_upside != null ? toNum(candidate.tp1_upside) : pctFrom(entry, tp1);
  if (upside == null || !isFinite(upside)) return false;
  if (!candidate.entry1) candidate.entry1 = entry;
  if (!candidate.tp1n) candidate.tp1n = tp1;
  candidate.tp1_upside = upside;
  return upside >= getMinTp1UpsideForCategory(candidate.category);
}

function rankCandidatesByPotential(candidate) {
  if (!candidate) return -999999;
  var stalePenalty = 0;
  if (!candidate.ticker || !candidate.entry1 || !candidate.tp1n || !candidate.sl) stalePenalty -= 1000;
  if (includesAny(joinTelegramTexts([candidate.notes, candidate.status_reason, candidate.entry_timing, candidate.time_plan, candidate.telegram_verdict]), ['chase', 'telat', 'late', 'failed', 'gagal', 'distribusi', 'avoid', 'invalid'])) stalePenalty -= 35;
  var upside = toNum(candidate.tp1_upside);
  if (upside == null) upside = pctFrom(toNum(candidate.entry1) || getEntry1(candidate), toNum(candidate.tp1n || candidate.tp1));
  var rr = toNum(candidate.risk_reward) || 0;
  var score = toNum(candidate.combined_score || candidate.telegram_conviction_score || candidate.score || candidate.daytrade_score) || 0;
  var volume = getTelegramValue(candidate) > 0 ? Math.min(20, Math.log10(getTelegramValue(candidate))) : 0;
  var volRatio = getTelegramVolumeRatio(candidate) || 0;
  var trend = classifyTrendAlignment(candidate).trend_label;
  var volCtx = classifyVolumeThrust(candidate).volume_label;
  var pattern = derivePatternLabel(Object.assign({}, candidate, { trend_label: trend, volume_label: volCtx })).pattern_label;
  var confluence = 0;
  if (trend === 'Bullish Trend') confluence += 10; else if (trend === 'Improving Trend') confluence += 5; else if (trend === 'Bearish Trend') confluence -= 15; else if (trend === 'Weak Trend') confluence -= 8;
  if (volCtx === 'Accumulation Volume' || volCtx === 'Strong Volume') confluence += 8;
  if (volCtx === 'Weak Volume') confluence -= 8;
  if (volCtx === 'Distribution Volume') confluence -= 15;
  if (pattern === 'VCP-like Base' || pattern === 'Ascending Triangle' || pattern === 'Breakout Consolidation') confluence += 8;
  if (pattern === 'Failed Breakout') confluence -= 15;
  var gate = deriveFinalTopQualityGate(candidate, 'rank');
  return ((upside || 0) * 100) + (rr * 25) + score + (volume * 3) + (volRatio * 5) + confluence + stalePenalty + (gate.quality_score_adjustment || 0);
}

function normalizeCombinedCandidate(row, category) {
  var r = Object.assign({}, row || {});
  r.category = category;
  r.ticker = normalizeForeignTicker(r.ticker || '');
  r.entry1 = getEntry1(r);
  r.entry2 = getEntry2(r);
  r.sl = toNum(r.stop_loss);
  r.tp1n = toNum(r.tp1);
  r.tp2n = toNum(r.tp2);
  r.lastn = toNum(r.last_price);
  r = idxTick.normalizeTradingPlanLevels(r);
  attachEntryStatus(r);
  r.score_norm = getTelegramScore(r, category === 'Day Trade' ? 'daytrade' : 'swing');
  var verified = verifyTelegramSignal(r, category === 'Day Trade' ? 'daytrade' : 'swing');
  if (verified) r = Object.assign(r, verified);
  var high = verified ? verifyHighConvictionTelegramSignal(r, category === 'Day Trade' ? 'daytrade' : 'swing') : null;
  if (high) r = Object.assign(r, high);
  r.tp1_upside = pctFrom(r.entry1, r.tp1n);
  r.tp2_upside = pctFrom(r.entry1, r.tp2n);
  r.sl_risk = pctFrom(r.entry1, r.sl);
  r.combined_score = (toNum(r.telegram_conviction_score) || r.score_norm || 0)
    + (r.tp1_upside >= 2 ? 8 : -4)
    + (r.tp2_upside >= 5 ? 6 : 0)
    + ((toNum(r.risk_reward) || 0) >= 1.5 ? 6 : -4)
    + (category === 'Day Trade' ? 4 : 0)
    + (getTelegramValue(r) >= 10000000000 ? 4 : 0)
    - (includesAny(joinTelegramTexts([r.notes, r.status_reason, r.entry_timing, r.time_plan]), ['chase', 'telat', 'late']) ? 8 : 0);
  r = applyPlanQualityConfidenceGuard(enrichSignalQuality(r, category));
  applyFinalTopQualityGate(r, 'normalize');
  return r;
}

async function fetchCombinedScreenerCandidates(supabase, includeExcluded) {
  var pools = [];
  var dt = await supabase.from('daytrade_screener_latest').select('*').order('daytrade_score', { ascending: false }).limit(40);
  (dt.data || []).forEach(function(r) { pools.push(normalizeCombinedCandidate(r, 'Day Trade')); });
  var kg = await supabase.from('swing_screener_latest').select('*').order('score', { ascending: false }).limit(40);
  (kg.data || []).forEach(function(r) { pools.push(normalizeCombinedCandidate(r, 'Swing Konglo')); });
  var nk = await supabase.from('swing_screener_non_konglo_latest').select('*').order('rank', { ascending: true }).limit(40);
  (nk.data || []).forEach(function(r) { pools.push(normalizeCombinedCandidate(r, 'Swing Non-Konglo')); });
  var byTicker = {};
  pools.filter(function(r) { return r.ticker && r.entry1 && r.tp1n && r.tp2n && r.sl && (includeExcluded || candidateTelegramEligible(r)); }).forEach(function(r) {
    if (!byTicker[r.ticker] || rankCandidatesByPotential(r) > rankCandidatesByPotential(byTicker[r.ticker])) byTicker[r.ticker] = r;
  });
  return Object.keys(byTicker).map(function(k) { return byTicker[k]; }).sort(function(a, b) { return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); });
}

async function fetchForeignSummary(supabase, ticker) {
  try {
    var res = await supabase.from('foreign_watchlist_daily').select('trade_date,ticker,foreign_net,nbsa').eq('ticker', ticker).order('trade_date', { ascending: false }).limit(7);
    var rows = res.data || [];
    if (res.error || rows.length === 0) return { text: 'Foreign: belum ada data', score: 0 };
    var latest = rows[0];
    var avg = rows.reduce(function(s, r) { return s + (Number(r.foreign_net) || 0); }, 0) / rows.length;
    var side = latest.foreign_net > 0 ? 'net buy' : (latest.foreign_net < 0 ? 'net sell' : 'netral');
    var trend = avg > 0 ? 'Accumulation' : (avg < 0 ? 'Distribution' : 'Neutral');
    return { latest: latest, avg: avg, trend: trend, score: avg > 0 ? 5 : (avg < 0 ? -4 : 0), text: 'Foreign: ' + latest.trade_date + ' NBSA ' + formatForeignNumber(latest.nbsa) + ' · ' + formatForeignNetWithSide(latest.foreign_net) + ' · Avg7 ' + formatForeignNetWithSide(avg) + ' (' + trend + ')' };
  } catch (e) { return { text: 'Foreign: belum ada data', score: 0 }; }
}

function candidateReason(r) {
  var gate = deriveFinalTopQualityGate(r, 'reason');
  if (!gate.pass) return safeTelegramText(gate.excluded_reason, 130, 'Tidak lolos final quality gate.');
  return safeTelegramText(r.telegram_verdict || r.status_reason || r.notes || r.setup || r.status || r.final_status, 130, 'Skor, RR, likuiditas, dan level plan relatif lebih kuat.');
}

function buildTop5PhotoCaption(detailText) {
  var full = String(detailText || '').trim();
  if (full.length <= 1024) return { caption: full, followup: null };
  var alasanIdx = full.indexOf('\nAlasan: ');
  if (alasanIdx !== -1) {
    var prefix = full.slice(0, alasanIdx);
    var alasan = full.slice(alasanIdx + 9).replace(/\s+/g, ' ').trim();
    var room = 1024 - prefix.length - 10;
    if (room > 24) return { caption: prefix + '\nAlasan: ' + alasan.slice(0, room - 1).trim() + '…', followup: null };
    if (prefix.length <= 1024) return { caption: prefix, followup: null };
  }
  return { caption: full.slice(0, 1023).trim() + '…', followup: null };
}

async function formatCandidateBlock(supabase, r, idx, compact) {
  if (!r.trend_label) Object.assign(r, classifyTrendAlignment(r));
  if (!r.volume_label) Object.assign(r, classifyVolumeThrust(r));
  if (!r.pattern_label) Object.assign(r, derivePatternLabel(r));
  var includeForeign = r.category !== 'Day Trade';
  var f = includeForeign ? await fetchForeignConfluence(supabase, r.ticker, r.lastn || r.last_price) : null;
  if (f) {
    Object.assign(r, f);
    var confAfterForeign = deriveConfidenceTier(r, r.category);
    r.confidence = confAfterForeign.confidence;
    r.confidence_label = confAfterForeign.confidence_label;
    r.confidence_notes = confAfterForeign.confidence_notes;
    applyPlanQualityConfidenceGuard(r);
  }
  var setup = compactSafeText(r.setup || r.setup_type || r.status || r.final_status, '-').replace(/_/g, ' ');
  var risk = deriveTelegramRiskLabel(r, r.category === 'Day Trade' ? 'daytrade' : 'swing').replace(' Risk','');
  var grade = compactSafeText(r.confidence || r.quality_grade || r.grade || getTelegramGrade(r), '-');
  var score = fmtScore(r.combined_score || r.telegram_conviction_score || r.score || r.daytrade_score);
  var lines = [];
  lines.push(idx + '. ' + r.ticker + ' — ' + r.category + ' | ' + setup);
  lines.push('G:' + grade + ' · Risk:' + risk + ' · RR:' + fmtRR(r.risk_reward) + ' · Liq:' + compactSafeText(r.liquidity_label, '-'));
  lines.push('EntryQ: ' + compactSafeText(r.entry_quality_label || r.entry_status_label, '-') + ' · PlanQ: ' + compactSafeText(r.plan_quality_label || r.plan_label, '-'));
  lines.push('Plan: ' + compactSafeText(r.rr_quality_label, 'RR sehat') + ' · ' + compactSafeText(r.sl_quality_label, 'SL wajar') + ' · ' + compactSafeText(r.tp_quality_label, 'TP realistis'));
  lines.push('Window: ' + compactSafeText(r.entry_window_label, '-'));
  lines.push('Harga ' + fmtPrice(r.lastn || r.last_price) + ' | Entry ' + fmtPrice(r.entry1) + '/' + fmtPrice(r.entry2) + ' | SL ' + fmtPrice(r.sl) + ' | TP ' + fmtPrice(r.tp1n) + '/' + fmtPrice(r.tp2n));
  lines.push('Vol ' + fmtRatio(getTelegramVolumeRatio(r)) + ' · Tx ' + fmtRpValue(getTelegramValue(r)) + ' · Trend ' + compactSafeText((r.trend_label || '').replace(' Trend',''), '-'));
  var confluence = [];
  if (r.pattern_label && r.pattern_label !== 'Insufficient Data' && r.pattern_label !== 'No Clear Pattern') confluence.push('Pattern: ' + r.pattern_label.replace('VCP-like Base','VCP-like'));
  if (f && f.foreign_label && f.foreign_label !== 'Foreign Data Unavailable') confluence.push('Foreign 7D: ' + f.foreign_label.replace('Foreign ','') + ' ' + formatForeignRupiah(f.foreign_7d));
  if (r.is_stale || r.data_stale || r.freshness_is_stale) confluence.push('Needs Revalidation: data stale');
  if (r.confidence === 'C') confluence.push('Radar Only');
  if (confluence.length) lines.push(confluence.join(' · '));
  var execReality = idxTick.deriveCandlePotentialRange(Object.assign({}, r, {
    previous_close: r.previous_close,
    prev_close: r.prev_close,
    prior_close: r.prior_close,
    close_prev: r.close_prev,
    prevClose: r.prevClose,
    previousClose: r.previousClose,
    current_price: r.current_price || r.last_price || r.lastn || r.close,
    mode: /day/i.test(r.category || '') ? 'daytrade' : 'swing'
  }));
  Object.assign(r, execReality);
  if (/day/i.test(r.category || '') && r.near_ara) {
    if (r.confidence === 'A+' || r.confidence === 'A') r.confidence = 'B';
    r.entry_timing = 'Watchlist — jangan chase dekat ARA';
    if (!r.telegram_verdict || /entry|buy|beli/i.test(r.telegram_verdict)) r.telegram_verdict = 'Watchlist — jangan chase dekat ARA.';
  }
  if (/day/i.test(r.category || '') && (r.tp1_beyond_ara || (r.candle_potential_high && (r.tp1 || r.tp1n) > r.candle_potential_high))) {
    if (r.confidence === 'A+' || r.confidence === 'A') r.confidence = 'B';
  }
  var sv = idxTick.deriveSignalVerdict(r);
  Object.assign(r, sv);
  if (r.candle_potential_low && r.candle_potential_high) {
    var roomTxt = r.ara_room_pct != null ? ' · ARA room ' + ((Number(r.ara_room_pct) >= 0 ? '+' : '') + Number(r.ara_room_pct).toFixed(1).replace('.', ',') + '%') : '';
    lines.push('Potensi: Candle ' + fmtPrice(r.candle_potential_low) + '–' + fmtPrice(r.candle_potential_high) + roomTxt);
    if (r.tp_realism_note) lines.push('TP Realism: ' + r.tp_realism_note);
    if (r.category === 'Day Trade' && r.near_ara) lines.push('Note: Dekat ARA, jangan chase agresif.');
  }
  lines.push('Verdict: ' + compactSafeText(r.signal_action_label || 'Watchlist', 'Watchlist'));
  if (!compact) lines.push('Chart: ' + chartLink(r.ticker));
  return lines.map(function(line){ return compactSafeText(line, '-'); }).join('\n');
}


async function fetchSignalScreenerCandidatesByTicker(supabase, ticker) {
  var safeTicker = normalizeForeignTicker(ticker);
  if (!safeTicker) return [];
  var sources = [
    { table: 'daytrade_screener_latest', category: 'Day Trade', orderCol: 'daytrade_score', asc: false },
    { table: 'swing_screener_latest', category: 'Swing Konglo', orderCol: 'score', asc: false },
    { table: 'swing_screener_non_konglo_latest', category: 'Swing Non-Konglo', orderCol: 'rank', asc: true }
  ];
  var out = [];
  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var res = await supabase.from(src.table).select('*').eq('ticker', safeTicker).order(src.orderCol, { ascending: src.asc }).limit(5);
    (res.data || []).forEach(function(row) { out.push(normalizeCombinedCandidate(row, src.category)); });
  }
  out.sort(function(a, b) {
    var ae = candidateTelegramEligible(a) ? 1 : 0;
    var be = candidateTelegramEligible(b) ? 1 : 0;
    return be - ae || rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || String(a.category || '').localeCompare(String(b.category || ''));
  });
  return out;
}

async function fetchSignalForeignRows(supabase, ticker) {
  var safeTicker = normalizeForeignTicker(ticker);
  if (!safeTicker) return [];
  var res = await supabase
    .from('foreign_watchlist_daily')
    .select('trade_date,ticker,foreign_net,close,volume,freq,valuasi,nbsa')
    .eq('ticker', safeTicker)
    .order('trade_date', { ascending: false })
    .limit(7);
  if (res.error) return [];
  return res.data || [];
}

function signalCleanLines(lines) {
  return lines.map(function(line) { return safeTelegramText(line, 300, ''); }).filter(Boolean).join('\n');
}

function signalForeignSummaryFromRows(rows) {
  rows = rows || [];
  if (!rows.length) return null;
  var n1 = Number(rows[0].foreign_net) || 0;
  var n3 = rows.slice(0, 3).reduce(function(sum, r) { return sum + (Number(r.foreign_net) || 0); }, 0);
  var n7 = rows.slice(0, 7).reduce(function(sum, r) { return sum + (Number(r.foreign_net) || 0); }, 0);
  return {
    latest: rows[0],
    foreign_1d: n1,
    foreign_3d: n3,
    foreign_7d: n7,
    foreign_label: getForeignTrendLabel(n3, n7),
    foreign_notes: rows.length >= 7 ? 'Foreign 1D/3D/7D dari foreign_watchlist_daily.' : ('Foreign data belum lengkap (' + rows.length + '/7 hari).')
  };
}


function redactAdvancedScreenerFields(row) {
  var r = Object.assign({}, row || {});
  delete r.half_candle_level;
  delete r.half_candle_label;
  delete r.half_candle_note;
  delete r.half_candle_chase_risk;
  delete r.half_candle_distance_pct;
  delete r.respect_zone_notes;
  delete r.refinement_notes;
  delete r.respect_quality_score;
  delete r.respect_quality_label;
  delete r.respect_quality_factors;
  delete r.respect_invalid_reason;
  delete r.bearish_respect_warning;
  var advancedTiming = /half-candle|1\/2 candle|reclaim 1\/2|failed respect|long candle/i;
  if (r.entry_timing && advancedTiming.test(String(r.entry_timing))) r.entry_timing = 'Tunggu konfirmasi entry';
  if (r.direction && /long candle|respect candle|half-candle|1\/2 candle/i.test(String(r.direction))) r.direction = 'Pantau setup';
  if (r.notes && /half-candle|1\/2 candle|respect zone|failed respect/i.test(String(r.notes))) r.notes = String(r.notes).replace(/\s*\|?\s*(Entry pullback 1\/2 candle|Pullback-to-midpoint candle|Chase candle \/ extended candle|Failed respect candle)[^|;.]*/gi, '').trim();
  return r;
}

function redactAdvancedScreenerRows(rows) {
  return (rows || []).map(redactAdvancedScreenerFields);
}

async function buildSignalMessage(supabase, ticker) {
  var safeTicker = normalizeForeignTicker(ticker);
  if (!safeTicker) return 'Format:\n/signal TICKER\nContoh: /signal BBRI';
  var candidates = await fetchSignalScreenerCandidatesByTicker(supabase, safeTicker);
  var row = candidates[0] || null;
  if (!row) {
    var foreignRows = await fetchSignalForeignRows(supabase, safeTicker);
    var fs = signalForeignSummaryFromRows(foreignRows);
    if (!fs) return signalCleanLines(['SIGNAL ' + safeTicker, 'Trading plan belum tersedia di screener.', 'Data teknikal belum cukup.', 'Bukan rekomendasi beli/jual. DYOR.']);
    return signalCleanLines([
      'SIGNAL ' + safeTicker,
      'Trading plan belum tersedia di screener.',
      'Harga ' + fmtPrice(fs.latest.close),
      'Foreign 1D/3D/7D: ' + formatForeignNetWithSide(fs.foreign_1d) + ' / ' + formatForeignNetWithSide(fs.foreign_3d) + ' / ' + formatForeignNetWithSide(fs.foreign_7d),
      'Foreign: ' + fs.foreign_label + ' · ' + fs.foreign_notes,
      'Data teknikal belum cukup.',
      'Bukan rekomendasi beli/jual. DYOR.'
    ]);
  }

  if (!row.trend_label) Object.assign(row, classifyTrendAlignment(row));
  if (!row.volume_label) Object.assign(row, classifyVolumeThrust(row));
  if (!row.pattern_label) Object.assign(row, derivePatternLabel(row));
  var foreignRows2 = await fetchSignalForeignRows(supabase, safeTicker);
  var fs2 = signalForeignSummaryFromRows(foreignRows2);
  if (fs2 && row.category !== 'Day Trade') Object.assign(row, fs2);
  else if (fs2 && (row.foreign_7d == null || row.foreign_label == null)) Object.assign(row, fs2);
  var confAfter = deriveConfidenceTier(row, row.category);
  row.confidence = confAfter.confidence;
  row.confidence_label = confAfter.confidence_label;
  row.confidence_notes = confAfter.confidence_notes;
  applyPlanQualityConfidenceGuard(row);
  Object.assign(row, deriveStaleLiquidityLabels(row));
  Object.assign(row, getEntryWindow(row.category));

  var eligible = candidateTelegramEligible(row);
  var risk = (normalizeTelegramRiskLabel(row.risk_label_v2) || deriveTelegramRiskLabel(row, row.category === 'Day Trade' ? 'daytrade' : 'swing')).replace(' Risk', '');
  var support = toNum(row.support);
  var resistance = toNum(row.resistance);
  var trigger = resistance ? ('close > ' + fmtPrice(resistance) + ' dengan volume valid') : 'konfirmasi breakout/pullback dengan volume valid';
  var invalidasi = support ? ('breakdown ' + fmtPrice(support) + ' atau SL kena') : 'SL kena';
  var sv = idxTick.deriveSignalVerdict(row);
  Object.assign(row, sv);
  var verdict = row.signal_verdict || (eligible ? 'Watchlist — tunggu konfirmasi.' : 'Pantauan — belum layak entry agresif.');
  var trendText = String(row.trend_label || '').replace('Bullish Trend', 'Kuat').replace('Improving Trend', 'Mulai membaik').replace('Bearish Trend', 'Melemah').replace('Weak Trend', 'Lemah').replace(' Trend', '');
  var patternText = String(row.pattern_label || 'No Clear Pattern').replace('No Clear Pattern', 'Belum ada pola kuat').replace('Insufficient Data', 'Data pola terbatas').replace('VCP-like Base', 'VCP-like');
  var volumeNote = compactSafeText(row.volume_confirmation_notes || row.volume_notes, 'Volume relatif normal.').replace('Volume/value belum mengonfirmasi pergerakan harga.', 'Volume belum mengonfirmasi pergerakan harga.');
  var warning = eligible ? '' : compactSafeText(row.volume_confirmation_label === 'Volume belum konfirmasi' || row.volume_confirmation_label === 'Volume lemah' ? 'Volume belum kuat, tunggu konfirmasi.' : row.confidence_notes, 'Tunggu konfirmasi.').replace('Radar only, jangan agresif.', 'Belum layak entry agresif.').replace('Radar only — RR belum ideal.', 'RR belum ideal.');
  var lines = [
    'SIGNAL ' + safeTicker + ' — ' + compactSafeText(row.category, 'Screener'),
    'Grade ' + compactSafeText(row.confidence, 'C') + ' · Risiko ' + risk + ' · RR ' + fmtRR(row.risk_reward),
    'Likuiditas: ' + compactSafeText(row.liquidity_label, '-') + ' · Waktu Entry: ' + compactSafeText(row.entry_window_label, '-').replace('Near planned entry zone', 'dekat area entry'),
    '',
    'Harga ' + fmtPrice(row.lastn || row.last_price),
    'Entry ' + fmtPrice(row.entry1) + '/' + fmtPrice(row.entry2) + ' · SL ' + fmtPrice(row.sl) + ' · TP ' + fmtPrice(row.tp1n) + '/' + fmtPrice(row.tp2n),
    'Plan: ' + compactSafeText(row.rr_quality_label, 'RR sehat') + ' · ' + compactSafeText(row.sl_quality_label, 'SL wajar') + ' · ' + compactSafeText(row.tp_quality_label, 'TP realistis'),
    'Potensi TP1: ' + formatPct(row.tp1_upside),
    row.entry_status_label ? ('Status Entry: ' + row.entry_status_label + ' — ' + String(row.entry_status_note || '').replace(/^Harga/, 'harga')) : '',
    '',
    'Trend: ' + compactSafeText(trendText, '-'),
    'Volume: ' + fmtRatio(getTelegramVolumeRatio(row)) + ' · transaksi ' + fmtRpValue(getTelegramValue(row)),
    'Catatan volume: ' + volumeNote.charAt(0).toLowerCase() + volumeNote.slice(1),
    fs2 ? ('Foreign 7D: ' + compactSafeText(row.foreign_label, '-').replace('Accumulation', 'Akumulasi').replace('Distribution', 'Distribusi').replace('Mixed', 'Campuran').replace('Neutral', 'Netral') + ' ' + formatForeignRupiah(row.foreign_7d)) : '',
    'Pattern: ' + compactSafeText(patternText, 'Belum ada pola kuat'),
    '',
    support && resistance ? ('Support: ' + fmtPrice(support) + ' · Resistance: ' + fmtPrice(resistance)) : (support ? ('Support: ' + fmtPrice(support)) : (resistance ? ('Resistance: ' + fmtPrice(resistance)) : '')),
    'Konfirmasi: ' + trigger,
    'Batal jika: ' + invalidasi,
    '',
    'Skenario Naik: tembus resistance, peluang lanjut ke TP1/TP2',
    'Skenario Netral: tunggu pullback atau konfirmasi volume',
    'Skenario Turun: breakdown support/SL',
    '',
    'Kesimpulan: ' + verdict,
    warning ? ('Catatan: ' + warning) : '',
    'Bukan rekomendasi beli/jual. DYOR.'
  ];
  return signalCleanLines(lines);
}

async function buildTelegramTopMessage(supabase) {
  // Public Top 10 uses the shared candidateTelegramEligible() path, which includes candidatePassesPublicTelegramSafetyGate().
  var rows = (await fetchCombinedScreenerCandidates(supabase)).filter(candidateTelegramEligible).sort(function(a, b) { return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); }).slice(0, 10);
  var lines = ['Top 10 Screener — ' + getWibDateString(), ''];
  if (rows.length === 0) lines.push('Belum ada kandidat yang lolos filter potensi TP minimal.');
  for (var i = 0; i < rows.length; i++) { lines.push(await formatCandidateBlock(supabase, rows[i], i + 1, true)); lines.push(''); }
  lines.push('Bukan rekomendasi beli/jual. DYOR.');
  return lines.join('\n');
}

async function buildTelegramScreenerMessage(supabase, modeText) {
  var mode = String(modeText || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!mode) return 'Format:\n/screener day trade\n/screener swing konglo\n/screener swing non konglo';
  var category, table, orderCol, asc = false;
  if (mode === 'day trade') { category = 'Day Trade'; table = 'daytrade_screener_latest'; orderCol = 'daytrade_score'; }
  else if (mode === 'swing konglo') { category = 'Swing Konglo'; table = 'swing_screener_latest'; orderCol = 'score'; }
  else if (mode === 'swing non konglo' || mode === 'swing non-konglo') { category = 'Swing Non-Konglo'; table = 'swing_screener_non_konglo_latest'; orderCol = 'rank'; asc = true; }
  else return 'Format:\n/screener day trade\n/screener swing konglo\n/screener swing non konglo';
  var res = await supabase.from(table).select('*').order(orderCol, { ascending: asc }).limit(20);
  var rows = (res.data || []).map(function(r) { return normalizeCombinedCandidate(r, category); }).filter(function(r) { return r.ticker && candidateTelegramEligible(r); }).sort(function(a, b) { return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); }).slice(0, 10);
  var lines = ['Screener ' + category + ' — ' + getWibDateString(), ''];
  if (rows.length === 0) lines.push('Belum ada kandidat yang lolos filter potensi TP minimal.');
  for (var i = 0; i < rows.length; i++) { lines.push(await formatCandidateBlock(supabase, rows[i], i + 1, category === 'Day Trade')); lines.push(''); }
  lines.push('Bukan rekomendasi beli/jual. DYOR.');
  return lines.join('\n');
}



function escapeSvgText(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function(ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
}

function planLevelsForChart(row) {
  return [
    { key: 'Entry 1', value: toNum(row.entry1), color: '#2563eb' },
    { key: 'Entry 2', value: toNum(row.entry2), color: '#7c3aed' },
    { key: 'TP1', value: toNum(row.tp1n || row.tp1), color: '#16a34a' },
    { key: 'TP2', value: toNum(row.tp2n || row.tp2), color: '#15803d' },
    { key: 'SL', value: toNum(row.sl), color: '#dc2626' }
  ].filter(function(x) { return x.value != null && isFinite(x.value) && x.value > 0; });
}

async function fetchChartOhlcRows(supabase, pick, options) {
  options = options || {};
  var ticker = normalizeForeignTicker(pick.ticker || '');
  if (!ticker) return { rows: [], source: 'missing_ticker', skipped: true, reason: 'missing_ticker' };

  // Match the web Chart page data source (/api/candles): Yahoo Finance 1y daily OHLCV.
  try {
    var symbol = ticker + '.JK';
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1y&interval=1d';
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, Number(options.timeout_ms || options.timeoutMs || 10000));
    var response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (response.ok) {
      var json = await response.json();
      var result = json && json.chart && json.chart.result && json.chart.result[0];
      var timestamps = result && result.timestamp || [];
      var q = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
      if (q) {
        var rows = [];
        for (var i = 0; i < timestamps.length; i++) {
          var o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i], v = q.volume && q.volume[i];
          if (o != null && h != null && l != null && c != null && isFinite(o) && isFinite(h) && isFinite(l) && isFinite(c)) {
            rows.push({
              date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
              open: Math.round(o * 100) / 100,
              high: Math.round(h * 100) / 100,
              low: Math.round(l * 100) / 100,
              close: Math.round(c * 100) / 100,
              volume: v || 0
            });
          }
        }
        if (rows.length >= 20) return { rows: rows, source: 'Yahoo Finance 1y daily OHLCV (/api/candles parity)' };
        return { rows: rows, source: 'Yahoo Finance 1y daily OHLCV (/api/candles parity)', skipped: true, reason: 'insufficient_historical_ohlc_' + rows.length };
      }
    }
  } catch (e) { /* best-effort fallback below */ }

  // Secondary real-data fallback only: local foreign table when it has enough OHLC rows.
  try {
    var fw = await supabase.from('foreign_watchlist_daily').select('trade_date,ticker,open,high,low,close,volume').eq('ticker', ticker).order('trade_date', { ascending: false }).limit(80);
    var localRows = (fw.data || []).filter(function(r) { return toNum(r.open) != null && toNum(r.high) != null && toNum(r.low) != null && toNum(r.close) != null; }).map(function(r) {
      return { date: r.trade_date, open: toNum(r.open), high: toNum(r.high), low: toNum(r.low), close: toNum(r.close), volume: toNum(r.volume) || 0 };
    }).reverse();
    if (!fw.error && localRows.length >= 20) return { rows: localRows, source: 'foreign_watchlist_daily OHLCV fallback' };
    return { rows: localRows, source: 'foreign_watchlist_daily OHLCV fallback', skipped: true, reason: 'insufficient_historical_ohlc_' + localRows.length };
  } catch (err) {
    return { rows: [], source: 'none', skipped: true, reason: 'historical_ohlc_unavailable' };
  }
}

function buildTop5ChartSvg(ticker, date, ohlcRows, pick, source) {
  var rows = (ohlcRows || []).slice(-30);
  if (rows.length === 0) throw new Error('no_ohlc_rows');
  var levels = planLevelsForChart(pick);
  var prices = [];
  rows.forEach(function(r) { prices.push(r.open, r.high, r.low, r.close); });
  levels.forEach(function(l) { prices.push(l.value); });
  var minP = Math.min.apply(null, prices.filter(function(v) { return v != null && isFinite(v); }));
  var maxP = Math.max.apply(null, prices.filter(function(v) { return v != null && isFinite(v); }));
  if (!isFinite(minP) || !isFinite(maxP)) throw new Error('invalid_price_range');
  if (minP === maxP) { minP *= 0.98; maxP *= 1.02; }
  var pad = (maxP - minP) * 0.08;
  minP -= pad; maxP += pad;
  var w = 920, h = 540, left = 72, right = 126, top = 58, bottom = 74;
  var plotW = w - left - right, plotH = h - top - bottom;
  function x(i) { return left + (rows.length === 1 ? plotW / 2 : (i * plotW / (rows.length - 1))); }
  function y(v) { return top + ((maxP - v) / (maxP - minP)) * plotH; }
  var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">', '<rect width="100%" height="100%" fill="#ffffff"/>'];
  parts.push('<text x="' + left + '" y="32" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="#111827">' + escapeSvgText(ticker) + ' — Top 5 Saham Pilihan</text>');
  parts.push('<text x="' + left + '" y="52" font-family="Arial,sans-serif" font-size="12" fill="#6b7280">Tanggal: ' + escapeSvgText(date) + ' · OHLC: ' + escapeSvgText(source || 'fallback') + '</text>');
  for (var g = 0; g <= 4; g++) { var gy = top + g * plotH / 4; parts.push('<line x1="' + left + '" y1="' + gy + '" x2="' + (w - right) + '" y2="' + gy + '" stroke="#e5e7eb"/>'); }
  levels.forEach(function(l) { var ly = y(l.value); parts.push('<line x1="' + left + '" y1="' + ly + '" x2="' + (w - right) + '" y2="' + ly + '" stroke="' + l.color + '" stroke-width="1.5" stroke-dasharray="6 4"/>'); parts.push('<text x="' + (w - right + 8) + '" y="' + (ly + 4) + '" font-family="Arial,sans-serif" font-size="12" fill="' + l.color + '">' + escapeSvgText(l.key + ' ' + fmtPrice(l.value)) + '</text>'); });
  var cw = Math.max(8, Math.min(18, plotW / Math.max(rows.length, 8) * 0.55));
  rows.forEach(function(r, i) { var cx = x(i); var up = r.close >= r.open; var color = up ? '#16a34a' : '#dc2626'; parts.push('<line x1="' + cx + '" y1="' + y(r.high) + '" x2="' + cx + '" y2="' + y(r.low) + '" stroke="' + color + '" stroke-width="2"/>'); var by = Math.min(y(r.open), y(r.close)); var bh = Math.max(2, Math.abs(y(r.open) - y(r.close))); parts.push('<rect x="' + (cx - cw/2) + '" y="' + by + '" width="' + cw + '" height="' + bh + '" fill="' + (up ? '#dcfce7' : '#fee2e2') + '" stroke="' + color + '"/>'); });
  parts.push('<line x1="' + left + '" y1="' + (top + plotH) + '" x2="' + (w - right) + '" y2="' + (top + plotH) + '" stroke="#9ca3af"/>');
  parts.push('<text x="' + left + '" y="' + (h - 24) + '" font-family="Arial,sans-serif" font-size="12" fill="#6b7280">Deterministic SVG chart. Bukan rekomendasi beli/jual. DYOR.</text>');
  parts.push('</svg>');
  return parts.join('');
}


function makeCrcTable() {
  var c, table = [];
  for (var n = 0; n < 256; n++) {
    c = n;
    for (var k = 0; k < 8; k++) c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
    table[n] = c >>> 0;
  }
  return table;
}
var PNG_CRC_TABLE = makeCrcTable();
function crc32(buf) {
  var c = 0xffffffff;
  for (var i = 0; i < buf.length; i++) c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  var typeBuf = Buffer.from(type, 'ascii');
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodeRgbaPng(width, height, rgba) {
  var zlib = require('zlib');
  var raw = Buffer.alloc((width * 4 + 1) * height);
  for (var yy = 0; yy < height; yy++) { raw[yy * (width * 4 + 1)] = 0; rgba.copy(raw, yy * (width * 4 + 1) + 1, yy * width * 4, (yy + 1) * width * 4); }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
function hexToRgb(hex) { hex = String(hex || '#000000').replace('#', ''); return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]; }
function buildTop5ChartPng(ticker, date, ohlcRows, pick, source) {
  var rows = (ohlcRows || []).slice(-120);
  if (rows.length < 20) throw new Error('insufficient_historical_ohlc_' + rows.length);
  var levels = planLevelsForChart(pick), prices = [];
  rows.forEach(function(r) { prices.push(r.open, r.high, r.low, r.close); });
  levels.forEach(function(l) { prices.push(l.value); });
  var minP = Math.min.apply(null, prices.filter(function(v) { return v != null && isFinite(v); }));
  var maxP = Math.max.apply(null, prices.filter(function(v) { return v != null && isFinite(v); }));
  if (!isFinite(minP) || !isFinite(maxP)) throw new Error('invalid_price_range');
  if (minP === maxP) { minP *= 0.98; maxP *= 1.02; }
  var pad = (maxP - minP) * 0.10; minP -= pad; maxP += pad;

  var w = 1080, h = 720, left = 64, right = 96, top = 54, mainH = 410, volH = 84, rsiTop = 574, rsiH = 82;
  var plotW = w - left - right, bottomMain = top + mainH;
  var rgba = Buffer.alloc(w * h * 4);
  function setPx(px, py, color) { px = Math.round(px); py = Math.round(py); if (px < 0 || py < 0 || px >= w || py >= h) return; var idx = (py * w + px) * 4; rgba[idx] = color[0]; rgba[idx + 1] = color[1]; rgba[idx + 2] = color[2]; rgba[idx + 3] = color.length > 3 ? color[3] : 255; }
  function blendRect(x1, y1, x2, y2, color) { x1 = Math.max(0, Math.floor(x1)); x2 = Math.min(w - 1, Math.ceil(x2)); y1 = Math.max(0, Math.floor(y1)); y2 = Math.min(h - 1, Math.ceil(y2)); for (var ry = y1; ry <= y2; ry++) for (var rx = x1; rx <= x2; rx++) setPx(rx, ry, color); }
  function rect(x1, y1, x2, y2, color) { blendRect(x1, y1, x2, y2, color); }
  function line(x1, y1, x2, y2, color, width) { width = width || 1; var dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1), sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1, err = dx - dy; while (true) { rect(x1 - width / 2, y1 - width / 2, x1 + width / 2, y1 + width / 2, color); if (Math.round(x1) === Math.round(x2) && Math.round(y1) === Math.round(y2)) break; var e2 = 2 * err; if (e2 > -dy) { err -= dy; x1 += sx; } if (e2 < dx) { err += dx; y1 += sy; } } }
  function x(i) { return left + (rows.length === 1 ? plotW / 2 : (i * plotW / (rows.length - 1))); }
  function y(v) { return top + ((maxP - v) / (maxP - minP)) * mainH; }
  function ma(period) { var out = []; for (var i = period - 1; i < rows.length; i++) { var sum = 0; for (var j = i - period + 1; j <= i; j++) sum += rows[j].close; out.push({ i: i, v: sum / period }); } return out; }
  function drawMA(period, color) { var data = ma(period); for (var i = 1; i < data.length; i++) line(x(data[i - 1].i), y(data[i - 1].v), x(data[i].i), y(data[i].v), color, period >= 100 ? 2 : 1); }
  function rsiData() { var out = []; for (var i = 14; i < rows.length; i++) { var gains = 0, losses = 0; for (var k = i - 13; k <= i; k++) { var d = rows[k].close - rows[k - 1].close; if (d > 0) gains += d; else losses -= d; } var ag = gains / 14, al = losses / 14; out.push({ i: i, v: al === 0 ? 100 : 100 - 100 / (1 + ag / al) }); } return out; }
  function yr(v) { return rsiTop + ((100 - v) / 100) * rsiH; }

  rect(0, 0, w, h, hexToRgb('#0f1319'));
  rect(left, top, w - right, bottomMain, hexToRgb('#0b0e14'));
  rect(left, bottomMain + 8, w - right, bottomMain + 8 + volH, hexToRgb('#0b0e14'));
  rect(left, rsiTop, w - right, rsiTop + rsiH, hexToRgb('#0b0e14'));
  for (var g = 0; g <= 4; g++) { var gy = top + g * mainH / 4; line(left, gy, w - right, gy, hexToRgb('#1c2333'), 1); }
  for (var vg = 0; vg <= 6; vg++) { var gx = left + vg * plotW / 6; line(gx, top, gx, rsiTop + rsiH, hexToRgb('#151b29'), 1); }

  // Fibonacci-like range levels from visible high/low, styled as subtle amber dashed guides.
  [0.382, 0.5, 0.618, 0.786].forEach(function(f) { var fy = y(maxP - pad - ((maxP - minP - pad * 2) * f)); for (var xx = left; xx < w - right; xx += 14) line(xx, fy, Math.min(xx + 7, w - right), fy, hexToRgb('#a16207'), 1); });
  levels.forEach(function(l) { var ly = y(l.value); for (var xx = left; xx < w - right; xx += 16) line(xx, ly, Math.min(xx + 9, w - right), ly, hexToRgb(l.color), 2); });

  if (rows.length >= 20) drawMA(20, hexToRgb('#10b981'));
  if (rows.length >= 50) drawMA(50, hexToRgb('#eab308'));
  if (rows.length >= 100) drawMA(100, hexToRgb('#3b82f6'));
  if (rows.length >= 200) drawMA(200, hexToRgb('#a855f7'));

  var maxVol = Math.max.apply(null, rows.map(function(r) { return r.volume || 0; }).concat([1]));
  var cw = Math.max(3, Math.min(10, plotW / Math.max(rows.length, 40) * 0.62));
  rows.forEach(function(r, i) {
    var cx = x(i), up = r.close >= r.open, color = hexToRgb(up ? '#10b981' : '#ef4444'), fill = hexToRgb(up ? '#10b981' : '#ef4444');
    var vh = Math.max(1, ((r.volume || 0) / maxVol) * volH);
    rect(cx - cw / 2, bottomMain + 8 + volH - vh, cx + cw / 2, bottomMain + 8 + volH, hexToRgb(up ? '#064e3b' : '#7f1d1d'));
    line(cx, y(r.high), cx, y(r.low), color, 1);
    var by = Math.min(y(r.open), y(r.close)), bh = Math.max(2, Math.abs(y(r.open) - y(r.close)));
    rect(cx - cw / 2, by, cx + cw / 2, by + bh, fill);
  });

  var rsi = rsiData();
  line(left, yr(70), w - right, yr(70), hexToRgb('#7f1d1d'), 1); line(left, yr(30), w - right, yr(30), hexToRgb('#064e3b'), 1);
  for (var ri = 1; ri < rsi.length; ri++) line(x(rsi[ri - 1].i), yr(rsi[ri - 1].v), x(rsi[ri].i), yr(rsi[ri].v), hexToRgb('#f97316'), 2);
  line(left, bottomMain, w - right, bottomMain, hexToRgb('#1c2333'), 1); line(w - right, top, w - right, rsiTop + rsiH, hexToRgb('#1c2333'), 1);
  var last = rows[rows.length - 1];
  if (last && isFinite(last.close)) { var ly2 = y(last.close); rect(w - right + 4, ly2 - 8, w - 18, ly2 + 8, hexToRgb(last.close >= last.open ? '#047857' : '#b91c1c')); line(w - right - 8, ly2, w - right + 4, ly2, hexToRgb(last.close >= last.open ? '#10b981' : '#ef4444'), 2); }
  return encodeRgbaPng(w, h, rgba);
}


function getRequestBaseUrl(req) {
  var proto = req.headers['x-forwarded-proto'] || 'https';
  var host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
}

function makeTop5ChartToken(ticker, ttlSeconds) {
  var secret = process.env.TOP5_CHART_TOKEN_SECRET || process.env.CRON_SECRET || '';
  if (!secret) return null;
  var exp = Math.floor(Date.now() / 1000) + (ttlSeconds || 900);
  var payload = normalizeForeignTicker(ticker) + ':' + exp;
  var sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

function verifyTop5ChartToken(ticker, token) {
  var secret = process.env.TOP5_CHART_TOKEN_SECRET || process.env.CRON_SECRET || '';
  if (!secret || !token || String(token).indexOf('.') === -1) return false;
  var parts = String(token).split('.');
  var payload;
  try { payload = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch (e) { return false; }
  var expectedPayload = normalizeForeignTicker(ticker) + ':';
  if (payload.indexOf(expectedPayload) !== 0) return false;
  var exp = Number(payload.slice(expectedPayload.length));
  if (!isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  var expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  try { return crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected)); } catch (e2) { return false; }
}

async function handleTelegramTop5ChartImage(req, res, supabase) {
  var ticker = normalizeForeignTicker(req.query.ticker || '');
  if (!ticker || !verifyTop5ChartToken(ticker, req.query.token)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
  try {
    var ohlc = await fetchChartOhlcRows(supabase, { ticker: ticker }, { timeout_ms: 2500 });
    if (!ohlc.rows || ohlc.rows.length < 20 || ohlc.skipped) return res.status(422).json({ success: false, skipped: true, reason: ohlc.reason || 'insufficient_historical_ohlc', source: ohlc.source });
    var png = buildTop5ChartPng(ticker, getJakartaDateString(), ohlc.rows, { ticker: ticker }, ohlc.source);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).send(png);
  } catch (e) {
    return res.status(504).json({ success: false, skipped: true, reason: e && e.name === 'AbortError' ? 'yahoo_timeout_2500ms' : (e.message || 'chart_error') });
  }
}

async function sendTop5ChartAttachments(req, picks) {
  var sent = 0, detailSent = 0, errors = [], skipped = 0;
  var started = Date.now();
  var baseUrl = getRequestBaseUrl(req);
  for (var i = 0; i < picks.length; i++) {
    var ticker = picks[i].ticker;
    if (Date.now() - started > 8500) {
      skipped += (picks.length - i);
      errors.push({ ticker: ticker, reason: 'timeout_guard_text_fallback' });
      for (var j = i; j < picks.length; j++) if (picks[j]._detail_text) { var guardDetail = await telegramNotifier.sendTelegramMessage(picks[j]._detail_text, { timeout_ms: 2500 }); if (guardDetail.sent) detailSent++; }
      break;
    }
    try {
      var token = makeTop5ChartToken(ticker, 900);
      if (!token) throw new Error('missing_chart_token_secret');
      var photoUrl = baseUrl + '/api/sector-hot?action=telegram-top5-chart-image&ticker=' + encodeURIComponent(ticker) + '&token=' + encodeURIComponent(token);
      var captionParts = buildTop5PhotoCaption(picks[i]._detail_text || ((i + 1) + '. ' + ticker + ' — ' + picks[i].category));
      var result = await telegramNotifier.sendTelegramPhotoUrl(photoUrl, captionParts.caption, { timeout_ms: 3500 });
      if (result.sent) sent++;
      else {
        skipped++;
        errors.push({ ticker: ticker, reason: result.reason || 'send_failed', telegram: result });
        if (picks[i]._detail_text) { var failedDetail = await telegramNotifier.sendTelegramMessage(picks[i]._detail_text, { timeout_ms: 2500 }); if (failedDetail.sent) detailSent++; }
      }
    } catch (e) {
      skipped++;
      errors.push({ ticker: ticker, reason: e.message || String(e) });
      if (picks[i]._detail_text) { var fallbackDetail = await telegramNotifier.sendTelegramMessage(picks[i]._detail_text, { timeout_ms: 2500 }); if (fallbackDetail.sent) detailSent++; }
    }
  }
  return { sent_count: sent, detail_sent_count: detailSent, skipped_count: skipped, errors: errors, method: sent > 0 ? 'sendPhoto chart-url per ticker' : 'text fallback no-chart due timeout guard' };
}

async function selectDailyTop5(supabase) {
  var rows = await fetchCombinedScreenerCandidates(supabase);
  for (var i = 0; i < rows.length; i++) {
    var f = await fetchForeignSummary(supabase, rows[i].ticker);
    rows[i].daily_score = (rows[i].combined_score || 0) + (f.score || 0)
      + (rows[i].entry1 && rows[i].lastn && Math.abs((rows[i].lastn - rows[i].entry1) / rows[i].entry1) <= 0.03 ? 8 : -4)
      + (rows[i].tp1_upside >= 2 ? 10 : -8)
      + (rows[i].tp2_upside >= 5 ? 8 : 0)
      + ((toNum(rows[i].risk_reward) || 0) >= 1.8 ? 6 : 0);
    var gate = applyFinalTopQualityGate(rows[i], 'daily_top5');
    rows[i].daily_score += gate.quality_score_adjustment || 0;
  }
  return rows.filter(candidateTelegramEligible).sort(function(a, b) { return (b.daily_score || 0) - (a.daily_score || 0) || rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); }).slice(0, 5);
}

function getTelegramConfigStatus() {
  return {
    enabled: process.env.TELEGRAM_ENABLED === '1',
    has_bot_token: !!(process.env.TELEGRAM_BOT_TOKEN && String(process.env.TELEGRAM_BOT_TOKEN).trim()),
    has_chat_id: !!(process.env.TELEGRAM_CHAT_ID && String(process.env.TELEGRAM_CHAT_ID).trim())
  };
}

function pickWasSentToTelegram(row) {
  var raw = (row && row.raw_payload) || {};
  return !!(raw.telegram_daily_sent_at || raw.telegram_sent_at || raw.sent_to_telegram_at);
}

function markRawPayloadTelegramSent(raw, sentAt) {
  var next = Object.assign({}, raw || {});
  next.telegram_daily_sent_at = sentAt;
  next.telegram_daily_send_source = 'telegram-daily-picks';
  return next;
}

function candidateDiagnostic(candidate) {
  return {
    ticker: candidate.ticker,
    category: candidate.category,
    daily_score: candidate.daily_score || null,
    tp1_upside: candidate.tp1_upside != null ? candidate.tp1_upside : null,
    risk_reward: candidate.risk_reward != null ? candidate.risk_reward : null,
    reason: candidateReason(candidate)
  };
}

function rowToDailyPickCandidate(row) {
  var raw = Object.assign({}, row.raw_payload || {});
  raw.ticker = row.ticker || raw.ticker;
  raw.category = row.category || raw.category;
  raw.entry1 = row.entry1 != null ? row.entry1 : raw.entry1;
  raw.entry2 = row.entry2 != null ? row.entry2 : raw.entry2;
  raw.tp1n = row.tp1 != null ? row.tp1 : (raw.tp1n != null ? raw.tp1n : raw.tp1);
  raw.tp2n = row.tp2 != null ? row.tp2 : (raw.tp2n != null ? raw.tp2n : raw.tp2);
  raw.sl = row.sl != null ? row.sl : raw.sl;
  raw._daily_pick_row_id = row.id;
  return raw;
}

async function sendDailyTop5Telegram(supabase, picks, date, options) {
  options = options || {};
  var headerLines = ['🚀 AUTO-CUAN SAHAM PILIHAN — TOP 5', 'Tanggal: ' + date];
  if (options.previous_close_snapshot) headerLines.push('Snapshot: Market close H-1, revalidasi harga saat market buka.');
  headerLines.push('Bukan rekomendasi beli/jual. DYOR.');
  var header = headerLines.join('\n');
  var emptyLines = ['🚀 AUTO-CUAN SAHAM PILIHAN — TOP 5', 'Tanggal: ' + date];
  if (options.previous_close_snapshot) emptyLines.push('Snapshot: Market close H-1, revalidasi harga saat market buka.');
  emptyLines.push('', 'Belum ada kandidat yang lolos final quality gate hari ini.', 'Bukan rekomendasi beli/jual. DYOR.');
  var safePicks = (picks || []).filter(function(p) { return candidatePassesPublicTelegramSafetyGate(p, 'daily_top5_send') && candidatePassesMinUpside(p); });
  var sendResult = safePicks.length > 0 ? await telegramNotifier.sendTelegramMessage(header) : { sent: false, skipped: true, reason: 'no_final_quality_gate_candidates_silent', message: null };
  var detailSent = 0;
  var detailResults = [];
  for (var i = 0; i < safePicks.length; i++) {
    var detailText = await formatCandidateBlock(supabase, safePicks[i], i + 1, false);
    var detailResult = await telegramNotifier.sendTelegramMessage(detailText, { timeout_ms: 2500 });
    detailResults.push({ ticker: safePicks[i].ticker, sent: !!detailResult.sent, skipped: !!detailResult.skipped, reason: detailResult.reason || null, status: detailResult.status || null });
    if (detailResult.sent) detailSent++;
  }
  return { header: sendResult, detail_sent_count: detailSent, detail_results: detailResults, sent_count: (sendResult.sent ? 1 : 0) + detailSent, public_picks: safePicks, public_filtered_count: (picks || []).length - safePicks.length };
}

async function handleTelegramDailyPicks(req, res, supabase) {
  if (!verifyCronSecret(req)) return res.status(401).json({ success: false, sent: false, skipped: false, reason: 'unauthorized', sent_count: 0, picked_count: 0, candidate_count: 0, inserted_count: 0, error: 'Unauthorized.' });
  try {
    var dryRun = req.query && (req.query.dry_run === '1' || req.query.dryRun === '1');
    var force = req.query && req.query.force === '1';
    var date = getJakartaDateString();
    var jakartaWeekday = isJakartaWeekday();
    var weekendBypassed = false;
    var diagnosticsBase = {
      build_marker: 'top5-daily-diagnostics-v1',
      date: date,
      weekday: jakartaWeekday,
      weekend_guard: { allowed: jakartaWeekday, bypassed: false },
      forced: force,
      dry_run: dryRun,
      telegram_config: getTelegramConfigStatus()
    };
    if (!jakartaWeekday) {
      if (!force) return res.status(200).json(Object.assign({ success: true, sent: false, skipped: true, reason: 'weekend', sent_count: 0, picked_count: 0, candidate_count: 0, inserted_count: 0 }, diagnosticsBase));
      weekendBypassed = true;
      diagnosticsBase.weekend_guard.bypassed = true;
    }

    var readiness = await getScreenerReadiness(supabase, { allow_previous_close_snapshot: true });
    var existingRes = await supabase.from('telegram_daily_picks').select('*').eq('date', date).order('id', { ascending: true }).limit(5);
    if (existingRes.error) throw new Error(existingRes.error.message);
    var existingRows = existingRes.data || [];
    var alreadySent = existingRows.length > 0 && existingRows.every(pickWasSentToTelegram);

    if (!force && !readiness.ready && existingRows.length === 0) {
      return res.status(200).json(Object.assign({ success: true, sent: false, skipped: true, reason: 'screeners_not_ready', readiness: readiness, sent_count: 0, picked_count: 0, candidate_count: 0, inserted_count: 0, telegram: null }, diagnosticsBase));
    }

    var picks = [];
    var source = 'selected_candidates';
    var insertedCount = 0;
    if (existingRows.length > 0) {
      source = 'locked_rows';
      picks = existingRows.map(rowToDailyPickCandidate);
    } else {
      picks = await selectDailyTop5(supabase);
    }

    picks = (picks || []).filter(function(p) { return candidatePassesPublicTelegramSafetyGate(p, 'daily_top5') && candidatePassesMinUpside(p); });

    if (dryRun) {
      return res.status(200).json(Object.assign({
        success: true,
        sent: false,
        skipped: true,
        reason: 'dry_run',
        source: source,
        readiness: readiness,
        candidate_count: picks.length,
        picked_count: picks.length,
        inserted_count: 0,
        selected_tickers: picks.map(function(p) { return p.ticker; }),
        candidates: picks.map(candidateDiagnostic),
        existing_locked_count: existingRows.length,
        already_sent: alreadySent,
        telegram: null
      }, diagnosticsBase));
    }

    if (alreadySent && !force) {
      return res.status(200).json(Object.assign({ success: true, sent: false, skipped: true, reason: 'already_sent', source: source, readiness: readiness, sent_count: 0, picked_count: existingRows.length, candidate_count: existingRows.length, inserted_count: 0, existing_locked_count: existingRows.length, telegram: null }, diagnosticsBase));
    }

    var notifier = await sendDailyTop5Telegram(supabase, picks, date, { previous_close_snapshot: readiness.snapshot_mode === 'previous_close_snapshot' });
    var telegramSent = notifier.sent_count > 0;
    var nowIso = new Date().toISOString();
    if (telegramSent) {
      if (existingRows.length > 0) {
        var publicPickIds = {};
        (notifier.public_picks || picks).forEach(function(p) { if (p && p._daily_pick_row_id) publicPickIds[p._daily_pick_row_id] = true; });
        for (var u = 0; u < existingRows.length; u++) {
          var rawPayload = markRawPayloadTelegramSent(existingRows[u].raw_payload, nowIso);
          if (!publicPickIds[existingRows[u].id]) rawPayload.public_filtered_from_send = true;
          await supabase.from('telegram_daily_picks').update({ first_sent_at: existingRows[u].first_sent_at || nowIso, raw_payload: rawPayload }).eq('id', existingRows[u].id);
        }
      } else if (picks.length > 0) {
        var rows = picks.map(function(r) {
          var row = dailyPickInsertRowFromCandidate(r, date, nowIso);
          row.raw_payload = markRawPayloadTelegramSent(row.raw_payload, nowIso);
          return row;
        });
        var ins = await supabase.from('telegram_daily_picks').insert(rows);
        if (ins.error) throw new Error('Simpan daily picks gagal: ' + ins.error.message);
        insertedCount = rows.length;
      }
    }

    var reason = telegramSent ? null : ((notifier.header && notifier.header.reason) || (picks.length ? 'telegram_send_failed' : 'no_candidates'));
    return res.status(200).json(Object.assign({
      success: telegramSent,
      sent: telegramSent,
      skipped: !telegramSent,
      reason: reason,
      source: source,
      readiness: readiness,
      sent_count: notifier.sent_count,
      picked_count: picks.length,
      candidate_count: picks.length,
      inserted_count: insertedCount,
      existing_locked_count: existingRows.length,
      selected_tickers: picks.map(function(p) { return p.ticker; }),
      notifier: notifier,
      telegram: notifier.header || null,
      error: telegramSent ? null : reason
    }, diagnosticsBase));
  } catch (e) {
    return res.status(200).json({ success: false, build_marker: 'top5-daily-diagnostics-v1', sent: false, skipped: false, reason: 'exception', date: getJakartaDateString(), weekday: isJakartaWeekday(), sent_count: 0, picked_count: 0, candidate_count: 0, inserted_count: 0, telegram_config: getTelegramConfigStatus(), error: e.message || String(e) });
  }
}

async function fetchLatestPriceForMonitor(supabase, ticker) {
  var dt = await supabase.from('daytrade_screener_latest').select('last_price,open_price,high_price,low_price,calculated_at').eq('ticker', ticker).maybeSingle();
  if (dt.data && dt.data.last_price != null) return { last: toNum(dt.data.last_price), open: toNum(dt.data.open_price), high: toNum(dt.data.high_price), low: toNum(dt.data.low_price), at: dt.data.calculated_at, bestEffort: false };
  var f = await supabase.from('foreign_watchlist_daily').select('close,trade_date').eq('ticker', ticker).order('trade_date', { ascending: false }).limit(1);
  if (f.data && f.data[0]) return { last: toNum(f.data[0].close), open: null, high: toNum(f.data[0].close), low: toNum(f.data[0].close), at: f.data[0].trade_date, bestEffort: true };
  return { last: null, open: null, high: null, low: null, at: null, bestEffort: true };
}

function isJakartaAtOrAfter(hour, minute) {
  var now = getJakartaNow();
  var h = now.getUTCHours();
  var m = now.getUTCMinutes();
  return h > hour || (h === hour && m >= minute);
}

function evaluateMonitorStatus(pick, px) {
  var status = String(pick.status || 'WAITING').toUpperCase();
  var finalBefore = pick.is_final || ['TP1_HIT','TP2_HIT','SL_HIT'].indexOf(status) >= 0;
  var raw = pick.raw_payload || {};
  var fresh = idxTick.deriveSetupFreshness(Object.assign({}, raw, {
    first_sent_at: pick.first_sent_at,
    last_checked_at: pick.last_checked_at,
    created_at: pick.created_at,
    entry1: pick.entry1,
    entry2: pick.entry2,
    sl: pick.sl,
    current_price: px && px.last
  }));
  if (!px || px.last == null) return { status: 'NEEDS_REVALIDATION', label: 'Needs Revalidation', isFinal: finalBefore, note: 'Data harga terbaru belum tersedia' };

  var last = toNum(px.last);
  var high = px.high != null ? toNum(px.high) : last;
  var low = px.low != null ? toNum(px.low) : last;
  var entry1 = toNum(pick.entry1);
  var entry2 = toNum(pick.entry2);
  var tp1 = toNum(pick.tp1);
  var tp2 = toNum(pick.tp2);
  var sl = toNum(pick.sl);
  var entryTouched = entry1 != null && high != null && low != null && low <= entry1 && high >= entry1;
  var active = status === 'RUNNING' || status === 'ACTIVE' || status.indexOf('TP') >= 0 || entryTouched || pick.hit_entry_at;

  if (sl != null && low != null && low <= sl) return { status: active ? 'SL_HIT' : 'INVALID', label: active ? 'SL kena' : 'Invalid', isFinal: true, note: active ? 'SL tersentuh' : 'Harga menyentuh invalidation sebelum entry' };
  if (active && tp2 != null && high != null && high >= tp2) return { status: 'TP2_HIT', label: 'TP2 Hit', isFinal: true, note: pick.hit_tp2_at ? 'TP2 sudah tercatat sebelumnya' : 'TP2 tersentuh' };
  if (active && tp1 != null && high != null && high >= tp1) return { status: 'TP1_HIT', label: 'TP1 Hit', isFinal: false, note: pick.hit_tp1_at ? 'TP1 sudah tercatat sebelumnya' : 'TP1 tersentuh' };
  if (fresh.setup_freshness_status === 'EXPIRED') return { status: 'EXPIRED', label: 'Expired', isFinal: false, note: fresh.setup_expiry_note };
  if (fresh.setup_freshness_status === 'NEEDS_REVALIDATION') return { status: 'NEEDS_REVALIDATION', label: 'Needs Revalidation', isFinal: false, note: fresh.setup_expiry_note };
  if (entryTouched) return { status: 'RUNNING', label: 'Running', isFinal: false, note: 'Entry sudah tersentuh; monitor TP/SL' };
  if (entry1 != null && entry2 != null && last <= entry1 && last >= entry2) return { status: 'IN_ENTRY_ZONE', label: 'In Entry Zone', isFinal: false, note: 'Harga berada di area Entry 1–Entry 2' };
  if (entry2 != null && sl != null && last < entry2 && last > sl) return { status: 'WATCHLIST', label: 'Watchlist', isFinal: false, note: 'Harga di bawah Entry 2 namun masih di atas SL' };
  if (entry1 != null && last > entry1) return { status: active ? 'RUNNING' : 'ENTRY_MISSED', label: active ? 'Running' : 'Entry Missed', isFinal: false, note: active ? 'Menuju TP1' : 'Harga di atas Entry 1 tanpa touch area; wait pullback' };
  if (entry1 != null && last < entry1) return { status: 'ENTRY_READY', label: 'Entry Ready', isFinal: false, note: 'Mendekati area entry; tunggu harga masuk zone' };
  return { status: 'WATCHLIST', label: 'Watchlist', isFinal: false, note: 'Belum masuk area entry' };
}

function webPickScore(raw) {
  return toNum(raw.combined_score || raw.telegram_conviction_score || raw.daytrade_score || raw.score || raw.daily_score) || null;
}

function buildDashboardPickRow(row, rank, px) {
  var raw = row.raw_payload || {};
  var current = px && px.last != null ? px.last : (toNum(raw.lastn || raw.last_price || raw.current_price) || null);
  var rr = toNum(raw.risk_reward || raw.rr) || null;
  attachEntryStatus(Object.assign(raw, { current_price: current, last_price: current }));
  var gate = deriveFinalTopQualityGate(raw, 'dashboard');
  if (!gate.pass) {
    raw.signal_action = 'AVOID';
    raw.signal_action_label = 'Hindari';
    raw.action_label = 'Hindari';
    raw.signal_verdict = gate.excluded_reason;
    raw.telegram_verdict = gate.excluded_reason;
  }
  var reason = !gate.pass ? gate.excluded_reason : (raw.top5_reason || raw.alasan_top5 || raw.telegram_pick_reason || raw.pick_reason || raw.reason || raw.grade_reason || raw.status_reason || raw.notes || raw.verdict || raw.telegram_verdict || null);
  var out = {
    id: row.id || null,
    rank: rank,
    date: row.date || getJakartaDateString(),
    ticker: row.ticker || raw.ticker,
    category: row.category || raw.category || raw.source || '-',
    source: row.category || raw.category || raw.source || '-',
    current_price: current,
    score: webPickScore(raw),
    grade: raw.confidence || raw.grade || raw.quality_grade || null,
    confidence: raw.confidence || raw.grade || raw.quality_grade || null,
    risk: raw.risk_label_v2 || raw.risk_label || raw.risk || null,
    risk_label_v2: raw.risk_label_v2 || null,
    risk_score_v2: raw.risk_score_v2 || null,
    risk_notes_v2: raw.risk_notes_v2 || null,
    risk_factors_v2: raw.risk_factors_v2 || null,
    rr: rr,
    risk_reward: rr,
    action: raw.action || raw.verdict || raw.telegram_verdict || raw.status || null,
    verdict: raw.signal_verdict || raw.verdict || raw.telegram_verdict || raw.action || null,
    signal_action: raw.signal_action || null,
    signal_action_label: raw.action_label || raw.signal_action_label || null,
    signal_verdict: raw.signal_verdict || null,
    signal_reason: raw.action_reason || raw.signal_reason || null,
    signal_priority: raw.action_priority || raw.signal_priority || null,
    signal_badges: raw.signal_badges || [],
    action_label: raw.action_label || raw.signal_action_label || null,
    action_reason: raw.action_reason || raw.signal_reason || null,
    action_priority: raw.action_priority || raw.signal_priority || null,
    plan_label: raw.plan_label || null,
    plan_reason: raw.plan_reason || raw.plan_quality_note || null,
    plan_priority: raw.plan_priority || null,
    entry1: toNum(row.entry1 != null ? row.entry1 : (raw.entry1 != null ? raw.entry1 : raw.entry_low)),
    entry2: toNum(row.entry2 != null ? row.entry2 : (raw.entry2 != null ? raw.entry2 : raw.entry_high)),
    sl: toNum(row.sl != null ? row.sl : (raw.sl != null ? raw.sl : raw.stop_loss)),
    tp1: toNum(row.tp1 != null ? row.tp1 : (raw.tp1 != null ? raw.tp1 : raw.tp1n)),
    tp2: toNum(row.tp2 != null ? row.tp2 : (raw.tp2 != null ? raw.tp2 : raw.tp2n)),
    reason: reason,
    short_reason: reason,
    quality_chips: raw.quality_chips || gate.quality_chips || [],
    alasan_top5: raw.alasan_top5 || raw.top5_reason || reason,
    top5_reason: raw.top5_reason || raw.alasan_top5 || reason,
    entry_status: raw.entry_status,
    entry_status_label: raw.entry_status_label,
    entry_status_note: raw.entry_status_note,
    entry_distance_pct: raw.entry_distance_pct,
    chase_risk_label: raw.chase_risk_label,
    breakout_confirmation_status: raw.breakout_confirmation_status,
    breakout_confirmation_label: raw.breakout_confirmation_label,
    breakout_confirmation_note: raw.breakout_confirmation_note,
    false_breakout_risk: raw.false_breakout_risk,
    setup_age_minutes: raw.setup_age_minutes,
    setup_age_hours: raw.setup_age_hours,
    setup_freshness_status: raw.setup_freshness_status,
    setup_freshness_label: raw.setup_freshness_label,
    setup_expiry_note: raw.setup_expiry_note,
    plan_quality_status: raw.plan_quality_status,
    sl_quality_label: raw.sl_quality_label,
    tp_quality_label: raw.tp_quality_label,
    rr_quality_label: raw.rr_quality_label,
    raw_payload: raw
  };
  return attachFreshness(out, { calculated_at: (px && px.at) || row.last_checked_at || row.first_sent_at || raw.calculated_at || raw.updated_at || row.date });
}

function buildFallbackDashboardPickRow(candidate, rank) {
  var raw = Object.assign({}, candidate || {});
  if (!raw.top5_reason && !raw.alasan_top5) {
    var rr = toNum(raw.risk_reward) || 0;
    var score = webPickScore(raw) || 0;
    raw.top5_reason = 'Skor screener ' + (score ? score.toFixed(0) : '-') + (rr ? ' · RR ' + rr.toFixed(1) : '') + (raw.category ? ' · ' + raw.category : '');
  }
  return buildDashboardPickRow({ date: getJakartaDateString(), ticker: raw.ticker, category: raw.category || raw.source || '-', entry1: raw.entry1 != null ? raw.entry1 : raw.entry_low, entry2: raw.entry2 != null ? raw.entry2 : raw.entry_high, sl: raw.sl != null ? raw.sl : raw.stop_loss, tp1: raw.tp1n != null ? raw.tp1n : raw.tp1, tp2: raw.tp2n != null ? raw.tp2n : raw.tp2, raw_payload: raw }, rank, { last: toNum(raw.lastn || raw.last_price || raw.current_price) || null });
}

function getMonitorEntryBasis(row, px, ev) {
  var status = String((ev && ev.status) || row.status || '').toUpperCase();
  var last = px && px.last != null ? toNum(px.last) : null;
  var high = px && px.high != null ? toNum(px.high) : last;
  var low = px && px.low != null ? toNum(px.low) : last;
  var entry1 = toNum(row.entry1);
  var entry2 = toNum(row.entry2);
  var entry1Touched = entry1 != null && high != null && low != null && low <= entry1 && high >= entry1;
  var entry2Touched = entry2 != null && high != null && low != null && low <= entry2 && high >= entry2;
  var finalOrActive = status === 'ACTIVE' || status.indexOf('TP') >= 0 || status === 'SL_HIT' || row.hit_entry_at;
  if (!entry1Touched && finalOrActive && entry1 != null) entry1Touched = true;
  if (entry2Touched) return { price: entry2, label: 'Entry 2', entry1_touched: entry1Touched, entry2_touched: true };
  if (entry1Touched) return { price: entry1, label: 'Entry 1', entry1_touched: true, entry2_touched: false };
  return { price: null, label: null, entry1_touched: false, entry2_touched: false };
}

function getMonitorPlDisplay(row, px, ev) {
  var current = px && px.last != null ? toNum(px.last) : null;
  var entry1 = toNum(row.entry1);
  var basis = getMonitorEntryBasis(row, px, ev);
  var status = String((ev && ev.status) || row.status || '').toUpperCase();
  var statusLabel = ev && ev.label ? ev.label : null;
  var finalLabel = ['TP1_HIT','TP2_HIT','SL_HIT'].indexOf(status) >= 0 ? (statusLabel || status.replace(/_/g, ' ')) : null;
  var pct = null;
  var label = 'Belum kena entry';
  if (current != null && basis.price != null && basis.price > 0) {
    pct = ((current - basis.price) / basis.price) * 100;
    label = 'Dari ' + basis.label;
  } else if (current != null && entry1 != null && entry1 > 0) {
    pct = ((current - entry1) / entry1) * 100;
    label = 'Jarak ke Entry 1';
  }
  return {
    active_entry_price: basis.price,
    active_entry_label: basis.label,
    entry1_touched: basis.entry1_touched,
    entry2_touched: basis.entry2_touched,
    return_from_entry_pct: basis.price != null ? pct : null,
    distance_to_entry1_pct: basis.price == null ? pct : null,
    monitor_pl_label: label,
    monitor_final_label: finalLabel,
    monitor_pl_pct: pct
  };
}

function buildDashboardMonitorRow(row, rank, px, ev) {
  var raw = row.raw_payload || {};
  var current = px && px.last != null ? px.last : (toNum(raw.lastn || raw.last_price || raw.current_price) || null);
  attachEntryStatus(Object.assign(raw, { current_price: current }));
  var open = px && px.open != null ? px.open : (toNum(raw.open_price) || null);
  var changeFromOpen = open != null && current != null ? current - open : null;
  var changeFromOpenPct = open != null && open > 0 && changeFromOpen != null ? (changeFromOpen / open) * 100 : null;
  var pl = getMonitorPlDisplay(row, px, ev);
  var out = {
    id: row.id || null,
    rank: rank,
    date: row.date,
    ticker: row.ticker,
    category: row.category || raw.category || raw.source || '-',
    source: row.category || raw.category || raw.source || '-',
    open_price: open,
    current_price: current,
    last_price: current,
    change_from_open: changeFromOpen,
    change_from_open_pct: changeFromOpenPct,
    active_entry_price: pl.active_entry_price,
    active_entry_label: pl.active_entry_label,
    entry1_touched: pl.entry1_touched,
    entry2_touched: pl.entry2_touched,
    return_from_entry_pct: pl.return_from_entry_pct,
    distance_to_entry1_pct: pl.distance_to_entry1_pct,
    monitor_pl_label: pl.monitor_pl_label,
    monitor_final_label: pl.monitor_final_label,
    monitor_pl_pct: pl.monitor_pl_pct,
    entry1: toNum(row.entry1),
    entry: toNum(row.entry1),
    entry2: toNum(row.entry2),
    sl: toNum(row.sl),
    tp1: toNum(row.tp1),
    tp2: toNum(row.tp2),
    status: ev.status,
    status_label: ev.label || ev.status,
    status_note: ev.note,
    signal_action: raw.signal_action || null,
    signal_action_label: raw.action_label || raw.signal_action_label || null,
    signal_verdict: raw.signal_verdict || null,
    signal_reason: raw.action_reason || raw.signal_reason || null,
    signal_badges: raw.signal_badges || [],
    action_label: raw.action_label || raw.signal_action_label || null,
    action_reason: raw.action_reason || raw.signal_reason || null,
    action_priority: raw.action_priority || raw.signal_priority || null,
    plan_label: raw.plan_label || null,
    plan_reason: raw.plan_reason || raw.plan_quality_note || null,
    plan_priority: raw.plan_priority || null,
    entry_status: raw.entry_status,
    entry_status_label: raw.entry_status_label,
    entry_status_note: raw.entry_status_note,
    breakout_confirmation_status: raw.breakout_confirmation_status,
    breakout_confirmation_label: raw.breakout_confirmation_label,
    breakout_confirmation_note: raw.breakout_confirmation_note,
    false_breakout_risk: raw.false_breakout_risk,
    last_updated_at: (px && px.at) || row.last_checked_at || row.first_sent_at || null,
    progress: buildMonitorProgressLabel(row, px),
    raw_payload: raw,
    detail: raw
  };
  return attachFreshness(out, { calculated_at: (px && px.at) || row.last_checked_at || row.first_sent_at || row.date });
}

function dailyPickInsertRowFromCandidate(candidate, date, firstSentAt) {
  return { date: date, ticker: candidate.ticker, category: candidate.category, entry1: candidate.entry1, entry2: candidate.entry2, tp1: candidate.tp1n, tp2: candidate.tp2n, sl: candidate.sl, status: 'WAITING', first_sent_at: firstSentAt || null, raw_payload: candidate };
}

async function lockWebDailyPicksIfDue(supabase, date) {
  if (!isJakartaAtOrAfter(8, 0)) return [];
  var picks = await selectDailyTop5(supabase);
  if (!picks.length) return [];
  var nowIso = new Date().toISOString();
  var rowsToInsert = picks.slice(0, 5).map(function(r) {
    var row = dailyPickInsertRowFromCandidate(r, date, null);
    row.raw_payload = Object.assign({}, row.raw_payload || {}, { web_daily_locked_at: nowIso, telegram_daily_sent_at: null });
    return row;
  });
  var ins = await supabase.from('telegram_daily_picks').insert(rowsToInsert).select('*');
  if (ins.error) throw new Error('Simpan daily picks web fallback gagal: ' + ins.error.message);
  return (ins.data || []).sort(function(a, b) { return (a.id || 0) - (b.id || 0); });
}


function isJakartaActiveMonitorSession() {
  var now = getJakartaNow();
  var day = now.getUTCDay();
  if (day < 1 || day > 5) return false;
  var minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day >= 1 && day <= 4) {
    return (minutes >= (9 * 60 + 30) && minutes <= (12 * 60)) || (minutes >= (13 * 60 + 30) && minutes <= (16 * 60));
  }
  return (minutes >= (9 * 60 + 30) && minutes <= (11 * 60 + 30)) || (minutes >= (14 * 60) && minutes <= (16 * 60));
}

function isMonitorTimestampStale(value, sourceLabel) {
  if (!value) return true;
  if (sourceLabel === 'daily lock fallback') return true;
  var d = new Date(value);
  if (isNaN(d.getTime())) return true;
  if (!isJakartaActiveMonitorSession()) return false;
  return (Date.now() - d.getTime()) > (45 * 60 * 1000);
}


function isDashboardScreenerLoggedIn(req) {
  var rawUserId = String(req.headers['x-user-id'] || '').trim();
  var rawUsername = String(req.headers['x-username'] || '').trim().toLowerCase();
  return !!((rawUserId || rawUsername) && rawUsername !== 'guest');
}


function parseAdminAllowlist(value) {
  return String(value || '').split(',').map(function(v) { return v.trim().toLowerCase(); }).filter(Boolean);
}

function isLikelyUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function isLegacyBudiReadAllowed(req) {
  var rawUsername = String(req.headers['x-username'] || '').trim();
  if (rawUsername !== 'budi') return false;
  var adminUsernames = parseAdminAllowlist(process.env.ADMIN_USERNAMES);
  return adminUsernames.indexOf('budi') >= 0 || process.env.ADMIN_LEGACY_BUDI_PREVIEW === 'true';
}


var TOP5_INTERNAL_RESPONSE_FIELDS = [
  'raw_payload', 'detail', 'sample_rejected', 'top_rejection_reasons', 'stageByTicker',
  'debug_notes', 'internal_notes', 'internal_diagnostics', 'preview_diagnostics',
  'admin_notes', 'admin_note', 'excluded_reason_admin', 'excluded_preview'
];
var TOP5_ADMIN_PREVIEW_FIELDS = [
  'admin_next_top5_preview', 'admin_next_top5_excluded_preview', 'admin_next_top5_potential_radar_preview', 'admin_next_top5_preview_count',
  'admin_next_top5_excluded_count', 'admin_next_top5_potential_radar_count', 'admin_next_top5_preview_note', 'admin_next_top5_preview_generated_at'
];
function isTop5PreviewOrProvisionalRow(row) {
  if (!row) return false;
  var source = String(row.top5_source || row.source_type || row.visibility || row.publication_status || row.status_label || '').toLowerCase();
  return row.web_provisional === true || row.is_provisional === true || row.provisional === true ||
    row.preview === true || row.is_preview === true || row.admin_only === true ||
    source.indexOf('provisional') >= 0 || source.indexOf('preview') >= 0 || source.indexOf('admin') >= 0;
}
function sanitizeTop5RowForPublic(row, opts) {
  if (!row || typeof row !== 'object') return row;
  var allowPreview = !!(opts && opts.allowPreview);
  var clean = Object.assign({}, row);
  for (var i = 0; i < TOP5_INTERNAL_RESPONSE_FIELDS.length; i++) delete clean[TOP5_INTERNAL_RESPONSE_FIELDS[i]];
  for (var j = 0; j < TOP5_ADMIN_PREVIEW_FIELDS.length; j++) delete clean[TOP5_ADMIN_PREVIEW_FIELDS[j]];
  if (!allowPreview) {
    delete clean.web_provisional; delete clean.is_provisional; delete clean.provisional;
    delete clean.preview; delete clean.is_preview; delete clean.admin_only;
  } else if (isTop5PreviewOrProvisionalRow(row)) {
    clean.visibility = clean.visibility || 'admin_preview';
    clean.publication_status = clean.publication_status || 'provisional';
    clean.preview_label = clean.preview_label || 'Preview';
    clean.provisional_label = clean.provisional_label || 'Provisional';
  }
  return clean;
}
function sanitizeTop5RowsForAudience(rows, opts) {
  if (!Array.isArray(rows)) return [];
  var allowPreview = !!(opts && opts.allowPreview);
  return rows.filter(function(row) { return allowPreview || !isTop5PreviewOrProvisionalRow(row); })
    .map(function(row) { return sanitizeTop5RowForPublic(row, { allowPreview: allowPreview }); });
}
function sanitizeTop5ResponseForAudience(payload, opts) {
  var allowAdminPreview = !!(opts && opts.allowAdminPreview);
  var clean = Object.assign({}, payload || {});
  ['top5','picks','monitor','rows','history','active_history','tp_history'].forEach(function(k) {
    if (Array.isArray(clean[k])) clean[k] = sanitizeTop5RowsForAudience(clean[k], { allowPreview: allowAdminPreview });
  });
  if (!allowAdminPreview) {
    TOP5_ADMIN_PREVIEW_FIELDS.forEach(function(k) { delete clean[k]; });
    if (!clean.top5_locked) {
      clean.top5_source = 'awaiting_locked_rows';
      clean.web_provisional = false;
      clean.update_note = clean.update_note || 'Belum ada Top 5 final yang terkunci. Cek lagi setelah data final tersedia.';
    }
  } else {
    if (Array.isArray(clean.admin_next_top5_preview)) clean.admin_next_top5_preview = sanitizeTop5RowsForAudience(clean.admin_next_top5_preview, { allowPreview: true });
    if (Array.isArray(clean.admin_next_top5_excluded_preview)) clean.admin_next_top5_excluded_preview = sanitizeTop5RowsForAudience(clean.admin_next_top5_excluded_preview, { allowPreview: true });
    if (Array.isArray(clean.admin_next_top5_potential_radar_preview)) clean.admin_next_top5_potential_radar_preview = sanitizeTop5RowsForAudience(clean.admin_next_top5_potential_radar_preview, { allowPreview: true });
  }
  return clean;
}

async function lookupDashboardAdminAppUser(req, supabase) {
  var rawUserId = String(req.headers['x-user-id'] || '').trim();
  var rawUsername = String(req.headers['x-username'] || '').trim().toLowerCase();
  if (!isLikelyUuid(rawUserId) || rawUsername === 'guest') return null;

  var r = await supabase
    .from('app_users')
    .select('*')
    .eq('id', rawUserId)
    .maybeSingle();
  if (r.error || !r.data) return null;

  var dbUsername = String(r.data.username || '').trim().toLowerCase();
  if (rawUsername && rawUsername !== dbUsername) return null;
  return r.data;
}

async function isDashboardAdminUser(req, supabase) {
  try {
    if (!isDashboardScreenerLoggedIn(req)) return false;

    var rawUsername = String(req.headers['x-username'] || '').trim().toLowerCase();
    if (!rawUsername || rawUsername === 'guest') return false;

    var userData = await lookupDashboardAdminAppUser(req, supabase);
    if (userData) {
      if (userData.is_blocked || userData.is_approved === false) return false;
      if (userData.is_admin === true) return true;
      var role = String(userData.role || userData.user_role || '').trim().toLowerCase();
      if (role === 'admin' || role === 'owner' || role === 'superadmin') return true;

      var username = String(userData.username || '').trim().toLowerCase();
      var userId = String(userData.id || '').trim().toLowerCase();
      var adminUsernames = parseAdminAllowlist(process.env.ADMIN_USERNAMES);
      var adminUserIds = parseAdminAllowlist(process.env.ADMIN_USER_IDS);
      if (username && adminUsernames.indexOf(username) >= 0) return true;
      if (userId && adminUserIds.indexOf(userId) >= 0) return true;
      return false;
    }

    if (rawUsername !== 'budi') return false;
    var legacyAdminUsernames = parseAdminAllowlist(process.env.ADMIN_USERNAMES);
    return legacyAdminUsernames.indexOf('budi') >= 0 || process.env.ADMIN_LEGACY_BUDI_PREVIEW === 'true';
  } catch (e) {
    return false;
  }
}

function sendDashboardScreenerGate(res, extra) {
  return res.status(200).json(Object.assign({
    success: true,
    auth_required: true,
    gated: true,
    message: 'Login diperlukan untuk melihat Top 5 screener dan Auto Monitor.',
    top5: [],
    picks: [],
    monitor: [],
    rows: [],
    history: [],
    active_history: [],
    tp_history: [],
    count: 0,
    tp_count: 0
  }, extra || {}));
}

async function handleWebDailyPicks(req, res, supabase) {
  if (!isDashboardScreenerLoggedIn(req)) {
    return sendDashboardScreenerGate(res, { date: getJakartaDateString(), top5_source: 'awaiting_locked_rows', top5_locked: false, telegram_scheduled_only: true, telegram_note: 'Telegram tetap dikirim hanya sesuai jadwal otomatis melalui flow telegram-daily-picks.', web_provisional: false, update_note: 'Belum ada Top 5 final yang terkunci. Cek lagi setelah data final tersedia.', last_updated_at: null, monitor_last_updated_at: null });
  }
  try {
    var date = getJakartaDateString();
    var q = await supabase.from('telegram_daily_picks').select('*').eq('date', date).order('id', { ascending: true }).limit(5);
    if (q.error) throw new Error(q.error.message);
    var rows = q.data || [];
    var locked = rows.length > 0;
    var allowProvisional = (req.query.admin_preview === '1' || req.query.provisional === '1') && await isDashboardAdminUser(req, supabase);
    var top5Source = locked ? 'locked_rows' : (allowProvisional ? 'provisional_candidates' : 'awaiting_locked_rows');
    var webProvisional = !locked && allowProvisional;
    var top5 = [];
    var monitor = [];
    var lastAt = null;
    var monitorSourceLabel = null;
    var latestPriceAt = null;
    var latestMonitorRunAt = null;
    var dailyLockFallbackAt = null;
    if (locked) {
      for (var i = 0; i < rows.length; i++) {
        var p = rows[i];
        var px = await fetchLatestPriceForMonitor(supabase, p.ticker);
        var ev = evaluateMonitorStatus(p, px);
        if (px && px.at && (!latestPriceAt || String(px.at) > String(latestPriceAt))) latestPriceAt = px.at;
        if (p.last_checked_at && (!latestMonitorRunAt || String(p.last_checked_at) > String(latestMonitorRunAt))) latestMonitorRunAt = p.last_checked_at;
        if (p.first_sent_at && (!dailyLockFallbackAt || String(p.first_sent_at) > String(dailyLockFallbackAt))) dailyLockFallbackAt = p.first_sent_at;
        top5.push(buildDashboardPickRow(p, i + 1, px));
        monitor.push(buildDashboardMonitorRow(p, i + 1, px, ev));
      }
    } else if (allowProvisional) {
      var fallback = await selectDailyTop5(supabase);
      for (var j = 0; j < fallback.length; j++) top5.push(buildFallbackDashboardPickRow(fallback[j], j + 1));
    }
    if (latestPriceAt) { lastAt = latestPriceAt; monitorSourceLabel = 'latest price'; }
    else if (latestMonitorRunAt) { lastAt = latestMonitorRunAt; monitorSourceLabel = 'monitor run'; }
    else if (dailyLockFallbackAt) { lastAt = dailyLockFallbackAt; monitorSourceLabel = 'daily lock fallback'; }
    var monitorStale = isMonitorTimestampStale(lastAt, monitorSourceLabel);
    var staleNote = monitorStale ? 'Data monitor belum update terbaru.' : null;
    var adminPreviewExtra = {};
    if (req.query.admin_preview === '1' && await isDashboardAdminUser(req, supabase)) {
      var previewCandidates = await selectDailyTop5(supabase);
      var previewRows = [];
      for (var k = 0; k < previewCandidates.length; k++) { var pr = buildFallbackDashboardPickRow(previewCandidates[k], k + 1); pr.is_preview = true; pr.is_provisional = true; pr.visibility = 'admin_preview'; pr.publication_status = 'provisional'; pr.preview_label = 'Preview'; pr.provisional_label = 'Provisional'; previewRows.push(pr); }
      var allPreviewCandidates = await fetchCombinedScreenerCandidates(supabase, true);
      var excludedRows = [];
      var potentialRows = [];
      for (var prx = 0; prx < allPreviewCandidates.length && potentialRows.length < 5; prx++) {
        var pc = allPreviewCandidates[prx];
        var pg = deriveFinalTopQualityGate(pc, 'admin_preview_potential');
        if (!pg.pass && candidatePassesPotentialRadarGate(pc, 'admin_preview')) potentialRows.push({ ticker: pc.ticker, category: pc.category, grade: pc.confidence || pc.grade || pc.quality_grade || null, risk: pc.risk_label_v2 || pc.risk_label || pc.verified_risk_label || null, rr: pc.risk_reward || null, action: 'Potential Radar / Watchlist', radar_reason: getPotentialRadarReason(pc) });
      }
      for (var ex = 0; ex < allPreviewCandidates.length && excludedRows.length < 5; ex++) {
        var eg = deriveFinalTopQualityGate(allPreviewCandidates[ex], 'admin_preview_excluded');
        if (!eg.pass) excludedRows.push({ ticker: allPreviewCandidates[ex].ticker, category: allPreviewCandidates[ex].category, grade: allPreviewCandidates[ex].confidence || allPreviewCandidates[ex].grade || allPreviewCandidates[ex].quality_grade || null, risk: allPreviewCandidates[ex].risk_label_v2 || allPreviewCandidates[ex].risk_label || allPreviewCandidates[ex].verified_risk_label || null, rr: allPreviewCandidates[ex].risk_reward || null, action: allPreviewCandidates[ex].action_label || allPreviewCandidates[ex].signal_action_label || allPreviewCandidates[ex].signal_action || null, excluded_reason: eg.excluded_reason });
      }
      adminPreviewExtra = {
        admin_next_top5_preview: previewRows,
        admin_next_top5_preview_count: previewRows.length,
        admin_next_top5_excluded_preview: excludedRows,
        admin_next_top5_potential_radar_preview: potentialRows,
        admin_next_top5_excluded_count: excludedRows.length,
        admin_next_top5_potential_radar_count: potentialRows.length,
        admin_next_top5_preview_note: 'Preview calon Top 5 besok khusus admin; Final/Locked tetap wajib lolos final quality gate. Potential Radar/Watchlist menampung kandidat pantauan non-sinyal. Excluded by Guard ditampilkan ringkas untuk audit admin.',
        admin_next_top5_preview_generated_at: new Date().toISOString()
      };
    }
    var responsePayload = Object.assign({
      success: true,
      date: date,
      top5: top5,
      monitor: monitor,
      top5_source: top5Source,
      top5_locked: locked,
      telegram_scheduled_only: true,
      telegram_note: 'Telegram tetap dikirim hanya sesuai jadwal otomatis melalui flow telegram-daily-picks.',
      web_provisional: webProvisional,
      update_note: locked ? 'Top 5 Radar locked. Monitor update tiap 30 menit saat jam bursa.' : (allowProvisional ? 'Top 5 Radar web dapat muncul sebelum jadwal Telegram; data ini masih sementara sampai Telegram terjadwal mengunci pilihan.' : 'Top 5 belum locked. Telegram/preview admin yang akan mengunci pilihan resmi.'),
      last_updated_at: lastAt,
      monitor_last_updated_at: lastAt,
      monitor_source_label: monitorSourceLabel,
      monitor_is_stale: monitorStale,
      monitor_stale_note: staleNote,
      picks: top5
    }, adminPreviewExtra);
    return res.status(200).json(sanitizeTop5ResponseForAudience(responsePayload, { allowAdminPreview: !!adminPreviewExtra.admin_next_top5_preview }));
  } catch (e) {
    return res.status(200).json({ success: false, date: getJakartaDateString(), top5: [], monitor: [], top5_source: 'awaiting_locked_rows', top5_locked: false, telegram_scheduled_only: true, telegram_note: 'Telegram tetap dikirim hanya sesuai jadwal otomatis melalui flow telegram-daily-picks.', web_provisional: false, update_note: 'Belum ada Top 5 final yang terkunci. Cek lagi setelah data final tersedia.', last_updated_at: null, monitor_last_updated_at: null, monitor_source_label: null, monitor_is_stale: true, monitor_stale_note: 'Data monitor belum update terbaru.', picks: [], error: e.message || String(e) });
  }
}


function getHistoryEntryUsage(normalized, px) {
  var current = px && px.last != null ? toNum(px.last) : null;
  var low = px && px.low != null ? toNum(px.low) : current;
  var entry1 = toNum(normalized.entry1);
  var entry2 = toNum(normalized.entry2);
  var usedPrice = null;
  var usedLabel = null;
  if (low != null && entry2 != null && low <= entry2) {
    usedPrice = entry2;
    usedLabel = 'Entry 2';
  } else if (low != null && entry1 != null && low <= entry1) {
    usedPrice = entry1;
    usedLabel = 'Entry 1';
  }
  var returnPct = current != null && usedPrice != null && usedPrice > 0 ? ((current - usedPrice) / usedPrice) * 100 : null;
  var distancePct = current != null && usedPrice == null && entry1 != null && entry1 > 0 ? ((current - entry1) / entry1) * 100 : null;
  return {
    active_entry_price: usedPrice,
    active_entry_label: usedLabel,
    entry_used_label: usedLabel,
    entry1_touched: usedLabel === 'Entry 1' || usedLabel === 'Entry 2',
    entry2_touched: usedLabel === 'Entry 2',
    return_from_entry_pct: returnPct,
    distance_to_entry1_pct: distancePct,
    monitor_pl_label: usedLabel ? ('Dari ' + usedLabel) : 'Belum kena Entry 1'
  };
}

function classifyWebTop5History(normalized, px) {
  var current = px && px.last != null ? toNum(px.last) : null;
  var high = px && px.high != null ? toNum(px.high) : current;
  var low = px && px.low != null ? toNum(px.low) : current;
  var status = String(normalized.status || '').toUpperCase();
  var slHit = !!((normalized.sl != null && low != null && low <= normalized.sl) || status === 'SL_HIT');
  var tp2Hit = !slHit && !!((normalized.tp2 != null && high != null && high >= normalized.tp2) || status === 'TP2_HIT');
  var tp1Hit = !slHit && !tp2Hit && !!((normalized.tp1 != null && high != null && high >= normalized.tp1) || status === 'TP1_HIT');
  var hasPrice = !!(px && px.last != null);
  if (slHit) return { bucket: 'failed', status: 'SL_HIT', status_label: 'SL kena', status_note: 'SL tersentuh', tp1_hit: false, tp2_hit: false, sl_hit: true };
  if (tp2Hit) return { bucket: 'tp', status: 'TP2_HIT', status_label: 'TP2 tercapai', status_note: 'TP2 tersentuh', tp1_hit: true, tp2_hit: true, sl_hit: false };
  if (tp1Hit) return { bucket: 'tp', status: 'TP1_HIT', status_label: 'TP1 tercapai', status_note: 'TP1 tersentuh', tp1_hit: true, tp2_hit: false, sl_hit: false };
  if (!hasPrice) return { bucket: 'active', status: 'PRICE_LIMITED', status_label: 'Data harga terbatas', status_note: 'Data harga terbaru belum tersedia', tp1_hit: false, tp2_hit: false, sl_hit: false };
  return { bucket: 'active', status: 'ACTIVE_TRACKING', status_label: 'Aktif dipantau', status_note: 'Belum TP/SL', tp1_hit: false, tp2_hit: false, sl_hit: false };
}

function buildWebTop5HistoryRow(row, rank, px, ev) {
  var raw = row.raw_payload || {};
  var current = px && px.last != null ? px.last : (toNum(raw.lastn || raw.last_price || raw.current_price) || null);
  var normalized = {
    id: row.id || null,
    date: row.date || null,
    ticker: row.ticker || raw.ticker || null,
    category: row.category || raw.category || raw.source || '-',
    entry1: toNum(row.entry1 != null ? row.entry1 : (raw.entry1 != null ? raw.entry1 : raw.entry_low)),
    entry2: toNum(row.entry2 != null ? row.entry2 : (raw.entry2 != null ? raw.entry2 : raw.entry_high)),
    sl: toNum(row.sl != null ? row.sl : (raw.sl != null ? raw.sl : raw.stop_loss)),
    tp1: toNum(row.tp1 != null ? row.tp1 : (raw.tp1 != null ? raw.tp1 : raw.tp1n)),
    tp2: toNum(row.tp2 != null ? row.tp2 : (raw.tp2 != null ? raw.tp2 : raw.tp2n)),
    status: row.status || 'WAITING',
    first_sent_at: row.first_sent_at || null,
    last_checked_at: row.last_checked_at || null,
    raw_payload: raw
  };
  var effectivePx = {
    last: current,
    high: px && px.high != null ? px.high : (toNum(raw.high_price || raw.high || raw.highn) || current),
    low: px && px.low != null ? px.low : (toNum(raw.low_price || raw.low || raw.lown) || current),
    at: px && px.at ? px.at : null
  };
  var entry = getHistoryEntryUsage(normalized, effectivePx);
  var cls = ev || classifyWebTop5History(normalized, effectivePx);
  var out = {
    id: normalized.id,
    rank: rank,
    date: normalized.date,
    ticker: normalized.ticker,
    category: normalized.category,
    entry1: normalized.entry1,
    entry2: normalized.entry2,
    sl: normalized.sl,
    tp1: normalized.tp1,
    tp2: normalized.tp2,
    current_price: current,
    last_price: current,
    status: cls.status,
    status_label: cls.status_label,
    status_note: cls.status_note,
    history_bucket: cls.bucket,
    first_sent_at: normalized.first_sent_at,
    last_checked_at: row.last_checked_at || effectivePx.at || null,
    raw_payload: raw,
    signal_action_label: raw.action_label || raw.signal_action_label || null,
    signal_verdict: raw.signal_verdict || raw.verdict || raw.telegram_verdict || null,
    signal_reason: raw.action_reason || raw.signal_reason || null,
    action_label: raw.action_label || raw.signal_action_label || null,
    action_reason: raw.action_reason || raw.signal_reason || null,
    plan_label: raw.plan_label || null,
    plan_reason: raw.plan_reason || raw.plan_quality_note || null,
    risk_label_v2: raw.risk_label_v2 || null,
    plan_quality_label: raw.plan_label || raw.plan_quality_label || raw.plan_quality_status || null,
    active_entry_price: entry.active_entry_price,
    active_entry_label: entry.active_entry_label,
    entry_used_label: entry.entry_used_label,
    entry_status_label: entry.active_entry_price != null ? (entry.entry_used_label + ' tersentuh') : 'Belum kena Entry 1',
    return_from_entry_pct: entry.return_from_entry_pct,
    distance_to_entry1_pct: entry.distance_to_entry1_pct,
    tp1_hit: cls.tp1_hit,
    tp2_hit: cls.tp2_hit,
    sl_hit: cls.sl_hit,
    entry1_touched: entry.entry1_touched,
    entry2_touched: entry.entry2_touched,
    detail: raw
  };
  return attachFreshness(out, { calculated_at: effectivePx.at || normalized.last_checked_at || normalized.first_sent_at || normalized.date });
}

async function handleWebTop5History(req, res, supabase) {
  if (!isDashboardScreenerLoggedIn(req)) {
    return sendDashboardScreenerGate(res, { limit: 0, show_archived: false, data_source: 'redacted_guest_dashboard' });
  }
  try {
    var limit = parseInt(req.query.limit || '100', 10);
    if (!isFinite(limit) || limit <= 0) limit = 100;
    if (limit > 300) limit = 300;
    var showArchived = String(req.query.show_archived || '') === '1';
    var q = await supabase.from('telegram_daily_picks').select('*').order('date', { ascending: false }).order('id', { ascending: false }).limit(300);
    if (q.error) throw new Error(q.error.message);
    var rows = (q.data || []).filter(function(r) { return showArchived || !((r.raw_payload || {}).history_archived_at); });
    var activeRows = [];
    var tpRows = [];
    for (var i = 0; i < rows.length; i++) {
      var px = await fetchLatestPriceForMonitor(supabase, rows[i].ticker);
      var row = buildWebTop5HistoryRow(rows[i], 0, px, null);
      if (row.history_bucket === 'tp') tpRows.push(row);
      else if (row.history_bucket === 'active') activeRows.push(row);
    }
    var seenTickers = {};
    var activeHistory = [];
    for (var a = 0; a < activeRows.length; a++) {
      var tickerKey = String(activeRows[a].ticker || '').trim().toUpperCase();
      if (!tickerKey) tickerKey = 'row-' + String(activeRows[a].id || '');
      if (seenTickers[tickerKey]) continue;
      seenTickers[tickerKey] = true;
      activeRows[a].rank = activeHistory.length + 1;
      activeHistory.push(activeRows[a]);
      if (activeHistory.length >= limit) break;
    }
    tpRows = tpRows.slice(0, 10).map(function(r, idx) { r.rank = idx + 1; return r; });
    return res.status(200).json(sanitizeTop5ResponseForAudience({ success: true, rows: activeHistory, history: activeHistory, active_history: activeHistory, tp_history: tpRows, count: activeHistory.length, tp_count: tpRows.length, limit: limit, show_archived: showArchived, dedupe: 'active_ticker_latest_date_id_after_status_filter', data_source: 'telegram_daily_picks.locked_rows' }, { allowAdminPreview: false }));
  } catch (e) {
    return res.status(200).json({ success: false, rows: [], history: [], count: 0, error: e.message || String(e) });
  }
}

async function handleWebTop5HistoryArchive(req, res, supabase) {
  var CRON_SECRET = process.env.CRON_SECRET;
  var authHeader = req.headers.authorization || '';
  var providedSecret = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!CRON_SECRET || providedSecret !== CRON_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized.' });
  var id = parseInt((req.body && req.body.id) || req.query.id || '', 10);
  if (!isFinite(id) || id <= 0) return res.status(200).json({ success: false, error: 'id wajib diisi.' });
  var existing = await supabase.from('telegram_daily_picks').select('id,raw_payload').eq('id', id).maybeSingle();
  if (existing.error) return res.status(200).json({ success: false, error: existing.error.message });
  if (!existing.data) return res.status(404).json({ success: false, error: 'Row tidak ditemukan.' });
  var archivedAt = new Date().toISOString();
  var raw = Object.assign({}, existing.data.raw_payload || {}, { history_archived_at: archivedAt, history_archived_by: 'web-admin' });
  var upd = await supabase.from('telegram_daily_picks').update({ raw_payload: raw }).eq('id', id);
  if (upd.error) return res.status(200).json({ success: false, error: upd.error.message });
  return res.status(200).json({ success: true, id: id, archived_at: archivedAt });
}

function buildMonitorProgressLabel(pick, px) {
  if (!px || px.last == null) return '-';
  var last = toNum(px.last);
  var entry = toNum(pick.entry1);
  var tp1 = toNum(pick.tp1);
  var sl = toNum(pick.sl);
  if (!(last > 0) || !(entry > 0)) return '-';
  if (tp1 > entry && last >= entry) return Math.max(0, Math.min(100, ((last - entry) / (tp1 - entry)) * 100)).toFixed(0) + '% ke TP1';
  if (entry > sl && last < entry) return Math.max(0, Math.min(100, ((entry - last) / (entry - sl)) * 100)).toFixed(0) + '% ke SL';
  return 'Menunggu entry';
}

async function handleTelegramMonitorPicks(req, res, supabase) {
  if (!verifyCronSecret(req)) return res.status(401).json({ success: false, sent_count: 0, checked_count: 0, error: 'Unauthorized.' });
  try {
    var force = req.query && req.query.force === '1';
    var weekendBypassed = false;
    if (!isJakartaWeekday()) {
      if (!force) return res.status(200).json({ success: true, skipped: true, forced: false, weekend_bypassed: false, reason: 'weekend', sent_count: 0, checked_count: 0 });
      weekendBypassed = true;
    }
    var date = getJakartaDateString();
    var hour = getWibHourString();
    var isFinal = hour.indexOf('15:') === 0 || req.query.final === '1';
    var q = await supabase.from('telegram_daily_picks').select('*').eq('date', date).order('id', { ascending: true });
    if (q.error) throw new Error(q.error.message);
    var rows = q.data || [];
    if (rows.length === 0) return res.status(200).json({ success: true, skipped: true, forced: force, weekend_bypassed: weekendBypassed, reason: 'daily_picks_not_found', sent_count: 0, checked_count: 0, error: null });
    var lines = [(isFinal ? '🏁' : '⏱') + ' AUTO-CUAN MONITOR ' + hour, ''];
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var pck = rows[i];
      if (!isFinal && pck.is_final) continue;
      var px = await fetchLatestPriceForMonitor(supabase, pck.ticker);
      var ev = evaluateMonitorStatus(pck, px);
      var update = { status: ev.status, is_final: ev.isFinal || isFinal, last_checked_at: new Date().toISOString() };
      if ((ev.status === 'RUNNING' || ev.status === 'IN_ENTRY_ZONE') && !pck.hit_entry_at) update.hit_entry_at = update.last_checked_at;
      if (ev.status === 'TP1_HIT' && !pck.hit_tp1_at) update.hit_tp1_at = update.last_checked_at;
      if (ev.status === 'TP2_HIT' && !pck.hit_tp2_at) update.hit_tp2_at = update.last_checked_at;
      if (ev.status === 'SL_HIT' && !pck.hit_sl_at) update.hit_sl_at = update.last_checked_at;
      await supabase.from('telegram_daily_picks').update(update).eq('id', pck.id);
      lines.push(pck.ticker + ' — ' + ev.status.replace(/_/g, ' '));
      lines.push(ev.note + (px.bestEffort ? ' (best effort)' : ''));
      lines.push('Entry 1: ' + fmtPrice(pck.entry1) + ' · Last: ' + fmtPrice(px.last));
      lines.push('TP1/TP2: ' + fmtPrice(pck.tp1) + ' / ' + fmtPrice(pck.tp2) + ' · SL: ' + fmtPrice(pck.sl));
      if (ev.isFinal && !isFinal) lines.push('Status: selesai, tidak akan dimonitor di update berikutnya.');
      lines.push('');
      shown++;
    }
    if (shown === 0) lines.push('Tidak ada ticker aktif yang perlu dimonitor (sudah final).');
    lines.push('Bukan rekomendasi beli/jual. DYOR.');
    var sendResult = await telegramNotifier.sendTelegramMessage(lines.join('\n'));
    return res.status(200).json({ success: true, skipped: false, forced: force, weekend_bypassed: weekendBypassed, sent_count: sendResult.sent ? 1 : 0, checked_count: rows.length, shown_count: shown, error: null, telegram: sendResult });
  } catch (e) { return res.status(200).json({ success: false, sent_count: 0, checked_count: 0, error: e.message || String(e) }); }
}


function buildTelegramStartMessage() {
  return [
    '🚀 Selamat datang di Auto-Cuan Bot',
    '',
    'Gunakan menu "/" untuk memilih fitur bot.',
    '',
    'Command yang tersedia:',
    '',
    '/top',
    'Top 10 gabungan screener: Day Trade + Swing Konglo + Swing Non-Konglo.',
    '',
    '/screener day trade',
    '/screener swing konglo',
    '/screener swing non konglo',
    'Screener saham per kategori (maks. 10 kandidat).',
    '',
    '/foreign BBCA',
    'Melihat foreign flow saham tertentu.',
    '',
    '/signal BBRI',
    'Melihat signal ringkas dari screener/foreign internal.',
    '',
    'Auto-Cuan Top 5 Saham Pilihan dikirim otomatis Senin-Jumat setelah semua data screener siap.',
    'Top 5 Saham Pilihan = pilihan otomatis yang lebih ketat dan dipantau intraday setelah terkirim.',
    '',
    'Butuh panduan? Ketik /help',
    '',
    'Disclaimer: Bukan rekomendasi beli/jual. DYOR.'
  ].join('\n');
}

function buildTelegramHelpMessage() {
  return [
    '📘 Panduan Auto-Cuan Bot',
    '',
    '/top',
    'Menampilkan Top 10 gabungan screener dari Day Trade + Swing Konglo + Swing Non-Konglo. Ini ranking umum dan tidak dimonitor otomatis.',
    '',
    '/screener day trade',
    'Menampilkan kandidat Day Trade (maks. 10).',
    '',
    '/screener swing konglo',
    'Menampilkan kandidat Swing Konglo (maks. 10).',
    '',
    '/screener swing non konglo',
    'Menampilkan kandidat Swing Non-Konglo (maks. 10).',
    '',
    '/foreign BBCA',
    'Menampilkan foreign flow saham tertentu.',
    '',
    '/signal BBRI',
    'Menampilkan signal ringkas dari screener/foreign internal.',
    '',
    'Otomatis:',
    '- Top 5 Saham Pilihan dikirim Senin-Jumat setelah Day Trade, Swing Konglo, dan Swing Non-Konglo siap untuk tanggal trading yang sama.',
    '- Top 5 Saham Pilihan = pilihan otomatis yang lebih ketat dan dipantau intraday.',
    '- Monitoring baru mulai setelah Top 5 terkirim.',
    '- Jadwal monitor: 10:00, 11:00, 14:00, dan 15:00 WIB.',
    '',
    'Catatan:',
    '- Data foreign muncul setelah CSV berhasil di-upload.',
    '- Missing foreign data tidak menggagalkan screener.',
    '- Bukan rekomendasi beli/jual. DYOR.'
  ].join('\n');
}

async function handleTelegramWebhook(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  var secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    var got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== secret) return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  var body = req.body || {};
  var msg = body.message || body.edited_message || {};
  var text = String(msg.text || '').trim();
  var chatId = msg.chat && msg.chat.id != null ? String(msg.chat.id) : '';

  var topMatch = text.match(/^\/top(?:@\w+)?(?:\s+.*)?$/i);
  var screenerMatch = text.match(/^\/screener(?:@\w+)?(?:\s+(.+))?$/i);
  var startMatch = text.match(/^\/start(?:@\w+)?(?:\s+.*)?$/i);
  var helpMatch = text.match(/^\/help(?:@\w+)?(?:\s+.*)?$/i);
  var foreignMatch = text.match(/^\/foreign(?:@\w+)?(?:\s+(.+))?$/i);
  var signalMatch = text.match(/^\/signal(?:@\w+)?(?:\s+(.+))?$/i);

  if (!startMatch && !helpMatch && !foreignMatch && !signalMatch && !topMatch && !screenerMatch) return res.status(200).json({ success: true, ignored: true });

  var reply = '';
  if (startMatch) {
    reply = buildTelegramStartMessage();
  } else if (helpMatch) {
    reply = buildTelegramHelpMessage();
  } else if (topMatch) {
    reply = await buildTelegramTopMessage(supabase);
  } else if (screenerMatch) {
    reply = await buildTelegramScreenerMessage(supabase, screenerMatch[1] || '');
  } else if (signalMatch) {
    var signalTicker = normalizeForeignTicker(signalMatch[1] || '');
    reply = 'Format:\n/signal TICKER\nContoh: /signal BBRI';
    if (signalTicker) {
      try {
        reply = await buildSignalMessage(supabase, signalTicker);
      } catch (err) {
        reply = 'Gagal ambil signal untuk ' + signalTicker + '.';
      }
    }
  } else {
    var ticker = normalizeForeignTicker(foreignMatch[1] || '');
    reply = 'Format: /foreign TICKER\nContoh: /foreign BBCA';
    if (ticker) {
      try {
        reply = await buildForeignLookupMessage(supabase, ticker);
      } catch (err) {
        reply = 'Gagal ambil data foreign untuk ' + ticker + '.';
      }
    }
  }

  var sendResult = chatId ? await telegramNotifier.sendTelegramMessage(reply, { chat_id: chatId }) : { skipped: true, reason: 'missing_chat_id' };
  return res.status(200).json({ success: true, handled: true, sent: !!sendResult.sent, skipped: !!sendResult.skipped, reason: sendResult.reason || null });
}

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
  if (!secret) return false;
  var querySecret = req && req.query ? String(req.query.secret || '').trim() : '';
  if (querySecret && querySecret === secret) return true;
  if (!token) return false;
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
  const forceRun = req.query.force === '1';

  // If no meta or different date or status is idle/published → start fresh.
  // completed_no_candidates is also terminal, but same-day rerun should be explicit via force=1.
  if (!meta || meta.run_date !== runDate || meta.status === 'published' || meta.status === 'idle' || (meta.status === 'completed_no_candidates' && forceRun)) {
    return await handleNkScreenerStart(req, res, supabase);
  }

  // force=1 with scanning status: start a CLEAN fresh run
  // This safely clears stale jobs/staging from a crashed previous run.
  // handleNkScreenerStart already deletes old jobs + staging for today's runDate.
  // Latest published rows (swing_screener_non_konglo_latest) are NOT wiped here —
  // they are only replaced during finalize after new results are ready.
  if (forceRun && meta.status === 'scanning') {
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

  // If already finalizing or failed:
  // With force=1: start fresh (don't re-finalize stale staging)
  // Without force: attempt finalize from existing staging
  if (meta.status === 'finalizing' || meta.status === 'failed') {
    if (forceRun) {
      return await handleNkScreenerStart(req, res, supabase);
    }
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

      // Respect zone level refinement for Non-Konglo
      // Only refine levels; do NOT add unknown columns to scored object (staging schema is fixed)
      if (scored.entry_low && scored.stop_loss && scored.tp1 && quoteData.candles && quoteData.candles.length >= 10) {
        var nkBaseLvl = { entry_low: scored.entry_low, entry_high: scored.entry_high, stop_loss: scored.stop_loss, tp1: scored.tp1, tp2: scored.tp2, risk_reward: scored.risk_reward };
        var nkRefined = dtEngine.refineLevelsWithRespectZones(nkBaseLvl, quoteData.candles, quoteData.lastPrice || scored.last_price, 'nonkonglo');
        if (nkRefined && nkRefined.risk_reward >= 1.5) {
          scored.entry_low = nkRefined.entry_low;
          scored.entry_high = nkRefined.entry_high;
          scored.stop_loss = nkRefined.stop_loss;
          scored.tp1 = nkRefined.tp1;
          scored.tp2 = nkRefined.tp2;
          scored.risk_reward = nkRefined.risk_reward;
        }
        // Do NOT add refinement_notes/respect_zone_notes to scored — staging table does not have those columns
      }

      // === V6: IDX TICK NORMALIZATION (Non-Konglo — after respect zone refinement) ===
      if (scored.entry_low && scored.stop_loss && scored.tp1) {
        var _nkTickResult = idxTick.normalizeLevelsToIdxTicks(
          { entry_low: scored.entry_low, entry_high: scored.entry_high, stop_loss: scored.stop_loss, tp1: scored.tp1, tp2: scored.tp2, risk_reward: scored.risk_reward, support: scored.support, resistance: scored.resistance },
          { mode: 'swing' }
        );
        if (_nkTickResult.tick_normalized) {
          scored.entry_low = _nkTickResult.entry_low;
          scored.entry_high = _nkTickResult.entry_high;
          scored.stop_loss = _nkTickResult.stop_loss;
          scored.tp1 = _nkTickResult.tp1;
          scored.tp2 = _nkTickResult.tp2;
          scored.risk_reward = _nkTickResult.risk_reward;
          scored.support = _nkTickResult.support;
          scored.resistance = _nkTickResult.resistance;
        }
      }

      // === V6: MULTI-TIMEFRAME CONTEXT (Non-Konglo — persist to staging) ===
      if (quoteData.candles && quoteData.candles.length >= 5) {
        var _nkMtf = idxTick.deriveMultiTimeframeContext(quoteData.candles);
        scored.tf_1d_context = _nkMtf.tf_1d_context;
        scored.tf_2d_context = _nkMtf.tf_2d_context;
        scored.tf_3d_context = _nkMtf.tf_3d_context;
        scored.tf_5d_context = _nkMtf.tf_5d_context;
        scored.tf_10d_context = _nkMtf.tf_10d_context;
        scored.tf_20d_context = _nkMtf.tf_20d_context;
        scored.multi_timeframe_bias = _nkMtf.multi_timeframe_bias;
        scored.multi_timeframe_notes = _nkMtf.multi_timeframe_notes;
        // Volume phase
        var _nkLc = quoteData.candles[quoteData.candles.length - 1];
        var _nkLcR = _nkLc.high - _nkLc.low;
        var _nkVpa = idxTick.analyzeVolumePriceAction({
          volume_today: _nkLc.volume || 0,
          avg_volume_20d: quoteData.avgVol20 || 1,
          change_pct: scored.change_pct || 0,
          close_position: _nkLcR > 0 ? (_nkLc.close - _nkLc.low) / _nkLcR : 0.5,
          body_ratio: _nkLcR > 0 ? Math.abs(_nkLc.close - _nkLc.open) / _nkLcR : 0.5,
          is_green: _nkLc.close > _nkLc.open
        });
        scored.volume_phase = _nkVpa.volume_phase;
        // Risk label + quality grade
        var _nkRisk = idxTick.calculateRiskLabel({ risk_reward: scored.risk_reward, mode: 'swing', weekly_bias: _nkMtf._weekly ? _nkMtf._weekly.bias : null, monthly_bias: _nkMtf._monthly ? _nkMtf._monthly.bias : null, volume_phase: _nkVpa.volume_phase, volume_ratio_20d: scored.volume_ratio_avg20, rsi14: scored.rsi14, multi_timeframe_bias: _nkMtf.multi_timeframe_bias });
        scored.risk_label = _nkRisk.risk_label;
        var _nkGrade = idxTick.calculateQualityGrade({ risk_reward: scored.risk_reward, risk_label: _nkRisk.risk_label, volume_phase: _nkVpa.volume_phase, multi_timeframe_bias: _nkMtf.multi_timeframe_bias, tick_normalized: true, mode: 'swing', volume_ratio_20d: scored.volume_ratio_avg20 });
        scored.quality_grade = _nkGrade.grade;
      }

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


function buildNkNoCandidateDiagnostics(rows, totalScanned) {
  rows = Array.isArray(rows) ? rows : [];
  var reasons = {};
  var samples = [];
  if (rows.length === 0) {
    reasons.no_staging_rows = 1;
  }
  function addReason(ticker, reason) {
    reason = reason || 'final_quality_gate';
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (samples.length < 10) samples.push({ ticker: ticker || '-', reason: reason });
  }
  var afterMin = [];
  var afterRisk = [];
  var afterLiquidity = [];
  var afterFinal = [];
  rows.forEach(function(row) {
    var c = normalizeCombinedCandidate(row, 'Swing Non-Konglo');
    if (!candidatePassesMinUpside(c)) { addReason(row.ticker, 'min_tp1_upside'); return; }
    afterMin.push(row);
    var risk = String(row.risk_label || row.risk_label_v2 || row.verified_risk_label || '').toLowerCase();
    if (risk.indexOf('very high') >= 0) { addReason(row.ticker, 'very_high_risk'); return; }
    afterRisk.push(row);
    var liq = toNum(row.avg_transaction_value_20d || row.avg_tx_value_7d || row.tx_value_1d) || 0;
    if (liq > 0 && liq < 1000000000) { addReason(row.ticker, 'liquidity_gate'); return; }
    afterLiquidity.push(row);
    var verified = verifyTelegramSignal(row, 'swing');
    var high = verified ? verifyHighConvictionTelegramSignal(verified, 'swing') : null;
    if (!high) { addReason(row.ticker, 'final_quality_gate'); return; }
    afterFinal.push(row);
  });
  var topReasons = Object.keys(reasons).map(function(k) { return { reason: k, count: reasons[k] }; }).sort(function(a, b) { return b.count - a.count || a.reason.localeCompare(b.reason); });
  return {
    total_scanned: totalScanned || 0,
    raw_candidates_count: rows.length,
    after_min_tp1_upside_count: afterMin.length,
    after_risk_gate_count: afterRisk.length,
    after_liquidity_gate_count: afterLiquidity.length,
    after_final_quality_gate_count: afterFinal.length,
    top_rejection_reasons: topReasons,
    sample_rejected: samples
  };
}

// --- FINALIZE: publish Top 30 ---
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

  const { data: finalizeMeta } = await supabase
    .from('swing_screener_non_konglo_meta')
    .select('universe_count, scanned_count, failed_count')
    .eq('id', 'latest')
    .maybeSingle();
  var nkTotalScanned = finalizeMeta && finalizeMeta.scanned_count != null ? finalizeMeta.scanned_count : 0;

  await updateNkMeta(supabase, { status: 'finalizing', message: 'Publishing top 30...' });

  // Get top 30 from staging by score desc
  const { data: topCandidates, error: stagErr } = await supabase
    .from('swing_screener_non_konglo_staging')
    .select('*')
    .eq('run_date', runDate)
    .order('score', { ascending: false })
    .limit(30);

  if (stagErr) {
    await updateNkMeta(supabase, { status: 'failed', message: 'Gagal membaca staging: ' + stagErr.message });
    return res.status(200).json({ success: false, error: 'Failed to read staging.', staging_error: stagErr.message });
  }

  // Count total staging rows for diagnostics
  var { count: totalStagingCount } = await supabase
    .from('swing_screener_non_konglo_staging')
    .select('*', { count: 'exact', head: true })
    .eq('run_date', runDate);

  // If no candidates passed filters, classify as a successful no-candidate run, not a system error.
  if (!topCandidates || topCandidates.length === 0) {
    var { data: diagnosticRows, error: diagErr } = await supabase
      .from('swing_screener_non_konglo_staging')
      .select('*')
      .eq('run_date', runDate)
      .order('score', { ascending: false })
      .limit(200);
    if (diagErr) {
      await updateNkMeta(supabase, { status: 'failed', message: 'Gagal membaca staging diagnostics: ' + diagErr.message });
      return res.status(200).json({ success: false, error: 'Failed to read staging diagnostics.', staging_error: diagErr.message });
    }
    var emptyDiagnostics = buildNkNoCandidateDiagnostics(diagnosticRows || [], nkTotalScanned);
    await updateNkMeta(supabase, {
      status: 'completed_no_candidates',
      published_count: 0,
      message: 'Belum ada kandidat yang lolos filter potensi TP minimal.',
      calculated_at: new Date().toISOString()
    });
    return res.status(200).json({
      success: true,
      step: 'finalize',
      status: 'COMPLETED_NO_CANDIDATES',
      message: 'Belum ada kandidat yang lolos filter potensi TP minimal.',
      published: 0,
      staging_count: totalStagingCount || 0,
      run_date: runDate,
      diagnostics: emptyDiagnostics,
      telegram: { sent: false, skipped: true, reason: 'no_min_tp1_upside_candidates', message: 'Belum ada kandidat yang lolos filter potensi TP minimal.' }
    });
  }

  // Clear latest table and insert top 30
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
      run_date: runDate,
      // V6: Persisted context fields from staging
      tf_1d_context: c.tf_1d_context || null,
      tf_2d_context: c.tf_2d_context || null,
      tf_3d_context: c.tf_3d_context || null,
      tf_5d_context: c.tf_5d_context || null,
      tf_10d_context: c.tf_10d_context || null,
      tf_20d_context: c.tf_20d_context || null,
      multi_timeframe_bias: c.multi_timeframe_bias || null,
      multi_timeframe_notes: c.multi_timeframe_notes || null,
      volume_phase: c.volume_phase || null,
      risk_label: c.risk_label || null,
      quality_grade: c.quality_grade || null
    }));

    var { error: insErr } = await supabase.from('swing_screener_non_konglo_latest').insert(publishRows);
    if (insErr) {
      // Insert failed — meta stays as "finalizing", NOT "published"
      // User can retry and finalize will re-attempt from staging
      await updateNkMeta(supabase, { status: 'failed', message: 'Gagal publish Top 30: ' + insErr.message });
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

  var nkTelegram = publishedCount > 0 ? await sendSwingNkTelegramNotification(supabase, publishedCount) : { skipped: true, reason: 'no_published_rows' };
  var nkDiagnostics = buildNkNoCandidateDiagnostics(topCandidates || [], nkTotalScanned);
  return res.status(200).json({
    success: true,
    step: 'finalize',
    status: publishedCount > 0 ? 'PUBLISHED' : 'COMPLETED_NO_CANDIDATES',
    message: publishedCount > 0 ? ('Published ' + publishedCount + ' top candidates.') : 'Belum ada kandidat yang lolos filter potensi TP minimal.',
    published: publishedCount,
    staging_count: totalStagingCount || 0,
    run_date: runDate,
    top_ticker: publishedCount > 0 ? topCandidates[0].ticker : null,
    top_score: publishedCount > 0 ? topCandidates[0].score : null,
    diagnostics: nkDiagnostics,
    telegram: nkTelegram
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

  var legacyBudiReadAllowed = isLegacyBudiReadAllowed(req);
  var userData = null;

  if (!legacyBudiReadAllowed) {
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

  // Derive swing labels and re-sort by tier priority
  var nkSorted = (rows || []).map(function(r) {
    var labels = deriveSwingLabels(r, 'nonkonglo');
    r.swing_tier = labels.swing_tier;
    r.entry_timing = labels.entry_timing;
    r.tradeability = labels.tradeability;
    r.direction = labels.direction;
    return attachFreshness(enrichSignalQuality(r, 'Swing Non-Konglo'), meta);
  });

  var swingTierPriority = { 'A_PLUS_SWING': 0, 'TRADE_CANDIDATE': 1, 'SWING_READY': 2, 'WATCHLIST': 3, 'REBOUND_CANDIDATE': 3, 'WAIT_PULLBACK': 5, 'SPECULATIVE': 6, 'INVALID': 7, 'AVOID': 8 };
  nkSorted.sort(function(a, b) {
    var pa = swingTierPriority[a.swing_tier] != null ? swingTierPriority[a.swing_tier] : 9;
    var pb = swingTierPriority[b.swing_tier] != null ? swingTierPriority[b.swing_tier] : 9;
    if (pa !== pb) return pa - pb;
    // Within same tier group: sort by composite quality
    var ta = a.tradeability === 'High' ? 0 : (a.tradeability === 'Medium' ? 1 : 2);
    var tb = b.tradeability === 'High' ? 0 : (b.tradeability === 'Medium' ? 1 : 2);
    if (ta !== tb) return ta - tb;
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    if ((b.risk_reward || 0) !== (a.risk_reward || 0)) return (b.risk_reward || 0) - (a.risk_reward || 0);
    // Entry closeness: prefer lower entry_distance (price closer to entry)
    var aEntry = a.entry_high > 0 && a.last_price > 0 ? ((a.last_price - a.entry_high) / a.entry_high) * 100 : 99;
    var bEntry = b.entry_high > 0 && b.last_price > 0 ? ((b.last_price - b.entry_high) / b.entry_high) * 100 : 99;
    return aEntry - bEntry;
  });

  // Re-assign rank based on new sort order
  nkSorted.forEach(function(r, idx) { r.rank = idx + 1; });

  nkSorted = await enrichNonKongloHalfCandleDebt(nkSorted);
  nkSorted = await enrichConfluenceRows(supabase, nkSorted, true);

  return res.status(200).json({
    success: true,
    meta: meta || { calculated_at: null, status: 'idle', message: 'Awaiting first calculation.', universe_count: 0, scanned_count: 0, failed_count: 0, published_count: 0 },
    results: nkSorted
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

    // === NK ATR14 CALCULATION (V1 Level Quality Upgrade) ===
    var nkAtr14 = null;
    if (validDays.length >= 15) {
      var nkTrSum = 0;
      var nkTrCount = 0;
      for (var nkAi = lastIdx - 13; nkAi <= lastIdx; nkAi++) {
        if (nkAi < 1) continue;
        var nkTrHigh = validDays[nkAi].high - validDays[nkAi].low;
        var nkTrHighPrev = Math.abs(validDays[nkAi].high - validDays[nkAi - 1].close);
        var nkTrLowPrev = Math.abs(validDays[nkAi].low - validDays[nkAi - 1].close);
        var nkTr = Math.max(nkTrHigh, nkTrHighPrev, nkTrLowPrev);
        nkTrSum += nkTr;
        nkTrCount++;
      }
      if (nkTrCount > 0) nkAtr14 = nkTrSum / nkTrCount;
    }
    var nkAtrProxy = nkAtr14 || (validDays[lastIdx].high - validDays[lastIdx].low) || (lastClose * 0.02);
    if (nkAtrProxy <= 0) nkAtrProxy = lastClose * 0.02;

    // === NK SWING HIGH 10D (intermediate resistance for TP) ===
    var nkSwingHigh10 = Math.max.apply(null, validDays.slice(-10).map(function(d) { return d.high; }));

    // === NK OVERHEAD GAP DETECTION (unfilled gap-down above current price) ===
    var nkOverheadGap = null;
    var nkDownsideGap = null;
    for (var nkGi = lastIdx - 1; nkGi >= Math.max(1, lastIdx - 19); nkGi--) {
      var nkPrevLow = validDays[nkGi - 1].low;
      var nkCurrHigh = validDays[nkGi].high;
      if (nkPrevLow > nkCurrHigh && nkPrevLow > lastClose && !nkOverheadGap) {
        var nkGapSize = nkPrevLow - nkCurrHigh;
        if (nkGapSize / lastClose > 0.003) {
          nkOverheadGap = { lower: Math.round(nkCurrHigh), upper: Math.round(nkPrevLow), size: Math.round(nkGapSize) };
        }
      }
      var nkCurrLow2 = validDays[nkGi].low;
      var nkPrevHigh2 = validDays[nkGi - 1].high;
      if (nkCurrLow2 > nkPrevHigh2 && nkPrevHigh2 < lastClose && !nkDownsideGap) {
        var nkDGapSize = nkCurrLow2 - nkPrevHigh2;
        if (nkDGapSize / lastClose > 0.003) {
          nkDownsideGap = { lower: Math.round(nkPrevHigh2), upper: Math.round(nkCurrLow2), size: Math.round(nkDGapSize) };
        }
      }
    }

    // === NK TP: Best probable swing target (V1.1 — not merely nearest resistance) ===
    var nkRange = resistance - support;
    var nkAtrForTP = nkAtr14 || (nkRange * 0.15);
    var nkRiskForTP = ((entryLow + entryHigh) / 2) - (stopLoss || entryLow * 0.96);
    if (nkRiskForTP <= 0) nkRiskForTP = nkAtrForTP;

    // TP1 base: Fibonacci 0.618 (existing good logic for NK)
    var tp1 = Math.round(support + nkRange * 0.618);
    var nkTp1Source = 'fib_618';

    // Check if swingHigh10 gives better RR than Fib (and is meaningful)
    var nkSwH10RR = nkRiskForTP > 0 ? (nkSwingHigh10 - ((entryLow + entryHigh) / 2)) / nkRiskForTP : 0;
    var nkFibRR = nkRiskForTP > 0 ? (tp1 - ((entryLow + entryHigh) / 2)) / nkRiskForTP : 0;

    // Use swingHigh10 ONLY if it gives RR >= 1.5 AND is not too close (skip if too short)
    if (nkSwingHigh10 > entryHigh && nkSwH10RR >= 1.5 && nkSwingHigh10 < resistance * 0.97) {
      // Only replace Fib if swing high is ABOVE Fib level (better target)
      if (nkSwingHigh10 > tp1) {
        tp1 = Math.round(nkSwingHigh10);
        nkTp1Source = 'swing_high_10d';
      }
      // If swing high is below Fib and gives poor RR, keep Fib
    }

    // Overhead gap as TP1 candidate if closer than current TP1 but still gives RR >= 1.5
    if (nkOverheadGap && nkOverheadGap.lower > entryHigh && nkOverheadGap.lower < tp1) {
      var nkGapRR = nkRiskForTP > 0 ? (nkOverheadGap.lower - ((entryLow + entryHigh) / 2)) / nkRiskForTP : 0;
      if (nkGapRR >= 1.5) {
        tp1 = nkOverheadGap.lower;
        nkTp1Source = 'gap_lower';
      }
    }

    // If TP1 RR < 1.5, try to use resistance instead
    var nkTp1FinalRR = nkRiskForTP > 0 ? (tp1 - ((entryLow + entryHigh) / 2)) / nkRiskForTP : 0;
    if (nkTp1FinalRR < 1.5 && resistance > entryHigh) {
      var resRR = nkRiskForTP > 0 ? (resistance - ((entryLow + entryHigh) / 2)) / nkRiskForTP : 0;
      if (resRR >= 1.5) {
        tp1 = Math.round(resistance);
        nkTp1Source = 'resistance_20d';
      }
    }

    // Fallback: TP1 must be > entry
    if (tp1 <= entryHigh) {
      tp1 = Math.round(((entryLow + entryHigh) / 2) + nkAtrForTP * 2.0);
      nkTp1Source = 'atr_measured';
    }

    // === NK TP2: Extended target (stricter than Konglo due to liquidity) ===
    var tp2 = Math.round(resistance);
    var nkTp2Source = 'resistance_20d';

    // If overhead gap upper is above TP1, use as TP2
    if (nkOverheadGap && nkOverheadGap.upper > tp1) {
      tp2 = Math.round(nkOverheadGap.upper);
      nkTp2Source = 'gap_upper';
    }
    // If TP2 <= TP1, extend
    if (tp2 <= tp1) {
      tp2 = Math.round(tp1 + nkAtrForTP * 1.0);
      nkTp2Source = 'atr_extension';
    }
    // NK stricter cap: TP2 max = entry + 4×ATR (tighter than Konglo's 5×)
    var nkTp2Cap = Math.round(((entryLow + entryHigh) / 2) + nkAtrForTP * 4.0);
    if (tp2 > nkTp2Cap && tp2 > resistance * 1.05 && volumeRatioAvg20 < 1.5) {
      tp2 = nkTp2Cap;
      nkTp2Source = 'capped_liquidity';
    }

    // Build NK TP note
    var nkTpNote = '';
    if (nkTp1Source === 'gap_lower' || nkTp2Source === 'gap_upper') {
      nkTpNote = 'TP mempertimbangkan area gap atas yang belum tertutup.';
    } else if (nkTp1Source === 'swing_high_10d') {
      nkTpNote = 'TP1 ke swing high valid.';
    } else if (nkTp1Source === 'resistance_20d') {
      nkTpNote = 'TP1 ke resistance 20D.';
    } else if (nkTp1Source === 'fib_618') {
      nkTpNote = 'TP1 ke Fib 61.8% area.';
    }
    if (nkDownsideGap) {
      nkTpNote += (nkTpNote ? ' ' : '') + 'Ada gap bawah belum tertutup, waspadai pullback.';
    }
    if (nkTp2Source === 'capped_liquidity') {
      nkTpNote += (nkTpNote ? ' ' : '') + 'TP dikonservatifkan karena volume belum mendukung.';
    }

    // === ENTRY-DISTANCE GUARD ===
    var entryDistancePct = entryHigh > 0 ? ((lastClose - entryHigh) / entryHigh) * 100 : 0;
    var originalEntryDistancePct = entryDistancePct;

    if (setupType !== 'breakout' && entryDistancePct > 5) {
      if (entryDistancePct > 8) {
        setupType = 'wait_pullback';
      }
      entryLow = Math.round(lastClose * (1 - pctWidth));
      entryHigh = Math.round(lastClose);
      stopLoss = Math.round(entryLow * 0.96);
    }

    // === NK ATR-BASED SL REFINEMENT (V1 Level Quality Upgrade, parity with Konglo) ===
    var nkEntryMidForAtr = (entryLow + entryHigh) / 2;
    if (nkAtr14 && nkAtr14 > 0) {
      var nkAtrStop = Math.round(nkEntryMidForAtr - (1.5 * nkAtr14));
      var nkExistingSlDist = nkEntryMidForAtr - stopLoss;
      var nkAtrSlDist = nkEntryMidForAtr - nkAtrStop;
      if (nkExistingSlDist > nkAtrSlDist * 1.3 && nkAtrStop < entryLow && nkAtrStop > nkEntryMidForAtr * 0.92) {
        stopLoss = nkAtrStop;
      } else if (nkAtrSlDist > nkExistingSlDist * 1.5 && nkEntryMidForAtr - stopLoss < nkAtr14 * 0.5) {
        var nkWidened = Math.round(nkEntryMidForAtr - (1.0 * nkAtr14));
        if (nkWidened < entryLow && nkWidened > nkEntryMidForAtr * 0.92) {
          stopLoss = nkWidened;
        }
      }
    }
    if (stopLoss < nkEntryMidForAtr * 0.95) {
      stopLoss = Math.round(nkEntryMidForAtr * 0.95);
    }
    if (stopLoss >= entryLow) {
      stopLoss = Math.round(entryLow * 0.965);
    }

    // Risk/Reward based on actual entry (post-ATR-adjustment)
    const entryMid = (entryLow + entryHigh) / 2;
    const riskAmt = entryMid - stopLoss;
    const rewardAmt = tp1 - entryMid;
    var riskReward = riskAmt > 0 ? rewardAmt / riskAmt : 0;

    // === RR QUALITY GUARD (V1.1) ===
    if (riskReward > 5.0 && tp1 > resistance && nkTp1Source !== 'gap_lower') {
      tp1 = Math.round(resistance);
      riskReward = riskAmt > 0 ? (tp1 - entryMid) / riskAmt : 0;
    }
    if (riskReward < 1.2 && riskReward > 0 && !nkTpNote.includes('terlalu dekat')) {
      nkTpNote = (nkTpNote ? nkTpNote + ' ' : '') + 'TP terlalu dekat, RR kurang layak.';
    }

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
      candles: validDays,
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
      nkDistAboveMA20Pct: Number(nkDistAboveMA20Pct.toFixed(2)),
      // V1.1: TP quality note
      nkTpNote: nkTpNote || null,
      nkOverheadGap: nkOverheadGap,
      nkDownsideGap: nkDownsideGap,
      // V5: Candle Pattern Confirmation (computed at runtime)
      nkCandlePattern: (function() {
        var cpCtx = { volumeAvg20: avgVol20, support: support, resistance: resistance, ma20: ma20, rsi14: rsi14, changePct: changePct, lastPrice: lastClose };
        return candleEngine.detectPattern(validDays.slice(-3), cpCtx);
      })()
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

  // === V5: Candle Pattern Confirmation (Non-Konglo Swing — stricter than Konglo) ===
  var _nkCp = q.nkCandlePattern;
  var _nkCpScore = 0;
  if (_nkCp && _nkCp.pattern) {
    var _nkNearSup = q.support && q.lastPrice ? Math.abs(q.lastPrice - q.support) / q.support <= 0.03 : false;
    var _nkVr = q.volumeRatioAvg20 || 0;

    // Positive boosts (same as Konglo)
    if (_nkCp.pattern === 'Bullish Engulfing' && _nkNearSup) _nkCpScore += 5;
    else if (_nkCp.pattern === 'Bullish Engulfing') _nkCpScore += 3;
    if (_nkCp.pattern === 'Hammer' && _nkNearSup) _nkCpScore += 4;
    if (_nkCp.pattern === 'Dragonfly Doji' && _nkNearSup) _nkCpScore += 4;
    if (_nkCp.pattern === 'Morning Star') _nkCpScore += 5;
    if (_nkCp.pattern === 'Bullish Marubozu' && _nkVr >= 1.0) _nkCpScore += 4;
    if (_nkCp.pattern === 'Tweezer Bottom') _nkCpScore += 3;
    if (_nkCp.pattern === 'Three White Soldiers' && _nkCp.risk !== 'Overextended') _nkCpScore += 4;

    // Negative downgrades (same as Konglo)
    if (_nkCp.pattern === 'Shooting Star') _nkCpScore -= 5;
    if (_nkCp.pattern === 'Hanging Man') _nkCpScore -= 4;
    if (_nkCp.pattern === 'Bearish Engulfing') _nkCpScore -= 6;
    if (_nkCp.pattern === 'Evening Star') _nkCpScore -= 6;
    if (_nkCp.pattern === 'Gravestone Doji') _nkCpScore -= 5;
    if (_nkCp.pattern === 'Three Black Crows') _nkCpScore -= 7;
    if (_nkCp.pattern === 'Distribution candle') _nkCpScore -= 6;
    if (_nkCp.pattern === 'Rejection candle') _nkCpScore -= 5;
    if (_nkCp.pattern === 'Failed breakout candle') _nkCpScore -= 5;
    if (_nkCp.pattern === 'Bearish Marubozu') _nkCpScore -= 5;

    // STRICTER for Non-Konglo: if bullish but liquidity weak, reduce boost
    if (_nkCpScore > 0 && _nkVr < 0.8) {
      _nkCpScore = Math.max(0, Math.round(_nkCpScore * 0.4));
      if (_nkCpScore > 0) components.push('candle boost reduced (vol rendah)');
    }
    // STRICTER for Non-Konglo: rejection/distribution extra penalty
    if (_nkCp.risk === 'Rejection' || _nkCp.risk === 'Distribution') {
      _nkCpScore -= 2;
    }

    // Cap: stricter than Konglo (+5 max, -10 max)
    if (_nkCpScore > 5) _nkCpScore = 5;
    if (_nkCpScore < -10) _nkCpScore = -10;
    score += _nkCpScore;

    if (_nkCp.note && _nkCpScore !== 0) {
      components.push(_nkCp.note);
    }
  }

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

  // 9. V3 ENHANCEMENTS: Close position health + entry closeness
  if (q.nkIsAccumulation && q.volumeRatioAvg20 >= 1.0) {
    // Candle close position bonus for confirmed accumulation
    score += 2;
  }
  // Entry closeness — reward entries near current price (tight zone)
  var nkEntryDist = q.entryDistancePct || 0;
  if (nkEntryDist <= 2 && q.setupType !== 'breakout') { score += 3; components.push('entry dekat'); }
  else if (nkEntryDist <= 4 && q.setupType !== 'breakout') { score += 1; }

  score = Math.max(0, Math.min(100, score));

  // GRADE (same thresholds)
  var grade = 'D';
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';

  // STATUS CLASSIFICATION (same logic as Konglo scoreAndClassify)
  // ENHANCED V4: entry-distance guard, anti-chase, better notes
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
    else if (q.rsi14 < 45) failReasons.push('RSI rendah (' + q.rsi14.toFixed(0) + ')');
  }
  // V2: RSI >80 absolute block
  if (q.rsi14 !== null && q.rsi14 > 80) { passesAllHardFilters = false; }
  if (!(q.volumeRatioAvg20 >= 1.0)) { passesAllHardFilters = false; failReasons.push('Vol < 1x avg'); }
  if (!(q.riskReward >= 1.5)) { passesAllHardFilters = false; failReasons.push('RR kurang (' + q.riskReward.toFixed(2) + ')'); }
  if (q.slDistance > 5) { passesAllHardFilters = false; failReasons.push('SL jauh (' + q.slDistance.toFixed(1) + '%)'); }
  if (q.isLargeRed) { passesAllHardFilters = false; failReasons.push('Candle distribusi'); }
  // V2 Guard A1: Strong distribution blocks Swing Ready
  if (q.nkIsDistribution && q.nkDistributionStrength >= 2) { passesAllHardFilters = false; failReasons.push('Distribusi kuat'); }
  // V2 Guard A2: Strong rejection blocks Swing Ready
  if (q.nkIsStrongRejection) { passesAllHardFilters = false; failReasons.push('Candle rejection'); }
  if (q.overextended && q.setupType !== 'breakout') { passesAllHardFilters = false; failReasons.push('Overextended'); }
  if (q.belowSupport) { passesAllHardFilters = false; failReasons.push('Breakdown support'); }
  // ENTRY-DISTANCE HARD FILTER: >5% above entry = NOT immediately actionable
  if (edPctClassify > 5) { passesAllHardFilters = false; failReasons.push('Entry distance +' + edPctClassify.toFixed(1) + '% — chase risk'); }
  if (!q.priceInEntryZone && q.distanceAboveEntry > 10) { passesAllHardFilters = false; failReasons.push('Harga jauh dari Fib entry'); }
  // V2 Guard A6: >12% above MA20 blocks Swing Ready for Non-Konglo
  if (q.nkDistAboveMA20Pct > 12) { passesAllHardFilters = false; failReasons.push('Jauh di atas MA20 (+' + q.nkDistAboveMA20Pct.toFixed(1) + '%)'); }
  // Breakout trigger: entry above current price — NOT immediate Swing Ready
  if (q.setupType === 'breakout') { passesAllHardFilters = false; failReasons.push('Breakout trigger (wait konfirmasi)'); }
  // wait_pullback setup — by definition not immediately actionable
  if (q.setupType === 'wait_pullback') { passesAllHardFilters = false; failReasons.push('Wait pullback'); }
  // V4: Anti-chase — high change without proportional volume
  if (q.changePct > 5.0 && q.volumeRatioAvg20 < 1.5) { passesAllHardFilters = false; failReasons.push('Naik +' + q.changePct.toFixed(1) + '% tanpa vol kuat'); }

  if (passesAllHardFilters) {
    status = 'Swing Ready';
    if (q.priceInEntryZone && edPctClassify <= 2) {
      statusReason = 'Setup lengkap. Price DEKAT entry area — actionable sekarang.';
    } else if (q.priceInEntryZone) {
      statusReason = 'Setup lengkap. Price near entry area, siap monitoring entry.';
    } else {
      statusReason = 'Setup lengkap: trend, momentum, volume, RR layak. Konfirmasi entry area.';
    }
  } else if (q.setupType === 'wait_pullback' || edPctClassify > 8 || (q.changePct > 5.0 && q.volumeRatioAvg20 < 1.5)) {
    // V4: WAIT_PULLBACK — more specific anti-chase messaging
    status = 'Wait Pullback';
    if (q.changePct > 5.0) {
      statusReason = 'Sudah naik +' + q.changePct.toFixed(1) + '%. JANGAN chase. Tunggu pullback ke area entry.';
    } else if (edPctClassify > 8) {
      statusReason = 'Entry terlewat (distance +' + edPctClassify.toFixed(1) + '%). Tunggu koreksi, jangan chase.';
    } else {
      statusReason = 'Tunggu pullback. Entry distance: +' + edPctClassify.toFixed(1) + '%.';
    }
  } else if (edPctClassify > 5 && score >= 55) {
    // Moderate distance — mark as Wait Pullback if score is decent
    status = 'Wait Pullback';
    statusReason = 'Harga sudah di atas entry area (+' + edPctClassify.toFixed(1) + '%). Tunggu pullback ke area entry. Jangan chase.';
  } else if (q.rsi14 !== null && q.rsi14 >= 30 && q.rsi14 <= 42 &&
             q.lastPrice > q.support && q.volumeRatioAvg20 >= 0.8 && score >= 40) {
    status = 'Rebound Speculative';
    if (edPctClassify <= 3) {
      statusReason = 'Near support + RSI oversold. Entry rebound dekat — konfirmasi bounce + volume wajib.';
    } else {
      statusReason = 'Near support, potensi rebound. Tunggu konfirmasi bounce + volume masuk.';
    }
  } else if (score >= 55) {
    status = 'Watchlist';
    if (q.distanceAboveEntry > 10 || edPctClassify > 5) {
      statusReason = 'Setup lumayan tapi entry sudah jauh. Tunggu pullback. ' + (failReasons.length > 0 ? failReasons.slice(0, 2).join(', ') : '');
    } else if (q.nkIsDistribution) {
      statusReason = 'Volume distribusi terdeteksi. Waspadai false breakout. ' + (failReasons.length > 0 ? failReasons.slice(0, 1).join(', ') : '');
    } else {
      statusReason = failReasons.length > 0 ? 'Tunggu: ' + failReasons.slice(0, 2).join(', ') + '.' : 'Menunggu konfirmasi multi-faktor.';
    }
  } else if (score >= 40) {
    status = 'Speculative';
    if (q.nkIsDistribution) {
      statusReason = 'Distribusi terdeteksi — risk tinggi. ' + (failReasons.length > 0 ? failReasons.slice(0, 1).join(', ') : 'Setup belum memenuhi kriteria.');
    } else {
      statusReason = failReasons.length > 0 ? 'Pantau: ' + failReasons.slice(0, 2).join(', ') + '. Bukan entry.' : 'Setup belum memenuhi kriteria swing.';
    }
  } else {
    status = 'Speculative';
    statusReason = failReasons.length > 0 ? failReasons.slice(0, 2).join(', ') + '. Setup terlalu lemah.' : 'Setup terlalu lemah untuk swing.';
  }

  // TASK 6: Improved status_reason format — V4: more actionable, anti-chase clarity
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

  // V4: Entry interpretation — explicit anti-chase warnings
  var entryNote = '';
  if (q.setupType === 'wait_pullback' || edPctClassify > 8) {
    entryNote = ' Entry distance: +' + edPctClassify.toFixed(1) + '%. JANGAN chase — tunggu pullback.';
  } else if (edPctClassify > 5) {
    entryNote = ' Entry distance: +' + edPctClassify.toFixed(1) + '%. Harga sudah jauh dari entry. Tunggu koreksi.';
  } else if (q.changePct > 5.0 && q.volumeRatioAvg20 < 1.5) {
    entryNote = ' Naik +' + q.changePct.toFixed(1) + '% tanpa vol kuat. Chase risk tinggi.';
  } else if (q.setupType === 'rebound' && q.priceInEntryZone) {
    entryNote = ' Entry rebound near support — actionable.';
  } else if (q.setupType === 'pullback' && q.priceInEntryZone) {
    entryNote = ' Entry pullback actionable — dekat area.';
  } else if (q.setupType === 'breakout') {
    entryNote = ' BREAKOUT TRIGGER — wait konfirmasi break + volume.';
  } else if (edPctClassify <= 2) {
    entryNote = ' Entry DEKAT — siap monitoring.';
  } else if (edPctClassify <= 5) {
    entryNote = ' Entry moderat (+' + edPctClassify.toFixed(1) + '%).';
  } else {
    entryNote = ' Price jauh dari entry ideal.';
  }

  statusReason = metricLine + '.' + entryNote + ' ' + statusReason;

  // V5: Append candle pattern note to statusReason if detected
  var _nkCpFinal = q.nkCandlePattern;
  if (_nkCpFinal && _nkCpFinal.pattern && _nkCpFinal.note) {
    statusReason += ' | Candle: ' + _nkCpFinal.note;
  }

  // V1.1: Append TP quality note
  if (q.nkTpNote) {
    statusReason += ' | ' + q.nkTpNote;
  }

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
// SWING SCREENER: Derive labels from stored fields (no DB columns needed)
// Computes: swing_tier, confidence, entry_timing, tradeability, direction
// Works for both Konglo and Non-Konglo screeners.
// V4: Improved tier granularity, anti-chase awareness, risk-aware labels
// ============================================================
function deriveSwingLabels(r, screenerType) {
  var status = r.final_status || r.status || 'Invalid';
  var score = r.score || 0;
  var rr = r.risk_reward || 0;
  var rsi = r.rsi14 != null ? Number(r.rsi14) : null;
  var volRatio = r.volume_ratio_avg20 != null ? Number(r.volume_ratio_avg20) : 0;
  var entryLow = r.entry_low != null ? Number(r.entry_low) : 0;
  var entryHigh = r.entry_high != null ? Number(r.entry_high) : 0;
  var lastPrice = r.last_price != null ? Number(r.last_price) : 0;
  var stopLoss = r.stop_loss != null ? Number(r.stop_loss) : 0;
  var ma20 = r.ma20 != null ? Number(r.ma20) : 0;
  var changePct = r.change_pct != null ? Number(r.change_pct) : 0;
  var txValue1d = r.tx_value_1d != null ? Number(r.tx_value_1d) : 0;
  var avgTxValue7d = r.avg_tx_value_7d != null ? Number(r.avg_tx_value_7d) : 0;
  var statusReason = r.status_reason || '';

  // Derived metrics
  var entryMid = (entryLow + entryHigh) / 2 || lastPrice;
  var entryDistancePct = entryHigh > 0 && lastPrice > 0 ? ((lastPrice - entryHigh) / entryHigh) * 100 : 0;
  var slDistancePct = entryMid > 0 && stopLoss > 0 ? ((entryMid - stopLoss) / entryMid) * 100 : 0;
  var distAboveMA20 = ma20 > 0 && lastPrice > 0 ? ((lastPrice - ma20) / ma20) * 100 : 0;

  // Detect signals from status_reason text
  var hasDistribution = statusReason.toLowerCase().indexOf('distribusi') >= 0 || statusReason.toLowerCase().indexOf('rejection') >= 0;
  var hasPoorRR = rr < 1.5 || statusReason.indexOf('RR kurang') >= 0;
  var hasRiskFar = slDistancePct > 5 || statusReason.indexOf('SL jauh') >= 0 || statusReason.indexOf('Risk terlalu jauh') >= 0;
  var hasOverextended = distAboveMA20 > 10 || statusReason.indexOf('Overextended') >= 0 || statusReason.indexOf('jauh di atas MA20') >= 0;
  var hasChaseRisk = entryDistancePct > 5 || statusReason.indexOf('jangan chase') >= 0;
  var hasLiquidityRisk = statusReason.indexOf('liquidity') >= 0 || statusReason.indexOf('Volume belum') >= 0 || volRatio < 0.7;

  // V4: Detect anti-chase signals from change_pct
  var isExtendedMove = changePct > 5.0 && volRatio < 1.5;
  var isGapUp = changePct > 7.0;

  // === SWING TIER === (V4: tighter A+ criteria, better REBOUND/WATCHLIST separation)
  var swing_tier = 'INVALID';

  if (status === 'Swing Ready' && score >= 85 && rr >= 2.0 && volRatio >= 1.2 &&
      !hasDistribution && !hasOverextended && !hasChaseRisk && !hasPoorRR &&
      !isExtendedMove && !isGapUp &&
      entryDistancePct <= 3 && slDistancePct <= 4.5) {
    swing_tier = 'A_PLUS_SWING';
  } else if (status === 'Swing Ready' && score >= 75 && rr >= 1.5 &&
             !hasDistribution && !hasOverextended && !isGapUp && entryDistancePct <= 5) {
    swing_tier = 'TRADE_CANDIDATE';
  } else if (status === 'Swing Ready') {
    // V4: Swing Ready with chase risk → downgrade to WATCHLIST
    if (hasChaseRisk || isExtendedMove) {
      swing_tier = 'WATCHLIST';
    } else {
      swing_tier = 'SWING_READY';
    }
  } else if (status === 'Wait Pullback' || (hasOverextended && score >= 50) || (isGapUp && score >= 50)) {
    swing_tier = 'WAIT_PULLBACK';
  } else if (status === 'Rebound Speculative' || (status === 'Watchlist' && rsi !== null && rsi >= 30 && rsi <= 42 && !hasDistribution)) {
    swing_tier = 'REBOUND_CANDIDATE';
  } else if (status === 'Watchlist' && score >= 60) {
    swing_tier = 'WATCHLIST';
  } else if (status === 'Speculative' || (status === 'Watchlist' && score < 60 && score >= 40)) {
    swing_tier = 'SPECULATIVE';
  } else if (status === 'Invalid' || score < 30) {
    swing_tier = 'AVOID';
  } else {
    swing_tier = 'SPECULATIVE';
  }

  // === CONFIDENCE === standardized A/B/C only
  var confidence = 'C';
  if (swing_tier === 'A_PLUS_SWING' || swing_tier === 'TRADE_CANDIDATE' || (swing_tier === 'SWING_READY' && score >= 80)) confidence = 'A';
  else if (swing_tier === 'SWING_READY' || swing_tier === 'WATCHLIST' || swing_tier === 'REBOUND_CANDIDATE') confidence = 'B';

  // === ENTRY TIMING === (V4: explicit anti-chase messaging)
  var entry_timing = 'Hanya pantau';
  if (swing_tier === 'A_PLUS_SWING' || swing_tier === 'TRADE_CANDIDATE') {
    if (entryDistancePct <= 2) entry_timing = 'Masih dekat entry';
    else if (entryDistancePct <= 4) entry_timing = 'Entry moderat — size kecil';
    else if (entryDistancePct <= 6) entry_timing = 'Tunggu pullback sedikit';
    else entry_timing = 'Tunggu pullback — jangan chase';
  } else if (swing_tier === 'SWING_READY') {
    if (entryDistancePct <= 2) entry_timing = 'Masih dekat entry';
    else if (entryDistancePct <= 4) entry_timing = 'Entry moderat';
    else entry_timing = 'Tunggu breakout konfirmasi';
  } else if (swing_tier === 'WATCHLIST') {
    if (hasChaseRisk) entry_timing = 'Sudah extended — pantau saja';
    else entry_timing = 'Hanya pantau — belum actionable';
  } else if (swing_tier === 'REBOUND_CANDIDATE') {
    if (entryDistancePct <= 3) entry_timing = 'Entry rebound — near support';
    else entry_timing = 'Tunggu test support';
  } else if (swing_tier === 'WAIT_PULLBACK') {
    if (entryDistancePct > 8 || changePct > 5.0) entry_timing = 'Sudah telat / JANGAN chase';
    else entry_timing = 'Tunggu pullback ke area entry';
  } else if (swing_tier === 'SPECULATIVE') {
    entry_timing = 'Hanya pantau — risk tinggi';
  } else {
    entry_timing = 'Hindari — setup tidak valid';
  }

  // === TRADEABILITY === (V4: volume-aware, anti-chase aware)
  var tradeability = 'Low';
  if (swing_tier === 'A_PLUS_SWING') tradeability = 'High';
  else if (swing_tier === 'TRADE_CANDIDATE') tradeability = 'High';
  else if (swing_tier === 'SWING_READY' && rr >= 2.0 && volRatio >= 1.0 && entryDistancePct <= 3) tradeability = 'High';
  else if (swing_tier === 'SWING_READY' && rr >= 1.5) tradeability = 'Medium';
  else if (swing_tier === 'SWING_READY') tradeability = 'Medium';
  else if (swing_tier === 'WATCHLIST' && score >= 70 && rr >= 1.5 && !hasChaseRisk) tradeability = 'Medium';
  else if (swing_tier === 'WATCHLIST') tradeability = 'Low';
  else if (swing_tier === 'REBOUND_CANDIDATE' && rr >= 2.0 && entryDistancePct <= 3) tradeability = 'Medium';
  else if (swing_tier === 'REBOUND_CANDIDATE') tradeability = 'Low';
  else if (swing_tier === 'WAIT_PULLBACK') tradeability = 'Low';
  else if (swing_tier === 'SPECULATIVE') tradeability = 'Low';
  else tradeability = 'Avoid';

  // === DIRECTION === (V4: more specific labels)
  var direction = 'Hindari';
  if (swing_tier === 'A_PLUS_SWING') direction = 'Potensi swing kuat — setup lengkap';
  else if (swing_tier === 'TRADE_CANDIDATE') direction = 'Potensi swing kuat';
  else if (swing_tier === 'SWING_READY' && score >= 80) direction = 'Potensi swing moderat-kuat';
  else if (swing_tier === 'SWING_READY') direction = 'Potensi swing moderat';
  else if (swing_tier === 'WATCHLIST' && score >= 70) direction = 'Potensi swing moderat — tunggu konfirmasi';
  else if (swing_tier === 'WATCHLIST') direction = 'Watchlist — belum actionable';
  else if (swing_tier === 'REBOUND_CANDIDATE') direction = 'Potensi rebound — konfirmasi bounce wajib';
  else if (swing_tier === 'WAIT_PULLBACK') direction = 'Rawan gagal lanjut — jangan chase';
  else if (swing_tier === 'SPECULATIVE') direction = 'Rawan gagal lanjut — risk tinggi';
  else direction = 'Hindari — setup tidak valid';

  return {
    swing_tier: swing_tier,
    confidence: confidence,
    entry_timing: entry_timing,
    tradeability: tradeability,
    direction: direction
  };
}

// ============================================================
// DAY TRADE: Derive labels from stored fields (no DB columns needed)
// V4: Consistent with engine V4 — anti-chase, graduated confidence, risk-aware
// ============================================================
function deriveDayTradeLabels(r) {
  var status = r.status || 'AVOID';
  var score = r.daytrade_score || 0;
  var chg = r.change_pct || 0;
  var vol = r.volume_ratio_20d || 0;
  var rr = r.risk_reward || 0;
  var entryLow = r.entry_low || 0;
  var entryHigh = r.entry_high || 0;
  var lastPrice = r.last_price || 0;
  var riskDist = (entryLow > 0 && lastPrice > 0) ? ((lastPrice - entryLow) / lastPrice) * 100 : 0;

  // Confidence tier standardized A/B/C only
  var confidence = 'C';
  if (status === 'A_PLUS_SETUP' || status === 'TRADE_CANDIDATE' || status === 'READY_BREAKOUT') confidence = 'A';
  else if (status === 'PRE_SPIKE_WATCH' || status === 'EARLY_RADAR' || status === 'MOMENTUM_CONTINUATION' || status === 'RECLAIM_CANDIDATE') confidence = 'B';

  // Entry timing (V4: anti-chase explicit messaging)
  var entryTiming = 'Hanya pantau';
  if (status === 'A_PLUS_SETUP' || status === 'TRADE_CANDIDATE' || status === 'READY_BREAKOUT') {
    if (chg <= 2.5 && riskDist <= 2.5) entryTiming = 'Masih dekat entry';
    else if (chg <= 4.0 && riskDist <= 4.0) entryTiming = 'Entry moderat — size kecil';
    else entryTiming = 'Tunggu breakout konfirmasi';
  } else if (status === 'PRE_SPIKE_WATCH' || status === 'EARLY_RADAR') {
    entryTiming = 'Tunggu breakout — belum entry';
  } else if (status === 'WAIT_PULLBACK') {
    if (chg > 5.0) entryTiming = 'Sudah telat / JANGAN chase';
    else entryTiming = 'Tunggu pullback ke area entry';
  } else if (status === 'MOMENTUM_CONTINUATION' && chg > 5.0) {
    entryTiming = 'Sudah telat / jangan chase';
  } else if (status === 'MOMENTUM_CONTINUATION') {
    entryTiming = 'Masih bisa — tight SL wajib';
  } else if (status === 'RECLAIM_CANDIDATE') {
    entryTiming = 'Tunggu konfirmasi reclaim MA20';
  } else if (status === 'AVOID') {
    entryTiming = 'Hindari — setup tidak valid';
  }

  // Direction prediction (V4: risk-aware)
  var direction = 'Hindari';
  if (confidence === 'A') direction = 'Potensi naik kuat';
  else if (confidence === 'B' && score >= 72) direction = 'Potensi naik moderat';
  else if (confidence === 'B') direction = 'Radar awal — belum konfirmasi';
  else if (status === 'WAIT_PULLBACK') direction = 'Rawan gagal lanjut — jangan chase';
  else if (status === 'SPECULATIVE') direction = 'Rawan gagal lanjut';
  else if (status === 'AVOID') direction = 'Hindari — risiko tinggi';
  else direction = 'Masih radar awal';

  return { confidence: confidence, entry_timing: entryTiming, direction: direction };
}

// ============================================================
// DAY TRADE TIMEFRAME CONTEXT (derived from persisted fields at read-time)
// Since multi-candle data is not persisted, we derive 1D context from
// change_pct, volume_ratio, range_position, rsi14.
// 2D-20D require schema update to persist (reported as limitation).
// ============================================================
function deriveDayTradeTimeframeContext(r) {
  var chg = r.change_pct || 0;
  var volR = r.volume_ratio_20d || 0;
  var rp = r.range_position || 50; // 0=low, 100=high
  var rsi = r.rsi14 || 50;
  var status = r.status || '';

  // 1D context from persisted single-candle fields
  var tf1d = 'Netral';
  if (chg >= 2 && volR >= 1.3 && rp >= 70) tf1d = 'Bullish close near high';
  else if (chg >= 1 && rp >= 60) tf1d = 'Bullish';
  else if (chg >= 0.3 && rp >= 50) tf1d = 'Slight bullish';
  else if (chg <= -3 && volR >= 1.3 && rp <= 30) tf1d = 'Distribution pressure';
  else if (chg <= -2 && rp <= 30) tf1d = 'Bearish close near low';
  else if (chg <= -1) tf1d = 'Bearish';
  else if (chg <= -0.3) tf1d = 'Slight bearish';
  else if (rp >= 80 && chg >= 0) tf1d = 'Close near high';
  else if (rp <= 20 && chg <= 0) tf1d = 'Close near low';
  else tf1d = 'Netral / sideways';

  // Volume-price action for 1D
  if (volR >= 1.5 && chg <= -1 && rp <= 30) tf1d = 'Distribution pressure (vol tinggi)';
  else if (volR >= 1.5 && chg >= 1 && rp >= 70) tf1d = 'Markup confirmation (vol tinggi)';
  else if (volR >= 1.5 && Math.abs(chg) < 1) tf1d = 'Absorption / battle zone (vol tinggi)';

  // Summary (compact for card)
  var summary = tf1d;
  if (status === 'AVOID') summary = tf1d + ' — setup AVOID';
  else if (status === 'WAIT_PULLBACK') summary = tf1d + ' — tunggu pullback';

  // Derived risk from 1D context
  var derivedRisk = null;
  if (tf1d.indexOf('Distribution') >= 0) derivedRisk = 'High Risk';
  else if (tf1d.indexOf('Bearish close near low') >= 0 && volR >= 1.3) derivedRisk = 'High Risk';
  else if (tf1d.indexOf('Bullish') >= 0 && volR >= 1.0) derivedRisk = 'Low Risk';
  else derivedRisk = 'Medium Risk';

  return { tf_1d: tf1d, summary: summary, derived_risk: derivedRisk };
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
    var statusPriority = { 'A_PLUS_SETUP': 0, 'TRADE_CANDIDATE': 1, 'READY_BREAKOUT': 2, 'PRE_SPIKE_WATCH': 3, 'EARLY_RADAR': 4, 'MOMENTUM_CONTINUATION': 5, 'RECLAIM_CANDIDATE': 6, 'WAIT_PULLBACK': 7, 'SPECULATIVE': 8, 'AVOID': 9 };
    var sortedRows = (rows || []).sort(function(a, b) {
      var pa = statusPriority[a.status] || 9;
      var pb = statusPriority[b.status] || 9;
      if (pa !== pb) return pa - pb;
      return (b.daytrade_score || 0) - (a.daytrade_score || 0);
    });

    // Derive computed labels (confidence, entry_timing, direction, timeframe) from stored fields
    sortedRows = sortedRows.map(function(r) {
      var labels = deriveDayTradeLabels(r);
      r.entry_timing = labels.entry_timing;
      r.direction = labels.direction;
      attachEntryStatus(r);
      // Derive 1D candle context from persisted fields
      var tfCtx = deriveDayTradeTimeframeContext(r);
      r.tf_1d_context = tfCtx.tf_1d;
      r.tf_summary = tfCtx.summary;
      r.derived_risk = tfCtx.derived_risk;
      return attachFreshness(enrichSignalQuality(r, 'Day Trade'), meta);
    });

    sortedRows = await enrichConfluenceRows(supabase, sortedRows, false);

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
  var runId = null;
  var runDate = null;

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

  try {
  // 2. Determine run mode
  var modeOverride = req.query.mode || null;
  var runMode = dtEngine.getRunMode(modeOverride);
  runDate = dtEngine.getWibDateStr();
  var speedMode = (req.query.speed || 'full').toLowerCase();
  var isFastMode = (speedMode === 'fast');
  var BATCH_SIZE = isFastMode ? 75 : 50;
  var batchIndex = parseInt(req.query.batch || '0', 10);
  var isFullScanStart = !isFastMode && batchIndex === 0;

  // 3. Read current meta state
  var { data: meta } = await supabase
    .from('daytrade_screener_meta')
    .select('*')
    .eq('id', 'latest')
    .maybeSingle();

  // 4. If batch > 0 and meta is scanning, continue existing run
  if (batchIndex > 0 && meta && meta.status === 'scanning') {
    runId = meta.run_id || ('dt-' + runDate + '-' + Date.now().toString(36));
  } else if (batchIndex === 0) {
    // Starting fresh
    runId = 'dt-' + runDate + '-' + Date.now().toString(36);

    // Day Trade full scan anti-overlap guard: never start a new full 760-stock
    // scan while the previous full scan lock is still fresh.
    var staleFullScanLock = false;
    if (isFullScanStart && meta && meta.status === 'scanning') {
      var runningStartedAt = getDtRunningStartedAt(meta);
      var runningAgeMs = runningStartedAt ? (Date.now() - new Date(runningStartedAt).getTime()) : 0;
      if (runningStartedAt && runningAgeMs < DAYTRADE_FULL_SCAN_STALE_LOCK_MS) {
        console.log('[daytrade-screener-run] ' + DAYTRADE_RUNNING_SKIP_MESSAGE + ' running_started_at=' + runningStartedAt + ' run_id=' + (meta.run_id || 'unknown'));
        return res.status(200).json({
          success: true,
          status: 'skipped',
          skipped_due_to_running: true,
          running_started_at: runningStartedAt,
          run_id: meta.run_id,
          message: DAYTRADE_RUNNING_SKIP_MESSAGE,
          meta: meta
        });
      }
      staleFullScanLock = true;
      console.warn('[daytrade-screener-run] stale Day Trade full scan lock expired; allowing new run. previous_run_id=' + (meta.run_id || 'unknown') + ' running_started_at=' + (runningStartedAt || 'unknown'));
    }

    // Check if already running for non-full modes (prevent accidental double-start)
    if (!isFullScanStart && meta && meta.status === 'scanning' && req.query.force !== '1') {
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
      message: staleFullScanLock ? 'Previous Day Trade full scan lock was stale/expired; starting new scan...' : 'Building universe...'
    });
  } else {
    // batch > 0 but meta is not scanning — stale request
    runId = 'dt-' + runDate + '-' + Date.now().toString(36);
  }

  // 5. Build universe (fast mode uses curated liquid shortlist)
  var universeResult;
  if (isFastMode) {
    universeResult = await dtEngine.buildFastDayTradeUniverse(supabase);
  } else {
    universeResult = await dtEngine.buildDayTradeUniverse(supabase);
  }
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
  var batchResult = await dtEngine.runDayTradeBatch(batchTickers, runMode, { fastMode: isFastMode });
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
        run_id: runId,
        // V6: Persisted context fields
        tf_1d_context: r.daily_candle_context || r.tf_1d_context || null,
        tf_2d_context: r.tf_2d_context || null,
        tf_3d_context: r.tf_3d_context || null,
        tf_5d_context: r.weekly_candle_context || r.tf_5d_context || null,
        tf_10d_context: r.tf_10d_context || null,
        tf_20d_context: r.monthly_candle_context || r.tf_20d_context || null,
        multi_timeframe_bias: r.multi_timeframe_bias || null,
        multi_timeframe_notes: r.multi_timeframe_notes || null,
        volume_phase: r.volume_phase || null,
        risk_label: r.risk_label || null,
        quality_grade: r.quality_grade || null
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
    speed_mode: isFastMode ? 'fast' : 'full',
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
  } catch (e) {
    console.error('daytrade screener run error:', e.message);
    if (runId) {
      await updateDtMeta(supabase, {
        status: 'failed',
        run_date: runDate,
        run_id: runId,
        message: 'Day Trade scan failed: ' + e.message
      });
    }
    return res.status(200).json({
      success: false,
      status: 'failed',
      run_id: runId,
      message: 'Day Trade scan failed: ' + e.message
    });
  }
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

  var sendEmptyNoticeRequested = getDayTradeEmptyNoticeRequested(req);
  var radarRequested = getDayTradeRadarRequested(req);
  var forceRadarDebug = getDayTradeForceRadarDebugRequested(req);
  var telegramResult = await sendDayTradeTelegramNotification(supabase, runId, runDate, savedCount, sendEmptyNoticeRequested, radarRequested, { force_radar_debug: forceRadarDebug });
  var responsePayload = {
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
    message: 'Day Trade Screener run complete. Top ' + savedCount + ' published.',
    radar_requested: radarRequested,
    send_empty_notice_requested: sendEmptyNoticeRequested,
    duplicate_guard_hit: !!(telegramResult && (telegramResult.duplicate_guard_hit || telegramResult.reason === 'duplicate_run_id' || telegramResult.reason === 'duplicate_radar_run_id')),
    telegram: telegramResult
  };
  if (telegramResult) {
    if (telegramResult.diagnostics) responsePayload.diagnostics = telegramResult.diagnostics;
    if (telegramResult.radar_count !== undefined) responsePayload.radar_count = telegramResult.radar_count;
    if (telegramResult.radar_candidates) responsePayload.radar_candidates = telegramResult.radar_candidates;
    if (telegramResult.radar_blocked_count !== undefined) responsePayload.radar_blocked_count = telegramResult.radar_blocked_count;
    if (telegramResult.radar_rejection_reasons) responsePayload.radar_rejection_reasons = telegramResult.radar_rejection_reasons;
    if (telegramResult.sample_radar_rejected) responsePayload.sample_radar_rejected = telegramResult.sample_radar_rejected;
  }
  if (telegramResult && telegramResult.reason === 'no_final_quality_gate_candidates') {
    responsePayload.skipped = true;
    responsePayload.reason = 'no_final_quality_gate_candidates';
    if (telegramResult.diagnostics) responsePayload.diagnostics = telegramResult.diagnostics;
    if (telegramResult.admin_radar_summary) responsePayload.admin_radar_summary = telegramResult.admin_radar_summary;
    if (telegramResult.signal_safe_count !== undefined) responsePayload.signal_safe_count = telegramResult.signal_safe_count;
    if (telegramResult.radar_sent !== undefined) responsePayload.radar_sent = telegramResult.radar_sent;
    if (telegramResult.radar_count !== undefined) responsePayload.radar_count = telegramResult.radar_count;
    if (telegramResult.radar_candidates) responsePayload.radar_candidates = telegramResult.radar_candidates;
    if (telegramResult.radar_blocked_count !== undefined) responsePayload.radar_blocked_count = telegramResult.radar_blocked_count;
    if (telegramResult.radar_rejection_reasons) responsePayload.radar_rejection_reasons = telegramResult.radar_rejection_reasons;
    if (telegramResult.sample_radar_rejected) responsePayload.sample_radar_rejected = telegramResult.sample_radar_rejected;
  }
  return res.status(200).json(responsePayload);
}


function getDtRunningStartedAt(meta) {
  if (!meta) return null;
  return meta.calculated_at || meta.updated_at || null;
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

// ============================================================
// DAY TRADE TELEGRAM NOTIFICATION (Phase 2 — after publish only)
// Never throws. Never breaks Day Trade flow.
// ============================================================
var _dtTelegramLastRunId = null; // Simple in-memory duplicate guard
var _dtTelegramLastRunReason = null;
var _dtTelegramLastRadarRunId = null;

function dayTradeTelegramTextHasAvoid(text) {
  return includesAny(text, ['hindari', 'avoid']);
}

function isDayTradeTelegramFinalGateRejected(r) {
  r = r || {};
  var finalGate = r.final_top_quality_gate || r.final_quality_gate || r.top_quality_gate || null;
  var finalStatus = safeTelegramText(r.final_quality_status || r.final_gate_status || r.quality_gate_status || '', 120, '').toLowerCase();
  var finalText = joinTelegramTexts([
    finalStatus,
    r.excluded_reason,
    r.signal_verdict,
    r.telegram_verdict,
    r.verdict,
    r.reason,
    r.status_reason
  ]).toLowerCase();
  return r.final_quality_pass === false ||
    r.final_gate_pass === false ||
    r.quality_gate_pass === false ||
    (finalGate && finalGate.pass === false) ||
    includesAny(finalText, ['rejected', 'reject', 'failed', 'fail', 'tidak lolos final quality gate', 'hindari', 'avoid']);
}

function getDayTradeEmptyNoticeRequested(req) {
  var q = (req && req.query) || {};
  var b = (req && req.body && typeof req.body === 'object') ? req.body : {};
  return q.debug_telegram === '1' || q.send_empty_notice === '1' || b.debug_telegram === '1' || b.debug_telegram === 1 || b.debug_telegram === true || b.send_empty_notice === '1' || b.send_empty_notice === 1 || b.send_empty_notice === true;
}

function dayTradeFlagEnabled(value) {
  return value === '1' || value === 1 || value === true || String(value || '').toLowerCase() === 'true';
}

function getDayTradeRadarRequested(req) {
  var q = (req && req.query) || {};
  var b = (req && req.body && typeof req.body === 'object') ? req.body : {};
  return dayTradeFlagEnabled(q.send_radar) || dayTradeFlagEnabled(q.radar_telegram) || dayTradeFlagEnabled(b.send_radar) || dayTradeFlagEnabled(b.radar_telegram);
}

function getDayTradeForceRadarDebugRequested(req) {
  var q = (req && req.query) || {};
  var b = (req && req.body && typeof req.body === 'object') ? req.body : {};
  return dayTradeFlagEnabled(q.force_radar_debug) || dayTradeFlagEnabled(b.force_radar_debug);
}

function candidatePassesDayTradeTelegramFinalGate(candidate) {
  if (!candidate) return false;

  if (isDayTradeTelegramFinalGateRejected(candidate)) return false;
  if (candidate.trading_plan_valid === false) return false;

  var actionText = joinTelegramTexts([
    candidate.action_label,
    candidate.signal_action_label,
    candidate.telegram_action_label,
    candidate.action,
    candidate.signal_action,
    candidate.telegram_verdict
  ]).toLowerCase();
  if (dayTradeTelegramTextHasAvoid(actionText)) return false;

  var riskStatusText = joinTelegramTexts([
    candidate.risk,
    candidate.risk_label,
    candidate.risk_label_v2,
    candidate.verified_risk_label,
    candidate.status,
    candidate.final_status,
    candidate.grade,
    candidate.quality_grade
  ]).toLowerCase();
  if (includesAny(riskStatusText, ['avoid'])) return false;

  var freshnessStatus = safeTelegramText(candidate.setup_freshness_status || candidate.freshness_status || '', 80, '').toUpperCase();
  if (freshnessStatus === 'EXPIRED' || freshnessStatus === 'NEEDS_REVALIDATION') return false;
  if (candidate.is_stale === true || candidate.data_stale === true || candidate.freshness_is_stale === true || candidate.stale === true) return false;

  var freshnessText = joinTelegramTexts([
    candidate.setup_freshness_label,
    candidate.freshness_label,
    candidate.setup_expiry_note,
    candidate.stale_notes
  ]).toLowerCase();
  if (includesAny(freshnessText, ['needs revalidation', 'expired', 'stale'])) return false;

  var guardText = joinTelegramTexts([
    candidate.action_guard_label,
    candidate.action_guard_status,
    candidate.plan_quality_label,
    candidate.plan_quality_note
  ]).toLowerCase();
  if (includesAny(guardText, ['level belum rapi', 'invalid plan', 'plan invalid'])) return false;

  return candidatePassesPublicTelegramSafetyGate(candidate, 'daytrade') && applyFinalTopQualityGate(candidate, 'daytrade_telegram_final_filter').pass;
}

function getDayTradeTelegramRejectionReason(candidate, stage) {
  var r = candidate || {};
  if (stage === 'verify_signal') return 'basic telegram verification failed';
  if (stage === 'high_conviction') return 'high conviction filter failed';
  if (stage === 'min_tp1') return 'min TP1 upside gate failed';
  if (isDayTradeTelegramFinalGateRejected(r)) return safeTelegramText(r.excluded_reason || r.telegram_verdict || r.verdict, 120, 'final quality gate failed');
  if (r.trading_plan_valid === false) return 'invalid trading plan';
  var actionText = joinTelegramTexts([r.action_label, r.signal_action_label, r.telegram_action_label, r.action, r.signal_action, r.telegram_verdict]).toLowerCase();
  if (dayTradeTelegramTextHasAvoid(actionText)) return 'Hindari/Avoid action blocked';
  var riskStatusText = joinTelegramTexts([r.risk, r.risk_label, r.risk_label_v2, r.verified_risk_label, r.status, r.final_status, r.grade, r.quality_grade]).toLowerCase();
  if (includesAny(riskStatusText, ['avoid'])) return 'Avoid risk/status blocked';
  var freshnessStatus = safeTelegramText(r.setup_freshness_status || r.freshness_status || '', 80, '').toUpperCase();
  if (freshnessStatus === 'EXPIRED' || freshnessStatus === 'NEEDS_REVALIDATION' || r.is_stale === true || r.data_stale === true || r.freshness_is_stale === true || r.stale === true) return 'stale / Needs Revalidation';
  var freshnessText = joinTelegramTexts([r.setup_freshness_label, r.freshness_label, r.setup_expiry_note, r.stale_notes]).toLowerCase();
  if (includesAny(freshnessText, ['needs revalidation', 'expired', 'stale'])) return 'stale / Needs Revalidation';
  var guardText = joinTelegramTexts([r.action_guard_label, r.action_guard_status, r.plan_quality_label, r.plan_quality_note]).toLowerCase();
  if (includesAny(guardText, ['level belum rapi', 'invalid plan', 'plan invalid'])) return 'invalid plan / level belum rapi';
  var text = joinTelegramTexts([r.status, r.final_status, r.action_label, r.signal_action_label, r.telegram_action_label, r.action, r.signal_action, r.telegram_verdict, r.signal_verdict, r.verdict, r.reason, r.status_reason, r.action_reason, r.signal_reason, r.excluded_reason, r.final_quality_status, r.final_gate_status, r.quality_gate_status, r.plan_quality_label, r.plan_quality_note, r.entry_quality_label, r.entry_status_label, r.entry_safety_note, r.stale_notes, r.liquidity_notes]).toLowerCase();
  if (includesAny(text, ['very high risk'])) return 'Very High Risk blocked';
  if (includesAny(text, ['weak liquidity', 'likuiditas lemah', 'likuiditas tipis'])) return 'weak liquidity blocked';
  if (includesAny(text, ['weak volume', 'volume lemah'])) return 'weak volume blocked';
  if (includesAny(text, ['missing entry', 'missing sl', 'missing tp', 'invalid rr'])) return 'invalid plan / missing Entry-SL-TP';
  if (includesAny(text, ['needs close confirmation', 'close confirmation', 'entry not touched', 'not entry-ready', 'not entry ready', 'watchlist only', 'mtf mixed', 'chase warning', 'tunggu konfirmasi', 'belum entry'])) return 'soft watchlist only';
  return 'public safety gate failed';
}

function classifyDayTradeTelegramRejection(candidate, stage, reason) {
  var r = candidate || {};
  var text = joinTelegramTexts([r.status, r.final_status, r.action_label, r.signal_action_label, r.telegram_action_label, r.action, r.signal_action, r.telegram_verdict, r.signal_verdict, r.verdict, r.reason, r.status_reason, r.action_reason, r.signal_reason, r.excluded_reason, r.final_quality_status, r.final_gate_status, r.quality_gate_status, r.plan_quality_label, r.plan_quality_note, r.entry_quality_label, r.entry_status_label, r.entry_safety_note, r.stale_notes, r.liquidity_notes, reason]).toLowerCase();
  if (stage === 'min_tp1' || includesAny(text, ['min tp1'])) return 'min_tp1_failed';
  if (dayTradeTelegramTextHasAvoid(text) || includesAny(text, ['very high risk', 'stale', 'expired', 'needs revalidation', 'invalid plan', 'plan invalid', 'level belum rapi', 'weak liquidity', 'likuiditas lemah', 'likuiditas tipis', 'weak volume', 'volume lemah']) || r.trading_plan_valid === false || r.is_stale === true || r.data_stale === true || r.freshness_is_stale === true || r.stale === true) return 'hard_block';
  if (includesAny(text, ['watchlist', 'pantau', 'needs close confirmation', 'close confirmation', 'entry not touched', 'not entry-ready', 'not entry ready', 'mtf mixed', 'chase warning', 'tunggu konfirmasi', 'belum entry'])) return 'soft_watchlist';
  return 'final_gate_failed_unknown';
}

function buildDayTradeTelegramDiagnostics(candidates, stageByTicker, counts) {
  candidates = candidates || [];
  stageByTicker = stageByTicker || {};
  counts = counts || {};
  var topReasons = {};
  var sample = [];
  for (var i = 0; i < candidates.length; i++) {
    var raw = candidates[i] || {};
    var ticker = safeTelegramText(raw.ticker, 16, '');
    var stageInfo = stageByTicker[ticker] || { stage: 'public_safety', candidate: raw };
    var c = stageInfo.candidate || raw;
    var reason = getDayTradeTelegramRejectionReason(c, stageInfo.stage);
    topReasons[reason] = (topReasons[reason] || 0) + 1;
    var rejectionType = classifyDayTradeTelegramRejection(c, stageInfo.stage, reason);
    if (!counts.rejection_types) counts.rejection_types = {};
    counts.rejection_types[rejectionType] = (counts.rejection_types[rejectionType] || 0) + 1;
    if (sample.length < 10) sample.push({
      ticker: ticker || null,
      action_label: c.telegram_action_label || c.action_label || c.signal_action_label || null,
      action: c.action || c.signal_action || null,
      verdict: c.signal_verdict || c.verdict || c.telegram_verdict || null,
      status: c.status || c.final_status || null,
      setup_freshness_status: c.setup_freshness_status || c.freshness_status || null,
      setup_freshness_label: c.setup_freshness_label || c.freshness_label || null,
      entry_quality_label: c.entry_quality_label || c.entry_status_label || null,
      plan_quality_label: c.plan_quality_label || c.plan_label || null,
      trading_plan_valid: c.trading_plan_valid,
      final_quality_reason: (c.final_top_quality_gate && c.final_top_quality_gate.reason) || c.excluded_reason || null,
      rejection_reason: reason,
      rejection_type: rejectionType
    });
  }
  var radarRejected = counts.radar_rejected || [];
  var radarReasons = {};
  radarRejected.forEach(function(c) {
    var reason = getDayTradeTelegramRejectionReason(c, 'radar_fallback');
    radarReasons[reason] = (radarReasons[reason] || 0) + 1;
  });
  var sampleRadar = radarRejected.slice(0, 10).map(function(c) {
    var reason = getDayTradeTelegramRejectionReason(c, 'radar_fallback');
    var entry1 = toNum(c.entry1) || getEntry1(c);
    var entry2 = toNum(c.entry2) || getEntry2(c);
    var sl = toNum(c.sl || c.stop_loss);
    var tp1 = toNum(c.tp1n || c.tp1);
    var liq = deriveStaleLiquidityLabels(c);
    return {
      ticker: safeTelegramText(c.ticker, 16, '') || null,
      status: c.status || c.final_status || null,
      action: c.action || c.signal_action || c.telegram_action_label || c.action_label || null,
      risk_label: deriveTelegramRiskLabel(c, 'daytrade'),
      freshness: c.setup_freshness_status || c.freshness_status || c.setup_freshness_label || c.freshness_label || null,
      liquidity_label: liq.liquidity_label || c.liquidity_label || null,
      has_entry: !!((entry1 > 0) && (entry2 > 0)),
      has_sl: !!(sl > 0),
      has_tp1: !!(tp1 > 0),
      rr: toNum(c.risk_reward) || null,
      min_tp1_pass: candidatePassesMinUpside(c),
      rejection_reason: reason
    };
  });
  return {
    scanned_count: counts.scanned_count,
    published_count: counts.published_count,
    raw_candidates_count: candidates.length,
    min_tp1_pass_count: counts.min_tp1_pass_count || 0,
    public_safe_count: counts.public_safe_count || 0,
    filtered_count: Math.max(0, candidates.length - (counts.public_safe_count || 0)),
    radar_requested: !!counts.radar_requested,
    radar_count: (counts.radar_candidates || []).length,
    radar_candidates: (counts.radar_candidates || []).map(function(r) { return r.ticker; }),
    radar_blocked_count: radarRejected.length,
    radar_rejection_reasons: radarReasons,
    sample_radar_rejected: sampleRadar,
    top_rejection_reasons: topReasons,
    rejection_types: counts.rejection_types || {},
    sample_rejected: sample
  };
}


function getDayTradeRadarStatus(candidate) {
  var raw = safeTelegramText(candidate && (candidate.status || candidate.final_status || candidate.action || candidate.signal_action || candidate.telegram_action_label || candidate.action_label), 120, '').toUpperCase().replace(/[\s-]+/g, '_');
  var allowed = { MOMENTUM_CONTINUATION: true, WAIT_PULLBACK: true, EARLY_RADAR: true, PRE_SPIKE_WATCH: true, RECLAIM_CANDIDATE: true, WATCHLIST: true };
  if (allowed[raw]) return raw;
  if (raw.indexOf('MOMENTUM') >= 0) return 'MOMENTUM_CONTINUATION';
  if (raw.indexOf('WAIT_PULLBACK') >= 0 || raw.indexOf('PULLBACK') >= 0) return 'WAIT_PULLBACK';
  if (raw.indexOf('EARLY_RADAR') >= 0) return 'EARLY_RADAR';
  if (raw.indexOf('PRE_SPIKE') >= 0) return 'PRE_SPIKE_WATCH';
  if (raw.indexOf('RECLAIM') >= 0) return 'RECLAIM_CANDIDATE';
  if (raw.indexOf('WATCHLIST') >= 0 || raw.indexOf('PANTAU') >= 0) return 'WATCHLIST';
  return null;
}

function candidatePassesDayTradeRadarFallbackGate(candidate) {
  if (!candidate || !candidate.ticker) return false;
  if (!candidatePassesPotentialRadarGate(candidate, 'daytrade')) return false;
  var status = getDayTradeRadarStatus(candidate) || getPotentialRadarReason(candidate);
  var allText = joinTelegramTexts([
    candidate.status, candidate.final_status, candidate.action_label, candidate.signal_action_label, candidate.telegram_action_label,
    candidate.action, candidate.signal_action, candidate.telegram_verdict, candidate.signal_verdict, candidate.verdict, candidate.reason,
    candidate.status_reason, candidate.action_reason, candidate.signal_reason, candidate.excluded_reason, candidate.final_quality_status,
    candidate.final_gate_status, candidate.quality_gate_status, candidate.plan_quality_label, candidate.plan_quality_note,
    candidate.entry_quality_label, candidate.entry_status_label, candidate.entry_safety_note, candidate.stale_notes, candidate.liquidity_notes
  ]).toLowerCase();
  var finalOnlyReject = includesAny(allText, ['tidak lolos final quality gate']);
  var generatedWatchlistAvoid = includesAny(String(candidate.status || candidate.final_status || candidate.breakout_confirmation_status || candidate.entry_status || '').toUpperCase(), ['WAIT_PULLBACK', 'BREAKOUT_WATCH', 'NEEDS_CLOSE_CONFIRMATION', 'PRE_SPIKE_WATCH']);
  if ((!finalOnlyReject && !generatedWatchlistAvoid && includesAny(allText, ['hindari', 'avoid'])) || includesAny(allText, ['very high risk', 'invalid plan', 'plan invalid', 'level belum rapi', 'stale', 'expired', 'weak liquidity', 'likuiditas lemah', 'likuiditas tipis', 'volume lemah', 'weak volume'])) return false;
  if (candidate.trading_plan_valid === false) return false;
  var freshnessStatus = safeTelegramText(candidate.setup_freshness_status || candidate.freshness_status || candidate.entry_quality_status || '', 80, '').toUpperCase();
  if (freshnessStatus === 'EXPIRED' || freshnessStatus === 'NEEDS_REVALIDATION') return false;
  if (candidate.is_stale === true || candidate.data_stale === true || candidate.freshness_is_stale === true || candidate.stale === true) return false;
  if (!finalOnlyReject && deriveTelegramRiskLabel(candidate, 'daytrade').toUpperCase() === 'VERY HIGH RISK') return false;
  var liq = deriveStaleLiquidityLabels(candidate);
  if (liq.is_stale || liq.is_liquidity_risk) return false;
  var entry1 = toNum(candidate.entry1) || getEntry1(candidate);
  var entry2 = toNum(candidate.entry2) || getEntry2(candidate);
  var sl = toNum(candidate.sl || candidate.stop_loss);
  var tp1 = toNum(candidate.tp1n || candidate.tp1);
  if (!(entry1 > 0) || !(entry2 > 0) || !(sl > 0) || !(tp1 > 0)) return false;
  if (!((toNum(candidate.risk_reward) || 0) > 0)) return false;
  if (!candidatePassesMinUpside(candidate)) return false;
  var finalRejected = candidate.final_quality_pass === false || candidate.final_gate_pass === false || candidate.quality_gate_pass === false || (candidate.final_top_quality_gate && candidate.final_top_quality_gate.pass === false);
  if (finalRejected) {
    var benign = includesAny(allText, ['not entry-ready yet', 'not entry ready yet', 'needs close confirmation', 'close confirmation', 'watchlist only', 'entry not touched', 'mtf mixed', 'chase warning', 'tunggu konfirmasi', 'tunggu close', 'belum entry']);
    if (!benign) return false;
  }
  return true;
}

function sortDayTradeRadarCandidates(a, b) {
  function gradeRank(x) { var g = safeTelegramText(x.confidence || x.quality_grade || x.grade || getTelegramGrade(x), 10, 'C').toUpperCase(); return g.indexOf('A') === 0 ? 0 : (g.indexOf('B') === 0 ? 1 : 2); }
  function riskRank(x) { var r = deriveTelegramRiskLabel(x, 'daytrade').toUpperCase(); return r.indexOf('MEDIUM') >= 0 ? 0 : (r.indexOf('HIGH') >= 0 ? 1 : (r.indexOf('LOW') >= 0 ? 2 : 3)); }
  var ga = gradeRank(a), gb = gradeRank(b); if (ga !== gb) return ga - gb;
  var ra = riskRank(a), rb = riskRank(b); if (ra !== rb) return ra - rb;
  if ((toNum(b.risk_reward) || 0) !== (toNum(a.risk_reward) || 0)) return (toNum(b.risk_reward) || 0) - (toNum(a.risk_reward) || 0);
  var ae = Math.abs(toNum(a.entry_distance_pct) || 0), be = Math.abs(toNum(b.entry_distance_pct) || 0); if (ae !== be) return ae - be;
  return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || String(a.ticker || '').localeCompare(String(b.ticker || ''));
}

function sanitizeDayTradeRadarText(value, maxLen, fallback) {
  return safeTelegramText(value, maxLen, fallback)
    .replace(/siap\s+beli/ig, 'tunggu konfirmasi')
    .replace(/entry\s+valid/ig, 'konfirmasi entry')
    .replace(/valid\s+entry/ig, 'konfirmasi entry');
}

function formatDayTradeRadarTelegramMessage(results) {
  var now = new Date();
  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  var wib = new Date(wibMs);
  var months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  var timeStr = wib.getUTCDate() + ' ' + months[wib.getUTCMonth()] + ' ' + wib.getUTCFullYear() + ', ' + wib.toISOString().slice(11, 16) + ' WIB';
  var lines = ['[RADAR — BUKAN SINYAL ENTRY]', '🚀 Day Trade Radar', 'Update: ' + timeStr, '', 'Belum ada kandidat Entry valid yang lolos final safety gate.', 'Radar pantauan berikut belum menjadi sinyal entry.', ''];
  results.forEach(function(r, i) {
    var setup = getDayTradeRadarStatus(r) || 'WATCHLIST';
    var trigger = sanitizeDayTradeRadarText(r.breakout_confirmation_label || r.breakout_confirmation_note || r.entry_timing || r.telegram_verdict, 100, 'Tunggu close confirmation / volume tetap masuk');
    var note = sanitizeDayTradeRadarText(r.entry_safety_note || r.plan_quality_note || 'Radar pantauan, bukan sinyal entry.', 110, 'Radar pantauan, bukan sinyal entry.');
    lines.push((i + 1) + '. ' + r.ticker + ' — ' + setup.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, function(c) { return c.toUpperCase(); }));
    lines.push('Harga: ' + fmtPrice(r.lastn || r.last_price) + ' | Entry: ' + fmtPrice(r.entry1) + ' / ' + fmtPrice(r.entry2) + ' | SL: ' + fmtPrice(r.sl) + ' | TP: ' + fmtPrice(r.tp1n) + ' / ' + fmtPrice(r.tp2n || r.tp2));
    lines.push('EntryQ: ' + compactSafeText(r.entry_quality_label || r.entry_status_label, '-') + ' · PlanQ: ' + compactSafeText(r.plan_quality_label || r.plan_label, '-'));
    lines.push('Trigger: ' + trigger);
    lines.push('Note: ' + note);
    lines.push('');
  });
  if (lines[lines.length - 1] === '') lines.pop();
  lines.push('Bukan rekomendasi beli. Konfirmasi manual wajib.');
  return lines.join('\n');
}

async function sendDayTradeTelegramNotification(supabase, runId, runDate, publishedCount, sendEmptyNotice, sendRadarFallback, options) {
  options = options || {};
  var forceRadarDebug = options.force_radar_debug === true;
  var duplicateRunHit = _dtTelegramLastRunId === runId;
  var allowRadarRetry = duplicateRunHit && sendRadarFallback && _dtTelegramLastRunReason === 'no_final_quality_gate_candidates' && _dtTelegramLastRadarRunId !== runId;
  // Duplicate guard: same run_id = don't send the normal Signal twice, but allow one explicit radar retry after a silent no-signal result.
  if (duplicateRunHit && !allowRadarRetry && !forceRadarDebug) {
    return { sent: false, skipped: true, reason: (_dtTelegramLastRadarRunId === runId && sendRadarFallback) ? 'duplicate_radar_run_id' : 'duplicate_run_id', duplicate_guard_hit: true, radar_requested: !!sendRadarFallback };
  }

  // 0 candidates: do not send empty/no-signal Telegram messages
  if (publishedCount === 0) {
    _dtTelegramLastRunId = runId;
    _dtTelegramLastRunReason = 'no_published_rows';
    return { sent: false, skipped: true, reason: 'no_published_rows', radar_requested: !!sendRadarFallback, duplicate_guard_hit: duplicateRunHit };
  }

  try {
    // Fetch top 50 published Day Trade rows (same data web displays)
    var { data: candidates, error: readErr } = await supabase
      .from('daytrade_screener_latest')
      .select('*')
      .order('daytrade_score', { ascending: false })
      .limit(50);

    if (readErr || !candidates || candidates.length === 0) {
      _dtTelegramLastRunId = runId;
      _dtTelegramLastRunReason = 'no_data_to_send';
      return { sent: false, skipped: true, reason: 'no_data_to_send', published_count: publishedCount, raw_candidate_count: 0, radar_requested: !!sendRadarFallback, duplicate_guard_hit: duplicateRunHit };
    }

    var rawCount = candidates.length;

    // === CANDIDATE SELECTION (using REAL DB fields only) ===
    // Real columns: status, daytrade_score, risk_reward, volume_ratio_20d, entry_low, entry_high, etc.
    // quality_grade/risk_label are NOT in DB — use status + score for selection.

    var metaRes = await supabase.from('daytrade_screener_meta').select('calculated_at,updated_at,run_date,run_id,status').eq('id', 'latest').maybeSingle();
    var daytradeMeta = metaRes && metaRes.data ? metaRes.data : { calculated_at: null };

    // Step 1: Deterministic Telegram verification filters INVALID/AVOID, very high risk, weak RR,
    // stale/revalidation setups, and final quality-gate failures before public output.
    var stageByTicker = {};
    var verifiedCandidates = [];
    candidates.forEach(function(raw) {
      var ticker = safeTelegramText(raw && raw.ticker, 16, '');
      var verified = verifyTelegramSignal(raw, 'daytrade');
      if (verified) verifiedCandidates.push(verified);
      else stageByTicker[ticker] = { stage: 'verify_signal', candidate: raw };
    });
    var highConvictionCandidates = [];
    verifiedCandidates.forEach(function(verified) {
      var ticker = safeTelegramText(verified && verified.ticker, 16, '');
      var high = verifyHighConvictionTelegramSignal(verified, 'daytrade');
      if (high) highConvictionCandidates.push(high);
      else stageByTicker[ticker] = { stage: 'high_conviction', candidate: verified };
    });
    var normalizedCandidates = highConvictionCandidates.map(function(r) { return attachFreshness(normalizeCombinedCandidate(r, 'Day Trade'), daytradeMeta); });
    var minTp1Candidates = [];
    normalizedCandidates.forEach(function(normalized) {
      var ticker = safeTelegramText(normalized && normalized.ticker, 16, '');
      if (candidatePassesMinUpside(normalized)) minTp1Candidates.push(normalized);
      else stageByTicker[ticker] = { stage: 'min_tp1', candidate: normalized };
    });
    var radarPool = normalizedCandidates.map(function(normalized) { return Object.assign({}, normalized); });
    var radarRejected = [];
    var radarCandidates = radarPool.filter(function(r) {
      var pass = candidatePassesDayTradeRadarFallbackGate(r);
      if (!pass) radarRejected.push(r);
      return pass;
    }).sort(sortDayTradeRadarCandidates).slice(0, 3);
    if (sendRadarFallback && radarCandidates.length === 0) {
      radarCandidates = radarPool.filter(function(r) { return candidatePassesPotentialRadarGate(r, 'daytrade') || !!getDayTradeRadarStatus(r); }).sort(sortDayTradeRadarCandidates).slice(0, 3);
    }

    var nonAvoid = [];
    minTp1Candidates.forEach(function(normalized) {
      var ticker = safeTelegramText(normalized && normalized.ticker, 16, '');
      if (candidatePassesDayTradeTelegramFinalGate(normalized)) nonAvoid.push(normalized);
      else stageByTicker[ticker] = { stage: 'public_safety', candidate: normalized };
    });

    // Step 2: Prioritize actionable setups
    var setupPriority = { 'A_PLUS_SETUP': 0, 'TRADE_CANDIDATE': 1, 'READY_BREAKOUT': 2, 'PRE_SPIKE_WATCH': 3, 'EARLY_RADAR': 4, 'MOMENTUM_CONTINUATION': 5, 'RECLAIM_CANDIDATE': 6, 'WAIT_PULLBACK': 7, 'SPECULATIVE': 8 };
    var actionable = nonAvoid.filter(function(r) {
      var pri = setupPriority[r.status];
      return pri != null && pri <= 6;
    });

    // Step 3: If not enough, include WAIT_PULLBACK/SPECULATIVE with strong confirmation
    if (actionable.length < 5) {
      var seenActionable = {}; actionable.forEach(function(r) { seenActionable[r.ticker] = true; });
      var watchlist = nonAvoid.filter(function(r) {
        return !seenActionable[r.ticker] && (r.status === 'WAIT_PULLBACK' || r.status === 'SPECULATIVE') && (r.daytrade_score || 0) >= 60;
      }).slice(0, 5 - actionable.length);
      actionable = actionable.concat(watchlist);
    }

    // Step 4: Sort by priority then score
    actionable.sort(function(a, b) {
      var pa = setupPriority[a.status] != null ? setupPriority[a.status] : 9;
      var pb = setupPriority[b.status] != null ? setupPriority[b.status] : 9;
      if (pa !== pb) return pa - pb;
      return (b.telegram_conviction_score || 0) - (a.telegram_conviction_score || 0) || (b.daytrade_score || 0) - (a.daytrade_score || 0);
    });

    actionable.sort(function(a, b) { return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); });
    var finalList = actionable.slice(0, 5);
    var headerNote = '';

    // Step 5: Fallback — if still empty but published_count > 0
    if (finalList.length === 0 && nonAvoid.length > 0) {
      nonAvoid.sort(function(a, b) { return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); });
      finalList = nonAvoid.slice(0, 5);
      headerNote = 'Tidak ada kandidat A/B bersih, menampilkan watchlist terbaik.';
    }

    var diagnostics = buildDayTradeTelegramDiagnostics(candidates, stageByTicker, {
      scanned_count: publishedCount,
      published_count: publishedCount,
      min_tp1_pass_count: minTp1Candidates.length,
      public_safe_count: nonAvoid.length,
      radar_requested: !!sendRadarFallback,
      radar_candidates: radarCandidates,
      radar_rejected: radarRejected
    });

    // Step 6: If no candidate survives the public Telegram final gate, stay silent by default.
    if (finalList.length === 0) {
      _dtTelegramLastRunId = runId;
      _dtTelegramLastRunReason = 'no_final_quality_gate_candidates';
      var silentResult = {
        sent: false,
        skipped: true,
        reason: 'no_final_quality_gate_candidates',
        published_count: publishedCount,
        raw_candidate_count: rawCount,
        raw_candidates_count: rawCount,
        verified_count: verifiedCandidates.length,
        high_conviction_count: highConvictionCandidates.length,
        min_tp1_pass_count: minTp1Candidates.length,
        public_safe_count: 0,
        selected_count: 0,
        filtered_out_count: rawCount,
        duplicate_guard_hit: duplicateRunHit,
        radar_requested: !!sendRadarFallback,
        force_radar_debug: forceRadarDebug,
        diagnostics: diagnostics,
        admin_radar_summary: [
          'Belum ada kandidat Entry valid yang lolos final safety gate.',
          'Radar pantauan tersedia di web screener, tetapi belum lolos public Telegram safety gate.'
        ]
      };
      silentResult.signal_safe_count = 0;
      silentResult.radar_count = radarCandidates.length;
      silentResult.radar_sent = false;
      silentResult.radar_candidates = radarCandidates.map(function(r) { return r.ticker; });
      silentResult.radar_blocked_count = diagnostics.radar_blocked_count;
      silentResult.radar_rejection_reasons = diagnostics.radar_rejection_reasons;
      silentResult.sample_radar_rejected = diagnostics.sample_radar_rejected;
      if (sendRadarFallback && _dtTelegramLastRadarRunId === runId) return Object.assign(silentResult, { reason: 'duplicate_radar_run_id', duplicate_guard_hit: true });
      if (forceRadarDebug && duplicateRunHit && !allowRadarRetry) return silentResult;
      if (sendRadarFallback && radarCandidates.length > 0) {
        var radarMsg = formatDayTradeRadarTelegramMessage(radarCandidates);
        var radarResult = await telegramNotifier.sendTelegramMessage(radarMsg);
        radarResult.reason = 'no_final_quality_gate_candidates';
        radarResult.message = radarMsg;
        if (radarResult.sent) _dtTelegramLastRadarRunId = runId;
        return Object.assign(silentResult, radarResult, { skipped: !radarResult.sent, radar_sent: !!radarResult.sent, radar_count: radarCandidates.length, radar_candidates: radarCandidates.map(function(r) { return r.ticker; }) });
      }
      return silentResult;
    }

    if (duplicateRunHit && forceRadarDebug) {
      return {
        sent: false,
        skipped: true,
        reason: 'duplicate_run_id',
        duplicate_guard_hit: true,
        radar_requested: !!sendRadarFallback,
        force_radar_debug: true,
        published_count: publishedCount,
        raw_candidate_count: rawCount,
        selected_count: finalList.length,
        diagnostics: diagnostics,
        radar_count: radarCandidates.length,
        radar_candidates: radarCandidates.map(function(r) { return r.ticker; }),
        radar_blocked_count: diagnostics.radar_blocked_count,
        radar_rejection_reasons: diagnostics.radar_rejection_reasons,
        sample_radar_rejected: diagnostics.sample_radar_rejected
      };
    }

    // Format message
    var dtRunMode = (finalList[0] && finalList[0].run_mode) ? finalList[0].run_mode.toUpperCase() : null;
    var msg = formatDayTradeTelegramMessage(finalList, runDate, headerNote, { run_mode: dtRunMode, published_count: publishedCount });

    // Send
    var result = await telegramNotifier.sendTelegramMessage(msg);
    _dtTelegramLastRunId = runId;
    _dtTelegramLastRunReason = result.sent ? 'sent_signal' : (result.reason || 'telegram_send_failed');
    result.published_count = publishedCount;
    result.raw_candidate_count = rawCount;
    result.selected_count = finalList.length;
    result.filtered_out_count = rawCount - finalList.length;
    result.verified_count = verifiedCandidates.length;
    result.high_conviction_count = highConvictionCandidates.length;
    result.min_tp1_pass_count = minTp1Candidates.length;
    result.public_safe_count = nonAvoid.length;
    return result;
  } catch (e) {
    return { sent: false, skipped: false, reason: 'exception', error_message: (e.message || '').substring(0, 80), published_count: publishedCount };
  }
}

function formatDayTradeTelegramMessage(results, runDate, headerNote, meta) {
  var now = new Date();
  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  var wib = new Date(wibMs);
  var months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  var timeStr = wib.getUTCDate() + ' ' + months[wib.getUTCMonth()] + ' ' + wib.getUTCFullYear() + ', ' + wib.toISOString().slice(11, 16) + ' WIB';

  meta = meta || {};
  var lines = [];
  lines.push('\uD83D\uDE80 Day Trade Signal');
  lines.push('Update: ' + timeStr);
  if (headerNote) lines.push(headerNote);
  lines.push('');

  for (var i = 0; i < results.length; i++) {
    lines.push(fmtTelegramSignalBlock(results[i], i + 1, 'daytrade'));
    lines.push('');
  }

  if (lines[lines.length - 1] === '') lines.pop();
  lines.push('Bukan rekomendasi beli. Konfirmasi manual wajib.');
  return lines.join('\n');
}

function formatDayTradeNoCandidateTelegramMessage() {
  var now = new Date();
  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  var wib = new Date(wibMs);
  var months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  var timeStr = wib.getUTCDate() + ' ' + months[wib.getUTCMonth()] + ' ' + wib.getUTCFullYear() + ', ' + wib.toISOString().slice(11, 16) + ' WIB';
  return [
    '\uD83D\uDE80 Day Trade Signal',
    'Update: ' + timeStr,
    '',
    'Belum ada kandidat day trade yang lolos final quality gate hari ini.',
    'Bukan rekomendasi beli. Konfirmasi manual wajib.'
  ].join('\n');
}

// Shorten context label for Telegram (remove "(approx 5D)"/"(approx 20D)" suffix, keep meaning)
function shortenContext(ctx) {
  if (!ctx) return '-';
  // Remove "(approx XD)" suffix
  var clean = ctx.replace(/\s*\(approx \d+D\)/g, '').trim();
  // Capitalize first letter
  if (clean.length > 0) clean = clean.charAt(0).toUpperCase() + clean.slice(1);
  return clean || '-';
}

// Short setup meaning for Telegram (compact)
function getTelegramSetupMeaning(status) {
  status = safeTelegramText(status, 80, '');
  if (!status) return null;
  var s = status.toUpperCase().replace(/[_\s]+/g, '_');
  var map = {
    'A_PLUS_SETUP': 'Setup A+, konfirmasi lengkap.',
    'TRADE_CANDIDATE': 'Kandidat trade kuat, butuh chart confirm.',
    'READY_BREAKOUT': 'Siap pantau breakout, entry jika konfirmasi.',
    'PRE_SPIKE_WATCH': 'Radar pre-spike, tunggu volume confirm.',
    'EARLY_RADAR': 'Sinyal awal, belum entry.',
    'MOMENTUM_CONTINUATION': 'Momentum berjalan, jangan chase.',
    'RECLAIM_CANDIDATE': 'Kandidat reclaim, valid jika hold.',
    'WAIT_PULLBACK': 'Tunggu pullback, jangan chase.',
    'SPECULATIVE': 'Spekulatif, size kecil wajib.',
    'AVOID': 'Hindari, risiko tinggi.'
  };
  return map[s] || null;
}

function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string') {
    var cleaned = v.trim().replace(/,/g, '.');
    if (!cleaned || cleaned.toLowerCase() === 'null' || cleaned.toLowerCase() === 'undefined' || cleaned === '[object Object]') return null;
    var n = Number(cleaned);
    return isFinite(n) ? n : null;
  }
  return null;
}

function fmtPrice(v) { var n = toNum(v); return n != null && n > 0 ? n.toLocaleString('id-ID') : '-'; }
function fmtRR(v) { var n = toNum(v); return n != null ? n.toFixed(2) : '-'; }
function fmtScore(v) { var n = toNum(v); return n != null ? Math.round(n) : 0; }

function safeTelegramText(value, maxLen, fallback) {
  fallback = fallback == null ? '-' : fallback;
  if (value == null) return fallback;
  if (typeof value === 'object') return fallback;
  var text = String(value).replace(/[\r\n\t]+/g, ' ').replace(/<[^>]*>/g, '').replace(/\s{2,}/g, ' ').trim();
  var low = text.toLowerCase();
  if (!text || low === 'undefined' || low === 'null' || text === '[object Object]' || low === 'nan') return fallback;
  maxLen = maxLen || 80;
  if (text.length > maxLen) text = text.slice(0, Math.max(0, maxLen - 1)).trim() + '…';
  return text;
}

function hasTelegramText(value) { return safeTelegramText(value, 80, '') !== ''; }

// Format transaction value in Rupiah (Indonesian units: M = Miliar, T = Triliun)
function fmtRpValue(v) {
  var n = toNum(v);
  if (n == null || n <= 0) return '-';
  if (n >= 1e12) return 'Rp' + (n / 1e12).toFixed(1).replace('.', ',') + ' T';
  if (n >= 1e9) return 'Rp' + (n / 1e9).toFixed(1).replace('.', ',') + ' M';
  if (n >= 1e6) return 'Rp' + (n / 1e6).toFixed(0) + ' jt';
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
}

// Format volume ratio (always with "x" suffix)
function fmtRatio(v) { var n = toNum(v); return n != null ? n.toFixed(2).replace('.', ',') + 'x' : '-'; }

function getTelegramScore(r, mode) {
  var n = mode === 'daytrade' ? toNum(r.daytrade_score) : toNum(r.score);
  if (n == null) n = toNum(r.score || r.daytrade_score);
  return n != null ? Math.round(n) : 0;
}

function getTelegramGrade(r) {
  return safeTelegramText(r.quality_grade || r.grade, 20, '-');
}

function isTelegramWaitPullbackStatus(status) {
  var s = safeTelegramText(status, 100, '').toUpperCase().replace(/[_-]+/g, ' ');
  return s.indexOf('WAIT PULLBACK') >= 0;
}

function isBadTelegramStatus(status) {
  var s = safeTelegramText(status, 100, '').toUpperCase();
  return s.indexOf('INVALID') >= 0 || s.indexOf('AVOID') >= 0;
}

function includesAny(text, words) {
  var t = safeTelegramText(text, 300, '').toLowerCase();
  for (var i = 0; i < words.length; i++) if (t.indexOf(words[i]) >= 0) return true;
  return false;
}

function joinTelegramTexts(parts) {
  return parts.map(function(p) { return safeTelegramText(p, 120, ''); }).filter(Boolean).join(' | ');
}

function normalizeTelegramRiskLabel(value) {
  var raw = safeTelegramText(value, 50, '').trim();
  if (!raw) return '';
  var key = raw.toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (key === 'LOW' || key === 'LOW RISK' || key === 'RISIKO RENDAH') return 'Low Risk';
  if (key === 'MEDIUM' || key === 'MEDIUM RISK' || key === 'MODERATE' || key === 'MODERATE RISK' || key === 'RISIKO SEDANG') return 'Medium Risk';
  if (key === 'HIGH' || key === 'HIGH RISK' || key === 'RISIKO TINGGI') return 'High Risk';
  if (key === 'VERY HIGH' || key === 'VERY HIGH RISK' || key === 'EXTREME' || key === 'EXTREME RISK' || key === 'RISIKO SANGAT TINGGI') return 'Very High Risk';
  return raw;
}

function deriveTelegramRiskLabel(r, mode) {
  var risk = normalizeTelegramRiskLabel(r.risk_label_v2 || r.risk_label || r.verified_risk_label);
  var rr = toNum(r.risk_reward) || 0;
  var score = getTelegramScore(r, mode);
  if (!risk) {
    risk = rr >= 2.2 && score >= 80 ? 'Low Risk' : (rr >= 1.5 ? 'Medium Risk' : 'High Risk');
  }

  var tf1 = safeTelegramText(r.tf_1d_context || r.daily_candle_context, 80, '').toLowerCase();
  var tf5 = safeTelegramText(r.tf_5d_context || r.weekly_candle_context, 80, '').toLowerCase();
  var chg = toNum(r.change_pct);
  var bearish1d = tf1.indexOf('red') >= 0 || tf1.indexOf('merah') >= 0 || tf1.indexOf('bearish') >= 0;
  var bearish5d = tf5.indexOf('bearish') >= 0 || tf5.indexOf('down') >= 0 || tf5.indexOf('turun') >= 0;
  var largeNegativeMove = (chg != null && chg <= -3) || tf5.indexOf('strong bearish') >= 0 || tf5.indexOf('bearish kuat') >= 0;
  if (risk === 'Low Risk' && bearish1d && bearish5d && largeNegativeMove) risk = 'Medium Risk';
  return risk;
}

function verifyTelegramSignal(row, mode) {
  if (!row) return null;
  var status = row.status || row.final_status || '';
  if (isBadTelegramStatus(status)) return null;

  var rr = toNum(row.risk_reward);
  if (rr == null || rr < 1.3) return null;

  var verifiedRisk = deriveTelegramRiskLabel(row, mode);
  if (verifiedRisk.toUpperCase() === 'VERY HIGH RISK') return null;

  var r = Object.assign({}, row);
  r.verified_risk_label = verifiedRisk;

  var s = safeTelegramText(status, 100, '').toUpperCase();
  var tfText = joinTelegramTexts([r.tf_1d_context, r.tf_3d_context, r.tf_5d_context, r.tf_20d_context]).toLowerCase();
  var noteText = joinTelegramTexts([r.notes, r.status_reason, r.entry_timing, r.time_plan, r.volume_notes, r.grade_reason]).toLowerCase();
  var volPhase = safeTelegramText(r.volume_phase, 80, '').toLowerCase();
  var score = getTelegramScore(r, mode);
  var volRatio = toNum(r.volume_ratio_20d || r.volume_ratio_avg20 || r.volume_today_vs_7d);
  var last = toNum(r.last_price);
  var tp1 = toNum(r.tp1);
  var closeToTp = last != null && tp1 != null && last > 0 && tp1 > last && ((tp1 - last) / last) < 0.03;
  var badNotes = includesAny(noteText, ['chase', 'late', 'telat', 'failed', 'gagal', 'distribusi']);
  var cautionText = tfText + ' ' + volPhase + ' ' + noteText;
  var weakMomentum = includesAny(cautionText, ['weak', 'lemah', 'mixed', 'doji', 'indecision', 'ragu', 'bearish', 'merah', 'distribution', 'distribusi']);
  var supportive = rr >= 1.5 && score >= 70 && (!volRatio || volRatio >= 1.0) && !weakMomentum && !closeToTp && !badNotes;

  if (badNotes || closeToTp) {
    r.telegram_action_label = badNotes && includesAny(noteText, ['failed', 'gagal', 'distribusi']) ? 'Skip dulu' : 'Pantau saja';
    r.telegram_verdict = closeToTp ? 'Pantau saja. Entry terlalu dekat TP/resistance, tunggu pullback valid.' : 'Skip dulu. Ada sinyal chase/late/failed/distribusi.';
  } else if (isTelegramWaitPullbackStatus(s)) {
    r.telegram_action_label = 'Tunggu pullback valid';
    r.telegram_verdict = 'Tunggu pullback valid, jangan chase.';
  } else if (s.indexOf('MOMENTUM_CONTINUATION') >= 0) {
    r.telegram_action_label = 'Pantau saja';
    r.telegram_verdict = 'Momentum berjalan. Jangan chase, tunggu entry valid.';
  } else if (weakMomentum) {
    r.telegram_action_label = 'Pantau dulu';
    r.telegram_verdict = 'Pantau dulu. Momentum masih lemah/mixed, tunggu konfirmasi.';
  } else if ((s.indexOf('READY') >= 0 || s.indexOf('TRADE_CANDIDATE') >= 0 || s.indexOf('A_PLUS') >= 0) && supportive) {
    r.telegram_action_label = 'Siap pantau';
    r.telegram_verdict = 'Siap pantau entry valid jika harga/volume konfirmasi.';
  } else {
    r.telegram_action_label = 'Tunggu konfirmasi';
    r.telegram_verdict = 'Tunggu konfirmasi. Jangan entry agresif.';
  }

  return r;
}

function getTelegramValue(r) {
  return toNum(r.tx_value_1d || r.value_today || r.avg_tx_value_7d || r.avg_value_7d) || 0;
}

function getTelegramVolumeRatio(r) {
  return toNum(r.volume_ratio_20d || r.volume_ratio_avg20 || r.volume_today_vs_7d || r.volume_today_vs_3d);
}

function isTelegramTfSupportive(r) {
  var tf1 = safeTelegramText(r.tf_1d_context, 80, '').toLowerCase();
  var tf5 = safeTelegramText(r.tf_5d_context, 80, '').toLowerCase();
  var tf20 = safeTelegramText(r.tf_20d_context, 80, '').toLowerCase();
  var joined = tf1 + ' ' + tf5 + ' ' + tf20;
  var bad = includesAny(joined, ['bearish', 'merah', 'down', 'turun', 'weak', 'lemah']);
  var good = includesAny(joined, ['bullish', 'hijau', 'reclaim', 'breakout', 'support', 'uptrend']);
  return good && !bad;
}

function hasStrongTelegramConfirmation(r, mode) {
  var status = safeTelegramText(r.status || r.final_status, 100, '').toUpperCase();
  var rr = toNum(r.risk_reward) || 0;
  var score = getTelegramScore(r, mode);
  var value = getTelegramValue(r);
  var vol = getTelegramVolumeRatio(r);
  var tfOk = isTelegramTfSupportive(r);
  var statusOk = status.indexOf('READY') >= 0 || status.indexOf('TRADE_CANDIDATE') >= 0 || status.indexOf('A_PLUS') >= 0 || status.indexOf('BREAKOUT') >= 0 || status.indexOf('RECLAIM') >= 0;
  return score >= 80 && rr >= (mode === 'swing' ? 1.5 : 1.3) && statusOk && (tfOk || (vol != null && vol >= 1.2) || value >= 5000000000);
}

function computeTelegramConvictionScore(r, mode) {
  var score = getTelegramScore(r, mode);
  var rr = toNum(r.risk_reward) || 0;
  var grade = getTelegramGrade(r).toUpperCase();
  var risk = normalizeTelegramRiskLabel(r.risk_label_v2 || r.verified_risk_label || r.risk_label).toUpperCase();
  var value = getTelegramValue(r);
  var vol = getTelegramVolumeRatio(r);
  var status = safeTelegramText(r.status || r.final_status, 100, '').toUpperCase();
  var noteText = joinTelegramTexts([r.notes, r.status_reason, r.entry_timing, r.time_plan, r.volume_notes, r.grade_reason]).toLowerCase();
  var conviction = Math.min(40, score * 0.4);
  if (rr >= 2.5) conviction += 16; else if (rr >= 2) conviction += 12; else if (rr >= 1.5) conviction += 8; else if (rr >= 1.3) conviction += 4;
  if (grade === 'A') conviction += 12; else if (grade === 'B') conviction += 8; else if (grade === 'C') conviction += 2; else if (grade === 'AVOID') conviction -= 30;
  if (risk === 'LOW RISK') conviction += 10; else if (risk === 'MEDIUM RISK') conviction += 6; else if (risk === 'HIGH RISK') conviction -= 8; else if (risk === 'VERY HIGH RISK') conviction -= 40;
  if (value >= 10000000000) conviction += 10; else if (value >= 3000000000) conviction += 6; else if (value > 0 && value < 750000000) conviction -= 12;
  if (vol != null) { if (vol >= 1.5) conviction += 10; else if (vol >= 1.0) conviction += 5; else if (vol < 0.8) conviction -= 12; }
  if (isTelegramTfSupportive(r)) conviction += 10;
  if (status.indexOf('READY') >= 0 || status.indexOf('TRADE_CANDIDATE') >= 0 || status.indexOf('A_PLUS') >= 0) conviction += 10;
  if (status.indexOf('WATCH') >= 0 || status.indexOf('EARLY') >= 0 || status.indexOf('SPECULATIVE') >= 0) conviction -= 8;
  if (includesAny(noteText, ['chase', 'late', 'telat', 'failed', 'gagal', 'distribusi'])) conviction -= 25;
  return Math.round(Math.max(0, Math.min(100, conviction)));
}

function verifyHighConvictionTelegramSignal(row, mode) {
  if (!row) return null;
  var r = Object.assign({}, row);
  var status = safeTelegramText(r.status || r.final_status, 100, '').toUpperCase();
  var grade = getTelegramGrade(r).toUpperCase();
  var rr = toNum(r.risk_reward) || 0;
  var value = getTelegramValue(r);
  var vol = getTelegramVolumeRatio(r);
  var strong = hasStrongTelegramConfirmation(r, mode);
  var noteText = joinTelegramTexts([r.notes, r.status_reason, r.entry_timing, r.time_plan, r.volume_notes, r.grade_reason]).toLowerCase();

  if (grade === 'AVOID') return null;
  if (mode === 'swing' && rr < 1.5) return null;
  if (mode === 'daytrade' && rr < 1.3) return null;
  if ((status.indexOf('WATCH') >= 0 || status.indexOf('EARLY') >= 0 || status.indexOf('SPECULATIVE') >= 0) && !strong) return null;
  if (value > 0 && value < 750000000 && !(getTelegramScore(r, mode) >= 90 && strong)) return null;
  if (vol != null && vol < 0.8 && !(value >= 5000000000 && isTelegramTfSupportive(r))) return null;
  if (includesAny(noteText, ['failed', 'gagal', 'distribusi'])) return null;

  var conviction = computeTelegramConvictionScore(r, mode);
  r.telegram_conviction_score = conviction;
  if (conviction < (mode === 'swing' ? 62 : 58)) return null;
  if (r.telegram_action_label === 'Pantau dulu' && !(conviction >= 82 && strong)) return null;

  if (isTelegramWaitPullbackStatus(status)) {
    r.telegram_action_label = 'Tunggu pullback';
    r.telegram_verdict = 'Tunggu pullback valid, jangan chase.';
  } else if (status.indexOf('MOMENTUM_CONTINUATION') >= 0) {
    r.telegram_action_label = 'Pantau entry valid jika konfirmasi';
    r.telegram_verdict = 'Momentum berjalan. Jangan chase, entry hanya jika pullback/volume valid.';
  } else if (status.indexOf('BREAKOUT') >= 0 || status.indexOf('RECLAIM') >= 0) {
    r.telegram_action_label = 'Pantau breakout/reclaim';
    r.telegram_verdict = 'Pantau breakout/reclaim valid dengan volume.';
  } else if (strong) {
    r.telegram_action_label = 'Siap pantau entry valid';
    r.telegram_verdict = 'Siap pantau entry valid jika harga dan volume tetap konfirmasi.';
  } else {
    r.telegram_action_label = 'Pantau breakout/reclaim';
    r.telegram_verdict = 'Pantau hanya jika konfirmasi lanjutan muncul.';
  }
  return r;
}

function fmtTelegramSignalBlock(r, idx, mode) {
  var entryLow = toNum(r.entry_low);
  var entryHigh = toNum(r.entry_high);
  var e1 = Math.max(entryLow || 0, entryHigh || 0);
  var e2 = Math.min(entryLow || 0, entryHigh || 0);
  if (e2 <= 0) e2 = e1;
  var score = getTelegramScore(r, mode);
  var statusLabel = safeTelegramText(r.status || r.final_status, 80, '-').replace(/_/g, ' ');
  var action = safeTelegramText(r.telegram_action_label, 40, 'Pantau dulu');
  var enrichedForGrade = enrichSignalQuality(r, mode === 'daytrade' ? 'Day Trade' : 'Swing');
  var grade = enrichedForGrade.confidence || getTelegramGrade(r);
  var risk = normalizeTelegramRiskLabel(r.risk_label_v2 || r.verified_risk_label || r.risk_label) || '-';
  var lines = [];
  lines.push(idx + '. ' + safeTelegramText(r.ticker, 16, '-') + ' — ' + action);
  lines.push('Status: ' + statusLabel);
  lines.push('G:' + grade + ' · ' + risk + ' · RR:' + fmtRR(r.risk_reward) + ' · Liq:' + safeTelegramText(enrichedForGrade.liquidity_label, 40, '-'));
  lines.push('EntryQ: ' + safeTelegramText(r.entry_quality_label || r.entry_status_label, 40, '-') + ' · PlanQ: ' + safeTelegramText(r.plan_quality_label || r.plan_label, 40, '-'));
  lines.push('Breakout: ' + safeTelegramText((r.breakout_confirmation_label || 'Breakout Watch').replace(/^Breakout /, ''), 40, '-') + (r.resistance ? ', needs close > ' + fmtPrice(r.resistance) : '') + ' · Setup Age: ' + safeTelegramText(r.setup_freshness_label || 'Needs Revalidation', 30, '-'));
  lines.push('Window: ' + safeTelegramText(enrichedForGrade.entry_window_label, 60, '-'));
  if (r.entry_status_label) lines.push('Entry Safety: ' + safeTelegramText(r.entry_status_label, 40, '-') + ' — ' + safeTelegramText(r.entry_status_note, 90, '-').replace(/^Harga/, 'harga'));
  lines.push('Harga: ' + fmtPrice(r.last_price));
  lines.push('Entry: ' + fmtPrice(e1) + ' / ' + fmtPrice(e2));
  lines.push('SL: ' + fmtPrice(r.stop_loss));
  lines.push('TP: ' + fmtPrice(r.tp1) + ' / ' + fmtPrice(r.tp2));

  var txParts = [];
  if (r.tx_value_1d) txParts.push('Tx1D ' + fmtRpValue(r.tx_value_1d));
  else if (r.value_today) txParts.push('Tx1D ' + fmtRpValue(r.value_today));
  if (mode === 'daytrade' && r.avg_tx_value_3d) txParts.push('Avg3D ' + fmtRpValue(r.avg_tx_value_3d));
  if (r.avg_tx_value_7d) txParts.push('Avg7D ' + fmtRpValue(r.avg_tx_value_7d));
  else if (r.avg_value_7d) txParts.push('Avg7D ' + fmtRpValue(r.avg_value_7d));
  if (txParts.length > 0) lines.push('Value: ' + txParts.join(' · '));

  var volParts = [];
  if (r.volume_ratio_20d || r.volume_ratio_avg20) volParts.push(fmtRatio(r.volume_ratio_20d || r.volume_ratio_avg20));
  if (mode === 'daytrade' && r.volume_today_vs_3d) volParts.push('3D ' + fmtRatio(r.volume_today_vs_3d));
  if (mode === 'daytrade' && r.volume_today_vs_7d) volParts.push('7D ' + fmtRatio(r.volume_today_vs_7d));
  if (volParts.length > 0) lines.push('Vol: ' + volParts.join(' · '));

  var tfParts = [];
  if (hasTelegramText(r.tf_1d_context)) tfParts.push('1D ' + safeTelegramText(r.tf_1d_context, 45, ''));
  if (mode === 'daytrade' && hasTelegramText(r.tf_3d_context)) tfParts.push('3D ' + safeTelegramText(r.tf_3d_context, 45, ''));
  if (hasTelegramText(r.tf_5d_context)) tfParts.push('5D ' + safeTelegramText(r.tf_5d_context, 45, ''));
  if (hasTelegramText(r.tf_20d_context)) tfParts.push('20D ' + safeTelegramText(r.tf_20d_context, 45, ''));
  if (tfParts.length > 0) lines.push('TF: ' + tfParts.join(' · '));
  lines.push('Verdict: ' + safeTelegramText(r.telegram_verdict, 120, 'Pantau dulu. Tunggu konfirmasi.'));
  return lines.join('\n');
}

function formatSwingNoCandidateTelegramMessage(title) {
  var now = new Date(); var wibMs = now.getTime() + 7*60*60*1000; var wib = new Date(wibMs);
  var months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  var timeStr = wib.getUTCDate() + ' ' + months[wib.getUTCMonth()] + ' ' + wib.getUTCFullYear() + ', ' + wib.toISOString().slice(11,16) + ' WIB';
  var label = String(title || '').replace(/^\s*[📈📊]+\s*/, '').replace(/ Signal\s*$/, '');
  return [title, 'Update: ' + timeStr, '', 'Belum ada kandidat ' + label + ' yang lolos final quality gate hari ini.', 'Bukan rekomendasi beli. Konfirmasi manual wajib.'].join('\n');
}

// ============================================================
// SWING KONGLO TELEGRAM NOTIFICATION (after manual refresh publish)
// ============================================================
async function sendSwingKongloTelegramNotification(supabase, savedCount) {
  if (savedCount === 0) return { skipped: true, reason: 'no_saved_rows' };
  try {
    var { data: rows } = await supabase.from('swing_screener_latest').select('*').order('score', { ascending: false }).limit(40);
    if (!rows || rows.length === 0) return { skipped: true, reason: 'no_data' };

    var metaRes = await supabase.from('swing_screener_meta').select('calculated_at,updated_at,run_date,status').eq('id', 'latest').maybeSingle();
    var swingMeta = metaRes && metaRes.data ? metaRes.data : { calculated_at: null };

    // Deterministic Telegram verification for Swing Konglo
    var verifiedRows = rows.map(function(r) { return verifyTelegramSignal(r, 'swing'); }).filter(Boolean);
    var highConvictionRows = verifiedRows.map(function(r) { return verifyHighConvictionTelegramSignal(r, 'swing'); }).filter(Boolean);
    var nonAvoid = highConvictionRows
      .map(function(r) { return attachFreshness(normalizeCombinedCandidate(r, 'Swing Konglo'), swingMeta); })
      .filter(candidatePassesMinUpside)
      .filter(function(r) { return candidatePassesPublicTelegramSafetyGate(r, 'swing_konglo'); });

    // Tier 1: Ready/Swing Ready with good RR and Grade A/B
    var tier1 = nonAvoid.filter(function(r) {
      var s = (r.status || r.final_status || '').toUpperCase();
      var isReady = s.indexOf('READY') >= 0 || s.indexOf('SWING_READY') >= 0 || s === 'TRADE_CANDIDATE' || s === 'A_PLUS_SWING';
      var gradeOk = r.quality_grade === 'A' || r.quality_grade === 'B' || (r.score || 0) >= 75;
      var rrOk = (toNum(r.risk_reward) || 0) >= 1.5;
      return isReady && gradeOk && rrOk;
    });

    // Tier 2: Watchlist/Rebound with decent score and RR
    var tier2 = nonAvoid.filter(function(r) {
      var s = (r.status || r.final_status || '').toUpperCase();
      var notSpec = s.indexOf('SPECULATIVE') < 0;
      return notSpec && (toNum(r.score) || 0) >= 65 && (toNum(r.risk_reward) || 0) >= 1.3;
    });

    // Build final: tier1 first, then tier2 to fill
    tier1.sort(function(a, b) { return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); });
    tier2.sort(function(a, b) { return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); });
    var finalList = tier1.slice(0, 5);
    if (finalList.length < 5) {
      var seen = {}; finalList.forEach(function(r) { seen[r.ticker] = true; });
      var fill = tier2.filter(function(r) { return !seen[r.ticker]; }).slice(0, 5 - finalList.length);
      finalList = finalList.concat(fill);
    }

    var headerNote = '';
    if (finalList.length === 0) {
      var emptyResult = { sent: false, skipped: true, reason: 'no_final_quality_gate_candidates_silent', message: null };
      emptyResult.verified_count = verifiedRows.length;
      emptyResult.high_conviction_count = highConvictionRows.length;
      emptyResult.selected_count = 0;
      return emptyResult;
    }

    var msg = formatSwingTelegramMessage(finalList, '\uD83D\uDCC8 Swing Konglo Signal', headerNote);
    var result = await telegramNotifier.sendTelegramMessage(msg);
    result.selected_count = finalList.length;
    result.verified_count = verifiedRows.length;
    result.high_conviction_count = highConvictionRows.length;
    return result;
  } catch (e) { return { sent: false, skipped: false, reason: 'exception', error_message: (e.message || '').substring(0, 80) }; }
}

// ============================================================
// SWING NON-KONGLO TELEGRAM NOTIFICATION (after manual finalize publish)
// ============================================================
async function sendSwingNkTelegramNotification(supabase, publishedCount) {
  if (publishedCount === 0) return { skipped: true, reason: 'no_published_rows' };
  try {
    var { data: rows } = await supabase.from('swing_screener_non_konglo_latest').select('*').order('rank', { ascending: true }).limit(40);
    if (!rows || rows.length === 0) return { skipped: true, reason: 'no_data' };

    var metaRes = await supabase.from('swing_screener_non_konglo_meta').select('calculated_at,updated_at,run_date,status').eq('id', 'latest').maybeSingle();
    var swingMeta = metaRes && metaRes.data ? metaRes.data : { calculated_at: null };

    // Deterministic Telegram verification for Swing Non-Konglo
    var verifiedRows = rows.map(function(r) { return verifyTelegramSignal(r, 'swing'); }).filter(Boolean);
    var highConvictionRows = verifiedRows.map(function(r) { return verifyHighConvictionTelegramSignal(r, 'swing'); }).filter(Boolean);
    var nonAvoid = highConvictionRows
      .map(function(r) { return attachFreshness(normalizeCombinedCandidate(r, 'Swing Non-Konglo'), swingMeta); })
      .filter(candidatePassesMinUpside)
      .filter(function(r) { return candidatePassesPublicTelegramSafetyGate(r, 'swing_non_konglo'); });

    // Tier 1: Ready with RR >= 1.5 and Grade A/B
    var tier1 = nonAvoid.filter(function(r) {
      var s = (r.status || '').toUpperCase();
      var isReady = s.indexOf('READY') >= 0 || s === 'TRADE_CANDIDATE' || s === 'A_PLUS_SWING';
      var gradeOk = r.quality_grade === 'A' || r.quality_grade === 'B' || r.grade === 'A' || r.grade === 'B' || (r.score || 0) >= 75;
      var rrOk = (toNum(r.risk_reward) || 0) >= 1.5;
      return isReady && gradeOk && rrOk;
    });

    // Tier 2: Other non-speculative with decent RR
    var tier2 = nonAvoid.filter(function(r) {
      var s = (r.status || '').toUpperCase();
      return s.indexOf('SPECULATIVE') < 0 && (toNum(r.score) || 0) >= 65 && (toNum(r.risk_reward) || 0) >= 1.3;
    });

    // Build final
    tier1.sort(function(a, b) { return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); });
    tier2.sort(function(a, b) { return rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || a.ticker.localeCompare(b.ticker); });
    var finalList = tier1.slice(0, 5);
    if (finalList.length < 5) {
      var seen = {}; finalList.forEach(function(r) { seen[r.ticker] = true; });
      var fill = tier2.filter(function(r) { return !seen[r.ticker]; }).slice(0, 5 - finalList.length);
      finalList = finalList.concat(fill);
    }

    var headerNote = '';
    if (finalList.length === 0) {
      var emptyResult = { sent: false, skipped: true, reason: 'no_final_quality_gate_candidates_silent', message: null };
      emptyResult.verified_count = verifiedRows.length;
      emptyResult.high_conviction_count = highConvictionRows.length;
      emptyResult.selected_count = 0;
      return emptyResult;
    }

    var msg = formatSwingTelegramMessage(finalList, '\uD83D\uDCCA Swing Non-Konglo Signal', headerNote);
    var result = await telegramNotifier.sendTelegramMessage(msg);
    result.selected_count = finalList.length;
    result.verified_count = verifiedRows.length;
    result.high_conviction_count = highConvictionRows.length;
    return result;
  } catch (e) { return { sent: false, skipped: false, reason: 'exception', error_message: (e.message || '').substring(0, 80) }; }
}

// Shared swing Telegram formatter (Konglo + Non-Konglo)
function formatSwingTelegramMessage(results, title, headerNote) {
  var now = new Date(); var wibMs = now.getTime() + 7*60*60*1000; var wib = new Date(wibMs);
  var months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  var timeStr = wib.getUTCDate() + ' ' + months[wib.getUTCMonth()] + ' ' + wib.getUTCFullYear() + ', ' + wib.toISOString().slice(11,16) + ' WIB';
  var lines = [];
  lines.push(title);
  lines.push('Update: ' + timeStr);
  if (headerNote) lines.push(headerNote);
  lines.push('');
  for (var i = 0; i < results.length; i++) {
    lines.push(fmtTelegramSignalBlock(results[i], i + 1, 'swing'));
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  lines.push('Bukan rekomendasi beli. Konfirmasi manual wajib.');
  return lines.join('\n');
}

module.exports.__test = {
  candidatePassesPublicTelegramSafetyGate: candidatePassesPublicTelegramSafetyGate,
  candidatePassesPotentialRadarGate: candidatePassesPotentialRadarGate,
  getPotentialRadarReason: getPotentialRadarReason,
  candidatePassesDayTradeRadarFallbackGate: candidatePassesDayTradeRadarFallbackGate,
  formatDayTradeRadarTelegramMessage: formatDayTradeRadarTelegramMessage,
  sendSwingKongloTelegramNotification: sendSwingKongloTelegramNotification,
  sendSwingNkTelegramNotification: sendSwingNkTelegramNotification,
  sendDayTradeTelegramNotification: sendDayTradeTelegramNotification,
  candidateTelegramEligible: candidateTelegramEligible,
  formatCandidateBlock: formatCandidateBlock,
  sanitizeTop5ResponseForAudience: sanitizeTop5ResponseForAudience,
  sanitizeTop5RowForPublic: sanitizeTop5RowForPublic,
  isTop5PreviewOrProvisionalRow: isTop5PreviewOrProvisionalRow,
  normalizeTelegramRiskLabel: normalizeTelegramRiskLabel
};
