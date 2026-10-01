'use strict';

/**
 * Unified Scoring Engine — contract + math tests.
 *
 * These tests pin three things that would otherwise drift silently:
 *   1. The weights add up to exactly 100 and every component is capped.
 *   2. The backward-compatibility aliases the frontend reads are always written
 *      (this is the whole point of the module — see the Fase 3 audit).
 *   3. Missing data is neutral, never a reward.
 */

const test = require('node:test');
const assert = require('node:assert');

const unified = require('../lib/unified-score');

// A fully healthy row: liquid, volume expanding, bandar accumulating with tight
// CR, foreign net buy, price above both MAs, RSI in band, good R:R.
function healthyRow(overrides) {
  return Object.assign({
    ticker: 'HEALTHY',
    category: 'Swing Konglo',
    last_price: 1000,
    change_pct: 1.5,
    value_today: 50e9,
    volume_ratio_20d: 2.2,
    volume_pace: 1.8,
    bandar_label: 'Accumulation',
    bandar_consistent_windows: ['7D', '1M'],
    bandarmologi_metrics: { cr3: 0.72, cr5: 0.88 },
    foreign_1d: 5e9,
    foreign_3d: 15e9,
    foreign_7d: 40e9,
    ma20: 980,
    ma50: 950,
    rsi14: 58,
    risk_reward: 2.8
  }, overrides || {});
}

// A row with no usable inputs at all.
function emptyRow(overrides) {
  return Object.assign({ ticker: 'EMPTY', category: 'Swing Konglo' }, overrides || {});
}

test('weights total exactly 100', () => {
  const sum = Object.values(unified.WEIGHTS).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, 100);
  assert.strictEqual(unified.MAX_WEIGHTED_TOTAL, 100);
});

test('component weights match the Fase 3 specification', () => {
  assert.strictEqual(unified.WEIGHTS.liquidity, 15);
  assert.strictEqual(unified.WEIGHTS.volume, 20);
  assert.strictEqual(unified.WEIGHTS.bandarmologi, 25);
  assert.strictEqual(unified.WEIGHTS.foreign, 15);
  assert.strictEqual(unified.WEIGHTS.price_action, 15);
  assert.strictEqual(unified.WEIGHTS.risk_reward, 10);
});

test('hard penalty values match the Fase 3 specification', () => {
  assert.strictEqual(unified.HARD_PENALTIES.DISTRIBUSI_BANDAR, -25);
  assert.strictEqual(unified.HARD_PENALTIES.RETAIL_TRAP, -20);
  assert.strictEqual(unified.HARD_PENALTIES.OVEREXTENDED, -15);
});

test('score is always an integer within 0-100', () => {
  const cases = [
    healthyRow(),
    emptyRow(),
    healthyRow({ bandar_label: 'Distribution', entry_chase_pct: 12, ara_hit: true }),
    healthyRow({ value_today: 0, volume_ratio_20d: 0, risk_reward: 0.5 })
  ];
  for (const row of cases) {
    const res = unified.calculateUnifiedScore(row);
    assert.ok(Number.isInteger(res.score), 'score must be an integer, got ' + res.score);
    assert.ok(res.score >= 0 && res.score <= 100, 'score out of range: ' + res.score);
  }
});

test('healthy row scores high and empty row scores low', () => {
  const healthy = unified.calculateUnifiedScore(healthyRow());
  const empty = unified.calculateUnifiedScore(emptyRow());

  assert.ok(healthy.score >= 80, 'healthy row should score >= 80, got ' + healthy.score);
  assert.ok(empty.score <= 20, 'empty row should score <= 20, got ' + empty.score);
  assert.ok(healthy.score > empty.score);
});

test('missing data is neutral, never a reward', () => {
  const res = unified.calculateUnifiedScore(emptyRow());
  // Every component must report itself unavailable rather than silently
  // awarding points for absent inputs.
  const unavailable = res.components.filter(c => c.available === false);
  assert.strictEqual(unavailable.length, 6, 'all 6 components should be unavailable on an empty row');
  res.components.forEach(c => {
    assert.strictEqual(c.points, 0, c.key + ' must award 0 when data is missing');
  });
});

