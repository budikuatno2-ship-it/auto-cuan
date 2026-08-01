'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const canary = require('../tools/run-daytrade-evaluation-canary');
const engine = require('../lib/daytrade-screener-engine');
const { auditRetention } = require('../lib/screener-evaluation-retention');

function candidate(ticker = 'TEST') {
  return {
    ticker, open_price: 100, high_price: 110, low_price: 99,
    last_price: 108, volume_today: 1234, volume_ratio_20d: 1.4,
    daytrade_evaluation_initial: {
      score_raw: 88, score_display: 88, status: 'READY_BREAKOUT',
      score_components_raw: { momentum: 10 },
      gate_inputs: { liquidity_pass: true, risk_reward: 1.8, risk_distance_pct: 4, change_pct: 3, volume_ratio_20d: 1.4, price_above_open: true, distribution: false, overextended_ma20: false, rsi14: 60, candle_downgrade: false, afternoon_mode: false },
      levels: { entry_low: 103, entry_high: 105, stop_loss: 98, tp1: 112, tp2: 118 }
    }
  };
}

function fakeEngine(rows = [candidate()]) {
  return {
    getRunMode: engine.getRunMode,
    getDayTradeEvaluationConfiguration: engine.getDayTradeEvaluationConfiguration,
    async runDayTradeBatch(tickers, mode, options) {
      assert.equal(options.captureEvaluationInitial, true);
      assert.equal(options.noDelay, true);
      await options.fetchCandles(tickers[0].ticker);
      return { results: rows, failed: [] };
    }
  };
}

function item(ticker, board = 'UTAMA') { return { ticker, board }; }
function options(root, tickers = [item('TEST')], sampleSlot = 'OPENING') { return { execute: true, marketDayConfirmed: true, sampleSlot, evaluationRoot: root, tickers }; }
function dependencies(overrides = {}) {
  return { engine: fakeEngine(), fetchCandles: async () => [], verifyCleanCheckout: () => {}, resolveCodeSha: () => 'a'.repeat(40), now: '2026-08-03T03:00:00.000Z', afterCalculationNow: () => '2026-08-03T03:01:00.000Z', diskAudit: { writes_should_stop: false }, ...overrides };
}

test('requires acknowledgement, caller root, and at most five validated tickers', () => {
  assert.throws(() => canary.validateOptions({ ...options('/tmp/x'), execute: false }), /--execute/);
  assert.throws(() => canary.validateOptions({ ...options('/tmp/x'), marketDayConfirmed: false }), /--market-day-confirmed/);
  assert.throws(() => canary.validateOptions({ ...options('/tmp/x'), sampleSlot: 'LUNCH' }), /--sample-slot/);
  assert.throws(() => canary.validateOptions(options('relative')), /absolute/);
  assert.throws(() => canary.validateOptions(options('/tmp/x', ['A','B','C','D','E','F'].map(value => item(value)))), /maximum 5/);
  assert.throws(() => canary.validateOptions(options('/tmp/x', [item('A', null)])), /allowed board/);
  assert.throws(() => canary.validateOptions(options('/tmp/x', [item('BBCA'), item('BBCA', 'PENGEMBANGAN')])), /tickers must be unique/);
  assert.throws(() => canary.parseArgs(['node','tool','--code-sha','secret']), /unknown option/);
  const parsed = canary.parseArgs(['node','tool','--execute','--market-day-confirmed','--sample-slot','CLOSING','--evaluation-root','/tmp/x','--tickers','BBCA:UTAMA,ACES:PENGEMBANGAN']);
  assert.equal(parsed.sampleSlot, 'CLOSING'); assert.equal(parsed.marketDayConfirmed, true);
  assert.deepEqual(parsed.tickers, [item('BBCA'), item('ACES','PENGEMBANGAN')]);
});

