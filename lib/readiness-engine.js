'use strict';

/**
 * lib/readiness-engine.js
 * ============================================================================
 * V5 P0 — CENTRAL READINESS VERDICT ENGINE (BUG-V5-P0-003 / BUG-V5-P0-005)
 * ============================================================================
 *
 * ROOT CAUSE THIS MODULE EXISTS TO REMOVE
 *   Every publish path stamped its own verdict. `api/screener.js` and
 *   `scripts/top5-radar.js` each grew a private `READY` / `BUY` / `A+` notion,
 *   `lib/top5-fusion-engine.js` could override the result unconditionally
 *   (`pick.trading_plan_valid = true` at ~1287-1304 and ~1345-1360), and the
 *   upstream producer's own free-text status (`"Swing Ready"`) was copied into a
 *   field (`setup`) that downstream consumers read as a verdict. The documented
 *   consequence: PANI was published as `Ready` / `A+` / `Low Risk` next to its
 *   own `rr = 1.39`, i.e. the numbers contradicted the label.
 *
 * THE INVARIANT THIS MODULE ENFORCES
 *   A candidate may be labelled READY **only** when every number it publishes
 *   independently supports that label. One evaluation function, one rule order,
 *   one vocabulary — no per-caller interpretation, no waiver, no override.
 *
 * CONTRACT
 *   1. `evaluate()` is PURE: no I/O, no clock read, no mutation of its input.
 *      The only time source is `policy.now`, injected by the caller. Two calls
 *      with equal arguments MUST return deeply equal results.
 *   2. Every rule that fires appends a machine-readable `reason` code. A rule
 *      never "silently passes": the gateResults entry records the outcome and
 *      the reason code names the rule that decided.
 *   3. The R/R veto is absolute. `rr < policy.minRiskReward` ⇒ `REJECTED`, and
 *      no combination of otherwise-clean inputs can lift it.
 *   4. There is NO waiver path. A candidate that arrives carrying a waiver flag
 *      is evaluated from scratch like any other; `WAIVER_IGNORED` is recorded
 *      and the flag grants nothing.
 *   5. Unknown is `null`. A numeric that is `null`/`NaN`/`undefined` can never
 *      contribute to `READY`.
 *
 * STATUS VOCABULARY (exactly six values)
 *   READY                 every gate passed and the plan is actionable now
 *   WATCH                 readable and gate-passing, but a non-blocking quality
 *                         dimension is unproven (e.g. volume/liquidity unknown)
 *   WAITING_CONFIRMATION  the plan is fine but the data cannot yet be trusted as
 *                         current (PARTIAL / STALE within tolerance)
 *   INSUFFICIENT_DATA     a required input is unknown — never READY
 *   EXPIRED               the data is real but past its usable window
 *   REJECTED              the candidate's own numbers contradict actionability
 * ============================================================================
 */

const contract = require('./market-data-contract.js');
const screenerConfig = require('./screener-config.js');

const { DATA_STATUS, numberOrNull, isKnown, validateOhlcv } = contract;

/* -------------------------------------------------------------------------- */
/* Status vocabulary — frozen so a typo cannot invent an eighth state          */
/* -------------------------------------------------------------------------- */

const STATUS = Object.freeze({
  READY: 'READY',
  WATCH: 'WATCH',
  WAITING_CONFIRMATION: 'WAITING_CONFIRMATION',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED'
});

const STATUS_VALUES = Object.freeze(Object.keys(STATUS).map((k) => STATUS[k]));

/**
 * Reason codes. Each is emitted by exactly one rule, so a caller can attribute
 * a verdict to the rule that produced it instead of guessing.
 */
