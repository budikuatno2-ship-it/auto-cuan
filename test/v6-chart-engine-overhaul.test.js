const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Mock browser root environment for public/analisis-v2.js
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

test('Chart Engine: REQ-13 - Validasi Matematis Percentile p10-p90 vs Target Harga', () => {
  const rangeCheck = analisis.rangeCheck;
  assert.equal(typeof rangeCheck, 'function', 'rangeCheck harus terdefinisi');

  const rngNormal = { p10: 1000, p90: 2000 };

  // Skenario 1: Target di dalam rentang
  const planInside = { entry: 1500, sl: 1200, tp1: 1700, tp2: 1900 };
  const res1 = rangeCheck('swing', planInside, rngNormal);
  assert.equal(res1.cls, 'ok');
  assert.equal(res1.v, 'Target di dalam rentang');

  // Skenario 2: Target di bawah rentang wajar (TP < p10)
  const planTooLow = { entry: 800, sl: 700, tp1: 900, tp2: 950 };
  const res2 = rangeCheck('swing', planTooLow, rngNormal);
  assert.equal(res2.cls, 'w');
  assert.equal(res2.v, 'TP2 di luar rentang');
  assert.ok(res2.s.includes('< p10'), 'Harus menandai bahwa target < p10');

  // Skenario 3: Target di atas rentang wajar (TP > p90)
  const planTooHigh = { entry: 1800, sl: 1600, tp1: 1950, tp2: 2200 };
  const res3 = rangeCheck('swing', planTooHigh, rngNormal);
  assert.equal(res3.cls, 'w');
  assert.equal(res3.v, 'TP2 di luar rentang');
  assert.ok(res3.s.includes('> p90'), 'Harus menandai bahwa target > p90');

  // Skenario 4: Horizon investor jujur tidak dipakai
  const resInv = rangeCheck('inv', planInside, rngNormal);
  assert.equal(resInv.v, 'Tidak dipakai');

  // Skenario 5: Range belum tersedia bila riwayat < 60 sesi
  const resNull = rangeCheck('swing', planInside, null);
  assert.equal(resNull.v, '—');
});

test('Chart Engine: REQ-11 & REQ-12 - Proteksi Plan Usang / Deviasi Entry vs Quote Aktif & Addendum P0 Rejection', () => {
  const levelsOf = analisis.levelsOf;
  assert.equal(typeof levelsOf, 'function', 'levelsOf harus terdefinisi');

  // Skenario 1: Plan segar selaras dengan penutupan pasar saat ini (BBCA ~9860 vs plan entry 9800)
  const freshRow = {
    ticker: 'BBCA',
    entry1: 9800,
    stop_loss: 9500,
    tp1: 10400,
    tp2: 11000,
    __src: 'Swing Konglo',
    date: '2026-11-04'
  };
  const freshPlan = levelsOf(freshRow, 9860);
  assert.ok(freshPlan, 'Plan harus diterima karena deviasi kecil (~0.6%)');
  assert.equal(freshPlan.status, 'VALID');
  assert.equal(freshPlan.actionable, true);
  assert.equal(freshPlan.entry, 9800);
  assert.ok(freshPlan.source.includes('2026-11-04'), 'Harus menyertakan tanggal as-of yang jelas');

  // Skenario 2: Plan usang yang menyimpang jauh (misal entry 4800 vs candle/quote 9860)
  // Berdasarkan Addendum P0: Dilarang menyamarkan deviasi > 25% menjadi plan actionable baru.
  // Wajib memberi status STALE_PLAN_REJECTED / NEEDS_RECALCULATION dengan actionable: false.
  const staleRow = {
    ticker: 'BBCA',
    entry1: 4800,
    entry2: 4840,
    stop_loss: 4600,
    tp1: 5200,
    tp2: 5600,
    __src: 'Screener Lawas'
  };
  const stalePlan = levelsOf(staleRow, 9860);
  assert.ok(stalePlan, 'Objek rejection harus dihasilkan untuk audit transparan');
  assert.equal(stalePlan.status, 'STALE_PLAN_REJECTED', 'Status harus STALE_PLAN_REJECTED');
  assert.equal(stalePlan.code, 'NEEDS_RECALCULATION', 'Code harus NEEDS_RECALCULATION');
  assert.equal(stalePlan.actionable, false, 'Plan usang tidak boleh actionable');
  assert.ok(stalePlan.deviationPct > 25, 'Persentase deviasi harus tercatat > 25%');
  assert.ok(stalePlan.reason.includes('> 25%'), 'Alasan penolakan harus transparan');
});

test('Chart Engine: REQ-14 - Clean Presentation & Anti-Clutter Contract', () => {
  const runtimeCode = fs.readFileSync(path.join(__dirname, '../public/market-feature-runtime.js'), 'utf8');

  // Verifikasi perlindungan label overlap pada mode simpel
  assert.ok(runtimeCode.includes('isSimpleMode'), 'market-feature-runtime harus memeriksa mode simpel');
  assert.ok(runtimeCode.includes('isSimplePreset'), 'market-feature-runtime harus memeriksa mode preset simpel pada fibonacci');
  assert.ok(runtimeCode.includes('axisLabelVisible: !isSimpleMode || !plan'), 'Label S/R disederhanakan pada mode simpel jika trading plan aktif');
});
