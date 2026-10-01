'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bandarmologiService = require('../lib/bandarmologi-service');
const insiderNetworkService = require('../lib/insider-network-service');

const NETWORK_FILE = path.join(__dirname, '..', 'data', 'insider-network', 'network.json');
const ROSTER_FILE = path.join(__dirname, '..', 'data', 'insider-network', 'roster.json');
const INSIDERS_DB_FILE = path.join(__dirname, '..', 'data', 'insider-network', 'insiders-db.json');

test('Transaction Parser: normalizeInsiders categorizes non-buy actions to TRANSFER', () => {
  const rawItems = [
    { name: 'Director A', action_type: 'BUY', broker: 'YP', changes_value: 100000, current_value: 500000 },
    { name: 'Director B', action_type: 'PENJUALAN', broker: 'CC', changes_value: 50000, current_value: 200000 },
    { name: 'Director C', action_type: 'HIBAH', broker: 'PD', changes_value: 20000, current_value: 100000 },
    { name: 'Director D', action_type: 'WARISAN', broker: 'AK', changes_value: 30000, current_value: 150000 },
    { name: 'Director E', action_type: 'MESOP_OPTION', broker: 'SQ', changes_value: 40000, current_value: 180000 },
    { name: 'Director F', action_type: 'REPO_TRANSFER', broker: 'LG', changes_value: 50000, current_value: 250000 }
  ];

  const normalized = bandarmologiService.normalizeInsiders(rawItems);
  assert.equal(normalized.length, 6);
  assert.equal(normalized[0].action_type, 'BUY');
  assert.equal(normalized[1].action_type, 'SELL');
  assert.equal(normalized[2].action_type, 'TRANSFER');
  assert.equal(normalized[3].action_type, 'TRANSFER');
  assert.equal(normalized[4].action_type, 'TRANSFER');
  assert.equal(normalized[5].action_type, 'TRANSFER');
});

test('Filter Non-Buy: aggregateInsiderHoldings never adds TRANSFER, HIBAH, or WARIS to total_bought', () => {
  const mockUniverse = [
    {
      ticker: 'TEST',
      insider_name: 'Test Conglomerate Owner',
      action_type: 'BUY',
      shares_change: 1000000,
      shares_after: 1000000,
      broker: 'YP'
    },
    {
      ticker: 'TEST',
      insider_name: 'Test Conglomerate Owner',
      action_type: 'HIBAH',
      shares_change: 500000,
      shares_after: 1500000,
      broker: 'CC'
    },
    {
      ticker: 'TEST',
      insider_name: 'Test Conglomerate Owner',
      action_type: 'WARISAN',
      shares_change: 250000,
      shares_after: 1750000,
      broker: 'AK'
    },
    {
      ticker: 'TEST',
      insider_name: 'Test Conglomerate Owner',
      action_type: 'SELL',
      shares_change: 200000,
      shares_after: 1550000,
      broker: 'PD'
    }
  ];

  const aggregated = insiderNetworkService.aggregateInsiderHoldings(mockUniverse);
  assert.equal(aggregated.length, 1);
  const ent = aggregated[0];
  const holding = ent.holdings[0];

  // Only BUY (1,000,000) counts towards total_bought
  assert.equal(holding.total_bought, 1000000);
  // Only SELL (200,000) counts towards total_sold
  assert.equal(holding.total_sold, 200000);
  // Net shares change: 1,000,000 - 200,000 = 800,000 (HIBAH and WARIS are NOT accumulated into buy net change)
  assert.equal(holding.net_shares_change, 800000);
  // Total balance after is properly tracked
  assert.equal(holding.shares, 1550000);
});

test('Holding Balance Guard: shares is never negative when an insider sells down to 0 balance', () => {
  const selloutRecord = [
    {
      ticker: 'ZERO',
      insider_name: 'Exited Shareholder',
      action_type: 'SELL',
      shares_change: -500000,
      shares_after: 0,
      broker: 'YP'
    }
  ];

  const aggregated = insiderNetworkService.aggregateInsiderHoldings(selloutRecord);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].holdings[0].shares, 0);
  assert.ok(aggregated[0].holdings[0].shares >= 0, 'shares must be non-negative');
});

