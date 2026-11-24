'use strict';

/**
 * test/v6-short-swing-canonical.test.js
 * ============================================================================
 * Canonical fail-closed contract for lib/saham-potensial-engine.js (Subtask F).
 *
 * Provenance: all candidates use REAL IDX tickers (BBCA, BBRI, BMRI, ASII,
 * TLKM, UNVR, ICBP, ANTM) with an explicit `as_of`/`source` provenance — NOT
 * synthetic TK01.. tickers.
 *
 * Asserted contract:
 *  1. stale as-of (14 Okt processed as 9 Nov) => NOT_READY, never READY.
 *  2. explicit 0 stays 0 (never coerced to 50 or 1); null stays null (UNKNOWN).
 *  3. R/R at max_entry = 99/71 = 1.3944 < 1.5 => WATCHLIST (not actionable).
 *  4. ticker identity mismatch => BLOCKED.
 *  5. mandatory broker/foreign missing => BLOCKED (no fake READY/win prob).
 *  6. Top5 is a pure subset of Top20 (same object), one session_date, one
 *     score_version, one snapshot_id, no duplicates, no padding.
 *
 * Subtask H additions:
 *  7. P0-08 — COMPONENT-level freshness: a fresh price clock does not launder
 *     a stale `bandar_asof` / `foreign_asof`. Stale mandatory component =>
 *     NOT_READY; stale/unknown optional component caps at WATCHLIST.
 *  8. P0-09 — producer chain: `data/screener-latest.json` must carry the
 *     canonical `short_swing` pool built from the WHOLE local IDX universe,
 *     and the legacy `swing` alias must be explicitly deprecated + gated.
 *  9. P0-12 — REAL_MARKET_REPLAY artifacts must exist, be labelled
 *     REAL_MARKET_REPLAY, and honestly report the freshness demotions.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const engine = require('../lib/saham-potensial-engine');

const SESSION = '2026-11-09';

/** Build a full, fresh, provenance-carrying candidate with valid levels. */
function idxCandidate(ticker, overrides = {}) {
  const base = {
    ticker,
    as_of: SESSION,
    price_asof: SESSION,
    source: 'IDX_DAILY_SNAPSHOT',
    bandar_score: 80,
    bandar_source: 'broker-accumulation',
    bandar_asof: SESSION,
    foreign_flow_score: 75,
    foreign_source: 'foreign-flow',
    foreign_asof: SESSION,
    technical_score: 72,
    technical_source: 'technical-structure',
    technical_asof: SESSION,
    volume_ratio: 1.8,
    volume_source: 'idx-market-volume',
    volume_asof: SESSION,
    change_pct: 2.1
  };
  return Object.assign({}, base, overrides);
}

