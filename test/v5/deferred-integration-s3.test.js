'use strict';

/**
 * test/v5/deferred-integration-s3.test.js — V5 S3 Deferred Integration regressions
 * ============================================================================
 * Local-only truth gates. No network, no real Telegram send, no quota spend.
 *
 *   A. Telegram gate consumer wiring
 *        - dry_run refusals now flow through the canonical lib/telegram-gate.js
 *          recorder (redacted chat id + text) — the non-breaking half of the
 *          gate that previously had NO consumer.
 *        - the strict live/dry decision (TELEGRAM_LIVE) remains fail-closed.
 *   B. Chart guard identity
 *        - a plan for ticker A can never satisfy a read for ticker B, and a
 *          superseded payload can never overwrite the newest write.
 *   C. Bandarmologi normalization
 *        - legacy `flow:"F"` mixed records are NOT re-summed into a fabricated
 *          foreign_net; normalizeBrokerSummary reports null + NOT_PUBLISHED.
 *        - getNetForeignFlow returns has_data:false + NOT_PUBLISHED (not NEUTRAL).
 *        - a valid legacy record still maps to a Broker Summary shape (broker
 *          rows preserved, foreign fields ABSENT).
 *        - insufficient-info fixture returns not-available, no fabricated number.
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

// Deterministic in-test Telegram recording seam (never touches data/).
const notifier = require(ROOT + '/lib/telegram-notifier');
const gate = require(ROOT + '/lib/telegram-gate');

const recordedRows = [];
// Route the refusal through the REAL gate recorder with an injected writeFile
// seam: this proves the canonical masking (chat id + secret text) is the actual
// sink, without ever writing to data/telegram-dry-run.jsonl.
function installTestRecorder() {
  recordedRows.length = 0;
  notifier.setDryRunRecorder((record) => gate.recordDryRun(record, {
    logPath: 'test-seam.jsonl',
    writeFile: (file, line) => { recordedRows.push(JSON.parse(line)); }
  }));
}
function restoreRecorder() {
  notifier.setDryRunRecorder(gate.recordDryRun);
}

// ---------------------------------------------------------------------------
// A. Telegram dry-run gate consumer
// ---------------------------------------------------------------------------

async function testTelegramGateWiring(t) {
  installTestRecorder();
  try {
    const res = await notifier.sendTelegramMessage('TEST dry-run with token=ABCDEFGH12345678', {
      chat_id: '6396446903',
      dry_run: true
    });
    assert.strictEqual(res.sent, false, 'dry_run must never send');
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'dry_run');
    assert.strictEqual(recordedRows.length, 1, 'dry-run refusal must be recorded exactly once via the gate sink');
    assert.strictEqual(recordedRows[0].source, 'telegram-notifier');
    assert.strictEqual(recordedRows[0].method, 'sendMessage');
    // The gate masks a numeric chat id as '***' + last-4 digits.
    assert.strictEqual(recordedRows[0].chat_id_masked.indexOf('6396446903'), -1, 'chat id must be masked');
    assert.strictEqual(recordedRows[0].text.indexOf('ABCDEFGH12345678'), -1, 'token must be redacted');
  } finally {
    restoreRecorder();
  }
}

async function testTelegramGateFailClosed(t) {
  // The strict live switch must still refuse live sends by default.
  assert.strictEqual(gate.decideSend({}).live, false);
  assert.strictEqual(gate.decideSend({ TELEGRAM_ENABLED: '1' }).live, false);
  assert.strictEqual(gate.decideSend({ TELEGRAM_LIVE: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'tok' }).live, true);
}

// ---------------------------------------------------------------------------
// B. Chart guard identity
// ---------------------------------------------------------------------------

function testChartGuardIdentity(t) {
  const guard = require(ROOT + '/public/chart-state-guard');
  const state = guard.createChartState();

  const tokenA = state.begin('BBCA', guard.CATEGORY.PLAN);
  state.publish(tokenA, { ticker: 'BBCA', plan: 'plan-for-A' }, {});

  // A plan for ticker A must NEVER satisfy a read for ticker B.
  assert.strictEqual(state.read('BBRI', guard.CATEGORY.PLAN), null,
    'a trading plan for A must not appear when the user opens B');
  assert.strictEqual(state.read('BBCA', guard.CATEGORY.PLAN).plan, 'plan-for-A');

  // A superseded request must not overwrite the newest write.
  const tokenB = state.begin('BBRI', guard.CATEGORY.PLAN);
  const tokenB2 = state.begin('BBRI', guard.CATEGORY.PLAN);
  // publish with the STALE token (B) after the newest token (B2) exists
  const stalePublish = state.publish(tokenB, { ticker: 'BBRI', plan: 'stale-B' }, {});
  assert.strictEqual(stalePublish.ok, false, 'stale token publish must be rejected');
  // The stale write never leaked into the store for BBRI (nothing published).
  assert.strictEqual(state.read('BBRI', guard.CATEGORY.PLAN), null,
    'a stale publish must not put a plan into the BBRI slot');

  // The newest token's publish succeeds and holds the current payload.
  const currentPublish = state.publish(tokenB2, { ticker: 'BBRI', plan: 'current-B' }, {});
  assert.strictEqual(currentPublish.ok, true, 'current token publish must be accepted');
  assert.strictEqual(state.read('BBRI', guard.CATEGORY.PLAN).plan, 'current-B');
}

// ---------------------------------------------------------------------------
// C. Bandarmologi normalization
// ---------------------------------------------------------------------------

const MIXED_LEGACY_F = {
  stock_code: 'BBCA',
  broker_start_date: '2026-10-30',
  broker_end_date: '2026-10-30',
  flow: 'F',
  brokers: [
    { broker_code: 'BK', broker_name: 'J.P. MORGAN', bval: 232420368000, bvol: 46751900, sval: 85679052500, svol: 17241400, nval: 146741315500, nvol: 29510500 },
    { broker_code: 'CC', broker_name: 'MANDIRI', bval: 67023386000, bvol: 13521600, sval: 49103761500, svol: 9905700, nval: 17919624500, nvol: 3615900 },
    { broker_code: 'AK', broker_name: 'UBS', bval: 232055742000, bvol: 46752900, sval: 177377345000, svol: 35748900, nval: 54678397000, nvol: 11004000 }
  ],
  broker_levels: [],
  broker_net: false
};

// A modern F record with a genuine foreign decomposition.
const MODERN_F = {
  stock_code: 'BBCA',
  date: '2026-11-02',
  flow: 'F',
  status: 'RELEASED',
  brokers: [
    { broker_code: 'BK', bval: 100, sval: 0, nval: 100 },
    { broker_code: 'YP', bval: 0, sval: 40, nval: -40 }
  ],
  foreign_net: 60
};

function testLegacyForeignNotConflated(t) {
  const svc = require(ROOT + '/lib/bandarmologi-service');
  const norm = svc.normalizeBrokerSummary(MIXED_LEGACY_F, '2026-10-30', 'BBCA');

  assert.ok(norm, 'legacy F record must normalize to a Broker Summary shape');
  assert.strictEqual(norm.foreign_net, null, 'legacy mixed F must NOT synthesize foreign_net');
  assert.strictEqual(norm.foreign_buy, 0, 'legacy mixed F must NOT synthesize foreign_buy');
  assert.strictEqual(norm.foreign_sell, 0, 'legacy mixed F must NOT synthesize foreign_sell');
  assert.strictEqual(norm.foreign_net_status, 'NOT_PUBLISHED');
  assert.strictEqual(norm.foreign_flow_status, 'NOT_PUBLISHED');
  // Real broker rows are preserved as real market data.
  assert.strictEqual(norm.brokers.length, 3);
}

function testLegacyForeignNetFlowNotAvailable(t) {
  const svc = require(ROOT + '/lib/bandarmologi-service');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 's3-legacy-f-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;
  try {
    svc.writeDiskCache('broker-summary', 'BBCA', '2026-10-30', MIXED_LEGACY_F);
    const flow = svc.getNetForeignFlow('BBCA', '2026-10-30');
    assert.strictEqual(flow.has_data, false, 'legacy mixed F must be not-available, not NEUTRAL');
    assert.strictEqual(flow.foreign_net, null);
    assert.strictEqual(flow.foreign_flow_status, 'NOT_PUBLISHED');
    assert.strictEqual(flow.foreign_net_status, 'NOT_PUBLISHED');
  } finally {
    if (origEnv === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = origEnv;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

function testModernForeignStillComputes(t) {
  const svc = require(ROOT + '/lib/bandarmologi-service');
  const norm = svc.normalizeBrokerSummary(MODERN_F, '2026-11-02', 'BBCA');
  assert.strictEqual(norm.foreign_net, 60, 'modern F record must keep its real foreign_net');
  assert.strictEqual(norm.foreign_net_status, 'AVAILABLE');
  assert.strictEqual(norm.foreign_flow_status, 'ACCUMULATION');
}

function testLegacyAdapterValidMapping(t) {
  const adapter = require(ROOT + '/lib/legacy-foreign-adapter');
  const out = adapter.normalizeLegacyForeign(MIXED_LEGACY_F, { requestedDate: '2026-10-30' });
  // Valid legacy -> Broker Summary mapping: broker rows + derived totals kept,
  // foreign decomposition ABSENT, status NOT_PUBLISHED.
  assert.strictEqual(out.status, 'LEGACY');
  assert.strictEqual(out.is_complete, false);
  assert.strictEqual(out.foreign_net, null);
  assert.strictEqual(out.foreign_net_status, 'NOT_PUBLISHED');
  assert.strictEqual(out.brokers.length, 3, 'real broker rows must be mapped verbatim');
  assert.strictEqual(out.total_buy_val, 232420368000 + 67023386000 + 232055742000);

  // Insufficient-info fixture: no broker rows at all → not-available, no number.
  const insufficient = { stock_code: 'BBCA', flow: 'F', brokers: [], broker_levels: [] };
  assert.strictEqual(adapter.classifyForeignRecord(insufficient), 'EMPTY');
  const mapped = adapter.normalizeLegacyForeign(insufficient, { requestedDate: '2026-10-30' });
  assert.strictEqual(mapped.foreign_net, null, 'insufficient legacy info must not fabricate foreign_net');
  assert.strictEqual(mapped.foreign_net_status, 'NOT_PUBLISHED');
  assert.strictEqual(mapped.brokers.length, 0);
}

// Simple sequential runner (node:test keeps each test isolated).
const tests = [
  ['A: telegram dry-run flows through the canonical gate recorder (redacted)', testTelegramGateWiring],
  ['A: telegram strict live swich remains fail-closed', testTelegramGateFailClosed],
  ['B: chart guard never serves ticker A plan to ticker B and blocks stale publish', testChartGuardIdentity],
  ['C: legacy mixed F is not re-summed into a fabricated foreign_net', testLegacyForeignNotConflated],
  ['C: legacy mixed F netforeignflow returns NOT_PUBLISHED (not NEUTRAL)', testLegacyForeignNetFlowNotAvailable],
  ['C: modern genuine foreign_net is preserved', testModernForeignStillComputes],
  ['C: legacy adapter maps valid legacy -> Broker Summary and rejects insufficient info', testLegacyAdapterValidMapping]
];

const failures = [];
(async () => {
  for (const [label, fn] of tests) {
    try {
      await fn();
      console.log('  ok   ' + label);
    } catch (e) {
      failures.push(label + ' :: ' + e.message);
      console.log('  FAIL ' + label + ' :: ' + e.message);
    }
  }
  if (failures.length > 0) {
    console.error('\n[deferred-integration-s3] ' + failures.length + ' failure(s)');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('\n[deferred-integration-s3] all ' + tests.length + ' assertions passed');
  process.exit(0);
})();