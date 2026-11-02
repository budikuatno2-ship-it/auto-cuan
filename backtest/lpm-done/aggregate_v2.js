'use strict';

/**
 * Aggregate Done Details v2 — Order Flow & LPM Engine
 * ===================================================
 * Fixes for Limit-Locked (ARA/ARB) & Auction Artifacts:
 * 1. Distinguishes Session Phases empirically:
 *    - Auction (Pre-opening < 09:00:00 & Pre-closing 15:50:00 - 16:00:59)
 *    - Continuous Trading (09:00:00 - 15:49:59)
 *    - Post-Trading (> 16:00:59 s.d. 16:15:00)
 * 2. Detects Limit-Locked Trades (ARA / ARB):
 *    - Price locked at ARB or ARA creates artificial one-sided taker tape
 *    - Locked trades are stripped from aggressive orderflow & big-money percentiles
 *    - Tracked separately in lockedVal, lockedSide, lockedShare
 * 3. Preserves board NG separation (ngVal).
 */

const fs = require('fs');
const path = require('path');

function getIdxTickSize(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 1;
  if (p < 200) return 1;
  if (p < 500) return 2;
  if (p < 2000) return 5;
  if (p < 5000) return 10;
  return 25;
}

function roundToIdxTick(price, mode) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const tick = getIdxTickSize(p);
  let rounded;
  if (mode === 'ceil' || mode === 'up') rounded = Math.ceil(p / tick) * tick;
  else if (mode === 'floor' || mode === 'down') rounded = Math.floor(p / tick) * tick;
  else rounded = Math.round(p / tick) * tick;
  return Math.max(1, rounded);
}

/**
 * Official IDX Auto Rejection Band Calculation (BEI normalized floor rules)
 */
function calculateIdxAraArb(prevClose) {
  const ref = Number(prevClose);
  if (!Number.isFinite(ref) || ref <= 0) {
    return { araPx: null, arbPx: null, araPct: null, arbPct: null };
  }

  let araPct = 0.35;
  if (ref > 5000) araPct = 0.20;
  else if (ref > 200) araPct = 0.25;

  const araPx = roundToIdxTick(ref * (1 + araPct), 'floor');
  // IDX Floor rule: -15% asymmetrical ARB floor with Rp1 absolute minimum
  const arbRaw = Math.max(1, Math.floor(ref * 0.85));
  const arbPx = roundToIdxTick(arbRaw, 'ceil');

  return {
    araPx,
    arbPx,
    araPct: Math.round(araPct * 100),
    arbPct: -15
  };
}

/**
 * Classify transaction session phase based on time
 */
function getSessionPhase(timeStr) {
  if (!timeStr) return 'CONT';
  const t = String(timeStr).trim();
  if (t < '09:00:00') return 'AUCTION'; // Pre-opening auction matching (08:58 - 08:59)
  if (t >= '15:50:00' && t <= '16:00:59') return 'AUCTION'; // Pre-closing auction matching
  if (t > '16:00:59') return 'POST'; // Post-trading session (16:01 - 16:15)
  return 'CONT'; // Continuous trading (09:00:00 - 15:49:59)
}

/**
 * Pure Aggregator v2
 */
