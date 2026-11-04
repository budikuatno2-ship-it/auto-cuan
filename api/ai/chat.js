'use strict';
/**
 * V3-F08 — /api/ai/chat (publik, tanpa auth, tanpa kuota).
 * Matriks angka tegas + chat kuantitatif dari DATA RIIL:
 *   - Swing High/Low 60 bar terakhir dari store pasar lokal (sqlite/file).
 *   - Fibonacci Retracement 0,0/23,6/38,2/50,0/61,8/78,6/100,0% + Extension 127,2/161,8%.
 *   - Area Entry, SL + %risiko, TP1, TP2, R/R, Support & Resistance 20 bar.
 *   - LPM via lib/liquidity-profiler (calculateLPMData) — angka yang sama dipakai jawaban chat.
 * GET  /api/ai/chat?ticker=BBCA   -> matriks JSON.
 * POST /api/ai/chat {message,ticker} -> {success:true, reply, ...} ringkas (<140px bubble).
 * TIDAK PERNAH mengembalikan frasa-mati — selalu jawab kuantitatif
 * dari data riil, atau 4xx jujur bila ticker tidak ada di data lokal.
 */
const store = require('../../lib/local-market-subset-store');
const profiler = require('../../lib/liquidity-profiler');

const RETRA = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
const RETRA_LABELS = ['0,0%', '23,6%', '38,2%', '50,0%', '61,8%', '78,6%', '100,0%'];
const EXT = [1.272, 1.618];
const EXT_LABELS = ['Ext 127,2%', 'Ext 161,8%'];

function tickSize(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return 1;
  if (p < 200) return 1;
  if (p < 500) return 2;
  if (p < 2000) return 5;
  if (p < 5000) return 10;
  return 25;
}

function roundTick(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const t = tickSize(p);
  return Math.round(p / t) * t;
}

function fmtRp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return 'Rp ' + Math.round(v).toLocaleString('id-ID');
}

function fmtPct1(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v.toFixed(1).replace('.', ',') + '%';
}

function fmtX1(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v.toFixed(1).replace('.', ',') + 'x';
}

function atr14(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const start = Math.max(1, candles.length - 14);
  let sum = 0;
  let cnt = 0;
  for (let i = start; i < candles.length; i++) {
    const h = Number(candles[i].high != null ? candles[i].high : candles[i].close);
    const l = Number(candles[i].low != null ? candles[i].low : candles[i].close);
    const pc = Number(candles[i - 1].close);
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (Number.isFinite(tr) && tr > 0) { sum += tr; cnt += 1; }
  }
  if (!cnt) return null;
  return sum / cnt;
}

function clampScore(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(5, Math.min(95, n));
}

function fmtFlow(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (a >= 1e9) return sign + 'Rp ' + (a / 1e9).toFixed(1).replace('.', ',') + ' M';
  if (a >= 1e6) return sign + 'Rp ' + Math.round(a / 1e6).toLocaleString('id-ID') + ' Jt';
  return sign + 'Rp ' + Math.round(a).toLocaleString('id-ID');
}

