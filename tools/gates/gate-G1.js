'use strict';
// Gate G1 — Sinkronisasi Git + Inventaris Rujukan + Pembersihan Drive C.
// Kontrak: instruksi subtask G1. PASS bila kedua merge-base true, ke-28 .dc.html
// + ac.css + motion.js + 70 screenshot acuan terbukti ada di disk, dan folder
// artefak lama di Drive C sudah bersih. Bukti hanya Drive D.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'G1.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'G1-before.json');

const result = lib.newResult('G1', 'Sinkronisasi Git feat/daytrade-screener-v1 + Inventaris Rujukan + Drive C bersih');

function sh(cmd) {
  try {
    return cp.execSync(cmd, { encoding: 'utf8', cwd: ROOT, shell: 'cmd.exe' }).trim();
  } catch (e) {
    return '';
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function fsize(p) {
  try {
    return fs.statSync(p).size;
  } catch (_) {
    return -1;
  }
}

function listDir(p) {
  try {
    return fs.readdirSync(p);
  } catch (_) {
    return null;
  }
}

// --- Kontrol negatif: validator inventaris harus MENOLAK sampel korup di memori ---
function inventoryValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.mergeRed !== true || sample.mergeFeat !== true) return false;
  if (sample.dcCount !== 28) return false;
  if (sample.shotCount !== 70) return false;
  if (!sample.hasAcCss || !sample.hasMotionJs) return false;
  if (sample.driveCDirty === true) return false;
  return true;
}

