'use strict';

/**
 * Bandarmologi Screener Scoring Engine
 *
 * Injects authentic Bandarmologi metrics into Screener scores:
 * - Swing Konglo
 * - Swing Non-Konglo
 * - Day Trade
 *
 * Scoring Rubric:
 * 1. Bandar Concentration (CR3/CR5): CR3 > 60% & Net Flow > 0 => +25 pts (CR5 > 70% => +15 pts)
 * 2. Institutional Dominance: Bandar/Retail ratio > 70% => +20 pts (> 50% => +10 pts)
 * 3. Retail Participation: Retail dump while bandar accumulates => +15 pts.
 *    Retail aggressive buy while bandar distributes => -20 pts.
 * 4. Insider Confirmation: Insider buy in 30 days => +20 pts. (Dominant >= 50% => +5 pts)
 * 5. Timeframe Weighting:
 *    - Swing: Multi-day accumulation (5D/7D/14D) => +10 pts
 *    - Day Trade: 1D volume surge (ratio >= 1.5x) => +10 pts
 */

const fs = require('fs');
const path = require('path');
const bandarmologiService = require('./bandarmologi-service');
const insiderService = require('./insider-network-service');

const RETAIL_BROKERS = new Set(['XC', 'PD', 'YP', 'NI', 'XL', 'CC']);
const INSTITUTIONAL_BROKERS = new Set(['ZP', 'CS', 'RX', 'KZ', 'MS', 'BK', 'DX', 'AK', 'OD', 'LG', 'EP', 'CC']);

