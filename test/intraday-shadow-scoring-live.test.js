'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const live = require('../lib/intraday-shadow-scoring-live');
const shadow = require('../lib/intraday-shadow-scoring');
const cli = require('../tools/intraday-shadow-scoring-live');

const FIXTURES = path.join(__dirname, 'fixtures', 'intraday-shadow-scoring-live');
const DATE = '2026-07-21';
const DATE_DIR = path.join(FIXTURES, DATE);
const SAFE_ENV = Object.freeze({
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
  TELEGRAM_ENABLED: '0'
});

async function tmpdir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix || 'live-shadow-test-'));
}

function hashDir(dir) {
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

async function runSnapshot(scheduledTime, overrides) {
  const outputRoot = await tmpdir('live-out-');
  const result = await live.runLiveShadowSnapshot(Object.assign({
    inputRoot: FIXTURES,
    outputRoot,
    date: DATE,
    scheduledTime,
    env: Object.assign({}, SAFE_ENV),
    skipLock: true
  }, overrides || {}));
  return { result, outputRoot };
}

function confirmedTop5At(evaluation, snapshot) {
  const s = evaluation.confirmed_top5.find((x) => x.snapshot === snapshot);
  return s ? s.confirmed_top5.map((t) => t.ticker) : [];
}
function provisionalTop5At(evaluation, snapshot) {
  const s = evaluation.provisional_top5.find((x) => x.snapshot === snapshot);
  return s ? s.provisional_top5.map((t) => t.ticker) : [];
}

// ===================================================================
// Confirmed-candidate gate
// ===================================================================

test('1. ATLA-style one-snapshot candidate stays provisional and is filtered from the confirmed Top 5', async () => {
  const { result } = await runSnapshot('10:30');
  const ev = result.evaluation;
  // ATLA appears only at 10:15 with a top score -> it IS in the provisional Top 5...
  assert.ok(provisionalTop5At(ev, '10:15').includes('ATLA'), 'ATLA must appear in provisional Top 5');
  // ...but must NOT be in the confirmed Top 5 at any snapshot.
  for (const snap of ev.confirmed_top5) {
    assert.ok(!snap.confirmed_top5.some((t) => t.ticker === 'ATLA'), 'ATLA must never enter confirmed Top 5 at ' + snap.snapshot);
  }
  assert.ok(ev.summary.confirmation.transient_filtered_from_confirmed_top5.includes('ATLA'));
  assert.ok(ev.summary.confirmation.provisional_only_tickers.includes('ATLA'));
  assert.ok(!ev.summary.confirmation.confirmed_tickers.includes('ATLA'));
  // ATLA is still LOGGED as a provisional candidate in the scores stream.
  assert.ok(ev.scores.some((s) => s.ticker === 'ATLA' && s.confirmation_state === 'PROVISIONAL'));
});

test('2. candidate becomes confirmed after two CONSECUTIVE appearances', async () => {
  const { result } = await runSnapshot('10:30');
  const ev = result.evaluation;
  const cons = ev.scores.filter((s) => s.ticker === 'CONS');
  const at0915 = cons.find((s) => s.snapshot === '09:15');
  const at0930 = cons.find((s) => s.snapshot === '09:30');
  assert.equal(at0915.confirmation_state, 'PROVISIONAL', 'first appearance is provisional');
  assert.equal(at0930.confirmed, true, 'confirmed on second consecutive appearance');
  assert.equal(at0930.confirmation_reason, 'TWO_CONSECUTIVE_SNAPSHOTS');
  // Confirmed Top 5 is empty at the very first snapshot (nothing confirmed yet).
  assert.deepEqual(confirmedTop5At(ev, '09:15'), []);
  // CONS enters the confirmed Top 5 at 09:30.
  assert.ok(confirmedTop5At(ev, '09:30').includes('CONS'));
});

test('3. 2-of-last-3 confirmation (non-consecutive gap) confirms the candidate', async () => {
  const { result } = await runSnapshot('10:30');
  const ev = result.evaluation;
  const gaps = ev.scores.filter((s) => s.ticker === 'GAPS');
  const at0915 = gaps.find((s) => s.snapshot === '09:15');
  const at0945 = gaps.find((s) => s.snapshot === '09:45');
  // GAPS appears 09:15, skips 09:30, appears 09:45 -> NOT consecutive, but 2 of last 3.
  assert.equal(at0915.confirmation_state, 'PROVISIONAL');
  assert.equal(at0945.confirmed, true);
  assert.equal(at0945.confirmation_reason, 'TWO_OF_LAST_THREE_SNAPSHOTS');
});

test('4. confirmed status is deterministic across repeated evaluations', async () => {
  const a = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '10:30', {});
  const b = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '10:30', {});
  assert.deepEqual(a.scores, b.scores);
  assert.deepEqual(a.confirmed_top5, b.confirmed_top5);
  assert.deepEqual(a.provisional_top5, b.provisional_top5);
  assert.deepEqual(a.forward_returns, b.forward_returns);
});

