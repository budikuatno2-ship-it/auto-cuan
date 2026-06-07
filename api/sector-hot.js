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

    // === REFRESH MODE (cron-protected) ===
    if (action === 'refresh') {
      return await handleRefresh(req, res, supabase);
    }

    // === NON-KONGLO SCREENER: START SCAN (cron-protected) ===
    if (action === 'nk-screener-start') {
      return await handleNkScreenerStart(req, res, supabase);
    }

    // === NON-KONGLO SCREENER: PROCESS BATCH (cron-protected) ===
    if (action === 'nk-screener-batch') {
      return await handleNkScreenerBatch(req, res, supabase);
    }

    // === NON-KONGLO SCREENER: FINALIZE (cron-protected) ===
    if (action === 'nk-screener-finalize') {
      return await handleNkScreenerFinalize(req, res, supabase);
    }

    // === NON-KONGLO SCREENER: AUTO-ORCHESTRATOR (single cron entry) ===
    if (action === 'nk-screener-run') {
      return await handleNkScreenerRun(req, res, supabase);
    }

    // === NON-KONGLO SCREENER: READ RESULTS (authenticated users) ===
    if (action === 'nk-screener-results') {
      return await handleNkScreenerResults(req, res, supabase);
    }

    // === DETAIL MODE: single group + members ===
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

    // === LIST MODE: all groups summary + meta ===
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

// === REFRESH HANDLER (protected by CRON_SECRET) ===
async function handleRefresh(req, res, supabase) {
  // Verify cron secret
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) {
    return res.status(200).json({ success: false, error: 'Refresh not configured.' });
  }

  // Check authorization: Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  const authHeader = req.headers.authorization || '';
  const providedSecret = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (providedSecret !== CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  try {
    // 1. Read active groups + members
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

    // 2. Build unique ticker list
    const uniqueTickers = [];
    const tickerSet = {};
    members.forEach(function(m) {
      if (!tickerSet[m.ticker]) { tickerSet[m.ticker] = true; uniqueTickers.push(m.ticker); }
    });

    // 3. Fetch quotes for each unique ticker
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
      // Rate limit: 200ms between requests (serverless has time limit)
      if (i < uniqueTickers.length - 1) {
        await delay(200);
      }
    }

    // If ALL failed, do not wipe cache
    if (failedCount === scannedCount) {
      await updateMeta(supabase, scannedCount, failedCount, 'failed', 'All ticker fetches failed.');
      return res.status(200).json({ success: false, error: 'All fetches failed.', scannedCount: scannedCount, failedCount: failedCount });
    }

    // 4. Calculate per-group and upsert
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

      // Upsert member rows
      await supabase.from('sector_hot_members_latest').upsert(memberRows, { onConflict: 'group_code,ticker' });

      // Upsert group summary
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

    // 5. Update meta
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

// === YAHOO FINANCE FETCHER ===
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



// ======================================================================
// NON-KONGLO SWING SCREENER v1 — DETERMINISTIC, BATCH PROCESSING
// ======================================================================

var NK_BATCH_SIZE = 15;
var NK_MIN_AVG_TX_VALUE = 10000000000; // Rp10 billion
var NK_MIN_PRICE = 50;
var NK_MIN_TRADED_DAYS = 15;
var NK_MIN_RR = 1.5;
var NK_MIN_VOL_RATIO = 0.7;
var NK_TOP_N = 15;

// === VERIFY CRON SECRET (shared helper) ===
function verifyCronSecret(req) {
  var CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) return false;
  var authHeader = req.headers.authorization || '';
  var providedSecret = authHeader.replace(/^Bearer\s+/i, '').trim();
  return providedSecret === CRON_SECRET;
}

