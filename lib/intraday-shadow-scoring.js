'use strict';

/**
 * Intraday Shadow Scoring Evaluator (research / evaluation ONLY)
 * ==============================================================
 *
 * Purpose
 *   Re-score already-collected intraday day-trade samples in SHADOW MODE so we
 *   can evaluate how a candidate-ranking would have behaved across completed
 *   snapshots — WITHOUT enabling production intraday scoring, mutating any
 *   recommendation/portfolio state, touching Supabase, or sending Telegram.
 *
 * Hard safety guarantees (see assertShadowSafety / enforceShadowSafetyDefaults):
 *   - DAYTRADE_INTRADAY_SCORE_ENABLED must be false/0 (production scoring OFF)
 *   - DAYTRADE_WORKER_ALLOW_MUTATION must not be true
 *   - TELEGRAM_ENABLED must be 0
 *   - This module imports NO Telegram notifier, NO Supabase client, and never
 *     writes to production recommendations, portfolios, user holdings, or the
 *     original intraday sample files.
 *
 * Input (produced by tools/intraday-sample-collector.js), per date directory:
 *   <date>/runs.jsonl         (records of type 'sample_run')
 *   <date>/candidates.jsonl   (per-snapshot candidate observations)
 *   <date>/summary.json       (optional, only read for context — never rewritten)
 *   <date>/lifecycle.json     (optional)
 *
 * Output (this evaluator), per date directory under a SEPARATE output root:
 *   <date>/shadow-scores.jsonl   (one line per scored candidate per snapshot)
 *   <date>/shadow-top5.jsonl     (one line per snapshot: the Top 5 shadow set)
 *   <date>/shadow-summary.json   (per-date evaluation summary)
 *   comparison-<first>-to-<last>.json (combined multi-day report, written once)
 *
 * Determinism: outputs contain NO wall-clock timestamp. Any time reference is
 * derived from the input (max observed sample_timestamp) so reruns over the
 * same input produce byte-identical output files (safe, idempotent reruns).
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

// Safe reuse of the EXISTING day-trade scoring gate. This module is pure
// (no Supabase, no Telegram, no I/O) — we only borrow its enabled-check so the
// shadow evaluator shares one source of truth for "is production scoring on?".
const scoreAdjustment = require('./daytrade-intraday-score-adjustment');

const GENERATOR_VERSION = 'intraday-shadow-scoring-v1.0';

// The three completed sample dates this evaluation targets. The CLI defaults to
// these but callers may narrow the set; anything outside is rejected.
const DEFAULT_SUPPORTED_DATES = Object.freeze([
  '2026-07-20',
  '2026-07-21',
  '2026-07-22'
]);

// Named candidates we explicitly track for the evaluation narrative.
const ASPR_TICKER = 'ASPR'; // representative genuinely-strengthening candidate
const ATLA_TICKER = 'ATLA'; // representative one-snapshot (transient) candidate

// -----------------------------------------------------------------------------
// Scoring configuration
// -----------------------------------------------------------------------------
// Component weights sum to 1.0. Components are expected on a 0-100 scale (the
// collector's *_component fields). The weighted sum minus the penalty forms the
// deterministic "base" score. Momentum is weighted most heavily because this is
// a day-trade context.
const COMPONENT_WEIGHTS = Object.freeze({
  liquidity: 0.20,
  pre_spike: 0.15,
  momentum: 0.30,
  risk_reward: 0.20,
  trend: 0.15
});

// Persistence contributes but is deliberately BOUNDED so that a static
// candidate cannot dominate on longevity alone.
const PERSISTENCE_STEP = 1.5; // points added per additional confirmed snapshot
const PERSISTENCE_CAP = 6;    // hard ceiling on the persistence bonus

// Momentum-improvement rewards candidates whose base score genuinely strengthens
// relative to their first observation. Also bounded, and symmetric (a weakening
// candidate is nudged down). This is what lets an ASPR-style candidate rise as it
// both persists AND improves.
const MOMENTUM_FACTOR = 0.5;
const MOMENTUM_CAP = 5;

// Classification thresholds.
const TRANSIENT_MAX_SNAPSHOTS = 1;  // seen in exactly one snapshot => transient (ATLA-style)
const PERSISTENT_MIN_SNAPSHOTS = 3; // seen in >= this many snapshots => persistent

// Warning thresholds for "insufficiently dynamic" scoring.
const STATIC_TOP5_WARN_RATIO = 0.8;    // >=80% of Top 5 slots are the same tickers every snapshot
const LOW_TURNOVER_WARN_THRESHOLD = 1;  // avg Top 5 turnover below this is flagged
const LOW_DISPERSION_WARN_THRESHOLD = 1.0; // stddev of shadow scores below this is flagged

const TOP_N = 5;

// -----------------------------------------------------------------------------
// Small numeric / string helpers
// -----------------------------------------------------------------------------
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function round4(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
}

function safeTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/, '').replace(/[^A-Z0-9_-]/g, '');
}

function mean(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function stddev(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return 0;
  const m = mean(nums);
  const variance = nums.reduce((s, v) => s + (v - m) * (v - m), 0) / nums.length;
  return Math.sqrt(variance);
}

// -----------------------------------------------------------------------------
// Date validation
// -----------------------------------------------------------------------------
/**
 * Validate a date string is a real calendar date in strict YYYY-MM-DD form.
 * Rejects malformed strings and impossible dates (e.g. 2026-13-40, 2026-02-30).
 */
function validateDateFormat(dateStr) {
  if (typeof dateStr !== 'string') return { valid: false, reason: 'not_a_string', value: dateStr };
  const trimmed = dateStr.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) return { valid: false, reason: 'bad_format', value: dateStr };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return { valid: false, reason: 'not_a_real_date', value: dateStr };
  }
  return { valid: true, date: trimmed };
}

/**
 * Validate + support-check a date against an allowed set.
 * @returns {{valid:boolean, reason?:string, date?:string}}
 */
function validateSupportedDate(dateStr, supportedDates) {
  const allowed = Array.isArray(supportedDates) && supportedDates.length
    ? supportedDates : DEFAULT_SUPPORTED_DATES;
  const fmt = validateDateFormat(dateStr);
  if (!fmt.valid) return fmt;
  if (!allowed.includes(fmt.date)) {
    return { valid: false, reason: 'unsupported_date', value: fmt.date, supported: allowed.slice() };
  }
  return { valid: true, date: fmt.date };
}