test('a row missing one component still scores from the others', () => {
  const noForeign = healthyRow({ foreign_1d: null, foreign_3d: null, foreign_7d: null, foreign_label: null });
  const res = unified.calculateUnifiedScore(noForeign);
  const foreign = res.components.find(c => c.key === 'foreign');
  assert.strictEqual(foreign.available, false);
  assert.strictEqual(foreign.points, 0);
  assert.ok(res.score >= 60, 'remaining components should still carry the score, got ' + res.score);
});

test('bandar Distribution triggers the -25 hard penalty', () => {
  const res = unified.calculateUnifiedScore(healthyRow({ bandar_label: 'Distribution' }));
  const penalty = res.penalties.find(p => p.rule === 'PENALTY_DISTRIBUSI_BANDAR');
  assert.ok(penalty, 'DISTRIBUSI_BANDAR penalty must be applied');
  assert.strictEqual(penalty.points, -25);
});

test('retail trap triggers the -20 hard penalty', () => {
  const res = unified.calculateUnifiedScore(healthyRow({ retail_net: 5e9, inst_net: -3e9 }));
  const penalty = res.penalties.find(p => p.rule === 'PENALTY_RETAIL_TRAP');
  assert.ok(penalty, 'RETAIL_TRAP penalty must be applied');
  assert.strictEqual(penalty.points, -20);
});

test('retail trap is also detected from narrative text', () => {
  const res = unified.calculateUnifiedScore(healthyRow({ notes: 'Ritel serok di atas, bandar distribusi' }));
  const penalty = res.penalties.find(p => p.rule === 'PENALTY_RETAIL_TRAP');
  assert.ok(penalty, 'RETAIL_TRAP penalty must be applied from notes');
});

test('overextended chase triggers the -15 hard penalty', () => {
  const res = unified.calculateUnifiedScore(healthyRow({ entry_chase_pct: 9 }));
  const penalty = res.penalties.find(p => p.rule === 'PENALTY_OVEREXTENDED');
  assert.ok(penalty, 'OVEREXTENDED penalty must be applied');
  assert.strictEqual(penalty.points, -15);
});

test('ARA proximity triggers the -15 hard penalty', () => {
  const res = unified.calculateUnifiedScore(healthyRow({ ara_hit: true }));
  const penalty = res.penalties.find(p => p.rule === 'PENALTY_OVEREXTENDED');
  assert.ok(penalty, 'OVEREXTENDED penalty must be applied when pinned at ARA');
});

test('penalties can drive a score to the floor of 0 but never below', () => {
  const res = unified.calculateUnifiedScore({
    ticker: 'WORST',
    category: 'Swing Konglo',
    bandar_label: 'Distribution',
    retail_net: 5e9,
    inst_net: -3e9,
    entry_chase_pct: 20,
    ara_hit: true
  });
  assert.strictEqual(res.score, 0);
  assert.ok(res.penalty_total <= 0);
});

test('breakdown lists every awarded rule with its component', () => {
  const res = unified.calculateUnifiedScore(healthyRow());
  assert.ok(Array.isArray(res.breakdown));
  assert.ok(res.breakdown.length > 0, 'breakdown must not be empty');
  res.breakdown.forEach(entry => {
    assert.ok(typeof entry.rule === 'string' && entry.rule.length > 0, 'rule name required');
    assert.ok(typeof entry.label === 'string' && entry.label.length > 0, 'human label required');
    assert.ok(typeof entry.component === 'string', 'component attribution required');
    assert.ok(Number.isFinite(entry.points), 'points must be numeric');
  });
});

test('grades follow the documented thresholds', () => {
  assert.strictEqual(unified.gradeFor(90), 'A+');
  assert.strictEqual(unified.gradeFor(85), 'A+');
  assert.strictEqual(unified.gradeFor(82), 'A');
  assert.strictEqual(unified.gradeFor(80), 'A');
  assert.strictEqual(unified.gradeFor(70), 'B');
  assert.strictEqual(unified.gradeFor(65), 'B');
  assert.strictEqual(unified.gradeFor(55), 'C');
  assert.strictEqual(unified.gradeFor(50), 'C');
  assert.strictEqual(unified.gradeFor(30), 'D');
});

