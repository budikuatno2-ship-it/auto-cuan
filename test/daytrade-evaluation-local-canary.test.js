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

function candidate() {
  return {
    ticker: 'TEST', open_price: 100, high_price: 110, low_price: 99,
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

function options(root, tickers = ['TEST']) { return { execute: true, evaluationRoot: root, tickers }; }
function dependencies(overrides = {}) {
  return { engine: fakeEngine(), fetchCandles: async () => [], resolveCodeSha: () => 'a'.repeat(40), now: '2026-08-01T03:00:00.000Z', diskAudit: { writes_should_stop: false }, ...overrides };
}

test('requires acknowledgement, caller root, and at most five validated tickers', () => {
  assert.throws(() => canary.validateOptions({ execute: false, evaluationRoot: '/tmp/x', tickers: ['A'] }), /--execute/);
  assert.throws(() => canary.validateOptions({ execute: true, evaluationRoot: 'relative', tickers: ['A'] }), /absolute/);
  assert.throws(() => canary.validateOptions({ execute: true, evaluationRoot: '/tmp/x', tickers: ['A','B','C','D','E','F'] }), /maximum 5/);
  assert.throws(() => canary.parseArgs(['node','tool','--code-sha','secret']), /unknown option/);
});

test('local canary makes no network/API call and writes only gzip plus manifest below caller root', async () => {
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
  const retention = auditRetention({ root, now: '2026-08-01T03:00:00.000Z', freeBytes: 100 * 1024 ** 3 });
  assert.equal(retention.dry_run, true);
  assert.equal(retention.writes_should_stop, false);
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
