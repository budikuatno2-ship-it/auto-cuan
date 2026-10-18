'use strict';

/**
 * VPS-side scan v2: validasi kewajaran arsip broksum terhadap candle + klasifikasi
 * KLIPPED vs TRUE_CORRUPTION agar tidak salah antre.
 *
 * 0 request Arjum.
 *
 * Klasifikasi untuk flow=all:
 *   - clipped_25    : 25 level tanpa all_data:true  -> sudah masuk antrean lama (bukan temuan baru)
 *   - empty_but_volume : brokers/levels kosong padahal volume candle > 0  -> KORUPSI NYATA
 *   - parse_error   : JSON tidak bisa dibaca        -> KORUPSI NYATA
 *   - unclipped_imbalance : buy != sell > 0.5% saat file SUDAH unclipped -> KORUPSI NYATA
 *   - unclipped_ratio_below : rasio < 0.95 saat sudah unclipped          -> KORUPSI NYATA
 *   - unclipped_ratio_above : rasio > 1.25 saat sudah unclipped          -> PERINGATAN (mungkin NG day)
 *   - valid
 *
 * Klasifikasi untuk flow=F:
 *   - f_exceeds_all   : totalBuy(F) > totalBuy(all) * 1.01  -> KORUPSI NYATA
 *   - f_missing_in_all: ada broker di F yang tidak ada di all -> KORUPSI NYATA
 *   - f_empty_but_volume: F kosong & all punya nilai         -> KORUPSI NYATA
 *   - valid
 */

const fs = require('fs');
const path = require('path');
const validator = require('/home/ubuntu/auto-cuan/lib/broksum-validator');

const BASE = '/home/ubuntu/auto-cuan/data/arjum-data';
const ALL_DIR = path.join(BASE, 'broker-summary');
const F_DIR = path.join(BASE, 'broker-summary-F');
const CANDLES_DIR = '/home/ubuntu/auto-cuan/data/daily-candles';
const OUT_PATH = '/tmp/broksum_sanity_report_v2.json';

const DATE_FROM = '2026-01-02';
const DATE_TO = '2026-10-16';

// ── Candle index ──────────────────────────────────────────────────────────
const candleIndex = new Map();
{
  const files = fs.readdirSync(CANDLES_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const tk = f.replace('.json', '');
    const map = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CANDLES_DIR, f), 'utf8'));
      for (const c of (data.candles || [])) {
        const d = String(c.date || c.time || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          map.set(d, {
            close: Number(c.close),
            volume: Number(c.volume),
            value: c.value != null ? Number(c.value) : (c.turnover != null ? Number(c.turnover) : null)
          });
        }
      }
    } catch (_) {}
    candleIndex.set(tk, map);
  }
}
function getCandle(t, d) {
  const m = candleIndex.get(t);
  return m ? (m.get(d) || null) : null;
}

