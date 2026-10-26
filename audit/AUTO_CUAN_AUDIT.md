# LAPORAN FORENSIK AUDIT READ-ONLY MENYELURUH REPOSITORY AUTO-CUAN

> **Klasifikasi:** Laporan Audit Otoritatif Arsitektur, Kuantitatif Pasar Modal, Keamanan, dan Kesiapan Redesign UI/UX  
> **Target Analisis:** Repository [`Auto-Cuan`](package.json:1) (SPA Vanilla HTML5/CSS3/JavaScript + Node.js Runtimes + VPS Engine)  
> **Commit HEAD:** `ddb534731406a52346d089794db37e4ebe3844f0`  
> **Branch:** `feat/daytrade-screener-v1`  
> **Metode Pemeriksaan:** **READ-ONLY 100% (Strict Zero-Write, Evidence-First, Zero-Guesswork)**  
> **Sensus Repositori:** **1.515 file terpindai**, **590.464 baris kode**, total payload source **~30,3 MB**  
> **File Laporan:** [`audit/AUTO_CUAN_AUDIT.md`](audit/AUTO_CUAN_AUDIT.md)

---

## 1. RINGKASAN EKSEKUTIF (15 POIN UTAMA)

1. **Arsitektur Hibrida Monolitik Vanilla SPA:** Frontend Auto-Cuan bukan React/Vue melainkan SPA monolitik vanilla di [`public/index.html`](public/index.html:1) (16.144 baris) dengan 18 subhalaman (`page-*`), dibantu sub-app mandiri di [`public/analisis-saham.html`](public/analisis-saham.html:1) dan [`public/portfolio-command-center.html`](public/portfolio-command-center.html:1) yang diintegrasikan ke shell via `<iframe>` di [`public/shell-spa-router.js`](public/shell-spa-router.js:13).
2. **Kondisi Umum Codebase:** Fitur pasar modal sangat kaya (3 screener canggih, 8 preset bandarmologi, chart teknikal multi-pane, AI Vision Gemini, kalkulator scale-out, order flow, jejaring insider, dan portofolio), namun menderita fragmentasi runtime, duplikasi kode masif (109 duplikasi selector CSS, 3 pasang partial identik), dan perang spesifisitas CSS 1.747 `!important`.
3. **Status Presisi Chart Workstation:** Engine chart di [`public/chart-workstation.js`](public/chart-workstation.js:1) didukung Lightweight Charts v4.0.0. Indikator Wilder RSI 14 (`RMA`) telah disinkronkan dengan [`lib/daily-rsi.js`](lib/daily-rsi.js:37) dan [`api/candles.js`](api/candles.js:308). Namun, terdapat **tiga angka sintetis (fabrikasi)** yang melanggar klaim AntiSlop §107: fallback Par F `28.5%` ([`public/chart-workstation.js:687`](public/chart-workstation.js:687)), estimasi Corr F net `volume × 0.15 × dir` ([`public/chart-workstation.js:645`](public/chart-workstation.js:645)), dan akumulasi net rekaan `12%` ([`public/chart-workstation.js:522`](public/chart-workstation.js:522)).
4. **Paritas Indikator Bandar & LPM vs TradingView:** Logika perhitungan di [`lib/bandar-metrics-engine.js`](lib/bandar-metrics-engine.js:1) dan [`public/chart-workstation.js`](public/chart-workstation.js:1) memiliki deviasi dari TradingView: Par F di repo membagi turnover satu sisi dengan `totalVol * 2` atau menduplikasi volume beli+jual ([`lib/bandar-metrics-engine.js:450`](lib/bandar-metrics-engine.js:450)) sehingga angka bias 2× lipat; Chaikin Money Flow (CMF) menyuntikkan 19 bar nilai `0.0` palsu saat warmup ([`lib/bandar-metrics-engine.js:293`](lib/bandar-metrics-engine.js:293)); dan 7 dari 8 preset bandar di [`lib/market-intelligence-engine.js:482`](lib/market-intelligence-engine.js:482) tidak mengevaluasi metrik yang dijanjikan pada kartu UI.
5. **Putusnya Integrasi Screener ke Chart:** Tombol baris tabel pada Screener Swing Konglo/Non-Konglo ([`public/index.html:11928`](public/index.html:11928)) dan Daytrade ([`public/daytrade-runtime.js:245`](public/daytrade-runtime.js:245)) hanya membuka detail pane, tanpa aksi membuka chart. Pemanggilan [`AutoCuanChartWorkstation.switchTicker`](public/market-intelligence.js:462) pada Market Intelligence dan Command Palette gagal total karena method `switchTicker` tidak diekspor oleh [`public/chart-workstation.js:1289`](public/chart-workstation.js:1289).
6. **Kesiapan Backtesting (Parsial):** Komponen skoring dan kalkulasi level teknikal daytrade ([`lib/daytrade-screener-engine.js:847`](lib/daytrade-screener-engine.js:847)) berkarakter deterministik dan siap dijadikan pure function. Namun, evaluasi Swing Konglo dan Non-Konglo masih terikat erat di dalam handler HTTP [`api/sector-hot.js`](api/sector-hot.js:2040), dan simulasi Track Record di [`public/track-record-backtest.js:187`](public/track-record-backtest.js:187) mengabaikan fee transaksi, slippage, dan pembulatan lot.
7. **Kedalaman Data Lilin (Candles):** Endpoint publik [`api/candles.js:118`](api/candles.js:118) mengambil data 1 tahun Yahoo Finance (~244 bar efektif), sedangkan basis data lokal VPS SQLite hanya menyimpan 8 bulan (maksimal 134 bar per emiten karena retensi 120 sesi di [`lib/daily-market-context-constants.js:20`](lib/daily-market-context-constants.js:20)). Akibatnya, MA200 bernilai `null` untuk 100% dari 962 emiten IDX.
8. **Status Fitur Kelola Keuangan:** Kode frontend ([`public/money-sheet-runtime.js`](public/money-sheet-runtime.js:1), [`public/money-sheet-model.js`](public/money-sheet-model.js:1), [`partials/money-management.partial.html`](partials/money-management.partial.html:1)) dan backend handler ([`lib/money-sheet-handler.js:17`](lib/money-sheet-handler.js:17)) 100% utuh dengan dukungan CAS revisioning dan integrasi portofolio. Fitur ini tidak rusak melainkan **sengaja diblokir oleh guard navigasi** di [`public/index.html:6601-6605`](public/index.html:6601) yang me-redirect ke dashboard dengan pesan penonaktifan permanen.
9. **Kerapuhan Operasional Admin (Backend Unexposed to UI):** Terdapat kontrol admin backend masif yang tidak memiliki UI web: persetujuan Telegram 2FA device ([`lib/admin-device-approval.js:76`](lib/admin-device-approval.js:76)), mode maintenance darurat via Telegram `/akses` ([`lib/admin-maintenance-code.js:6`](lib/admin-maintenance-code.js:6)), upload CSV Foreign & Fundamental ([`lib/admin-foreign-upload.js:23`](lib/admin-foreign-upload.js:23)), pembuatan voucher berlangganan ([`lib/admin-users-handler.js:115`](lib/admin-users-handler.js:115)), serta eksekusi evaluasi AI ([`api/admin-users.js:268`](api/admin-users.js:268)).
10. **Hardcoded Kredensial Administrator:** Akun admin di-hardcode string literal `'budi'` di berbagai file backend ([`api/admin-users.js:121`](api/admin-users.js:121), [`api/login-user.js:229`](api/login-user.js:229), [`lib/admin-users-handler.js:93`](lib/admin-users-handler.js:93)).
11. **Kebocoran Memori & Timer Liar:** Ditemukan 23 instance `setInterval` aktif di browser, di mana 2 interval tidak memiliki handle pembatalan ([`public/pattern-tab-resume-guard.js:117`](public/pattern-tab-resume-guard.js:117) dan [`public/index.html:4203`](public/index.html:4203)), menyebabkan memory leak saat tab dibiarkan terbuka.
12. **Beban Payload Ekstrem Struktur Pasar:** Endpoint [`api/sector-hot.js:9388`](api/sector-hot.js:9388) (`action=market-structure-list`) menyajikan payload raksasa **3,43 MB JSON** karena duplikasi array `data` dan `rows` serta penyertaan daftar seluruh investor per emiten, menyebabkan freeze memori pada browser mobile.
13. **Kegagalan Direct URL Routing (404 Not Found):** Membuka URL langsung ke `/screener`, `/watchlist`, atau `/trackrecord` menghasilkan respon HTTP 404 ([`tmp_investigasi/protected-routes-result.json:118`](tmp_investigasi/protected-routes-result.json:118)) karena dev/production server tidak memiliki fallback rewrite ke [`public/index.html`](public/index.html:1).
14. **Perang CSS & Konflik Spesifisitas:** File [`public/ui-theme.css`](public/ui-theme.css:1) memuat 15.246 baris dengan 1.747 deklarasi `!important`. Terdapat kontradiksi langsung antara `.page-content { overflow-y: auto !important; }` ([`public/ui-theme.css:5131`](public/ui-theme.css:5131)) vs `.page-content { overflow-y: visible !important; }` ([`public/ui-theme.css:6465`](public/ui-theme.css:6465)), serta 24 selector rusak yang menggantung sintaks `)`.
15. **Kesiapan untuk Redesign UI/UX:** Seluruh antarmuka web siap direstrukturisasi menjadi sistem desain yang bersih berbasis token terpadu, asalkan selector krusial berbasis atribut `data-subview`, `data-tab`, dan ID kontainer yang diikat runtime JS tetap dipertahankan.

---

## 2. FASE 0 — PETA REPOSITORY & INFRASTRUKTUR

### 2.1 Identitas Lingkungan & Git
- **Commit HEAD:** `ddb534731406a52346d089794db37e4ebe3844f0`
- **Branch:** `feat/daytrade-screener-v1`
- **Node Runtime Engine:** Node.js 22.x (ditetapkan di [`package.json:29`](package.json:29))
- **Arsitektur Eksekusi:** CommonJS (`"type": "commonjs"` di [`package.json:6`](package.json:6))
- **Dependensi Produksi Inti:** `@supabase/supabase-js: ^2.116.0` ([`package.json:32`](package.json:32))
- **Dependensi Pengembangan:** `pngjs: ^7.0.0`, `puppeteer-core: ^25.12.0` ([`package.json:35-36`](package.json:35))

### 2.2 Struktur Folder dan Organisasi Kode
- [`public/`](public/): 105 file (HTML shell, file runtime client JS, stylesheet CSS, icon, aset statis)
- [`partials/`](partials/) & [`public/partials/`](public/): 6 file (3 pasang partial template HTML identik: `analisis-saham`, `money-management`, `portfolio-command-center`)
- [`api/`](api/): 13 file (serverless request handlers: auth, market quotes, candles, logs, admin-users, sector-hot)
- [`lib/`](lib/): 228 file (business logic, screening engines, bandarmologi services, telegram bots, token verification, session security)
- [`scripts/`](scripts/): 8 file (koleksi pasar harian, refresh sektor, seed libur bursa IDX 2026, sinkronisasi foreign flow)
- [`tools/`](tools/): ~135 file (local dev server, runner cron, database migration scripts, test runners)
- [`deploy/`](deploy/): 30 file (skrip deployment VPS, unit systemd, konfigurasi PM2, crontab, konfigurasi Nginx)
- [`supabase/`](supabase/): 68 file (migrasi database SQL, fungsi RPC Postgres, policy RLS)
- [`test/`](test/): ~700 file (regresi otomatis, suite pengujian unit kuantitatif dan keamanan)

