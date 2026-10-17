'use strict';

const fs = require('fs');
const path = require('path');

function cleanNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extract broker maps from a daily broker summary JSON
 */
function parseDailyBroksumLevels(dailyJson) {
  const map = new Map();
  if (!dailyJson) return map;

  if (Array.isArray(dailyJson.brokers) && dailyJson.brokers.length > 0) {
    dailyJson.brokers.forEach(b => {
      if (b && b.broker_code) {
        const code = String(b.broker_code).trim().toUpperCase();
        map.set(code, {
          broker_code: code,
          broker_name: b.broker_name || code,
          bval: cleanNumber(b.bval),
          sval: cleanNumber(b.sval),
          bvol: cleanNumber(b.bvol),
          svol: cleanNumber(b.svol),
          nval: cleanNumber(b.nval !== undefined ? b.nval : (cleanNumber(b.bval) - cleanNumber(b.sval))),
          nvol: cleanNumber(b.nvol !== undefined ? b.nvol : (cleanNumber(b.bvol) - cleanNumber(b.svol)))
        });
      }
    });
    return map;
  }

  if (Array.isArray(dailyJson.broker_levels)) {
    dailyJson.broker_levels.forEach(lvl => {
      if (lvl.buy && lvl.buy.broker_code) {
        const code = String(lvl.buy.broker_code).trim().toUpperCase();
        const cur = map.get(code) || { broker_code: code, broker_name: lvl.buy.broker_name || code, bval: 0, sval: 0, bvol: 0, svol: 0 };
        cur.bval += cleanNumber(lvl.buy.bval);
        cur.bvol += cleanNumber(lvl.buy.bvol);
        map.set(code, cur);
      }
      if (lvl.sell && lvl.sell.broker_code) {
        const code = String(lvl.sell.broker_code).trim().toUpperCase();
        const cur = map.get(code) || { broker_code: code, broker_name: lvl.sell.broker_name || code, bval: 0, sval: 0, bvol: 0, svol: 0 };
        cur.sval += cleanNumber(lvl.sell.sval);
        cur.svol += cleanNumber(lvl.sell.svol);
        map.set(code, cur);
      }
    });

    for (const item of map.values()) {
      item.nval = item.bval - item.sval;
      item.nvol = item.bvol - item.svol;
    }
  }

  return map;
}

/**
 * Compute Broker Accumulation series and top buyers/sellers from a sequence of daily broker summaries.
 * Produces the exact schema matching Arjum's /api/broker-accumulation/{code} endpoint.
 *
 * @param {string} ticker - Stock symbol
 * @param {Array<{date: string, broksum: object}>} dailySeries - Sorted array of daily broker summaries
 * @param {object} [options] - Options { startDate, endDate, topCount }
 * @returns {object} Payload matching /api/broker-accumulation format
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

  // Filter by date if specified
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

  const startDate = sortedDays[0].date;
  const endDate = sortedDays[sortedDays.length - 1].date;

  // Track each broker across days
  // broker_code -> { name, totalNval, days: Map<date, { nval, nvol, bval, sval, bvol, svol }> }
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

  // Sort all brokers by totalNval descending
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

  // Selected brokers for series: top 3 buyers + top 3 sellers (deduplicated)
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

  // Sort series alphabetically or top buyer first then top sellers
  series.sort((a, b) => {
    const aTot = brokerMap.get(a.broker_code)?.totalNval || 0;
    const bTot = brokerMap.get(b.broker_code)?.totalNval || 0;
    return bTot - aTot;
  });

  return {
    code,
    start_date: startDate,
    end_date: endDate,
    series,
    top_buyers: topBuyers,
    top_sellers: topSellers
  };
}

module.exports = {
  computeBrokerAccumulation,
  parseDailyBroksumLevels
};
