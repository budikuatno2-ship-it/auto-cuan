'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const shadow = require('../lib/intraday-shadow-scoring');
const cli = require('../tools/intraday-shadow-scoring');

const FIXTURES = path.join(__dirname, 'fixtures', 'intraday-shadow-scoring');
const DATES = ['2026-07-20', '2026-07-21', '2026-07-22'];
const SAFE_ENV = Object.freeze({
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
  TELEGRAM_ENABLED: '0'
});

async function tmpdir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix || 'shadow-test-'));
}

function hashDir(dir) {
  // Deterministic content hash of every file under dir (path + bytes).
  const files = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) walk(p);
      else files.push([path.relative(dir, p), fs.readFileSync(p)]);
    }
  })(dir);
  const h = crypto.createHash('sha256');
  for (const [rel, buf] of files) { h.update(rel); h.update('\0'); h.update(buf); h.update('\0'); }
  return h.digest('hex');
}

async function runOnFixtures(overrides) {
  const outputRoot = await tmpdir('shadow-out-');
  const result = await shadow.runShadowScoring(Object.assign({
    inputRoot: FIXTURES,
    outputRoot,
    dates: DATES.slice(),
    env: Object.assign({}, SAFE_ENV)
  }, overrides || {}));
  return { result, outputRoot };
}

// ===================================================================
// Date acceptance / rejection
// ===================================================================

test('1. all three supported dates are accepted', async () => {
  const { result } = await runOnFixtures();
  assert.equal(result.status, 'success');
  assert.deepEqual(result.dates, DATES);
  assert.equal(result.evaluations.length, 3);
});

test('2. unsupported (but well-formed) date is rejected', async () => {
  const { result } = await runOnFixtures({ dates: ['2026-07-23'] });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'unsupported_date');
});

test('3. malformed date string is rejected with a clear reason', async () => {
  const bad = shadow.validateSupportedDate('2026-13-99', DATES);
  assert.equal(bad.valid, false);
  const notReal = shadow.validateSupportedDate('2026-02-30', DATES);
  assert.equal(notReal.valid, false);
  assert.equal(notReal.reason, 'not_a_real_date');
  const garbage = shadow.validateSupportedDate('not-a-date', DATES);
  assert.equal(garbage.valid, false);
  assert.equal(garbage.reason, 'bad_format');
});

// ===================================================================
// Malformed JSONL handling
// ===================================================================

test('4. malformed JSONL lines are counted and skipped safely', async () => {
  const dir = await tmpdir('shadow-malformed-');
  const dateDir = path.join(dir, 'input', '2026-07-20');
  await fsp.mkdir(dateDir, { recursive: true });
  await fsp.writeFile(path.join(dateDir, 'runs.jsonl'),
    JSON.stringify({ type: 'sample_run', status: 'success', scheduled_time: '09:15' }) + '\n' +
    '{ this is not valid json \n');
  await fsp.writeFile(path.join(dateDir, 'candidates.jsonl'),
    JSON.stringify({ ticker: 'BBCA', scheduled_time: '09:15', liquidity_component: 90, momentum_component: 55, pre_spike_component: 60, risk_reward_component: 70, trend_component: 75, penalty_component: 0, score: 68 }) + '\n' +
    'NOT JSON AT ALL\n' +
    '{"ticker":"BBRI","scheduled_time":"09:15"' + '\n');
  const result = await shadow.runShadowScoring({
    inputRoot: path.join(dir, 'input'),
    outputRoot: path.join(dir, 'output'),
    dates: ['2026-07-20'],
    env: Object.assign({}, SAFE_ENV)
  });
  assert.equal(result.status, 'success');
  const summary = result.evaluations[0].summary;
  assert.equal(summary.missing_or_malformed.malformed_candidate_lines, 2);
  assert.equal(summary.missing_or_malformed.malformed_run_lines, 1);
  // The single valid candidate (BBCA) is still scored.
  assert.equal(summary.total_unique_candidates, 1);
});

test('5. missing files are reported, not fatal', async () => {
  const dir = await tmpdir('shadow-missing-');
  await fsp.mkdir(path.join(dir, 'input', '2026-07-20'), { recursive: true });
  const result = await shadow.runShadowScoring({
    inputRoot: path.join(dir, 'input'),
    outputRoot: path.join(dir, 'output'),
    dates: ['2026-07-20'],
    env: Object.assign({}, SAFE_ENV)
  });
  assert.equal(result.status, 'success');
  const mm = result.evaluations[0].summary.missing_or_malformed;
  assert.ok(mm.missing_files.includes('runs.jsonl'));
  assert.ok(mm.missing_files.includes('candidates.jsonl'));
});

