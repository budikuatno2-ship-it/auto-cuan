'use strict';

/**
 * Parity + whole-lifecycle classification tests.
 *
 * Proves:
 *  - the shared pure helper (lib/intraday-production-eligibility) returns the
 *    SAME data-quality eligibility result as the previous inline production
 *    condition, and the live production gate (candidatePassesPublicTelegramSafetyGate)
 *    now routes through it;
 *  - the summary classifies eligibility over the WHOLE lifecycle (any risky
 *    observation -> risk), never relying solely on the first-seen snapshot;
 *  - the legacy fallback is conservative (unknown legacy is NOT production eligible).
 *
 * Mocked/local only: no network, no live collector, no production endpoint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const nodeFs = require('node:fs');

const policy = require('../lib/intraday-production-eligibility');
const lifecycle = require('../lib/intraday-sample-lifecycle');
const summary = require('../lib/intraday-sample-summary');

// The live production gate lives in api/sector-hot.js, which requires
// @supabase/supabase-js. In a dependency-free sandbox that module is absent, so
// we load the gate defensively and SKIP the live-gate parity test when the
// production dependencies are not installed (never fail on environment).
let liveGate = null;
try {
  liveGate = require('../api/sector-hot').__test.candidatePassesPublicTelegramSafetyGate;
} catch (e) {
  liveGate = null;
}

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'eligibility-parity-test-'));
}

/**
 * Reference reimplementation of the EXACT production data-quality condition
 * that previously lived inline in api/sector-hot.js (candidatePassesPublicTelegramSafetyGate).
 * Returns true when the candidate would be EXCLUDED on the data-quality axis.
 */
function previousProductionDataQualityExcludes(c) {
  var dataQualityStatus = String(c.data_quality_status || '').trim().toUpperCase();
  if (c.data_quality_valid === false || c.data_quality_needs_revalidation === true) return true;
  if ({
    SHORT_HISTORY: true, MISSING_REFERENCE: true, SPARSE_TRADING_DAYS: true,
    INVALID_CANDLE: true, CORPORATE_ACTION_RISK: true, NEEDS_REVALIDATION: true
  }[dataQualityStatus]) return true;
  return false;
}

// A candidate that passes the FULL public safety gate when data-quality is clean.
function safeCandidate(overrides) {
  return Object.assign({
    ticker: 'BBRI', category: 'Day Trade', status: 'READY', setup: 'Signal',
    risk_label: 'Low Risk', risk_reward: 1.8, entry1: 5000, entry2: 5050, sl: 4900,
    tp1n: 5150, tp2n: 5300, tp1_upside: 3, last_price: 5025, value_today: 20000000000,
    volume_ratio_20d: 1.4, volume_confirmation_label: 'Volume kuat', liquidity_label: 'Liquid',
    trading_plan_valid: true, plan_quality_status: 'VALID', plan_quality_label: 'Plan valid',
    rr_quality_label: 'RR sehat', sl_quality_label: 'SL wajar', tp_quality_label: 'TP realistis',
    entry_quality_status: 'IN_ENTRY_AREA', entry_status: 'IN_ENTRY_AREA',
    entry_status_label: 'Entry area', signal_action_label: 'Watchlist',
    telegram_verdict: 'Watchlist — tunggu konfirmasi.'
  }, overrides || {});
}

// The ten data-quality axis cases. expectedEligible is the data-quality-axis result.
const DQ_CASES = [
  ['clean candidate', {}, true],
  ['data_quality_valid === false', { data_quality_valid: false }, false],
  ['data_quality_needs_revalidation === true', { data_quality_needs_revalidation: true }, false],
  ['CORPORATE_ACTION_RISK', { data_quality_status: 'CORPORATE_ACTION_RISK' }, false],
  ['INVALID_CANDLE', { data_quality_status: 'INVALID_CANDLE' }, false],
  ['SHORT_HISTORY', { data_quality_status: 'SHORT_HISTORY' }, false],
  ['MISSING_REFERENCE', { data_quality_status: 'MISSING_REFERENCE' }, false],
  ['SPARSE_TRADING_DAYS', { data_quality_status: 'SPARSE_TRADING_DAYS' }, false],
  ['NEEDS_REVALIDATION', { data_quality_status: 'NEEDS_REVALIDATION' }, false]
];

