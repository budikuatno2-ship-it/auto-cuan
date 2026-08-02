'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const collector = require('../lib/daytrade-outcome-collector');
const { createLocalEvaluationLogger } = require('../lib/screener-evaluation-logger');

function initial(ticker = 'TEST', overrides = {}) {
  return {
    schema_version: 1,
    strategy: 'DAY_TRADE',
    run_id: 'run-1',
    run_mode: 'MORNING_SCOUT',
    batch_index: 0,
    scheduled_slot: 'OPENING',
    scheduler_source: 'manual_market_day_sample',
    code_sha: 'a'.repeat(40),
    config_hash: 'b'.repeat(64),
    ticker,
    candidate_revision: 1,
    observed_at: '2026-08-03T03:00:00.000Z',
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
    publication: { published: false, rank: null },
    ...overrides
  };
}

function policy() {
  return {
    schema_version: 2,
    policy_version: 'synthetic-v2',
    entry_reference: { version: 'entry-rule-v1', field: 'ENTRY_LOW', provenance: 'caller supplied initial range rule' },
    tick: {
      version: 'tiered-v1',
      tiers: [{ min_inclusive: 0, max_exclusive: 100, size: 1 }, { min_inclusive: 100, max_exclusive: null, size: 2 }],
      provenance: 'caller supplied synthetic tier table'
    },
    execution: { quantity: 10, price_unit: 100, currency: 'IDR' },
    costs: [
      { component: 'FEE', version: 'fee-v1', unit: 'RETURN_FRACTION', side: 'BUY', basis: 'ENTRY_NOTIONAL', value: 0.001, provenance: 'caller supplied buy fee' },
      { component: 'TAX', version: 'tax-v1', unit: 'RETURN_FRACTION', side: 'SELL', basis: 'EXIT_NOTIONAL', value: 0.002, provenance: 'caller supplied sell tax' },
      { component: 'SPREAD', version: 'spread-v1', unit: 'CURRENCY', side: 'BUY', basis: 'ENTRY_NOTIONAL', value: 1000, provenance: 'caller supplied fixed entry spread' },
      { component: 'SLIPPAGE', version: 'slippage-v1', unit: 'CURRENCY', side: 'SELL', basis: 'EXIT_NOTIONAL', value: 500, provenance: 'caller supplied fixed exit slippage' }
    ]
  };
}

function makeRoot(records = [initial()]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-collector-'));
  const logger = createLocalEvaluationLogger({
    root,
    env: { EVALUATION_LOGGING_ENABLED: 'true' },
    runId: 'run-1',
    marketDate: '2026-08-03',
    diskAudit: { writes_should_stop: false }
  });
  records.forEach(record => logger.append(record));
  logger.finalize();
  return root;
}