// === NK SCREENER AUTO-ORCHESTRATOR (single cron handles start/batch/finalize) ===
async function handleNkScreenerRun(req, res, supabase) {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  try {
    // === WIB TIME-WINDOW GUARD ===
    // Automatic scheduled runs only proceed Mon-Fri 19:30-21:30 WIB.
    // Manual Preview QA can bypass with force=1 query param.
    var forceMode = req.query.force === '1';

    if (!forceMode && !isWithinNkRunWindow()) {
      return res.status(200).json({
        success: true,
        status: 'skipped_outside_window',
        message: 'Outside Non-Konglo screener run window (Mon-Fri 19:30-21:30 WIB).'
      });
    }

    var today = getWibDateString();

    // Check current meta state
    var { data: meta } = await supabase
      .from('swing_screener_non_konglo_meta')
      .select('*')
      .eq('id', 'latest')
      .maybeSingle();

    // Case 1: No scan today or idle/failed from previous day → START
    if (!meta || meta.scan_date !== today || meta.status === 'idle' || meta.status === 'failed') {
      return await handleNkScreenerStart(req, res, supabase);
    }

    // Case 2: Scan already completed today → nothing to do
    if (meta.status === 'completed') {
      return res.status(200).json({ success: true, status: 'already_completed', message: 'Scan already completed for ' + today, phase: 'done' });
    }

    // Case 3: Scanning in progress → check if batches remain
    var { data: pendingJobs } = await supabase
      .from('swing_screener_non_konglo_jobs')
      .select('id')
      .eq('scan_date', today)
      .in('status', ['pending', 'processing']);

    if (pendingJobs && pendingJobs.length > 0) {
      // Still have batches to process → run next batch
      return await handleNkScreenerBatch(req, res, supabase);
    }

    // All batches done → finalize
    return await handleNkScreenerFinalize(req, res, supabase);

  } catch (e) {
    console.error('nk-screener-run error:', e.message);
    return res.status(200).json({ success: false, error: 'Orchestrator error: ' + e.message });
  }
}

// === WIB TIME-WINDOW CHECK ===
// Returns true if current time is Mon-Fri 19:30-21:30 WIB
function isWithinNkRunWindow() {
  var now = new Date();
  // Convert to WIB (UTC+7)
  var wibOffset = 7 * 60; // minutes
  var utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  var wibMinutes = utcMinutes + wibOffset;
  var wibHour = Math.floor(wibMinutes / 60) % 24;
  var wibMin = wibMinutes % 60;

  // Day of week in WIB (handle day rollover)
  var wibDay = now.getUTCDay();
  if (wibMinutes >= 24 * 60) {
    wibDay = (wibDay + 1) % 7;
  }

  // Must be Monday(1) - Friday(5)
  if (wibDay < 1 || wibDay > 5) return false;

  // Must be between 19:30 and 21:30 WIB
  var wibTotalMin = wibHour * 60 + wibMin;
  var startMin = 19 * 60 + 30; // 19:30
  var endMin = 21 * 60 + 30;   // 21:30

  return wibTotalMin >= startMin && wibTotalMin <= endMin;
}

