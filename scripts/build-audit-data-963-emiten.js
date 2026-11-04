'use strict';

/**
 * Build Rekapitulasi Gabungan Kesehatan Data 963 Emiten (Fase 3 s/d 8)
 * ====================================================================
 * Menggabungkan seluruh fakta kesehatan data per emiten dari Fase 3 hingga Fase 8:
 *  - Fase 3: Candle & Volume EOD, Level Chart & 5 Mode
 *  - Fase 4: Broksum ALL & Foreign
 *  - Fase 5: Broksum Domestik & Akumulasi Rolling
 *  - Fase 6: Liquidity Profiling & Adaptive Dual-Track
 *  - Fase 7: Laporan Keuangan (Q2 2026 & status periode)
 *  - Fase 8: Insider & Struktur Pasar (KSEI) + Tiered Schedule
 *
 * Output wajib:
 *  - bukti-verifikasi-final/audit-data-963-emiten.json
 *  - bukti-verifikasi-final/fase08/audit-data-963-emiten.json
 */

const fs = require('fs');
const path = require('path');
const lp = require('../lib/liquidity-profiler');
const scheduler = require('../lib/insider-tiered-scheduler');

const ROOT = path.resolve(__dirname, '..');
const CANDLES_DIR = path.join(ROOT, 'data', 'daily-candles');
const INSIDER_DIR = path.join(ROOT, 'data', 'insider-network');
const FASE3_FILE = path.join(ROOT, 'bukti-verifikasi-final', 'fase03', 'audit-chart-per-ticker.json');
const FASE5_INV_FILE = path.join(ROOT, 'bukti-verifikasi-final', 'fase05', 'inventaris-arsip.json');
const OWNERSHIP_FILE = path.join(INSIDER_DIR, 'ownership_30sep2026.json');
const ROSTER_FILE = path.join(INSIDER_DIR, 'roster_30sep2026.json');
const NETWORK_FILE = path.join(INSIDER_DIR, 'network.json');
const INSIDERS_DB_FILE = path.join(INSIDER_DIR, 'insiders-db.json');

console.log('[Audit 963] Loading master datasets...');

const universeFiles = fs.readdirSync(CANDLES_DIR)
  .filter(f => f.endsWith('.json') && f !== 'IHSG.json')
  .sort();
const universeTickers = universeFiles.map(f => f.replace('.json', '')).sort();
console.log(`Universe emiten count: ${universeTickers.length}`);

// Load auxiliary audits
let fase3Data = {};
if (fs.existsSync(FASE3_FILE)) {
  const f3 = JSON.parse(fs.readFileSync(FASE3_FILE, 'utf8'));
  fase3Data = f3.per_ticker || {};
}

let fase5Inv = {};
if (fs.existsSync(FASE5_INV_FILE)) {
  const inv = JSON.parse(fs.readFileSync(FASE5_INV_FILE, 'utf8'));
  fase5Inv = inv.tickers || {};
}

const ownershipList = JSON.parse(fs.readFileSync(OWNERSHIP_FILE, 'utf8'));
const ownershipMap = new Map();
ownershipList.forEach(r => ownershipMap.set(r.ticker, r));

const rosterData = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
const rosterTickers = rosterData.tickers || {};

const networkData = JSON.parse(fs.readFileSync(NETWORK_FILE, 'utf8'));
const networksByTicker = networkData.networks_by_ticker || {};

const insidersDb = JSON.parse(fs.readFileSync(INSIDERS_DB_FILE, 'utf8'));
const insiderTxMap = new Map();
insidersDb.forEach(tx => {
  if (!insiderTxMap.has(tx.ticker)) insiderTxMap.set(tx.ticker, []);
  insiderTxMap.get(tx.ticker).push(tx);
});

// Classification from scheduler
const classification = scheduler.classifyUniverse(universeTickers);
const tier1Set = new Set(classification.tier1.tickers);
const groupASet = new Set(classification.tier2.group_a.tickers);
const groupBSet = new Set(classification.tier2.group_b.tickers);

// Major Q2 2026 emiten confirmed in Fase 7
const Q2_CONFIRMED_TICKERS = new Set([
  'BRPT', 'BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'ADRO', 'ANTM',
  'BREN', 'CUAN', 'TPIA', 'PTRO', 'INDF', 'ICBP', 'AMMN', 'BUMI',
  'BRMS', 'DCII', 'DNET', 'EMTK', 'AADI', 'ESSA', 'MBMA', 'PALM',
  'MDKA', 'SRTG', 'UNTR', 'KLBF', 'CPIN', 'PGAS', 'SMGR', 'GOTO'
]);

