'use strict';

/**
 * AUDIT FASE 10 — Telegram Notification Delivery, Rate Limiting, Deduplication & Template Formatting
 *
 * Test-first verification of defects found by line-by-line audit of:
 *   lib/telegram-notifier.js
 *   lib/telegram-templates.js
 *   lib/webhook-alert-engine.js
 *   lib/foreign-flow-recap.js
 *
 * Each test FAILS on pre-fix code and documents the real-world trigger.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// F10-01 — isConfirmedBuyStatus false positive for NOT_READY (substring bug)
// ---------------------------------------------------------------------------
test('F10-01 telegram-notifier isConfirmedBuyStatus must not treat NOT_READY as confirmed buy', () => {
  const notifier = require('../lib/telegram-notifier');
  const result = notifier.isDrasticAlertStatusChange('WATCHLIST', 'NOT_READY');
  assert.equal(result, false, 'WATCHLIST -> NOT_READY must NOT be considered drastic upgrade (NOT_READY contains READY substring bug)');
});

test('F10-01b webhook-alert-engine isConfirmedBuyStatus must not treat NOT_READY as confirmed buy', () => {
  const engine = require('../lib/webhook-alert-engine');
  engine.clearCooldownCache();
  const now = Date.now();
  engine.recordCooldown('BBCA', { status: 'WATCHLIST' }, { now, cooldownMs: 20 * 60 * 1000 });
  const check = engine.checkCooldown('BBCA', { status: 'NOT_READY' }, { now: now + 1000 });
  assert.equal(check.shouldDrop, true, 'NOT_READY should NOT bypass WATCHLIST cooldown (substring bug)');
  engine.clearCooldownCache();
});

// ---------------------------------------------------------------------------
// F10-02 — fmtSignedValue leaks raw string NaN/undefined/null
// ---------------------------------------------------------------------------
test('F10-02 fmtSignedValue must not leak NaN/undefined/null strings', () => {
  const templates = require('../lib/telegram-templates');
  assert.equal(templates.fmtSignedValue('NaN'), '-', 'NaN string must be sanitized to -');
  assert.equal(templates.fmtSignedValue('undefined'), '-', 'undefined string must be sanitized');
  assert.equal(templates.fmtSignedValue('null'), '-', 'null string must be sanitized');
  assert.equal(templates.fmtSignedValue('[object Object]'), '-', '[object Object] must be sanitized');
  assert.equal(templates.fmtSignedValue('+Rp 1 M'), '+Rp 1 M');
});

test('F10-02b fmtSignedValue numeric NaN must return -', () => {
  const templates = require('../lib/telegram-templates');
  assert.equal(templates.fmtSignedValue(NaN), '-');
  assert.equal(templates.fmtSignedValue(undefined), '-');
  assert.equal(templates.fmtSignedValue(null), '-');
});

// ---------------------------------------------------------------------------
// F10-03 — webhook-alert-engine dispatchTelegram 429 must expose retry_after
// ---------------------------------------------------------------------------
test('F10-03 webhook dispatchTelegram must expose retry_after on 429', async () => {
  const engine = require('../lib/webhook-alert-engine');
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '5' : null },
    text: async () => JSON.stringify({ ok: false, parameters: { retry_after: 5 } })
  });
  try {
    const result = await engine.dispatchTelegram('test message', 'fake-token', '123', { timeoutMs: 1000 });
    assert.equal(result.sent, false);
    assert.equal(result.status, 429);
    assert.equal(result.retry_after_seconds, 5, 'retry_after_seconds must be 5, got ' + JSON.stringify(result));
  } finally {
    global.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// F10-04 — HTML parse mode: foreign-flow-recap must escape entities
// ---------------------------------------------------------------------------
test('F10-04 formatForeignFlowRecapMessage must escape HTML entities for HTML parse_mode', () => {
  const recap = require('../lib/foreign-flow-recap');
  const data = {
    date: '2026-09-23',
    total_net_foreign: 1000000000,
    stocks_scanned: 1,
    total_universe: 1,
    top_accumulated: [{ ticker: 'A' + String.fromCharCode(38) + 'B', net_val: 500000000, top_foreign_brokers: ['AK'] }],
    top_distributed: []
  };
  const msg = recap.formatForeignFlowRecapMessage(data);
  const rawAmp = String.fromCharCode(38);
  const escapedAmp = rawAmp + 'amp;';
  // Raw ampersand inside the bold ticker tag must not survive; it must be escaped.
  assert.ok(msg.indexOf('<b>A' + rawAmp + 'B</b>') === -1, 'Raw & inside <b> must be escaped for HTML parse_mode');
  assert.ok(msg.indexOf('A' + escapedAmp + 'B') !== -1, 'Ticker with & must be HTML-escaped to ' + escapedAmp);
});

test('F10-04b telegram-templates safe must not leak NaN/undefined into card', () => {
  const templates = require('../lib/telegram-templates');
  const card = templates.formatSignalCard({
    ticker: 'TEST',
    status: 'READY_BREAKOUT',
    entry_low: NaN,
    entry_high: undefined,
    stop_loss: null,
    tp1: NaN,
    tp2: undefined,
    risk_reward: NaN,
    last_price: NaN,
    volume_ratio_20d: NaN
  }, 1, 'daytrade');
  assert.doesNotMatch(card, /NaN/);
  assert.doesNotMatch(card, /undefined/);
  assert.doesNotMatch(card, /null%/);
});

// ---------------------------------------------------------------------------
// F10-05 — splitTelegramMessage must not produce whitespace-only chunks
// ---------------------------------------------------------------------------
test('F10-05 splitTelegramMessage must not produce whitespace-only chunks', () => {
  const notifier = require('../lib/telegram-notifier');
  const chunks = notifier.splitTelegramMessage('   \n\n   ', 100);
  for (const c of chunks) {
    assert.ok(c.trim().length > 0, 'chunk must not be whitespace-only: ' + JSON.stringify(c));
  }
  assert.ok(chunks.length === 0 || chunks.every((c) => c.trim().length > 0), 'no whitespace-only chunks');
});

// ---------------------------------------------------------------------------
// F10-06 — webhook dispatchTelegram must not throw on network error
// ---------------------------------------------------------------------------
test('F10-06 webhook dispatchTelegram must not throw on network error', async () => {
  const engine = require('../lib/webhook-alert-engine');
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const result = await engine.dispatchTelegram('test', 'fake-token', '123', { timeoutMs: 1000 });
    assert.equal(result.sent, false);
    assert.ok(result.error, 'error must be set');
  } finally {
    global.fetch = originalFetch;
  }
});
