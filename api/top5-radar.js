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

const TOP5_FILE = path.resolve(__dirname, '..', 'data', 'top5-radar.json');

let _cachedData = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60 * 1000;

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
 * @param {object} pick
 * @param {number} now
 * @returns {object} the pick, with a corrected verdict
 */
function revalidatePick(pick, now) {
  if (!pick || typeof pick !== 'object') return pick;

  const result = readiness.evaluate(pick, { now });
  const isReady = result.status === readiness.STATUS.READY;

  const out = Object.assign({}, pick);
  out.readiness_status = result.status;
  out.status = result.status;
  out.action = readiness.actionForStatus(result.status);
  out.action_label = out.action;
  out.status_label = readiness.labelForStatus(result.status);
  out.verdict_reason = result.reasons.length > 0 ? result.reasons[0] : null;
  out.verdict_reasons = result.reasons.slice();
  out.rr_gate_passed = Boolean(result.gateResults.riskReward && result.gateResults.riskReward.pass);
  // Honest derived flags, matching what the producer now writes.
  out.trading_plan_valid = isReady;
  out.safe = isReady;
  out.quality_grade = null;
  out.grade = null;
  // Records that the artefact's own claim was overruled, so the discrepancy is
  // visible instead of silently corrected.
  if (pick.status !== result.status) {
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
  if (_cachedData && (now - _cachedAt < CACHE_TTL_MS)) {
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
      // Enforce the readiness verdict on the way out. The file is treated as
      // untrusted input, not as an authority.
      for (const key of ['picks', 'top5', 'top5_picks']) {
        if (Array.isArray(served[key])) {
          served[key] = served[key].map((pick) => revalidatePick(pick, now));
        }
      }
      if (served.categories && typeof served.categories === 'object') {
        const cats = {};
        for (const catKey of Object.keys(served.categories)) {
          const list = served.categories[catKey];
          cats[catKey] = Array.isArray(list) ? list.map((pick) => revalidatePick(pick, now)) : list;
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
      served.readiness_enforced_at = new Date(now).toISOString();
      served.readiness_engine = '../lib/readiness-engine.js';

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

module.exports = async function handler(req, res) {
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
};
