'use strict';
// Gate G2 — Ekstraksi Kontrak 28 Kanvas + style-fidelity.js + motion-audit.js.
// Kontrak: instruksi subtask G2. PASS bila checked===total (28/28 kanvas
// terekstrak ke kontrak-28-kanvas.json dengan seluruh field kontrak valid),
// serta style-fidelity.js + motion-audit.js lolos kontrol negatif.
// Bukti hanya Drive D. DILARANG sentuh main.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'G2.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'G2-before.json');
const KONTRAK_PATH = path.join(ROOT, 'bukti-verifikasi-final', 'faseG2', 'kontrak-28-kanvas.json');

const result = lib.newResult('G2', 'Ekstraksi Kontrak 28 Kanvas + style-fidelity.js + motion-audit.js');

function sh(cmd) {
  try {
    return cp.execSync(cmd, { encoding: 'utf8', cwd: ROOT, shell: 'cmd.exe' }).trim();
  } catch (e) {
    return '';
  }
}

function entryValid(k) {
  if (!k || typeof k !== 'object') return false;
  if (typeof k.file !== 'string' || !k.file.endsWith('.dc.html')) return false;
  if (!k.judulTitle && !(Array.isArray(k.judulH1) && k.judulH1.length) && !(Array.isArray(k.judulPh) && k.judulPh.length)) return false;
  if (!Array.isArray(k.tabs) || !Array.isArray(k.segmen)) return false;
  if (!Array.isArray(k.tombolAksi) || k.tombolAksi.length < 1) return false;
  if (!Array.isArray(k.headerKolom)) return false;
  if (typeof k.kartuMetrik !== 'number') return false;
  if (!Array.isArray(k.ariaLabels)) return false;
  if (!Array.isArray(k.cssUtama) || k.cssUtama.length < 1) return false;
  if (!Array.isArray(k.komponenKhusus)) return false;
  if (!(k.bytes > 0)) return false;
  return true;
}

