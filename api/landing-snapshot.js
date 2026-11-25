'use strict';
/**
 * V3-F07 / V6.5.4 — /api/landing-snapshot (publik, tanpa auth).
 * Menyajikan snapshot EOD riil Three-Horizon terbaru (`data/three-horizon-latest.json`)
 * dengan fallback ke snapshot v3f04 hanya jika file Three-Horizon belum ada.
 * 0 mock, 0 sintetis. Gagal jujur bila file hilang/korup (success:false).
 */
const fs = require('fs');
const path = require('path');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickRow(r, fallbackHorizonLabel) {
  if (!r || typeof r !== 'object') return null;
  const ticker = String(r.ticker || '').toUpperCase().trim();
  const lastPrice = num(r.last_price != null ? r.last_price : r.close);
  if (!ticker || lastPrice == null || lastPrice < 1) return null;
  const entryLow = num(r.entry_low != null ? r.entry_low : r.entry2);
  const entryHigh = num(r.entry_high != null ? r.entry_high : r.entry1);
  const sl = num(r.stop_loss != null ? r.stop_loss : r.sl);
  if (entryLow != null && entryLow < 1) return null;
  if (sl != null && sl < 1) return null;
  return {
    ticker,
    emiten: r.emiten || r.company_name || ticker,
    score: num(r.score != null ? r.score : r.conviction_score),
    last_price: lastPrice,
    entry_low: entryLow,
    entry_high: entryHigh,
    entry: num(entryHigh != null ? entryHigh : lastPrice),
    tp: num(r.tp1 != null ? r.tp1 : r.tp),
    tp2: num(r.tp2),
    sl,
    rr: num(r.risk_reward != null ? r.risk_reward : r.rr),
    change_pct: num(r.change_pct),
    volume_ratio: num(r.volume_ratio_20d != null ? r.volume_ratio_20d : r.volume_ratio),
    rsi14: num(r.rsi14),
    status: r.status != null ? String(r.status) : 'READY',
    holding_label: r.holding_label || fallbackHorizonLabel || null,
    horizon: r.horizon || r.horizon_key || null,
    signal_age_status: r.signal_age_status || 'BARU',
    signal_age_label: r.signal_age_label || 'BARU',
    machine: r.holding_label || r.horizon_label || r.machine || fallbackHorizonLabel || 'Three-Horizon EOD',
    trade_date: r.trade_date != null ? String(r.trade_date) : null
  };
}

function buildThreeHorizonLanding(threeDoc) {
  if (!threeDoc || !threeDoc.horizons || !threeDoc.trade_date) return null;
  const tradeDate = String(threeDoc.trade_date).slice(0, 10);
  const hMap = threeDoc.horizons;
  const specs = [
    { key: 'potensi_besok', label: 'Potensi Besok (1–5H)' },
    { key: 'short_swing', label: 'Short Swing (3–10H)' },
    { key: 'swing', label: 'Swing (7–30H)' }
  ];

  const horizonsOut = {};
  const sectors = [];
  for (const s of specs) {
    const src = hMap[s.key] || {};
    const list = (Array.isArray(src.top20) ? src.top20 : (Array.isArray(src.picks) ? src.picks : []))
      .map((r) => pickRow(r, src.holding_label || s.label))
      .filter(Boolean);
    horizonsOut[s.key] = {
      key: s.key,
      label: src.holding_label || s.label,
      published_count: list.length,
      universe_count: num(src.universe_count) || list.length,
      max_holding_days: num(src.holding_days_max),
      top5: list.slice(0, 5)
    };
    let sumChg = 0; let cnt = 0; let leader = list[0] ? list[0].ticker : null;
    for (const r of list) {
      if (r.change_pct != null) { sumChg += r.change_pct; cnt += 1; }
    }
    sectors.push({
      name: s.label,
      key: s.key,
      change_pct: cnt > 0 ? Math.round((sumChg / cnt) * 100) / 100 : null,
      leader
    });
  }

  const primaryList = (horizonsOut.short_swing && horizonsOut.short_swing.top5.length)
    ? horizonsOut.short_swing.top5
    : ((horizonsOut.potensi_besok && horizonsOut.potensi_besok.top5) || []);
  const dtSource = (horizonsOut.potensi_besok && horizonsOut.potensi_besok.top5) || [];
  const dtSignals = dtSource.slice(0, 3).map((r) => ({
    ticker: r.ticker,
    signal_type: r.status || 'READY',
    entry: r.entry,
    tp: r.tp,
    sl: r.sl,
    rr: r.rr,
    last_price: r.last_price,
    change_pct: r.change_pct,
    created_at: tradeDate
  }));

  return {
    trade_date: tradeDate,
    session_status: 'FINAL_EOD',
    is_eod_final: true,
    sectors,
    dt_signals: dtSignals,
    top_picks: primaryList.slice(0, 5),
    horizons: horizonsOut,
    generated_at: threeDoc.generated_at || new Date().toISOString(),
    source: 'three-horizon-latest'
  };
}

