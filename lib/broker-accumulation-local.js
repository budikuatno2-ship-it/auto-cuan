'use strict';

/**
 * Local Broker Accumulation & Domestic Broksum Quantitative Engine (Fase 5)
 * =========================================================================
 * 100% pure local computation (0 upstream quota).
 * Computes:
 * 1. Domestic Broker Summary per broker per day (D = ALL - F) with strict non-negative clamping
 *    and foreign unreleased detection.
 * 2. Rolling window N in {1, 3, 5, 10, 20} trading days for ALL, Foreign (F), and Domestic (D):
 *    - NetLot = sum(BuyLot - SellLot)
 *    - NetVal = sum(BuyVal - SellVal)
 *    - AvgBuyPrice = sum(BuyVal) / (max(1, sum(BuyLot)) * 100)
 *    - AvgSellPrice = sum(SellVal) / (max(1, sum(SellLot)) * 100)
 *    - TopBuyerVal(k) & TopSellerVal(k) for k in {1, 3, 5}
 *    - BS_Ratio_3 = TopBuyerVal(3) / max(1, TopSellerVal(3))
 *    - Verdict arah:
 *      >= 1.35 : Akumulasi Kuat
 *      1.10 - 1.35 : Akumulasi
 *      0.90 - 1.10 : Netral
 *      0.70 - 0.90 : Distribusi
 *      <= 0.70 : Distribusi Kuat
 * 3. Bandar Consistency:
 *    - Broker top buyer 20H
 *    - Frequency of net buy days in 10 days (X / 10 hari)
 *    - Consecutive streak of net buy days
 * 4. Daily Broker Pressure & Bandar VWAP (Top 3 buyer).
 * 5. Full historical rolling time series (date-addressable) for 0 look-ahead backtesting in Fase 6.
 */

const fs = require('node:fs');
const path = require('node:path');

const WINDOWS = [1, 3, 5, 10, 20];

