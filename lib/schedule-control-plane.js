'use strict';

/**
 * lib/schedule-control-plane.js
 * ============================================================================
 * V6 (Subtask F) — SCHEDULER & WIB CONTROL PLANE
 * ============================================================================
 * WHY THIS EXISTS (P0-07 closure)
 *   The admin schedule editor (api/admin/schedule-settings.js) writes a durable
 *   versioned doc (lib/admin-schedule-store.js) and the decision core
 *   (lib/admin-schedule-engine.js) computes WIB next-runs — but the PRODUCTION
 *   executor is still the legacy VPS cron (deploy/vps/final-schedule.cron via
 *   job-wrapper.sh) with its own fixed slots (broksum-1945 @ 19:45,
 *   domestic-compile-2025 @ 20:25, ...). If the dynamic schedule (broksum-all
 *   20:00, domestic-compile 21:20) were executed while the legacy cron slots
 *   are still ACTIVE, the SAME side effect (broker API fetch, domestic
 *   compile, Telegram recap) would run TWICE => double Arjum quota burn and
 *   double publishes.
 *
 *   This module is the single mapping layer between the two worlds:
 *     1. SIDE_EFFECT_CLASS per dynamic job  — what real-world effect a job has.
 *     2. LEGACY_EXECUTORS                   — the frozen inventory of the old
 *        cron/PM2/systemd executors with their WIB windows + classes.
 *     3. detectLegacyDuplicatePatches()     — config-time guard used by
 *        store.put(): REJECTS a patch that introduces a NEW time-window overlap
 *        with an ACTIVE legacy executor of the SAME side-effect class
 *        (grandfathered defaults and locked-default times are exempt; the
 *        runtime guard below covers those).
 *     4. activeExecutorsForClass()          — runtime guard used by
 *        engine.decideRun()/the local runner: while ANY legacy executor of the
 *        same class is ACTIVE, the dynamic job is BLOCKED_LEGACY_ACTIVE (never
 *        double-spawned). Cutover = mark the legacy executor RETIRED in the
 *        registry (data/schedule-runner/legacy-active.json) — an approval-gated
 *        operation, see CUTOVER_PLAN_MD.
 *     5. buildJobDescriptor()               — the mandated 23-field per-job
 *        record (job_id .. rollback_target) for docs/CSV + admin UI.
 *     6. buildCollisionMatrix()             — explicit DYNAMIC×DYNAMIC and
 *        DYNAMIC×LEGACY overlap matrix rows for docs/v6/V6_COLLISION_MATRIX.csv.
 *
 *   This module is deliberately dependency-free (fs/path only) so both the
 *   store and the engine can require it without cycles.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* -------------------------------------------------------------------------- */
/* Small standalone time helpers (duplicated on purpose: NO require cycles)     */
/* -------------------------------------------------------------------------- */

function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minutesToTime(m) {
  const mm = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(mm / 60)).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
}

function normalizeDays(days) {
  if (days == null || days === '*') return [];
  if (Array.isArray(days)) {
    const out = [];
    for (const d of days) {
      const n = Number(d);
      if (Number.isInteger(n) && n >= 0 && n <= 6 && !out.includes(n)) out.push(n);
    }
    return out.sort((a, b) => a - b);
  }
  return [];
}

function daysShare(aDays, bDays) {
  const A = normalizeDays(aDays);
  const B = normalizeDays(bDays);
  if (A.length === 0 || B.length === 0) return true; // empty => every day
  return A.some((d) => B.includes(d));
}

function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/* -------------------------------------------------------------------------- */
/* Side-effect classes (what a job DOES to the real world)                      */
/* -------------------------------------------------------------------------- */

const SIDE_EFFECT_CLASS = {
  'yahoo-ohlcv': 'CANDLE_EOD_YAHOO',
  'ihsg': 'IHSG_CANDLE',
  'lifecycle': 'LIFECYCLE_EVAL',
  'market-context': 'MARKET_CONTEXT',
  'sector-hot': 'SECTOR_HOT',
  'broksum-all': 'BROKER_SUMMARY_ALL',
  'broksum-foreign': 'BROKER_SUMMARY_SWEEP',
  'domestic-compile': 'DOMESTIC_COMPILE',
  'accumulation': 'ACCUMULATION_ROLLING',
  'bandarmologi': 'BANDARMOLOGI_INTEL',
  'top20': 'TOP20_COMPILE',
  'top5': 'TOP5_RADAR',
  'telegram': 'TELEGRAM_RECAP',
  'insider': 'INSIDER_FETCH',
  'fundamental': 'FUNDAMENTAL_REFRESH',
  'quota-backfill': 'QUOTA_BURN',
  'hourly-confirmation': 'HOURLY_CONFIRMATION',
  'daytrade-fastwatcher': 'DAYTRADE_INTRADAY',
  'fastwatcher': 'DAYTRADE_INTRADAY',
  'daytrade-producer': 'DAYTRADE_INTRADAY',
  'coordinated-pipeline': 'COORDINATED_PIPELINE',
  'oracle-monitoring': 'MONITORING'
};

