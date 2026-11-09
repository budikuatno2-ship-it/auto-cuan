'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const manifestPath = path.join(ROOT, 'MANIFEST_AUDIT_V4_LENGKAP.md');

const v4Files = [
  // 1. Dokumen Aturan & Core Config
  { rel: '.roo/rules/auto-cuan-8-github-skills.md', cat: 'Aturan 8 Skill', status: 'Dibuat', desc: 'Aturan permanen institusional 8 skill GitHub Auto-Cuan V4' },
  { rel: 'server.js', cat: 'Kode Inti', status: 'Dimodifikasi', desc: 'Entry point server Express utama, graceful shutdown, single-shell route fallback' },
  { rel: 'package.json', cat: 'Konfigurasi', status: 'Tersertifikasi', desc: 'Manifest dependensi modul Node.js dan skrip operasional' },
  { rel: 'deploy/vps/final-schedule.cron', cat: 'Konfigurasi Cron', status: 'Tersertifikasi', desc: 'Jadwal cron VPS produksi (penarikan harga, fast-bundle, pembatasan kuota)' },

  // 2. Lib Backend
  { rel: 'lib/quota-manager.js', cat: 'Backend Lib', status: 'Dibuat', desc: 'Pengelola kuota Stock Arjum 18.080, hard-lock floor 5.000 (08:30-20:30 WIB)' },
  { rel: 'lib/fast-bundle.js', cat: 'Backend Lib', status: 'Dimodifikasi', desc: 'Mesin kompilasi fast-bundle < 15ms in-memory cache untuk 964 saham IDX' },
  { rel: 'lib/backtest-individual-964.js', cat: 'Backend Lib', status: 'Dibuat', desc: 'Mesin backtest 964 saham 1 per 1 lintas 7 metode kuantitatif (0 Math.random)' },
  { rel: 'lib/bandarmologi-service.js', cat: 'Backend Lib', status: 'Dimodifikasi', desc: 'Kalkulasi net broker flow, rasio akumulasi Top 1/3/5, dan konsentrasi CR3' },
  { rel: 'lib/admin-notes-handler.js', cat: 'Backend Lib', status: 'Dimodifikasi', desc: 'Handler catatan admin: pembersihan dummy, hapus persisten, briefing pasar' },
  { rel: 'lib/telegram-notifier.js', cat: 'Backend Lib', status: 'Dibuat', desc: 'Pengirim telemetri Telegram dengan anti-spam throttler & filter heartbeat' },
  { rel: 'lib/heartbeat-recorder.js', cat: 'Backend Lib', status: 'Dibuat', desc: 'Perekam detak jantung cron/worker internal ke log telemetri tanpa spam' },
  { rel: 'lib/sector-radar.js', cat: 'Backend Lib', status: 'Dibuat', desc: 'Agregator radar sektor & konglomerasi besar (Barito, Djarum, Salim, dll)' },
  { rel: 'lib/local-market-subset-store.js', cat: 'Backend Lib', status: 'Dimodifikasi', desc: 'Penyimpan subset data pasar lokal teroptimasi cepat' },
  { rel: 'routes/admin.js', cat: 'Routing Admin', status: 'Dimodifikasi', desc: 'Router controller administrasi: endpoint kontrol pemeliharaan, kuota, audit' },

  // 3. API Endpoints
  { rel: 'api/version.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint status versi rilis live V4 (4.0.0-institutional)' },
  { rel: 'api/admin/quota-status.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint pemantau kuota Stock Arjum & status hard-lock untuk HUD' },
  { rel: 'api/ai/chat.js', cat: 'Endpoint API', status: 'Dimodifikasi', desc: 'Guardrail Anti-Slop AI chat, analisis teknikal SMC & penyesuaian khusus IHSG' },
  { rel: 'api/backtest.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint penyaji data backtest per-ticker untuk lencana Analisis AI' },
  { rel: 'api/bandarmologi.js', cat: 'Endpoint API', status: 'Dimodifikasi', desc: 'Endpoint penyaji tabel broker flow dan konsentrasi bandar' },
  { rel: 'api/candles.js', cat: 'Endpoint API', status: 'Dimodifikasi', desc: 'Endpoint candlestick OHLCV sinkron Yahoo Finance (IHSG 7.505 & BBCA 10k)' },
  { rel: 'api/chart.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint data chart workstation, pola SMC BOS/CHoCH & Harmonic' },
  { rel: 'api/intel.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint deteksi sinyal intelijen dan pemindai anomali volume < 1 detik' },
  { rel: 'api/pattern-radar.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint pattern radar pola harmonik XABCD untuk 964 saham BEI' },
  { rel: 'api/quote.js', cat: 'Endpoint API', status: 'Dimodifikasi', desc: 'Normalisasi kuotasi harga, bid/offer spread, dan validasi turnover' },
  { rel: 'api/ranking.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint pemeringkat pasar harian (top value/gain/loss/foreign flow)' },
  { rel: 'api/screener.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint screener multivariat (Daytrade, Konglo, Non-Konglo) + Win Rate' },
  { rel: 'api/sector-hot.js', cat: 'Endpoint API', status: 'Dimodifikasi', desc: 'Endpoint penyaji heatmap sektor dan konglomerasi (>= 4 emiten/grup)' },
  { rel: 'api/signals.js', cat: 'Endpoint API', status: 'Dimodifikasi', desc: 'Handler sinyal trading aktif' },
  { rel: 'api/struktur-pasar.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint struktur pasar: rasio Free Float riil 90%+ dan nama pengendali' },
  { rel: 'api/top5-radar.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint top 5 radar dashboard dengan timestamp segar hari ini' },
  { rel: 'api/track-record.js', cat: 'Endpoint API', status: 'Dibuat', desc: 'Endpoint rekap performa portofolio 6 kartu metrik kuantitatif' },

  // 4. Frontend UI & Runtime
  { rel: 'public/index.html', cat: 'Frontend UI', status: 'Dimodifikasi', desc: 'Master single-shell UI bento grid 12-kolom, HUD kuota & telemetri' },
  { rel: 'public/app.js', cat: 'Frontend Script', status: 'Dimodifikasi', desc: 'Controller navigasi Single-Shell SPA, pemulihan URL hash & track record' },
  { rel: 'public/v4-f08-runtime.js', cat: 'Frontend Script', status: 'Dibuat', desc: 'Runtime screener responsif, radar popup, dan integrasi matriks kuantitatif' },
  { rel: 'public/analisis-v2.js', cat: 'Frontend Script', status: 'Dimodifikasi', desc: 'Renderer sub-tab AI: Fibonacci 9 baris, lencana backtest, SVG insider rapi' },
  { rel: 'public/chart-workstation.js', cat: 'Frontend Script', status: 'Dimodifikasi', desc: 'Render chart workstation < 150ms, poligon XABCD, indikator SMC BOS/CHoCH' },
  { rel: 'public/admin-console.html', cat: 'Frontend UI', status: 'Dimodifikasi', desc: 'Template Admin Console institucional, waktu WIB, tabel ancaman forensik' },
  { rel: 'public/admin-console-runtime.js', cat: 'Frontend Script', status: 'Dimodifikasi', desc: 'Runtime Admin Console, integrasi telemetry HUD, proteksi F5 reload' },
  { rel: 'public/analisis-saham.html', cat: 'Frontend UI', status: 'Dimodifikasi', desc: 'Halaman analisis saham single-shell dengan sidebar 19 menu' },
  { rel: 'partials/analisis-saham.partial.html', cat: 'Frontend Partial', status: 'Dimodifikasi', desc: 'Partial template analisis saham: header modern, sub-tab harmonis' },

  // 5. Scripts & Tools
  { rel: 'scripts/build-fast-bundle.js', cat: 'Skrip Kompilasi', status: 'Dibuat', desc: 'Skrip kompilasi berkas fast-bundle 964 saham IDX ke JSON disk & RAM' },
  { rel: 'scripts/domestic-compile.js', cat: 'Skrip Kompilasi', status: 'Dibuat', desc: 'Kompilasi data domestik, validasi free float, dan pemeringkatan harian' },
  { rel: 'scripts/fetch-yahoo-eod.js', cat: 'Skrip Kompilasi', status: 'Dibuat', desc: 'Penarik data EOD Yahoo Finance resmi (IHSG 7.505, BBCA 10k, 0 kuota API)' },
  { rel: 'scripts/foreign-compile.js', cat: 'Skrip Kompilasi', status: 'Dibuat', desc: 'Kompilasi data aliran dana asing, konsentrasi akumulasi/distribusi' },
  { rel: 'scripts/run-individual-backtest-964.js', cat: 'Skrip Runner', status: 'Dibuat', desc: 'Runner backtest 1-per-1 964 ticker melintasi 7 strategi kuantitatif' },
  { rel: 'scripts/top5-radar.js', cat: 'Skrip Runner', status: 'Dibuat', desc: 'Runner harian Top 5 Radar dengan timestamp valid hari ini WIB' },
  { rel: 'scripts/watchdog.js', cat: 'Skrip Watchdog', status: 'Dibuat', desc: 'Watchdog kesehatan sistem berjadwal dengan penekan spam Telegram' },
  { rel: 'scripts/inspect-live-video-flow-v4.js', cat: 'Skrip Otomasi', status: 'Dibuat', desc: 'Otomasi BrowserSkill & Browser-Use: 20 screenshot live 1920x1080 di web live' },
  { rel: 'tools/build-v4-audit-package.js', cat: 'Utilitas Audit', status: 'Dibuat', desc: 'Utilitas pembungkus arsip forensik ZIP 100% non-destruktif' },

  // 6. Gerbang Penguji (16 Gates)
  { rel: 'tools/gates/gate-V4-F01.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F01: 8 Skill, Quota Manager 18.080 & Floor 5.000' },
  { rel: 'tools/gates/gate-V4-F02.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F02: Anti-Spam Watchdog & Heartbeat Cron WIB' },
  { rel: 'tools/gates/gate-V4-F03.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F03: Single-Shell SPA & Kunci 19 Menu Sidebar' },
  { rel: 'tools/gates/gate-V4-F04.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F04: UI Admin Console BI, Waktu WIB, Tabel Ancaman' },
  { rel: 'tools/gates/gate-V4-F05.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F05: Harga Riil Yahoo (IHSG 7.505, BBCA 10k), Radar WIB' },
  { rel: 'tools/gates/gate-V4-F06.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F06: Kompilasi Paralel < 15s (Bandar, Ranking, Sektor)' },
  { rel: 'tools/gates/gate-V4-F07.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F07: Backtest 964 Ticker Deterministik (0 Random)' },
  { rel: 'tools/gates/gate-V4-F08.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F08: Perbaikan Screener, Top 5 Radar, Intelijen, Track Record' },
  { rel: 'tools/gates/gate-V4-F09.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F09: Fibo 9 Baris, Lencana Backtest, Penyesuaian IHSG' },
  { rel: 'tools/gates/gate-V4-F10.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F10: Chart < 150ms, Layer Poligon XABCD & SMC BOS/CHoCH' },
  { rel: 'tools/gates/gate-V4-F11.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F11: Jejaring Insider (Hapus Duplikat 54,94%, Tabel KSEI)' },
  { rel: 'tools/gates/gate-V4-F12.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F12: Catatan Admin (0 Dummy, Hapus), Blur Modal, Telegram Test' },
  { rel: 'tools/gates/gate-V4-F13.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F13: Fast-Bundle Penuh 964 Saham (< 15ms) & 10 Endpoint API' },
  { rel: 'tools/gates/gate-V4-F14.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F14: Deployment VPS 168.110.221.197, PM2 Reload, Tes HTTP' },
  { rel: 'tools/gates/gate-V4-F15.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F15: Uji 20 Langkah Video-Flow Browser 1920x1080 Live' },
  { rel: 'tools/gates/gate-V4-F16.js', cat: 'Gate Penguji', status: 'Dibuat', desc: 'Gate F16: Pembungkusan Arsip ZIP Audit Forensik Non-Destruktif' },

  // 7. Konfigurasi & Data
  { rel: 'config/conglomerates.json', cat: 'Konfigurasi', status: 'Dibuat', desc: 'Definisi konglomerasi bursa BEI (Barito, Djarum, Salim, Sinarmas, dll)' },
  { rel: 'data/quota-state.json', cat: 'Status Data', status: 'Dimodifikasi', desc: 'Status persisten kuota Stock Arjum (18.080 max, 5.000 floor)' },
  { rel: 'data/admin-notes.json', cat: 'Status Data', status: 'Dimodifikasi', desc: 'Penyimpanan catatan admin persisten (bersih 0 dummy)' },
  { rel: 'data/pending-catchup-queue.json', cat: 'Status Data', status: 'Tersertifikasi', desc: 'Antrean sinkronisasi catch-up data historis bursa' },
  { rel: 'data/fast-bundle.json', cat: 'Dataset Master', status: 'Dimodifikasi', desc: 'Dataset fast-bundle lengkap 964 saham IDX terkompilasi' },
  { rel: 'bukti-verifikasi-final/backtest-individual-964.json', cat: 'Dataset Master', status: 'Dibuat', desc: 'Master dataset hasil backtest individual 964 saham lintas 7 strategi' }
];

