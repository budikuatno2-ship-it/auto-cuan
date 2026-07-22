'use strict';

/**
 * Event-based Intraday Shadow Trade Backtest (research / evaluation ONLY)
 * ======================================================================
 *
 * Purpose
 *   Convert the repeated per-snapshot observations already produced by the LIVE
 *   intraday shadow-scoring evaluator (data/intraday-shadow-scoring-live/<date>/
 *   shadow-scores.jsonl) into realistic, DEDUPLICATED shadow *trade events*, and
 *   evaluate a single candidate rule against them:
 *
 *       confirmation_state = CONFIRMED
 *       confirmed_rank     = 1
 *       shadow_score       >= min-score (default 16)
 *
 *   Rank 2..5 are NEVER treated as production candidates.
 *
 *   This is a SHADOW / backtest evaluation only. It reads the already-collected
 *   shadow-scoring outputs and intraday sample prices read-only, and writes only
 *   into a SEPARATE output root. It NEVER:
 *     - enables production intraday scoring,
 *     - mutates any recommendation / portfolio / user state,
 *     - touches Supabase,
 *     - imports or sends Telegram,
 *     - rewrites the source sample / shadow-scoring files.
 *
 * Hard safety guarantees (shared with the shadow evaluator via
 * lib/intraday-shadow-scoring.js):
 *   - DAYTRADE_INTRADAY_SCORE_ENABLED must be false/0 (production scoring OFF)
 *   - DAYTRADE_WORKER_ALLOW_MUTATION must not be true
 *   - TELEGRAM_ENABLED must be 0
 *
 * Anti-look-ahead entry rule
 *   A signal detected at snapshot T may only enter using the candidate price
 *   from the NEXT valid snapshot (strictly after T). The signal snapshot's own
 *   price is never reused as the executable entry. If no next valid price
 *   exists, the trade is marked unavailable — prices are NEVER invented.
 *
 * Determinism
 *   Outputs contain NO wall-clock timestamp. Every value is derived from the
 *   input files and the explicit CLI arguments, so reruns over the same input
 *   produce byte-identical output files (safe, idempotent reruns).
 *
 * Honesty
 *   Repeated snapshot observations of the same persistent candidate are collapsed
 *   into ONE independent trade. The summary explicitly refuses to claim
 *   profitability and warns when the independent-trade sample is small.
 */

const path = require('node:path');

// Reuse the shadow evaluator's PURE primitives (IO, safety, path guards, numeric
// helpers). That module imports NO Supabase / Telegram / DB-mutation code — it
// only borrows the shared production-scoring gate — so requiring it here keeps a
// single source of truth without pulling in any unsafe dependency.
const shadow = require('./intraday-shadow-scoring');

const GENERATOR_VERSION = 'intraday-shadow-trade-backtest-v1.0';

// -----------------------------------------------------------------------------
// Candidate rule (the ONLY rule evaluated as a production candidate)
// -----------------------------------------------------------------------------
const CANDIDATE_CONFIRMATION_STATE = 'CONFIRMED';
const CANDIDATE_CONFIRMED_RANK = 1; // rank 2..5 are explicitly NOT evaluated
const DEFAULT_MIN_SCORE = 16;

// -----------------------------------------------------------------------------
// Exit scenarios (evaluated SEPARATELY)
// -----------------------------------------------------------------------------
const EOD_TIME = '16:00';
const PLUS_60_MINUTES = 60;
const EXIT_SCENARIOS = Object.freeze([
  { key: 'PLUS_60M', kind: 'offset', minutes: PLUS_60_MINUTES, label: '+60 minutes' },
  { key: 'EOD', kind: 'clock', time: EOD_TIME, label: 'end-of-day 16:00' }
]);

// -----------------------------------------------------------------------------
// Trading-cost scenarios (total ROUND-TRIP cost, in basis points)
// -----------------------------------------------------------------------------
// Deliberately NOT a specific broker's fee — configurable scenarios only.
const DEFAULT_COST_SCENARIOS_BPS = Object.freeze([0, 30, 50]);
const DEFAULT_PRIMARY_COST_BPS = 30;

// A round trip of N bps reduces the net return by N/100 percentage points.
function bpsToPct(bps) {
  return Number(bps) / 100;
}

// -----------------------------------------------------------------------------
// Classification / warning thresholds
// -----------------------------------------------------------------------------
// Below this many INDEPENDENT trades the sample is too small to draw any
// conclusion — the summary emits a prominent warning and makes no claim.
const SMALL_SAMPLE_THRESHOLD = 5;
// Neutral band for win/loss/neutral classification (percentage points). 0 =>
// only an exactly-flat return is neutral. Configurable via opts.neutralBandPct.
const DEFAULT_NEUTRAL_BAND_PCT = 0;

// -----------------------------------------------------------------------------
// Numeric helpers (rounding is fixed + deterministic for byte-identical reruns)
// -----------------------------------------------------------------------------
function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

