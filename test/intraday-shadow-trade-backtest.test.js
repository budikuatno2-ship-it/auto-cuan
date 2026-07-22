'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const bt = require('../lib/intraday-shadow-trade-backtest');
const cli = require('../tools/intraday-shadow-trade-backtest');

const FIXTURES = path.join(__dirname, 'fixtures', 'intraday-shadow-trade-backtest');
const SHADOW_ROOT = path.join(FIXTURES, 'shadow');
const SAMPLE_ROOT = path.join(FIXTURES, 'samples');
const DATES = ['2026-07-20', '2026-07-21', '2026-07-22'];

const SAFE_ENV = Object.freeze({
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
  TELEGRAM_ENABLED: '0'
});

async function tmpdir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix || 'shadow-trade-test-'));
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

async function run(overrides) {
  const outputRoot = overrides && overrides.outputRoot ? overrides.outputRoot : await tmpdir('shadow-trade-out-');
  const result = await bt.runBacktest(Object.assign({
    shadowRoot: SHADOW_ROOT,
    sampleRoot: SAMPLE_ROOT,
    outputRoot,
    dates: DATES.slice(),
    minScore: 16,
    env: Object.assign({}, SAFE_ENV)
  }, overrides || {}));
  return { result, outputRoot };
}

function tradesFor(result, ticker, scenario) {
  return result.trades.filter((t) => t.ticker === ticker && t.exit_scenario === scenario);
}

// ===================================================================
// Deduplication of repeated snapshot observations
// ===================================================================

test('1. repeated snapshot signals collapse into exactly one independent trade', async () => {
  const { result } = await run();
  // WINR is CONFIRMED rank 1 across 6 snapshots but must produce ONE trade
  // (one record per exit scenario => 2 rows, both sharing a single entry).
  const winr = result.trades.filter((t) => t.ticker === 'WINR');
  assert.equal(winr.length, 2);
  assert.equal(winr[0].signal_time, '09:30'); // earliest qualifying snapshot preserved
  assert.equal(winr[0].persistent_snapshot_count, 6); // it persisted 6 snapshots...
  assert.equal(new Set(winr.map((t) => t.entry_time)).size, 1); // ...but one entry
  assert.equal(result.summary.counts.unique_independent_trades, 5);
});

test('2. a ticker gets at most one entry per trading day', async () => {
  const { result } = await run();
  const perDateTicker = {};
  for (const t of result.trades) {
    if (!t.available || !t.entry_time) continue;
    const key = t.date + '|' + t.ticker;
    perDateTicker[key] = perDateTicker[key] || new Set();
    perDateTicker[key].add(t.entry_time);
  }
  for (const key of Object.keys(perDateTicker)) {
    assert.equal(perDateTicker[key].size, 1, key + ' must have a single entry');
  }
});

// ===================================================================
// Entry rules (no look-ahead, next snapshot only, never invented)
// ===================================================================

test('3. entry uses the NEXT valid snapshot price, never the signal snapshot price', async () => {
  const { result } = await run();
  const winr = tradesFor(result, 'WINR', 'EOD')[0];
  // Signal at 09:30 (price 101). Entry must be the NEXT snapshot 09:45 (price 102).
  assert.equal(winr.signal_time, '09:30');
  assert.equal(winr.entry_time, '09:45');
  assert.equal(winr.entry_price, 102);
  assert.notEqual(winr.entry_price, 101); // never the signal snapshot's own price
  assert.ok(bt.timeToMinutes(winr.entry_time) > bt.timeToMinutes(winr.signal_time));
});

test('4. a missing next price is never invented — the trade is marked unavailable', async () => {
  const { result } = await run();
  // NONX is CONFIRMED rank 1 at 10:45 with no later snapshot price at all.
  const nonx = tradesFor(result, 'NONX', 'PLUS_60M');
  assert.equal(nonx.length, 1);
  assert.equal(nonx[0].available, false);
  assert.equal(nonx[0].entry_time, null);
  assert.equal(nonx[0].entry_price, null);
  assert.equal(nonx[0].unavailable_reason, 'NO_NEXT_VALID_SNAPSHOT_PRICE');
  assert.equal(result.summary.counts.unavailable_entry_signals, 1);
});

