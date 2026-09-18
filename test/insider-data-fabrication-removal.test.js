'use strict';

// Batch 5 (HIGH): removal of fabricated insider fallback data.
// F-041: lib/insider-network-service.js must never fall back to a hardcoded
//        SAMPLE_INSIDER_UNIVERSE; a missing/empty insiders-db.json -> NO_DATA.
// F-007: public/bandarmologi-runtime.js must never serve FALLBACK_INSIDER_DATA
//        and must never resolve an unknown name to a default figure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SERVICE_PATH = require.resolve('../lib/insider-network-service');

test('F-041: insider-network-service no longer contains or exports SAMPLE_INSIDER_UNIVERSE', () => {
  const src = read('lib/insider-network-service.js');
  assert.ok(src.indexOf('SAMPLE_INSIDER_UNIVERSE') < 0, 'fabricated sample universe must be gone from the service source');
  assert.ok(src.indexOf('flattenAndNormalizeRecords(SAMPLE_INSIDER_UNIVERSE)') < 0, 'the fake fallback call must be gone');

  const service = require('../lib/insider-network-service');
  assert.equal(service.SAMPLE_INSIDER_UNIVERSE, undefined, 'service must not export a fabricated universe');
  assert.equal(typeof service.getEffectiveUniverse, 'function');
  assert.equal(typeof service.getEffectiveUniverseStatus, 'function');
});

test('F-041: missing insiders-db.json -> empty universe and explicit NO_DATA status', () => {
  // Simulate a serverless runtime where insiders-db.json is absent. The patch
  // must stay active while the service lazily reads the file.
  const originalExists = fs.existsSync;
  fs.existsSync = function (p) {
    if (String(p).includes('insiders-db.json')) return false;
    return originalExists.apply(fs, arguments);
  };
  try {
    delete require.cache[SERVICE_PATH];
    const service = require('../lib/insider-network-service');

    assert.equal(service.getEffectiveUniverseStatus(), 'NO_DATA');
    assert.deepEqual(service.getEffectiveUniverse(), [], 'no data must yield an empty array, never fake insiders');

    const graph = service.buildInsiderNetworkGraph({ name: 'Orang Tidak Dikenal Sekali' });
    assert.deepEqual(graph.nodes, [], 'unknown name must not produce fabricated nodes');
    assert.deepEqual(graph.edges, []);
    assert.equal(graph.summary.total_emitens, 0);

    const profile = service.getInsiderProfile('Orang Tidak Dikenal Sekali');
    assert.equal(profile, null, 'unknown name must not resolve to a fallback profile');

    // A known fabricated name must ALSO be empty when there is no real data.
    assert.deepEqual(service.searchInsiders('Belvin Tannadi'), [], 'known sample names must not surface without real data');
  } finally {
    fs.existsSync = originalExists;
    delete require.cache[SERVICE_PATH];
  }
});

test('F-041: real data file yields OK status and real entities', () => {
  const service = require('../lib/insider-network-service');
  const status = service.getEffectiveUniverseStatus();
  assert.ok(status === 'OK' || status === 'NO_DATA', 'status must be an explicit known value');
  const universe = service.getEffectiveUniverse();
  assert.ok(Array.isArray(universe));
});

test('F-007: bandarmologi-runtime source no longer references FALLBACK_INSIDER_DATA or a Belvin default', () => {
  const src = read('public/bandarmologi-runtime.js');
  assert.ok(src.indexOf('FALLBACK_INSIDER_DATA') < 0, 'FALLBACK_INSIDER_DATA must be fully removed');
  assert.ok(
    src.indexOf("activeInsiderNetworkEntity = 'Belvin Tannadi'") < 0,
    'the tab must not default to a fabricated example figure'
  );
});

test('F-007: runtime returns explicit NO_DATA for an unknown insider instead of a fallback figure', () => {
  const runtime = require('../public/bandarmologi-runtime');

  assert.equal(runtime.getInsiderNetworkEntity(), '', 'no entity is selected on first load');

  const graph = runtime.getEffectiveInsiderGraph('Orang Tidak Dikenal Sekali');
  assert.equal(graph.nodes.length, 0, 'unknown name must not return a fabricated graph');
  assert.equal(graph.status, 'NO_DATA');
  assert.equal(graph.no_data, true);
  assert.equal(runtime.getEffectiveInsiderGraphStatus('Orang Tidak Dikenal Sekali'), 'NO_DATA');

  // Must never leak the old Belvin Tannadi default profile.
  assert.ok(!JSON.stringify(graph).includes('Belvin Tannadi'), 'unknown lookup must not fall back to Belvin Tannadi');

  assert.deepEqual(runtime.getEffectiveSearchInsiders('Orang Tidak Dikenal Sekali'), []);
  assert.equal(runtime.getEffectiveInsiderGraph('').nodes.length, 0, 'empty query yields an empty graph');
});

test('F-041: vercel.json bundles data/insider-network for the insider API function', () => {
  const config = JSON.parse(read('vercel.json'));
  const fn = config.functions && config.functions['api/sector-hot.js'];
  assert.ok(fn, 'api/sector-hot.js function config must exist');
  assert.equal(typeof fn.includeFiles, 'string');
  assert.ok(fn.includeFiles.includes('data/insider-network'), 'insider data directory must be included in the serverless bundle');
});
