'use strict';
// Gate V3-F09 — Mesin Visual Otomatis Chart Workstation (SMC + Harmonic XABCD + ZigZag).
// Verifikasi: toolbar 3 mode (Pro SMC+Harmonic XABCD / Simple Zig-Zag / Hybrid) + saklar tema
// Putih/Gelap; geometri deterministik 964 ticker (963+IHSG) 0 gagal render / 0 hilang S/R / 0 NaN;
// render BULL+BBRI ada poligon XABCD, label BOS/CHoCH, Order Block, jalur ZigZag.
// ATURAN BESI: no GH polling/sleep, no Vercel, Windows node -e, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F09.json');

const result = lib.newResult('V3-F09', 'Mesin visual otomatis chart: SMC+XABCD+ZigZag 3 mode + tema + audit 964');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function existsRaw(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// --- Kontrol negatif: validator geometri wajib MENOLAK korup/NaN/hilang-SR/simulasi ---
function geometryValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.success !== true) return false;
  if (sample.simulated === true) return false;
  const g = sample.geometry;
  if (!g || typeof g !== 'object') return false;
  const nums = [g.support, g.resistance, g.atr, g.ab_xa, g.bc_ab, g.cd_bc, g.ad_xa];
  for (const v of nums) { if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) return false; }
  if (!(g.resistance > g.support)) return false;
  if (typeof g.hud !== 'string' || (g.hud !== 'BUY' && g.hud !== 'SELL')) return false;
  if (typeof g.projection !== 'string' || !g.projection) return false;
  return true;
}