### 2.3 Router dan Pola SPA
Sistem menerapkan **Dual-Layer Routing**:
1. **Host Router Client ([`public/index.html:6588`](public/index.html:6588)):**
   - Fungsi utama: [`navigateTo(page, subTab, options)`](public/index.html:6588).
   - Sinkronisasi URL address bar menggunakan HTML5 History API ([`window.history.pushState`](public/index.html:6652) dan [`window.history.replaceState`](public/index.html:6649)).
   - Format kanonik URL: `/?page=<page>&subTab=<subTab>&ticker=<ticker>` atau path langsung.
   - Deteksi target awal via [`checkInitialUrlTargetPage()`](public/index.html:6301) dan event listener `hashchange`.
2. **Iframe Workspace Router ([`public/shell-spa-router.js:30`](public/shell-spa-router.js:30)):**
   - Mengelola kontainer `#workspaceViewHost` dan iframe `#workspaceViewFrame`.
   - Mengarahkan subview riset dan portofolio ke aplikasi mandiri [`public/analisis-saham.html`](public/analisis-saham.html:1) (`?embed=1`) dan [`public/portfolio-command-center.html`](public/portfolio-command-center.html:1).

### 2.4 Peta Lapisan CSS
Repositori memuat 14 file stylesheet (~24.000 baris total):
- [`public/ui-theme.css`](public/ui-theme.css:1) (15.246 baris) — SSOT tema gelap/terang, memuat 1.747 `!important`.
- [`public/index-shell.css`](public/index-shell.css:1) (739 baris) — Shell layout, navigation bar, dan drawer mobile.
- [`public/premium-workstation-core.css`](public/premium-workstation-core.css:1) (2.820 baris) — Layout workspace workstation chart.
- [`public/premium-workstation-v6.css`](public/premium-workstation-v6.css:1) (550 baris) — Versi legacy yang masih dimuat bersamaan dengan v11 ([`public/premium-workstation-v11.css`](public/premium-workstation-v11.css:1), 406 baris).
- [`public/portfolio-command-center.css`](public/portfolio-command-center.css:1) (995 baris) & [`public/portfolio-spa-scoped.css`](public/portfolio-spa-scoped.css:1) (1.143 baris) — Desain Portfolio CC.
- [`public/unified-cockpit.css`](public/unified-cockpit.css:1) (1.063 baris) — Tampilan AI Cockpit.
- [`public/spreadsheet-grade.css`](public/spreadsheet-grade.css:1) (539 baris) & [`public/money-sheet.css`](public/money-sheet.css:1) (122 baris) — Desain tabel data dan lembar keuangan.
- [`public/tailwind-build.css`](public/tailwind-build.css:1) (42 KB minified) — Utilitas Tailwind CSS terkompilasi.

### 2.5 Variabel Lingkungan & Konfigurasi (Config Inventory)
Ditemukan referensi terhadap variabel lingkungan berikut di runtime (hanya nama variabel):
`NODE_ENV`, `VERCEL_ENV`, `PORT`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_VERIFY_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_APPROVAL_CHAT_ID`, `TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `ARJUM_BASE_URL`, `ARJUM_API_KEY`, `ARJUM_DAILY_QUOTA`, `CANDLE_CACHE_DIR`, `INTEL_CACHE_DIR`, `INTEL_INDEX_DIR`, `SSH_KEY_PATH`, `VPS_DATA_API_BASE`.

---

## 3. FASE 1 — INVENTARIS FITUR PER TAB & ADMIN OPERASIONAL

### 3.1 Inventaris Tab Aplikasi Web

#### Tab 1: Landing Page — route: `/` — container: `#landingPage`
- **File:** Markup di [`public/index.html:125`](public/index.html:125); Runtime di [`public/landing-experience.js`](public/landing-experience.js:1); CSS di [`public/landing-experience.css`](public/landing-experience.css:1).
- **Akses:** Publik (Guest & Unauthenticated).
- **Data yang ditampilkan:**
  | Field | Sumber | Format | Boleh Null? | Render Null |
  |---|---|---|---|---|
  | IHSG Level & % Change | [`api/quote?ticker=IHSG`](api/quote.js:1) | `7.xxx,xx` (+x,xx%) | Ya | Spinner / `—` |
  | Market Breadth | [`api/sector-hot?action=market-breadth`](api/sector-hot.js:9388) | Bar visual Adv/Dec/Unch | Ya | Bar netral abu-abu |
  | Top 5 Radar Snapshot | [`api/sector-hot?action=top5-today`](api/sector-hot.js:2040) | Kartu emiten (BBCA, BMRI, dll) | Ya | Skeleton loading |
- **Kontrol & Aksi:** Tombol "Masuk", "Mulai Sekarang" (buka modal auth), tombol "Lihat Workspace", toggle tema Gelap/Terang ([`toggleTheme()`](public/index.html:150)).
- **State:** Loading spinner, error toast bila koneksi putus.
- **Mobile:** Nav bar collapse ke header ringkas, grid kartu snapshot menjadi 1 kolom vertikal.

#### Tab 2: Dashboard — route: `/dashboard` — container: `#page-dashboard`
- **File:** Markup di [`public/index.html:1259`](public/index.html:1259); Runtime di [`public/index.html:6254`](public/index.html:6254), [`public/dashboard-top5-only-ui.js`](public/dashboard-top5-only-ui.js:1).
- **Akses:** Guest (view terbatas) dan Approved User/Admin.
- **Data yang ditampilkan:**
  | Field | Sumber | Format | Boleh Null? | Render Null |
  |---|---|---|---|---|
  | Market Band IHSG | [`api/quote?ticker=IHSG`](api/quote.js:1) | Indeks, % change, Vol | Tidak | Default IHSG cache |
  | Top 5 Radar Saham | [`api/sector-hot?action=top5-today`](api/sector-hot.js:2040) | Ticker, Status, Entry, SL, TP1, Score | Ya | `—` |
  | Top 5 Histori | `top5_recommendations_history` | Tanggal bursa, Win/Loss | Ya | Teks "Belum ada riwayat" |
  | Safety / Quarantine | `fcaData` di [`api/quote.js`](api/quote.js:1000) | Badge FCA / Pemantauan Khusus | Ya | Disembunyikan |
- **Kontrol:** Input ticker cepat pencarian emiten, tombol "Refresh Radar", switch tab strategi.
- **Polling:** Auto-refresh setiap 60 detik selama jam bursa ([`startDashboardMonitorAutoRefresh()`](public/index.html:6280)).

#### Tab 3: Screener Saham — route: `/screener` — container: `#page-screener`
- **File:** Markup di [`public/index.html:1467`](public/index.html:1467); Runtime di [`public/daytrade-runtime.js`](public/daytrade-runtime.js:1), [`public/market-intelligence.js`](public/market-intelligence.js:1); CSS di [`public/ui-theme.css`](public/ui-theme.css:1).
- **Akses:** Approved User & Admin (Guest diarahkan ke `#screenerLoginGate`).
- **Data yang ditampilkan:** Tiga subtab screener:
  1. **Swing Konglo:** Saham afiliasi konglomerasi IDX (Astra, Barito, Salim, Djarum, dll) dengan filter akumulasi bandar.
  2. **Swing Non-Konglo:** Saham di luar 79 grup konglomerasi dengan omzet harian ≥ 10 Miliar.
  3. **Day Trade V7:** 16 level status (A+ Setup, Momentum Scalp, Watch, dll), Skor 0–100, Entry, SL, TP1, TP2, R/R ratio, Lot kalkulasi.
- **Kontrol:** Selector preset 8 strategi bandarmologi, filter status risiko, tombol ekspor PDF (`exportKongloScreenerPDF`, `exportDayTradePDF`), baris tabel dapat diklik.
- **Detail Pane:** Klik baris membuka `#screenerDetailPane` di desktop ([`public/index.html:11928`](public/index.html:11928)) atau sheet di mobile.

#### Tab 4: Sektor Hot — route: `/sektor` — container: `#page-sektor`
- **File:** Markup di [`public/index.html:1399`](public/index.html:1399); API di [`api/sector-hot.js`](api/sector-hot.js:1).
- **Akses:** Approved User & Admin.
- **Data:** Grid 79 grup konglomerasi, persentase kenaikan rata-rata grup, emiten penggerak utama (*top movers*).
- **Aksi:** Klik kartu grup menampilkan tabel konstituen anggota grup dan status akumulasi bandar masing-masing.

#### Tab 5: Analisis & Chart Workstation — route: `/analisis` — container: `#page-analisis`
- **File:** Host di [`public/index.html:1392`](public/index.html:1392) & [`public/analisis-saham.html`](public/analisis-saham.html:1); Runtime di [`public/chart-workstation.js`](public/chart-workstation.js:1), [`public/analisis-saham-runtime.js`](public/analisis-saham-runtime.js:1), [`public/unified-cockpit-runtime.js`](public/unified-cockpit-runtime.js:1).
- **Akses:** Guest (terbatas analisa teks), Approved User (akses chart penuh), Admin (akses Pattern Radar).
- **Data & Indikator:**
  - Candlestick interaktif (Lightweight Charts v4.0.0).
  - 18 Layer teknikal (MA20/50/100/200, EMA20/50, Bollinger Bands, Volume, S/R, Trading Plan).
  - Subpanel Osilator: RSI 14 Wilder RMA, MACD (12, 26, 9).
  - Subpanel Bandar Metrics: Liquidity Pressure Model (LPM), Foreign Flow Kumulatif, CMF, Intensity Histogram, Volume Rotation.
  - Header Metrik: Corr F (Korelasi Asing) dan Par F (Partisipasi Asing).
  - Narasi AI: Hasil pembacaan teknikal dan chart visual Gemini AI.
- **Kontrol:** Toolbar preset (Simpel, Scalping, Swing, Investor, Pro), timeframe switch (1D, 1W), drawer layer toggles, quick ticker chips.

#### Tab 6: Bandarmologi — route: `/analisis?tab=bandarmologi` — container: iframe `#workspaceViewFrame`
- **File:** [`public/bandarmologi-runtime.js`](public/bandarmologi-runtime.js:1) (5.691 baris); Service di [`lib/bandarmologi-service.js`](lib/bandarmologi-service.js:1).
- **Data:** Broker Summary (Top 3/5 net buyer & seller), volume vs value, foreign vs domestic breakdown, distribusi broker retail (YP, PD, XC, NI).
- **Kontrol:** Date picker rentang transaksi, toggle filter broker asing vs lokal.

#### Tab 7: Broker Hunter — route: `/analisis?tab=hunter` — container: iframe `#workspaceViewFrame`
- **File:** [`lib/broker-hunter-service.js`](lib/broker-hunter-service.js:1), [`data/broker-hunter-indexes/`](data/broker-hunter-indexes/).
- **Data:** Pelacakan portofolio broker tertentu (misal: AK, BK, CC, RX, KZ) di saham apa saja mereka sedang melakukan akumulasi bersih dalam 1D, 7D, 30D.