function computeMatrix(rawTicker) {
  const ticker = String(rawTicker || '').trim().toUpperCase().replace(/\.JK$/i, '');
  if (!/^[A-Z0-9]{3,6}$/.test(ticker)) return { ok: false, error: 'Ticker tidak valid.' };
  const pack = store.getCandles(ticker);
  if (!pack || !Array.isArray(pack.candles) || pack.candles.length < 20) {
    return { ok: false, error: 'Ticker ' + ticker + ' tidak ada di data lokal.' };
  }
  const candles = pack.candles;
  const last = Number(pack.latest.last);
  const asOf = pack.latest.date || null;
  const win60 = candles.slice(-60);
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of win60) {
    const h = Number(c.high != null ? c.high : c.close);
    const l = Number(c.low != null ? c.low : c.close);
    if (Number.isFinite(h) && h > hi) hi = h;
    if (Number.isFinite(l) && l < lo) lo = l;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= 0 || lo <= 0) {
    return { ok: false, error: 'Data candle ' + ticker + ' rusak.' };
  }
  let range = hi - lo;
  const atr = atr14(candles) || Math.max(tickSize(last), last * 0.02);
  if (!(range > 0)) range = Math.max(atr, last * 0.02);

  const fibo = RETRA.map((r, i) => ({
    label: RETRA_LABELS[i],
    ratio: r,
    price: roundTick(hi - r * range)
  })).concat(EXT.map((r, i) => ({
    label: EXT_LABELS[i],
    ratio: r,
    price: roundTick(hi + (r - 1) * range)
  })));

  const win20 = candles.slice(-20);
  const support = Math.min.apply(null, win20.map((c) => Number(c.low != null ? c.low : c.close)));
  const resistance = Math.max.apply(null, win20.map((c) => Number(c.high != null ? c.high : c.close)));
  const swingLow5 = Math.min.apply(null, candles.slice(-5).map((c) => Number(c.low != null ? c.low : c.close)));

  let entryHigh = roundTick(last);
  let entryLow = roundTick(last - 0.3 * atr);
  if (entryLow == null || entryLow >= entryHigh) entryLow = roundTick(entryHigh - tickSize(entryHigh));
  let sl = roundTick(Math.min(swingLow5, support));
  if (sl == null || sl >= entryLow) sl = roundTick(entryLow - Math.max(atr, tickSize(entryLow)));
  const tp1 = roundTick(entryHigh + atr);
  const tp2 = roundTick(entryHigh + 2 * atr);
  const riskPct = ((entryLow - sl) / entryLow) * 100;
  const rr = (tp1 - entryHigh) / Math.max(1, entryHigh - sl);

  const lpm = profiler.calculateLPMData(candles, 20);
  const m = pack.metrics || {};
  const ma20 = Number(m.ma20);
  const ma50 = Number(m.ma50);
  const rsi = Number(m.rsi14);
  const rvol = Number(m.volumeVsAvg20);

  let foreignNet = null;
  try {
    const s = store.loadStore();
    const feat = s && s.features ? s.features[ticker] : null;
    const raw = feat ? (feat.foreign_net_today != null ? feat.foreign_net_today
      : (feat.foreign_net_val != null ? feat.foreign_net_val : null)) : null;
    if (raw != null && Number.isFinite(Number(raw))) foreignNet = Number(raw);
  } catch (_) { foreignNet = null; }

  const pillars = [
    {
      id: 'trend',
      label: 'Tren & MA20',
      score: clampScore(50 + (last > ma20 ? 15 : -15) + (last > ma50 ? 10 : -10)
        + (rsi >= 40 && rsi <= 70 ? 10 : -5)),
      display: fmtRp(ma20),
      note: 'Harga ' + fmtRp(last) + ' vs MA20 ' + fmtRp(ma20)
    },
    {
      id: 'lpm',
      label: 'Momentum LPM',
      score: clampScore(50 + (lpm.isPositive ? 20 : -10) + (lpm.isRising ? 15 : -10)),
      display: fmtRp(lpm.lastValue),
      note: 'LPM ' + (lpm.isPositive ? 'di atas' : 'di bawah') + ' rerata, tren '
        + (lpm.isRising ? 'menanjak' : 'melemah')
    },
    {
      id: 'volume',
      label: 'Volume vs Rata2',
      score: clampScore(50 + (rvol - 1) * 50),
      display: Number.isFinite(rvol) ? rvol.toFixed(2).replace('.', ',') + 'x' : null,
      note: 'RVOL ' + (Number.isFinite(rvol) ? rvol.toFixed(2).replace('.', ',') + 'x' : '—')
    },
    {
      id: 'foreign',
      label: 'Arus Asing',
      score: foreignNet == null ? null : clampScore(50 + (foreignNet > 0 ? 20 : foreignNet < 0 ? -15 : 0)),
      display: foreignNet == null ? null : fmtFlow(foreignNet),
      note: foreignNet == null ? 'Data asing belum tersedia' : 'Net asing sesi terakhir'
    }
  ];

  const lotsDefault = 10;
  const sizing = {
    lots_default: lotsDefault,
    cost_idr: lotsDefault * 100 * entryHigh,
    risk_idr: lotsDefault * 100 * Math.max(0, entryHigh - sl)
  };

  return {
    ok: true,
    ticker,
    last,
    as_of: asOf,
    swing: { high: hi, low: lo },
    fibo,
    plan: {
      entry_low: entryLow,
      entry_high: entryHigh,
      sl,
      risk_pct: riskPct,
      tp1,
      tp2,
      rr,
      support: roundTick(support),
      resistance: roundTick(resistance)
    },
    lpm: {
      value: lpm.lastValue,
      prev: lpm.prevValue,
      ma5: lpm.maValue,
      is_positive: lpm.isPositive,
      is_rising: lpm.isRising
    },
    pillars,
    sizing
  };
}