// === NK SCREENER START: Build universe, create batches ===
async function handleNkScreenerStart(req, res, supabase) {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  try {
    var today = getWibDateString();

    // Check if scan already running or completed for today
    var { data: meta } = await supabase
      .from('swing_screener_non_konglo_meta')
      .select('*')
      .eq('id', 'latest')
      .maybeSingle();

    if (meta && meta.scan_date === today && (meta.status === 'scanning' || meta.status === 'completed')) {
      return res.status(200).json({ success: true, message: 'Scan already ' + meta.status + ' for ' + today, meta: meta });
    }

    // 1. Get Konglo tickers to exclude
    var { data: kongloMembers } = await supabase
      .from('sector_hot_group_members')
      .select('ticker')
      .eq('is_active', true);

    var kongloSet = {};
    if (kongloMembers) {
      kongloMembers.forEach(function(m) { kongloSet[m.ticker] = true; });
    }

    // 2. Get Main Board + Development Board stocks
    var { data: allStocks, error: stocksErr } = await supabase
      .from('stock_boards')
      .select('ticker, company_name, board')
      .eq('is_active', true)
      .in('board', ['UTAMA', 'PENGEMBANGAN']);

    if (stocksErr || !allStocks || allStocks.length === 0) {
      await updateNkMeta(supabase, { status: 'failed', message: 'No stocks found in stock_boards.', scan_date: today });
      return res.status(200).json({ success: false, error: 'No eligible stocks found.' });
    }

    // 3. Filter out Konglo stocks
    var universe = allStocks.filter(function(s) {
      return !kongloSet[s.ticker];
    });

    if (universe.length === 0) {
      await updateNkMeta(supabase, { status: 'failed', message: 'No non-konglo stocks after filtering.', scan_date: today });
      return res.status(200).json({ success: false, error: 'No non-konglo stocks found.' });
    }

    // 4. Create batches
    var batches = [];
    for (var i = 0; i < universe.length; i += NK_BATCH_SIZE) {
      batches.push(universe.slice(i, i + NK_BATCH_SIZE));
    }

    // 5. Clear old jobs + staging for today and insert new batch jobs
    await supabase.from('swing_screener_non_konglo_jobs').delete().eq('scan_date', today);
    await supabase.from('swing_screener_non_konglo_staging').delete().eq('scan_date', today);

    var jobRows = batches.map(function(batch, idx) {
      return {
        scan_date: today,
        batch_number: idx + 1,
        tickers: batch.map(function(s) { return s.ticker; }),
        status: 'pending'
      };
    });

    await supabase.from('swing_screener_non_konglo_jobs').insert(jobRows);

    // 6. Update meta
    await updateNkMeta(supabase, {
      scan_date: today,
      status: 'scanning',
      total_universe: universe.length,
      processed_count: 0,
      passed_hard_filter: 0,
      current_batch: 0,
      total_batches: batches.length,
      started_at: new Date().toISOString(),
      completed_at: null,
      message: 'Scan started. Universe: ' + universe.length + ', Batches: ' + batches.length
    });

    return res.status(200).json({
      success: true,
      message: 'Non-Konglo scan started.',
      universe: universe.length,
      batches: batches.length,
      batchSize: NK_BATCH_SIZE,
      scanDate: today
    });

  } catch (e) {
    console.error('nk-screener-start error:', e.message);
    return res.status(200).json({ success: false, error: 'Start failed: ' + e.message });
  }
}