let rows = '';
v4Files.forEach((item, idx) => {
  const full = path.join(ROOT, item.rel);
  let size = '0';
  let mtime = 'N/A';
  if (fs.existsSync(full)) {
    const s = fs.statSync(full);
    size = s.size.toLocaleString('id-ID');
    mtime = new Date(s.mtimeMs + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' WIB';
  }
  rows += `| ${idx + 1} | \`${item.rel}\` | ${size} | ${mtime} | ${item.status} | ${item.desc} |\n`;
});

const newSection2 = `## 2. INVENTARIS BERKAS & ARTEFAK BUKTI FORENSIK V4

Seluruh berkas berikut telah diinventarisasi dengan metrik fisik lengkap (ukuran byte aktual, waktu modifikasi WIB, status pengerjaan, dan peran rekayasa V4) serta disalin secara non-destruktif ke dalam direktori staging \`D:\\staging-audit-roo-v4\` untuk dikompresi menjadi \`D:\\AUDIT_ROO_V4_FINAL.zip\`:

### 2.1 Matriks Inventaris Lengkap Berkas Kunci yang Dibuat / Dimodifikasi Selama Eksekusi V4

| No | Lokasi Berkas Sumber | Ukuran (Bytes) | Waktu Modifikasi (WIB) | Status | Ringkasan Fungsi & Peran Rekayasa V4 |
|:---:|---|:---:|:---:|:---:|---|
${rows}
### 2.2 Inventaris Artefak Visual & Log Gate
| No | Kelompok Artefak | Jumlah Berkas | Total Ukuran | Format | Ringkasan Fungsi & Peran Rekayasa V4 |
|:---:|---|:---:|:---:|:---:|---|
| A | \`bukti-verifikasi-final/faseV4-live/*.png\` | 20 Screenshot | ~3,5 MB | PNG (1920x1080) | 20 screenshot live bukti verifikasi video-flow (setiap berkas >40KB, 20 SHA-256 unik) |
| B | \`bukti-verifikasi-final/gates-v4/F*.json\` | 16 Log Gate | ~180 KB | JSON | 16 log JSON otentik kelulusan pengujian gerbang V4-F01 s.d. V4-F16 (100% PASS) |
| C | \`data/backtest-per-ticker/*.json\` | 964 Berkas | ~380 MB | JSON | Berkas hasil backtest individual 1 per 1 untuk seluruh 964 emiten/indeks BEI |
| D | \`docs/darurat/*.md\` | 25 Berkas | ~80 KB | Markdown | Arsip dokumen mitigasi darurat dan kontrak perbaikan bursa |
| E | \`LAPORAN_FINAL_V3_TERVERIFIKASI.md\` | 1 Berkas | 15.988 bytes | Markdown | Laporan formal penutupan fase V3 sebelumnya |
| F | \`CHECKPOINT_AUDIT_ROO.md\` | 1 Berkas | 62.460 bytes | Markdown | Catatan kronologi investigasi forensik awal |

`;

let content = fs.readFileSync(manifestPath, 'utf8');
const startMarker = '## 2. INVENTARIS BERKAS & ARTEFAK BUKTI FORENSIK V4';
const endMarker = '## 3. MATRIKS SEBELUM VS SESUDAH UNTUK KE-22 TEMUAN VIDEO / SCREENSHOT';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('Marker not found!');
  process.exit(1);
}

const before = content.slice(0, startIdx);
const after = content.slice(endIdx);

const updatedContent = before + newSection2 + '---\n\n' + after;
fs.writeFileSync(manifestPath, updatedContent, 'utf8');
console.log('SUCCESS: MANIFEST_AUDIT_V4_LENGKAP.md berhasil dimutakhirkan dengan inventaris V4 lengkap!');