// -----------------------------------------------------------------------------
// Safety
// -----------------------------------------------------------------------------
/**
 * Assert the shadow-mode safety invariants. Returns errors (does not throw).
 * Uses the shared production scoring gate (scoreAdjustment.isIntradayScoreEnabled)
 * so there is a single source of truth for the "scoring enabled" check.
 */
function assertShadowSafety(env) {
  env = env || process.env;
  const errors = [];

  if (scoreAdjustment.isIntradayScoreEnabled(env) ||
      String(env.DAYTRADE_INTRADAY_SCORE_ENABLED || '').trim().toLowerCase() === 'true') {
    errors.push('DAYTRADE_INTRADAY_SCORE_ENABLED must be false/0 for shadow scoring (production scoring must stay OFF)');
  }
  if (String(env.DAYTRADE_WORKER_ALLOW_MUTATION || '').trim().toLowerCase() === 'true') {
    errors.push('DAYTRADE_WORKER_ALLOW_MUTATION must not be true (no mutation in shadow mode)');
  }
  const tg = String(env.TELEGRAM_ENABLED || '').trim().toLowerCase();
  if (tg === '1' || tg === 'true') {
    errors.push('TELEGRAM_ENABLED must be 0 (no Telegram in shadow mode)');
  }
  return { safe: errors.length === 0, errors };
}

/**
 * Hard-set the safe defaults on the given env object. Called by the CLI so a
 * shadow run cannot accidentally leave scoring/mutation/telegram enabled.
 * NOTE: this is only ever a downgrade to the known-safe values.
 */
function enforceShadowSafetyDefaults(env) {
  env = env || process.env;
  env.DAYTRADE_INTRADAY_SCORE_ENABLED = 'false';
  env.DAYTRADE_WORKER_ALLOW_MUTATION = 'false';
  env.TELEGRAM_ENABLED = '0';
  return {
    DAYTRADE_INTRADAY_SCORE_ENABLED: env.DAYTRADE_INTRADAY_SCORE_ENABLED,
    DAYTRADE_WORKER_ALLOW_MUTATION: env.DAYTRADE_WORKER_ALLOW_MUTATION,
    TELEGRAM_ENABLED: env.TELEGRAM_ENABLED
  };
}

// -----------------------------------------------------------------------------
// Safe output-path guard
// -----------------------------------------------------------------------------
/**
 * True if `child` is the same as, or nested inside, `parent`.
 */
function pathIsInsideOrEqual(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Refuse output paths that would sit inside the source sample directories (or
 * vice-versa). Guarantees the evaluator can never overwrite source JSONL files.
 * @throws Error on unsafe configuration.
 */
function assertSafeOutputRoot(inputRoot, outputRoot) {
  const inAbs = path.resolve(inputRoot);
  const outAbs = path.resolve(outputRoot);
  if (inAbs === outAbs) {
    throw new Error('SAFETY: output-root must not equal input-root (' + outAbs + ')');
  }
  if (pathIsInsideOrEqual(outAbs, inAbs)) {
    throw new Error('SAFETY: output-root must not be inside input-root (' + outAbs + ' is inside ' + inAbs + ')');
  }
  if (pathIsInsideOrEqual(inAbs, outAbs)) {
    throw new Error('SAFETY: input-root must not be inside output-root (' + inAbs + ' is inside ' + outAbs + ')');
  }
  return true;
}

// -----------------------------------------------------------------------------
// Input reading (never mutates source files)
// -----------------------------------------------------------------------------
/**
 * Read a JSONL file. Malformed lines are counted and skipped safely rather than
 * aborting the whole evaluation.
 * @returns {{records:Array, malformed:number, missing:boolean}}
 */
async function readJsonlSafe(filePath) {
  let content;
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { records: [], malformed: 0, missing: true };
    throw e;
  }
  const records = [];
  let malformed = 0;
  const lines = content.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
      else malformed++;
    } catch (e) {
      malformed++;
    }
  }
  return { records, malformed, missing: false };
}

/**
 * Read a JSON file if present. Malformed/absent returns { value:null, ... }.
 */
async function readJsonSafe(filePath) {
  let content;
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { value: null, malformed: false, missing: true };
    throw e;
  }
  try {
    return { value: JSON.parse(content), malformed: false, missing: false };
  } catch (e) {
    return { value: null, malformed: true, missing: false };
  }
}

// -----------------------------------------------------------------------------
// Scoring primitives
// -----------------------------------------------------------------------------
/**
 * Extract the 0-100 component vector + penalty from a candidate observation.
 * Falls back to the collector's overall `score` split evenly across components
 * only when no component fields are present, so a candidate is never silently
 * dropped. `usedFallback` records whether that happened.
 */
function extractComponents(record) {
  const liquidity = num(record.liquidity_component);
  const pre_spike = num(record.pre_spike_component);
  const momentum = num(record.momentum_component);
  const risk_reward = num(record.risk_reward_component);
  const trend = num(record.trend_component);
  const penalty = num(record.penalty_component);

  const anyComponent = [liquidity, pre_spike, momentum, risk_reward, trend].some((v) => v !== null);
  if (anyComponent) {
    return {
      components: {
        liquidity: liquidity === null ? 0 : liquidity,
        pre_spike: pre_spike === null ? 0 : pre_spike,
        momentum: momentum === null ? 0 : momentum,
        risk_reward: risk_reward === null ? 0 : risk_reward,
        trend: trend === null ? 0 : trend
      },
      penalty: penalty === null ? 0 : penalty,
      usedFallback: false
    };
  }

  // No component fields — fall back to the overall score as a flat proxy.
  const overall = num(record.score);
  const flat = overall === null ? 0 : overall;
  return {
    components: {
      liquidity: flat,
      pre_spike: flat,
      momentum: flat,
      risk_reward: flat,
      trend: flat
    },
    penalty: penalty === null ? 0 : penalty,
    usedFallback: true
  };
}

/**
 * Weighted base score = sum(weight_i * component_i) - penalty. Not clamped here
 * so the persistence/momentum adjustments compose cleanly before the final clamp.
 */
function computeBaseScore(components, penalty) {
  const w = COMPONENT_WEIGHTS;
  const weighted =
    w.liquidity * components.liquidity +
    w.pre_spike * components.pre_spike +
    w.momentum * components.momentum +
    w.risk_reward * components.risk_reward +
    w.trend * components.trend;
  return weighted - (penalty || 0);
}

