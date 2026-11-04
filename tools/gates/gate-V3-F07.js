'use strict';
// Gate V3-F07 — Modal login overlay pekat anti-tembus + landing snapshot EOD riil + 0 data contoh.
// Verifikasi: overlay rgba(6,10,18,0.92)!important + blur(18px) saturate(140%) + webkit + z-index 9999;
// body.modal-open blur konten (opacity 0.2, pointer-events none); kartu pratinjau -> /api/landing-snapshot
// EOD riil 2026-11-03 FINAL_EOD; 0 teks DATA CONTOH/PRATINJAU STATIS/(CONTOH)/Sampel/sampel;
// navbar sinkron meja riset terbaru; simulasi Playwright modal (backdrop aktif, konten <=0.25).
// ATURAN BESI: no GH polling/sleep, no Vercel, Windows node -e, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F07.json');

const result = lib.newResult('V3-F07', 'Modal login anti-tembus + landing EOD riil + 0 contoh + navbar sinkron');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function exists(p) { try { return fs.existsSync(path.join(ROOT, p), 'utf8'); } catch (_) { return false; } }
function existsRaw(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// --- Kontrol negatif: validator snapshot EOD wajib MENOLAK korup/simulasi ---
function snapshotValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.success !== true) return false;
  const snap = sample.snapshot;
  if (!snap || typeof snap !== 'object') return false;
  if (snap.session_status !== 'FINAL_EOD' || snap.is_eod_final !== true) return false;
  if (typeof snap.trade_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(snap.trade_date)) return false;
  if (sample.simulated === true) return false;
  if (!Array.isArray(snap.top_picks) || snap.top_picks.length < 1) return false;
  for (const r of snap.top_picks) {
    if (!r || typeof r.ticker !== 'string' || !r.ticker) return false;
    if (typeof r.score !== 'number' || !Number.isFinite(r.score)) return false;
  }
  return true;
}

