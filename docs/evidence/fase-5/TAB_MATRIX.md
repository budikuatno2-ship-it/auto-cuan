# TAB_MATRIX.md — FASE 5: UX TAB SWEEP (ALL 16 TABS & SUBTABS)

**Tanggal Audit:** 14 Oktober 2026  
**Branch:** `fix/ux-fase-5-tab-sweep`  
**Hasil Audit Layout Gaps:** 100% Lulus (`partialIntegrity.differences: []`)  
**AntiSlop Compliance:** 100% Lulus (Sifar em dash, zero native dialogs, zero unformatted dates, zero unformatted currency)

---

## Matriks Evaluasi Lengkap 16 Item Navigasi Sidebar & Sub-Tab

| No | Tab / Sub-Tab Sidebar | Selektor DOM / Route | Status Akses & Gate | Pembersihan Bar Pendua / Redundansi | Pembersihan Jargon & Bahasa | Status Scroll & Layout Viewport | Hasil Verifikasi |
|---|---|---|---|---|---|---|---|
| 1 | **Dashboard** | `#page-dashboard` | Publik (Free/Auth) | N/A (Bukan Analisis Lens) | S5/S6/S7: Terjemahkan pesan kosong, label normal pada titik IHSG, konversi kode mentah UI | Padding atas 14px rapi, responsive di 5 viewport (375px–1920px) | **LULUS** |
| 2 | **Screener** | `#page-screener` | Publik (Free/Auth) | N/A | Bersih dari em dash, format rupiah baku (`Mrd`, `Jt`) | Sticky header GPU clean, table scroll lancar | **LULUS** |
| 3 | **Sektor** | `#page-sektor` | Publik (Free/Auth) | N/A | Sektor IDX resmi, tanpa singkatan ambigu | Grid kartu responsif tanpa overflow horizontal | **LULUS** |
| 4 | **Analisis & Chart** | `#panel-tab-chart` (`analisis-chart`) | Publik (Free/Auth) | Bar 9 tombol horizontal disembunyikan via CSS (`display: none !important`) | Subtitle akurat, input ticker tunggal aktif | Chart interaktif TradingView/Lightweight lancar | **LULUS** |
| 5 | **Bandarmologi** | `#panel-tab-bandar` (`bandarmologi`) | Publik (Free/Auth) | Bar horizontal redundan disembunyikan | S8, S9, S10, S12, S36: Subtitle baru, format `Mrd`, tooltip metodologi Net Flow & Big Dist, helper WIB | S11, S34: `scrollTop = 0` saat ganti ticker/tanggal, padding-right 12px cegah digit terpotong | **LULUS** |
| 6 | **Broker Hunter** | `#panel-tab-hunter` (`hunter`) | Publik (Free/Auth) | Bar horizontal redundan disembunyikan | Format `Mrd`, label Bahasa Indonesia natural | Daftar broker rapi, scroll tabel bersih | **LULUS** |
| 7 | **Sinyal Intelijen** | `#panel-tab-intel` (`intel`) | Publik (Free/Auth) | Bar horizontal redundan disembunyikan | Label status sinyal terjemah jelas, tanpa em dash | Konfluensi sinyal akurat, no layout gap | **LULUS** |
| 8 | **Jejaring Insider** | `#panel-tab-insider` (`insider`) | Publik (Free/Auth) | Bar horizontal redundan disembunyikan | Hubungan kepemilikan dan transaksi direksi/komisaris baku | Graph/tabel transaksi insider responsif | **LULUS** |
| 9 | **Financial** | `#panel-tab-financial` (`financial`) | Publik (Free/Auth) | Bar horizontal redundan disembunyikan | Laporan laba rugi, neraca, arus kas dalam Bahasa Indonesia | Tabel finansial per kuartal tersusun rapi | **LULUS** |
| 10 | **Struktur Pasar** | `#panel-tab-market-structure` (`market-structure`) | Publik (Free/Auth) | Bar horizontal redundan & bar input ticker tunggal atas `#analisisChartHeader` disembunyikan otomatis | Sifar em dash, format persentase dan tanggal baku | Pepijat 1: Header `KODE` z-index 30/40 legap penuh (ADMF tidak menembus); Pepijat 2: Title tidak terpotong; Pepijat 3: Kolom AS-OF 110px penuh | **LULUS** |
| 11 | **Ranking Harian PRO** | `#panel-tab-ranking` (`ranking`) | Server-Side Gate PRO (`requirePremiumEntitlement` HTTP 401/402/403) | Bar horizontal redundan disembunyikan | Label indikator teknikal (RSI, 52W High, Flow) jelas | Sort multi-kolom stabil di 5 viewport | **LULUS** |
| 12 | **Pattern Radar ADMIN** | `#panel-tab-pattern` (`pattern`) | Server-Side Gate ADMIN (`requireBudiAdmin` HTTP 401/403) | Bar horizontal redundan disembunyikan | Formasi teknikal multi-frame berlabel bahasa manusia | Mount lifecycle aman, admin gate aktif | **LULUS** |
| 13 | **Portfolio Command Center** | `#page-portofolio` | Premium User Session | 7 Subtab Navigasi lengkap (Desktop `#tabStrip` & Mobile `#pccMobileSectionSelect`) | Simulasi scale-out TP1/TP2 dengan estimasi fee BEI (0,15% beli, 0,25% jual) & Break-Even Stop | Hero, metric grid, candidate item rapi di mobile hingga desktop | **LULUS** |
| 14 | **Track Record** | `#page-trackrecord` | Publik (Free/Auth) | N/A | Win rate, profit factor, metrik statistik transparan | Filter status berjalan/selesai responsif | **LULUS** |
| 15 | **Watchlist** | `#page-watchlist` | User Session | N/A | Sifar native alert/prompt (toast design system) | Daftar pantauan dan alert harga real-time | **LULUS** |
| 16 | **Langganan / Paket** | `#page-subscription` | Publik (Free/Auth) | N/A | Paket PRO, VIP, Lifetime transparan tanpa kata-kata manipulatif | Pricing card responsif, checkout gate aman | **LULUS** |

