'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const pool = require('./intraday-fast-watcher-guarded-live-pool');
const selection = require('./intraday-fast-watcher-guarded-live-selection');
const {
  RULE_VERSION, DEFAULT_MAX_POOL, MAX_POOL_LIMIT, DEFAULT_STATE_DIR,
  DEFAULT_EVENT_DIR, DEFAULT_LOCK_STALE_MS, DEFAULT_SOURCE_TIMEOUT_MS,
  MAX_PUBLISH_PER_RUN, enabled, validDate, validTime, extractSourceRows,
  sourceMeta, sourceFingerprint, freshPoolState, mergePool, trackerRankScore
} = pool;
const {
  applyObservations, buildPublishRow, formatTelegramMessage
} = selection;

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(temp, file);
}

async function appendJsonl(file, rows) {
  if (!rows || !rows.length) return;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && error.code === 'EPERM'); }
}

async function acquireLock(file, options) {
  const nowMs = options && options.nowMs != null ? options.nowMs : Date.now();
  const staleMs = options && options.staleMs != null ? options.staleMs : DEFAULT_LOCK_STALE_MS;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date(nowMs).toISOString() }) + '\n');
      return async function release() { await handle.close().catch(() => {}); await fsp.unlink(file).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current = null;
      try { current = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) {}
      const created = current ? Date.parse(current.created_at) : NaN;
      const stale = Number.isFinite(created) && nowMs - created >= staleMs;
      if (!stale || isPidAlive(current && current.pid)) return null;
      await fsp.unlink(file).catch(() => {});
    }
  }
  return null;
}

async function fetchProductionSource(options) {
  const baseUrl = String(options.baseUrl || '').trim();
  const secret = String(options.cronSecret || '').trim();
  if (!baseUrl || !secret) throw Object.assign(new Error('production_source_not_configured'), { code: 'SOURCE_NOT_CONFIGURED' });
  const url = new URL('/api/sector-hot', baseUrl);
  url.searchParams.set('action', 'daytrade-screener');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_SOURCE_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || fetch)(url, {
      headers: { Authorization: 'Bearer ' + secret, Accept: 'application/json' },
      signal: controller.signal
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch (_) { throw Object.assign(new Error('production_source_invalid_json'), { code: 'SOURCE_INVALID_JSON' }); }
    if (!response.ok || !payload || payload.success === false) throw Object.assign(new Error('production_source_http_' + response.status), { code: 'SOURCE_HTTP_ERROR' });
    return payload;
  } finally { clearTimeout(timer); }
}

async function readSourceWithFallback(options) {
  try {
    const payload = await fetchProductionSource(options);
    return { payload, source: 'production_api', fallback: false };
  } catch (error) {
    if (!options.shortlistFile) throw error;
    const payload = await readJson(options.shortlistFile);
    if (!payload) throw error;
    return { payload, source: 'local_shortlist_file', fallback: true, fallback_reason: error.code || error.message };
  }
}

async function collectPoolSnapshot(options, poolRows) {
  const live = require('./intraday-fast-watcher-live');
  return live.collectLiveSnapshot({
    sampleDate: options.sampleDate,
    scheduledTime: options.scheduledTime,
    shortlistFile: options.shortlistFile || 'guarded-live-virtual-shortlist.json',
    maxShortlist: Math.min(poolRows.length || options.maxPool || DEFAULT_MAX_POOL, MAX_POOL_LIMIT),
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    cacheDir: options.cacheDir,
    observationRoot: options.observationRoot,
    productionLockFile: options.productionLockFile,
    dryRun: options.dryRun,
    readPayload: async function readVirtualPayload() { return { status: 'published', results: poolRows }; }
  });
}