// -----------------------------------------------------------------------------
// Time helpers (HH:MM only; deterministic, no timezone / clock dependency)
// -----------------------------------------------------------------------------
function timeToMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minutesToTime(mins) {
  if (!Number.isFinite(mins) || mins < 0 || mins >= 24 * 60) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// -----------------------------------------------------------------------------
// Safe output-path guard against BOTH source roots
// -----------------------------------------------------------------------------
/**
 * Refuse an output root that equals, sits inside, or contains EITHER source
 * root (the shadow-scoring root or the sample root). Guarantees the backtest
 * can never overwrite a source file. Throws on an unsafe configuration.
 */
function assertSafeOutputRoots(outputRoot, sourceRoots) {
  for (const src of sourceRoots) {
    if (!src) continue;
    // shadow.assertSafeOutputRoot(inputRoot, outputRoot) throws on equal / nested
    // in either direction.
    shadow.assertSafeOutputRoot(src, outputRoot);
  }
  return true;
}

// -----------------------------------------------------------------------------
// Price map (built from the intraday sample candidates — the "candidate price")
// -----------------------------------------------------------------------------
/**
 * Build a price lookup for one date from the sample-root candidates.jsonl.
 *
 *   ticker -> Map(HH:MM -> { price, source })
 *
 * A snapshot is "valid" for a ticker only when a finite candidate price exists
 * there. current_price is preferred; reference_entry_price is the fallback. No
 * price is ever synthesised.
 *
 * @returns {{priceByTicker:Map, snapshotTimes:string[], malformed:number, missing:boolean}}
 */
async function buildSamplePriceMap(sampleDateDir) {
  const read = await shadow.readJsonlSafe(path.join(sampleDateDir, 'candidates.jsonl'));
  const priceByTicker = new Map();
  const snapshotSet = new Set();

  for (const rec of read.records) {
    if (!rec || typeof rec !== 'object') continue;
    const time = typeof rec.scheduled_time === 'string' ? rec.scheduled_time.trim() : '';
    if (!time || timeToMinutes(time) === null) continue;
    snapshotSet.add(time);

    const ticker = shadow.safeTicker(rec.ticker);
    if (!ticker) continue;

    const current = shadow.num(rec.current_price);
    const refEntry = shadow.num(rec.reference_entry_price);
    let price = null;
    let source = null;
    if (Number.isFinite(current)) { price = current; source = 'current_price'; }
    else if (Number.isFinite(refEntry)) { price = refEntry; source = 'reference_entry_price'; }
    if (price === null) continue; // no valid price at this snapshot for this ticker

    if (!priceByTicker.has(ticker)) priceByTicker.set(ticker, new Map());
    // Keep the FIRST valid price seen for a (ticker, time) pair; source files are
    // deterministic so this is stable.
    if (!priceByTicker.get(ticker).has(time)) {
      priceByTicker.get(ticker).set(time, { price, source });
    }
  }

  const snapshotTimes = Array.from(snapshotSet).sort((a, b) => timeToMinutes(a) - timeToMinutes(b));
  return { priceByTicker, snapshotTimes, malformed: read.malformed, missing: read.missing };
}

/**
 * Ordered list of snapshot times (strictly after `afterTime`) at which `ticker`
 * has a valid candidate price. Used for next-valid-snapshot entry/exit lookups.
 */
function validTimesForTickerAfter(priceByTicker, ticker, afterMinutes) {
  const m = priceByTicker.get(ticker);
  if (!m) return [];
  return Array.from(m.keys())
    .filter((t) => timeToMinutes(t) > afterMinutes)
    .sort((a, b) => timeToMinutes(a) - timeToMinutes(b));
}

function priceAt(priceByTicker, ticker, time) {
  const m = priceByTicker.get(ticker);
  if (!m) return null;
  const p = m.get(time);
  return p && Number.isFinite(p.price) ? p : null;
}

// -----------------------------------------------------------------------------
// Signal detection + deduplication
// -----------------------------------------------------------------------------
/**
 * From one date's shadow-scores.jsonl rows, select the qualifying candidate
 * signals and DEDUPLICATE them to at most ONE per ticker per day.
 *
 * A row qualifies when it matches the candidate rule exactly:
 *   confirmation_state === CONFIRMED, confirmed_rank === 1, shadow_score >= minScore.
 *
 * Persistent signals (the same ticker qualifying across many consecutive
 * snapshots) collapse to the EARLIEST qualifying snapshot — the original signal
 * time. Rank 2..5 rows are ignored entirely (never evaluated as candidates).
 *
 * @returns {{signals:Array, qualifyingRowCount:number, rejectedByRank:number,
 *            rejectedByScore:number, rejectedByState:number}}
 */
function detectSignals(scoreRows, minScore) {
  const byTicker = new Map();
  let qualifyingRowCount = 0;
  let rejectedByRank = 0;
  let rejectedByScore = 0;
  let rejectedByState = 0;

  for (const row of scoreRows) {
    if (!row || typeof row !== 'object') continue;
    const ticker = shadow.safeTicker(row.ticker);
    const snapshot = typeof row.snapshot === 'string' ? row.snapshot.trim() : '';
    if (!ticker || !snapshot || timeToMinutes(snapshot) === null) continue;

    const state = String(row.confirmation_state || '').trim().toUpperCase();
    const rank = shadow.num(row.confirmed_rank);
    const score = shadow.num(row.shadow_score);

    // Evaluate the candidate rule. Track why non-matching rows are rejected so
    // the summary can honestly report rank 2..5 / low-score exclusions.
    if (state !== CANDIDATE_CONFIRMATION_STATE) { rejectedByState++; continue; }
    if (rank !== CANDIDATE_CONFIRMED_RANK) { rejectedByRank++; continue; }
    if (!(Number.isFinite(score) && score >= minScore)) { rejectedByScore++; continue; }

    qualifyingRowCount++;

    // Deduplicate: keep the earliest qualifying snapshot for this ticker (the
    // original signal). A later persistent re-observation never creates a new
    // entry.
    const existing = byTicker.get(ticker);
    if (!existing || timeToMinutes(snapshot) < timeToMinutes(existing.signal_time)) {
      byTicker.set(ticker, {
        ticker,
        signal_time: snapshot,
        signal_score: round4(score),
        confirmed_rank: rank,
        confirmation_state: state,
        confirmation_reason: row.confirmation_reason || null,
        persistent_snapshot_count: 1
      });
    }
  }

  // Count how many snapshots each surviving signal persisted for (documentation
  // only — proves repeated observations collapse into one independent trade).
  const persistCount = new Map();
  for (const row of scoreRows) {
    if (!row || typeof row !== 'object') continue;
    const ticker = shadow.safeTicker(row.ticker);
    if (!byTicker.has(ticker)) continue;
    const state = String(row.confirmation_state || '').trim().toUpperCase();
    const rank = shadow.num(row.confirmed_rank);
    const score = shadow.num(row.shadow_score);
    if (state === CANDIDATE_CONFIRMATION_STATE && rank === CANDIDATE_CONFIRMED_RANK &&
        Number.isFinite(score) && score >= minScore) {
      persistCount.set(ticker, (persistCount.get(ticker) || 0) + 1);
    }
  }
  for (const sig of byTicker.values()) {
    sig.persistent_snapshot_count = persistCount.get(sig.ticker) || 1;
  }

  const signals = Array.from(byTicker.values())
    .sort((a, b) => (timeToMinutes(a.signal_time) - timeToMinutes(b.signal_time)) || a.ticker.localeCompare(b.ticker));

  return { signals, qualifyingRowCount, rejectedByRank, rejectedByScore, rejectedByState };
}

// -----------------------------------------------------------------------------
// Entry selection (next valid snapshot only — never the signal snapshot)
// -----------------------------------------------------------------------------
/**
 * Resolve the executable entry for a signal: the candidate price at the NEXT
 * valid snapshot strictly after the signal time. Returns an unavailable result
 * (never a synthesised price) when no such snapshot exists.
 */
function resolveEntry(priceByTicker, signal) {
  const signalMinutes = timeToMinutes(signal.signal_time);
  const nextTimes = validTimesForTickerAfter(priceByTicker, signal.ticker, signalMinutes);
  if (!nextTimes.length) {
    return { available: false, reason: 'NO_NEXT_VALID_SNAPSHOT_PRICE' };
  }
  const entryTime = nextTimes[0];
  const p = priceAt(priceByTicker, signal.ticker, entryTime);
  if (!p) {
    return { available: false, reason: 'NO_NEXT_VALID_SNAPSHOT_PRICE' };
  }
  // Guard: never reuse the signal snapshot's own price as the entry.
  if (timeToMinutes(entryTime) <= signalMinutes) {
    return { available: false, reason: 'NO_NEXT_VALID_SNAPSHOT_PRICE' };
  }
  return {
    available: true,
    entry_time: entryTime,
    entry_price: p.price,
    entry_price_source: p.source
  };
}

// -----------------------------------------------------------------------------
// Exit resolution (exact snapshot; next-valid ONLY when the policy is enabled)
// -----------------------------------------------------------------------------
/**
 * Resolve one exit scenario for an entered trade.
 *
 * @param opts.allowNextValidFallback  when true, and the exact exit snapshot is
 *   unavailable, use the next valid snapshot at/after the target and RECORD that
 *   policy explicitly. When false, an unavailable exact snapshot => unavailable.
 */
function resolveExit(priceByTicker, ticker, entryTime, scenario, opts) {
  const entryMinutes = timeToMinutes(entryTime);
  let targetTime;
  let targetMinutes;
  if (scenario.kind === 'offset') {
    targetMinutes = entryMinutes + scenario.minutes;
    targetTime = minutesToTime(targetMinutes);
  } else {
    targetTime = scenario.time;
    targetMinutes = timeToMinutes(scenario.time);
  }

  const base = { exit_scenario: scenario.key, exit_target_time: targetTime };

  if (targetTime === null || targetMinutes === null) {
    return Object.assign(base, { available: false, unavailable_reason: 'INVALID_EXIT_TARGET_TIME', exit_time: null, exit_price: null, exit_policy: null });
  }
  if (targetMinutes <= entryMinutes) {
    // e.g. an EOD exit for an entry that is already at/after 16:00.
    return Object.assign(base, { available: false, unavailable_reason: 'EXIT_TARGET_NOT_AFTER_ENTRY', exit_time: null, exit_price: null, exit_policy: null });
  }

  // 1. Exact target snapshot.
  const exact = priceAt(priceByTicker, ticker, targetTime);
  if (exact) {
    return Object.assign(base, {
      available: true,
      exit_time: targetTime,
      exit_price: exact.price,
      exit_price_source: exact.source,
      exit_policy: 'exact'
    });
  }

  // 2. Next-valid fallback — ONLY when the policy is explicitly enabled, and the
  //    chosen snapshot is recorded so the substitution is never silent.
  if (opts && opts.allowNextValidFallback) {
    const laterTimes = validTimesForTickerAfter(priceByTicker, ticker, targetMinutes - 1)
      .filter((t) => timeToMinutes(t) >= targetMinutes);
    if (laterTimes.length) {
      const chosen = laterTimes[0];
      const p = priceAt(priceByTicker, ticker, chosen);
      if (p) {
        return Object.assign(base, {
          available: true,
          exit_time: chosen,
          exit_price: p.price,
          exit_price_source: p.source,
          exit_policy: 'next_valid_snapshot'
        });
      }
    }
    return Object.assign(base, { available: false, unavailable_reason: 'NO_VALID_EXIT_SNAPSHOT_AT_OR_AFTER_TARGET', exit_time: null, exit_price: null, exit_policy: null });
  }

  // 3. Policy disabled: an unavailable exact snapshot is unavailable (never invented).
  return Object.assign(base, { available: false, unavailable_reason: 'EXACT_EXIT_SNAPSHOT_UNAVAILABLE', exit_time: null, exit_price: null, exit_policy: null });
}

// -----------------------------------------------------------------------------
// Return + cost computation
// -----------------------------------------------------------------------------
function grossReturnPct(entryPrice, exitPrice) {
  if (!Number.isFinite(entryPrice) || entryPrice === 0 || !Number.isFinite(exitPrice)) return null;
  return ((exitPrice - entryPrice) / entryPrice) * 100;
}

/**
 * Build the per-cost-scenario net-return breakdown for a resolved gross return.
 * Net = gross - round-trip cost (in percentage points). Gross and net are kept
 * strictly separate.
 */
function buildCostScenarios(gross, costScenariosBps) {
  return costScenariosBps.map((bps) => {
    const costPct = bpsToPct(bps);
    return {
      cost_bps: bps,
      trading_cost_pct: round4(costPct),
      net_return_pct: gross === null ? null : round4(gross - costPct)
    };
  });
}

// -----------------------------------------------------------------------------
// Build the trade records for one signal (one record per exit scenario)
// -----------------------------------------------------------------------------
function buildTradeRecordsForSignal(date, signal, entry, priceByTicker, opts) {
  const records = [];
  const costScenariosBps = opts.costScenariosBps;
  const primaryCostBps = opts.primaryCostBps;

  for (const scenario of EXIT_SCENARIOS) {
    const common = {
      date,
      ticker: signal.ticker,
      signal_time: signal.signal_time,
      signal_snapshot: signal.signal_time,
      signal_score: signal.signal_score,
      confirmed_rank: signal.confirmed_rank,
      confirmation_state: signal.confirmation_state,
      confirmation_reason: signal.confirmation_reason,
      persistent_snapshot_count: signal.persistent_snapshot_count,
      exit_scenario: scenario.key,
      exit_scenario_label: scenario.label
    };

    if (!entry.available) {
      records.push(Object.assign(common, {
        entry_time: null,
        entry_price: null,
        entry_price_source: null,
        exit_target_time: null,
        exit_time: null,
        exit_price: null,
        exit_price_source: null,
        exit_policy: null,
        hold_minutes: null,
        available: false,
        unavailable_reason: entry.reason,
        gross_return_pct: null,
        trading_cost_pct: null,
        net_return_pct: null,
        cost_scenarios: buildCostScenarios(null, costScenariosBps)
      }));
      continue;
    }

    const exit = resolveExit(priceByTicker, signal.ticker, entry.entry_time, scenario, opts);
    const gross = exit.available ? grossReturnPct(entry.entry_price, exit.exit_price) : null;
    const costScenarios = buildCostScenarios(gross, costScenariosBps);
    const primary = costScenarios.find((c) => c.cost_bps === primaryCostBps) || costScenarios[0] || null;

    records.push(Object.assign(common, {
      entry_time: entry.entry_time,
      entry_price: entry.entry_price,
      entry_price_source: entry.entry_price_source,
      exit_target_time: exit.exit_target_time,
      exit_time: exit.exit_time,
      exit_price: exit.exit_price,
      exit_price_source: exit.exit_price_source || null,
      exit_policy: exit.exit_policy,
      hold_minutes: exit.available && exit.exit_time
        ? timeToMinutes(exit.exit_time) - timeToMinutes(entry.entry_time)
        : null,
      available: !!exit.available,
      unavailable_reason: exit.available ? null : exit.unavailable_reason,
      gross_return_pct: gross === null ? null : round4(gross),
      trading_cost_pct: primary ? primary.trading_cost_pct : null,
      net_return_pct: primary ? primary.net_return_pct : null,
      cost_scenarios: costScenarios
    }));
  }

  return records;
}

// -----------------------------------------------------------------------------
// One-position-at-a-time portfolio filter (configurable mode)
// -----------------------------------------------------------------------------
/**
 * Given the entered independent trades, greedily admit a non-overlapping subset
 * such that at most ONE position is open at any time. Positions are considered
 * in chronological entry order (ties broken by ticker). A trade's occupancy
 * window is [entry, occupancyExit); occupancyExit prefers the resolved +60m
 * exit, then the resolved EOD exit, then a nominal entry+60m when neither
 * resolved (so an unresolved-exit trade still blocks the slot honestly).
 *
 * @param enteredTrades Array of { signal, entry, exitsByScenario }
 * @returns {{admitted:Set<string>, excluded:Array}} keyed by ticker (unique/day)
 */
function applyOnePositionMode(enteredTrades) {
  const ordered = enteredTrades.slice().sort((a, b) => {
    const am = timeToMinutes(a.entry.entry_time);
    const bm = timeToMinutes(b.entry.entry_time);
    return (am - bm) || a.signal.ticker.localeCompare(b.signal.ticker);
  });

  const admitted = new Set();
  const excluded = [];
  let openUntil = -Infinity;

  for (const t of ordered) {
    const entryMinutes = timeToMinutes(t.entry.entry_time);
    if (entryMinutes >= openUntil) {
      admitted.add(t.signal.ticker);
      openUntil = occupancyExitMinutes(t);
    } else {
      excluded.push({
        ticker: t.signal.ticker,
        entry_time: t.entry.entry_time,
        reason: 'ONE_POSITION_MODE_OVERLAP',
        blocked_until: minutesToTime(openUntil)
      });
    }
  }
  return { admitted, excluded };
}

function occupancyExitMinutes(t) {
  const plus60 = t.exitsByScenario.PLUS_60M;
  const eod = t.exitsByScenario.EOD;
  if (plus60 && plus60.available && plus60.exit_time) return timeToMinutes(plus60.exit_time);
  if (eod && eod.available && eod.exit_time) return timeToMinutes(eod.exit_time);
  return timeToMinutes(t.entry.entry_time) + PLUS_60_MINUTES;
}

// -----------------------------------------------------------------------------
// Metrics (computed per exit scenario × cost scenario over RESOLVED trades)
// -----------------------------------------------------------------------------
/**
 * @param entries Array of { date, ticker, entry_time, gross_return_pct,
 *                            net_return_pct } (already filtered to one exit
 *                            scenario / cost scenario and RESOLVED).
 */
function computeMetrics(entries, neutralBand) {
  const n = entries.length;
  const nets = entries.map((e) => e.net_return_pct);
  const grosses = entries.map((e) => e.gross_return_pct);

  const band = Number.isFinite(neutralBand) ? neutralBand : 0;
  const classify = (v) => (v > band ? 'win' : (v < -band ? 'loss' : 'neutral'));

  let win = 0, loss = 0, neutral = 0;
  let grossWin = 0;
  for (const e of entries) {
    const c = classify(e.net_return_pct);
    if (c === 'win') win++; else if (c === 'loss') loss++; else neutral++;
    if (classify(e.gross_return_pct) === 'win') grossWin++;
  }

  // Profit factor from NET returns.
  let grossProfit = 0;
  let grossLoss = 0;
  for (const v of nets) {
    if (v > 0) grossProfit += v;
    else if (v < 0) grossLoss += -v;
  }
  let profitFactor = null;
  let profitFactorNote = null;
  if (grossLoss > 0) {
    profitFactor = round4(grossProfit / grossLoss);
  } else if (grossProfit > 0) {
    profitFactorNote = 'no_losing_trades_profit_factor_undefined';
  } else {
    profitFactorNote = 'no_resolved_pnl';
  }

  // Cumulative (no compounding) = sum of net returns; compounded = product.
  const cumulativeNoCompound = nets.reduce((s, v) => s + v, 0);
  let equity = 1;
  for (const v of nets) equity *= (1 + v / 100);
  const compounded = (equity - 1) * 100;

  // Max drawdown on the ordered compounded equity curve (chronological by entry).
  const ordered = entries.slice().sort((a, b) =>
    (timeToMinutes(a.entry_time) - timeToMinutes(b.entry_time)) ||
    String(a.date).localeCompare(String(b.date)) ||
    a.ticker.localeCompare(b.ticker));
  let eq = 1, peak = 1, maxDD = 0;
  let cum = 0, cumPeak = 0, maxDDsimple = 0;
  for (const e of ordered) {
    eq *= (1 + e.net_return_pct / 100);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    cum += e.net_return_pct;
    if (cum > cumPeak) cumPeak = cum;
    const ddSimple = cumPeak - cum;
    if (ddSimple > maxDDsimple) maxDDsimple = ddSimple;
  }

  // Best / worst trade by net return.
  let best = null;
  let worst = null;
  for (const e of entries) {
    const info = { date: e.date, ticker: e.ticker, entry_time: e.entry_time, net_return_pct: e.net_return_pct, gross_return_pct: e.gross_return_pct };
    if (!best || e.net_return_pct > best.net_return_pct) best = info;
    if (!worst || e.net_return_pct < worst.net_return_pct) worst = info;
  }

  return {
    resolved_trades: n,
    win_count: win,
    loss_count: loss,
    neutral_count: neutral,
    gross_win_rate_pct: n ? round4((grossWin / n) * 100) : null,
    net_win_rate_pct: n ? round4((win / n) * 100) : null,
    avg_gross_return_pct: n ? round4(shadow.mean(grosses)) : null,
    avg_net_return_pct: n ? round4(shadow.mean(nets)) : null,
    median_net_return_pct: n ? round4(median(nets)) : null,
    profit_factor: profitFactor,
    profit_factor_note: profitFactorNote,
    cumulative_net_return_pct_no_compounding: n ? round4(cumulativeNoCompound) : null,
    compounded_net_return_pct: n ? round4(compounded) : null,
    max_drawdown_pct: round4(maxDD * 100),
    max_drawdown_pct_no_compounding: round4(maxDDsimple),
    best_trade: best,
    worst_trade: worst
  };
}

// -----------------------------------------------------------------------------
// Core evaluation for one date (pure — no writes)
// -----------------------------------------------------------------------------
async function evaluateDate(shadowDateDir, sampleDateDir, dateStr, opts) {
  const scoresRead = await shadow.readJsonlSafe(path.join(shadowDateDir, 'shadow-scores.jsonl'));
  const priceMap = await buildSamplePriceMap(sampleDateDir);

  const missing = [];
  if (scoresRead.missing) missing.push('shadow-scores.jsonl');
  if (priceMap.missing) missing.push('candidates.jsonl');

  const detection = detectSignals(scoresRead.records, opts.minScore);

  // Resolve entries + exits for every deduplicated signal.
  const enteredTrades = []; // { signal, entry, exitsByScenario }
  const signalOutcomes = []; // one per signal (entry availability)
  for (const signal of detection.signals) {
    const entry = resolveEntry(priceMap.priceByTicker, signal);
    const records = buildTradeRecordsForSignal(dateStr, signal, entry, priceMap.priceByTicker, opts);
    const exitsByScenario = {};
    for (const r of records) exitsByScenario[r.exit_scenario] = r;
    signalOutcomes.push({ signal, entry, records, exitsByScenario });
    if (entry.available) enteredTrades.push({ signal, entry, exitsByScenario });
  }

  return {
    date: dateStr,
    missing_files: missing,
    malformed: {
      shadow_scores_lines: scoresRead.malformed,
      sample_candidate_lines: priceMap.malformed
    },
    detection,
    signalOutcomes,
    enteredTrades,
    snapshotTimes: priceMap.snapshotTimes
  };
}

// -----------------------------------------------------------------------------
// Summary + comparison builders
// -----------------------------------------------------------------------------
const SAFETY_BLOCK = Object.freeze({
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
  TELEGRAM_ENABLED: '0',
  production_scoring_enabled: false,
  mutations_performed: false,
  telegram_sent: false,
  supabase_writes: false,
  portfolio_mutated: false,
  recommendations_mutated: false,
  source_files_rewritten: false
});

/**
 * Collect resolved entries for a given exit scenario + cost, restricted to an
 * optional admitted-ticker set (for the one-position portfolio).
 */
function collectResolved(allTradeRecords, scenarioKey, costBps, admittedFilter) {
  const out = [];
  for (const r of allTradeRecords) {
    if (r.exit_scenario !== scenarioKey) continue;
    if (!r.available) continue;
    if (admittedFilter && !admittedFilter(r)) continue;
    const cs = r.cost_scenarios.find((c) => c.cost_bps === costBps);
    if (!cs || cs.net_return_pct === null || r.gross_return_pct === null) continue;
    out.push({
      date: r.date,
      ticker: r.ticker,
      entry_time: r.entry_time,
      gross_return_pct: r.gross_return_pct,
      net_return_pct: cs.net_return_pct
    });
  }
  return out;
}

function buildScenarioMetrics(allTradeRecords, opts, admittedFilter) {
  const byExit = {};
  for (const scenario of EXIT_SCENARIOS) {
    const byCost = {};
    for (const bps of opts.costScenariosBps) {
      const resolved = collectResolved(allTradeRecords, scenario.key, bps, admittedFilter);
      byCost[String(bps)] = computeMetrics(resolved, opts.neutralBandPct);
    }
    byExit[scenario.key] = {
      label: scenario.label,
      primary_cost_bps: opts.primaryCostBps,
      primary: byCost[String(opts.primaryCostBps)] || null,
      by_cost_bps: byCost
    };
  }
  return byExit;
}

function buildSummary(evaluations, opts) {
  const allTradeRecords = [];
  for (const ev of evaluations) {
    for (const so of ev.signalOutcomes) {
      for (const r of so.records) allTradeRecords.push(r);
    }
  }

  // Independent trades = deduped signals that ENTERED (one per ticker per day).
  const enteredSignals = [];
  const unavailableSignals = [];
  for (const ev of evaluations) {
    for (const so of ev.signalOutcomes) {
      if (so.entry.available) enteredSignals.push({ date: ev.date, signal: so.signal, entry: so.entry, exitsByScenario: so.exitsByScenario });
      else unavailableSignals.push({ date: ev.date, ticker: so.signal.ticker, signal_time: so.signal.signal_time, reason: so.entry.reason });
    }
  }

  const uniqueIndependentTrades = enteredSignals.length;

  // trades per date / ticker (independent trades).
  const tradesPerDate = {};
  const tradesPerTicker = {};
  for (const e of enteredSignals) {
    tradesPerDate[e.date] = (tradesPerDate[e.date] || 0) + 1;
    tradesPerTicker[e.signal.ticker] = (tradesPerTicker[e.signal.ticker] || 0) + 1;
  }
  const tradesPerDateSorted = {};
  Object.keys(tradesPerDate).sort().forEach((d) => { tradesPerDateSorted[d] = tradesPerDate[d]; });
  const tradesPerTickerSorted = {};
  Object.keys(tradesPerTicker).sort((a, b) => (tradesPerTicker[b] - tradesPerTicker[a]) || a.localeCompare(b))
    .forEach((t) => { tradesPerTickerSorted[t] = tradesPerTicker[t]; });

  // Ticker concentration (share of independent trades + HHI).
  const distinctTickers = Object.keys(tradesPerTicker).length;
  const shares = {};
  let hhi = 0;
  let maxShare = 0;
  for (const t of Object.keys(tradesPerTicker)) {
    const share = uniqueIndependentTrades ? tradesPerTicker[t] / uniqueIndependentTrades : 0;
    shares[t] = round4(share);
    hhi += share * share;
    if (share > maxShare) maxShare = share;
  }

  // Full-independent-trade metrics.
  const byExitScenario = buildScenarioMetrics(allTradeRecords, opts, null);

  // Exit-scenario comparison at the primary cost.
  const exitComparison = {
    primary_cost_bps: opts.primaryCostBps,
    PLUS_60M: byExitScenario.PLUS_60M.primary,
    EOD: byExitScenario.EOD.primary
  };

  // Cost sensitivity (per exit scenario, headline metrics at each cost).
  const costSensitivity = {};
  for (const scenario of EXIT_SCENARIOS) {
    costSensitivity[scenario.key] = {};
    for (const bps of opts.costScenariosBps) {
      const m = byExitScenario[scenario.key].by_cost_bps[String(bps)];
      costSensitivity[scenario.key][String(bps)] = {
        resolved_trades: m.resolved_trades,
        net_win_rate_pct: m.net_win_rate_pct,
        avg_net_return_pct: m.avg_net_return_pct,
        cumulative_net_return_pct_no_compounding: m.cumulative_net_return_pct_no_compounding,
        compounded_net_return_pct: m.compounded_net_return_pct,
        profit_factor: m.profit_factor,
        max_drawdown_pct: m.max_drawdown_pct
      };
    }
  }

  // Result by date (per date, per exit scenario at primary cost).
  const resultByDate = {};
  for (const ev of evaluations) {
    resultByDate[ev.date] = {};
    for (const scenario of EXIT_SCENARIOS) {
      const resolved = collectResolved(
        allTradeRecords.filter((r) => r.date === ev.date), scenario.key, opts.primaryCostBps, null);
      const m = computeMetrics(resolved, opts.neutralBandPct);
      resultByDate[ev.date][scenario.key] = {
        resolved_trades: m.resolved_trades,
        net_win_rate_pct: m.net_win_rate_pct,
        avg_net_return_pct: m.avg_net_return_pct,
        cumulative_net_return_pct_no_compounding: m.cumulative_net_return_pct_no_compounding
      };
    }
  }

  // Optional one-position-at-a-time portfolio.
  let singlePositionPortfolio = null;
  if (opts.onePositionMode) {
    const admittedByDate = new Map(); // date -> { admitted:Set, excluded:[] }
    for (const ev of evaluations) {
      admittedByDate.set(ev.date, applyOnePositionMode(ev.enteredTrades));
    }
    const admittedFilter = (r) => {
      const res = admittedByDate.get(r.date);
      return res && res.admitted.has(r.ticker);
    };
    const admittedCount = Array.from(admittedByDate.values()).reduce((s, r) => s + r.admitted.size, 0);
    const excluded = [];
    for (const [date, res] of admittedByDate.entries()) {
      for (const ex of res.excluded) excluded.push(Object.assign({ date }, ex));
    }
    singlePositionPortfolio = {
      enabled: true,
      occupancy_basis: 'prefers resolved +60m exit, then EOD exit, then nominal entry+60m',
      admitted_position_count: admittedCount,
      excluded_overlap_count: excluded.length,
      excluded_overlaps: excluded,
      by_exit_scenario: buildScenarioMetrics(allTradeRecords, opts, admittedFilter)
    };
  }

  // Warnings.
  const warnings = [];
  if (uniqueIndependentTrades < opts.smallSampleThreshold) {
    warnings.push('SMALL_INDEPENDENT_TRADE_SAMPLE: only ' + uniqueIndependentTrades +
      ' independent trade(s) (< ' + opts.smallSampleThreshold +
      '); results are NOT statistically meaningful and NO profitability is claimed.');
  }
  if (unavailableSignals.length) {
    warnings.push('UNAVAILABLE_ENTRIES: ' + unavailableSignals.length +
      ' qualifying signal(s) had no next valid snapshot price and were marked unavailable (no price invented).');
  }
  const missingAny = evaluations.some((ev) => ev.missing_files.length);
  if (missingAny) {
    warnings.push('MISSING_SOURCE_FILES: one or more dates were missing shadow-scores.jsonl or candidates.jsonl; see per_date_diagnostics.');
  }

  return {
    generator_version: GENERATOR_VERSION,
    mode: 'shadow_trade_backtest_only',
    timezone: 'Asia/Jakarta',
    dates: evaluations.map((e) => e.date),

    parameters: {
      candidate_rule: {
        confirmation_state: CANDIDATE_CONFIRMATION_STATE,
        confirmed_rank: CANDIDATE_CONFIRMED_RANK,
        min_shadow_score: opts.minScore,
        ranks_2_to_5_evaluated: false
      },
      exit_scenarios: EXIT_SCENARIOS.map((s) => ({ key: s.key, label: s.label })),
      cost_scenarios_bps: opts.costScenariosBps,
      primary_cost_bps: opts.primaryCostBps,
      exit_fallback_next_valid: !!opts.allowNextValidFallback,
      one_position_mode: !!opts.onePositionMode,
      neutral_band_pct: opts.neutralBandPct,
      small_sample_threshold: opts.smallSampleThreshold
    },

    safety: SAFETY_BLOCK,

    counts: {
      unique_independent_trades: uniqueIndependentTrades,
      entered_trades: uniqueIndependentTrades,
      unavailable_entry_signals: unavailableSignals.length,
      total_qualifying_signals: enteredSignals.length + unavailableSignals.length,
      total_qualifying_snapshot_rows: evaluations.reduce((s, e) => s + e.detection.qualifyingRowCount, 0),
      rejected_rows_by_state: evaluations.reduce((s, e) => s + e.detection.rejectedByState, 0),
      rejected_rows_by_rank_2_to_5: evaluations.reduce((s, e) => s + e.detection.rejectedByRank, 0),
      rejected_rows_by_low_score: evaluations.reduce((s, e) => s + e.detection.rejectedByScore, 0)
    },

    unavailable_entries: unavailableSignals,

    trades_per_date: tradesPerDateSorted,
    trades_per_ticker: tradesPerTickerSorted,
    ticker_concentration: {
      distinct_tickers: distinctTickers,
      max_ticker_share: round4(maxShare),
      herfindahl_hirschman_index: round4(hhi),
      share_by_ticker: shares
    },

    by_exit_scenario: byExitScenario,
    exit_scenario_comparison_plus60_vs_eod: exitComparison,
    cost_sensitivity_0_30_50_bps: costSensitivity,
    result_by_date: resultByDate,

    single_position_portfolio: singlePositionPortfolio,

    per_date_diagnostics: evaluations.map((e) => ({
      date: e.date,
      missing_files: e.missing_files,
      malformed: e.malformed,
      snapshot_times: e.snapshotTimes,
      qualifying_signals: e.detection.signals.length
    })),

    warnings,

    disclaimer: 'Shadow backtest of repeated intraday snapshot observations collapsed into deduplicated independent trades. This measures how the CONFIRMED rank-1 rule would have behaved on already-collected shadow data ONLY. It does NOT claim profitability, is not investment advice, and small samples are explicitly flagged.'
  };
}

function buildCostComparison(summary, opts) {
  const byExit = {};
  for (const scenario of EXIT_SCENARIOS) {
    const perCost = {};
    const primary = summary.by_exit_scenario[scenario.key].by_cost_bps[String(opts.primaryCostBps)];
    for (const bps of opts.costScenariosBps) {
      const m = summary.by_exit_scenario[scenario.key].by_cost_bps[String(bps)];
      perCost[String(bps)] = {
        resolved_trades: m.resolved_trades,
        gross_win_rate_pct: m.gross_win_rate_pct,
        net_win_rate_pct: m.net_win_rate_pct,
        avg_gross_return_pct: m.avg_gross_return_pct,
        avg_net_return_pct: m.avg_net_return_pct,
        median_net_return_pct: m.median_net_return_pct,
        cumulative_net_return_pct_no_compounding: m.cumulative_net_return_pct_no_compounding,
        compounded_net_return_pct: m.compounded_net_return_pct,
        profit_factor: m.profit_factor,
        max_drawdown_pct: m.max_drawdown_pct,
        delta_net_vs_0bps_pct: (m.avg_net_return_pct !== null && summary.by_exit_scenario[scenario.key].by_cost_bps['0'].avg_net_return_pct !== null)
          ? round4(m.avg_net_return_pct - summary.by_exit_scenario[scenario.key].by_cost_bps['0'].avg_net_return_pct)
          : null
      };
    }
    byExit[scenario.key] = { label: scenario.label, by_cost_bps: perCost };
  }

  return {
    generator_version: GENERATOR_VERSION,
    mode: 'shadow_trade_backtest_only',
    dates: summary.dates,
    cost_scenarios_bps: opts.costScenariosBps,
    primary_cost_bps: opts.primaryCostBps,
    unique_independent_trades: summary.counts.unique_independent_trades,
    safety: SAFETY_BLOCK,
    by_exit_scenario: byExit,
    note: 'Round-trip trading cost applied uniformly as a reduction of net return (N bps => N/100 percentage points). Gross returns are identical across cost scenarios; only net returns differ. No specific broker fee is assumed.',
    warnings: summary.warnings
  };
}

// -----------------------------------------------------------------------------
// Output writing (atomic; never touches source files)
// -----------------------------------------------------------------------------
function buildAllTradeRecords(evaluations, opts) {
  const records = [];
  for (const ev of evaluations) {
    for (const so of ev.signalOutcomes) {
      for (const r of so.records) records.push(r);
    }
  }
  // Deterministic order: date, entry/signal time, ticker, exit scenario.
  const scenarioOrder = { PLUS_60M: 0, EOD: 1 };
  records.sort((a, b) =>
    String(a.date).localeCompare(String(b.date)) ||
    (timeToMinutes(a.signal_time) - timeToMinutes(b.signal_time)) ||
    a.ticker.localeCompare(b.ticker) ||
    ((scenarioOrder[a.exit_scenario] || 0) - (scenarioOrder[b.exit_scenario] || 0)));

  // Annotate one-position membership when the mode is enabled.
  if (opts.onePositionMode) {
    const admittedByDate = new Map();
    for (const ev of evaluations) admittedByDate.set(ev.date, applyOnePositionMode(ev.enteredTrades).admitted);
    for (const r of records) {
      const admitted = admittedByDate.get(r.date);
      r.in_single_position_portfolio = !!(r.available && r.entry_time && admitted && admitted.has(r.ticker));
    }
  }
  return records;
}

async function writeOutputs(outputRoot, tradeRecords, summary, comparison) {
  const tradesPath = path.join(outputRoot, 'trades.jsonl');
  const summaryPath = path.join(outputRoot, 'summary.json');
  const comparisonPath = path.join(outputRoot, 'comparison-cost-scenarios.json');

  await shadow.atomicWriteFile(tradesPath, shadow.toJsonl(tradeRecords));
  await shadow.atomicWriteFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  await shadow.atomicWriteFile(comparisonPath, JSON.stringify(comparison, null, 2) + '\n');

  return { trades: tradesPath, summary: summaryPath, comparison: comparisonPath };
}

// -----------------------------------------------------------------------------
// Options normalisation
// -----------------------------------------------------------------------------
function normalizeOptions(opts) {
  opts = opts || {};
  let costScenariosBps = Array.isArray(opts.costScenariosBps) && opts.costScenariosBps.length
    ? opts.costScenariosBps.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0)
    : DEFAULT_COST_SCENARIOS_BPS.slice();
  // Deterministic, de-duplicated, ascending.
  costScenariosBps = Array.from(new Set(costScenariosBps)).sort((a, b) => a - b);
  if (!costScenariosBps.length) costScenariosBps = DEFAULT_COST_SCENARIOS_BPS.slice();

  let primaryCostBps = Number.isFinite(Number(opts.primaryCostBps)) ? Number(opts.primaryCostBps) : DEFAULT_PRIMARY_COST_BPS;
  if (!costScenariosBps.includes(primaryCostBps)) primaryCostBps = costScenariosBps[0];

  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : DEFAULT_MIN_SCORE;

  return {
    minScore,
    costScenariosBps,
    primaryCostBps,
    allowNextValidFallback: !!opts.allowNextValidFallback,
    onePositionMode: !!opts.onePositionMode,
    neutralBandPct: Number.isFinite(Number(opts.neutralBandPct)) ? Number(opts.neutralBandPct) : DEFAULT_NEUTRAL_BAND_PCT,
    smallSampleThreshold: Number.isFinite(Number(opts.smallSampleThreshold)) ? Number(opts.smallSampleThreshold) : SMALL_SAMPLE_THRESHOLD
  };
}

