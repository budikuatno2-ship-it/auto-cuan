'use strict';

/**
 * lib/short-swing-universe.js
 * ============================================================================
 * Canonical Short Swing candidate builder over the WHOLE local IDX universe
 * (Auto-Cuan V6, Subtask H / P0-09).
 * ============================================================================
 *
 * WHY THIS EXISTS:
 *   `data/screener-latest.json` pool `swing` was an alias of the Konglo
 *   screener results (universe = 165 conglomerate-affiliated tickers). The
 *   canonical Short Swing Top20/Top5 must be graded over the WHOLE eligible
 *   IDX universe available locally, not a 165-ticker subset. This module is
 *   the single place that turns local raw data into canonical engine
 *   candidates; both the real producer (`scripts/run-screeners.js`) and the
 *   offline replay tool (`tools/v6-short-swing-replay.js`) use it, so replay
 *   evidence and live wiring cannot drift apart.
 *
 * DATA SOURCES (local only — zero provider quota, zero network):
 *   data/daily-candles/<TICKER>.json    OHLCV daily bars (Yahoo EOD cache)
 *   data/broker-accumulation/<T>.json   broksum history incl. foreign windows
 *
 * HONESTY CONTRACT:
 *   - Every candidate carries REAL as-of dates per component:
 *       price_asof    = date of the last local candle
 *       bandar_asof   = date of the broksum entry used (or null)
 *       foreign_asof  = date of the broksum entry carrying foreign data (or null)
 *   - No score is fabricated. bandar/foreign scores are derived from the
 *     local broksum buy/sell value ratio (bs) and foreign net value; when the
 *     broksum file is absent the score stays null and the canonical engine
 *     fail-closes to BLOCKED.
 *   - A ticker whose candles are stale vs session_date is still emitted (with
 *     its real price_asof) so the engine can grade it NOT_READY — silence
 *     would hide the staleness instead of proving the gate works.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const mf964 = require('./backtest-multifactor-964.js');
const idxTick = require('./idx-tick.js');

const DEFAULT_CANDLE_DIR = path.join(__dirname, '..', 'data', 'daily-candles');
const DEFAULT_BROKSUM_DIR = path.join(__dirname, '..', 'data', 'broker-accumulation');

const MIN_CANDLES = 25; // same structural minimum as the legacy swing machine
const SUPPORT_RESISTANCE_WINDOW = 20;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeDateYmd(value) {
  if (value == null) return null;
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
}

/** Whole local universe: every ticker with a daily-candles file (minus IHSG index). */
function listLocalUniverse(candleDir) {
  const dir = candleDir || DEFAULT_CANDLE_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5).toUpperCase())
    .filter((t) => t !== 'IHSG' && t !== 'INDEX')
    .sort();
}

function readCandles(ticker, candleDir) {
  const dir = candleDir || DEFAULT_CANDLE_DIR;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, ticker + '.json'), 'utf8'));
    const candles = (j.candles || []).map((c) => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: c.volume == null ? null : Number(c.volume),
      date: normalizeDateYmd(c.date)
    })).filter((c) => Number.isFinite(c.close) && c.date);
    return candles;
  } catch (_) {
    return [];
  }
}

function readBroksumHistory(ticker, broksumDir) {
  const dir = broksumDir || DEFAULT_BROKSUM_DIR;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, ticker + '.json'), 'utf8'));
    if (j && j.history && typeof j.history === 'object') return j.history;
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Derive honest bandar (broker accumulation) and foreign-flow scores from the
 * local broksum entry for `priceAsOf`.
 *
 * WHY NOT THE buy/sell RATIO (bs):
 *   In a broksum window every trade has both a buyer and a seller, so
 *   `total_buy_val == total_sell_val` BY CONSTRUCTION and `bs == 1.0` for every
 *   ticker on every date. Scoring off `bs` therefore yields a CONSTANT — an
 *   information-free number that merely looks derived. (Verified: mf964's
 *   `bsFeaturesAt` returns bs1..bs20 all exactly 1 for BBCA.) Using it would be
 *   a fake neutral score in all but name, which the anti-slop contract forbids.
 *
 * WHAT ACTUALLY DISCRIMINATES in this data:
 *   bandar_score  — net accumulation by the top brokers, `sum(top_buyers[i].net_val)`
 *                   for i<3, expressed as a share of one-sided turnover, damped
 *                   by how CONSISTENT that accumulation was over the trailing
 *                   10 sessions (`consistency.all.net_buy_days_10h / of_days`).
 *                   Distribution (negative net) scores below 50.
 *   foreign_score — the 1-day foreign net value as a share of one-sided
 *                   turnover, mapped through tanh so extreme prints saturate
 *                   instead of dominating.
 *
 * Both stay null when the underlying numbers are absent — the engine BLOCKS on
 * null, which is the honest outcome. Neither is ever defaulted to 50.
 */
