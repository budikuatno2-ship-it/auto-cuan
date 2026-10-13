#!/usr/bin/env node
'use strict';

/**
 * Scheduled retry worker for stuck Telegram deliveries.
 *
 * Production evidence (audit 1-12 Oct 2026): 48 rows sat at
 * DELIVERY_RETRYABLE and at least one row (MEDC 2026-10-12, Swing Konglo) sat
 * at DELIVERY_PENDING with first_sent_at=null because the delivery pipeline
 * was interrupted between prepare and finalize. Nothing swept those queues,
 * so the signals were neither delivered nor expired.
 *
 * This worker runs every 15 minutes during the extended EOD window and:
 *   1. Reclaims stale PENDING/IN_PROGRESS claims (older than the recovery
 *      window) back to DELIVERY_RETRYABLE via the canonical recovery helper.
 *   2. Selects retry-eligible rows: DELIVERY_RETRYABLE (any date) and
 *      DELIVERY_PENDING older than the recovery window, within the stale max
 *      age (weeks-old signals are never re-blasted; they decay instead).
 *   3. Rebuilds the canonical Telegram message per source
 *      (swing_konglo / swing_nk / daytrade_signal / daily_top5) from the
 *      persisted raw_payload.
 *   4. Sends with skip_market_guard=true (EOD deliveries are intentionally
 *      after market close) and finalizes the row state.
 *
 * Usage:
 *   node tools/retry-telegram-delivery.js                 # dry-run report
 *   node tools/retry-telegram-delivery.js --apply         # actually retry
 *   node tools/retry-telegram-delivery.js --apply --limit=10
 *   node tools/retry-telegram-delivery.js --apply --date=2026-10-12
 *
 * Safety:
 *   - dry-run by default;
 *   - requires ALLOW_PROD_DB_WRITE=1 for --apply against the production DB;
 *   - never retries rows that already carry a delivery receipt;
 *   - never retries rows older than TELEGRAM_DELIVERY_STALE_MAX_AGE_MS
 *     (default 72h) - those are expired, not resent.
 */

const fs = require('node:fs');
const path = require('node:path');

const telegramDelivery = require('../lib/telegram-delivery');
const telegramNotifier = require('../lib/telegram-notifier');
const telegramTemplates = require('../lib/telegram-templates');

const ROOT = path.resolve(__dirname, '..');
const PROD_MARKET_DB = '/home/ubuntu/auto-cuan-data/market.sqlite';

// The worker must talk to the same hybrid client the API uses so that the
// VPS market store (SQLite) is the backing store on production and Supabase
// remains the fallback in other environments.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      if (Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
      let value = match[2].replace(/\s+#.*$/, '').trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value || /^\[(?:sensitive|redacted|secret|placeholder|todo)\]$/i.test(value)) continue;
      process.env[match[1]] = value;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function initEnv() {
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  [
    path.join(runnerDir, '.env'),
    path.join(ROOT, '.env.local'),
    path.join(ROOT, '.env.intraday-runtime'),
    path.join(ROOT, '.env')
  ].forEach(loadEnvFile);

  // BUG-RETRY-VPS-STORE (2026-10-13): the delivery rows live in the VPS SQLite
  // market store, but AUTO_CUAN_MARKET_DATA_VPS=1 was only exported inside
  // PM2's process env (pm2 env 0), never in the runner .env or a shell. A
  // standalone cron invocation therefore talked to the remote Supabase client
  // and found ZERO stuck rows while 49 sat in the local store. This worker is
  // VPS-only by definition, so it pins the flag unless the operator
  // explicitly overrides it.
  if (process.env.AUTO_CUAN_MARKET_DATA_VPS == null || process.env.AUTO_CUAN_MARKET_DATA_VPS === '') {
    process.env.AUTO_CUAN_MARKET_DATA_VPS = '1';
  }
  if (process.env.AUTO_CUAN_MARKET_DB == null || process.env.AUTO_CUAN_MARKET_DB === '') {
    process.env.AUTO_CUAN_MARKET_DB = PROD_MARKET_DB;
  }
}

function parseArgs(argv) {
  const options = {
    apply: false,
    limit: 20,
    date: null,
    source: null,
    verbose: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg.startsWith('--limit=')) options.limit = Math.max(1, Number(arg.split('=')[1]) || options.limit);
    else if (arg.startsWith('--date=')) options.date = arg.split('=')[1].trim();
    else if (arg.startsWith('--source=')) options.source = arg.split('=')[1].trim();
  }
  return options;
}

function createStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // On the VPS the hybrid client is required for the SQLite market store;
    // without credentials we fail closed rather than silently no-op.
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY tidak tersedia; retry worker tidak dapat berjalan.');
  }
  const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
  const { hybridizeClient } = require('../lib/hybrid-supabase-client');
  return hybridizeClient(createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  }));
}

function isProductionDbTarget() {
  const dbPath = String(process.env.AUTO_CUAN_MARKET_DB || PROD_MARKET_DB);
  return /auto-cuan-data[\\/]market\.sqlite$/i.test(dbPath);
}

/**
 * A row is retry-eligible when it carries no delivery receipt and is within
 * the stale max age. Anything older is expired instead of resent (a
 * weeks-old signal must never hit the production channel).
 */
function isRetryEligible(row, nowMs) {
  const status = telegramDelivery.normalizeDeliveryStatus(row);
  if (status !== 'DELIVERY_RETRYABLE' && status !== 'DELIVERY_PENDING' && status !== 'DELIVERY_IN_PROGRESS') {
    return false;
  }
  if (telegramDelivery.rowWasDelivered(row)) return false;
  if (telegramDelivery.rowIsRetryExpired(row, { now: nowMs })) return false;
  const ageMs = telegramDelivery.deliveryRowAgeMs(row, nowMs);
  if (status !== 'DELIVERY_RETRYABLE' && ageMs != null && ageMs <= telegramDelivery.DELIVERY_PENDING_RECOVERY_MS) {
    // Fresh pending claim: a worker may genuinely be mid-send.
    return false;
  }
  return true;
}

function messageForRow(row) {
  const raw = row && row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
  // Never leak the delivery bookkeeping status (DELIVERY_RETRYABLE) into the
  // user-facing signal card: the signal's own status lives in raw_payload.
  const merged = Object.assign({}, raw, {
    ticker: row.ticker || raw.ticker,
    status: raw.status || raw.final_status || undefined
  });
  const source = String(row.monitor_source || raw.monitor_source || '').toLowerCase();

  if (source === 'swing_nk') {
    return telegramTemplates.formatSwingNonKongloSignalMessage([merged], { headerNote: '' });
  }
  if (source === 'swing_konglo') {
    return telegramTemplates.formatSwingKongloSignalMessage([merged], { headerNote: '' });
  }
  if (source === 'daytrade_signal' || source === 'daytrade') {
    return telegramTemplates.formatDayTradeSignalMessage([merged], {});
  }
  if (source === 'daily_top5' || source === 'top5') {
    return telegramTemplates.formatDailyTop5Message([merged], row.date || '', {});
  }
  // Unknown source: a compact generic card beats silently dropping the row.
  return 'AUTO-CUAN SIGNAL RETRY\n' +
    String(merged.ticker || '-') + '\n' +
    'Status: ' + String(merged.status || '-') + '\n' +
    'Entry: ' + String(merged.entry_low != null ? merged.entry_low : (row.entry1 != null ? row.entry1 : '-')) +
    ' - ' + String(merged.entry_high != null ? merged.entry_high : (row.entry2 != null ? row.entry2 : '-')) + '\n' +
    'TP1: ' + String(merged.tp1 != null ? merged.tp1 : (row.tp1 != null ? row.tp1 : '-')) +
    ' | SL: ' + String(merged.stop_loss != null ? merged.stop_loss : (row.sl != null ? row.sl : '-'));
}

async function loadRetryQueue(supabase, options) {
  let query = supabase
    .from('telegram_daily_picks')
    .select('id,date,ticker,monitor_source,status,first_sent_at,updated_at,raw_payload');

  if (options.date) {
    query = query.eq('date', options.date);
  }
  if (options.source) {
    query = query.eq('monitor_source', options.source);
  }

  const result = await query;
  if (result.error) {
    throw new Error('Gagal memuat antrean retry: ' + result.error.message);
  }

  const nowMs = Date.now();
  const rows = (result.data || []).filter((row) => isRetryEligible(row, nowMs));
  return rows.slice(0, options.limit);
}