// ── Scan ALL ──────────────────────────────────────────────────────────────
function scanAll() {
  const out = [];
  const dirs = fs.readdirSync(ALL_DIR);
  for (const tk of dirs) {
    const tkDir = path.join(ALL_DIR, tk);
    let isDir = false;
    try { isDir = fs.statSync(tkDir).isDirectory(); } catch (_) {}
    if (!isDir) continue;

    for (const f of fs.readdirSync(tkDir)) {
      if (!f.endsWith('.json') || f === 'latest.json') continue;
      const date = f.replace('.json', '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < DATE_FROM || date > DATE_TO) continue;
      const fullPath = path.join(tkDir, f);

      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(fullPath).size; } catch (_) { continue; }

      let payload = null, parseError = null;
      try { payload = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch (e) { parseError = e.message; }

      const candle = getCandle(tk, date);
      const totals = parseError
        ? { totalBuy: 0, totalSell: 0, brokerCount: 0, codes: [] }
        : validator.summarizeBroksumTotals(payload);
      const turnover = validator.candleTurnoverOf(candle);
      const candleVol = candle ? Number(candle.volume || 0) : 0;
      const ratio = turnover > 0 && totals.totalBuy > 0 ? totals.totalBuy / turnover : null;

      const levelsLen = payload && Array.isArray(payload.broker_levels) ? payload.broker_levels.length : 0;
      const brokersLen = payload && Array.isArray(payload.brokers) ? payload.brokers.length : 0;
      const isClipped = levelsLen === 25 && (!payload || payload.all_data !== true);
      const isDerivedNoTrade = payload && payload.derived === 'no-trade';

      let category = 'valid';
      const flags = [];

      if (parseError) {
        category = 'parse_error';
        flags.push('parse_error');
      } else if (isDerivedNoTrade) {
        if (candleVol > 0) { category = 'empty_but_volume'; flags.push('no_trade_but_candle_has_volume'); }
      } else if (totals.brokerCount === 0 && candleVol > 0) {
        category = 'empty_but_volume';
        flags.push('empty_broksum_but_candle_has_volume');
      } else if (isClipped) {
        category = 'clipped_25';
        flags.push('clipped_25_levels');
      } else {
        // Sudah unclipped: baru validasi penuh
        if (totals.totalBuy > 0 && turnover > 0) {
          if (ratio < 0.95) { category = 'unclipped_ratio_below'; flags.push('unclipped_ratio_below'); }
          else if (ratio > 1.25) { category = 'unclipped_ratio_above'; flags.push('unclipped_ratio_above'); }
        }
        if (totals.totalBuy > 0 || totals.totalSell > 0) {
          const denom = Math.max(totals.totalBuy, totals.totalSell);
          if (denom > 0 && Math.abs(totals.totalBuy - totals.totalSell) / denom > 0.005) {
            if (category === 'valid') { category = 'unclipped_imbalance'; }
            flags.push('unclipped_imbalance');
          }
        }
      }

      out.push({
        ticker: tk, date, flow: 'all',
        sizeBytes, category, flags, ratio: ratio != null ? Number(ratio.toFixed(4)) : null,
        brokerCount: totals.brokerCount, brokersLen, levelsLen,
        totalBuy: totals.totalBuy, totalSell: totals.totalSell,
        candleTurnover: turnover, candleVolume: candleVol,
        isClipped, isDerivedNoTrade,
        allDataFlag: payload && payload.all_data === true,
        codes: totals.codes,
        path: fullPath
      });
    }
  }
  return out;
}

// ── Scan F ────────────────────────────────────────────────────────────────
function scanF(allIndex) {
  const out = [];
  if (!fs.existsSync(F_DIR)) return out;
  const dirs = fs.readdirSync(F_DIR);
  for (const tk of dirs) {
    const tkDir = path.join(F_DIR, tk);
    let isDir = false;
    try { isDir = fs.statSync(tkDir).isDirectory(); } catch (_) {}
    if (!isDir) continue;

    for (const f of fs.readdirSync(tkDir)) {
      if (!f.endsWith('.json') || f === 'latest.json') continue;
      const date = f.replace('.json', '.json');
      const dKey = f.replace('.json', '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dKey) || dKey < DATE_FROM || dKey > DATE_TO) continue;
      const fullPath = path.join(tkDir, f);

      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(fullPath).size; } catch (_) { continue; }

      let payload = null, parseError = null;
      try { payload = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch (e) { parseError = e.message; }

      const totals = parseError
        ? { totalBuy: 0, totalSell: 0, brokerCount: 0, codes: [] }
        : validator.summarizeBroksumTotals(payload);
      const isDerivedNoTrade = payload && payload.derived === 'no-trade';

      const allRec = allIndex.get(`${tk}|${dKey}`);
      const flags = [];
      let category = 'valid';

      if (parseError) {
        category = 'f_parse_error'; flags.push('parse_error');
      } else if (isDerivedNoTrade) {
        if (allRec && allRec.totalBuy > 0) { category = 'f_empty_but_all_has_value'; flags.push('f_no_trade_but_all_has_value'); }
      } else if (totals.brokerCount === 0 && allRec && allRec.totalBuy > 0) {
        category = 'f_empty_but_all_has_value'; flags.push('f_empty_but_all_has_value');
      } else if (allRec) {
        if (allRec.totalBuy > 0 && totals.totalBuy > allRec.totalBuy * 1.01) {
          category = 'f_exceeds_all'; flags.push('f_buy_exceeds_all');
        }
        if (allRec.totalSell > 0 && totals.totalSell > allRec.totalSell * 1.01) {
          if (category === 'valid') category = 'f_exceeds_all';
          flags.push('f_sell_exceeds_all');
        }
        // Broker F harus ada di all -- HANYA bila file all dipastikan LENGKAP,
        // yaitu membawa tanda eksplisit `all_data === true`. Tanpa tanda itu,
        // `all` kemungkinan besar masih dibatasi level_limit (default 100),
        // sehingga broker tambahan di F adalah normal, bukan korupsi F.
        if (allRec.allDataFlag === true) {
          const allCodes = new Set(allRec.codes || []);
          const fCodes = new Set(totals.codes || []);
          let missing = 0;
          for (const c of fCodes) if (!allCodes.has(c)) missing++;
          if (missing > 0) {
            if (category === 'valid') category = 'f_broker_missing_in_all';
            flags.push('f_broker_missing_in_all');
          }
        }
      }

      out.push({
        ticker: tk, date: dKey, flow: 'F',
        sizeBytes, category, flags,
        brokerCount: totals.brokerCount, totalBuy: totals.totalBuy, totalSell: totals.totalSell,
        allBuy: allRec ? allRec.totalBuy : null,
        allSell: allRec ? allRec.totalSell : null,
        allCategory: allRec ? allRec.category : null,
        isDerivedNoTrade,
        path: fullPath
      });
    }
  }
  return out;
}

// ── Eksekusi ──────────────────────────────────────────────────────────────
console.error('[SCAN] Loading candles...');
const allRecs = scanAll();
console.error(`[SCAN] all scanned = ${allRecs.length}`);

const allIndex = new Map();
for (const r of allRecs) allIndex.set(`${r.ticker}|${r.date}`, r);

console.error('[SCAN] Scanning F...');
const fRecs = scanF(allIndex);
console.error(`[SCAN] F scanned = ${fRecs.length}`);

// ── Kategori utama (all) ──────────────────────────────────────────────────
const catCount = {};
for (const r of allRecs) catCount[r.category] = (catCount[r.category] || 0) + 1;

const catCountF = {};
for (const r of fRecs) catCountF[r.category] = (catCountF[r.category] || 0) + 1;

// TRUE CORRUPTION = kategori selain valid & clipped_25 & unclipped_ratio_above
const TRUE_CATS = ['parse_error', 'empty_but_volume', 'unclipped_imbalance', 'unclipped_ratio_below'];
const trueCorruptionAll = allRecs.filter(r => TRUE_CATS.includes(r.category));
const ratioAboveAll = allRecs.filter(r => r.category === 'unclipped_ratio_above');
const clippedAll = allRecs.filter(r => r.category === 'clipped_25');

const TRUE_CATS_F = ['f_parse_error', 'f_empty_but_all_has_value', 'f_exceeds_all', 'f_broker_missing_in_all'];
const trueCorruptionF = fRecs.filter(r => TRUE_CATS_F.includes(r.category));

// ── Agregasi ──────────────────────────────────────────────────────────────
function byDate(recs) {
  const m = new Map();
  for (const r of recs) {
    if (!m.has(r.date)) m.set(r.date, { count: 0, tickers: new Set() });
    const e = m.get(r.date);
    e.count++;
    e.tickers.add(r.ticker);
  }
  return Array.from(m.entries())
    .map(([date, e]) => ({ date, count: e.count, uniqueTickers: e.tickers.size }))
    .sort((a, b) => b.count - a.count);
}
function byTicker(recs) {
  const m = new Map();
  for (const r of recs) m.set(r.ticker, (m.get(r.ticker) || 0) + 1);
  return Array.from(m.entries()).map(([ticker, count]) => ({ ticker, count })).sort((a, b) => b.count - a.count);
}

// 10 terburuk = rasio terjauh dari 1 atau flag paling berat
function worst(recs) {
  const scored = recs.map(r => {
    let sev = 0;
    if (r.category === 'parse_error' || r.category === 'f_parse_error') sev = 10000;
    else if (r.category === 'empty_but_volume' || r.category === 'f_empty_but_all_has_value') sev = 9000;
    else if (r.category === 'unclipped_imbalance' || r.category === 'f_exceeds_all') sev = 8000;
    else if (r.ratio != null) sev = Math.abs(r.ratio - 1) * 100;
    return { r, sev };
  });
  scored.sort((a, b) => b.sev - a.sev);
  return scored.slice(0, 10).map(s => s.r);
}

// ── Tulis laporan ─────────────────────────────────────────────────────────
const report = {
  generated_at: new Date().toISOString(),
  date_range: { from: DATE_FROM, to: DATE_TO },
  summary: {
    all_scanned: allRecs.length,
    all_valid: catCount.valid || 0,
    all_clipped_25: catCount.clipped_25 || 0,
    all_unclipped_ratio_above_warn: catCount.unclipped_ratio_above || 0,
    all_true_corruption: trueCorruptionAll.length,
    all_true_corruption_pct: Number(((trueCorruptionAll.length / Math.max(1, allRecs.length)) * 100).toFixed(3)),
    f_scanned: fRecs.length,
    f_valid: catCountF.valid || 0,
    f_true_corruption: trueCorruptionF.length,
    f_true_corruption_pct: Number(((trueCorruptionF.length / Math.max(1, fRecs.length)) * 100).toFixed(3))
  },
  all_category_breakdown: catCount,
  f_category_breakdown: catCountF,
  all_true_corruption_by_date: byDate(trueCorruptionAll).slice(0, 30),
  all_true_corruption_by_ticker: byTicker(trueCorruptionAll).slice(0, 30),
  all_ratio_above_by_date: byDate(ratioAboveAll).slice(0, 15),
  f_true_corruption_by_date: byDate(trueCorruptionF).slice(0, 30),
  worst_all: worst(trueCorruptionAll),
  worst_f: worst(trueCorruptionF),
  list_true_corruption_all: trueCorruptionAll.map(r => ({
    ticker: r.ticker, date: r.date, category: r.category, flags: r.flags, ratio: r.ratio,
    brokerCount: r.brokerCount, levelsLen: r.levelsLen, totalBuy: r.totalBuy,
    candleTurnover: r.candleTurnover, candleVolume: r.candleVolume, sizeBytes: r.sizeBytes
  })),
  list_true_corruption_f: trueCorruptionF.map(r => ({
    ticker: r.ticker, date: r.date, category: r.category, flags: r.flags,
    brokerCount: r.brokerCount, totalBuy: r.totalBuy, allBuy: r.allBuy, sizeBytes: r.sizeBytes
  }))
};

fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
console.error(`[SCAN] Written: ${OUT_PATH}`);

// Ringkasan ke stdout
console.log(JSON.stringify({
  summary: report.summary,
  all_category_breakdown: report.all_category_breakdown,
  f_category_breakdown: report.f_category_breakdown,
  all_true_corruption_by_date: report.all_true_corruption_by_date.slice(0, 15),
  all_true_corruption_by_ticker: report.all_true_corruption_by_ticker.slice(0, 15),
  all_ratio_above_by_date: report.all_ratio_above_by_date,
  f_true_corruption_by_date: report.f_true_corruption_by_date.slice(0, 15),
  worst_all: report.worst_all,
  worst_f: report.worst_f
}, null, 2));
