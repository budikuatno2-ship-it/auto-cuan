#!/usr/bin/env node
'use strict';

/**
 * C (2026-10-23) — catch up missing broker-summary dates, newest first, with a
 * hard budget guard.
 *
 * WHY: J1 did not run on 20-22 Oct, so ALL/F/accumulation/insider are missing
 * for those dates (and 19 Oct is still ~920 emiten short). This tool fills the
 * gaps WITHOUT touching the daily jobs' quota:
 *
 *  - Newest date first (22, 21, 20, then the 19 Oct remainder).
 *  - Budget = ARJUM_DAILY_LIMIT - (J1 evening need + J2 + IHSG + 10% retry +
 *    web reserve). It never spends below that floor.
 *  - Small batches (default 50 emiten). If more than 20% of a batch fails, it
 *    STOPS and reports instead of burning quota on a broken provider.
 *  - Idempotent: a date/ticker that already has its file is skipped, and no
 *    other date is ever overwritten.
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
// Daily-job need that must stay untouched (J1 evening + J2 + IHSG + retry).
const DAILY_JOB_NEED = 4400;
const RETRY_RATIO = 0.10;
const WEB_RESERVE = 100;
// Weekend (Sat/Sun): there is NO J1 and NO J2, so the 4,940 floor does not
// apply. Only a small reserve for the live website + retries is kept, capped at
// 1,500 (owner decision, 23 Oct 2026).
const WEEKEND_RESERVE_CAP = 1500;
const WEEKEND_RETRY_RATIO = 0.10;
const WEEKEND_WEB_RESERVE = 100;

function dataDir(env) {
  const e = env || process.env;
  return e.ARJUM_DATA_DIR || path.join(ROOT_DIR, 'data', 'arjum-data');
}

function parseArgs(argv) {
  const opts = { dryRun: false, dates: [], batch: DEFAULT_BATCH, limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
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
  const floor = isWeekend
    ? Math.min(WEEKEND_RESERVE_CAP, Math.ceil(Number(limit) * WEEKEND_RETRY_RATIO) + WEEKEND_WEB_RESERVE)
    : Math.ceil(DAILY_JOB_NEED * (1 + RETRY_RATIO)) + WEB_RESERVE;
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

/** Emiten still missing a given date, per type. */
function missingForDate(baseDir, date) {
  const all = tickerDirs(path.join(baseDir, 'broker-summary'));
  const missingAll = all.filter((t) => !hasFile(path.join(baseDir, 'broker-summary'), t, date));
  return { total: all.length, missingAll };
}

async function run(argv, deps) {
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

  const dates = opts.dates.length ? opts.dates : ['2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19'];
  const plan = dates.map((date) => {
    const m = missingForDate(baseDir, date);
    return { date, total: m.total, missing: m.missingAll.length, tickers: m.missingAll };
  });

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
    plan: plan.map((p) => ({ date: p.date, total: p.total, missing: p.missing }))
  };

  if (opts.dryRun) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return summary;
  }

  let spent = 0;
  const results = [];
  for (const p of plan) {
    if (spent >= budget.spendable || spent >= opts.limit) break;
    const batch = p.tickers.slice(0, opts.batch);
    let ok = 0;
    let failed = 0;
    for (const ticker of batch) {
      if (spent >= budget.spendable || spent >= opts.limit) break;
      try {
        const res = await client.fetchBrokerSummary(ticker, p.date, null, null, { fresh: true, forceLive: true, noFallback: true });
        spent += 1;
        if (res && res.ok && res.data) {
          const dir = path.join(baseDir, 'broker-summary', ticker);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, p.date + '.json'), JSON.stringify(res.data, null, 2));
          ok += 1;
        } else {
          failed += 1;
        }
      } catch (_) {
        failed += 1;
      }
    }
    const ratio = batch.length ? failed / batch.length : 0;
    results.push({ date: p.date, attempted: batch.length, ok, failed, failure_ratio: Number(ratio.toFixed(3)) });
    if (ratio > MAX_FAILURE_RATIO) {
      summary.stopped = 'failure_ratio_exceeded';
      summary.stopped_on = p.date;
      break;
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
  MAX_FAILURE_RATIO, DAILY_JOB_NEED, WEEKEND_RESERVE_CAP
};