const ncSamples = [
  { description: 'inventaris hilang (bukan objek)', sample: null },
  { description: 'merge-base palsu di memori', sample: { mergeRed: false, mergeFeat: true, dcCount: 28, shotCount: 70, hasAcCss: true, hasMotionJs: true, driveCDirty: false } },
  { description: 'kanvas kurang (27 bukan 28)', sample: { mergeRed: true, mergeFeat: true, dcCount: 27, shotCount: 70, hasAcCss: true, hasMotionJs: true, driveCDirty: false } },
  { description: 'Drive C kotor di memori', sample: { mergeRed: true, mergeFeat: true, dcCount: 28, shotCount: 70, hasAcCss: true, hasMotionJs: true, driveCDirty: true } }
];
const nc = lib.runNegativeControl(ncSamples.map((s) => s.sample), inventoryValidator);
result.negativeControl = {
  description: 'Suntik inventaris hilang + merge-base palsu + kanvas kurang + Drive C kotor di memori; validator wajib menolak keempatnya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Bukti nyata ---
const branch = sh('git branch --show-current');
const backupList = sh('git branch --list "backup-v2-master-*"');
let mergeRed = false;
let mergeFeat = false;
try {
  cp.execSync('git merge-base --is-ancestor origin/redesign/v2 HEAD', { cwd: ROOT, stdio: 'ignore', shell: 'cmd.exe' });
  mergeRed = true;
} catch (_) { mergeRed = false; }
try {
  cp.execSync('git merge-base --is-ancestor origin/feat/daytrade-screener-v1 HEAD', { cwd: ROOT, stdio: 'ignore', shell: 'cmd.exe' });
  mergeFeat = true;
} catch (_) { mergeFeat = false; }

const projDir = path.join(ROOT, 'handoff-redesign', 'design', 'project');
const projFiles = listDir(projDir) || [];
const dcFiles = projFiles.filter((f) => f.endsWith('.dc.html'));
const hasAcCss = exists(path.join(projDir, 'ac.css'));
const hasMotionJs = exists(path.join(projDir, 'motion.js'));
const acSize = fsize(path.join(projDir, 'ac.css'));
const motionSize = fsize(path.join(projDir, 'motion.js'));

const shotDir = path.join(ROOT, 'handoff-redesign', 'screenshots');
const shotFiles = listDir(shotDir) || [];
const shotCount = shotFiles.length;

const docsDir = path.join(ROOT, 'docs', 'redesign-handoff');
const docsFiles = listDir(docsDir) || [];
const expectDocs = ['GEMINI.md', 'HANDOFF_ANTIGRAVITY_REDESIGN_UIUX.md', 'HANDOFF_ROO_PIPELINE_VPS.md', 'LAMPIRAN_PERFORMA_MULTIUSER.md', 'LAMPIRAN_WEB_ANTIGRAVITY.md', 'LOG_SESI.md'];
const docsOk = expectDocs.every((f) => docsFiles.includes(f) && fsize(path.join(docsDir, f)) > 0);

const invPath = path.join(ROOT, 'bukti-verifikasi-final', 'faseG1', 'inventaris-rujukan.json');
let invOk = false;
let invNote = 'hilang';
try {
  const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
  const hasPaths = inv && inv.lokasi1 && inv.lokasi2 && inv.lokasi3 && inv.lokasi4 && inv.driveC;
  const hasSizes = hasPaths && Array.isArray(inv.lokasi4.files) && inv.lokasi4.files.every((f) => typeof f.size === 'number');
  invOk = Boolean(hasPaths && hasSizes);
  invNote = invOk ? ('lok1design=' + (inv.lokasi1.designProject || []).length + ' lok2docs=' + (inv.lokasi2.docs || []).length + ' shot=' + inv.lokasi1.screenshotsCount) : 'struktur tak lengkap';
} catch (e) {
  invNote = 'baca gagal: ' + String(e.message).slice(0, 120);
}

const driveCCheck = ['C:/auto-cuan-2', 'C:/auto-cuan', 'C:/auto-cuan-redesign', 'C:/bukti-verifikasi-final', 'C:/Users/ADVAN/bukti-verifikasi-final', 'C:/Users/ADVAN/auto-cuan-2', 'C:/Users/ADVAN/auto-cuan', 'C:/docs', 'C:/handoff-redesign', 'C:/tmp', 'C:/playwright-browsers'];
const driveCLeft = driveCCheck.filter((p) => exists(p));
const driveCClean = driveCLeft.length === 0;

let excludeTxt = '';
try {
  excludeTxt = fs.readFileSync(path.join(ROOT, '.git', 'info', 'exclude'), 'utf8');
} catch (_) { excludeTxt = ''; }
const exclOk = excludeTxt.includes('CHECKPOINT_AUDIT_ROO.md') && excludeTxt.includes('bukti-verifikasi-final/') && excludeTxt.includes('docs/darurat/');

lib.addAssertion(result, 'branch aktif feat/daytrade-screener-v1', branch === 'feat/daytrade-screener-v1', 'feat/daytrade-screener-v1', branch || '(kosong)');
lib.addAssertion(result, 'branch cadangan backup-v2-master-* ada', backupList.length > 0 && /backup-v2-master-/.test(backupList), 'backup-v2-master-*', backupList.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('|') || '(tidak ada)');
lib.addAssertion(result, 'merge-base origin/redesign/v2 ancestor HEAD', mergeRed === true, 'true', String(mergeRed));
lib.addAssertion(result, 'merge-base origin/feat/daytrade-screener-v1 ancestor HEAD', mergeFeat === true, 'true', String(mergeFeat));
lib.addAssertion(result, 'ke-28 file .dc.html ada di disk', dcFiles.length === 28, '28', String(dcFiles.length));
lib.addAssertion(result, 'ac.css + motion.js ada di disk', hasAcCss && hasMotionJs && acSize > 0 && motionSize > 0, 'ac.css>0 + motion.js>0', 'ac.css=' + acSize + 'B motion.js=' + motionSize + 'B');
lib.addAssertion(result, '70 screenshot acuan ada di disk', shotCount === 70, '70', String(shotCount));
lib.addAssertion(result, 'dokumen rujukan tersalin ke docs/redesign-handoff', docsOk, expectDocs.join(','), docsFiles.length + ' files: ' + docsFiles.join('|').slice(0, 200));
lib.addAssertion(result, 'inventaris-rujukan.json ada + path + ukuran', invOk, 'lokasi1-4 + driveC + sizes', invPath + ' :: ' + invNote);
lib.addAssertion(result, 'folder artefak lama Drive C bersih', driveCClean, '0 sisa di Drive C', driveCLeft.length === 0 ? 'bersih (11 path MISS)' : 'SISA: ' + driveCLeft.join('|'));
lib.addAssertion(result, '.git/info/exclude mencantumkan 3 pola', exclOk, 'CHECKPOINT_AUDIT_ROO.md + bukti-verifikasi-final/ + docs/darurat/', 'checkpoint=' + excludeTxt.includes('CHECKPOINT_AUDIT_ROO.md') + ' bukti=' + excludeTxt.includes('bukti-verifikasi-final/') + ' darurat=' + excludeTxt.includes('docs/darurat/'));
lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'G1-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);
