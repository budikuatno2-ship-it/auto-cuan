#!/usr/bin/env node
'use strict';

/**
 * tools/sync-quota-state.js
 * ============================================================================
 * Zero-cost quota state & limit synchronizer.
 *
 * Syncs data/quota-limit.json (via lib/quota-limit.js lock-guarded setter) and
 * data/quota-state.json for the current WIB trading date using `.env`
 * `ARJUM_DAILY_LIMIT` (default 6063) and already-recorded local usage counters,
 * with ZERO upstream paid Stock Arjum calls.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvLimit() {
  const fromEnv = Number(process.env.ARJUM_DAILY_LIMIT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^ARJUM_DAILY_LIMIT\s*=\s*(\d+)/.exec(line.trim());
      if (m && Number(m[1]) > 0) return Math.floor(Number(m[1]));
    }
  } catch (_) {}
  return 6063;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function syncQuotaState(opts = {}) {
  const quotaLimit = require('../lib/quota-limit');
  const quotaState = require('../lib/quota-state');
  const now = opts.now instanceof Date ? opts.now : new Date();
  const wibDate = quotaState.getWibDateKey(now);
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
    ? Math.floor(Number(opts.limit))
    : loadEnvLimit();

  const existingState = readJsonSafe(path.join(ROOT, 'data', 'quota-state.json'));
  const sameDay = existingState && (existingState.date === wibDate || existingState.currentDateWIB === wibDate);
  const burnState = readJsonSafe(path.join(ROOT, 'data', 'quota-burn-state.json'));
  const burnSameDay = burnState && String(burnState.finishedAt || burnState.startedAt || '').slice(0, 10) === wibDate;

  let usedToday = 0;
  if (sameDay) {
    const localUsed = Number(existingState.localUsedToday || 0);
    const upUsed = existingState.upstreamUsedToday != null ? Number(existingState.upstreamUsedToday) : 0;
    usedToday = Math.max(0, Math.floor(Math.max(localUsed, upUsed)));
  } else if (burnSameDay && Number.isFinite(Number(burnState.usedBefore))) {
    usedToday = Math.max(0, Math.floor(Number(burnState.usedBefore) + Number(burnState.spent || 0)));
  }

  const limRes = quotaLimit.setProviderLimit({
    limit,
    used: usedToday,
    source: 'local_zero_cost_env_sync',
    now
  });

  const cfg = quotaState.loadConfig();
  const written = quotaState.writeState({
    date: wibDate,
    currentDateWIB: wibDate,
    localUsedToday: sameDay ? Math.max(0, Math.floor(Number(existingState.localUsedToday || 0))) : 0,
    usedToday: sameDay ? Math.max(0, Math.floor(Number(existingState.usedToday || existingState.localUsedToday || 0))) : 0,
    backfillUsedToday: sameDay ? Math.max(0, Math.floor(Number(existingState.backfillUsedToday || 0))) : 0,
    hardStopLocked: false,
    upstreamUsedToday: usedToday,
    upstreamDailyLimit: limit,
    effectiveDailyLimit: limit,
    drift: 0,
    driftDetected: false,
    updatedAt: now.toISOString(),
    source: 'sync-quota-state'
  });

  // Also keep ops config operating cap aligned if below/equal configured ceiling or missing
  try {
    const opsStore = require('../lib/quota-config-store');
    const currentOps = opsStore.get ? opsStore.get() : null;
    const opsDoc = currentOps && currentOps.ok ? currentOps.doc : null;
    if (opsDoc && (opsDoc.configuredOperatingCap == null || Number(opsDoc.configuredOperatingCap) > limit)) {
      opsStore.put({
        version: opsDoc.version,
        patch: {
          configuredOperatingCap: limit,
          weekdayBackfillLimit: Math.min(Number(opsDoc.weekdayBackfillLimit || 3146), limit),
          weekendBackfillLimit: Math.min(Number(opsDoc.weekendBackfillLimit || limit), limit),
          reserveFloorWeekday: Math.min(Number(opsDoc.reserveFloorWeekday || 2867), limit)
        },
        reason: 'V6.5.3 sync-quota-state alignment with ARJUM_DAILY_LIMIT=' + limit
      }, { actor: 'system:sync-quota-state' });
    }
  } catch (_) {}

  return {
    ok: Boolean(limRes && limRes.ok),
    wibDate,
    limit,
    used: usedToday,
    remaining: Math.max(0, limit - usedToday),
    stateDate: written.date,
    plan: cfg.planName || 'Supporter'
  };
}

if (require.main === module) {
  const out = syncQuotaState();
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

module.exports = { syncQuotaState, loadEnvLimit };