test('5. computeConfirmation rules are exact and unit-deterministic', () => {
  // consecutive: appeared at index 2 and 1
  const set1 = new Set([1, 2]);
  assert.deepEqual(
    live.computeConfirmation(set1, 2, false),
    { confirmed: true, state: 'CONFIRMED', reason: 'TWO_CONSECUTIVE_SNAPSHOTS' }
  );
  // 2-of-last-3 with a gap: appeared at index 0 and 2 (skip 1)
  const set2 = new Set([0, 2]);
  assert.equal(live.computeConfirmation(set2, 2, false).reason, 'TWO_OF_LAST_THREE_SNAPSHOTS');
  // single appearance: provisional
  const set3 = new Set([2]);
  assert.deepEqual(
    live.computeConfirmation(set3, 2, false),
    { confirmed: false, state: 'PROVISIONAL', reason: 'SINGLE_SNAPSHOT_UNCONFIRMED' }
  );
  // sticky: previously confirmed and appears again after a long gap
  const set4 = new Set([0, 1, 5]);
  assert.equal(live.computeConfirmation(set4, 5, true).reason, 'STICKY_PREVIOUSLY_CONFIRMED');
  assert.equal(live.computeConfirmation(set4, 5, true).confirmed, true);
});

// ===================================================================
// No look-ahead
// ===================================================================

test('6. ranking uses only snapshots at or before the target time (no look-ahead leakage)', async () => {
  const at0945 = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '09:45', {});
  // Only snapshots up to 09:45 are evaluated.
  assert.deepEqual(at0945.summary.evaluated_snapshot_times, ['09:15', '09:30', '09:45']);
  // No scored row references a snapshot after the target.
  assert.ok(at0945.scores.every((s) => live.timeToMinutes(s.snapshot) <= live.timeToMinutes('09:45')));
  // Candidate rows from later snapshots (e.g. ATLA at 10:15) are ignored, not leaked.
  assert.ok(!at0945.scores.some((s) => s.ticker === 'ATLA'));
  assert.ok(at0945.summary.missing_or_malformed.future_candidate_rows_ignored_no_lookahead > 0);
});

test('7. confirmation at an early snapshot is identical whether evaluated early or as part of a later run', async () => {
  const early = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '09:45', {});
  const later = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '10:30', {});
  // The 09:45 snapshot's confirmed Top 5 membership must be identical in both
  // runs — later data cannot retroactively change an earlier ranking.
  assert.deepEqual(confirmedTop5At(early, '09:45'), confirmedTop5At(later, '09:45'));
  assert.deepEqual(provisionalTop5At(early, '09:45'), provisionalTop5At(later, '09:45'));
});

// ===================================================================
// Forward-return tracking
// ===================================================================