// === NK SCREENER BATCH: Process next pending batch ===
async function handleNkScreenerBatch(req, res, supabase) {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  try {
    var today = getWibDateString();

    // Find next pending batch
    var { data: pendingJobs, error: jobErr } = await supabase
      .from('swing_screener_non_konglo_jobs')
      .select('*')
      .eq('scan_date', today)
      .eq('status', 'pending')
      .order('batch_number', { ascending: true })
      .limit(1);

    if (jobErr || !pendingJobs || pendingJobs.length === 0) {
      // No more pending batches — check if all done
      var { data: allJobs } = await supabase
        .from('swing_screener_non_konglo_jobs')
        .select('status')
        .eq('scan_date', today);

      var allDone = allJobs && allJobs.every(function(j) { return j.status === 'completed' || j.status === 'failed'; });
      if (allDone) {
        return res.status(200).json({ success: true, message: 'All batches processed. Ready to finalize.', allDone: true });
      }
      return res.status(200).json({ success: true, message: 'No pending batches found.', allDone: false });
    }

    var job = pendingJobs[0];
    var tickers = job.tickers || [];

    // Mark job as processing
    await supabase.from('swing_screener_non_konglo_jobs')
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', job.id);

    // Process each ticker in the batch
    var stagingRows = [];
    var passedCount = 0;

    for (var i = 0; i < tickers.length; i++) {
      var ticker = tickers[i];
      try {
        var quoteData = await fetchNkQuoteData(ticker);
        if (!quoteData) continue;

        // Apply hard filters
        var filterResult = applyNkHardFilters(quoteData);
        if (!filterResult.passed) continue;

        // Calculate setup score
        var scored = calculateNkSetupScore(quoteData);
        passedCount++;

        stagingRows.push({
          scan_date: today,
          ticker: ticker,
          stock_name: quoteData.stockName || null,
          board: quoteData.board || null,
          last_price: quoteData.lastPrice,
          change_pct: quoteData.changePct,
          avg_volume_20d: quoteData.avgVolume20d,
          avg_transaction_value_20d: quoteData.avgTxValue20d,
          volume_ratio_avg20: quoteData.volumeRatioAvg20,
          traded_days_20d: quoteData.tradedDays20d,
          rsi14: quoteData.rsi14,
          ma20: quoteData.ma20,
          ma50: quoteData.ma50,
          risk_reward: quoteData.riskReward,
          setup_score: scored.score,
          setup_grade: scored.grade,
          status: scored.status,
          reason: scored.reason,
          calculated_at: new Date().toISOString()
        });
      } catch (tickerErr) {
        // Skip failed ticker, continue batch
      }

      // Rate limit between Yahoo requests
      if (i < tickers.length - 1) {
        await delay(250);
      }
    }

    // Insert staging rows (upsert to handle retries)
    if (stagingRows.length > 0) {
      await supabase.from('swing_screener_non_konglo_staging')
        .upsert(stagingRows, { onConflict: 'scan_date,ticker' });
    }

    // Mark job completed
    await supabase.from('swing_screener_non_konglo_jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        results: { processed: tickers.length, passed: passedCount }
      })
      .eq('id', job.id);

    // Update meta progress
    var { data: completedJobs } = await supabase
      .from('swing_screener_non_konglo_jobs')
      .select('status, results')
      .eq('scan_date', today)
      .eq('status', 'completed');

    var totalProcessed = 0;
    var totalPassed = 0;
    if (completedJobs) {
      completedJobs.forEach(function(j) {
        if (j.results) {
          totalProcessed += j.results.processed || 0;
          totalPassed += j.results.passed || 0;
        }
      });
    }

    await updateNkMeta(supabase, {
      scan_date: today,
      status: 'scanning',
      processed_count: totalProcessed,
      passed_hard_filter: totalPassed,
      current_batch: job.batch_number,
      message: 'Batch ' + job.batch_number + ' completed. Processed: ' + totalProcessed + ', Passed: ' + totalPassed
    });

    return res.status(200).json({
      success: true,
      message: 'Batch ' + job.batch_number + ' completed.',
      batchNumber: job.batch_number,
      tickersProcessed: tickers.length,
      passed: passedCount,
      totalProcessed: totalProcessed,
      totalPassed: totalPassed
    });

  } catch (e) {
    console.error('nk-screener-batch error:', e.message);
    return res.status(200).json({ success: false, error: 'Batch failed: ' + e.message });
  }
}

// === NK SCREENER FINALIZE: Publish Top 15 from staging ===
async function handleNkScreenerFinalize(req, res, supabase) {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  try {
    var today = getWibDateString();

    // Verify all batches are done
    var { data: pendingJobs } = await supabase
      .from('swing_screener_non_konglo_jobs')
      .select('id')
      .eq('scan_date', today)
      .in('status', ['pending', 'processing']);

    if (pendingJobs && pendingJobs.length > 0) {
      return res.status(200).json({ success: false, error: 'Not all batches completed yet. Remaining: ' + pendingJobs.length });
    }

    // Get all scored candidates from staging, order by setup_score DESC
    var { data: candidates, error: candErr } = await supabase
      .from('swing_screener_non_konglo_staging')
      .select('*')
      .eq('scan_date', today)
      .order('setup_score', { ascending: false })
      .limit(NK_TOP_N);

    if (candErr || !candidates || candidates.length === 0) {
      await updateNkMeta(supabase, {
        scan_date: today,
        status: 'completed',
        completed_at: new Date().toISOString(),
        message: 'Scan completed but no candidates passed all filters.'
      });
      // Clear latest table
      await supabase.from('swing_screener_non_konglo_latest').delete().neq('ticker', '');
      return res.status(200).json({ success: true, message: 'No candidates passed filters.', published: 0 });
    }

    // Build Top 15 rows with rank
    var publishRows = candidates.map(function(c, idx) {
      return {
        ticker: c.ticker,
        stock_name: c.stock_name,
        board: c.board,
        last_price: c.last_price,
        change_pct: c.change_pct,
        avg_volume_20d: c.avg_volume_20d,
        avg_transaction_value_20d: c.avg_transaction_value_20d,
        volume_ratio_avg20: c.volume_ratio_avg20,
        traded_days_20d: c.traded_days_20d,
        rsi14: c.rsi14,
        ma20: c.ma20,
        ma50: c.ma50,
        risk_reward: c.risk_reward,
        setup_score: c.setup_score,
        setup_grade: c.setup_grade,
        status: c.status,
        reason: c.reason,
        rank_position: idx + 1,
        calculated_at: c.calculated_at
      };
    });

    // Atomic publish: clear old + insert new
    await supabase.from('swing_screener_non_konglo_latest').delete().neq('ticker', '');
    await supabase.from('swing_screener_non_konglo_latest').insert(publishRows);

    // Update meta to completed
    await updateNkMeta(supabase, {
      scan_date: today,
      status: 'completed',
      completed_at: new Date().toISOString(),
      message: 'Published Top ' + publishRows.length + ' candidates.'
    });

    return res.status(200).json({
      success: true,
      message: 'Top ' + publishRows.length + ' published.',
      published: publishRows.length,
      topTicker: publishRows[0] ? publishRows[0].ticker : null,
      topScore: publishRows[0] ? publishRows[0].setup_score : null
    });

  } catch (e) {
    console.error('nk-screener-finalize error:', e.message);
    return res.status(200).json({ success: false, error: 'Finalize failed: ' + e.message });
  }
}