function cleanTicker(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Calculate bandarmologi score breakdown from broker summary data
 * @param {Array|Object} brokerData - broker list or broker summary object
 * @param {Object} options - { mode: 'swing'|'daytrade', insiderRoster: [], volumeRatio20d: number, multiDayNetPositive: boolean }
 */
function calculateBandarmologiScore(brokerData, options) {
  options = options || {};
  const mode = options.mode || 'swing';

  let brokers = [];
  if (Array.isArray(brokerData)) {
    brokers = brokerData;
  } else if (brokerData && Array.isArray(brokerData.brokers)) {
    brokers = brokerData.brokers;
  } else if (brokerData && brokerData.top_buyers) {
    // Normalise from top_buyers/top_sellers format
    const buyers = (brokerData.top_buyers || []).map(b => ({
      broker_code: b.code || b.broker_code,
      bval: Number(b.val || b.bval || b.value || 0),
      bvol: Number(b.vol || b.bvol || b.volume || 0),
      sval: 0,
      nval: Number(b.val || b.bval || b.value || 0)
    }));
    const sellers = (brokerData.top_sellers || []).map(s => ({
      broker_code: s.code || s.broker_code,
      bval: 0,
      bvol: 0,
      sval: Number(s.val || s.sval || s.value || 0),
      nval: -Number(s.val || s.sval || s.value || 0)
    }));
    brokers = buyers.concat(sellers);
  }

  let totalBuyVal = 0;
  let totalSellVal = 0;
  let netFlow = 0;
  let instBuyVal = 0;
  let instSellVal = 0;
  let retailBuyVal = 0;
  let retailSellVal = 0;

  const validBrokers = brokers.map(b => {
    const code = String(b.broker_code || b.code || '').trim().toUpperCase();
    const bval = Number(b.bval || b.buy_value || 0);
    const sval = Number(b.sval || b.sell_value || 0);
    const nval = b.nval !== undefined ? Number(b.nval) : (bval - sval);

    totalBuyVal += bval;
    totalSellVal += sval;
    netFlow += nval;

    if (INSTITUTIONAL_BROKERS.has(code)) {
      instBuyVal += bval;
      instSellVal += sval;
    }
    if (RETAIL_BROKERS.has(code)) {
      retailBuyVal += bval;
      retailSellVal += sval;
    }

    return { code, bval, sval, nval };
  });

  // Sort by gross buy value descending for CR calculation
  const sortedBuyers = validBrokers.slice().sort((a, b) => b.bval - a.bval);
  const cr3Buy = sortedBuyers.slice(0, 3).reduce((sum, b) => sum + b.bval, 0);
  const cr5Buy = sortedBuyers.slice(0, 5).reduce((sum, b) => sum + b.bval, 0);

  const cr3 = totalBuyVal > 0 ? (cr3Buy / totalBuyVal) : 0;
  const cr5 = totalBuyVal > 0 ? (cr5Buy / totalBuyVal) : 0;

  let score = 0;
  const breakdown = [];

  // 1. KONSENTRASI BANDAR (CR3 / CR5)
  if (cr3 > 0.60 && netFlow > 0) {
    score += 25;
    breakdown.push({ rule: 'CR3_CONCENTRATION', points: 25, label: `CR3 ${(cr3 * 100).toFixed(0)}% (+25)` });
  } else if (cr5 > 0.70 && netFlow > 0) {
    score += 15;
    breakdown.push({ rule: 'CR5_CONCENTRATION', points: 15, label: `CR5 ${(cr5 * 100).toFixed(0)}% (+15)` });
  } else if (cr3 > 0.50 && netFlow > 0) {
    score += 10;
    breakdown.push({ rule: 'CR3_MODERATE', points: 10, label: `CR3 ${(cr3 * 100).toFixed(0)}% (+10)` });
  }

  // 2. DOMINASI INSTITUSI
  const totalInstRetailBuy = instBuyVal + retailBuyVal;
  const instRatio = totalInstRetailBuy > 0 ? (instBuyVal / totalInstRetailBuy) : (instBuyVal > 0 ? 1 : 0);

  if (instRatio >= 0.70 && instBuyVal > 0) {
    score += 20;
    breakdown.push({ rule: 'INST_DOMINANCE_70', points: 20, label: `Institusi Dominan ${(instRatio * 100).toFixed(0)}% (+20)` });
  } else if (instRatio >= 0.50 && instBuyVal > 0) {
    score += 10;
    breakdown.push({ rule: 'INST_DOMINANCE_50', points: 10, label: `Institusi Akumulasi (+10)` });
  }

  // 3. PARTISIPASI RITEL
  const retailNet = retailBuyVal - retailSellVal;
  const instNet = instBuyVal - instSellVal;

  if (retailNet < 0 && (instNet > 0 || netFlow > 0)) {
    // Retail dumping while bandar accumulates -> Strong Bullish
    score += 15;
    breakdown.push({ rule: 'RETAIL_DUMP_BANDAR_ACCUM', points: 15, label: 'Ritel Buang Barang (+15)' });
  } else if (retailNet > 0 && (instNet < 0 || netFlow < 0)) {
    // Retail aggressively buying while bandar distributes -> Penalty
    score -= 20;
    breakdown.push({ rule: 'RETAIL_CHASE_DISTRIBUTION', points: -20, label: 'Ritel Buy saat Distribusi (-20)' });
  }

  // 4. KONFIRMASI INSIDER
  const insiderRoster = options.insiderRoster || [];
  let hasRecentInsiderBuy = false;
  let dominantHolding = false;

  for (const ins of insiderRoster) {
    const change = Number(ins.change || ins.net_change || 0);
    const pct = Number(ins.percentage || ins.holding_pct || 0);
    if (change > 0 || ins.is_recent_buyer || ins.action_type === 'BUY' || ins.action === 'BUY') {
      hasRecentInsiderBuy = true;
    }
    if (pct >= 50 || (ins.position && String(ins.position).includes('Pengendali'))) {
      dominantHolding = true;
    }
  }

  if (hasRecentInsiderBuy || options.hasInsiderBuy) {
    score += 20;
    breakdown.push({ rule: 'INSIDER_BUY_30D', points: 20, label: 'Insider Buy 30D (+20)' });
  } else if (dominantHolding) {
    score += 5;
    breakdown.push({ rule: 'INSIDER_DOMINANT_50', points: 5, label: 'Insider >= 50% (+5)' });
  }

  // 5. TIMEFRAME WEIGHTING
  if (mode === 'swing') {
    if (options.multiDayNetPositive || (netFlow > 0 && cr3 > 0.40)) {
      score += 10;
      breakdown.push({ rule: 'SWING_MULTI_DAY_ACCUM', points: 10, label: 'Akumulasi Multi-Hari (+10)' });
    }
  } else if (mode === 'daytrade') {
    const vr = Number(options.volumeRatio20d || options.volume_ratio_20d || 0);
    if (vr >= 1.5) {
      score += 10;
      breakdown.push({ rule: 'DAYTRADE_VOLUME_SURGE', points: 10, label: `Lonjakan Vol ${vr.toFixed(1)}x (+10)` });
    }
    // Top buyer aggression: top 1 buyer accounts for > 40% of buy volume
    if (sortedBuyers.length > 0 && totalBuyVal > 0 && (sortedBuyers[0].bval / totalBuyVal) >= 0.40) {
      score += 10;
      breakdown.push({ rule: 'DAYTRADE_TOP_BUYER_AGGRESSION', points: 10, label: 'Agresi Top Buyer (+10)' });
    }
  }

  const breakdownShort = breakdown.map(b => b.label).join(', ') || 'Netral';
  const badgeLabel = (score >= 0 ? '+' : '') + score + ' BD Score';
  const badgeColor = score >= 35 ? 'emerald' : (score > 0 ? 'cyan' : (score === 0 ? 'gray' : 'rose'));

  return {
    score: score,
    badge_label: badgeLabel,
    badge_color: badgeColor,
    breakdown: breakdown,
    breakdown_text: breakdownShort,
    metrics: {
      cr3: Number(cr3.toFixed(4)),
      cr5: Number(cr5.toFixed(4)),
      inst_ratio: Number(instRatio.toFixed(4)),
      net_flow: netFlow,
      total_buy_val: totalBuyVal,
      total_sell_val: totalSellVal,
      retail_net: retailNet,
      inst_net: instNet,
      has_insider_buy: hasRecentInsiderBuy
    }
  };
}

/**
 * Enrich a candidate row directly with Bandarmologi metrics and injected score
 * @param {Object} candidate - screener row object
 * @param {Object} options - { mode: 'swing'|'daytrade', insiderRoster: [], ... }
 */
function enrichCandidateWithBandarmologi(candidate, options) {
  if (!candidate) return candidate;
  options = options || {};
  const ticker = cleanTicker(candidate.ticker);
  if (!ticker) return candidate;

  // 1. Get broker data
  let brokerData = candidate.broker_summary || candidate._brokerData;
  if (!brokerData && bandarmologiService && typeof bandarmologiService.readDiskCache === 'function') {
    brokerData = bandarmologiService.readDiskCache('broker-summary', ticker, 'latest');
  }

  // 2. Get insider roster
  let insiderRoster = options.insiderRoster;
  if (!insiderRoster && insiderService && typeof insiderService.getRosterForTicker === 'function') {
    insiderRoster = insiderService.getRosterForTicker(ticker) || [];
  }

  // 3. Compute score
  const scoringResult = calculateBandarmologiScore(brokerData, {
    mode: options.mode || 'swing',
    insiderRoster: insiderRoster,
    volumeRatio20d: candidate.volume_ratio_avg20 || candidate.volume_ratio_20d || 0,
    multiDayNetPositive: Boolean(candidate.bandar_3d > 0 && candidate.bandar_7d > 0)
  });

  candidate.bandarmologi_score = scoringResult.score;
  candidate.bandar_score_bonus = scoringResult.score;
  candidate.bandarmologi_badge = scoringResult.badge_label;
  candidate.bandarmologi_badge_color = scoringResult.badge_color;
  candidate.bandarmologi_breakdown = scoringResult.breakdown_text;
  candidate.bandar_breakdown = {
    reasons: scoringResult.breakdown ? scoringResult.breakdown.map(b => b.label) : [],
    score: scoringResult.score
  };
  candidate.bandarmologi_metrics = scoringResult.metrics;

  // Score injection: inject bandarmologi score into overall score
  if (candidate.score != null) {
    candidate.score_before_bandarmologi = candidate.score;
    candidate.score = Math.max(0, Math.min(100, candidate.score + scoringResult.score));
  }
  if (candidate.daytrade_score != null) {
    candidate.daytrade_score_before_bandarmologi = candidate.daytrade_score;
    candidate.daytrade_score = Math.max(0, Math.min(100, candidate.daytrade_score + scoringResult.score));
  }

  return candidate;
}

module.exports = {
  RETAIL_BROKERS,
  INSTITUTIONAL_BROKERS,
  calculateBandarmologiScore,
  enrichCandidateWithBandarmologi
};
