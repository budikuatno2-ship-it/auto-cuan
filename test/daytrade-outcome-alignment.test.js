'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../lib/daytrade-outcome-collector-guard');
const aligned = require('../tools/run-daytrade-aligned-evaluation-canary');
const { createLocalEvaluationLogger } = require('../lib/screener-evaluation-logger');

function initial(observedAt = '2026-08-03T03:00:00.000Z') {
  return {
    schema_version: 1,
    strategy: 'DAY_TRADE',
    run_id: 'run-aligned',
    run_mode: 'MORNING_SCOUT',
    batch_index: 0,
    scheduled_slot: 'OPENING',
    scheduler_source: 'manual_market_day_sample',
    code_sha: 'a'.repeat(40),
    config_hash: 'b'.repeat(64),
    ticker: 'TEST',
    candidate_revision: 1,
    observed_at: observedAt,
    feature_as_of_ts: null,
    feature_as_of_provenance: 'unavailable',
    data_source: 'fixture',
    data_lag_ms: null,
    ohlcv_sofar: { open: 100, high: 101, low: 99, close: 100, volume: 1, provenance: 'fixture' },
    rvol_raw: 1,
    rvol_seasonal: null,
    rvol_seasonal_provenance: 'unavailable',
    score_components_raw: { momentum: 1 },
    score_components_provenance: 'fixture',
    score_raw: 88,
    score_display: 88,
    status: 'READY_BREAKOUT',
    passed: true,
    rejection_codes: [],
    gate_trace: { schema_version: 1, rule_set_version: 'test', gates: {} },
    levels: { raw: { entry_low: 101.1, entry_high: 103.1, stop_loss: 98.9, tp1: 105.1, tp2: 110 }, normalized: null, provenance: 'initial' },
    publication: { published: false, rank: null }
  };
}

function makeRoot(record) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-alignment-'));
  const logger = createLocalEvaluationLogger({
    root,
    env: { EVALUATION_LOGGING_ENABLED: 'true' },
    runId: record.run_id,
    marketDate: '2026-08-03',
    diskAudit: { writes_should_stop: false }
  });
  logger.append(record);
  logger.finalize();
  return root;
}

function makePolicyFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-alignment-policy-'));
  const file = path.join(directory, 'policy.json');
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 2,
    policy_version: 'synthetic-v2',
    entry_reference: { version: 'entry-v1', field: 'ENTRY_LOW', provenance: 'caller supplied rule' },
    tick: {
      version: 'tick-v1',
      tiers: [{ min_inclusive: 0, max_exclusive: 100, size: 1 }, { min_inclusive: 100, max_exclusive: null, size: 2 }],
      provenance: 'caller supplied tiers'
    },
    execution: { quantity: 10, price_unit: 100, currency: 'IDR' },
    costs: [
      { component: 'FEE', version: 'fee-v1', unit: 'RETURN_FRACTION', side: 'BUY', basis: 'ENTRY_NOTIONAL', value: 0.001, provenance: 'caller supplied fee' },
      { component: 'TAX', version: 'tax-v1', unit: 'RETURN_FRACTION', side: 'SELL', basis: 'EXIT_NOTIONAL', value: 0.002, provenance: 'caller supplied tax' }
    ]
  }) + '\n', { mode: 0o600 });
  return file;
}

function options(root, policyFile, horizonEnd = '2026-08-03T04:00:00.000Z') {
  return {
    execute: true,
    marketDayConfirmed: true,
    continuousSegmentConfirmed: true,
    evaluationRoot: root,
    marketDate: '2026-08-03',
    scheduledSlot: 'OPENING',
    tickers: ['TEST'],
    horizonEnd,
    intervalMs: 900000,
    policyFile
  };
}

