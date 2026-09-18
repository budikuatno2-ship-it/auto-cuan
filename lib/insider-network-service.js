'use strict';

/**
 * Insider Network Relation Service & Search Index Helper
 *
 * Provides:
 * 1. Multi-emiten ownership aggregation per person/entity (e.g. Belvin Tannadi -> BUMI, BRMS, DEWA).
 * 2. Network Graph Schema generator (nodes, edges/links, stats) for visualization (D3/ForceGraph/Cytoscape).
 * 3. Instant search & autocomplete index for insider names with ranking and ticker associations.
 * 4. Profile builder with per-ticker holding breakdown and transaction summaries.
 */

const fs = require('fs');
const path = require('path');

// ponytail: fabricated fallback universe removed (F-041). No data file -> NO_DATA, never fake insiders.

let customUniverse = null;

const CONGLOMERATE_ALIASES = {
  'anthony salim': 'anthoni salim',
  'salim anthoni': 'anthoni salim',
  'salim group': 'anthoni salim',
  'grup salim': 'anthoni salim',
  'prayogo pangestu': 'prajogo pangestu',
  'barito group': 'prajogo pangestu',
  'barito pacific': 'prajogo pangestu',
  'grup barito': 'prajogo pangestu',
  'boy thohir': 'garibaldi thohir',
  'thohir boy': 'garibaldi thohir',
  'adaro group': 'garibaldi thohir',
  'saratoga group': 'garibaldi thohir',
  'haji isam': 'samsudin andi arsyad',
  'h isam': 'samsudin andi arsyad',
  'isam': 'samsudin andi arsyad',
  'jhonlin group': 'samsudin andi arsyad',
  'jhonlin': 'samsudin andi arsyad',
  'budi hartono': 'robert budi hartono',
  'r budi hartono': 'robert budi hartono',
  'michael bambang hartono': 'robert budi hartono',
  'bambang hartono': 'robert budi hartono',
  'grup djarum': 'robert budi hartono',
  'djarum group': 'robert budi hartono',
  'djarum': 'robert budi hartono',
  'lkh': 'lo kheng hong',
  'bapak lkh': 'lo kheng hong',
  'warren buffett indonesia': 'lo kheng hong'
};

/**
 * Strips academic, honorific and corporate titles, lowercases and collapses spaces.
 * Useful for matching variations like "Dr. Ir. Belvin Tannadi, M.M." -> "belvin tannadi".
 */
function canonicalizeName(rawName) {
  if (!rawName) return '';
  const cleaned = String(rawName)
    .toLowerCase()
    .replace(/\b(dr|drs|dra|ir|prof|h|hj|haji|sh|s\.h|se|s\.e|si|s\.i|mm|m\.m|msc|m\.sc|mba|phd|ph\.d|llm|akt|cfa|cfp|ak|pt|tbk|cv|bv|ltd|inc|corp|llc)\b/gi, ' ')
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ')
    .replace(/\b(dr|drs|dra|ir|prof|h|hj|haji|sh|se|si|mm|msc|mba|phd|llm|akt|cfa|cfp|ak|pt|tbk)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return CONGLOMERATE_ALIASES[cleaned] || cleaned;
}

/**
 * Generate unique entity identifier
 */
function toEntityId(name) {
  const canon = canonicalizeName(name);
  return 'insider:' + (canon.replace(/\s+/g, '_') || 'unknown');
}

/**
 * Generate unique ticker node identifier
 */
function toTickerId(ticker) {
  return 'ticker:' + String(ticker || '').trim().toUpperCase();
}

/**
 * Parse numeric shares safely
 */
function parseShares(val) {
  if (val == null) return 0;
  if (typeof val === 'number') {
    return isNaN(val) ? 0 : Math.round(val);
  }
  const clean = String(val).replace(/[,.\s]/g, '').trim();
  const num = parseInt(clean, 10);
  return isNaN(num) ? 0 : num;
}

/**
 * Parse percentage safely as float (e.g. "2.45%" -> 2.45, 0.0245 -> 0.0245)
 */
function parsePercentage(val) {
  if (val == null) return null;
  if (typeof val === 'number') {
    return isNaN(val) ? null : val;
  }
  const clean = String(val).replace(/[%,\s]/g, '').trim();
  const num = parseFloat(clean);
  return isNaN(num) ? null : num;
}

/**
 * Flatten input universe / dataset into normalized list of insider transactions
 */
function flattenAndNormalizeRecords(input, defaultTicker = '') {
  if (!input) return [];

  let list = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === 'object') {
    // Check if it's an object of { [ticker]: [...] }
    for (const [tickerKey, items] of Object.entries(input)) {
      if (Array.isArray(items)) {
        for (const it of items) {
          list.push(Object.assign({ ticker: tickerKey }, it));
        }
      }
    }
  }

  // Lazy require bandarmologiService to avoid circular dependency
  let normalizeFn = null;
  try {
    const b = require('./bandarmologi-service');
    normalizeFn = b.normalizeInsiders;
  } catch {}

  const normalized = typeof normalizeFn === 'function' ? normalizeFn(list) : list;
  return normalized.map((norm, idx) => {
    const raw = list[idx] || {};
    const ticker = String(raw.ticker || defaultTicker || norm.ticker || '').trim().toUpperCase();
    return Object.assign({}, norm, { ticker });
  });
}

