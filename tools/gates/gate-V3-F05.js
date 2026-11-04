'use strict';
// Gate V3-F05 — Perbaikan Halaman Catatan Admin (hapus 3 dummy BRPT/PTRO oleh budi, tombol Hapus, kunci role admin).
// Verifikasi: data/admin-notes.json bersih dummy; CRUD penuh admin POST->PUT->DELETE hingga 0;
// non-admin tombol hidden display:none + DELETE 403.
// ATURAN BESI: dilarang polling GH/sleep, dilarang Vercel, Windows node -e saja,
// data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F05.json');

const result = lib.newResult('V3-F05', 'Catatan Admin: bersih dummy + DELETE + tombol Hapus + kunci role admin');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function exists(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (_) { return null; } }

// --- Kontrol negatif: validator role admin wajib MENOLAK non-admin/korup ---
function roleValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  const r = sample.role;
  if (typeof r !== 'string') return false;
  if (r.toLowerCase() !== 'admin') return false;
  if (sample.simulated === true) return false;
  return true;
}

async function main() {
  const ncSamples = [
    { role: 'user' },
    { role: 'vip' },
    { role: '' },
    { role: null },
    { role: 'guest', simulated: true },
    { role: 'ADMINX' },
    { role: 123 },
    { role: 'admin', simulated: true }
  ];
  const nc = lib.runNegativeControl(ncSamples, roleValidator);
  result.negativeControl = {
    description: 'Suntik role user/vip/kosong/null/guest/simulasi/bukan-string; validator admin wajib menolak',
    injected: nc.injected, detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada.
  const scopeFiles = [
    'lib/admin-notes-handler.js',
    'public/catatan-admin-runtime.js',
    'public/index.html',
    'data/admin-notes.json',
    'api/sector-hot.js'
  ];
  const missingScope = scopeFiles.filter((f) => !exists(f));
  lib.addAssertion(result, 'scope V3-F05 selaras (handler+runtime+index+json+sector-hot)', missingScope.length === 0,
    '5/5 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '5/5 ada');

  // 2. data/admin-notes.json bersih dummy BRPT1.035/PTRO14.000 + 3 aktif + 3 riwayat karangan.
  let jsonCleanOk = false;
  let jsonDetail = 'tidak terbaca';
  try {
    const raw = read('data/admin-notes.json') || '';
    const j = readJson('data/admin-notes.json');
    const hasDummyId = raw.indexOf('note-brpt-001') >= 0 || raw.indexOf('note-ptro-002') >= 0
      || raw.indexOf('note-medc-003') >= 0 || raw.indexOf('note-bren-hist') >= 0
      || raw.indexOf('note-cuan-hist') >= 0 || raw.indexOf('note-bbca-hist') >= 0;
    const hasDummyPx = raw.indexOf('1035') >= 0 || raw.indexOf('14000') >= 0
      || raw.indexOf('13800') >= 0 || raw.indexOf('14200') >= 0;
    const hasDummyTicker = (raw.match(/BRPT/g) || []).length > 0 || (raw.match(/PTRO/g) || []).length > 0;
    const isEmptyArray = Array.isArray(j) && j.length === 0;
    jsonCleanOk = !hasDummyId && !hasDummyPx && !hasDummyTicker && isEmptyArray;
    jsonDetail = 'len=' + raw.length + ' arr=' + (Array.isArray(j) ? j.length : 'bukan-array')
      + ' dummyId=' + hasDummyId + ' dummyPx=' + hasDummyPx + ' ticker=' + hasDummyTicker;
  } catch (e) { jsonDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'data/admin-notes.json bersih dummy (0 catatan, tanpa BRPT/PTRO/1035/14000)', jsonCleanOk === true,
    'kosong+bersih', jsonDetail);

  // 3. Kode handler bersih dummy seed + tanpa auto-seed contoh produksi.
  let seedCleanOk = false;
  let seedDetail = 'tidak terbaca';
  try {
    const h = read('lib/admin-notes-handler.js') || '';
    const hasSeedIds = h.indexOf('note-brpt-001') >= 0 || h.indexOf('note-ptro-002') >= 0
      || h.indexOf('note-medc-003') >= 0 || h.indexOf('note-bren-hist') >= 0
      || h.indexOf('note-cuan-hist') >= 0 || h.indexOf('note-bbca-hist') >= 0;
    const hasEmptyStore = h.indexOf('let _mockNotes = [];') >= 0;
    const hasNoSeedComment = h.indexOf('V3-F05') >= 0;
    seedCleanOk = !hasSeedIds && hasEmptyStore && hasNoSeedComment;
    seedDetail = 'seedIds=' + hasSeedIds + ' emptyStore=' + hasEmptyStore;
  } catch (e) { seedDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'handler bersih 6 dummy seed (store mulai kosong, tanpa auto-seed)', seedCleanOk === true,
    '0 seed + kosong', seedDetail);

  // 4. Backend: DELETE ada + validasi req.user.role==='admin' + 403 + Allow mencakup DELETE.
  let backendOk = false;
  let backendDetail = 'tidak terbaca';
  try {
    const h = read('lib/admin-notes-handler.js') || '';
    const hasDelete = h.indexOf("method === 'DELETE'") >= 0;
    const hasRoleGate = h.indexOf('req.user.role') >= 0;
    const has403 = h.indexOf('403') >= 0;
    const hasAllow = h.indexOf('GET, POST, PATCH, DELETE') >= 0;
    const hasOkTrue = h.indexOf('ok: true') >= 0;
    const s = read('api/sector-hot.js') || '';
    const gateOpen = s.indexOf('_adminNotesWrite') >= 0;
    backendOk = hasDelete && hasRoleGate && has403 && hasAllow && hasOkTrue && gateOpen;
    backendDetail = 'DELETE=' + hasDelete + ' role=' + hasRoleGate + ' 403=' + has403 + ' allow=' + hasAllow + ' ok=' + hasOkTrue + ' gate=' + gateOpen;
  } catch (e) { backendDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, "backend DELETE + req.user.role==='admin' + 403 + {ok:true}", backendOk === true,
    'DELETE+role+403+ok', backendDetail);

  // 5. CRUD penuh admin POST->PUT->DELETE hingga 0 (data riil, tanpa sleep/GH/Vercel).
  let crudOk = false;
  let crudDetail = 'handler tidak termuat';
  try {
    const handler = require(path.join(ROOT, 'lib', 'admin-notes-handler'));
    if (handler && handler._mockNotes) { try { handler._mockNotes.length = 0; } catch (_) {} }
    const mkRes = () => {
      const r = { statusCode: 200, body: null };
      r.status = function (c) { r.statusCode = c; return r; };
      r.json = function (d) { r.body = d; return r; };
      r.setHeader = function () {};
      return r;
    };
    const mkReq = (method, url, user, body) => ({ method, url, headers: {}, user, body });
    const admin = { role: 'admin', id: 'admin-budi-id', username: 'budi' };
    const payload = {
      ticker: 'BBCA', style: 'daytrade',
      reason: 'Area akumulasi valid untuk pengujian CRUD gate V3-F05 dengan data riil.',
      zone_lo: 10000, zone_hi: 10150, target: 10600, risk_limit: 9800, valid_days: 2
    };
    const resPost = mkRes();
    await handler(mkReq('POST', '/api/admin-notes?action=admin-notes', admin, payload), resPost);
    if (resPost.statusCode !== 201 || !resPost.body || !resPost.body.success || !resPost.body.note || !resPost.body.note.id) {
      crudDetail = 'POST gagal: ' + resPost.statusCode + ' ' + JSON.stringify(resPost.body).slice(0, 200);
    } else {
      const nid = resPost.body.note.id;
      const resPut = mkRes();
      await handler(mkReq('PUT', '/api/admin-notes?action=admin-notes', admin, { id: nid, target: 10700, edit_reason: 'Uji edit CRUD V3-F05 valid.' }), resPut);
      if (resPut.statusCode !== 200 || !resPut.body || !resPut.body.success || Number(resPut.body.note.target) !== 10700) {
        crudDetail = 'PUT gagal: ' + resPut.statusCode + ' ' + JSON.stringify(resPut.body).slice(0, 200);
      } else {
        const resDel = mkRes();
        await handler(mkReq('DELETE', '/api/admin-notes?action=admin-notes&id=' + encodeURIComponent(nid), admin, null), resDel);
        if (resDel.statusCode !== 200 || !resDel.body || !(resDel.body.ok === true || resDel.body.success === true)) {
          crudDetail = 'DELETE gagal: ' + resDel.statusCode + ' ' + JSON.stringify(resDel.body).slice(0, 200);
        } else {
          const left = handler._mockNotes ? handler._mockNotes.length : -1;
          if (left !== 0) {
            crudDetail = 'sisa=' + left + ' (wajib 0)';
          } else {
            crudOk = true;
            crudDetail = 'POST201->PUT200(target10700)->DELETE200(ok:true)->sisa0';
          }
        }
      }
    }
  } catch (e) { crudDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'CRUD penuh admin POST->PUT->DELETE hingga 0', crudOk === true,
    'POST201 PUT200 DEL200 sisa0', crudDetail);

  // 6. Non-admin: tombol hidden display:none + DELETE 403 (riil).
  let nonAdminOk = false;
  let nonAdminDetail = 'tidak terbaca';
  try {
    const f = read('public/catatan-admin-runtime.js') || '';
    const hasLihat = f.indexOf('Lihat di chart') >= 0;
    const hasEdit = f.indexOf('openEditNoteDrawer') >= 0 && f.indexOf('>Edit<') >= 0;
    const hasHapus = f.indexOf('>Hapus<') >= 0 && f.indexOf('deleteAdminNote') >= 0;
    const hasHidden = f.indexOf('display:none') >= 0 && f.indexOf('data-admin-only') >= 0
      && f.indexOf('applyAdminVisibilityLock') >= 0;
    const html = read('public/index.html') || '';
    const btnHiddenDefault = html.indexOf('btnNewAdminNote') >= 0 && html.indexOf('display:none') >= 0;
    const handler2 = require(path.join(ROOT, 'lib', 'admin-notes-handler'));
    const resBad = { statusCode: 200, body: null };
    resBad.status = function (c) { resBad.statusCode = c; return resBad; };
    resBad.json = function (d) { resBad.body = d; return resBad; };
    resBad.setHeader = function () {};
    const reqBad = { method: 'DELETE', url: '/api/admin-notes?action=admin-notes&id=x', headers: {}, user: { role: 'user' }, body: null };
    await handler2(reqBad, resBad);
    const del403 = resBad.statusCode === 403;
    nonAdminOk = hasLihat && hasEdit && hasHapus && hasHidden && btnHiddenDefault && del403;
    nonAdminDetail = 'Lihat=' + hasLihat + ' Edit=' + hasEdit + ' Hapus=' + hasHapus + ' hidden=' + hasHidden + ' btnDefault=' + btnHiddenDefault + ' DEL403=' + del403 + '(' + resBad.statusCode + ')';
  } catch (e) { nonAdminDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'non-admin tombol hidden display:none + DELETE 403', nonAdminOk === true,
    'Lihat|Edit|Hapus + hidden + 403', nonAdminDetail);

  // 7. Kontrol negatif lolos.
  lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)',
    result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected,
    'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try {
    lib.addAssertion(result, 'gate V3-F05 tidak exception', false, 'no-exception', String((e && e.message) || e).slice(0, 200));
    lib.finalizeGate(result, OUT);
  } catch (_) { process.exit(1); }
});
