'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const flow = require('../lib/bandarmologi-flow');
const cache = require('../lib/bandarmologi-cache');

function tmpBroker() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-bandar-'));
}

function writeDay(root, ticker, date, brokers) {
  const dir = path.join(root, ticker);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, date + '.json'), JSON.stringify({ stock_code: ticker, brokers }));
}

test('toNumber parses id-ID and en-US grouped magnitudes without NaN', () => {
  assert.equal(flow.toNumber('1.500.000.000'), 1500000000);
  assert.equal(flow.toNumber('1,500,000,000'), 1500000000);
  assert.equal(flow.toNumber('1500,25'), 1500.25);
  assert.equal(flow.toNumber('(2.000)'), -2000);
  assert.equal(flow.toNumber('n/a'), 0);
  assert.equal(flow.toNumber(null), 0);
});

test('foreign classification uses the canonical broker whitelist and honors investor_type', () => {
  const rows = flow.parseBrokerRows({
    brokers: [
      { broker_code: 'BK', bval: 100, sval: 0, nval: 100 },
      { broker_code: 'YP', bval: 0, sval: 50, nval: -50 },
      { broker_code: 'ZZ', bval: 10, sval: 0, nval: 10, investor_type: 'foreign' }
    ]
  });
  const bk = rows.find((r) => r.code === 'BK');
  const zz = rows.find((r) => r.code === 'ZZ');
  assert.equal(bk.foreign, false); // code-based, not flagged per-row
  assert.equal(flow.isForeignBroker('BK'), true);
  assert.equal(flow.isForeignBroker('YU'), true);
  assert.equal(flow.isForeignBroker('YP'), false);
  assert.equal(zz.foreign, true);
});

test('nval falls back to bval - sval when the feed omits it', () => {
  const rows = flow.parseBrokerRows([
    { broker_code: 'BK', bval: 300, sval: 100 }
  ]);
  assert.equal(rows[0].nval, 200);
});

test('computeConcentration returns CR3/CR5 as a share of the same side total', () => {
  const rows = flow.parseBrokerRows([
    { broker_code: 'A1', bval: 50, sval: 0 },
    { broker_code: 'A2', bval: 30, sval: 0 },
    { broker_code: 'A3', bval: 10, sval: 0 },
    { broker_code: 'A4', bval: 6, sval: 0 },
    { broker_code: 'A5', bval: 2, sval: 0 },
    { broker_code: 'A6', bval: 2, sval: 0 }
  ]);
  const conc = flow.computeConcentration(rows, 'bval');
  assert.equal(conc.total, 100);
  assert.equal(Math.round(conc.cr3), 90);
  assert.equal(Math.round(conc.cr5), 98);
  assert.equal(conc.cr3 <= 100 && conc.cr5 <= 100, true);
});

test('summarizeBandarDay computes retail and foreign net plus avg buy price', () => {
  const rows = flow.parseBrokerRows([
    { broker_code: 'BK', bval: 1000, bvol: 100, sval: 0, nval: 1000 },
    { broker_code: 'YP', bval: 0, sval: 400, nval: -400 }
  ]);
  const summary = flow.summarizeBandarDay(rows);
  assert.equal(summary.foreignNet, 1000);
  assert.equal(summary.retailNet, -400);
  assert.equal(summary.topBuyers[0].avgBuyPrice, 10);
});

test('aggregateUniverseFlow sums foreign net across the window', () => {
  const root = tmpBroker();
  writeDay(root, 'BBCA', '2026-09-23', [{ broker_code: 'BK', bval: 100, sval: 0, nval: 100 }]);
  writeDay(root, 'BBCA', '2026-09-24', [{ broker_code: 'BK', bval: 250, sval: 0, nval: 250 }]);
  writeDay(root, 'BBRI', '2026-09-24', [{ broker_code: 'BK', bval: -50, sval: 0, nval: -50 }]);
  const rows = flow.aggregateUniverseFlow(root, 'foreign', 5, null, ['BBCA', 'BBRI']);
  const bbca = rows.find((r) => r.ticker === 'BBCA');
  assert.equal(bbca.net, 350);
  assert.equal(bbca.sessions, 2);
});

test('bandarForTickerWindow aggregates per broker before CR3/CR5', () => {
  const root = tmpBroker();
  writeDay(root, 'BBCA', '2026-09-23', [
    { broker_code: 'BK', bval: 100, sval: 0, nval: 100 },
    { broker_code: 'YP', bval: 10, sval: 0, nval: 10 }
  ]);
  writeDay(root, 'BBCA', '2026-09-24', [
    { broker_code: 'BK', bval: 200, sval: 0, nval: 200 },
    { broker_code: 'YP', bval: 20, sval: 0, nval: 20 }
  ]);
  const window = flow.bandarForTickerWindow(root, 'BBCA', 5, null);
  assert.equal(window.sessions, 2);
  assert.equal(window.summary.turnover, 330);
});

test('cache anchor only advances to today after 19:00 WIB', () => {
  const dates = ['2026-09-23', '2026-09-24', '2026-09-25'];
  const before = cache.resolveAnchorDate(dates, new Date('2026-09-25T10:00:00Z')); // 17:00 WIB
  const after = cache.resolveAnchorDate(dates, new Date('2026-09-25T13:00:00Z'));  // 20:00 WIB
  assert.equal(before, '2026-09-24');
  assert.equal(after, '2026-09-25');
});

test('cache payload is bounded and recomputes on demand', () => {
  const root = tmpBroker();
  writeDay(root, 'BBCA', '2026-09-24', [{ broker_code: 'BK', bval: 100, sval: 0, nval: 100 }]);
  const payload = cache.buildCache(root, new Date('2026-09-24T13:00:00Z'));
  assert.equal(payload.version, cache.CACHE_VERSION);
  assert.ok(payload.foreign['1'].length >= 1);
  assert.ok(payload.foreign['1'].length <= cache.MAX_TICKERS_PER_WINDOW);
});

test('pruneCacheByDate drops dated rows older than the min date', () => {
  const payload = { foreign: { 1: [{ ticker: 'A', date: '2026-09-01' }, { ticker: 'B', date: '2026-09-24' }] }, ritel: { 1: [] } };
  const pruned = cache.pruneCacheByDate(payload, '2026-09-20');
  assert.deepEqual(pruned.foreign['1'].map((r) => r.ticker), ['B']);
});