test('injected provider path cannot call Vercel/production API and writes only below caller root', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-canary-parent-'));
  const root = path.join(parent, 'evaluation-only');
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network path reached'); };
  let summary;
  try { summary = await canary.runCanary(options(root), dependencies()); }
  finally { global.fetch = originalFetch; }
  assert.equal(summary.record_count, 1);
  assert.match(summary.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readdirSync(parent), ['evaluation-only']);
  const files = fs.readdirSync(root, { recursive: true }).filter(name => !fs.statSync(path.join(root, name)).isDirectory());
  assert.equal(files.length, 2);
  assert.ok(files.some(name => name.endsWith('.jsonl.gz')));
  assert.ok(files.some(name => name.endsWith('.manifest.json')));
  const manifestName = files.find(name => name.endsWith('.manifest.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestName), 'utf8'));
  const gzip = fs.readFileSync(path.join(root, manifest.relative_path));
  assert.equal(manifest.byte_size, gzip.length);
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(gzip).digest('hex'));
  assert.equal(JSON.parse(zlib.gunzipSync(gzip).toString()).publication.published, false);
  assert.equal(JSON.parse(zlib.gunzipSync(gzip).toString()).observed_at, '2026-08-03T03:01:00.000Z');
  assert.equal(JSON.parse(zlib.gunzipSync(gzip).toString()).scheduled_slot, 'OPENING');
  const retention = auditRetention({ root, now: '2026-08-03T03:00:00.000Z', freeBytes: 100 * 1024 ** 3 });
  assert.equal(retention.dry_run, true);
  assert.equal(retention.writes_should_stop, false);
});

test('dirty tracked checkout stops before provider and logger', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-canary-dirty-')), 'output');
  let providerCalls = 0; let loggerCalls = 0;
  await assert.rejects(canary.runCanary(options(root), dependencies({
    verifyCleanCheckout: () => { throw new canary.CanaryError('TRACKED_CHECKOUT_DIRTY'); },
    fetchCandles: async () => { providerCalls++; }, createLogger: () => { loggerCalls++; }
  })), /TRACKED_CHECKOUT_DIRTY/);
  assert.equal(providerCalls, 0); assert.equal(loggerCalls, 0); assert.equal(fs.existsSync(root), false);
});

test('market acknowledgement and Jakarta weekend stop before provider and logger', async () => {
  for (const [runOptions, now, pattern] of [
    [{ ...options('/tmp/not-created'), marketDayConfirmed: false }, '2026-08-03T03:00:00Z', /market-day-confirmed/],
    [options('/tmp/not-created'), '2026-08-01T03:00:00Z', /JAKARTA_WEEKEND/]
  ]) {
    let providerCalls = 0; let loggerCalls = 0;
    await assert.rejects(canary.runCanary(runOptions, dependencies({ now, fetchCandles: async () => { providerCalls++; }, createLogger: () => { loggerCalls++; } })), pattern);
    assert.equal(providerCalls, 0); assert.equal(loggerCalls, 0);
  }
});

test('finalized evidence prevents a duplicate date/slot without mutable state and permits another slot', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-samples-')), 'evidence');
  await canary.runCanary(options(root), dependencies());
  let providerCalls = 0; let loggerCalls = 0;
  await assert.rejects(canary.runCanary(options(root), dependencies({ fetchCandles: async () => { providerCalls++; }, createLogger: () => { loggerCalls++; } })), /DUPLICATE_MARKET_DATE_SLOT/);
  assert.equal(providerCalls, 0); assert.equal(loggerCalls, 0);
  const closing = await canary.runCanary(options(root, [item('TEST')], 'CLOSING'), dependencies());
  assert.equal(closing.sample_slot, 'CLOSING');
  const files = fs.readdirSync(root, { recursive: true }).filter(name => !fs.statSync(path.join(root, name)).isDirectory());
  assert.equal(files.length, 4);
  assert.ok(files.every(name => name.endsWith('.jsonl.gz') || name.endsWith('.manifest.json')));
});

test('malformed, escaping, and symlinked finalized evidence fails closed before provider and logger', async () => {
  for (const kind of ['malformed', 'escaping', 'symlink']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-bad-evidence-'));
    const directory = path.join(root, 'manifests', '2026-08-03'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'bad.manifest.json');
    if (kind === 'malformed') fs.writeFileSync(file, '{');
    if (kind === 'escaping') fs.writeFileSync(file, JSON.stringify({ schema_version: 1, strategy: 'DAY_TRADE', relative_path: '../escape.jsonl.gz', record_count: 1, byte_size: 1, sha256: 'a'.repeat(64) }));
    if (kind === 'symlink') { fs.rmSync(directory, { recursive: true, force: true }); fs.symlinkSync(os.tmpdir(), directory, 'dir'); }
    let providerCalls = 0; let loggerCalls = 0;
    await assert.rejects(canary.runCanary(options(root), dependencies({ fetchCandles: async () => { providerCalls++; }, createLogger: () => { loggerCalls++; } })), /EXISTING_EVIDENCE_UNVERIFIABLE/);
    assert.equal(providerCalls, 0); assert.equal(loggerCalls, 0);
  }
});

