'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, readState, writeState, shouldSendEvent } = require('../tools/run-top5-progress-monitor');
test('runner defaults to dry-run and only enables send explicitly', () => {
  assert.equal(parseArgs(['node', 'runner']).dryRun, true);
  assert.equal(parseArgs(['node', 'runner', '--send']).send, true);
});
test('VPS state file persists idempotency event keys without duplicate records', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'top5-progress-'));
  const file = path.join(dir, 'state.json');
  const state = await readState(file);
  state.events['top5_progress:ABCD:2026-07-15:TP1_HIT:tp1'] = { sent_at: '2026-07-16T10:00:00Z' };
  await writeState(file, state);
  const reread = await readState(file);
  assert.equal(Object.keys(reread.events).length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});
test('duplicate, stale, and dry-run events cannot send', () => {
  const event = { event_key: 'top5_progress:ABCD:2026-07-15:TP1_HIT:tp1', actionable: true };
  assert.equal(shouldSendEvent({ send: false }, event, { events: {} }, { stale: false }), false);
  assert.equal(shouldSendEvent({ send: true }, event, { events: { [event.event_key]: {} } }, { stale: false }), false);
  assert.equal(shouldSendEvent({ send: true }, event, { events: {} }, { stale: true }), false);
});
