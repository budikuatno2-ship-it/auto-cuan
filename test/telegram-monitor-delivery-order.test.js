'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');

test('significant monitor hits are delivered before terminal markers are persisted', () => {
  const start = source.indexOf('var update = { status: ev.status');
  const end = source.indexOf('// HOURLY BATCH DIGEST ROW', start);
  assert.ok(start >= 0 && end > start, 'monitor block not found');
  const block = source.slice(start, end);
  const send = block.indexOf('sendTelegramMessage(hitMsg');
  const persist = block.indexOf("update(persistedUpdate).eq('id', pck.id)");
  assert.ok(send >= 0, 'immediate Telegram send not found');
  assert.ok(persist > send, 'monitor state must be persisted only after the delivery attempt');
  assert.ok(block.includes("persistedUpdate = { last_checked_at: update.last_checked_at }"), 'failed sends must not consume terminal/hit markers');
});

test('monitor response surfaces an individual delivery failure instead of reporting success true', () => {
  assert.match(source, /success:\s*individualDeliveryOk/);
  assert.match(source, /individual_failed_count:\s*individualFailedCount/);
  assert.match(source, /individual_monitor_delivery_failed/);
});

test('Telegram webhook fails closed when its secret is absent', () => {
  const start = source.indexOf('async function handleTelegramWebhook');
  const end = source.indexOf('var body = req.body || {}', start);
  const block = source.slice(start, end);
  assert.match(block, /if \(!secret\) return res\.status\(503\)/);
  assert.match(block, /crypto\.timingSafeEqual/);
});