/** Artifact each job produces (used by the dependency gate + descriptors). */
const PRODUCES = {
  'yahoo-ohlcv': 'data/candles/daily/<trade_date> (963 emiten, Yahoo, 0 kuota)',
  'ihsg': 'data/candles/ihsg/<trade_date>.json (1 req Arjum)',
  'lifecycle': 'data/lifecycle/<trade_date>/evaluasi.json + track-record ledger',
  'market-context': 'data/market-context/<trade_date>.json (breadth lokal)',
  'sector-hot': 'data/sector-hot/<trade_date>.json (agregasi candle lokal)',
  'broksum-all': 'data/broksum/<trade_date>/ALL-<ticker>.json (±1926 req Arjum)',
  'broksum-foreign': 'data/broksum/<trade_date>/F-<ticker>.json (sweep/retry)',
  'domestic-compile': 'data/broker-accumulation/<ticker>.json (kompilasi ALL-F, 0 kuota)',
  'accumulation': 'data/broker-accumulation/archive-index.json (rolling + konsistensi)',
  'bandarmologi': 'data/bandarmologi-intel-indexes/latest*.json (intel lokal)',
  'top20': 'data/top20/<trade_date>.json (HANYA bila broksum-all valid + bandarmologi done)',
  'top5': 'data/top5/<trade_date>.json (rank 1..min(5,total) subset Top20)',
  'telegram': 'Telegram broadcast recap (message_id + receipt logged)',
  'insider': 'data/insider/<trade_date>/ (KSEI berjenjang ±455 req)',
  'fundamental': 'data/fundamental/refresh-<trade_date>.json (rolling Q2)',
  'quota-backfill': 'data/backfill-queue*.json progress (penyerapan kuota terukur)',
  'hourly-confirmation': 'short-swing hourly confirmation (FLAG OFF, legacy inactive)',
  'daytrade-fastwatcher': 'daytrade producer + fastwatcher intraday (legacy inactive)',
  'fastwatcher': 'fastwatcher intraday (legacy inactive)',
  'daytrade-producer': 'daytrade producer intraday (legacy inactive)',
  'coordinated-pipeline': 'data/coordinated-pipeline/<trade_date>.json (DAG Stage 1..5 coordinated snapshot)',
  'oracle-monitoring': 'data/alerts/operational-status.json (watchdog)'
};

const OWNER_SERVICE = {
  'yahoo-ohlcv': 'candle-pipeline',
  'ihsg': 'candle-pipeline',
  'lifecycle': 'track-record-service',
  'market-context': 'market-context-collector',
  'sector-hot': 'sector-analytics',
  'broksum-all': 'broker-summary-pipeline',
  'broksum-foreign': 'broker-summary-pipeline',
  'domestic-compile': 'broker-summary-pipeline',
  'accumulation': 'broker-summary-pipeline',
  'bandarmologi': 'bandarmologi-intel',
  'top20': 'screener-dispatch',
  'top5': 'screener-dispatch',
  'telegram': 'telegram-broadcast',
  'insider': 'insider-ksei-collector',
  'fundamental': 'fundamental-refresh',
  'quota-backfill': 'quota-manager',
  'hourly-confirmation': 'short-swing',
  'daytrade-fastwatcher': 'daytrade-v7',
  'fastwatcher': 'daytrade-v7',
  'daytrade-producer': 'daytrade-v7',
  'coordinated-pipeline': 'coordinated-pipeline-orchestrator',
  'oracle-monitoring': 'ops-watchdog'
};