test('8. +15/+30/+60/EOD returns are computed only from existing future snapshots', async () => {
  const ev = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '16:00', {});
  const winr = ev.forward_returns.find((r) => r.ticker === 'WINR' && r.snapshot === '09:30');
  assert.equal(winr.reference_price, 1010);
  assert.equal(winr.horizons.t_plus_15.target_time, '09:45');
  assert.equal(winr.horizons.t_plus_15.price, 1020);
  assert.equal(winr.horizons.t_plus_15.hit_status, 'HIT');
  assert.equal(winr.horizons.t_plus_30.target_time, '10:00');
  assert.equal(winr.horizons.t_plus_60.target_time, '10:30');
  assert.equal(winr.horizons.eod.target_time, '16:00');
  assert.equal(winr.horizons.eod.price, 1100);
  assert.equal(winr.horizons.eod.hit_status, 'HIT');
  // MFE/MAE bounded by observed excursions.
  assert.ok(winr.mfe_pct >= winr.mae_pct);
});

test('9. rising / falling / flat map to HIT / MISS / NEUTRAL against the neutral band', async () => {
  const ev = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '16:00', {});
  const losr = ev.forward_returns.find((r) => r.ticker === 'LOSR' && r.snapshot === '09:30');
  const flat = ev.forward_returns.find((r) => r.ticker === 'FLAT' && r.snapshot === '09:30');
  assert.equal(losr.horizons.t_plus_15.hit_status, 'MISS');
  assert.ok(losr.horizons.eod.raw_return_pct < 0);
  assert.equal(flat.horizons.t_plus_15.hit_status, 'NEUTRAL');
  assert.equal(flat.horizons.t_plus_15.raw_return_pct, 0);
});

test('10. forward returns are only attached after the relevant future snapshot exists (progressive fill)', async () => {
  const early = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '09:45', {});
  const winr = early.forward_returns.find((r) => r.ticker === 'WINR' && r.snapshot === '09:30');
  // At target 09:45 only the +15 horizon (09:45) exists; later horizons are
  // explicitly not-yet-available (never invented).
  assert.equal(winr.horizons.t_plus_15.available, true);
  assert.equal(winr.horizons.t_plus_30.available, false);
  assert.equal(winr.horizons.t_plus_30.missing_reason, 'future_snapshot_not_yet_available');
  assert.equal(winr.horizons.t_plus_60.available, false);
  assert.equal(winr.horizons.eod.available, false);
  assert.equal(winr.horizons.eod.missing_reason, 'eod_snapshot_not_yet_available');
  assert.equal(winr.horizons.t_plus_30.price, null);
});

test('11. missing future prices remain explicitly unavailable with a reason (never invented)', async () => {
  // A candidate present at 16:00 has no +15/+30/+60 snapshot (none scheduled after
  // 10:30 until 16:00) -> those horizons are explicitly missing.
  const ev = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '16:00', {});
  const winrFinal = ev.forward_returns.find((r) => r.ticker === 'WINR' && r.snapshot === '16:00');
  // At the final snapshot every forward horizon is unavailable (no later data).
  if (winrFinal) {
    for (const key of ['t_plus_15', 't_plus_30', 't_plus_60', 'eod']) {
      assert.equal(winrFinal.horizons[key].available, false);
      assert.ok(typeof winrFinal.horizons[key].missing_reason === 'string');
      assert.equal(winrFinal.horizons[key].price, null);
      assert.equal(winrFinal.horizons[key].raw_return_pct, null);
    }
  }
  // A reference at 10:30 has no snapshot at 10:45/11:00/11:30 in the fixture.
  const winr1030 = ev.forward_returns.find((r) => r.ticker === 'WINR' && r.snapshot === '10:30');
  assert.equal(winr1030.horizons.t_plus_15.available, false);
  assert.equal(winr1030.horizons.t_plus_15.missing_reason, 'no_snapshot_at_offset');
});