test('5. no look-ahead: entry selection never uses a snapshot at or before the signal', async () => {
  const { result } = await run();
  for (const t of result.trades) {
    if (!t.available || !t.entry_time) continue;
    assert.ok(bt.timeToMinutes(t.entry_time) > bt.timeToMinutes(t.signal_time),
      t.ticker + ' entry (' + t.entry_time + ') must be strictly after signal (' + t.signal_time + ')');
  }
});

test('6. resolveEntry returns unavailable (never a price) when no later snapshot exists', () => {
  const priceMap = new Map([['ZZZ', new Map([['10:45', { price: 300, source: 'current_price' }]])]]);
  const res = bt.resolveEntry(priceMap, { ticker: 'ZZZ', signal_time: '10:45' });
  assert.equal(res.available, false);
  assert.equal(res.reason, 'NO_NEXT_VALID_SNAPSHOT_PRICE');
  assert.equal(res.entry_price, undefined);
});

// ===================================================================
// Candidate rule (score / rank exclusions)
// ===================================================================

test('7. shadow_score below the minimum is excluded', async () => {
  const { result } = await run();
  // LOWS is CONFIRMED rank 1 but score 12 (< 16) -> no trade.
  assert.ok(!result.trades.some((t) => t.ticker === 'LOWS'));
  assert.equal(result.summary.counts.rejected_rows_by_low_score, 2);
});

test('8. rank 2..5 are never evaluated as candidates', async () => {
  const { result } = await run();
  // SECND is CONFIRMED rank 2 with a very high score (96) but must be ignored.
  assert.ok(!result.trades.some((t) => t.ticker === 'SECND'));
  assert.equal(result.summary.counts.rejected_rows_by_rank_2_to_5, 2);
  assert.equal(result.summary.parameters.candidate_rule.confirmed_rank, 1);
  assert.equal(result.summary.parameters.candidate_rule.ranks_2_to_5_evaluated, false);
});

test('9. only CONFIRMED rows qualify (PROVISIONAL rows are rejected)', async () => {
  const { result } = await run();
  assert.equal(result.summary.counts.rejected_rows_by_state, 2);
  // The earliest WINR qualifying snapshot is the CONFIRMED 09:30, not the
  // PROVISIONAL 09:15.
  assert.equal(tradesFor(result, 'WINR', 'EOD')[0].signal_time, '09:30');
});

// ===================================================================
// Exit scenarios evaluated separately
// ===================================================================

test('10. +60-minute and EOD exits are evaluated separately with distinct prices', async () => {
  const { result } = await run();
  const p60 = tradesFor(result, 'WINR', 'PLUS_60M')[0];
  const eod = tradesFor(result, 'WINR', 'EOD')[0];
  assert.equal(p60.exit_target_time, '10:45');
  assert.equal(p60.exit_time, '10:45');
  assert.equal(p60.exit_price, 106);
  assert.equal(p60.gross_return_pct, 3.9216);
  assert.equal(eod.exit_target_time, '16:00');
  assert.equal(eod.exit_price, 110);
  assert.equal(eod.gross_return_pct, 7.8431);
  assert.notEqual(p60.exit_price, eod.exit_price);
});

test('11. an unavailable exact exit snapshot is not invented unless fallback policy is enabled', async () => {
  // Default: OVLB +60m target 11:00 does not exist -> unavailable (not invented).
  const { result } = await run();
  const p60 = tradesFor(result, 'OVLB', 'PLUS_60M')[0];
  assert.equal(p60.available, false);
  assert.equal(p60.exit_time, null);
  assert.equal(p60.exit_price, null);
  assert.equal(p60.unavailable_reason, 'EXACT_EXIT_SNAPSHOT_UNAVAILABLE');

  // With the fallback policy, the substitution is used AND recorded explicitly.
  const { result: withFallback } = await run({ allowNextValidFallback: true });
  const p60b = tradesFor(withFallback, 'OVLB', 'PLUS_60M')[0];
  assert.equal(p60b.available, true);
  assert.equal(p60b.exit_time, '16:00'); // next valid snapshot at/after 11:00
  assert.equal(p60b.exit_policy, 'next_valid_snapshot');
  assert.equal(withFallback.summary.parameters.exit_fallback_next_valid, true);
});

