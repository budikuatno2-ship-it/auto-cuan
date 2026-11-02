'use strict';
// P4 — Pembangun antrean prioritas backfill penuh (tanpa sampel, tanpa hardcode kuota).
// Sumber: data/completeness/latest.json + pindaian disk fisik (1x per direktori ticker) + kalender IHSG.
// Output: data/backfill-queue.json
//   P1 = Laporan Keuangan Q2 2026 untuk emiten tertahan Q1 (likuid dulu, lalu sisanya).
//        6 berkas per emiten (3 laporan x quarterly/annually) = 1 request per berkas.
//   P2 = sel bolong Broksum ALL (tanggal bursa terbaru mundur).
//   P3 = sel bolong Broksum Foreign: 20 hari bursa terakhir dulu (untuk Akumulasi 1H-20H),
//        lalu sisa jendela hingga tertutup.
//   P4 = sisa histori Foreign lebih tua (< windowStart, cap 120 hari bursa).
// Format item ringkas agar berkas tetap ramping:
//   P1: "TICKER/REPORT-period"  (mis. "AADI/INCOME_STATEMENT-quarterly")
//   P2/P3/P4: "TICKER@YYYY-MM-DD"
// Istilah netral: "Kuota API data". DILARANG print secret.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LATEST = path.join(ROOT, 'data', 'completeness', 'latest.json');
const OUT = path.join(ROOT, 'data', 'backfill-queue.json');
const DAILY_DIR = path.join(ROOT, 'data', 'daily-candles');
const ALL_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary');
const F_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary-F');
const FIN_DIR = path.join(ROOT, 'data', 'arjum-data', 'financial-statements');

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const REPORTS = ['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW_REPORT'];
const PERIODS = ['quarterly', 'annually'];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function listDailyTickers() {
  try {
    return fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch (_) { return []; }
}

function loadCalendar() {
  const ihsg = readJson(path.join(DAILY_DIR, 'IHSG.json'));
  const candles = (ihsg && Array.isArray(ihsg.candles)) ? ihsg.candles : [];
  return candles.map((c) => c && c.date).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}

// Pindai satu direktori ticker SEKALI -> Set tanggal valid (non-kosong, JSON valid).
function scanTickerDates(baseDir, ticker) {
  const out = new Set();
  let ents = [];
  try { ents = fs.readdirSync(path.join(baseDir, ticker)); } catch (_) { return out; }
  for (const e of ents) {
    const m = e.match(DATE_RE);
    if (!m) continue;
    const fp = path.join(baseDir, ticker, e);
    try {
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size === 0) continue;
      const raw = fs.readFileSync(fp, 'utf8');
      if (!raw || !raw.trim()) continue;
      const d = JSON.parse(raw);
      const nonEmpty = d && typeof d === 'object' && (Array.isArray(d) ? d.length > 0 : Object.keys(d).length > 0);
      if (!nonEmpty) continue;
      out.add(m[1]);
    } catch (_) {}
  }
  return out;
}

function detectQ2(items) {
  if (!Array.isArray(items)) return false;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const label = String(it.label || '');
    const year = String(it.year || '');
    const q = String(it.quarter || '').toUpperCase();
    const blob = JSON.stringify([label, year, q, it.period || '', it.date || '', it.end_date || '']).toUpperCase();
    if (label.toUpperCase().includes('Q2 2026') || label.toUpperCase().includes('6M 2026') || blob.includes('2026-06-30')) return true;
    if (year === '2026' && (q === '2' || q === 'Q2' || q === '06' || q === 'H1' || q === '6M')) return true;
  }
  return false;
}

function extractItems(envelope) {
  if (!envelope || typeof envelope !== 'object') return [];
  if (envelope.data && Array.isArray(envelope.data.items)) return envelope.data.items;
  if (Array.isArray(envelope.items)) return envelope.items;
  if (envelope.data && envelope.data.data && Array.isArray(envelope.data.data.items)) return envelope.data.data.items;
  if (envelope.data && Array.isArray(envelope.data.data)) return envelope.data.data;
  if (Array.isArray(envelope.data)) return envelope.data;
  return [];
}

function tickerHasQ2All3(ticker) {
  for (const rep of REPORTS) {
    const fp = path.join(FIN_DIR, ticker, rep + '-quarterly.json');
    let r = null;
    try {
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size === 0) return false;
      r = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (_) { return false; }
    if (!detectQ2(extractItems(r))) return false;
  }
  return true;
}

function avgTurnoverCached(ticker, cache) {
  if (cache.has(ticker)) return cache.get(ticker);
  let v = 0;
  try {
    const j = readJson(path.join(DAILY_DIR, ticker + '.json'));
    const candles = (j && Array.isArray(j.candles)) ? j.candles : [];
    const tail = candles.slice(-60);
    let sum = 0;
    let n = 0;
    for (const c of tail) {
      const vol = Number(c.volume || 0);
      const close = Number(c.close || 0);
      if (vol > 0 && close > 0) { sum += vol * close; n += 1; }
    }
    v = n ? sum / n : 0;
  } catch (_) { v = 0; }
  cache.set(ticker, v);
  return v;
}

