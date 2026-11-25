'use strict';

/**
 * lib/saham-potensial-engine.js
 * ============================================================================
 * Saham Potensial Engine — Short Swing 2–5 Hari Bursa (Auto-Cuan V6, canonical)
 * ============================================================================
 *
 * FAIL-CLOSED CONTRACT (Subtask F + Subtask H remediation):
 * 1. Freshness gate: a candidate carries an as-of date. If that date differs
 *    from `session_date`, the row is NOT_READY (never READY). A missing as-of
 *    date demotes the best possible readiness to WATCHLIST (never READY).
 * 1b. COMPONENT-LEVEL freshness gate (Subtask H / P0-08): the price as-of is
 *    NOT the only clock. `bandar_asof` / `foreign_asof` / `technical_asof` /
 *    `volume_asof` are each compared against `session_date`. A STALE mandatory
 *    component (price, bandar, foreign) forces NOT_READY even when the price
 *    as-of is fresh. A STALE or UNKNOWN as-of on any component caps the row at
 *    WATCHLIST. Before this gate a row with price as-of 9 Nov but broker and
 *    foreign as-of 14 Oct was published READY.
 * 2. Zero is a real number, null is unknown. `0` is never coerced to `50`,
 *    `null` is never coerced to `1`. There is NO fake default.
 * 3. R/R is computed at `max_entry` with `rr = (tp1 - max_entry) / (max_entry - sl)`.
 *    `is_actionable === true` requires `rr >= MIN_RR_THRESHOLD (1.5)`.
 * 4. Mandatory inputs (broker accumulation AND foreign flow) unavailable
 *    => BLOCKED, not READY. Technical or relative-volume unavailable => DEGRADED.
 * 5. Every scoring component carries source / as_of / freshness / eligibility /
 *    quality_gate / threshold / weight / penalty / reason / algo_version.
 * 6. Snapshot is immutable and deterministic: one session_date, one score
 *    version, one snapshot_id. The id is a CANONICAL NORMALIZED CONTENT HASH
 *    (Subtask H / P0-10) over session_date + score_version + horizon +
 *    universe + every row's score/components/levels/R-R/risk_flags/reasons/
 *    input_checksum + the published ranking. Any change to a score, an R/R, a
 *    risk flag or a reason produces a NEW snapshot_id. The previous
 *    implementation hashed only session_date + the ticker set, so two
 *    materially different snapshots shared one id.
 *    Top20 is capped at 20 WITHOUT padding; Top5 is a pure subset of Top20.
 * ============================================================================
 */

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const idxTick = require('./idx-tick.js');

const MIN_RR_THRESHOLD = 1.5;
const HOLDING_HORIZON_LABEL = 'Short Swing (2–5 Hari)';
const HOLDING_HORIZON_MIN_DAYS = 2;
const HOLDING_HORIZON_MAX_DAYS = 5;
// v1.1.0 — Subtask H: component-level freshness gate (P0-08) and canonical
// normalized content-hash snapshot_id (P0-10) both change emitted verdicts and
// ids, so the algorithm version is bumped rather than silently reusing v1.0.0.
const SCORE_ALGORITHM_VERSION = 'short-swing/canonical/v1.1.0';
/** Version of the canonical content-hash normalization itself. */
const CONTENT_HASH_VERSION = 'snapshot-content-hash/v1';
/** Components whose freshness is REQUIRED for any actionable verdict. */
const MANDATORY_FRESHNESS_COMPONENTS = Object.freeze(['price', 'bandar', 'foreign']);
/** Components whose staleness caps (but does not block) the verdict. */
const OPTIONAL_FRESHNESS_COMPONENTS = Object.freeze(['technical', 'volume']);
const GAP_HANDLING_POLICY = 'NO_LOOKAHEAD: entry triggered only when candle low touches entry zone (low <= max_entry), fill recorded at market price of that session';

// Readiness axis (ordered by how confidently the row may be published).
const READINESS = Object.freeze({
  READY: 'READY',
  WAITING_ENTRY: 'WAITING_ENTRY',
  WATCHLIST: 'WATCHLIST',
  DEGRADED: 'DEGRADED',
  BLOCKED: 'BLOCKED',
  NOT_READY: 'NOT_READY'
});

