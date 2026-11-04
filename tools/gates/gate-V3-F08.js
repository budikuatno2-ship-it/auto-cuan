'use strict';
// Gate V3-F08 — Perombakan Halaman Analisis AI:
// matriks angka tegas (Entry/SL+%risiko/TP1/TP2/R/R/Support&Resistance),
// tabel Fibonacci riil (retr 0,0/23,6/38,2/50,0/61,8/78,6/100,0% + ext 127,2/161,8%),
// endpoint POST /api/ai/chat hidup + fallback kuantitatif lokal riil,
// CSS gelembung chat proporsional (height auto, padding 8px 12px, <140px),
// kolom kanan Lembar Fakta: Rincian Skor 4 Pilar + Kalkulator Position Sizing (grid 12 kolom).
// ATURAN BESI: no GH polling/sleep, no Vercel, Windows node -e, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F08.json');

const result = lib.newResult('V3-F08', 'Halaman Analisis AI: matriks fibo riil + chat kuantitatif hidup + bubble proporsional');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function existsRaw(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// Validator balasan chat kuantitatif: sukses + ada angka + 0 frasa mati.
function chatReplyValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.success !== true) return false;
  const r = sample.reply;
  if (typeof r !== 'string' || r.length < 20) return false;
  if (!/\d{3,}/.test(r)) return false; // wajib ada angka level riil
  if (r.indexOf('AI tidak tersedia') !== -1) return false;
  if (typeof sample.lpm !== 'number' || !Number.isFinite(sample.lpm)) return false;
  if (r.indexOf(String(Math.round(sample.lpm))) === -1) return false; // angka LPM riil haru
  return true;
}