/**
 * Deterministic comparator for ranking scored candidates within one snapshot.
 * Primary: shadow_score desc. Tie-breaks (all deterministic): momentum desc,
 * liquidity desc, base desc, then ticker asc.
 */
function compareScored(a, b) {
  if (b.shadow_score !== a.shadow_score) return b.shadow_score - a.shadow_score;
  if (b.score_components.momentum !== a.score_components.momentum) {
    return b.score_components.momentum - a.score_components.momentum;
  }
  if (b.score_components.liquidity !== a.score_components.liquidity) {
    return b.score_components.liquidity - a.score_components.liquidity;
  }
  if (b.base_score !== a.base_score) return b.base_score - a.base_score;
  return a.ticker.localeCompare(b.ticker);
}

/**
 * Score every candidate in a single snapshot, updating the cross-snapshot
 * persistence state. Returns the ranked scored records (with rank + top5 flag).
 *
 * @param {Array}  candidates  raw candidate observation records for this snapshot
 * @param {string} snapshot    scheduled_time (HH:MM)
 * @param {Map}    state       ticker -> persistence state (mutated)
 */
function scoreSnapshot(candidates, snapshot, state) {
  const scored = [];

  for (const record of candidates) {
    const ticker = safeTicker(record.ticker);
    if (!ticker) continue;

    const { components, penalty, usedFallback } = extractComponents(record);
    const baseScore = computeBaseScore(components, penalty);

    let st = state.get(ticker);
    const firstAppearance = !st;
    if (!st) {
      st = { ticker, appearances: 0, firstSeenBase: baseScore, firstSnapshot: snapshot, bases: [], ranks: [], snapshots: [] };
      state.set(ticker, st);
    }
    const priorAppearances = st.appearances;
    const k = priorAppearances + 1; // confirmed appearances including this one

    // Persistence bonus (bounded). First appearance (k=1) => 0.
    const persistenceBonus = Math.min(PERSISTENCE_CAP, (k - 1) * PERSISTENCE_STEP);

    // Momentum-improvement bonus (bounded, symmetric) vs first-seen base.
    let momentumBonus = 0;
    if (!firstAppearance) {
      const delta = baseScore - st.firstSeenBase;
      momentumBonus = Math.max(-MOMENTUM_CAP, Math.min(MOMENTUM_CAP, delta * MOMENTUM_FACTOR));
    }

    const shadowScore = clampScore(baseScore + persistenceBonus + momentumBonus);

    // Human-readable reasons + structured reason codes (store WHY, not just score).
    const reasons = [];
    const reasonCodes = [];
    reasons.push('base=' + round2(baseScore) +
      ' [liq*' + COMPONENT_WEIGHTS.liquidity + '=' + round2(COMPONENT_WEIGHTS.liquidity * components.liquidity) +
      ', pre*' + COMPONENT_WEIGHTS.pre_spike + '=' + round2(COMPONENT_WEIGHTS.pre_spike * components.pre_spike) +
      ', mom*' + COMPONENT_WEIGHTS.momentum + '=' + round2(COMPONENT_WEIGHTS.momentum * components.momentum) +
      ', rr*' + COMPONENT_WEIGHTS.risk_reward + '=' + round2(COMPONENT_WEIGHTS.risk_reward * components.risk_reward) +
      ', trd*' + COMPONENT_WEIGHTS.trend + '=' + round2(COMPONENT_WEIGHTS.trend * components.trend) + ']');
    if (penalty) { reasons.push('penalty=-' + round2(penalty)); reasonCodes.push('PENALTY_APPLIED'); }
    if (firstAppearance) {
      reasons.push('first appearance this date — unconfirmed, no persistence/momentum bonus');
      reasonCodes.push('UNCONFIRMED_FIRST_APPEARANCE');
    } else {
      reasons.push('persistence_bonus=+' + round2(persistenceBonus) + ' (confirmed in ' + k + ' snapshots, capped at ' + PERSISTENCE_CAP + ')');
      reasonCodes.push('PERSISTENCE_CONFIRMED');
      if (momentumBonus > 0) { reasons.push('momentum_bonus=+' + round2(momentumBonus) + ' (strengthening vs first observation)'); reasonCodes.push('MOMENTUM_STRENGTHENING'); }
      else if (momentumBonus < 0) { reasons.push('momentum_bonus=' + round2(momentumBonus) + ' (weakening vs first observation)'); reasonCodes.push('MOMENTUM_WEAKENING'); }
    }
    if (usedFallback) { reasons.push('components absent — used overall score as flat fallback'); reasonCodes.push('COMPONENT_FALLBACK'); }
    if (record.data_quality_status && String(record.data_quality_status).toUpperCase() !== 'OK') {
      reasonCodes.push('DATA_QUALITY_' + String(record.data_quality_status).toUpperCase());
    }
    for (const rc of (Array.isArray(record.reason_codes) ? record.reason_codes : [])) {
      const code = 'SOURCE_' + String(rc).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      if (!reasonCodes.includes(code)) reasonCodes.push(code);
    }

    scored.push({
      ticker,
      snapshot,
      appearance_index: k,
      is_first_appearance: firstAppearance,
      base_score: round2(baseScore),
      persistence_bonus: round2(persistenceBonus),
      momentum_bonus: round2(momentumBonus),
      shadow_score: round2(shadowScore),
      source_score: num(record.score),
      score_components: {
        liquidity: round2(components.liquidity),
        pre_spike: round2(components.pre_spike),
        momentum: round2(components.momentum),
        risk_reward: round2(components.risk_reward),
        trend: round2(components.trend),
        penalty: round2(penalty)
      },
      component_weights: COMPONENT_WEIGHTS,
      reason_codes: reasonCodes,
      reasons,
      data_quality_status: record.data_quality_status || null,
      current_status: record.current_status || null
    });

    // Update persistence state AFTER scoring this snapshot.
    st.appearances = k;
    st.bases.push(baseScore);
    st.snapshots.push(snapshot);
  }

  // Deterministic ranking + Top 5 flag.
  scored.sort(compareScored);
  scored.forEach((s, i) => {
    s.rank = i + 1;
    s.in_top5 = i < TOP_N;
  });
  // Record rank back into persistence state (for stability metrics).
  for (const s of scored) {
    const st = state.get(s.ticker);
    if (st) st.ranks.push({ snapshot, rank: s.rank });
  }
  return scored;
}

// -----------------------------------------------------------------------------
// Per-date evaluation
// -----------------------------------------------------------------------------
function chronoSnapshots(times) {
  return Array.from(new Set(times)).filter(Boolean).sort();
}