/** Estimated real runtime (seconds) from production evidence (cron timeouts). */
const ESTIMATED_RUNTIME_SEC = {
  'yahoo-ohlcv': 1200,
  'ihsg': 60,
  'lifecycle': 600,
  'market-context': 300,
  'sector-hot': 240,
  'broksum-all': 2400,
  'broksum-foreign': 900,
  'domestic-compile': 600,
  'accumulation': 420,
  'bandarmologi': 480,
  'top20': 180,
  'top5': 120,
  'telegram': 90,
  'insider': 1500,
  'fundamental': 1200,
  'quota-backfill': 3300,
  'hourly-confirmation': 300,
  'daytrade-fastwatcher': 600,
  'fastwatcher': 600,
  'daytrade-producer': 900,
  'coordinated-pipeline': 3600,
  'oracle-monitoring': 60
};

/* -------------------------------------------------------------------------- */
/* Legacy executor inventory (frozen; source = deploy/vps/final-schedule.cron)  */
/* -------------------------------------------------------------------------- */

/**
 * The OLD production executors. `days: []` means every day; `[1..5]` Mon..Fri.
 * `timeoutSec` is the job-wrapper.sh timeout (upper bound of the WIB window).
 * These rows are the "19:45/20:25 tetap aktif" side of P0-07: while any of
 * them is ACTIVE for a side-effect class, the dynamic job of the same class
 * MUST NOT execute (runtime guard) and new config overlaps are rejected
 * (config guard).
 */