test('Graph Integrity: network.json contains ZERO orphan edges and valid schema', () => {
  assert.ok(fs.existsSync(NETWORK_FILE), 'network.json must exist');
  const network = JSON.parse(fs.readFileSync(NETWORK_FILE, 'utf8'));

  assert.ok(network.total_multi_emiten_entities >= 200, 'Should have over 200 multi-emiten entities');
  assert.ok(network.networks_by_ticker, 'networks_by_ticker must be defined');

  let orphanEdges = 0;
  let totalEdges = 0;
  const sampleTickers = ['BBCA', 'BREN', 'BRPT', 'INDF', 'AMMN', 'ADRO'];

  for (const t of sampleTickers) {
    assert.ok(network.networks_by_ticker[t], `Network graph for ${t} must exist`);
  }

  for (const [ticker, graph] of Object.entries(network.networks_by_ticker)) {
    const nodeIds = new Set(graph.nodes.map(n => n.id));
    assert.equal(nodeIds.size, graph.nodes.length, `Duplicate node IDs found in graph for ${ticker}`);

    for (const edge of graph.edges) {
      totalEdges++;
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        orphanEdges++;
      }
    }
  }

  assert.equal(orphanEdges, 0, 'Graph must have zero orphan edges');
  assert.ok(totalEdges > 1000, 'Total edges should be substantial');
});

test('Roster Integrity: roster.json has non-negative shares and valid percentages', () => {
  assert.ok(fs.existsSync(ROSTER_FILE), 'roster.json must exist');
  const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));

  assert.ok(roster.total_tickers >= 900, 'Should have >= 900 tickers indexed in roster');
  let invalidShares = 0;
  let invalidPercentages = 0;
  let invalidNames = 0;

  for (const [ticker, list] of Object.entries(roster.tickers)) {
    for (const item of list) {
      if (typeof item.shares !== 'number' || isNaN(item.shares) || item.shares < 0) {
        invalidShares++;
      }
      if (typeof item.percentage !== 'number' || isNaN(item.percentage) || item.percentage < 0 || item.percentage > 100) {
        invalidPercentages++;
      }
      if (!item.name || item.name === '—' || item.name.length < 2) {
        invalidNames++;
      }
    }
  }

  assert.equal(invalidShares, 0, 'Roster must contain 0 negative or NaN shares');
  assert.equal(invalidPercentages, 0, 'Roster must contain 0 invalid percentages');
  assert.equal(invalidNames, 0, 'Roster must contain 0 empty or corrupt names');
});

test('Conglomerate Connectivity: Top Indonesian conglomerates have multi-emiten holdings', () => {
  assert.ok(fs.existsSync(INSIDERS_DB_FILE), 'insiders-db.json must exist');
  const db = JSON.parse(fs.readFileSync(INSIDERS_DB_FILE, 'utf8'));
  assert.ok(db.length > 10000, 'Should have > 10,000 insider transactions');

  // Verify search and network profiles for top conglomerates
  const prajogoProfile = insiderNetworkService.getInsiderProfile('Prajogo Pangestu');
  assert.ok(prajogoProfile, 'Prajogo Pangestu profile must exist');
  assert.ok(prajogoProfile.holdings.length >= 3, 'Prajogo Pangestu must hold at least 3 emitens (BREN, BRPT, TPIA, PTRO)');

  const boyThohirProfile = insiderNetworkService.getInsiderProfile('Garibaldi Thohir');
  assert.ok(boyThohirProfile, 'Garibaldi Thohir profile must exist');
  assert.ok(boyThohirProfile.holdings.length >= 3, 'Garibaldi Thohir must hold at least 3 emitens (ADRO, MDKA, ESSA)');

  const lkhProfile = insiderNetworkService.getInsiderProfile('Lo Kheng Hong');
  assert.ok(lkhProfile, 'Lo Kheng Hong profile must exist');
  assert.ok(lkhProfile.holdings.length >= 3, 'Lo Kheng Hong must hold at least 3 emitens');
});