// === NK SCREENER RESULTS: Read cached Top 15 (for frontend) ===
async function handleNkScreenerResults(req, res, supabase) {
  try {
    // Get meta
    var { data: meta } = await supabase
      .from('swing_screener_non_konglo_meta')
      .select('*')
      .eq('id', 'latest')
      .maybeSingle();

    // Get latest results
    var { data: results, error: resErr } = await supabase
      .from('swing_screener_non_konglo_latest')
      .select('*')
      .order('rank_position', { ascending: true });

    if (resErr) {
      return res.status(200).json({ success: false, error: 'Gagal memuat data screener.' });
    }

    return res.status(200).json({
      success: true,
      meta: meta || { status: 'idle', message: 'Belum ada scan.' },
      results: results || [],
      count: (results || []).length
    });

  } catch (e) {
    return res.status(200).json({ success: false, error: 'Error: ' + e.message });
  }
}

// === NK HELPERS ===

function getWibDateString() {
  // Get current date in WIB (UTC+7)
  var now = new Date();
  var wib = new Date(now.getTime() + (7 * 60 * 60 * 1000));
  return wib.toISOString().slice(0, 10);
}

async function updateNkMeta(supabase, fields) {
  var row = Object.assign({ id: 'latest', updated_at: new Date().toISOString() }, fields);
  await supabase.from('swing_screener_non_konglo_meta').upsert([row], { onConflict: 'id' });
}

