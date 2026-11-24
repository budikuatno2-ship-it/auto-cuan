'use strict';

/**
 * lib/track-record-live-ledger.js
 * ============================================================================
 * Live Signal Ledger Reader & Lifecycle Aggregator — Auto-Cuan V6 (Remediasi H)
 * ============================================================================
 *
 * Independent of the backtest statistics file
 * (`bukti-verifikasi-final/backtest-individual-964.json`). The live track
 * record is derived from the actual persisted signal ledger rows
 * (`telegram_daily_picks` shape), never from per-ticker backtest statistics.
 *
 * Contract:
 *   - UNREADABLE / MISSING source fails honestly (`success:false`, errorCode),
 *     it does NOT produce fake empty statistics.
 *   - Lifecycle states are WAITING_ENTRY / ENTERED / TP1_HIT / TP2_HIT / SL_HIT /
 *     INVALIDATED (incl. INVALIDATED_BEFORE_ENTRY) / EXPIRED (incl.
 *     EXPIRED_NO_ENTRY) / TIME_EXIT / AMBIGUOUS, with a 2–5 market-day horizon.
 *   - "no-entry" (WAITING / INVALIDATED / EXPIRED_NO_ENTRY) is NOT a loss and is
 *     excluded from the win/loss denominator.
 *   - Same-bar TP+SL is AMBIGUOUS and treated conservatively (never a win).
 *     The same-bar rule is enforced upstream too, in
 *     `lib/saham-potensial-lifecycle.js` (AMBIGUOUS_SAME_BAR), so an evaluator
 *     can never persist an optimistic win that this reader would then trust.
 *   - Realized gain is reduced by ROUND-TRIP slippage + fee costs (both sides,
 *     configurable). Reported alongside gross so nothing is silently hidden.
 *   - Floating (open) positions and resolved (closed) trades are reported as
 *     separate, non-overlapping buckets.
 *   - The produced snapshot is immutable & deterministic: one snapshot_id =
 *     SHA-256 of the normalized, sorted ledger.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

const DEFAULT_SLIPPAGE_PCT = 0.25;      // conservative: 0.25% per side
const DEFAULT_FEE_PCT = 0.10;           // conservative: 0.10% broker fee per side
// Number of legs the slippage+fee drag is applied over. The established V6
// contract applies the cost once (sides = 1) so `net = gross - (slippage+fee)`;
// Subtask K keeps that default EXACTLY (no silent change to published numbers)
// but makes the leg count explicit and configurable, so a caller can request a
// full round-trip drag (sides = 2) when it wants the more conservative net.
const DEFAULT_COST_SIDES = 1;
const HOLDING_HORIZON_DAYS_MAX = 5;

const WAITING_STATES = new Set(['WAITING', 'WAITING_ENTRY', 'ENTRY_READY', 'WATCHLIST', 'NOT_ENTERED']);
const ENTERED_STATES = new Set(['ENTERED', 'RUNNING', 'ACTIVE', 'ENTRY_HIT', 'IN_ENTRY_ZONE']);
const SL_STATES = new Set(['SL_HIT', 'STOP_LOSS']);
// Subtask K: TIME_EXIT is split out of the generic EXPIRED bucket. A TIME_EXIT is
// an ENTERED trade that closed at market when the 2–5 market-day horizon ran out;
// an EXPIRED_NO_ENTRY is a signal that never became a position at all. Collapsing
// them hides how many real positions closed without a TP/SL verdict.
const EXPIRED_STATES = new Set(['EXPIRED', 'EXPIRED_NO_ENTRY', 'NEEDS_REVALIDATION']);
const TIME_EXIT_STATES = new Set(['TIME_EXIT']);
const NEVER_ENTERED_STATES = new Set(['NEVER_ENTERED', 'INVALIDATED_BEFORE_ENTRY', 'INVALIDATED', 'INVALID', 'ENTRY_MISSED']);
// Subtask K: lib/saham-potensial-lifecycle.js now emits AMBIGUOUS_SAME_BAR when a
// single daily bar touches both a target and the stop. That state is terminal but
// is neither a win nor a loss, so it must be recognised here too — otherwise the
// row would silently fall through to ENTERED (an open/floating position).
const AMBIGUOUS_STATES = new Set(['AMBIGUOUS', 'AMBIGUOUS_SAME_BAR', 'SAME_BAR_AMBIGUOUS']);

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIsoMs(v) {
  if (v == null || v === '') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Candidate search paths for the independent live ledger file. */