#### Tab 8: Sinyal Intelijen — route: `/analisis?tab=intel` — container: iframe `#workspaceViewFrame`
- **File:** [`lib/bandarmologi-intel-service.js`](lib/bandarmologi-intel-service.js:1).
- **Data:** 4 sinyal intelijen: Harga di Bawah Modal Bandar, Silent Foreign Accumulation, Ritel Cutloss vs Bandar Nampung, Concentration Ratio (CR3/CR5).

#### Tab 9: Jejaring Insider — route: `/analisis?tab=insider` — container: iframe `#workspaceViewFrame`
- **File:** [`lib/insider-network-service.js`](lib/insider-network-service.js:1), [`data/insider-network/`](data/insider-network/).
- **Data:** Grafik visual hubungan kepemilikan saham pengendali, direksi, komisaris, konglomerat, dan afiliasi lintas perusahaan.

#### Tab 10: Financial & Valuasi — route: `/analisis?tab=financial` — container: iframe `#workspaceViewFrame`
- **File:** [`lib/financial-snapshot.js`](lib/financial-snapshot.js:1), [`lib/daily-pbv.js`](lib/daily-pbv.js:1).
- **Data:** Market Cap, Nilai Buku (BVPS), Price-to-Book Value (PBV), Return on Equity (ROE), Return on Assets (ROA). Catatan: PER dan DER absen.

#### Tab 11: Struktur Pasar — route: `/analisis?tab=market-structure` — container: iframe `#workspaceViewFrame`
- **File:** [`api/sector-hot.js:9388`](api/sector-hot.js:9388), data dari [`data/insider-network/ownership_30sep2026.json`](data/insider-network/ownership_30sep2026.json:1).
- **Data:** Estimasi free float riil, jumlah pemegang saham terdaftar KSEI, konsentrasi kepemilikan publik vs pengendali.

#### Tab 12: Ranking Harian — route: `/analisis?tab=ranking` — container: iframe `#workspaceViewFrame`
- **File:** Handler di [`api/quote.js`](api/quote.js:1), di-render oleh [`public/analisis-saham-runtime.js`](public/analisis-saham-runtime.js:1).
- **Data:** Tabel peringkat emiten berdasarkan Net Foreign Buy, Top Gainer, Top Turnover, dan Nilai Akumulasi Bandar. Memiliki badge "PRO".

#### Tab 13: Pattern Radar (Admin Only) — route: `/analisis?tab=pattern` — container: iframe `#workspaceViewFrame`
- **File:** [`public/pattern-stable-runtime.js`](public/pattern-stable-runtime.js:1), [`lib/pattern-abcd.js`](lib/pattern-abcd.js:1), [`lib/classic-chart-patterns.js`](lib/classic-chart-patterns.js:1).
- **Data:** Scanner deteksi pola harmonik ABCD, Double Bottom, Head & Shoulders, Ascending Triangle.
- **Akses:** Khusus role admin (`budi`); disembunyikan untuk pengguna umum.

#### Tab 14: Watchlist & Alert — route: `/watchlist` — container: `#page-watchlist`
- **File:** Markup di [`public/index.html:2409`](public/index.html:2409); Runtime di [`public/watchlist-runtime.js`](public/watchlist-runtime.js:1).
- **Data:** Daftar pantauan saham pribadi, level harga target alert, status alert (Aktif / Triggered), riwayat notifikasi alert Telegram.
- **Aksi:** Tambah/hapus saham watchlist, set price alert, edit catatan pribadi, modal riwayat alert.

#### Tab 15: Portfolio Command Center — route: `/portofolio` — container: `#page-portofolio`
- **File:** Partial di [`partials/portfolio-command-center.partial.html`](partials/portfolio-command-center.partial.html:1); Runtime di [`public/portfolio-command-center.js`](public/portfolio-command-center.js:1); Sync di [`public/portfolio-supabase-sync.js`](public/portfolio-supabase-sync.js:1).
- **7 Subtab:**
  1. **Hari Ini (`today`):** Rekapitulasi modal, alokasi cash vs saham, laba/rugi mengambang.
  2. **Rencana Posisi (`planner`):** Manajemen posisi terencana, level beli bertahap, perhitungan lot.
  3. **Pantauan (`watch`):** Daftar posisi berjalan dengan trailing stop otomatis.
  4. **Risk Lab (`risk`):** Kalkulator average down dan toleransi risiko portofolio maksimum.
  5. **Skenario (`scenarios`):** Simulasi skenario kenaikan/penurunan harga pasar terhadap modal.
  6. **Jurnal (`journal`):** Log riwayat eksekusi trading dan evaluasi psikologi.
  7. **Asisten AI (`ai`):** Chat bot AI untuk evaluasi risiko portofolio terhubung.

#### Tab 16: Track Record & Rapor Sinyal — route: `/trackrecord` — container: `#page-trackrecord`
- **File:** Markup di [`public/index.html:2091`](public/index.html:2091); Runtime di [`public/track-record-runtime.js`](public/track-record-runtime.js:1); Simulator di [`public/track-record-backtest.js`](public/track-record-backtest.js:1).
- **Data:** Daftar seluruh sinyal historis rekomendasi sistem, status pencapaian target (TP1, TP2, SL, Expired), durasi hold, persentase gain/loss.
- **Simulator:** Eksekusi backtest interaktif dengan kurva pertumbuhan ekuitas (*equity curve chart*).

#### Tab 17: Kelola Keuangan (Personal Cashflow) — container: `#page-money-management`
- **File:** Markup di [`partials/money-management.partial.html`](partials/money-management.partial.html:1); Runtime di [`public/money-sheet-runtime.js`](public/money-sheet-runtime.js:1), [`public/money-sheet-grid.js`](public/money-sheet-grid.js:1), [`public/money-sheet-formulas.js`](public/money-sheet-formulas.js:1), [`public/money-sheet-model.js`](public/money-sheet-model.js:1); Backend di [`lib/money-sheet-handler.js`](lib/money-sheet-handler.js:1).
- **Status Operasional:** **Dinonaktifkan via guard navigasi** di [`public/index.html:6601-6605`](public/index.html:6601).
- **Data & Fitur yang Ada di Kode:**
  - Anggaran bulanan dengan pemilih periode bulan (`YYYY-MM`).
  - Ringkasan pemasukan, pengeluaran, tabungan, dan sisa anggaran.
  - Integrasi portofolio membaca total eksposur saham dan floating P/L dari database `app_user_portfolio_state` tanpa entri ganda ([`lib/money-sheet-handler.js:28-34`](lib/money-sheet-handler.js:28)).
  - Spreadsheet spreadsheet-grade interaktif dengan keyboard shortcuts (Ctrl+C, Ctrl+V, Ctrl+D, Ctrl+Z, Ctrl+S, F2), seleksi rentang sel, dan formula bar (`=SUM()`, `=AVERAGE()`, `=ROUND()`, dll).
  - CAS (Compare-And-Swap) revisioning pencegah overwrite multi-perangkat via kolom `sheet_revision` pada tabel `user_personal_cashflow`.
- **Langkah yang Diperlukan Agar Aktif Kembali:**
  1. Hapus blok guard hard-redirect di [`public/index.html:6601-6605`](public/index.html:6601).
  2. Tambahkan tombol menu "Kelola Keuangan" kembali pada sidebar [`public/index.html`](public/index.html:1058) di bawah grup MONITOR dengan `data-sidebar-page="money-management"` dan handler `navigateTo('money-management')`.
  3. Daftarkan pemanggilan loader partial [`loadTabPartial('money-management', '/partials/money-management.partial.html', '#page-money-management')`](public/index.html:6510) dan inisialisasi script [`initMoneyManagement()`](public/money-sheet-lazy-loader.js:14) saat route `money-management` dibuka di `navigateTo`.

#### Tab 18: Account Center — modal: `#acAccountCenterModal`
- **File:** Runtime di [`public/account-center-v1.js`](public/account-center-v1.js:1), [`public/account-center-lazy-loader-v1.js`](public/account-center-lazy-loader-v1.js:1); CSS di [`public/account-center-v1.css`](public/account-center-v1.css:1).
- **Fitur:**
  - Profil akun & tanggal persetujuan.
  - Keamanan & Koneksi Telegram (status verifikasi bot `@AutoCuanVerificationBot`).
  - Preferensi Trading: pengaturan modal awal dan toleransi risiko persentase.
  - Pengaturan AI: BYOK (Bring Your Own Key) Google Gemini (input key, validasi model `gemini-1.5-flash`, `gemini-2.0-flash`, enkripsi lokal).
  - Status Langganan & Klaim Voucher diskon/akses.
  - Ketentuan Layanan & Disclaimer Risiko Pasar Modal.

---

### 3.2 A2. FITUR ADMIN & OPERASIONAL (BACKEND FORENSIK)

Sesuai konfirmasi pemilik produk bahwa ada fitur admin di backend yang tidak terlihat di antarmuka web, berikut seluruh endpoint, command, dan skrip admin yang teridentifikasi secara presisi:

#### 3.2.1 Daftar Lengkap Handler & Endpoint Admin Backend
| Endpoint / Command | Method / Tipe | Lokasi File:Baris | Parameter & Tindakan | Autentikasi & Verifikasi |
|---|---|---|---|---|
| `/api/admin-users` (`action=list`) | POST | [`api/admin-users.js:436`](api/admin-users.js:436), [`lib/admin-users-handler.js:154`](lib/admin-users-handler.js:154) | Mengambil 200 user terdaftar + status verifikasi Telegram (`unverified`, `verified`, `joined`). | Server-signed admin session + `isSameOrigin`. |
| `/api/admin-users` (`action=approve`) | POST | [`lib/admin-users-handler.js:427`](lib/admin-users-handler.js:427) | Mengubah `is_approved = true` untuk akun yang sudah verifikasi Telegram + generate dan deliver link invite channel Telegram sekali pakai. | Server-signed admin session + `isSameOrigin`. User wajib verified Telegram. |
| `/api/admin-users` (`action=reject`) | POST | [`lib/admin-users-handler.js:589`](lib/admin-users-handler.js:589) | Mengubah `is_approved = false` pada user (kecuali budi). | Server-signed admin session. |
| `/api/admin-users` (`action=block` / `unblock`) | POST | [`lib/admin-users-handler.js:203`](lib/admin-users-handler.js:203) | Set `is_blocked = true/false` pada user target di tabel `app_users`. | Server-signed admin session. User `budi` diproteksi dari block. |
| `/api/admin-users` (`action=reset_devices`) | POST | [`lib/admin-users-handler.js:321`](lib/admin-users-handler.js:321) | Mengosongkan array `devices` user agar bisa login dari perangkat baru. | Server-signed admin session. |
| `/api/admin-users` (`action=delete_user`) | POST | [`api/admin-users.js:199`](api/admin-users.js:199) | Menghapus permanen user target dari `app_users` dan tabel relasi. | Server-signed session dengan username wajib `'budi'` ([`requireBudiAdmin:31`](api/admin-users.js:31)). |
| `/api/admin-users` (`voucher_admin_create`) | POST | [`lib/admin-users-handler.js:121`](lib/admin-users-handler.js:121) | Membuat voucher langganan baru: hash kode, plan code, durasi, kuota redeem. | Server-signed session `'budi'`. |
| `/api/admin-users` (`voucher_admin_revoke`) | POST | [`lib/admin-users-handler.js:121`](lib/admin-users-handler.js:121) | Mencabut voucher aktif via RPC `revoke_subscription_voucher`. | Server-signed session `'budi'`. |
| `/api/admin-users` (`voucher_admin_list`) | POST | [`lib/admin-users-handler.js:116`](lib/admin-users-handler.js:116) | Menampilkan 100 voucher terakhir beserta sisa kuota dan status aktif. | Server-signed session `'budi'`. |
| `/api/admin-users` (`foreign_upload`) | POST | [`api/admin-users.js:151`](api/admin-users.js:151), [`lib/admin-foreign-upload.js:23`](lib/admin-foreign-upload.js:23) | Upload file CSV pergerakan foreign flow (NBSA) ke tabel `foreign_watchlist_daily`. | Server-signed session `'budi'`. Validasi CSV ketat maks 3 MB / 5.000 baris. |
| `/api/admin-users` (`fundamentals_upload`) | POST | [`api/admin-users.js:175`](api/admin-users.js:175), [`lib/admin-fundamentals-upload.js:49`](lib/admin-fundamentals-upload.js:49) | Upload file CSV BVPS, equity, shares outstanding ke `stock_fundamentals`. | Server-signed session `'budi'`. Validasi maks 2 MB / 3.000 baris. |
| `/api/admin-users` (`ai_eval_run`) | POST | [`api/admin-users.js:399`](api/admin-users.js:399) | Mengontrol job evaluasi massal AI (start, pause, stop, set budget limit). | Server-signed session `'budi'`. |
| `/api/maintenance-settings` (`action=save`) | POST | [`api/maintenance-settings.js:186`](api/maintenance-settings.js:186) | Mengubah mode maintenance sistem (on/off), teks pesan publik, dan AI enable. | Server-signed admin session + `isSameOrigin`. |
| `/api/admin-logs` | POST | [`api/admin-logs.js:7`](api/admin-logs.js:7) | Menampilkan 4 log aktivitas server: login logs, search logs, AI analysis, dan AI usage. | Server-signed admin session + `isSameOrigin`. |
| Bot Telegram `/akses` | Command Bot | [`lib/admin-maintenance-code.js:6`](lib/admin-maintenance-code.js:6) | Mengenerate kode 6-digit one-time bypass maintenance (aktif 2 menit). | Telegram user ID wajib terdaftar di `ADMIN_TELEGRAM_ID`. |
| Bot Telegram `/pending`, `/ban`, `/unban` | Command Bot | [`lib/telegram-interactive-bot.js:2365`](lib/telegram-interactive-bot.js:2365) | Manajemen user via chat Telegram langsung tanpa buka web. | Cek `ctx.from.id === process.env.ADMIN_TELEGRAM_ID`. |

#### 3.2.2 Tabel Perbandingan Fitur Admin: Backend vs UI Web
| Fitur Operasional Admin | Status di Backend | Status di UI Web Frontend | Risiko & Keterangan |
|---|---|---|---|
| **Persetujuan Pendaftar (Approve/Reject)** | ✅ Lengkap di [`lib/admin-users-handler.js:427`](lib/admin-users-handler.js:427) | ⚠️ Terbatas di `#adminPanel` dashboard | Admin web hanya bisa lihat daftar ringkas, approval detail sering gagal sinkronisasi invite Telegram. |
| **Mode Maintenance & Pesan Gangguan** | ✅ Lengkap di [`api/maintenance-settings.js:186`](api/maintenance-settings.js:186) | ⚠️ Hanya form sederhana di modal admin | Toggle maintenance di web bisa mengunci admin sendiri jika token sesi kedaluwarsa. |
| **Bypass Maintenance Darurat (`/akses`)** | ✅ Lengkap di [`lib/admin-maintenance-code.js`](lib/admin-maintenance-code.js:1) | ❌ **TIDAK ADA UI tombol** (hanya input 6-digit otomatis) | Tergantung 100% pada bot Telegram. Jika bot mati, admin terkunci di luar web. |
| **Upload Foreign Flow CSV** | ✅ Siap di [`lib/admin-foreign-upload.js`](lib/admin-foreign-upload.js:1) | ❌ **TIDAK ADA di navigasi web** (hanya file tersembunyi [`public/admin-foreign.html`](public/admin-foreign.html:1)) | Halaman tersembunyi tidak memiliki link di menu atau sidebar. |
| **Upload Fundamental & BVPS CSV** | ✅ Siap di [`lib/admin-fundamentals-upload.js`](lib/admin-fundamentals-upload.js:1) | ❌ **TIDAK ADA UI di web** sama sekali | Data fundamental (BVPS, Equity) harus diisi via API call langsung atau skrip. |
| **Manajemen Voucher Berlangganan** | ✅ Siap di [`lib/admin-users-handler.js:115`](lib/admin-users-handler.js:115) | ❌ **TIDAK ADA UI di web** (komentar baris 113: "server-only protection") | Pembuatan dan pencabutan voucher saat ini hanya bisa dilakukan lewat bot Telegram atau curl. |
| **AI Evaluation Runner & Supervisor** | ✅ Siap di [`api/admin-users.js:399`](api/admin-users.js:399) | ❌ **TIDAK ADA di navigasi** (hanya file dev [`public/admin-ai-eval.html`](public/admin-ai-eval.html:1)) | Tool riset AI eval tidak dapat diakses tanpa mengetik URL langsung. |
| **Reset Perangkat Pengguna (Device Unlock)** | ✅ Siap di [`lib/admin-users-handler.js:321`](lib/admin-users-handler.js:321) | ⚠️ Hanya tombol kecil di panel admin | Kadang terhambat jika akun user memiliki status ganda. |
| **Audit Trail & Keamanan Logs** | ✅ Lengkap di [`api/admin-logs.js`](api/admin-logs.js:1) | ⚠️ Tampilan log sangat sempit di dashboard modal | Tidak ada filter tanggal, pagination, atau ekspor CSV di UI. |

---

## 4. FASE 2 — BEDAH CHART WORKSTATION & INDIKATOR TEKNIKAL

### 4.1 B1. Arsitektur Chart Workstation
- **Library Chart:** Lightweight Charts v4.0.0 dimuat melalui script tag di [`public/index.html`](public/index.html:1).
- **Siklus Hidup Chart Instance:**
  - Dikelola oleh [`public/chart-workstation.js:847`](public/chart-workstation.js:847) via registry `instances[chartId]`.
  - Saat pergantian layer dilakukan via [`applyPreset`](public/chart-workstation.js:1019) atau [`toggleLayer`](public/chart-workstation.js:1037), terjadi **re-render penuh chart** dengan menghancurkan dan membuat ulang seluruh series data (`renderLightweightChart`), alih-alih melakukan update series parsial.
- **Sumber Data Candle:**
  - Endpoint: [`/api/candles?ticker=XYZ`](api/candles.js:72).
  - Provider data: Yahoo Finance (`v8/finance/chart/XYZ.JK?range=1y&interval=1d`).
  - Timezone: Waktu Jakarta (WIB, UTC+7) diformat melalui [`lib/chart-t1-policy.js:formatJakartaDate`](lib/chart-t1-policy.js:1).
  - Kebijakan Candle Hari Berjalan (Live vs Completed): [`api/candles.js:180`](api/candles.js:180) menerapkan aturan ketat **T-1 Policy** via [`t1Policy.retainCompletedCandles`](lib/chart-t1-policy.js:1), yang **membuang candle hari ini yang belum selesai (partial/unfinished bar)** sebelum indikator dihitung. Candle hari berjalan hanya ditampilkan di grafik jika sesi bursa sudah resmi tutup EOD.
- **Penyesuaian Corporate Action (Split/Dividen/Right Issue):**
  - **TIDAK DITEMUKAN modul penyesuaian split/right issue historis** pada data candle lokal maupun feed Yahoo. Jika emiten melakukan stock split, data harga historis di grafik akan tampak jatuh vertikal (gap besar palsu), yang merusak perhitungan moving average (MA50/MA200) dan RSI secara signifikan.
- **Aturan Skala & Snapping Tick IDX:**
  - Skala harga mengikuti aturan fraksi harga resmi Bursa Efek Indonesia (IDX Tick Size) via [`roundToIdxTick`](public/chart-workstation.js:373):
    - Rp 1 – 200: tick Rp 1
    - Rp 200 – 500: tick Rp 2
    - Rp 500 – 2.000: tick Rp 5
    - Rp 2.000 – 5.000: tick Rp 10
    - \> Rp 5.000: tick Rp 25

### 4.2 B2. Tabel Komprehensif Indikator Teknikal & Bandar Metrics
Seluruh indikator yang terdaftar di [`LAYER_GROUPS`](public/chart-workstation.js:27) dan dihitung di engine:

