/**
 * Sektor Hot / Grup Konglomerat Hot — Manual Refresh Script
 *
 * Usage: node scripts/refresh-sector-hot.js
 *
 * Requires environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * What it does:
 * 1. Reads active groups + members from Supabase
 * 2. Fetches quote data from Yahoo Finance for each unique ticker
 * 3. Calculates per-member metrics (change_pct, volume_ratio_30d)
 * 4. Calculates per-group aggregates (avg_change_pct, avg_volume_ratio, top_ticker)
 * 5. Upserts results into sector_hot_members_latest and sector_hot_latest
 * 6. Updates sector_hot_meta
 *
 * Safety:
 * - If a single ticker fails, it continues to the next (increments failed_count)
 * - If ALL tickers fail, previous cache is NOT wiped
 * - 300ms delay between Yahoo requests to avoid rate limiting
 * - Does NOT print secrets
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// === YAHOO FINANCE FETCHER ===
async function fetchYahooQuote(ticker) {
  // IDX tickers use .JK suffix on Yahoo Finance
  const symbol = ticker + '.JK';
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=60d&interval=1d&includePrePost=false';

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });

  if (!response.ok) return null;

  const data = await response.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) return null;

  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const indicators = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!indicators) return null;

  const closes = indicators.close || [];
  const volumes = indicators.volume || [];

  // Filter out null entries
  const validDays = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && volumes[i] != null) {
      validDays.push({ close: closes[i], volume: volumes[i], ts: timestamps[i] });
    }
  }

  if (validDays.length < 2) return null;

  const latest = validDays[validDays.length - 1];
  const prev = validDays[validDays.length - 2];

  // Last price and change
  const lastPrice = latest.close;
  const prevClose = prev.close;
  const changePct = prevClose > 0 ? ((lastPrice - prevClose) / prevClose) * 100 : 0;

  // Volume today
  const volumeToday = latest.volume;

  // Avg volume 30d (use up to 30 most recent valid days, excluding today)
  const histDays = validDays.slice(0, -1); // exclude today
  const recentDays = histDays.slice(-30);
  let avgVolume30d = 0;
  if (recentDays.length > 0) {
    const totalVol = recentDays.reduce(function(sum, d) { return sum + d.volume; }, 0);
    avgVolume30d = totalVol / recentDays.length;
  }

  const volumeRatio30d = avgVolume30d > 0 ? volumeToday / avgVolume30d : 0;

  return {
    lastPrice: Math.round(lastPrice * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    volumeToday: volumeToday,
    avgVolume30d: Math.round(avgVolume30d),
    volumeRatio30d: Math.round(volumeRatio30d * 100) / 100
  };
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// === MAIN REFRESH LOGIC ===
async function main() {
  console.log('[refresh-sector-hot] Starting...');
  const startTime = Date.now();

  // 1. Read active groups + members
  const { data: groups, error: gErr } = await supabase
    .from('sector_hot_groups')
    .select('group_code, group_name, owner_label')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (gErr || !groups || groups.length === 0) {
    console.error('[refresh-sector-hot] Failed to read groups:', gErr ? gErr.message : 'No groups found');
    await updateMeta(0, 0, 'failed', 'No active groups found.');
    process.exit(1);
  }

  const { data: members, error: mErr } = await supabase
    .from('sector_hot_group_members')
    .select('group_code, ticker, stock_name, member_type, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (mErr || !members || members.length === 0) {
    console.error('[refresh-sector-hot] Failed to read members:', mErr ? mErr.message : 'No members found');
    await updateMeta(0, 0, 'failed', 'No active members found.');
    process.exit(1);
  }

  console.log('[refresh-sector-hot] Groups: ' + groups.length + ', Members: ' + members.length);

  // 2. Build unique ticker list
  const uniqueTickers = [];
  const tickerSet = {};
  members.forEach(function(m) {
    if (!tickerSet[m.ticker]) {
      tickerSet[m.ticker] = true;
      uniqueTickers.push(m.ticker);
    }
  });

  console.log('[refresh-sector-hot] Unique tickers to fetch: ' + uniqueTickers.length);

  // 3. Fetch quotes for each unique ticker
  const quoteCache = {};
  let scannedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < uniqueTickers.length; i++) {
    const ticker = uniqueTickers[i];
    scannedCount++;
    try {
      const quote = await fetchYahooQuote(ticker);
      if (quote) {
        quoteCache[ticker] = quote;
        console.log('  [' + (i + 1) + '/' + uniqueTickers.length + '] ' + ticker + ': ' + quote.lastPrice + ' (' + (quote.changePct >= 0 ? '+' : '') + quote.changePct + '%)');
      } else {
        failedCount++;
        console.log('  [' + (i + 1) + '/' + uniqueTickers.length + '] ' + ticker + ': FAILED (no data)');
      }
    } catch (e) {
      failedCount++;
      console.log('  [' + (i + 1) + '/' + uniqueTickers.length + '] ' + ticker + ': ERROR (' + e.message + ')');
    }

    // Rate limit: 300ms between requests
    if (i < uniqueTickers.length - 1) {
      await delay(300);
    }
  }

  console.log('[refresh-sector-hot] Fetched: ' + (scannedCount - failedCount) + ' ok, ' + failedCount + ' failed');

  // If ALL failed, do not wipe cache
  if (failedCount === scannedCount) {
    console.error('[refresh-sector-hot] All tickers failed. Keeping previous cache.');
    await updateMeta(scannedCount, failedCount, 'failed', 'All ticker fetches failed.');
    process.exit(1);
  }

  // 4. Calculate per-group and upsert
  const now = new Date().toISOString();
  let groupsProcessed = 0;

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const groupMembers = members.filter(function(m) { return m.group_code === group.group_code; });

    if (groupMembers.length === 0) continue;

    // Build member rows
    const memberRows = [];
    let validCount = 0;
    let totalChangePct = 0;
    let totalVolRatio = 0;
    let topTicker = null;
    let topChangePct = -Infinity;

    for (let m = 0; m < groupMembers.length; m++) {
      const member = groupMembers[m];
      const quote = quoteCache[member.ticker];

      const row = {
        group_code: group.group_code,
        ticker: member.ticker,
        stock_name: member.stock_name,
        last_price: quote ? quote.lastPrice : null,
        change_pct: quote ? quote.changePct : null,
        volume_today: quote ? quote.volumeToday : null,
        avg_volume_30d: quote ? quote.avgVolume30d : null,
        volume_ratio_30d: quote ? quote.volumeRatio30d : null,
        member_type: member.member_type,
        calculated_at: now
      };

      memberRows.push(row);

      if (quote) {
        validCount++;
        totalChangePct += quote.changePct;
        totalVolRatio += quote.volumeRatio30d;
        if (quote.changePct > topChangePct) {
          topChangePct = quote.changePct;
          topTicker = member.ticker;
        }
      }
    }

    // Upsert member rows
    const { error: upsertMErr } = await supabase
      .from('sector_hot_members_latest')
      .upsert(memberRows, { onConflict: 'group_code,ticker' });

    if (upsertMErr) {
      console.error('  [' + group.group_code + '] Member upsert error:', upsertMErr.message);
    }

    // Calculate group summary
    const avgChangePct = validCount > 0 ? Math.round((totalChangePct / validCount) * 100) / 100 : null;
    const avgVolRatio = validCount > 0 ? Math.round((totalVolRatio / validCount) * 100) / 100 : null;

    const groupRow = {
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
      message: validCount > 0 ? null : 'No valid data for this group'
    };

    const { error: upsertGErr } = await supabase
      .from('sector_hot_latest')
      .upsert([groupRow], { onConflict: 'group_code' });

    if (upsertGErr) {
      console.error('  [' + group.group_code + '] Group upsert error:', upsertGErr.message);
    } else {
      groupsProcessed++;
    }
  }

  // 5. Update meta
  await updateMeta(scannedCount, failedCount, 'ok', 'Refresh completed. Groups: ' + groupsProcessed);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('[refresh-sector-hot] Done in ' + elapsed + 's. Groups: ' + groupsProcessed + ', Tickers: ' + scannedCount + ' (' + failedCount + ' failed)');
}

async function updateMeta(scannedCount, failedCount, status, message) {
  const { error } = await supabase
    .from('sector_hot_meta')
    .upsert([{
      id: 'latest',
      calculated_at: new Date().toISOString(),
      scanned_count: scannedCount,
      failed_count: failedCount,
      status: status,
      message: message,
      updated_at: new Date().toISOString()
    }], { onConflict: 'id' });

  if (error) {
    console.error('[refresh-sector-hot] Meta update error:', error.message);
  }
}

main().catch(function(e) {
  console.error('[refresh-sector-hot] Unexpected error:', e.message);
  process.exit(1);
});