function cleanNumber(val) {
  if (val == null || val === '') return 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Determine broker accumulation direction verdict from BS_Ratio_3.
 * Thresholds:
 *   >= 1.35: Akumulasi Kuat
 *   1.10 - 1.35: Akumulasi
 *   0.90 - 1.10: Netral
 *   0.70 - 0.90: Distribusi
 *   <= 0.70: Distribusi Kuat
 */
function calculateArahVerdict(bsRatio3) {
  const r = cleanNumber(bsRatio3);
  if (r >= 1.35) return 'Akumulasi Kuat';
  if (r >= 1.10) return 'Akumulasi';
  if (r >= 0.90) return 'Netral';
  if (r >= 0.70) return 'Distribusi';
  return 'Distribusi Kuat';
}

/**
 * Parse a daily broker summary (ALL, Foreign, or Domestic) into a standardized Map:
 * brokerCode -> {
 *   broker_code, broker_name,
 *   bval, sval, bvol, svol, nval, nvol,
 *   buy_lot, sell_lot, net_lot,
 *   bfrq, sfrq
 * }
 */
function parseDailyBroksumLevels(dailyJson) {
  const map = new Map();
  if (!dailyJson || typeof dailyJson !== 'object') return map;

  // Case 1: Array of broker objects (standard Arjum format or our normalized format)
  const brokerList = Array.isArray(dailyJson.brokers)
    ? dailyJson.brokers
    : (Array.isArray(dailyJson.data) ? dailyJson.data : null);

  if (brokerList && brokerList.length > 0) {
    brokerList.forEach(b => {
      if (!b) return;
      const code = String(b.broker_code || b.code || b.broker || b.id || '').trim().toUpperCase();
      if (!code) return;

      const bval = cleanNumber(b.bval != null ? b.bval : (b.buy_val != null ? b.buy_val : b.buyVal));
      const sval = cleanNumber(b.sval != null ? b.sval : (b.sell_val != null ? b.sell_val : b.sellVal));
      const bvol = cleanNumber(b.bvol != null ? b.bvol : (b.buy_vol != null ? b.buy_vol : (b.buy_volume != null ? b.buy_volume : b.buyVol)));
      const svol = cleanNumber(b.svol != null ? b.svol : (b.sell_vol != null ? b.sell_vol : (b.sell_volume != null ? b.sell_volume : b.svol)));

      const nval = b.nval !== undefined ? cleanNumber(b.nval) : (bval - sval);
      const nvol = b.nvol !== undefined ? cleanNumber(b.nvol) : (bvol - svol);

      const buy_lot = Math.round(bvol / 100);
      const sell_lot = Math.round(svol / 100);
      const net_lot = Math.round(nvol / 100);

      map.set(code, {
        broker_code: code,
        broker_name: b.broker_name || b.name || code,
        bval,
        sval,
        bvol,
        svol,
        nval,
        nvol,
        buy_lot,
        sell_lot,
        net_lot,
        bfrq: cleanNumber(b.bfrq || b.buy_freq),
        sfrq: cleanNumber(b.sfrq || b.sell_freq)
      });
    });
    return map;
  }

  // Case 2: broker_levels array [{ buy: {...}, sell: {...} }]
  if (Array.isArray(dailyJson.broker_levels)) {
    dailyJson.broker_levels.forEach(lvl => {
      if (lvl.buy && (lvl.buy.broker_code || lvl.buy.broker || lvl.buy.code)) {
        const code = String(lvl.buy.broker_code || lvl.buy.broker || lvl.buy.code).trim().toUpperCase();
        const cur = map.get(code) || {
          broker_code: code,
          broker_name: lvl.buy.broker_name || lvl.buy.name || code,
          bval: 0, sval: 0, bvol: 0, svol: 0, bfrq: 0, sfrq: 0
        };
        cur.bval += cleanNumber(lvl.buy.bval != null ? lvl.buy.bval : lvl.buy.buy_val);
        cur.bvol += cleanNumber(lvl.buy.bvol != null ? lvl.buy.bvol : lvl.buy.buy_vol);
        cur.bfrq += cleanNumber(lvl.buy.bfrq);
        map.set(code, cur);
      }
      if (lvl.sell && (lvl.sell.broker_code || lvl.sell.broker || lvl.sell.code)) {
        const code = String(lvl.sell.broker_code || lvl.sell.broker || lvl.sell.code).trim().toUpperCase();
        const cur = map.get(code) || {
          broker_code: code,
          broker_name: lvl.sell.broker_name || lvl.sell.name || code,
          bval: 0, sval: 0, bvol: 0, svol: 0, bfrq: 0, sfrq: 0
        };
        cur.sval += cleanNumber(lvl.sell.sval != null ? lvl.sell.sval : lvl.sell.sell_val);
        cur.svol += cleanNumber(lvl.sell.svol != null ? lvl.sell.svol : lvl.sell.sell_vol);
        cur.sfrq += cleanNumber(lvl.sell.sfrq);
        map.set(code, cur);
      }
    });

    for (const item of map.values()) {
      item.nval = item.bval - item.sval;
      item.nvol = item.bvol - item.svol;
      item.buy_lot = Math.round(item.bvol / 100);
      item.sell_lot = Math.round(item.svol / 100);
      item.net_lot = Math.round(item.nvol / 100);
    }
  }

  return map;
}

/**
 * Compute Domestic Broker Summary from daily ALL and Foreign data:
 * BuyVol_D = max(0, BuyVol_ALL - BuyVol_F)
 * BuyVal_D = max(0, BuyVal_ALL - BuyVal_F)
 * SellVol_D = max(0, SellVol_ALL - SellVol_F)
 * SellVal_D = max(0, SellVal_ALL - SellVal_F)
 *
 * Negative Control Guard:
 * If F is not present/released, marks "Data Asing Belum Dirilis" and refuses
 * to invent 0s or equate D = ALL.
 */
function computeDomesticBroksum(allJson, fJson, date = '', ticker = '') {
  if (!allJson || typeof allJson !== 'object') {
    return {
      status: 'NO_ALL_DATA',
      data_asing_dirilis: false,
      message: 'Data broker summary ALL tidak tersedia',
      ticker,
      date,
      flow: 'D',
      brokers: [],
      broker_levels: []
    };
  }

  // Verify foreign release state
  const isForeignValid = fJson &&
    typeof fJson === 'object' &&
    fJson.status !== 'foreign_missing' &&
    fJson.status !== 'FOREIGN_NOT_RELEASED' &&
    (Array.isArray(fJson.brokers) || Array.isArray(fJson.broker_levels) || Array.isArray(fJson.data));

  if (!isForeignValid) {
    return {
      status: 'FOREIGN_NOT_RELEASED',
      data_asing_dirilis: false,
      message: 'Data Asing Belum Dirilis',
      ticker,
      date,
      flow: 'D',
      brokers: [],
      broker_levels: []
    };
  }

  const allMap = parseDailyBroksumLevels(allJson);
  const fMap = parseDailyBroksumLevels(fJson);

  const domBrokers = [];
  const domBuyers = [];
  const domSellers = [];

  for (const [code, bAll] of allMap.entries()) {
    const bF = fMap.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0, bfrq: 0, sfrq: 0 };

    // Clamping to 0 ensures no negative values even with synthetic or anomalous foreign values
    const bvol = Math.max(0, cleanNumber(bAll.bvol) - cleanNumber(bF.bvol));
    const bval = Math.max(0, cleanNumber(bAll.bval) - cleanNumber(bF.bval));
    const svol = Math.max(0, cleanNumber(bAll.svol) - cleanNumber(bF.svol));
    const sval = Math.max(0, cleanNumber(bAll.sval) - cleanNumber(bF.sval));

    const bfrq = Math.max(0, cleanNumber(bAll.bfrq) - cleanNumber(bF.bfrq));
    const sfrq = Math.max(0, cleanNumber(bAll.sfrq) - cleanNumber(bF.sfrq));

    const nval = bval - sval;
    const nvol = bvol - svol;
    const buy_lot = Math.round(bvol / 100);
    const sell_lot = Math.round(svol / 100);
    const net_lot = Math.round(nvol / 100);

    const bavg = bvol > 0 ? Math.round((bval / bvol) * 100) / 100 : 0;
    const savg = svol > 0 ? Math.round((sval / svol) * 100) / 100 : 0;

    if (bvol > 0 || svol > 0 || bval > 0 || sval > 0) {
      const brokerObj = {
        broker_code: code,
        broker_name: bAll.broker_name || code,
        bval,
        bvol,
        sval,
        svol,
        nval,
        nvol,
        buy_lot,
        sell_lot,
        net_lot,
        bavg,
        savg,
        bfrq,
        sfrq
      };
      domBrokers.push(brokerObj);

      if (bval > 0 || bvol > 0) {
        domBuyers.push({
          broker_code: code,
          broker_name: brokerObj.broker_name,
          bval,
          bvol,
          buy_lot,
          bavg,
          bfrq
        });
      }
      if (sval > 0 || svol > 0) {
        domSellers.push({
          broker_code: code,
          broker_name: brokerObj.broker_name,
          sval,
          svol,
          sell_lot,
          savg,
          sfrq
        });
      }
    }
  }

  // Sort brokers by net value descending
  domBrokers.sort((a, b) => b.nval - a.nval);
  domBuyers.sort((a, b) => b.bval - a.bval);
  domSellers.sort((a, b) => b.sval - a.sval);

  const maxLevels = Math.max(domBuyers.length, domSellers.length);
  const broker_levels = [];
  for (let i = 0; i < maxLevels; i++) {
    broker_levels.push({
      buy: domBuyers[i] || null,
      sell: domSellers[i] || null
    });
  }

  return {
    status: 'RELEASED',
    data_asing_dirilis: true,
    stock_code: ticker || allJson.stock_code || '',
    date: date || allJson.broker_start_date || '',
    broker_start_date: date || allJson.broker_start_date || '',
    broker_end_date: date || allJson.broker_end_date || '',
    flow: 'D',
    brokers: domBrokers,
    broker_levels,
    total_buyers: domBuyers.length,
    total_sellers: domSellers.length
  };
}