test('12. hit rate is only reported with a sufficient sample; small samples warn and make no profitability claim', async () => {
  const ev = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '16:00', {});
  const fr = ev.summary.forward_returns;
  assert.equal(fr.profitability_claimed, false);
  // +60 has a small resolved sample in this fixture -> hit rate withheld + warning.
  assert.equal(fr.hit_rates_by_horizon.t_plus_60.sufficient_sample, false);
  assert.equal(fr.hit_rates_by_horizon.t_plus_60.hit_rate, null);
  assert.ok(ev.summary.warnings.some((w) => w.startsWith('SMALL_FORWARD_SAMPLE_T_PLUS_60')));
  // EOD has enough resolved observations -> a hit rate IS reported.
  assert.equal(fr.hit_rates_by_horizon.eod.sufficient_sample, true);
  assert.equal(typeof fr.hit_rates_by_horizon.eod.hit_rate, 'number');
  // Sample sizes are surfaced per horizon.
  assert.ok(fr.sample_sizes_by_horizon.eod >= live.MIN_HIT_RATE_SAMPLE);
});

test('13. no forward-return record fabricates a price or a profitability claim', async () => {
  const ev = await live.evaluateLiveThroughTime(DATE_DIR, DATE, '16:00', {});
  for (const rec of ev.forward_returns) {
    for (const key of Object.keys(rec.horizons)) {
      const h = rec.horizons[key];
      if (!h.available) {
        assert.equal(h.price, null);
        assert.equal(h.raw_return_pct, null);
        assert.equal(h.hit_status, null);
        assert.ok(h.missing_reason, 'missing horizons must carry a reason');
      } else {
        assert.ok(Number.isFinite(h.price));
      }
    }
  }
});

// ===================================================================
// Output structure
// ===================================================================

test('14. all five output files are written under the live output root', async () => {
  const { result, outputRoot } = await runSnapshot('10:30');
  const dir = path.join(outputRoot, DATE);
  for (const f of ['shadow-scores.jsonl', 'provisional-top5.jsonl', 'confirmed-top5.jsonl', 'forward-returns.jsonl', 'live-shadow-summary.json']) {
    assert.ok(fs.existsSync(path.join(dir, f)), 'missing output ' + f);
  }
  // Every written path is inside outputRoot.
  for (const p of Object.values(result.outputs)) {
    assert.ok(path.resolve(p).startsWith(path.resolve(outputRoot)));
  }
});

test('15. summary reports confirmed vs provisional counts, turnover, transient filtering and forward samples', async () => {
  const { result } = await runSnapshot('16:00');
  const s = result.evaluation.summary;
  assert.equal(s.candidate_counts.confirmed_candidates, 6);
  assert.equal(s.candidate_counts.provisional_only_candidates, 1);
  assert.ok(Array.isArray(s.top5_turnover.provisional_between_snapshots));
  assert.ok(Array.isArray(s.top5_turnover.confirmed_between_snapshots));
  assert.equal(s.confirmation.transient_filtered_count, 1);
  assert.ok('sample_sizes_by_horizon' in s.forward_returns);
  assert.ok('hit_rates_by_horizon' in s.forward_returns);
});

// ===================================================================
// Date / time acceptance / rejection (never uses current time)
// ===================================================================