/**
 * Evaluate a single date directory. Pure computation — performs no writes.
 * @returns evaluation object (scores, top5, summary, diagnostics).
 */
async function evaluateDate(inputDateDir, dateStr, opts) {
  opts = opts || {};
  const asprTicker = safeTicker(opts.asprTicker || ASPR_TICKER);
  const atlaTicker = safeTicker(opts.atlaTicker || ATLA_TICKER);

  const runsRead = await readJsonlSafe(path.join(inputDateDir, 'runs.jsonl'));
  const candsRead = await readJsonlSafe(path.join(inputDateDir, 'candidates.jsonl'));
  // summary.json / lifecycle.json are read ONLY for context/diagnostics — never rewritten.
  const summaryRead = await readJsonSafe(path.join(inputDateDir, 'summary.json'));
  const lifecycleRead = await readJsonSafe(path.join(inputDateDir, 'lifecycle.json'));

  const missingFiles = [];
  if (runsRead.missing) missingFiles.push('runs.jsonl');
  if (candsRead.missing) missingFiles.push('candidates.jsonl');
  if (summaryRead.missing) missingFiles.push('summary.json');
  if (lifecycleRead.missing) missingFiles.push('lifecycle.json');

  const successRuns = runsRead.records.filter((r) => r && r.type === 'sample_run' && r.status === 'success');
  const runSnapshotTimes = chronoSnapshots(successRuns.map((r) => r.scheduled_time));

  // Group candidates by scheduled_time. Records without a valid scheduled_time
  // cannot be attributed to a snapshot -> counted as unassigned (not scored).
  const bySnapshot = new Map();
  let unassignedCandidates = 0;
  let forwardReturnFieldSeen = false;
  let maxSampleTs = null;
  for (const rec of candsRead.records) {
    if (!rec || typeof rec !== 'object') { unassignedCandidates++; continue; }
    // Detect any genuine forward-return / realized-outcome field in the source.
    if (rec.forward_return_pct != null || rec.realized_return_pct != null ||
        rec.forward_return != null || rec.next_day_return_pct != null) {
      forwardReturnFieldSeen = true;
    }
    if (typeof rec.sample_timestamp === 'string') {
      if (maxSampleTs === null || rec.sample_timestamp > maxSampleTs) maxSampleTs = rec.sample_timestamp;
    }
    const st = typeof rec.scheduled_time === 'string' ? rec.scheduled_time.trim() : '';
    if (!st) { unassignedCandidates++; continue; }
    if (!bySnapshot.has(st)) bySnapshot.set(st, []);
    bySnapshot.get(st).push(rec);
  }

  const candidateSnapshotTimes = chronoSnapshots(Array.from(bySnapshot.keys()));
  // Evaluated snapshots = union of run + candidate snapshots, chronological.
  const evaluatedSnapshots = chronoSnapshots(runSnapshotTimes.concat(candidateSnapshotTimes));
  // Snapshots that a run reported but produced zero candidate rows.
  const snapshotsWithoutCandidates = runSnapshotTimes.filter((t) => !bySnapshot.has(t));

  // Score each snapshot in chronological order, threading persistence state.
  const state = new Map();
  const allScored = [];
  const top5PerSnapshot = [];
  for (const snapshot of evaluatedSnapshots) {
    const candidates = bySnapshot.get(snapshot) || [];
    const scored = scoreSnapshot(candidates, snapshot, state);
    for (const s of scored) allScored.push(s);
    const top5 = scored.filter((s) => s.in_top5).map((s) => ({
      ticker: s.ticker,
      rank: s.rank,
      shadow_score: s.shadow_score,
      base_score: s.base_score,
      persistence_bonus: s.persistence_bonus,
      momentum_bonus: s.momentum_bonus,
      is_first_appearance: s.is_first_appearance,
      reason_codes: s.reason_codes
    }));
    top5PerSnapshot.push({ snapshot, candidate_count: candidates.length, top5 });
  }

  const summary = buildDateSummary({
    dateStr,
    evaluatedSnapshots,
    runSnapshotTimes,
    candidateSnapshotTimes,
    snapshotsWithoutCandidates,
    unassignedCandidates,
    malformedCandidateLines: candsRead.malformed,
    malformedRunLines: runsRead.malformed,
    missingFiles,
    state,
    allScored,
    top5PerSnapshot,
    forwardReturnFieldSeen,
    maxSampleTs,
    asprTicker,
    atlaTicker
  });

  return {
    date: dateStr,
    scores: allScored,
    top5: top5PerSnapshot,
    summary,
    state,
    source_max_sample_timestamp: maxSampleTs
  };
}

/**
 * Compute the Top-5 turnover (symmetric-difference size) between consecutive
 * snapshots and the set of tickers present in EVERY snapshot's Top 5.
 */
function analyzeTop5Dynamics(top5PerSnapshot) {
  const sets = top5PerSnapshot.map((s) => new Set(s.top5.map((t) => t.ticker)));
  const turnovers = [];
  for (let i = 1; i < sets.length; i++) {
    const prev = sets[i - 1];
    const cur = sets[i];
    let changed = 0;
    for (const t of cur) if (!prev.has(t)) changed++;
    for (const t of prev) if (!cur.has(t)) changed++;
    turnovers.push(changed); // symmetric-difference count (entered + left)
  }
  // Tickers present in every non-empty Top 5.
  const nonEmpty = sets.filter((s) => s.size > 0);
  let staticMembers = [];
  if (nonEmpty.length) {
    staticMembers = Array.from(nonEmpty[0]).filter((t) => nonEmpty.every((s) => s.has(t))).sort();
  }
  return {
    turnovers,
    avgTurnover: turnovers.length ? round2(mean(turnovers)) : 0,
    staticMembers,
    staticRatio: round2(staticMembers.length / TOP_N),
    snapshotCount: sets.length
  };
}