// ===================================================================
// Trading costs (0 / 30 / 50 bps) and gross vs net separation
// ===================================================================

test('12. round-trip costs of 0/30/50 bps are applied consistently to net return', async () => {
  const { result } = await run();
  const p60 = tradesFor(result, 'WINR', 'PLUS_60M')[0];
  const byBps = {};
  for (const c of p60.cost_scenarios) byBps[c.cost_bps] = c;
  assert.equal(byBps[0].trading_cost_pct, 0);
  assert.equal(byBps[0].net_return_pct, 3.9216);   // gross - 0.00
  assert.equal(byBps[30].trading_cost_pct, 0.3);
  assert.equal(byBps[30].net_return_pct, 3.6216);  // gross - 0.30
  assert.equal(byBps[50].trading_cost_pct, 0.5);
  assert.equal(byBps[50].net_return_pct, 3.4216);  // gross - 0.50
  // Gross is unchanged by cost.
  assert.equal(p60.gross_return_pct, 3.9216);
});

test('13. gross and net are kept separate — a gross win can be a net loss under cost', async () => {
  const { result } = await run();
  const eod = tradesFor(result, 'MRGN', 'EOD')[0];
  assert.equal(eod.gross_return_pct, 0.1); // gross positive
  const byBps = {};
  for (const c of eod.cost_scenarios) byBps[c.cost_bps] = c;
  assert.equal(byBps[0].net_return_pct, 0.1);   // net win at 0 bps
  assert.equal(byBps[30].net_return_pct, -0.2);  // net loss at 30 bps
  assert.equal(byBps[50].net_return_pct, -0.4);  // net loss at 50 bps
  // Summary separates gross vs net win rate.
  const m = result.summary.by_exit_scenario.EOD.by_cost_bps['30'];
  assert.ok('gross_win_rate_pct' in m && 'net_win_rate_pct' in m);
});

test('14. cost sensitivity and the cost-comparison output cover 0/30/50 bps', async () => {
  const { result } = await run();
  const sens = result.summary.cost_sensitivity_0_30_50_bps.EOD;
  assert.deepEqual(Object.keys(sens).sort(), ['0', '30', '50']);
  const comp = result.comparison.by_exit_scenario.EOD.by_cost_bps;
  assert.deepEqual(Object.keys(comp).sort(), ['0', '30', '50']);
  // Higher cost never increases net average return.
  assert.ok(comp['50'].avg_net_return_pct <= comp['0'].avg_net_return_pct);
  assert.equal(result.comparison.cost_scenarios_bps.join(','), '0,30,50');
});

// ===================================================================
// Metrics correctness (profit factor, drawdown)
// ===================================================================

test('15. profit factor and drawdown are computed correctly', () => {
  // Hand-built resolved entries: +10, -5, +4 (chronological by entry_time).
  const entries = [
    { date: 'd', ticker: 'A', entry_time: '09:15', gross_return_pct: 10, net_return_pct: 10 },
    { date: 'd', ticker: 'B', entry_time: '09:30', gross_return_pct: -5, net_return_pct: -5 },
    { date: 'd', ticker: 'C', entry_time: '09:45', gross_return_pct: 4, net_return_pct: 4 }
  ];
  const m = bt.computeMetrics(entries, 0);
  // Profit factor = (10 + 4) / 5 = 2.8
  assert.equal(m.profit_factor, 2.8);
  // Equity: 1 -> 1.1 -> 1.045 -> 1.0868; peak 1.1, trough 1.045 => DD 5%.
  assert.equal(m.max_drawdown_pct, 5);
  assert.equal(m.win_count, 2);
  assert.equal(m.loss_count, 1);
  assert.equal(m.neutral_count, 0);
});