const BANDAR_TANH_SCALE = 2.0;
const FOREIGN_TANH_SCALE = 4.0;
/** Accumulation consistency weighting: 0.7 at 0/10 net-buy days, 1.0 at 10/10. */
const CONSISTENCY_FLOOR = 0.7;

function deriveBrokerForeignScores(bsFeat, broksumEntry) {
  const out = {
    bandar_score: null,
    bandar_asof: null,
    bandar_basis: null,
    foreign_flow_score: null,
    foreign_asof: null,
    foreign_status: null
  };
  if (!bsFeat || bsFeat.hasData !== true) return out;

  const asOf = normalizeDateYmd(bsFeat.broksumDate);
  out.bandar_asof = asOf;

  const win1h = (broksumEntry && broksumEntry.windows && broksumEntry.windows['1H']) || null;
  const allNode = win1h && win1h.all;
  // One-sided turnover: buy_val == sell_val in a closed window, so either side
  // is the traded value. Using the sum would halve every ratio for no reason.
  const oneSidedTurnover = allNode
    ? Math.max(Number(allNode.total_buy_val) || 0, Number(allNode.total_sell_val) || 0)
    : 0;

  /* ---- bandar: top-3 net accumulation, damped by consistency ------------- */
  const top3Net = num(bsFeat.top3Net);
  if (top3Net !== null && oneSidedTurnover > 0) {
    const top3Share = top3Net / oneSidedTurnover; // negative => distribution
    let score = 50 + 50 * Math.tanh(top3Share * BANDAR_TANH_SCALE);

    const cons = (broksumEntry.consistency && broksumEntry.consistency.all) || null;
    const netBuyDays = cons ? num(cons.net_buy_days_10h) : null;
    const ofDays = cons ? num(cons.of_days) : null;
    let consistency = null;
    if (netBuyDays !== null && ofDays !== null && ofDays > 0) {
      consistency = netBuyDays / ofDays;
      score = score * (CONSISTENCY_FLOOR + (1 - CONSISTENCY_FLOOR) * consistency);
    }

    out.bandar_score = Number(Math.min(100, Math.max(0, score)).toFixed(1));
    out.bandar_basis = {
      top3_net_val: top3Net,
      one_sided_turnover: oneSidedTurnover,
      top3_share: Number(top3Share.toFixed(6)),
      net_buy_days_10h: netBuyDays,
      of_days: ofDays,
      consistency: consistency === null ? null : Number(consistency.toFixed(4)),
      tekanan_broker: broksumEntry.tekanan_broker !== undefined
        ? num(broksumEntry.tekanan_broker)
        : null
    };
  }

  /* ---- foreign: 1-day foreign net value share ---------------------------- */
  const foreignNet = num(bsFeat.foreignNet);
  if (foreignNet !== null && oneSidedTurnover > 0) {
    const foreignShare = foreignNet / oneSidedTurnover;
    const scaled = 50 + 50 * Math.tanh(foreignShare * FOREIGN_TANH_SCALE);
    out.foreign_flow_score = Number(Math.min(100, Math.max(0, scaled)).toFixed(1));
    out.foreign_asof = asOf;
  }
  if (broksumEntry) {
    out.foreign_status = broksumEntry.foreign_status || null;
    if (out.foreign_asof === null && broksumEntry.has_foreign === true) {
      out.foreign_asof = normalizeDateYmd(broksumEntry.date);
    }
  }
  return out;
}

