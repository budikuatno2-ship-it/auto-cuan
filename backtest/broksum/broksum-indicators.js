'use strict';

/**
 * Bandar Indicators from Broker Summary (Pure Function Module)
 * ============================================================
 * Implements deterministic quantitative metrics:
 * 1. B_b, S_b, N_b per broker from broker_levels.
 * 2. T: Total daily transaction value (Sum B_b).
 * 3. top3Buy & top3Sell: Net sum of top 3 net buyers and top 3 net sellers.
 * 4. tb: Top Buyer/Seller imbalance ratio [-1.00 to +1.00].
 * 5. tbCum: Cumulative (top3Buy - top3Sell) / MA20(T).
 * 6. tbSlope5: tbCum[t] - tbCum[t-5].
 * 7. hab20: Volume-weighted buy price of the top 3 net accumulating brokers over 20 days.
 * 8. kons: Consistency of the #1 20-day accumulator (days net buy in last 10 days + current streak).
 * 9. foreignNet: null (no investor type field in broker-summary).
 * 10. top: Tooltip object with top 3 net buyers and sellers.
 * 11. locked: "ARA" | "ARB" | null.
 */

function round(val, decimals = 4) {
  if (val == null || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

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

function calculateIdxAraArb(prevClose) {
  const ref = Number(prevClose);
  if (!Number.isFinite(ref) || ref <= 0) {
    return { araPx: null, arbPx: null };
  }
  let araPct = 0.35;
  if (ref > 5000) araPct = 0.20;
  else if (ref > 200) araPct = 0.25;

  const araPx = roundToIdxTick(ref * (1 + araPct), 'floor');
  const arbRaw = Math.max(1, Math.floor(ref * 0.85));
  const arbPx = roundToIdxTick(arbRaw, 'ceil');
  return { araPx, arbPx };
}

/**
 * Parse one day's broker summary JSON object into broker maps.
 */
function parseDailyBroksum(dailyBroksumJson) {
  const bMap = new Map();
  if (!dailyBroksumJson) return bMap;

  // Prefer broker_levels as it contains all top 25 levels with both buy and sell
  if (Array.isArray(dailyBroksumJson.broker_levels) && dailyBroksumJson.broker_levels.length > 0) {
    for (const lvl of dailyBroksumJson.broker_levels) {
      if (lvl.buy && lvl.buy.broker_code) {
        const code = String(lvl.buy.broker_code).trim().toUpperCase();
        const cur = bMap.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0 };
        cur.bval += Number(lvl.buy.bval || 0);
        cur.bvol += Number(lvl.buy.bvol || 0);
        bMap.set(code, cur);
      }
      if (lvl.sell && lvl.sell.broker_code) {
        const code = String(lvl.sell.broker_code).trim().toUpperCase();
        const cur = bMap.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0 };
        cur.sval += Number(lvl.sell.sval || 0);
        cur.svol += Number(lvl.sell.svol || 0);
        bMap.set(code, cur);
      }
    }
  } else if (Array.isArray(dailyBroksumJson.brokers)) {
    // Fallback to brokers array if broker_levels is missing
    for (const b of dailyBroksumJson.brokers) {
      const code = String(b.broker_code).trim().toUpperCase();
      const cur = bMap.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0 };
      cur.bval += Number(b.bval || 0);
      cur.sval += Number(b.sval || 0);
      cur.bvol += Number(b.bvol || 0);
      cur.svol += Number(b.svol || 0);
      bMap.set(code, cur);
    }
  }

  // Calculate net
  for (const [code, obj] of bMap.entries()) {
    obj.nval = obj.bval - obj.sval;
    obj.nvol = obj.bvol - obj.svol;
  }

  return bMap;
}

/**
 * Compute broker summary metrics across a time-series of daily broker summaries.
 * 
 * @param {Array<{date: string, broksum: object, close: number, prevClose?: number}>} series
 * @returns {Array<object>} Output series matching prompt contract
 */