const LEGACY_EXECUTORS = [
  { name: 'daily-candles-1630', timeWIB: '16:30', days: [1, 2, 3, 4, 5], timeoutSec: 1800, usesQuota: false, sideEffectClass: 'CANDLE_EOD_YAHOO', executor: 'CRON_VPS', owner: 'run-daily-candles.sh' },
  { name: 'daily-candles', timeWIB: '17:00', days: [1, 2, 3, 4, 5], timeoutSec: 1800, usesQuota: false, sideEffectClass: 'CANDLE_EOD_YAHOO', executor: 'CRON_VPS', owner: 'run-daily-candles.sh' },
  { name: 'ihsg-candle', timeWIB: '17:05', days: [1, 2, 3, 4, 5], timeoutSec: 600, usesQuota: true, sideEffectClass: 'IHSG_CANDLE', executor: 'CRON_VPS', owner: 'run-ihsg-candle.sh' },
  { name: 'lifecycle-1715', timeWIB: '17:15', days: [1, 2, 3, 4, 5], timeoutSec: 900, usesQuota: false, sideEffectClass: 'LIFECYCLE_EVAL', executor: 'CRON_VPS', owner: 'run-lifecycle-evaluator.sh' },
  { name: 'daily-candles-retry', timeWIB: '17:45', days: [1, 2, 3, 4, 5], timeoutSec: 1200, usesQuota: false, sideEffectClass: 'CANDLE_EOD_YAHOO', executor: 'CRON_VPS', owner: 'run-daily-candles.sh --retry' },
  { name: 'lifecycle-1800', timeWIB: '18:00', days: [1, 2, 3, 4, 5], timeoutSec: 900, usesQuota: false, sideEffectClass: 'LIFECYCLE_EVAL', executor: 'CRON_VPS', owner: 'run-lifecycle-evaluator.sh' },
  { name: 'market-context', timeWIB: '18:10', days: [1, 2, 3, 4, 5], timeoutSec: 900, usesQuota: false, sideEffectClass: 'MARKET_CONTEXT', executor: 'CRON_VPS', owner: 'run-daily-market-context-collector.sh' },
  { name: 'sector-hot-eod', timeWIB: '18:12', days: [1, 2, 3, 4, 5], timeoutSec: 600, usesQuota: false, sideEffectClass: 'SECTOR_HOT', executor: 'CRON_VPS', owner: 'run-sector-hot.sh' },
  { name: 'broksum-1945', timeWIB: '19:45', days: [1, 2, 3, 4, 5], timeoutSec: 2400, usesQuota: true, sideEffectClass: 'BROKER_SUMMARY_ALL', executor: 'CRON_VPS', owner: 'run-daily-market-update.sh' },
  { name: 'domestic-compile-2025', timeWIB: '20:25', days: [1, 2, 3, 4, 5], timeoutSec: 1500, usesQuota: false, sideEffectClass: 'DOMESTIC_COMPILE', executor: 'CRON_VPS', owner: 'build-domestic-broksum-and-accum.js' },
  { name: 'broksum-retry-2045', timeWIB: '20:45', days: [1, 2, 3, 4, 5], timeoutSec: 1500, usesQuota: true, sideEffectClass: 'BROKER_SUMMARY_SWEEP', executor: 'CRON_VPS', owner: 'run-daily-market-update.sh --final' },
  { name: 'domestic-compile-final-2110', timeWIB: '21:10', days: [1, 2, 3, 4, 5], timeoutSec: 1200, usesQuota: false, sideEffectClass: 'DOMESTIC_COMPILE', executor: 'CRON_VPS', owner: 'build-domestic-broksum-and-accum.js --force' },
  { name: 'bandarmologi-intel-2114', timeWIB: '21:14', days: [1, 2, 3, 4, 5], timeoutSec: 900, usesQuota: false, sideEffectClass: 'BANDARMOLOGI_INTEL', executor: 'CRON_VPS', owner: 'run-bandarmologi-intel.js' },
  { name: 'screeners-preflight-2125', timeWIB: '21:25', days: [1, 2, 3, 4, 5], timeoutSec: 2700, usesQuota: false, sideEffectClass: 'SCREENERS_PREFLIGHT', executor: 'CRON_VPS', owner: 'run-screeners-preflight.sh' },
  { name: 'top5-radar', timeWIB: '21:35', days: [1, 2, 3, 4, 5], timeoutSec: 900, usesQuota: false, sideEffectClass: 'TOP5_RADAR', executor: 'CRON_VPS', owner: 'run-after-market-top5-lock.js' },
  { name: 'landing-snapshot', timeWIB: '21:40', days: [1, 2, 3, 4, 5], timeoutSec: 600, usesQuota: false, sideEffectClass: 'LANDING_SNAPSHOT', executor: 'CRON_VPS', owner: 'direct-refresh-landing.js' },
  { name: 'afternoon-recap', timeWIB: '21:45', days: [1, 2, 3, 4, 5], timeoutSec: 600, usesQuota: false, sideEffectClass: 'TELEGRAM_RECAP', executor: 'CRON_VPS', owner: 'run-daily-afternoon-recap.sh' },
  { name: 'insider-tiered-2200', timeWIB: '22:00', days: [], timeoutSec: 1800, usesQuota: true, sideEffectClass: 'INSIDER_FETCH', executor: 'CRON_VPS', owner: 'collect-insider-data.js --tiered' },
  { name: 'fundamental-refresh-2220', timeWIB: '22:20', days: [], timeoutSec: 1500, usesQuota: true, sideEffectClass: 'FUNDAMENTAL_REFRESH', executor: 'CRON_VPS', owner: 'run-fundamental-refresh.js' },
  { name: 'quota-burn-night-2245', timeWIB: '22:45', days: [], timeoutSec: 3600, usesQuota: true, sideEffectClass: 'QUOTA_BURN', executor: 'CRON_VPS', owner: 'quota-burn.js --floor 5000' },
  { name: 'catchup-0015', timeWIB: '00:15', days: [], timeoutSec: 600, usesQuota: false, sideEffectClass: 'CATCHUP_QUEUE', executor: 'CRON_VPS', owner: 'catchup-missing-dates.js' },
  { name: 'quota-burn-0015', timeWIB: '00:15', days: [1, 2, 3, 4, 5], timeoutSec: 3300, usesQuota: true, sideEffectClass: 'QUOTA_BURN', executor: 'CRON_VPS', owner: 'quota-burn.js --floor 5000' },
  { name: 'quota-burn-day', timeWIB: '00:35', days: [1, 2, 3, 4, 5], timeoutSec: 3300, usesQuota: true, sideEffectClass: 'QUOTA_BURN', executor: 'CRON_VPS', owner: 'quota-burn.js (estafet :35 tiap jam 00:35-18:35)' },
  { name: 'quota-burn-weekend', timeWIB: '00:35', days: [0, 6], timeoutSec: 3000, usesQuota: true, sideEffectClass: 'QUOTA_BURN', executor: 'CRON_VPS', owner: 'quota-burn.js --floor 0 (estafet :35)' },
  { name: 'scheduler-daemon-observer', timeWIB: '00:00', days: [], timeoutSec: 0, usesQuota: false, sideEffectClass: 'OBSERVER_ONLY', executor: 'PM2_VPS', owner: 'scripts/scheduler-daemon.js (V5: observer, never spawns)' },
  { name: 'watchdog', timeWIB: '00:00', days: [], timeoutSec: 300, usesQuota: false, sideEffectClass: 'MONITORING', executor: 'CRON_VPS', owner: 'watchdog.js (*/5)' },
  { name: 'security-monitor', timeWIB: '00:00', days: [], timeoutSec: 300, usesQuota: false, sideEffectClass: 'MONITORING', executor: 'CRON_VPS', owner: 'security-monitor.js (*/5)' }
];

