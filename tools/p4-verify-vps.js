'use strict';
// P4 — Verifikasi ringan pasca-burn di VPS (0 kuota, hanya baca disk).
// Membandingkan baseline pra-burn (/tmp/p4-vps-baseline.json atau argumen) dengan
// kondisi kini: emiten Q2 2026 + jumlah file tanggal valid ALL/Foreign.
// Output: bukti-verifikasi-final/faseP4/verify-after.json
// DILARANG print secret.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIN_DIR = path.join(ROOT, 'data', 'arjum-data', 'financial-statements');
const ALL_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary');
const F_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary-F');
const DAILY_DIR = path.join(ROOT, 'data', 'daily-candles');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'faseP4', 'verify-after.json');

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const REPORTS = ['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW_REPORT'];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
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

function hasQ2(items) {
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

function countDateFiles(baseDir) {
  let n = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (_) { return { files: 0, dirs: 0 }; }
  for (const t of dirs) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(baseDir, t)); } catch (_) { continue; }
    for (const e of ents) {
      if (!DATE_RE.test(e)) continue;
      try {
        const st = fs.statSync(path.join(baseDir, t, e));
        if (st.isFile() && st.size > 0) n += 1;
      } catch (_) {}
    }
  }
  return { files: n, dirs: dirs.length };
}

function main() {
  const baselinePath = process.argv[2] || '/tmp/p4-vps-baseline.json';
  const baseline = readJson(baselinePath);
  let emitens = [];
  try {
    emitens = fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((t) => t !== 'IHSG').sort();
  } catch (_) {}
  let q2 = 0;
  const q2Tickers = [];
  for (const t of emitens) {
    let ok = true;
    for (const rep of REPORTS) {
      try {
        const fp = path.join(FIN_DIR, t, rep + '-quarterly.json');
        const st = fs.statSync(fp);
        if (!st.isFile() || st.size === 0) { ok = false; break; }
        const r = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (!hasQ2(extractItems(r))) { ok = false; break; }
      } catch (_) { ok = false; break; }
    }
    if (ok) { q2 += 1; q2Tickers.push(t); }
  }
  const all = countDateFiles(ALL_DIR);
  const f = countDateFiles(F_DIR);
  const result = {
    tool: 'tools/p4-verify-vps.js',
    generatedAt: new Date().toISOString(),
    baselinePath,
    baseline: baseline ? {
      generatedAt: baseline.generatedAt || null,
      q2: Number(baseline.fundamental.withQ2_2026_all3),
      allFill: Number(baseline.broksumALL.filledCells),
      fFill: Number(baseline.broksumForeign.filledCells)
    } : null,
    after: { q2, q2Tickers: q2Tickers.slice(0, 60), q2Total: q2Tickers.length, allFiles: all.files, allDirs: all.dirs, fFiles: f.files, fDirs: f.dirs, emitens: emitens.length },
    delta: baseline ? {
      q2: q2 - Number(baseline.fundamental.withQ2_2026_all3),
      allFilesVsFill: all.files - Number(baseline.broksumALL.filledCells),
      fFilesVsFill: f.files - Number(baseline.broksumForeign.filledCells)
    } : null
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('wrote=' + OUT);
  console.log('q2=' + q2 + ' allFiles=' + all.files + ' fFiles=' + f.files);
  if (result.delta) console.log('deltaQ2=' + result.delta.q2 + ' deltaAll=' + result.delta.allFilesVsFill + ' deltaF=' + result.delta.fFilesVsFill);
}

if (require.main === module) main();
module.exports = { main };