async function main() {
  // --- Kontrol negatif tingkat gate: validator kontrak wajib MENOLAK sampel rusak ---
  // Sampel 1: halaman uji dihapus 1 tombolnya (tombolAksi dikosongkan) -> pass:false.
  // Sampel 2: halaman uji dirusak CSS-nya (cssUtama dikosongkan) -> pass:false.
  const ncSamples = [
    { description: 'tombol dihapus (tombolAksi kosong)', sample: { file: 'X.dc.html', judulTitle: 'X', judulH1: ['X'], judulPh: ['X'], tabs: [], segmen: [], tombolAksi: [], headerKolom: [], kartuMetrik: 0, ariaLabels: [], cssUtama: ['ph'], komponenKhusus: [], bytes: 100 } },
    { description: 'CSS dirusak (cssUtama kosong)', sample: { file: 'X.dc.html', judulTitle: 'X', judulH1: ['X'], judulPh: ['X'], tabs: [], segmen: [], tombolAksi: ['OK'], headerKolom: [], kartuMetrik: 0, ariaLabels: [], cssUtama: [], komponenKhusus: [], bytes: 100 } },
    { description: 'kontrak hilang (bukan objek)', sample: null },
    { description: 'judul hilang total', sample: { file: 'X.dc.html', judulTitle: '', judulH1: [], judulPh: [], tabs: [], segmen: [], tombolAksi: ['OK'], headerKolom: [], kartuMetrik: 0, ariaLabels: [], cssUtama: ['ph'], komponenKhusus: [], bytes: 100 } },
  ];
  const ncGate = lib.runNegativeControl(ncSamples.map((s) => s.sample), entryValid);

  // --- Bukti nyata: kontrak 28 kanvas ---
  let kontrak = null;
  let kontrakErr = '';
  try {
    kontrak = JSON.parse(fs.readFileSync(KONTRAK_PATH, 'utf8'));
  } catch (e) {
    kontrakErr = String(e.message).slice(0, 160);
  }
  const kanvas = (kontrak && Array.isArray(kontrak.kanvas)) ? kontrak.kanvas : [];
  const branch = sh('git branch --show-current');

  // --- Alat uji standar: style-fidelity.js + motion-audit.js (browser nyata) ---
  let styleR = null;
  let motionR = null;
  let styleErr = '';
  let motionErr = '';
  try {
    const style = require('./style-fidelity');
    styleR = await style.selfCheck();
  } catch (e) {
    styleErr = String(e && e.message || e).slice(0, 200);
  }
  try {
    const motion = require('./motion-audit');
    motionR = await motion.selfCheck();
  } catch (e) {
    motionErr = String(e && e.message || e).slice(0, 200);
  }
  const stylePass = Boolean(styleR && styleR.pass === true);
  const motionPass = Boolean(motionR && motionR.pass === true);
  const styleNC = (styleR && styleR.negativeControl) || { injected: 0, detected: 0, pass: false };
  const motionNC = (motionR && motionR.negativeControl) || { injected: 0, detected: 0, pass: false };

  const ncInjected = (ncGate.injected || 0) + (styleNC.injected || 0) + (motionNC.injected || 0);
  const ncDetected = (ncGate.detected || 0) + (styleNC.detected || 0) + (motionNC.detected || 0);
  result.negativeControl = {
    description: 'Suntik halaman rusak (1 tombol dihapus + CSS dirusak + kontrak hilang + judul hilang) wajib pass:false; style-fidelity.js (' + styleNC.injected + '/' + styleNC.detected + ') + motion-audit.js (' + motionNC.injected + '/' + motionNC.detected + ') wajib lolos kontrol negatif',
    injected: ncInjected,
    detected: ncDetected,
    pass: ncInjected >= 1 && ncDetected === ncInjected,
  };

  // --- 28 assertions: satu per kanvas (checked===total 28/28) ---
  const byFile = {};
  for (const k of kanvas) byFile[k.file] = k;
  let files = [];
  try {
    files = fs.readdirSync(path.join(ROOT, 'handoff-redesign', 'design', 'project')).filter((f) => f.endsWith('.dc.html')).sort();
  } catch (_) { files = []; }
  // Pastikan tepat 28 berkas kanvas di disk sebagai semesta assertions.
  const universe = files.length === 28 ? files : kanvas.map((k) => k.file).sort();
  // Normalisasi: selalu 28 assertions sesuai kontrak bila disk lengkap.
  const list28 = (files.length === 28 ? files : []).map((f) => byFile[f] || { file: f });
  // Bila disk tak lengkap, tetap 28 assertions dari kontrak (fail).
  const final28 = list28.length === 28 ? list28 : kanvas.slice(0, 28);
  while (final28.length < 28) final28.push({ file: '(hilang-' + final28.length + ')' });

  for (const k of final28) {
    const ok = entryValid(k) && stylePass && motionPass;
    const actual = entryValid(k)
      ? ('judul=' + (k.judulTitle || (k.judulH1 || [])[0] || '?') + ' tabs=' + k.tabs.length + ' tombol=' + k.tombolAksi.length + ' kolom=' + k.headerKolom.length + ' metrik=' + k.kartuMetrik + ' aria=' + k.ariaLabels.length + ' css=' + k.cssUtama.length + ' khusus=' + (k.komponenKhusus || []).join(',') + ' | fidelity=' + (stylePass ? 'pass' : 'FAIL:' + styleErr) + ' motion=' + (motionPass ? 'pass' : 'FAIL:' + motionErr))
      : ('TIDAK VALID (' + (k.file || '?') + ') kontrakErr=' + kontrakErr + ' | fidelity=' + (stylePass ? 'pass' : 'FAIL') + ' motion=' + (motionPass ? 'pass' : 'FAIL'));
    lib.addAssertion(result, 'kanvas ' + (k.file || '?') + ' terekstrak + fidelity/motion lolos', ok, 'judul+tabs+tombol+kolom+metrik+aria+css+khusus valid; fidelity pass; motion pass', actual);
  }

  // Ringkas konteks ke assertion terakhir via actual (tanpa menambah total).
  result.branch = branch;
  result.kontrakPath = path.relative(ROOT, KONTRAK_PATH);
  result.styleFidelity = styleR ? { pass: styleR.pass, diffRatio: styleR.diffRatio, panel3: styleR.panel3, negativeControl: styleNC } : { pass: false, error: styleErr };
  result.motionAudit = motionR ? { pass: motionR.pass, inpMs: motionR.inpMs, negativeControl: motionNC } : { pass: false, error: motionErr };

  // Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
  try {
    if (!fs.existsSync(BEFORE)) {
      fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
      const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'G2-before: snapshot kondisi sebelum perbaikan' });
      fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
    }
  } catch (_) {}

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try {
    lib.addAssertion(result, 'gate-G2 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200));
  } catch (_) {}
  lib.finalizeGate(result, OUT);
});
