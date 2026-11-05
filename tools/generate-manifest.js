'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function getInventory() {
  const list = [];

  // 1. Audit .md files in root
  const rootFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.md')).sort();
  for (const f of rootFiles) {
    const p = path.join(ROOT, f);
    const s = fs.statSync(p);
    list.push({
      relPath: f,
      cat: 'Laporan Audit Markdown',
      sizeBytes: s.size,
      sizeFmt: (s.size / 1024).toFixed(1) + ' KB',
      mtime: s.mtime.toISOString().slice(0, 19).replace('T', ' '),
      desc: `Dokumen audit laporan: ${f}`
    });
  }

  // 2. bukti-verifikasi-final/gates-v3/*.json
  const gDir = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3');
  if (fs.existsSync(gDir)) {
    const gFiles = fs.readdirSync(gDir).filter(f => f.endsWith('.json')).sort();
    for (const f of gFiles) {
      const p = path.join(gDir, f);
      const s = fs.statSync(p);
      list.push({
        relPath: `bukti-verifikasi-final/gates-v3/${f}`,
        cat: 'Gate Verifikasi V3 JSON',
        sizeBytes: s.size,
        sizeFmt: (s.size / 1024).toFixed(1) + ' KB',
        mtime: s.mtime.toISOString().slice(0, 19).replace('T', ' '),
        desc: `Bukti gate verifikasi otomatis ${f.replace('.json', '')}`
      });
    }
  }

  // 3. bukti-verifikasi-final/fase03/*
  const f3Dir = path.join(ROOT, 'bukti-verifikasi-final', 'fase03');
  if (fs.existsSync(f3Dir)) {
    const f3Files = fs.readdirSync(f3Dir).sort();
    for (const f of f3Files) {
      const p = path.join(f3Dir, f);
      const s = fs.statSync(p);
      list.push({
        relPath: `bukti-verifikasi-final/fase03/${f}`,
        cat: 'Bukti Backtest 964 Saham Fase03',
        sizeBytes: s.size,
        sizeFmt: (s.size / 1024).toFixed(1) + ' KB',
        mtime: s.mtime.toISOString().slice(0, 19).replace('T', ' '),
        desc: `Bukti dataset & hasil evaluasi Fase 03 (${f})`
      });
    }
  }

  // 4. bukti-verifikasi-final/faseV3-live/*.png
  const liveDir = path.join(ROOT, 'bukti-verifikasi-final', 'faseV3-live');
  if (fs.existsSync(liveDir)) {
    const liveFiles = fs.readdirSync(liveDir).sort();
    for (const f of liveFiles) {
      const p = path.join(liveDir, f);
      const s = fs.statSync(p);
      list.push({
        relPath: `bukti-verifikasi-final/faseV3-live/${f}`,
        cat: 'Screenshot Bukti Nyata Live',
        sizeBytes: s.size,
        sizeFmt: (s.size / 1024).toFixed(1) + ' KB',
        mtime: s.mtime.toISOString().slice(0, 19).replace('T', ' '),
        desc: `Tangkapan layar resolusi penuh live autocuan.web.id (${f})`
      });
    }
  }

  // 5. Config, data, cron, core
  const specifics = [
    { p: 'config/quota.json', desc: 'Konfigurasi parameter kuota API dan jadwal darurat' },
    { p: 'data/quota-state.json', desc: 'Status pemakaian kuota runtime harian' },
    { p: 'data/completeness/forecast-vps.json', desc: 'Status kelengkapan forecast VPS' },
    { p: 'data/completeness/forecast.json', desc: 'Status kelengkapan forecast lokal' },
    { p: 'data/completeness/latest-vps.json', desc: 'Kelengkapan dataset 964 emiten VPS' },
    { p: 'data/completeness/latest.json', desc: 'Kelengkapan dataset 964 emiten lokal' },
    { p: 'deploy/vps/final-schedule.cron', desc: 'Jadwal crontab produksi 29 entri' },
    { p: 'public/index.html', desc: 'Antarmuka utama single-page app Auto-Cuan' },
    { p: 'public/app.js', desc: 'Logika frontend dan routing aplikasi web' },
    { p: 'public/ac.css', desc: 'Styling tema gelap, modal blur, dan layout hallmark' },
    { p: 'public/chart-workstation.js', desc: 'Mesin visualisasi SMC, XABCD, dan ZigZag' },
    { p: 'lib/quota-state.js', desc: 'Modul manajemen kuota dinamis & drift protection' },
    { p: 'server.js', desc: 'Entry point server backend Express/Node.js' }
  ];

  for (const item of specifics) {
    const full = path.join(ROOT, item.p);
    if (fs.existsSync(full)) {
      const s = fs.statSync(full);
      list.push({
        relPath: item.p,
        cat: 'Berkas Konfigurasi & Inti',
        sizeBytes: s.size,
        sizeFmt: (s.size / 1024).toFixed(1) + ' KB',
        mtime: s.mtime.toISOString().slice(0, 19).replace('T', ' '),
        desc: item.desc
      });
    }
  }

  return list;
}

const items = getInventory();
const totalBytes = items.reduce((sum, it) => sum + it.sizeBytes, 0);
const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);

let md = `# MANIFEST_AUDIT_FINAL — Inventaris Lengkap Paket Arsip Audit V3 (Non-Destruktif)

**Tanggal:** 2026-11-04  
**Target Repository:** \`D:\\auto-cuan-2\` (Branch: \`feat/daytrade-screener-v1\`)  
**Paket Arsip:** \`D:\\AUDIT_ROO_V3_FINAL.zip\`  
**Folder Staging:** \`D:\\staging-audit-roo-v3\\\`  
**Total Berkas Terinventaris:** ${items.length} berkas  
**Total Ukuran Berkas:** ${totalMb} MB (${totalBytes} bytes)  

---

## Aturan Keamanan & Privasi
1. Seluruh berkas disalin secara **aman non-destruktif** tanpa menghapus maupun memodifikasi berkas asli di repositori.
2. Tidak ada rahasia produksi (.env, private key SSH, token JWT, webhook secret) yang tercatat dalam manifest ini maupun terikut dalam paket terbuka.

---

## Tabel Inventaris Berkas Lengkap

| No | Path Relatif | Kategori | Ukuran & mtime | Deskripsi Singkat |
|:---:|---|---|---|---|
`;

items.forEach((it, idx) => {
  md += `| ${idx + 1} | \`${it.relPath}\` | ${it.cat} | ${it.sizeFmt} / ${it.mtime} | ${it.desc} |\n`;
});

md += `\n---
*Manifest digenerate secara otomatis oleh tools/generate-manifest.js untuk verifikasi audit V3.*
`;

fs.writeFileSync(path.join(ROOT, 'MANIFEST_AUDIT_FINAL.md'), md, 'utf8');
console.log(`Manifest created with ${items.length} items (${totalMb} MB).`);
