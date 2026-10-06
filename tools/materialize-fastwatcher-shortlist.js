#!/usr/bin/env node
'use strict';

/**
 * FastWatcher shortlist materializer — BUG-3C-01.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production cron invoked `run-screener.js --mode=fastwatcher`, which looked
 * for a `fastwatcher` key inside data/screener-latest.json. That key is never
 * produced (the EOD snapshot builder writes swing / swing_non_konglo / nk /
 * daytrade only), so FastWatcher logged `no_candidates` on 100% of runs.
 *
 * The canonical FastWatcher architecture is the dedicated intraday engine:
 *   deploy/vps/run-fastwatcher.sh
 *     → tools/run-intraday-fast-watcher-guarded-live.js
 *       → lib/intraday-fast-watcher-guarded-live.js
 *         (2/2 confirmation pool, anti-chase, kill switches)
 * which consumes a DayTrade FULL-SCREENER shortlist payload. This tool is the
 * missing producer step: it reads the already-computed DayTrade results from
 * the local VPS daemon (read-only HTTP GET, same CRON_SECRET contract as
 * tools/build-screener-snapshot.js) and materializes them into
 * data/fastwatcher-shortlist.json in the exact shape the guarded-live engine
 * accepts (a `results` array of ticker rows, or `radar_candidates` strings).
 *
 * It does NOT compute anything, does NOT run a screener, and never invents
 * candidates. An empty daemon result is written as an empty payload so the
 * engine can legitimately produce 0 candidates for a REAL reason (no setup),
 * instead of a structurally impossible contract.
 *
 * It also applies the canonical IDX trading-day guard (weekend + exchange
 * holiday, lib/idx-trading-calendar.js) BEFORE any daemon read, so the
 * production wrapper can skip non-trading days cheaply and deterministically.
 *
 * Usage:
 *   node tools/materialize-fastwatcher-shortlist.js
 *   node tools/materialize-fastwatcher-shortlist.js --dry-run --print
 *
 * Exit codes: 0 wrote (or dry-run ok), 3 non-trading day (skip), 1 configuration error.
 */

const fs = require('node:fs');
const path = require('node:path');

const calendar = require(path.resolve(__dirname, '..', 'lib', 'idx-trading-calendar'));
const snapshotFreshness = require(path.resolve(__dirname, '..', 'lib', 'snapshot-freshness'));

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_OUTPUT = path.join(ROOT, 'data', 'fastwatcher-shortlist.json');

// BUG-RT-02: first-wins loader — runner-owned .env first (highest priority),
// then repository files (.env.local > .env.intraday-runtime > .env).
const ENV_FILES = ['.env.local', '.env.intraday-runtime', '.env'];

function loadEnvFiles(env = process.env, cwd = ROOT) {
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  const filePaths = [
    path.join(runnerDir, '.env'),
    ...ENV_FILES.map((f) => path.join(cwd, f))
  ];
  for (const filePath of filePaths) {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    text.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
      if (!m || Object.prototype.hasOwnProperty.call(env, m[1])) return;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      env[m[1]] = v;
      if (process.env[m[1]] == null || process.env[m[1]] === '') process.env[m[1]] = v;
    });
  }
  return env;
}

function parseArgs(argv) {
  const o = { dryRun: false, print: false, output: DEFAULT_OUTPUT, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--print') o.print = true;
    else if (a === '--output') o.output = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error('Unknown option: ' + a);
  }
  return o;
}

const DEFAULT_MAX_SHORTLIST_ROWS = 12;

