'use strict';

// Regression test for PR-3: Swing Konglo previously took a SILENT path when a
// refresh completed successfully but saved zero rows (savedCount === 0). The
// refresh returned { skipped: true, reason: 'no_saved_rows' } without sending any
// Telegram message, so a successful-but-empty run looked like a Telegram failure.
//
// It now sends a safe empty heartbeat via sendSwingKongloNoSavedRowsHeartbeat.
// This test verifies the heartbeat contract and message content, and confirms no
// candidates are published (no monitoring/insert side effects).

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');
const notifier = require('../lib/telegram-notifier');

async function withSendSpy(fn) {
  const original = notifier.sendTelegramMessage;
  const calls = [];
  notifier.sendTelegramMessage = async (text) => { calls.push(text); return { sent: true, message: text }; };
  try { return await fn(calls); } finally { notifier.sendTelegramMessage = original; }
}

test('Swing Konglo no_saved_rows sends a safe empty heartbeat (not a silent skip)', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingKongloNoSavedRowsHeartbeat({
      scanned_count: 120,
      generated_count: 0,
      saved_count: 0,
      failed_count: 3
    });

    // Heartbeat contract required by PR-3.
    assert.equal(result.sent, true);
    assert.equal(result.skipped, false);
    assert.equal(result.reason, 'swing_konglo_no_saved_rows_heartbeat_sent');
    assert.notEqual(result.reason, 'no_saved_rows');

    // Exactly one Telegram message sent, no candidates published.
    assert.equal(calls.length, 1);
    assert.equal(result.selected_count, 0);

    // Message clearly states the situation and includes the counts.
    assert.match(calls[0], /Swing Konglo refresh completed but no rows were saved\./);
    assert.match(calls[0], /Scanned: 120/);
    assert.match(calls[0], /Generated: 0/);
    assert.match(calls[0], /Saved: 0/);
    assert.match(calls[0], /Failed: 3/);
  });
});

test('Swing Konglo no_saved_rows heartbeat surfaces missing counts as 0', async () => {
  await withSendSpy(async (calls) => {
    const result = await sectorHot.__test.sendSwingKongloNoSavedRowsHeartbeat();
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'swing_konglo_no_saved_rows_heartbeat_sent');
    assert.match(calls[0], /Scanned: 0/);
    assert.match(calls[0], /Saved: 0/);
  });
});

test('Swing Konglo no_saved_rows heartbeat reports silent when Telegram not sent', async () => {
  const original = notifier.sendTelegramMessage;
  notifier.sendTelegramMessage = async () => ({ sent: false, reason: 'telegram_disabled' });
  try {
    const result = await sectorHot.__test.sendSwingKongloNoSavedRowsHeartbeat({ scanned_count: 10 });
    assert.equal(result.sent, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'swing_konglo_no_saved_rows_silent');
  } finally {
    notifier.sendTelegramMessage = original;
  }
});