/**
 * Calculate rolling metrics for a given list of daily broker maps over a window N:
 * - NetLot = sum(BuyLot - SellLot)
 * - NetVal = sum(BuyVal - SellVal)
 * - AvgBuyPrice = sum(BuyVal) / (max(1, sum(BuyLot)) * 100)
 * - AvgSellPrice = sum(SellVal) / (max(1, sum(SellLot)) * 100)
 * - TopBuyerVal(k) & TopSellerVal(k) for k in {1, 3, 5}
 * - BS_Ratio_3 = TopBuyerVal(3) / max(1, TopSellerVal(3))
 * - arah = calculateArahVerdict(BS_Ratio_3)
 */
function calculateRollingWindow(dailyMapsSlice, windowN) {
  const windowDays = dailyMapsSlice.length;
  if (windowDays === 0) {
    return {
      window_days: 0,
      target_window: windowN,
      total_buy_lot: 0,
      total_sell_lot: 0,
      net_lot: 0,
      total_buy_val: 0,
      total_sell_val: 0,
      net_val: 0,
      avg_buy_price: 0,
      avg_sell_price: 0,
      top_buyers: [],
      top_sellers: [],
      top_buyer_val: { k1: 0, k3: 0, k5: 0 },
      top_seller_val: { k1: 0, k3: 0, k5: 0 },
      bs_ratio_3: 1.0,
      arah: 'Netral'
    };
  }

  const brokerTotals = new Map();
  let grandBuyVal = 0;
  let grandSellVal = 0;
  let grandBuyLot = 0;
  let grandSellLot = 0;

  for (const dayEntry of dailyMapsSlice) {
    const map = dayEntry.brokerMap;
    for (const [code, bData] of map.entries()) {
      let cur = brokerTotals.get(code);
      if (!cur) {
        cur = {
          broker_code: code,
          broker_name: bData.broker_name || code,
          buy_lot: 0,
          sell_lot: 0,
          buy_val: 0,
          sell_val: 0
        };
        brokerTotals.set(code, cur);
      }
      cur.buy_lot += cleanNumber(bData.buy_lot);
      cur.sell_lot += cleanNumber(bData.sell_lot);
      cur.buy_val += cleanNumber(bData.bval);
      cur.sell_val += cleanNumber(bData.sval);

      grandBuyVal += cleanNumber(bData.bval);
      grandSellVal += cleanNumber(bData.sval);
      grandBuyLot += cleanNumber(bData.buy_lot);
      grandSellLot += cleanNumber(bData.sell_lot);
    }
  }

  const brokers = Array.from(brokerTotals.values()).map(b => {
    const net_lot = b.buy_lot - b.sell_lot;
    const net_val = b.buy_val - b.sell_val;
    const avg_buy_price = b.buy_lot > 0 ? Math.round((b.buy_val / (b.buy_lot * 100)) * 100) / 100 : 0;
    const avg_sell_price = b.sell_lot > 0 ? Math.round((b.sell_val / (b.sell_lot * 100)) * 100) / 100 : 0;
    return {
      broker_code: b.broker_code,
      broker_name: b.broker_name,
      buy_lot: b.buy_lot,
      sell_lot: b.sell_lot,
      net_lot,
      buy_val: b.buy_val,
      sell_val: b.sell_val,
      net_val,
      avg_buy_price,
      avg_sell_price
    };
  });

  const netBuyers = brokers.filter(b => b.net_val > 0).sort((a, b) => b.net_val - a.net_val);
  const netSellers = brokers.filter(b => b.net_val < 0).sort((a, b) => a.net_val - b.net_val); // most negative first

  function topKVal(list, k, key) {
    return list.slice(0, k).reduce((s, b) => s + Math.abs(cleanNumber(b[key])), 0);
  }

  // Top buyers by net_val
  const topBuyerValK1 = topKVal(netBuyers, 1, 'net_val');
  const topBuyerValK3 = topKVal(netBuyers, 3, 'net_val');
  const topBuyerValK5 = topKVal(netBuyers, 5, 'net_val');

  // Top sellers by net_val
  const topSellerValK1 = topKVal(netSellers, 1, 'net_val');
  const topSellerValK3 = topKVal(netSellers, 3, 'net_val');
  const topSellerValK5 = topKVal(netSellers, 5, 'net_val');

  // BS_Ratio_3 based on Top 3 buyers vs sellers value:
  // BS_Ratio_3 = TopBuyerVal(3) / max(1, TopSellerVal(3))
  const bs_ratio_3 = topSellerValK3 > 0
    ? Math.round((topBuyerValK3 / Math.max(1, topSellerValK3)) * 100) / 100
    : (topBuyerValK3 > 0 ? 99.0 : 1.0);

  const arah = calculateArahVerdict(bs_ratio_3);

  const net_lot = grandBuyLot - grandSellLot;
  const net_val = grandBuyVal - grandSellVal;
  const avg_buy_price = grandBuyLot > 0 ? Math.round((grandBuyVal / (grandBuyLot * 100)) * 100) / 100 : 0;
  const avg_sell_price = grandSellLot > 0 ? Math.round((grandSellVal / (grandSellLot * 100)) * 100) / 100 : 0;

  return {
    window_days: windowDays,
    target_window: windowN,
    total_buy_lot: grandBuyLot,
    total_sell_lot: grandSellLot,
    net_lot,
    total_buy_val: grandBuyVal,
    total_sell_val: grandSellVal,
    net_val,
    avg_buy_price,
    avg_sell_price,
    top_buyers: netBuyers.slice(0, 5),
    top_sellers: netSellers.slice(0, 5),
    top_buyer_val: {
      k1: topBuyerValK1,
      k3: topBuyerValK3,
      k5: topBuyerValK5
    },
    top_seller_val: {
      k1: topSellerValK1,
      k3: topSellerValK3,
      k5: topSellerValK5
    },
    bs_ratio_3,
    arah
  };
}