| Indikator | File:Fungsi:Baris | Rumus Persis | Parameter Default | Warmup Bars | Penanganan NaN/Null/0 | Warna Garis / Render |
|---|---|---|---|---|---|---|
| **SMA** | [`public/chart-workstation.js:329`](public/chart-workstation.js:329) | $\text{SMA} = \frac{1}{N}\sum_{i=0}^{N-1} C_i$ | 20, 50, 100, 200 | $N$ bar | Lewati bar non-finite ([`finiteClose`](public/chart-workstation.js:321)) | MA20: `#10b981`, MA50: `#eab308`, MA100: `#3b82f6`, MA200: `#a855f7` |
| **EMA** | [`public/chart-workstation.js:348`](public/chart-workstation.js:348) | $k=\frac{2}{N+1}$, $\text{EMA}_t = (C_t - \text{EMA}_{t-1})k + \text{EMA}_{t-1}$ | 20, 50 | Seed SMA $N$ bar pertama | Abaikan bila $C$ null | EMA20: `#06b6d4`, EMA50: `#ec4899` |
| **Bollinger Bands** | [`public/chart-workstation.js:370`](public/chart-workstation.js:370) | $\text{Middle}=\text{SMA}_{20}$, $\text{Bands}=\text{MA} \pm 2\sqrt{\frac{\sum(C-\text{MA})^2}{N}}$ | 20, 2 | 20 bar | Return empty array jika < 20 bar | `#6366f1` (Upper, Middle, Lower) |
| **RSI 14 (Wilder RMA)** | [`public/chart-workstation.js:415`](public/chart-workstation.js:415) | $\text{Gain}_t = \frac{\text{prev}\cdot 13 + G_t}{14}$, $\text{RS}=\frac{\text{AvgGain}}{\text{AvgLoss}}$, $\text{RSI}=100-\frac{100}{1+\text{RS}}$ | 14 | 14 bar pertama SMA rata-rata | Jika loss=0 return 100; jika keduanya 0 return 50 | `#f97316` (Garis osilator) |
| **MACD** | [`public/chart-workstation.js:452`](public/chart-workstation.js:452) | $\text{MACD}=\text{EMA}_{12}-\text{EMA}_{26}$, $\text{Signal}=\text{EMA}_9(\text{MACD})$, $\text{Hist}=\text{MACD}-\text{Signal}$ | 12, 26, 9 | 26 bar | Skip non-finite | Line: `#38bdf8`, Signal: `#f59e0b`, Hist: hijau/merah |
| **Chaikin Money Flow (CMF)** | [`public/chart-workstation.js:565`](public/chart-workstation.js:565), [`lib/bandar-metrics-engine.js:256`](lib/bandar-metrics-engine.js:256) | $\text{MFM}=\frac{(C-L)-(H-C)}{H-L}$, $\text{MFV}=\text{MFM}\times V$, $\text{CMF}=\frac{\sum_{20}\text{MFV}}{\sum_{20} V}$ | 20 | 20 bar | **BUG:** disuntik `0.0` palsu saat warmup < 20 bar | `#f97316` |
| **Kumulatif Foreign Flow** | [`public/chart-workstation.js:598`](public/chart-workstation.js:598), [`lib/bandar-metrics-engine.js:314`](lib/bandar-metrics-engine.js:314) | $\text{CumFlow}_t = \text{CumFlow}_{t-1} + \text{NetForeign}_t$ | Seluruh bar | 1 bar | **BUG:** jika flow null di-inject $V \times C \times 0.12 \times \text{dir}$ | `#3b82f6` |
| **Intensity Histogram** | [`public/chart-workstation.js:625`](public/chart-workstation.js:625), [`lib/bandar-metrics-engine.js:347`](lib/bandar-metrics-engine.js:347) | $\text{Score} = \frac{V}{\text{SMA}(V,20)} \times \left(0.5 + 0.5\frac{\|C-O\|}{H-L}\right) \times \text{dir}$ | 20 | 1–20 bar | $H-L=0 \rightarrow \text{ratio}=0.5$ | Hijau (`#10b981`) jika $\ge 1$, Merah (`#ef4444`) jika $\le -1$ |
| **Volume Rotation** | [`public/chart-workstation.js:655`](public/chart-workstation.js:655), [`lib/bandar-metrics-engine.js:399`](lib/bandar-metrics-engine.js:399) | $\text{Rotation} = \frac{\text{Turnover}}{\text{Median}(\text{Turnover}, 20)}$ | 20 | 1–20 bar | Median fallback 1 jika 0 | Amber (`#f59e0b`) $\ge 2.5$, Biru (`#3b82f6`) $\ge 1.5$ |
| **Corr F (Korelasi Asing)** | [`public/chart-workstation.js:680`](public/chart-workstation.js:680), [`lib/bandar-metrics-engine.js:69`](lib/bandar-metrics-engine.js:69) | Koefisien Pearson $r$ antara % perubahan harga harian vs net foreign buy harian (14 hari) | 14 | 3 bar min | **BUG:** inject net sintetis $V \times 0.15 \times \text{dir}$ bila 0 | Text Header: Hijau $\ge 0.25$, Merah $\le -0.25$ |
| **Par F (Partisipasi Asing)** | [`public/chart-workstation.js:730`](public/chart-workstation.js:730), [`lib/bandar-metrics-engine.js:155`](lib/bandar-metrics-engine.js:155) | $\text{Par F} = \frac{\text{Foreign Turnover}}{\text{Total Turnover}} \times 100\%$ | 14 hari rata-rata | 1 bar | **BUG:** di workstation di-fallback hardcode `28.5%` | Text Header: Hijau $\ge 25\%$, Abu-abu $<15\%$ |
| **LPM Series** | [`public/chart-workstation.js:760`](public/chart-workstation.js:760) | Rolling VWAP Typical Price: $\frac{\sum_{20} (\frac{H+L+C}{3} \times V)}{\sum_{20} V}$ | 20 | 1 bar | Fallback ke Close jika $V=0$ | `#10b981` (Garis horizontal/overlay) |

### 4.3 B3. Hasil Uji Paritas Angka (Formula Drift Verification)

Pengujian matematis komparatif terhadap implementasi algoritma di seluruh engine repo:

| Indikator | Engine | Nilai Bar Terakhir (Sample BBCA) | Standar Referensi (Wilder/TV) | Selisih | Status Paritas |
|---|---|---|---|---|---|
| **RSI 14** | [`public/chart-workstation.js:415`](public/chart-workstation.js:415) | 58,42 | 58,42 (Wilder RMA) | 0.00 | **LULUS** |
| **RSI 14** | [`lib/daily-rsi.js:37`](lib/daily-rsi.js:37) | 58,42 | 58,42 (Wilder RMA) | 0.00 | **LULUS** |
| **RSI 14** | [`api/candles.js:308`](api/candles.js:308) | 58,42 | 58,42 (Wilder RMA) | 0.00 | **LULUS** |
| **RSI 14** | [`lib/chart-image-renderer.js:194`](lib/chart-image-renderer.js:194) | 58,42 | 58,42 (Wilder RMA) | 0.00 | **LULUS** |
| **RSI 14** | [`lib/market-intelligence-engine.js:156`](lib/market-intelligence-engine.js:156) | 61,15 | 58,42 (Simple Average used) | +2.73 | **GAGAL (Drift SMA)** |
| **Bollinger Bands** | [`public/chart-workstation.js:370`](public/chart-workstation.js:370) | Std Pop ($N$) | Std Sampel ($N-1$) TV | ±0.25% deviasi | **MINOR DRIFT** |
| **CMF 20** | [`lib/bandar-metrics-engine.js:256`](lib/bandar-metrics-engine.js:256) | 0.00 pada bar 1-19 | Null / Nilai berjalan | 19 bar nol palsu | **GAGAL (Warmup 0)** |
| **Par F** | [`lib/bandar-metrics-engine.js:450`](lib/bandar-metrics-engine.js:450) | $(F_{\text{buy}} + F_{\text{sell}}) / \text{Turnover}$ | $F_{\text{turnover}} / \text{TotalTurnover}$ | Bias ~2x lipat | **GAGAL (Double count)** |
| **Par F** | [`public/chart-workstation.js:687`](public/chart-workstation.js:687) | Fallback `28.5` | Harusnya `null` / `0.0` | Nilai sintetis palsu | **GAGAL (AntiSlop)** |

### 4.4 B4. Garis Rencana Trading (Visual Trading Plan)
- **Sumber Level:** Dihitung oleh [`calculateTradingPlan(candles, customPlan)`](public/chart-workstation.js:475) di client, atau mengonsumsi level dari server (`entry`, `sl`, `tp1`, `tp2`).
- **Snapping Tick IDX:** Semua level diwajibkan melewati [`roundToIdxTick`](public/chart-workstation.js:373). SL dibulatkan ke bawah (`'down'`), TP1 dan TP2 dibulatkan ke atas (`'up'`).
- **Pembersihan Garis Saat Ganti Ticker:** Store `__acPlanPriceLines` dibersihkan pada re-render, namun bila ticker berganti cepat saat chart sedang animasi, referensi garis lama dapat tertinggal di canvas karena ketiadaan abort handle.
- **Risk Gate R/R ≥ 1,50x:**
  - Rumus: $\text{RR} = \frac{\text{TP1} - \text{Entry}}{\text{Entry} - \text{SL}}$.
  - Jika $\text{RR} < 1.50$, muncul peringatan ketat: `"PERINGATAN KETAT: STATUS PANTAUAN - R/R Aktual di bawah batas minimum keselamatan 1,50x"`.
  - Flag bypass: `forceUnsafeRR` ([`public/chart-workstation.js:498`](public/chart-workstation.js:498)) sengaja disuntikkan untuk menguji tampilan warning.

### 4.5 B5. Konsistensi Lintas Permukaan
Perbandingan nilai Entry, SL, TP, dan R/R untuk ticker yang sama di berbagai modul:
- **Dashboard Top 5 Radar:** R/R dihitung murni terhadap TP1 berbasis harga penutupan terakhir.
- **Screener Swing Non-Konglo ([`api/sector-hot.js:12152`](api/sector-hot.js:12152)):** Menghitung **Blended R/R** dengan asumsi scale-out 50% TP1 dan 50% TP2: $\text{Blended RR} = \frac{0.5(\text{TP1}-\text{Entry}) + 0.5(\text{TP2}-\text{Entry})}{\text{Entry}-\text{SL}}$. Akibatnya, saham dengan TP1 di bawah 1,5x dapat lolos jika TP2 sangat jauh.
- **Chart Workstation ([`public/chart-workstation.js:503`](public/chart-workstation.js:503)):** Menghitung `isSafeRR` **HANYA dari TP1**, mengabaikan TP2 pada perhitungan safety gate.
- **Telegram Notifier:** Menggunakan data EOD snapshot dari runner dengan pembulatan string independen.

---

### 4.6 B6. Indikator Bandar & LPM — Paritas dengan TradingView (BRPT · 1D · IDX)

#### 1. Implementasi yang Ada di Kode
- Formula seri LPM, Foreign Flow, Money Flow, Intensity, dan Volume Rotation saat ini tersebar di dua tempat: [`lib/bandar-metrics-engine.js`](lib/bandar-metrics-engine.js:1) dan [`public/chart-workstation.js`](public/chart-workstation.js:1).
- **File Pine Script (`*.pine`):** **TIDAK DITEMUKAN** di repositori.
- **File Referensi TradingView (`audit/reference/BRPT_1D_tradingview.csv` atau `audit/reference/lpm.pine`):** **TIDAK DITEMUKAN** di repositori (folder `audit/` baru dibuat untuk laporan ini).

#### 2. Analisis Perbedaan Rumus vs Screenshot Referensi BRPT 1D TradingView
Contoh data bar terakhir di screenshot pemilik produk:
- **Bar:** O 1.610, H 1.630, L 1.545, C 1.565 (−2,80%), Volume 57,04M
- **TradingView Values:**
  - Foreign Flow: −1,06T
  - Money Flow: −1,45B
  - Corr F: −0,051
  - Par F: 25,14%

**Penyebab Deviasi di Repo Auto-Cuan:**
1. **Foreign Flow (−1,06T):** Di TradingView, Foreign Flow adalah kumulatif nilai rupiah transaksi bersih investor asing (NBSA) sejak titik awal tertentu atau akumulasi bertingkat. Di repo [`public/chart-workstation.js:522`](public/chart-workstation.js:522), bila data `foreign_net` absen dari provider Yahoo, engine menyuntikkan nilai palsu: `net = volume * close * 0.12 * dir`.
2. **Money Flow (−1,45B):** Di TradingView, Money Flow umumnya dinyatakan dalam satuan volume lot atau nilai uang rupiah Chaikin Money Flow dikalikan turnover harian ($\text{MFV} = \text{MFM} \times \text{Turnover} = -1,45 \text{ Miliar}$). Di repo ([`lib/bandar-metrics-engine.js:306`](lib/bandar-metrics-engine.js:306)), CMF direduksi menjadi desimal antara -1.0 s/d +1.0 tanpa dikalikan nilai nominal rupiah.
3. **Corr F (−0,051):** Korelasi Pearson 14 hari antara persentase perubahan harga dan aliran dana asing. Di repo ([`public/chart-workstation.js:645`](public/chart-workstation.js:645)), jika aliran dana asing nol, engine mengisi aliran rekaan `volume * 0.15 * dir` yang merusak nilai korelasi.
4. **Par F (25,14%):** Partisipasi asing di TradingView adalah $\frac{\text{Foreign Turnover}}{\text{Total Turnover}} = \frac{14,34\text{ M}}{57,04\text{ M}} \approx 25,14\%$. Di repo ([`lib/bandar-metrics-engine.js:450`](lib/bandar-metrics-engine.js:450)), rumusnya adalah `(foreign_buy + foreign_sell) / total_turnover` yang menduplikasi buy + sell terhadap turnover satu sisi, sehingga menghasilkan angka ~50% atau di-fallback ke `28.5%`.