// Load emiten dictionary fallback if available
let TICKER_MAP = null;
function getTickerMap() {
  if (TICKER_MAP) return TICKER_MAP;
  TICKER_MAP = {};
  try {
    const p = path.resolve(__dirname, '..', 'public', 'assets', 'idx-tickers.js');
    if (fs.existsSync(p)) {
      const code = fs.readFileSync(p, 'utf8');
      const jsonStr = code.replace(/^window\.IDX_TICKERS\s*=\s*/, '').replace(/;\s*$/, '');
      TICKER_MAP = JSON.parse(jsonStr);
    }
  } catch (_) {
    TICKER_MAP = {};
  }
  return TICKER_MAP;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** First finite number among keys (preserves explicit 0). Returns null if none. */
function pickNumber(candidate, ...keys) {
  if (!candidate || typeof candidate !== 'object') return null;
  for (const k of keys) {
    const v = num(candidate[k]);
    if (v !== null) return v;
  }
  return null;
}

/** First non-empty text among keys. Returns null if none. */
function pickText(candidate, ...keys) {
  if (!candidate || typeof candidate !== 'object') return null;
  for (const k of keys) {
    const v = candidate[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDateYmd(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    // Accept ISO timestamps and plain YYYY-MM-DD.
    const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : String(value).trim().slice(0, 10);
  }
  return null;
}

/** WIB date string for "today" (used only as last-resort fallback). */
function wibToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

/**
 * Hitung Risk/Reward konservatif berdasarkan entry_high (max_entry).
 *
 * @param {number} maxEntry
 * @param {number} sl
 * @param {number} tp1
 * @returns {number|null}
 */
function calculateConservativeRiskReward(maxEntry, sl, tp1) {
  const e = num(maxEntry);
  const s = num(sl);
  const t = num(tp1);
  if (e == null || s == null || t == null) return null;
  if (e <= s || t <= e || s <= 0) return null;
  const risk = e - s;
  const reward = t - e;
  if (risk <= 0 || reward <= 0) return null;
  const rr = reward / risk;
  return Number.isFinite(rr) ? Number(rr.toFixed(4)) : null;
}

/**
 * Resolve one scoring component WITHOUT fabricating a default.
 *
 * Explicit `0` is preserved as a real number. `null`/undefined => `null`
 * (UNKNOWN). The returned descriptor carries the audit contract fields.
 *
 * @param {object} candidate
 * @param {object} cfg { name, valueKeys, sourceKeys, asOfKeys, threshold, weight, format }
 * @param {string} sessionDate
 */
function resolveComponent(candidate, cfg, sessionDate) {
  let value = null;
  let source = null;
  for (const k of cfg.valueKeys) {
    const v = num(candidate[k]);
    if (v !== null) {
      value = v;
      source = k;
      break;
    }
  }
  const as_of = normalizeDateYmd(pickText(candidate, ...cfg.asOfKeys)) || null;

  let status = 'UNKNOWN';
  let eligibility = false;
  let qualityGate = 'UNKNOWN';
  let reason = cfg.name + ' data tidak tersedia (null/unknown)';
  if (value !== null) {
    eligibility = true;
    status = value === 0 ? 'ZERO' : 'OK';
    qualityGate = 'PASS';
    reason = value === 0 ? cfg.name + ' bernilai 0 (angka nyata, bukan null)' : cfg.name + ' tersedia';
  }

  const freshness = as_of
    ? (as_of === sessionDate ? 'FRESH' : 'STALE')
    : 'UNKNOWN';

  const penalty = eligibility && value < cfg.threshold
    ? Number(((cfg.threshold - value) * cfg.weight).toFixed(2))
    : 0;

  return {
    value,
    status,
    source,
    as_of,
    freshness,
    eligibility,
    quality_gate: qualityGate,
    threshold: cfg.threshold,
    weight: cfg.weight,
    penalty,
    reason,
    algo_version: SCORE_ALGORITHM_VERSION
  };
}

/**
 * Determine structured freshness for a candidate against a session date.
 *
 * Fresh unless the candidate explicitly carries a DIFFERENT as-of date
 * (=> STALE / NOT_READY). Missing date => UNKNOWN (demotes best readiness).
 */
function resolveFreshness(candidate, sessionDate) {
  const asOf = normalizeDateYmd(
    pickText(candidate, 'as_of', 'price_asof', 'session_date', 'date', 'trade_date', 'market_date', 'run_date')
  );
  if (!asOf) {
    return {
      status: 'UNKNOWN',
      as_of: null,
      reason: 'MISSING_AS_OF_DATE'
    };
  }
  if (asOf === sessionDate) {
    return { status: 'FRESH', as_of: asOf, reason: null };
  }
  return {
    status: 'STALE',
    as_of: asOf,
    reason: 'AS_OF_STALE: kandidat bertanggal ' + asOf + ' tidak sama dengan session_date ' + sessionDate
  };
}

/**
 * Detect a ticker identity mismatch (plan ticker vs data/source ticker).
 * Fail-closed: any authoritative source ticker conflicting with the plan
 * ticker marks the row BLOCKED.
 */
function resolveTickerMismatch(candidate, ticker) {
  const conflicts = [];
  for (const k of ['symbol', 'data_ticker', 'source_ticker', 'plan_ticker', 'market_ticker']) {
    const v = pickText(candidate, k);
    if (v && String(v).toUpperCase() !== ticker) {
      conflicts.push({ field: k, value: String(v).toUpperCase(), expected: ticker });
    }
  }
  return conflicts.length ? conflicts : null;
}

/**
 * Subtask H / P0-08 — per-component freshness ledger.
 *
 * The price as-of is only ONE clock. A candidate whose price is fresh for
 * `sessionDate` but whose broker accumulation (`bandar_asof`) or foreign flow
 * (`foreign_asof`) is weeks old was still published READY by the previous
 * implementation, because readiness only inspected the top-level as-of.
 *
 * This resolver builds an explicit ledger for every scoring component and
 * classifies each as FRESH / STALE / UNKNOWN against `sessionDate`. A component
 * that carries NO as-of date but DOES carry a value is UNKNOWN (the value
 * exists, its clock does not) — never silently treated as fresh.
 *
 * @param {object} candidate
 * @param {string} sessionDate
 * @param {object} components resolved bandar/foreign/technical/volume descriptors
 * @returns {{
 *   components: object,
 *   staleMandatory: string[],
 *   staleOptional: string[],
 *   unknownMandatory: string[],
 *   unknownOptional: string[],
 *   allFresh: boolean
 * }}
 */
function resolveComponentFreshness(candidate, sessionDate, components) {
  const priceAsOf = normalizeDateYmd(
    pickText(candidate, 'price_asof', 'price_date', 'as_of', 'session_date', 'date',
      'trade_date', 'market_date', 'run_date')
  );

  const ledger = {
    price: {
      as_of: priceAsOf,
      status: !priceAsOf ? 'UNKNOWN' : (priceAsOf === sessionDate ? 'FRESH' : 'STALE')
    },
    bandar: { as_of: components.bandar.as_of, status: components.bandar.freshness },
    foreign: { as_of: components.foreign.as_of, status: components.foreign.freshness },
    technical: { as_of: components.technical.as_of, status: components.technical.freshness },
    volume: { as_of: components.volume_ratio.as_of, status: components.volume_ratio.freshness }
  };

  const staleMandatory = [];
  const staleOptional = [];
  const unknownMandatory = [];
  const unknownOptional = [];

  for (const name of MANDATORY_FRESHNESS_COMPONENTS) {
    const entry = ledger[name];
    if (entry.status === 'STALE') staleMandatory.push(name);
    else if (entry.status === 'UNKNOWN') unknownMandatory.push(name);
  }
  for (const name of OPTIONAL_FRESHNESS_COMPONENTS) {
    const entry = ledger[name];
    if (entry.status === 'STALE') staleOptional.push(name);
    else if (entry.status === 'UNKNOWN') unknownOptional.push(name);
  }

  const allFresh = staleMandatory.length === 0 && staleOptional.length === 0 &&
    unknownMandatory.length === 0 && unknownOptional.length === 0;

  return {
    components: ledger,
    staleMandatory,
    staleOptional,
    unknownMandatory,
    unknownOptional,
    allFresh
  };
}

/**
 * Evaluasi satu kandidat saham untuk Short Swing 2–5 Hari (fail-closed).
 *
 * @param {object} candidate
 * @param {object} [options]
 * @returns {object|null}
 */
function evaluateShortSwingCandidate(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object') return null;

  const ticker = String(pickText(candidate, 'ticker', 'symbol') || '').trim().toUpperCase();
  if (!ticker) return null;

  const tickerMap = getTickerMap();
  const emiten = pickText(candidate, 'emiten', 'name', 'company_name', 'stock_name') || tickerMap[ticker] || (ticker + ' Tbk.');

  const lastPrice = pickNumber(candidate, 'last_price', 'close', 'price', 'current_price');
  if (lastPrice == null || lastPrice < 0) return null;

  // Levels — structural plan. TASK 5: every published level is snapped onto
  // the official IDX tick fraction BEFORE any R/R gate is evaluated. A raw
  // off-fraction input can never leak into a snapshot row.
  const rawEntryLow = pickNumber(candidate, 'entry_low', 'entry2', 'buy_low');
  const rawEntryHigh = pickNumber(candidate, 'entry_high', 'entry1', 'entry', 'buy_high');
  let effEntryLow = idxTick.roundToIdxTick(rawEntryLow != null ? rawEntryLow : lastPrice);
  let effEntryHigh = idxTick.roundToIdxTick(rawEntryHigh != null ? rawEntryHigh : lastPrice);
  if (effEntryLow == null || effEntryHigh == null) return null;
  if (effEntryLow > effEntryHigh) {
    const swap = effEntryLow; effEntryLow = effEntryHigh; effEntryHigh = swap;
  }
  const maxEntry = Math.max(effEntryLow, effEntryHigh);

  const rawSl = pickNumber(candidate, 'sl', 'stop_loss');
  const rawTp1 = pickNumber(candidate, 'tp1', 'tp');
  const rawTp2 = pickNumber(candidate, 'tp2');

  // Structural rejection: cannot build a plan without SL/TP1.
  if (rawSl == null || rawTp1 == null) return null;

  let sl = idxTick.roundToIdxTick(rawSl);
  let tp1 = idxTick.roundToIdxTick(rawTp1);
  let tp2 = rawTp2 != null
    ? idxTick.roundToIdxTick(rawTp2)
    : idxTick.roundToIdxTick(rawTp1 * 1.05);
  if (sl == null || tp1 == null) return null;

  // Enforce structural ordering on the tick grid. Rounding can collapse two
  // levels onto the same tick; move them by the minimum legal tick instead of
  // publishing an invalid plan or silently widening risk.
  if (!(sl > 0 && sl < maxEntry)) sl = idxTick.tickBelow(maxEntry);
  if (!(tp1 > maxEntry)) tp1 = idxTick.tickAbove(maxEntry);
  if (tp2 == null || !(tp2 > tp1)) tp2 = idxTick.tickAbove(tp1);
  if (!(maxEntry > sl && sl > 0 && tp1 > maxEntry)) return null;

  // TASK 5: R/R is derived from the ROUNDED levels, never from a stale
  // metadata field. Revalidate the >= 1.5 gate on this recomputed value.
  const rr = idxTick.rrFromLevels(maxEntry, sl, tp1);
  if (rr == null) return null;

  const minRr = num(options.minRiskReward) != null ? num(options.minRiskReward) : MIN_RR_THRESHOLD;
  const isRrActionable = (rr + 1e-6) >= minRr;

  // Maximum stop loss constraint (configurable via options.maxStopLossPct or candidate.max_sl_pct, e.g. <= 6.0% or ATR/support)
  const maxSlPct = num(options.maxStopLossPct) != null
    ? num(options.maxStopLossPct)
    : (candidate.max_sl_pct != null ? num(candidate.max_sl_pct) : null);
  const stopLossPct = ((maxEntry - sl) / maxEntry) * 100;
  const isSlAcceptable = maxSlPct != null ? ((stopLossPct - 1e-6) <= maxSlPct) : true;

  // Anti-stale plan: price deviation > 25% from entry plan marks plan stale/invalid
  const priceDeviation = lastPrice > 0 && maxEntry > 0 ? Math.abs(lastPrice - maxEntry) / maxEntry : 0;
  const isPriceDeviationStale = priceDeviation > 0.25;

  const sessionDate = normalizeDateYmd(options.sessionDate) || normalizeDateYmd(candidate.session_date) || wibToday();

  // Tick integrity (blocked before anything else).
  const tickerConflicts = resolveTickerMismatch(candidate, ticker);

  // Freshness gate.
  const freshness = resolveFreshness(candidate, sessionDate);

  // Four scoring components. Mandatory: bandar (broker) + foreign flow.
  const bandar = resolveComponent(candidate, {
    name: 'bandar_score',
    valueKeys: ['bandar_score', 'broksum_score', 'broker_score', 'broker_net_score'],
    sourceKeys: ['bandar_source', 'broker_source'],
    asOfKeys: ['bandar_asof', 'broksum_date', 'broker_date', 'broker_asof'],
    threshold: 50,
    weight: 0.30
  }, sessionDate);

  const foreign = resolveComponent(candidate, {
    name: 'foreign_flow_score',
    valueKeys: ['foreign_flow_score', 'foreign_score', 'foreign_flow', 'foreign_net_score'],
    sourceKeys: ['foreign_source'],
    asOfKeys: ['foreign_asof', 'foreign_date', 'foreign_flow_date'],
    threshold: 50,
    weight: 0.25
  }, sessionDate);

  const technical = resolveComponent(candidate, {
    name: 'technical_score',
    valueKeys: ['technical_score', 'score', 'conviction_score'],
    sourceKeys: ['technical_source'],
    asOfKeys: ['technical_asof', 'technical_date', 'price_asof'],
    threshold: 50,
    weight: 0.25
  }, sessionDate);

  const volumeRatio = pickNumber(candidate, 'volume_ratio_20d', 'volume_ratio', 'effective_volume_ratio');
  const volume = resolveComponent(candidate, {
    name: 'volume_ratio',
    valueKeys: ['volume_ratio_20d', 'volume_ratio', 'effective_volume_ratio'],
    sourceKeys: ['volume_source'],
    asOfKeys: ['volume_asof', 'volume_date', 'price_asof'],
    threshold: 1.0,
    weight: 0.20
  }, sessionDate);
  // Volume's score contribution is a relative-surge bonus (0..25), distinct
  // from the raw ratio held in `volume.value`.
  const volumeBonus = volumeRatio !== null
    ? Number(clamp((volumeRatio - 1.0) * 15, 0, 25).toFixed(1))
    : null;

  const changePct = pickNumber(candidate, 'change_pct', 'changePercent');

  const horizonLabel = pickText(options, 'holdingLabel', 'holding_label') ||
    pickText(candidate, 'holding_label', 'holding_horizon') ||
    HOLDING_HORIZON_LABEL;
  const holdingDaysMin = num(options.holdingDaysMin != null ? options.holdingDaysMin : candidate.holding_days_min) || HOLDING_HORIZON_MIN_DAYS;
  const holdingDaysMax = num(options.holdingDaysMax != null ? options.holdingDaysMax : candidate.holding_days_max) || HOLDING_HORIZON_MAX_DAYS;

  // Fused score is only honest when ALL four components are present.
  let fusedScore = null;
  if (bandar.value !== null && foreign.value !== null && technical.value !== null && volumeRatio !== null) {
    const customW = options && options.weights && typeof options.weights === 'object' ? options.weights : null;
    if (customW && (num(customW.bandar) != null || num(customW.technical) != null)) {
      const wb = Math.max(0, num(customW.bandar) || 0);
      const wf = Math.max(0, num(customW.foreign) || 0);
      const wt = Math.max(0, num(customW.technical) || 0);
      const wv = Math.max(0, num(customW.volume) || 0);
      const wSum = Math.max(1, wb + wf + wt + wv);
      const volScaled100 = clamp(volumeRatio * 25, 0, 100);
      const raw = ((bandar.value * wb) + (foreign.value * wf) + (technical.value * wt) + (volScaled100 * wv)) / wSum;
      fusedScore = Number(Math.min(100, Math.max(0, raw)).toFixed(1));
    } else {
      const raw = (bandar.value * 0.30) + (foreign.value * 0.25) + (technical.value * 0.25) + (volumeBonus || 0);
      fusedScore = Number(Math.min(100, Math.max(0, raw)).toFixed(1));
    }
  }

  // Subtask H / P0-08 — component-level freshness ledger (price is not the
  // only clock: bandar_asof / foreign_asof are graded too).
  const componentFreshness = resolveComponentFreshness(candidate, sessionDate, {
    bandar,
    foreign,
    technical,
    volume_ratio: volume
  });

  // Risk flags.
  const riskFlags = [];
  if (volumeRatio !== null && volumeRatio < 1.0) riskFlags.push('LOW_RELATIVE_VOLUME');
  if (changePct !== null && changePct > 15.0) riskFlags.push('HIGH_CHASE_RISK');
  if (changePct !== null && changePct < -3.0) riskFlags.push('STRONG_SELLING_PRESSURE');
  if (rr + 1e-6 < minRr) riskFlags.push('RR_BELOW_MINIMUM_' + rr.toFixed(2) + '_VS_' + minRr);
  if (!isSlAcceptable) riskFlags.push('SL_EXCEEDS_MAX_' + stopLossPct.toFixed(1) + '%_VS_' + maxSlPct + '%');
  if (isPriceDeviationStale) {
    riskFlags.push('STALE_PLAN_DEVIATION_' + (priceDeviation * 100).toFixed(1) + '%');
    riskFlags.push('STALE_PLAN_REJECTED');
  }
  if (candidate.near_ara) riskFlags.push('NEAR_ARA');
  if (candidate.in_fca) riskFlags.push('FCA_WATCH');
  if (freshness.status === 'STALE') riskFlags.push('STALE_AS_OF');
  if (freshness.status === 'UNKNOWN') riskFlags.push('UNKNOWN_AS_OF');
  if (tickerConflicts) riskFlags.push('TICKER_MISMATCH');
  if (bandar.value === null) riskFlags.push('BROKER_DATA_UNAVAILABLE');
  if (foreign.value === null) riskFlags.push('FOREIGN_DATA_UNAVAILABLE');
  if (technical.value === null) riskFlags.push('TECHNICAL_DATA_UNAVAILABLE');
  if (volumeRatio === null) riskFlags.push('VOLUME_DATA_UNAVAILABLE');
  for (const name of componentFreshness.staleMandatory) {
    riskFlags.push('STALE_COMPONENT_' + name.toUpperCase() + '_' + componentFreshness.components[name].as_of);
  }
  for (const name of componentFreshness.staleOptional) {
    riskFlags.push('STALE_COMPONENT_' + name.toUpperCase() + '_' + componentFreshness.components[name].as_of);
  }
  for (const name of componentFreshness.unknownMandatory) {
    riskFlags.push('UNKNOWN_ASOF_COMPONENT_' + name.toUpperCase());
  }
  for (const name of componentFreshness.unknownOptional) {
    riskFlags.push('UNKNOWN_ASOF_COMPONENT_' + name.toUpperCase());
  }

  // Readiness decision (fail-closed precedence).
  let readiness;
  let statusReason;
  let blockedReason = null;

  if (tickerConflicts) {
    readiness = READINESS.BLOCKED;
    blockedReason = 'TICKER_MISMATCH';
    statusReason = 'Plan ticker ' + ticker + ' tidak cocok dengan sumber data (' +
      tickerConflicts.map((c) => c.field + '=' + c.value).join(', ') + ')';
  } else if (freshness.status === 'STALE') {
    readiness = READINESS.NOT_READY;
    statusReason = freshness.reason;
  } else if (isPriceDeviationStale) {
    readiness = READINESS.NOT_READY;
    statusReason = 'STALE_PLAN: Deviasi harga pasar (' + lastPrice + ') vs entry (' + maxEntry + ') mencapai ' +
      (priceDeviation * 100).toFixed(1) + '% (> 25%). Plan ditandai usang/invalid.';
  } else if (bandar.value === null || foreign.value === null) {
    readiness = READINESS.BLOCKED;
    blockedReason = 'MANDATORY_BROKER_FOREIGN_UNAVAILABLE';
    statusReason = 'Data wajib (broker akumulasi / foreign flow) tidak tersedia — dilarang READY';
  } else if (componentFreshness.staleMandatory.length > 0) {
    // P0-08: price fresh but a MANDATORY component (price/bandar/foreign)
    // carries an older as-of than session_date => the plan is built on mixed
    // clocks. Never READY/WAITING_ENTRY; NOT_READY until every clock agrees.
    readiness = READINESS.NOT_READY;
    statusReason = 'STALE_MANDATORY_COMPONENT: ' + componentFreshness.staleMandatory
      .map((name) => name + '_asof=' + componentFreshness.components[name].as_of)
      .join(', ') + ' vs session_date=' + sessionDate;
  } else if (technical.value === null || volumeRatio === null) {
    readiness = READINESS.DEGRADED;
    statusReason = 'Technical/relative-volume tidak tersedia — hanya bisa DEGRADED, bukan READY';
  } else if (!isSlAcceptable) {
    readiness = READINESS.WATCHLIST;
    statusReason = 'Stop loss (' + stopLossPct.toFixed(1) + '%) pada max_entry (' + maxEntry + ') di atas batas maksimal ' + maxSlPct + '%';
  } else if (!isRrActionable) {
    readiness = READINESS.WATCHLIST;
    statusReason = 'R/R (' + rr.toFixed(2) + ') pada max_entry (' + maxEntry + ') di bawah ambang batas minimal ' + minRr;
  } else if (lastPrice < effEntryLow) {
    readiness = READINESS.WAITING_ENTRY;
    statusReason = 'Harga masih di bawah area entry';
  } else if (lastPrice >= effEntryLow && lastPrice <= maxEntry) {
    readiness = READINESS.READY;
    statusReason = 'Harga berada di dalam area beli optimal';
  } else {
    readiness = READINESS.WATCHLIST;
    statusReason = 'Harga telah melebihi batas entry maksimum (chase risk)';
  }

  // Freshness-unknown cannot be READY (fail-closed, no lookahead). This covers
  // BOTH the top-level as-of and every component clock: a value with no as-of
  // is unproven, so the best honest verdict is WATCHLIST.
  const hasUnknownClock = freshness.status === 'UNKNOWN' ||
    componentFreshness.unknownMandatory.length > 0 ||
    componentFreshness.unknownOptional.length > 0;
  if (hasUnknownClock && (readiness === READINESS.READY || readiness === READINESS.WAITING_ENTRY)) {
    readiness = READINESS.WATCHLIST;
    const unknownParts = [];
    if (freshness.status === 'UNKNOWN') unknownParts.push('as_of');
    for (const name of componentFreshness.unknownMandatory) unknownParts.push(name + '_asof');
    for (const name of componentFreshness.unknownOptional) unknownParts.push(name + '_asof');
    statusReason = 'FRESHNESS_UNKNOWN: komponen tanpa as-of date (' + unknownParts.join(', ') +
      ') tidak boleh dipromosikan READY';
    riskFlags.push('FRESHNESS_UNKNOWN_DEMOTION');
  }

  // A stale OPTIONAL component (technical/volume) caps the verdict at
  // WATCHLIST — the mandatory clocks agree, but the confirmation data does not.
  if (componentFreshness.staleOptional.length > 0 &&
      (readiness === READINESS.READY || readiness === READINESS.WAITING_ENTRY)) {
    readiness = READINESS.WATCHLIST;
    statusReason = 'STALE_OPTIONAL_COMPONENT: ' + componentFreshness.staleOptional
      .map((name) => name + '_asof=' + componentFreshness.components[name].as_of)
      .join(', ') + ' vs session_date=' + sessionDate;
    riskFlags.push('STALE_OPTIONAL_DEMOTION');
  }

  const isActionable = readiness === READINESS.READY && isSlAcceptable && !isPriceDeviationStale;

  const setupBase = candidate.setup || (volumeRatio !== null && volumeRatio >= 1.5 ? 'Volume Surge Reversal' : 'Short Swing Accumulation');

  const tickSize = pickNumber(candidate, 'tick_size', 'tickSize', 'price_tick');

  const inputChecksum = crypto.createHash('sha256')
    .update(stableStringify({
      ticker,
      last_price: lastPrice,
      change_pct: changePct,
      volume_ratio: volumeRatio,
      entry_low: effEntryLow,
      entry_high: effEntryHigh,
      sl,
      tp1,
      tp2,
      bandar: { value: bandar.value, as_of: bandar.as_of, source: bandar.source },
      foreign: { value: foreign.value, as_of: foreign.as_of, source: foreign.source },
      technical: { value: technical.value, as_of: technical.as_of, source: technical.source },
      volume: { value: volume.value, as_of: volume.as_of, source: volume.source },
      as_of: freshness.as_of,
      session_date: sessionDate
    }))
    .digest('hex');

  return {
    ticker,
    emiten,
    session_date: sessionDate,
    as_of: freshness.as_of,
    snapshot_id: null, // set by buildSahamPotensialSnapshot
    snapshot_content_hash: null, // set by buildSahamPotensialSnapshot
    input_checksum: inputChecksum,
    component_freshness: componentFreshness.components,
    score_version: SCORE_ALGORITHM_VERSION,

    last_price: lastPrice,
    change_pct: changePct !== null ? Number(changePct.toFixed(2)) : null,
    volume_ratio: volumeRatio !== null ? Number(volumeRatio.toFixed(2)) : null,

    score: fusedScore,
    score_components: {
      bandar,
      foreign,
      technical,
      volume_ratio: volume,
      volume_bonus: {
        value: volumeBonus,
        status: volumeBonus !== null ? 'OK' : 'UNKNOWN',
        source: volume.source,
        as_of: volume.as_of,
        freshness: volume.freshness,
        eligibility: volumeBonus !== null,
        quality_gate: volumeBonus !== null ? 'PASS' : 'UNKNOWN',
        threshold: 0,
        weight: 0.20,
        penalty: 0,
        reason: volumeBonus !== null ? 'relative volume bonus (clamp((vr-1)*15, 0, 25))' : 'relative volume tidak tersedia',
        algo_version: SCORE_ALGORITHM_VERSION
      },
      fused: {
        value: fusedScore,
        status: fusedScore !== null ? 'OK' : 'UNKNOWN',
        source: 'short-swing/canonical/fused',
        as_of: sessionDate,
        freshness: freshness.status,
        eligibility: fusedScore !== null,
        quality_gate: fusedScore !== null ? 'PASS' : 'UNKNOWN',
        threshold: 0.5,
        weight: 1.0,
        penalty: 0,
        reason: fusedScore !== null ? 'fused weighted score' : 'tidak ada fused score (komponen tidak lengkap)',
        algo_version: SCORE_ALGORITHM_VERSION
      }
    },

    // Legacy numeric aliases (no fabrication; `null` is genuinely unknown).
    bandar_score: bandar.value,
    foreign_flow_score: foreign.value,
    technical_score: technical.value,
    volume_bonus: volumeBonus,

    setup: setupBase,
    risk_flags: riskFlags,

    entry_low: effEntryLow,
    entry_high: effEntryHigh,
    max_entry: maxEntry,
    tick_size: tickSize,
    tick_size_status: tickSize != null ? 'PROVIDED' : 'UNKNOWN',
    gap_handling: GAP_HANDLING_POLICY,

    sl,
    tp1,
    tp2,

    expiry: {
      horizon: horizonLabel,
      days_min: holdingDaysMin,
      days_max: holdingDaysMax
    },

    rr: Number(rr.toFixed(2)),
    rr_at_max_entry: rr,
    risk_reward: rr,
    min_rr: minRr,

    holding_horizon: horizonLabel,
    holding_days_min: holdingDaysMin,
    holding_days_max: holdingDaysMax,

    // No fabricated win probability. Honest null.
    win_probability: null,
    probability_source: null,

    readiness,
    status_reason: statusReason,
    blocked_reason: blockedReason,
    is_actionable: isActionable
  };
}

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 * Two structurally identical payloads always produce byte-identical strings,
 * which is what makes the content hash canonical.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * DEPRECATED (Subtask H / P0-10): ticker-set hash. Kept ONLY for legacy
 * callers/tests; it does NOT change when scores/levels/flags change, so it
 * must never be used as the published snapshot identity. Use
 * `buildSnapshotContentHash` instead.
 */
function buildSnapshotId(sessionDate, tickers) {
  const sorted = tickers.slice().sort();
  const h = crypto.createHash('sha256').update([sessionDate, ...sorted].join('|')).digest('hex').slice(0, 8);
  return 'SP-' + sessionDate + '-' + h;
}

/**
 * Canonical per-row content digest: everything that defines the row's
 * published meaning — score + component breakdown, entry/max_entry/SL/TP,
 * R/R at max_entry, risk flags, readiness verdict + reasons, per-component
 * freshness and the raw-input checksum.
 */
function buildRowContentDigest(row) {
  const sc = row.score_components || {};
  const componentDigest = (c) => (c ? {
    value: c.value === undefined ? null : c.value,
    as_of: c.as_of === undefined ? null : c.as_of,
    freshness: c.freshness || null,
    penalty: c.penalty === undefined ? null : c.penalty,
    quality_gate: c.quality_gate || null
  } : null);
  return crypto.createHash('sha256').update(stableStringify({
    ticker: row.ticker,
    session_date: row.session_date,
    score_version: row.score_version,
    score: row.score === undefined ? null : row.score,
    components: {
      bandar: componentDigest(sc.bandar),
      foreign: componentDigest(sc.foreign),
      technical: componentDigest(sc.technical),
      volume_ratio: componentDigest(sc.volume_ratio),
      volume_bonus: componentDigest(sc.volume_bonus)
    },
    component_freshness: row.component_freshness || null,
    entry_low: row.entry_low,
    entry_high: row.entry_high,
    max_entry: row.max_entry,
    sl: row.sl,
    tp1: row.tp1,
    tp2: row.tp2 === undefined ? null : row.tp2,
    rr_at_max_entry: row.rr_at_max_entry,
    min_rr: row.min_rr,
    risk_flags: (row.risk_flags || []).slice().sort(),
    readiness: row.readiness,
    status_reason: row.status_reason,
    blocked_reason: row.blocked_reason === undefined ? null : row.blocked_reason,
    is_actionable: row.is_actionable,
    input_checksum: row.input_checksum || null
  })).digest('hex');
}

/**
 * Subtask H / P0-10 — canonical normalized snapshot CONTENT hash.
 *
 * Covers: session_date, algorithm version, horizon, evaluated universe,
 * every row's content digest (scores, breakdown, levels, R/R, risk flags,
 * reasons, freshness, input checksums) AND the published Top20 ranking.
 * Any material change (score, R/R, flag, reason, ordering) yields a new hash;
 * identical content always yields the identical hash.
 *
 * Callers may supply `universe`/`rowDigests` directly (e.g. a consumer that
 * only holds the producer's persisted hash inputs, not the full evaluated
 * rows); otherwise they are derived from `rows`.
 *
 * @returns {{ content_hash: string, snapshot_id: string }}
 */
function buildSnapshotContentHash(params) {
  const rows = Array.isArray(params.rows) ? params.rows : [];
  const ranking = Array.isArray(params.ranking) ? params.ranking : [];
  const universe = Array.isArray(params.universe)
    ? params.universe.slice().sort()
    : rows.map((r) => r.ticker).slice().sort();
  let rowDigests;
  if (params.rowDigests && typeof params.rowDigests === 'object') {
    rowDigests = params.rowDigests;
  } else {
    rowDigests = {};
    for (const r of rows) rowDigests[r.ticker] = buildRowContentDigest(r);
  }
  const payload = {
    hash_version: CONTENT_HASH_VERSION,
    session_date: params.session_date,
    score_version: params.score_version,
    horizon: params.horizon,
    universe_count: universe.length,
    universe,
    row_digests: rowDigests,
    ranking
  };
  const contentHash = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  return {
    content_hash: contentHash,
    snapshot_id: 'SP-' + params.session_date + '-' + contentHash.slice(0, 16)
  };
}

/**
 * Generate snapshot Top 20 dan Top 5 Saham Potensial Short Swing.
 *
 * Invarian:
 * 1. Top 20 = kandidat berkualitas tertinggi, terurut deterministik
 *    (readiness → score → rr → volume_ratio → ticker). MAXIMAL 20, no padding.
 * 2. Top 5 adalah subset murni (rank 1..min(5,total)) dari snapshot Top 20 SAMA.
 * 3. Satu session_date, satu score_version, satu snapshot_id.
 *
 * @param {Array<object>} rawCandidates
 * @param {object} [options]
 * @returns {{
 *   snapshot_id: string,
 *   session_date: string,
 *   score_version: string,
 *   horizon: string,
 *   universe_count: number,
 *   evaluated_count: number,
 *   top20_count: number,
 *   top5_count: number,
 *   top20: Array<object>,
 *   top5: Array<object>
 * }}
 */
function buildSahamPotensialSnapshot(rawCandidates = [], options = {}) {
  const sessionDate = normalizeDateYmd(options.sessionDate) || wibToday();

  const evaluated = [];
  const seenTickers = new Set();

  for (const raw of rawCandidates) {
    const res = evaluateShortSwingCandidate(raw, { ...options, sessionDate });
    if (!res) continue;
    if (seenTickers.has(res.ticker)) continue;
    seenTickers.add(res.ticker);
    res.session_date = sessionDate;
    evaluated.push(res);
  }

  const readinessRank = {
    READY: 6,
    WAITING_ENTRY: 5,
    WATCHLIST: 4,
    DEGRADED: 3,
    BLOCKED: 2,
    NOT_READY: 1
  };

  evaluated.sort((a, b) => {
    const rA = readinessRank[a.readiness] || 0;
    const rB = readinessRank[b.readiness] || 0;
    if (rB !== rA) return rB - rA;
    const sA = typeof a.score === 'number' ? a.score : -Infinity;
    const sB = typeof b.score === 'number' ? b.score : -Infinity;
    if (sB !== sA) return sB - sA;
    const rrA = typeof a.rr === 'number' ? a.rr : -Infinity;
    const rrB = typeof b.rr === 'number' ? b.rr : -Infinity;
    if (rrB !== rrA) return rrB - rrA;
    const vA = typeof a.volume_ratio === 'number' ? a.volume_ratio : -Infinity;
    const vB = typeof b.volume_ratio === 'number' ? b.volume_ratio : -Infinity;
    if (vB !== vA) return vB - vA;
    return a.ticker.localeCompare(b.ticker);
  });

  // P0-10: the snapshot identity is the CANONICAL CONTENT HASH — computed
  // AFTER ranking so the published order is part of the hashed content, and
  // BEFORE stamping so every row carries the same identity.
  const ranking = evaluated.slice(0, 20).map((r) => r.ticker);
  const universe = evaluated.map((r) => r.ticker).slice().sort();
  const rowDigests = {};
  for (const r of evaluated) {
    r.row_content_digest = buildRowContentDigest(r);
    rowDigests[r.ticker] = r.row_content_digest;
  }
  const resolvedHorizonLabel = pickText(options, 'holdingLabel', 'holding_label') || HOLDING_HORIZON_LABEL;
  const resolvedDaysMin = num(options.holdingDaysMin) || HOLDING_HORIZON_MIN_DAYS;
  const resolvedDaysMax = num(options.holdingDaysMax) || HOLDING_HORIZON_MAX_DAYS;
  const { content_hash: contentHash, snapshot_id: snapshotId } = buildSnapshotContentHash({
    session_date: sessionDate,
    score_version: SCORE_ALGORITHM_VERSION,
    horizon: resolvedHorizonLabel,
    rows: evaluated,
    ranking
  });

  const top20Candidates = evaluated.slice(0, 20).map((cand, idx) => ({
    ...cand,
    rank: idx + 1,
    snapshot_id: snapshotId,
    snapshot_content_hash: contentHash,
    score_version: SCORE_ALGORITHM_VERSION
  }));

  // Top 5 adalah subset murni dari Top 20 yang sama (objek referensi identik).
  const top5Candidates = top20Candidates.slice(0, Math.min(5, top20Candidates.length));

  return {
    snapshot_id: snapshotId,
    snapshot_content_hash: contentHash,
    content_hash: contentHash,
    content_hash_version: CONTENT_HASH_VERSION,
    session_date: sessionDate,
    score_version: SCORE_ALGORITHM_VERSION,
    horizon: resolvedHorizonLabel,
    holding_days_min: resolvedDaysMin,
    holding_days_max: resolvedDaysMax,
    universe_count: rawCandidates.length,
    evaluated_count: evaluated.length,
    top20_count: top20Candidates.length,
    top5_count: top5Candidates.length,
    // Persisted hash inputs: an auditor (or the snapshot store) can recompute
    // the canonical content hash from the artifact alone, without re-running
    // the engine, and detect any tampering.
    universe,
    row_digests: rowDigests,
    ranking,
    top20: top20Candidates,
    top5: top5Candidates
  };
}

module.exports = {
  MIN_RR_THRESHOLD,
  HOLDING_HORIZON_LABEL,
  HOLDING_HORIZON_MIN_DAYS,
  HOLDING_HORIZON_MAX_DAYS,
  SCORE_ALGORITHM_VERSION,
  CONTENT_HASH_VERSION,
  MANDATORY_FRESHNESS_COMPONENTS,
  OPTIONAL_FRESHNESS_COMPONENTS,
  READINESS,
  calculateConservativeRiskReward,
  evaluateShortSwingCandidate,
  buildSahamPotensialSnapshot,
  buildSnapshotContentHash,
  buildRowContentDigest,
  stableStringify,
  buildSnapshotId, // DEPRECATED ticker-set hash — legacy only, see P0-10
  getTickerMap
};