// ===================================================================
// Source files remain byte-identical (never rewrites source)
// ===================================================================

test('6. source sample files remain byte-identical after evaluation', async () => {
  const before = hashDir(FIXTURES);
  await runOnFixtures();
  const after = hashDir(FIXTURES);
  assert.equal(after, before, 'source fixtures must not be modified by the evaluator');
});

// ===================================================================
// Output structure
// ===================================================================

test('7. exactly one Top 5 set per valid snapshot, capped at 5', async () => {
  const { result } = await runOnFixtures();
  for (const ev of result.evaluations) {
    const snapshotTimes = ev.summary.evaluated_snapshot_times;
    assert.equal(ev.top5.length, snapshotTimes.length, 'one Top 5 set per snapshot');
    const seen = new Set();
    for (const snap of ev.top5) {
      assert.ok(!seen.has(snap.snapshot), 'no duplicate snapshot Top 5 sets');
      seen.add(snap.snapshot);
      assert.ok(snap.top5.length <= shadow.TOP_N, 'Top 5 has at most 5 members');
      // ranks are 1..n contiguous within the top5 block
      snap.top5.forEach((t, i) => assert.equal(t.rank, i + 1));
    }
  }
});

test('8. per-date output files are written (scores, top5, summary) + comparison', async () => {
  const { result, outputRoot } = await runOnFixtures();
  for (const date of DATES) {
    const dir = path.join(outputRoot, date);
    assert.ok(fs.existsSync(path.join(dir, 'shadow-scores.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'shadow-top5.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'shadow-summary.json')));
  }
  const comparison = path.join(outputRoot, 'comparison-2026-07-20-to-2026-07-22.json');
  assert.ok(fs.existsSync(comparison));
  assert.equal(result.comparison_path, comparison);
});

test('9. score-component breakdown and reasons are stored (not just final score)', async () => {
  const { outputRoot } = await runOnFixtures();
  const line = fs.readFileSync(path.join(outputRoot, '2026-07-20', 'shadow-scores.jsonl'), 'utf8').trim().split('\n')[0];
  const rec = JSON.parse(line);
  for (const k of ['liquidity', 'pre_spike', 'momentum', 'risk_reward', 'trend', 'penalty']) {
    assert.ok(typeof rec.score_components[k] === 'number', 'component ' + k + ' present');
  }
  assert.ok(typeof rec.base_score === 'number');
  assert.ok(typeof rec.persistence_bonus === 'number');
  assert.ok(typeof rec.momentum_bonus === 'number');
  assert.ok(Array.isArray(rec.reasons) && rec.reasons.length > 0);
  assert.ok(Array.isArray(rec.reason_codes));
});

// ===================================================================
// Deterministic ranking
// ===================================================================

test('10. ranking is deterministic across repeated evaluations', async () => {
  const a = await shadow.evaluateDate(path.join(FIXTURES, '2026-07-20'), '2026-07-20', {});
  const b = await shadow.evaluateDate(path.join(FIXTURES, '2026-07-20'), '2026-07-20', {});
  assert.deepEqual(a.scores, b.scores);
  assert.deepEqual(a.top5, b.top5);
});

test('11. equal-score candidates break ties by momentum then ticker (deterministic)', () => {
  const state = new Map();
  // Two candidates with identical shadow score; higher momentum wins, then ticker asc.
  const scored = shadow.scoreSnapshot([
    { ticker: 'ZZZZ', liquidity_component: 50, pre_spike_component: 50, momentum_component: 60, risk_reward_component: 50, trend_component: 50, penalty_component: 0 },
    { ticker: 'AAAA', liquidity_component: 50, pre_spike_component: 50, momentum_component: 60, risk_reward_component: 50, trend_component: 50, penalty_component: 0 },
    { ticker: 'MMMM', liquidity_component: 60, pre_spike_component: 50, momentum_component: 50, risk_reward_component: 50, trend_component: 50, penalty_component: 0 }
  ], '09:15', state);
  // ZZZZ and AAAA have higher momentum (60) => ranked above MMMM.
  // Between ZZZZ and AAAA (identical), ticker asc => AAAA first.
  assert.equal(scored[0].ticker, 'AAAA');
  assert.equal(scored[1].ticker, 'ZZZZ');
  assert.equal(scored[2].ticker, 'MMMM');
});