/**
 * Calculate Bandar Consistency:
 * - Broker top buyer 20H
 * - Frekuensi hari net buy dalam 10 hari (X / 10 hari)
 * - Streak hari beruntun
 */
function calculateBandarConsistency(dailyRecordsSlice, topBuyerWindow = 20, recentDays = 10) {
  if (!Array.isArray(dailyRecordsSlice) || dailyRecordsSlice.length === 0) {
    return {
      top_broker_20h: null,
      top_broker_name: null,
      net_buy_freq_10h: '0/0',
      net_buy_days_10h: 0,
      of_days: 0,
      streak: 0,
      total_net_val_20h: 0
    };
  }

  const windowSlice = dailyRecordsSlice.slice(-topBuyerWindow);
  const brokerTotals = new Map();

  for (const day of windowSlice) {
    const map = day.brokerMap;
    for (const [code, b] of map.entries()) {
      const cur = brokerTotals.get(code) || { broker_code: code, broker_name: b.broker_name || code, total_nval: 0 };
      cur.total_nval += cleanNumber(b.nval);
      brokerTotals.set(code, cur);
    }
  }

  const sortedBrokers = Array.from(brokerTotals.values()).sort((a, b) => b.total_nval - a.total_nval);
  const topBrokerObj = sortedBrokers.find(b => b.total_nval > 0) || null;
  const topBroker = topBrokerObj ? topBrokerObj.broker_code : null;
  const topBrokerName = topBrokerObj ? topBrokerObj.broker_name : null;

  if (!topBroker) {
    return {
      top_broker_20h: null,
      top_broker_name: null,
      net_buy_freq_10h: `0/${Math.min(recentDays, dailyRecordsSlice.length)}`,
      net_buy_days_10h: 0,
      of_days: Math.min(recentDays, dailyRecordsSlice.length),
      streak: 0,
      total_net_val_20h: 0
    };
  }

  const recentSlice = dailyRecordsSlice.slice(-recentDays);
  let netBuyDays = 0;
  for (const day of recentSlice) {
    const b = day.brokerMap.get(topBroker);
    if (b && cleanNumber(b.nval) > 0) {
      netBuyDays++;
    }
  }

  let streak = 0;
  for (let i = recentSlice.length - 1; i >= 0; i--) {
    const b = recentSlice[i].brokerMap.get(topBroker);
    if (b && cleanNumber(b.nval) > 0) {
      streak++;
    } else {
      break;
    }
  }

  return {
    top_broker_20h: topBroker,
    top_broker_name: topBrokerName,
    net_buy_freq_10h: `${netBuyDays}/${recentSlice.length}`,
    net_buy_days_10h: netBuyDays,
    of_days: recentSlice.length,
    streak,
    total_net_val_20h: topBrokerObj.total_nval
  };
}