test('16. profit factor is withheld (not fabricated) when there are no losing trades', () => {
  const entries = [
    { date: 'd', ticker: 'A', entry_time: '09:15', gross_return_pct: 3, net_return_pct: 3 },
    { date: 'd', ticker: 'B', entry_time: '09:30', gross_return_pct: 2, net_return_pct: 2 }
  ];
  const m = bt.computeMetrics(entries, 0);
  assert.equal(m.profit_factor, null);
  assert.equal(m.profit_factor_note, 'no_losing_trades_profit_factor_undefined');
  assert.equal(m.max_drawdown_pct, 0);
});

test('17. summary keeps cumulative (no compounding) and compounded returns separate', async () => {
  const { result } = await run();
  const m = result.summary.by_exit_scenario.EOD.by_cost_bps['0'];
  assert.ok('cumulative_net_return_pct_no_compounding' in m);
  assert.ok('compounded_net_return_pct' in m);
  assert.notEqual(m.cumulative_net_return_pct_no_compounding, m.compounded_net_return_pct);
  assert.ok(m.best_trade && m.worst_trade);
  assert.equal(m.best_trade.ticker, 'WINR');
  assert.equal(m.worst_trade.ticker, 'LOSR');
});

// ===================================================================
// One-position-at-a-time mode
// ===================================================================

test('18. one-position-at-a-time mode prevents overlapping open positions', async () => {
  const { result } = await run({ onePositionMode: true });
  const sp = result.summary.single_position_portfolio;
  assert.ok(sp && sp.enabled);
  // OVLA (entry 09:30, occupancy to 10:30) blocks OVLB (entry 10:00).
  assert.equal(sp.excluded_overlap_count, 1);
  assert.equal(sp.excluded_overlaps[0].ticker, 'OVLB');
  assert.equal(sp.excluded_overlaps[0].reason, 'ONE_POSITION_MODE_OVERLAP');
  // OVLB trade rows are flagged as NOT in the single-position portfolio.
  for (const r of result.trades.filter((t) => t.ticker === 'OVLB')) {
    assert.equal(r.in_single_position_portfolio, false);
  }
  // OVLA and MRGN are admitted.
  assert.ok(result.trades.some((t) => t.ticker === 'OVLA' && t.in_single_position_portfolio === true));
});

test('19. applyOnePositionMode admits a non-overlapping subset deterministically', () => {
  const entered = [
    { signal: { ticker: 'A' }, entry: { entry_time: '09:30' }, exitsByScenario: { PLUS_60M: { available: true, exit_time: '10:30' }, EOD: { available: true, exit_time: '16:00' } } },
    { signal: { ticker: 'B' }, entry: { entry_time: '10:00' }, exitsByScenario: { PLUS_60M: { available: false }, EOD: { available: true, exit_time: '16:00' } } },
    { signal: { ticker: 'C' }, entry: { entry_time: '10:45' }, exitsByScenario: { PLUS_60M: { available: false }, EOD: { available: true, exit_time: '16:00' } } }
  ];
  const res = bt.applyOnePositionMode(entered);
  assert.ok(res.admitted.has('A'));
  assert.ok(!res.admitted.has('B')); // 10:00 overlaps A's [09:30,10:30)
  assert.ok(res.admitted.has('C')); // 10:45 is clear
});

// ===================================================================
// Determinism / safe reruns / atomic writes
// ===================================================================

test('20. reruns are idempotent — byte-identical outputs', async () => {
  const outputRoot = await tmpdir('shadow-trade-idem-');
  await run({ outputRoot });
  const first = hashDir(outputRoot);
  await run({ outputRoot });
  const second = hashDir(outputRoot);
  assert.equal(second, first);
});