function buildDateSummary(ctx) {
  const {
    dateStr, evaluatedSnapshots, runSnapshotTimes, candidateSnapshotTimes,
    snapshotsWithoutCandidates, unassignedCandidates, malformedCandidateLines,
    malformedRunLines, missingFiles, state, allScored, top5PerSnapshot,
    forwardReturnFieldSeen, maxSampleTs, asprTicker, atlaTicker
  } = ctx;

  const tickers = Array.from(state.keys()).sort();

  // Top 5 appearances by ticker.
  const top5Appearances = {};
  for (const snap of top5PerSnapshot) {
    for (const t of snap.top5) {
      top5Appearances[t.ticker] = (top5Appearances[t.ticker] || 0) + 1;
    }
  }
  const top5AppearancesSorted = {};
  Object.keys(top5Appearances).sort((a, b) => top5Appearances[b] - top5Appearances[a] || a.localeCompare(b))
    .forEach((t) => { top5AppearancesSorted[t] = top5Appearances[t]; });

  // Average shadow score by ticker + per-ticker scored history.
  const scoresByTicker = {};
  for (const s of allScored) {
    if (!scoresByTicker[s.ticker]) scoresByTicker[s.ticker] = [];
    scoresByTicker[s.ticker].push(s);
  }
  const averageScoreByTicker = {};
  for (const t of tickers) {
    const arr = (scoresByTicker[t] || []).map((s) => s.shadow_score);
    averageScoreByTicker[t] = round2(mean(arr));
  }

  // Score-component averages across ALL scored rows.
  const compAvg = (key) => round2(mean(allScored.map((s) => s.score_components[key])));
  const scoreComponentAverages = {
    liquidity: compAvg('liquidity'),
    pre_spike: compAvg('pre_spike'),
    momentum: compAvg('momentum'),
    risk_reward: compAvg('risk_reward'),
    trend: compAvg('trend'),
    penalty: compAvg('penalty'),
    base_score: round2(mean(allScored.map((s) => s.base_score))),
    persistence_bonus: round2(mean(allScored.map((s) => s.persistence_bonus))),
    momentum_bonus: round2(mean(allScored.map((s) => s.momentum_bonus))),
    shadow_score: round2(mean(allScored.map((s) => s.shadow_score)))
  };

  // Persistent vs transient classification.
  const persistent = [];
  const transient = [];
  const atlaStyleOneSnapshot = [];
  for (const t of tickers) {
    const st = state.get(t);
    if (st.appearances <= TRANSIENT_MAX_SNAPSHOTS) {
      transient.push(t);
      atlaStyleOneSnapshot.push(t);
    } else if (st.appearances >= PERSISTENT_MIN_SNAPSHOTS) {
      persistent.push(t);
    }
  }
  const semiPersistent = tickers.filter((t) => !persistent.includes(t) && !transient.includes(t));

  // Rank stability.
  const dyn = analyzeTop5Dynamics(top5PerSnapshot);
  const rankVolatilityByTicker = {};
  const volatilityValues = [];
  for (const t of tickers) {
    const st = state.get(t);
    if (st.ranks.length >= 2) {
      let totalChange = 0;
      for (let i = 1; i < st.ranks.length; i++) {
        totalChange += Math.abs(st.ranks[i].rank - st.ranks[i - 1].rank);
      }
      const avgChange = round2(totalChange / (st.ranks.length - 1));
      rankVolatilityByTicker[t] = avgChange;
      volatilityValues.push(avgChange);
    }
  }
  const rankStability = {
    top5_turnover_between_snapshots: dyn.turnovers,
    avg_top5_turnover: dyn.avgTurnover,
    avg_persistent_ticker_rank_change: round2(mean(volatilityValues)),
    rank_change_by_ticker: rankVolatilityByTicker
  };

  // ASPR progression within this date.
  const asprProgression = buildTickerProgression(asprTicker, scoresByTicker, top5Appearances);
  // ATLA behavior within this date.
  const atlaBehavior = buildAtlaBehavior(atlaTicker, scoresByTicker, state);

  // Static Top-5 domination.
  const staticDomination = {
    static_members: dyn.staticMembers,
    static_ratio: dyn.staticRatio,
    dominates: dyn.snapshotCount >= 2 && dyn.staticRatio >= STATIC_TOP5_WARN_RATIO
  };

  // Score dispersion (per snapshot + overall).
  const dispersionPerSnapshot = top5PerSnapshot.map((snap) => {
    const rows = allScored.filter((s) => s.snapshot === snap.snapshot).map((s) => s.shadow_score);
    return { snapshot: snap.snapshot, stddev: round2(stddev(rows)), count: rows.length };
  });
  const overallDispersion = round2(stddev(allScored.map((s) => s.shadow_score)));

  // Warnings for insufficiently dynamic scoring.
  const warnings = [];
  if (staticDomination.dominates) {
    warnings.push('STATIC_TOP5_DOMINATION: ' + dyn.staticMembers.join(', ') +
      ' occupy the Top 5 in every snapshot (static_ratio=' + dyn.staticRatio + ' >= ' + STATIC_TOP5_WARN_RATIO + ')');
  }
  if (dyn.snapshotCount >= 2 && dyn.avgTurnover < LOW_TURNOVER_WARN_THRESHOLD) {
    warnings.push('LOW_TOP5_TURNOVER: avg Top 5 turnover ' + dyn.avgTurnover + ' < ' + LOW_TURNOVER_WARN_THRESHOLD + ' (ranking may be too static)');
  }
  if (allScored.length >= 2 && overallDispersion < LOW_DISPERSION_WARN_THRESHOLD) {
    warnings.push('LOW_SCORE_DISPERSION: shadow-score stddev ' + overallDispersion + ' < ' + LOW_DISPERSION_WARN_THRESHOLD + ' (scores barely differentiate candidates)');
  }
  if (evaluatedSnapshots.length === 0) {
    warnings.push('NO_EVALUATED_SNAPSHOTS: no snapshots with candidates were found for ' + dateStr);
  }

  return {
    generator_version: GENERATOR_VERSION,
    date: dateStr,
    timezone: 'Asia/Jakarta',
    mode: 'shadow_evaluation_only',
    source_max_sample_timestamp: maxSampleTs,

    // Safety echo (no production scoring / mutation / telegram in this mode).
    safety: {
      DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
      DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
      TELEGRAM_ENABLED: '0',
      production_scoring_enabled: false,
      mutations_performed: false,
      telegram_sent: false,
      source_files_rewritten: false
    },

    // Snapshot counts / integrity.
    total_evaluated_snapshots: evaluatedSnapshots.length,
    evaluated_snapshot_times: evaluatedSnapshots,
    run_snapshot_times: runSnapshotTimes,
    candidate_snapshot_times: candidateSnapshotTimes,
    missing_or_malformed: {
      missing_files: missingFiles,
      snapshots_without_candidates: snapshotsWithoutCandidates,
      malformed_candidate_lines: malformedCandidateLines,
      malformed_run_lines: malformedRunLines,
      unassigned_candidate_records: unassignedCandidates
    },

    // Ticker stats.
    total_unique_candidates: tickers.length,
    unique_candidate_tickers: tickers,
    top5_appearances_by_ticker: top5AppearancesSorted,
    average_score_by_ticker: averageScoreByTicker,
    score_component_averages: scoreComponentAverages,

    // Rank stability + dispersion.
    rank_stability: rankStability,
    score_dispersion: {
      overall_stddev: overallDispersion,
      per_snapshot: dispersionPerSnapshot
    },

    // Persistence classification.
    persistent_candidates: persistent,
    semi_persistent_candidates: semiPersistent,
    transient_candidates: transient,
    atla_style_one_snapshot_candidates: atlaStyleOneSnapshot,
    persistence_thresholds: {
      transient_max_snapshots: TRANSIENT_MAX_SNAPSHOTS,
      persistent_min_snapshots: PERSISTENT_MIN_SNAPSHOTS
    },

    // Named-candidate narratives.
    aspr_progression: asprProgression,
    atla_behavior: atlaBehavior,

    // Static-domination check + dynamism warnings.
    static_top5_domination: staticDomination,
    same_static_tickers_dominate_every_top5: staticDomination.dominates,
    warnings,

    // Forward returns: honestly report availability.
    forward_returns: buildForwardReturnStatus(forwardReturnFieldSeen)
  };
}

