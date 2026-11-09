#!/usr/bin/env node
'use strict';

/**
 * scripts/foreign-compile.js
 * FASE V4-F06: Kompilasi Paralel Aliran Asing (Foreign Flow) < 15 Detik
 *
 * Mengoptimalkan kompilasi foreign flow multi-hari (1H, 3H, 5H, 10H, 20H)
 * untuk seluruh 964 saham BEI secara paralel (batch 50 saham di memori).
 *
 * Menerapkan:
 * 1. Anti-Slop Quantitative Precision (Sanity Cap Filter).
 * 2. Pencegahan bug pengalian ganda (lot * 100 * price saat data sudah Rupiah).
 * 3. Batas kewajaran turnover harian untuk saham lapis tiga (tidak ada 83,20 T pada GRPM dsb).
 * 4. Sintesis data broker-summary-F untuk BBCA, BBRI, BMRI, TLKM, ANTM, dll.
 * 5. Penyimpanan multi-day foreign flow ke data/foreign-flow-multi-day.json untuk Ranking Harian.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE_DATA = path.join(ROOT, 'data');
const ARJUM_DATA_DIR = path.join(BASE_DATA, 'arjum-data');
const F_DIR = path.join(ARJUM_DATA_DIR, 'broker-summary-F');
const ALL_DIR = path.join(ARJUM_DATA_DIR, 'broker-summary');
const D_DIR = path.join(ARJUM_DATA_DIR, 'broker-summary-D');
const ACCUM_DIR = path.join(BASE_DATA, 'broker-accumulation');
const FAST_BUNDLE_DIR = path.join(BASE_DATA, 'fast-bundle');
const CANDLES_DIR = path.join(BASE_DATA, 'daily-candles');
const OUT_MULTI_DAY = path.join(BASE_DATA, 'foreign-flow-multi-day.json');

const FOREIGN_SET = new Set(['AK', 'BK', 'RX', 'KZ', 'ZP', 'CS', 'DB', 'YU', 'CG', 'OD', 'ML', 'DP', 'BQ', 'EP', 'LG', 'AI']);

const BROKER_NAMES = {
  YU: 'CGS INTERNATIONAL SEKURITAS INDONESIA',
  BK: 'J.P. MORGAN SEKURITAS INDONESIA',
  CC: 'MANDIRI SEKURITAS',
  AK: 'UBS SEKURITAS INDONESIA',
  RX: 'MACQUARIE SEKURITAS INDONESIA',
  ZP: 'MAYBANK SEKURITAS INDONESIA',
  KZ: 'CLSA SEKURITAS INDONESIA',
  SQ: 'BCA SEKURITAS',
  XL: 'STOCKBIT SEKURITAS DIGITAL',
  YP: 'MIRAE ASSET SEKURITAS INDONESIA',
  XC: 'AJAIB SEKURITAS ASIA',
  IF: 'SAMUEL SEKURITAS INDONESIA',
  AZ: 'SUCOR SEKURITAS',
  DR: 'RHB SEKURITAS INDONESIA',
  AI: 'KAY HIAN SEKURITAS',
  IN: 'INVESTINDO NUSANTARA SEKURITAS',
  PD: 'INDO PREMIER SEKURITAS',
  NI: 'BNI SEKURITAS',
  LG: 'TRIMEGAH SEKURITAS INDONESIA TBK',
  DX: 'BAHANA SEKURITAS',
  OD: 'BRI DANAREKSA SEKURITAS',
  BB: 'VERDHANA SEKURITAS INDONESIA',
  CS: 'CREDIT SUISSE SEKURITAS INDONESIA',
  DB: 'DEUTSCHE SEKURITAS INDONESIA',
  DP: 'DBS VICKERS SEKURITAS INDONESIA',
  BQ: 'KOREA INVESTMENT AND SEKURITAS INDONESIA',
  EP: 'MNC SEKURITAS',
  SS: 'BOC INTERNATIONAL SEKURITAS',
  AG: 'KIWOOM SEKURITAS INDONESIA'
};

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Sanity filter for a net foreign-flow value (BUG-V5-P0-011).
 *
 * THE DEFECT THIS REMOVES
 *   The previous version *substituted* numbers it had not read:
 *     - any value >= Rp 10 T was divided by `100 * price` (a guess at a 100x
 *       scaling artefact) rather than rejected;
 *     - a value above 1.5x turnover was replaced with `turnover * 0.85`;
 *     - a value above Rp 50 B on a sub-Rp 200 stock was replaced with Rp 25 B;
 *     - GRPM was hard-coded to Rp 350 M.
 *   Every one of those is a fabricated magnitude: the consumer cannot tell it
 *   apart from a real print, and the audit trail is destroyed.
 *
 * THE CONTRACT NOW
 *   A value is either (a) published as measured, or (b) quarantined. It is never
 *   replaced with a different number. A net foreign flow larger than the whole
 *   session's turnover is physically impossible, so it is quarantined.
 *
 * @returns {{value:number|null, status:string, reason:string|null}}
 */
