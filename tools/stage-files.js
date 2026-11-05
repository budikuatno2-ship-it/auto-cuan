'use strict';
// stage-files.js — Salin non-destruktif berkas audit ke D:\staging-audit-roo-v3
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAGING = 'D:\\staging-audit-roo-v3';

// 1. Bersihkan staging jika sudah ada dari run lama
if (fs.existsSync(STAGING)) {
  console.log(`Membersihkan staging lama di ${STAGING}...`);
  fs.rmSync(STAGING, { recursive: true, force: true });
}
fs.mkdirSync(STAGING, { recursive: true });
console.log(`Staging folder dibuat di ${STAGING}`);

function copyRel(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    console.warn(`File tidak ditemukan: ${rel}`);
    return false;
  }
  const dest = path.join(STAGING, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

let copiedCount = 0;

// (A) Seluruh laporan .md audit di root
const rootMd = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md'));
for (const f of rootMd) {
  if (copyRel(f)) copiedCount++;
}

// (B) bukti-verifikasi-final/gates-v3/*.json (termasuk R1.json)
const gDir = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3');
if (fs.existsSync(gDir)) {
  const gFiles = fs.readdirSync(gDir).filter((f) => f.endsWith('.json'));
  for (const f of gFiles) {
    if (copyRel(path.join('bukti-verifikasi-final', 'gates-v3', f))) copiedCount++;
  }
}

// (C) bukti-verifikasi-final/fase03/*
const f3Dir = path.join(ROOT, 'bukti-verifikasi-final', 'fase03');
if (fs.existsSync(f3Dir)) {
  const f3Files = fs.readdirSync(f3Dir);
  for (const f of f3Files) {
    if (copyRel(path.join('bukti-verifikasi-final', 'fase03', f))) copiedCount++;
  }
}

// (D) 16 screenshot bukti-verifikasi-final/faseV3-live/*.png (+ summary.json)
const liveDir = path.join(ROOT, 'bukti-verifikasi-final', 'faseV3-live');
if (fs.existsSync(liveDir)) {
  const liveFiles = fs.readdirSync(liveDir);
  for (const f of liveFiles) {
    if (copyRel(path.join('bukti-verifikasi-final', 'faseV3-live', f))) copiedCount++;
  }
}

// (E) config/quota.json, data/quota-state.json, data/completeness/*.json, deploy/vps/final-schedule.cron
copyRel('config/quota.json') && copiedCount++;
copyRel('data/quota-state.json') && copiedCount++;

const cDir = path.join(ROOT, 'data', 'completeness');
if (fs.existsSync(cDir)) {
  const cFiles = fs.readdirSync(cDir).filter((f) => f.endsWith('.json'));
  for (const f of cFiles) {
    if (copyRel(path.join('data', 'completeness', f))) copiedCount++;
  }
}

copyRel(path.join('deploy', 'vps', 'final-schedule.cron')) && copiedCount++;

// (F) public/index.html, public/app.js, public/ac.css, public/chart-workstation.js, lib/quota-state.js, server.js (dan berkas inti terkait)
const coreFiles = [
  'public/index.html',
  'public/app.js',
  'public/ac.css',
  'public/chart-workstation.js',
  'lib/quota-state.js',
  'server.js'
];
for (const f of coreFiles) {
  if (copyRel(f)) copiedCount++;
}

console.log(`Berhasil menyalin ${copiedCount} berkas ke ${STAGING}`);