async function main() {
  const ncCorrupt = [
    null,
    { success: false, reply: 'x', lpm: 1 },
    { success: true, reply: 'pendek', lpm: 5987 },
    { success: true, reply: 'LPM BBCA 5987 harga Rp 5.950 entry bagus sekali untuk dibeli sekarang juga', lpm: NaN },
    { success: true, reply: 'AI tidak tersedia saat ini. Coba beberapa saat lagi.', lpm: 5987 },
    { success: true, reply: 'LPM BBCA 9999 (Rp 9.999), harga Rp 5.950.', lpm: 5987 },
    { success: true, reply: 'LPM BBCA tanpa angka level sama sekali, hanya opini kualitatif saja.', lpm: 5987 }
  ];
  const nc = lib.runNegativeControl(ncCorrupt, chatReplyValidator);
  result.negativeControl = {
    description: 'Suntik null/gagal/reply-pendek/lpm-NaN/frasa-mati/lpm-tak-cocok; validator kuantitatif wajib menolak',
    injected: nc.injected, detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada (hanya scope subtask).
  const scopeFiles = ['public/index.html', 'public/app.js', 'public/ac.css', 'api/ai/chat.js'];
  const missingScope = scopeFiles.filter((f) => !existsRaw(f));
  lib.addAssertion(result, 'scope V3-F08 selaras (index+app.js+ac.css+api/ai/chat.js)',
    missingScope.length === 0, '4/4 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '4/4 ada');

  const html = read('public/index.html') || '';
  const css = read('public/ac.css') || '';
  const appjs = read('public/app.js') || '';
  const chatSrc = read('api/ai/chat.js') || '';

  // 2. Fungsional matriks: fibo >=7 baris rupiah valid 0 NaN utk 4 ticker (data riil).
  let fiboOk = false;
  let fiboDetail = 'handler tidak termuat';
  const fiboRows = {};
  try {
    delete require.cache[path.join(ROOT, 'api', 'ai', 'chat.js')];
    const handler = require(path.join(ROOT, 'api', 'ai', 'chat.js'));
    const mkRes = () => {
      const r = { statusCode: 200, headers: {}, body: '' };
      r.setHeader = function (k, v) { r.headers[k] = v; return r; };
      r.end = function (d) { r.body = d; return r; };
      return r;
    };
    let allOk = true;
    const parts = [];
    for (const t of ['BBCA', 'BBRI', 'BRPT', 'BULL']) {
      const res = mkRes();
      await handler({ method: 'GET', query: { ticker: t } }, res);
      const j = JSON.parse(res.body);
      const rows = (j && j.success && j.data && Array.isArray(j.data.fibo)) ? j.data.fibo : [];
      fiboRows[t] = rows.length;
      const nan = rows.filter((r) => !(r && Number.isFinite(r.price) && r.price > 0)).length;
      const rupiah = rows.filter((r) => r && Number.isFinite(r.price) && r.price > 0).length;
      const p = j.data.plan || {};
      const planOk = [p.entry_low, p.entry_high, p.sl, p.tp1, p.tp2, p.support, p.resistance]
        .every((v) => Number.isFinite(v) && v > 0) && Number.isFinite(p.rr) && Number.isFinite(p.risk_pct);
      const ok = res.statusCode === 200 && rows.length >= 7 && nan === 0 && rupiah >= 7 && planOk;
      if (!ok) allOk = false;
      parts.push(t + ':rows=' + rows.length + ' nan=' + nan + ' plan=' + planOk);
    }
    fiboOk = allOk === true;
    fiboDetail = parts.join(' | ');
  } catch (e) { fiboDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'tabel fibo >=7 baris rupiah valid 0 NaN + plan Entry/SL/TP1/TP2/RR/SR (BBCA/BBRI/BRPT/BULL)',
    fiboOk === true, '4 ticker x >=7 baris + plan penuh', fiboDetail);

  // 3. Fungsional chat: "Apa arti LPM sekarang?" -> balasan ada angka LPM riil, 0 frasa mati.
  let chatOk = false;
  let chatDetail = 'handler tidak termuat';
  try {
    delete require.cache[path.join(ROOT, 'api', 'ai', 'chat.js')];
    const handler = require(path.join(ROOT, 'api', 'ai', 'chat.js'));
    const mkRes = () => {
      const r = { statusCode: 200, headers: {}, body: '' };
      r.setHeader = function (k, v) { r.headers[k] = v; return r; };
      r.end = function (d) { r.body = d; return r; };
      return r;
    };
    let allOk = true;
    const parts = [];
    for (const t of ['BBCA', 'BBRI', 'BRPT', 'BULL']) {
      const res = mkRes();
      await handler({ method: 'POST', query: {}, body: { message: 'Apa arti LPM sekarang?', ticker: t } }, res);
      const j = JSON.parse(res.body);
      const reply = (j && j.reply) || '';
      const hasLpm = typeof j.lpm === 'number' && reply.indexOf(String(Math.round(j.lpm))) !== -1;
      const noDead = reply.indexOf('AI tidak tersedia') === -1;
      const valid = chatReplyValidator(j);
      const ok = res.statusCode === 200 && hasLpm && noDead && valid;
      if (!ok) allOk = false;
      parts.push(t + ':lpm=' + j.lpm + ' inReply=' + hasLpm + ' noDead=' + noDead);
    }
    chatOk = allOk === true;
    chatDetail = parts.join(' | ');
  } catch (e) { chatDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'POST "Apa arti LPM sekarang?" => balasan ada angka LPM riil, 0 "AI tidak tersedia" (4 ticker)',
    chatOk === true, '4/4 lpm-angka + 0 frasa-mati', chatDetail);

  // 4. Fungsional chat plan: "Di mana area beli dan stop loss?" -> ada angka SL riil, 0 frasa mati.
  let planChatOk = false;
  let planChatDetail = 'handler tidak termuat';
  try {
    delete require.cache[path.join(ROOT, 'api', 'ai', 'chat.js')];
    const handler = require(path.join(ROOT, 'api', 'ai', 'chat.js'));
    const mkRes = () => {
      const r = { statusCode: 200, headers: {}, body: '' };
      r.setHeader = function (k, v) { r.headers[k] = v; return r; };
      r.end = function (d) { r.body = d; return r; };
      return r;
    };
    const res = mkRes();
    await handler({ method: 'POST', query: {}, body: { message: 'Di mana area beli dan stop loss?', ticker: 'BBCA' } }, res);
    const j = JSON.parse(res.body);
    const reply = (j && j.reply) || '';
    const sl = j && j.plan ? j.plan.sl : null;
    const hasSl = Number.isFinite(sl) && reply.indexOf(String(Math.round(sl))) !== -1;
    const noDead = reply.indexOf('AI tidak tersedia') === -1;
    planChatOk = res.statusCode === 200 && hasSl === true && noDead === true;
    planChatDetail = 'sl=' + sl + ' inReply=' + hasSl + ' noDead=' + noDead;
  } catch (e) { planChatDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'POST "Di mana area beli dan stop loss?" => balasan ada angka SL riil, 0 frasa-mati',
    planChatOk === true, 'sl-angka + 0 frasa-mati', planChatDetail);

  // 5. 0 frasa mati di file scope.
  let deadOk = false;
  let deadDetail = 'tidak terbaca';
  try {
    const counts = scopeFiles.map((f) => {
      const s = read(f) || '';
      return { f, n: s.split('AI tidak tersedia saat ini').length - 1 };
    });
    deadOk = counts.every((c) => c.n === 0);
    deadDetail = counts.map((c) => c.f + '=' + c.n).join(' ');
  } catch (e) { deadDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, '0 kemunculan "AI tidak tersedia saat ini" di 4 file scope',
    deadOk === true, '0+0+0+0', deadDetail);

  // 6. CSS gelembung proporsional + estimasi tinggi bubble <140px.
  let bubOk = false;
  let bubDetail = 'tidak terbaca';
  try {
    const hasH = css.includes('height:auto!important');
    const hasMin = css.includes('min-height:unset!important');
    const hasPad = css.includes('padding:8px 12px!important');
    const scoped = css.includes('#unifiedChatMessages');
    // Estimasi statis ala simulasi F07: balasan LPM ~230 char, ~85 char/baris @92% lebar,
    // tinggi baris ~20px (14px x 1.45) + padding 16px.
    delete require.cache[path.join(ROOT, 'api', 'ai', 'chat.js')];
    const handler = require(path.join(ROOT, 'api', 'ai', 'chat.js'));
    const mx = handler.computeMatrix('BBCA');
    const reply = handler.buildReply('lpm', mx);
    const lines = Math.max(1, Math.ceil(reply.length / 85));
    const estH = lines * 21 + 16;
    bubOk = hasH && hasMin && hasPad && scoped && estH < 140;
    bubDetail = 'h=' + hasH + ' min=' + hasMin + ' pad=' + hasPad + ' scope=' + scoped
      + ' replyLen=' + reply.length + ' lines~' + lines + ' estH~' + estH + 'px(<140:' + (estH < 140) + ')';
  } catch (e) { bubDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'CSS bubble proporsional (height auto + min-height unset + padding 8px 12px) & tinggi <140px',
    bubOk === true, 'kontrak-css + estH<140px', bubDetail);

  // 7. HTML: matriks + fibo + pilar + sizing + grid 12 kolom + JetBrains Mono tabular-nums.
  let htmlOk = false;
  let htmlDetail = 'tidak terbaca';
  try {
    const ids = ['v3f08Matrix', 'v3f08Entry', 'v3f08SL', 'v3f08Risk', 'v3f08TP1', 'v3f08TP2', 'v3f08RR',
      'v3f08Support', 'v3f08Resistance', 'v3f08FiboTable', 'v3f08FiboBody', 'v3f08Pillars',
      'v3f08PillarList', 'v3f08Sizing', 'v3f08Lots', 'v3f08RiskRp'];
    const idsOk = ids.every((id) => html.includes('id="' + id + '"'));
    const gridOk = html.includes('repeat(12,1fr)') && html.includes('grid-column:span 12');
    const labels = ['Area Entry', 'SL + %risiko', 'TP1', 'TP2', 'R/R', 'Support terdekat', 'Resistance terdekat',
      'Tabel Fibonacci', 'Rincian Skor 4 Pilar', 'Kalkulator Position Sizing', 'Position Sizing'];
    const labelsOk = labels.every((l) => html.includes(l));
    const qpOk = html.includes('Di mana area beli dan stop loss?');
    const monoOk = html.includes('v3f08-mono') || css.includes('JetBrains Mono');
    const tabularOk = css.includes('tabular-nums');
    htmlOk = idsOk && gridOk && labelsOk && qpOk && monoOk && tabularOk;
    htmlDetail = 'ids=' + idsOk + ' grid12=' + gridOk + ' labels=' + labelsOk + ' qp=' + qpOk
      + ' mono=' + monoOk + ' tabular=' + tabularOk;
  } catch (e) { htmlDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'HTML matriks+fibo+pilar+sizing grid-12 + JetBrains Mono tabular-nums + quick prompt SL',
    htmlOk === true, 'ids+grid+label+qp+mono penuh', htmlDetail);

  // 8. app.js: wiring /api/ai/chat (GET matriks + POST chat) + override sendChatQuery + netralisasi legacy.
  let jsOk = false;
  let jsDetail = 'tidak terbaca';
  try {
    const getW = appjs.includes('/api/ai/chat?ticker=') || appjs.includes('/api/ai/chat');
    const postW = appjs.includes("fetch('/api/ai/chat'") || appjs.includes('fetch("/api/ai/chat"');
    const overrideQ = appjs.includes('UC.sendChatQuery=function') || appjs.includes('sendChatQuery=function');
    const overrideQP = appjs.includes('UC.sendQuickPrompt=function') || appjs.includes('sendQuickPrompt=function');
    const neutral = appjs.includes('neutralizeLegacyChat') || appjs.includes('stockAiBound');
    const render = appjs.includes('v3f08FiboBody') && appjs.includes('v3f08PillarList');
    jsOk = getW && postW && overrideQ && overrideQP && neutral && render;
    jsDetail = 'get=' + getW + ' post=' + postW + ' sendQ=' + overrideQ + ' quickP=' + overrideQP
      + ' neutral=' + neutral + ' render=' + render;
  } catch (e) { jsDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'app.js wiring /api/ai/chat GET+POST + override chat + netralisasi legacy + render',
    jsOk === true, 'get+post+override+neutral+render', jsDetail);

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
