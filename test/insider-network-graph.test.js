'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const insiderNetworkService = require('../lib/insider-network-service');
const bandarmologiService = require('../lib/bandarmologi-service');

const MOCK_MULTI_EMITEN_DATA = [
  {
    ticker: 'BUMI',
    date: '2026-09-04',
    insider_name: 'Belvin Tannadi',
    position: 'Pemegang Saham >5%',
    action_type: 'BUY',
    broker: 'YP',
    price: 142,
    shares_change: 25000000,
    pct_change: '+0.15%',
    shares_after: 850000000,
    shares_after_percentage: '2.45%',
    nationality: 'local'
  },
  {
    ticker: 'BUMI',
    date: '2026-08-20',
    insider_name: 'Belvin Tannadi',
    position: 'Pemegang Saham >5%',
    action_type: 'BUY',
    broker: 'YP',
    price: 130,
    shares_change: 20000000,
    pct_change: '+0.12%',
    shares_after: 825000000,
    shares_after_percentage: '2.30%',
    nationality: 'local'
  },
  {
    ticker: 'BRMS',
    date: '2026-08-28',
    insider_name: 'Belvin Tannadi',
    position: 'Pemegang Saham >5%',
    action_type: 'BUY',
    broker: 'XL',
    price: 195,
    shares_change: 15000000,
    pct_change: '+0.10%',
    shares_after: 420000000,
    shares_after_percentage: '1.80%',
    nationality: 'local'
  },
  {
    ticker: 'DEWA',
    date: '2026-08-15',
    insider_name: 'Belvin Tannadi',
    position: 'Investor Strategis',
    action_type: 'BUY',
    broker: 'YP',
    price: 78,
    shares_change: 10000000,
    pct_change: '+0.08%',
    shares_after: 180000000,
    shares_after_percentage: '1.15%',
    nationality: 'local'
  },
  {
    ticker: 'BREN',
    date: '2026-09-02',
    insider_name: 'Prajogo Pangestu',
    position: 'Pengendali & Komisaris Utama',
    action_type: 'BUY',
    broker: 'CC',
    price: 8900,
    shares_change: 5000000,
    pct_change: '+0.03%',
    shares_after: 5800000000,
    shares_after_percentage: '43.20%',
    nationality: 'local'
  },
  {
    ticker: 'BRPT',
    date: '2026-08-20',
    insider_name: 'Prajogo Pangestu',
    position: 'Pengendali & Direktur Utama',
    action_type: 'BUY',
    broker: 'CC',
    price: 1150,
    shares_change: 12000000,
    pct_change: '+0.05%',
    shares_after: 66500000000,
    shares_after_percentage: '71.18%',
    nationality: 'local'
  }
];

test('FASE 2: aggregateInsiderHoldings aggregates multi-emiten ownership per person/entity', () => {
  const aggregated = insiderNetworkService.aggregateInsiderHoldings(MOCK_MULTI_EMITEN_DATA);
  assert.equal(aggregated.length, 2);

  // Belvin Tannadi
  const belvin = aggregated.find(e => e.canonical_name === 'belvin tannadi');
  assert.ok(belvin, 'Belvin Tannadi should be present in aggregated entities');
  assert.equal(belvin.total_emitens, 3);
  // Total shares = BUMI (850M) + BRMS (420M) + DEWA (180M) = 1,450,000,000
  assert.equal(belvin.total_shares, 1450000000);
  assert.equal(belvin.nationality, 'local');
  assert.deepEqual(belvin.brokers.sort(), ['XL', 'YP']);
  assert.equal(belvin.transactions_count, 4);

  // Verify BUMI holding has multi-transaction consolidation
  const bumiHolding = belvin.holdings.find(h => h.ticker === 'BUMI');
  assert.ok(bumiHolding);
  assert.equal(bumiHolding.shares, 850000000);
  assert.equal(bumiHolding.percentage, 2.45);
  assert.equal(bumiHolding.percentage_raw, '2.45%');
  assert.equal(bumiHolding.latest_date, '2026-09-04');
  assert.equal(bumiHolding.transactions_count, 2);
  assert.equal(bumiHolding.total_bought, 45000000);

  // Prajogo Pangestu
  const prajogo = aggregated.find(e => e.canonical_name === 'prajogo pangestu');
  assert.ok(prajogo);
  assert.equal(prajogo.total_emitens, 2);
  assert.equal(prajogo.total_shares, 72300000000);
});