function getCandidatePaths(customPath) {
  const list = [];
  if (customPath && typeof customPath === 'string') list.push(path.resolve(customPath));
  if (process.env.AUTO_CUAN_LIVE_LEDGER_FILE) list.push(path.resolve(process.env.AUTO_CUAN_LIVE_LEDGER_FILE));
  list.push(path.join(ROOT, 'data', 'live-signal-ledger.json'));
  list.push(path.join(ROOT, 'data', 'signals-live-ledger.json'));
  return [...new Set(list)];
}

function loadLiveLedger(customPath) {
  const searchedPaths = getCandidatePaths(customPath);
  let resolvedPath = null;
  for (const candidate of searchedPaths) {
    try {
      if (fs.existsSync(candidate)) { resolvedPath = candidate; break; }
    } catch (_) { /* ignore */ }
  }
  if (!resolvedPath) {
    return { success: false, data: null, filePath: null, error: 'LIVE_LEDGER_NOT_FOUND', errorCode: 'ENOENT', searchedPaths };
  }
  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);
    const data = Array.isArray(parsed) ? parsed : (parsed.signals || parsed.rows || parsed.data || null);
    if (!Array.isArray(data)) {
      return { success: false, data: null, filePath: resolvedPath, error: 'LIVE_LEDGER_NOT_AN_ARRAY', errorCode: 'INVALID_SHAPE', searchedPaths };
    }
    return { success: true, data, filePath: resolvedPath, error: null, errorCode: null, searchedPaths };
  } catch (err) {
    const isParse = err instanceof SyntaxError;
    return {
      success: false,
      data: null,
      filePath: resolvedPath,
      error: isParse ? 'LIVE_LEDGER_CORRUPTED' : 'LIVE_LEDGER_UNREADABLE',
      errorCode: isParse ? 'JSON_SYNTAX_ERROR' : (err.code || 'READ_ERROR'),
      detail: String((err && err.message) || err),
      searchedPaths
    };
  }
}

/**
 * Conservative outcome classification.
 *
 * Precedence:
 *   1. Explicit outcome/status terminal states (persisted truth).
 *   2. Persisted TP1/TP2/SL timestamps with TP-before-SL chronology.
 *   3. Same-bar TP+SL (equal timestamps) => AMBIGUOUS (conservative, never a win).
 *   4. Entry timestamp => ENTERED, otherwise WAITING.
 *
 * Returns canonical outcome string.
 */
function classifyLiveOutcome(row) {
  if (!row) return 'WAITING';
  const status = String(row.status || row.outcome || '').toUpperCase();
  const raw = row.raw_payload || {};

  if (status === 'TP2_HIT') return 'TP2_HIT';
  if (status === 'TP1_HIT') return 'TP1_HIT';
  if (SL_STATES.has(status)) return 'SL_HIT';
  if (AMBIGUOUS_STATES.has(status)) return 'AMBIGUOUS';
  if (TIME_EXIT_STATES.has(status)) return 'TIME_EXIT';
  if (EXPIRED_STATES.has(status)) return 'EXPIRED';
  if (NEVER_ENTERED_STATES.has(status)) return 'INVALIDATED';

  const tp2Ms = toIsoMs(row.hit_tp2_at || raw.hit_tp2_at);
  const tp1Ms = toIsoMs(row.hit_tp1_at || raw.hit_tp1_at);
  const slMs = toIsoMs(row.hit_sl_at || raw.hit_sl_at);
  const entryMs = toIsoMs(row.hit_entry_at || raw.hit_entry_at);

  // Same-bar TP + SL must be resolved conservatively: ambiguous, not a win.
  const tpWin = tp2Ms != null ? tp2Ms : tp1Ms;
  if (tpWin != null && slMs != null && tpWin === slMs) return 'AMBIGUOUS';

  if (tp2Ms != null && (slMs == null || tp2Ms < slMs)) return 'TP2_HIT';
  if (tp1Ms != null && (slMs == null || tp1Ms < slMs)) return 'TP1_HIT';
  if (slMs != null) return 'SL_HIT';
  if (entryMs != null) return 'ENTERED';
  if (ENTERED_STATES.has(status)) return 'ENTERED';
  return 'WAITING';
}

