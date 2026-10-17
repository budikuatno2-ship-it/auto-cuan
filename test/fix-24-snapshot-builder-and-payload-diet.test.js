'use strict';

/**
 * FIX-24: Two defects that both waste the same resource - bytes.
 *
 * (a) tools/build-screener-snapshot.js could only be executed as a CLI: the
 *     snapshot construction logic was locked behind `main()` reading
 *     `process.argv`, so nothing could build a snapshot in-process. The
 *     exporter must expose a pure `buildScreenerSnapshot(payloads, options)`.
 *
 * (b) api/sector-hot.js and api/quote.js returned the SAME row array twice
 *     (`data` and `rows` pointing at one array) and shipped the full
 *     `investors` array on every market-structure row. On a large universe
 *     that doubles the JSON body for no reader benefit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('FIX-24: tools/build-screener-snapshot.js exposes a pure, require-safe builder', () => {
  const src = read('tools/build-screener-snapshot.js');

  // Requiring the module must not build or write anything.
  const mod = require('../tools/build-screener-snapshot.js');
  assert.equal(typeof mod.buildScreenerSnapshot, 'function', 'buildScreenerSnapshot must be exported');
  assert.equal(typeof mod.buildSnapshot, 'function', 'buildSnapshot alias must remain for compatibility');
  assert.equal(typeof mod.main, 'function', 'main must remain exported');

  // The CLI guard must exist so `require()` never triggers a live fetch.
  assert.match(src, /require\.main\s*===\s*module/, 'require.main === module guard must be present');

  // Atomic write contract.
  assert.match(src, /renameSync/, 'snapshot must be written atomically via renameSync');
  assert.match(src, /\.tmp-/, 'atomic write must stage through a .tmp- file');
});

test('FIX-24: buildScreenerSnapshot is pure and derives counts from the payloads', () => {
  const { buildScreenerSnapshot } = require('../tools/build-screener-snapshot.js');

  const payloads = {
    screener: {
      success: true,
      rows: [
        { ticker: 'BBCA', last_price: 9000, unified_score: 88 },
        { ticker: 'bbri', last_price: 4200, unified_score: 81 },
        { not_a_row: true }
      ]
    },
    'nk-screener-results': {
      success: true,
      results: [{ ticker: 'ANTM', last_price: 1500 }]
    },
    'daytrade-screener': { success: true, data: [{ ticker: 'GOTO', last_price: 65 }] },
    'telegram-daily-picks': { success: false, error: 'unavailable' }
  };

  const out = buildScreenerSnapshot(payloads, { updatedAt: '2026-10-16T00:00:00.000Z' });

  assert.equal(typeof out, 'object', 'buildScreenerSnapshot must return an object');
  assert.ok(out.snapshot && typeof out.snapshot === 'object', 'result must carry a snapshot object');
  assert.ok(out.counts && typeof out.counts === 'object', 'result must carry a counts object');

  assert.equal(out.snapshot.updated_at, '2026-10-16T00:00:00.000Z', 'updatedAt option must be honoured');
  assert.equal(out.snapshot.generated_by, 'tools/build-screener-snapshot.js');

  // Row-free payload -> counted as 0 and never placed into the snapshot.
  assert.equal(out.counts['telegram-daily-picks'], 0, 'an unavailable source must count 0');

  // usableRows must drop rows without a ticker.
  assert.equal(out.counts.screener, 2, 'rows without a ticker must not be counted');
  assert.equal(out.counts['nk-screener-results'], 1);
  assert.equal(out.counts['daytrade-screener'], 1);

  assert.equal(out.snapshot.swing.length, 2, 'screener rows land in the swing bucket');
  assert.equal(out.snapshot.swing_non_konglo.length, 1, 'nk rows land in the swing_non_konglo bucket');
  assert.equal(out.snapshot.nk.length, 1, 'nk alias must be written for the AI reader');
  assert.equal(out.snapshot.daytrade.length, 1);
  assert.equal(out.snapshot.top5, undefined, 'a failed optional source must not create a bucket');

  // Purity: calling twice with the same payload must not mutate it.
  const before = JSON.stringify(payloads);
  buildScreenerSnapshot(payloads);
  assert.equal(JSON.stringify(payloads), before, 'buildScreenerSnapshot must not mutate its input');
});

test('FIX-24: api/quote.js and api/sector-hot.js export a shared compact payload diet', () => {
  const quote = require('../api/quote.js');
  const sectorHot = require('../api/sector-hot.js');

  const quoteDiet = (quote.__test && quote.__test.applyCompactPayloadDiet) || quote.applyCompactPayloadDiet;
  const hotDiet = (sectorHot.__test && sectorHot.__test.applyCompactPayloadDiet) || sectorHot.applyCompactPayloadDiet;

  assert.equal(typeof quoteDiet, 'function', 'api/quote.js must export applyCompactPayloadDiet');
  assert.equal(typeof hotDiet, 'function', 'api/sector-hot.js must export applyCompactPayloadDiet');

  const shared = [{ ticker: 'BBCA', investors: Array.from({ length: 40 }, (_, i) => ({ name: 'H' + i })) }];

  // Non-compact callers must be unaffected (backwards compatible).
  const untouched = quoteDiet({ success: true, data: shared, rows: shared }, false);
  assert.ok(Array.isArray(untouched.rows), 'a non-compact payload must keep rows');
  assert.equal(untouched.data[0].investors.length, 40, 'a non-compact payload must keep the full investors array');

  // Compact removes the duplicate alias and trims the heavy inner array.
  const compact = quoteDiet({ success: true, data: shared, rows: shared }, true);
  assert.equal(compact.rows, undefined, 'compact payload must drop the duplicated rows alias');
  assert.ok(Array.isArray(compact.data), 'compact payload must keep data as the single source');
  assert.equal(compact.data[0].investors.length, 10, 'compact payload must trim investors to the head');
  assert.equal(compact.data[0].investors_count_total, 40, 'trimming must disclose the original length');

  // A payload whose aliases are distinct arrays must keep both.
  const distinct = quoteDiet({ success: true, data: [{ ticker: 'A' }], rows: [{ ticker: 'B' }] }, true);
  assert.ok(Array.isArray(distinct.rows), 'distinct data/rows must not be silently dropped');

  // Both modules must implement identical semantics.
  const compactHot = hotDiet({ success: true, data: shared, rows: shared }, true);
  assert.deepEqual(compactHot, compact, 'both APIs must apply the same diet rules');
});

test('FIX-24: the diet is wired into the response paths, not just exported', () => {
  const quoteSrc = read('api/quote.js');
  const hotSrc = read('api/sector-hot.js');

  for (const [name, src] of [['api/quote.js', quoteSrc], ['api/sector-hot.js', hotSrc]]) {
    const calls = src.match(/applyCompactPayloadDiet\s*\(/g) || [];
    assert.ok(calls.length >= 2, `${name} must export AND call applyCompactPayloadDiet (found ${calls.length} occurrences)`);
    assert.match(src, /compact/i, `${name} must honour a compact request flag`);
  }

  // The market-structure list is the surface that ships the investors array.
  assert.match(
    hotSrc,
    /handleMarketStructureList[\s\S]{0,4000}applyCompactPayloadDiet/,
    'handleMarketStructureList must compact its payload before responding'
  );
});