test('volume ratio resolves from any of the three frontend aliases', () => {
  assert.strictEqual(unified.resolveVolumeRatio({ volume_ratio_20d: 1.8 }), 1.8);
  assert.strictEqual(unified.resolveVolumeRatio({ volume_ratio: 1.6 }), 1.6);
  assert.strictEqual(unified.resolveVolumeRatio({ volume_ratio_avg20: 1.4 }), 1.4);
  // Precedence: 20d wins when several are present.
  assert.strictEqual(unified.resolveVolumeRatio({ volume_ratio_20d: 2.0, volume_ratio: 1.0 }), 2.0);
  assert.strictEqual(unified.resolveVolumeRatio({}), null);
});

// ---------------------------------------------------------------------------
// Backward-compatibility layer — the contract the frontend audit pinned down.
// ---------------------------------------------------------------------------

test('applyUnifiedScore writes every score alias the frontend reads', () => {
  const row = healthyRow();
  unified.applyUnifiedScore(row);

  for (const alias of unified.SCORE_ALIASES) {
    assert.ok(row[alias] != null, 'score alias missing: ' + alias);
    assert.strictEqual(row[alias], row.unified_score, alias + ' must equal unified_score');
  }
  // Spot-check the exact fields named in the Fase 3 brief.
  assert.strictEqual(row.score, row.unified_score);
  assert.strictEqual(row.daytrade_score, row.unified_score);
  assert.strictEqual(row.combined_score, row.unified_score);
});

test('applyUnifiedScore writes every volume-ratio alias (frontend Bug #1)', () => {
  const row = healthyRow({ volume_ratio_20d: 1.9, volume_ratio: undefined, volume_ratio_avg20: undefined });
  unified.applyUnifiedScore(row);

  for (const alias of unified.VOLUME_RATIO_ALIASES) {
    assert.strictEqual(row[alias], 1.9, alias + ' must be synced to the resolved ratio');
  }
});

test('applyUnifiedScore does not invent a volume ratio when none exists', () => {
  const row = emptyRow();
  unified.applyUnifiedScore(row);
  assert.strictEqual(row.volume_ratio, undefined, 'must not write a fabricated volume ratio');
  assert.strictEqual(row.volume_ratio_20d, undefined);
  assert.strictEqual(row.volume_ratio_avg20, undefined);
});

test('applyUnifiedScore preserves trading-plan fields untouched', () => {
  const row = healthyRow({
    entry_low: 950,
    entry_high: 1000,
    stop_loss: 900,
    tp1: 1100,
    tp2: 1200,
    risk_reward: 2.5
  });
  unified.applyUnifiedScore(row);

  assert.strictEqual(row.entry_low, 950);
  assert.strictEqual(row.entry_high, 1000);
  assert.strictEqual(row.stop_loss, 900);
  assert.strictEqual(row.tp1, 1100);
  assert.strictEqual(row.tp2, 1200);
  assert.strictEqual(row.risk_reward, 2.5);
});

test('applyUnifiedScore preserves the bandarmologi label verbatim', () => {
  // The card badge renders "Akumulasi"/"Distribusi"/"Campuran" straight from
  // this field; rewriting it here would desync badge and score.
  for (const label of ['Accumulation', 'Distribution', 'Mixed']) {
    const row = healthyRow({ bandar_label: label });
    unified.applyUnifiedScore(row);
    assert.strictEqual(row.bandar_label, label);
  }
});

test('applyUnifiedScore records the pre-unified score once', () => {
  const row = healthyRow({ score: 61 });
  unified.applyUnifiedScore(row);
  assert.strictEqual(row.score_before_unified, 61);

  // A second pass must not overwrite the original with a derived value.
  const derived = row.score;
  unified.applyUnifiedScore(row);
  assert.strictEqual(row.score_before_unified, 61, 'original score must survive re-enrichment');
  assert.strictEqual(row.score, derived, 're-enrichment must be idempotent');
});

test('applyUnifiedScore never deletes a key it did not own', () => {
  const row = healthyRow({ some_future_field: 'keep me', pattern_label: 'Bullish Engulfing' });
  const before = Object.keys(row).sort();
  unified.applyUnifiedScore(row);
  const after = Object.keys(row).sort();

  for (const key of before) {
    assert.ok(after.includes(key), 'key was removed: ' + key);
  }
  assert.strictEqual(row.some_future_field, 'keep me');
  assert.strictEqual(row.pattern_label, 'Bullish Engulfing');
});