function buildReply(kind, mx) {
  const p = mx.plan;
  const l = mx.lpm;
  const t = mx.ticker;
  const last = fmtRp(mx.last);
  const lpmRaw = String(Math.round(l.value));
  const lpmRp = fmtRp(l.value);
  const entry = fmtRp(p.entry_low) + '–' + Math.round(p.entry_high).toLocaleString('id-ID');
  const slRaw = String(Math.round(p.sl));
  const sl = fmtRp(p.sl);
  const risk = fmtPct1(p.risk_pct);
  const tp1 = fmtRp(p.tp1);
  const tp2 = fmtRp(p.tp2);
  const rr = fmtX1(p.rr);
  if (kind === 'lpm') {
    return 'LPM ' + t + ' ' + lpmRaw + ' (' + lpmRp + '), harga ' + last + ' — LPM '
      + (l.is_positive ? 'di atas harga' : 'di bawah harga') + ' & tren '
      + (l.is_rising ? 'menanjak (akumulasi)' : 'melemah (distribusi)')
      + '. Entry ' + entry + ', SL ' + slRaw + ' (' + sl + ', ' + risk + '), TP1 ' + tp1
      + ', TP2 ' + tp2 + ', R/R ' + rr + '.';
  }
  if (kind === 'plan') {
    return t + ' @' + last + ': area beli ' + entry + ', stop loss ' + slRaw
      + ' (' + sl + ', risiko ' + risk + '), TP1 ' + tp1 + ', TP2 ' + tp2 + ', R/R ' + rr
      + '. Support ' + fmtRp(p.support) + ', resisten ' + fmtRp(p.resistance) + '.';
  }
  return t + ' @' + last + ' | LPM ' + lpmRaw + ' (' + lpmRp + ', '
    + (l.is_rising ? 'menanjak' : 'melemah')
    + ') | Entry ' + entry + ', SL ' + slRaw + ' (' + risk + '), TP1 ' + tp1
    + ', TP2 ' + tp2 + ', R/R ' + rr + '.';
}

function classify(message) {
  const s = String(message || '').toLowerCase();
  if (s.indexOf('lpm') !== -1) return 'lpm';
  if (s.indexOf('beli') !== -1 || s.indexOf('entry') !== -1 || s.indexOf('stop loss') !== -1
    || s.indexOf('stop-loss') !== -1 || s.indexOf('cut loss') !== -1
    || s.indexOf('area') !== -1 || s.indexOf('sl') !== -1) return 'plan';
  return 'default';
}

async function handler(req, res) {
  try {
    const method = String((req && req.method) || 'GET').toUpperCase();
    const query = (req && req.query) || {};
    if (method === 'GET') {
      const mx = computeMatrix(query.ticker);
      if (!mx.ok) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ success: false, error: mx.error }));
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
      return res.end(JSON.stringify({ success: true, source: 'data-pasar-riil-lokal', data: mx }));
    }
    if (method === 'POST') {
      const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
      const message = String(body.message != null ? body.message : (body.chatMessage || query.message || ''));
      const tickerRaw = body.ticker != null ? body.ticker
        : (body.context && body.context.ticker != null ? body.context.ticker : query.ticker);
      if (!message.trim()) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ success: false, error: 'Pesan kosong.' }));
      }
      const mx = computeMatrix(tickerRaw || 'BBCA');
      if (!mx.ok) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ success: false, error: mx.error }));
      }
      const kind = classify(message);
      const reply = buildReply(kind, mx);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
      return res.end(JSON.stringify({
        success: true,
        ticker: mx.ticker,
        kind,
        reply,
        lpm: mx.lpm.value,
        plan: mx.plan,
        fibo_rows: mx.fibo.length,
        source: 'kuantitatif-lokal-data-riil'
      }));
    }
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ success: false, error: 'Method tidak didukung.' }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ success: false, error: 'Gagal hitung matriks: ' + String((err && err.message) || err).slice(0, 200) }));
  }
}

module.exports = handler;
module.exports.computeMatrix = computeMatrix;
module.exports.buildReply = buildReply;
module.exports.classify = classify;