const REASON = Object.freeze({
  // R/R veto
  RR_BELOW_MIN: 'RR_BELOW_MIN',
  RR_UNKNOWN: 'RR_UNKNOWN',
  RR_CONTRADICTS_REPORTED: 'RR_CONTRADICTS_REPORTED',
  // Structural
  INVALID_OHLCV: 'INVALID_OHLCV',
  TRADE_PLAN_STRUCTURALLY_INVALID: 'TRADE_PLAN_STRUCTURALLY_INVALID',
  TRADE_PLAN_LEVELS_ABSENT: 'TRADE_PLAN_LEVELS_ABSENT',
  PRICE_ABSENT: 'PRICE_ABSENT',
  PRICE_NOT_POSITIVE: 'PRICE_NOT_POSITIVE',
  // Freshness
  DATA_EXPIRED: 'DATA_EXPIRED',
  DATA_STALE_WITHIN_TOLERANCE: 'DATA_STALE_WITHIN_TOLERANCE',
  DATA_STALE_AGE_UNKNOWN: 'DATA_STALE_AGE_UNKNOWN',
  DATA_PARTIAL: 'DATA_PARTIAL',
  DATA_NOT_AVAILABLE: 'DATA_NOT_AVAILABLE',
  // Quality (non-blocking)
  VOLUME_UNKNOWN: 'VOLUME_UNKNOWN',
  VOLUME_ZERO: 'VOLUME_ZERO',
  LIQUIDITY_UNKNOWN: 'LIQUIDITY_UNKNOWN',
  LIQUIDITY_BELOW_MIN: 'LIQUIDITY_BELOW_MIN',
  SOURCE_ADVISES_CAUTION: 'SOURCE_ADVISES_CAUTION',
  // Transparency
  WAIVER_IGNORED: 'WAIVER_IGNORED',
  ALL_GATES_PASSED: 'ALL_GATES_PASSED'
});

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Default policy. `now` is deliberately `null` — the engine never reads the
 * clock itself. A caller that omits it simply cannot be granted `EXPIRED`
 * (staleness age becomes unknown, which degrades instead of expiring).
 */
const DEFAULT_POLICY = Object.freeze({
  minRiskReward: screenerConfig.MIN_RR_RATIO,
  maxStalenessMinutes: 1440,
  minVolume: 1,
  minLiquidityValue: 0,
  now: null,
  /** Present only so a caller cannot claim "the engine allowed a waiver". */
  allowWaiver: false
});

/** Numeric policy field with a hard default; never accepts garbage. */
function policyNumber(value, fallback) {
  const n = numberOrNull(value);
  return n === null ? fallback : n;
}

function normalizePolicy(policy) {
  const p = policy && typeof policy === 'object' ? policy : {};
  return {
    minRiskReward: policyNumber(p.minRiskReward, DEFAULT_POLICY.minRiskReward),
    maxStalenessMinutes: policyNumber(p.maxStalenessMinutes, DEFAULT_POLICY.maxStalenessMinutes),
    minVolume: policyNumber(p.minVolume, DEFAULT_POLICY.minVolume),
    minLiquidityValue: policyNumber(p.minLiquidityValue, DEFAULT_POLICY.minLiquidityValue),
    now: p.now === undefined ? DEFAULT_POLICY.now : p.now,
    // Always false. Reading the flag cannot enable it.
    allowWaiver: false
  };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/** First known numeric among the aliases. `0` survives. */
function readNumber() {
  for (let i = 0; i < arguments.length; i += 1) {
    const n = numberOrNull(arguments[i]);
    if (n !== null) return n;
  }
  return null;
}

/** First non-empty trimmed string among the aliases, upper-cased. */
function readUpperText() {
  for (let i = 0; i < arguments.length; i += 1) {
    const candidate = arguments[i];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim().toUpperCase();
    }
  }
  return null;
}

/**
 * Resolve the published entry / stop / target from a candidate.
 *
 * Entry is the *upper* bound of the zone: using the lower bound would make the
 * ratio look better than the plan the user can actually get filled at.
 */