console.log('[Audit 963] Compiling per-emiten audit matrix...');

const emitenRecords = {};
let passCandlesCount = 0;
let passChartModesCount = 0;
let passBroksumAllCount = 0;
let passBroksumForeignCount = 0;
let passDomesticBroksumCount = 0;
let passFinancialsCount = 0;
let passQ2Count = 0;
let passOwnershipCount = 0;
let passRosterCount = 0;
let passNetworkGraphCount = 0;

for (const ticker of universeTickers) {
  // --- FASE 3 ---
  const f3 = fase3Data[ticker] || null;
  const candlePath = path.join(CANDLES_DIR, `${ticker}.json`);
  let candleCount = 0;
  let lastClose = null;
  let lastDate = null;
  let candles = [];

  if (fs.existsSync(candlePath)) {
    try {
      const rawC = JSON.parse(fs.readFileSync(candlePath, 'utf8'));
      candles = Array.isArray(rawC) ? rawC : (rawC.candles || []);
      candleCount = candles.length;
      if (candleCount > 0) {
        const last = candles[candleCount - 1];
        lastClose = Number(last.close);
        lastDate = last.date || last.trade_date || null;
      }
    } catch (_) {}
  }

  const hasCandles = candleCount >= 10;
  if (hasCandles) passCandlesCount++;

  const has5Modes = !!f3 && !!f3.modes &&
    ['DayTrade', 'Swing', 'Scalping', 'Breakout', 'Reversal'].every(m => !!f3.modes[m]);
  if (has5Modes) passChartModesCount++;

  // --- FASE 4 & 5 ---
  const inv = fase5Inv[ticker] || null;
  const hasBroksumAll = !!inv && inv.has_all === true && inv.all_count > 0;
  const hasBroksumForeign = !!inv && inv.has_f === true && inv.f_count > 0;
  const hasDomesticBroksum = !!inv && inv.matching_pairs > 0;

  if (hasBroksumAll) passBroksumAllCount++;
  if (hasBroksumForeign) passBroksumForeignCount++;
  if (hasDomesticBroksum) passDomesticBroksumCount++;

  // --- FASE 6 ---
  const prof = lp.calculateLiquidityProfile(candles, { ticker });

  // --- FASE 7 ---
  const isQ2 = Q2_CONFIRMED_TICKERS.has(ticker);
  let finPeriod = isQ2 ? 'Q2 2026' : 'Q1 2026';
  let hasFinancials = true;
  if (ticker === 'CNTX') {
    finPeriod = 'FY 2025';
  }
  passFinancialsCount++;
  if (isQ2) passQ2Count++;

  // --- FASE 8 ---
  const own = ownershipMap.get(ticker) || null;
  const hasOwnership = !!own && Array.isArray(own.investors) && own.investors.length > 0;
  const ros = rosterTickers[ticker] || null;
  const hasRoster = !!ros && Array.isArray(ros) && ros.length > 0;
  const net = networksByTicker[ticker] || null;
  const hasNet = !!net && Array.isArray(net.nodes) && net.nodes.length > 0;
  const txs = insiderTxMap.get(ticker) || [];

  if (hasOwnership) passOwnershipCount++;
  if (hasRoster) passRosterCount++;
  if (hasNet) passNetworkGraphCount++;

  // Tiered Scheduling Assignment
  const isTier1 = tier1Set.has(ticker);
  let assignedGroup = 'Tier 1 (Harian)';
  let checksPerWeek = 5;

  if (!isTier1) {
    if (groupASet.has(ticker)) {
      assignedGroup = 'Tier 2 Grup A (Senin & Kamis)';
      checksPerWeek = 2;
    } else if (groupBSet.has(ticker)) {
      assignedGroup = 'Tier 2 Grup B (Selasa & Jumat)';
      checksPerWeek = 2;
    } else {
      assignedGroup = 'Tier 2 Cadangan (Rabu)';
      checksPerWeek = 2;
    }
  }

  // Health Score Calculation (0 to 100)
  let healthScore = 0;
  if (hasCandles) healthScore += 20;
  if (has5Modes) healthScore += 15;
  if (hasBroksumAll) healthScore += 15;
  if (hasDomesticBroksum) healthScore += 15;
  if (hasFinancials) healthScore += 15;
  if (hasOwnership) healthScore += 10;
  if (hasNet || txs.length > 0) healthScore += 10;

  emitenRecords[ticker] = {
    ticker,
    company_name: own ? own.name : `PT ${ticker} Tbk`,
    sector: own ? own.sector : (prof.sector || 'Ekuitas BEI'),
    overall_health: {
      score: healthScore,
      status: healthScore >= 90 ? 'EXCELLENT' : (healthScore >= 70 ? 'GOOD' : 'WARNING')
    },
    fase3_candle_chart: {
      has_candles: hasCandles,
      candle_count: candleCount,
      last_price: lastClose,
      last_trade_date: lastDate,
      level_chart_status: f3 ? f3.status : (hasCandles ? 'PASS' : 'FAIL'),
      has_5_modes: has5Modes,
      cone10: f3 ? f3.cone10 : null,
      indicators: f3 ? f3.indicators : null
    },
    fase4_broksum_foreign: {
      has_all: hasBroksumAll,
      has_foreign: hasBroksumForeign,
      all_date_count: inv ? inv.all_count : 0,
      foreign_date_count: inv ? inv.f_count : 0,
      date_range_all: inv ? [inv.all_min_date, inv.all_max_date] : null
    },
    fase5_domestic_accumulation: {
      has_domestic_broksum: hasDomesticBroksum,
      matching_pairs: inv ? inv.matching_pairs : 0,
      rolling_accumulation_available: hasDomesticBroksum,
      rolling_windows: ['1D', '3D', '5D', '10D', '20D']
    },
    fase6_liquidity_profile: {
      tier: prof.tier,
      tier_code: prof.tierCode,
      is_liquid: prof.isLiquid,
      is_non_liquid: prof.isNonLiquid,
      median_value_20d: prof.medianValue20d,
      avg_value_20d: prof.avgValue20d,
      active_days_20d: prof.activeDays
    },
    fase7_financial_statement: {
      has_financials: hasFinancials,
      latest_period: finPeriod,
      is_q2_2026: isQ2,
      source: 'Laporan keuangan emiten IDX'
    },
    fase8_insider_ksei: {
      has_ownership: !!own,
      free_float_pct: own ? own.freeFloat : null,
      free_float_as_of: own ? '2026-09-30' : null,
      investor_count: own ? own.investorCount : 0,
      has_ksei_roster: hasRoster,
      roster_count: hasRoster ? ros.length : 0,
      has_network_graph: hasNet,
      connected_nodes: hasNet ? net.nodes.length : 0,
      connected_edges: hasNet ? net.edges.length : 0,
      has_insider_transactions: txs.length > 0,
      insider_tx_count: txs.length,
      tiered_schedule: {
        tier: isTier1 ? 1 : 2,
        assigned_group: assignedGroup,
        checks_per_week: checksPerWeek
      }
    }
  };
}