test('21. evaluation is deterministic (dry-run results are deep-equal)', async () => {
  const a = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: await tmpdir('d-'), dates: DATES.slice(), minScore: 16, env: Object.assign({}, SAFE_ENV), dryRun: true });
  const b = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: await tmpdir('d-'), dates: DATES.slice(), minScore: 16, env: Object.assign({}, SAFE_ENV), dryRun: true });
  assert.deepEqual(a.trades, b.trades);
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(a.comparison, b.comparison);
});

test('22. all three output files are written under the output root', async () => {
  const { result, outputRoot } = await run();
  for (const f of ['trades.jsonl', 'summary.json', 'comparison-cost-scenarios.json']) {
    assert.ok(fs.existsSync(path.join(outputRoot, f)), 'missing ' + f);
  }
  for (const p of Object.values(result.outputs)) {
    assert.ok(path.resolve(p).startsWith(path.resolve(outputRoot)));
  }
});

// ===================================================================
// Source files remain byte-identical
// ===================================================================

test('23. source fixtures remain byte-identical after runs', async () => {
  const before = hashDir(FIXTURES);
  await run();
  await run({ allowNextValidFallback: true, onePositionMode: true });
  const after = hashDir(FIXTURES);
  assert.equal(after, before, 'the backtest must never modify its source files');
});

// ===================================================================
// Output path safety
// ===================================================================

test('24. output-root inside/equal to either source root is refused', async () => {
  const insideShadow = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: path.join(SHADOW_ROOT, 'out'), dates: DATES.slice(), env: Object.assign({}, SAFE_ENV) });
  assert.equal(insideShadow.status, 'unsafe_output_path');
  const insideSample = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: SAMPLE_ROOT, dates: DATES.slice(), env: Object.assign({}, SAFE_ENV) });
  assert.equal(insideSample.status, 'unsafe_output_path');
});

// ===================================================================
// Explicit dates / invalid input handling (non-zero style statuses)
// ===================================================================

test('25. malformed / duplicate dates are rejected; missing args error', async () => {
  const bad = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: await tmpdir('x-'), dates: ['2026-13-40'], env: Object.assign({}, SAFE_ENV) });
  assert.equal(bad.status, 'rejected');
  const dup = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: await tmpdir('x-'), dates: ['2026-07-20', '2026-07-20'], env: Object.assign({}, SAFE_ENV) });
  assert.equal(dup.status, 'rejected');
  const noDates = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: await tmpdir('x-'), dates: [], env: Object.assign({}, SAFE_ENV) });
  assert.equal(noDates.status, 'error');
  const noRoots = await bt.runBacktest({ dates: DATES.slice(), env: Object.assign({}, SAFE_ENV) });
  assert.equal(noRoots.status, 'error');
});

// ===================================================================
// Small-sample warning + honesty
// ===================================================================

test('26. a small independent-trade sample raises a warning and never claims profitability', async () => {
  const { result } = await run({ dates: ['2026-07-20'] }); // only WINR -> 1 trade
  assert.equal(result.summary.counts.unique_independent_trades, 1);
  assert.ok(result.summary.warnings.some((w) => w.startsWith('SMALL_INDEPENDENT_TRADE_SAMPLE')));
  assert.ok(/does NOT claim profitability/i.test(result.summary.disclaimer));
});

test('27. summary reports trades-per-date/ticker, concentration, result-by-date and +60 vs EOD', async () => {
  const { result } = await run();
  const s = result.summary;
  assert.deepEqual(Object.keys(s.trades_per_date).sort(), DATES.slice());
  assert.equal(s.ticker_concentration.distinct_tickers, 5);
  assert.equal(s.ticker_concentration.max_ticker_share, 0.2);
  assert.ok(s.result_by_date['2026-07-20'].EOD);
  assert.ok(s.exit_scenario_comparison_plus60_vs_eod.PLUS_60M);
  assert.ok(s.exit_scenario_comparison_plus60_vs_eod.EOD);
});

// ===================================================================
// Safety: scoring / mutation / telegram disabled
// ===================================================================

