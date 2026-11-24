'use strict';

/**
 * test/v6/insider-network-filters.test.js
 * ============================================================================
 * V6 (W2a / Feature 13D) — Insider numeric threshold filters + edge provenance.
 *
 * Covers:
 *   (a) min_pct=1 returns only edges with pct > 1
 *   (b) min_pct=5 likewise
 *   (c) custom threshold
 *   (d) every returned edge has source + as_of keys (may be UNKNOWN/null)
 *   (e) no fabricated relations when data missing (empty + reason)
 *   (f) the hard-coded roster is not served as live data
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const svc = require(path.join(ROOT, 'lib', 'insider-network-service.js'));

// A controlled universe with a spread of percentages and dates.
const UNIVERSE = [
  { ticker: 'AAAA', insider_name: 'Alpha Holder', action_type: 'BUY', shares_after: 1000000, pct_after: '0.5%', date: '2026-09-01' },
  { ticker: 'BBBB', insider_name: 'Alpha Holder', action_type: 'BUY', shares_after: 2000000, pct_after: '1.5%', date: '2026-09-02' },
  { ticker: 'CCCC', insider_name: 'Alpha Holder', action_type: 'BUY', shares_after: 3000000, pct_after: '5.5%', date: '2026-09-03' },
  { ticker: 'DDDD', insider_name: 'Alpha Holder', action_type: 'BUY', shares_after: 4000000, pct_after: '10.0%', date: '2026-09-04' },
  // A holding with NO date -> provenance must be UNKNOWN/null.
  { ticker: 'EEEE', insider_name: 'Alpha Holder', action_type: 'BUY', shares_after: 5000000, pct_after: '2.0%' }
];

function graph(minPct) {
  return svc.buildInsiderNetworkGraph({ name: 'Alpha Holder', records: UNIVERSE, minPct });
}

test('13D-(a): min_pct=1 returns only edges with percentage > 1', () => {
  const g = graph(1);
  assert.ok(g.edges.length > 0);
  for (const e of g.edges) {
    assert.ok(Number(e.percentage) > 1, `edge ${e.ticker} pct ${e.percentage} must be > 1`);
  }
  const tickers = g.edges.map((e) => e.ticker).sort();
  assert.deepEqual(tickers, ['BBBB', 'CCCC', 'DDDD', 'EEEE']);
});

test('13D-(b): min_pct=5 returns only edges with percentage > 5', () => {
  const g = graph(5);
  for (const e of g.edges) {
    assert.ok(Number(e.percentage) > 5, `edge ${e.ticker} pct ${e.percentage} must be > 5`);
  }
  const tickers = g.edges.map((e) => e.ticker).sort();
  assert.deepEqual(tickers, ['CCCC', 'DDDD']);
});

test('13D-(c): custom threshold (min_pct=2) filters correctly', () => {
  const g = graph(2);
  for (const e of g.edges) {
    assert.ok(Number(e.percentage) > 2, `edge ${e.ticker} pct ${e.percentage} must be > 2`);
  }
  // EEEE is exactly 2.0% -> NOT > 2, so it is excluded (strict predicate).
  const tickers = g.edges.map((e) => e.ticker).sort();
  assert.deepEqual(tickers, ['CCCC', 'DDDD']);
});

test('13D-(d): every returned edge has data_source + as_of keys', () => {
  const g = graph(null); // no threshold -> all edges
  assert.ok(g.edges.length > 0);
  for (const e of g.edges) {
    // `source` remains the source NODE id (D3 semantics); provenance lives on
    // `data_source` + `as_of`, both always present as keys.
    assert.ok(Object.prototype.hasOwnProperty.call(e, 'data_source'), 'edge has data_source key');
    assert.ok(Object.prototype.hasOwnProperty.call(e, 'as_of'), 'edge has as_of key');
  }
  // The dated edges carry the real data source + date.
  const bbbb = g.edges.find((e) => e.ticker === 'BBBB');
  assert.equal(bbbb.data_source, 'insiders-db.json');
  assert.equal(bbbb.as_of, '2026-09-02');
  // The undated edge is UNKNOWN/null — never a fabricated date.
  const eeee = g.edges.find((e) => e.ticker === 'EEEE');
  assert.equal(eeee.data_source, 'UNKNOWN');
  assert.equal(eeee.as_of, null);
});

test('13D-(e): no fabricated relations when data is missing (empty + reason)', () => {
  const g = svc.buildInsiderNetworkGraph({ name: 'Nonexistent Person', records: [] });
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
  assert.equal(g.summary.node_count, 0);
  assert.equal(g.summary.edge_count, 0);
});

test('13D-(f): the hard-coded DEFAULT_BBCA_ROSTER is not served as live data', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'bandarmologi-runtime.js'), 'utf8');
  // The literal must no longer be seeded into the live cache.
  assert.ok(!/vpsInsiderRosterCache\s*=\s*\{\s*BBCA:\s*DEFAULT_BBCA_ROSTER\s*\}/.test(src),
    'cache must not be seeded with the hard-coded roster');
  assert.ok(!/var DEFAULT_BBCA_ROSTER\s*=\s*\[/.test(src),
    'the hard-coded DEFAULT_BBCA_ROSTER literal must be removed from the runtime');
  // An explicit DATA_UNAVAILABLE empty state must exist instead.
  assert.ok(/DATA_UNAVAILABLE/.test(src), 'explicit DATA_UNAVAILABLE state present');
  assert.ok(/function renderRosterUnavailable/.test(src), 'renderRosterUnavailable helper present');
});