function resolveLevels(candidate) {
  const c = candidate || {};
  const nested = (c.levels && typeof c.levels === 'object') ? c.levels : {};
  const plan = (c.trade_plan_v2 && typeof c.trade_plan_v2 === 'object') ? c.trade_plan_v2 : {};

  return {
    price: readNumber(c.last_price, c.current_price, c.close, c.price, c.last),
    entry: readNumber(
      c.entry_high, c.entry_zone_high, c.buy_high, c.entry1,
      nested.entry_high, plan.entry_high,
      c.entry, c.entry_price, c.entry_low, c.entry2,
      nested.entry_low, plan.entry_low
    ),
    sl: readNumber(c.stop_loss, c.sl, c.stop, c.invalidation, nested.stop_loss, plan.sl),
    tp1: readNumber(c.tp1, c.tp1n, c.target_1, c.target1, nested.tp1, plan.tp1),
    tp2: readNumber(c.tp2, c.tp2n, c.target_2, nested.tp2, plan.tp2),
    volume: readNumber(c.volume, c.volume_today, c.volume_shares, c.total_volume),
    liquidity: readNumber(
      c.liquidity_idr, c.turnover_idr, c.value_idr,
      c.avg_value_traded, c.avg_turnover_idr
    )
  };
}

/**
 * Risk/reward recomputed from the resolved levels. Returns `null` when the plan
 * is not fully known or not structurally coherent — never a guessed ratio.
 */
function recomputeRiskReward(levels) {
  if (!levels) return null;
  const { entry, sl, tp1 } = levels;
  if (entry === null || sl === null || tp1 === null) return null;
  if (!(entry > sl) || !(tp1 > entry) || !(sl > 0)) return null;
  const risk = entry - sl;
  const reward = tp1 - entry;
  if (!(risk > 0) || !(reward > 0)) return null;
  const rr = reward / risk;
  return Number.isFinite(rr) ? rr : null;
}

