'use strict';

/**
 * api/pattern-radar.js
 * ============================================================================
 * Deteksi Pola Otomatis Harmonic XABCD (Gartley, Bat, Butterfly, Crab)
 * & Smart Money Concepts (SMC Structure: CHoCH, BOS, Order Block Retest)
 * ============================================================================
 *
 * FIX 4: the scan is bound to the canonical `stock_daily_history` snapshot
 * (read-only, max date 2026-11-20, BBCA 5550 / 147637100). The stale flat-file
 * cache (2026-11-04, BBCA 9860) is never read. Every published price level is
 * rounded onto the official IDX tick fraction via lib/idx-tick.js, and each row
 * carries the real daily candles so the inline SVG renderer can draw the shape.
 */

const path = require('path');
const W = require('../public/chart-workstation.js');
const tick = require('../lib/idx-tick.js');
const canonical = require('../lib/canonical-daily-history-source.js');

const ROOT = path.resolve(__dirname, '..');

const STOCK_NAMES = {
  'BBCA': 'Bank Central Asia Tbk',
  'BBRI': 'Bank Rakyat Indonesia Tbk',
  'BMRI': 'Bank Mandiri Tbk',
  'BBNI': 'Bank Negara Indonesia Tbk',
  'TLKM': 'Telkom Indonesia Tbk',
  'ASII': 'Astra International Tbk',
  'BRPT': 'Barito Pacific Tbk',
  'BREN': 'Barito Renewables Energy Tbk',
  'AMMN': 'Amman Mineral Internasional Tbk',
  'ADRO': 'Adaro Energy Indonesia Tbk',
  'MEDC': 'Medco Energi Internasional Tbk',
  'ANTM': 'Aneka Tambang Tbk',
  'ICBP': 'Indofood CBP Sukses Makmur Tbk',
  'INDF': 'Indofood Sukses Makmur Tbk',
  'GOTO': 'GoTo Gojek Tokopedia Tbk',
  'KLBF': 'Kalbe Farma Tbk',
  'UNVR': 'Unilever Indonesia Tbk',
  'PGAS': 'Perusahaan Gas Negara Tbk',
  'PTBA': 'Bukit Asam Tbk',
  'CPIN': 'Charoen Pokphand Indonesia Tbk',
  'MDKA': 'Merdeka Copper Gold Tbk',
  'INCO': 'Vale Indonesia Tbk',
  'ITMG': 'Indo Tambangraya Megah Tbk',
  'TPIA': 'Chandra Asri Pacific Tbk',
  'BRIS': 'Bank Syariah Indonesia Tbk',
  'IHSG': 'Indeks Harga Saham Gabungan'
};

const PRIORITY_LIST = ['BBCA', 'BBRI', 'BMRI', 'BRPT', 'MEDC', 'ANTM', 'ICBP', 'TLKM', 'ASII', 'ADRO', 'BREN', 'AMMN', 'GOTO', 'PGAS', 'PTBA', 'KLBF', 'BRIS', 'CPIN', 'MDKA'];
const CANDLE_WINDOW = 100;

function getStockName(ticker) {
  return STOCK_NAMES[ticker] || `${ticker} Tbk`;
}

/** Every published level goes through the single official IDX tick helper. */
function onTick(value) {
  const rounded = tick.roundToIdxTick(value);
  return rounded === null ? null : rounded;
}

/**
 * BUG 4: one canonical ordering pass for every published pattern card.
 * Bullish: Invalidasi < PRZ/Harga < Konfirmasi Naik < Target1 <= Target2.
 * Bearish: the exact inverse. Rounding happens first (onTick), then the
 * sequence is repaired so IDX tick fractions can never invert the order.
 */
