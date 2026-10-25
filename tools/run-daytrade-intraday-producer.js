#!/usr/bin/env node
'use strict';

/**
 * Canonical VPS intraday DayTrade producer.
 *
 * Restores the producer half of the 09:00-16:00 pipeline after the VPS
 * migration. The existing run-daytrade.sh jobs are consumers/senders only;
 * FastWatcher also consumes the canonical DayTrade latest table. Without this
 * producer both paths freeze when the previous EOD producer fails.
 *
 * Production contract:
 * - local VPS API only (never Vercel)
 * - FAST DayTrade universe (same contract as local_scan_runner auto-fast)
 * - explicit --execute required
 * - market-session guard before mutation
 * - defer public producer delivery to FastWatcher (no duplicate stock signal)
 * - materialize screener-latest.json after successful publication so the
 *   scheduled DayTrade sender sees authoritative per-mode source_dates
 */

const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const guard = require(path.join(ROOT, 'lib', 'market-hours-guard'));
const runner = require(path.join(ROOT, 'tools', 'run-all-screeners-vps'));
const snapshotBuilder = require(path.join(ROOT, 'tools', 'build-screener-snapshot'));
const snapshotAlarm = require(path.join(ROOT, 'lib', 'daytrade-snapshot-alarm'));

function cleanStaleLockFile(lockPath = '/tmp/daytrade.lock', maxAgeMs = 12 * 60 * 1000) {
  try {
    const fsInstance = require('node:fs');
    if (!fsInstance.existsSync(lockPath)) return false;
    const stat = fsInstance.statSync(lockPath);
    const ageMs = Date.now() - (stat.mtimeMs || stat.mtime.getTime());
    if (ageMs > maxAgeMs) {
      let pidActive = false;
      try {
        const content = fsInstance.readFileSync(lockPath, 'utf8').trim();
        const pid = parseInt(content, 10);
        if (Number.isFinite(pid) && pid > 0) {
          process.kill(pid, 0);
          pidActive = true;
        }
      } catch (_) {
        pidActive = false;
      }
      if (!pidActive) {
        fsInstance.unlinkSync(lockPath);
        console.warn(`[DAYTRADE-PRODUCER] Stale lockfile ${lockPath} removed (age: ${Math.round(ageMs / 60000)}m, PID inactive).`);
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function parseArgs(argv) {
  const defaultSpeed = process.env.DAYTRADE_RUN_SPEED || 'full';
  const opts = { execute: false, maxBatches: 120, sleepMs: 500, force: false, syncSnapshot: false, speed: defaultSpeed };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--dry-run') opts.execute = false;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--sync-snapshot') opts.syncSnapshot = true;
    else if (arg === '--max-batches') opts.maxBatches = Math.max(1, Number(argv[++i]) || opts.maxBatches);
    else if (arg === '--sleep-ms') opts.sleepMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === '--speed') opts.speed = normalizeSpeed(argv[++i]);
    else if (arg.indexOf('--speed=') === 0) opts.speed = normalizeSpeed(arg.slice('--speed='.length));
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error('Unknown option: ' + arg);
  }
  return opts;
}

function terminalStatus(value) {
  return ['published', 'already_done', 'completed'].includes(String(value || '').toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry policy for a MISSING/UNKNOWN producer status.
//
// A missing status is almost always a transient transport/shape problem (the
// dashboard timeout guard used to answer heavy scans with an empty 200 body).
// Aborting the whole 15-minute cycle on it froze DayTrade for six sessions, so
// an unknown status now retries with backoff instead of throwing immediately.
// The whole loop stays bounded by opts.maxBatches and the cron cadence.
const UNKNOWN_STATUS_RETRY_DELAYS_MS = [1000, 3000, 8000, 15000, 30000];

function isTransientStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === '' || s === 'unknown' || s === 'missing' || s === 'undefined' || s === 'null';
}

function retryDelayFor(attempt) {
  const idx = Math.min(Math.max(0, attempt), UNKNOWN_STATUS_RETRY_DELAYS_MS.length - 1);
  return UNKNOWN_STATUS_RETRY_DELAYS_MS[idx];
}

/**
 * A snapshot with zero rows must never replace a healthy snapshot file.
 * `build-screener-snapshot` reports `{ ok:true, rows:0 }` when every upstream
 * table is empty (exactly what the frozen producer produced), and writing that
 * over a good file destroys the last usable DayTrade state.
 */
function shouldRejectEmptySnapshot(snapshot) {
  if (!snapshot || snapshot.ok !== true) return false;
  const rows = Number(snapshot.rows || 0);
  return !Number.isFinite(rows) || rows <= 0;
}

// ---------------------------------------------------------------------------
// Run-speed modes.
//
// `fast` is the historic 258-name curated shortlist. `full` scans the entire
// eligible DayTrade universe (~800 names) using the SAME BATCH_SIZE 50 that
// api/sector-hot.js already applies to full mode. The DEFAULT stays `fast`, so
// the existing 15-minute cron keeps its exact current behaviour until the
// schedule is deliberately reviewed (change request A3).
//
// A full run must never overrun a single 15-minute slot, so the producer aborts
// cleanly at the ceiling: the last good snapshot stays on disk, the run is
// logged as ABORTED_TIMEOUT, and a half-finished scan is never published.
const RUN_SPEEDS = new Set(['fast', 'full']);
const DAYTRADE_SPEED_BATCH_SIZE = 50; // mirrors api/sector-hot.js full-mode BATCH_SIZE
const FULL_RUN_TIMEOUT_MS = 6 * 60 * 1000;
const FAST_RUN_TIMEOUT_MS = 4 * 60 * 1000;

function normalizeSpeed(value) {
  const s = String(value == null ? '' : value).toLowerCase().trim();
  return RUN_SPEEDS.has(s) ? s : 'fast';
}

function resolveRunTimeoutMs(opts) {
  const configured = Number(opts && opts.timeoutMs);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return (opts && opts.speed === 'full') ? FULL_RUN_TIMEOUT_MS : FAST_RUN_TIMEOUT_MS;
}

function readPeakRssMb() {
  try { return Math.round((process.memoryUsage().rss || 0) / (1024 * 1024)); }
  catch (_) { return null; }
}

function readLoadAvg1() {
  try {
    const l = os.loadavg();
    return Number.isFinite(l && l[0]) ? Number(l[0].toFixed(2)) : null;
  } catch (_) { return null; }
}

/**
 * Emit ONE Telegram alert per stale-snapshot incident.
 *
 * State is persisted in `data/daytrade-snapshot-alarm.json` so the 15-minute
 * cron cannot spam: an alert is re-armed only after the snapshot becomes fresh
 * again (or the alarm module's cooldown elapses).
 */
async function maybeAlertStaleSnapshot(ctx) {
  const deps = ctx.deps || {};
  const log = ctx.log || console.log;
  const fsInstance = deps.fs || require('node:fs');
  const rootDir = deps.rootDir || ROOT;
  const statePath = path.join(rootDir, 'data', 'daytrade-snapshot-alarm.json');
  const snapshotPath = snapshotBuilder.snapshotPath
    ? snapshotBuilder.snapshotPath(rootDir)
    : path.join(rootDir, 'data', 'screener-latest.json');

  let snapshotMtime = null;
  try {
    if (fsInstance.existsSync(snapshotPath)) snapshotMtime = fsInstance.statSync(snapshotPath).mtime;
  } catch (_) {}

  let lastAlertAt = null;
  let lastReason = null;
  try {
    if (fsInstance.existsSync(statePath)) {
      const raw = JSON.parse(fsInstance.readFileSync(statePath, 'utf8'));
      lastAlertAt = raw && raw.last_alert_at ? raw.last_alert_at : null;
      lastReason = raw && raw.last_reason ? raw.last_reason : null;
    }
  } catch (_) {}

  const decision = snapshotAlarm.evaluate({
    snapshotMtime,
    now: ctx.now,
    marketOpen: ctx.market && ctx.market.isOpen === true,
    lastAlertAt,
    staleMinutes: deps.staleMinutes,
    cooldownMs: deps.alarmCooldownMs
  });

  if (!decision.shouldAlert) {
    if (decision.reason === 'fresh' && lastAlertAt) {
      // Re-arm for the next incident.
      try {
        fsInstance.writeFileSync(statePath, JSON.stringify({ last_alert_at: null, last_reason: null, rearmed_at: new Date().toISOString() }, null, 2));
      } catch (_) {}
    }
    return decision;
  }

  log('  ALARM    : snapshot stale (' + decision.reason + ', ' + decision.ageMinutes + ' min) — sending Telegram');
  const sent = await snapshotAlarm.send(
    { ageMinutes: decision.ageMinutes, reason: decision.reason, staleMinutes: deps.staleMinutes },
    { notifier: deps.notifier }
  );
  log('  ALARM    : ' + (sent.sent ? 'sent' : 'not sent (' + (sent.reason || 'unknown') + ')'));

  if (sent.sent) {
    try {
      fsInstance.writeFileSync(statePath, JSON.stringify({
        last_alert_at: new Date().toISOString(),
        last_reason: decision.reason,
        age_minutes: decision.ageMinutes
      }, null, 2));
    } catch (_) {}
  }
  return Object.assign({}, decision, { sent: sent.sent, sendReason: sent.reason || null });
}

async function run(options, deps) {
  cleanStaleLockFile();
  const opts = options || parseArgs(process.argv);
  deps = deps || {};
  const log = deps.log || console.log;
  const now = deps.now || new Date();
  const market = (deps.getMarketSessionStatus || guard.getMarketSessionStatus)(now);

  log('DayTrade intraday producer');
  log('  market   : ' + String(market.status || market.session || 'UNKNOWN') +
    ' (' + String(market.reason || '-') + ')');

  const env = deps.env || runner.loadEnvFiles();
  const baseUrl = deps.baseUrl || runner.resolveBaseUrl(env);

  if (!market || market.isOpen !== true) {
    log('  skip     : market session is not open');
    const fsInstance = deps.fs || require('node:fs');
    const targetFile = snapshotBuilder.snapshotPath ? snapshotBuilder.snapshotPath(deps.rootDir || ROOT) : path.join(deps.rootDir || ROOT, 'data', 'screener-latest.json');
    if (!fsInstance.existsSync(targetFile) || opts.force || opts.syncSnapshot) {
      log('  snapshot : file missing or sync requested at MARKET_CLOSED, synchronizing...');
      try {
        const buildSnapshot = deps.buildSnapshot || snapshotBuilder.main;
        await buildSnapshot(
          { dryRun: false, print: false },
          {
            baseUrl,
            env,
            rootDir: deps.rootDir || ROOT,
            fetchFn: deps.snapshotFetch || deps.fetch
          }
        );
      } catch (err) {
        log('  snapshot sync warning: ' + (err && err.message ? err.message : String(err)));
      }
    }
    return { ok: true, skipped: true, reason: 'MARKET_CLOSED', market };
  }

  // Alert once per incident when the snapshot is stale during market hours.
  // Runs BEFORE the scan so a broken producer still notifies on every firing
  // (the alarm module applies its own per-episode cooldown).
  await maybeAlertStaleSnapshot({ deps, log, now, market });

  if (!env.CRON_SECRET) throw new Error('CRON_SECRET is required.');
  runner.assertNotServerlessForExecute(baseUrl, opts.execute);

  const client = deps.client || runner.makeClient(baseUrl, env.CRON_SECRET, deps.fetch);
  if (!opts.execute) {
    const current = await client.call({ action: 'daytrade-screener' });
    log('  mode     : DRY-RUN');
    return { ok: true, dryRun: true, base_url: baseUrl, current };
  }

  const mem = runner.assertHeavyScanMemoryHeadroom(env, deps.fs);
  if (mem.availableMb != null) {
    log('  memory   : ' + mem.availableMb.toFixed(1) + ' MB available (floor ' + mem.minMb.toFixed(0) + ' MB)');
  }

  const speed = normalizeSpeed(opts.speed);
  const timeoutMs = resolveRunTimeoutMs({ speed, timeoutMs: opts.timeoutMs });
  const startedMs = Date.now();
  const deadlineMs = startedMs + timeoutMs;
  const loadStart = readLoadAvg1();
  let peakRssMb = readPeakRssMb();

  log('  mode     : EXECUTE / ' + speed.toUpperCase());
  log('  timeout  : ' + Math.round(timeoutMs / 1000) + 's (single run ceiling)');
  log('  load 1m  : start=' + loadStart + '  rss=' + peakRssMb + 'MB');
  log('  delivery : deferred_to_fast_watcher');
  log('  base URL : ' + baseUrl);

  let batch = 0;
  let last = null;
  let lastGood = null;
  let unknownStatusRetries = 0;

  // Per-run summary. duration_ms is measured producer-side so the 15-minute slot
  // always records how long the whole run really took, not just one batch.
  const buildRunMeta = () => ({
    run_speed: speed,
    universe_count: Number(lastGood && lastGood.universe_count || 0),
    scanned_count: Number(lastGood && lastGood.scanned_count || 0),
    duration_ms: Math.max(0, Date.now() - startedMs),
    peak_rss_mb: peakRssMb,
    loadavg1_start: loadStart,
    loadavg1_end: readLoadAvg1()
  });

  const logRunSummary = (outcome) => {
    const meta = buildRunMeta();
    log('  summary  : ' + outcome +
      ' mode=' + speed +
      ' universe=' + meta.universe_count +
      ' scanned=' + meta.scanned_count +
      ' duration=' + meta.duration_ms + 'ms' +
      ' peak_rss=' + meta.peak_rss_mb + 'MB' +
      ' load1=' + meta.loadavg1_start + '->' + meta.loadavg1_end);
    return meta;
  };

  while (batch < opts.maxBatches) {
    // Abort cleanly before spending the next batch if the slot is already spent.
    // The last good snapshot stays on disk and a half scan is never published.
    if (Date.now() >= deadlineMs) {
      const meta = logRunSummary('ABORTED_TIMEOUT');
      log('  abort    : run exceeded ' + Math.round(timeoutMs / 1000) + 's ceiling; stopping cleanly (no publish, last good snapshot preserved)');
      return {
        ok: false,
        aborted: true,
        published: false,
        reason: 'ABORTED_TIMEOUT',
        run_speed: speed,
        universe_count: meta.universe_count,
        scanned_count: meta.scanned_count,
        duration_ms: meta.duration_ms,
        peak_rss_mb: meta.peak_rss_mb,
        loadavg1_start: meta.loadavg1_start,
        loadavg1_end: meta.loadavg1_end,
        response: last
      };
    }

    const query = {
      action: 'daytrade-screener-run',
      force: 1,
      batch,
      mode: 'auto',
      speed,
      send_radar: 0,
      defer_to_fast_watcher: 1
    };

    last = await client.call(query);
    peakRssMb = Math.max(Number(peakRssMb || 0), Number(readPeakRssMb() || 0));
    const status = String(last && last.status || '').toLowerCase();
    log('  batch ' + batch + ': status=' + (status || 'unknown') +
      ' scanned=' + Number(last && last.scanned_count || 0) +
      '/' + Number(last && last.universe_count || 0));
    if (Number(last && last.universe_count || 0) > 0) lastGood = last;

    // Missing/unknown status = transient. Retry the SAME batch with backoff
    // instead of aborting the whole 15-minute cycle (see the 13 Oct outage).
    if (isTransientStatus(status)) {
      const retry = unknownStatusRetries;
      if (retry >= UNKNOWN_STATUS_RETRY_DELAYS_MS.length) {
        throw new Error('DayTrade producer status stayed unknown after ' +
          UNKNOWN_STATUS_RETRY_DELAYS_MS.length + ' retries (last note: ' +
          String(last && last.note || 'none') + ')');
      }
      const waitMs = retryDelayFor(retry);
      log('  retry    : status missing/unknown, waiting ' + waitMs + 'ms (attempt ' + (retry + 1) + '/' + UNKNOWN_STATUS_RETRY_DELAYS_MS.length + ')');
      unknownStatusRetries += 1;
      await sleep(waitMs);
      continue;
    }
    unknownStatusRetries = 0;

    if (terminalStatus(status)) {
      const buildSnapshot = deps.buildSnapshot || snapshotBuilder.main;
      const snapshot = await buildSnapshot(
        { dryRun: false, print: false },
        {
          baseUrl,
          env,
          rootDir: deps.rootDir || ROOT,
          fetchFn: deps.snapshotFetch || deps.fetch
        }
      );
      if (!snapshot || snapshot.ok !== true) {
        throw new Error('DayTrade published but snapshot materialization failed: ' +
          String(snapshot && snapshot.reason || 'unknown'));
      }
      const runMeta = logRunSummary(String(status).toUpperCase());
      // Never let an empty snapshot overwrite the last healthy one.
      if (shouldRejectEmptySnapshot(snapshot)) {
        log('  snapshot : SKIPPED — producer reported 0 rows, existing file preserved');
        return {
          ok: true,
          status,
          run_date: last.run_date || null,
          run_id: last.run_id || null,
          published_count: Number(last.published_count || 0),
          run_speed: speed,
          universe_count: runMeta.universe_count,
          scanned_count: runMeta.scanned_count,
          duration_ms: runMeta.duration_ms,
          meta: runMeta,
          snapshot: Object.assign({}, snapshot, { rejected_empty: true })
        };
      }
      log('  snapshot : materialized (' + Number(snapshot.rows || 0) + ' rows)');
      return {
        ok: true,
        status,
        run_date: last.run_date || null,
        run_id: last.run_id || null,
        published_count: Number(last.published_count || 0),
        run_speed: speed,
        universe_count: runMeta.universe_count,
        scanned_count: runMeta.scanned_count,
        duration_ms: runMeta.duration_ms,
        meta: runMeta,
        snapshot
      };
    }

    if (status === 'paused') {
      log('  skip     : endpoint paused for market session (' + String(last.reason || 'market_break') + ')');
      return { ok: true, skipped: true, reason: last.reason || 'MARKET_PAUSED', response: last };
    }

    if (status === 'failed' || last.success === false) {
      throw new Error('DayTrade producer failed: ' + String(last.error || last.error_code || status || 'unknown'));
    }

    // The API refuses a second concurrent full scan and answers `skipped`. Treat
    // that as a clean slot skip, not an error: the ongoing run owns this slot.
    if (status === 'skipped' || last.skipped_due_to_running === true) {
      log('  skip     : SKIPPED_RUNNING — a previous DayTrade scan is still running.');
      return { ok: true, skipped: true, reason: 'SKIPPED_RUNNING', run_speed: speed, response: last };
    }

    if (status !== 'running') {
      throw new Error('Unexpected DayTrade producer status: ' + (status || 'missing'));
    }

    const next = Number(last.next_batch);
    batch = Number.isInteger(next) && next > batch ? next : batch + 1;
    if (opts.sleepMs > 0) await sleep(opts.sleepMs);
  }

  throw new Error('DayTrade producer reached --max-batches without publication.');
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage: node tools/run-daytrade-intraday-producer.js [--dry-run|--execute] [--speed fast|full] [--max-batches N] [--sleep-ms N]');
    return;
  }
  const result = await run(opts);
  if (!result || result.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('ERROR: ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  terminalStatus,
  run,
  // Exported for unit tests (13 Oct outage regression coverage).
  isTransientStatus,
  retryDelayFor,
  shouldRejectEmptySnapshot,
  maybeAlertStaleSnapshot,
  UNKNOWN_STATUS_RETRY_DELAYS_MS,
  // Run-speed contract (full-universe scan feature).
  normalizeSpeed,
  resolveRunTimeoutMs,
  RUN_SPEEDS,
  DAYTRADE_SPEED_BATCH_SIZE,
  FULL_RUN_TIMEOUT_MS,
  FAST_RUN_TIMEOUT_MS,
  readPeakRssMb,
  readLoadAvg1
};
