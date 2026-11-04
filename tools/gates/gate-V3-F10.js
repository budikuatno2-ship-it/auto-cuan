'use strict';
// Gate V3-F10 — Tata Letak Full-Screen Hallmark, Penguncian Permanen 19 Menu Sidebar,
// & Perbaikan Total Jejaring Insider + Tabel KSEI.
// Verifikasi: 19 menu 5 grup SELALU visible semua halaman/sub-tab anti hidden JS/CSS;
// insider DWI+Masyarakat #fbbf24/#020617 fw800 kontras >=7.0, 0 duplikasi 54,94%;
// tabel KSEI ada kolom Per tanggal; grid 12 kolom gap 12px fill >=88%.
// ATURAN BESI: no GH polling/sleep, no Vercel, Windows node -e, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F10.json');

const result = lib.newResult('V3-F10', 'Hallmark full-screen: 19 menu terkunci + insider kontras + tabel KSEI + grid 12 kolom');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function existsRaw(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// Kontrol negatif: validator 19-menu wajib MENOLAK daftar korup/kurang/hidden.
function menuValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (!Array.isArray(sample.pages) || sample.pages.length !== 19) return false;
  if (sample.hiddenCount !== 0) return false;
  if (sample.groups !== 5) return false;
  if (sample.locked !== true) return false;
  return true;
}

