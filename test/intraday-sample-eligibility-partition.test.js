'use strict';

/**
 * Focused tests for the production-eligibility partitioning + additive
 * lifecycle fields (research schema v1.1).
 *
 * Mocked/local only: no network, no live collector, no production endpoints.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const lifecycle = require('../lib/intraday-sample-lifecycle');
const summary = require('../lib/intraday-sample-summary');
const policy = require('../lib/intraday-production-eligibility');

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sample-eligibility-test-'));
}

// A candidate observation record with the frozen levels used across the day.
function rec(over) {
  return Object.assign({
    ticker: 'TEST',
    current_price: 87,
    entry_low: 85,
    entry_high: 87,
    reference_entry_price: 86,
    tp1: 92,
    tp2: 107,
    sl: 82,
    current_status: 'TRADE_CANDIDATE',
    score: 70,
    data_quality_status: 'OK'
  }, over || {});
}

// Write a lifecycle.json + empty jsonl inputs, then generate the summary.
async function summarizeLifecycle(dir, lifecycleMap) {
  await fs.writeFile(path.join(dir, 'lifecycle.json'), JSON.stringify(lifecycleMap, null, 2));
  await fs.writeFile(path.join(dir, 'runs.jsonl'), '');
  await fs.writeFile(path.join(dir, 'candidates.jsonl'), '');
  await fs.writeFile(path.join(dir, 'errors.jsonl'), '');
  return summary.generateSummary(dir, ['09:15'], '2026-07-20');
}

// A finalized-shape lifecycle entry helper for summary partition tests.
function entry(over) {
  return Object.assign({
    ticker: 'X',
    first_entry_touch_at: null,
    first_tp1_touch_at: null,
    first_tp2_touch_at: null,
    first_sl_touch_at: null,
    first_invalid_at: null,
    first_stale_at: null,
    first_entry_missed_at: null,
    final_simulated_outcome: null,
    max_favorable_excursion_pct: 0,
    max_adverse_excursion_pct: 0,
    statuses: ['TRADE_CANDIDATE']
  }, over || {});
}

// ===================================================================
// 1. First snapshot remains observation-only (no price touch detection)
// ===================================================================
test('E1. first snapshot is observation-only — no entry touch on first obs even if in-zone', async () => {
  const dir = await tmpdir();
  const lf = path.join(dir, 'lifecycle.json');
  // price 87 is inside entry zone 85-87 on the very first observation
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], '09:15');
  const data = await lifecycle.readLifecycle(lf);
  assert.equal(data.TEST.number_of_observations, 1);
  assert.equal(data.TEST.first_entry_touch_at, null);
  assert.equal(data.TEST.first_tp1_touch_at, null);
  assert.equal(data.TEST.first_stale_at, null);
});

// ===================================================================
// 2. Observation 4 at 10:00 is the earliest possible price-inactivity
//    evaluation for a 09:15 start.
// ===================================================================
test('E2. earliest possible price-inactivity is observation 4 (10:00) for a 09:15 start', async () => {
  const dir = await tmpdir();
  const lf = path.join(dir, 'lifecycle.json');
  // Constant price equal to first_seen_price across obs 1..4
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], '09:15'); // obs1
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], '09:30'); // obs2
  let data = await lifecycle.readLifecycle(lf);
  assert.equal(data.TEST.first_stale_at, null, 'obs2 (<4) must not flag inactivity');
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], '09:45'); // obs3
  data = await lifecycle.readLifecycle(lf);
  assert.equal(data.TEST.first_stale_at, null, 'obs3 (<4) must not flag inactivity');
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], '10:00'); // obs4
  data = await lifecycle.readLifecycle(lf);
  assert.equal(data.TEST.number_of_observations, 4);
  assert.equal(data.TEST.first_stale_at, '10:00', 'obs4 at 10:00 is the earliest possible inactivity flag');
});

// ===================================================================
// 3. A BNBR-like sequence first triggers price inactivity at 10:15 when
//    equality first occurs then.
// ===================================================================
test('E3. BNBR-like sequence flags price inactivity at 10:15 when equality first occurs', async () => {
  const dir = await tmpdir();
  const lf = path.join(dir, 'lifecycle.json');
  // first_seen 87; price moves away, only returns to 87 at 10:15 (obs5, n>=4)
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], '09:15'); // obs1 seen@87
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 88 })], '09:30'); // obs2
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 90 })], '09:45'); // obs3
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 95 })], '10:00'); // obs4 (n=4 but price!=87)
  let data = await lifecycle.readLifecycle(lf);
  assert.equal(data.TEST.first_stale_at, null, 'no inactivity while price != first_seen_price');
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], '10:15'); // obs5 price back to 87
  data = await lifecycle.readLifecycle(lf);
  assert.equal(data.TEST.first_stale_at, '10:15');
});

// ===================================================================
// 4. first_stale_at equals first_price_inactivity_at
// ===================================================================
test('E4. first_price_inactivity_at alias equals first_stale_at', async () => {
  const dir = await tmpdir();
  const lf = path.join(dir, 'lifecycle.json');
  for (const t of ['09:15', '09:30', '09:45', '10:00']) {
    await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], t);
  }
  const data = await lifecycle.readLifecycle(lf);
  assert.equal(data.TEST.first_stale_at, '10:00');
  assert.equal(data.TEST.first_price_inactivity_at, data.TEST.first_stale_at);
});

// ===================================================================
// 5. Provider freshness is independent from price inactivity
// ===================================================================
test('E5. price inactivity depends only on sampled price, independent of provider freshness', async () => {
  const dir = await tmpdir();
  // (a) constant price -> inactivity flagged; lifecycle carries no provider-freshness field
  const lfA = path.join(dir, 'a.json');
  for (const t of ['09:15', '09:30', '09:45', '10:00']) {
    await lifecycle.updateLifecycle(lfA, [rec({ current_price: 87 })], t);
  }
  const a = (await lifecycle.readLifecycle(lfA)).TEST;
  assert.equal(a.first_price_inactivity_at, '10:00');
  assert.equal('is_stale' in a, false, 'lifecycle entry must not carry provider is_stale');
  assert.equal('provider' in a, false, 'lifecycle entry must not carry provider freshness');

  // (b) moving price across >=4 obs -> never flagged, regardless of provider freshness
  const lfB = path.join(dir, 'b.json');
  const prices = [87, 88, 89, 90, 91];
  const times = ['09:15', '09:30', '09:45', '10:00', '10:15'];
  for (let i = 0; i < times.length; i++) {
    await lifecycle.updateLifecycle(lfB, [rec({ current_price: prices[i] })], times[i]);
  }
  const b = (await lifecycle.readLifecycle(lfB)).TEST;
  assert.equal(b.first_price_inactivity_at, null, 'active price must never flag inactivity');
});

// ===================================================================
// 6. Frozen entry/TP1/TP2/SL levels remain unchanged across observations
// ===================================================================
test('E6. frozen entry/TP1/TP2/SL levels are not overwritten by later observations', async () => {
  const dir = await tmpdir();
  const lf = path.join(dir, 'lifecycle.json');
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], '09:15');
  // Later observation carries DIFFERENT recalculated levels
  await lifecycle.updateLifecycle(lf, [rec({
    current_price: 90, entry_low: 88, entry_high: 91, reference_entry_price: 89,
    tp1: 95, tp2: 110, sl: 84
  })], '09:30');
  const data = (await lifecycle.readLifecycle(lf)).TEST;
  assert.equal(data.entry_low, 85);
  assert.equal(data.entry_high, 87);
  assert.equal(data.reference_entry_price, 86);
  assert.equal(data.tp1, 92);
  assert.equal(data.tp2, 107);
  assert.equal(data.sl, 82);
});

// ===================================================================
// 7. CORPORATE_ACTION_RISK retains raw TP1_HIT
// ===================================================================
test('E7. CORPORATE_ACTION_RISK candidate retains raw TP1_HIT (not converted to INVALID)', async () => {
  const dir = await tmpdir();
  const lf = path.join(dir, 'lifecycle.json');
  await lifecycle.updateLifecycle(lf, [rec({
    ticker: 'BNBR', current_price: 87, data_quality_status: 'CORPORATE_ACTION_RISK'
  })], '09:15');
  // touches tp1 (>=92) on a later observation
  await lifecycle.updateLifecycle(lf, [rec({
    ticker: 'BNBR', current_price: 104, data_quality_status: 'CORPORATE_ACTION_RISK'
  })], '11:45');
  const finalized = await lifecycle.finalizeLifecycle(lf);
  assert.equal(finalized.BNBR.first_tp1_touch_at, '11:45');
  assert.equal(finalized.BNBR.first_invalid_at, null);
  assert.equal(finalized.BNBR.final_simulated_outcome, 'TP1_HIT');
  assert.equal(finalized.BNBR.production_eligible_at_first_seen, false);
  assert.equal(finalized.BNBR.production_eligibility_reason, 'data_quality_risk:CORPORATE_ACTION_RISK');
});

// ===================================================================
// 8/9/10/11. Summary partition placement
// ===================================================================
test('E8-11. TP1 partitioning: combined includes both, eligible only clean, risk only CA', async () => {
  const dir = await tmpdir();
  const lifecycleMap = {
    CLEAN: entry({
      ticker: 'CLEAN', first_tp1_touch_at: '10:00', first_entry_touch_at: '09:30',
      final_simulated_outcome: 'TP1_HIT', production_eligible_at_first_seen: true,
      production_eligibility_reason: 'ok', initial_data_quality_status: 'OK',
      max_favorable_excursion_pct: 5.5, max_adverse_excursion_pct: 1.0
    }),
    BNBR: entry({
      ticker: 'BNBR', first_tp1_touch_at: '11:45', first_entry_touch_at: '09:30',
      final_simulated_outcome: 'TP1_HIT', production_eligible_at_first_seen: false,
      production_eligibility_reason: 'data_quality_risk:CORPORATE_ACTION_RISK',
      initial_data_quality_status: 'CORPORATE_ACTION_RISK',
      max_favorable_excursion_pct: 20.93, max_adverse_excursion_pct: 0
    })
  };
  const s = await summarizeLifecycle(dir, lifecycleMap);

  // 8. combined includes both TP1s
  assert.equal(s.combined_metrics.candidate_count, 2);
  assert.equal(s.combined_metrics.tp1_touch_count, 2);
  // 9/11. production-eligible includes only the clean candidate
  assert.equal(s.production_eligible_metrics.candidate_count, 1);
  assert.equal(s.production_eligible_metrics.tp1_touch_count, 1);
  assert.equal(s.production_eligible_metrics.outcome_distribution.TP1_HIT, 1);
  // 10. data-quality-risk includes only the CA candidate's TP1
  assert.equal(s.data_quality_risk_metrics.candidate_count, 1);
  assert.equal(s.data_quality_risk_metrics.tp1_touch_count, 1);
  assert.equal(s.data_quality_risk_metrics.outcome_distribution.TP1_HIT, 1);
  // each partition carries sampled MFE/MAE summaries
  for (const part of ['combined_metrics', 'production_eligible_metrics', 'data_quality_risk_metrics']) {
    assert.ok(s[part].sampled_mfe && 'max' in s[part].sampled_mfe && 'avg' in s[part].sampled_mfe && 'count' in s[part].sampled_mfe);
    assert.ok(s[part].sampled_mae && 'count' in s[part].sampled_mae);
  }
});

// ===================================================================
// 12. Existing top-level summary fields remain present
// ===================================================================
test('E12. existing top-level summary fields remain present (backward compatibility)', async () => {
  const dir = await tmpdir();
  const s = await summarizeLifecycle(dir, {
    CLEAN: entry({ ticker: 'CLEAN', first_tp1_touch_at: '10:00', final_simulated_outcome: 'TP1_HIT',
      production_eligible_at_first_seen: true })
  });
  for (const field of [
    'expected_snapshot_count', 'completed_snapshot_count', 'missing_snapshot_times',
    'total_unique_tickers_observed', 'max_favorable_movement', 'max_adverse_movement',
    'entry_touch_count', 'tp1_touch_count', 'tp2_touch_count', 'sl_touch_count',
    'invalid_count', 'stale_count', 'entry_missed_count', 'outcome_distribution',
    'data_quality_and_provider_errors', 'note'
  ]) {
    assert.ok(field in s, 'missing top-level field: ' + field);
  }
  assert.equal(s.version, 'intraday-sample-summary-v1.1');
});

// ===================================================================
// 13. Sampled-price aliases equal the existing lifecycle values
// ===================================================================
test('E13. sampled-price aliases equal their canonical lifecycle source fields', async () => {
  const dir = await tmpdir();
  const lf = path.join(dir, 'lifecycle.json');
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 87 })], '09:15');
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 104 })], '11:45');
  await lifecycle.updateLifecycle(lf, [rec({ current_price: 86 })], '13:45');
  const e = (await lifecycle.readLifecycle(lf)).TEST;
  assert.equal(e.sampled_high_after_first_seen, e.intraday_high_after_first_seen);
  assert.equal(e.sampled_low_after_first_seen, e.intraday_low_after_first_seen);
  assert.equal(e.sampled_mfe_pct, e.max_favorable_excursion_pct);
  assert.equal(e.sampled_mae_pct, e.max_adverse_excursion_pct);
  assert.equal(e.first_price_inactivity_at, e.first_stale_at);
  // MFE for refEntry 86 and sampled high 104 == 20.93%
  assert.equal(e.sampled_mfe_pct, 20.93);
});

// ===================================================================
// 14. Old lifecycle entries without new fields can still be summarized
// ===================================================================
test('E14. legacy lifecycle entries lacking v1.1 fields still summarize (fallback classification)', async () => {
  const dir = await tmpdir();
  // Legacy entry: no production_eligible_at_first_seen, no data_quality_statuses,
  // no aliases. Mirrors a pre-change lifecycle.json entry.
  const legacy = {
    LEGACY: {
      ticker: 'LEGACY',
      first_seen_at: '09:15',
      number_of_observations: 3,
      first_seen_price: 100,
      intraday_high_after_first_seen: 108,
      intraday_low_after_first_seen: 99,
      max_favorable_excursion_pct: 8,
      max_adverse_excursion_pct: 1,
      entry_low: 98, entry_high: 100, reference_entry_price: 99,
      tp1: 106, tp2: 112, sl: 94,
      first_entry_touch_at: '09:30', first_tp1_touch_at: '11:00',
      first_tp2_touch_at: null, first_sl_touch_at: null,
      first_invalid_at: null, first_stale_at: null, first_entry_missed_at: null,
      final_simulated_outcome: null,
      statuses: ['TRADE_CANDIDATE']
    }
  };
  const s = await summarizeLifecycle(dir, legacy);
  // does not throw; legacy entry stays in combined but is NOT production-eligible
  assert.equal(s.combined_metrics.candidate_count, 1);
  assert.equal(s.production_eligible_metrics.candidate_count, 0, 'unknown legacy must not be counted eligible');
  assert.equal(s.data_quality_risk_metrics.candidate_count, 0, 'unknown legacy is not a positive data-quality risk');
  assert.equal(s.legacy_unclassified_metrics.candidate_count, 1, 'unknown legacy surfaces in its own partition');
  // finalize normalized aliases onto the legacy entry
  const finalized = JSON.parse(await fs.readFile(path.join(dir, 'lifecycle.json'), 'utf8'));
  assert.equal(finalized.LEGACY.sampled_high_after_first_seen, 108);
  assert.equal(finalized.LEGACY.final_simulated_outcome, 'TP1_HIT');
  // conservative fallback: an unknown legacy entry must NOT be silently eligible
  const res = summary.resolveEntryEligibility(legacy.LEGACY);
  assert.equal(res.eligible, false);
  assert.equal(res.classification, 'legacy_unclassified');
  assert.equal(res.reason, 'legacy_missing_data_quality');
  assert.equal(res.source, 'legacy_conservative');
});

// A legacy entry that DID retain a data-quality status classifies over its history
test('E14b. legacy entry with recorded risk status is classified as data-quality risk', () => {
  const res = summary.resolveEntryEligibility({
    ticker: 'OLD', initial_data_quality_status: 'CORPORATE_ACTION_RISK'
  });
  assert.equal(res.eligible, false);
  assert.equal(res.classification, 'data_quality_risk');
  assert.equal(res.source, 'whole_lifecycle_status_history');
  assert.equal(res.reason, 'data_quality_risk:CORPORATE_ACTION_RISK');
});

// A legacy entry that positively proves clean (recorded OK) is eligible
test('E14c. legacy entry with recorded clean status is production eligible', () => {
  const res = summary.resolveEntryEligibility({ ticker: 'OLD', initial_data_quality_status: 'OK' });
  assert.equal(res.eligible, true);
  assert.equal(res.classification, 'eligible');
});

// ===================================================================
// 15. Collector safety / non-mutation invariants remain intact
// ===================================================================
test('E15. lifecycle + eligibility modules perform no production mutation (no supabase/telegram)', () => {
  const nodeFs = require('node:fs');
  const lsrc = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'intraday-sample-lifecycle.js'), 'utf8');
  const ssrc = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'intraday-sample-summary.js'), 'utf8');
  const psrc = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'intraday-production-eligibility.js'), 'utf8');
  for (const src of [lsrc, ssrc, psrc]) {
    assert.ok(!src.includes('supabase'));
    assert.ok(!src.includes('telegram'));
    assert.ok(!src.includes('.insert('));
    assert.ok(!src.includes('.upsert('));
  }
  // eligibility helper must not IMPORT any API handler (doc references are fine)
  assert.ok(!psrc.includes("require('../api"));
  assert.ok(!psrc.includes("require(\"../api"));
  assert.ok(!psrc.match(/require\(['"][^'"]*sector-hot/));
});

// ===================================================================
// 16. API endpoint JavaScript count remains exactly 12
// ===================================================================
test('E16. API endpoint count remains exactly 12', async () => {
  const entries = await fs.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});

// Extra: the shared policy must not use execution_grade to decide eligibility
test('E-policy. execution_grade "Avoid" alone does not make a clean candidate ineligible', () => {
  const r = policy.classifyProductionEligibility({ data_quality_status: 'OK', execution_grade: 'Avoid' });
  assert.equal(r.eligible, true);
  assert.equal(r.reason, 'ok');
});