test('28. enabling scoring / mutation / telegram fails the safety gate', async () => {
  const scoring = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: await tmpdir('s-'), dates: DATES.slice(), env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
  assert.equal(scoring.status, 'safety_violation');
  const mut = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: await tmpdir('s-'), dates: DATES.slice(), env: { DAYTRADE_WORKER_ALLOW_MUTATION: 'true' } });
  assert.equal(mut.status, 'safety_violation');
  const tg = await bt.runBacktest({ shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, outputRoot: await tmpdir('s-'), dates: DATES.slice(), env: { TELEGRAM_ENABLED: '1' } });
  assert.equal(tg.status, 'safety_violation');
});

test('29. summary asserts scoring / mutation / telegram / supabase / portfolio all disabled', async () => {
  const { result } = await run();
  const safety = result.summary.safety;
  assert.equal(safety.production_scoring_enabled, false);
  assert.equal(safety.mutations_performed, false);
  assert.equal(safety.telegram_sent, false);
  assert.equal(safety.supabase_writes, false);
  assert.equal(safety.portfolio_mutated, false);
  assert.equal(safety.recommendations_mutated, false);
  assert.equal(safety.source_files_rewritten, false);
  assert.equal(safety.DAYTRADE_INTRADAY_SCORE_ENABLED, 'false');
  assert.equal(safety.DAYTRADE_WORKER_ALLOW_MUTATION, 'false');
  assert.equal(safety.TELEGRAM_ENABLED, '0');
});

test('30. backtest modules import no Telegram / Supabase / DB-mutation / trading code', () => {
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'intraday-shadow-trade-backtest.js'), 'utf8');
  const toolSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'intraday-shadow-trade-backtest.js'), 'utf8');
  for (const src of [libSrc, toolSrc]) {
    assert.ok(!/require\(['"].*telegram/i.test(src), 'must not import telegram code');
    assert.ok(!/@supabase\/supabase-js/.test(src), 'must not import supabase client');
    assert.ok(!/\.insert\(|\.upsert\(|\.update\(/.test(src), 'must not perform DB mutations');
    assert.ok(!/sendTelegram\(|notifyTelegram\(/.test(src), 'must not send telegram');
  }
});

// ===================================================================
// API count invariant
// ===================================================================

test('31. API endpoint count remains exactly 12', async () => {
  const entries = await fsp.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});

// ===================================================================
// CLI
// ===================================================================

test('32. CLI parses the documented VPS invocation', () => {
  const args = cli.parseArgs([
    'node', 'tool',
    '--shadow-root', '/home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live',
    '--sample-root', '/home/ubuntu/auto-cuan/data/intraday-samples',
    '--output-root', '/home/ubuntu/auto-cuan/data/intraday-shadow-trades',
    '--dates', '2026-07-20,2026-07-21,2026-07-22',
    '--min-score', '16'
  ]);
  assert.equal(args.shadowRoot, '/home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live');
  assert.equal(args.sampleRoot, '/home/ubuntu/auto-cuan/data/intraday-samples');
  assert.equal(args.outputRoot, '/home/ubuntu/auto-cuan/data/intraday-shadow-trades');
  assert.deepEqual(args.dates, ['2026-07-20', '2026-07-21', '2026-07-22']);
  assert.equal(args.minScore, 16);
});

// ===================================================================
// trades.jsonl structure — every required per-trade field is present
// ===================================================================

test('33. every trade record carries the required fields', async () => {
  const { result } = await run();
  const required = ['date', 'ticker', 'signal_time', 'entry_time', 'entry_price', 'exit_time',
    'exit_price', 'signal_score', 'confirmation_reason', 'gross_return_pct', 'trading_cost_pct',
    'net_return_pct', 'exit_scenario', 'unavailable_reason', 'cost_scenarios'];
  assert.ok(result.trades.length > 0);
  for (const t of result.trades) {
    for (const f of required) assert.ok(f in t, 'trade missing field ' + f);
  }
  // Two records (one per exit scenario) per qualifying signal (6 signals => 12).
  assert.equal(result.trades.length, 12);
});