// ===================================================================
// Persistence + momentum behavior
// ===================================================================

test('12. ASPR-like strengthening candidate rises in rank within the day', async () => {
  const ev = await shadow.evaluateDate(path.join(FIXTURES, '2026-07-20'), '2026-07-20', {});
  const ranks = ev.summary.aspr_progression.per_snapshot.map((p) => p.rank);
  // strictly non-increasing rank number (i.e., improving toward #1)
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] <= ranks[i - 1], 'ASPR rank should improve or hold: ' + ranks);
  assert.equal(ev.summary.aspr_progression.best_rank, 1);
  assert.equal(ev.summary.aspr_progression.rank_direction, 'improving');
  assert.equal(ev.summary.aspr_progression.strengthened, true);
});

test('13. ASPR improves across the three days (comparison)', async () => {
  const { result } = await runOnFixtures();
  const aspr = result.comparison.aspr_rank_progression;
  assert.equal(aspr.cross_day_direction, 'improving');
  const avgRanks = aspr.per_day.map((d) => d.avg_rank);
  for (let i = 1; i < avgRanks.length; i++) assert.ok(avgRanks[i] <= avgRanks[i - 1], 'ASPR avg rank improves across days: ' + avgRanks);
});

test('14. ATLA-like one-snapshot candidate does not dominate and gets no persistence bonus', async () => {
  const ev = await shadow.evaluateDate(path.join(FIXTURES, '2026-07-20'), '2026-07-20', {});
  const atla = ev.summary.atla_behavior;
  assert.equal(atla.observed, true);
  assert.equal(atla.is_one_snapshot, true);
  assert.equal(atla.received_persistence_bonus, false);
  assert.equal(atla.rejected_as_persistent_pick, true);
  // It appears (may be in Top 5) but is never #1.
  assert.ok(atla.best_rank > 1, 'ATLA must not be the #1 pick; got rank ' + atla.best_rank);
  assert.ok(ev.summary.atla_style_one_snapshot_candidates.includes('ATLA'));
  assert.ok(ev.summary.transient_candidates.includes('ATLA'));
  assert.ok(!ev.summary.persistent_candidates.includes('ATLA'));
});

test('15. persistence contributes but does NOT fully dominate — higher base beats longer persistence', () => {
  const state = new Map();
  // OLDCO persists across many snapshots but has a flat, mediocre base.
  const oldco = { ticker: 'OLDC', liquidity_component: 55, pre_spike_component: 55, momentum_component: 55, risk_reward_component: 55, trend_component: 55, penalty_component: 0 };
  for (let i = 0; i < 8; i++) shadow.scoreSnapshot([oldco], '09:' + String(15 + i).padStart(2, '0'), state);
  // Its persistence bonus is capped.
  const oldState = state.get('OLDC');
  assert.ok(oldState.appearances >= 6);

  // NEWCO appears fresh (no persistence) but with a clearly stronger base.
  const scored = shadow.scoreSnapshot([
    Object.assign({}, oldco),
    { ticker: 'NEWC', liquidity_component: 85, pre_spike_component: 80, momentum_component: 88, risk_reward_component: 82, trend_component: 84, penalty_component: 0 }
  ], '11:00', state);
  const newc = scored.find((s) => s.ticker === 'NEWC');
  const oldc = scored.find((s) => s.ticker === 'OLDC');
  assert.equal(newc.rank, 1, 'a genuinely stronger fresh candidate outranks a long-persisting mediocre one');
  assert.ok(oldc.persistence_bonus <= shadow.PERSISTENCE_CAP);
  assert.ok(newc.shadow_score > oldc.shadow_score);
});

// ===================================================================
// Static Top 5 concentration warning
// ===================================================================

test('16. static Top 5 concentration triggers a warning', async () => {
  // Days 21 & 22 have an identical Top-5 membership every snapshot -> warning.
  const ev = await shadow.evaluateDate(path.join(FIXTURES, '2026-07-22'), '2026-07-22', {});
  assert.equal(ev.summary.static_top5_domination.dominates, true);
  assert.equal(ev.summary.same_static_tickers_dominate_every_top5, true);
  assert.ok(ev.summary.warnings.some((w) => w.startsWith('STATIC_TOP5_DOMINATION')));
});

