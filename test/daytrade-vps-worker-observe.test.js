'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const worker = require('../tools/daytrade-vps-worker-observe');

function candle(day, close) {
  return {
    time: Math.floor(Date.parse(day + 'T00:00:00Z') / 1000),
    date: day,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1000000
  };
}

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'daytrade-worker-test-'));
}

test('cache read/write stores per-ticker 90D OHLCV JSON', async () => {
  const dir = await tmpdir();
  const candles = Array.from({ length: 95 }, (_, i) => candle('2026-01-' + String((i % 28) + 1).padStart(2, '0'), 100 + i));
  await worker.writeCache(dir, 'BBCA', candles, 'unit-test');
  const read = await worker.readCache(dir, 'BBCA', Date.now());
  assert.equal(read.hit, true);
  assert.equal(read.candles.length, 90);
  assert.equal(read.meta.ticker, 'BBCA');
  assert.equal(read.meta.range, '90d');
});

test('stale cache detection marks old cache stale', async () => {
  const dir = await tmpdir();
  await worker.writeCache(dir, 'BBRI', [candle('2026-07-01', 100)], 'unit-test');
  const read = await worker.readCache(dir, 'BBRI', Date.now() + 48 * 60 * 60 * 1000);
  assert.equal(read.hit, true);
  assert.equal(read.stale, true);
});

test('latest candle merge replaces same day and keeps full ordered array', () => {
  const base = [candle('2026-07-01', 100), candle('2026-07-02', 101), candle('2026-07-03', 102)];
  const latest = [candle('2026-07-03', 110)];
  const merged = worker.mergeLatestCandle(base, latest);
  assert.equal(merged.updated, true);
  assert.equal(merged.candles.length, 3);
  assert.equal(merged.candles[2].close, 110);
});

test('active lock still blocks second worker instance', async () => {
  const dir = await tmpdir();
  const lock = path.join(dir, 'worker.lock');
  const release = await worker.acquireLock(lock);
  assert.equal(typeof release, 'function');
  const second = await worker.acquireLock(lock);
  assert.equal(second, null);
  await release();
});

test('stale lock is cleaned and allows new acquire', async () => {
  const dir = await tmpdir();
  const lock = path.join(dir, 'worker.lock');
  await fs.writeFile(lock, JSON.stringify({
    pid: 99999999,
    started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  }) + '\n');

  const release = await worker.acquireLock(lock, { ttlMs: 30 * 60 * 1000 });
  assert.equal(typeof release, 'function');
  const raw = await fs.readFile(lock, 'utf8');
  const state = JSON.parse(raw);
  assert.equal(state.pid, process.pid);
  await release();
});

test('observe-only guard rejects non-observe and mutation override', () => {
  assert.equal(worker.assertObserveOnly('observe'), true);
  assert.throws(() => worker.assertObserveOnly('write'), /observe-only/);
  const old = process.env.DAYTRADE_WORKER_ALLOW_MUTATION;
  process.env.DAYTRADE_WORKER_ALLOW_MUTATION = 'true';
  assert.throws(() => worker.assertObserveOnly('observe'), /forbidden/);
  if (old === undefined) delete process.env.DAYTRADE_WORKER_ALLOW_MUTATION;
  else process.env.DAYTRADE_WORKER_ALLOW_MUTATION = old;
});