function canonicalLevelOrder(levels) {
  const src = levels || {};
  const dir = src.direction === 'bearish' ? 'bearish' : 'bullish';
  const step = (v) => tick.idxTickSize(v);
  const price = (v, fallback) => {
    const r = onTick(v);
    return r == null ? onTick(fallback) : r;
  };
  const close = price(src.close, 0);
  const atr = Number(src.atr) > 0 ? Number(src.atr) : Math.max(1, Math.round(close * 0.02));
  let inv = price(src.invalidation, close - 1.2 * atr);
  let conf = price(src.confirmation, close + 0.382 * atr);
  let t1 = price(src.tp1, close + 1.618 * atr);
  let t2 = price(src.tp2, close + 2.618 * atr);
  let low = price(src.przLow, close - 0.5 * atr);
  let high = price(src.przHigh, close + 0.2 * atr);
  if (dir === 'bullish') {
    if (low <= inv) low = onTick(inv + step(inv));
    if (high <= low) high = onTick(low + step(low));
    if (high >= conf) conf = onTick(high + step(high));
    if (t1 <= conf) t1 = onTick(conf + step(conf));
    if (t2 < t1) t2 = onTick(t1 + step(t1));
  } else {
    if (low >= inv) low = onTick(inv - step(inv));
    if (high >= low) high = onTick(low - step(low));
    if (high <= conf) conf = onTick(high - step(high));
    if (t1 >= conf) t1 = onTick(conf - step(conf));
    if (t2 > t1) t2 = onTick(t1 - step(t1));
  }
  return { invalidation: inv, confirmation: conf, tp1: t1, tp2: t2, prz: { low: low, high: high } };
}
module.exports.canonicalLevelOrder = canonicalLevelOrder;

