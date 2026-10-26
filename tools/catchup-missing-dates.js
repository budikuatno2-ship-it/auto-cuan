#!/usr/bin/env node
'use strict';

/**
 * C (2026-10-23) — catch up missing broker-summary dates, newest first, with a
 * hard budget guard.
 *
 * WHY: J1 did not run on 20-22 Oct, so ALL/F/accumulation/insider are missing
 * for those dates (and 19 Oct is still ~920 emiten short). This tool fills the
 * gaps WITHOUT touching the daily jobs' quota.
 *
 * WHAT IT FILLS (same four types J1 writes):
 *   - broker-summary      (ALL, all_data=true)      1 request per ticker/date
 *   - broker-summary-F    (F,   all_data=true)      1 request per ticker/date
 *   - broker-accumulation (dated snapshot)          1 request per ticker/date
 *   - insiders            (dated snapshot)          1 request per ticker/date
 *   => up to 4 requests per ticker/date (3 if F is skipped).
 *
 * RULES:
 *  - Newest date first (22, 21, 20, then the 19 Oct remainder).
 *  - Budget = ARJUM_DAILY_LIMIT - reserve. Weekday reserve = J1/J2 need + 10%
 *    retry + web (4,940). Weekend reserve = min(1,500, 10% retry + web) because
 *    there is no J1/J2 on Sat/Sun.
 *  - Small batches (default 50 emiten). If more than 20% of a batch fails, it
 *    STOPS and reports instead of burning quota on a broken provider.
 *  - Idempotent: a type that already has its file is skipped, and no other date
 *    is ever overwritten.
 *
 * Usage:
 *   node tools/catchup-missing-dates.js --dry-run
 *   node tools/catchup-missing-dates.js --dates 2026-10-22,2026-10-21 --batch 50
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const arjumClient = require(path.join(ROOT_DIR, 'lib', 'arjum-client'));
const quotaTracker = require(path.join(ROOT_DIR, 'lib', 'arjum-quota-tracker'));

const DEFAULT_BATCH = 50;
const MAX_FAILURE_RATIO = 0.20;
// Quota floors are read dynamically from arjum-client (ARJUM_WEEKDAY_RESERVE / ARJUM_WEEKEND_RESERVE env vars).
// Call resolveWeekdayFloor() / resolveWeekendFloor() at runtime to get the latest values.
function resolveWeekdayFloor() { return arjumClient.getArjumWeekdayReserve(); }
function resolveWeekendFloor() { return arjumClient.getArjumWeekendReserve(); }
const DAILY_JOB_NEED = 5000;
const WEEKEND_RESERVE_CAP = 0;

// Catchup historical types: ONLY ALL and F.
// BUG-03: /api/broker-accumulation and /api/insiders have NO date parameter.
const TYPES = [
  { key: 'ALL', dir: 'broker-summary' },
  { key: 'F', dir: 'broker-summary-F' }
];

function loadEnvFile() {
  const candidates = [
    path.join(__dirname, '..', '.env.ai-eval-once'),
    path.join(__dirname, '..', '.env.local'),
    path.join(__dirname, '..', '.env'),
    '/home/ubuntu/auto-cuan-runner/.env',
    '/home/ubuntu/auto-cuan/.env'
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[k]) process.env[k] = v;
      }
    } catch (_) {}
  }
}

function dataDir(env) {
  const e = env || process.env;
  return e.ARJUM_DATA_DIR || path.join(ROOT_DIR, 'data', 'arjum-data');
}

function parseArgs(argv) {
  const opts = { dryRun: false, dates: [], batch: DEFAULT_BATCH, limit: Infinity, skipF: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-f') opts.skipF = true;
    else if (a === '--dates') { opts.dates = String(argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (a === '--batch') { const n = parseInt(argv[i + 1], 10); if (Number.isFinite(n) && n > 0) opts.batch = n; i += 1; }
    else if (a === '--limit') { const n = parseInt(argv[i + 1], 10); if (Number.isFinite(n) && n > 0) opts.limit = n; i += 1; }
  }
  return opts;
}

/**
 * Budget the catch-up may spend today, keeping the daily jobs safe.
 *
 * Weekday: floor = J1/J2 need + 10% retry + web (4,940).
 * Weekend: no J1/J2, so floor = min(1,500, 10% retry + web) — the owner's rule.
 *
 * @param {number} limit
 * @param {number} used
 * @param {{isWeekend?: boolean}} [options]
 */
function computeCatchupBudget(limit, used, options) {
  const opts = options || {};
  const isWeekend = opts.isWeekend === true;
  const floor = isWeekend ? resolveWeekendFloor() : resolveWeekdayFloor();
  const remaining = Math.max(0, Number(limit) - Number(used));
  return { limit, used, remaining, floor, spendable: Math.max(0, remaining - floor), isWeekend };
}

/** Is the given WIB date (YYYY-MM-DD) a Saturday or Sunday? */
function isWeekendWib(dateKey) {
  // Parse the calendar date directly: converting a +07:00 midnight to UTC would
  // shift it to the previous day and report the wrong weekday.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!m) return false;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return day === 0 || day === 6;
}

function tickerDirs(dir) {
  try {
    return fs.readdirSync(dir).filter((d) => {
      try { return fs.statSync(path.join(dir, d)).isDirectory(); } catch (_) { return false; }
    }).sort();
  } catch (_) { return []; }
}

function hasFile(dir, ticker, date) {
  try { return fs.existsSync(path.join(dir, ticker, date + '.json')); } catch (_) { return false; }
}

/**
 * Emiten still missing a given date, PER TYPE.
 * @returns {{total:number, missing:Object<string,string[]>, missingCells:number}}
 */