async function publishToSupabase(row, options) {
  const env = options.env || process.env;
  const url = String(env.SUPABASE_URL || '').trim();
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return { published: false, retryable: true, reason: 'supabase_not_configured' };
  const { createClient } = require('@supabase/supabase-js');
  const client = options.supabase || createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const existing = await client.from('daytrade_screener_latest').select('ticker').eq('ticker', row.ticker).maybeSingle();
  if (existing.error) return { published: false, retryable: true, reason: 'supabase_lookup_failed', error: existing.error.message };
  const result = existing.data
    ? await client.from('daytrade_screener_latest').update(row).eq('ticker', row.ticker)
    : await client.from('daytrade_screener_latest').insert([row]);
  if (result.error) return { published: false, retryable: true, reason: 'supabase_write_failed', error: result.error.message };
  return { published: true, reason: existing.data ? 'updated_existing_ticker' : 'inserted_new_ticker' };
}

function classifyTelegramResult(result) {
  if (result && result.sent === true) return 'sent';
  if (!result || result.sent !== false) return 'uncertain';
  if (typeof result.chunks_sent === 'number' && result.chunks_sent > 0) return 'uncertain';
  if (['telegram_disabled', 'missing_token', 'missing_chat_id', 'empty_message', 'api_error'].includes(result.reason)) return 'retryable';
  return 'uncertain';
}

async function sendTelegram(item, options) {
  const env = options.env || process.env;
  if (!enabled(env.FAST_WATCHER_TELEGRAM_ENABLED)) return { sent: false, skipped: true, reason: 'fast_watcher_telegram_disabled' };
  const notifier = require('./telegram-notifier');
  return notifier.sendTelegramMessage(formatTelegramMessage(item, options), { disable_web_page_preview: true, timeout_ms: 5000 });
}

function liveGate(env) {
  env = env || process.env;
  if (enabled(env.FAST_WATCHER_KILL_SWITCH)) return { ok: false, reason: 'kill_switch_enabled' };
  if (!enabled(env.FAST_WATCHER_LIVE_ENABLED)) return { ok: false, reason: 'live_feature_disabled' };
  return { ok: true, reason: null };
}