test('applyUnifiedScore neutralises the legacy additive bandar formula', () => {
  // The card prints "Score: 82 (Base: 78 + Bandar: +4)". Once bandarmologi is a
  // 25-point component of the unified score that formula no longer adds up, so
  // the two fields feeding it must be neutralised or the card shows wrong math.
  const row = healthyRow({ score: 78, score_before_bandarmologi: 78, bandar_score_bonus: 4 });
  unified.applyUnifiedScore(row);

  assert.strictEqual(row.score_before_bandarmologi, null, 'legacy base must be neutralised');
  assert.strictEqual(row.bandar_score_bonus, 0, 'legacy bonus must be zeroed');

  // Both card branches are guarded by truthiness, so the formula is hidden.
  const showsFormula = row.score_before_bandarmologi != null && row.bandar_score_bonus;
  assert.ok(!showsFormula, 'card must not render the stale Base+Bandar formula');
});

test('applyUnifiedScore archives the legacy bandar values for audit', () => {
  const row = healthyRow({ score: 78, score_before_bandarmologi: 78, bandar_score_bonus: 4 });
  unified.applyUnifiedScore(row);

  assert.strictEqual(row.legacy_score_before_bandarmologi, 78);
  assert.strictEqual(row.legacy_bandar_score_bonus, 4);
});

test('applyUnifiedScore neutralises the daytrade legacy pair too', () => {
  const row = healthyRow({ daytrade_score_before_bandarmologi: 70, bandar_score_bonus: 5 });
  unified.applyUnifiedScore(row);

  assert.strictEqual(row.daytrade_score_before_bandarmologi, null);
  assert.strictEqual(row.legacy_daytrade_score_before_bandarmologi, 70);
});

test('legacy bandar archival can be disabled for callers that want it untouched', () => {
  const row = healthyRow({ score_before_bandarmologi: 78, bandar_score_bonus: 4 });
  unified.applyUnifiedScore(row, { archiveLegacyBandarBreakdown: false });

  assert.strictEqual(row.score_before_bandarmologi, 78, 'opt-out must leave the field alone');
  assert.strictEqual(row.bandar_score_bonus, 4);
});

test('applyUnifiedScore attaches an auditable breakdown', () => {
  const row = healthyRow();
  unified.applyUnifiedScore(row);
  assert.ok(Array.isArray(row.unified_score_breakdown) && row.unified_score_breakdown.length > 0);
  assert.ok(Array.isArray(row.unified_score_components));
  assert.strictEqual(row.unified_score_version, 'unified-score-v1');
  assert.ok(typeof row.unified_score_grade === 'string');
});

test('applyUnifiedScore persists the raw/penalty arithmetic', () => {
  // An operator must be able to reconcile the final score without re-running
  // the engine: raw_score + penalty_total === score.
  const row = healthyRow({ bandar_label: 'Distribution' });
  unified.applyUnifiedScore(row);

  assert.ok(Number.isFinite(row.unified_score_raw), 'raw score must be persisted');
  assert.ok(Number.isFinite(row.unified_score_penalty_total), 'penalty total must be persisted');
  assert.ok(row.unified_score_penalty_total < 0, 'distribution must produce a negative penalty total');

  const reconciled = Math.round(Math.max(0, Math.min(100, row.unified_score_raw + row.unified_score_penalty_total)));
  assert.strictEqual(reconciled, row.unified_score, 'raw + penalties must reconcile to the final score');
});

