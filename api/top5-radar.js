'use strict';

/**
 * api/top5-radar.js
 * ============================================================================
 * Endpoint API Top 5 Radar Terpadu Auto-Cuan V4
 * Menyajikan 5 saham pilihan terbaik (Konglo, Non-Konglo, Day Trade)
 * Disajikan dari cache in-memory untuk waktu respon < 10 ms.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const readiness = require('../lib/readiness-engine.js');
const chartT1Policy = require('../lib/chart-t1-policy.js');

const TOP5_FILE = path.resolve(__dirname, '..', 'data', 'top5-radar.json');

function expectedCompletedEodDate(nowMs) {
  const d = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const todayWib = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  const wd = get('weekday').toLowerCase();
  const mins = Number(get('hour') || 0) * 60 + Number(get('minute') || 0);
  const isWeekend = wd.startsWith('sat') || wd.startsWith('sun');
  if (isWeekend || mins < (16 * 60 + 30)) {
    return (typeof chartT1Policy.previousWeekday === 'function' && chartT1Policy.previousWeekday(todayWib)) || todayWib;
  }
  return todayWib;
}

let _cachedData = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60 * 1000;

/**
 * Canonical Short Swing readiness (lib/saham-potensial-engine.js) is a STRICTER
 * authority than the level-based readiness engine: it also grades per-component
 * data freshness (price / bandar / foreign) and mandatory-input availability.
 *
 * Only canonical READY may ever surface as an actionable READY here. Every
 * other canonical verdict caps the served status at WAITING_CONFIRMATION, so a
 * row the canonical engine demoted for staleness (NOT_READY) can never be
 * re-promoted to READY by the level-only engine.
 */
const CANONICAL_READY = 'READY';
const CANONICAL_READINESS_FLOOR_REASON = 'CANONICAL_READINESS_NOT_READY';

/**
 * Re-evaluate a pick that the producer wrote, through the single authority.
 *
 * WHY THIS EXISTS (BUG-V5-P0-003 / BUG-V5-P0-005):
 * the producer is not the only way a pick reaches a user. `data/top5-radar.json`
 * is a FILE on disk, so anything — an older build, an operator, a partially
 * rolled-back deploy — can leave a pick there stamped `READY` / `BUY` beside a
 * number that does not support it. Serving that file verbatim made this endpoint
 * a publisher of whatever the artefact claimed.
 *
 * Enforcement is server-side and fail-closed: the verdict is recomputed here,
 * from the pick's own levels, on every request. A pick the engine does not
 * consider READY has its action token removed before it is returned, whatever
 * the file said.
 *
 * Subtask H: the canonical engine's own `readiness` verdict is additionally
 * applied as a hard floor (see CANONICAL_READY above).
 *
 * @param {object} pick
 * @param {number} now
 * @param {object} [context] { publicationBlocked, blockReason }
 * @returns {object} the pick, with a corrected verdict
 */
function revalidatePick(pick, now, context) {
  if (!pick || typeof pick !== 'object') return pick;

  const pickTradeDay = String(pick.trade_date || pick.date || pick.market_date || pick.session_date || '').slice(0, 10);
  const expectedEod = expectedCompletedEodDate(now);
  const prevEod = (typeof chartT1Policy.previousWeekday === 'function' && chartT1Policy.previousWeekday(expectedEod)) || expectedEod;
  const wibClock = typeof chartT1Policy.getJakartaClockParts === 'function' ? chartT1Policy.getJakartaClockParts(now) : null;
  const beforeBroksumPublish = wibClock ? (wibClock.hour * 60 + wibClock.minute) < (21 * 60) : false;
  const effectiveExpectedEod = (beforeBroksumPublish && context && context.sourceDates && context.sourceDates.broksum_all === prevEod)
    ? prevEod
    : expectedEod;
  // Before 16:30 WIB on a trading day (or pre-21:00 WIB awaiting Broksum, or weekends/holidays),
  // the latest completed EOD session is up to ~40-96h after 00:00 WIB of that session.
  const evalOpts = (pickTradeDay && effectiveExpectedEod && pickTradeDay >= effectiveExpectedEod)
    ? { now, maxStalenessMinutes: 96 * 60 }
    : { now };
  const result = readiness.evaluate(pick, evalOpts);
  let status = result.status;
  const reasons = result.reasons.slice();

  // Canonical readiness floor (fail-closed).
  const canonicalReadiness = typeof pick.readiness === 'string' ? pick.readiness.toUpperCase() : null;
  const canonicalBlocks = canonicalReadiness !== null && canonicalReadiness !== CANONICAL_READY;
  if (canonicalBlocks && status === readiness.STATUS.READY) {
    status = readiness.STATUS.WAITING_CONFIRMATION;
    reasons.push(CANONICAL_READINESS_FLOOR_REASON + '_' + canonicalReadiness);
  }

  // A publication the producer itself refused (superseded revision, failed
  // content-hash validation, incomplete snapshot) must never look actionable.
  // The reason is recorded UNCONDITIONALLY so the block is auditable even when
  // another gate had already demoted the row.
  const ctx = context || {};
  if (ctx.publicationBlocked) {
    reasons.push('PUBLICATION_BLOCKED_' + String(ctx.blockReason || 'UNKNOWN'));
    if (status === readiness.STATUS.READY) {
      status = readiness.STATUS.INSUFFICIENT_DATA;
    }
  }

  const isReady = status === readiness.STATUS.READY;

  const out = Object.assign({}, pick);
  out.canonical_readiness = canonicalReadiness;
  out.canonical_status_reason = pick.status_reason || null;
  out.readiness_status = status;
  out.status = status;
  out.action = readiness.actionForStatus(status);
  out.action_label = out.action;
  out.status_label = readiness.labelForStatus(status);
  out.verdict_reason = reasons.length > 0 ? reasons[0] : null;
  out.verdict_reasons = reasons;
  out.rr_gate_passed = Boolean(result.gateResults.riskReward && result.gateResults.riskReward.pass);
  // Honest derived flags, matching what the producer now writes.
  out.trading_plan_valid = isReady;
  out.safe = isReady;
  out.quality_grade = null;
  out.grade = null;
  // Records that the artefact's own claim was overruled, so the discrepancy is
  // visible instead of silently corrected.
  if (pick.status !== status) {
    out.artifact_status_overruled = pick.status === undefined ? null : pick.status;
  }
  return out;
}

