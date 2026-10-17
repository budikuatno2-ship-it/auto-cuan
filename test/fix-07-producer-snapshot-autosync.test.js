'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const producer = require('../tools/run-daytrade-intraday-producer.js');
const snapshotBuilder = require('../tools/build-screener-snapshot.js');

test('FIX-07: build-screener-snapshot exports required functions', () => {
  assert.equal(typeof snapshotBuilder.main, 'function', 'snapshotBuilder.main must be exported');
  assert.equal(typeof snapshotBuilder.buildSnapshot, 'function', 'snapshotBuilder.buildSnapshot must be exported');
  assert.equal(typeof snapshotBuilder.snapshotPath, 'function', 'snapshotBuilder.snapshotPath must be exported');
});

test('FIX-07: run-daytrade-intraday-producer auto-syncs snapshot when MARKET_CLOSED and file is missing', async () => {
  let snapshotBuilt = false;
  const mockDeps = {
    log: () => {},
    now: new Date('2026-10-16T17:00:00Z'), // Outside market hours
    getMarketSessionStatus: () => ({ isOpen: false, session: 'CLOSED', reason: 'after_market' }),
    fs: {
      existsSync: () => false // Snapshot file missing
    },
    buildSnapshot: async () => {
      snapshotBuilt = true;
      return { ok: true, rows: 10 };
    },
    env: { CRON_SECRET: 'mock-secret' },
    baseUrl: 'http://127.0.0.1:3000'
  };

  const res = await producer.run({ execute: true }, mockDeps);
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'MARKET_CLOSED');
  assert.equal(snapshotBuilt, true, 'Must auto-sync snapshot when market closed and file is missing');
});

test('FIX-07: run-daytrade-intraday-producer auto-syncs snapshot when --sync-snapshot is provided even if file exists', async () => {
  let snapshotBuilt = false;
  const mockDeps = {
    log: () => {},
    now: new Date('2026-10-16T17:00:00Z'),
    getMarketSessionStatus: () => ({ isOpen: false, session: 'CLOSED', reason: 'after_market' }),
    fs: {
      existsSync: () => true // Snapshot file exists
    },
    buildSnapshot: async () => {
      snapshotBuilt = true;
      return { ok: true, rows: 10 };
    },
    env: { CRON_SECRET: 'mock-secret' },
    baseUrl: 'http://127.0.0.1:3000'
  };

  const res = await producer.run({ execute: true, syncSnapshot: true }, mockDeps);
  assert.equal(res.ok, true);
  assert.equal(snapshotBuilt, true, 'Must sync snapshot when syncSnapshot flag is true');
});