const times = ['03:00', '03:15', '03:30', '03:45', '04:00'];
function bars() {
  return [0, 1, 2, 3].map(index => ({
    ticker: 'TEST',
    start_at: `2026-08-03T${times[index]}:00.000Z`,
    end_at: `2026-08-03T${times[index + 1]}:00.000Z`,
    open: 103,
    high: 104,
    low: 103,
    close: 103,
    provenance: 'synthetic exact interval bar',
    source_as_of: '2026-08-03T05:00:00.000Z'
  }));
}

function dependencies(fetchBars) {
  return {
    verifyCleanCheckout() {},
    fetchBars,
    now: '2026-08-03T05:00:00.000Z',
    afterFetchNow: () => '2026-08-03T05:00:00.000Z',
    completedAt: '2026-08-03T05:00:01.000Z',
    resolveCodeSha: () => 'c'.repeat(40)
  };
}

test('guard rejects an unaligned initial timestamp before provider access or outcome creation', async () => {
  const root = makeRoot(initial('2026-08-03T03:00:30.000Z'));
  const policyFile = makePolicyFile();
  let providerCalls = 0;
  await assert.rejects(
    guard.runCollector(options(root, policyFile), dependencies(async () => { providerCalls++; return []; })),
    /INITIAL_OBSERVED_AT_NOT_INTERVAL_ALIGNED/
  );
  assert.equal(providerCalls, 0);
  assert.equal(fs.existsSync(path.join(root, 'outcomes')), false);
});

test('guard rejects an unaligned horizon before provider access', async () => {
  const root = makeRoot(initial());
  const policyFile = makePolicyFile();
  let providerCalls = 0;
  await assert.rejects(
    guard.runCollector(options(root, policyFile, '2026-08-03T04:00:30.000Z'), dependencies(async () => { providerCalls++; return []; })),
    /HORIZON_NOT_INTERVAL_ALIGNED/
  );
  assert.equal(providerCalls, 0);
});

test('guard permits an exact aligned window and preserves B0.4 unresolved/finalization semantics', async () => {
  const root = makeRoot(initial());
  const policyFile = makePolicyFile();
  const summary = await guard.runCollector(options(root, policyFile), dependencies(async () => bars()));
  assert.equal(summary.finalized_count, 1);
  assert.equal(summary.results[0].outcome, 'EXPIRED');
});

test('aligned wrapper parses and removes only its activation argument', () => {
  const parsed = aligned.parseAlignedArgs([
    'node', 'tool', '--execute', '--activation-interval-ms', '60000',
    '--market-day-confirmed', '--sample-slot', 'OPENING', '--evaluation-root', '/tmp/eval',
    '--tickers', 'BBCA:UTAMA'
  ]);
  assert.equal(parsed.activationIntervalMs, 60000);
  assert.equal(parsed.forwardedArgv.includes('--activation-interval-ms'), false);
  assert.equal(parsed.forwardedArgv.includes('--sample-slot'), true);
});

test('aligned activation waits for the next strict boundary and returns that exact timestamp', () => {
  const values = [Date.parse('2026-08-03T03:00:05.000Z'), Date.parse('2026-08-03T03:01:00.000Z')];
  let slept = null;
  const activation = aligned.createAlignedActivation({
    intervalMs: 60000,
    now: () => values.shift(),
    sleep: ms => { slept = ms; },
    getRunMode: () => 'MORNING_SCOUT'
  });
  assert.equal(activation.afterCalculationNow(), '2026-08-03T03:01:00.000Z');
  assert.equal(slept, 55000);
  assert.equal(activation.getActivationAt(), '2026-08-03T03:01:00.000Z');
});

test('aligned activation refuses a boundary that changes run mode', () => {
  const activation = aligned.createAlignedActivation({
    intervalMs: 60000,
    now: () => Date.parse('2026-08-03T03:00:59.000Z'),
    sleep: () => { throw new Error('sleep must not run'); },
    getRunMode: date => date.getUTCMinutes() === 0 ? 'MORNING_SCOUT' : 'MID_SESSION'
  });
  assert.throws(() => activation.afterCalculationNow(), /ACTIVATION_RUN_MODE_CHANGED/);
});