/**
 * Calculate Daily Broker Pressure & Bandar VWAP (Top 3 buyer).
 */
function calculateDailyPressureAndVwap(dailyBrokerMap) {
  if (!dailyBrokerMap || dailyBrokerMap.size === 0) {
    return {
      top3_buyer_codes: [],
      bandar_vwap: null,
      tekanan_broker: 0,
      top3_buy_val: 0,
      top3_buy_vol: 0
    };
  }

  const buyers = [];
  let dayNetVal = 0;

  for (const b of dailyBrokerMap.values()) {
    dayNetVal += cleanNumber(b.nval);
    if (cleanNumber(b.nval) > 0 && cleanNumber(b.bval) > 0) {
      buyers.push(b);
    }
  }

  buyers.sort((a, b) => cleanNumber(b.nval) - cleanNumber(a.nval));
  const top3 = buyers.slice(0, 3);
  const top3BuyVal = top3.reduce((s, b) => s + cleanNumber(b.bval), 0);
  const top3BuyVol = top3.reduce((s, b) => s + cleanNumber(b.bvol), 0);
  const bandarVwap = top3BuyVol > 0 ? Math.round(top3BuyVal / top3BuyVol) : null;

  return {
    top3_buyer_codes: top3.map(b => b.broker_code),
    bandar_vwap: bandarVwap,
    tekanan_broker: dayNetVal,
    top3_buy_val: top3BuyVal,
    top3_buy_vol: top3BuyVol
  };
}