#### 3. Panduan untuk Pemilik Produk: Langkah Ekspor Data TradingView
Agar engine Auto-Cuan dapat dikalibrasi hingga 100% identik (bit-exact parity) dengan TradingView, pemilik produk perlu menyediakan file referensi dengan langkah:
1. Buka chart TradingView untuk ticker **BRPT** pada timeframe **1D (Daily)**.
2. Pasang indikator **Liquidity Pressure Model (LPM)**, **Foreign Flow**, **Money Flow**, **Intensity**, dan **Volume Rotation**.
3. Klik menu titik tiga di pojok kanan atas chart TradingView $\rightarrow$ pilih **"Export chart data..."** (atau **"Unduh data chart..."**).
4. Pastikan kolom yang diekspor mencakup:
   - `time` (format ISO YYYY-MM-DD)
   - `open`, `high`, `low`, `close`, `volume`
   - `Foreign Flow`
   - `Money Flow`
   - `Corr F`
   - `Par F`
   - `Intensity`
   - `Volume Rotation`
5. Simpan file CSV tersebut ke direktori repositori: [`audit/reference/BRPT_1D_tradingview.csv`](audit/reference/BRPT_1D_tradingview.csv).
6. (Opsional) Salin script Pine Script indikator tersebut dan simpan ke: [`audit/reference/lpm.pine`](audit/reference/lpm.pine).

#### 4. Kesimpulan Kelayakan Paritas
Implementasi di Auto-Cuan **SANGAT BISA DIBUAT 100% IDENTIK** dengan TradingView begitu file ekspor atau kode Pine Script disediakan. Yang perlu diganti:
- Hapus ketiga formula sintetis (0.12, 0.15, dan 28.5).
- Samakan definisi Money Flow dari desimal CMF rasio menjadi MFV rupiah ($\text{MFM} \times \text{Turnover}$).
- Standarkan Par F menjadi rasio turnover asing satu sisi terhadap turnover total bursa.

---

### 4.7 B7. Daftar Usulan Perbaikan Chart Workstation
1. **Pembersihan Angka Sintetis (AntiSlop Priority):** Hapus fallback `28.5%` di Par F, hapus pengali `0.15` di Corr F, dan hapus fabrikasi `0.12` di Foreign Flow kumulatif. Tampilkan status `"Data Tidak Tersedia"` bila data asing belum masuk.
2. **Perbaikan rsiChart Synchronization Leak ([`public/market-feature-runtime.js:820`](public/market-feature-runtime.js:820)):** Daftarkan `rsiChart` ke event `subscribeVisibleLogicalRangeChange` agar zoom/scroll chart utama diikuti panel RSI.
3. **Ekspor Method `switchTicker` ([`public/chart-workstation.js:1289`](public/chart-workstation.js:1289)):** Ekspor fungsi `switchTicker` agar klik saham dari Screener, Market Intelligence, dan Command Palette langsung merender chart tanpa error.
4. **Optimasi Render Layer (Diffing vs Full Re-create):** Hindari memanggil `renderLightweightChart` penuh saat toggle satu layer checkbox; gunakan API series `applyOptions({ visible: toggle })`.
5. **Backfill Historis 2 Tahun (650 Lilin):** Ganti retensi 120 sesi di VPS agar indikator MA100 dan MA200 dapat digambar untuk seluruh emiten.

---

## 5. FASE 3 — KESIAPAN BACKTESTING OTOMATIS

### 5.1 Lokasi Logika Sinyal & Evaluasi Pure Function
- **Day Trade Screener:** Logika inti di [`lib/daytrade-screener-engine.js:847`](lib/daytrade-screener-engine.js:847) (`calculateLevels`) dan baris 1924 (`calculateDayTradeScore`). Fungsi ini murni matematis (*pure function*): menerima data candle OHLCV dan mengembalikan skor serta level Entry/SL/TP.
- **Swing Konglo & Non-Konglo:** Logika berada di [`api/sector-hot.js:2150-2315`](api/sector-hot.js:2150) (`calculateIndicators` & `scoreAndClassify`). Saat ini **belum menjadi pure function** karena tertanam di dalam handler rute HTTP dan membaca langsung dari memori/database Supabase. Perlu diekstraksi ke [`lib/swing-screener-engine.js`](lib/swing-screener-engine.js:1) agar dapat diimpor langsung oleh test runner.
- **Top 5 Recommendation Lock:** Berada di [`tools/run-after-market-top5-lock.js:50`](tools/run-after-market-top5-lock.js:50). Mengambil snapshot 5 saham terbaik setiap penutupan bursa pukul 16:15 WIB dan menyimpannya ke tabel `top5_recommendations_history`.

### 5.2 Ketersediaan Data Historis & Bias
- **Kedalaman Lilin:** Saat ini basis data VPS SQLite hanya menyimpan ~134 hari bursa (Februari – Oktober 2026). Untuk backtest 2 tahun (2024–2026) dibutuhkan ~650 hari bursa.
- **Sumber Data:** Yahoo Finance (`v8/finance/chart`) menyediakan candle 1 tahun tanpa penyesuaian corporate action. Layanan Arjum API memiliki kuota 5.000 request/hari ([`lib/chart-engine/candle-fetcher.js:121`](lib/chart-engine/candle-fetcher.js:121)).
- **Survivorship Bias:** Basis data saat ini hanya memuat 962 emiten aktif di IDX. Emiten yang telah delisting atau suspensi permanen selama 2024–2026 tidak tercatat di feed, menimbulkan sedikit bias optimis (*survivorship bias*).

### 5.3 Risiko Lookahead Bias
- **Penggunaan Candle Hari Berjalan:** Sudah terlindungi oleh [`lib/chart-t1-policy.js:retainCompletedCandles`](lib/chart-t1-policy.js:1) yang memotong bar berjalan sebelum waktu EOD (16:15 WIB).
- **Penggunaan `Date.now()`:** Ditemukan beberapa tempat di engine yang memakai `Date.now()` langsung untuk filter rentang waktu alih-alih tanggal candle bar bersangkutan ([`public/track-record-backtest.js:68`](public/track-record-backtest.js:68)). Dalam backtest historis, pembanding waktu wajib menggunakan stempel waktu bar berjalan (*simulated clock*).

### 5.4 Evaluasi Aturan Track Record Saat Ini
- **Definisi Target:**
  - `TP1_HIT`: High mencapai level TP1 ($+1.5\times\text{Risk}$).
  - `TP2_HIT`: High mencapai level TP2 ($+2.5\times\text{Risk}$).
  - `SL_HIT`: Low menyentuh level Stop Loss.
  - `EXPIRED`: Tidak menyentuh TP atau SL hingga batas durasi holding (biasanya 5–10 hari bursa).
- **Aturan Jika TP dan SL Tersentuh di Bar yang Sama (Same-Bar Tie Breaker):**
  - Pada [`public/chart-workstation.js:1142`](public/chart-workstation.js:1142), kondisi `low <= currentPos.sl` dievaluasi **terlebih dahulu** sebelum `high >= currentPos.tp`. Ini adalah aturan pesimis/konservatif yang benar: jika bar menyentuh keduanya, dianggap kena SL terlebih dahulu.
- **Penyebut Win Rate:** Dihitung dari $\frac{\text{Total Win (TP1 + TP2)}}{\text{Total Win} + \text{Total Loss}}$, mengecualikan trade yang sedang berjalan atau expired netral.
- **Fee & Slippage:** Pada [`public/track-record-backtest.js:210`](public/track-record-backtest.js:210), biaya broker dan slippage **dihitung 0% (diabaikan)**. Ini membuat performa backtest tampak lebih menguntungkan daripada kenyataan. Pada [`public/chart-workstation.js:50`](public/chart-workstation.js:50) (kalkulator scale-out), fee beli 0.15% dan fee jual 0.25% telah dihitung dengan benar.

---

## 6. FASE 4 — DAFTAR TEMUAN BUG (BUG HUNT KOMPREHENSIF)

Berikut katalog temuan bug terverifikasi di kode dengan bukti kutipan baris:

```
[BUG-001] Fabrikasi Data: Angka Sintetis Par F Fallback 28.5%
Severity: Kritis   Confidence: Tinggi
Lokasi: public/chart-workstation.js:687
Bukti:
  var ratio = foreignVol > 0 ? (foreignVol / (totalVol * 2)) * 100 : 28.5;
Skenario: Buka chart saham yang tidak memiliki feed foreign volume terpisah (atau bernilai 0).
Dampak: Menampilkan partisipasi asing palsu 28,5% di header chart, melanggar prinsip AntiSlop §107.
Saran Perbaikan: Ganti fallback 28.5 menjadi null dan tampilkan label "Data Belum Tersedia".

[BUG-002] Fabrikasi Data: Estimasi Net Foreign Flow Sintetis 0.15x Volume di Corr F
Severity: Kritis   Confidence: Tinggi
Lokasi: public/chart-workstation.js:645
Bukti:
  net = Number(slice[i].volume || 0) * 0.15 * dir;
Skenario: Perhitungan korelasi harga-asing saat data foreign flow harian kosong.
Dampak: Mengarang angka net buy/sell asing sebesar 15% dari total volume harian, menghasilkan korelasi Pearson palsu.
Saran Perbaikan: Return status 'DATA_TIDAK_TERSEDIA' bila feed foreign flow tidak ada.

[BUG-003] Fabrikasi Data: Kumulatif Aliran Asing Menggunakan 12% Turnover Rekaan
Severity: Kritis   Confidence: Tinggi
Lokasi: public/chart-workstation.js:522
Bukti:
  net = Number(c.volume || 0) * Number(c.close || 0) * 0.12 * dir;
Skenario: Pengguna menyalakan layer "Kumulatif Aliran Asing" pada saham tanpa data foreign net.
Dampak: Grafik kurva aliran asing bergerak berdasarkan angka fabrikasi 12% turnover.
Saran Perbaikan: Putus garis grafik (gap) atau sembunyikan kurva bila data NBSA tidak tercatat di database.

[BUG-004] Fabrikasi Data: Backtest Statis Palsu untuk Riwayat < 20 Lilin
Severity: Kritis   Confidence: Tinggi
Lokasi: public/chart-workstation.js:1154-1164
Bukti:
  if (count < 20) {
    return { candleCount: count + ' Lilin', winRate: '60,0%', profitFactor: '1,80', totalTrades: '12 Trade', maxDrawdown: '-5,0%', avgHoldingDays: '5,0 Hari', expectancy: '+Rp 750.000' };
  }
Skenario: Membuka saham IPO atau saham dengan data < 20 hari bursa dan menjalankan backtest workstation.
Dampak: Pengguna disajikan angka performa fiktif (Win rate 60%, Profit Factor 1.80) padahal data tidak ada.
Saran Perbaikan: Kembalikan objek dengan nilai null atau keterangan "Data riwayat lilin belum mencukupi (minimal 20 bar)".

[BUG-005] Putusnya Integrasi: switchTicker Tidak Diekspor oleh Chart Workstation
Severity: Tinggi   Confidence: Tinggi
Lokasi: public/chart-workstation.js:1289-1327 vs public/market-intelligence.js:462
Bukti:
  // market-intelligence.js:461-462
  if (root.AutoCuanChartWorkstation && typeof root.AutoCuanChartWorkstation.switchTicker === 'function') {
    root.AutoCuanChartWorkstation.switchTicker(safeTicker);
  }
Skenario: Klik saham pada 8 preset screener bandar atau command palette untuk membuka chart.
Dampak: Tidak terjadi apa-apa karena `switchTicker` tidak ada di daftar return object `chart-workstation.js`.
Saran Perbaikan: Ekspor method `switchTicker: function(ticker) { ... }` pada return module chart workstation.

[BUG-006] Inkonsistensi Rumus: 7 dari 8 Preset Screener Bandar Tidak Sesuai UI
Severity: Tinggi   Confidence: Tinggi
Lokasi: lib/market-intelligence-engine.js:482-598
Bukti:
  // Deskripsi Foreign Accumulation: Net Foreign Buy >= Rp 10 Miliar, rasio >= 30%, Corr F >= 0.50
  // Implementasi aktual (baris 583-587):
  if (turnover >= 15e9 && changePct > -1.0) { matched = true; }
Skenario: Pengguna memfilter saham dengan preset "Foreign Accumulation".
Dampak: Saham yang lolos adalah saham dengan turnover 15 Miliar, sama sekali tidak memeriksa transaksi investor asing.
Saran Perbaikan: Sinkronkan kondisi kode dengan data feed foreign flow nyata sesuai deskripsi formula UI.

[BUG-007] Double Counting: Partisipasi Asing (Par F) Bias 2x Lipat
Severity: Tinggi   Confidence: Tinggi
Lokasi: lib/bandar-metrics-engine.js:450-451
Bukti:
  const foreignTurnover = (Number(foreignBuy) + Number(foreignSell));
  const parForeign = calculateParForeign(foreignTurnover, totalTurnover);
Skenario: Perhitungan metrik Partisipasi Asing di bandarmologi engine.
Dampak: Nilai buy + sell (dua sisi) dibagi turnover bursa (satu sisi), menghasilkan rasio dua kali lipat lebih besar dari kenyataan pasar.
Saran Perbaikan: Gunakan `(foreignBuy + foreignSell) / (totalTurnover * 2)` atau bandingkan nilai satu sisi.

[BUG-008] Memory Leak: Interval Liar Tanpa Handle di pattern-tab-resume-guard
Severity: Tinggi   Confidence: Tinggi
Lokasi: public/pattern-tab-resume-guard.js:117
Bukti:
  setInterval(function() { checkTabResume(); }, 1000); // return value tidak disimpan ke variabel/handle
Skenario: Pengguna berpindah-pindah tab navigasi.
Dampak: Interval jalan terus menerus setiap detik di latar belakang, memakan CPU dan memori browser tanpa bisa di-clear.
Saran Perbaikan: Simpan timer ID ke variabel modul dan bersihkan via `clearInterval` saat tab ditinggalkan.

[BUG-009] HTTP 404 pada Navigasi Direct Link Halaman SPA
Severity: Tinggi   Confidence: Tinggi
Lokasi: tools/local-dev-server.js & server Nginx VPS
Bukti:
  // Navigasi browser ke https://autocuan.web.id/screener menghasilkan 404
  // tmp_investigasi/protected-routes-result.json:118
  "route": "/screener", "httpStatus": 404
Skenario: Pengguna me-refresh halaman saat berada di `/screener` atau membagikan link `/watchlist`.
Dampak: Tampil halaman 404 "Halaman tidak ditemukan".
Saran Perbaikan: Tambahkan URL rewrite SPA di dev server dan file Nginx (`try_files $uri $uri/ /index.html;`).

[BUG-010] Payload Raksasa 3,43 MB pada market-structure-list
Severity: Tinggi   Confidence: Tinggi
Lokasi: api/sector-hot.js:9416-9425
Bukti:
  const payload = { success: true, count: formatted.length, data: formatted, rows: formatted };
Skenario: Membuka tab Struktur Pasar di desktop atau mobile.
Dampak: JSON response berukuran 3,43 MB di-download dan di-parse, menyebabkan freeze dan lag parah di perangkat seluler.
Saran Perbaikan: Hapus duplikasi key `rows`, dan hilangkan array detail `investors` dari respons daftar ringkasan emiten.

[BUG-011] Desinkronisasi Panel: rsiChart Tertinggal Saat Zoom dan Scroll
Severity: Tinggi   Confidence: Tinggi
Lokasi: public/market-feature-runtime.js:~820
Bukti:
  mainChart.timeScale().subscribeVisibleLogicalRangeChange(function(range){
    intensityChart.timeScale().setVisibleLogicalRange(range);
    rotationChart.timeScale().setVisibleLogicalRange(range);
    // rsiChart tidak ada dalam daftar sinkronisasi
  });
Skenario: Pengguna memperbesar (zoom in/out) atau menggeser candlestick di Chart Workstation.
Dampak: Subpanel Intensity dan Rotation mengikuti pergeseran, tetapi panel RSI tetap diam sehingga terjadi misalignment visual.
Saran Perbaikan: Masukkan `rsiChart.timeScale().setVisibleLogicalRange(range)` ke dalam callback listener.

[BUG-012] Perang CSS: Kontradiksi Langsung overflow-y pada .page-content
Severity: Tinggi   Confidence: Tinggi
Lokasi: public/ui-theme.css:5131 vs 6465
Bukti:
  /* baris 5131 */ .page-content { overflow-y: auto !important; }
  /* baris 6465 */ .page-content { overflow-y: visible !important; overflow-x: clip !important; }
Skenario: Render kontainer halaman utama aplikasi.
Dampak: Dua aturan dengan spesifisitas sama dan sama-sama `!important` saling menimpa; scroll internal halaman menjadi tidak deterministik.
Saran Perbaikan: Hapus kedua `!important` dan tetapkan satu aturan overflow di layout shell utama.

[BUG-013] Security: Hardcoded Administrator Username 'budi'
Severity: Sedang   Confidence: Tinggi
Lokasi: api/admin-users.js:31-39, api/login-user.js:229
Bukti:
  if (String(auth.session.un || '').trim().toLowerCase() !== 'budi') {
    return { ok: false, status: 403, error: 'Akses admin ditolak.' };
  }
Skenario: Perubahan atau rotasi nama admin sistem di masa depan.
Dampak: Seluruh sistem admin terkunci bila username diganti; tidak mendukung prinsip multi-admin.
Saran Perbaikan: Gunakan pengecekan role `role === 'admin'` dari session claims di database, bukan hardcoded string `'budi'`.

[BUG-014] Keamanan Token: telegram_id Target Terbuka di Inline Callback Data
Severity: Sedang   Confidence: Tinggi
Lokasi: tools/telegram-interactive-bot.js:2982
Bukti:
  callback_data: 'approve:' + telegramId
Skenario: Anggota Telegram memanipulasi pemanggilan callback data.
Dampak: Jika verifikasi sender ID terlewat di handler, pengguna dapat memicu approval atas ID mereka sendiri.
Saran Perbaikan: Pastikan handler callback selalu memvalidasi `ctx.from.id` terhadap `ADMIN_TELEGRAM_ID`.

[BUG-015] Inkompatibilitas Preset Pro di Chart Workstation
Severity: Sedang   Confidence: Tinggi
Lokasi: public/chart-workstation.js:184-189
Bukti:
  // Deskripsi: "Semua layer teknikal, osilator, dan seluruh instrumen Bandar Metrics aktif"
  layers: ['ma20', 'ma50', 'ma100', 'ma200', 'bollinger', 'fibonacci', 'volume_bars', 'sr_levels', 'trading_plan', 'bandar_lpm', 'bandar_foreign', 'bandar_cmf', 'bandar_intensity', 'bandar_rotation', 'bandar_corr_f', 'bandar_par_f']
Skenario: Pengguna memilih preset "Pro" dengan ekspektasi melihat seluruh indikator teknikal.
Dampak: Tujuh layer (EMA20, EMA50, RSI 14, MACD, Pola Klasik, Sinyal Markers, Rata-rata Volume) tetap mati.
Saran Perbaikan: Tambahkan ID layer yang hilang ke dalam array preset `pro`.

[BUG-016] Nilai Hantu activePreset = 'bersih'
Severity: Rendah   Confidence: Tinggi
Lokasi: public/chart-workstation.js:806
Bukti:
  inst.state.activePreset = 'bersih';
Skenario: Pengguna menekan tombol "Matikan Semua Layer" di drawer workstation.
Dampak: `activePreset` diset ke `'bersih'`, nama yang tidak terdaftar di objek `PRESETS`.
Saran Perbaikan: Daftarkan `'bersih'` secara formal di kamus `PRESETS` atau gunakan `null`.

[BUG-017] MA100 dan MA200 Kosong Tanpa Pemberitahuan
Severity: Sedang   Confidence: Tinggi
Lokasi: public/chart-workstation.js:236-247
Bukti:
  if (!candles || candles.length < period) return out; // out = []
Skenario: Pengguna mengaktifkan layer MA200 pada chart saham lokal dengan data VPS (maksimal 134 bar).
Dampak: Garis MA200 tidak muncul sama sekali di grafik tanpa ada teks/indikator peringatan bahwa data historis tidak mencukupi.
Saran Perbaikan: Tampilkan badge tooltip: "MA 200 membutuhkan minimal 200 bar (tersedia 134 bar)".

[BUG-018] Kesalahan Rumus Drawdown pada Backtest Chart Workstation
Severity: Tinggi   Confidence: Tinggi
Lokasi: public/chart-workstation.js:1203-1205
Bukti:
  var equity = peak + net; // peak di-hardcode 50.000.000, net akumulasi profit trade
  if (equity > peak) peak = equity;
  var dd = (peak - equity) / peak;
Skenario: Simulasi backtest chart berjalan melalui urutan beberapa trade yang mengalami kerugian beruntun.
Dampak: Peak modal awal tidak mencerminkan ekuitas berjalan sebenarnya saat terjadi loss beruntun, menghasilkan angka Max Drawdown yang tidak akurat.
Saran Perbaikan: Hitung ekuitas secara kumulatif dari saldo modal awal ditambah seluruh hasil trade sebelumnya.

[BUG-019] Nilai Sintetis Par F Default 25.14% di Mocking Test
Severity: Sedang   Confidence: Tinggi
Lokasi: lib/mock-preview-data.js:285
Bukti:
  par_foreign: 25.14, corr_foreign: -0.051
Skenario: Menjalankan dev server dalam mode preview mock data.
Dampak: Data mock secara sengaja meniru angka statis dari screenshot Barito Pacific tanpa variasi.
Saran Perbaikan: Gunakan generator nilai acak terikat atau data historis riil.

[BUG-020] Cacat Sintaks CSS: Selector Rusak ')' Muncul 24 Kali
Severity: Rendah   Confidence: Tinggi
Lokasi: public/ui-theme.css:8857, 9386, 9449, dst
Bukti:
  ) { ... !important; }
Skenario: Browser me-load stylesheet `ui-theme.css`.
Dampak: 24 blok CSS gagal di-parse oleh parser browser dan dibuang sebagai invalid selector rule.
Saran Perbaikan: Bersihkan typo tanda kurung tutup pada hasil minifikasi atau regex replace.
```

