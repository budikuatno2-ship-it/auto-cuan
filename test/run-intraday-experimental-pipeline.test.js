'use strict';

/**
 * Tests for the combined intraday EXPERIMENTAL pipeline
 * (tools/run-intraday-experimental-pipeline.js).
 *
 * Verifies: explicit-date wiring + output dirs, validation rejections, strict
 * stage ordering (collector -> shadow scoring -> admin gate), the no-look-ahead
 * timing rule (a same-snapshot signal cannot enter; it becomes eligible only
 * once the next snapshot exists), dry-run + feature-flag protections, admin-only
 * delivery, idempotent reruns, the overlapping-run lock, and non-interference
 * with swing / Top5 / public delivery / the API surface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const pipeline = require('../tools/run-intraday-experimental-pipeline');
const live = require('../lib/intraday-shadow-scoring-live');

const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'intraday-shadow-scoring-live', '2026-07-21');
const DATE = '2026-07-21';
const ADMIN_CHAT = '-1009999999';
const PUBLIC_CHAT = '-1001111111';

const ENABLED_ENV = Object.freeze({
  DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: 'true',
  TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT
});

const MODULE_SRC = fs.readFileSync(path.join(__dirname, '..', 'tools', 'run-intraday-experimental-pipeline.js'), 'utf8');

async function tmpdir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix || 'pipeline-test-'));
}

// Build an isolated workspace: a sample-root pre-populated with the fixture
// date directory (models "the collector already produced samples"), a separate
// shadow-root, and a fresh state file path (not yet created).
async function makeWorkspace() {
  const base = await tmpdir();
  const sampleRoot = path.join(base, 'intraday-samples');
  const shadowRoot = path.join(base, 'intraday-shadow-scoring-live');
  const dateDir = path.join(sampleRoot, DATE);
  await fsp.mkdir(dateDir, { recursive: true });
  for (const f of ['runs.jsonl', 'candidates.jsonl', 'summary.json', 'lifecycle.json']) {
    await fsp.copyFile(path.join(FIXTURE_SRC, f), path.join(dateDir, f));
  }
  return { base, sampleRoot, shadowRoot, stateFile: path.join(base, 'alerts', 'alerts.jsonl') };
}

// A no-op collector that reports success without touching files (the fixture
// samples already exist in the sample-root).
function noopCollector(recorder) {
  return async (o) => {
    if (recorder) recorder.push({ stage: 'collector', opts: o });
    return { status: 'success', candidates: 0, scanned: 0, summary_generated: false };
  };
}

function captureSender() {
  const calls = [];
  const sender = async (text, adminChatId, env) => {
    calls.push({ text, adminChatId, env });
    return { ok: true, sent: true, skipped: false, reason: null };
  };
  return { calls, sender };
}

// ===================================================================
// Explicit date -> output directories
// ===================================================================

test('1. explicit date controls the sample + shadow output directories', async () => {
  const ws = await makeWorkspace();
  const collectorCalls = [];
  const result = await pipeline.runPipeline({
    date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    stateFile: ws.stateFile, env: {}, skipLock: true, collector: noopCollector(collectorCalls)
  });
  assert.equal(result.status, 'success');
  assert.equal(result.sample_dir, path.join(ws.sampleRoot, DATE));
  assert.equal(result.shadow_dir, path.join(ws.shadowRoot, DATE));
  // The collector was invoked with the explicit sample date + root.
  assert.equal(collectorCalls[0].opts.sampleDate, DATE);
  assert.equal(collectorCalls[0].opts.sampleRoot, ws.sampleRoot);
  // Shadow outputs were written under <shadowRoot>/<date>/.
  assert.ok(fs.existsSync(path.join(ws.shadowRoot, DATE, 'live-shadow-summary.json')));
});

// ===================================================================
// Validation rejections
// ===================================================================

test('2. an invalid date is rejected before any stage runs', async () => {
  const ws = await makeWorkspace();
  const collectorCalls = [];
  const result = await pipeline.runPipeline({
    date: '2026-13-40', time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    env: {}, skipLock: true, collector: noopCollector(collectorCalls)
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'invalid_date');
  assert.equal(collectorCalls.length, 0);
});

test('3. an invalid scheduled time is rejected before any stage runs', async () => {
  const ws = await makeWorkspace();
  const collectorCalls = [];
  const result = await pipeline.runPipeline({
    date: DATE, time: '12:15', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    env: {}, skipLock: true, collector: noopCollector(collectorCalls)
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'invalid_time');
  assert.equal(collectorCalls.length, 0);
});

test('4. a wrong WIB date from the collector halts the pipeline', async () => {
  const ws = await makeWorkspace();
  const order = [];
  const wrongDateCollector = async (o) => { order.push('collector'); return { status: 'rejected', reason: 'wrong_date' }; };
  const shadowSpy = async () => { order.push('shadow'); return { status: 'success', evaluation: {} }; };
  const result = await pipeline.runPipeline({
    date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    env: {}, skipLock: true, collector: wrongDateCollector, shadowScorer: shadowSpy
  });
  assert.equal(result.status, 'collector_failed');
  assert.equal(result.collector.reason, 'wrong_date');
  // Shadow scoring must NOT have run after a failed collector.
  assert.deepEqual(order, ['collector']);
});

// ===================================================================
// Strict stage ordering
// ===================================================================

test('5. stages run strictly in order: collector -> shadow scoring -> admin gate', async () => {
  const ws = await makeWorkspace();
  const order = [];
  const collector = async () => { order.push('collector'); return { status: 'success' }; };
  const shadowScorer = async () => { order.push('shadow_scoring'); return { status: 'success', evaluation: { date: DATE, summary: { evaluated_snapshot_times: [] }, scores: [], confirmed_top5: [] } }; };
  const alerter = async () => { order.push('admin_gate'); return { status: 'disabled', enabled: false, sent: 0, evaluated: 0, alerts: [] }; };
  const result = await pipeline.runPipeline({
    date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    env: {}, skipLock: true, collector, shadowScorer, alerter
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(order, ['collector', 'shadow_scoring', 'admin_gate']);
  assert.deepEqual(result.stages_completed, ['collector', 'shadow_scoring', 'admin_gate']);
});

// ===================================================================
// No look-ahead / timing
// ===================================================================

test('6. a current-snapshot signal cannot enter at the same snapshot (no next snapshot yet)', async () => {
  // WINR becomes confirmed rank-1 at 09:30. Running THROUGH 09:30 means 09:30 is
  // the latest snapshot, so there is no next snapshot and no executable entry.
  const ws = await makeWorkspace();
  const { calls, sender } = captureSender();
  const result = await pipeline.runPipeline({
    date: DATE, time: '09:30', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    stateFile: ws.stateFile, env: Object.assign({}, ENABLED_ENV), skipLock: true,
    collector: noopCollector(), sender
  });
  assert.equal(result.status, 'success');
  assert.equal(result.admin_gate.sent, 0);
  assert.equal(calls.length, 0);
  const winr = (result.admin_gate.alerts || []).find((a) => a.ticker === 'WINR');
  assert.ok(winr, 'WINR should be evaluated as a candidate');
  assert.equal(winr.eligible, false);
  assert.equal(winr.reason, 'REJECT_MISSING_NEXT_SNAPSHOT_PRICE');
  // No alert state written for a non-eligible candidate.
  assert.equal(fs.existsSync(ws.stateFile), false);
});

test('7. a prior signal becomes eligible once the next snapshot exists', async () => {
  // Running THROUGH 09:45 means WINR (signal 09:30) now has a next snapshot
  // (09:45) with an executable entry price -> eligible, and sent admin-only.
  const ws = await makeWorkspace();
  const { calls, sender } = captureSender();
  const result = await pipeline.runPipeline({
    date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    stateFile: ws.stateFile, env: Object.assign({}, ENABLED_ENV), skipLock: true,
    collector: noopCollector(), sender
  });
  assert.equal(result.status, 'success');
  assert.equal(result.admin_gate.sent, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('Ticker: WINR'));
  assert.equal(calls[0].adminChatId, ADMIN_CHAT);
  assert.ok(fs.existsSync(ws.stateFile), 'an eligible send records alert state');
});

// ===================================================================
// Dry-run + feature-flag protections
// ===================================================================

test('8. dry-run sends nothing and writes no alert state', async () => {
  const ws = await makeWorkspace();
  const { calls, sender } = captureSender();
  const result = await pipeline.runPipeline({
    date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    stateFile: ws.stateFile, env: Object.assign({}, ENABLED_ENV), skipLock: true,
    collector: noopCollector(), sender, dryRun: true
  });
  assert.equal(result.status, 'success');
  assert.equal(result.dry_run, true);
  assert.equal(result.admin_gate.sent, 0);
  assert.equal(calls.length, 0);
  // A dry-run WINR is still previewed as eligible, but not sent.
  const winr = (result.admin_gate.alerts || []).find((a) => a.ticker === 'WINR');
  assert.ok(winr && winr.eligible === true && winr.dry_run === true);
  assert.equal(fs.existsSync(ws.stateFile), false, 'dry-run must not create the alert state file');
});

test('9. feature flag not explicitly true sends nothing', async () => {
  const ws = await makeWorkspace();
  const { calls, sender } = captureSender();
  const result = await pipeline.runPipeline({
    date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    stateFile: ws.stateFile, env: { TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT }, // flag absent
    skipLock: true, collector: noopCollector(), sender
  });
  assert.equal(result.status, 'success');
  assert.equal(result.admin_gate.status, 'disabled');
  assert.equal(result.admin_gate.sent, 0);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(ws.stateFile), false);
});

test('10. feature flag true delivers admin-only (never the public chat)', async () => {
  const ws = await makeWorkspace();
  const { calls, sender } = captureSender();
  const result = await pipeline.runPipeline({
    date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    stateFile: ws.stateFile, skipLock: true, collector: noopCollector(), sender,
    env: { DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: 'true', TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT, TELEGRAM_CHAT_ID: PUBLIC_CHAT }
  });
  assert.equal(result.admin_gate.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].adminChatId, ADMIN_CHAT);
  assert.notEqual(calls[0].adminChatId, PUBLIC_CHAT);
  assert.equal(result.safety.public_delivery_possible, false);
});

// ===================================================================
// Idempotency
// ===================================================================

test('11. reruns do not duplicate the same date/ticker alert', async () => {
  const ws = await makeWorkspace();
  const first = captureSender();
  const r1 = await pipeline.runPipeline({
    date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    stateFile: ws.stateFile, env: Object.assign({}, ENABLED_ENV), skipLock: true,
    collector: noopCollector(), sender: first.sender
  });
  assert.equal(r1.admin_gate.sent, 1);

  const second = captureSender();
  const r2 = await pipeline.runPipeline({
    date: DATE, time: '10:30', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    stateFile: ws.stateFile, env: Object.assign({}, ENABLED_ENV), skipLock: true,
    collector: noopCollector(), sender: second.sender
  });
  assert.equal(r2.admin_gate.sent, 0, 'a later rerun must not resend the same date/ticker');
  assert.equal(second.calls.length, 0);
  const winr = (r2.admin_gate.alerts || []).find((a) => a.ticker === 'WINR');
  assert.equal(winr.reason, 'REJECT_DUPLICATE_SAME_DAY');
});

// ===================================================================
// Overlapping pipeline execution is blocked
// ===================================================================

test('12. an overlapping pipeline run is blocked by the dedicated lock', async () => {
  const ws = await makeWorkspace();
  const lockFile = path.join(ws.base, '.locks', 'pipeline.lock');
  const release = await live.acquireLock(lockFile);
  assert.ok(typeof release === 'function');
  try {
    const result = await pipeline.runPipeline({
      date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
      stateFile: ws.stateFile, env: Object.assign({}, ENABLED_ENV), lockFile,
      collector: noopCollector()
    });
    assert.equal(result.status, 'skipped_due_to_lock');
  } finally {
    await release();
  }
  // Once released, the pipeline acquires the lock and runs.
  const ok = await pipeline.runPipeline({
    date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
    stateFile: ws.stateFile, env: Object.assign({}, ENABLED_ENV), lockFile,
    collector: noopCollector(), sender: captureSender().sender
  });
  assert.equal(ok.status, 'success');
});

// ===================================================================
// Hard-set safety
// ===================================================================

test('13. the pipeline hard-sets score/mutation off even if the ambient env enables them', async () => {
  const ws = await makeWorkspace();
  const savedScore = process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
  const savedMut = process.env.DAYTRADE_WORKER_ALLOW_MUTATION;
  process.env.DAYTRADE_INTRADAY_SCORE_ENABLED = '1';
  process.env.DAYTRADE_WORKER_ALLOW_MUTATION = 'true';
  try {
    let seenScore = null;
    let seenMut = null;
    const collector = async () => {
      // The collector reads process.env directly; the pipeline must have forced
      // both flags off before invoking it.
      seenScore = process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
      seenMut = process.env.DAYTRADE_WORKER_ALLOW_MUTATION;
      return { status: 'success' };
    };
    const result = await pipeline.runPipeline({
      date: DATE, time: '09:45', sampleRoot: ws.sampleRoot, shadowRoot: ws.shadowRoot,
      stateFile: ws.stateFile, env: Object.assign({}, ENABLED_ENV), skipLock: true,
      collector, sender: captureSender().sender
    });
    assert.equal(result.status, 'success');
    assert.equal(seenScore, 'false');
    assert.equal(seenMut, 'false');
    assert.equal(result.safety.DAYTRADE_INTRADAY_SCORE_ENABLED, 'false');
    assert.equal(result.safety.DAYTRADE_WORKER_ALLOW_MUTATION, 'false');
    // process.env is restored to its prior (enabled) values after the run.
    assert.equal(process.env.DAYTRADE_INTRADAY_SCORE_ENABLED, '1');
    assert.equal(process.env.DAYTRADE_WORKER_ALLOW_MUTATION, 'true');
  } finally {
    if (savedScore === undefined) delete process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
    else process.env.DAYTRADE_INTRADAY_SCORE_ENABLED = savedScore;
    if (savedMut === undefined) delete process.env.DAYTRADE_WORKER_ALLOW_MUTATION;
    else process.env.DAYTRADE_WORKER_ALLOW_MUTATION = savedMut;
  }
});

// ===================================================================
// Telegram destination discipline + non-interference
// ===================================================================

test('14. the pipeline code never uses forbidden Telegram destinations, swing/top5, or DB mutation', () => {
  // Executable code must not reference the public / secondary / channel chats.
  const codeOnly = MODULE_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  for (const forbidden of ['TELEGRAM_CHAT_ID', 'TELEGRAM_DAYTRADE_CHAT_ID', 'TELEGRAM_TOP5_CHAT_ID', 'TELEGRAM_VERIFY_CHANNEL_ID']) {
    // The literal may appear only inside the FORBIDDEN_TELEGRAM_ENV allowlist
    // (as data documenting what must be avoided), never as an env read.
    const asRead = new RegExp('env(?:ironment)?\\[?[\'"\\.]?' + forbidden);
    assert.ok(!asRead.test(codeOnly), 'must not read ' + forbidden);
  }
  // No new bot token, no swing/top5/public delivery, no DB mutation.
  assert.ok(!/TELEGRAM_[A-Z_]*BOT_TOKEN\s*=/.test(codeOnly), 'must not define a new bot token');
  assert.ok(!/konglo|sendDailyTop5|progress[_-]?monitor/i.test(codeOnly), 'must not touch swing/top5 delivery');
  assert.ok(!/\.insert\(|\.upsert\(|@supabase\/supabase-js/.test(codeOnly), 'must not mutate DB / import supabase');
});

test('15. swing, Top5 and public delivery modules are not imported by the pipeline', () => {
  assert.ok(!/require\(['"][^'"]*(telegram-templates|top5-progress-monitor|daytrade-screener-engine|supabase)[^'"]*['"]\)/.test(MODULE_SRC));
  // The reused admin destination + bot token are the ONLY telegram references.
  assert.ok(pipeline.FORBIDDEN_TELEGRAM_ENV.includes('TELEGRAM_CHAT_ID'));
  assert.ok(pipeline.FORBIDDEN_TELEGRAM_ENV.includes('TELEGRAM_VERIFY_CHANNEL_ID'));
});

test('16. API JavaScript endpoint count remains exactly 12', async () => {
  const entries = await fsp.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});

// ===================================================================
// CLI parsing
// ===================================================================

test('17. CLI parses the documented VPS dry-run invocation', () => {
  const args = pipeline.parseArgs([
    'node', 'tool',
    '--date', '2026-07-23',
    '--time', '16:00',
    '--sample-root', '/home/ubuntu/auto-cuan/data/intraday-samples',
    '--shadow-root', '/home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live',
    '--state-file', '/home/ubuntu/auto-cuan/data/experimental-daytrade-alerts/alerts.jsonl',
    '--dry-run'
  ]);
  assert.equal(args.date, '2026-07-23');
  assert.equal(args.time, '16:00');
  assert.equal(args.sampleRoot, '/home/ubuntu/auto-cuan/data/intraday-samples');
  assert.equal(args.shadowRoot, '/home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live');
  assert.equal(args.stateFile, '/home/ubuntu/auto-cuan/data/experimental-daytrade-alerts/alerts.jsonl');
  assert.equal(args.dryRun, true);
});