const INSIDERS_DB_FILE = path.join(__dirname, '..', 'data', 'insider-network', 'insiders-db.json');

let cachedDedicatedUniverse = null;
let cachedAggregatedHoldings = null;
let cachedSearchIndex = null;

function clearInsiderServiceMemoryCache() {
  cachedDedicatedUniverse = null;
  cachedAggregatedHoldings = null;
  cachedSearchIndex = null;
}

function loadDedicatedUniverse() {
  if (cachedDedicatedUniverse) return cachedDedicatedUniverse;
  try {
    if (fs.existsSync(INSIDERS_DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(INSIDERS_DB_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        cachedDedicatedUniverse = data;
        return data;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Get effective universe of insider records.
 * F-041: never fabricate data. When no override/custom/dedicated data exists,
 * return an empty array so callers surface an explicit NO_DATA state.
 */
function getEffectiveUniverse(recordsOverride) {
  if (recordsOverride) {
    return flattenAndNormalizeRecords(recordsOverride);
  }
  if (customUniverse) {
    return customUniverse;
  }
  const dedicated = loadDedicatedUniverse();
  if (dedicated) {
    return flattenAndNormalizeRecords(dedicated);
  }
  return [];
}

/**
 * Explicit data-availability status for the effective universe.
 * Returns 'NO_DATA' when data/insider-network/insiders-db.json is missing/empty
 * and no override/custom universe was supplied.
 */
function getEffectiveUniverseStatus(recordsOverride) {
  if (recordsOverride) return 'OVERRIDE';
  if (customUniverse) return 'CUSTOM';
  return loadDedicatedUniverse() ? 'OK' : 'NO_DATA';
}

/**
 * Set custom universe for testing or runtime injection
 */
function setCustomUniverse(records) {
  if (records == null) {
    customUniverse = null;
  } else {
    customUniverse = flattenAndNormalizeRecords(records);
  }
}

/**
 * Aggregate insider holdings across multiple emitens
 */
function aggregateInsiderHoldings(recordsOrUniverse) {
  if (!recordsOrUniverse && !customUniverse && cachedAggregatedHoldings) {
    return cachedAggregatedHoldings;
  }
  const records = getEffectiveUniverse(recordsOrUniverse);
  const entitiesMap = new Map();

  for (const item of records) {
    const rawName = item.insider_name || item.name || '';
    if (!rawName || rawName === '—') continue;

    const canon = canonicalizeName(rawName);
    if (!canon) continue;

    const entityId = toEntityId(rawName);
    if (!entitiesMap.has(entityId)) {
      entitiesMap.set(entityId, {
        id: entityId,
        name: rawName,
        canonical_name: canon,
        nationality: item.nationality || 'local',
        positions: new Set(),
        brokers: new Set(),
        tickerHoldings: new Map(),
        transactions: []
      });
    }

    const entity = entitiesMap.get(entityId);

    // Track positions and brokers
    if (item.position && item.position !== '—') {
      entity.positions.add(item.position);
    }
    if (item.broker && item.broker !== '—') {
      entity.brokers.add(item.broker);
    }
    if (item.nationality && item.nationality !== 'local') {
      entity.nationality = item.nationality;
    }

    entity.transactions.push(item);

    // Aggregate by ticker
    const ticker = item.ticker || 'UNKNOWN';
    if (!entity.tickerHoldings.has(ticker)) {
      entity.tickerHoldings.set(ticker, {
        ticker: ticker,
        latest_date: item.date || '',
        latest_action: item.action_type || 'BUY',
        latest_price: item.price || 0,
        shares: Math.max(0, parseShares(item.shares_after != null ? item.shares_after : (item.shares != null ? item.shares : 0))),
        percentage: parsePercentage(item.pct_after || item.pct_change),
        percentage_raw: item.pct_after || item.pct_change || '—',
        brokers: new Set(),
        transactions_count: 0,
        net_shares_change: 0,
        total_bought: 0,
        total_sold: 0
      });
    }

    const holding = entity.tickerHoldings.get(ticker);
    holding.transactions_count += 1;

    // Maintain latest known date & status
    if (!holding.latest_date || (item.date && item.date >= holding.latest_date)) {
      holding.latest_date = item.date || holding.latest_date;
      holding.latest_action = item.action_type || holding.latest_action;
      if (item.price) holding.latest_price = item.price;
      if (item.shares_after != null) holding.shares = Math.max(0, parseShares(item.shares_after));
      if (item.pct_after != null) {
        holding.percentage = parsePercentage(item.pct_after);
        holding.percentage_raw = item.pct_after;
      }
    }

    const change = parseShares(item.shares_change || item.shares || 0);
    const action = String(item.action_type || '').toUpperCase().trim();
    if (action === 'SELL') {
      holding.total_sold += change;
      holding.net_shares_change -= change;
    } else if (action === 'BUY' || action === 'PURCHASE') {
      holding.total_bought += change;
      holding.net_shares_change += change;
    }
    // Aksi non-beli/jual seperti TRANSFER, HIBAH, WARIS, BONUS, dan RIGHTS
    // sengaja diabaikan dari total_bought dan net_shares_change untuk mencegah akumulasi palsu

    if (item.broker && item.broker !== '—') {
      holding.brokers.add(item.broker);
    }
  }

  // Convert map structures to clean JSON-serializable objects
  const results = [];
  for (const entity of entitiesMap.values()) {
    const holdings = [];
    let totalShares = 0;

    for (const h of entity.tickerHoldings.values()) {
      totalShares += h.shares || 0;
      holdings.push({
        ticker: h.ticker,
        shares: h.shares,
        percentage: h.percentage,
        percentage_raw: h.percentage_raw,
        latest_action: h.latest_action,
        latest_date: h.latest_date,
        latest_price: h.latest_price,
        brokers: Array.from(h.brokers).sort(),
        transactions_count: h.transactions_count,
        net_shares_change: h.net_shares_change,
        total_bought: h.total_bought,
        total_sold: h.total_sold
      });
    }

    // Sort holdings by shares descending
    holdings.sort((a, b) => (b.shares || 0) - (a.shares || 0));

    results.push({
      id: entity.id,
      name: entity.name,
      canonical_name: entity.canonical_name,
      nationality: entity.nationality,
      positions: Array.from(entity.positions),
      brokers: Array.from(entity.brokers).sort(),
      total_emitens: holdings.length,
      total_shares: totalShares,
      holdings: holdings,
      latest_date: holdings.length > 0 ? holdings[0].latest_date : '',
      transactions_count: entity.transactions.length
    });
  }

  const sorted = results.sort((a, b) => b.total_emitens - a.total_emitens || b.total_shares - a.total_shares);
  if (!recordsOrUniverse && !customUniverse) {
    cachedAggregatedHoldings = sorted;
  }
  return sorted;
}

/**
 * Build Autocomplete / Instant Search Index
 */
function buildInsiderSearchIndex(recordsOrUniverse) {
  if (!recordsOrUniverse && !customUniverse && cachedSearchIndex) {
    return cachedSearchIndex;
  }
  const aggregated = aggregateInsiderHoldings(recordsOrUniverse);

  const index = aggregated.map(ent => ({
    id: ent.id,
    name: ent.name,
    canonical_name: ent.canonical_name,
    tickers: ent.holdings.map(h => h.ticker),
    total_emitens: ent.total_emitens,
    total_shares: ent.total_shares,
    nationality: ent.nationality,
    positions: ent.positions,
    latest_date: ent.latest_date
  }));

  if (!recordsOrUniverse && !customUniverse) {
    cachedSearchIndex = index;
  }
  return index;
}

/**
 * Search Insiders by query with ranking
 */
function searchInsiders(query, options = {}) {
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 10;
  const index = buildInsiderSearchIndex(options.records || options.universe);

  const cleanQuery = canonicalizeName(query);
  if (!cleanQuery) {
    // If empty query, return top entities sorted by total_emitens
    return index.slice(0, limit);
  }

  const queryTerms = cleanQuery.split(/\s+/).filter(Boolean);

  const matches = [];
  for (const item of index) {
    const canon = item.canonical_name;
    const nameLower = item.name.toLowerCase();

    let score = 0;

    // Exact full match
    if (canon === cleanQuery || nameLower === cleanQuery) {
      score += 1000;
    }
    // Prefix match
    else if (canon.startsWith(cleanQuery)) {
      score += 500;
    }
    // Word boundary match (e.g. query "tannadi" matches "belvin tannadi")
    else if (canon.includes(' ' + cleanQuery) || canon.split(' ').some(word => word.startsWith(cleanQuery))) {
      score += 300;
    }
    // All terms match somewhere
    else if (queryTerms.every(term => canon.includes(term))) {
      score += 150;
    }
    // Substring match
    else if (canon.includes(cleanQuery)) {
      score += 100;
    }

    // Secondary boost for ticker match (e.g. user types "BUMI" -> finds holders of BUMI)
    const upperRawQuery = String(query || '').trim().toUpperCase();
    if (item.tickers.includes(upperRawQuery)) {
      score += 80;
    }

    if (score > 0) {
      matches.push({
        score,
        item
      });
    }
  }

  // Sort by score descending, then total_emitens, then total_shares
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.item.total_emitens !== a.item.total_emitens) return b.item.total_emitens - a.item.total_emitens;
    return (b.item.total_shares || 0) - (a.item.total_shares || 0);
  });

  const seenIds = new Set();
  const uniqueItems = [];
  for (const m of matches) {
    if (!seenIds.has(m.item.id)) {
      seenIds.add(m.item.id);
      uniqueItems.push(m.item);
      if (uniqueItems.length >= limit) break;
    }
  }

  return uniqueItems;
}

/**
 * Build Network Relation Graph Schema
 *
 * Can target:
 * - A specific insider entity: `options.name` / `options.query`
 * - A specific ticker: `options.ticker`
 * - Entire universe: no filter (or all multi-emiten insiders)
 */
function buildInsiderNetworkGraph(options = {}) {
  const query = typeof options === 'string' ? options : (options && (options.name || options.query) || '');
  const tickerQuery = options && options.ticker ? String(options.ticker).trim().toUpperCase() : '';
  const maxDepth = Math.min(3, Math.max(1, Number((options && options.maxDepth) || 3)));
  const aggregated = aggregateInsiderHoldings(options && (options.records || options.universe));
  const nodes = [];
  const edges = [];
  const nodeMap = new Set();

  function addNode(node) {
    if (!nodeMap.has(node.id)) {
      nodeMap.add(node.id);
      nodes.push(node);
    }
  }

  // 1. Filtered by Insider Person/Entity
  if (query) {
    const searchResults = searchInsiders(query, { records: options.records || options.universe, limit: 1 });
    const targetEntity = searchResults.length > 0
      ? aggregated.find(e => e.id === searchResults[0].id)
      : null;

    if (!targetEntity) {
      return {
        nodes: [],
        edges: [],
        links: [],
        summary: {
          query: query,
          entity_name: query,
          node_count: 0,
          edge_count: 0,
          total_emitens: 0,
          total_shares: 0
        }
      };
    }

    // Add Central Insider Node
    addNode({
      id: targetEntity.id,
      type: 'insider',
      label: targetEntity.name,
      canonical_name: targetEntity.canonical_name,
      nationality: targetEntity.nationality,
      total_emitens: targetEntity.total_emitens,
      total_shares: targetEntity.total_shares,
      positions: targetEntity.positions,
      brokers: targetEntity.brokers,
      is_central: true
    });

    // Add Connected Ticker Nodes & Edges
    for (const h of targetEntity.holdings) {
      const tickerNodeId = toTickerId(h.ticker);
      addNode({
        id: tickerNodeId,
        type: 'ticker',
        ticker: h.ticker,
        label: h.ticker
      });

      edges.push({
        id: `edge:${targetEntity.id}-${tickerNodeId}`,
        source: targetEntity.id,
        target: tickerNodeId,
        relation: 'HOLDS',
        ticker: h.ticker,
        shares: h.shares,
        percentage: h.percentage,
        percentage_raw: h.percentage_raw,
        latest_action: h.latest_action,
        latest_date: h.latest_date,
        latest_price: h.latest_price,
        brokers: h.brokers,
        broker: (h.brokers && h.brokers.length > 0) ? h.brokers[0] : '',
        transactions_count: h.transactions_count,
        net_shares_change: h.net_shares_change
      });
    }

    return {
      nodes,
      edges,
      links: edges, // Alias for D3 / ForceGraph compatibility
      summary: {
        query: query,
        entity_name: targetEntity.name,
        entity_id: targetEntity.id,
        nationality: targetEntity.nationality,
        total_emitens: targetEntity.total_emitens,
        total_shares: targetEntity.total_shares,
        node_count: nodes.length,
        edge_count: edges.length
      }
    };
  }

  // 2. Filtered by Ticker
  if (tickerQuery) {
    const tickerNodeId = toTickerId(tickerQuery);
    const relatedEntities = aggregated.filter(ent => ent.holdings.some(h => h.ticker === tickerQuery));

    addNode({
      id: tickerNodeId,
      type: 'ticker',
      ticker: tickerQuery,
      label: tickerQuery,
      is_central: true
    });

    for (const ent of relatedEntities) {
      const holding = ent.holdings.find(h => h.ticker === tickerQuery);
      if (!holding) continue;

      addNode({
        id: ent.id,
        type: 'insider',
        label: ent.name,
        canonical_name: ent.canonical_name,
        nationality: ent.nationality,
        total_emitens: ent.total_emitens,
        total_shares: ent.total_shares,
        positions: ent.positions,
        brokers: ent.brokers
      });

      edges.push({
        id: `edge:${ent.id}-${tickerNodeId}`,
        source: ent.id,
        target: tickerNodeId,
        relation: 'HOLDS',
        ticker: tickerQuery,
        shares: holding.shares,
        percentage: holding.percentage,
        percentage_raw: holding.percentage_raw,
        latest_action: holding.latest_action,
        latest_date: holding.latest_date,
        latest_price: holding.latest_price,
        brokers: holding.brokers,
        broker: (holding.brokers && holding.brokers.length > 0) ? holding.brokers[0] : '',
        transactions_count: holding.transactions_count,
        net_shares_change: holding.net_shares_change
      });
    }

    return {
      nodes,
      edges,
      links: edges,
      summary: {
        ticker: tickerQuery,
        insiders_count: relatedEntities.length,
        node_count: nodes.length,
        edge_count: edges.length
      }
    };
  }

  // 3. Complete Network (All entities or multi-emiten entities)
  const targetEntities = options.multiOnly
    ? aggregated.filter(e => e.total_emitens > 1)
    : aggregated;

  for (const ent of targetEntities) {
    addNode({
      id: ent.id,
      type: 'insider',
      label: ent.name,
      canonical_name: ent.canonical_name,
      nationality: ent.nationality,
      total_emitens: ent.total_emitens,
      total_shares: ent.total_shares,
      positions: ent.positions,
      brokers: ent.brokers
    });

    for (const h of ent.holdings) {
      const tickerNodeId = toTickerId(h.ticker);
      addNode({
        id: tickerNodeId,
        type: 'ticker',
        ticker: h.ticker,
        label: h.ticker
      });

      edges.push({
        id: `edge:${ent.id}-${tickerNodeId}`,
        source: ent.id,
        target: tickerNodeId,
        relation: 'HOLDS',
        ticker: h.ticker,
        shares: h.shares,
        percentage: h.percentage,
        percentage_raw: h.percentage_raw,
        latest_action: h.latest_action,
        latest_date: h.latest_date,
        latest_price: h.latest_price,
        brokers: h.brokers,
        broker: (h.brokers && h.brokers.length > 0) ? h.brokers[0] : '',
        transactions_count: h.transactions_count,
        net_shares_change: h.net_shares_change
      });
    }
  }

  return {
    nodes,
    edges,
    links: edges,
    summary: {
      total_insiders: targetEntities.length,
      node_count: nodes.length,
      edge_count: edges.length
    }
  };
}

/**
 * Get full profile of an insider including detailed holdings and graph
 */
function getInsiderProfile(nameOrQuery, options = {}) {
  if (!nameOrQuery) return null;

  const matches = searchInsiders(nameOrQuery, { records: options.records || options.universe, limit: 1 });
  if (matches.length === 0) return null;

  const aggregated = aggregateInsiderHoldings(options.records || options.universe);
  const profile = aggregated.find(e => e.id === matches[0].id);
  if (!profile) return null;

  const graph = buildInsiderNetworkGraph({
    name: profile.name,
    records: options.records || options.universe
  });

  return Object.assign({}, profile, { graph });
}

/**
 * Scan local disk cache for insider transactions
 */
function loadDiskInsiderUniverse(baseDir) {
  const dir = baseDir || process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
  const insiderDir = path.join(dir, 'insiders');
  if (!fs.existsSync(insiderDir)) return [];

  const universe = [];
  try {
    const tickers = fs.readdirSync(insiderDir);
    for (const ticker of tickers) {
      const tickerDir = path.join(insiderDir, ticker);
      if (!fs.statSync(tickerDir).isDirectory()) continue;
      const files = fs.readdirSync(tickerDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = JSON.parse(fs.readFileSync(path.join(tickerDir, file), 'utf8'));
          const items = Array.isArray(content) ? content : (content.items || content.data || []);
          for (const it of items) {
            universe.push(Object.assign({ ticker: ticker.toUpperCase() }, it));
          }
        } catch {
          // ignore corrupted files
        }
      }
    }
  } catch {
    return [];
  }

  return flattenAndNormalizeRecords(universe);
}

function getInsidersForTicker(ticker) {
  if (!ticker) return [];
  const clean = String(ticker).trim().toUpperCase();
  const all = getEffectiveUniverse();
  return all.filter(r => (r.ticker || '').toUpperCase() === clean);
}

function getRosterForTicker(ticker) {
  if (!ticker) return [];
  const clean = String(ticker).trim().toUpperCase();
  try {
    const rosterFile = path.join(__dirname, '..', 'data', 'insider-network', 'roster.json');
    if (fs.existsSync(rosterFile)) {
      const allRosters = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
      const tickerData = allRosters && allRosters.tickers ? allRosters.tickers[clean] : (allRosters ? allRosters[clean] : null);
      if (tickerData && Array.isArray(tickerData) && tickerData.length > 0) {
        return tickerData;
      }
    }
  } catch (_) {}

  const recs = getInsidersForTicker(clean);
  return recs.map((r, idx) => ({
    no: idx + 1,
    ticker: clean,
    name: r.insider_name || r.name,
    category: r.position && r.position.toLowerCase().includes('pengendali') ? 'Pengendali' : (r.position && r.position.toLowerCase().includes('direk') ? 'Direksi' : (r.position && r.position.toLowerCase().includes('komis') ? 'Komisaris' : 'Pemegang Saham')),
    position: r.position || 'Pemegang Saham',
    shares: Math.max(0, parseShares(r.shares_after != null ? r.shares_after : (r.shares || 0))),
    percentage: r.percentage || 0,
    percentage_formatted: (r.percentage || 0).toFixed(2) + '%',
    action_type: r.action_type || 'BUY',
    last_change: r.pct_change || '+0.00%',
    // No static fallback: a missing date propagates as null so the UI can
    // render the explicit "tanggal belum tersedia" marker (Batch 6 F-080).
    last_date: r.date || null,
    nationality: r.nationality || 'local'
  }));
}

module.exports = {
  canonicalizeName,
  toEntityId,
  toTickerId,
  parseShares,
  parsePercentage,
  flattenAndNormalizeRecords,
  getEffectiveUniverse,
  getEffectiveUniverseStatus,
  aggregateInsiderHoldings,
  buildInsiderSearchIndex,
  searchInsiders,
  buildInsiderNetworkGraph,
  buildInsiderNetwork: buildInsiderNetworkGraph,
  getInsiderProfile,
  loadDiskInsiderUniverse,
  setCustomUniverse,
  getInsidersForTicker,
  getRosterForTicker
};