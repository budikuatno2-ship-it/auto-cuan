#!/usr/bin/env node
'use strict';

/**
 * Screener snapshot producer — writes data/screener-latest.json.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Telegram bot (`lib/telegram-interactive-bot.js` → `roots.screener`) and the
 * AI grounding layer (`lib/market-context-service.js` → `findScreenerRow`) both
 * read a local file at `data/screener-latest.json`. Until now NOTHING in the
 * repository wrote it: `tools/run-screener.js` is a read-only diagnostic and
 * says so itself ("snapshot_missing: ... tidak ada producer yang jalan"), and
 * `tools/run-all-screeners-vps.js` publishes to Supabase but never materialises
 * a local file. The only writers were test fixtures.
 *
 * The result was that `/tanya`, `/analisa`, `/opini` and `/scan` always saw a
 * missing snapshot, so the AI never received the unified score, the trade plan,
 * or the bandarmologi verdict — even though the running VPS app held all of it.
 *
 * This tool closes that loop: it reads the already-computed results back from
 * the local VPS app (read-only HTTP GETs) and materialises them into the local
 * snapshot in the exact shape the readers expect.
 *
 * It does NOT compute anything. It does NOT run a screener. It copies the
 * canonical rows the daemon already produced, so the snapshot can never contain
 * a number that the API does not also serve.
 *
 * Usage:
 *   node tools/build-screener-snapshot.js            # write the snapshot
 *   node tools/build-screener-snapshot.js --dry-run  # report only, write nothing
 *   node tools/build-screener-snapshot.js --print    # also dump a summary
 *
 * Exit codes: 0 wrote (or dry-run ok), 2 nothing to write, 1 configuration error.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILES = ['.env.local', '.env.intraday-runtime', '.env'];
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

/**
 * Source actions → destination snapshot keys.
 *
 * `daytrade` and `swing` are the keys the bot's `loadScreener()` reads. The
 * `nk` / `non_konglo` aliases are written too because
 * `market-context-service.findScreenerRow()` scans that bucket name, and a row
 * that only exists under `swing_non_konglo` would otherwise be invisible to the
 * AI grounding layer.
 */
const SOURCES = [
  { action: 'screener', keys: ['swing'] },
  { action: 'nk-screener-results', keys: ['swing_non_konglo', 'nk'] },
  { action: 'daytrade-screener', keys: ['daytrade'] },
  { action: 'telegram-daily-picks', keys: ['top5'], optional: true }
];

function loadEnvFiles(env = process.env, cwd = ROOT) {
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  const filePaths = [
    ...ENV_FILES.map((f) => path.join(cwd, f)),
    path.join(runnerDir, '.env')
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

function snapshotPath(rootDir) {
  return path.join(rootDir || ROOT, 'data', 'screener-latest.json');
}

function parseArgs(argv) {
  const o = { dryRun: false, print: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--print') o.print = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error('Unknown option: ' + a);
  }
  return o;
}

function extractRows(payload) {
  if (!payload || payload.success === false) return [];
  for (const key of ['results', 'rows', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

/**
 * Keep only rows that carry a ticker. A row without one cannot be looked up by
 * the readers and would just be dead weight in the snapshot.
 */
function usableRows(rows) {
  return (rows || []).filter((r) => r && typeof r === 'object' && String(r.ticker || '').trim());
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
 * Build the snapshot object. Pure: takes already-fetched payloads so the shape
 * can be unit-tested without a live server.
 */
function buildSnapshot(payloads, options) {
  const opts = options || {};
  const snapshot = {
    updated_at: opts.updatedAt || new Date().toISOString(),
    generated_by: 'tools/build-screener-snapshot.js',
    source: 'local-vps-api'
  };
  const counts = {};

  for (const src of SOURCES) {
    const rows = usableRows(extractRows(payloads[src.action]));
    counts[src.action] = rows.length;
    if (!rows.length) continue;
    for (const key of src.keys) snapshot[key] = rows;
  }

  // `swing` doubles as the Konglo bucket for the AI reader, which scans
  // `data.swing`. Keep it explicit rather than relying on the alias above.
  if (!snapshot.swing && snapshot.swing_konglo) snapshot.swing = snapshot.swing_konglo;

  return { snapshot, counts };
}

async function main(options, deps) {
  options = options || parseArgs(process.argv);
  deps = deps || {};

  if (options.help) {
    console.log('Usage: node tools/build-screener-snapshot.js [--dry-run] [--print]');
    return { ok: true, help: true };
  }

  const env = deps.env || loadEnvFiles();
  const secret = env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET is required (checked .env.local, .env.intraday-runtime, .env).');

  const baseUrl = String(deps.baseUrl || env.APP_BASE_URL || env.VPS_LOCAL_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchFn = deps.fetchFn || fetch;
  const log = deps.log || console.log;
  const rootDir = deps.rootDir || ROOT;

  log('Screener snapshot producer');
  log('  base URL : ' + baseUrl);
  log('  mode     : ' + (options.dryRun ? 'DRY-RUN (nothing written)' : 'WRITE'));

  const payloads = {};
  const failures = [];
  for (const src of SOURCES) {
    try {
      payloads[src.action] = await fetchAction(baseUrl, secret, src.action, fetchFn);
    } catch (e) {
      failures.push(src.action + ': ' + e.message);
      if (!src.optional) log('  ! ' + src.action + ' failed: ' + e.message);
      else log('  - ' + src.action + ' skipped (optional): ' + e.message);
    }
  }

  const { snapshot, counts } = buildSnapshot(payloads);
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);

  log('  rows read:');
  for (const [action, n] of Object.entries(counts)) log('    ' + action.padEnd(24) + n);
  log('    ' + 'TOTAL'.padEnd(24) + totalRows);

  const withUnified = ['daytrade', 'swing', 'swing_non_konglo', 'top5']
    .flatMap((k) => snapshot[k] || [])
    .filter((r) => r.unified_score != null).length;
  log('  rows with unified_score   : ' + withUnified);

  if (totalRows === 0) {
    log('  nothing to write (all sources empty)');
    return { ok: false, reason: 'no_rows', counts, failures };
  }

  if (options.dryRun) {
    log('  dry-run: snapshot NOT written');
    if (options.print) log(JSON.stringify({ counts, sample: (snapshot.swing || [])[0] }, null, 2));
    return { ok: true, dryRun: true, counts, failures };
  }

  const target = snapshotPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Atomic write: a reader polling this file must never observe a half-written
  // JSON document, which would make the bot treat the snapshot as corrupt.
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n');
  fs.renameSync(tmp, target);

  const size = fs.statSync(target).size;
  log('  wrote ' + target + ' (' + size + ' bytes)');
  if (options.print) log(JSON.stringify({ counts, sample: (snapshot.swing || [])[0] }, null, 2));

  return { ok: true, path: target, counts, failures, bytes: size, rows: totalRows };
}

if (require.main === module) {
  main().then((res) => {
    process.exitCode = res.ok ? 0 : 2;
  }).catch((e) => {
    console.error('ERROR: ' + e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  ENV_FILES,
  DEFAULT_BASE_URL,
  SOURCES,
  loadEnvFiles,
  snapshotPath,
  parseArgs,
  extractRows,
  usableRows,
  fetchAction,
  buildSnapshot,
  main
};