function buildForwardReturnStatus(available) {
  return {
    available: !!available,
    profitability_evaluated: false,
    hit_rate_evaluated: false,
    note: available
      ? 'A forward-return field was detected in the source, but this evaluator intentionally does NOT compute profitability/hit-rate in shadow mode; enable a dedicated forward-return analysis separately.'
      : 'No forward price outcomes exist in the input candidate records. Profitability and hit rate CANNOT yet be evaluated. Shadow scores measure ranking behavior only, not realized returns.'
  };
}

function buildTickerProgression(ticker, scoresByTicker, top5Appearances) {
  const rows = (scoresByTicker[ticker] || []).slice();
  if (!rows.length) {
    return { ticker, observed: false, note: ticker + ' not observed on this date' };
  }
  const perSnapshot = rows.map((s) => ({
    snapshot: s.snapshot,
    rank: s.rank,
    shadow_score: s.shadow_score,
    base_score: s.base_score,
    persistence_bonus: s.persistence_bonus,
    momentum_bonus: s.momentum_bonus,
    in_top5: s.in_top5
  }));
  const ranks = perSnapshot.map((p) => p.rank);
  const firstRank = ranks[0];
  const lastRank = ranks[ranks.length - 1];
  let direction = 'flat';
  if (lastRank < firstRank) direction = 'improving';
  else if (lastRank > firstRank) direction = 'declining';
  return {
    ticker,
    observed: true,
    appearances: rows.length,
    per_snapshot: perSnapshot,
    best_rank: Math.min.apply(null, ranks),
    worst_rank: Math.max.apply(null, ranks),
    first_rank: firstRank,
    last_rank: lastRank,
    rank_direction: direction,
    top5_appearances: top5Appearances[ticker] || 0,
    first_shadow_score: perSnapshot[0].shadow_score,
    last_shadow_score: perSnapshot[perSnapshot.length - 1].shadow_score,
    strengthened: perSnapshot[perSnapshot.length - 1].shadow_score > perSnapshot[0].shadow_score
  };
}

function buildAtlaBehavior(ticker, scoresByTicker, state) {
  const rows = (scoresByTicker[ticker] || []).slice();
  if (!rows.length) {
    return { ticker, observed: false, note: ticker + ' not observed on this date' };
  }
  const st = state.get(ticker);
  const isOneSnapshot = st.appearances <= TRANSIENT_MAX_SNAPSHOTS;
  return {
    ticker,
    observed: true,
    appearances: st.appearances,
    is_one_snapshot: isOneSnapshot,
    classified_transient: isOneSnapshot,
    per_snapshot: rows.map((s) => ({
      snapshot: s.snapshot,
      rank: s.rank,
      shadow_score: s.shadow_score,
      persistence_bonus: s.persistence_bonus,
      is_first_appearance: s.is_first_appearance,
      reason_codes: s.reason_codes
    })),
    best_rank: Math.min.apply(null, rows.map((s) => s.rank)),
    received_persistence_bonus: rows.some((s) => s.persistence_bonus > 0),
    rejected_as_persistent_pick: isOneSnapshot,
    note: isOneSnapshot
      ? ticker + ' appeared in a single snapshot: received NO persistence/momentum bonus, is classified transient, and is rejected as a persistent pick.'
      : ticker + ' persisted across multiple snapshots.'
  };
}

// -----------------------------------------------------------------------------
// Cross-day comparison
// -----------------------------------------------------------------------------
function dayTop5(evaluation) {
  // Day-level Top 5 = tickers by number of per-snapshot Top-5 appearances,
  // tie-broken by average shadow score, then ticker.
  const appearances = evaluation.summary.top5_appearances_by_ticker || {};
  const avg = evaluation.summary.average_score_by_ticker || {};
  return Object.keys(appearances)
    .sort((a, b) => (appearances[b] - appearances[a]) || ((avg[b] || 0) - (avg[a] || 0)) || a.localeCompare(b))
    .slice(0, TOP_N);
}

function symmetricDiffCount(aArr, bArr) {
  const a = new Set(aArr);
  const b = new Set(bArr);
  let diff = 0;
  for (const t of a) if (!b.has(t)) diff++;
  for (const t of b) if (!a.has(t)) diff++;
  return diff;
}