function makePolicyFile(value = policy()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-policy-'));
  const file = path.join(directory, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
  return file;
}

function options(root, policyFile, tickers = ['TEST']) {
  return {
    execute: true,
    marketDayConfirmed: true,
    continuousSegmentConfirmed: true,
    evaluationRoot: root,
    marketDate: '2026-08-03',
    scheduledSlot: 'OPENING',
    tickers,
    horizonEnd: '2026-08-03T04:00:00.000Z',
    intervalMs: 900000,
    policyFile
  };
}

const times = ['03:00', '03:15', '03:30', '03:45', '04:00'];
function bar(ticker, index, low = 103, high = 104, close = 103, extra = {}) {
  return {
    ticker,
    start_at: `2026-08-03T${times[index]}:00.000Z`,
    end_at: `2026-08-03T${times[index + 1]}:00.000Z`,
    open: close,
    high,
    low,
    close,
    provenance: 'synthetic direct provider bar',
    source_as_of: '2026-08-03T04:30:00.000Z',
    ...extra
  };
}
function complete(ticker = 'TEST') { return [bar(ticker, 0), bar(ticker, 1), bar(ticker, 2), bar(ticker, 3)]; }

function deps(fetchBars) {
  return {
    verifyCleanCheckout() {},
    fetchBars,
    now: '2026-08-03T05:00:00.000Z',
    afterFetchNow: () => '2026-08-03T05:00:00.000Z',
    completedAt: '2026-08-03T05:00:01.000Z',
    resolveCodeSha: () => 'c'.repeat(40)
  };
}

function fileSnapshot(root) {
  return fs.readdirSync(root, { recursive: true }).map(String).sort();
}

function initialEvidenceDigest(root) {
  const hash = crypto.createHash('sha256');
  for (const top of ['raw', 'manifests']) {
    const base = path.join(root, top);
    for (const relative of fs.readdirSync(base, { recursive: true }).map(String).sort()) {
      const file = path.join(base, relative);
      if (fs.statSync(file).isFile()) { hash.update(top + '/' + relative + '\0'); hash.update(fs.readFileSync(file)); }
    }
  }
  return hash.digest('hex');
}

test('CLI parser requires repeated ticker and explicit acknowledgements', () => {
  const parsed = collector.parseArgs(['node', 'tool', '--execute', '--market-day-confirmed', '--continuous-segment-confirmed', '--evaluation-root', '/tmp/eval', '--market-date', '2026-08-03', '--scheduled-slot', 'OPENING', '--ticker', 'bbca', '--ticker', 'bbri.jk', '--horizon-end', '2026-08-03T04:00:00.000Z', '--interval-ms', '900000', '--policy-file', '/tmp/policy.json']);
  assert.deepEqual(parsed.tickers, ['bbca', 'bbri.jk']);
  const root = makeRoot(); const file = makePolicyFile();
  for (const field of ['execute', 'marketDayConfirmed', 'continuousSegmentConfirmed']) {
    const value = options(root, file); value[field] = false;
    assert.throws(() => collector.validateOptions(value));
  }
});

test('validation enforces external roots, policy files, dates, intervals, and unique 1-5 tickers', () => {
  const root = makeRoot(); const file = makePolicyFile();
  assert.equal(collector.validateOptions(options(root, file)).tickers[0], 'TEST');
  assert.throws(() => collector.validateOptions(options(root, file, ['TEST', 'test'])));
  assert.throws(() => collector.validateOptions(options(root, file, ['A', 'B', 'C', 'D', 'E', 'F'])));
  assert.throws(() => collector.validateOptions({ ...options(root, file), intervalMs: 12345 }));
  assert.throws(() => collector.validateOptions({ ...options(root, file), horizonEnd: '2026-08-04T04:00:00.000Z' }));
  assert.throws(() => collector.validateOptions({ ...options(root, file), policyFile: path.join(__dirname, 'inside.json') }));
});

test('policy file has no hardcoded fallback and is exact-contract validated', () => {
  const file = makePolicyFile();
  assert.equal(collector.readPolicyFile(file).policy_version, 'synthetic-v2');
  const bad = makePolicyFile({ ...policy(), unexpected: true });
  assert.throws(() => collector.readPolicyFile(bad), /POLICY_FILE_INVALID/);
});

test('initial evidence selection is exact and rejects missing or mixed identities', () => {
  const root = makeRoot([initial('AAA'), initial('BBB')]);
  const selected = collector.loadInitialRecords(root, '2026-08-03', 'OPENING', ['BBB', 'AAA']);
  assert.deepEqual(selected.map(record => record.ticker), ['BBB', 'AAA']);
  assert.throws(() => collector.loadInitialRecords(root, '2026-08-03', 'OPENING', ['CCC']), /INITIAL_EVIDENCE_MISSING/);
  const mixed = makeRoot([initial('AAA'), initial('BBB', { config_hash: 'd'.repeat(64) })]);
  assert.throws(() => collector.loadInitialRecords(mixed, '2026-08-03', 'OPENING', ['AAA', 'BBB']), /INITIAL_EVIDENCE_MIXED_IDENTITY/);
});

test('provider boundary rejects out-of-range, overlap, mixed ticker, and future source-as-of', () => {
  const request = { ticker: 'TEST', startAt: '2026-08-03T03:00:00.000Z', endAt: '2026-08-03T04:00:00.000Z' };
  assert.throws(() => collector.validateProviderBars([{ ...bar('TEST', 0), start_at: '2026-08-03T02:45:00.000Z' }], request, '2026-08-03T05:00:00.000Z'));
  assert.throws(() => collector.validateProviderBars([bar('TEST', 0), { ...bar('TEST', 1), start_at: '2026-08-03T03:10:00.000Z' }], request, '2026-08-03T05:00:00.000Z'));
  assert.throws(() => collector.validateProviderBars([bar('OTHER', 0)], request, '2026-08-03T05:00:00.000Z'));
  assert.throws(() => collector.validateProviderBars([{ ...bar('TEST', 0), source_as_of: '2026-08-03T06:00:00.000Z' }], request, '2026-08-03T05:00:00.000Z'));
});

test('collector passes complete TP, SL, expirations and ambiguity states through B0.4', async () => {
  const scenarios = [
    ['TP1_FIRST', rows => { rows[0] = bar('TEST', 0, 101, 103, 102); rows[2] = bar('TEST', 2, 101, 107, 106); }],
    ['SL_FIRST', rows => { rows[0] = bar('TEST', 0, 101, 103, 102); rows[2] = bar('TEST', 2, 97, 103, 98); }],
    ['EXPIRED', rows => { rows[0] = bar('TEST', 0, 101, 103, 102); }],
    ['EXPIRED', () => {}],
    ['UNRESOLVED', rows => { rows[0] = bar('TEST', 0, 101, 107, 102); }],
    ['SL_FIRST', rows => { rows[0] = bar('TEST', 0, 101, 103, 102); rows[2] = bar('TEST', 2, 97, 107, 102); }]
  ];
  for (const [expected, mutate] of scenarios) {
    const root = makeRoot(); const file = makePolicyFile(); const rows = complete(); mutate(rows);
    const summary = await collector.runCollector(options(root, file), deps(async () => rows));
    assert.equal(summary.results[0].outcome, expected);
    assert.equal(summary.finalized_count, 1);
  }
});

test('zero, sparse, truncated, gapped, and interval-mismatched bars remain unresolved without manufactured bars', async () => {
  const cases = [[], [bar('TEST', 0)], [bar('TEST', 0), bar('TEST', 2), bar('TEST', 3)], [bar('TEST', 0), bar('TEST', 1), bar('TEST', 2)], [{ ...bar('TEST', 0), end_at: '2026-08-03T03:10:00.000Z' }, { ...bar('TEST', 1), start_at: '2026-08-03T03:10:00.000Z' }]];
  for (const rows of cases) {
    const root = makeRoot(); const file = makePolicyFile();
    const summary = await collector.runCollector(options(root, file), deps(async () => rows));
    assert.equal(summary.results[0].outcome, 'UNRESOLVED');
    assert.equal(summary.unresolved_count, 1);
  }
});

test('whole batch is prepared before writes and one bad ticker produces zero outcomes', async () => {
  const root = makeRoot([initial('AAA'), initial('BBB')]); const file = makePolicyFile();
  const before = fileSnapshot(root);
  await assert.rejects(() => collector.runCollector(options(root, file, ['AAA', 'BBB']), deps(async request => request.ticker === 'AAA' ? complete('AAA') : [{ ...bar('BBB', 0), ticker: 'WRONG' }])), /PROVIDER_MIXED_TICKER/);
  assert.deepEqual(fileSnapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, 'outcomes')), false);
});

