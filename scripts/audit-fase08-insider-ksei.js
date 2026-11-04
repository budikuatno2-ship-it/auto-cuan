'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INSIDER_DIR = path.join(ROOT, 'data', 'insider-network');
const CANDLES_DIR = path.join(ROOT, 'data', 'daily-candles');

function loadJson(file) {
  const p = path.join(INSIDER_DIR, file);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

console.log('[AUDIT 8A] Starting audit of insider & market structure data...');

const insidersDb = loadJson('insiders-db.json');
const rosterSep = loadJson('roster_30sep2026.json');
const rosterLegacy = loadJson('roster.json');
const ownershipSep = loadJson('ownership_30sep2026.json');
const network = loadJson('network.json');

// Universe of tickers from daily-candles (excluding index IHSG)
const candleFiles = fs.readdirSync(CANDLES_DIR).filter(f => f.endsWith('.json') && f !== 'IHSG.json');
const universeTickers = candleFiles.map(f => f.replace('.json', '')).sort();

console.log(`Universe emiten count: ${universeTickers.length}`);

// 1. Audit insiders-db.json
const insiderDbTickers = new Set(insidersDb.map(x => x.ticker));
const insiderDbDates = insidersDb.map(x => x.date).filter(Boolean).sort();
const minInsiderDate = insiderDbDates[0];
const maxInsiderDate = insiderDbDates[insiderDbDates.length - 1];

console.log(`insiders-db.json: ${insidersDb.length} transaksi, ${insiderDbTickers.size} unique tickers, rentang ${minInsiderDate} s/d ${maxInsiderDate}`);

// 2. Audit roster_30sep2026.json
const rosterTickers = Object.keys(rosterSep.tickers || {});
console.log(`roster_30sep2026.json: as_of=${rosterSep.as_of}, total_tickers=${rosterSep.total_tickers}, actual keys=${rosterTickers.length}`);

// 3. Audit ownership_30sep2026.json
const ownershipMap = new Map();
ownershipSep.forEach(row => ownershipMap.set(row.ticker, row));
console.log(`ownership_30sep2026.json: ${ownershipSep.length} emiten`);

// 4. Audit network.json
const networkTickers = Object.keys(network.networks_by_ticker || {});
const multiEntities = Object.keys(network.multi_emiten_entities || {});
console.log(`network.json: ${multiEntities.length} multi-emiten entities, ${networkTickers.length} networks_by_ticker`);

// 5. Compare universe vs datasets
const auditResults = universeTickers.map(ticker => {
  const own = ownershipMap.get(ticker) || null;
  const ros = rosterSep.tickers ? rosterSep.tickers[ticker] : null;
  const net = network.networks_by_ticker ? network.networks_by_ticker[ticker] : null;
  const hasTx = insiderDbTickers.has(ticker);

  const hasOwnership = !!own && Array.isArray(own.investors) && own.investors.length > 0;
  const hasRoster = !!ros && Array.isArray(ros) && ros.length > 0;
  const hasNetGraph = !!net && Array.isArray(net.nodes) && net.nodes.length > 0;

  return {
    ticker,
    has_ownership: !!own,
    ownership_complete: hasOwnership,
    free_float: own ? own.freeFloat : null,
    investor_count: own ? own.investorCount : 0,
    has_roster: hasRoster,
    roster_count: hasRoster ? ros.length : 0,
    has_network_graph: hasNetGraph,
    network_nodes: hasNetGraph ? net.nodes.length : 0,
    network_edges: hasNetGraph ? net.edges.length : 0,
    has_insider_transactions: hasTx
  };
});

const withOwnership = auditResults.filter(r => r.has_ownership).length;
const withCompleteOwnership = auditResults.filter(r => r.ownership_complete).length;
const withRoster = auditResults.filter(r => r.has_roster).length;
const withNetworkGraph = auditResults.filter(r => r.has_network_graph).length;
const withInsiderTx = auditResults.filter(r => r.has_insider_transactions).length;

const summary = {
  total_universe: universeTickers.length,
  with_ownership: withOwnership,
  with_complete_ownership: withCompleteOwnership,
  with_roster_ksei: withRoster,
  with_network_graph: withNetworkGraph,
  with_insider_transactions: withInsiderTx,
  missing_in_ownership: auditResults.filter(r => !r.has_ownership).map(r => r.ticker),
  incomplete_ownership: auditResults.filter(r => r.has_ownership && !r.ownership_complete).map(r => r.ticker)
};

console.log('SUMMARY AUDIT 8A:');
console.log(JSON.stringify(summary, null, 2));

const outDir = path.join(ROOT, 'bukti-verifikasi-final', 'fase08');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'audit-insider-ksei-summary.json'), JSON.stringify({
  timestamp: new Date().toISOString(),
  datasets: {
    insiders_db: {
      records: insidersDb.length,
      unique_tickers: insiderDbTickers.size,
      date_range: [minInsiderDate, maxInsiderDate]
    },
    roster_30sep2026: {
      as_of: rosterSep.as_of,
      total_tickers: rosterSep.total_tickers
    },
    ownership_30sep2026: {
      total_emiten: ownershipSep.length
    },
    network: {
      multi_emiten_entities: multiEntities.length,
      networks_by_ticker: networkTickers.length
    }
  },
  audit_summary: summary
}, null, 2), 'utf8');

console.log(`Saved to ${path.join(outDir, 'audit-insider-ksei-summary.json')}`);