function aggregateDoneDetailsV2(rows, prevClose) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const { araPx, arbPx } = calculateIdxAraArb(prevClose);

  let ngVal = 0;
  const rgRows = [];

  for (const r of rows) {
    const board = String(r.market_board || 'RG').toUpperCase();
    const val = Number(r.value_raw || 0);
    if (board === 'NG') {
      ngVal += val;
    } else {
      rgRows.push(r);
    }
  }

  if (rgRows.length === 0) {
    return {
      n: 0, val: 0, vol: 0, vwap: 0,
      contVal: 0, auctionVal: 0, postVal: 0,
      lockedVal: 0, lockedSide: null, lockedShare: 0,
      prevClose: prevClose || null, araPx, arbPx,
      buyAggVal: 0, sellAggVal: 0,
      p50: 0, p90: 0, p95: 0, p99: 0,
      bigBuyVal: 0, bigSellVal: 0, bigN: 0,
      fBuyVal: 0, fSellVal: 0,
      fAggBuyVal: 0, fAggSellVal: 0,
      ngVal: Math.round(ngVal),
      first: null, last: null
    };
  }

  // RG Summary
  let totalVal = 0;
  let totalVol = 0;
  let contVal = 0;
  let auctionVal = 0;
  let postVal = 0;
  let lockedVal = 0;
  let araLockedVal = 0;
  let arbLockedVal = 0;

  const times = [];
  const cleanContinuousRows = [];

  for (const r of rgRows) {
    const vRaw = Number(r.value_raw || 0);
    const shares = Number(r.qty_num || 0) * 100;
    const px = Number(r.price_num || 0);
    const phase = getSessionPhase(r.time);

    totalVal += vRaw;
    totalVol += shares;
    if (r.time) times.push(String(r.time));

    if (phase === 'AUCTION') {
      auctionVal += vRaw;
    } else if (phase === 'POST') {
      postVal += vRaw;
    } else {
      // Continuous phase
      contVal += vRaw;

      // Check if price is limit-locked
      let isLocked = false;
      if (araPx != null && px >= araPx) {
        isLocked = true;
        lockedVal += vRaw;
        araLockedVal += vRaw;
      } else if (arbPx != null && px <= arbPx) {
        isLocked = true;
        lockedVal += vRaw;
        arbLockedVal += vRaw;
      }

      if (!isLocked) {
        cleanContinuousRows.push(r);
      }
    }
  }

  // Determine locked side and share
  let lockedSide = null;
  if (araLockedVal > 0 && araLockedVal >= arbLockedVal) lockedSide = 'ARA';
  else if (arbLockedVal > 0) lockedSide = 'ARB';
  const lockedShare = totalVal > 0 ? Math.round((lockedVal / totalVal) * 1000) / 1000 : 0;

  // Calculate order flow & big money HANYA dari cleanContinuousRows
  let buyAggVal = 0;
  let sellAggVal = 0;
  let fBuyVal = 0;
  let fSellVal = 0;
  let fAggBuyVal = 0;
  let fAggSellVal = 0;

  const cleanVals = [];

  for (const r of cleanContinuousRows) {
    const vRaw = Number(r.value_raw || 0);
    const action = String(r.action || '').toUpperCase();
    const bType = String(r.buyer_type || '').toUpperCase();
    const sType = String(r.seller_type || '').toUpperCase();

    cleanVals.push(vRaw);

    if (action === 'BUY') buyAggVal += vRaw;
    else if (action === 'SELL') sellAggVal += vRaw;

    if (bType === 'F') {
      fBuyVal += vRaw;
      if (action === 'BUY') fAggBuyVal += vRaw;
    }
    if (sType === 'F') {
      fSellVal += vRaw;
      if (action === 'SELL') fAggSellVal += vRaw;
    }
  }

  // Percentiles from clean continuous
  let p50 = 0, p90 = 0, p95 = 0, p99 = 0;
  let bigBuyVal = 0, bigSellVal = 0, bigN = 0;

  if (cleanVals.length > 0) {
    cleanVals.sort((a, b) => a - b);
    const cn = cleanVals.length;
    p50 = cleanVals[Math.floor(0.50 * (cn - 1))];
    p90 = cleanVals[Math.floor(0.90 * (cn - 1))];
    p95 = cleanVals[Math.floor(0.95 * (cn - 1))];
    p99 = cleanVals[Math.floor(0.99 * (cn - 1))];

    for (const r of cleanContinuousRows) {
      const vRaw = Number(r.value_raw || 0);
      if (vRaw >= p95) {
        bigN++;
        const action = String(r.action || '').toUpperCase();
        if (action === 'BUY') bigBuyVal += vRaw;
        else if (action === 'SELL') bigSellVal += vRaw;
      }
    }
  }

  times.sort();
  const vwap = totalVol > 0 ? Math.round(totalVal / totalVol) : 0;

  return {
    n: rgRows.length,
    cleanContinuousN: cleanContinuousRows.length,
    val: Math.round(totalVal),
    vol: Math.round(totalVol),
    vwap,
    contVal: Math.round(contVal),
    auctionVal: Math.round(auctionVal),
    postVal: Math.round(postVal),
    lockedVal: Math.round(lockedVal),
    lockedSide,
    lockedShare,
    prevClose: prevClose || null,
    araPx,
    arbPx,
    buyAggVal: Math.round(buyAggVal),
    sellAggVal: Math.round(sellAggVal),
    p50: Math.round(p50),
    p90: Math.round(p90),
    p95: Math.round(p95),
    p99: Math.round(p99),
    bigBuyVal: Math.round(bigBuyVal),
    bigSellVal: Math.round(bigSellVal),
    bigN,
    fBuyVal: Math.round(fBuyVal),
    fSellVal: Math.round(fSellVal),
    fAggBuyVal: Math.round(fAggBuyVal),
    fAggSellVal: Math.round(fAggSellVal),
    ngVal: Math.round(ngVal),
    first: times[0] || null,
    last: times[times.length - 1] || null
  };
}

module.exports = {
  getIdxTickSize,
  roundToIdxTick,
  calculateIdxAraArb,
  getSessionPhase,
  aggregateDoneDetailsV2
};