function computeBroksumSeries(series) {
  if (!Array.isArray(series) || series.length === 0) return [];

  const nDays = series.length;
  const parsedDays = [];

  // Pass 1: Parse single-day broker totals
  for (let t = 0; t < nDays; t++) {
    const item = series[t];
    const bMap = parseDailyBroksum(item.broksum);

    let sumB = 0;
    let sumS = 0;
    const brokerList = [];

    for (const [code, b] of bMap.entries()) {
      sumB += b.bval;
      sumS += b.sval;
      brokerList.push({ b: code, nval: b.nval, bval: b.bval, sval: b.sval, bvol: b.bvol, svol: b.svol });
    }

    // Sort by nval descending
    brokerList.sort((a, b) => b.nval - a.nval);

    // Top 3 buyers (nval > 0)
    const buyers = brokerList.filter(x => x.nval > 0).slice(0, 3);
    const top3Buy = buyers.reduce((sum, x) => sum + x.nval, 0);

    // Top 3 sellers (nval < 0)
    const sellers = brokerList.filter(x => x.nval < 0).slice(-3).reverse();
    const top3Sell = sellers.reduce((sum, x) => sum + Math.abs(x.nval), 0);

    // Total daily turnover T: priority 1: explicit field in broksum if any;
    // priority 2: candle turnover (volume * close); priority 3: sum of brokers sumB
    const candleTurnover = Number(item.turnover || (item.volume && item.close ? item.volume * item.close : 0));
    const broksumTotal = Number(item.broksum?.total_val || item.broksum?.total_value || item.broksum?.val || 0);
    const T = broksumTotal > 0 ? Math.round(broksumTotal) : (candleTurnover > 0 ? Math.round(candleTurnover) : Math.round(sumB));
    // Buang hari dengan T=0 (libur bursa, file kosong, tanpa turnover)
    if (!T || T <= 0) {
      continue;
    }

    const tb = round((top3Buy - top3Sell) / T, 4);

    // Check locked ARA/ARB (prevClose from previous active trading day if not explicit)
    let locked = null;
    const prevC = item.prevClose != null
      ? item.prevClose
      : (parsedDays.length > 0 ? parsedDays[parsedDays.length - 1].close : null);
    if (prevC != null && item.close != null) {
      const { araPx, arbPx } = calculateIdxAraArb(prevC);
      if (araPx != null && item.close >= araPx) locked = 'ARA';
      else if (arbPx != null && item.close <= arbPx) locked = 'ARB';
    }

    // Tooltip top 3
    const top = {
      buy: buyers.map(x => ({ b: x.b, net: Math.round(x.nval) })),
      sell: sellers.map(x => ({ b: x.b, net: Math.round(x.nval) }))
    };

    parsedDays.push({
      date: item.date,
      close: item.close,
      prevClose: prevC,
      bMap,
      T,
      top3Buy: Math.round(top3Buy),
      top3Sell: Math.round(top3Sell),
      tb,
      locked,
      top
    });
  }

  const nParsed = parsedDays.length;

  // Pass 2: Rolling MA20(T), tbCum, tbSlope5, hab20, kons across active trading days
  let runningTbCum = 0;
  const out = [];

  for (let t = 0; t < nParsed; t++) {
    const cur = parsedDays[t];

    let ma20T = null;
    let hab20 = null;
    let kons = null;

    if (t >= 19) {
      // 20-day window [t - 19 ... t]
      let sumT = 0;
      for (let j = t - 19; j <= t; j++) {
        sumT += parsedDays[j].T;
      }
      ma20T = sumT / 20;

      // Accumulate broker stats over 20 days
      const broker20Map = new Map();
      for (let j = t - 19; j <= t; j++) {
        for (const [code, b] of parsedDays[j].bMap.entries()) {
          const cur20 = broker20Map.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0, nval: 0 };
          cur20.bval += b.bval;
          cur20.sval += b.sval;
          cur20.bvol += b.bvol;
          cur20.svol += b.svol;
          cur20.nval += b.nval;
          broker20Map.set(code, cur20);
        }
      }

      // Sort brokers by 20-day net value
      const sorted20 = Array.from(broker20Map.entries()).map(([code, b]) => ({
        code,
        ...b
      })).sort((a, b) => b.nval - a.nval);

      // Top 3 net buyers over 20 days
      const top3Accum = sorted20.slice(0, 3).filter(x => x.nval > 0);
      let sumBuyVal20 = 0;
      let sumBuyVol20 = 0;
      for (const b of top3Accum) {
        sumBuyVal20 += b.bval;
        sumBuyVol20 += b.bvol;
      }

      hab20 = sumBuyVol20 > 0 ? Math.round(sumBuyVal20 / sumBuyVol20) : null;

      // Konsistensi akumulator #1 over 20 days
      const top1Broker = sorted20[0] ? sorted20[0].code : null;
      if (top1Broker) {
        let days10 = 0;
        // Count days in last 10 days [t - 9 ... t] where top1Broker was net buyer
        const start10 = Math.max(0, t - 9);
        for (let j = start10; j <= t; j++) {
          const dayB = parsedDays[j].bMap.get(top1Broker);
          if (dayB && dayB.nval > 0) days10++;
        }

        // Current streak backwards from day t
        let streak = 0;
        for (let j = t; j >= 0; j--) {
          const dayB = parsedDays[j].bMap.get(top1Broker);
          if (dayB && dayB.nval > 0) {
            streak++;
          } else {
            break;
          }
        }

        kons = { b: top1Broker, days10, streak };
      }
    }

    // tbCum accumulation
    let tbCum = null;
    let tbSlope5 = null;

    if (ma20T != null && ma20T > 0) {
      const dailyDelta = (cur.top3Buy - cur.top3Sell) / ma20T;
      runningTbCum += dailyDelta;
      tbCum = round(runningTbCum, 2);
    }

    out.push({
      d: cur.date,
      T: cur.T,
      top3Buy: cur.top3Buy,
      top3Sell: cur.top3Sell,
      tb: cur.tb,
      tbCum,
      tbSlope5, // will compute in pass 3
      hab20,
      kons,
      foreignNet: null, // explicit null as investor type is absent
      locked: cur.locked,
      top: cur.top
    });
  }

  // Pass 3: tbSlope5 = tbCum[t] - tbCum[t - 5]
  for (let t = 0; t < nParsed; t++) {
    if (out[t].tbCum != null && t >= 5 && out[t - 5].tbCum != null) {
      out[t].tbSlope5 = round(out[t].tbCum - out[t - 5].tbCum, 2);
    }
  }

  return out;
}

module.exports = {
  round,
  getIdxTickSize,
  roundToIdxTick,
  calculateIdxAraArb,
  parseDailyBroksum,
  computeBroksumSeries
};