test('same evaluation semantics reject a materially different second result before provider or filesystem changes', async () => {
  const root = makeRoot(); const file = makePolicyFile();
  const first = complete(); first[0] = bar('TEST', 0, 101, 103, 102); first[2] = bar('TEST', 2, 101, 107, 106);
  await collector.runCollector(options(root, file), deps(async () => first));
  const before = fileSnapshot(root); let providerCalls = 0;
  const second = complete(); second[0] = bar('TEST', 0, 101, 103, 102); second[2] = bar('TEST', 2, 97, 103, 98);
  await assert.rejects(() => collector.runCollector(options(root, file), deps(async () => { providerCalls++; return second; })), /DUPLICATE_FINALIZATION/);
  assert.equal(providerCalls, 0);
  assert.deepEqual(fileSnapshot(root), before);
});

test('successful collection preserves every initial raw and manifest byte', async () => {
  const root = makeRoot(); const file = makePolicyFile(); const before = initialEvidenceDigest(root);
  await collector.runCollector(options(root, file), deps(async () => complete()));
  assert.equal(initialEvidenceDigest(root), before);
});

test('dirty checkout and unsafe evidence stop before provider access or writes', async () => {
  const root = makeRoot(); const file = makePolicyFile(); let calls = 0;
  const dirty = deps(async () => { calls++; return complete(); });
  dirty.verifyCleanCheckout = () => { throw new collector.CollectorError('TRACKED_CHECKOUT_DIRTY'); };
  await assert.rejects(() => collector.runCollector(options(root, file), dirty), /TRACKED_CHECKOUT_DIRTY/);
  assert.equal(calls, 0);

  const unsafeRoot = makeRoot(); fs.mkdirSync(path.join(unsafeRoot, 'outcome-quarantine')); fs.writeFileSync(path.join(unsafeRoot, 'outcome-quarantine', 'x'), 'x');
  const unsafe = deps(async () => { calls++; return complete(); });
  await assert.rejects(() => collector.runCollector(options(unsafeRoot, file), unsafe), /OUTCOME_PREFLIGHT_/);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(unsafeRoot, 'outcomes')), false);
});

test('partial finalization returns bounded ticker status without paths or raw evidence', async () => {
  const root = makeRoot([initial('AAA'), initial('BBB')]); const file = makePolicyFile(); let calls = 0;
  const dependency = deps(async request => complete(request.ticker));
  dependency.createOutcomeLogger = input => { calls++; if (calls === 2) throw new Error('stop'); return require('../lib/daytrade-outcome-logger').createOutcomeLogger(input); };
  await assert.rejects(async () => {
    try { await collector.runCollector(options(root, file, ['AAA', 'BBB']), dependency); }
    catch (error) {
      assert.equal(error.summary.finalized_count, 1);
      assert.deepEqual(error.summary.results.map(item => item.finalization_status), ['FINALIZED', 'NOT_FINALIZED']);
      assert.doesNotMatch(JSON.stringify(error.summary), /\/tmp\/|policy\.json|source_as_of|record_hash/);
      throw error;
    }
  }, /FINALIZATION_PARTIAL/);
});

test('machine output is bounded and modules have no production activation dependency', async () => {
  const root = makeRoot(); const file = makePolicyFile();
  const summary = await collector.runCollector(options(root, file), deps(async () => complete()));
  const text = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(text) < 4096);
  assert.doesNotMatch(text, /\/tmp\/|query2|policy\.json|record_hash|raw_provider/);
  for (const fileName of ['lib/daytrade-outcome-collector.js', 'tools/run-daytrade-outcome-collector.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', fileName), 'utf8');
    assert.doesNotMatch(source, /supabase|telegram|fast-watcher|top5|swing-screener|sector-hot|setInterval|cron|systemd/i);
  }
});