// Fetch enriched quote data for a single ticker (for screener scoring)
async function fetchNkQuoteData(ticker) {
  var symbol = ticker + '.JK';
  var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=60d&interval=1d&includePrePost=false';

  var response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
  } catch (e) { return null; }

  if (!response.ok) return null;

  var data;
  try { data = await response.json(); } catch (e) { return null; }

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

  // Build valid candles
  var candles = [];
  for (var i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && opens[i] != null && highs[i] != null && lows[i] != null && volumes[i] != null) {
      candles.push({ open: closes[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i] });
    }
  }

  if (candles.length < 5) return null;

  var latest = candles[candles.length - 1];
  var lastPrice = latest.close;

  // Last 20 trading days
  var last20 = candles.slice(-20);
  var tradedDays20d = last20.length;

  // Avg volume 20d
  var volSum20 = 0;
  for (var v = 0; v < last20.length; v++) { volSum20 += last20[v].volume; }
  var avgVolume20d = last20.length > 0 ? volSum20 / last20.length : 0;

  // Avg transaction value 20d = avg_volume_20d * last_price
  var avgTxValue20d = avgVolume20d * lastPrice;

  // Volume ratio today vs avg 20d
  var volumeRatioAvg20 = avgVolume20d > 0 ? latest.volume / avgVolume20d : 0;

  // Change percent
  var prevClose = candles.length >= 2 ? candles[candles.length - 2].close : lastPrice;
  var changePct = prevClose > 0 ? ((lastPrice - prevClose) / prevClose) * 100 : 0;

  // Simple MA calculations
  var closePrices = candles.map(function(c) { return c.close; });
  var ma20 = nkCalcMA(closePrices, 20);
  var ma50 = nkCalcMA(closePrices, 50);

  // RSI 14
  var rsi14 = nkCalcRSI(closePrices, 14);

  // Risk/Reward calculation
  // Support = lowest low of last 20 candles
  // Resistance = highest high of last 20 candles
  // Risk = lastPrice - support, Reward = resistance - lastPrice
  var support = Infinity;
  var resistance = -Infinity;
  for (var s = 0; s < last20.length; s++) {
    if (last20[s].low < support) support = last20[s].low;
    if (last20[s].high > resistance) resistance = last20[s].high;
  }
  var risk = lastPrice - support;
  var reward = resistance - lastPrice;
  var riskReward = (risk > 0) ? reward / risk : 0;

  return {
    ticker: ticker,
    stockName: null, // will be filled from stock_boards if available
    board: null,
    lastPrice: Math.round(lastPrice * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    avgVolume20d: Math.round(avgVolume20d),
    avgTxValue20d: Math.round(avgTxValue20d),
    volumeRatioAvg20: Math.round(volumeRatioAvg20 * 100) / 100,
    tradedDays20d: tradedDays20d,
    rsi14: rsi14 != null ? Math.round(rsi14 * 100) / 100 : null,
    ma20: ma20 != null ? Math.round(ma20 * 100) / 100 : null,
    ma50: ma50 != null ? Math.round(ma50 * 100) / 100 : null,
    riskReward: Math.round(riskReward * 100) / 100,
    support: Math.round(support * 100) / 100,
    resistance: Math.round(resistance * 100) / 100,
    volume: latest.volume,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    isGreenCandle: lastPrice >= latest.open
  };
}

// Apply hard filters — returns { passed: boolean }
function applyNkHardFilters(q) {
  if (!q) return { passed: false };
  if (q.lastPrice <= NK_MIN_PRICE) return { passed: false };
  if (q.tradedDays20d < NK_MIN_TRADED_DAYS) return { passed: false };
  if (q.avgTxValue20d < NK_MIN_AVG_TX_VALUE) return { passed: false };
  if (q.riskReward < NK_MIN_RR) return { passed: false };
  if (q.volumeRatioAvg20 < NK_MIN_VOL_RATIO) return { passed: false };
  return { passed: true };
}