/**
 * Compute full rolling accumulation series across historical dates (0 look-ahead bias).
 * Supports ALL, Foreign, and Domestic flows.
 */
function computeFullRollingAccumulation(ticker, rawAllDays, rawFDays) {
  const code = String(ticker || '').trim().toUpperCase();

  // Combine and sort dates chronologically
  const allMapByDate = new Map();
  (rawAllDays || []).forEach(d => {
    if (d && d.date && d.broksum) allMapByDate.set(d.date, d.broksum);
  });

  const fMapByDate = new Map();
  (rawFDays || []).forEach(d => {
    if (d && d.date && d.broksum) fMapByDate.set(d.date, d.broksum);
  });

  const allDates = Array.from(allMapByDate.keys()).sort();
  if (allDates.length === 0) {
    return {
      ticker: code,
      total_sessions: 0,
      latest: null,
      history: {}
    };
  }

  // Pre-parse daily maps
  const parsedSeries = allDates.map(date => {
    const allJson = allMapByDate.get(date);
    const fJson = fMapByDate.get(date) || null;

    const allBrokerMap = parseDailyBroksumLevels(allJson);
    const fBrokerMap = fJson ? parseDailyBroksumLevels(fJson) : new Map();

    const domResult = computeDomesticBroksum(allJson, fJson, date, code);
    const domBrokerMap = domResult.status === 'RELEASED'
      ? parseDailyBroksumLevels(domResult)
      : new Map();

    const pressureVwap = calculateDailyPressureAndVwap(allBrokerMap);

    return {
      date,
      has_foreign: domResult.data_asing_dirilis,
      foreign_status: domResult.status,
      allMap: allBrokerMap,
      fMap: fBrokerMap,
      domMap: domBrokerMap,
      pressureVwap
    };
  });

  // Build rolling history strictly using index <= t
  const history = {};

  for (let t = 0; t < parsedSeries.length; t++) {
    const curDate = parsedSeries[t].date;
    const pastSlice = parsedSeries.slice(0, t + 1);

    const rollingForDate = {
      date: curDate,
      has_foreign: parsedSeries[t].has_foreign,
      foreign_status: parsedSeries[t].foreign_status,
      bandar_vwap: parsedSeries[t].pressureVwap.bandar_vwap,
      tekanan_broker: parsedSeries[t].pressureVwap.tekanan_broker,
      top3_buyers: parsedSeries[t].pressureVwap.top3_buyer_codes,
      windows: {}
    };

    // Prepare slices for ALL, F, D
    const allDailyMaps = pastSlice.map(p => ({ date: p.date, brokerMap: p.allMap }));
    const fDailyMaps = pastSlice.filter(p => p.fMap.size > 0).map(p => ({ date: p.date, brokerMap: p.fMap }));
    const domDailyMaps = pastSlice.filter(p => p.has_foreign && p.domMap.size > 0).map(p => ({ date: p.date, brokerMap: p.domMap }));

    for (const N of WINDOWS) {
      rollingForDate.windows[N + 'H'] = {
        all: calculateRollingWindow(allDailyMaps.slice(-N), N),
        foreign: calculateRollingWindow(fDailyMaps.slice(-N), N),
        domestic: calculateRollingWindow(domDailyMaps.slice(-N), N)
      };
    }

    rollingForDate.consistency = {
      all: calculateBandarConsistency(allDailyMaps, 20, 10),
      foreign: calculateBandarConsistency(fDailyMaps, 20, 10),
      domestic: calculateBandarConsistency(domDailyMaps, 20, 10)
    };

    history[curDate] = rollingForDate;
  }

  const latestDate = allDates[allDates.length - 1];
  const latestSnapshot = history[latestDate] || null;

  return {
    ticker: code,
    updated_at: new Date().toISOString(),
    start_date: allDates[0],
    end_date: latestDate,
    total_sessions: allDates.length,
    latest: latestSnapshot,
    history
  };
}