const DEFAULT_LEGACY_ACTIVE_PATH = path.join(ROOT, 'data', 'schedule-runner', 'legacy-active.json');

/**
 * Read the legacy-active registry. Missing/corrupt file => FAIL-CLOSED:
 * EVERY legacy executor is considered ACTIVE (cron is the production SSOT),
 * so no dynamic job can double-execute by accident.
 * Returns { executors: {name:'ACTIVE'|'RETIRED'}, activeNames:[], source, allActive }.
 */
function readLegacyActive(file) {
  const p = file || process.env.SCHEDULE_LEGACY_ACTIVE_PATH || DEFAULT_LEGACY_ACTIVE_PATH;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const map = {};
    const names = [];
    for (const ex of LEGACY_EXECUTORS) {
      const st = String((parsed && parsed.executors && parsed.executors[ex.name]) || 'ACTIVE').toUpperCase();
      map[ex.name] = st === 'RETIRED' ? 'RETIRED' : 'ACTIVE';
      if (map[ex.name] === 'ACTIVE') names.push(ex.name);
    }
    return { executors: map, activeNames: names, source: p, allActive: false };
  } catch (_) {
    const map = {};
    const names = [];
    for (const ex of LEGACY_EXECUTORS) { map[ex.name] = 'ACTIVE'; names.push(ex.name); }
    return { executors: map, activeNames: names, source: 'BUILTIN_DEFAULT (file missing => fail-closed all ACTIVE)', allActive: true };
  }
}

/** Active legacy executors sharing a job's side-effect class (runtime guard). */
function activeExecutorsForClass(sideEffectClass, activeNames) {
  const active = new Set(Array.isArray(activeNames) ? activeNames : []);
  return LEGACY_EXECUTORS.filter((ex) => ex.sideEffectClass === sideEffectClass && active.has(ex.name));
}

/* -------------------------------------------------------------------------- */
/* Config-time guard: NEW overlap introduced by a patch                         */
/* -------------------------------------------------------------------------- */

function jobWindow(job) {
  const start = timeToMinutes(job.timeWIB);
  if (start == null) return null;
  const durMin = Math.max(1, Math.ceil((Number(job.maxDurationSeconds) || 0) / 60));
  return { start, end: start + durMin };
}

function legacyWindow(ex) {
  const start = timeToMinutes(ex.timeWIB);
  const durMin = Math.max(1, Math.ceil((Number(ex.timeoutSec) || 0) / 60));
  return { start, end: start + durMin };
}

function overlappingLegacyExecutors(job, activeNames) {
  const cls = SIDE_EFFECT_CLASS[job.key];
  const w = jobWindow(job);
  if (!cls || !w) return [];
  const out = [];
  for (const ex of activeExecutorsForClass(cls, activeNames)) {
    const lw = legacyWindow(ex);
    if (!daysShare(job.days, ex.days)) continue;
    if (windowsOverlap(w.start, w.end, lw.start, lw.end)) out.push(ex);
  }
  return out;
}

/**
 * Config guard for store.put() — P0-07 "duplikasi job dengan executor lama":
 * a patch is REJECTED (reason LEGACY_DUPLICATE) when, for a patched job whose
 * timeWIB CHANGES (or which is newly ENABLED), the new execution window
 * overlaps an ACTIVE legacy executor (cron/PM2/systemd) of the SAME
 * side-effect class — i.e. the edit would schedule a second executor on top of
 * the old one (double broker-API burn / double publish).
 *
 * Exemptions:
 *   - timeWIB unchanged (pure enable/retry/priority edit of a grandfathered
 *     slot) — governed at RUNTIME by BLOCKED_LEGACY_ACTIVE instead.
 *   - new timeWIB equals the catalog seed default (e.g. broksum-all 20:00 vs
 *     broksum-1945 19:45-20:25): the canonical V6 layout is intentionally
 *     grandfathered and runtime-guarded until the approved cutover.
 *
 * @param {object} prevDoc  normalized doc before patch
 * @param {object} nextDoc  normalized doc after patch
 * @param {string[]} patchedKeys
 * @param {string[]} activeNames from readLegacyActive()
 * @param {object} catalogDefaults { key: defaultTimeWIB }
 * @returns {Array<{job:string, timeWIB:string, executors:string[], sideEffectClass:string}>}
 */