test('17. a genuinely dynamic day does NOT raise the static-domination warning', async () => {
  const ev = await shadow.evaluateDate(path.join(FIXTURES, '2026-07-20'), '2026-07-20', {});
  assert.equal(ev.summary.static_top5_domination.dominates, false);
  assert.ok(!ev.summary.warnings.some((w) => w.startsWith('STATIC_TOP5_DOMINATION')));
});

// ===================================================================
// Forward returns honesty
// ===================================================================

test('18. missing forward-return data does not produce fake profitability claims', async () => {
  const { result } = await runOnFixtures();
  for (const ev of result.evaluations) {
    assert.equal(ev.summary.forward_returns.available, false);
    assert.equal(ev.summary.forward_returns.profitability_evaluated, false);
    assert.equal(ev.summary.forward_returns.hit_rate_evaluated, false);
    assert.match(ev.summary.forward_returns.note, /CANNOT yet be evaluated/i);
  }
  assert.equal(result.comparison.forward_returns.profitability_evaluated, false);
});

// ===================================================================
// Safety: scoring / mutation / telegram disabled
// ===================================================================

test('19. scoring enabled fails the safety gate and refuses to run', async () => {
  const gate = shadow.assertShadowSafety({ DAYTRADE_INTRADAY_SCORE_ENABLED: '1' });
  assert.equal(gate.safe, false);
  const gate2 = shadow.assertShadowSafety({ DAYTRADE_INTRADAY_SCORE_ENABLED: 'true' });
  assert.equal(gate2.safe, false);
  const result = await shadow.runShadowScoring({
    inputRoot: FIXTURES, outputRoot: await tmpdir('shadow-refuse-'),
    dates: DATES.slice(), env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' }
  });
  assert.equal(result.status, 'safety_violation');
});

test('20. mutation enabled fails the safety gate', async () => {
  const gate = shadow.assertShadowSafety({ DAYTRADE_WORKER_ALLOW_MUTATION: 'true' });
  assert.equal(gate.safe, false);
  assert.ok(gate.errors.some((e) => e.includes('DAYTRADE_WORKER_ALLOW_MUTATION')));
});

test('21. telegram enabled fails the safety gate', async () => {
  assert.equal(shadow.assertShadowSafety({ TELEGRAM_ENABLED: '1' }).safe, false);
  assert.equal(shadow.assertShadowSafety({ TELEGRAM_ENABLED: 'true' }).safe, false);
  assert.equal(shadow.assertShadowSafety(Object.assign({}, SAFE_ENV)).safe, true);
});

test('22. enforceShadowSafetyDefaults hard-sets the safe values', () => {
  const env = { DAYTRADE_INTRADAY_SCORE_ENABLED: 'maybe', DAYTRADE_WORKER_ALLOW_MUTATION: 'x', TELEGRAM_ENABLED: 'x' };
  const out = shadow.enforceShadowSafetyDefaults(env);
  assert.equal(env.DAYTRADE_INTRADAY_SCORE_ENABLED, 'false');
  assert.equal(env.DAYTRADE_WORKER_ALLOW_MUTATION, 'false');
  assert.equal(env.TELEGRAM_ENABLED, '0');
  assert.deepEqual(out, { DAYTRADE_INTRADAY_SCORE_ENABLED: 'false', DAYTRADE_WORKER_ALLOW_MUTATION: 'false', TELEGRAM_ENABLED: '0' });
});