// Deterministic Setup Score for Non-Konglo v1 (0–100)
function calculateNkSetupScore(q) {
  if (!q) return { score: 0, grade: 'E', status: 'invalid', reason: 'Data tidak tersedia' };

  var reasons = [];
  var score = 0;

  // === TREND (0-30) ===
  var trend = 0;
  if (q.ma20 != null && q.lastPrice >= q.ma20) { trend += 15; reasons.push('Price > MA20'); }
  else if (q.ma20 != null) { reasons.push('Price < MA20'); }
  if (q.ma50 != null && q.lastPrice >= q.ma50) { trend += 15; reasons.push('Price > MA50'); }
  else if (q.ma50 != null) { reasons.push('Price < MA50'); }
  if (q.ma20 == null && q.ma50 == null) { trend = 10; } // neutral if no MA

  // === MOMENTUM / RSI (0-20) ===
  var momentum = 0;
  if (q.rsi14 != null) {
    if (q.rsi14 >= 50 && q.rsi14 <= 65) { momentum = 20; reasons.push('RSI ' + q.rsi14 + ' bullish zone'); }
    else if (q.rsi14 > 65 && q.rsi14 <= 70) { momentum = 15; reasons.push('RSI ' + q.rsi14 + ' kuat'); }
    else if (q.rsi14 >= 45 && q.rsi14 < 50) { momentum = 12; reasons.push('RSI ' + q.rsi14 + ' netral'); }
    else if (q.rsi14 > 70 && q.rsi14 <= 80) { momentum = 8; reasons.push('RSI ' + q.rsi14 + ' overbought warning'); }
    else if (q.rsi14 > 80) { momentum = 4; reasons.push('RSI ' + q.rsi14 + ' extreme overbought'); }
    else if (q.rsi14 >= 35 && q.rsi14 < 45) { momentum = 8; reasons.push('RSI ' + q.rsi14 + ' lemah'); }
    else if (q.rsi14 < 35) { momentum = 4; reasons.push('RSI ' + q.rsi14 + ' oversold'); }
    else { momentum = 10; }
  } else {
    momentum = 8;
    reasons.push('RSI tidak tersedia');
  }

  // === VOLUME (0-25) ===
  var volume = 0;
  var vr = q.volumeRatioAvg20;
  if (vr >= 2.0 && q.isGreenCandle) { volume = 25; reasons.push('Volume spike + green (' + vr + 'x)'); }
  else if (vr >= 1.5 && q.isGreenCandle) { volume = 22; reasons.push('Volume tinggi + green (' + vr + 'x)'); }
  else if (vr >= 1.2 && q.isGreenCandle) { volume = 18; reasons.push('Volume above avg + green (' + vr + 'x)'); }
  else if (vr >= 1.0) { volume = 14; reasons.push('Volume normal (' + vr + 'x)'); }
  else if (vr >= 0.7) { volume = 10; reasons.push('Volume cukup (' + vr + 'x)'); }
  else { volume = 5; reasons.push('Volume rendah (' + vr + 'x)'); }

  // === RISK/REWARD (0-15) ===
  var rrScore = 0;
  if (q.riskReward >= 3.0) { rrScore = 15; reasons.push('R:R ' + q.riskReward + ' sangat baik'); }
  else if (q.riskReward >= 2.5) { rrScore = 13; reasons.push('R:R ' + q.riskReward + ' baik'); }
  else if (q.riskReward >= 2.0) { rrScore = 10; reasons.push('R:R ' + q.riskReward + ' cukup'); }
  else if (q.riskReward >= 1.5) { rrScore = 7; reasons.push('R:R ' + q.riskReward + ' minimal'); }
  else { rrScore = 3; }

  // === LIQUIDITY BONUS (0-10) ===
  var liqScore = 0;
  var txB = q.avgTxValue20d / 1000000000; // convert to billions
  if (txB >= 50) { liqScore = 10; }
  else if (txB >= 30) { liqScore = 8; }
  else if (txB >= 20) { liqScore = 6; }
  else if (txB >= 10) { liqScore = 4; }
  else { liqScore = 2; }

  score = trend + momentum + volume + rrScore + liqScore;
  score = Math.max(0, Math.min(100, score));

  // Grade
  var grade;
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'E';

  // Status and reason text
  var status = 'valid';
  var reasonText = reasons.slice(0, 3).join('; ');

  if (q.rsi14 != null && q.rsi14 > 75) {
    status = 'overbought_risk';
    reasonText = 'RSI terlalu tinggi (' + q.rsi14 + '), tunggu pullback. ' + reasonText;
  } else if (q.volumeRatioAvg20 < 0.8 && !q.isGreenCandle) {
    status = 'low_volume';
    reasonText = 'Volume lemah + red candle. ' + reasonText;
  } else if (q.riskReward < 2.0) {
    status = 'rr_minimal';
    reasonText = 'R:R masih minimal. ' + reasonText;
  } else if (score >= 65) {
    status = 'strong_setup';
    reasonText = 'Setup kuat. ' + reasonText;
  } else if (score >= 50) {
    status = 'moderate_setup';
    reasonText = 'Setup cukup. ' + reasonText;
  }

  return {
    score: score,
    grade: grade,
    status: status,
    reason: reasonText
  };
}

// Simple Moving Average
function nkCalcMA(arr, period) {
  if (!arr || arr.length < period) return null;
  var sum = 0;
  for (var i = arr.length - period; i < arr.length; i++) { sum += arr[i]; }
  return sum / period;
}

// RSI Calculation
function nkCalcRSI(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  var gains = 0;
  var losses = 0;
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