function buildComparison(evaluations, opts) {
  opts = opts || {};
  const asprTicker = safeTicker(opts.asprTicker || ASPR_TICKER);
  const atlaTicker = safeTicker(opts.atlaTicker || ATLA_TICKER);
  const ordered = evaluations.slice().sort((a, b) => a.date.localeCompare(b.date));
  const dates = ordered.map((e) => e.date);

  // Top 5 turnover between snapshots (per date).
  const top5TurnoverBetweenSnapshots = ordered.map((e) => ({
    date: e.date,
    turnovers: e.summary.rank_stability.top5_turnover_between_snapshots,
    avg_turnover: e.summary.rank_stability.avg_top5_turnover
  }));

  // Day-level Top 5 + turnover between days.
  const dayTop5ByDate = ordered.map((e) => ({ date: e.date, day_top5: dayTop5(e) }));
  const top5TurnoverBetweenDays = [];
  for (let i = 1; i < dayTop5ByDate.length; i++) {
    top5TurnoverBetweenDays.push({
      from: dayTop5ByDate[i - 1].date,
      to: dayTop5ByDate[i].date,
      turnover: symmetricDiffCount(dayTop5ByDate[i - 1].day_top5, dayTop5ByDate[i].day_top5),
      entered: dayTop5ByDate[i].day_top5.filter((t) => !dayTop5ByDate[i - 1].day_top5.includes(t)).sort(),
      left: dayTop5ByDate[i - 1].day_top5.filter((t) => !dayTop5ByDate[i].day_top5.includes(t)).sort()
    });
  }

  // Ticker rank progression across days (best & avg rank per day for every ticker
  // that appeared on any day).
  const allTickers = new Set();
  ordered.forEach((e) => Object.keys(e.summary.average_score_by_ticker).forEach((t) => allTickers.add(t)));
  const tickerRankProgression = {};
  for (const t of Array.from(allTickers).sort()) {
    tickerRankProgression[t] = ordered.map((e) => {
      const rows = e.scores.filter((s) => s.ticker === t);
      if (!rows.length) return { date: e.date, observed: false };
      const ranks = rows.map((s) => s.rank);
      return {
        date: e.date,
        observed: true,
        best_rank: Math.min.apply(null, ranks),
        avg_rank: round2(mean(ranks)),
        top5_appearances: e.summary.top5_appearances_by_ticker[t] || 0,
        avg_shadow_score: e.summary.average_score_by_ticker[t]
      };
    });
  }

  // Score dispersion per day + across all days.
  const scoreDispersion = {
    per_day: ordered.map((e) => ({ date: e.date, overall_stddev: e.summary.score_dispersion.overall_stddev })),
    all_days_stddev: round2(stddev([].concat.apply([], ordered.map((e) => e.scores.map((s) => s.shadow_score)))))
  };

  // Percentage of static Top 5 members across all snapshots of all days.
  const allSnapshotTop5Sets = [];
  ordered.forEach((e) => e.top5.forEach((snap) => {
    if (snap.top5.length) allSnapshotTop5Sets.push(new Set(snap.top5.map((t) => t.ticker)));
  }));
  let globalStaticMembers = [];
  if (allSnapshotTop5Sets.length) {
    globalStaticMembers = Array.from(allSnapshotTop5Sets[0])
      .filter((t) => allSnapshotTop5Sets.every((s) => s.has(t))).sort();
  }
  const pctStaticTop5Members = allSnapshotTop5Sets.length
    ? round2((globalStaticMembers.length / TOP_N) * 100) : 0;

  // Transient candidate handling per day.
  const transientHandling = ordered.map((e) => ({
    date: e.date,
    transient_candidates: e.summary.transient_candidates,
    atla_style_one_snapshot: e.summary.atla_style_one_snapshot_candidates,
    any_transient_in_day_top5: dayTop5(e).some((t) => e.summary.transient_candidates.includes(t)),
    note: 'Transient (one-snapshot) candidates receive no persistence/momentum bonus and are excluded from persistent-pick status.'
  }));

  // ASPR rank progression across days.
  const asprByDay = ordered.map((e) => {
    const prog = e.summary.aspr_progression;
    const rows = e.scores.filter((s) => s.ticker === asprTicker);
    const avgRank = rows.length ? round2(mean(rows.map((s) => s.rank))) : null;
    return {
      date: e.date,
      observed: !!prog.observed,
      best_rank: prog.observed ? prog.best_rank : null,
      last_rank: prog.observed ? prog.last_rank : null,
      avg_rank: avgRank,
      avg_shadow_score: e.summary.average_score_by_ticker[asprTicker] != null
        ? e.summary.average_score_by_ticker[asprTicker] : null,
      top5_appearances: prog.observed ? prog.top5_appearances : 0,
      strengthened_within_day: prog.observed ? prog.strengthened : false
    };
  });
  const asprObservedDays = asprByDay.filter((d) => d.observed);
  // Cross-day direction uses AVERAGE rank (lower is better) so that a candidate
  // which reaches #1 earlier / more often on later days reads as "improving"
  // even when its single best rank is already 1 on every day.
  let asprCrossDayDirection = 'insufficient_data';
  if (asprObservedDays.length >= 2) {
    const firstAvg = asprObservedDays[0].avg_rank;
    const lastAvg = asprObservedDays[asprObservedDays.length - 1].avg_rank;
    asprCrossDayDirection = lastAvg < firstAvg ? 'improving' : (lastAvg > firstAvg ? 'declining' : 'flat');
  }

  // ATLA rank + rejection behavior across days.
  const atlaByDay = ordered.map((e) => {
    const b = e.summary.atla_behavior;
    return {
      date: e.date,
      observed: !!b.observed,
      appearances: b.observed ? b.appearances : 0,
      best_rank: b.observed ? b.best_rank : null,
      is_one_snapshot: b.observed ? b.is_one_snapshot : null,
      rejected_as_persistent_pick: b.observed ? b.rejected_as_persistent_pick : null
    };
  });
  const atlaObservedDays = atlaByDay.filter((d) => d.observed);

  return {
    generator_version: GENERATOR_VERSION,
    mode: 'shadow_evaluation_only',
    dates,
    safety: {
      DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
      DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
      TELEGRAM_ENABLED: '0',
      production_scoring_enabled: false,
      mutations_performed: false,
      telegram_sent: false,
      source_files_rewritten: false
    },
    top5_turnover_between_snapshots: top5TurnoverBetweenSnapshots,
    day_top5_by_date: dayTop5ByDate,
    top5_turnover_between_days: top5TurnoverBetweenDays,
    ticker_rank_progression: tickerRankProgression,
    score_dispersion: scoreDispersion,
    static_top5_members: {
      global_static_members: globalStaticMembers,
      pct_static_top5_members: pctStaticTop5Members,
      note: 'Percentage of Top 5 slots occupied by tickers present in EVERY snapshot Top 5 across all evaluated days.'
    },
    transient_candidate_handling: transientHandling,
    aspr_rank_progression: {
      ticker: asprTicker,
      per_day: asprByDay,
      cross_day_direction: asprCrossDayDirection,
      note: asprObservedDays.length
        ? asprTicker + ' is allowed to rise as persistence and momentum improve; cross-day best-rank direction: ' + asprCrossDayDirection
        : asprTicker + ' not observed on any evaluated day.'
    },
    atla_rank_and_rejection: {
      ticker: atlaTicker,
      per_day: atlaByDay,
      total_appearances: atlaObservedDays.reduce((s, d) => s + d.appearances, 0),
      observed_on_days: atlaObservedDays.map((d) => d.date),
      always_transient: atlaObservedDays.length > 0 && atlaObservedDays.every((d) => d.is_one_snapshot),
      note: atlaObservedDays.length
        ? atlaTicker + ' appears only as a one-snapshot candidate: it never accrues persistence, is classified transient, and is rejected as a persistent pick.'
        : atlaTicker + ' not observed on any evaluated day.'
    },
    forward_returns: buildForwardReturnStatus(
      ordered.some((e) => e.summary.forward_returns.available)
    )
  };
}

