#!/usr/bin/env node
'use strict';

const DEFAULT_BASE_URL = 'https://auto-cuan.vercel.app';
const DRY_PATH = '/api/sector-hot?action=telegram-daily-picks&lock_only=1&dry_run=1';
const LOCK_PATH = '/api/sector-hot?action=telegram-daily-picks&lock_only=1';
const BLOCK_REASONS = new Set(['screeners_not_ready', 'top5_gate_blocked', 'no_candidates']);
const ALREADY_LOCKED_REASONS = new Set(['already_locked_dry_run', 'already_locked']);

function printHelp() {
  console.log(`Usage: node tools/run-after-market-top5-lock.js [options]\n\nSafely previews the after-market Top 5 lock-only flow. Default mode is dry-run/read-only.\nScan refresh orchestration is intentionally out of scope for this phase.\n\nOptions:\n  --base-url <url>  Override BASE_URL/AUTO_CUAN_BASE_URL (default: ${DEFAULT_BASE_URL})\n  --json            Print only the concise JSON summary\n  --execute-lock    After a safe dry-run, execute lock_only=1 (requires --yes)\n  --yes             Required with --execute-lock\n  -h, --help        Show this help\n\nEnvironment:\n  CRON_SECRET       Required; sent as Authorization: Bearer <CRON_SECRET>\n  BASE_URL          Optional base URL\n  AUTO_CUAN_BASE_URL Optional base URL fallback\n`);
}

function parseArgs(argv) {
  const opts = { json: false, executeLock: false, yes: false, baseUrl: process.env.BASE_URL || process.env.AUTO_CUAN_BASE_URL || DEFAULT_BASE_URL };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--execute-lock') opts.executeLock = true;
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--base-url') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--base-url requires a URL value');
      opts.baseUrl = value;
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function buildUrl(baseUrl, path) {
  const base = new URL(baseUrl);
  return new URL(path, base).toString();
}

async function fetchJson(baseUrl, path, cronSecret) {
  const url = buildUrl(baseUrl, path);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cronSecret}`, Accept: 'application/json' } });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    const err = new Error(`Invalid JSON from ${url}: ${error.message}`);
    err.exitCode = 1;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${url}`);
    err.exitCode = 1;
    err.response = json;
    throw err;
  }
  return json;
}

function isSafeDryRun(data) {
  return data && data.success === true && data.mode === 'lock_only' && data.dry_run === true && data.sent === false && data.telegram_sent === false && data.skipped_send === true && data.write_suppressed_by_dry_run === true;
}

function hasTelegramRisk(data) {
  return data && (data.sent !== false || data.telegram_sent !== false || data.skipped_send !== true);
}

function makeSummary(baseUrl, dryRun, lock, executedLock) {
  return {
    base_url: baseUrl,
    dry_run_success: dryRun ? dryRun.success === true : false,
    dry_run_reason: dryRun ? dryRun.reason || null : null,
    would_lock: dryRun ? dryRun.would_lock === true : false,
    would_insert_count: dryRun && Number.isFinite(Number(dryRun.would_insert_count)) ? Number(dryRun.would_insert_count) : 0,
    would_lock_tickers: dryRun && Array.isArray(dryRun.would_lock_tickers) ? dryRun.would_lock_tickers : [],
    already_locked: Boolean((dryRun && dryRun.already_locked) || (lock && lock.already_locked)),
    existing_locked_count: dryRun && Number.isFinite(Number(dryRun.existing_locked_count)) ? Number(dryRun.existing_locked_count) : 0,
    executed_lock: executedLock,
    lock_success: lock ? lock.success === true : false,
    lock_reason: lock ? lock.reason || null : null,
    lock_count: lock && Number.isFinite(Number(lock.lock_count)) ? Number(lock.lock_count) : 0,
    locked_tickers: lock && Array.isArray(lock.selected_tickers) ? lock.selected_tickers : [],
    telegram_sent: Boolean((dryRun && dryRun.telegram_sent) || (lock && lock.telegram_sent)),
    sent: Boolean((dryRun && dryRun.sent) || (lock && lock.sent)),
    safe_to_schedule_hint: 'Manual runner only; cron/scan refresh orchestration is a later phase.'
  };
}

