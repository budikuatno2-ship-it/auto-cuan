'use strict';

/**
 * test/v5/intel-no-synthetic.test.js
 * ============================================================================
 * F5 regression: /api/intel must never publish a synthetic market fact.
 * ============================================================================
 * Guards the same P0-001 / P0-011 contract the other publish paths obey:
 *   - api/intel.js must not hardcode the documented synthetic constants
 *     (last_price 1550/1420/380, fabricated CR3/net-buy/score) as a market fact;
 *   - the served payload must trace to the real `bandarmologi-intel-service`
 *     authority, which reads the on-disk index (never a fabricated replacement).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const INTEL_SRC = path.join(ROOT, 'api', 'intel.js');

function readIntelSource() {
  return fs.readFileSync(INTEL_SRC, 'utf8');
}

function codeLines(src) {
  return String(src || '').split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (t.startsWith('//')) return false;
    if (t.startsWith('/*')) return false;
    if (/^\*\s?/.test(t) || /^\*\/$/.test(t)) return false;
    return true;
  }).join('\n');
}

test('api/intel.js no longer hardcodes the synthetic price constants as market facts', () => {
  const src = codeLines(readIntelSource());
  // The old fabricated rows were `last_price: 1550|380|1420|1050` on the
  // DSNG/BULL/PANI/BRPT/MEDC anomalies. A literal `last_price: <constant>` in
  // executable code is the fingerprint of fabrication; explanatory prose must
  // not trip it, so comments are stripped before matching.
  const fabricated = /\blast_price:\s*(1550|380|1420|1050)\b/.test(src);
  assert.equal(fabricated, false, 'api/intel.js still carries a hardcoded synthetic last_price');

  const hardBroker = /\bnet_buy_idr:\s*(142500000000|68200000000|85300000000|34100000000|28400000000)\b/.test(src);
  assert.equal(hardBroker, false, 'api/intel.js still carries a hardcoded synthetic broker net_buy_idr');
});

test('api/intel.js delegates to the real bandarmologi-intel authority (no parallel dataset)', () => {
  const src = readIntelSource();
  assert.match(src, /bandarmologi-intel-service/);
  assert.match(src, /getBandarmologiIntel/);
  assert.doesNotMatch(src, /volume_anomalies\s*=\s*\[/);
  assert.doesNotMatch(src, /broker_surges\s*=\s*\[/);
  assert.doesNotMatch(src, /lpm_rsi_divergences\s*=\s*\[/);
});

test('the bandarmologi intel authority serves a real index with no synthetic constant for known fabricated tickers', () => {
  const service = require(path.join(ROOT, 'lib', 'bandarmologi-intel-service.js'));
  const index = require(path.join(ROOT, 'data', 'bandarmologi-intel-indexes', 'latest.json'));

  const syntheticPrices = new Set([1550, 1420, 380, 1050]);
  const fabricatedTickers = new Set(['DSNG', 'BULL', 'PANI']);

  const picked = [];
  const rowsIn = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.ticker && fabricatedTickers.has(String(obj.ticker).toUpperCase())) {
      picked.push(obj);
    }
  };
  for (const cat of Object.keys(index.indexes || {})) {
    const list = index.indexes[cat];
    if (Array.isArray(list)) for (const r of list) rowsIn(r);
  }
  for (const t of Object.keys(index.tickers || {})) rowsIn(index.tickers[t]);

  // The index must not have resurrected the fabricated price for those tickers.
  for (const row of picked) {
    const lp = Number(row.current_price != null ? row.current_price : row.last_price);
    if (Number.isFinite(lp) && syntheticPrices.has(lp)) {
      assert.fail('intel index publishes synthetic price ' + lp + ' for ' + row.ticker);
    }
  }
  assert.ok(true, 'no synthetic constant found for fabricated tickers in the served intel index');
});