---

## 7 Sub-Tab Portfolio Command Center

| No | Sub-Tab Portfolio | ID Halaman | Input / Kontrol Tambahan | Logika & Metodologi Perhitungan | Status Pengujian |
|---|---|---|---|---|---|
| 13.1 | **Hari Ini** | `#page-today` | Decision hero & postur portofolio | Ringkasan eksposur modal, risiko, dan alert level tersimpan | Lulus |
| 13.2 | **Rencana Posisi** | `#page-planner` | Form rencana entry, stop, TP1, TP2, lot | Money management matematis (1-2% rule) | Lulus |
| 13.3 | **Pantauan** | `#page-watch` | Ticker monitoring & live price cards | Sinkronisasi harga terkini dengan rencana | Lulus |
| 13.4 | **Risiko & Avg Down** | `#page-risk` | Guard matematis penambahan lot | Decision engine anti average down ngawur | Lulus |
| 13.5 | **Skenario Posisi** | `#page-scenarios` | Select porsi TP1 (25%, 50%, 75%), Input Estimasi Fee Beli (default 0,15%), Input Estimasi Fee Jual (default 0,25%) | Simulasi bertahap (Gross, Biaya, Net) + Simulasi Break-Even Stop berlabel | Lulus unit test (`test/portfolio-scenarios-fees.test.js`) |
| 13.6 | **Jurnal Trading** | `#page-journal` | Modal input jurnal disiplin | Pencatatan eksekusi & kepatuhan rencana | Lulus |
| 13.7 | **Asisten AI** | `#page-ai` | Prompt review portofolio | Analisis risiko terpadu berbasis model AI | Lulus |