function printHuman(summary) {
  console.log('\nAfter-market Top 5 lock-only runner');
  console.log(`Base URL: ${summary.base_url}`);
  console.log(`Dry-run: success=${summary.dry_run_success} reason=${summary.dry_run_reason || 'none'} would_lock=${summary.would_lock} would_insert_count=${summary.would_insert_count}`);
  console.log(`Would lock tickers: ${summary.would_lock_tickers.length ? summary.would_lock_tickers.join(', ') : '-'}`);
  console.log(`Already locked: ${summary.already_locked} existing_locked_count=${summary.existing_locked_count}`);
  console.log(`Executed lock: ${summary.executed_lock} lock_success=${summary.lock_success} lock_count=${summary.lock_count} lock_reason=${summary.lock_reason || 'none'}`);
  console.log(`Locked tickers: ${summary.locked_tickers.length ? summary.locked_tickers.join(', ') : '-'}`);
  console.log(`Telegram sent flags: sent=${summary.sent} telegram_sent=${summary.telegram_sent}`);
  console.log(`Note: ${summary.safe_to_schedule_hint}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }
  if (!process.env.CRON_SECRET) throw Object.assign(new Error('CRON_SECRET is required; set it before running this manual runner.'), { exitCode: 1 });
  if (opts.executeLock && !opts.yes) throw Object.assign(new Error('--execute-lock requires --yes.'), { exitCode: 4 });

  const dryRun = await fetchJson(opts.baseUrl, DRY_PATH, process.env.CRON_SECRET);
  if (!isSafeDryRun(dryRun)) {
    const exitCode = hasTelegramRisk(dryRun) || dryRun && dryRun.write_suppressed_by_dry_run !== true ? 2 : 4;
    const summary = makeSummary(opts.baseUrl, dryRun, null, false);
    if (!opts.json) printHuman(summary);
    console.log(JSON.stringify(summary, null, 2));
    throw Object.assign(new Error('Dry-run response was not read-only/safe; refusing to continue.'), { exitCode });
  }

  if (ALREADY_LOCKED_REASONS.has(dryRun.reason)) {
    const summary = makeSummary(opts.baseUrl, dryRun, null, false);
    if (!opts.json) printHuman(summary);
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (BLOCK_REASONS.has(dryRun.reason)) {
    const summary = makeSummary(opts.baseUrl, dryRun, null, false);
    if (!opts.json) printHuman(summary);
    console.log(JSON.stringify(summary, null, 2));
    return 3;
  }

  if (!opts.executeLock) {
    const summary = makeSummary(opts.baseUrl, dryRun, null, false);
    if (!opts.json) printHuman(summary);
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (dryRun.reason !== 'lock_only_dry_run' || dryRun.would_lock !== true || Number(dryRun.would_insert_count) <= 0) {
    const summary = makeSummary(opts.baseUrl, dryRun, null, false);
    if (!opts.json) printHuman(summary);
    console.log(JSON.stringify(summary, null, 2));
    return 4;
  }

  const lock = await fetchJson(opts.baseUrl, LOCK_PATH, process.env.CRON_SECRET);
  const lockSafe = lock && lock.success === true && lock.sent === false && lock.telegram_sent === false && lock.skipped_send === true && (lock.locked === true || lock.already_locked === true);
  const summary = makeSummary(opts.baseUrl, dryRun, lock, true);
  if (!opts.json) printHuman(summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!lockSafe) throw Object.assign(new Error('Lock response was unsafe or did not confirm lock/already_locked.'), { exitCode: 2 });
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
});
