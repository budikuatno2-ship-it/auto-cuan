'use strict';
/**
 * test/v5/ranking-integrity.test.js
 * ============================================================================
 * R2 REVIEW REMEDIATION — ranking fabrication removal integrity tests
 * ============================================================================
 * Proves api/ranking.js contains no fabricated fallbacks or GRPM block and that
 * absent fields are null (never invented), known zeros survive, and rows trace
 * to data/foreign-flow-multi-day.json.
 * Run: node test/v5/ranking-integrity.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true, error: null }); }
  catch (err) { results.push({ name, ok: false, error: err }); }
}
async function testAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true, error: null }); }
  catch (err) { results.push({ name, ok: false, error: err }); }
}
function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

const ROOT = path.resolve(__dirname, '..', '..');
const RANKING_SRC = fs.readFileSync(path.join(ROOT, 'api', 'ranking.js'), 'utf8');

test('source: GRPM hardcoded foreign-flow block is deleted', () => {
  assert(!/GRPM/.test(RANKING_SRC), 'literal "GRPM" must not appear');
  assert(!/144776632/.test(RANKING_SRC), 'fabricated fToday 144776632 must be gone');
  assert(!/376419243/.test(RANKING_SRC), 'fabricated f3d 376419243 must be gone');
  assert(!/851286596/.test(RANKING_SRC), 'fabricated f7d 851286596 must be gone');
});

test('source: no invented foreign-flow derivation (p*v*0.18, x2.5, x4.2)', () => {
  assert(!/0\.18/.test(RANKING_SRC), 'p*v*0.18 derivation must be gone');
  assert(!/\*\s*2\.5/.test(RANKING_SRC), '×2.5 derivation must be gone');
  assert(!/\*\s*4\.2/.test(RANKING_SRC), '×4.2 derivation must be gone');
});

test('source: no indexed fallback arrays (rsi/dist/vol fabrication)', () => {
  assert(!/rsiFallback/.test(RANKING_SRC), 'rsiFallback array must be gone');
  assert(!/distFallback/.test(RANKING_SRC), 'distFallback array must be gone');
  assert(!/volFallback/.test(RANKING_SRC), 'volFallback array must be gone');
  assert(!/48\.2,\s*55\.4/.test(RANKING_SRC), 'fabricated RSI values must be gone');
});

const sandboxes = [];
function loadSandbox(sourcePayload) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ranking-'));
  const sandboxApi = path.join(sandbox, 'api');
  const sandboxData = path.join(sandbox, 'data');
  fs.mkdirSync(sandboxApi, { recursive: true });
  fs.mkdirSync(sandboxData, { recursive: true });
  fs.writeFileSync(path.join(sandboxApi, 'ranking.js'),
    fs.readFileSync(path.join(ROOT, 'api', 'ranking.js'), 'utf8').replace(
      "require('../lib/market-data-contract')",
      "require('" + path.join(ROOT, 'lib', 'market-data-contract.js').replace(/\\/g, '\\\\') + "')"
    ));
  fs.writeFileSync(path.join(sandboxData, 'foreign-flow-multi-day.json'), sourcePayload);
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(sandbox) === 0) delete require.cache[k];
  }
  const handler = require(path.join(sandboxApi, 'ranking.js'));
  sandboxes.push(sandbox);
  return async function run() {
    return await handler(undefined, undefined);
  };
}

const REAL_SOURCE = JSON.stringify({
  as_of: '2026-10-30',
  generated_at: '2026-10-30T16:00:00.000Z',
  count: 4,
  data: {
    AADI: { ticker: 'AADI', last_price: 10425, volume_today: 15197700, foreign_net_today: 36440285175, foreign_net_3d: 94744741455, foreign_net_7d: 214268876829 },
    GRPM: { ticker: 'GRPM', last_price: 120, volume_today: 0, foreign_net_today: 0, foreign_net_3d: 0, foreign_net_7d: 0 },
    XXX_UNKNOWN: { ticker: 'XXX_UNKNOWN', last_price: 500, volume_today: 1000 },
    NO_RECORD_IS_PRESENT: null
  }
});

(async () => {
  const runSandbox = loadSandbox(REAL_SOURCE);
  const data = await runSandbox();

  test('runtime: fabricated free-float 35.0 fallback and change_pct are gone', () => {
    assert(data.rows.every(r => r.free_float_pct === null), 'free_float_pct must be null, not 35.0');
    assert(data.rows.every(r => r.change_pct === null), 'change_pct must be null, not derived');
  });

  test('runtime: known zero foreign flow survives (GRPM stays 0, not null)', () => {
    const grpm = data.rows.find(r => r.ticker === 'GRPM');
    assert(grpm, 'GRPM row exists');
    assert(grpm.foreign_net_today === 0, 'known 0 must survive: ' + JSON.stringify(grpm.foreign_net_today));
    assert(grpm.volume_today === 0, 'known 0 volume must survive');
  });

  test('runtime: absent foreign fields are null, not invented', () => {
    const unknown = data.rows.find(r => r.ticker === 'XXX_UNKNOWN');
    assert(unknown, 'row exists for record with absent foreign fields');
    assert(unknown.foreign_net_today === null, 'absent foreign_net_today is null');
    assert(unknown.foreign_net_3d === null, 'absent foreign_net_3d is null');
    assert(unknown.foreign_net_7d === null, 'absent foreign_net_7d is null');
    assert(unknown.data_status === 'PARTIAL', 'partially populated record is PARTIAL, got ' + unknown.data_status);

    for (const r of data.rows) {
      assert(r.rsi_14 === null, r.ticker + ': rsi_14 null');
      assert(r.week52_high_dist_pct === null, r.ticker + ': week52_high_dist_pct null');
      assert(r.volume_ratio_vs_7d_avg === null, r.ticker + ': volume_ratio_vs_7d_avg null');
      assert(r.company_name === null, r.ticker + ': company_name null');
      assert(r.free_float_pct === null, r.ticker + ': free_float_pct null');
    }
  });

  test('runtime: null record -> NOT_PUBLISHED, not an invented row', () => {
    const ghost = data.rows.find(r => r.ticker === 'NO_RECORD_IS_PRESENT');
    assert(ghost, 'row exists for null source record');
    assert(ghost.data_status === 'NOT_PUBLISHED', 'null record -> NOT_PUBLISHED, got ' + ghost.data_status);
    assert(ghost.last_price === null, 'null record -> last_price null');
  });

  test('runtime: as_of trade date comes from the real source, never hardcoded', () => {
    assert(data.as_of === '2026-10-30', 'as_of traced from source, got ' + data.as_of);
    assert(data.rows[0].as_of_trade_date === '2026-10-30', 'row as_of_trade_date traced');
  });

  await testAsync('runtime: unreadable source -> SOURCE_UNAVAILABLE; empty source -> NOT_PUBLISHED', async () => {
    const dEmpty = await loadSandbox(JSON.stringify({ as_of: null, data: {} }))();
    assert(dEmpty.success === true, 'backward-compatible shape kept');
    assert(Array.isArray(dEmpty.rows) && dEmpty.rows.length === 0, 'no rows invented from empty source');
    assert(dEmpty.data_status === 'NOT_PUBLISHED', 'empty map -> NOT_PUBLISHED, got ' + dEmpty.data_status);

    const dCorrupt = await loadSandbox('{not valid json')();
    assert(dCorrupt.success === true, 'shape kept even when the source is corrupt');
    assert(Array.isArray(dCorrupt.rows) && dCorrupt.rows.length === 0, 'no rows invented from unreadable source');
    assert(dCorrupt.data_status === 'SOURCE_UNAVAILABLE', 'corrupt file -> SOURCE_UNAVAILABLE, got ' + dCorrupt.data_status);
  });

  test('runtime: backward-compatible response shape (universe/data/rows aliases)', () => {
    assert(data.universe === data.rows && data.data === data.rows, 'universe/data aliases kept');
    assert(typeof data.count === 'number', 'count kept');
    assert(data.success === true, 'success kept');
  });

  report();
})().catch((err) => {
  results.push({ name: 'main async runner', ok: false, error: err });
  report();
});

function report() {
  for (const sb of sandboxes) { try { fs.rmSync(sb, { recursive: true, force: true }); } catch (_) {} }
  let failed = 0;
  process.stdout.write('ranking-integrity test suite (R2 remediation)\n');
  process.stdout.write('===========================================\n');
  for (const r of results) {
    process.stdout.write((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '  -> ' + (r.error && r.error.message)) + '\n');
    if (!r.ok) failed += 1;
  }
  process.stdout.write('\n' + (results.length - failed) + '/' + results.length + ' passed\n');
  if (failed > 0) process.exit(1);
  process.exit(0);
}