test('the persisted arithmetic reconciles exactly, across rounding boundaries', () => {
  // The stored values must be full precision. Storing the 2-decimal rounded
  // pair can shift a sum across a .5 boundary and reconcile to a score one
  // point off, which would make the audit trail look wrong.
  const candidates = [];
  for (let vr = 1.0; vr <= 3.0; vr += 0.05) {
    for (let rr = 1.2; rr <= 3.0; rr += 0.1) {
      candidates.push(healthyRow({
        volume_ratio_20d: Number(vr.toFixed(2)),
        volume_pace: Number(vr.toFixed(2)),
        risk_reward: Number(rr.toFixed(2)),
        value_today: 7e9 + vr * 1e8
      }));
    }
  }

  let checked = 0;
  for (const row of candidates) {
    unified.applyUnifiedScore(row);
    const reconciled = Math.round(Math.max(0, Math.min(100, row.unified_score_raw + row.unified_score_penalty_total)));
    assert.strictEqual(
      reconciled,
      row.unified_score,
      'reconciliation drifted for vr=' + row.volume_ratio_20d + ' rr=' + row.risk_reward +
      ' (raw=' + row.unified_score_raw + ' pen=' + row.unified_score_penalty_total + ')'
    );
    checked++;
  }
  assert.ok(checked > 300, 'sweep should cover a few hundred combinations, got ' + checked);
});

test('applyUnifiedScore is a no-op on non-objects', () => {
  assert.strictEqual(unified.applyUnifiedScore(null), null);
  assert.strictEqual(unified.applyUnifiedScore(undefined), undefined);
  assert.strictEqual(unified.applyUnifiedScore('not a row'), 'not a row');
});

test('applyUnifiedScoreBatch clones rather than mutating inputs', () => {
  const rows = [healthyRow({ ticker: 'AAA' }), healthyRow({ ticker: 'BBB' })];
  const out = unified.applyUnifiedScoreBatch(rows);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(rows[0].unified_score, undefined, 'input rows must not be mutated');
  assert.ok(out[0].unified_score != null);
  assert.strictEqual(out[0].ticker, 'AAA');
});

test('getUnifiedScore reads any alias without mutating', () => {
  assert.strictEqual(unified.getUnifiedScore({ unified_score: 77 }), 77);
  assert.strictEqual(unified.getUnifiedScore({ score: 66 }), 66);
  assert.strictEqual(unified.getUnifiedScore({ daytrade_score: 55 }), 55);
  assert.strictEqual(unified.getUnifiedScore({ combined_score: 44 }), 44);
  assert.strictEqual(unified.getUnifiedScore({}), null);
  assert.strictEqual(unified.getUnifiedScore(null), null);
});

test('unified_score takes precedence so a stale alias cannot override it', () => {
  const row = { unified_score: 88, score: 12, daytrade_score: 3 };
  assert.strictEqual(unified.getUnifiedScore(row), 88);
});

test('calculation is deterministic', () => {
  const a = unified.calculateUnifiedScore(healthyRow());
  const b = unified.calculateUnifiedScore(healthyRow());
  assert.strictEqual(a.score, b.score);
  assert.deepStrictEqual(a.breakdown, b.breakdown);
});

test('higher liquidity scores at least as high as lower liquidity', () => {
  const low = unified.calculateUnifiedScore(healthyRow({ value_today: 6e9 }));
  const high = unified.calculateUnifiedScore(healthyRow({ value_today: 500e9 }));
  assert.ok(high.score >= low.score, 'more liquidity must not score lower');
});

test('higher R:R scores at least as high as lower R:R', () => {
  const low = unified.calculateUnifiedScore(healthyRow({ risk_reward: 1.3 }));
  const high = unified.calculateUnifiedScore(healthyRow({ risk_reward: 3.5 }));
  assert.ok(high.score >= low.score, 'better R:R must not score lower');
});

test('accumulation beats distribution on an otherwise identical row', () => {
  const accum = unified.calculateUnifiedScore(healthyRow({ bandar_label: 'Accumulation' }));
  const dist = unified.calculateUnifiedScore(healthyRow({ bandar_label: 'Distribution' }));
  assert.ok(accum.score > dist.score, 'accumulation must outrank distribution');
});

test('component points never exceed their declared maximum', () => {
  const res = unified.calculateUnifiedScore(healthyRow({
    value_today: 1e15, volume_ratio_20d: 99, volume_pace: 99,
    bandarmologi_metrics: { cr3: 0.99, cr5: 0.99 },
    foreign_1d: 1e13, foreign_3d: 1e13, foreign_7d: 1e13,
    ma20: 1, ma50: 1, rsi14: 55, change_pct: 30, risk_reward: 99
  }));
  res.components.forEach(c => {
    assert.ok(c.points <= c.max + 1e-9, c.key + ' exceeded max: ' + c.points + ' > ' + c.max);
  });
});
