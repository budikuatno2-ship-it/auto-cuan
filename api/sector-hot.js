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