test('whole protocol tree rejects unsafe or unresolved evidence before provider and logger', async () => {
  for (const kind of ['raw-root-symlink', 'orphan-finalized', 'open', 'quarantine', 'intermediate-symlink']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-protocol-tree-'));
    if (kind === 'raw-root-symlink') fs.symlinkSync(os.tmpdir(), path.join(root, 'raw'), 'dir');
    if (kind === 'orphan-finalized' || kind === 'open') {
      const raw = path.join(root, 'raw', '2026-08-03', 'day-trade'); fs.mkdirSync(raw, { recursive: true });
      fs.writeFileSync(path.join(raw, kind === 'open' ? 'run.open.jsonl.gz' : 'run.jsonl.gz'), zlib.gzipSync('{}\n'));
    }
    if (kind === 'quarantine') {
      const quarantine = path.join(root, 'quarantine', '2026-08-03'); fs.mkdirSync(quarantine, { recursive: true });
      fs.writeFileSync(path.join(quarantine, 'run.invalid.jsonl.gz'), zlib.gzipSync('{}\n'));
    }
    if (kind === 'intermediate-symlink') {
      fs.mkdirSync(path.join(root, 'raw')); fs.symlinkSync(os.tmpdir(), path.join(root, 'raw', '2026-08-03'), 'dir');
    }
    let providerCalls = 0; let loggerCalls = 0;
    await assert.rejects(canary.runCanary(options(root), dependencies({ fetchCandles: async () => { providerCalls++; }, createLogger: () => { loggerCalls++; } })), /EXISTING_EVIDENCE_UNVERIFIABLE/);
    assert.equal(providerCalls, 0, kind); assert.equal(loggerCalls, 0, kind);
  }
});

test('checksummed evidence with tampered finalized-run identity fails before provider and logger', async () => {
  for (const kind of ['record-run-id', 'mixed-code-sha', 'manifest-timestamp']) {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-identity-')), 'evidence');
    await canary.runCanary(options(root, [item('TEST'), item('SECOND')]), dependencies({ engine: fakeEngine([candidate('TEST'), candidate('SECOND')]) }));
    const manifestFile = fs.readdirSync(path.join(root, 'manifests', '2026-08-03')).map(name => path.join(root, 'manifests', '2026-08-03', name))[0];
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const rawFile = path.join(root, manifest.relative_path);
    const records = zlib.gunzipSync(fs.readFileSync(rawFile)).toString('utf8').trim().split('\n').map(JSON.parse);
    if (kind === 'record-run-id') records[0].run_id = 'different-run';
    if (kind === 'mixed-code-sha') records[1].code_sha = 'b'.repeat(40);
    if (kind === 'manifest-timestamp') manifest.first_timestamp = '2026-08-03T03:02:00.000Z';
    const rebuilt = zlib.gzipSync(records.map(record => JSON.stringify(record)).join('\n') + '\n');
    fs.writeFileSync(rawFile, rebuilt); manifest.byte_size = rebuilt.length;
    manifest.sha256 = crypto.createHash('sha256').update(rebuilt).digest('hex');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest) + '\n');
    let providerCalls = 0; let loggerCalls = 0;
    await assert.rejects(canary.runCanary(options(root), dependencies({ fetchCandles: async () => { providerCalls++; }, createLogger: () => { loggerCalls++; } })), /EXISTING_EVIDENCE_UNVERIFIABLE/);
    assert.equal(providerCalls, 0, kind); assert.equal(loggerCalls, 0, kind);
  }
});

