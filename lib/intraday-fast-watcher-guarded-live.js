'use strict';

const path = require('node:path');
const watcher = require('./intraday-fast-watcher');
const shadowLive = require('./intraday-fast-watcher-live');
const pool = require('./intraday-fast-watcher-pool');
const publisher = require('./intraday-fast-watcher-publisher');
const radarPublisher = require('./intraday-fast-watcher-radar-publisher');
const earlyWatch = require('./intraday-fast-watcher-early-watch');

const DEFAULT_STATE_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-live-state');
const DEFAULT_EVENT_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-live-events');
const DEFAULT_PUBLISHED_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-published');

function liveEnabled(env) { return String((env || process.env).FAST_WATCHER_LIVE_ENABLED || '') === '1'; }

async function run(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  if (!liveEnabled(env)) return { status: 'live_disabled', error_code: 'kill_switch_off', system_published: 0, telegram_sent: 0 };
  if (!watcher.validDate(opts.sampleDate) || !watcher.validTime(opts.scheduledTime)) {
    return { status: 'invalid_input', error_code: !watcher.validDate(opts.sampleDate) ? 'invalid_date' : 'invalid_time' };
  }
  const requestedMax = Number.isInteger(opts.maxShortlist) ? opts.maxShortlist : pool.MAX_ACTIVE_POOL;
  if (requestedMax < 1 || requestedMax > pool.MAX_ACTIVE_POOL) {
    return { status: 'invalid_input', error_code: 'invalid_max_shortlist', max_shortlist_limit: pool.MAX_ACTIVE_POOL };
  }
  const maxShortlist = requestedMax;
  const stateDir = opts.stateDir || DEFAULT_STATE_DIR;
  const eventDir = opts.eventDir || DEFAULT_EVENT_DIR;
  const lockFile = path.join(stateDir, `${opts.sampleDate}.guarded-live.lock`);
  const release = await (opts.acquireLock || watcher.acquireLock)(lockFile, { nowMs: opts.lockNowMs, staleMs: opts.lockStaleMs });
  if (!release) return { status: 'lock_busy', error_code: 'guarded_live_lock_busy' };
  try {
    const startedAt = Date.now();
    let rawPayload;
    try { rawPayload = await (opts.readPayload || watcher.parseFile)(opts.shortlistFile); }
    catch (error) { return { status: error.code === 'ENOENT' ? 'shortlist_missing' : 'shortlist_invalid', error_code: error.code || 'shortlist_invalid' }; }
    const normalized = shadowLive.normalizeProductionShortlistPayload(rawPayload);
    if (normalized.status === 'screener_running') return { status: 'skipped_screener_running', error_code: 'source_screener_running', shortlist_count: 0 };

    const stateFile = path.join(stateDir, `${opts.sampleDate}.json`);
    const eventFile = path.join(eventDir, `${opts.sampleDate}.jsonl`);
    const priorState = await (opts.readState || watcher.readState)(stateFile);
    const supplemental = typeof opts.loadSupplemental === 'function'
      ? await opts.loadSupplemental()
      : await publisher.loadSupplementalShortlist({ env, storeClient: opts.storeClient });
    const mergedPayload = pool.mergePayload(normalized.payload, priorState, opts.scheduledTime, supplemental, maxShortlist);
    const shortlistRows = Array.isArray(mergedPayload.results) ? mergedPayload.results.slice(0, maxShortlist) : [];
    if (!shortlistRows.length) return { status: 'empty_shortlist', shortlist_count: 0 };

    const collected = await shadowLive.collectLiveSnapshot({
      sampleDate: opts.sampleDate,
      scheduledTime: opts.scheduledTime,
      shortlistFile: opts.shortlistFile,
      maxShortlist,
      concurrency: opts.concurrency || shadowLive.DEFAULT_CONCURRENCY,
      timeoutMs: opts.timeoutMs || shadowLive.DEFAULT_TIMEOUT_MS,
      cacheDir: opts.cacheDir,
      productionLockFile: opts.productionLockFile,
      observationRoot: opts.observationRoot,
      dryRun: opts.dryRun === true,
      now: opts.now,
      env,
      readPayload: async () => mergedPayload,
      engine: opts.engine,
      collector: opts.collector,
      fetchCandles: opts.fetchCandles,
      checkProductionWorkerActive: opts.checkProductionWorkerActive,
      appendRows: opts.appendRows
    });
    if (!['live_shadow_collected', 'live_shadow_dry_run'].includes(collected.status)) return collected;

    const processed = pool.process({
      sampleDate: opts.sampleDate,
      scheduledTime: opts.scheduledTime,
      shortlistRows,
      observations: collected.observations,
      priorState,
      now: opts.now
    });
    if (!opts.dryRun) {
      await (opts.writeState || watcher.writeJsonAtomic)(stateFile, processed.state);
      await (opts.writeEvents || watcher.appendEvents)(eventFile, processed.events);
    }

    // Additive, shadow-only hook. Defaults OFF (FAST_WATCHER_EARLY_WATCH_SHADOW_ENABLED).
    // Runs strictly after the 2/2 confirmation pool state above is finalized and
    // written; never reads back into it, never influences publication below.
    let earlyWatchResult = { enabled: false, shadow_only: true, status: 'disabled', version: earlyWatch.VERSION };
    try {
      earlyWatchResult = await (opts.runEarlyWatchShadow || earlyWatch.runEarlyWatchShadow)({
        env,
        sampleDate: opts.sampleDate,
        scheduledTime: opts.scheduledTime,
        now: opts.now,
        dryRun: opts.dryRun === true,
        priorPoolState: priorState,
        processedPoolState: processed.state,
        observations: collected.observations,
        stateDir: opts.earlyWatchStateDir,
        eventDir: opts.earlyWatchEventDir
      });
    } catch (error) {
      earlyWatchResult = { enabled: earlyWatch.isEnabled(env), shadow_only: true, status: 'error', version: earlyWatch.VERSION, error: error && error.message };
    }

    const radarCandidates = radarPublisher.selectRadarCandidates(processed.state);
    let publication = { attempted: false, system_published: 0, telegram_sent: 0, reason: opts.dryRun ? 'dry_run' : 'nothing_confirmed' };
    if (!opts.dryRun && processed.publishable.length) {
      publication = await (opts.publishConfirmed || publisher.publishConfirmed)({
        publishable: processed.publishable,
        sampleDate: opts.sampleDate,
        scheduledTime: opts.scheduledTime,
        env,
        publishedDir: opts.publishedDir || DEFAULT_PUBLISHED_DIR,
        storeClient: opts.storeClient,
        notifyFn: opts.notifyFn
      });
    } else if (!opts.dryRun) {
      publication = await (opts.publishRadar || radarPublisher.publishRadar)({
        candidates: radarCandidates,
        state: processed.state,
        sampleDate: opts.sampleDate,
        scheduledTime: opts.scheduledTime,
        env,
        radarDir: opts.radarDir,
        notifyFn: opts.notifyFn
      });
    }
    return {
      status: opts.dryRun ? 'guarded_live_dry_run' : 'guarded_live_recorded',
      rule_version: pool.RULE_VERSION,
      sample_date: opts.sampleDate,
      scheduled_time: opts.scheduledTime,
      requested_max_shortlist: requestedMax,
      max_active_pool: pool.MAX_ACTIVE_POOL,
      shortlist_count: shortlistRows.length,
      supplemental_count: Array.isArray(supplemental) ? supplemental.length : 0,
      merge_diagnostics: mergedPayload.diagnostics || null,
      active_pool_count: processed.active_pool_count,
      processed_observation_count: processed.processed_observation_count,
      event_count: processed.events.length,
      events: processed.events,
      confirmed: processed.confirmed,
      publishable: processed.publishable,
      informational_spikes: processed.informational_spikes || [],
      informational_spike_count: (processed.informational_spikes || []).length,
      radar_candidates: radarCandidates,
      radar_count: radarCandidates.length,
      state_file: stateFile,
      event_file: eventFile,
      publication,
      system_published: Number(publication.system_published || 0),
      telegram_attempted: publication.telegram_attempted === true,
      telegram_sent: Number(publication.telegram_sent || 0),
      radar_items_sent: Number(publication.radar_items_sent || 0),
      production_state_mutated: Number(publication.system_published || 0) > 0,
      full_universe_built: false,
      early_watch: earlyWatchResult,
      runtime_duration_ms: Date.now() - startedAt
    };
  } finally {
    await release();
  }
}

module.exports = { DEFAULT_STATE_DIR, DEFAULT_EVENT_DIR, DEFAULT_PUBLISHED_DIR, liveEnabled, run };