test('16. unsupported (well-formed) date is rejected', async () => {
  const { result } = await runSnapshot('10:15', { date: '2026-07-23' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'unsupported_date');
});

test('17. unsupported / break-period / malformed times are rejected', () => {
  assert.equal(live.validateScheduledTime('12:15').valid, false);        // break period
  assert.equal(live.validateScheduledTime('12:15').reason, 'break_period_rejected');
  assert.equal(live.validateScheduledTime('09:16').valid, false);        // not in schedule
  assert.equal(live.validateScheduledTime('99:99').valid, false);        // bad format
  assert.equal(live.validateScheduledTime('nope').valid, false);
  assert.equal(live.validateScheduledTime('').reason, 'missing_scheduled_time');
  assert.equal(live.validateScheduledTime('10:15').valid, true);
});

test('18. missing date or time is an explicit error — never silently uses the current time', async () => {
  const noDate = await live.runLiveShadowSnapshot({ inputRoot: FIXTURES, outputRoot: await tmpdir('live-'), scheduledTime: '10:15', env: Object.assign({}, SAFE_ENV), skipLock: true });
  assert.equal(noDate.status, 'error');
  assert.ok(noDate.errors[0].includes('date'));
  const noTime = await live.runLiveShadowSnapshot({ inputRoot: FIXTURES, outputRoot: await tmpdir('live-'), date: DATE, env: Object.assign({}, SAFE_ENV), skipLock: true });
  assert.equal(noTime.status, 'error');
  assert.ok(noTime.errors[0].includes('scheduledTime'));
});

// ===================================================================
// Source files remain byte-identical
// ===================================================================

test('19. source sample files remain byte-identical after a live run', async () => {
  const before = hashDir(FIXTURES);
  await runSnapshot('10:30');
  await runSnapshot('16:00');
  const after = hashDir(FIXTURES);
  assert.equal(after, before, 'source fixtures must not be modified by the live runner');
});

// ===================================================================
// Rerun idempotency
// ===================================================================

test('20. reruns of the same snapshot are idempotent — byte-identical outputs', async () => {
  const outputRoot = await tmpdir('live-idem-');
  const opts = { inputRoot: FIXTURES, outputRoot, date: DATE, scheduledTime: '10:30', env: Object.assign({}, SAFE_ENV), skipLock: true };
  await live.runLiveShadowSnapshot(opts);
  const first = hashDir(outputRoot);
  await live.runLiveShadowSnapshot(opts);
  const second = hashDir(outputRoot);
  assert.equal(second, first, 'a safe rerun must produce byte-identical output');
});

// ===================================================================
// Lock prevents overlapping execution
// ===================================================================

test('21. lock prevents overlapping execution', async () => {
  const outputRoot = await tmpdir('live-lock-');
  const lockFile = path.join(outputRoot, '.locks', 'test.lock');
  // Hold the lock with a live (running) PID = our own process.
  const release = await live.acquireLock(lockFile);
  assert.ok(typeof release === 'function');
  try {
    const result = await live.runLiveShadowSnapshot({
      inputRoot: FIXTURES, outputRoot, date: DATE, scheduledTime: '10:15',
      env: Object.assign({}, SAFE_ENV), lockFile
    });
    assert.equal(result.status, 'skipped_due_to_lock');
  } finally {
    await release();
  }
  // Once released, a run acquires the lock and succeeds.
  const ok = await live.runLiveShadowSnapshot({
    inputRoot: FIXTURES, outputRoot, date: DATE, scheduledTime: '10:15',
    env: Object.assign({}, SAFE_ENV), lockFile
  });
  assert.equal(ok.status, 'success');
});

test('22. a released lock file is removed', async () => {
  const outputRoot = await tmpdir('live-lock2-');
  const lockFile = path.join(outputRoot, '.locks', 'x.lock');
  const release = await live.acquireLock(lockFile);
  assert.ok(fs.existsSync(lockFile));
  await release();
  assert.ok(!fs.existsSync(lockFile));
});

// ===================================================================
// Safety: scoring / mutation / telegram disabled
// ===================================================================

test('23. scoring enabled fails the safety gate and refuses to run', async () => {
  const result = await live.runLiveShadowSnapshot({
    inputRoot: FIXTURES, outputRoot: await tmpdir('live-refuse-'),
    date: DATE, scheduledTime: '10:15', env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' }, skipLock: true
  });
  assert.equal(result.status, 'safety_violation');
});

test('24. mutation / telegram enabled fail the safety gate', async () => {
  const mut = await live.runLiveShadowSnapshot({
    inputRoot: FIXTURES, outputRoot: await tmpdir('live-mut-'),
    date: DATE, scheduledTime: '10:15', env: { DAYTRADE_WORKER_ALLOW_MUTATION: 'true' }, skipLock: true
  });
  assert.equal(mut.status, 'safety_violation');
  const tg = await live.runLiveShadowSnapshot({
    inputRoot: FIXTURES, outputRoot: await tmpdir('live-tg-'),
    date: DATE, scheduledTime: '10:15', env: { TELEGRAM_ENABLED: '1' }, skipLock: true
  });
  assert.equal(tg.status, 'safety_violation');
});

test('25. summary asserts scoring / mutation / telegram / supabase / portfolio all disabled', async () => {
  const { result } = await runSnapshot('10:30');
  const safety = result.evaluation.summary.safety;
  assert.equal(safety.production_scoring_enabled, false);
  assert.equal(safety.mutations_performed, false);
  assert.equal(safety.telegram_sent, false);
  assert.equal(safety.supabase_writes, false);
  assert.equal(safety.portfolio_mutated, false);
  assert.equal(safety.source_files_rewritten, false);
  assert.equal(safety.DAYTRADE_INTRADAY_SCORE_ENABLED, 'false');
  assert.equal(safety.DAYTRADE_WORKER_ALLOW_MUTATION, 'false');
  assert.equal(safety.TELEGRAM_ENABLED, '0');
});

test('26. live modules import no Telegram / Supabase / DB-mutation / trading code', () => {
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'intraday-shadow-scoring-live.js'), 'utf8');
  const toolSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'intraday-shadow-scoring-live.js'), 'utf8');
  for (const src of [libSrc, toolSrc]) {
    assert.ok(!/require\(['"].*telegram/i.test(src), 'must not import telegram code');
    assert.ok(!/@supabase\/supabase-js/.test(src), 'must not import supabase client');
    assert.ok(!/\.insert\(|\.upsert\(|\.update\(/.test(src), 'must not perform DB mutations');
    assert.ok(!/sendTelegram\(|notifyTelegram\(/.test(src), 'must not send telegram');
  }
});

// ===================================================================
// Safe output paths (never overwrite source)
// ===================================================================

test('27. output-root inside or equal to input-root is refused', async () => {
  const nested = await live.runLiveShadowSnapshot({
    inputRoot: FIXTURES, outputRoot: path.join(FIXTURES, 'nested'),
    date: DATE, scheduledTime: '10:15', env: Object.assign({}, SAFE_ENV), skipLock: true
  });
  assert.equal(nested.status, 'unsafe_output_path');
  const equal = await live.runLiveShadowSnapshot({
    inputRoot: FIXTURES, outputRoot: FIXTURES,
    date: DATE, scheduledTime: '10:15', env: Object.assign({}, SAFE_ENV), skipLock: true
  });
  assert.equal(equal.status, 'unsafe_output_path');
});

// ===================================================================
// API count invariant
// ===================================================================

test('28. API endpoint count remains exactly 12', async () => {
  const entries = await fsp.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});

// ===================================================================
// CLI
// ===================================================================

test('29. CLI parses the documented VPS invocation', () => {
  const args = cli.parseArgs([
    'node', 'tool',
    '--input-root', '/home/ubuntu/auto-cuan/data/intraday-samples',
    '--output-root', '/home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live',
    '--date', '2026-07-21',
    '--time', '10:15'
  ]);
  assert.equal(args.inputRoot, '/home/ubuntu/auto-cuan/data/intraday-samples');
  assert.equal(args.outputRoot, '/home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live');
  assert.equal(args.date, '2026-07-21');
  assert.equal(args.time, '10:15');
});

// ===================================================================
// Historical evaluator preserved (unchanged behaviour still available)
// ===================================================================

test('30. historical evaluator module is still present and independent', () => {
  assert.equal(typeof shadow.runShadowScoring, 'function');
  assert.equal(typeof shadow.evaluateDate, 'function');
  // The live module reuses the historical scoring primitives.
  assert.equal(typeof shadow.scoreSnapshot, 'function');
  assert.equal(shadow.TOP_N, 5);
});