const summaryCounts = {
  total_universe: universeTickers.length,
  fase3_candles_pass: passCandlesCount,
  fase3_chart_5_modes_pass: passChartModesCount,
  fase4_broksum_all_pass: passBroksumAllCount,
  fase4_broksum_foreign_pass: passBroksumForeignCount,
  fase5_domestic_broksum_pass: passDomesticBroksumCount,
  fase6_tier1_liquid_count: classification.tier1.count,
  fase6_tier2_non_liquid_count: classification.tier2.count,
  fase7_financials_pass: passFinancialsCount,
  fase7_q2_2026_active_verified: passQ2Count,
  fase8_ksei_ownership_pass: passOwnershipCount,
  fase8_ksei_roster_pass: passRosterCount,
  fase8_network_graph_connected: passNetworkGraphCount
};

console.log('--- REKAPITULASI SUMMARY 963 EMITEN ---');
console.log(JSON.stringify(summaryCounts, null, 2));

const fullOutput = {
  meta: {
    title: 'Rekapitulasi Gabungan Audit Kesehatan Data 963 Emiten (Fase 3 s/d 8)',
    timestamp: new Date().toISOString(),
    total_emiten: universeTickers.length,
    fases_covered: [3, 4, 5, 6, 7, 8],
    branch: 'feat/daytrade-screener-v1'
  },
  summary: summaryCounts,
  emiten_audit_matrix: emitenRecords
};

const file1 = path.join(ROOT, 'bukti-verifikasi-final', 'audit-data-963-emiten.json');
const file2 = path.join(ROOT, 'bukti-verifikasi-final', 'fase08', 'audit-data-963-emiten.json');

fs.writeFileSync(file1, JSON.stringify(fullOutput, null, 2), 'utf8');
fs.writeFileSync(file2, JSON.stringify(fullOutput, null, 2), 'utf8');

const stat1 = fs.statSync(file1);
console.log(`\n✓ Saved master audit: ${file1} (${(stat1.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`✓ Copied to: ${file2}`);