function build() {
  const latest = readJson(LATEST);
  const tickers = listDailyTickers();
  const emitens = tickers.filter((t) => t !== 'IHSG');
  const calendar = loadCalendar();
  const lastDay = calendar.length ? calendar[calendar.length - 1] : (latest && latest.calendar ? latest.calendar.last : null);
  let windowStart = latest && latest.broksumALL ? latest.broksumALL.windowStart : null;
  if (!windowStart) {
    try {
      const dirs = fs.readdirSync(ALL_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).slice(0, 60);
      for (const td of dirs) {
        let ents = [];
        try { ents = fs.readdirSync(path.join(ALL_DIR, td)); } catch (_) { continue; }
        for (const e of ents) {
          const m = e.match(DATE_RE);
          if (m && (!windowStart || m[1] < windowStart)) windowStart = m[1];
        }
      }
    } catch (_) {}
  }
  if (!windowStart && calendar.length) windowStart = calendar[0];
  const expectedDates = calendar.filter((d) => !windowStart || d >= windowStart).sort();

  // ---- Pindai disk SEKALI per ticker (ALL + F) ----
  const allMap = new Map();
  const fMap = new Map();
  for (const t of tickers) {
    allMap.set(t, scanTickerDates(ALL_DIR, t));
    fMap.set(t, scanTickerDates(F_DIR, t));
  }

  // ---- P1: fundamental Q2 2026 ----
  const stuck = [];
  const doneQ2 = [];
  for (const t of emitens) {
    if (tickerHasQ2All3(t)) doneQ2.push(t);
    else stuck.push(t);
  }
  const turnCache = new Map();
  stuck.sort((a, b) => avgTurnoverCached(b, turnCache) - avgTurnoverCached(a, turnCache));
  const p1Items = [];
  for (const t of stuck) {
    for (const rep of REPORTS) {
      for (const per of PERIODS) {
        p1Items.push(t + '/' + rep + '-' + per);
      }
    }
  }

  // ---- P2: ALL missing (terbaru mundur) ----
  const expDesc = expectedDates.slice().sort().reverse();
  const p2Items = [];
  for (const d of expDesc) {
    for (const t of tickers) {
      if (!allMap.get(t).has(d)) p2Items.push(t + '@' + d);
    }
  }

  // ---- P3: Foreign missing — 20 hari terakhir dulu, lalu sisa ----
  const last20 = expDesc.slice(0, 20);
  const last20Set = new Set(last20);
  const older = expDesc.filter((d) => !last20Set.has(d));
  const p3a = [];
  const p3b = [];
  for (const d of last20) {
    for (const t of tickers) {
      if (!fMap.get(t).has(d)) p3a.push(t + '@' + d);
    }
  }
  for (const d of older) {
    for (const t of tickers) {
      if (!fMap.get(t).has(d)) p3b.push(t + '@' + d);
    }
  }
  const p3Items = p3a.concat(p3b);

  // ---- P4: histori Foreign lebih tua (< windowStart, cap 120 hari) ----
  const olderCal = calendar.filter((d) => windowStart && d < windowStart).sort().reverse();
  const P4_CAP_DAYS = 120;
  const p4Items = [];
  const p4Days = olderCal.slice(0, P4_CAP_DAYS);
  const p4Map = new Map();
  for (const t of emitens) p4Map.set(t, new Set());
  // Pindai ulang hanya untuk tanggal P4 (hemat: cek keberadaan file langsung).
  for (const d of p4Days) {
    for (const t of emitens) {
      const fp = path.join(F_DIR, t, d + '.json');
      let has = false;
      try {
        const st = fs.statSync(fp);
        has = st.isFile() && st.size > 0;
      } catch (_) { has = false; }
      if (!has) p4Items.push(t + '@' + d);
    }
  }

  const totalRequests = p1Items.length + p2Items.length + p3Items.length + p4Items.length;
  const queue = {
    tool: 'tools/build-backfill-queue.js',
    generatedAt: new Date().toISOString(),
    source: 'data/completeness/latest.json',
    sourceGeneratedAt: latest ? (latest.generatedAt || null) : null,
    universe: { tickers: tickers.length, emitens: emitens.length, hasIHSG: tickers.includes('IHSG') },
    window: { start: windowStart, end: lastDay, expectedDates: expectedDates.length },
    priorities: {
      P1: { name: 'Laporan Keuangan Q2 2026 (emiten tertahan Q1, likuid dulu)', items: p1Items.length, requests: p1Items.length, doneQ2: doneQ2.length, stuck: stuck.length },
      P2: { name: 'Sel bolong Broksum ALL (terbaru mundur)', items: p2Items.length, requests: p2Items.length },
      P3: { name: 'Sel bolong Broksum Foreign (20 hari terakhir dulu, lalu sisa)', items: p3Items.length, requests: p3Items.length, last20: p3a.length, older: p3b.length },
      P4: { name: 'Sisa histori Foreign lebih tua (< windowStart, cap 120 hari)', items: p4Items.length, requests: p4Items.length, capDays: P4_CAP_DAYS, olderCalendarDays: olderCal.length }
    },
    totalItems: totalRequests,
    totalRequests,
    items: { P1: p1Items, P2: p2Items, P3: p3Items, P4: p4Items }
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(queue, null, 2));
  return { out: OUT, queue };
}

module.exports = { build };

if (require.main === module) {
  const { out, queue } = build();
  console.log('wrote=' + out);
  console.log('P1=' + queue.priorities.P1.items + ' P2=' + queue.priorities.P2.items + ' P3=' + queue.priorities.P3.items + ' (last20=' + queue.priorities.P3.last20 + ' older=' + queue.priorities.P3.older + ') P4=' + queue.priorities.P4.items);
  console.log('total=' + queue.totalRequests);
}
