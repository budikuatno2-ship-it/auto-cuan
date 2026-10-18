'use strict';

/**
 * Priority backfill: 10 saham uji paritas akumulasi pada tanggal tidak wajar.
 * Menggunakan sisa kuota malam ini (sebelum reset 00:00 WIB).
 *
 * Target: BBCA, BRPT, BBRI, MEDC, ADRO, BUMI, BMRI, TPIA, BBNI, TLKM
 * Tanggal prioritas: 2026-09-04, 2026-09-11, 2026-09-25 (dan tanggal tidak wajar lain)
 * Mode: all_data=true SAJA (flow=all), ~30-60 request.
 *
 * Dijalankan di VPS:
 *   cd /home/ubuntu/auto-cuan && node /tmp/priority-backfill-accum-tests.js
 */

const fs = require('fs');
const path = require('path');

// Load env dari runner agar API key & ARJUM_DATA_DIR terisi
function loadEnv() {
  const candidates = [
    '/home/ubuntu/auto-cuan-runner/.env',
    '/home/ubuntu/auto-cuan/.env.local',
    '/home/ubuntu/auto-cuan/.env'
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

const arjumClient = require('/home/ubuntu/auto-cuan/lib/arjum-client');
const quotaTracker = require('/home/ubuntu/auto-cuan/lib/arjum-quota-tracker');
const validator = require('/home/ubuntu/auto-cuan/lib/broksum-validator');

const BASE = '/home/ubuntu/auto-cuan/data/arjum-data';
const ALL_DIR = path.join(BASE, 'broker-summary');
const F_DIR = path.join(BASE, 'broker-summary-F');
const CANDLES_DIR = '/home/ubuntu/auto-cuan/data/daily-candles';
const QUARANTINE_ROOT = path.join(BASE, '_quarantine-tidakwajar-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
const CANDLES_DIR_REPO = '/home/ubuntu/auto-cuan/data/daily-candles';

const TICKERS = ['BBCA', 'BRPT', 'BBRI', 'MEDC', 'ADRO', 'BUMI', 'BMRI', 'TPIA', 'BBNI', 'TLKM'];
const PRIORITY_DATES = ['2026-09-25', '2026-09-11', '2026-09-04'];

// Batas kuota: sisakan minimum 30 request (website akhir pekan butuh ~15)
const MIN_REMAINING = 30;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getCandle(ticker, date) {
  try {
    const f = path.join(CANDLES_DIR_REPO, `${ticker}.json`);
    if (!fs.existsSync(f)) return null;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const c of (d.candles || [])) {
      const dd = String(c.date || c.time || '').slice(0, 10);
      if (dd === date) {
        return { close: Number(c.close), volume: Number(c.volume), value: c.value != null ? Number(c.value) : null };
      }
    }
  } catch (_) {}
  return null;
}

function quarantineFile(srcPath, ticker, date) {
  try {
    const qDir = path.join(QUARANTINE_ROOT, ticker);
    fs.mkdirSync(qDir, { recursive: true });
    const qFile = path.join(qDir, `${date}.json`);
    if (!fs.existsSync(qFile)) fs.copyFileSync(srcPath, qFile);
    fs.unlinkSync(srcPath);
  } catch (_) {}
}

async function main() {
  console.log('=== PRIORITY BACKFILL: 10 saham uji paritas akumulasi ===');
  console.log('Tanggal prioritas:', PRIORITY_DATES.join(', '));

  const configured = arjumClient.getConfiguredDailyQuota();
  const remainingStart = quotaTracker.getRemainingToday(configured);
  console.log(`Kuota terkonfigurasi: ${configured}, sisa: ${remainingStart}`);

  if (remainingStart <= MIN_REMAINING) {
    console.log(`[STOP] Sisa kuota ${remainingStart} <= batas minimum ${MIN_REMAINING}. Tidak ada request dikirim.`);
    return;
  }

  const budget = remainingStart - MIN_REMAINING;
  console.log(`Anggaran request: ${budget} (akan menyisakan ${MIN_REMAINING})`);

  const tasks = [];
  for (const tk of TICKERS) {
    for (const date of PRIORITY_DATES) {
      const fPath = path.join(ALL_DIR, tk, `${date}.json`);
      const exists = fs.existsSync(fPath);
      let needsRefetch = !exists;
      let reason = exists ? 'exists' : 'missing';

      if (exists) {
        try {
          const p = JSON.parse(fs.readFileSync(fPath, 'utf8'));
          const candle = getCandle(tk, date);
          const v = validator.validateBroksumAgainstCandle(p, candle);
          if (!v.valid) {
            needsRefetch = true;
            reason = 'invalid:' + v.flags.join(',');
          }
        } catch (e) {
          needsRefetch = true;
          reason = 'parse_error';
        }
      }
      // Prioritas: tanggal 25 Sep dulu, lalu 11, lalu 4
      tasks.push({ ticker: tk, date, needsRefetch, reason, priority: PRIORITY_DATES.indexOf(date) });
    }
  }

  // Urutkan: prioritas tanggal dulu, lalu ticker likuid
  tasks.sort((a, b) => a.priority - b.priority || TICKERS.indexOf(a.ticker) - TICKERS.indexOf(b.ticker));

  const toFetch = tasks.filter(t => t.needsRefetch);
  console.log(`Total kandidat: ${toFetch.length}, anggaran: ${budget}`);

  let sent = 0;
  let ok = 0;
  let failed = 0;
  const results = [];

  for (const t of toFetch) {
    if (sent >= budget) {
      console.log(`[BUDGET] Anggaran ${budget} tercapai. Berhenti.`);
      break;
    }
    if (arjumClient.isCircuitBreakerTripped()) {
      console.log('[CIRCUIT-BREAKER] Berhenti total.');
      break;
    }

    const fPath = path.join(ALL_DIR, t.ticker, `${t.date}.json`);
    console.log(`[FETCH] ${t.ticker} ${t.date} (${t.reason})`);

    try {
      const res = await arjumClient.fetchBrokerSummary(t.ticker, t.date, 'all', null, {
        allData: true,
        fresh: true,
        forceLive: true,
        noFallback: true,
        bypassMarketGuard: true
      });
      sent++;

      const isOk = res && res.ok && res.status === 200 && res.data && !res.from_cache && !res.fallback
        && res.data.flow === 'all'
        && String(res.data.stock_code || '').trim().toUpperCase() === t.ticker;

      if (!isOk) {
        console.warn(`[FAIL] ${t.ticker} ${t.date}: status=${res && res.status} ok=${res && res.ok} fallback=${res && res.fallback} err=${res && res.error}`);
        failed++;
        results.push({ ticker: t.ticker, date: t.date, result: 'fetch_failed', error: res && res.error });
        continue;
      }

      // Validasi hasil sebelum menyimpan (Fase 5: validasi permanen)
      const candle = getCandle(t.ticker, t.date);
      const v = validator.validateBroksumAgainstCandle(res.data, candle);
      if (!v.valid) {
        console.warn(`[REJECT] ${t.ticker} ${t.date} gagal validasi ulang: ${v.flags.join(',')} ratio=${v.ratio}`);
        failed++;
        results.push({ ticker: t.ticker, date: t.date, result: 'invalid_after_refetch', flags: v.flags, ratio: v.ratio });
        continue;
      }

      // Simpan: kuarantina file lama, tulis file baru
      const tkDir = path.join(ALL_DIR, t.ticker);
      if (!fs.existsSync(tkDir)) fs.mkdirSync(tkDir, { recursive: true });
      if (fs.existsSync(fPath)) quarantineFile(fPath, t.ticker, t.date);

      // Tambahkan tanda validasi pada payload
      const toWrite = Object.assign({}, res.data, {
        _validated: {
          at: new Date().toISOString(),
          ratio: v.ratio,
          brokerCount: v.totals.brokerCount,
          source: 'priority-backfill-accum-tests'
        }
      });
      fs.writeFileSync(fPath, JSON.stringify(toWrite, null, 2), 'utf8');
      ok++;
      results.push({ ticker: t.ticker, date: t.date, result: 'saved', ratio: v.ratio, brokerCount: v.totals.brokerCount });
      console.log(`[SAVED] ${t.ticker} ${t.date} ratio=${v.ratio} brokers=${v.totals.brokerCount}`);
    } catch (e) {
      console.warn(`[ERROR] ${t.ticker} ${t.date}: ${e.message}`);
      failed++;
      results.push({ ticker: t.ticker, date: t.date, result: 'exception', error: e.message });
    }

    await sleep(150);
  }

  const remainingEnd = quotaTracker.getRemainingToday(configured);
  const summary = {
    sent,
    ok,
    failed,
    remaining_start: remainingStart,
    remaining_end: remainingEnd,
    quarantine_root: QUARANTINE_ROOT,
    results
  };
  fs.writeFileSync('/tmp/priority_backfill_result.json', JSON.stringify(summary, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ sent, ok, failed, remaining_start: remainingStart, remaining_end: remainingEnd }, null, 2));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
