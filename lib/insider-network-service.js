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

// Default sample universe of prominent Indonesian market insiders for instant offline/demo capability
const SAMPLE_INSIDER_UNIVERSE = [
  // Belvin Tannadi - multi-emiten influencer/investor
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
    shares_before: 825000000,
    shares_before_percentage: '2.30%',
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
    shares_before: 405000000,
    shares_before_percentage: '1.70%',
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
    shares_before: 170000000,
    shares_before_percentage: '1.07%',
    nationality: 'local'
  },

  // Prajogo Pangestu - Barito Group conglomerate owner
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
    shares_before: 5795000000,
    shares_before_percentage: '43.17%',
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
    shares_before: 66488000000,
    shares_before_percentage: '71.13%',
    nationality: 'local'
  },
  {
    ticker: 'TPIA',
    date: '2026-08-10',
    insider_name: 'Prajogo Pangestu',
    position: 'Pengendali',
    action_type: 'BUY',
    broker: 'CC',
    price: 8750,
    shares_change: 2000000,
    pct_change: '+0.01%',
    shares_after: 3280000000,
    shares_after_percentage: '37.95%',
    shares_before: 3278000000,
    shares_before_percentage: '37.94%',
    nationality: 'local'
  },
  {
    ticker: 'PTRO',
    date: '2026-07-25',
    insider_name: 'Prajogo Pangestu',
    position: 'Pengendali Tidak Langsung',
    action_type: 'BUY',
    broker: 'CC',
    price: 14200,
    shares_change: 1500000,
    pct_change: '+0.15%',
    shares_after: 340000000,
    shares_after_percentage: '34.00%',
    shares_before: 338500000,
    shares_before_percentage: '33.85%',
    nationality: 'local'
  },

  // Lo Kheng Hong - Value investor
  {
    ticker: 'BMTR',
    date: '2026-08-18',
    insider_name: 'Lo Kheng Hong',
    position: 'Pemegang Saham >5%',
    action_type: 'BUY',
    broker: 'PD',
    price: 240,
    shares_change: 3000000,
    pct_change: '+0.02%',
    shares_after: 1060000000,
    shares_after_percentage: '6.45%',
    shares_before: 1057000000,
    shares_before_percentage: '6.43%',
    nationality: 'local'
  },
  {
    ticker: 'DILD',
    date: '2026-08-05',
    insider_name: 'Lo Kheng Hong',
    position: 'Pemegang Saham >5%',
    action_type: 'BUY',
    broker: 'PD',
    price: 185,
    shares_change: 2000000,
    pct_change: '+0.02%',
    shares_after: 650000000,
    shares_after_percentage: '6.28%',
    shares_before: 648000000,
    shares_before_percentage: '6.26%',
    nationality: 'local'
  },
  {
    ticker: 'ABMM',
    date: '2026-07-30',
    insider_name: 'Lo Kheng Hong',
    position: 'Pemegang Saham >5%',
    action_type: 'BUY',
    broker: 'PD',
    price: 3950,
    shares_change: 500000,
    pct_change: '+0.02%',
    shares_after: 138000000,
    shares_after_percentage: '5.01%',
    shares_before: 137500000,
    shares_before_percentage: '4.99%',
    nationality: 'local'
  },

  // Anthony Salim - Salim Group
  {
    ticker: 'INDF',
    date: '2026-08-22',
    insider_name: 'Anthoni Salim',
    position: 'Direktur Utama & Pengendali',
    action_type: 'BUY',
    broker: 'CS',
    price: 6800,
    shares_change: 1000000,
    pct_change: '+0.01%',
    shares_after: 4390000000,
    shares_after_percentage: '50.07%',
    shares_before: 4389000000,
    shares_before_percentage: '50.06%',
    nationality: 'local'
  },
  {
    ticker: 'AMMN',
    date: '2026-08-14',
    insider_name: 'Anthoni Salim',
    position: 'Pemegang Saham Tidak Langsung',
    action_type: 'BUY',
    broker: 'AK',
    price: 10400,
    shares_change: 5000000,
    pct_change: '+0.01%',
    shares_after: 5200000000,
    shares_after_percentage: '7.15%',
    shares_before: 5195000000,
    shares_before_percentage: '7.14%',
    nationality: 'local'
  },

  // Haji Samsudin Andi Arsyad (Haji Isam) - Jhonlin Group
  {
    ticker: 'JARR',
    date: '2026-09-08',
    insider_name: 'Haji Samsudin Andi Arsyad',
    entity_type: 'tokoh',
    holding_company: 'PT Eshan Agro Sentosa',
    position: 'Pemegang Saham Pengendali Terakhir',
    action_type: 'BUY',
    broker: 'CC',
    price: 380,
    shares_change: 35000000,
    pct_change: '+0.44%',
    shares_after: 6750000000,
    shares_after_percentage: '84.38%',
    shares_before: 6715000000,
    shares_before_percentage: '83.94%',
    nationality: 'local'
  },
  {
    ticker: 'PGUN',
    date: '2026-09-02',
    insider_name: 'Haji Samsudin Andi Arsyad',
    entity_type: 'tokoh',
    holding_company: 'PT Araya Agro Lestari',
    position: 'Pemegang Saham Pengendali',
    action_type: 'BUY',
    broker: 'YP',
    price: 420,
    shares_change: 20000000,
    pct_change: '+0.35%',
    shares_after: 4780000000,
    shares_after_percentage: '83.28%',
    shares_before: 4760000000,
    shares_before_percentage: '82.93%',
    nationality: 'local'
  },

  // Foreign Institutional Entity
  {
    ticker: 'BBCA',
    date: '2026-09-01',
    insider_name: 'BlackRock Inc.',
    position: 'Institutional Investor',
    action_type: 'BUY',
    broker: 'AK',
    price: 9850,
    shares_change: 4500000,
    pct_change: '+0.01%',
    shares_after: 3100000000,
    shares_after_percentage: '2.52%',
    shares_before: 3095500000,
    shares_before_percentage: '2.51%',
    nationality: 'foreign'
  },
  {
    ticker: 'BBRI',
    date: '2026-08-29',
    insider_name: 'BlackRock Inc.',
    position: 'Institutional Investor',
    action_type: 'BUY',
    broker: 'AK',
    price: 4950,
    shares_change: 8000000,
    pct_change: '+0.01%',
    shares_after: 3800000000,
    shares_after_percentage: '2.51%',
    shares_before: 3792000000,
    shares_before_percentage: '2.50%',
    nationality: 'foreign'
  },
  {
    ticker: 'TLKM',
    date: '2026-08-25',
    insider_name: 'BlackRock Inc.',
    position: 'Institutional Investor',
    action_type: 'SELL',
    broker: 'AK',
    price: 2950,
    shares_change: 12000000,
    pct_change: '-0.01%',
    shares_after: 2450000000,
    shares_after_percentage: '2.47%',
    shares_before: 2462000000,
    shares_before_percentage: '2.48%',
    nationality: 'foreign'
  },

  // Garibaldi Thohir (Boy Thohir) - Adaro & conglomerates
  {
    ticker: 'ADRO',
    date: '2026-09-03',
    insider_name: 'Garibaldi Thohir',
    position: 'Presiden Direktur & Pemegang Saham',
    action_type: 'BUY',
    broker: 'LG',
    price: 3680,
    shares_change: 10000000,
    pct_change: '+0.03%',
    shares_after: 1980000000,
    shares_after_percentage: '6.18%',
    shares_before: 1970000000,
    shares_before_percentage: '6.15%',
    nationality: 'local'
  },
  {
    ticker: 'MDKA',
    date: '2026-08-26',
    insider_name: 'Garibaldi Thohir',
    position: 'Pemegang Saham >5%',
    action_type: 'BUY',
    broker: 'LG',
    price: 2360,
    shares_change: 8000000,
    pct_change: '+0.03%',
    shares_after: 1850000000,
    shares_after_percentage: '7.65%',
    shares_before: 1842000000,
    shares_before_percentage: '7.62%',
    nationality: 'local'
  },
  {
    ticker: 'ESSA',
    date: '2026-08-19',
    insider_name: 'Garibaldi Thohir',
    position: 'Pemegang Saham',
    action_type: 'BUY',
    broker: 'LG',
    price: 940,
    shares_change: 5000000,
    pct_change: '+0.03%',
    shares_after: 920000000,
    shares_after_percentage: '5.40%',
    shares_before: 915000000,
    shares_before_percentage: '5.37%',
    nationality: 'local'
  }
];

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
 * Get effective universe of insider records
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
  return flattenAndNormalizeRecords(SAMPLE_INSIDER_UNIVERSE);
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
        shares: parseShares(item.shares_after || item.shares_change || item.shares),
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
      if (item.shares_after != null) holding.shares = parseShares(item.shares_after);
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
    shares: r.shares_after || r.shares || 0,
    percentage: r.percentage || 0,
    percentage_formatted: (r.percentage || 0).toFixed(2) + '%',
    action_type: r.action_type || 'BUY',
    last_change: r.pct_change || '+0.00%',
    last_date: r.date || '2026-09-01',
    nationality: r.nationality || 'local'
  }));
}

module.exports = {
  SAMPLE_INSIDER_UNIVERSE,
  canonicalizeName,
  toEntityId,
  toTickerId,
  parseShares,
  parsePercentage,
  flattenAndNormalizeRecords,
  aggregateInsiderHoldings,
  buildInsiderSearchIndex,
  searchInsiders,
  buildInsiderNetworkGraph,
  getInsiderProfile,
  loadDiskInsiderUniverse,
  setCustomUniverse,
  getInsidersForTicker,
  getRosterForTicker
};