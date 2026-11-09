'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING = 'D:\\staging-audit-roo-v4';

console.log('================================================================');
console.log('🚀 MEMULAI PENYIAPAN STAGING AUDIT V4 NON-DESTRUKTIF');
console.log(`Sumber  : ${ROOT}`);
console.log(`Staging : ${STAGING}`);
console.log('================================================================\n');

// 1. Pastikan STAGING bersih & baru
if (fs.existsSync(STAGING)) {
  fs.rmSync(STAGING, { recursive: true, force: true });
}
fs.mkdirSync(STAGING, { recursive: true });

function copyFileSafe(relSrc, relDest = null) {
  const targetRel = relDest || relSrc;
  const src = path.join(ROOT, relSrc);
  const dest = path.join(STAGING, targetRel);
  if (!fs.existsSync(src)) {
    console.warn(`[WARN] File sumber tidak ditemukan: ${relSrc}`);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[FILE] Salin: ${relSrc} -> ${targetRel}`);
  return true;
}

function copyDirRecursive(relSrc, filterFn = null) {
  const srcDir = path.join(ROOT, relSrc);
  if (!fs.existsSync(srcDir)) {
    console.warn(`[WARN] Direktori sumber tidak ditemukan: ${relSrc}`);
    return;
  }

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      const rel = path.relative(ROOT, full);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        if (!filterFn || filterFn(rel)) {
          const dest = path.join(STAGING, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(full, dest);
        }
      }
    }
  }

  walk(srcDir);
  console.log(`[DIR] Berhasil disalin: ${relSrc}`);
}

// A. Laporan & Manifest
console.log('\n--- 1. Laporan & Manifest ---');
copyFileSafe('MANIFEST_AUDIT_V4_LENGKAP.md');
copyFileSafe('CHECKPOINT_AUDIT_ROO.md');

const rootFiles = fs.readdirSync(ROOT);
for (const f of rootFiles) {
  if (f.startsWith('LAPORAN_FINAL') && f.endsWith('.md')) {
    copyFileSafe(f);
  }
}

if (fs.existsSync(path.join(ROOT, 'docs', 'darurat'))) {
  copyDirRecursive('docs/darurat', f => f.endsWith('.md'));
}

// B. Aturan 8 Skill Permanen
console.log('\n--- 2. Aturan 8 Skill Permanen ---');
copyFileSafe('.roo/rules/auto-cuan-8-github-skills.md');

// C. Seluruh Skrip Gate & Bukti
console.log('\n--- 3. Seluruh Skrip Gate & Bukti ---');
copyDirRecursive('tools/gates');

if (fs.existsSync(path.join(ROOT, 'tmp_investigasi'))) {
  copyDirRecursive('tmp_investigasi');
}

// Berkas hasil verifikasi .json dan .md di bukti-verifikasi-final/**
// Serta seluruh screenshot faseV4-live/*.png
copyDirRecursive('bukti-verifikasi-final', relPath => {
  const lower = relPath.toLowerCase().replace(/\\/g, '/');
  if (lower.endsWith('.json') || lower.endsWith('.md')) {
    return true;
  }
  if (lower.includes('fasev4-live/') && lower.endsWith('.png')) {
    return true;
  }
  return false;
});

// D. Seluruh Kode Sumber & Konfigurasi
console.log('\n--- 4. Seluruh Kode Sumber & Konfigurasi ---');
copyFileSafe('server.js');
copyFileSafe('package.json');
copyFileSafe('deploy/vps/final-schedule.cron');

copyDirRecursive('public');
copyDirRecursive('lib');
copyDirRecursive('routes');
copyDirRecursive('api');
copyDirRecursive('scripts');
copyDirRecursive('tools');
copyDirRecursive('config');

// Data spesifik yang disyaratkan
copyFileSafe('data/quota-state.json');
copyFileSafe('data/admin-notes.json');
copyFileSafe('data/pending-catchup-queue.json');
if (fs.existsSync(path.join(ROOT, 'data', 'completeness'))) {
  copyDirRecursive('data/completeness');
}
if (fs.existsSync(path.join(ROOT, 'data', 'backtest-per-ticker'))) {
  copyDirRecursive('data/backtest-per-ticker');
}

// E. Snapshot Git ke GIT_AUDIT_LOG.txt
console.log('\n--- 5. Snapshot Git ke GIT_AUDIT_LOG.txt ---');
let gitLogContent = '================================================================\n';
gitLogContent += 'AUTO-CUAN V4 GIT AUDIT SNAPSHOT LOG\n';
gitLogContent += `Generated at: ${new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ')} WIB\n`;
gitLogContent += 'Workspace: D:\\auto-cuan-2\n';
gitLogContent += '================================================================\n\n';

gitLogContent += '### 1. GIT STATUS -S ###\n';
try {
  gitLogContent += cp.execSync('git status -s', { cwd: ROOT, encoding: 'utf8' }) + '\n';
} catch (e) {
  gitLogContent += `Error: ${e.message}\n`;
}

gitLogContent += '\n### 2. GIT LOG -N 20 --ONELINE ###\n';
try {
  gitLogContent += cp.execSync('git log -n 20 --oneline', { cwd: ROOT, encoding: 'utf8' }) + '\n';
} catch (e) {
  gitLogContent += `Error: ${e.message}\n`;
}

gitLogContent += '\n### 3. GIT DIFF --STAT HEAD~10..HEAD ###\n';
try {
  gitLogContent += cp.execSync('git diff --stat HEAD~10..HEAD', { cwd: ROOT, encoding: 'utf8' }) + '\n';
} catch (e) {
  gitLogContent += `Error: ${e.message}\n`;
}

fs.writeFileSync(path.join(STAGING, 'GIT_AUDIT_LOG.txt'), gitLogContent, 'utf8');
console.log('[GIT] Berhasil membuat GIT_AUDIT_LOG.txt di staging');

console.log('\n================================================================');
console.log('✅ SELURUH PENYALINAN NON-DESTRUKTIF KE STAGING SELESAI');
console.log('================================================================\n');
