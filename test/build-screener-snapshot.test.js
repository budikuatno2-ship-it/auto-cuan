'use strict';

/**
 * Screener snapshot producer contract.
 *
 * `tools/build-screener-snapshot.js` exists because nothing in the repository
 * wrote `data/screener-latest.json`, so the Telegram bot and the AI grounding
 * layer always saw a missing snapshot. These tests pin the properties that make
 * the producer safe:
 *
 *   1. It writes the exact shape the readers expect (`loadScreener`,
 *      `findScreenerRow`).
 *   2. It never invents a row or a score — it only copies what the API served.
 *   3. A failure of one source does not destroy the others.
 *   4. The write is atomic, so a polling reader never sees partial JSON.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const producer = require('../tools/build-screener-snapshot');
const marketContext = require('../lib/market-context-service');

const ROW_KONGLO = {
  ticker: 'BBCA',
  unified_score: 84,
  unified_score_grade: 'A',
  swing_tier: 'SWING_READY',
  entry_low: 8600, entry_high: 8750, stop_loss: 8400, tp1: 9200, tp2: 9600,
  risk_reward: 2.1,
  bandar_label: 'Accumulation',
  bandar_consistent_windows: ['7D', '1M'],
  volume_ratio_20d: 1.8
};
const ROW_NK = { ticker: 'SOCI', unified_score: 34, entry_low: 650, bandar_label: 'Accumulation' };
const ROW_DT = { ticker: 'MKAP', unified_score: 26, entry_low: 1100, bandar_label: 'Accumulation' };

function payload(results, meta) {
  return { success: true, meta: meta || { status: 'published' }, results };
}

test('buildSnapshot maps each API action onto the reader-facing keys', () => {
  const { snapshot, counts } = producer.buildSnapshot({
    screener: payload([ROW_KONGLO]),
    'nk-screener-results': payload([ROW_NK]),
    'daytrade-screener': payload([ROW_DT])
  });

  assert.strictEqual(counts.screener, 1);
  assert.strictEqual(counts['nk-screener-results'], 1);
  assert.strictEqual(counts['daytrade-screener'], 1);

  // The keys the bot's loadScreener() reads.
  assert.deepStrictEqual(snapshot.swing.map(r => r.ticker), ['BBCA']);
  assert.deepStrictEqual(snapshot.daytrade.map(r => r.ticker), ['MKAP']);
  // The Non-Konglo row must be reachable under every alias the readers scan.
  assert.deepStrictEqual(snapshot.swing_non_konglo.map(r => r.ticker), ['SOCI']);
  assert.deepStrictEqual(snapshot.nk.map(r => r.ticker), ['SOCI']);
});

test('the written snapshot is readable by the bot loader shape', () => {
  const { snapshot } = producer.buildSnapshot({
    screener: payload([ROW_KONGLO]),
    'daytrade-screener': payload([ROW_DT])
  });
  // loadScreener() reads data.daytrade / data.swing and data.updated_at.
  assert.ok(Array.isArray(snapshot.swing) && snapshot.swing.length === 1);
  assert.ok(Array.isArray(snapshot.daytrade) && snapshot.daytrade.length === 1);
  assert.ok(typeof snapshot.updated_at === 'string' && snapshot.updated_at.length > 0);
});

test('the written snapshot is readable by the AI grounding layer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  try {
    const { snapshot } = producer.buildSnapshot({
      screener: payload([ROW_KONGLO]),
      'nk-screener-results': payload([ROW_NK])
    });
    const target = producer.snapshotPath(dir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(snapshot));

    // findScreenerRow must locate a row in both buckets.
    assert.strictEqual(marketContext.findScreenerRow(dir, 'BBCA').unified_score, 84);
    assert.strictEqual(marketContext.findScreenerRow(dir, 'SOCI').unified_score, 34);

    // And the full grounding path must emit score + plan + bandar lines.
    const facts = marketContext.extractScreenerFacts(marketContext.findScreenerRow(dir, 'BBCA'));
    const ctx = marketContext.renderContext([{ ticker: 'BBCA', available: true, technical: null, bandar: null, screener: facts }]);
    assert.match(ctx, /SKOR UNIFIED: 84\/100/);
    assert.match(ctx, /RENCANA TRADE:/);
    assert.match(ctx, /STATUS BANDARMOLOGI: Akumulasi/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSnapshot never invents rows or scores', () => {
  const { snapshot, counts } = producer.buildSnapshot({ screener: payload([]) });
  assert.strictEqual(counts.screener, 0);
  assert.strictEqual(snapshot.swing, undefined, 'an empty source must not create an empty bucket');
  assert.strictEqual(snapshot.daytrade, undefined);
});

test('rows without a ticker are dropped rather than written', () => {
  const { snapshot } = producer.buildSnapshot({
    screener: payload([ROW_KONGLO, { unified_score: 99 }, { ticker: '   ' }, null])
  });
  assert.deepStrictEqual(snapshot.swing.map(r => r.ticker), ['BBCA']);
});

test('a failed source does not destroy the sources that succeeded', () => {
  // Only the Konglo payload arrives; the other two are absent (fetch failed).
  const { snapshot, counts } = producer.buildSnapshot({ screener: payload([ROW_KONGLO]) });
  assert.strictEqual(counts['nk-screener-results'], 0);
  assert.strictEqual(counts['daytrade-screener'], 0);
  assert.deepStrictEqual(snapshot.swing.map(r => r.ticker), ['BBCA'],
    'the successful source must still be present');
});

test('extractRows tolerates every response envelope the API uses', () => {
  assert.deepStrictEqual(producer.extractRows({ results: [1] }), [1]);
  assert.deepStrictEqual(producer.extractRows({ rows: [2] }), [2]);
  assert.deepStrictEqual(producer.extractRows({ data: [3] }), [3]);
  assert.deepStrictEqual(producer.extractRows({ success: false, results: [1] }), [],
    'a failed envelope must not be treated as data');
  assert.deepStrictEqual(producer.extractRows(null), []);
  assert.deepStrictEqual(producer.extractRows({}), []);
});

test('main writes the file atomically and leaves no temp file behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  try {
    const responses = {
      screener: payload([ROW_KONGLO]),
      'nk-screener-results': payload([ROW_NK]),
      'daytrade-screener': payload([ROW_DT])
    };
    const fakeFetch = async (url) => {
      const action = new URL(url).searchParams.get('action');
      const body = responses[action];
      if (!body) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };

    const res = await producer.main(
      { dryRun: false, print: false },
      { env: { CRON_SECRET: 'x' }, baseUrl: 'http://127.0.0.1:3000', fetchFn: fakeFetch, log: () => {}, rootDir: dir }
    );

    assert.strictEqual(res.ok, true);
    const target = producer.snapshotPath(dir);
    assert.ok(fs.existsSync(target), 'snapshot must be written');

    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.strictEqual(written.swing.length, 1);
    assert.strictEqual(written.daytrade.length, 1);
    assert.strictEqual(written.swing[0].unified_score, 84);

    const leftovers = fs.readdirSync(path.dirname(target)).filter(f => f.includes('.tmp-'));
    assert.deepStrictEqual(leftovers, [], 'no temp file may survive the atomic rename');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main --dry-run writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  try {
    const fakeFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload([ROW_KONGLO])) });
    const res = await producer.main(
      { dryRun: true, print: false },
      { env: { CRON_SECRET: 'x' }, baseUrl: 'http://127.0.0.1:3000', fetchFn: fakeFetch, log: () => {}, rootDir: dir }
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.dryRun, true);
    assert.ok(!fs.existsSync(producer.snapshotPath(dir)), 'dry-run must not create the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main refuses to run without CRON_SECRET', async () => {
  await assert.rejects(
    () => producer.main({ dryRun: false, print: false }, { env: {}, log: () => {} }),
    /CRON_SECRET is required/
  );
});

test('main reports no_rows and writes nothing when every source is empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  try {
    const fakeFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload([])) });
    const res = await producer.main(
      { dryRun: false, print: false },
      { env: { CRON_SECRET: 'x' }, baseUrl: 'http://127.0.0.1:3000', fetchFn: fakeFetch, log: () => {}, rootDir: dir }
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'no_rows');
    assert.ok(!fs.existsSync(producer.snapshotPath(dir)), 'an empty run must not overwrite a good snapshot');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the produced snapshot round-trips through a real read/write cycle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  try {
    const responses = {
      screener: payload([ROW_KONGLO]),
      'nk-screener-results': payload([ROW_NK]),
      'daytrade-screener': payload([ROW_DT])
    };
    const fakeFetch = async (url) => {
      const action = new URL(url).searchParams.get('action');
      return { ok: true, status: 200, text: async () => JSON.stringify(responses[action] || payload([])) };
    };
    await producer.main({ dryRun: false, print: false },
      { env: { CRON_SECRET: 'x' }, baseUrl: 'http://127.0.0.1:3000', fetchFn: fakeFetch, log: () => {}, rootDir: dir });

    // Simulate the bot's loadScreener().
    const data = JSON.parse(fs.readFileSync(producer.snapshotPath(dir), 'utf8'));
    const loaded = {
      daytrade: data.daytrade || [],
      swing: data.swing || [],
      top5: data.top5 || [],
      updatedAt: data.updated_at || null,
      missing: false
    };
    assert.strictEqual(loaded.missing, false);
    assert.strictEqual(loaded.swing.length, 1);
    assert.strictEqual(loaded.daytrade.length, 1);
    assert.ok(loaded.updatedAt, 'updated_at must survive the round-trip');

    // Every row must still carry the unified score.
    for (const row of [...loaded.swing, ...loaded.daytrade]) {
      assert.ok(row.unified_score != null, row.ticker + ' lost its unified_score');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
