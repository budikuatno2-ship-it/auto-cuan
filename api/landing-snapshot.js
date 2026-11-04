'use strict';
/**
 * V3-F07 — /api/landing-snapshot (publik, tanpa auth).
 * Menyajikan snapshot EOD riil dari 3 mesin screener V3-F04
 * (data/screener-v3f04-{konglo,nonkonglo,daytrade}.json).
 * 0 mock, 0 sintetis: seluruh angka berasal dari file EOD 2026-11-03 FINAL_EOD.
 * Gagal jujur bila file hilang/korup (success:false), tidak pernah mengarang.
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
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickRow(r) {
  if (!r || typeof r !== 'object') return null;
  const ticker = String(r.ticker || '').toUpperCase().trim();
  if (!ticker) return null;
  return {
    ticker,
    score: num(r.score != null ? r.score : r.conviction_score),
    last_price: num(r.last_price != null ? r.last_price : r.close),
    entry_low: num(r.entry_low),
    entry_high: num(r.entry_high),
    entry: num(r.entry_high != null ? r.entry_high : r.last_price),
    tp: num(r.tp1 != null ? r.tp1 : r.tp),
    sl: num(r.stop_loss != null ? r.stop_loss : r.sl),
    rr: num(r.risk_reward != null ? r.risk_reward : r.rr),
    change_pct: num(r.change_pct),
    status: r.status != null ? String(r.status) : null,
    machine: r.machine != null ? String(r.machine) : null,
    trade_date: r.trade_date != null ? String(r.trade_date) : null
  };
}

module.exports = async function handler(req, res) {
  try {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
      return res.end(JSON.stringify({ success: false, error: 'Method tidak didukung.' }));
    }
    const root = path.resolve(__dirname, '..');
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
    const kRows = Array.isArray(k.results) ? k.results.map(pickRow).filter(Boolean) : [];
    const nRows = Array.isArray(n.results) ? n.results.map(pickRow).filter(Boolean) : [];
    const dPub = Array.isArray(d.results) ? d.results.map(pickRow).filter(Boolean) : [];
    const dRadarRaw = Array.isArray(d.radar) ? d.radar : [];
    const dRadar = dRadarRaw.map((r) => {
      const base = pickRow(r);
      if (!base) return null;
      base.volume_ratio = num(r.volume_ratio_20d != null ? r.volume_ratio_20d : r.volume_ratio);
      base.rsi = num(r.rsi14 != null ? r.rsi14 : r.rsi);
      return base;
    }).filter(Boolean);

    // Sektor: ringkasan riil per mesin (rata-rata change + leader skor tertinggi).
    function sectorOf(name, rows) {
      if (!rows.length) return { name, change_pct: null, leader: null };
      let sum = 0; let cnt = 0; let leader = null; let best = -Infinity;
      for (const r of rows) {
        if (r.change_pct != null) { sum += r.change_pct; cnt += 1; }
        if (r.score != null && r.score > best) { best = r.score; leader = r.ticker; }
      }
      const avg = cnt > 0 ? Math.round((sum / cnt) * 100) / 100 : null;
      return { name, change_pct: avg, leader };
    }
    const sectors = [
      sectorOf('KONGLO-165', kRows),
      sectorOf('NONKONGLO-165', nRows),
      sectorOf('DAY-TRADE-165', dPub.length ? dPub : dRadar)
    ];

    // Sinyal day-trade: published bila ada, bila 0 pakai radar WAIT (jujur, status asli).
    const dtSource = dPub.length ? dPub : dRadar.slice(0, 3);
    const dtSignals = dtSource.slice(0, 3).map((r) => ({
      ticker: r.ticker,
      signal_type: dPub.length ? (r.status || 'TRADE') : (dRadarRaw.find((x) => String(x.ticker).toUpperCase() === r.ticker)?.status || 'WATCH'),
      entry: r.entry,
      tp: r.tp,
      sl: r.sl,
      rr: r.rr,
      last_price: r.last_price,
      change_pct: r.change_pct,
      created_at: tradeDate
    }));

    // Top picks gabungan konglo+nonkonglo urut skor desc (maks 5).
    const combined = kRows.concat(nRows).filter((r) => r.score != null)
      .sort((a, b) => b.score - a.score).slice(0, 5);
    const topPicks = combined.map((r) => ({
      ticker: r.ticker,
      score: r.score,
      last_price: r.last_price,
      entry_low: r.entry_low,
      entry_high: r.entry_high,
      tp: r.tp,
      sl: r.sl,
      rr: r.rr,
      change_pct: r.change_pct,
      machine: r.machine
    }));

    const snapshot = {
      trade_date: tradeDate,
      session_status: 'FINAL_EOD',
      is_eod_final: true,
      sectors,
      dt_signals: dtSignals,
      top_picks: topPicks,
      konglo: { published_count: k.published_count, universe_count: k.universe_count },
      nonkonglo: { published_count: n.published_count, universe_count: n.universe_count },
      daytrade: { published_count: d.published_count, radar_count: dRadar.length },
      generated_at: new Date().toISOString(),
      source: 'eod-screener-v3f04'
    };

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
    return res.end(JSON.stringify({
      success: true,
      stale: false,
      updated_at: k.calculated_at || k.updated_at || new Date().toISOString(),
      snapshot
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ success: false, error: 'Gagal membaca snapshot EOD.' }));
  }
};