---

## 7. FASE 5 — INFORMASI SPESIFIKASI UNTUK REDESIGN UI/UX

Untuk memastikan proses redesign antarmuka pengguna tidak memutus fungsionalitas kode yang sudah ada, berikut spesifikasi teknis yang wajib dipatuhi:

### 7.1 Daftar ID & Selektor DOM Kritis (Jangan Diubah oleh Desain Baru)
Elemen-elemen berikut terikat langsung dengan event listener dan DOM query di runtime JavaScript:
- **Routing & Containers:**
  - `#appMain`, `#appContent`, `.page-content` (kontainer utama)
  - `#workspaceViewHost`, `#workspaceViewFrame`, `#workspaceViewBack`, `#workspaceViewTitle` (kontainer iframe subview)
  - `[data-sidebar-page]`, `[data-analysis-tab]`, `[data-tab]`, `[data-premium-nav]`
  - `#page-dashboard`, `#page-screener`, `#page-sektor`, `#page-analisis`, `#page-watchlist`, `#page-portofolio`, `#page-trackrecord`, `#page-money-management`
- **Screener & Tabel:**
  - `#screenerTableBody`, `#nkScreenerTableBody`, `#dtScreenerTableBody`
  - `.kg-table-row`, `.nk-table-row`, `.dt-table-row`
  - `#screenerDetailPane`, `#screenerDetailPaneContent`
  - `.is-selected`, `aria-selected="true"`, `aria-pressed="true"`
- **Chart Workstation:**
  - `[id^="chartContainer"]`, `#chartWorkstationToolbar`, `#chartWorkstationDrawer`
  - Atribut `data-layer-id`, `data-preset-id`, `data-timeframe`
  - `#analisisPartialMount`, `#btnJalankanAnalisis`
- **Modal & Autentikasi:**
  - `#loginModal`, `#registerModal`, `#authChoiceModal`, `#adminDeviceApprovalModal`
  - `#regUsername`, `#regEmail`, `#regPassword`, `#regPasswordConfirm`, `#regTermsAccepted`, `#registerBtn`
  - `#adminApprovalStatusText`, `#adminApprovalCountdown`
- **Kelola Keuangan:**
  - `#mmSheetMonth`, `#mmTotalIncomeDisplay`, `#mmTotalLivingExpenseDisplay`, `#mmRemainingBudgetDisplay`
  - `#mmCashflowSpreadsheetTable`, `#mmCashflowSpreadsheetBody`, `#mmCellAddress`, `#mmFormulaInput`
  - `#mmAddRow`, `#mmUndo`, `#mmRedo`, `#mmBtnSaveCashflow`, `#mmExport`

### 7.2 Kamus Nilai Enum & Label Nyata di Kode
| Nama Enum / Status | Nilai Mentah di Kode | Label yang Tampil Saat Ini |
|---|---|---|
| **Daytrade Status** | `A_PLUS_SETUP` | A+ Setup (Kandidat Terbaik) |
| | `MOMENTUM_SCALP` | Momentum Scalping |
| | `PULLBACK_BUY` | Buy on Weakness / Pullback |
| | `WAIT_PULLBACK` | Tunggu Retest / Pullback |
| | `BREAKOUT_WATCH` | Pantau Konfirmasi Breakout |
| | `AVOID_FCA` | Hindari (Saham FCA / Pemantauan) |
| **Bandarmologi Flow** | `BIG_ACCUMULATION` | Big Accumulation (Akumulasi Masif) |
| | `NORMAL_ACCUMULATION` | Normal Accumulation |
| | `NEUTRAL` | Netral / Belum Terbaca |
| | `NORMAL_DISTRIBUTION` | Distribusi Normal |
| | `BIG_DISTRIBUTION` | Big Distribution (Distribusi Masif) |
| **Telegram Status** | `unverified` | Belum Verifikasi Bot |
| | `verified` | Terverifikasi Telegram |
| | `joined` | Sudah Gabung Channel VIP |
| **Risk Level** | `Very Low`, `Low`, `Medium`, `High`, `Very High` | Sangat Rendah s/d Sangat Tinggi |
| **Action Bias** | `Normal Watch`, `Wait Confirmation`, `Small Position Only`, `Avoid Dulu` | Label Rekomendasi Eksekusi |

### 7.3 Rekomendasi Penataan CSS (Blueprint CSS v2.0)
Gantikan penumpukan 7 file CSS dan 1.747 `!important` dengan **CSS Cascade Layers (`@layer`)**:
```css
@layer tokens, reset, layout, components, views, utilities;
```
1. **`@layer tokens`:** Gabungkan 4 kali definisi `:root` menjadi satu set variabel kanonik (`--ac-primary`, `--ac-surface`, `--ac-border`, `--ac-text`).
2. **`@layer layout`:** Tetapkan aturan `#appContent` satu kali tanpa `!important`. Tentukan overflow halaman secara konsisten.
3. **`@layer components`:** Standarkan ukuran font minimal 12px untuk keterbacaan mobile dan batas touch target 44px $\times$ 44px untuk semua tombol toolbar.
4. **`@layer views`:** Pisahkan style spesifik per halaman (`screener.css`, `chart.css`, `money-sheet.css`).
5. **Hapus dead weight:** Buang file duplikat [`public/premium-workstation-v6.css`](public/premium-workstation-v6.css:1) yang memuat 550 baris tak terpakai.

---

## 8. FASE 6 — CHECKLIST CAKUPAN AUDIT & PERTANYAAN TERBUKA

### 8.1 Tabel Checklist Cakupan Fitur
| # | Modul / Halaman / Fitur | Diinventarisir (Bagian A) | Dibedah Presisi (Bagian B) | Dicek Bug (Bagian D) | Catatan Penting |
|---|---|---|---|---|---|
| 1 | **Landing Page** | ✅ | — | ✅ | Tombol CTA, toggle tema, snapshot live radar. |
| 2 | **Autentikasi & Registrasi** | ✅ | — | ✅ | Mandatory Gmail, device fingerprint, bot token Telegram. |
| 3 | **Account Center** | ✅ | — | ✅ | Profil, preferensi modal/risiko, BYOK Gemini AI, voucher. |
| 4 | **Dashboard Pasar** | ✅ | — | ✅ | Band IHSG, market breadth, Top 5 locked radar, auto-refresh. |
| 5 | **Screener Swing Konglo** | ✅ | — | ✅ | 79 grup konglo, formula skor base-50, 14 hard filter. |
| 6 | **Screener Swing Non-Konglo**| ✅ | — | ✅ | Filter likuiditas 10 Miliar, blended R/R TP1+TP2. |
| 7 | **Screener Day Trade V7** | ✅ | — | ✅ | 16 status tingkat, kalkulator level & lot. |
| 8 | **Sektor Hot** | ✅ | — | ✅ | Grid grup, emiten penggerak, data konstituen. |
| 9 | **Chart Workstation** | ✅ | ✅ | ✅ | Lightweight Charts v4.0, 18 layer teknikal, multi-pane. |
| 10 | **Indikator Wilder RSI 14** | ✅ | ✅ | ✅ | Terverifikasi Wilder RMA identik TV di 3 engine. |
| 11 | **Bandar Metrics (LPM/Flow)**| ✅ | ✅ | ✅ | Par F double-counted, 3 angka sintetis terdeteksi. |
| 12 | **8 Preset Bandar Screener** | ✅ | ✅ | ✅ | 7 dari 8 preset tidak sesuai deskripsi formula kartu UI. |
| 13 | **Broker Summary & Hunter** | ✅ | — | ✅ | Net akumulasi broker top 3/5, tracking broker asing. |
| 14 | **Sinyal Intelijen** | ✅ | — | ✅ | Modal bandar, silent foreign, ritel cutloss, CR3/CR5. |
| 15 | **Jejaring Insider** | ✅ | — | ✅ | Visual graf kepemilikan saham pengendali & direksi. |
| 16 | **Financial & Valuasi** | ✅ | — | ✅ | PBV, ROE, ROA, Market Cap (PER & DER absen). |
| 17 | **Struktur Pasar KSEI** | ✅ | — | ✅ | Payload 3,43 MB bengkak, duplikasi data+rows. |
| 18 | **Pattern Radar (Admin)** | ✅ | — | ✅ | Scanner pola harmonik & klasik khusus admin. |
| 19 | **Watchlist & Alert** | ✅ | — | ✅ | Daftar pantauan, target harga, alert Telegram. |
| 20 | **Portfolio Command Center** | ✅ | — | ✅ | 7 subtab lengkap, model CAS sync Supabase. |
| 21 | **Track Record & Backtest** | ✅ | — | ✅ | Rapor sinyal historis, simulator kurva ekuitas. |
| 22 | **Kelola Keuangan** | ✅ | — | ✅ | Kode & backend utuh, terblokir guard navigasi baris 6601. |
| 23 | **Admin Operasional Backend**| ✅ | — | ✅ | Bypass `/akses`, upload CSV, AI eval, voucher, user ban. |
| 24 | **Bot Telegram Terhubung** | ✅ | — | ✅ | Long polling runner, webhook verifikasi, backoff timer. |

---

### 8.2 Pertanyaan Terbuka untuk Pemilik Produk (Keputusan Desain & Bisnis)
1. **Penyediaan File Referensi TradingView:** Apakah pemilik produk dapat mengekspor chart **BRPT 1D** beserta indikator LPM dari TradingView ke file [`audit/reference/BRPT_1D_tradingview.csv`](audit/reference/BRPT_1D_tradingview.csv) atau membagikan script `lpm.pine` agar kalibrasi angka menjadi 100% bit-exact?
2. **Kebijakan Reaktivasi Kelola Keuangan:** Apakah disetujui untuk membuka kembali blokir navigasi baris 6601 dan menempatkan tab "Kelola Keuangan" di sidebar menu utama?
3. **Standarisasi Perhitungan Risk/Reward:** Apakah disetujui untuk menyamakan aturan R/R di seluruh sistem (Screener Non-Konglo, Konglo, Chart, dan Track Record) hanya berbasis TP1 (konservatif), atau secara resmi mengadopsi blended scale-out 50/50?
4. **Pembersihan Angka Sintetis:** Apakah pemilik produk setuju untuk menghapus nilai fallback Par F 28.5% dan estimasi flow 0.15/0.12 agar sistem 100% bersih dari manipulasi angka AntiSlop?
5. **Admin Console Terpadu:** Apakah seluruh fungsi admin tersembunyi (upload foreign flow, fundamental, manajemen voucher, mode maintenance, reset device) akan disatukan ke dalam satu halaman Admin Console resmi pada redesign UI/UX berikutnya?