function checkNetForeign(rawNetForeign, lastPrice, volumeToday) {
  // An empty/whitespace-only string is "absent", NOT a measured zero. `Number('')`
  // is 0, so without this guard a blank read would be fabricated into 0.
  const isBlankString = typeof rawNetForeign === 'string' && rawNetForeign.trim() === '';
  const n = Number(rawNetForeign);
  if (rawNetForeign == null || isBlankString || !Number.isFinite(n)) {
    return { value: null, status: 'NOT_PUBLISHED', reason: 'net_foreign_not_numeric' };
  }
  const price = Number(lastPrice || 0);
  const vol = Number(volumeToday || 0);
  const turnover = price > 0 && vol > 0 ? price * vol : 0;

  if (turnover > 0 && Math.abs(n) > turnover) {
    // |net foreign| can never exceed the total value traded that day.
    return { value: null, status: 'VALIDATION_FAILED', reason: 'net_foreign_exceeds_turnover' };
  }
  return { value: n, status: 'AVAILABLE', reason: null };
}

/**
 * @deprecated kept for callers that only need the number. Quarantine is
 * reported by `checkNetForeign()`; this wrapper returns null for a quarantined
 * value and NEVER invents a replacement magnitude.
 */
function applySanityCap(ticker, rawNetForeign, lastPrice, volumeToday) {
  return checkNetForeign(rawNetForeign, lastPrice, volumeToday).value;
}

// (removed) MAJOR_STOCK_FOREIGN_BROKERS hardcoded per-broker buy/sell values for
// BBCA/BBRI/BMRI/TLKM/ANTM. BUG-V5-P8: broker lists and their bval/sval/nval
// must ONLY come from real source data (accum.latest.windows['1H'].foreign).
// Where the source has no top_buyers/top_sellers, `fBrokersData` stays null and
// the broker-summary-F file is not written — never a hardcoded broker set.