// ===================================================================
// 1. API and research use the SAME pure eligibility helper (structural)
// ===================================================================
test('P1. api/sector-hot.js and research modules import the same pure helper', () => {
  const shSrc = nodeFs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const sumSrc = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'intraday-sample-summary.js'), 'utf8');
  const lfSrc = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'intraday-sample-lifecycle.js'), 'utf8');

  // API -> pure lib helper
  assert.ok(shSrc.includes("require('../lib/intraday-production-eligibility')"));
  assert.ok(shSrc.includes('productionEligibility.classifyProductionEligibility('));

  // research -> pure lib helper
  assert.ok(sumSrc.includes("require('./intraday-production-eligibility')"));
  assert.ok(lfSrc.includes("require('./intraday-production-eligibility')"));

  // dependency direction guard: the pure helper must NOT import an API handler
  const helperSrc = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'intraday-production-eligibility.js'), 'utf8');
  assert.ok(!helperSrc.match(/require\(['"][^'"]*\/api\//));
});

// ===================================================================
// 2. Parity: helper === previous production condition for all 10 cases,
//    and the live gate matches on the data-quality axis.
// ===================================================================
test('P2. helper matches the previous production data-quality condition (10 cases)', () => {
  for (const [name, override, expectedEligible] of DQ_CASES) {
    const cand = { data_quality_status: 'OK', ...override };
    const helperEligible = policy.classifyProductionEligibility(cand).eligible;
    const refEligible = !previousProductionDataQualityExcludes(cand);
    assert.equal(helperEligible, refEligible, 'helper vs reference mismatch: ' + name);
    assert.equal(helperEligible, expectedEligible, 'expected eligibility mismatch: ' + name);
  }
});

test('P2b. live production gate matches helper on the data-quality axis (9 cases)', (t) => {
  if (!liveGate) {
    t.skip('api/sector-hot.js dependencies (@supabase/supabase-js) not installed in this sandbox');
    return;
  }
  for (const [name, override, expectedEligible] of DQ_CASES) {
    const gatePass = liveGate(safeCandidate(override), 'daytrade');
    assert.equal(gatePass, expectedEligible, 'live gate mismatch on data-quality axis: ' + name);
  }
});

// ===================================================================
// 2c. execution_grade === 'Avoid' with otherwise clean data:
//     eligible on the DATA-QUALITY axis (execution grade is a different axis).
// ===================================================================
test('P2c. clean data + execution_grade "Avoid" stays eligible on the data-quality axis', () => {
  const cand = { data_quality_status: 'OK', execution_grade: 'Avoid' };
  const res = policy.classifyProductionEligibility(cand);
  assert.equal(res.eligible, true);
  assert.equal(res.reason, 'ok');
  // and the reference condition agrees (execution grade is not a data-quality exclusion)
  assert.equal(previousProductionDataQualityExcludes(cand), false);
});

// ===================================================================
// Whole-lifecycle helpers
// ===================================================================
function candRec(over) {
  return Object.assign({
    ticker: 'T', current_price: 100, entry_low: 98, entry_high: 100,
    reference_entry_price: 99, tp1: 105, tp2: 112, sl: 94,
    current_status: 'TRADE_CANDIDATE', score: 70, data_quality_status: 'OK'
  }, over || {});
}

// Run a scripted multi-observation sequence, finalize, and generate the summary.
async function runSequence(dir, ticker, steps) {
  const lf = path.join(dir, 'lifecycle.json');
  for (const step of steps) {
    await lifecycle.updateLifecycle(lf, [candRec(Object.assign({ ticker }, step.rec))], step.time);
  }
  await fs.writeFile(path.join(dir, 'runs.jsonl'), '');
  await fs.writeFile(path.join(dir, 'candidates.jsonl'), '');
  await fs.writeFile(path.join(dir, 'errors.jsonl'), '');
  const s = await summary.generateSummary(dir, ['09:15'], '2026-07-20');
  const finalized = JSON.parse(await fs.readFile(lf, 'utf8'));
  return { summary: s, entry: finalized[ticker] };
}

// ===================================================================
// 3. Clean -> Risk becomes risk (and 8/9: raw TP1 factual, excluded from eligible)
// ===================================================================
test('P3. clean-at-first then CORPORATE_ACTION_RISK later => data_quality_risk, raw TP1 kept', async () => {
  const dir = await tmpdir();
  const { summary: s, entry } = await runSequence(dir, 'CLEANRISK', [
    { time: '09:15', rec: { current_price: 99, data_quality_status: 'OK' } },
    { time: '09:30', rec: { current_price: 106, data_quality_status: 'CORPORATE_ACTION_RISK' } } // touches tp1 105
  ]);
  // raw TP/SL unchanged: TP1_HIT is factual
  assert.equal(entry.first_tp1_touch_at, '09:30');
  assert.equal(entry.final_simulated_outcome, 'TP1_HIT');
  // first-seen was clean (true), but whole-lifecycle sees the later risk
  assert.equal(entry.production_eligible_at_first_seen, true);
  const res = summary.resolveEntryEligibility(entry);
  assert.equal(res.classification, 'data_quality_risk');
  assert.equal(res.source, 'whole_lifecycle_status_history');
  // 8. combined keeps the raw TP1_HIT
  assert.equal(s.combined_metrics.tp1_touch_count, 1);
  assert.equal(s.combined_metrics.outcome_distribution.TP1_HIT, 1);
  // 9. risk TP1 excluded from production-eligible; present in risk partition
  assert.equal(s.production_eligible_metrics.tp1_touch_count, 0);
  assert.equal(s.production_eligible_metrics.candidate_count, 0);
  assert.equal(s.data_quality_risk_metrics.tp1_touch_count, 1);
});

// ===================================================================
// 4. Risk -> Clean remains risk (later clean must not erase earlier flag)
// ===================================================================
test('P4. risk-at-first then clean later => remains data_quality_risk', async () => {
  const dir = await tmpdir();
  const { summary: s, entry } = await runSequence(dir, 'RISKCLEAN', [
    { time: '09:15', rec: { current_price: 99, data_quality_status: 'CORPORATE_ACTION_RISK' } },
    { time: '09:30', rec: { current_price: 106, data_quality_status: 'OK' } } // later clean + tp1
  ]);
  assert.equal(entry.first_data_quality_flag_at, '09:15', 'risk flag stamped at first risky obs');
  assert.equal(entry.production_eligible_at_first_seen, false);
  const res = summary.resolveEntryEligibility(entry);
  assert.equal(res.classification, 'data_quality_risk');
  assert.equal(s.production_eligible_metrics.candidate_count, 0, 'later clean must not restore eligibility');
  assert.equal(s.data_quality_risk_metrics.candidate_count, 1);
  // raw outcome intact
  assert.equal(entry.final_simulated_outcome, 'TP1_HIT');
});

// ===================================================================
// 5. Clean -> Clean remains eligible
// ===================================================================
test('P5. clean throughout => production eligible', async () => {
  const dir = await tmpdir();
  const { summary: s, entry } = await runSequence(dir, 'CLEANCLEAN', [
    { time: '09:15', rec: { current_price: 99, data_quality_status: 'OK' } },
    { time: '09:30', rec: { current_price: 106, data_quality_status: 'OK' } }
  ]);
  const res = summary.resolveEntryEligibility(entry);
  assert.equal(res.classification, 'eligible');
  assert.equal(s.production_eligible_metrics.candidate_count, 1);
  assert.equal(s.production_eligible_metrics.tp1_touch_count, 1);
  assert.equal(s.data_quality_risk_metrics.candidate_count, 0);
});

// ===================================================================
// 6. Risk at first observation remains risk
// ===================================================================
test('P6. risk at first observation => data_quality_risk', async () => {
  const dir = await tmpdir();
  const { summary: s, entry } = await runSequence(dir, 'RISKFIRST', [
    { time: '09:15', rec: { current_price: 99, data_quality_status: 'INVALID_CANDLE' } }
  ]);
  const res = summary.resolveEntryEligibility(entry);
  assert.equal(res.classification, 'data_quality_risk');
  assert.equal(s.production_eligible_metrics.candidate_count, 0);
  assert.equal(s.data_quality_risk_metrics.candidate_count, 1);
});

// ===================================================================
// 7. Legacy unknown is NOT silently production eligible
// ===================================================================
test('P7. legacy entry with no data-quality evidence is not production eligible', () => {
  const legacy = { ticker: 'OLD', first_tp1_touch_at: '10:00', final_simulated_outcome: 'TP1_HIT' };
  const res = summary.resolveEntryEligibility(legacy);
  assert.equal(res.eligible, false);
  assert.equal(res.classification, 'legacy_unclassified');
  assert.equal(res.reason, 'legacy_missing_data_quality');
});

// ===================================================================
// 14. API endpoint JavaScript count remains exactly 12
// ===================================================================
test('P-endpoints. API endpoint count remains exactly 12', async () => {
  const entries = await fs.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});