// -----------------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------------
/**
 * Run the full deduplicated intraday shadow-trade backtest.
 *
 * @param {object} rawOpts
 *   shadowRoot   required — root of live shadow-scoring outputs (<date>/shadow-scores.jsonl) [read-only]
 *   sampleRoot   required — root of intraday samples (<date>/candidates.jsonl) [read-only]
 *   outputRoot   required — root for backtest outputs (MUST be outside BOTH source roots)
 *   dates        required — explicit array of YYYY-MM-DD dates
 *   minScore, costScenariosBps, primaryCostBps, allowNextValidFallback,
 *   onePositionMode, neutralBandPct, smallSampleThreshold — optional
 *   env          optional — env object for safety checks (defaults to process.env)
 *   dryRun       optional — compute but do not write
 * @returns result object
 */
async function runBacktest(rawOpts) {
  rawOpts = rawOpts || {};
  const env = rawOpts.env || process.env;

  // 1. Safety gate — production scoring / mutation / telegram must be OFF.
  const safety = shadow.assertShadowSafety(env);
  if (!safety.safe) {
    return { status: 'safety_violation', errors: safety.errors };
  }

  // 2. Required arguments.
  const missing = [];
  if (!rawOpts.shadowRoot) missing.push('shadowRoot');
  if (!rawOpts.sampleRoot) missing.push('sampleRoot');
  if (!rawOpts.outputRoot) missing.push('outputRoot');
  if (!Array.isArray(rawOpts.dates) || !rawOpts.dates.length) missing.push('dates');
  if (missing.length) {
    return { status: 'error', errors: ['missing required argument(s): ' + missing.join(', ')] };
  }

  // 3. Safe output-path guard against BOTH source roots.
  try {
    assertSafeOutputRoots(rawOpts.outputRoot, [rawOpts.shadowRoot, rawOpts.sampleRoot]);
  } catch (e) {
    return { status: 'unsafe_output_path', errors: [e.message] };
  }

  // 4. Validate every requested date up front (strict YYYY-MM-DD real date).
  //    Explicit dates only — nothing is defaulted.
  const validated = [];
  for (const d of rawOpts.dates) {
    const v = shadow.validateDateFormat(d);
    if (!v.valid) {
      return { status: 'rejected', reason: v.reason, errors: ['invalid date: ' + JSON.stringify(d) + ' (' + v.reason + ')'] };
    }
    if (validated.includes(v.date)) {
      return { status: 'rejected', reason: 'duplicate_date', errors: ['duplicate date: ' + JSON.stringify(v.date)] };
    }
    validated.push(v.date);
  }

  const opts = normalizeOptions(rawOpts);

  // 5. Evaluate each date (pure).
  const evaluations = [];
  for (const date of validated) {
    const shadowDateDir = path.join(rawOpts.shadowRoot, date);
    const sampleDateDir = path.join(rawOpts.sampleRoot, date);
    evaluations.push(await evaluateDate(shadowDateDir, sampleDateDir, date, opts));
  }

  // 6. Build outputs.
  const tradeRecords = buildAllTradeRecords(evaluations, opts);
  const summary = buildSummary(evaluations, opts);
  const comparison = buildCostComparison(summary, opts);

  let outputs = null;
  if (!rawOpts.dryRun) {
    outputs = await writeOutputs(path.resolve(rawOpts.outputRoot), tradeRecords, summary, comparison);
  }

  return {
    status: 'success',
    dates: validated,
    trades: tradeRecords,
    summary,
    comparison,
    outputs,
    enforced_safety: {
      DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
      DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
      TELEGRAM_ENABLED: '0'
    }
  };
}

module.exports = {
  GENERATOR_VERSION,
  CANDIDATE_CONFIRMATION_STATE,
  CANDIDATE_CONFIRMED_RANK,
  DEFAULT_MIN_SCORE,
  DEFAULT_COST_SCENARIOS_BPS,
  DEFAULT_PRIMARY_COST_BPS,
  EXIT_SCENARIOS,
  EOD_TIME,
  PLUS_60_MINUTES,
  SMALL_SAMPLE_THRESHOLD,
  // helpers
  bpsToPct,
  round4,
  median,
  timeToMinutes,
  minutesToTime,
  assertSafeOutputRoots,
  // pricing
  buildSamplePriceMap,
  validTimesForTickerAfter,
  priceAt,
  // signals + trades
  detectSignals,
  resolveEntry,
  resolveExit,
  grossReturnPct,
  buildCostScenarios,
  buildTradeRecordsForSignal,
  applyOnePositionMode,
  occupancyExitMinutes,
  computeMetrics,
  collectResolved,
  // evaluation
  evaluateDate,
  buildSummary,
  buildCostComparison,
  buildAllTradeRecords,
  normalizeOptions,
  // outputs
  writeOutputs,
  // orchestration
  runBacktest
};