function scanAllPatterns() {
  const universe = canonical.loadCanonicalDailyHistory();
  const meta = universe.meta;
  const tickers = Array.from(universe.byTicker.keys()).sort((a, b) => {
    const pa = PRIORITY_LIST.indexOf(a) >= 0 ? PRIORITY_LIST.indexOf(a) : 999;
    const pb = PRIORITY_LIST.indexOf(b) >= 0 ? PRIORITY_LIST.indexOf(b) : 999;
    return pa - pb || a.localeCompare(b);
  });

  const results = [];
  for (const ticker of tickers) {
    try {
      const allCandles = universe.byTicker.get(ticker) || [];
      if (allCandles.length < 20) continue;
      const rawCandles = allCandles.slice(-CANDLE_WINDOW).map((c) => Object.assign({}, c));
      const last = rawCandles[rawCandles.length - 1];
      const close = Number(last.close);
      if (!(close > 0) || !Number.isFinite(close)) continue;
      const dataDate = last.time;

      const xb = W.calculateV3F09XABCD(rawCandles);
      const xbConfirmation = (xb && xb.confirmation === 'CONFIRMED') ? 'CONFIRMED' : 'PROVISIONAL';
      const xbConfirmedAt = (xb && xb.confirmedAt) || null;
      const xbBarsAfterD = (xb && Number(xb.barsAfterD)) || 0;
      const smc = W.calculateV3F09SMC(rawCandles);
      const atr = (smc && smc.atr) ? smc.atr : Math.max(1, Math.round(close * 0.02));

      const common = {
        ticker,
        companyName: getStockName(ticker),
        name: getStockName(ticker),
        currentPrice: onTick(close),
        dataDate,
        data_source: meta.data_source,
        as_of: meta.max_date,
        snapshot_sha256: meta.sha256,
        snapshot_verified: meta.verified,
        candles: rawCandles
      };

      // 1. Harmonic patterns
      if (xb && xb.ratios) {
        const r = xb.ratios;
        let patternName = null;
        let confidence = 85.0;
        if (Math.abs(r.ab_xa - 0.618) < 0.18 && Math.abs(r.ad_xa - 0.786) < 0.18) {
          patternName = 'Bullish Gartley'; confidence = 94.2;
        } else if (Math.abs(r.ab_xa - 0.5) < 0.22 && Math.abs(r.ad_xa - 0.886) < 0.18) {
          patternName = 'Bullish Bat'; confidence = 91.5;
        } else if (r.ad_xa > 1.15 && r.ad_xa < 1.45) {
          patternName = 'Bullish Butterfly'; confidence = 89.8;
        } else if (r.ad_xa >= 1.45 && r.ad_xa <= 1.85) {
          patternName = 'Bullish Crab'; confidence = 88.4;
        } else if (Math.abs(r.ab_xa - 0.618) < 0.3) {
          patternName = 'Harmonic Pattern XABCD'; confidence = 86.5;
        }
        if (patternName) {
          results.push(Object.assign({}, common, {
            pattern: patternName,
            patternType: 'harmonic',
            bias: 'bullish',
            direction: 'bullish',
            confidence,
            breakout: onTick(close + 0.382 * atr),
            ...canonicalLevelOrder({ direction: 'bullish', close, atr,
              invalidation: close - 1.2 * atr, confirmation: close + 0.382 * atr,
              tp1: close + 1.618 * atr, tp2: close + 2.618 * atr,
              przLow: close - 0.5 * atr, przHigh: close + 0.2 * atr }),
            sl: onTick(close - 1.2 * atr),
            status: xbConfirmation === 'CONFIRMED' ? 'Terkonfirmasi' : 'Provisional (menunggu konfirmasi pivot)',
            statusTone: xbConfirmation === 'CONFIRMED' ? 'positive' : 'neutral',
            badge: xbConfirmation === 'CONFIRMED' ? 'Terkonfirmasi' : 'Provisional',
            confirmation_state: xbConfirmation,
            confirmedAt: xbConfirmedAt,
            barsAfterD: xbBarsAfterD,
            ratios: r,
            actionable: xbConfirmation === 'CONFIRMED'
          }));
        }
      }

      // 2. SMC formations
      if (smc) {
        if (smc.choch && smc.choch.length > 0) {
          const ch = smc.choch[0];
          const level = onTick(ch.level || close);
          results.push(Object.assign({}, common, {
            pattern: 'CHoCH Reversal',
            patternType: 'smc',
            bias: 'bullish',
            direction: 'bullish',
            confidence: 90.0,
            breakout: level,
            ...canonicalLevelOrder({ direction: 'bullish', close, atr,
              invalidation: close - 1.5 * atr, confirmation: level,
              tp1: close + 2.0 * atr, tp2: close + 3.5 * atr,
              przLow: close - 0.8 * atr, przHigh: close }),
            sl: onTick(close - 1.5 * atr),
            status: 'Konfirmasi Reversal',
            statusTone: 'positive',
            badge: 'SMC Reversal',
            actionable: true
          }));
        }
        if (smc.demandOB) {
          const obTop = onTick(smc.demandOB.top || close);
          const obBottom = onTick(smc.demandOB.bottom || close);
          results.push(Object.assign({}, common, {
            pattern: 'Order Block Retest',
            patternType: 'smc',
            bias: 'bullish',
            direction: 'bullish',
            confidence: 88.5,
            breakout: obTop,
            ...canonicalLevelOrder({ direction: 'bullish', close, atr,
              invalidation: (smc.demandOB.bottom || close) - 0.5 * atr, confirmation: obTop,
              tp1: close + 1.8 * atr, tp2: close + 3.0 * atr,
              przLow: obBottom, przHigh: obTop }),
            sl: onTick((smc.demandOB.bottom || close) - 0.5 * atr),
            status: 'Demand OB Valid',
            statusTone: 'positive',
            badge: 'Order Block',
            actionable: true
          }));
        }
      }
    } catch (_) {}
  }

  // Deduplicate per ticker, keeping the highest-confidence formation.
  const byTicker = new Map();
  for (const r of results) {
    const ex = byTicker.get(r.ticker);
    if (!ex || r.confidence > ex.confidence) byTicker.set(r.ticker, r);
  }
  const finalRows = Array.from(byTicker.values());
  finalRows.sort((a, b) => {
    const pa = PRIORITY_LIST.indexOf(a.ticker) >= 0 ? PRIORITY_LIST.indexOf(a.ticker) : 999;
    const pb = PRIORITY_LIST.indexOf(b.ticker) >= 0 ? PRIORITY_LIST.indexOf(b.ticker) : 999;
    return pa - pb || b.confidence - a.confidence || a.ticker.localeCompare(b.ticker);
  });

  return {
    success: true,
    count: finalRows.length,
    total_scanned: tickers.length,
    patterns: finalRows,
    rows: finalRows,
    data_source: meta.data_source,
    as_of: meta.max_date,
    snapshot_sha256: meta.sha256,
    snapshot_verified: meta.verified,
    canonical_status: meta.status
  };
}

module.exports = async function handler(req, res) {
  try {
    const t0 = Date.now();
    const result = scanAllPatterns();
    const ms = Date.now() - t0;
    const payload = Object.assign({}, result, { ms, as_of: result.as_of || new Date().toISOString() });
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
    }
    if (res && typeof res.status === 'function') return res.status(200).json(payload);
    return payload;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: String(err && err.message) });
    }
    throw err;
  }
};

module.exports.scanAllPatterns = scanAllPatterns;
