'use strict';

/**
 * Daily Bandarmologi Update (Bagian 3) — Broker Summary + Broker Accumulation
 * + Insiders refresh for TODAY's trading date, for the full ticker universe.
 *
 * Arjum's broker-summary data for the current session typically isn't
 * published until ~18:00-20:00 WIB, so this is meant to run every 30 minutes
 * through the durable run-daily-market-update coordinator. New sessions begin
 * at 18:00 WIB; incomplete dates retry every 30 minutes without a cutoff:
 *   - Idempotent: any ticker whose broker-summary for today is already on
 *     disk is skipped on the next firing (mirrors tools/backfill-arjum-data.js).
 *   - Before the final firing, empty-but-successful broker-summary responses
 *     remain pending so late publication can still arrive.
 *   - Only an explicit manual --final invocation treats an empty response as terminal
 *     NO_DATA (for example suspended/no-trade tickers); it is never fabricated
 *     into a cache file. A completion marker is written only when every ticker
 *     is either backed by valid broker-summary rows or terminal NO_DATA, with
 *     no real upstream errors and no quota stop.
 *   - A complete marker makes later firings a fast no-op.
 *
 * Usage:
 *   node tools/run-daily-broker-update.js --dry-run
 *   node tools/run-daily-broker-update.js
 *   node tools/run-daily-broker-update.js --final
 *   node tools/run-daily-broker-update.js --tickers BBCA,BBRI --dry-run
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const idxTradingCalendar = require('../lib/idx-trading-calendar');

// Same .env loading convention as tools/backfill-arjum-data.js /
// tools/run-daily-afternoon-recap.js.
try {
  const envCandidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local')
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch (_) {}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJakartaDateString(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(now || new Date());
}

function getJakartaTimeInfo(now) {
  const dateObj = now || new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const parts = fmt.formatToParts(dateObj);
  let year = '', month = '', day = '', hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  const dateKey = `${year}-${month}-${day}`;
  return { dateKey, hour, minute };
}

function resolveTargetDate(options = {}) {
  const { dateArg, now, holidaySet } = options;
  if (dateArg) {
    return {
      targetDate: String(dateArg).trim(),
      shifted: false,
      reason: 'explicit_argument'
    };
  }

  const { dateKey: todayKey, hour, minute } = getJakartaTimeInfo(now);
  const isBeforeCutoff = hour < 16 || (hour === 16 && minute < 30);

  // If today is a weekend or public holiday, always shift to the last completed trading day
  if (!idxTradingCalendar.isTradingDay(todayKey, holidaySet)) {
    const prevTrading = idxTradingCalendar.previousTradingDay(todayKey, holidaySet);
    const resolved = prevTrading || todayKey;
    return {
      targetDate: resolved,
      shifted: true,
      originalDate: todayKey,
      timeString: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      reason: 'weekend_or_holiday'
    };
  }

  if (isBeforeCutoff) {
    const prevTrading = idxTradingCalendar.previousTradingDay(todayKey, holidaySet);
    const resolved = prevTrading || todayKey;
    return {
      targetDate: resolved,
      shifted: true,
      originalDate: todayKey,
      timeString: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      reason: 'before_market_close_cutoff'
    };
  }

  return {
    targetDate: todayKey,
    shifted: false,
    reason: 'after_cutoff_today'
  };
}

function markerPath(date) {
  const baseDir = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
  return path.join(baseDir, '_daily-update-marker', `${date}.json`);
}

function readMarker(date) {
  try {
    const p = markerPath(date);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

function writeMarker(date, payload) {
    const p = markerPath(date);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const temp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
    fs.renameSync(temp, p);
}

function brokerSummaryPayloadDate(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [payload.broker_end_date, payload.broker_start_date, payload.trade_date, payload.date];
  for (const value of candidates) {
    const key = String(value || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  }
  return null;
}

function shouldAdvanceLatestBrokerSummary(ticker, targetDate) {
  const target = String(targetDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return false;

  let newestKnown = null;
  try {
    const dates = bandarmologiService.listDiskDates('broker-summary', ticker) || [];
    for (const value of dates) {
      const key = String(value || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && (!newestKnown || key > newestKnown)) newestKnown = key;
    }
  } catch (_) {}

  try {
    const latestRaw = bandarmologiService.readDiskCache('broker-summary', ticker, 'latest');
    const latestDate = brokerSummaryPayloadDate(latestRaw);
    if (latestDate && (!newestKnown || latestDate > newestKnown)) newestKnown = latestDate;
  } catch (_) {}

  return !newestKnown || target >= newestKnown;
}

async function run(argv) {
  const args = argv || process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const isFinal = args.includes('--final');

  const isFresh = args.includes('--fresh');
  let limit = Infinity;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10) || Infinity;
  }

  let dateFromArg = null;
  const dateIdx = args.indexOf('--date');
  if (dateIdx >= 0 && args[dateIdx + 1]) dateFromArg = args[dateIdx + 1];

  const resolved = resolveTargetDate({ dateArg: dateFromArg });
  const dateArg = resolved.targetDate;

  if (resolved.shifted) {
    console.log(`[SAFETY GUARD] Script dieksekusi sebelum pukul 16:30 WIB (${resolved.timeString} WIB) tanpa argumen --date.`);
    console.log(`  -> Target date otomatis dialihkan dari hari ini (${resolved.originalDate}) ke hari bursa aktif sebelumnya (${dateArg}) agar kuota API tidak terbuang.`);
  }

  let tickers = [];
  const tickerArgIdx = args.indexOf('--tickers');
  if (tickerArgIdx >= 0 && args[tickerArgIdx + 1]) {
    tickers = args[tickerArgIdx + 1].split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  } else {
    try {
      const txtFile = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
      if (fs.existsSync(txtFile)) {
        tickers = fs.readFileSync(txtFile, 'utf8').split(/\r?\n/).map(t => t.trim().toUpperCase()).filter(Boolean);
      }
    } catch (_) {}
  }

  if (isFinite(limit) && limit < tickers.length) {
    tickers = tickers.slice(0, limit);
  }

  let delayMs = 250;
  const delayIdx = args.indexOf('--delay');
  if (delayIdx >= 0 && args[delayIdx + 1]) delayMs = parseInt(args[delayIdx + 1], 10) || 250;

  const dailyLimit = arjumClient.getConfiguredDailyQuota();

  console.log('=== AUTO-CUAN DAILY BROKER UPDATE (Bagian 3) ===');
  console.log(`Target Date (WIB): ${dateArg}`);
  console.log(`Total Tickers: ${tickers.length}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN' : (isFresh ? 'LIVE (FRESH OVERWRITE)' : 'LIVE')}${isFinal ? ' (FINAL ATTEMPT for tonight)' : ''}`);
  console.log(`Daily Quota: ${dailyLimit} | Already used today (cross-process, all scripts): ${arjumClient.getUsedQuotaToday()}`);
  console.log('----------------------------------------------------');

  // Mandatory per project spec: skip entirely on a non-trading day (weekend
  // or IDX/KSEI holiday) rather than spending quota on a session that never
  // happened. Falls back to a weekend-only guard when Supabase credentials
  // are unavailable (idx-trading-calendar.js's own designed degrade), so
  // this still works before/without the holiday table being seeded.
  let supabase = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('../lib/hybrid-supabase-client');
      supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch (_) {}
  }
  const guard = await idxTradingCalendar.marketDayGuard(supabase, { now: new Date(`${dateArg}T12:00:00+07:00`) });
  if (!guard.shouldRun) {
    console.log(`[LIBUR: ${guard.reason}] ${dateArg} bukan hari bursa (calendar source: ${guard.calendarSource}). Worker berhenti, tidak ada request dikirim.`);
    return { skipped: true, reason: guard.reason };
  }
  console.log(`Trading day check: OK (calendar source: ${guard.calendarSource})`);

  tickers = [...new Set(tickers)].sort();
  const universeHash = crypto.createHash('sha256').update(tickers.join(',')).digest('hex');
  const existingMarker = readMarker(dateArg);
  if (!isFresh && existingMarker && existingMarker.complete && existingMarker.version === 2 && existingMarker.universe_hash === universeHash) {
    console.log(`[SUDAH SELESAI] Marker ${dateArg} sudah lengkap sejak ${existingMarker.completed_at}. Tidak ada yang perlu dikerjakan.`);
    return;
  }
  if (!isFresh && existingMarker && existingMarker.complete && Number(existingMarker.total_tickers) !== tickers.length) {
    console.log(`[UNIVERSE BERUBAH] Marker ${dateArg} mencatat ${existingMarker.total_tickers} ticker, universe aktif sekarang ${tickers.length}. Hanya ticker yang belum punya dated cache yang akan diproses ulang.`);
  }

  if (!dryRun && !arjumClient.hasArjumApiKey()) {
    console.error('ERROR: ARJUM_API_KEY tidak ditemukan di environment atau .env.');
    throw new Error('ARJUM_API_KEY is required');
  }

  let totalRequested = 0;
  let doneCount = 0;
  let newBrokerSummaryCount = 0;
  let pendingCount = 0; // Empty response before the final retry window closes.
  let confirmedNoDataCount = 0; // Empty-but-successful response on --final (e.g. suspended/no-trade ticker).
  let errorCount = 0;
  let quotaReached = false;
  let auxiliaryPending = 0;
  const noDataTickers = new Set(isFinal && !isFresh && existingMarker && existingMarker.version === 2 && existingMarker.no_data_tickers || []);

  function checkApiQuota(res) {
    if (!res.ok) {
      const classified = arjumClient.classifyFailure(res);
      if (classified.reason === 'quota_exceeded') {
        quotaReached = true;
        console.log(`\n[BERHENTI: KUOTA API HABIS] ${classified.detail || 'quota exceeded'}. Sisa ticker akan dicoba lagi di run berikutnya.`);
        return true;
      }
    }
    return false;
  }

  for (let i = 0; i < tickers.length; i++) {
    if (quotaReached) break;
    const ticker = tickers[i];
    let shouldRefreshAuxiliary = false;

    // 1. Broker Summary for TODAY — the critical, evening-gated data.
    // Retry firings must be quota-safe: if the dated summary is already valid,
    // reuse it and retry only missing dated accumulation/insider caches.
    const cached = !isFresh && bandarmologiService.readDiskCache('broker-summary', ticker, dateArg);
    const normalized = cached && bandarmologiService.normalizeBrokerSummary(cached, dateArg);
    const cachedDate = cached && brokerSummaryPayloadDate(cached);
    const alreadyCached = normalized && (!cachedDate || cachedDate === dateArg) && ((normalized.top_buyers || []).length || (normalized.top_sellers || []).length);
    if (alreadyCached) {
      doneCount++;
      shouldRefreshAuxiliary = true;
    } else if (noDataTickers.has(ticker)) {
      confirmedNoDataCount++;
      shouldRefreshAuxiliary = true;
    } else if (dryRun) {
      totalRequested++;
    } else {
      if (arjumClient.getUsedQuotaToday() >= dailyLimit) { quotaReached = true; break; }
      totalRequested++;
      const res = await arjumClient.fetchBrokerSummary(ticker, dateArg);
      if (res.ok && res.data && (!brokerSummaryPayloadDate(res.data) || brokerSummaryPayloadDate(res.data) === dateArg)) {
        const norm = bandarmologiService.normalizeBrokerSummary(res.data, dateArg);
        const hasAnyRows = (norm.top_buyers && norm.top_buyers.length > 0) || (norm.top_sellers && norm.top_sellers.length > 0);
        if (hasAnyRows) {
          const advanceLatest = shouldAdvanceLatestBrokerSummary(ticker, dateArg);
          persistDatedCache('broker-summary', ticker, dateArg, res.data);
          if (advanceLatest) {
            bandarmologiService.writeDiskCache('broker-summary', ticker, 'latest', res.data);
          } else {
            console.log(`[HISTORICAL] ${ticker} ${dateArg} disimpan sebagai dated cache; latest.json yang lebih baru dipertahankan.`);
          }
          doneCount++;
          newBrokerSummaryCount++;
          shouldRefreshAuxiliary = true;
        } else if (isFinal) {
          // An empty-but-successful response can be legitimate for suspended,
          // FCA/no-trade, or otherwise inactive tickers. During the retry
          // window we keep it pending so late publication can still arrive;
          // on the 22:00 --final attempt, treat it as terminal NO_DATA rather
          // than requiring an impossible 957/957 non-empty universe.
          confirmedNoDataCount++;
          noDataTickers.add(ticker);
          shouldRefreshAuxiliary = true;
        } else {
          // Before the final attempt, keep successful empty responses pending.
          // This preserves the late-publication retry behaviour for active
          // tickers without permanently treating NO_DATA as a worker failure.
          pendingCount++;
        }
      } else {
        if (checkApiQuota(res)) break;
        errorCount++;
      }
      await sleep(delayMs);
    }

    if (quotaReached) break;

    // 2-3. Reuse successful dated auxiliary caches, retry failed/missing ones.
    // Dry-run keeps counting the historical three-request worst case.
    if (shouldRefreshAuxiliary || dryRun) {
      if (!dryRun && (isFresh || !bandarmologiService.readDiskCache('broker-accumulation', ticker, dateArg))) {
        if (arjumClient.getUsedQuotaToday() >= dailyLimit) { quotaReached = true; break; }
        totalRequested++;
        const accRes = await arjumClient.fetchBrokerAccumulation(ticker);
        if (accRes.ok && accRes.data) {
          bandarmologiService.writeDiskCache('broker-accumulation', ticker, 'series', accRes.data);
          persistDatedCache('broker-accumulation', ticker, dateArg, accRes.data);
        } else if (checkApiQuota(accRes)) {
          break;
        } else {
          auxiliaryPending++; errorCount++;
        }
        await sleep(delayMs);
      } else if (dryRun) {
        totalRequested++;
      }

      if (quotaReached) break;

      // Insiders: an empty result is normal, not an error.
      if (!dryRun && (isFresh || !bandarmologiService.readDiskCache('insiders', ticker, dateArg))) {
        if (arjumClient.getUsedQuotaToday() >= dailyLimit) { quotaReached = true; break; }
        totalRequested++;
        const insRes = await arjumClient.fetchInsiders(ticker, 1, 15);
        if (insRes.ok && insRes.data) {
          bandarmologiService.writeDiskCache('insiders', ticker, 'p1', insRes.data);
          persistDatedCache('insiders', ticker, dateArg, insRes.data);
        } else if (checkApiQuota(insRes)) {
          break;
        } else {
          auxiliaryPending++; errorCount++;
        }
        await sleep(delayMs);
      } else if (dryRun) {
        totalRequested++;
      }
    }
  }

  const terminalCount = doneCount + confirmedNoDataCount;
  const remaining = tickers.length - terminalCount;
  const auxiliaryComplete = tickers.every(ticker =>
    bandarmologiService.readDiskCache('broker-accumulation', ticker, dateArg) &&
    bandarmologiService.readDiskCache('insiders', ticker, dateArg));
  const complete = !dryRun && tickers.length > 0 && remaining === 0 && auxiliaryComplete && auxiliaryPending === 0 && errorCount === 0 && !quotaReached;

  console.log('\n----------------------------------------------------');
  console.log('=== RINGKASAN DAILY BROKER UPDATE ===');
  console.log(`Total Permintaan Terkirim (run ini): ${totalRequested}`);
  console.log(`Total Terpakai Hari Ini (lintas-proses): ${arjumClient.getUsedQuotaToday()} / ${dailyLimit}`);
  console.log(`Broker Summary Selesai:        ${doneCount}/${tickers.length}`);
  console.log(`Broker Summary Baru (run ini): ${newBrokerSummaryCount}`);
  console.log(`Belum Terbit (Pending Arjum):  ${pendingCount}`);
  console.log(`Final NO_DATA (valid kosong):  ${confirmedNoDataCount}`);
  console.log(`Error / Gagal:                 ${errorCount}`);
  console.log(`Kuota Habis:                   ${quotaReached ? 'YA' : 'TIDAK'}`);

  if (dryRun) {
    console.log('Status: DRY-RUN, tidak ada perubahan disimpan.');
    return;
  }

  if (newBrokerSummaryCount > 0) {
    try {
      const bandarmologiIntelService = require('../lib/bandarmologi-intel-service');
      console.log('\n[INTEL] Menjalankan pre-calculation 4 sinyal intelijen bandarmologi...');
      bandarmologiIntelService.computeAndSaveIntel({ tickers, date: dateArg });
      console.log('[INTEL] Pre-calculation sinyal intelijen bandarmologi selesai.');
    } catch (intelErr) {
      console.warn('[INTEL] Warning: Gagal pre-calculate sinyal intelijen:', intelErr && intelErr.message ? intelErr.message : intelErr);
    }
  }

  if (complete) {
    writeMarker(dateArg, {
      version: 2, universe_hash: universeHash, no_data_tickers: [...noDataTickers],
      date: dateArg,
      complete: true,
      completed_at: new Date().toISOString(),
      broker_summary_rows: doneCount,
      no_data: confirmedNoDataCount,
      total_tickers: tickers.length
    });
    console.log(`Status: SELESAI — ${doneCount} ticker punya broker summary dan ${confirmedNoDataCount} ticker terkonfirmasi NO_DATA untuk ${dateArg}.`);
    return;
  }

  writeMarker(dateArg, {
    version: 2, universe_hash: universeHash, no_data_tickers: [...noDataTickers], auxiliary_pending: auxiliaryPending,
    date: dateArg,
    complete: false,
    updated_at: new Date().toISOString(),
    done: doneCount,
    pending: pendingCount,
    no_data: confirmedNoDataCount,
    errors: errorCount,
    total_tickers: tickers.length
  });

  if (isFinal) {
    console.log(`Status: GAGAL — jendela retry (18:00-22:00 WIB) habis dengan ${remaining} ticker belum punya broker summary ${dateArg}.`);
    process.exitCode = 4;
  } else if (quotaReached) {
    console.log(`Status: TERHENTI SEMENTARA (kuota habis) — ${remaining} ticker akan dicoba lagi di run 30 menit berikutnya.`);
    process.exitCode = 2;
  } else {
    console.log(`Status: BELUM LENGKAP — ${remaining} ticker (kemungkinan besar belum dipublish Arjum) akan dicoba lagi di run 30 menit berikutnya.`);
    process.exitCode = 3;
  }
}

function persistDatedCache(endpoint, ticker, date, data) {
  bandarmologiService.writeDiskCache(endpoint, ticker, date, data);
  const saved = bandarmologiService.readDiskCache(endpoint, ticker, date);
  if (JSON.stringify(saved) !== JSON.stringify(data)) throw new Error('Dated cache could not be persisted: ' + endpoint + '/' + ticker + '/' + date);
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal worker error:', err);
    process.exit(1);
  });
}

module.exports = { run, getJakartaDateString, getJakartaTimeInfo, resolveTargetDate, markerPath, readMarker, writeMarker, brokerSummaryPayloadDate, shouldAdvanceLatestBrokerSummary };