/**
 * Serve what the producer wrote, with every verdict recomputed server-side.
 *
 * V5 P0: this function performs NO fallback substitution. The previous version
 * returned `{ success: true, picks: [] }` whenever the file was missing — a
 * shape indistinguishable from "the producer honestly found zero candidates",
 * which let an absent file masquerade as a valid empty publication. Now the
 * absence is reported as an absence.
 *
 * `picks` may legitimately be `[]`; that is the producer's honest answer and it
 * is passed through untouched, together with the `data_status` it declared.
 */
function loadTop5Data() {
  const now = Date.now();
  const { getSnapshotVersionSig } = require('../lib/snapshot-mtime-guard');
  const snapSig = getSnapshotVersionSig();
  if (_cachedData && _cachedData._snapSig === snapSig && (now - _cachedAt < CACHE_TTL_MS)) {
    return _cachedData;
  }

  if (!fs.existsSync(TOP5_FILE)) {
    return {
      success: false,
      error: 'TOP5_ARTIFACT_MISSING',
      data_status: 'NOT_PUBLISHED',
      status_reason: 'PRODUCER_HAS_NOT_RUN',
      count: 0,
      picks: [],
      top5: []
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TOP5_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const served = Object.assign({}, parsed);

      // Subtask H / P0-10: a publication the producer refused — superseded
      // revision, failed content-hash validation, or an incomplete snapshot —
      // must never yield actionable picks, even if rows are present.
      const publicationBlocked =
        served.snapshot_superseded === true ||
        served.snapshot_id_match === false ||
        served.store_verified === false ||
        served.data_status === 'VALIDATION_FAILED' ||
        served.data_status === 'NOT_PUBLISHED';
      const revalidateCtx = {
        publicationBlocked,
        blockReason: served.status_reason || served.data_status || 'UNKNOWN',
        sourceDates: served.source_dates || null
      };

      // Enforce the readiness verdict on the way out. The file is treated as
      // untrusted input, not as an authority.
      for (const key of ['picks', 'top5', 'top5_picks']) {
        if (Array.isArray(served[key])) {
          served[key] = served[key].map((pick) => revalidatePick(pick, now, revalidateCtx));
        }
      }
      if (Array.isArray(served.top20)) {
        served.top20 = served.top20.map((pick) => revalidatePick(pick, now, revalidateCtx));
      }
      if (served.categories && typeof served.categories === 'object') {
        const cats = {};
        for (const catKey of Object.keys(served.categories)) {
          const list = served.categories[catKey];
          cats[catKey] = Array.isArray(list) ? list.map((pick) => revalidatePick(pick, now, revalidateCtx)) : list;
        }
        served.categories = cats;
      }
      // Report what the enforced set actually contains.
      const enforced = Array.isArray(served.picks) ? served.picks : [];
      served.readiness_counts = enforced.reduce((acc, pick) => {
        const k = String(pick && pick.readiness_status || 'UNKNOWN');
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
      served.canonical_readiness_counts = enforced.reduce((acc, pick) => {
        const k = String(pick && pick.canonical_readiness || 'UNKNOWN');
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
      served.actionable_count = enforced.filter((pick) => pick && pick.action === 'BUY').length;
      served.publication_blocked = publicationBlocked;
      served.top5_locked = Boolean(!publicationBlocked && enforced.length > 0);
      served.top5_source = served.top5_locked ? 'locked_rows' : 'awaiting_locked_rows';
      served.date = served.date || served.trade_date || served.market_date || null;
      served.readiness_enforced_at = new Date(now).toISOString();
      served.readiness_engine = '../lib/readiness-engine.js';
      served.canonical_engine = '../lib/saham-potensial-engine.js';

      served._snapSig = snapSig;
      _cachedData = served;
      _cachedAt = now;
      return served;
    }
    return {
      success: false,
      error: 'TOP5_ARTIFACT_NOT_AN_OBJECT',
      data_status: 'VALIDATION_FAILED',
      count: 0,
      picks: [],
      top5: []
    };
  } catch (err) {
    return {
      success: false,
      error: 'TOP5_ARTIFACT_UNPARSEABLE',
      detail: String((err && err.message) || err),
      data_status: 'VALIDATION_FAILED',
      count: 0,
      picks: [],
      top5: []
    };
  }
}

async function handler(req, res) {
  try {
    const data = loadTop5Data();
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    }
    if (res && typeof res.status === 'function') {
      return res.status(200).json(data);
    }
    return data;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: String((err && err.message) || err) });
    }
    throw err;
  }
}

module.exports = handler;
// Exported for the Subtask H consumer-contract tests: the canonical readiness
// floor must be verifiable without spinning up an HTTP server.
module.exports.revalidatePick = revalidatePick;
module.exports.loadTop5Data = loadTop5Data;
module.exports.CANONICAL_READY = CANONICAL_READY;