/** Round to 2 dp for display without changing gate arithmetic. */
function round2(value) {
  const n = numberOrNull(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

/** Epoch millis from an injected clock value, or `null` when unusable. */
function epochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Age in minutes of a `YYYY-MM-DD` (or ISO) trade date relative to `nowMs`.
 *
 * A date-only value is anchored at 00:00 UTC+7 (Asia/Jakarta) — the WIB session
 * boundary the rest of the repository uses (`lib/format-wib.js`). Anchoring at
 * midnight makes the computed age an *upper bound* on freshness, which is the
 * fail-safe direction: it can expire data slightly early, never late.
 */
function stalenessMinutes(tradeDate, nowMs) {
  if (nowMs === null) return null;
  if (typeof tradeDate !== 'string' || tradeDate.trim().length === 0) return null;
  const text = tradeDate.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const parsed = dateOnly ? new Date(text + 'T00:00:00+07:00').getTime() : new Date(text).getTime();
  if (!Number.isFinite(parsed)) return null;
  const delta = nowMs - parsed;
  if (!Number.isFinite(delta)) return null;
  return Math.floor(delta / 60000);
}

/** Candidate volume, accepting a lot/shares pair when only lots are given. */
function volumeCandidates(candidate, levels) {
  const c = candidate || {};
  const out = [];
  if (levels.volume !== null) out.push(levels.volume);
  const lots = readNumber(c.volume_lot, c.lot, c.volume_lots);
  if (lots !== null) out.push(lots * 100);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Verdict ranking — a lower-quality state can never outrank a worse one      */
/* -------------------------------------------------------------------------- */

const STATUS_RANK = Object.freeze({
  READY: 0,
  WATCH: 1,
  WAITING_CONFIRMATION: 2,
  EXPIRED: 3,
  INSUFFICIENT_DATA: 4,
  REJECTED: 5
});

/** Strictest status wins. Ties keep the earlier (more specific) assignment. */
function stricter(current, candidate) {
  if (current === null) return candidate;
  return STATUS_RANK[candidate] > STATUS_RANK[current] ? candidate : current;
}

/* -------------------------------------------------------------------------- */
/* evaluate()                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate one candidate and return its readiness verdict.
 *
 * @param {object} candidate
 * @param {object} [policy]  {minRiskReward, maxStalenessMinutes, minVolume,
 *                            minLiquidityValue, now}
 * @returns {{status:string, reasons:string[], rr:number|null, gateResults:object}}
 */
function evaluate(candidate, policy) {
  const p = normalizePolicy(policy);
  const reasons = [];
  const gateResults = {};

  const push = (code) => {
    if (reasons.indexOf(code) < 0) reasons.push(code);
  };

  /* ---- 0. No-waiver transparency --------------------------------------- */
  const c = candidate && typeof candidate === 'object' ? candidate : null;
  if (!c) {
    gateResults.input = { pass: false, outcome: 'CANDIDATE_NOT_OBJECT' };
    return finalize(STATUS.INSUFFICIENT_DATA, [REASON.TRADE_PLAN_LEVELS_ABSENT], null, gateResults);
  }

  const waiverClaimed = c.waived === true || c.fusion_waived === true ||
    c.waiver === true || c.readiness_waived === true || c.override === true;
  gateResults.waiver = {
    pass: true,
    // A claimed waiver never grants anything; it is recorded and ignored.
    claimed: waiverClaimed,
    outcome: waiverClaimed ? 'IGNORED_NO_WAIVER_PATH' : 'NONE'
  };
  if (waiverClaimed) push(REASON.WAIVER_IGNORED);

  const levels = resolveLevels(c);

  /* ---- 1. OHLCV structural validity (hard reject) ---------------------- */
  const bars = Array.isArray(c.ohlcv) ? c.ohlcv
    : (Array.isArray(c.candles) ? c.candles : (Array.isArray(c.bars) ? c.bars : null));
  if (bars && bars.length > 0) {
    const violations = [];
    for (let i = 0; i < bars.length; i += 1) {
      const res = validateOhlcv(bars[i]);
      if (!res.valid) violations.push({ index: i, errors: res.errors });
      if (violations.length >= 5) break;
    }
    gateResults.ohlcv = {
      pass: violations.length === 0,
      bars: bars.length,
      violations: violations.slice(0, 5)
    };
    if (violations.length > 0) {
      push(REASON.INVALID_OHLCV);
      return finalize(STATUS.REJECTED, reasons, null, gateResults);
    }
  } else {
    gateResults.ohlcv = { pass: true, bars: 0, outcome: 'NO_BARS_SUPPLIED' };
  }

  /* ---- 2. R/R — the absolute veto -------------------------------------- */
  const reportedRr = readNumber(c.rr, c.risk_reward, c.riskReward, c.rr_ratio, c.rrRatio, c.rr_to_tp1);
  const computedRr = recomputeRiskReward(levels);
  const knownRr = [reportedRr, computedRr].filter((v) => v !== null);
  // The more conservative of the two wins: stale metadata must never rescue a
  // plan whose own levels produce a worse ratio.
  const effectiveRr = knownRr.length > 0 ? Math.min.apply(Math, knownRr) : null;

  gateResults.riskReward = {
    pass: false,
    minRiskReward: p.minRiskReward,
    reported: round2(reportedRr),
    recomputedFromLevels: round2(computedRr),
    effective: round2(effectiveRr)
  };

  // Informational: the ratio is unavailable. Emitted here so that a caller can
  // still see it when a stronger rule (veto / structural) decides the verdict.
  if (effectiveRr === null) push(REASON.RR_UNKNOWN);

  // The producer's metadata and the plan's own levels disagree. Recorded BEFORE
  // the veto return so the contradiction is never hidden by the veto.
  if (reportedRr !== null && computedRr !== null &&
      Math.abs(reportedRr - computedRr) > 0.005) {
    push(REASON.RR_CONTRADICTS_REPORTED);
  }

  /* ---- 2a. R/R veto — absolute, outranks every other rule -------------- */
  if (effectiveRr !== null && (effectiveRr + 1e-12) < p.minRiskReward) {
    gateResults.riskReward.outcome = 'BELOW_MINIMUM';
    push(REASON.RR_BELOW_MIN);
    // Returns before any other gate can soften the verdict: rr = 1.39 is
    // REJECTED even when every remaining field is perfect.
    return finalize(STATUS.REJECTED, reasons, effectiveRr, gateResults);
  }

  /* ---- 3. Required numerics must be known ------------------------------ */
  const missing = [];
  if (levels.price === null) missing.push('price');
  if (levels.entry === null) missing.push('entry');
  if (levels.sl === null) missing.push('sl');
  if (levels.tp1 === null) missing.push('tp');

  gateResults.requiredInputs = {
    pass: missing.length === 0,
    missing,
    price: levels.price,
    entry: levels.entry,
    sl: levels.sl,
    tp1: levels.tp1
  };
  if (missing.length > 0) {
    push(REASON.TRADE_PLAN_LEVELS_ABSENT);
    if (missing.indexOf('price') >= 0) push(REASON.PRICE_ABSENT);
    return finalize(STATUS.INSUFFICIENT_DATA, reasons, effectiveRr, gateResults);
  }

  /* ---- 4. Structural sanity of the plan -------------------------------- */
  const structurallyValid = levels.sl > 0 && levels.sl < levels.entry && levels.tp1 > levels.entry;
  gateResults.tradePlanStructure = {
    pass: structurallyValid,
    outcome: structurallyValid ? 'VALID' : 'SL_ENTRY_TP_ORDER_VIOLATED'
  };
  if (!structurallyValid) {
    push(REASON.TRADE_PLAN_STRUCTURALLY_INVALID);
    return finalize(STATUS.REJECTED, reasons, effectiveRr, gateResults);
  }
  if (!(levels.price > 0)) {
    gateResults.price = { pass: false, outcome: 'NOT_POSITIVE', price: levels.price };
    push(REASON.PRICE_NOT_POSITIVE);
    return finalize(STATUS.REJECTED, reasons, effectiveRr, gateResults);
  }
  gateResults.price = { pass: true, price: levels.price };

  /* ---- 4b. With every level known and coherent, the ratio must exist --- */
  if (effectiveRr === null) {
    gateResults.riskReward.outcome = 'RR_UNKNOWN';
    return finalize(STATUS.INSUFFICIENT_DATA, reasons, null, gateResults);
  }

  gateResults.riskReward.pass = true;
  gateResults.riskReward.outcome = 'PASS';

  /* ---- 5. Freshness / data status -------------------------------------- */
  const rawStatus = readUpperText(c.data_status, c.provenance && c.provenance.status);
  const nowMs = epochMs(p.now);
  const age = stalenessMinutes(c.trade_date || c.date || c.market_date, nowMs);
  const declaredStale = c.stale === true || c.is_stale === true;

  let statusFloor = STATUS.READY;
  const freshness = {
    pass: true,
    dataStatus: rawStatus,
    ageMinutes: age,
    maxStalenessMinutes: p.maxStalenessMinutes,
    declaredStale
  };

  if (rawStatus === null) {
    freshness.outcome = 'STATUS_UNKNOWN_TREATED_AS_NOT_AVAILABLE';
    freshness.pass = false;
    push(REASON.DATA_NOT_AVAILABLE);
    statusFloor = stricter(statusFloor, STATUS.WAITING_CONFIRMATION);
  } else if (rawStatus === DATA_STATUS.AVAILABLE) {
    freshness.outcome = 'AVAILABLE';
  } else if (rawStatus === DATA_STATUS.STALE) {
    freshness.pass = false;
    if (age !== null && age > p.maxStalenessMinutes) {
      freshness.outcome = 'EXPIRED';
      push(REASON.DATA_EXPIRED);
      statusFloor = stricter(statusFloor, STATUS.EXPIRED);
    } else if (age !== null) {
      freshness.outcome = 'STALE_WITHIN_TOLERANCE';
      push(REASON.DATA_STALE_WITHIN_TOLERANCE);
      statusFloor = stricter(statusFloor, STATUS.WAITING_CONFIRMATION);
    } else {
      freshness.outcome = 'STALE_AGE_UNKNOWN';
      push(REASON.DATA_STALE_AGE_UNKNOWN);
      statusFloor = stricter(statusFloor, STATUS.WAITING_CONFIRMATION);
    }
  } else if (rawStatus === DATA_STATUS.PARTIAL) {
    freshness.pass = false;
    freshness.outcome = 'PARTIAL';
    push(REASON.DATA_PARTIAL);
    statusFloor = stricter(statusFloor, STATUS.WAITING_CONFIRMATION);
  } else {
    // NOT_PUBLISHED / SOURCE_UNAVAILABLE / VALIDATION_FAILED / QUARANTINED
    freshness.pass = false;
    freshness.outcome = rawStatus;
    push(REASON.DATA_NOT_AVAILABLE);
    statusFloor = stricter(statusFloor, STATUS.INSUFFICIENT_DATA);
  }

  // A positive AVAILABLE flag does not overrule an expired trade_date.
  // This is assessed only when the caller supplies an explicit clock; the
  // engine itself stays pure and deterministic without reading Date.now().
  if (rawStatus === DATA_STATUS.AVAILABLE &&
      age !== null && age > p.maxStalenessMinutes) {
    freshness.pass = false;
    freshness.outcome = 'EXPIRED';
    push(REASON.DATA_EXPIRED);
    statusFloor = stricter(statusFloor, STATUS.EXPIRED);
  }

  // A row the producer itself marked stale is stale even if `data_status` says
  // otherwise: the caller's own freshness claim is evidence.
  if (declaredStale && statusFloor === STATUS.READY) {
    if (age !== null && age > p.maxStalenessMinutes) {
      freshness.outcome = 'EXPIRED';
      push(REASON.DATA_EXPIRED);
      statusFloor = stricter(statusFloor, STATUS.EXPIRED);
    } else {
      freshness.outcome = 'STALE_WITHIN_TOLERANCE';
      push(REASON.DATA_STALE_WITHIN_TOLERANCE);
      statusFloor = stricter(statusFloor, STATUS.WAITING_CONFIRMATION);
    }
  }
  gateResults.freshness = freshness;

  /* ---- 6. Volume / liquidity — quality, not blocking ------------------- */
  const volumes = volumeCandidates(c, levels);
  const knownVolumes = volumes.filter((v) => v !== null);
  const volumeState = {
    pass: true,
    values: knownVolumes,
    minVolume: p.minVolume,
    liquidity: levels.liquidity,
    minLiquidityValue: p.minLiquidityValue
  };

  if (knownVolumes.length === 0) {
    volumeState.pass = false;
    volumeState.outcome = 'VOLUME_UNKNOWN';
    push(REASON.VOLUME_UNKNOWN);
    statusFloor = stricter(statusFloor, STATUS.WATCH);
  } else {
    const maxVolume = Math.max.apply(Math, knownVolumes);
    if (!(maxVolume >= p.minVolume)) {
      volumeState.pass = false;
      volumeState.outcome = maxVolume <= 0 ? 'VOLUME_ZERO' : 'VOLUME_BELOW_MIN';
      push(maxVolume <= 0 ? REASON.VOLUME_ZERO : REASON.VOLUME_UNKNOWN);
      statusFloor = stricter(statusFloor, STATUS.WATCH);
    } else if (levels.liquidity === null && p.minLiquidityValue > 0) {
      volumeState.pass = false;
      volumeState.outcome = 'LIQUIDITY_UNKNOWN';
      push(REASON.LIQUIDITY_UNKNOWN);
      statusFloor = stricter(statusFloor, STATUS.WATCH);
    } else if (levels.liquidity !== null && levels.liquidity < p.minLiquidityValue) {
      volumeState.pass = false;
      volumeState.outcome = 'LIQUIDITY_BELOW_MIN';
      push(REASON.LIQUIDITY_BELOW_MIN);
      statusFloor = stricter(statusFloor, STATUS.WATCH);
    } else {
      volumeState.outcome = 'PASS';
    }
  }
  gateResults.volume = volumeState;

  /* ---- 7. Source advice — caution, not blocking ------------------------ */
  const sourceStatus = readUpperText(c.source_status, c.source_setup);
  const advisedAgainst = sourceStatus !== null &&
    /AVOID|WAIT|HINDARI|NO_?TRADE|REJECT|EXPIRED/.test(sourceStatus);
  gateResults.sourceAdvice = {
    pass: !advisedAgainst,
    sourceStatus,
    outcome: advisedAgainst ? 'SOURCE_ADVISES_CAUTION' : 'NEUTRAL_OR_POSITIVE'
  };
  if (advisedAgainst) {
    push(REASON.SOURCE_ADVISES_CAUTION);
    statusFloor = stricter(statusFloor, STATUS.WATCH);
  }

  /* ---- 8. Verdict ------------------------------------------------------ */
  if (statusFloor === STATUS.READY) push(REASON.ALL_GATES_PASSED);

  return finalize(statusFloor, reasons, effectiveRr, gateResults);
}

/** Assemble the frozen result. `rr` is always the effective, rounded ratio. */
function finalize(status, reasons, rr, gateResults) {
  if (STATUS_VALUES.indexOf(status) < 0) {
    // Defensive: an unknown status is never allowed to look actionable.
    status = STATUS.INSUFFICIENT_DATA;
    if (reasons.indexOf('INTERNAL_UNKNOWN_STATUS') < 0) reasons.push('INTERNAL_UNKNOWN_STATUS');
  }
  return Object.freeze({
    status,
    reasons: Object.freeze(reasons.slice()),
    rr: round2(rr),
    gateResults: Object.freeze(Object.assign({}, gateResults))
  });
}

/* -------------------------------------------------------------------------- */
/* Presentation helpers — display only, never a decision                       */
/* -------------------------------------------------------------------------- */

/**
 * The single action token a verdict may produce. `READY` is the ONLY status
 * that yields an actionable token; everything else is `null`, so no downstream
 * renderer can fabricate a BUY from a non-ready state.
 */
function actionForStatus(status) {
  return status === STATUS.READY ? 'BUY' : null;
}

/** Short Indonesian label for the UI. Never used by the engine's decision. */
function labelForStatus(status) {
  switch (status) {
    case STATUS.READY: return 'Siap Entry';
    case STATUS.WATCH: return 'Pantau';
    case STATUS.WAITING_CONFIRMATION: return 'Menunggu Konfirmasi';
    case STATUS.INSUFFICIENT_DATA: return 'Data Tidak Cukup';
    case STATUS.EXPIRED: return 'Kedaluwarsa';
    case STATUS.REJECTED: return 'Ditolak';
    default: return 'Tidak Diketahui';
  }
}

/** True only for the actionable state. Convenience for callers and tests. */
function isReady(result) {
  return Boolean(result && result.status === STATUS.READY);
}

/**
 * Backward-compatible projection of a verdict onto the legacy row fields.
 *
 * Returns exactly the fields the old producers stamped by hand, all derived
 * from the engine result. `setup` is deliberately NOT the upstream free-text
 * status: copying `"Swing Ready"` there made a downstream reader treat a mere
 * source label as a verdict (`test/v5/harness.js#isReadyRow` reads `setup`).
 */
function projectOntoRow(row, result) {
  const target = row && typeof row === 'object' ? row : {};
  const status = result.status;
  const ready = status === STATUS.READY;

  target.status = status;
  target.readiness_status = status;
  target.action = actionForStatus(status);
  target.action_label = target.action;
  target.status_label = labelForStatus(status);
  target.verdict_reason = result.reasons.length > 0 ? result.reasons[0] : null;
  target.verdict_reasons = result.reasons.slice();
  target.rr_gate_passed = Boolean(
    result.gateResults && result.gateResults.riskReward && result.gateResults.riskReward.pass
  );
  // Honest, derived booleans: `true` only when the engine actually said READY.
  target.trading_plan_valid = ready;
  target.safe = ready;
  target.quality_grade = null;
  target.grade = null;
  target.timeline = ready ? 'Siap Entry' : labelForStatus(status);
  target.timing = ready ? 'Area Beli' : null;
  target.arah = ready ? 'Akumulasi' : null;
  return target;
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  STATUS,
  STATUS_VALUES,
  REASON,
  DEFAULT_POLICY,

  evaluate,
  actionForStatus,
  labelForStatus,
  isReady,
  projectOntoRow,

  // Exported for unit tests and for callers that need the same pure helpers.
  recomputeRiskReward,
  resolveLevels,
  stalenessMinutes
};