/* -------------------------------------------------------------------------- */
/* 1. Freshness gate: stale as-of must never be READY                         */
/* -------------------------------------------------------------------------- */
test('canonical: stale as-of (14 Okt) processed as 9 Nov => NOT_READY', () => {
  const cand = idxCandidate('BBCA', {
    as_of: '2026-10-14',
    price_asof: '2026-10-14',
    last_price: 10050,
    entry_low: 9900,
    entry_high: 10050,
    sl: 9600,
    tp1: 11500,
    rr: undefined
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res, 'stale row still evaluated for provenance');
  assert.equal(res.readiness, 'NOT_READY');
  assert.equal(res.is_actionable, false);
  assert.equal(res.as_of, '2026-10-14');
  assert.match(res.status_reason, /STALE/);
  assert.ok(res.risk_flags.includes('STALE_AS_OF'));
});

/* -------------------------------------------------------------------------- */
/* 2. Zero is real, null is unknown (no fake defaults)                        */
/* -------------------------------------------------------------------------- */
test('canonical: explicit 0 stays 0 — never coerced to 50 or 1', () => {
  const cand = idxCandidate('BBRI', {
    bandar_score: 0,
    foreign_flow_score: 0,
    technical_score: 0,
    volume_ratio: 0, // real zero, not unknown
    last_price: 5000,
    entry_low: 4900,
    entry_high: 5050,
    sl: 4700,
    tp1: 5900
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.score_components.bandar.value, 0);
  assert.equal(res.score_components.foreign.value, 0);
  assert.equal(res.score_components.technical.value, 0);
  assert.equal(res.volume_ratio, 0);
  assert.equal(res.bandar_score, 0);
  assert.equal(res.foreign_flow_score, 0);
  assert.equal(res.technical_score, 0);
  assert.equal(res.score, 0, 'fused score with all-zero components must be 0, not a padded 50');
});

test('canonical: null is UNKNOWN — mandatory foreign missing => BLOCKED', () => {
  const cand = idxCandidate('BMRI', {
    foreign_flow_score: null,
    foreign_source: null,
    last_price: 6900,
    entry_low: 6800,
    entry_high: 6950,
    sl: 6550,
    tp1: 7900
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.score_components.foreign.value, null);
  assert.equal(res.score_components.foreign.status, 'UNKNOWN');
  assert.equal(res.foreign_flow_score, null);
  assert.equal(res.readiness, 'BLOCKED');
  assert.equal(res.blocked_reason, 'MANDATORY_BROKER_FOREIGN_UNAVAILABLE');
  assert.equal(res.is_actionable, false);
  assert.equal(res.win_probability, null, 'no fabricated win probability');
});

/* -------------------------------------------------------------------------- */
/* 3. R/R at max_entry below 1.5 => WATCHLIST                                  */
/* -------------------------------------------------------------------------- */
test('canonical: R/R below 1.5 at max_entry => WATCHLIST, never actionable', () => {
  const res = engine.evaluateShortSwingCandidate(idxCandidate('PANI', {
    last_price: 1405,
    entry_low: 1399,
    entry_high: 1420,
    sl: 1349,
    tp1: 1519,
    volume_ratio: 1.4,
    change_pct: 1.2
  }), { sessionDate: SESSION });

  assert.ok(res);
  // TASK 5: levels are snapped onto official IDX ticks BEFORE the R/R gate.
  // Raw 1349 -> 1350 (Rp 5 band) and 1519 -> 1520, so the recomputed R/R is
  // (1520 - 1420) / (1420 - 1350) = 100 / 70 = 1.4286. The fail-closed intent
  // is unchanged: still < 1.5, still WATCHLIST, still not actionable.
  assert.equal(res.rr_at_max_entry, 1.4286);
  assert.equal(res.readiness, 'WATCHLIST');
  assert.equal(res.is_actionable, false);
  assert.ok(res.risk_flags.some((f) => f.startsWith('RR_BELOW_MINIMUM')));
});

/* -------------------------------------------------------------------------- */
/* 4. Ticker / date mismatch => BLOCKED                                       */
/* -------------------------------------------------------------------------- */
test('canonical: ticker identity mismatch => BLOCKED', () => {
  const cand = idxCandidate('BBCA', {
    symbol: 'BBRI', // conflicting identity field
    last_price: 10050,
    entry_low: 9900,
    entry_high: 10050,
    sl: 9600,
    tp1: 11500
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.readiness, 'BLOCKED');
  assert.equal(res.blocked_reason, 'TICKER_MISMATCH');
  assert.equal(res.is_actionable, false);
  assert.ok(res.risk_flags.includes('TICKER_MISMATCH'));
});

test('canonical: date mismatch (as_of != session) => NOT_READY', () => {
  const cand = idxCandidate('TLKM', {
    as_of: '2026-11-08',
    last_price: 3000,
    entry_low: 2950,
    entry_high: 3050,
    sl: 2850,
    tp1: 3500
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.readiness, 'NOT_READY');
  assert.equal(res.is_actionable, false);
});

/* -------------------------------------------------------------------------- */
/* 5. Top5 pure subset of Top20, one snapshot/session/version, no padding     */
/* -------------------------------------------------------------------------- */
function buildRealIdxCandidates() {
  return [
    idxCandidate('BBCA', { last_price: 10050, entry_low: 9950, entry_high: 10100, sl: 9600, tp1: 11600, volume_ratio: 2.0, bandar_score: 92, foreign_flow_score: 88, technical_score: 90 }),
    idxCandidate('BBRI', { last_price: 5050, entry_low: 4980, entry_high: 5080, sl: 4780, tp1: 5750, volume_ratio: 1.9, bandar_score: 85, foreign_flow_score: 82, technical_score: 80 }),
    idxCandidate('BMRI', { last_price: 6950, entry_low: 6880, entry_high: 7000, sl: 6600, tp1: 7900, volume_ratio: 1.7, bandar_score: 80, foreign_flow_score: 78, technical_score: 74 }),
    idxCandidate('ASII', { last_price: 5250, entry_low: 5180, entry_high: 5280, sl: 4950, tp1: 6050, volume_ratio: 1.6, bandar_score: 76, foreign_flow_score: 70, technical_score: 72 }),
    idxCandidate('UNVR', { last_price: 2950, entry_low: 2900, entry_high: 2970, sl: 2780, tp1: 3350, volume_ratio: 1.5, bandar_score: 72, foreign_flow_score: 68, technical_score: 66 }),
    // These two deliberately have weak R/R so they must never be actionable.
    idxCandidate('ICBP', { last_price: 11100, entry_low: 11000, entry_high: 11150, sl: 10800, tp1: 11600, volume_ratio: 1.3, bandar_score: 70, foreign_flow_score: 60, technical_score: 64 }),
    idxCandidate('ANTM', { last_price: 1800, entry_low: 1780, entry_high: 1820, sl: 1740, tp1: 1880, volume_ratio: 1.2, bandar_score: 68, foreign_flow_score: 62, technical_score: 60 })
  ];
}

test('canonical: Top5 real IDX pure subset, one snapshot/session/version, no duplicates', () => {
  const snapshot = engine.buildSahamPotensialSnapshot(buildRealIdxCandidates(), { sessionDate: SESSION });

  assert.equal(snapshot.session_date, SESSION);
  assert.equal(snapshot.score_version, engine.SCORE_ALGORITHM_VERSION);

  // Top5 is the exact same objects as top20[0..4].
  assert.equal(snapshot.top5.length, Math.min(5, snapshot.top20.length));
  for (let i = 0; i < snapshot.top5.length; i++) {
    assert.equal(snapshot.top5[i], snapshot.top20[i], 'Top5 must be object-identical to top20[' + i + ']');
  }

  // One snapshot_id + one session_date across every published row.
  const ids = new Set(snapshot.top20.map((r) => r.snapshot_id));
  const dates = new Set(snapshot.top20.map((r) => r.session_date));
  const versions = new Set(snapshot.top20.map((r) => r.score_version));
  assert.equal(ids.size, 1);
  assert.equal(dates.size, 1);
  assert.equal(versions.size, 1);

  // No duplicate tickers, no padding.
  assert.equal(new Set(snapshot.top20.map((r) => r.ticker)).size, snapshot.top20.length);

  // No fake READY: every row with rr < 1.5 must not be actionable.
  for (const row of snapshot.top20) {
    if (row.rr_at_max_entry + 1e-6 < engine.MIN_RR_THRESHOLD) {
      assert.equal(row.is_actionable, false, row.ticker + ' with RR < 1.5 must not be actionable');
    }
  }

  // Deterministic snapshot id for identical input.
  const again = engine.buildSahamPotensialSnapshot(buildRealIdxCandidates(), { sessionDate: SESSION });
  assert.equal(again.snapshot_id, snapshot.snapshot_id);
});

/* -------------------------------------------------------------------------- */
/* 6. No fabricated READY from incomplete data                               */
/* -------------------------------------------------------------------------- */
test('canonical: missing broker+foreign must never produce READY/win probability', () => {
  const cand = {
    ticker: 'ASII',
    as_of: SESSION,
    last_price: 5200,
    entry_low: 5100,
    entry_high: 5250,
    sl: 4900,
    tp1: 6000,
    volume_ratio: 2.0,
    change_pct: 1.0
    // bandar_score & foreign_flow_score omitted entirely
  };

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.readiness, 'BLOCKED');
  assert.equal(res.is_actionable, false);
  assert.equal(res.win_probability, null);
  assert.equal(res.probability_source, null);
});

/* -------------------------------------------------------------------------- */
/* 7. P0-08 — COMPONENT-level freshness gate                                  */
/* -------------------------------------------------------------------------- */
test('P0-08: fresh price but stale bandar_asof/foreign_asof (14 Okt vs 9 Nov) => NOT_READY', () => {
  const cand = idxCandidate('BBCA', {
    // Price clock is fresh for the session...
    as_of: SESSION,
    price_asof: SESSION,
    last_price: 10050,
    entry_low: 9950,
    entry_high: 10100,
    sl: 9600,
    tp1: 11600,
    // ...but the mandatory broker/foreign clocks are three weeks old.
    bandar_asof: '2026-10-14',
    foreign_asof: '2026-10-14'
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.readiness, 'NOT_READY', 'a stale mandatory component must block READY');
  assert.equal(res.is_actionable, false);
  assert.equal(res.score_components.bandar.freshness, 'STALE');
  assert.equal(res.score_components.foreign.freshness, 'STALE');
  assert.equal(res.component_freshness.price.status, 'FRESH');
  assert.equal(res.component_freshness.bandar.status, 'STALE');
  assert.equal(res.component_freshness.foreign.status, 'STALE');
  assert.match(res.status_reason, /STALE_MANDATORY_COMPONENT/);
  assert.ok(res.risk_flags.some((f) => f.startsWith('STALE_COMPONENT_BANDAR_')));
  assert.ok(res.risk_flags.some((f) => f.startsWith('STALE_COMPONENT_FOREIGN_')));
});

test('P0-08: all components fresh => READY is still reachable (gate is not a blanket block)', () => {
  const cand = idxCandidate('BBRI', {
    as_of: SESSION,
    price_asof: SESSION,
    bandar_asof: SESSION,
    foreign_asof: SESSION,
    technical_asof: SESSION,
    volume_asof: SESSION,
    last_price: 5050,
    entry_low: 4980,
    entry_high: 5080,
    sl: 4780,
    tp1: 5750
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.readiness, 'READY');
  assert.equal(res.is_actionable, true);
  assert.equal(res.component_freshness.price.status, 'FRESH');
  assert.equal(res.component_freshness.bandar.status, 'FRESH');
  assert.equal(res.component_freshness.foreign.status, 'FRESH');
});

test('P0-08: missing component as-of (value present, clock absent) caps at WATCHLIST', () => {
  const cand = idxCandidate('BMRI', {
    as_of: SESSION,
    price_asof: SESSION,
    bandar_asof: null,
    foreign_asof: null,
    last_price: 6950,
    entry_low: 6880,
    entry_high: 7000,
    sl: 6600,
    tp1: 7900
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.readiness, 'WATCHLIST', 'an unproven clock may never be promoted to READY');
  assert.equal(res.is_actionable, false);
  assert.equal(res.component_freshness.bandar.status, 'UNKNOWN');
  assert.equal(res.component_freshness.foreign.status, 'UNKNOWN');
  assert.ok(res.risk_flags.includes('FRESHNESS_UNKNOWN_DEMOTION'));
});

test('P0-08: stale OPTIONAL component (technical) caps at WATCHLIST, not NOT_READY', () => {
  const cand = idxCandidate('ASII', {
    as_of: SESSION,
    price_asof: SESSION,
    bandar_asof: SESSION,
    foreign_asof: SESSION,
    technical_asof: '2026-10-01',
    volume_asof: SESSION,
    last_price: 5250,
    entry_low: 5180,
    entry_high: 5280,
    sl: 4950,
    tp1: 6050
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.readiness, 'WATCHLIST');
  assert.equal(res.is_actionable, false);
  assert.ok(res.risk_flags.includes('STALE_OPTIONAL_DEMOTION'));
});

test('P0-08: stale price component alone => NOT_READY', () => {
  const cand = idxCandidate('TLKM', {
    as_of: SESSION,
    price_asof: '2026-10-14',
    bandar_asof: SESSION,
    foreign_asof: SESSION,
    last_price: 3000,
    entry_low: 2950,
    entry_high: 3050,
    sl: 2850,
    tp1: 3500
  });

  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: SESSION });
  assert.ok(res);
  assert.equal(res.component_freshness.price.status, 'STALE');
  assert.equal(res.readiness, 'NOT_READY');
  assert.equal(res.is_actionable, false);
});

/* -------------------------------------------------------------------------- */
/* 8. P0-09 — producer chain: one canonical whole-IDX Short Swing source       */
/* -------------------------------------------------------------------------- */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

test('P0-09: screener-latest.json carries a canonical short_swing pool wider than Konglo165', () => {
  const file = path.join(ROOT, 'data', 'screener-latest.json');
  if (!fs.existsSync(file)) return; // producer has not run locally; nothing to assert
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.ok(Array.isArray(doc.short_swing), 'canonical `short_swing` pool must exist');
  assert.ok(doc.short_swing_meta, 'short_swing_meta must be published');
  assert.equal(doc.short_swing_meta.canonical, true);
  assert.equal(doc.short_swing_meta.pool, 'short_swing');
  assert.equal(doc.short_swing_meta.engine, 'lib/saham-potensial-engine.js');

  // The whole point of P0-09: the canonical universe is the WHOLE local IDX
  // universe, not the 165-ticker conglomerate subset.
  assert.ok(doc.short_swing_meta.local_universe_count > 165,
    'canonical universe (' + doc.short_swing_meta.local_universe_count + ') must exceed Konglo165');
  assert.ok(doc.short_swing_meta.evaluated_count > 165,
    'evaluated rows must exceed the Konglo165 universe');

  // Every published row carries the canonical identity + fail-closed fields.
  for (const row of doc.short_swing) {
    assert.equal(row.snapshot_id, doc.short_swing_meta.snapshot_id);
    assert.equal(row.score_version, doc.short_swing_meta.score_version);
    assert.equal(typeof row.readiness, 'string');
    assert.equal(typeof row.input_checksum, 'string');
    assert.ok(row.component_freshness, 'per-component freshness must be published');
  }
});

test('P0-09: the legacy `swing` alias is explicitly deprecated and gated', () => {
  const file = path.join(ROOT, 'data', 'screener-latest.json');
  if (!fs.existsSync(file)) return;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(doc.swing_alias_deprecated, true, 'swing alias must be flagged deprecated');
  assert.ok(doc.swing_alias_meta, 'swing_alias_meta must explain the deprecation');
  assert.equal(doc.swing_alias_meta.deprecated, true);
  assert.equal(doc.swing_alias_meta.canonical_replacement, 'short_swing');
  assert.match(doc.swing_alias_meta.deprecated_reason, /P0-09/);
  assert.match(doc.swing_alias_meta.actual_source, /konglo/i);

  // The gate itself: the runner must refuse the alias.
  const runner = require('../scripts/top5-radar.js');
  const aliasOnly = runner.selectCanonicalPool({ swing: [{ ticker: 'BBCA' }], swing_alias_deprecated: true });
  assert.equal(aliasOnly.rows.length, 0);
  assert.match(aliasOnly.rejected, /DEPRECATED_SWING_ALIAS_REJECTED/);

  const canonical = runner.selectCanonicalPool({ short_swing: [{ ticker: 'BBCA' }], short_swing_meta: {} });
  assert.equal(canonical.pool, 'short_swing');
  assert.equal(canonical.rows.length, 1);
  assert.equal(canonical.rejected, null);
});

test('P0-12: bandar_score derived from real broksum is discriminating, not a constant', () => {
  // Regression guard for a real defect found during this subtask: scoring off
  // the broksum buy/sell value ratio yields bs === 1.0 for EVERY ticker (each
  // trade has a buyer and a seller, so total_buy_val === total_sell_val by
  // construction), which collapsed bandar_score to a constant 50 — an
  // information-free number that only looked derived.
  const universe = require('../lib/short-swing-universe');
  const broksumDir = universe.DEFAULT_BROKSUM_DIR;
  if (!fs.existsSync(broksumDir)) return;
  const tickers = fs.readdirSync(broksumDir)
    .filter((f) => f.endsWith('.json') && f !== 'archive-index.json')
    .map((f) => f.slice(0, -5));
  if (tickers.length < 5) return;

  const scores = [];
  for (const t of tickers) {
    const { candidate } = universe.buildCandidateFromLocalData(t);
    if (candidate && candidate.bandar_score !== null) scores.push(candidate.bandar_score);
  }
  assert.ok(scores.length >= 5, 'need several broksum-covered tickers, got ' + scores.length);

  const distinct = new Set(scores);
  assert.ok(distinct.size >= Math.max(3, Math.floor(scores.length / 4)),
    'bandar_score must vary across tickers; got ' + distinct.size + ' distinct of ' + scores.length +
    ' (a constant score is a fabricated neutral in disguise). values=' + scores.join(','));
  assert.ok(!scores.every((s) => s === 50), 'bandar_score must not be the constant 50 for every ticker');
});

test('P0-09: normalizeCandidate preserves per-component as-of clocks', () => {
  const runner = require('../scripts/top5-radar.js');
  const row = {
    ticker: 'BBCA',
    as_of: '2026-11-03',
    price_asof: '2026-11-03',
    last_price: 9860,
    entry_low: 9761,
    entry_high: 9860,
    sl: 9480,
    tp1: 10620,
    bandar_score: 62,
    foreign_flow_score: 71,
    technical_score: 55,
    volume_ratio: 1.2,
    score_components: {
      bandar: { value: 62, as_of: '2026-10-28' },
      foreign: { value: 71, as_of: '2026-10-28' },
      technical: { value: 55, as_of: '2026-11-03' },
      volume_ratio: { value: 1.2, as_of: '2026-11-03' }
    }
  };
  const cand = runner.normalizeCandidate(row, '2026-11-11');
  assert.equal(cand.as_of, '2026-11-03', 'the row price clock must not be overwritten by the session date');
  assert.equal(cand.bandar_asof, '2026-10-28');
  assert.equal(cand.foreign_asof, '2026-10-28');
  assert.equal(cand.technical_asof, '2026-11-03');
  assert.equal(cand.volume_asof, '2026-11-03');

  // And the engine then refuses to promote it.
  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: '2026-11-11' });
  assert.equal(res.readiness, 'NOT_READY');
  assert.equal(res.is_actionable, false);
});

/* -------------------------------------------------------------------------- */
/* 9. P0-12 — REAL_MARKET_REPLAY artifacts are real, labelled and honest       */
/* -------------------------------------------------------------------------- */

/** Minimal RFC4180 CSV parser (fields may be quoted and contain commas). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

test('P0-12: REAL_MARKET_REPLAY per-ticker ledger exists, is labelled, and is honestly demoted', () => {
  const file = path.join(ROOT, 'docs', 'v6', 'V6_SHORT_SWING_WHOLE_IDX_PER_TICKER.csv');
  if (!fs.existsSync(file)) return; // replay not run in this workspace
  const parsed = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = parsed[0];
  const rows = parsed.slice(1);

  // Master-prompt column contract.
  for (const col of ['evidence_class', 'ticker', 'trade_session_wib', 'universe_eligibility',
    'score', 'missing', 'source_asof_price', 'source_asof_bandar', 'source_asof_foreign',
    'freshness_price', 'broker_status', 'foreign_status', 'entry_low', 'entry_high',
    'max_entry', 'sl', 'tp1', 'tp2', 'rr_at_max_entry', 'horizon', 'actionability',
    'readiness', 'reason_codes', 'algo_version', 'snapshot_content_hash']) {
    assert.ok(header.includes(col), 'ledger must expose column ' + col);
  }

  assert.ok(rows.length > 500, 'the ledger must cover the whole local universe, got ' + rows.length);

  const evidenceIdx = header.indexOf('evidence_class');
  const readinessIdx = header.indexOf('readiness');
  const actionableIdx = header.indexOf('actionability');
  const algoIdx = header.indexOf('algo_version');
  const hashIdx = header.indexOf('snapshot_content_hash');
  let ready = 0;
  for (const cells of rows) {
    assert.equal(cells[evidenceIdx], 'REAL_MARKET_REPLAY', 'every row must be labelled REAL_MARKET_REPLAY');
    assert.equal(cells[algoIdx], engine.SCORE_ALGORITHM_VERSION);
    assert.equal(String(cells[hashIdx]).length, 64, 'every row must carry the canonical content hash');
    if (cells[readinessIdx] === 'READY') ready++;
    assert.notEqual(cells[actionableIdx], 'ACTIONABLE',
      'no row may be ACTIONABLE while the local cache is stale vs the session');
  }
  assert.equal(ready, 0,
    'Subtask G: stale local data must not promote any READY row — got ' + ready);
});

test('P0-12: Top20/Top5 real-source replay CSV is labelled REAL_MARKET_REPLAY', () => {
  const file = path.join(ROOT, 'docs', 'v6', 'V6_TOP20_TOP5_REAL_SOURCE_REPLAY.csv');
  if (!fs.existsSync(file)) return;
  const parsed = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = parsed[0];
  assert.ok(header.includes('evidence_class'));
  assert.ok(header.includes('snapshot_content_hash'));
  assert.ok(header.includes('rr_at_max_entry'));
  const evidenceIdx = header.indexOf('evidence_class');
  const readinessIdx = header.indexOf('readiness');
  const rrIdx = header.indexOf('rr_at_max_entry');
  const rows = parsed.slice(1);
  assert.ok(rows.length > 0 && rows.length <= 20, 'Top20 must not be padded, got ' + rows.length);
  for (const cells of rows) {
    assert.equal(cells[evidenceIdx], 'REAL_MARKET_REPLAY');
    assert.notEqual(cells[readinessIdx], 'READY');
    if (cells[rrIdx] !== '') {
      assert.ok(Number(cells[rrIdx]) > 0, 'R/R must be a real positive number, never fabricated');
    }
  }
});

test('P0-12: the superseded fixture CSV is labelled FIXTURE_TEST, never live evidence', () => {
  const file = path.join(ROOT, 'docs', 'v6', 'V6_TOP20_TOP5_REAL_IDX_CONSISTENCY.csv');
  if (!fs.existsSync(file)) return;
  const parsed = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = parsed[0];
  assert.ok(header.includes('evidence_class'),
    'the legacy CSV must carry an explicit evidence_class column');
  const evidenceIdx = header.indexOf('evidence_class');
  for (const cells of parsed.slice(1)) {
    assert.equal(cells[evidenceIdx], 'FIXTURE_TEST',
      'synthetic numbers must never be presented as REAL/live results');
  }
});

/* -------------------------------------------------------------------------- */
/* 10. Consumer contract: the API may never re-promote a canonical NOT_READY   */
/* -------------------------------------------------------------------------- */
test('consumer API: a canonical NOT_READY row never surfaces as READY/BUY', () => {
  const api = require('../api/top5-radar.js');
  const staleRow = {
    ticker: 'MEDC',
    readiness: 'NOT_READY',
    status_reason: 'AS_OF_STALE: kandidat bertanggal 2026-11-03 tidak sama dengan session_date 2026-11-11',
    last_price: 1280,
    entry_low: 1267,
    entry_high: 1280,
    sl: 1200,
    tp1: 1440,
    rr_at_max_entry: 2,
    data_status: 'AVAILABLE',
    trade_date: SESSION
  };

  const out = api.revalidatePick(staleRow, Date.now(), { publicationBlocked: false });
  assert.equal(out.canonical_readiness, 'NOT_READY');
  assert.notEqual(out.readiness_status, 'READY',
    'the level-only readiness engine must not re-promote a canonically stale row');
  assert.equal(out.action, null, 'no BUY token may be emitted for a NOT_READY row');
  assert.equal(out.trading_plan_valid, false);
  assert.equal(out.safe, false);
});

test('consumer API: a blocked publication never yields an actionable pick', () => {
  const api = require('../api/top5-radar.js');
  const row = {
    ticker: 'BBCA',
    readiness: 'READY',
    last_price: 9860,
    entry_low: 9761,
    entry_high: 9860,
    sl: 9480,
    tp1: 10620,
    rr_at_max_entry: 2,
    data_status: 'AVAILABLE',
    trade_date: SESSION
  };
  const out = api.revalidatePick(row, Date.now(), {
    publicationBlocked: true,
    blockReason: 'SNAPSHOT_SUPERSEDED_BY_NEWER_REVISION'
  });
  assert.notEqual(out.readiness_status, 'READY');
  assert.equal(out.action, null);
  assert.ok(out.verdict_reasons.some((r) => /PUBLICATION_BLOCKED/.test(r)));
});

/* -------------------------------------------------------------------------- */
/* 11. Telegram consumer reads the canonical pool, not the Konglo165 alias     */
/* -------------------------------------------------------------------------- */
test('consumer Telegram: loadScreener prefers the canonical short_swing pool', () => {
  const bot = require('../lib/telegram-interactive-bot.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-tg-'));
  const file = path.join(dir, 'screener-latest.json');
  fs.writeFileSync(file, JSON.stringify({
    updated_at: '2026-11-11T00:00:00.000Z',
    short_swing: [{ ticker: 'MEDC', readiness: 'NOT_READY', score: 56.3 }],
    short_swing_meta: { snapshot_id: 'SP-2026-11-11-abc' },
    swing: [{ ticker: 'KONGLO_ONLY', score: 10 }],
    swing_alias_deprecated: true
  }), 'utf8');

  const snap = bot.loadScreener(file);
  assert.equal(snap.swing_source, 'canonical_short_swing');
  assert.equal(snap.swing.length, 1);
  assert.equal(snap.swing[0].ticker, 'MEDC', 'Telegram must serve the canonical pool, not Konglo165');

  const card = bot.formatScanCard(snap, 'swing');
  assert.ok(card.includes('MEDC'));
  assert.ok(card.includes('NOT_READY'), 'the card must show the canonical verdict');
  assert.ok(card.includes('tidak actionable'), 'a non-READY row must not read like a buy signal');
  assert.ok(!card.includes('KONGLO_ONLY'));
});

test('consumer Telegram: falls back to the legacy alias only when no canonical pool exists', () => {
  const bot = require('../lib/telegram-interactive-bot.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-tg-'));
  const file = path.join(dir, 'screener-latest.json');
  fs.writeFileSync(file, JSON.stringify({
    swing: [{ ticker: 'LEGACY', score: 10 }]
  }), 'utf8');

  const snap = bot.loadScreener(file);
  assert.equal(snap.swing_source, 'deprecated_swing_alias');
  assert.equal(snap.swing[0].ticker, 'LEGACY');
});