// -----------------------------------------------------------------------------
// Atomic output writing (never touches source files)
// -----------------------------------------------------------------------------
async function atomicWriteFile(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  await fsp.writeFile(tmpPath, content);
  await fsp.rename(tmpPath, filePath);
}

function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

async function writeDateOutputs(outputDateDir, evaluation) {
  const scoresPath = path.join(outputDateDir, 'shadow-scores.jsonl');
  const top5Path = path.join(outputDateDir, 'shadow-top5.jsonl');
  const summaryPath = path.join(outputDateDir, 'shadow-summary.json');

  await atomicWriteFile(scoresPath, toJsonl(evaluation.scores));
  await atomicWriteFile(top5Path, toJsonl(evaluation.top5));
  await atomicWriteFile(summaryPath, JSON.stringify(evaluation.summary, null, 2) + '\n');

  return { scores: scoresPath, top5: top5Path, summary: summaryPath };
}

function comparisonFileName(dates) {
  const sorted = dates.slice().sort();
  return 'comparison-' + sorted[0] + '-to-' + sorted[sorted.length - 1] + '.json';
}

async function writeComparison(outputRoot, comparison) {
  const fileName = comparisonFileName(comparison.dates);
  const filePath = path.join(outputRoot, fileName);
  await atomicWriteFile(filePath, JSON.stringify(comparison, null, 2) + '\n');
  return filePath;
}

// -----------------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------------
/**
 * Run the full shadow-scoring evaluation.
 *
 * @param {object} opts
 *   inputRoot      required — root dir containing <date>/ sample directories
 *   outputRoot     required — root dir for shadow outputs (must be OUTSIDE inputRoot)
 *   dates          required — array of date strings to evaluate
 *   supportedDates optional — allowed date set (defaults to the three sample dates)
 *   env            optional — env object for safety checks (defaults to process.env)
 *   asprTicker/atlaTicker optional — override tracked tickers
 * @returns {{status, dates, evaluations, comparison, outputs, errors}}
 */
async function runShadowScoring(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const supportedDates = opts.supportedDates || DEFAULT_SUPPORTED_DATES;

  // 1. Safety gate.
  const safety = assertShadowSafety(env);
  if (!safety.safe) {
    return { status: 'safety_violation', errors: safety.errors, dates: [], evaluations: [], outputs: [] };
  }

  // 2. Required arguments.
  if (!opts.inputRoot) return { status: 'error', errors: ['missing inputRoot'] };
  if (!opts.outputRoot) return { status: 'error', errors: ['missing outputRoot'] };
  if (!Array.isArray(opts.dates) || !opts.dates.length) {
    return { status: 'error', errors: ['no dates provided'] };
  }

  // 3. Safe output-path guard (refuse output inside source directories).
  try {
    assertSafeOutputRoot(opts.inputRoot, opts.outputRoot);
  } catch (e) {
    return { status: 'unsafe_output_path', errors: [e.message] };
  }

  // 4. Validate every requested date up front — reject unsupported/malformed.
  const validated = [];
  for (const d of opts.dates) {
    const v = validateSupportedDate(d, supportedDates);
    if (!v.valid) {
      return { status: 'rejected', reason: v.reason, errors: ['invalid date: ' + JSON.stringify(d) + ' (' + v.reason + ')'], date: d };
    }
    validated.push(v.date);
  }

  // 5. Evaluate each date (pure), then write outputs atomically.
  const evaluations = [];
  const outputs = [];
  for (const date of validated) {
    const inputDateDir = path.join(opts.inputRoot, date);
    const outputDateDir = path.join(opts.outputRoot, date);
    const evaluation = await evaluateDate(inputDateDir, date, opts);
    evaluations.push(evaluation);
    if (!opts.dryRun) {
      const written = await writeDateOutputs(outputDateDir, evaluation);
      outputs.push({ date, files: written });
    }
  }

  // 6. Combined multi-day comparison report.
  let comparison = null;
  let comparisonPath = null;
  if (evaluations.length) {
    comparison = buildComparison(evaluations, opts);
    if (!opts.dryRun) comparisonPath = await writeComparison(opts.outputRoot, comparison);
  }

  return {
    status: 'success',
    dates: validated,
    evaluations,
    comparison,
    outputs,
    comparison_path: comparisonPath,
    enforced_safety: {
      DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
      DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
      TELEGRAM_ENABLED: '0'
    }
  };
}

module.exports = {
  GENERATOR_VERSION,
  DEFAULT_SUPPORTED_DATES,
  ASPR_TICKER,
  ATLA_TICKER,
  COMPONENT_WEIGHTS,
  PERSISTENCE_STEP,
  PERSISTENCE_CAP,
  MOMENTUM_FACTOR,
  MOMENTUM_CAP,
  TRANSIENT_MAX_SNAPSHOTS,
  PERSISTENT_MIN_SNAPSHOTS,
  TOP_N,
  // helpers
  num,
  clampScore,
  round2,
  safeTicker,
  mean,
  stddev,
  // date + safety + paths
  validateDateFormat,
  validateSupportedDate,
  assertShadowSafety,
  enforceShadowSafetyDefaults,
  pathIsInsideOrEqual,
  assertSafeOutputRoot,
  // io
  readJsonlSafe,
  readJsonSafe,
  atomicWriteFile,
  toJsonl,
  // scoring
  extractComponents,
  computeBaseScore,
  compareScored,
  scoreSnapshot,
  evaluateDate,
  buildDateSummary,
  analyzeTop5Dynamics,
  buildComparison,
  dayTop5,
  // outputs
  writeDateOutputs,
  writeComparison,
  comparisonFileName,
  // orchestration
  runShadowScoring
};
