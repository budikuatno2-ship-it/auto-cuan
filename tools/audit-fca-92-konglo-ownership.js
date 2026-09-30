'use strict';

/**
 * FCA-92 Konglo ownership audit
 *
 * Read-only diagnostic:
 * - reads the 92 Sep-2026 FCA exits from data/fca-transition-2026-09-28.json
 * - reads the local 31-Aug-2026 market-structure ownership snapshot
 * - reads the curated Konglo membership seed from the versioned SQL mapping
 * - finds exact normalized shareholder-name overlap between the 92 targets and
 *   already-curated members of each Konglo group
 *
 * IMPORTANT:
 * This tool NEVER mutates Supabase, market-structure/latest.json, or screener
 * mappings. Ambiguous/weak evidence stays unresolved for human review.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MARKET = path.join(ROOT, 'data', 'market-structure', 'latest.json');
const DEFAULT_MANIFEST = path.join(ROOT, 'data', 'fca-transition-2026-09-28.json');
const DEFAULT_MAPPING_SQL = path.join(ROOT, 'supabase', 'patch-sector-hot-group-mapping-v2.sql');
const DEFAULT_OUT = path.join(ROOT, 'data', 'market-structure', 'audit', 'fca-92-konglo-candidates.json');

const NOMINEE_MARKERS = [
  'NOMINEE', 'A C CLIENT', 'AC CLIENT', 'CLIENTS', 'SECURITIES', 'SEKURITAS',
  'KUSTODIAN', 'CUSTODY', 'CUSTODIAN', 'CLEARING', 'DEPOSITORY',
  'DBS VICKERS', 'UOB KAY HIAN', 'CGS INTERNATIONAL', 'UBS AG',
  'CITIBANK', 'CITIBANK N A', 'HSBC', 'JPMORGAN', 'JP MORGAN',
  'STANDARD CHARTERED', 'MORGAN STANLEY', 'CREDIT SUISSE'
];

const LEGAL_TOKENS = new Set([
  'PT', 'TBK', 'PERSERO', 'PERSEROAN', 'TERBATAS',
  'LTD', 'LIMITED', 'PTE', 'CORP', 'CORPORATION', 'INC', 'LLC', 'PLC',
  'CO', 'COMPANY', 'NV', 'SA'
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
}

function normalizeOwnerName(value) {
  const raw = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

  if (!raw) return '';

  const tokens = raw
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !LEGAL_TOKENS.has(token));

  return tokens.join(' ').trim();
}

function isGenericNomineeOwner(value) {
  const normalized = normalizeOwnerName(value);
  if (!normalized || normalized.length < 6) return true;
  return NOMINEE_MARKERS.some(marker => normalized.includes(normalizeOwnerName(marker)));
}

function firstDefined(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

function investorName(row) {
  return String(firstDefined(row, [
    'name', 'investor_name', 'investor', 'holder_name', 'shareholder_name',
    'owner_name', 'nama', 'nama_investor', 'nama_pemegang_saham'
  ]) || '').trim();
}

function investorPct(row) {
  const raw = firstDefined(row, [
    'pct', 'percentage', 'percent', 'ownership_pct', 'ownership_percentage',
    'percentage_owned', 'persentase', 'persentase_kepemilikan'
  ]);
  if (raw == null) return null;
  const cleaned = String(raw).replace('%', '').replace(',', '.').trim();
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function investorShares(row) {
  const raw = firstDefined(row, [
    'shares', 'share_count', 'shares_owned', 'jumlah_saham', 'total_shares'
  ]);
  if (raw == null) return null;
  const numeric = Number(String(raw).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : raw;
}

function normalizeInvestors(stock) {
  const raw = stock && stock.ownership && Array.isArray(stock.ownership.investors)
    ? stock.ownership.investors
    : [];

  return raw.map((row, index) => {
    const name = investorName(row);
    return {
      rank: index + 1,
      name,
      normalized_name: normalizeOwnerName(name),
      pct: investorPct(row),
      shares: investorShares(row),
      raw: row
    };
  }).filter(row => row.name && row.normalized_name);
}

function parseCuratedMembership(sqlText) {
  const rows = [];
  const re = /\('([^']+)'\s*,\s*'([A-Z0-9]+)'\s*,\s*'((?:''|[^'])*)'\s*,\s*'(CORE|AFFILIATE|RADAR|ANCHOR|Member)'\s*,\s*true\s*,\s*(\d+)\)/g;
  let match;
  while ((match = re.exec(sqlText))) {
    rows.push({
      group_code: match[1],
      ticker: normalizeTicker(match[2]),
      stock_name: match[3].replace(/''/g, "'"),
      member_type: match[4],
      sort_order: Number(match[5])
    });
  }
  return rows;
}

function buildGroupOwnerSignatures(marketByTicker, memberships) {
  const groupSignatures = new Map();

  for (const member of memberships) {
    const stock = marketByTicker.get(member.ticker);
    const investors = normalizeInvestors(stock)
      .filter(row => !isGenericNomineeOwner(row.name));

    if (!groupSignatures.has(member.group_code)) {
      groupSignatures.set(member.group_code, new Map());
    }
    const signature = groupSignatures.get(member.group_code);

    for (const inv of investors) {
      if (!inv.normalized_name) continue;
      if (!signature.has(inv.normalized_name)) {
        signature.set(inv.normalized_name, {
          normalized_name: inv.normalized_name,
          display_names: new Set(),
          source_tickers: new Set(),
          max_pct: null
        });
      }
      const entry = signature.get(inv.normalized_name);
      entry.display_names.add(inv.name);
      entry.source_tickers.add(member.ticker);
      if (inv.pct != null) entry.max_pct = entry.max_pct == null ? inv.pct : Math.max(entry.max_pct, inv.pct);
    }
  }

  return groupSignatures;
}

function inferCandidates(targetInvestors, groupSignatures) {
  const candidates = [];

  for (const [groupCode, signature] of groupSignatures.entries()) {
    const overlaps = [];

    for (const inv of targetInvestors) {
      if (isGenericNomineeOwner(inv.name)) continue;
      const sig = signature.get(inv.normalized_name);
      if (!sig) continue;
      overlaps.push({
        investor_name: inv.name,
        normalized_name: inv.normalized_name,
        target_pct: inv.pct,
        target_rank: inv.rank,
        known_group_member_tickers: Array.from(sig.source_tickers).sort(),
        known_display_names: Array.from(sig.display_names).sort()
      });
    }

    if (!overlaps.length) continue;

    const distinctKnownMembers = new Set(
      overlaps.flatMap(row => row.known_group_member_tickers)
    );
    const targetPctSum = overlaps.reduce(
      (sum, row) => sum + (Number.isFinite(row.target_pct) ? row.target_pct : 0),
      0
    );
    const topMatchedPct = overlaps.reduce(
      (max, row) => Math.max(max, Number.isFinite(row.target_pct) ? row.target_pct : 0),
      0
    );

    let confidence = 'WEAK';
    if (distinctKnownMembers.size >= 2 && topMatchedPct >= 1) confidence = 'STRONG';
    else if (topMatchedPct >= 5) confidence = 'STRONG';
    else if (topMatchedPct >= 1 || overlaps.length >= 2) confidence = 'MEDIUM';

    candidates.push({
      group_code: groupCode,
      confidence,
      overlap_count: overlaps.length,
      known_member_count: distinctKnownMembers.size,
      target_matched_pct_sum: Number(targetPctSum.toFixed(4)),
      top_matched_pct: Number(topMatchedPct.toFixed(4)),
      overlaps
    });
  }

  const rank = { STRONG: 3, MEDIUM: 2, WEAK: 1 };
  candidates.sort((a, b) =>
    (rank[b.confidence] - rank[a.confidence]) ||
    (b.target_matched_pct_sum - a.target_matched_pct_sum) ||
    (b.known_member_count - a.known_member_count) ||
    a.group_code.localeCompare(b.group_code)
  );
  return candidates;
}

function classifyCandidateState(existingMappings, candidates) {
  if (existingMappings.length) return 'EXISTING_MAPPING';
  const strong = candidates.filter(row => row.confidence === 'STRONG');
  if (strong.length === 1) return 'STRONG_CANDIDATE';
  if (strong.length > 1) return 'AMBIGUOUS_STRONG';
  const medium = candidates.filter(row => row.confidence === 'MEDIUM');
  if (medium.length === 1) return 'MEDIUM_CANDIDATE';
  if (medium.length > 1) return 'AMBIGUOUS_MEDIUM';
  return 'UNRESOLVED';
}

function buildAudit(options) {
  options = options || {};
  const marketPath = path.resolve(options.marketPath || DEFAULT_MARKET);
  const manifestPath = path.resolve(options.manifestPath || DEFAULT_MANIFEST);
  const mappingSqlPath = path.resolve(options.mappingSqlPath || DEFAULT_MAPPING_SQL);

  if (!fs.existsSync(marketPath)) {
    throw new Error('Market structure snapshot not found: ' + marketPath);
  }

  const market = readJson(marketPath);
  const manifest = readJson(manifestPath);
  const mappingSql = fs.readFileSync(mappingSqlPath, 'utf8');

  const stocks = Array.isArray(market.stocks) ? market.stocks : [];
  const marketByTicker = new Map(
    stocks.map(stock => [normalizeTicker(stock && stock.ticker), stock])
  );

  const tickers = Array.from(new Set(
    (manifest.all_exit_tickers || []).map(normalizeTicker).filter(Boolean)
  )).sort();

  if (tickers.length !== 92) {
    throw new Error('Expected 92 FCA exits, got ' + tickers.length);
  }

  const memberships = parseCuratedMembership(mappingSql);
  const activeMappingByTicker = new Map();
  for (const row of memberships) {
    if (!activeMappingByTicker.has(row.ticker)) activeMappingByTicker.set(row.ticker, []);
    activeMappingByTicker.get(row.ticker).push(row);
  }

  const groupSignatures = buildGroupOwnerSignatures(marketByTicker, memberships);

  const rows = tickers.map(ticker => {
    const stock = marketByTicker.get(ticker) || null;
    const investors = normalizeInvestors(stock);
    const existingMappings = (activeMappingByTicker.get(ticker) || []).map(row => ({
      group_code: row.group_code,
      member_type: row.member_type
    }));
    const candidates = inferCandidates(investors, groupSignatures);

    return {
      ticker,
      company_name: stock && (stock.company_name || stock.name || stock.stock_name) || null,
      ownership_as_of: stock && stock.ownership && stock.ownership.as_of || null,
      investor_count: stock && stock.ownership && stock.ownership.investor_count != null
        ? stock.ownership.investor_count
        : investors.length,
      derived_free_float_pct: stock && stock.ownership
        ? stock.ownership.derived_free_float_pct ?? null
        : null,
      existing_mappings: existingMappings,
      candidate_state: classifyCandidateState(existingMappings, candidates),
      candidate_groups: candidates.slice(0, 8),
      top_investors: investors
        .slice()
        .sort((a, b) => {
          const ap = Number.isFinite(a.pct) ? a.pct : -1;
          const bp = Number.isFinite(b.pct) ? b.pct : -1;
          return bp - ap || a.rank - b.rank;
        })
        .slice(0, 10)
        .map(row => ({
          rank: row.rank,
          name: row.name,
          pct: row.pct,
          shares: row.shares
        })),
      ownership_missing: !stock || !stock.ownership || !Array.isArray(stock.ownership.investors)
    };
  });

  const counts = {};
  for (const row of rows) counts[row.candidate_state] = (counts[row.candidate_state] || 0) + 1;

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    scope: '92 equities removed from IDX Special Monitoring Board / FCA effective 2026-09-28',
    ownership_source: {
      snapshot_path: path.relative(ROOT, marketPath).replace(/\\/g, '/'),
      expected_as_of: '2026-08-31'
    },
    mapping_source: {
      curated_sql: path.relative(ROOT, mappingSqlPath).replace(/\\/g, '/')
    },
    safety: {
      read_only: true,
      auto_apply_mapping: false,
      exact_shareholder_overlap_only: true,
      generic_nominee_names_excluded: true,
      ambiguous_candidates_require_review: true
    },
    ticker_count: rows.length,
    counts,
    rows
  };
}

function writeAudit(audit, outPath) {
  const target = path.resolve(outPath || DEFAULT_OUT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(audit, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

function printSummary(audit, outPath) {
  const counts = audit.counts || {};
  console.log(JSON.stringify({
    ticker_count: audit.ticker_count,
    counts,
    ownership_missing: audit.rows.filter(row => row.ownership_missing).map(row => row.ticker),
    existing_mapping_tickers: audit.rows.filter(row => row.candidate_state === 'EXISTING_MAPPING').map(row => row.ticker),
    strong_candidate_tickers: audit.rows.filter(row => row.candidate_state === 'STRONG_CANDIDATE').map(row => row.ticker),
    ambiguous_tickers: audit.rows.filter(row => /^AMBIGUOUS_/.test(row.candidate_state)).map(row => row.ticker),
    unresolved_tickers: audit.rows.filter(row => row.candidate_state === 'UNRESOLVED').map(row => row.ticker),
    output: outPath
  }, null, 2));

  console.log('\n--- REVIEW LINES ---');
  for (const row of audit.rows) {
    const best = row.candidate_groups && row.candidate_groups[0];
    const top = (row.top_investors || []).slice(0, 3)
      .map(inv => inv.name + (inv.pct == null ? '' : ' ' + inv.pct + '%'))
      .join(' | ');
    console.log([
      row.ticker,
      row.candidate_state,
      row.existing_mappings.map(m => m.group_code).join(',') || '-',
      best ? best.group_code + ':' + best.confidence + ':' + best.target_matched_pct_sum + '%' : '-',
      top || '-'
    ].join('\t'));
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--market' && argv[i + 1]) options.marketPath = argv[++i];
    else if (token === '--manifest' && argv[i + 1]) options.manifestPath = argv[++i];
    else if (token === '--mapping-sql' && argv[i + 1]) options.mappingSqlPath = argv[++i];
    else if (token === '--out' && argv[i + 1]) options.outPath = argv[++i];
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const audit = buildAudit(options);
    const outPath = writeAudit(audit, options.outPath);
    printSummary(audit, outPath);
  } catch (error) {
    console.error('[fca-92-konglo-ownership-audit]', error && error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = {
  normalizeOwnerName,
  isGenericNomineeOwner,
  investorName,
  investorPct,
  normalizeInvestors,
  parseCuratedMembership,
  buildGroupOwnerSignatures,
  inferCandidates,
  classifyCandidateState,
  buildAudit,
  writeAudit
};
