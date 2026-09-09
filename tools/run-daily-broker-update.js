'use strict';

/**
 * Daily Bandarmologi Update (Bagian 3) — Broker Summary + Broker Accumulation
 * + Insiders refresh for TODAY's trading date, for the full ticker universe.
 *
 * Arjum's broker-summary data for the current session typically isn't
 * published until ~18:00-20:00 WIB, so this is meant to run every 30 minutes
 * from 20:00 to 22:00 WIB (5 cron firings) rather than as one long-running
 * process:
 *   - Idempotent: any ticker whose broker-summary for today is already on
 *     disk is skipped on the next firing (mirrors tools/backfill-arjum-data.js).
 *   - A completion marker (data/arjum-data/_daily-update-marker/<date>.json)
 *     is written once every ticker's broker-summary for today is on disk, so
 *     later firings within the window become a fast no-op.
 *   - Pass --final on the LAST scheduled firing (22:00) so an incomplete run
 *     is reported as a real failure instead of "will retry in 30 minutes".
 *
 * Usage:
 *   node tools/run-daily-broker-update.js --dry-run
 *   node tools/run-daily-broker-update.js
 *   node tools/run-daily-broker-update.js --final
 *   node tools/run-daily-broker-update.js --tickers BBCA,BBRI --dry-run
 */