async function markDelivered(supabase, id, nowIso) {
  return supabase
    .from('telegram_daily_picks')
    .update({ status: 'WAITING', first_sent_at: nowIso, updated_at: nowIso })
    .eq('id', id);
}

async function markRetryable(supabase, id, nowIso) {
  return supabase
    .from('telegram_daily_picks')
    .update({ status: 'DELIVERY_RETRYABLE', updated_at: nowIso })
    .eq('id', id);
}

async function markUncertain(supabase, id, nowIso) {
  return supabase
    .from('telegram_daily_picks')
    .update({ status: 'DELIVERY_UNCERTAIN', updated_at: nowIso })
    .eq('id', id);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  initEnv();
  const options = parseArgs(argv);
  const log = deps.log || console.log;

  log('=== AUTO-CUAN TELEGRAM DELIVERY RETRY WORKER ===');
  log('Mode: ' + (options.apply ? 'APPLY' : 'DRY-RUN'));
  log('Limit: ' + options.limit + (options.date ? ' | Date: ' + options.date : '') + (options.source ? ' | Source: ' + options.source : ''));

  if (options.apply && isProductionDbTarget() && process.env.ALLOW_PROD_DB_WRITE !== '1') {
    throw new Error('Safety guard: --apply terhadap database produksi membutuhkan ALLOW_PROD_DB_WRITE=1.');
  }

  const supabase = deps.supabase || createStore();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Step 1: reclaim stale claims so they become retry-eligible in this pass.
  const recovery = await telegramDelivery.recoverStaleDeliveryClaims({ supabase: supabase, now: nowMs });
  log('Recovery pass: scanned=' + recovery.scanned + ' expired=' + recovery.expired + ' requeued=' + recovery.retryable +
    (recovery.error ? ' error=' + recovery.error : ''));

  // Step 2: select the retry queue.
  const queue = await loadRetryQueue(supabase, options);
  log('Retry-eligible rows: ' + queue.length);

  if (!options.apply) {
    queue.forEach((row) => {
      log('  [dry-run] ' + row.date + ' ' + row.ticker + ' source=' + (row.monitor_source || '-') + ' status=' + (row.status || '-'));
    });
    log('Dry-run selesai. Gunakan --apply untuk mengirim ulang.');
    return { dry_run: true, queue_size: queue.length, recovery };
  }

  let sent = 0;
  let failed = 0;
  let uncertain = 0;

  for (const row of queue) {
    let text;
    try {
      text = messageForRow(row);
    } catch (buildErr) {
      log('  SKIP ' + row.ticker + ' (' + row.date + '): build message gagal: ' + buildErr.message);
      failed++;
      continue;
    }

    let result;
    try {
      result = await telegramNotifier.sendTelegramMessage(text, {
        chat_id: process.env.FAST_WATCHER_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
        // EOD retries are intentionally after market close.
        skip_market_guard: true,
        timeout_ms: 8000,
        ticker: row.ticker
      });
    } catch (sendErr) {
      result = { sent: false, reason: 'telegram_exception', error: sendErr.message };
    }

    const classified = telegramDelivery.classifyTelegramResult(result || {});

    if (classified.delivered) {
      await markDelivered(supabase, row.id, nowIso);
      sent++;
      log('  SENT ' + row.ticker + ' (' + row.date + ') source=' + (row.monitor_source || '-'));
    } else if (classified.uncertain) {
      await markUncertain(supabase, row.id, nowIso);
      uncertain++;
      log('  UNCERTAIN ' + row.ticker + ' (' + row.date + '): ' + (classified.reason || 'unknown'));
    } else {
      await markRetryable(supabase, row.id, nowIso);
      failed++;
      log('  FAILED ' + row.ticker + ' (' + row.date + '): ' + (classified.reason || 'unknown'));
    }
  }

  log('----------------------------------------------------');
  log('Ringkasan: sent=' + sent + ' failed=' + failed + ' uncertain=' + uncertain + ' of ' + queue.length);
  return { dry_run: false, queue_size: queue.length, sent, failed, uncertain, recovery };
}

if (require.main === module) {
  main().catch((err) => {
    console.error('retry-telegram-delivery fatal:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  isRetryEligible,
  messageForRow,
  loadRetryQueue,
  main
};