function extractRows(payload) {
  if (!payload || payload.success === false) return [];
  for (const key of ['results', 'rows', 'data', 'radar_candidates']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function isValidCandidateSetup(row) {
  if (typeof row === 'string') return row.trim() !== '';
  if (!row || typeof row !== 'object') return false;
  const ticker = String(row.ticker || row.symbol || row.code || '').trim();
  if (!ticker) return false;
  const status = String(row.status || row.current_status || row.signal_status || row.production_status || '').trim().toUpperCase();
  if (['AVOID', 'INVALIDATED', 'INVALID_DATA', 'STALE', 'BLOCKED', 'BLOCKED_CHASE'].includes(status)) {
    return false;
  }
  const riskLabel = String(row.risk_label || row.risk_status || row.risk_grade || '').trim().toUpperCase();
  if (riskLabel.includes('VERY HIGH') || riskLabel === 'VERY_HIGH' || row.high_risk_blocked === true) {
    return false;
  }
  const entryLow = Number(row.entry_low);
  const entryHigh = Number(row.entry_high);
  const stopLoss = Number(row.stop_loss != null ? row.stop_loss : row.sl);
  const tp1 = Number(row.tp1);

  if (Number.isFinite(entryLow) && Number.isFinite(entryHigh) && entryLow > entryHigh) {
    return false;
  }
  if (Number.isFinite(stopLoss) && Number.isFinite(entryLow) && stopLoss >= entryLow) {
    return false;
  }
  if (Number.isFinite(tp1) && Number.isFinite(entryHigh) && tp1 <= entryHigh) {
    return false;
  }
  return true;
}

function usableRows(rows, maxLimit = DEFAULT_MAX_SHORTLIST_ROWS) {
  return (rows || [])
    .filter(isValidCandidateSetup)
    .slice(0, maxLimit);
}

function sourceStatus(payload) {
  return String((payload && ((payload.meta && payload.meta.status) || payload.status)) || '').trim().toLowerCase();
}

function extractSourceDate(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [];
  if (payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)) candidates.push(payload.meta);
  candidates.push(payload);
  for (const candidate of candidates) {
    const extracted = snapshotFreshness.extractSnapshotDate(candidate);
    if (extracted) return extracted.date;
  }
  return null;
}

async function fetchAction(baseUrl, secret, action, fetchFn) {
  const url = new URL('/api/sector-hot', baseUrl);
  url.searchParams.set('action', action);
  const res = await fetchFn(url, {
    headers: { Authorization: 'Bearer ' + secret, Accept: 'application/json' },
    signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for action=' + action);
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error('Invalid JSON for action=' + action);
  }
  return data;
}

/**
 * Build the canonical FastWatcher shortlist payload. Pure: takes the fetched
 * daemon payload so the shape can be unit-tested without a live server.
 *
 * Output shape is intentionally one the guarded-live engine already accepts:
 *   { status, source, generated_at, run_date, results: [ {ticker,...}, ... ] }
 * If DayTrade producer is running, a valid, fresh completed shortlist from the
 * existing file on disk may be safely reused with producer_overlap_reuse=true.
 * Otherwise a `status: 'running'` answer is preserved so the engine skips fail-closed.
 */
function buildShortlist(payload, options) {
  const opts = options || {};
  const maxRows = opts.maxShortlist || DEFAULT_MAX_SHORTLIST_ROWS;
  const status = sourceStatus(payload);
  if (status === 'running' || status === 'scanning') {
    if (opts.existingShortlist && opts.existingShortlist.status === 'published' &&
        Array.isArray(opts.existingShortlist.results) && opts.existingShortlist.results.length > 0 &&
        opts.existingFreshness && opts.existingFreshness.fresh) {
      const reusedRows = usableRows(opts.existingShortlist.results, maxRows);
      return {
        payload: Object.assign({}, opts.existingShortlist, {
          status: 'published',
          source: opts.existingShortlist.source || 'local-vps-api:daytrade-screener',
          generated_at: opts.existingShortlist.generated_at || new Date().toISOString(),
          run_date: opts.existingShortlist.run_date || opts.sourceRunDate || null,
          results: reusedRows,
          producer_overlap_reuse: true
        }),
        counts: { rows: reusedRows.length, running: true, producer_overlap_reuse: true }
      };
    }
    return {
      payload: {
        status: 'running',
        source: 'local-vps-api:daytrade-screener',
        generated_at: new Date().toISOString(),
        run_date: opts.sourceRunDate || extractSourceDate(payload) || null,
        results: [],
        producer_overlap_reuse: false
      },
      counts: { rows: 0, running: true, producer_overlap_reuse: false }
    };
  }
  const rows = usableRows(extractRows(payload), maxRows);
  return {
    payload: {
      status: 'published',
      source: 'local-vps-api:daytrade-screener',
      generated_at: new Date().toISOString(),
      run_date: opts.sourceRunDate || extractSourceDate(payload) || null,
      results: rows,
      producer_overlap_reuse: false
    },
    counts: { rows: rows.length, running: false, producer_overlap_reuse: false }
  };
}

async function main(options, deps) {
  options = options || parseArgs(process.argv);
  deps = deps || {};

  if (options.help) {
    console.log('Usage: node tools/materialize-fastwatcher-shortlist.js [--dry-run] [--print] [--output PATH]');
    return { ok: true, help: true };
  }

  const env = deps.env || loadEnvFiles();
  const log = deps.log || console.log;
  const runDate = deps.runDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  const holidaySet = deps.holidaySet instanceof Set ? deps.holidaySet : calendar.getSeedHolidaySet();

  log('FastWatcher shortlist materializer');
  log('  run date : ' + runDate);

  // Canonical trading-day guard: weekends and IDX exchange holidays skip
  // before any daemon read or engine fetch (fail closed, cheap, deterministic).
  if (!calendar.isTradingDay(runDate, holidaySet)) {
    log('  SKIP_NON_TRADING_DAY: ' + runDate + ' is not an IDX trading day');
    return { ok: true, skipped: true, reason: 'MARKET_CLOSED', runDate };
  }

  const secret = env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET is required (checked runner .env, .env.local, .env.intraday-runtime, .env).');

  const baseUrl = String(deps.baseUrl || env.APP_BASE_URL || env.VPS_LOCAL_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchFn = deps.fetchFn || fetch;

  log('  base URL : ' + baseUrl);
  log('  mode     : ' + (options.dryRun ? 'DRY-RUN (nothing written)' : 'WRITE'));

  const payload = await fetchAction(baseUrl, secret, 'daytrade-screener', fetchFn);
  const status = sourceStatus(payload);
  const sourceDate = extractSourceDate(payload);

  const target = options.output || DEFAULT_OUTPUT;
  const evaluationNow = deps.now || new Date(runDate + 'T12:00:00+07:00');

  let existingShortlist = deps.existingShortlist || null;
  if (!existingShortlist && fs.existsSync(target)) {
    try {
      existingShortlist = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (_) {
      existingShortlist = null;
    }
  }

  let existingFreshness = { fresh: false, reason: 'no_existing_shortlist' };
  if (existingShortlist && existingShortlist.status === 'published' &&
      Array.isArray(existingShortlist.results) && existingShortlist.results.length > 0) {
    const existingSourceDate = extractSourceDate(existingShortlist) || existingShortlist.run_date;
    if (existingSourceDate) {
      existingFreshness = snapshotFreshness.evaluateSnapshotFreshness({
        snapshotDate: existingSourceDate,
        mode: 'daytrade',
        now: evaluationNow,
        holidaySet
      });
    }
  }

  // FastWatcher is allowed to seed its live scan from today's DayTrade full
  // screener or the latest completed trading session. Anything older (or
  // missing provenance) fails closed so stale shortlist rows can never be
  // relabelled as today's data by this materializer.
  if (status !== 'running' && status !== 'scanning') {
    const sourceFreshness = snapshotFreshness.evaluateSnapshotFreshness({
      snapshotDate: sourceDate,
      mode: 'daytrade',
      now: evaluationNow,
      holidaySet
    });
    if (!sourceFreshness.fresh) {
      log('  STALE_SOURCE: DayTrade source=' + (sourceDate || 'none') +
        ' acceptable=' + JSON.stringify(sourceFreshness.acceptable_dates) +
        ' reason=' + sourceFreshness.reason);
      return {
        ok: false,
        reason: 'STALE_SOURCE',
        sourceDate,
        freshness: sourceFreshness
      };
    }
  }

  const { payload: shortlist, counts } = buildShortlist(payload, {
    sourceRunDate: sourceDate,
    existingShortlist,
    existingFreshness
  });

  if (counts.producer_overlap_reuse) {
    log('  OVERLAP_REUSE: producer is running, reusing last completed fresh shortlist (' +
      counts.rows + ' rows, source date ' + (shortlist.run_date || 'unknown') + ')');
  }

  log('  source date: ' + (shortlist.run_date || sourceDate || 'none'));
  log('  rows     : ' + counts.rows + (counts.running ? (counts.producer_overlap_reuse ? ' (producer running, overlap reuse)' : ' (full screener running)') : ''));

  if (options.dryRun) {
    log('  dry-run: shortlist NOT written');
    if (options.print) log(JSON.stringify(shortlist, null, 2));
    return { ok: true, dryRun: true, counts, shortlist, producer_overlap_reuse: counts.producer_overlap_reuse === true };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(shortlist, null, 2) + '\n');
  fs.renameSync(tmp, target);

  log('  wrote ' + target + ' (' + fs.statSync(target).size + ' bytes)');
  if (options.print) log(JSON.stringify(shortlist, null, 2));

  return { ok: true, path: target, counts, shortlist, producer_overlap_reuse: counts.producer_overlap_reuse === true };
}

if (require.main === module) {
  main().then((res) => {
    // 3 = non-trading day: the wrapper logs the skip and exits 0.
    process.exitCode = res.skipped ? 3 : (res.ok ? 0 : 2);
  }).catch((e) => {
    console.error('ERROR: ' + e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  ENV_FILES,
  DEFAULT_BASE_URL,
  DEFAULT_OUTPUT,
  loadEnvFiles,
  parseArgs,
  extractRows,
  usableRows,
  sourceStatus,
  extractSourceDate,
  fetchAction,
  buildShortlist,
  main
};