test('FASE 2: buildInsiderNetworkGraph generates central insider node with connected tickers and edges', () => {
  const graph = insiderNetworkService.buildInsiderNetworkGraph({
    name: 'Belvin Tannadi',
    records: MOCK_MULTI_EMITEN_DATA
  });

  assert.equal(graph.nodes.length, 4, 'Should contain 1 central insider node + 3 ticker nodes');
  assert.equal(graph.edges.length, 3, 'Should contain 3 connection edges');
  assert.equal(graph.links.length, 3, 'links should be an alias of edges for D3/ForceGraph compatibility');

  // Central Node
  const centralNode = graph.nodes.find(n => n.type === 'insider');
  assert.equal(centralNode.id, 'insider:belvin_tannadi');
  assert.equal(centralNode.label, 'Belvin Tannadi');
  assert.equal(centralNode.is_central, true);
  assert.equal(centralNode.total_emitens, 3);
  assert.equal(centralNode.total_shares, 1450000000);

  // Ticker Nodes
  const tickerNodes = graph.nodes.filter(n => n.type === 'ticker').map(n => n.ticker).sort();
  assert.deepEqual(tickerNodes, ['BRMS', 'BUMI', 'DEWA']);

  // Edges validation
  const bumiEdge = graph.edges.find(e => e.ticker === 'BUMI');
  assert.ok(bumiEdge);
  assert.equal(bumiEdge.source, 'insider:belvin_tannadi');
  assert.equal(bumiEdge.target, 'ticker:BUMI');
  assert.equal(bumiEdge.shares, 850000000);
  assert.equal(bumiEdge.percentage, 2.45);
  assert.equal(bumiEdge.latest_action, 'BUY');
  assert.equal(bumiEdge.latest_price, 142);
  assert.deepEqual(bumiEdge.brokers, ['YP']);

  // Summary object
  assert.equal(graph.summary.entity_name, 'Belvin Tannadi');
  assert.equal(graph.summary.total_emitens, 3);
  assert.equal(graph.summary.total_shares, 1450000000);
  assert.equal(graph.summary.node_count, 4);
  assert.equal(graph.summary.edge_count, 3);
});

test('FASE 2: buildInsiderNetworkGraph supports querying by ticker', () => {
  const graph = insiderNetworkService.buildInsiderNetworkGraph({
    ticker: 'BUMI',
    records: MOCK_MULTI_EMITEN_DATA
  });

  assert.equal(graph.nodes.length, 2, 'Should have 1 ticker node + 1 insider node');
  assert.equal(graph.edges.length, 1);

  const tickerNode = graph.nodes.find(n => n.id === 'ticker:BUMI');
  assert.ok(tickerNode);
  assert.equal(tickerNode.is_central, true);

  const insiderNode = graph.nodes.find(n => n.id === 'insider:belvin_tannadi');
  assert.ok(insiderNode);

  assert.equal(graph.edges[0].source, 'insider:belvin_tannadi');
  assert.equal(graph.edges[0].target, 'ticker:BUMI');
});

test('FASE 2: searchInsiders provides instant autocomplete with prefix, fuzzy, and ranking', () => {
  // 1. Prefix match
  const matchPrefix = insiderNetworkService.searchInsiders('Belv', { records: MOCK_MULTI_EMITEN_DATA });
  assert.ok(matchPrefix.length >= 1);
  assert.equal(matchPrefix[0].name, 'Belvin Tannadi');
  assert.deepEqual(matchPrefix[0].tickers.sort(), ['BRMS', 'BUMI', 'DEWA']);

  // 2. Word boundary match
  const matchLast = insiderNetworkService.searchInsiders('Tannadi', { records: MOCK_MULTI_EMITEN_DATA });
  assert.equal(matchLast[0].name, 'Belvin Tannadi');

  // 3. Case-insensitivity
  const matchCase = insiderNetworkService.searchInsiders('pRaJoGo', { records: MOCK_MULTI_EMITEN_DATA });
  assert.equal(matchCase[0].name, 'Prajogo Pangestu');

  // 4. Limit parameter
  const matchLimit = insiderNetworkService.searchInsiders('', { records: MOCK_MULTI_EMITEN_DATA, limit: 1 });
  assert.equal(matchLimit.length, 1);
  // Belvin has 3 emitens, Prajogo has 2, so Belvin is first
  assert.equal(matchLimit[0].name, 'Belvin Tannadi');
});

test('FASE 2: getInsiderProfile returns full profile and nested graph', () => {
  const profile = insiderNetworkService.getInsiderProfile('Belvin', { records: MOCK_MULTI_EMITEN_DATA });
  assert.ok(profile);
  assert.equal(profile.name, 'Belvin Tannadi');
  assert.equal(profile.total_emitens, 3);
  assert.equal(profile.holdings.length, 3);
  assert.ok(profile.graph);
  assert.equal(profile.graph.nodes.length, 4);
  assert.equal(profile.graph.edges.length, 3);

  // Unknown person returns null
  const nullProfile = insiderNetworkService.getInsiderProfile('Orang Asing Tidak Dikenal', { records: MOCK_MULTI_EMITEN_DATA });
  assert.equal(nullProfile, null);
});

test('FASE 2: bandarmologiService re-exports insider network service methods', () => {
  assert.equal(typeof bandarmologiService.buildInsiderNetworkGraph, 'function');
  assert.equal(typeof bandarmologiService.searchInsiders, 'function');
  assert.equal(typeof bandarmologiService.getInsiderProfile, 'function');
  assert.ok(bandarmologiService.insiderNetworkService);
});

test('FASE 2: Robust edge cases (null inputs, empty data, title stripping)', () => {
  // Title stripping
  const canonical = insiderNetworkService.canonicalizeName('Dr. Ir. Belvin Tannadi, M.M.');
  assert.equal(canonical, 'belvin tannadi');

  // Null input to buildInsiderNetworkGraph
  const emptyGraph = insiderNetworkService.buildInsiderNetworkGraph({ name: 'Tidak Ada', records: [] });
  assert.equal(emptyGraph.nodes.length, 0);
  assert.equal(emptyGraph.edges.length, 0);
  assert.equal(emptyGraph.summary.total_emitens, 0);

  // Empty search
  const emptySearch = insiderNetworkService.searchInsiders('ZZZZ9999', { records: [] });
  assert.equal(emptySearch.length, 0);
});