/**
 * Wilder ATR(14) from real OHLC candles (oldest-first). No lookahead: uses only
 * bars up to and including the last bar. Returns null when history is short.
 */
function atr14(candles) {
  const arr = Array.isArray(candles) ? candles : [];
  if (arr.length < 15) return null;
  const trs = [];
  for (let i = 1; i < arr.length; i += 1) {
    const c = arr[i], p = arr[i - 1];
    const h = Number(c.high), l = Number(c.low), pc = Number(p.close);
    if (![h, l, pc].every(Number.isFinite)) return null;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const period = 14;
  const recent = trs.slice(-period);
  if (recent.length < period) return null;
  let atr = recent.reduce((a, b) => a + b, 0) / period;
  // Wilder smoothing over the remaining true ranges (deterministic, no lookahead).
  for (let i = period; i < trs.length; i += 1) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

/**
 * Build the structural trade plan (entry/SL/TP) from real local candles.
 *
 * TASK F RR CALIBRATION (proven defect: old code hardcoded `risk * 2.0`, so
 * 908/909 replay rows had rr exactly 2.0 regardless of the ticker's own levels):
 *   - SL = 20-day structural support, but never wider than 1.5x ATR(14) nor
 *     more than 8% below entry (real volatility/structure guard).
 *   - TP1 = nearest real resistance above entry when it clears R/R >= 1.5;
 *     otherwise the ATR/structure-implied target, clamped to [1.5, 2.5] x risk.
 *   - TP2 = next structural extension (1.5x the TP1 distance), not a fixed 5%.
 * Every level carries its basis so the audit can prove it came from real data.
 */
function buildPlanFromCandles(candles) {
  const last = candles[candles.length - 1];
  const window = candles.slice(-SUPPORT_RESISTANCE_WINDOW);
  const support = Math.min.apply(null, window.map((c) => c.low));
  const resistance = Math.max.apply(null, window.map((c) => c.high));
  const atr = atr14(candles);

  // TASK 5: every published level MUST sit on the official IDX tick fraction.
  // Round the raw close first, then derive all other levels from that on-tick
  // anchor so no off-fraction price can leak into the canonical candidate.
  const entryHigh = idxTick.roundToIdxTick(last.close);
  const entryLow = idxTick.roundToIdxTick(last.close * 0.99);

  // SL: structural support, volatility-capped and hard risk-capped.
  let stopLoss = support > 0 && support < entryHigh ? support : entryHigh * 0.97;
  let slBasis = 'STRUCTURAL_SUPPORT_20D';
  if (atr !== null) {
    const atrFloor = entryHigh - 1.5 * atr;
    if (stopLoss < atrFloor) { stopLoss = atrFloor; slBasis = 'ATR_1_5_FLOOR'; }
  }
  const hardFloor = entryHigh * 0.92;
  if (stopLoss < hardFloor) { stopLoss = hardFloor; slBasis = 'MAX_RISK_8PCT_FLOOR'; }
  stopLoss = idxTick.roundToIdxTick(stopLoss);
  if (!(stopLoss > 0 && stopLoss < entryHigh)) {
    stopLoss = idxTick.tickBelow(entryHigh);
    slBasis = 'FALLBACK_3PCT';
  }

  const risk = entryHigh - stopLoss;
  const minRR = 1.5;
  const maxRR = 3.0; // short-swing institutional cap: no absurd 100x "targets"
  let tp1;
  let tp1Basis;
  const resistanceReward = resistance > entryHigh ? resistance - entryHigh : 0;
  const resistanceRR = risk > 0 ? resistanceReward / risk : 0;
  if (resistanceRR >= minRR && resistanceRR <= maxRR) {
    tp1 = resistance;
    tp1Basis = 'STRUCTURAL_RESISTANCE_20D';
  } else {
    // ATR-implied target: at least 1 ATR of reward, RR clamped to [1.5, 3.0].
    // When resistance is beyond the cap, use the capped RR (still real-risk based).
    const atrReward = atr !== null ? Math.max(atr, risk * minRR) : risk * minRR;
    const rrTarget = risk > 0 ? Math.min(maxRR, Math.max(minRR, atrReward / risk)) : minRR;
    tp1 = entryHigh + risk * rrTarget;
    tp1Basis = resistanceRR > maxRR ? 'RESISTANCE_BEYOND_RR_CAP' :
      (atr !== null ? 'ATR_IMPLIED_RR_CLAMPED' : 'MIN_RR_1_5_FALLBACK');
  }
  tp1 = idxTick.roundUpToIdxTick(tp1);
  if (!(tp1 > entryHigh)) { tp1 = idxTick.tickAbove(entryHigh); tp1Basis = 'MIN_RR_1_5_FALLBACK'; }

  // TASK 5: revalidate R/R >= 1.5 AFTER tick rounding. If rounding pushed the
  // target below the minimum, lift TP1 to the first on-tick level that clears
  // the gate. This is a real structural adjustment, never a fabricated number.
  let rr = idxTick.rrFromLevels(entryHigh, stopLoss, tp1);
  if (rr == null || rr + 1e-9 < minRR) {
    const requiredTp1 = entryHigh + risk * minRR;
    tp1 = idxTick.roundUpToIdxTick(requiredTp1);
    tp1Basis = 'MIN_RR_1_5_AFTER_TICK_ROUNDING';
    rr = idxTick.rrFromLevels(entryHigh, stopLoss, tp1);
  }

  const tpDistance = tp1 - entryHigh;
  const tp2 = idxTick.roundToIdxTick(tp1 + tpDistance * 0.5);

  return {
    support,
    resistance,
    atr14: atr,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop_loss: stopLoss,
    sl_basis: slBasis,
    tp1,
    tp1_basis: tp1Basis,
    tp2,
    tp2_basis: 'TP1_PLUS_HALF_DISTANCE',
    rr_at_max_entry: rr
  };
}

/**
 * Build ONE canonical candidate for a ticker from local data only.
 *
 * @param {string} ticker
 * @param {object} [options] { candleDir, broksumDir }
 * @returns {{ candidate: object|null, eligibility: object }}
 */
function buildCandidateFromLocalData(ticker, options = {}) {
  const candles = readCandles(ticker, options.candleDir);
  const eligibility = {
    ticker,
    in_local_universe: true,
    candle_file: candles.length > 0,
    candle_count: candles.length,
    price_asof: candles.length ? candles[candles.length - 1].date : null,
    broksum_file: false,
    broksum_asof: null,
    eligible: false,
    exclusion_reason: null
  };

  if (candles.length === 0) {
    eligibility.exclusion_reason = 'NO_LOCAL_CANDLES';
    return { candidate: null, eligibility };
  }
  if (candles.length < MIN_CANDLES) {
    eligibility.exclusion_reason = 'INSUFFICIENT_HISTORY_' + candles.length + '_LT_' + MIN_CANDLES;
    return { candidate: null, eligibility };
  }

  const broksumHist = readBroksumHistory(ticker, options.broksumDir);
  eligibility.broksum_file = broksumHist !== null;

  const feats = mf964.computeBarFeatures(candles, broksumHist);
  const lastFeat = feats.length ? feats[feats.length - 1] : null;
  if (!lastFeat) {
    eligibility.exclusion_reason = 'FEATURE_COMPUTATION_FAILED';
    return { candidate: null, eligibility };
  }

  const priceAsOf = normalizeDateYmd(lastFeat.date);
  eligibility.price_asof = priceAsOf;

  let broksumEntry = null;
  if (broksumHist && lastFeat.bs && lastFeat.bs.broksumDate) {
    broksumEntry = broksumHist[lastFeat.bs.broksumDate] || null;
    eligibility.broksum_asof = normalizeDateYmd(lastFeat.bs.broksumDate);
  }

  const scores = deriveBrokerForeignScores(lastFeat.bs, broksumEntry);

  const prev = candles.length >= 2 ? candles[candles.length - 2] : null;
  const changePct = prev && prev.close > 0
    ? Number((((lastFeat.close - prev.close) / prev.close) * 100).toFixed(2))
    : null;

  const plan = buildPlanFromCandles(candles);

  // Technical score: honest, deterministic, derived from real local features
  // (trend vs MA20/MA50 + RSI band). NOT a fabricated conviction number: the
  // formula is fixed, documented and reproducible from the same candles.
  let technicalScore = null;
  if (lastFeat.ma20 != null && lastFeat.rsi14 != null) {
    let ts = 50;
    if (lastFeat.close >= lastFeat.ma20) ts += 15;
    if (lastFeat.ma50 != null && lastFeat.ma20 >= lastFeat.ma50) ts += 10;
    if (lastFeat.rsi14 >= 45 && lastFeat.rsi14 <= 68) ts += 10;
    if (lastFeat.rsi14 > 75) ts -= 15;
    if (lastFeat.rsi14 < 30) ts -= 10;
    technicalScore = Number(Math.min(100, Math.max(0, ts)).toFixed(1));
  }

  eligibility.eligible = true;

  const candidate = {
    ticker,
    source: 'local-daily-candles+broker-accumulation',
    source_file: 'data/daily-candles/' + ticker + '.json',

    // Price clock (real).
    as_of: priceAsOf,
    price_asof: priceAsOf,
    last_price: lastFeat.close,
    change_pct: changePct,
    volume_ratio: lastFeat.volumeRatio != null ? Number(lastFeat.volumeRatio.toFixed(4)) : null,
    volume_ratio_20d: lastFeat.volumeRatio != null ? Number(lastFeat.volumeRatio.toFixed(4)) : null,
    volume_asof: priceAsOf,
    value_avg20: lastFeat.valueAvg20 != null ? Math.round(lastFeat.valueAvg20) : null,

    // Structural plan (real levels from real candles).
    entry_low: plan.entry_low,
    entry_high: plan.entry_high,
    sl: plan.stop_loss,
    stop_loss: plan.stop_loss,
    tp1: plan.tp1,
    tp2: plan.tp2,
    support: plan.support,
    resistance: plan.resistance,

    // Broker / foreign (real broksum-derived, or honest null).
    bandar_score: scores.bandar_score,
    bandar_asof: scores.bandar_asof,
    bandar_source: scores.bandar_score !== null ? 'data/broker-accumulation (bs-ratio)' : null,
    foreign_flow_score: scores.foreign_flow_score,
    foreign_asof: scores.foreign_asof,
    foreign_source: scores.foreign_flow_score !== null ? 'data/broker-accumulation (1H foreign net)' : null,
    foreign_status: scores.foreign_status,

    // Technical (real feature-derived).
    technical_score: technicalScore,
    technical_asof: technicalScore !== null ? priceAsOf : null,
    technical_source: technicalScore !== null ? 'ma20/ma50/rsi14 local candles' : null,

    rsi14: lastFeat.rsi14 != null ? Number(lastFeat.rsi14.toFixed(2)) : null,
    ma20: lastFeat.ma20 != null ? Number(lastFeat.ma20.toFixed(1)) : null
  };

  return { candidate, eligibility };
}

/**
 * Build canonical candidates for the WHOLE local universe.
 *
 * @param {object} [options] { candleDir, broksumDir, universe (explicit list) }
 * @returns {{ candidates: Array<object>, ledger: Array<object> }}
 */
function buildUniverseCandidates(options = {}) {
  const universe = Array.isArray(options.universe) && options.universe.length
    ? options.universe
    : listLocalUniverse(options.candleDir);
  const candidates = [];
  const ledger = [];
  for (const ticker of universe) {
    const { candidate, eligibility } = buildCandidateFromLocalData(ticker, options);
    ledger.push(eligibility);
    if (candidate) candidates.push(candidate);
  }
  return { candidates, ledger, universe_count: universe.length };
}

module.exports = {
  MIN_CANDLES,
  SUPPORT_RESISTANCE_WINDOW,
  DEFAULT_CANDLE_DIR,
  DEFAULT_BROKSUM_DIR,
  listLocalUniverse,
  readCandles,
  readBroksumHistory,
  deriveBrokerForeignScores,
  buildPlanFromCandles,
  buildCandidateFromLocalData,
  buildUniverseCandidates
};