test('Jakarta market-date rollover after calculation creates no files', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-rollover-')), 'evidence');
  let loggerCalls = 0;
  await assert.rejects(canary.runCanary(options(root), dependencies({
    now: '2026-08-03T16:59:59.000Z', afterCalculationNow: () => '2026-08-03T17:00:01.000Z',
    createLogger: () => { loggerCalls++; }
  })), /MARKET_DATE_CHANGED_DURING_RUN/);
  assert.equal(loggerCalls, 0); assert.equal(fs.existsSync(root), false);
});

test('partial and total calculation failures create no files and disclose counts only', async () => {
  for (const calculation of [
    { results: [candidate()], failed: [{ ticker: 'HIDDEN', reason: 'provider URL hidden' }] },
    { results: [], failed: [{ ticker: 'HIDDEN1' }, { ticker: 'HIDDEN2' }] }
  ]) {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-canary-incomplete-')), 'output');
    let loggerCalls = 0;
    const incompleteEngine = fakeEngine(); incompleteEngine.runDayTradeBatch = async () => calculation;
    const requested = calculation.results.length ? [item('TEST'), item('TWO')] : [item('ONE'), item('TWO')];
    await assert.rejects(canary.runCanary(options(root, requested), dependencies({ engine: incompleteEngine, createLogger: () => { loggerCalls++; } })), error => {
      assert.match(error.message, /^CALCULATION_INCOMPLETE requested=2 results=\d failed=\d$/);
      assert.doesNotMatch(error.message, /HIDDEN|provider|URL/); return true;
    });
    assert.equal(loggerCalls, 0); assert.equal(fs.existsSync(root), false);
  }
});

test('evaluation root rejects filesystem/repository paths and symlinks but accepts external roots', () => {
  assert.throws(() => canary.assertSafeEvaluationRoot(path.parse(process.cwd()).root), /UNSAFE_EVALUATION_ROOT/);
  assert.throws(() => canary.assertSafeEvaluationRoot(canary.REPOSITORY_ROOT), /UNSAFE_EVALUATION_ROOT/);
  assert.throws(() => canary.assertSafeEvaluationRoot(path.join(canary.REPOSITORY_ROOT, 'logs', 'canary')), /UNSAFE_EVALUATION_ROOT/);
  assert.throws(() => canary.assertSafeEvaluationRoot(path.join(canary.REPOSITORY_ROOT, 'data', 'intraday-test')), /UNSAFE_EVALUATION_ROOT/);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-canary-root-'));
  const link = path.join(external, 'repo-link'); fs.symlinkSync(canary.REPOSITORY_ROOT, link, 'dir');
  assert.throws(() => canary.assertSafeEvaluationRoot(link), /UNSAFE_EVALUATION_ROOT/);
  assert.equal(canary.assertSafeEvaluationRoot(path.join(external, 'safe')), path.join(external, 'safe'));
  assert.equal(canary.assertSafeEvaluationRoot('/home/ubuntu/auto-cuan-evaluation'), '/home/ubuntu/auto-cuan-evaluation');
});

test('CLI failures use stable messages and never include raw paths', () => {
  const raw = new Error('EACCES: /private/caller/evaluation/path');
  assert.equal(canary.failureMessage(raw), 'CANARY_FAILED INTERNAL_ERROR');
  assert.equal(canary.failureMessage(new canary.CanaryError('UNSAFE_EVALUATION_ROOT')), 'CANARY_FAILED UNSAFE_EVALUATION_ROOT');
});

test('malformed mapping and invalid SHA fail before logger creation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-canary-invalid-'));
  let loggerCalls = 0;
  const createLogger = () => { loggerCalls++; throw new Error('logger must not be reached'); };
  await assert.rejects(canary.runCanary(options(root), dependencies({ engine: fakeEngine([{ ticker: 'BAD' }]), createLogger })), /snapshot is unavailable/);
  await assert.rejects(canary.runCanary(options(root), dependencies({ resolveCodeSha: () => 'invalid', createLogger })), /code SHA/);
  assert.equal(loggerCalls, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('canary module has no Supabase, Telegram, Vercel, publication, ranking, or runtime activation dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'run-daytrade-evaluation-canary.js'), 'utf8');
  assert.doesNotMatch(source, /require\([^)]*(supabase|telegram)/i);
  assert.doesNotMatch(source, /sector-hot|vercel\.app|CRON_SECRET|setInterval|setTimeout/);
  assert.doesNotMatch(source, /\.from\(|\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
});
