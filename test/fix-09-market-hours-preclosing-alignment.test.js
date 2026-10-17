'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../lib/market-hours-guard.js');
const producer = require('../tools/run-daytrade-intraday-producer.js');

test('FIX-09: Pre-closing 15:45-15:50 WIB preserves 2-layer contract', () => {
  // Monday 2026-10-19 15:45:00 WIB (08:45:00 UTC)
  const at1545 = new Date('2026-10-19T08:45:00.000Z');
  assert.equal(guard.getMarketSession(at1545), 'SESSION_2');
  assert.equal(guard.isMarketOpen(at1545), true);
  const status1545 = guard.getMarketSessionStatus(at1545);
  assert.equal(status1545.isOpen, true);
  assert.equal(status1545.session, 'SESSION_2');
  assert.equal(status1545.broadcast_allowed, true);

  // Monday 2026-10-19 15:48:00 WIB (08:48:00 UTC) - Pre-closing phase
  const at1548 = new Date('2026-10-19T08:48:00.000Z');
  // Broadcast gate is CLOSED at 15:48
  assert.equal(guard.getMarketSession(at1548), 'CLOSED', 'getMarketSession must be CLOSED at 15:48 to protect broadcast gate');
  assert.equal(guard.isMarketOpen(at1548), false, 'isMarketOpen must be false at 15:48');
  // But scanner/observation status remains OPEN until 15:50
  const status1548 = guard.getMarketSessionStatus(at1548);
  assert.equal(status1548.isOpen, true, 'getMarketSessionStatus().isOpen must remain true at 15:48 for pre-closing scanner');
  assert.equal(status1548.session, 'SESSION_2');
  assert.equal(status1548.broadcast_allowed, false, 'broadcast_allowed must be false at 15:48');

  // Monday 2026-10-19 15:51:00 WIB (08:51:00 UTC) - After market close
  const at1551 = new Date('2026-10-19T08:51:00.000Z');
  assert.equal(guard.getMarketSession(at1551), 'CLOSED');
  assert.equal(guard.isMarketOpen(at1551), false);
  const status1551 = guard.getMarketSessionStatus(at1551);
  assert.equal(status1551.isOpen, false);
  assert.equal(status1551.session, 'CLOSED');
  assert.equal(status1551.broadcast_allowed, false);
});

test('FIX-09: Daytrade intraday producer runs during pre-closing 15:48 WIB via getMarketSessionStatus.isOpen', async () => {
  const at1548 = new Date('2026-10-19T08:48:00.000Z');
  const mockDeps = {
    log: () => {},
    now: at1548,
    env: { CRON_SECRET: 'mock-secret' },
    baseUrl: 'http://127.0.0.1:3000',
    client: {
      call: async () => ({ status: 'published', published_count: 5, success: true })
    },
    buildSnapshot: async () => ({ ok: true, rows: 5 })
  };

  const res = await producer.run({ execute: true, maxBatches: 1 }, mockDeps);
  assert.equal(res.ok, true);
  assert.notEqual(res.reason, 'MARKET_CLOSED', 'Producer should NOT be skipped as MARKET_CLOSED at 15:48 WIB');
});
