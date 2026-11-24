'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 1. Mock root environment for testing public/analisis-v2.js
const mockRoot = {
  document: {
    getElementById: () => null,
    addEventListener: () => {}
  },
  normalizeDisplayLevels: (row) => ({
    e1: row.entry1 || row.entry_high,
    e2: row.entry2 || row.entry_low,
    sl: row.stop_loss || row.sl,
    t1: row.tp1,
    t2: row.tp2
  }),
  AutoCuanChartBus: {
    get: () => null
  }
};
global.window = mockRoot;

const analisisCode = fs.readFileSync(path.join(__dirname, '../public/analisis-v2.js'), 'utf8');
const runScript = new Function('root', analisisCode);
runScript(mockRoot);

const analisis = mockRoot.AutoCuanAnalisisV2;

test('Critical Fix 1: ATR-14 Plan Stale Handling & Rejection Invariant', () => {
  const levelsOf = analisis.levelsOf;
  assert.equal(typeof levelsOf, 'function', 'levelsOf harus terdefinisi');

  // Skenario A: Plan sinkron & valid (deviasi <= 25%)
  const validRow = {
    ticker: 'BBCA',
    entry1: 10000,
    stop_loss: 9700,
    tp1: 10500,
    tp2: 11000,
    __src: 'Swing Konglo',
    date: '2026-11-04'
  };
  const validPlan = levelsOf(validRow, 10200);
  assert.ok(validPlan, 'Plan valid harus dikembalikan');
  assert.equal(validPlan.status, 'VALID');
  assert.equal(validPlan.actionable, true);
  assert.equal(validPlan.entry, 10000);
  assert.ok(validPlan.source.includes('2026-11-04'));

  // Skenario B: Plan menyimpang > 25% (misal entry 5000 vs currentClose 10000 -> 50% deviasi)
  // Wajib menolak penyamaran plan actionable baru dan mengembalikan STALE_PLAN_REJECTED / NEEDS_RECALCULATION
  const staleRow = {
    ticker: 'BBCA',
    entry1: 5000,
    stop_loss: 4800,
    tp1: 5400,
    tp2: 5800,
    __src: 'Screener Lawas',
    date: '2026-08-01'
  };
  const stalePlan = levelsOf(staleRow, 10000);
  assert.ok(stalePlan, 'Objek status penolakan harus tetap dikembalikan');
  assert.equal(stalePlan.status, 'STALE_PLAN_REJECTED');
  assert.equal(stalePlan.code, 'NEEDS_RECALCULATION');
  assert.equal(stalePlan.actionable, false, 'Plan usang dilarang berstatus actionable');
  assert.ok(stalePlan.deviationPct > 25, 'Persentase deviasi harus dicatat');
  assert.ok(stalePlan.source.includes('STALE DEVIASI 50.0%'));
  assert.ok(stalePlan.reason.includes('50.0% (> 25%)'));
});

test('Critical Fix 2: Landing Calculator Dynamic Logic & Transparency (REQ-01)', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. Verifikasi badge SIMULASI INTERAKTIF dan Ticker Badge
  assert.ok(indexHtml.includes('id="lpCalcBadge"'), 'Harus terdapat elemen badge simulasi interaktif');
  // W7: the static default is an explicit empty state; the as-of date is injected
  // from the live snapshot, never hardcoded in markup.
  assert.ok(indexHtml.includes('SIMULASI INTERAKTIF (data belum tersedia)'), 'Default harus empty-state, bukan tanggal hardcoded');
  assert.ok(indexHtml.includes('id="lpCalcTickerBadge"'), 'Harus terdapat elemen badge ticker dinamis');

  // 2. Verifikasi ID elemen untuk level dinamis SL, TP1, TP2, dan Note Sumber
  assert.ok(indexHtml.includes('id="lpCalcEntryVal"'), 'Elemen entry value');
  assert.ok(indexHtml.includes('id="lpCalcSlVal"'), 'Elemen SL value dinamis');
  assert.ok(indexHtml.includes('id="lpCalcTp1Val"'), 'Elemen TP1 value dinamis');
  assert.ok(indexHtml.includes('id="lpCalcTp2Val"'), 'Elemen TP2 value dinamis');
  assert.ok(indexHtml.includes('id="lpCalcSourceNote"'), 'Elemen catatan sumber transparan');

  // 3. Verifikasi fungsi window.setLandingCalcTicker dan window.acUpdateLandingCalc
  assert.ok(indexHtml.includes('window.setLandingCalcTicker = function'), 'Fungsi injeksi ticker dinamis harus tersedia');
  assert.ok(indexHtml.includes('window.acUpdateLandingCalc = function'), 'Fungsi kalkulasi dinamis landing harus tersedia');
  assert.ok(indexHtml.includes("window._landingCalcData = {"), 'State kalkulator landing default harus terdefinisi');

  // 4. Verifikasi integrasi Top 1 snapshot ke kalkulator
  assert.ok(indexHtml.includes('window.setLandingCalcTicker({'), 'Showcase loader harus memicu setLandingCalcTicker saat data tersedia');
});

test('Critical Fix 3: Dual CSV Separation - Data vs Browser Audit Verification', () => {
  const dataCsvPath = path.join(__dirname, '../docs/v6/V6_CHART_DATA_RESULTS.csv');
  const browserCsvPath = path.join(__dirname, '../docs/v6/V6_CHART_BROWSER_RESULTS.csv');

  assert.ok(fs.existsSync(dataCsvPath), 'V6_CHART_DATA_RESULTS.csv harus tercipta');
  assert.ok(fs.existsSync(browserCsvPath), 'V6_CHART_BROWSER_RESULTS.csv harus tercipta');

  const dataContent = fs.readFileSync(dataCsvPath, 'utf8');
  const browserContent = fs.readFileSync(browserCsvPath, 'utf8');

  // Verifikasi struktur data audit CSV
  assert.ok(dataContent.startsWith('ticker,status,candle_count,latest_date,latest_close,volume_latest,ma20,rsi14,lpm_value,notes'));
  const dataLines = dataContent.trim().split('\n');
  assert.ok(dataLines.length > 900, 'Data audit harus mencakup seluruh universe emiten IDX (960+)');

  // Verifikasi struktur visual browser CSV
  assert.ok(browserContent.startsWith('ticker,browser_status,viewport,canvas_rendered,container_width,container_height,console_errors,notes'));
  const targetTickers = ['BBCA', 'BBRI', 'BMRI', 'PANI', 'BRMS', 'BUMI', 'DEWA', 'LPIN', 'ASGR', 'LPPF', 'GPRA'];
  for (const t of targetTickers) {
    assert.ok(browserContent.includes(t), `Browser visual audit harus menyertakan emiten representatif ${t}`);
  }
});