let _cachedLandingPayload = null;
let _cachedLandingAt = 0;
const LANDING_CACHE_TTL_MS = 30 * 1000;

module.exports = async function handler(req, res) {
  try {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
      return res.end(JSON.stringify({ success: false, error: 'Method tidak didukung.' }));
    }

    const now = Date.now();
    if (_cachedLandingPayload && (now - _cachedLandingAt < LANDING_CACHE_TTL_MS)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
      return res.end(_cachedLandingPayload);
    }

    const root = path.resolve(__dirname, '..');
    const threeDoc = readJson(path.join(root, 'data', 'three-horizon-latest.json'));
    const threeSnap = buildThreeHorizonLanding(threeDoc);
    if (threeSnap) {
      const bodyStr = JSON.stringify({
        success: true,
        stale: false,
        updated_at: threeSnap.generated_at,
        snapshot: threeSnap
      });
      _cachedLandingPayload = bodyStr;
      _cachedLandingAt = now;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
      return res.end(bodyStr);
    }

    const k = readJson(path.join(root, 'data', 'screener-v3f04-konglo.json'));
    const n = readJson(path.join(root, 'data', 'screener-v3f04-nonkonglo.json'));
    const d = readJson(path.join(root, 'data', 'screener-v3f04-daytrade.json'));
    if (!k || !n || !d) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
      return res.end(JSON.stringify({ success: false, error: 'Snapshot EOD belum tersedia.' }));
    }
    const tradeDate = k.trade_date || n.trade_date || d.trade_date || null;
    const sessionOk = (k.session_status === 'FINAL_EOD' && k.is_eod_final === true)
      && (n.session_status === 'FINAL_EOD' && n.is_eod_final === true)
      && (d.session_status === 'FINAL_EOD' && d.is_eod_final === true);
    if (!tradeDate || sessionOk !== true) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
      return res.end(JSON.stringify({ success: false, error: 'Snapshot EOD belum final.' }));
    }
    const kRows = Array.isArray(k.results) ? k.results.map((r) => pickRow(r, 'Short Swing')).filter(Boolean) : [];
    const nRows = Array.isArray(n.results) ? n.results.map((r) => pickRow(r, 'Swing')).filter(Boolean) : [];
    const dPub = Array.isArray(d.results) ? d.results.map((r) => pickRow(r, 'Potensi Besok')).filter(Boolean) : [];
    const dRadar = (Array.isArray(d.radar) ? d.radar : []).map((r) => pickRow(r, 'Potensi Besok')).filter(Boolean);
    const dtSource = dPub.length ? dPub : dRadar.slice(0, 3);
    const dtSignals = dtSource.slice(0, 3).map((r) => ({
      ticker: r.ticker, signal_type: r.status || 'WATCH', entry: r.entry, tp: r.tp, sl: r.sl, rr: r.rr,
      last_price: r.last_price, change_pct: r.change_pct, created_at: tradeDate
    }));
    const combined = kRows.concat(nRows).filter((r) => r.score != null).sort((a, b) => b.score - a.score).slice(0, 5);
    const bodyStr = JSON.stringify({
      success: true,
      stale: false,
      updated_at: k.calculated_at || k.updated_at || new Date().toISOString(),
      snapshot: {
        trade_date: tradeDate,
        session_status: 'FINAL_EOD',
        is_eod_final: true,
        sectors: [],
        dt_signals: dtSignals,
        top_picks: combined,
        konglo: { published_count: k.published_count, universe_count: k.universe_count },
        nonkonglo: { published_count: n.published_count, universe_count: n.universe_count },
        daytrade: { published_count: d.published_count, radar_count: dRadar.length },
        generated_at: new Date().toISOString(),
        source: 'eod-screener-v3f04'
      }
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    return res.end(bodyStr);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ success: false, error: 'Gagal membaca snapshot EOD.' }));
  }
};