test('23. no Telegram / Supabase / mutation code is imported by the shadow modules', () => {
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'intraday-shadow-scoring.js'), 'utf8');
  const toolSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'intraday-shadow-scoring.js'), 'utf8');
  for (const src of [libSrc, toolSrc]) {
    assert.ok(!/require\(['"].*telegram/i.test(src), 'must not import telegram code');
    assert.ok(!/@supabase\/supabase-js/.test(src), 'must not import supabase client');
    assert.ok(!/\.insert\(|\.upsert\(|\.update\(/.test(src), 'must not perform DB mutations');
    assert.ok(!/sendTelegram\(|notifyTelegram\(/.test(src), 'must not send telegram');
  }
});

// ===================================================================
// No recommendation / portfolio mutation; only writes under outputRoot
// ===================================================================

test('24. evaluation only writes under outputRoot and never mutates source recommendations/portfolio state', async () => {
  const before = hashDir(FIXTURES);
  const { result, outputRoot } = await runOnFixtures();
  const after = hashDir(FIXTURES);
  assert.equal(after, before, 'source directory (recommendations/portfolio proxies) untouched');
  // Every written path is inside outputRoot.
  for (const o of result.outputs) {
    for (const p of Object.values(o.files)) {
      assert.ok(path.resolve(p).startsWith(path.resolve(outputRoot)), 'output stays within outputRoot');
    }
  }
  // Summary asserts no mutation / telegram happened.
  for (const ev of result.evaluations) {
    assert.equal(ev.summary.safety.mutations_performed, false);
    assert.equal(ev.summary.safety.telegram_sent, false);
    assert.equal(ev.summary.safety.source_files_rewritten, false);
  }
});

// ===================================================================
// Rerun idempotency
// ===================================================================

test('25. reruns are idempotent — byte-identical outputs', async () => {
  const outputRoot = await tmpdir('shadow-idem-');
  const opts = { inputRoot: FIXTURES, outputRoot, dates: DATES.slice(), env: Object.assign({}, SAFE_ENV) };
  await shadow.runShadowScoring(opts);
  const first = hashDir(outputRoot);
  await shadow.runShadowScoring(opts); // rerun over same input/output
  const second = hashDir(outputRoot);
  assert.equal(second, first, 'a safe rerun must produce byte-identical output');
});

// ===================================================================
// Safe output paths
// ===================================================================

test('26. output-root inside input-root is refused', async () => {
  const result = await shadow.runShadowScoring({
    inputRoot: FIXTURES,
    outputRoot: path.join(FIXTURES, 'nested-output'),
    dates: DATES.slice(),
    env: Object.assign({}, SAFE_ENV)
  });
  assert.equal(result.status, 'unsafe_output_path');
});

test('27. output-root equal to input-root is refused', async () => {
  const result = await shadow.runShadowScoring({
    inputRoot: FIXTURES, outputRoot: FIXTURES, dates: DATES.slice(), env: Object.assign({}, SAFE_ENV)
  });
  assert.equal(result.status, 'unsafe_output_path');
});

test('28. assertSafeOutputRoot throws for nested/equal, passes for sibling', () => {
  assert.throws(() => shadow.assertSafeOutputRoot('/a/in', '/a/in'), /SAFETY/);
  assert.throws(() => shadow.assertSafeOutputRoot('/a/in', '/a/in/out'), /SAFETY/);
  assert.throws(() => shadow.assertSafeOutputRoot('/a/in/deep', '/a/in'), /SAFETY/);
  assert.equal(shadow.assertSafeOutputRoot('/a/in', '/a/out'), true);
});

// ===================================================================
// CLI-level checks
// ===================================================================

test('29. CLI arg parsing handles the documented VPS invocation', () => {
  const args = cli.parseArgs([
    'node', 'tool',
    '--input-root', '/home/ubuntu/auto-cuan/data/intraday-samples',
    '--output-root', '/home/ubuntu/auto-cuan/data/intraday-shadow-scoring',
    '--dates', '2026-07-20,2026-07-21,2026-07-22'
  ]);
  assert.equal(args.inputRoot, '/home/ubuntu/auto-cuan/data/intraday-samples');
  assert.equal(args.outputRoot, '/home/ubuntu/auto-cuan/data/intraday-shadow-scoring');
  assert.deepEqual(args.dates, ['2026-07-20', '2026-07-21', '2026-07-22']);
});

test('30. API endpoint count remains exactly 12', async () => {
  const entries = await fsp.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});

// ===================================================================
// Summary completeness — every required field present
// ===================================================================

test('31. per-date summary contains every required section', async () => {
  const { result } = await runOnFixtures();
  const s = result.evaluations[0].summary;
  const required = [
    'total_evaluated_snapshots', 'missing_or_malformed', 'total_unique_candidates',
    'top5_appearances_by_ticker', 'average_score_by_ticker', 'score_component_averages',
    'rank_stability', 'persistent_candidates', 'transient_candidates',
    'atla_style_one_snapshot_candidates', 'aspr_progression',
    'same_static_tickers_dominate_every_top5', 'warnings', 'forward_returns'
  ];
  for (const k of required) assert.ok(k in s, 'summary missing required field: ' + k);
});

test('32. comparison report contains every required section', async () => {
  const { result } = await runOnFixtures();
  const c = result.comparison;
  const required = [
    'top5_turnover_between_snapshots', 'top5_turnover_between_days', 'ticker_rank_progression',
    'score_dispersion', 'static_top5_members', 'transient_candidate_handling',
    'aspr_rank_progression', 'atla_rank_and_rejection'
  ];
  for (const k of required) assert.ok(k in c, 'comparison missing required field: ' + k);
});