function missingForDate(baseDir, date, options) {
  const opts = options || {};
  const all = tickerDirs(path.join(baseDir, 'broker-summary'));
  const missing = {};
  let missingCells = 0;
  for (const t of TYPES) {
    if (t.key === 'F' && opts.skipF) { missing[t.key] = []; continue; }
    const dir = path.join(baseDir, t.dir);
    const list = all.filter((ticker) => !hasFile(dir, ticker, date));
    missing[t.key] = list;
    missingCells += list.length;
  }
  return { total: all.length, missing, missingCells };
}

function writeDated(baseDir, typeDir, ticker, date, data) {
  const dir = path.join(baseDir, typeDir, ticker);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, date + '.json'), JSON.stringify(data, null, 2));
}

async function run(argv, deps) {
  loadEnvFile();
  const d = deps || {};
  const opts = parseArgs(argv || []);
  const env = d.env || process.env;
  const baseDir = dataDir(env);
  const client = d.client || arjumClient;
  const tracker = d.tracker || quotaTracker;

  const limit = client.getConfiguredDailyQuota();
  const used = tracker.getUsedToday();
  // Weekend (Sat/Sun) has no J1/J2, so the daily-job floor does not apply.
  const todayWib = d.todayWib || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const weekend = isWeekendWib(todayWib);
  const budget = computeCatchupBudget(limit, used, { isWeekend: weekend });

  const dates = opts.dates.length ? opts.dates : ['2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19'];
  const plan = dates.map((date) => {
    const m = missingForDate(baseDir, date, { skipF: opts.skipF });
    return { date, total: m.total, missing: m.missing, missingCells: m.missingCells };
  });

  const totalCells = plan.reduce((s, p) => s + p.missingCells, 0);

  const summary = {
    dry_run: opts.dryRun,
    today_wib: todayWib,
    is_weekend: weekend,
    limit,
    used,
    remaining: budget.remaining,
    floor: budget.floor,
    spendable: budget.spendable,
    batch: opts.batch,
    types: TYPES.filter((t) => !(t.key === 'F' && opts.skipF)).map((t) => t.key),
    total_missing_cells: totalCells,
    fits_in_budget: totalCells <= budget.spendable,
    plan: plan.map((p) => ({
      date: p.date,
      total: p.total,
      missing: Object.fromEntries(Object.entries(p.missing).map(([k, v]) => [k, v.length])),
      missing_cells: p.missingCells
    }))
  };

  if (opts.dryRun) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return summary;
  }

  let spent = 0;
  const results = [];
  for (const p of plan) {
    if (spent >= budget.spendable || spent >= opts.limit) break;
    const union = Array.from(new Set(Object.values(p.missing).flat())).sort();
    let batchOffset = 0;

    while (batchOffset < union.length) {
      if (spent >= budget.spendable || spent >= opts.limit) break;
      const batch = union.slice(batchOffset, batchOffset + opts.batch);
      batchOffset += opts.batch;

      const perType = { ALL: { ok: 0, failed: 0 }, F: { ok: 0, failed: 0 } };
      let attempted = 0;
      let failed = 0;

      for (const ticker of batch) {
        if (spent >= budget.spendable || spent >= opts.limit) break;
        let tickerFailed = false;

        // 1. ALL
        if (p.missing.ALL && p.missing.ALL.includes(ticker)) {
          attempted += 1;
          try {
            const res = await client.fetchBrokerSummary(ticker, p.date, 'all', null, { allData: true, fresh: true, forceLive: true, noFallback: true, bypassMarketGuard: true });
            spent += 1;
            if (res && res.ok && res.data) { writeDated(baseDir, 'broker-summary', ticker, p.date, res.data); perType.ALL.ok += 1; }
            else { perType.ALL.failed += 1; failed += 1; tickerFailed = true; }
          } catch (_) { perType.ALL.failed += 1; failed += 1; tickerFailed = true; }
        }

        // 2. F (only when ALL succeeded for this ticker, mirroring J1)
        if (!tickerFailed && !opts.skipF && p.missing.F && p.missing.F.includes(ticker)) {
          attempted += 1;
          try {
            const res = await client.fetchBrokerSummary(ticker, p.date, 'F', null, { allData: true, fresh: true, forceLive: true, noFallback: true, bypassMarketGuard: true });
            spent += 1;
            if (res && res.ok && res.data) { writeDated(baseDir, 'broker-summary-F', ticker, p.date, res.data); perType.F.ok += 1; }
            else { perType.F.failed += 1; failed += 1; tickerFailed = true; }
          } catch (_) { perType.F.failed += 1; failed += 1; tickerFailed = true; }
        }
      }

      const ratio = attempted ? failed / attempted : 0;
      results.push({ date: p.date, batch_start: batchOffset - batch.length, tickers: batch.length, attempted, failed, failure_ratio: Number(ratio.toFixed(3)), per_type: perType });
      if (ratio > MAX_FAILURE_RATIO) {
        summary.stopped = 'failure_ratio_exceeded';
        summary.stopped_on = p.date;
        break;
      }

      // Small pause between batches
      if (batchOffset < union.length && spent < budget.spendable && spent < opts.limit) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }

  summary.spent = spent;
  summary.results = results;
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (require.main === module) {
  run(process.argv.slice(2)).then(() => { process.exitCode = 0; }).catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  run, parseArgs, computeCatchupBudget, missingForDate, isWeekendWib,
  MAX_FAILURE_RATIO, DAILY_JOB_NEED, WEEKEND_RESERVE_CAP, TYPES
};