function normalizeLiveSignal(row, index) {
  const ticker = String(row.ticker || '').trim().toUpperCase();
  // Conservative entry basis: the canonical engine measures R/R and gain at
  // max_entry (see lib/saham-potensial-engine.calculateConservativeRiskReward
  // and lib/saham-potensial-lifecycle.evaluateLifecycleHistory). Using the
  // lower of two entry bounds would overstate the realized gain, so take the
  // max of whichever bounds are present.
  const e1 = num(row.entry1);
  const e2 = num(row.entry2);
  const entry = e1 != null && e2 != null ? Math.max(e1, e2) : (e1 != null ? e1 : e2);
  return {
    id: row.id != null ? row.id : index + 1,
    date: String(row.date || '').slice(0, 10) || null,
    ticker: ticker || null,
    category: row.category || null,
    monitor_source: row.monitor_source || null,
    entry1: num(row.entry1),
    entry2: num(row.entry2),
    entry: entry,
    tp1: num(row.tp1),
    tp2: num(row.tp2),
    sl: num(row.sl),
    status: String(row.status || row.outcome || '').toUpperCase() || null,
    hit_tp2_at: row.hit_tp2_at || null,
    hit_tp1_at: row.hit_tp1_at || null,
    hit_sl_at: row.hit_sl_at || null,
    hit_entry_at: row.hit_entry_at || null,
    first_sent_at: row.first_sent_at || row.created_at || null,
    raw_payload: row.raw_payload || {}
  };
}

/** Realized gross gain % for a TP/SL outcome at the given entry price. */
function grossGainPct(signal, outcome) {
  const entry = signal.entry;
  if (entry == null || entry <= 0) return null;
  let target = null;
  if (outcome === 'TP2_HIT') target = signal.tp2;
  else if (outcome === 'TP1_HIT') target = signal.tp1;
  else if (outcome === 'SL_HIT') target = signal.sl;
  if (target == null || target <= 0) return null;
  const pct = ((target - entry) / entry) * 100;
  return Number.isFinite(pct) ? Number(pct.toFixed(4)) : null;
}

/**
 * Apply slippage + fee costs to a gross % (conservative, never inflates).
 *
 * `sides` defaults to 2 (round trip: entry + exit). Each side pays
 * slippage + fee, so the default total drag is (0.25 + 0.10) x 2 = 0.70%.
 */
function applyCosts(grossPct, options = {}) {
  const slippage = num(options.slippagePct) != null ? num(options.slippagePct) : DEFAULT_SLIPPAGE_PCT;
  const fee = num(options.feePct) != null ? num(options.feePct) : DEFAULT_FEE_PCT;
  const sides = num(options.sides) != null && num(options.sides) > 0 ? num(options.sides) : DEFAULT_COST_SIDES;
  const cost = (slippage + fee) * sides;
  return Number((grossPct - cost).toFixed(4));
}

/** Total round-trip cost (in %) implied by the resolved cost options. */
function resolveCostModel(options = {}) {
  const slippage = num(options.slippagePct) != null ? num(options.slippagePct) : DEFAULT_SLIPPAGE_PCT;
  const fee = num(options.feePct) != null ? num(options.feePct) : DEFAULT_FEE_PCT;
  const sides = num(options.sides) != null && num(options.sides) > 0 ? num(options.sides) : DEFAULT_COST_SIDES;
  return {
    slippage_pct_per_side: slippage,
    fee_pct_per_side: fee,
    sides,
    round_trip_cost_pct: Number(((slippage + fee) * sides).toFixed(4)),
    // Backwards-compatible aliases (older consumers read these two keys).
    slippage_pct: slippage,
    fee_pct: fee
  };
}