function detectLegacyDuplicatePatches(prevDoc, nextDoc, patchedKeys, activeNames, catalogDefaults) {
  const out = [];
  for (const key of patchedKeys || []) {
    const prevJob = prevDoc && prevDoc.jobs ? prevDoc.jobs[key] : null;
    const nextJob = nextDoc && nextDoc.jobs ? nextDoc.jobs[key] : null;
    if (!nextJob || nextJob.enabled !== true) continue;
    const timeChanged = !prevJob || prevJob.timeWIB !== nextJob.timeWIB;
    const newlyEnabled = !prevJob || (prevJob.enabled !== true && nextJob.enabled === true);
    if (!timeChanged && !newlyEnabled) continue; // grandfathered slot, runtime-guarded
    const defTime = catalogDefaults ? catalogDefaults[key] : null;
    if (defTime && nextJob.timeWIB === defTime && !newlyEnabled) continue; // canonical default exempt
    const overlaps = overlappingLegacyExecutors(nextJob, activeNames);
    if (overlaps.length === 0) continue;
    out.push({
      job: key,
      timeWIB: nextJob.timeWIB,
      sideEffectClass: SIDE_EFFECT_CLASS[key] || 'UNKNOWN',
      executors: overlaps.map((e) => e.name + ' @ ' + e.timeWIB + '-' + minutesToTime(legacyWindow(e).end))
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Collision matrix (explicit, for docs/v6/V6_COLLISION_MATRIX.csv)             */
/* -------------------------------------------------------------------------- */

/**
 * Build explicit collision rows:
 *   DYNAMIC_DYNAMIC — enabled collisionCheck jobs whose WIB windows overlap.
 *   DYNAMIC_LEGACY  — dynamic job vs legacy executor:
 *       severity DUPLICATE_CLASS_OVERLAP  (same class + time overlap => double exec risk)
 *       severity DUPLICATE_CLASS_DISJOINT (same class, disjoint time => still one
 *                                          executor per class until cutover)
 *       severity TIME_OVERLAP_CROSS_CLASS (advisory: resource contention only)
 *   GUARD columns state which guard rejects/blocks each row.
 */
function buildCollisionMatrix(doc, activeNames) {
  const rows = [];
  const jobs = Object.values((doc && doc.jobs) || {});

  // DYNAMIC × DYNAMIC
  const cc = jobs.filter((j) => j && j.enabled && j.collisionCheck);
  for (let i = 0; i < cc.length; i++) {
    const a = cc[i];
    const wa = jobWindow(a);
    for (let j = i + 1; j < cc.length; j++) {
      const b = cc[j];
      const wb = jobWindow(b);
      if (!wa || !wb) continue;
      if (!daysShare(a.days, b.days)) continue;
      if (windowsOverlap(wa.start, wa.end, wb.start, wb.end)) {
        rows.push({
          pairType: 'DYNAMIC_DYNAMIC',
          a: a.key, aTime: a.timeWIB, aEnd: minutesToTime(wa.end),
          b: b.key, bTime: b.timeWIB, bEnd: minutesToTime(wb.end),
          overlapMinutes: Math.min(wa.end, wb.end) - Math.max(wa.start, wb.start),
          sideEffectClass: SIDE_EFFECT_CLASS[a.key] || '',
          severity: 'HARD',
          guard: 'store.put reason=COLLISION (409 SCHEDULE_COLLISION)',
          resolution: 'Geser jam/kurangi durasi salah satu job.'
        });
      }
    }
  }

  // DYNAMIC × LEGACY
  for (const job of jobs) {
    if (!job || !job.enabled) continue;
    const cls = SIDE_EFFECT_CLASS[job.key];
    if (!cls) continue;
    const wj = jobWindow(job);
    for (const ex of LEGACY_EXECUTORS) {
      const isActive = (activeNames || []).includes(ex.name);
      if (ex.sideEffectClass === cls) {
        const wl = legacyWindow(ex);
        const overlap = wj && daysShare(job.days, ex.days) && windowsOverlap(wj.start, wj.end, wl.start, wl.end);
        rows.push({
          pairType: 'DYNAMIC_LEGACY',
          a: job.key, aTime: job.timeWIB, aEnd: wj ? minutesToTime(wj.end) : '',
          b: ex.name, bTime: ex.timeWIB, bEnd: minutesToTime(wl.end),
          overlapMinutes: overlap ? Math.min(wj.end, wl.end) - Math.max(wj.start, wl.start) : 0,
          sideEffectClass: cls,
          severity: overlap ? 'DUPLICATE_CLASS_OVERLAP' : 'DUPLICATE_CLASS_DISJOINT',
          guard: isActive
            ? 'RUNTIME BLOCKED_LEGACY_ACTIVE (dynamic job tidak dieksekusi selama executor legacy ACTIVE) + store.put LEGACY_DUPLICATE untuk overlap BARU'
            : 'Legacy RETIRED di registry => dynamic job boleh eksekusi (cutover selesai)',
          resolution: isActive
            ? 'Cutover butuh APPROVAL: retire ' + ex.name + ' di data/schedule-runner/legacy-active.json HANYA setelah izin (jangan sentuh cron produksi tanpa persetujuan).'
            : 'Tidak ada aksi (sudah cutover).'
        });
      } else if (wj && ex.timeoutSec > 0 && daysShare(job.days, ex.days)) {
        const wl = legacyWindow(ex);
        if (windowsOverlap(wj.start, wj.end, wl.start, wl.end)) {
          rows.push({
            pairType: 'DYNAMIC_LEGACY',
            a: job.key, aTime: job.timeWIB, aEnd: minutesToTime(wj.end),
            b: ex.name, bTime: ex.timeWIB, bEnd: minutesToTime(wl.end),
            overlapMinutes: Math.min(wj.end, wl.end) - Math.max(wj.start, wl.start),
            sideEffectClass: cls + ' vs ' + ex.sideEffectClass,
            severity: 'ADVISORY_TIME_OVERLAP_CROSS_CLASS',
            guard: 'Tidak ada duplikasi side-effect (kelas beda); kontensi resource dipantau job-wrapper flock + nice/ionice',
            resolution: 'Monitor; tidak perlu aksi kecuali event-loop lag > 100ms.'
          });
        }
      }
    }
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Job descriptor — the mandated 23 fields per job                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the full per-job descriptor record.
 * opts: { now:Date, version:number, state:object, legacyActive:string[],
 *         effectiveNextRunWib:string, activeExecutorOverride:string }
 */
function buildJobDescriptor(job, catalogDef, opts) {
  const o = opts || {};
  const key = job.key;
  const cls = SIDE_EFFECT_CLASS[key] || 'UNKNOWN';
  const activeNames = o.legacyActive || [];
  const sameClassActive = activeExecutorsForClass(cls, activeNames);
  const st = (o.state && o.state.last && o.state.last[key]) || {};
  const usesQuota = job.costClass !== 'ZERO_QUOTA';
  const editability = job.editable === false ? 'READ_ONLY'
    : (catalogDef && catalogDef.lockedDefault ? 'EDITABLE_LOCKED_DEFAULT_20:00 (17:00/19:45 ditolak)' : 'EDITABLE');
  const version = Number.isInteger(Number(o.version)) ? Number(o.version) : 0;
  return {
    job_id: 'dyn:' + key,
    source_of_truth: 'data/admin-schedule-config.json v' + version + ' (admin-schedule-store)',
    configured_days: (job.days && job.days.length ? job.days.join('|') : '*'),
    configured_time_wib: job.timeWIB,
    effective_next_run_wib: o.effectiveNextRunWib || null,
    requires: (job.dependsOn || []).join('|') || '',
    produces: PRODUCES[key] || '',
    uses_arjum_quota: usesQuota,
    budget_priority: job.priority,
    lock_key: 'autocuan-' + key,
    timeout_sec: job.maxDurationSeconds,
    retry_policy: 'catch-up<=' + job.retryWindowMinutes + 'm; beyond->MISSED; FAILED/TIMEOUT->RETRIED (idempoten per slot)',
    heartbeat_path: 'data/schedule-runner/heartbeat.json (runner lokal) / data/job-heartbeat/' + key + '.json (konvensi cron)',
    active_executor: o.activeExecutorOverride
      || (sameClassActive.length ? 'CRON_VPS:' + sameClassActive.map((e) => e.name).join('+') + ' (dynamic BLOCKED_LEGACY_ACTIVE)' : 'ADMIN_STORE+LOCAL_RUNNER (legacy class RETIRED)'),
    owner_service: OWNER_SERVICE[key] || '',
    estimated_runtime_sec: ESTIMATED_RUNTIME_SEC[key] || job.maxDurationSeconds,
    last_start_wib: st.lastStartWib || null,
    last_end_wib: st.lastEndWib || null,
    last_success_wib: st.lastSuccessWib || null,
    last_result: st.lastResult || null,
    side_effect_class: cls,
    editability,
    rollback_target: version > 0
      ? 'admin-schedule-config.v' + (version - 1) + '.json (store.restoreVersion(' + (version - 1) + '))'
      : 'seed default JOB_CATALOG (belum ada versi sebelumnya)'
  };
}

/* -------------------------------------------------------------------------- */
/* Cutover plan (APPROVAL REQUIRED — never mutate production cron silently)     */
/* -------------------------------------------------------------------------- */

const CUTOVER_PLAN_MD = [
  '## Rencana Cutover Executor Lama -> Jadwal Dinamis (APPROVAL REQUIRED)',
  '',
  'Status quo: `deploy/vps/final-schedule.cron` (via `job-wrapper.sh`) adalah SATU-SATUNYA eksekutor produksi.',
  'Jadwal dinamis (admin store) dieksekusi lokal HANYA oleh `scripts/schedule-runner-local.js` dalam mode FIXTURE',
  '(side-effect file lokal, tanpa network/Telegram), sehingga tidak pernah dobel dengan cron.',
  '',
  'Guard ganda yang sudah aktif:',
  '1. RUNTIME: selama executor legacy sekelas masih ACTIVE di registry, `decideRun`/runner mengembalikan',
  '   `BLOCKED_LEGACY_ACTIVE` — job dinamis TIDAK dieksekusi (bukti: test runner nyata).',
  '2. CONFIG: `store.put` menolak patch yang memperkenalkan overlap BARU dengan executor legacy ACTIVE sekelas',
  '   (reason `LEGACY_DUPLICATE`). Overlap bawaan (grandfathered, mis. broksum-all 20:00 vs broksum-1945 19:45-20:25)',
  '   diatur oleh guard runtime sampai cutover disetujui.',
  '',
  'Langkah cutover per job (HANYA setelah izin owner; JANGAN sentuh cron/PM2 produksi tanpa approval):',
  '1. Dry-run runner lokal >= 3 hari bursa: heartbeat + executions.jsonl bersih (DONE, tanpa BLOCKED/MISSED berulang).',
  '2. Set registry `data/schedule-runner/legacy-active.json`: executor legacy sekelas -> `RETIRED` (mis. `broksum-1945`).',
  '3. Verifikasi runner lokal mengeksekusi job dinamis pada slot barunya (20:00) TANPA eksekusi legacy bersamaan.',
  '4. Dengan approval tertulis: hapus baris cron legacy (`crontab -e` di VPS) ATAU nonaktifkan entri PM2 lama;',
  '   jalankan `node tools/validate-schedule.js` (wajib exit 0) dan simpan buktinya di docs/v6/.',
  '5. Rollback cutover: kembalikan registry ke `ACTIVE` (fail-closed) + pasang kembali baris cron dari',
  '   `deploy/vps/final-schedule.cron` (file ini tidak pernah dimutasi oleh admin store).',
  '',
  'Urutan cutover yang disarankan (dependency-safe): yahoo-ohlcv -> ihsg -> lifecycle -> market-context -> sector-hot',
  '-> broksum-all -> broksum-foreign -> domestic-compile -> accumulation -> bandarmologi -> top20 -> top5 -> telegram',
  '-> insider -> fundamental -> quota-backfill. Job LEGACY read-only (hourly-confirmation, daytrade-fastwatcher)',
  'dan monitoring (oracle/watchdog/security) TIDAK ikut cutover (SSOT tetap cron/VM).'
].join('\n');

module.exports = {
  ROOT,
  SIDE_EFFECT_CLASS,
  PRODUCES,
  OWNER_SERVICE,
  ESTIMATED_RUNTIME_SEC,
  LEGACY_EXECUTORS,
  DEFAULT_LEGACY_ACTIVE_PATH,
  timeToMinutes,
  minutesToTime,
  normalizeDays,
  daysShare,
  windowsOverlap,
  jobWindow,
  legacyWindow,
  readLegacyActive,
  activeExecutorsForClass,
  overlappingLegacyExecutors,
  detectLegacyDuplicatePatches,
  buildCollisionMatrix,
  buildJobDescriptor,
  CUTOVER_PLAN_MD
};