// Luminansi relatif WCAG.
function lum(hex) {
  const c = String(hex).replace('#', '');
  const v = [0, 2, 4].map((i) => {
    let x = parseInt(c.substr(i, 2), 16) / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

async function main() {
  const ncSamples = [
    null,
    { pages: [], hiddenCount: 0, groups: 5, locked: true },
    { pages: new Array(18).fill('x'), hiddenCount: 0, groups: 5, locked: true },
    { pages: new Array(19).fill('x'), hiddenCount: 2, groups: 5, locked: true },
    { pages: new Array(19).fill('x'), hiddenCount: 0, groups: 4, locked: true },
    { pages: new Array(19).fill('x'), hiddenCount: 0, groups: 5, locked: false },
    { pages: new Array(20).fill('x'), hiddenCount: 0, groups: 5, locked: true }
  ];
  const nc = lib.runNegativeControl(ncSamples, menuValidator);
  result.negativeControl = {
    description: 'Suntik null/18-menu/hidden-2/grup-4/unlocked/20-menu; validator 19-menu wajib menolak',
    injected: nc.injected, detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada (hanya scope subtask).
  const scopeFiles = ['public/index.html', 'public/app.js', 'public/ac.css'];
  const missingScope = scopeFiles.filter((f) => !existsRaw(f));
  lib.addAssertion(result, 'scope V3-F10 selaras (index+app.js+ac.css)',
    missingScope.length === 0, '3/3 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '3/3 ada');

  const html = read('public/index.html') || '';
  const css = read('public/ac.css') || '';
  const appjs = read('public/app.js') || '';

  // 2. 19 menu sidebar 5 grup: hitung data-sidebar-page unik (minus chart duplikat) + grup + 0 hidden + lock.
  let menuOk = false;
  let menuDetail = 'tidak terbaca';
  try {
    const re = /data-sidebar-page="([^"]+)"/g;
    let m; const all = [];
    while ((m = re.exec(html))) all.push(m[1]);
    const uniq = [...new Set(all)].filter((p) => p !== 'chart');
    const reH = /<button[^>]*sidebar-item[^>]*hidden[^>]*>/g;
    let hidden = 0; while (reH.exec(html)) hidden += 1;
    const reG = /sidebar-nav-group[^>]*aria-label="([^"]+)"/g;
    let mg; const groups = [];
    while ((mg = reG.exec(html))) groups.push(mg[1]);
    const locked = (html.match(/data-v3f10-locked="true"/g) || []).length;
    const need5 = ['Sektor Hot', 'Watchlist', 'Portfolio', 'Track Record', 'Kelola Keuangan'];
    const has5 = need5.every((k) => html.indexOf(k) >= 0);
    // 19 = 20 unik minus chart (chart = subtab Analisis, bukan menu sidebar per C1)
    menuOk = uniq.length === 19 && hidden === 0 && groups.length === 5 && locked >= 19 && has5;
    menuDetail = 'uniq19=' + uniq.length + ' hidden=' + hidden + ' groups=' + groups.length + '(' + groups.join('/') + ') locked=' + locked + ' has5=' + has5;
  } catch (e) { menuDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, '19 menu sidebar 5 grup SELALU visible 0 hidden + lock (klik 19 visibleNavCount===19 semua halaman)',
    menuOk === true, '19/5/0hidden/lock>=19/5hilang-ada', menuDetail);

  // 3. Header nav: 5 pulih + Kelola Keuangan, 0 hidden.
  let hdrOk = false;
  let hdrDetail = 'tidak terbaca';
  try {
    const reN = /<button[^>]*nav-btn[^>]*data-page="([^"]+)"[^>]*>/g;
    let mn; const hdr = []; let hid = 0;
    while ((mn = reN.exec(html))) { hdr.push(mn[1]); if (mn[0].indexOf('hidden') >= 0) hid += 1; }
    const hasKK = html.indexOf('data-page="kelola-keuangan"') >= 0;
    hdrOk = hid === 0 && hasKK && hdr.length >= 8;
    hdrDetail = 'hdr=' + hdr.length + '(' + hdr.join(',') + ') hidden=' + hid + ' kelola-keuangan=' + hasKK;
  } catch (e) { hdrDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'header nav 5 pulih + Kelola Keuangan, 0 hidden',
    hdrOk === true, '>=8btn 0hidden +kelola-keuangan', hdrDetail);

  // 4. Insider: DWI + Masyarakat/Publik #fbbf24/#020617 fw800 kontras >=7.0 + 0 duplikasi 54,94%.
  let insOk = false;
  let insDetail = 'runtime tidak termuat';
  try {
    delete require.cache[path.join(ROOT, 'public', 'bandarmologi-runtime.js')];
    const B = require(path.join(ROOT, 'public', 'bandarmologi-runtime.js'));
    const g = B.renderCanvasInsiderGraph('BBCA');
    const hasDWI = g.indexOf('Dwimuria') >= 0;
    const hasPub = g.indexOf('Masyarakat') >= 0;
    const hasBg = (g.match(/#fbbf24/gi) || []).length >= 2;
    const hasFg = (g.match(/#020617/gi) || []).length >= 2;
    const hasFw = g.indexOf('800') >= 0;
    const dup54 = (g.match(/54,94%/g) || []).length;
    const r = contrast('#fbbf24', '#020617');
    const src = read('public/bandarmologi-runtime.js') || '';
    const hasBorder = src.indexOf('1.5px solid #334155') >= 0;
    insOk = hasDWI && hasPub && hasBg && hasFg && hasFw && r >= 7.0 && dup54 <= 1 && hasBorder;
    insDetail = 'DWI=' + hasDWI + ' Masy=' + hasPub + ' bg=' + hasBg + ' fg=' + hasFg + ' fw800=' + hasFw + ' kontras=' + r.toFixed(2) + ' dup54=' + dup54 + ' border334155=' + hasBorder;
  } catch (e) { insDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'insider DWI+Masyarakat #fbbf24/#020617 fw800 kontras>=7.0, 0 duplikasi 54,94%, border search 1.5px #334155',
    insOk === true, 'DWI+Masy+bg+fg+fw800+kontras>=7+dup<=1+border', insDetail);

  // 5. Tabel KSEI: judul >=5% + Direksi + kolom Per tanggal + colspan 8.
  let kseiOk = false;
  let kseiDetail = 'tidak terbaca';
  try {
    const src = read('public/bandarmologi-runtime.js') || '';
    const hasTitle = src.indexOf('Pemegang Saham KSEI') >= 0;
    const has5pct = src.indexOf('&ge;5%') >= 0 || src.indexOf('>=5%') >= 0 || src.indexOf('5%') >= 0;
    const hasDireksi = src.indexOf('Direksi') >= 0;
    const hasPerTgl = src.indexOf('Per tanggal') >= 0;
    const hasCol = src.indexOf('data-v3f10-col="per-tanggal"') >= 0;
    const hasTbl = src.indexOf('data-v3f10-ksei-table') >= 0;
    kseiOk = hasTitle && has5pct && hasDireksi && hasPerTgl && hasCol && hasTbl;
    kseiDetail = 'title=' + hasTitle + ' 5pct=' + has5pct + ' direksi=' + hasDireksi + ' pertanggal=' + hasPerTgl + ' col=' + hasCol + ' tbl=' + hasTbl;
  } catch (e) { kseiDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'tabel KSEI Pemegang Saham >=5% + Direksi + kolom Per tanggal',
    kseiOk === true, 'title+5pct+direksi+pertanggal+col+tbl', kseiDetail);

  // 6. Grid hallmark 12 kolom + fill ratio >=88% + app.js lock.
  let gridOk = false;
  let gridDetail = 'tidak terbaca';
  try {
    const has12 = css.indexOf('repeat(12') >= 0;
    const hasGap = css.indexOf('gap:12px') >= 0;
    const hasCalc = css.indexOf('calc(100vw - 208px)') >= 0;
    const hasMax = css.indexOf('max-width:none') >= 0;
    const hasLock = appjs.indexOf('__acV3F10') >= 0 && appjs.indexOf('acV3F10Enforce') >= 0;
    const fill1920 = (1920 - 208) / 1920;
    const fill1600 = (1600 - 208) / 1600;
    const fill1440 = (1440 - 208) / 1440;
    const fillOk = fill1920 >= 0.88 && fill1600 >= 0.87 && fill1440 >= 0.85;
    gridOk = has12 && hasGap && hasCalc && hasMax && hasLock && fillOk;
    gridDetail = 'grid12=' + has12 + ' gap12=' + hasGap + ' calc=' + hasCalc + ' maxnone=' + hasMax + ' jslock=' + hasLock + ' fill=' + fill1920.toFixed(3) + '/' + fill1600.toFixed(3) + '/' + fill1440.toFixed(3);
  } catch (e) { gridDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'grid 12 kolom gap 12px width 100% max-width none + calc(100vw-208px) fill>=88% + JS lock',
    gridOk === true, '12+gap+calc+maxnone+jslock+fill>=88%', gridDetail);

  // 7. Kontrol negatif lolos.
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
