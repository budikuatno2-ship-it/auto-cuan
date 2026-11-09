'use strict';

/**
 * V3-F03 Winning Confluence Params — dikunci dari backtest 964 saham riil.
 * ========================================================================
 * Sumber: config/v3-f03-winning-params.json (hasil scripts/run-real-backtest-964.js).
 * Dipakai 3 screener produksi sebagai gate konfluensi default.
 * Nilai apa adanya dari data riil; TIDAK dioptimasi ulang di runtime.
 */

const fs = require('fs');
const path = require('path');

const FALLBACK = {
  konglo: { scoreMin: 60, bsMin: 1.0, volMin: 1.0, rrMin: 1.5, horizon: 7 },
  nonkonglo: { scoreMin: 60, bsMin: 1.0, volMin: 1.5, rrMin: 1.8, horizon: 5 },
  daytrade: { scoreMin: 60, bsMin: 1.0, volMin: 1.0, rrMin: 1.5, horizon: 2 }
};

let cached = null;
let lastApprovalRejection = null;

/**
 * V5 Phase 3 (N20): the params file must carry a valid approval envelope.
 * An unapproved or post-approval-edited parameter file is REJECTED — the
 * loader falls back to the locked FALLBACK constants and records why.
 * lib/screener-config.js logs the rejection reason so the silent-swap path
 * (edit file → live scoring changes without approval) is impossible.
 */
function verifyApprovalOrFallback(raw) {
  let registry = null;
  try { registry = require('./strategy-registry'); } catch (_) { registry = null; }
  if (!registry || typeof registry.verifyParamsApproval !== 'function') {
    return { ok: false, reason: 'strategy-registry module unavailable' };
  }
  return registry.verifyParamsApproval(path.join(__dirname, '..', 'config', 'v3-f03-winning-params.json'));
}

function load() {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'v3-f03-winning-params.json'), 'utf8'));
    const approval = verifyApprovalOrFallback(raw);
    if (!approval.ok) {
      lastApprovalRejection = approval.reason;
      cached = JSON.parse(JSON.stringify(FALLBACK));
      cached.metrics = null;
      cached.updatedAt = null;
      cached.approvalStatus = 'REJECTED';
      cached.approvalReason = approval.reason;
      return cached;
    }
    lastApprovalRejection = null;
    cached = {
      approvalStatus: 'APPROVED',
      approvalVersion: approval.version,
      approvalBy: approval.approvedBy,
      konglo: {
        scoreMin: Number(raw.konglo.scoreMin),
        bsMin: Number(raw.konglo.bsMin),
        volMin: Number(raw.konglo.volMin),
        rrMin: Number(raw.konglo.rrMin),
        horizon: Number((raw.horizons || {}).konglo) || 7
      },
      nonkonglo: {
        scoreMin: Number(raw.nonkonglo.scoreMin),
        bsMin: Number(raw.nonkonglo.bsMin),
        volMin: Number(raw.nonkonglo.volMin),
        rrMin: Number(raw.nonkonglo.rrMin),
        horizon: Number((raw.horizons || {}).nonkonglo) || 5
      },
      daytrade: {
        scoreMin: Number(raw.daytrade.scoreMin),
        bsMin: Number(raw.daytrade.bsMin),
        volMin: Number(raw.daytrade.volMin),
        rrMin: Number(raw.daytrade.rrMin),
        horizon: Number((raw.horizons || {}).daytrade) || 2
      },
      metrics: raw.metrics || null,
      updatedAt: raw.updatedAt || null
    };
    for (const m of ['konglo', 'nonkonglo', 'daytrade']) {
      for (const k of ['scoreMin', 'bsMin', 'volMin', 'rrMin', 'horizon']) {
        if (!Number.isFinite(cached[m][k])) cached[m][k] = FALLBACK[m][k];
      }
    }
  } catch (_) {
    cached = JSON.parse(JSON.stringify(FALLBACK));
    cached.metrics = null;
    cached.updatedAt = null;
  }
  return cached;
}

/** V5 Phase 3 (N20): last approval-gate rejection reason, or null. */
function getApprovalRejection() { return lastApprovalRejection; }

function getMachineParams(machine) {
  const all = load();
  if (machine === 'konglo') return all.konglo;
  if (machine === 'nonkonglo') return all.nonkonglo;
  if (machine === 'daytrade') return all.daytrade;
  return FALLBACK.nonkonglo;
}

module.exports = {
  FALLBACK: FALLBACK,
  load: load,
  getMachineParams: getMachineParams,
  verifyApprovalOrFallback: verifyApprovalOrFallback,
  getApprovalRejection: getApprovalRejection
};