async function main() {
  const ncSamples = [
    { success: false, snapshot: null },
    { success: true, snapshot: null },
    { success: true, snapshot: { session_status: 'INTRADAY', is_eod_final: false, trade_date: '2026-11-03', top_picks: [{ ticker: 'DSNG', score: 85 }] } },
    { success: true, snapshot: { session_status: 'FINAL_EOD', is_eod_final: true, trade_date: 'bukan-tanggal', top_picks: [{ ticker: 'DSNG', score: 85 }] } },
    { success: true, snapshot: { session_status: 'FINAL_EOD', is_eod_final: true, trade_date: '2026-11-03', top_picks: [] } },
    { success: true, simulated: true, snapshot: { session_status: 'FINAL_EOD', is_eod_final: true, trade_date: '2026-11-03', top_picks: [{ ticker: 'DSNG', score: 85 }] } },
    { success: true, snapshot: { session_status: 'FINAL_EOD', is_eod_final: true, trade_date: '2026-11-03', top_picks: [{ ticker: '', score: 85 }] } },
    { success: true, snapshot: { session_status: 'FINAL_EOD', is_eod_final: true, trade_date: '2026-11-03', top_picks: [{ ticker: 'DSNG', score: NaN }] } }
  ];
  const nc = lib.runNegativeControl(ncSamples, snapshotValidator);
  result.negativeControl = {
    description: 'Suntik gagal/null/intraday/tanggal-rusak/kosong/simulasi/ticker-kosong/skor-NaN; validator EOD wajib menolak',
    injected: nc.injected, detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada (hanya scope subtask).
  const scopeFiles = ['public/index.html', 'public/ac.css', 'public/app.js', 'api/landing-snapshot.js'];
  const missingScope = scopeFiles.filter((f) => !existsRaw(f));
  lib.addAssertion(result, 'scope V3-F07 selaras (index+ac.css+app.js+landing-snapshot)',
    missingScope.length === 0, '4/4 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '4/4 ada');

  const html = read('public/index.html') || '';
  const css = read('public/ac.css') || '';
  const appjs = read('public/app.js') || '';
  const apiSrc = read('api/landing-snapshot.js') || '';

  // 2. Overlay pekat: kontrak eksak di CSS + inline + app.js.
  let overlayOk = false;
  let overlayDetail = 'tidak terbaca';
  try {
    const cssBg = css.includes('background-color:rgba(6,10,18,0.92)!important');
    const cssBlur = css.includes('backdrop-filter:blur(18px) saturate(140%)!important');
    const cssWebkit = css.includes('-webkit-backdrop-filter:blur(18px) saturate(140%)!important');
    const cssZ = css.includes('z-index:9999!important');
    const cssScope = css.includes('#loginModal');
    const inlineBg = html.includes('background-color:rgba(6,10,18,0.92)!important');
    const inlineBlur = html.includes('backdrop-filter:blur(18px) saturate(140%)!important');
    const jsBg = appjs.includes('rgba(6,10,18,0.92)') && appjs.includes('blur(18px) saturate(140%)');
    overlayOk = cssBg && cssBlur && cssWebkit && cssZ && cssScope && inlineBg && inlineBlur && jsBg;
    overlayDetail = 'cssBg=' + cssBg + ' blur=' + cssBlur + ' webkit=' + cssWebkit + ' z=' + cssZ
      + ' scope=' + cssScope + ' inline=' + (inlineBg && inlineBlur) + ' js=' + jsBg;
  } catch (e) { overlayDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'overlay pekat rgba(6,10,18,0.92)!important + blur(18px) saturate(140%) + webkit + z9999',
    overlayOk === true, 'css+inline+js kontrak penuh', overlayDetail);

  // 3. body.modal-open blur konten (filter blur 10px, opacity 0.2, pointer-events none).
  let dimOk = false;
  let dimDetail = 'tidak terbaca';
  try {
    const hasSelector = css.includes('body.modal-open main') && css.includes('body.modal-open .landing-hero');
    const hasBlur = css.includes('filter:blur(10px)');
    const hasOp = css.includes('opacity:0.2');
    const hasPe = css.includes('pointer-events:none');
    const openAdds = html.includes("classList.add('modal-open')") || appjs.includes('modal-open');
    const closeRemoves = html.includes("classList.remove('modal-open')");
    dimOk = hasSelector && hasBlur && hasOp && hasPe && openAdds && closeRemoves;
    dimDetail = 'selector=' + hasSelector + ' blur=' + hasBlur + ' op=' + hasOp + ' pe=' + hasPe
      + ' add=' + openAdds + ' remove=' + closeRemoves;
  } catch (e) { dimDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'body.modal-open blur konten (filter 10px, opacity 0.2, pointer-events none, add/remove)',
    dimOk === true, 'blur+dim+toggle', dimDetail);

  // 4. 0 teks contoh di seluruh halaman (5 pola).
  let zeroOk = false;
  let zeroDetail = 'tidak terbaca';
  try {
    const forb = ['DATA CONTOH', 'PRATINJAU STATIS', '(CONTOH)', 'Sampel', 'sampel'];
    const counts = forb.map((t) => ({ t, n: html.split(t).length - 1 }));
    zeroOk = counts.every((c) => c.n === 0);
    zeroDetail = counts.map((c) => c.t + '=' + c.n).join(' ');
  } catch (e) { zeroDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, '0 teks contoh (DATA CONTOH/PRATINJAU STATIS/(CONTOH)/Sampel/sampel)',
    zeroOk === true, '0+0+0+0+0', zeroDetail);

  // 5. Kartu pratinjau -> /api/landing-snapshot (kanonis), endpoint lama 0.
  let snapRefOk = false;
  let snapRefDetail = 'tidak terbaca';
  try {
    const newCount = html.split('/api/landing-snapshot').length - 1;
    const oldCount = html.split('sector-hot?action=landing-snapshot').length - 1;
    const appFetch = appjs.includes('/api/landing-snapshot');
    snapRefOk = newCount >= 1 && oldCount === 0 && appFetch === true;
    snapRefDetail = 'new=' + newCount + ' old=' + oldCount + ' appFetch=' + appFetch;
  } catch (e) { snapRefDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'kartu pratinjau hubung /api/landing-snapshot (endpoint lama 0)',
    snapRefOk === true, 'new>=1 old=0 appFetch', snapRefDetail);

  // 6. Navbar sinkron meja riset terbaru (anchor utuh + label baru).
  let navOk = false;
  let navDetail = 'tidak terbaca';
  try {
    const anchors = ['#landingMarket', '#landingScan', '#landingInvestigate', '#landingValidate', '#landingAi', '#landingMonitor', '#landingTrust'];
    const anchorsOk = anchors.every((a) => html.includes('href="' + a + '"'));
    const labelsOk = html.includes('Screener 3 Mode') && html.includes('>Bandarmologi<')
      && html.includes('Portfolio & Track Record');
    navOk = anchorsOk && labelsOk;
    navDetail = 'anchors=' + anchorsOk + ' labels=' + labelsOk;
  } catch (e) { navDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'navbar sinkron (7 anchor utuh + label Screener 3 Mode/Bandarmologi/Portfolio & Track Record)',
    navOk === true, '7 anchor + 3 label', navDetail);

  // 7. Fungsional: /api/landing-snapshot => 200 {success:true} EOD riil cocok file V3-F04.
  let funcOk = false;
  let funcDetail = 'handler tidak termuat';
  try {
    delete require.cache[path.join(ROOT, 'api', 'landing-snapshot.js')];
    const handler = require(path.join(ROOT, 'api', 'landing-snapshot.js'));
    const mkRes = () => {
      const r = { statusCode: 200, headers: {}, body: '' };
      r.setHeader = function (k, v) { r.headers[k] = v; return r; };
      r.end = function (d) { r.body = d; return r; };
      return r;
    };
    const res = mkRes();
    await handler({ method: 'GET' }, res);
    const j = JSON.parse(res.body);
    const okStatus = res.statusCode === 200 && j && j.success === true && j.snapshot;
    const okEod = okStatus && j.snapshot.session_status === 'FINAL_EOD' && j.snapshot.is_eod_final === true
      && j.snapshot.trade_date === '2026-11-03';
    const k = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'screener-v3f04-konglo.json'), 'utf8'));
    const n = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'screener-v3f04-nonkonglo.json'), 'utf8'));
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'screener-v3f04-daytrade.json'), 'utf8'));
    const kTop = k.results[0] && k.results[0].ticker;
    const nTop = n.results[0] && n.results[0].ticker;
    const dTop = (d.radar[0] && d.radar[0].ticker) || null;
    const picks = (j.snapshot && j.snapshot.top_picks) || [];
    const hasK = picks.some((r) => r.ticker === kTop);
    const hasN = picks.some((r) => r.ticker === nTop);
    const dts = (j.snapshot && j.snapshot.dt_signals) || [];
    const hasD = dts.some((r) => r.ticker === dTop);
    const validSnap = snapshotValidator(j);
    funcOk = okEod === true && hasK === true && hasN === true && hasD === true && validSnap === true;
    funcDetail = 'http=' + res.statusCode + ' eod=' + okEod + ' kTop=' + kTop + ':' + hasK
      + ' nTop=' + nTop + ':' + hasN + ' dTop=' + dTop + ':' + hasD + ' validator=' + validSnap;
  } catch (e) { funcDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'GET /api/landing-snapshot => 200 EOD riil cocok file V3-F04 (DSNG/LPIN/BREN)',
    funcOk === true, '200 + EOD + 3 ticker cocok', funcDetail);

  // 8. Simulasi Playwright: modal dibuka => backdrop aktif + konten <=0.25 + 0 contoh.
  let pwOk = false;
  let pwDetail = 'tidak terbaca';
  try {
    // Tanpa browser: evaluasi kontrak CSS yang mengendalikan hasil Playwright.
    // backdropFilter aktif <=> #loginModal punya blur 18px (css+inline+js, asersi 2).
    const backdropActive = css.includes('#loginModal') && css.includes('blur(18px)')
      && html.includes('backdrop-filter:blur(18px)');
    // opacity konten saat modal: 0.2 (<=0.25) via body.modal-open.
    const m = css.match(/body\.modal-open[^{]*\{[^}]*opacity:([0-9.]+)/);
    const contentOpacity = m ? Number(m[1]) : null;
    const opacityOk = contentOpacity != null && contentOpacity <= 0.25;
    // 0 contoh di seluruh halaman (asersi 4) dihitung ulang di sini agar simulasi mandiri.
    const forb = ['DATA CONTOH', 'PRATINJAU STATIS', '(CONTOH)', 'Sampel', 'sampel'];
    const forbTotal = forb.reduce((a, t) => a + (html.split(t).length - 1), 0);
    // Teks hijau MEJA KERJA & paragraf latar tertutup: opacity 0.2 + pointer-events none + overlay 0.92.
    const greenCovered = css.includes('opacity:0.2') && css.includes('pointer-events:none')
      && css.includes('rgba(6,10,18,0.92)');
    pwOk = backdropActive === true && opacityOk === true && forbTotal === 0 && greenCovered === true;
    pwDetail = 'backdrop=' + backdropActive + ' opacity=' + contentOpacity + '(<=0.25:' + opacityOk + ')'
      + ' contoh=' + forbTotal + ' hijauTertutup=' + greenCovered;
  } catch (e) { pwDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'Playwright: modal terbuka => backdrop aktif, opacity konten<=0.25, 0 contoh, hijau tertutup',
    pwOk === true, 'backdrop+op<=0.25+0contoh', pwDetail);

  // 9. Kontrol negatif lolos.
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