/**
 * Backward compatibility:
 * Compute Broker Accumulation series matching Arjum's /api/broker-accumulation/{code} endpoint.
 */
function computeBrokerAccumulation(ticker, dailySeries, options = {}) {
  const code = String(ticker || '').trim().toUpperCase();
  if (!Array.isArray(dailySeries) || dailySeries.length === 0) {
    return {
      code,
      start_date: null,
      end_date: null,
      series: [],
      top_buyers: [],
      top_sellers: []
    };
  }

  let sortedDays = dailySeries.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (options.startDate) {
    sortedDays = sortedDays.filter(d => d.date >= options.startDate);
  }
  if (options.endDate) {
    sortedDays = sortedDays.filter(d => d.date <= options.endDate);
  }

  if (sortedDays.length === 0) {
    return {
      code,
      start_date: options.startDate || null,
      end_date: options.endDate || null,
      series: [],
      top_buyers: [],
      top_sellers: []
    };
  }

  const brokerMap = new Map();

  sortedDays.forEach(day => {
    const dayMap = parseDailyBroksumLevels(day.broksum);
    for (const [bCode, bData] of dayMap.entries()) {
      if (!brokerMap.has(bCode)) {
        brokerMap.set(bCode, {
          broker_code: bCode,
          broker_name: bData.broker_name || bCode,
          totalNval: 0,
          totalBval: 0,
          totalSval: 0,
          days: new Map()
        });
      }
      const record = brokerMap.get(bCode);
      record.totalNval += bData.nval;
      record.totalBval += bData.bval;
      record.totalSval += bData.sval;
      record.days.set(day.date, bData);
    }
  });

  const brokerList = Array.from(brokerMap.values()).sort((a, b) => b.totalNval - a.totalNval);

  const topBuyers = brokerList
    .filter(b => b.totalNval > 0)
    .slice(0, 3)
    .map(b => ({
      broker_code: b.broker_code,
      broker_name: b.broker_name,
      total_nval: b.totalNval
    }));

  const topSellers = brokerList
    .filter(b => b.totalNval < 0)
    .slice(-3)
    .reverse()
    .map(b => ({
      broker_code: b.broker_code,
      broker_name: b.broker_name,
      total_nval: b.totalNval
    }));

  const selectedBrokerCodes = new Set();
  topBuyers.forEach(b => selectedBrokerCodes.add(b.broker_code));
  topSellers.forEach(b => selectedBrokerCodes.add(b.broker_code));

  const series = [];

  for (const bCode of selectedBrokerCodes) {
    const bMeta = brokerMap.get(bCode);
    if (!bMeta) continue;

    let cumNval = 0;
    const points = [];

    sortedDays.forEach(day => {
      const dayData = bMeta.days.get(day.date) || { nval: 0, nvol: 0, bval: 0, sval: 0, bvol: 0, svol: 0 };
      cumNval += dayData.nval;

      const bavg = dayData.bvol > 0 ? Math.round((dayData.bval / dayData.bvol) * 100) / 100 : 0;
      const savg = dayData.svol > 0 ? Math.round((dayData.sval / dayData.svol) * 100) / 100 : 0;

      points.push({
        date: day.date,
        nval: dayData.nval,
        nvol: dayData.nvol,
        cum_nval: cumNval,
        bavg,
        savg
      });
    });

    series.push({
      broker_code: bCode,
      broker_name: bMeta.broker_name,
      points
    });
  }

  series.sort((a, b) => {
    const aTot = brokerMap.get(a.broker_code)?.totalNval || 0;
    const bTot = brokerMap.get(b.broker_code)?.totalNval || 0;
    return bTot - aTot;
  });

  return {
    code,
    start_date: sortedDays[0].date,
    end_date: sortedDays[sortedDays.length - 1].date,
    series,
    top_buyers: topBuyers,
    top_sellers: topSellers
  };
}

module.exports = {
  WINDOWS,
  cleanNumber,
  calculateArahVerdict,
  parseDailyBroksumLevels,
  computeDomesticBroksum,
  calculateRollingWindow,
  calculateBandarConsistency,
  calculateDailyPressureAndVwap,
  computeFullRollingAccumulation,
  computeBrokerAccumulation
};