const fs = require('fs');
const path = require('path');
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
  try {
    const p = markerPath(date);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  } catch (_) {}
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

  const dailyLimit = Math.min(arjumClient.getConfiguredDailyQuota(), isFinite(limit) ? limit : Infinity);

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
      const { createClient } = require('@supabase/supabase-js');
      supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch (_) {}
  }
  const guard = await idxTradingCalendar.marketDayGuard(supabase, { now: new Date(`${dateArg}T12:00:00+07:00`) });
  if (!guard.shouldRun) {
    console.log(`[LIBUR: ${guard.reason}] ${dateArg} bukan hari bursa (calendar source: ${guard.calendarSource}). Worker berhenti, tidak ada request dikirim.`);
    return;
  }
  console.log(`Trading day check: OK (calendar source: ${guard.calendarSource})`);

  const existingMarker = readMarker(dateArg);
  if (!isFresh && existingMarker && existingMarker.complete) {
    console.log(`[SUDAH SELESAI] Marker ${dateArg} sudah lengkap sejak ${existingMarker.completed_at}. Tidak ada yang perlu dikerjakan.`);
    return;
  }

  if (!dryRun && !arjumClient.hasArjumApiKey()) {
    console.error('ERROR: ARJUM_API_KEY tidak ditemukan di environment atau .env.');
    process.exit(1);
  }

  let totalRequested = 0;
  let doneCount = 0;
  let pendingCount = 0; // Arjum hasn't published today's data for this ticker yet
  let errorCount = 0;
  let quotaReached = false;

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
    if (quotaReached || arjumClient.getUsedQuotaToday() >= dailyLimit) break;
    const ticker = tickers[i];

    // 1. Broker Summary for TODAY — the critical, evening-gated data.
    const alreadyCached = !isFresh && bandarmologiService.hasDiskCache('broker-summary', ticker, dateArg);
    if (alreadyCached) {
      doneCount++;
    } else if (dryRun) {
      totalRequested++;
    } else {
      totalRequested++;
      const res = await arjumClient.fetchBrokerSummary(ticker, dateArg);
      if (res.ok && res.data) {
        const norm = bandarmologiService.normalizeBrokerSummary(res.data, dateArg);
        const hasAnyRows = (norm.top_buyers && norm.top_buyers.length > 0) || (norm.top_sellers && norm.top_sellers.length > 0);
        if (hasAnyRows) {
          bandarmologiService.writeDiskCache('broker-summary', ticker, dateArg, res.data);
          bandarmologiService.writeDiskCache('broker-summary', ticker, 'latest', res.data);
          doneCount++;
        } else {
          // Empty buyer/seller lists for today's date: most likely Arjum
          // hasn't published this session yet, not a real error. Leave
          // uncached so the next 30-minute firing retries this ticker.
          pendingCount++;
        }
      } else {
        if (checkApiQuota(res)) break;
        errorCount++;
      }
      await sleep(delayMs);
    }

    if (quotaReached || arjumClient.getUsedQuotaToday() >= dailyLimit) break;

    // 2. Broker Accumulation — always refreshed (Arjum's own trend endpoint
    // is expected to append today's point once published).
    if (!dryRun) {
      totalRequested++;
      const accRes = await arjumClient.fetchBrokerAccumulation(ticker);
      if (accRes.ok && accRes.data) {
        bandarmologiService.writeDiskCache('broker-accumulation', ticker, 'series', accRes.data);
      } else if (checkApiQuota(accRes)) {
        break;
      }
      await sleep(delayMs);
    } else {
      totalRequested++;
    }

    if (quotaReached || arjumClient.getUsedQuotaToday() >= dailyLimit) break;

    // 3. Insiders — cheap check for new transactions; not every ticker has
    // one every day, so an empty result is normal, not an error.
    if (!dryRun) {
      totalRequested++;
      const insRes = await arjumClient.fetchInsiders(ticker, 1, 15);
      if (insRes.ok && insRes.data) {
        bandarmologiService.writeDiskCache('insiders', ticker, 'p1', insRes.data);
      } else if (checkApiQuota(insRes)) {
        break;
      }
      await sleep(delayMs);
    } else {
      totalRequested++;
    }
  }

  const remaining = tickers.length - doneCount;
  const complete = !dryRun && remaining === 0;

  console.log('\n----------------------------------------------------');
  console.log('=== RINGKASAN DAILY BROKER UPDATE ===');
  console.log(`Total Permintaan Terkirim (run ini): ${totalRequested}`);
  console.log(`Total Terpakai Hari Ini (lintas-proses): ${arjumClient.getUsedQuotaToday()} / ${dailyLimit}`);
  console.log(`Broker Summary Selesai:        ${doneCount}/${tickers.length}`);
  console.log(`Belum Terbit (Pending Arjum):  ${pendingCount}`);
  console.log(`Error / Gagal:                 ${errorCount}`);
  console.log(`Kuota Habis:                   ${quotaReached ? 'YA' : 'TIDAK'}`);

  if (dryRun) {
    console.log('Status: DRY-RUN, tidak ada perubahan disimpan.');
    return;
  }

  if (doneCount > 0) {
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
    writeMarker(dateArg, { date: dateArg, complete: true, completed_at: new Date().toISOString(), total_tickers: tickers.length });
    console.log(`Status: SELESAI LENGKAP — ${tickers.length} ticker punya broker summary ${dateArg}.`);
    return;
  }

  writeMarker(dateArg, { date: dateArg, complete: false, updated_at: new Date().toISOString(), done: doneCount, pending: pendingCount, errors: errorCount, total_tickers: tickers.length });

  if (isFinal) {
    console.log(`Status: GAGAL — jendela retry (20:00-22:00 WIB) habis dengan ${remaining} ticker belum punya broker summary ${dateArg}.`);
    process.exitCode = 4;
  } else if (quotaReached) {
    console.log(`Status: TERHENTI SEMENTARA (kuota habis) — ${remaining} ticker akan dicoba lagi di run 30 menit berikutnya.`);
    process.exitCode = 2;
  } else {
    console.log(`Status: BELUM LENGKAP — ${remaining} ticker (kemungkinan besar belum dipublish Arjum) akan dicoba lagi di run 30 menit berikutnya.`);
    process.exitCode = 3;
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal worker error:', err);
    process.exit(1);
  });
}

module.exports = { run, getJakartaDateString, getJakartaTimeInfo, resolveTargetDate, markerPath, readMarker, writeMarker };