async function main() {
  const ncSamples = [
    null,
    { success: false, geometry: null },
    { success: true, geometry: null },
    { success: true, simulated: true, geometry: { support: 100, resistance: 120, atr: 5, ab_xa: 0.656, bc_ab: 0.786, cd_bc: 0.814, ad_xa: 1.244, hud: 'BUY', projection: 'Naik' } },
    { success: true, geometry: { support: NaN, resistance: 120, atr: 5, ab_xa: 0.656, bc_ab: 0.786, cd_bc: 0.814, ad_xa: 1.244, hud: 'BUY', projection: 'Naik' } },
    { success: true, geometry: { support: 120, resistance: 100, atr: 5, ab_xa: 0.656, bc_ab: 0.786, cd_bc: 0.814, ad_xa: 1.244, hud: 'BUY', projection: 'Naik' } },
    { success: true, geometry: { support: 100, resistance: 120, atr: 5, ab_xa: 0.656, bc_ab: 0.786, cd_bc: 0.814, ad_xa: 1.244, hud: 'HOLD', projection: 'Naik' } },
    { success: true, geometry: { support: 100, resistance: 120, atr: Infinity, ab_xa: 0.656, bc_ab: 0.786, cd_bc: 0.814, ad_xa: 1.244, hud: 'BUY', projection: '' } }
  ];
  const nc = lib.runNegativeControl(ncSamples, geometryValidator);
  result.negativeControl = {
    description: 'Suntik null/gagal/simulasi/NaN/SR-terbalik/hud-salah/proyeksi-kosong; validator geometri wajib menolak',
    injected: nc.injected, detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada (hanya scope subtask).
  const scopeFiles = ['public/chart-workstation.js', 'public/index.html', 'public/app.js'];
  const missingScope = scopeFiles.filter((f) => !existsRaw(f));
  lib.addAssertion(result, 'scope V3-F09 selaras (chart-workstation+index+app.js)',
    missingScope.length === 0, '3/3 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '3/3 ada');

  const ws = read('public/chart-workstation.js') || '';
  const html = read('public/index.html') || '';
  const appjs = read('public/app.js') || '';

  // 2. Toolbar 3 mode + saklar tema di workstation + slot HTML + wiring app.js.
  let uiOk = false;
  let uiDetail = 'tidak terbaca';
  try {
    const hasModes = ws.indexOf('Pro SMC+Harmonic XABCD') >= 0 && ws.indexOf('Simple Zig-Zag') >= 0
      && ws.indexOf('Hybrid') >= 0 && ws.indexOf('renderV3F09ToolbarHtml') >= 0;
    const hasTheme = ws.indexOf('setV3F09Theme') >= 0 && ws.indexOf('Putih') >= 0 && ws.indexOf('Gelap') >= 0
      && ws.indexOf('V3F09_THEMES') >= 0;
    const hasSlot = html.indexOf('v3f09-chart-toolbar-slot') >= 0 && html.indexOf('/chart-workstation.js?v=20261104-v3f09') >= 0;
    const hasWire = appjs.indexOf('__acV3F09') >= 0 && appjs.indexOf('buildV3F09Overlay') >= 0
      && appjs.indexOf('renderV3F09ToolbarHtml') >= 0;
    uiOk = hasModes && hasTheme && hasSlot && hasWire;
    uiDetail = 'modes=' + hasModes + ' theme=' + hasTheme + ' slot=' + hasSlot + ' wire=' + hasWire;
  } catch (e) { uiDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'toolbar 3 mode Pro/Simple/Hybrid + tema Putih/Gelap + slot HTML + wiring app.js',
    uiOk === true, 'modes+tema+slot+wire penuh', uiDetail);

  // 3. Kontrak visual: XABCD rasio, segitiga biru, BOS/CHoCH, OB, HUD, ZigZag, S/R.
  let visOk = false;
  let visDetail = 'tidak terbaca';
  try {
    const ratios = ['0.656', '0.786', '0.814', '1.244'].every((r) => ws.indexOf(r) >= 0);
    const tri = ws.indexOf('data-xabcd="XAB"') >= 0 && ws.indexOf('data-xabcd="BCD"') >= 0
      && ws.indexOf('#2563eb') >= 0 && ws.indexOf('stroke-dasharray') >= 0;
    const smc = ws.indexOf('BOS') >= 0 && ws.indexOf('CHoCH') >= 0 && ws.indexOf('EQH') >= 0
      && ws.indexOf('EQL') >= 0 && ws.indexOf('Strong High') >= 0 && ws.indexOf('#ef4444') >= 0;
    const ob = ws.indexOf('Supply OB') >= 0 && ws.indexOf('Demand OB') >= 0
      && ws.indexOf('#fbcfe8') >= 0 && ws.indexOf('#bfdbfe') >= 0 && ws.indexOf('Order Block') >= 0
      && ws.indexOf('Harga') >= 0;
    const hud = ws.indexOf('SELL') >= 0 && ws.indexOf('BUY') >= 0 && ws.indexOf('data-hud') >= 0;
    const zz = ws.indexOf('data-zigzag="path"') >= 0 && ws.indexOf('Bullish Sideways') >= 0
      && ws.indexOf('Naik') >= 0 && ws.indexOf('Turun') >= 0 && ws.indexOf('ATR') >= 0;
    const sr = ws.indexOf('calculateV3F09SR') >= 0 && ws.indexOf('D Weak Low') >= 0;
    visOk = ratios && tri && smc && ob && hud && zz && sr;
    visDetail = 'rasio=' + ratios + ' tri=' + tri + ' smc=' + smc + ' ob=' + ob + ' hud=' + hud + ' zz=' + zz + ' sr=' + sr;
  } catch (e) { visDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'kontrak visual XABCD rasio+segitiga-biru + SMC BOS/CHoCH/EQH-EQL/StrongHigh + OB + HUD + ZigZag',
    visOk === true, 'rasio+tri+smc+ob+hud+zz+sr penuh', visDetail);

  // 4. Audit 964 ticker geometri valid 0 FAIL 0 NaN 0 hilang S/R (data riil daily-candles).
  let auditOk = false;
  let auditDetail = 'workstation tidak termuat';
  try {
    delete require.cache[path.join(ROOT, 'public', 'chart-workstation.js')];
    const W = require(path.join(ROOT, 'public', 'chart-workstation.js'));
    const dir = path.join(ROOT, 'data', 'daily-candles');
    const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
    let fail = 0, nan = 0, miss = 0;
    const failNames = [];
    for (const fn of files) {
      const t = fn.replace(/\.json$/, '');
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8'));
        const r = W.auditV3F09Ticker(t, (j && j.candles) || []);
        if (r.nanCount > 0) nan += r.nanCount;
        if (r.missingSR) miss += 1;
        if (r.fail) { fail += 1; if (failNames.length < 5) failNames.push(t); }
      } catch (e) { fail += 1; if (failNames.length < 5) failNames.push(t + ':EXC'); }
    }
    auditOk = files.length === 964 && fail === 0 && nan === 0 && miss === 0;
    auditDetail = 'total=' + files.length + ' fail=' + fail + ' nan=' + nan + ' missSR=' + miss
      + (failNames.length ? ' contoh=' + failNames.join(',') : '');
  } catch (e) { auditDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'audit 964 ticker geometri SMC/XABCD/SR/ZigZag valid 0 FAIL 0 NaN 0 hilang S/R',
    auditOk === true, '964 fail=0 nan=0 missSR=0', auditDetail);

  // 5. Render BULL (Pro) + BBRI (Simple): poligon XABCD, BOS/CHoCH, Order Block, jalur ZigZag.
  let renderOk = false;
  let renderDetail = 'workstation tidak termuat';
  try {
    delete require.cache[path.join(ROOT, 'public', 'chart-workstation.js')];
    const W = require(path.join(ROOT, 'public', 'chart-workstation.js'));
    function loadCandles(t) {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'daily-candles', t + '.json'), 'utf8'));
      return (j && j.candles) || [];
    }
    const bullOv = W.buildV3F09Overlay('BULL', loadCandles('BULL'), 'pro', 'dark');
    const bbriOv = W.buildV3F09Overlay('BBRI', loadCandles('BBRI'), 'simple', 'light');
    function hasAll(ov) {
      if (!ov || !ov.svg) return false;
      const s = ov.svg;
      return s.indexOf('<polygon') >= 0 && s.indexOf('data-xabcd="XAB"') >= 0
        && s.indexOf('data-xabcd="BCD"') >= 0 && s.indexOf('BOS') >= 0
        && s.indexOf('CHoCH') >= 0 && s.indexOf('Order Block') >= 0
        && s.indexOf('data-zigzag="path"') >= 0 && s.indexOf('S/R') >= 0;
    }
    const bullOk = hasAll(bullOv);
    const bbriOk = hasAll(bbriOv);
    const hudOk = (bullOv.hud === 'BUY' || bullOv.hud === 'SELL') && (bbriOv.hud === 'BUY' || bbriOv.hud === 'SELL');
    const projOk = typeof bullOv.projection === 'string' && bullOv.projection.length > 0
      && typeof bbriOv.projection === 'string' && bbriOv.projection.length > 0;
    renderOk = bullOk && bbriOk && hudOk && projOk;
    renderDetail = 'BULL=' + bullOk + '(' + bullOv.hud + '/' + bullOv.projection + ') BBRI=' + bbriOk
      + '(' + bbriOv.hud + '/' + bbriOv.projection + ') hud=' + hudOk + ' proj=' + projOk;
  } catch (e) { renderDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'render BULL+BBRI ada poligon XABCD, label BOS/CHoCH, Order Block, jalur ZigZag',
    renderOk === true, 'BULL+BBRI poligon+BOS+CHoCH+OB+zigzag', renderDetail);

  // 6. Kontrol negatif lolos.
  lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)',
    result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected,
    'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

  lib.finalizeGate(result, OUT);
  return result;
}

main().catch((e) => {
  try {
    lib.addAssertion(result, 'gate tidak crash', false, 'no-crash', String((e && e.message) || e).slice(0, 300));
    lib.finalizeGate(result, OUT);
  } catch (_) { process.exit(1); }
});
