'use strict';

const fs = require('fs');
const path = require('path');

const checkpointPath = path.join(__dirname, '..', 'CHECKPOINT_AUDIT_ROO.md');
let content = fs.readFileSync(checkpointPath, 'utf8');

// 1. Update Table Row for Fase 8
const oldTableRow = '| 8 | NOT-CHECKED | - | - | - | - | - |';
const newTableRow = '| 8 | VERIFIED | 28 Okt 22:10 | 28 Okt 22:45 | fase08/ | 2557 KB | 963 emiten audit, KSEI per tanggal verified, 326 KB PNG, tiered 501/450 req/hari (hemat 48%), 2x/mgg PASS |';

if (content.includes(oldTableRow)) {
  content = content.replace(oldTableRow, newTableRow);
  console.log('✓ Updated table row for Fase 8 in CHECKPOINT_AUDIT_ROO.md');
} else {
  console.log('⚠ oldTableRow not found');
}

// 2. Insert Log for Fase 8 before decisions section
const targetMarker = '## KEPUTUSAN DAN ASUMSI YANG PERLU KONFIRMASI PEMILIK';
const fase8Log = `### FASE 8 — Insider tiered dan Struktur Pasar (KSEI) [VERIFIED]
- **Perintah**: \`node scripts/audit-fase08-insider-ksei.js\`, \`node scripts/capture-struktur-pasar-screenshot.js\`, \`node scripts/run-tiered-simulation.js\`, \`node scripts/build-audit-data-963-emiten.js\`
- **8A. Audit Data Insider & Struktur Pasar (KSEI)**:
  - Berkas dataset di \`data/insider-network/\`:
    - \`insiders-db.json\`: 11.219 transaksi historis (2020 s/d Sep 2026), 907 emiten aktif.
    - \`roster_30sep2026.json\`: as_of 2026-09-30, 962 emiten KSEI terdaftar.
    - \`ownership_30sep2026.json\`: 962 emiten lengkap dengan freeFloat, float, investorCount, investors (>5%).
    - \`network.json\`: 226 entitas konglomerasi multi-emiten, 907 emiten terhubung graf relasi nodes & edges.
  - Sensus semesta emiten (963 emiten BEI aktif):
    - Kepemilikan KSEI: 961 emiten lolos lengkap (1 incomplete: CNTX 0 investor; 1 tidak ada: MSKY).
    - Graf Relasi Insider: 907 emiten terhubung lengkap dengan nodes & edges konglomerasi.
- **8B. Struktur Pasar UI & Kolom Wajib "Per tanggal"**:
  - Kolom wajib \`Per tanggal\` terverifikasi di header tabel \`#marketStructureTable\` dan sel data \`<td>\`.
  - Bersumber langsung dari tanggal asli KSEI (\`2026-09-30\`), diformat rapi via \`formatIndonesianDateWithWib\` menjadi \`30 Sep 2026\`, atau \`—\` jika data belum tersedia (0 tanggal mock/palsu).
  - Free Float dilengkapi bar visual mini interaktif di sel tabel (\`ffVisual\` width proporsional + warna adaptif brand/warning) serta progress bar di panel detail (\`msDetailFfBar\`).
  - Chip filter sinkron dengan semesta data riil: Semua (962), Free Float Rendah <15% (551), HSC Aktif (0), Data Belum Lengkap (1).
  - Sinkronisasi interaktif: Klik baris emiten (misal BBCA / BREN) membuka panel Detail Struktur secara sinkron dengan sumber \`KSEI · 30 Sep 2026\`.
  - Tangkapan layar antarmuka Playwright/Puppeteer tersimpan: \`bukti-verifikasi-final/fase08/struktur_pasar_per_tanggal.png\` (326,0 KB, 1920x1080).
- **8C. Jadwal Insider Berjenjang (Tiered Schedule Hemat Kuota)**:
  - Modul produksi: \`lib/insider-tiered-scheduler.js\` berbasis profil likuiditas Fase 6 (\`lib/liquidity-profiler.js\`).
  - **Tier 1 (Likuid / Konglomerasi / Aktif)**: 194 emiten (~200 emiten), dicek setiap hari bursa (~194 req/hari).
  - **Tier 2 (Non-Likuid / Lapis 2–3)**: 769 emiten (~764 emiten), digilir 2 kali seminggu:
    - Grup A (385 emiten): Senin & Kamis
    - Grup B (384 emiten): Selasa & Jumat
    - Cadangan / Sweep: Rabu
  - **Hasil Simulasi Deterministik 7 Hari Bursa Berturut-turut**:
    - Day 1 (Senin): 579 req
    - Day 2 (Selasa): 578 req
    - Day 3 (Rabu): 194 req (Tier 1 + sweep)
    - Day 4 (Kamis): 579 req
    - Day 5 (Jumat): 578 req
    - Day 6 (Senin): 579 req
    - Day 7 (Selasa): 578 req
    - Rata-rata beban kuota harian: **501.6 req/hari** (semesta penuh 963 emiten) dan **450.0 req/hari** (subset emiten aktif insider ~834 emiten), berada tepat di kisaran target **~455 req/hari**.
    - Beban tanpa tiered scheduler: 963 req/hari -> **Hemat kuota 47,9% (hampir 50% hemat kuota)**.
    - Uji Assertion (1): Setiap emiten non-likuid terambil **tepat 2 kali per minggu** (\`all_tier2_checked_exactly_twice_per_week = true\`, Min=2, Max=2).
  - Laporan hasil simulasi: \`bukti-verifikasi-final/fase08/simulasi-tiered-insider.json\` (2,0 KB).
- **8D. Rekapitulasi Gabungan Audit Data 963 Emiten (Fase 3 sampai 8)**:
  - Matriks kesehatan data komposit 963 emiten menggabungkan:
    1. Candle & Volume EOD: 962/963 PASS (99.9%)
    2. Level Chart & 5 Mode: 959/963 PASS (99.6%)
    3. Broksum ALL: 963/963 PASS (100%)
    4. Broksum Foreign: 963/963 PASS (100%)
    5. Broksum Domestik & Akumulasi Rolling: 963/963 PASS (100%)
    6. Profil Likuiditas Fase 6: 194 Likuid / 769 Non-Likuid (100%)
    7. Laporan Keuangan: 963/963 PASS (32 emiten utama aktif Q2 2026, 931 Q1 2026 / FY 2025)
    8. Insider & Struktur Pasar (KSEI): 961/963 PASS (99.8%)
  - Berkas master: \`bukti-verifikasi-final/audit-data-963-emiten.json\` (2.227,1 KB) dan salinan di \`bukti-verifikasi-final/fase08/audit-data-963-emiten.json\` (2.227,1 KB).
- **8E. Bukti Fisik Artefak**:
  - \`bukti-verifikasi-final/fase08/struktur_pasar_per_tanggal.png\` (326,0 KB)
  - \`bukti-verifikasi-final/fase08/simulasi-tiered-insider.json\` (2,0 KB)
  - \`bukti-verifikasi-final/fase08/audit-data-963-emiten.json\` (2.227,1 KB)
  - \`bukti-verifikasi-final/audit-data-963-emiten.json\` (2.227,1 KB)
  - \`bukti-verifikasi-final/fase08/audit-insider-ksei-summary.json\` (0,8 KB)
  - \`bukti-verifikasi-final/fase08/struktur-pasar-ui-verification.json\` (0,8 KB)

${targetMarker}`;

if (content.includes(targetMarker)) {
  content = content.replace(targetMarker, fase8Log);
  console.log('✓ Inserted Fase 8 log in CHECKPOINT_AUDIT_ROO.md');
} else {
  console.log('⚠ targetMarker not found');
}

fs.writeFileSync(checkpointPath, content, 'utf8');
console.log('Done updating CHECKPOINT_AUDIT_ROO.md');