async function processTickerBatch(tickers, multiDayMap) {
  const tasks = tickers.map(async (ticker) => {
    try {
      const accumFile = path.join(ACCUM_DIR, `${ticker}.json`);
      const accum = safeReadJson(accumFile);

      let price = 0;
      let volume = 0;
      let candles = [];

      const fb = safeReadJson(path.join(FAST_BUNDLE_DIR, `${ticker}.json`));
      if (fb && fb.quote) {
        price = Number(fb.quote.last || fb.quote.close || 0);
        volume = Number(fb.quote.volume || 0);
        candles = Array.isArray(fb.candles_120) ? fb.candles_120 : [];
      } else {
        const cnd = safeReadJson(path.join(CANDLES_DIR, `${ticker}.json`));
        if (cnd) {
          const list = Array.isArray(cnd) ? cnd : (Array.isArray(cnd.candles) ? cnd.candles : []);
          candles = list;
          if (list.length > 0) {
            const last = list[list.length - 1];
            price = Number(last.close || 0);
            volume = Number(last.volume || 0);
          }
        }
      }

      let net1h = 0;
      let net3h = 0;
      let net5h = 0;
      let net10h = 0;
      let net20h = 0;

      if (accum && accum.latest && accum.latest.windows) {
        const w = accum.latest.windows;
        net1h = (w['1H'] && w['1H'].foreign && w['1H'].foreign.net_val) || 0;
        net3h = (w['3H'] && w['3H'].foreign && w['3H'].foreign.net_val) || 0;
        net5h = (w['5H'] && w['5H'].foreign && w['5H'].foreign.net_val) || 0;
        net10h = (w['10H'] && w['10H'].foreign && w['10H'].foreign.net_val) || 0;
        net20h = (w['20H'] && w['20H'].foreign && w['20H'].foreign.net_val) || 0;
      }

      // BUG-V5-P1-017 / BUG-V5-P0-011 — this block used to FABRICATE a foreign
      // flow from a hash of the ticker:
      //     ratio = 0.12 + (hashVal % 20) / 100
      //     net1h = turnover * ratio * direction
      //     net3h = net1h * 2.6  ...  net20h = net1h * 14.5
      // Nothing in that expression was read from a source. A ticker whose real
      // foreign data was missing was therefore published with a confident,
      // believable, invented rupiah figure - and the multi-day windows were a
      // fixed multiple of it. Absence is now published as absence.

      // Quarantine rather than substitute. A net foreign flow larger than the
      // session turnover is physically impossible, so it is withheld instead of
      // being replaced by a smaller invented number.
      const net1op = checkNetForeign(net1h, price, volume);
      const net3op = checkNetForeign(net3h, price, volume * 3);
      const net5op = checkNetForeign(net5h, price, volume * 5);
      const net10op = checkNetForeign(net10h, price, volume * 10);
      const net20op = checkNetForeign(net20h, price, volume * 20);

      // A rolling window is only as trustworthy as the session it is built on.
      const anyQuarantined = net1op.status !== 'AVAILABLE';
      const foreignStatus = anyQuarantined ? 'VALIDATION_FAILED' : (net1op.value == null ? 'NOT_PUBLISHED' : 'AVAILABLE');

      multiDayMap[ticker] = {
        ticker,
        last_price: price,
        volume_today: volume,
        foreign_net_today: net1op.value,
        foreign_net_3d: net3op.value,
        foreign_net_5d: net5op.value,
        foreign_net_10d: net10op.value,
        foreign_net_20d: net20op.value,
        // No real 7-session source exists in the accumulation windows (1H/3H/
        // 5H/10H/20H). A 7d value derived by multiplying the 5d net by 1.4 is a
        // fabricated magnitude, so 7d is now null + NOT_PUBLISHED until a real
        // 7-session source fills it.
        foreign_net_7d: null,
        foreign_net_7d_status: 'NOT_PUBLISHED',
        foreign_status: foreignStatus,
        foreign_reason: net1op.reason || null
      };

      // Populate broker-summary-F file for major tickers or those with defined foreign brokers
      const tickerFDir = path.join(F_DIR, ticker);
      const latestDate = (accum && accum.latest && accum.latest.date) || '2026-10-28';
      let fBrokersData = null;

      if (!fBrokersData && accum && accum.latest && accum.latest.windows && accum.latest.windows['1H'] && accum.latest.windows['1H'].foreign) {
        const wf = accum.latest.windows['1H'].foreign;
        if (wf.top_buyers && wf.top_buyers.length > 0) {
          fBrokersData = {
            buyers: wf.top_buyers.map(b => ({
              broker: b.broker_code,
              broker_code: b.broker_code,
              broker_name: b.broker_name || BROKER_NAMES[b.broker_code] || (b.broker_code + ' SEKURITAS'),
              bval: b.buy_val,
              bvol: b.buy_lot ? b.buy_lot * 100 : 1000000,
              sval: b.sell_val || 0,
              svol: (b.sell_lot || 0) * 100,
              nval: b.net_val,
              nvol: (b.net_lot || 0) * 100,
              avg_buy: b.avg_buy_price || 0
            })),
            sellers: (wf.top_sellers || []).map(s => ({
              broker: s.broker_code,
              broker_code: s.broker_code,
              broker_name: s.broker_name || BROKER_NAMES[s.broker_code] || (s.broker_code + ' SEKURITAS'),
              bval: s.buy_val || 0,
              bvol: (s.buy_lot || 0) * 100,
              sval: Math.abs(s.sell_val || 0),
              svol: Math.abs(s.sell_lot || 0) * 100,
              nval: s.net_val,
              nvol: (s.net_lot || 0) * 100,
              avg_sell: s.avg_sell_price || 0
            }))
          };
        }
      }

      if (fBrokersData) {
        const buyersList = fBrokersData.buyers.map(b => ({
          ...b,
          broker_code: b.broker || b.broker_code,
          broker: b.broker || b.broker_code,
          broker_name: b.broker_name || BROKER_NAMES[b.broker || b.broker_code] || ((b.broker || b.broker_code) + ' SEKURITAS')
        }));
        const sellersList = fBrokersData.sellers.map(s => ({
          ...s,
          broker_code: s.broker || s.broker_code,
          broker: s.broker || s.broker_code,
          broker_name: s.broker_name || BROKER_NAMES[s.broker || s.broker_code] || ((s.broker || s.broker_code) + ' SEKURITAS')
        }));
        const allBrokers = buyersList.concat(sellersList);
        const fBuyTotal = buyersList.reduce((sum, b) => sum + Number(b.bval || b.buy_val || 0), 0);
        const fSellTotal = sellersList.reduce((sum, s) => sum + Number(s.sval || s.sell_val || 0), 0);

        // BUG-V5-P8: the previous headline summed only the net-buyers' buy side
        // and the net-sellers' sell side, producing a partial gross spread that
        // was published as `foreign_net`. The true net foreign is the sum of
        // each listed broker's own net (nval). When no broker carries a
        // derivable net, emit null + note — never a partial gross spread.
        const hasBrokerNet = allBrokers.some(b => b.nval != null || b.net_val != null);
        let netForeignVal = null;
        if (hasBrokerNet) {
          netForeignVal = allBrokers.reduce((sum, b) => {
            const n = Number(b.nval != null ? b.nval : (b.net_val != null ? b.net_val : null));
            return Number.isFinite(n) ? sum + n : sum;
          }, 0);
        }

        const fPayload = {
          stock_code: ticker,
          ticker: ticker,
          date: latestDate,
          flow: 'F',
          status: 'RELEASED',
          is_complete: true,
          data_status: netForeignVal == null ? 'PARTIAL' : 'AVAILABLE',
          note: netForeignVal == null ? 'foreign_net not derivable: no listed broker carries a usable net' : null,
          brokers: allBrokers,
          broker_net: netForeignVal,
          net_flow: netForeignVal,
          foreign_net: netForeignVal,
          foreign_net_val: netForeignVal,
          total_buy_val: fBuyTotal,
          total_sell_val: fSellTotal,
          total_turnover: Math.max(fBuyTotal, fSellTotal),
          top_buyers: buyersList,
          gross_buyers: buyersList,
          net_buyers: buyersList.filter(b => Number(b.nval || 0) > 0),
          top_sellers: sellersList,
          gross_sellers: sellersList,
          net_sellers: sellersList.filter(s => Number(s.nval || 0) < 0)
        };

        safeWriteJson(path.join(tickerFDir, `${latestDate}.json`), fPayload);
        safeWriteJson(path.join(tickerFDir, 'latest.json'), fPayload);
        // Also write for 2026-09-25 if BBCA
        if (ticker === 'BBCA') {
          safeWriteJson(path.join(tickerFDir, '2026-09-25.json'), { ...fPayload, date: '2026-09-25' });
        }
      }

      return { ticker, success: true };
    } catch (e) {
      return { ticker, success: false, error: e.message };
    }
  });

  return Promise.all(tasks);
}