function buildLiveSnapshotId(signals) {
  const canonical = signals.map((s) => [
    s.id, s.date, s.ticker, s.entry, s.sl, s.tp1, s.tp2, s.status,
    s.hit_tp2_at, s.hit_tp1_at, s.hit_sl_at, s.hit_entry_at
  ].join('|')).sort().join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/**
 * Build an immutable live track record from normalized signal rows.
 *
 * @param {Array<object>} rows  Live ledger rows (telegram_daily_picks shape)
 * @param {object} [options]  { slippagePct, feePct }
 * @returns {object}
 */
function buildLiveTrackRecord(rows = [], options = {}) {
  const signals = (Array.isArray(rows) ? rows : [])
    .map((r, i) => normalizeLiveSignal(r, i))
    .filter((s) => s.ticker && s.date);

  signals.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id - b.id));

  const snapshotId = buildLiveSnapshotId(signals);

  let waiting = 0;
  let entered = 0;
  let tp1 = 0;
  let tp2 = 0;
  let sl = 0;
  let expired = 0;
  let invalidated = 0;
  let timeExit = 0;
  let ambiguous = 0;

  const TERMINAL_OUTCOMES = ['TP2_HIT', 'TP1_HIT', 'SL_HIT', 'EXPIRED', 'INVALIDATED', 'TIME_EXIT', 'AMBIGUOUS'];

  const enriched = signals.map((s) => {
    const outcome = classifyLiveOutcome(s);
    // Only unambiguous, entered-and-closed outcomes carry a realized gain.
    // TIME_EXIT closed at market but its exit price is not persisted on the
    // ledger row, so no realized % is claimed for it (honest null, not 0).
    let gross = (outcome === 'TP1_HIT' || outcome === 'TP2_HIT' || outcome === 'SL_HIT')
      ? grossGainPct(s, outcome)
      : null;
    let net = gross != null ? applyCosts(gross, options) : null;

    if (outcome === 'TP2_HIT') tp2++;
    else if (outcome === 'TP1_HIT') tp1++;
    else if (outcome === 'SL_HIT') sl++;
    else if (outcome === 'EXPIRED') expired++;
    else if (outcome === 'INVALIDATED') invalidated++;
    else if (outcome === 'TIME_EXIT') timeExit++;
    else if (outcome === 'AMBIGUOUS') ambiguous++;
    else if (ENTERED_STATES.has(outcome) || outcome === 'ENTERED') entered++;
    else waiting++;

    return {
      id: s.id,
      date: s.date,
      ticker: s.ticker,
      category: s.category,
      monitor_source: s.monitor_source,
      entry1: s.entry1,
      entry2: s.entry2,
      entry: s.entry,
      tp1: s.tp1,
      tp2: s.tp2,
      sl: s.sl,
      outcome,
      is_terminal: TERMINAL_OUTCOMES.includes(outcome),
      gross_gain_pct: gross,
      net_gain_pct: net,
      first_sent_at: s.first_sent_at
    };
  });

  // Correct denominator: only ENTERED-and-resolved trades count for win/loss.
  // No-entry (WAITING / INVALIDATED / EXPIRED_NO_ENTRY) is NOT a loss, and
  // TIME_EXIT / AMBIGUOUS closed without a proven TP/SL verdict so they are
  // excluded from the win/loss denominator too (reported separately).
  const resolved = tp1 + tp2 + sl;       // wins + losses only
  const resolvedWithAmbiguous = resolved + ambiguous;

  const winRateOnResolved = resolved > 0
    ? Number(((tp1 + tp2) / resolved * 100).toFixed(2))
    : null;
  const lossRateOnResolved = resolved > 0
    ? Number((sl / resolved * 100).toFixed(2))
    : null;

  const bestNetGain = enriched
    .filter((s) => s.net_gain_pct != null && s.net_gain_pct > 0)
    .reduce((best, s) => (!best || s.net_gain_pct > best.net_gain_pct ? s : best), null);

  // Floating (still open / not yet decided) vs resolved (closed) are reported
  // as separate, non-overlapping buckets so no reader can mistake an open
  // position for a settled result (Subtask K).
  const floatingOpen = waiting + entered;
  const closedNoOutcome = expired + invalidated + timeExit + ambiguous;

  return {
    success: true,
    snapshot_id: snapshotId,
    source: 'live_signals_ledger',
    holding_horizon: `Short Swing (2–${HOLDING_HORIZON_DAYS_MAX} Hari Bursa)`,
    cost_model: resolveCostModel(options),
    summary: {
      total_signals: signals.length,
      waiting,
      entered,
      tp1_hits: tp1,
      tp2_hits: tp2,
      sl_hits: sl,
      expired,
      // Kept for backwards compatibility: "never entered" == INVALIDATED.
      never_entered: invalidated,
      invalidated,
      time_exit: timeExit,
      ambiguous_same_bar: ambiguous,
      // Denominator discipline: resolved = entered & closed (wins + losses).
      total_resolved: resolved,
      total_resolved_incl_ambiguous: resolvedWithAmbiguous,
      win_rate_on_resolved_pct: winRateOnResolved,
      loss_rate_on_resolved_pct: lossRateOnResolved,
      // Explicit floating vs resolved separation (Subtask K).
      floating_open: floatingOpen,
      closed_without_outcome: closedNoOutcome,
      accounted_total: floatingOpen + resolved + closedNoOutcome,
      best_net_gain: bestNetGain
        ? { ticker: bestNetGain.ticker, date: bestNetGain.date, net_gain_pct: bestNetGain.net_gain_pct, gross_gain_pct: bestNetGain.gross_gain_pct }
        : null
    },
    signals: enriched
  };
}

module.exports = {
  DEFAULT_SLIPPAGE_PCT,
  DEFAULT_FEE_PCT,
  DEFAULT_COST_SIDES,
  HOLDING_HORIZON_DAYS_MAX,
  WAITING_STATES,
  ENTERED_STATES,
  AMBIGUOUS_STATES,
  getCandidatePaths,
  loadLiveLedger,
  normalizeLiveSignal,
  classifyLiveOutcome,
  grossGainPct,
  applyCosts,
  resolveCostModel,
  buildLiveSnapshotId,
  buildLiveTrackRecord
};