async function runGuardedLive(options) {
  options = options || {};
  const env = options.env || process.env;
  if (!validDate(options.sampleDate) || !validTime(options.scheduledTime)) return { status: 'invalid_input', error_code: 'invalid_date_or_time', rule_version: RULE_VERSION };
  const maxPool = Number.isInteger(options.maxPool) ? options.maxPool : DEFAULT_MAX_POOL;
  if (maxPool < 1 || maxPool > MAX_POOL_LIMIT) return { status: 'invalid_input', error_code: 'invalid_max_pool', rule_version: RULE_VERSION };

  const stateDir = options.stateDir || DEFAULT_STATE_DIR;
  const eventDir = options.eventDir || DEFAULT_EVENT_DIR;
  const stateFile = path.join(stateDir, `${options.sampleDate}.json`);
  const eventFile = path.join(eventDir, `${options.sampleDate}.jsonl`);
  const lockFile = path.join(stateDir, `${options.sampleDate}.live.lock`);
  const lock = await (options.acquireLock || acquireLock)(lockFile, { nowMs: options.lockNowMs, staleMs: options.lockStaleMs });
  if (!lock) return { status: 'lock_busy', error_code: 'live_lock_busy', rule_version: RULE_VERSION };

  try {
    const sourceResult = await (options.readSource || readSourceWithFallback)({
      baseUrl: options.baseUrl || env.APP_BASE_URL || 'https://auto-cuan.vercel.app',
      cronSecret: options.cronSecret || env.CRON_SECRET,
      shortlistFile: options.shortlistFile,
      timeoutMs: options.sourceTimeoutMs,
      fetchImpl: options.fetchImpl
    });
    const sourceRows = extractSourceRows(sourceResult.payload, maxPool);
    if (!sourceRows.length) return { status: 'empty_source_pool', source: sourceResult.source, rule_version: RULE_VERSION, pool_count: 0 };
    const meta = sourceMeta(sourceResult.payload);
    const fingerprint = sourceFingerprint(sourceResult.payload, sourceRows);
    let state = await (options.readState || readJson)(stateFile);
    if (!state || state.date !== options.sampleDate || state.rule_version !== RULE_VERSION) state = freshPoolState(options.sampleDate);
    state.source_fingerprint = fingerprint;
    state.source_run_id = meta.run_id;
    state.source_calculated_at = meta.calculated_at;
    mergePool(state, sourceRows, { scheduledTime: options.scheduledTime, sourceTime: meta.source_time, maxPool });

    const poolRows = Object.values(state.tickers).filter(tracker => tracker.active !== false && !tracker.drop_reason).sort((a, b) => trackerRankScore(b) - trackerRankScore(a)).slice(0, maxPool).map(tracker => Object.assign({}, tracker.source_row, { ticker: tracker.ticker }));
    const collection = await (options.collectSnapshot || collectPoolSnapshot)(Object.assign({}, options, { env }), poolRows);
    if (!collection || !['live_shadow_collected', 'live_shadow_dry_run'].includes(collection.status)) {
      return Object.assign({ status: collection && collection.status || 'collection_failed', rule_version: RULE_VERSION, pool_count: poolRows.length, source: sourceResult.source }, collection || {});
    }

    const processed = applyObservations(state, collection.observations || [], { sampleDate: options.sampleDate, scheduledTime: options.scheduledTime });
    state = processed.state;
    const gate = options.dryRun ? { ok: false, reason: 'dry_run' } : liveGate(env);
    const publishResults = [];

    // A full screener refresh clears/rebuilds daytrade_screener_latest. Re-upsert
    // already-confirmed Fast Watcher rows on every watcher run so a valid live
    // candidate returns to the website after that rebuild, without re-sending its
    // Telegram notification.
    for (const item of processed.refreshable || []) {
      const tracker = item.tracker;
      if (!gate.ok) {
        publishResults.push({ ticker: tracker.ticker, published: false, refreshed: false, reason: gate.reason, identity: item.identity });
        continue;
      }
      const row = buildPublishRow(item, { sampleDate: options.sampleDate, scheduledTime: options.scheduledTime });
      const dbResult = await (options.publishCandidate || publishToSupabase)(row, { env, sampleDate: options.sampleDate, scheduledTime: options.scheduledTime });
      if (!dbResult || dbResult.published !== true) {
        tracker.last_refresh_error = dbResult && (dbResult.reason || dbResult.error) || 'unknown_refresh_error';
        publishResults.push({ ticker: tracker.ticker, published: false, refreshed: false, reason: tracker.last_refresh_error, identity: item.identity });
        continue;
      }
      tracker.db_published = true;
      tracker.last_db_refresh_at = new Date().toISOString();
      tracker.publish_status = tracker.telegram_status === 'sent' ? 'published_and_notified' : 'published_refreshed_without_duplicate_telegram';
      publishResults.push({ ticker: tracker.ticker, published: true, refreshed: true, db_reason: dbResult.reason, telegram_sent: false, telegram_reason: 'deduplicated_existing_setup', identity: item.identity });
    }

    for (const item of processed.publishable) {
      const tracker = item.tracker;
      if (!gate.ok) {
        publishResults.push({ ticker: tracker.ticker, published: false, reason: gate.reason, identity: item.identity });
        continue;
      }
      tracker.published_identity = item.identity;
      tracker.publish_status = 'db_publish_in_progress';
      tracker.publish_started_at = new Date().toISOString();
      await (options.writeState || writeJsonAtomic)(stateFile, state);

      const row = buildPublishRow(item, { sampleDate: options.sampleDate, scheduledTime: options.scheduledTime });
      const dbResult = await (options.publishCandidate || publishToSupabase)(row, { env, sampleDate: options.sampleDate, scheduledTime: options.scheduledTime });
      if (!dbResult || dbResult.published !== true) {
        tracker.published_identity = null;
        tracker.publish_status = 'db_publish_failed_retryable';
        tracker.last_publish_error = dbResult && (dbResult.reason || dbResult.error) || 'unknown_publish_error';
        publishResults.push({ ticker: tracker.ticker, published: false, reason: tracker.last_publish_error, identity: item.identity });
        continue;
      }

      tracker.db_published = true;
      tracker.publish_status = 'published_pending_telegram';
      tracker.published_at = new Date().toISOString();
      state.published_identities = [...new Set([...(state.published_identities || []), item.identity])].slice(-200);
      await (options.writeState || writeJsonAtomic)(stateFile, state);

      let telegramResult = { sent: false, skipped: true, reason: 'telegram_not_attempted' };
      if (enabled(env.FAST_WATCHER_TELEGRAM_ENABLED)) {
        tracker.telegram_attempts = (tracker.telegram_attempts || 0) + 1;
        telegramResult = await (options.sendTelegram || sendTelegram)(item, { env, sampleDate: options.sampleDate, scheduledTime: options.scheduledTime });
        tracker.telegram_status = classifyTelegramResult(telegramResult);
      } else tracker.telegram_status = 'disabled';
      tracker.publish_status = tracker.telegram_status === 'sent' ? 'published_and_notified' : 'published_telegram_' + tracker.telegram_status;
      publishResults.push({ ticker: tracker.ticker, published: true, db_reason: dbResult.reason, telegram_sent: telegramResult.sent === true, telegram_reason: telegramResult.reason || null, identity: item.identity });
      await (options.writeState || writeJsonAtomic)(stateFile, state);
    }

    state.updated_at = new Date().toISOString();
    if (!options.dryRun) {
      await (options.writeState || writeJsonAtomic)(stateFile, state);
      await (options.writeEvents || appendJsonl)(eventFile, processed.events.map(event => Object.assign({ date: options.sampleDate, time: options.scheduledTime, rule_version: RULE_VERSION }, event)));
    }

    const active = Object.values(state.tickers).filter(tracker => tracker.active !== false && !tracker.drop_reason);
    const confirmed = active.filter(tracker => tracker.status === 'READY_CONFIRMED');
    return {
      status: gate.ok ? 'guarded_live_completed' : (options.dryRun ? 'guarded_live_dry_run' : 'guarded_live_blocked'),
      rule_version: RULE_VERSION,
      sample_date: options.sampleDate,
      scheduled_time: options.scheduledTime,
      source: sourceResult.source,
      source_fallback: sourceResult.fallback === true,
      source_fallback_reason: sourceResult.fallback_reason || null,
      source_count: sourceRows.length,
      pool_count: active.length,
      completed_count: collection.completed_count,
      failed_count: collection.failed_count,
      event_count: processed.events.length,
      confirmed_count: confirmed.length,
      top_confirmed_count: (processed.top_confirmed || []).length,
      publishable_count: processed.publishable.length,
      refreshed_count: publishResults.filter(row => row.published && row.refreshed).length,
      published_count: publishResults.filter(row => row.published && !row.refreshed).length,
      db_write_count: publishResults.filter(row => row.published).length,
      telegram_sent_count: publishResults.filter(row => row.telegram_sent).length,
      live_gate: gate,
      publish_results: publishResults,
      active_pool: active.map(tracker => ({ ticker: tracker.ticker, status: tracker.status, confirmation_streak: tracker.confirmation_streak, expires_minute: tracker.expires_minute, watch_score: tracker.last_evaluation && tracker.last_evaluation.watch_score, in_latest_source: tracker.in_latest_source })),
      state_file: stateFile,
      event_file: eventFile
    };
  } finally { await lock(); }
}

module.exports = {
  readJson, writeJsonAtomic, appendJsonl, acquireLock,
  fetchProductionSource, readSourceWithFallback, collectPoolSnapshot,
  publishToSupabase, classifyTelegramResult, sendTelegram,
  liveGate, runGuardedLive
};