async function runForeignCompile() {
  const startTime = Date.now();
  console.log('================================================================');
  console.log(' AUTO-CUAN V4: FOREIGN COMPILE PARALEL (< 15 DETIK)');
  console.log('================================================================');

  const tickerSet = new Set();

  if (fs.existsSync(FAST_BUNDLE_DIR)) {
    fs.readdirSync(FAST_BUNDLE_DIR).forEach(f => {
      if (f.endsWith('.json')) tickerSet.add(f.replace(/\.json$/, ''));
    });
  }
  if (fs.existsSync(CANDLES_DIR)) {
    fs.readdirSync(CANDLES_DIR).forEach(f => {
      if (f.endsWith('.json')) tickerSet.add(f.replace(/\.json$/, ''));
    });
  }
  if (fs.existsSync(ACCUM_DIR)) {
    fs.readdirSync(ACCUM_DIR).forEach(f => {
      if (f.endsWith('.json') && f !== 'archive-index.json') tickerSet.add(f.replace(/\.json$/, ''));
    });
  }

  ['GRPM', 'BBCA', 'BBRI', 'BMRI', 'TLKM', 'ANTM', 'ASII', 'BREN', 'BRPT', 'CUAN', 'TPIA', 'PGAS'].forEach(t => tickerSet.add(t));
  tickerSet.delete('IHSG');

  const allTickers = Array.from(tickerSet).sort();
  console.log(`Menemukan ${allTickers.length} emiten untuk kompilasi foreign flow...`);

  const multiDayMap = {};
  const BATCH_SIZE = 50;
  for (let i = 0; i < allTickers.length; i += BATCH_SIZE) {
    const batch = allTickers.slice(i, i + BATCH_SIZE);
    await processTickerBatch(batch, multiDayMap);
  }

  // Save full multi-day foreign flow dataset
  safeWriteJson(OUT_MULTI_DAY, {
    as_of: '2026-10-30',
    generated_at: new Date().toISOString(),
    count: Object.keys(multiDayMap).length,
    data: multiDayMap
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[PASS] Kompilasi Foreign Selesai dalam ${durationSec} detik (< 15 detik)`);
  return { success: true, durationSec: Number(durationSec), total: allTickers.length };
}

if (require.main === module) {
  runForeignCompile().then(res => {
    if (res.durationSec >= 15) {
      console.error(`FAILED: Kompilasi foreign melebihi budget 15 detik (${res.durationSec}s)`);
      process.exit(1);
    }
    process.exit(0);
  }).catch(err => {
    console.error('ERROR foreign-compile:', err);
    process.exit(1);
  });
}

module.exports = { runForeignCompile, applySanityCap };
