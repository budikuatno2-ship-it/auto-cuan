# LAPORAN PERBAIKAN KOMPREHENSIF GABUNGAN BATCH 2–5
**Proyek:** Auto-Cuan — Indonesian Stock Exchange (IDX) Radar & Screener Platform
**Repository:** `budikuatno2-ship-it/auto-cuan`
**Branch Integrasi:** `feat/daytrade-screener-v1`
**Baseline Terverifikasi:** Commit `f130a37b60e683d0dfe796ec0b4d1138104e7ddd` (Merge PR #862 / Batch 1)
**Branch Perbaikan:** `fix/audit-okt2026-batch-2-5`
**Waktu Penyelesaian:** Minggu, 11 Oktober 2026

---

## 1. RINGKASAN EKSEKUTIF

Seluruh paket perbaikan Audit Auto-Cuan Oktober 2026 untuk **Batch 2 (Financial Data Pipeline)**, **Batch 3 (Struktur Pasar dan Pemegang Saham)**, **Batch 4 (Track Record & Telegram Lifecycle)**, dan **Batch 5 (Perbaikan UI/UX Global)** telah diselesaikan secara berurutan dalam satu paket terpadu.

Semua safety gate Batch 1 (R/R >= 1.5, Provenance Fail-Closed, FastWatcher Protection, Market Hours Guard) tetap dipertahankan 100% tanpa regresi.

| Batch | Area | Prioritas | Status | Test Suite |
|---|---|---|---|---|
| **Batch 2** | Financial Data Pipeline (PBV, Market Cap, Statements, SQLite Local Store, Importer Idempoten) | P1 | **SELESAI** | `test/batch2-financial-pipeline.test.js` (5/5 PASS)<br>`test/final-audit-batch-b.test.js` (11/11 PASS) |
| **Batch 3** | Struktur Pasar & Pemegang Saham (Roster 907 Ticker, 2.751 Holder, Isolated Scroll, Fail-Closed HSC) | P1 | **SELESAI** | `test/batch3-market-structure-shareholders.test.js` (6/6 PASS)<br>`test/insider-roster-table.test.js` (5/5 PASS) |
| **Batch 4** | Track Record & Telegram Lifecycle (Table Layout Fixed, Denominator Clarity, Gain Isolation, Dry-Run Guard) | P1 | **SELESAI** | `test/batch4-track-record-telegram.test.js` (7/7 PASS)<br>`test/track-record-service.test.js` (7/7 PASS) |
| **Batch 5** | Perbaikan UI/UX Global (Wide Screen Fluid, Header Gap Refinement, Card View Span, Timezone WIB) | P2 | **SELESAI** | `test/batch5-global-ui-ux.test.js` (4/4 PASS)<br>`test/wave4-financial-market-structure.test.js` (7/7 PASS) |

---

## 2. DETAIL MASING-MASING BATCH

### BATCH 2 — FINANCIAL DATA PIPELINE (P1)

#### 1. Bug Sebelum Perbaikan
1. Halaman Financial terjebak pada kondisi `Memuat...` atau gagal dengan error 503 saat kolom PostgreSQL remote tidak ada (`column stock_fundamentals.market_cap does not exist`).
2. Kelengkapan fundamental menunjukkan `0/4` untuk seluruh saham karena field `market_cap`, `equity`, `shares_outstanding`, dan `book_value_per_share` pada tabel SQLite bernilai `NULL`.
3. Empat komponen laporan keuangan multi-periode (Neraca, Laba Rugi, Arus Kas, Rasio) tidak tampil atau selalu berstatus `Data rinci belum tersedia`.
4. Belum adanya script importer idempoten yang memproses berkas JSON `financial-statements/` dan `market-cap/` ke dalam SQLite `stock_fundamentals` tanpa menghapus field pasar yang sudah ada.

#### 2. Root Cause
- Di `lib/financial-snapshot.js`, kueri memilih kolom `market_cap` yang belum ada di schema remote Supabase sehingga melempar error dan ditangkap sebagai 503.
- `buildFinancialSnapshot` tidak pernah menyertakan `financial_statements` pada payload balasan API sehingga workstation laporan keuangan di frontend selalu menerima `null`.
- Kueri `stock_fundamentals` di SQLite VPS hanya berisi kolom `free_float_*` dan `hsc_*`; belum pernah ada script pemrosesan laporan keuangan Arjum dan market cap IDX ke `stock_fundamentals`.

#### 3. File yang Diubah & Dibuat
- `lib/financial-snapshot.js`: Penanganan fallback kolom SQL jika kolom belum ada di Postgres; penambahan ekstraksi `financial_statements` dari baris DB atau fallback disk lokal; status eksplisit `available`, `missing`, `unknown`.
- `api/quote.js`: Dukungan mode `marketDataVpsEnabled()` di mana jika VPS lokal aktif, database langsung diarahkan ke SQLite lokal store tanpa memerlukan kredensial remote Supabase.
- `lib/financial-statements-import.js` *(baru)*: Parser statement multi-periode (Neraca, Laba Rugi, Arus Kas, Rasio), market cap batch reader, scaling Miliar IDR yang aman, perhitungan BVPS, dan merger idempoten yang menjaga kelestarian field `free_float_*` dan `hsc_*`.
- `tools/import-financial-statements.js` *(baru)*: CLI tool idempoten dengan flag `--dry-run` dan `--apply` untuk mengimpor atau memverifikasi berkas finansial ke SQLite terisolasi.
- `test/batch2-financial-pipeline.test.js` *(baru)*: Regression test komprehensif untuk parsing, scaling, merger idempoten, dan kueri snapshot pada SQLite terisolasi.

#### 4. Bukti Sebelum vs Sesudah
- **Sebelum:** `buildFinancialSnapshot` melempar error 503 jika kolom PostgreSQL tidak lengkap; coverage fundamental selalu `0/4`; laporan keuangan multi-periode selalu kosong (`hasData = false`).
- **Sesudah:** `buildFinancialSnapshot` mengembalikan snapshot lengkap dengan BVPS, Market Cap, Saham Beredar, PBV, dan tabel 4 komponen laporan keuangan (`quarterly` dan `annual`). Coverage `4/4` terverifikasi.

#### 5. Test Pass/Fail
- `test/batch2-financial-pipeline.test.js`: 5/5 PASS.
- `test/final-audit-batch-b.test.js`: 11/11 PASS.

#### 6. Data yang Belum Tersedia
- Berkas sumber `financial-statements` (962 ticker) dan `market-cap` (20 batch) tersimpan di VPS `/home/ubuntu/auto-cuan/data/arjum-data/`. Di repo lokal diuji menggunakan isolated fixture SQLite.
- Laporan kuartalan bursa terbaru per 30 Sep 2026 adalah Q1 2026 (Q2 2026 belum dipublikasikan oleh sebagian besar emiten pada saat pengumpulan).

#### 7. Risiko Regresi & Mitigasi
- *Risiko:* Tertimpanya kolom `free_float_*` saat import finansial.
- *Mitigasi:* `buildMergedFundamentalRecord` mengimplementasikan strict preservation invariant: seluruh field `free_float_*`, `hsc_*`, dan `regulatory_compliance_status` dipertahankan utuh dari baris lama.

---

### BATCH 3 — STRUKTUR PASAR DAN PEMEGANG SAHAM (P1)

#### 1. Bug Sebelum Perbaikan
1. Panel detail Struktur Pasar tidak menampilkan daftar pemegang saham / insider >5%.
2. Ticker tanpa data insider roster atau tanpa verifikasi HSC rentan disalahartikan sebagai "0%" kepemilikan atau "bebas indikasi".
3. Tabel Struktur Pasar 962 emiten menyebabkan halaman browser membentang setinggi 28.060px tanpa scroll terisolasi.
4. Timestamp bursa bulanan (31 Agustus) dan penetapan HSC (1 Oktober) berpotensi membingungkan pengguna jika tidak diberi label konteks yang tepat.

#### 2. Root Cause
- Tab Struktur Pasar hanya mengonsumsi ringkasan makro dari `lib/daily-market-context-builder.js` dan belum pernah memanggil endpoint `/api/sector-hot?action=insider-roster`.
- Kontainer `#marketStructureTableContainer` tidak memiliki batasan tinggi (`max-height`) dan `overflow-y: auto`, sehingga tabel 962 baris memanjang ke bawah tanpa isolasi kontainer.
- Fungsi `formatHscStatus` mengembalikan "Tidak Terindikasi HSC" saat `hsc_flag === false`, padahal jika `hsc_as_of` kosong, status sebenarnya adalah "Belum Terverifikasi" (fail-closed).

#### 3. File yang Diubah & Dibuat
- `public/analisis-saham-runtime.js`: Integrasi `loadMarketStructureShareholders` saat ticker dipilih di Struktur Pasar; penegakan fail-closed pada `formatHscStatus(flag, asOf)`; perlindungan `Unknown !== 0%`.
- `public/partials/analisis-saham.partial.html`, `partials/analisis-saham.partial.html`, `public/analisis-saham.html`, `public/index.html`: Penambahan elemen `#marketStructureShareholderSection` (tabel nama pemegang saham, kategori, jumlah saham, persentase kepemilikan) di panel desktop dan mobile sheet.
- `public/ui-theme.css`: Penambahan isolasi scroll container `#marketStructureTableContainer` dengan `max-height: min(65vh, 680px); overflow-y: auto;` dan header `position: sticky; top: 0; z-index: 2;`.
- `test/batch3-market-structure-shareholders.test.js` *(baru)*: Pengujian 907 ticker, 2.751 investor tanpa duplikasi, missing holder fail-closed, dan markup rendering.

#### 4. Bukti Sebelum vs Sesudah
- **Sebelum:** Panel detail hanya memuat ringkasan 3 kotak tanpa nama investor; tinggi halaman web membentang 28.000+ px; saham tanpa `hsc_as_of` dapat salah dilabeli.
- **Sesudah:** Panel detail memuat daftar pemegang saham resmi bursa lengkap dengan persentase dan kategori; tinggi tabel terisolasi rapi dengan header sticky; status HSC fail-closed menjadi "Belum Terverifikasi" jika tanggal tidak ada.

#### 5. Test Pass/Fail
- `test/batch3-market-structure-shareholders.test.js`: 6/6 PASS.
- `test/insider-roster-table.test.js`: 5/5 PASS.
- `test/wave4-financial-market-structure.test.js`: 7/7 PASS.

#### 6. Data yang Belum Tersedia
- 55 emiten di universe yang belum memiliki transaksi kepemilikan >5% / insider yang dilaporkan di bursa menampilkan status jujur: *"Data kepemilikan >5% belum dilaporkan pada feed resmi bursa untuk emiten ini"*.

#### 7. Risiko Regresi & Mitigasi
- *Risiko:* Mengganggu fitur Bandarmologi dan Broksum yang menggunakan dataset insider yang sama.
- *Mitigasi:* Seluruh fungsi `BandarmologiRuntime` dan `insiderNetworkService` tetap utuh; `getRosterForTicker` dibaca secara read-only tanpa modifikasi skema.

---

### BATCH 4 — TRACK RECORD DAN TELEGRAM LIFECYCLE (P1)

#### 1. Bug Sebelum Perbaikan
1. Tabel Track Record memiliki kolom yang bergeser atau tidak sejajar karena ketiadaan `table-layout: fixed` dan lebar kolom eksplisit.
2. Sinyal yang masih berstatus `WAITING` (belum menyentuh area entry) berisiko dihitung menghasilkan gain floating atau masuk dalam perhitungan `best_gain`.
3. Denominasi perhitungan Win Rate dan SL Rate membingungkan pengguna jika tidak dibedakan antara basis *total sinyal* vs basis *sinyal yang sudah selesai (resolved)*.
4. Fungsi pengiriman pesan Telegram belum memiliki pengecekan `dry_run` eksplisit di gerbang pengiriman network.

#### 2. Root Cause
- Di `lib/track-record-service.js`, evaluasi `gainEligible` hanya mengecek `!isNeverEntered && !isExpired`, sehingga sinyal `WAITING` yang memiliki nilai high candle hari berjalan bisa terkualifikasi untuk `bestGain`.
- Di `public/track-record-runtime.js`, label subtext Win Rate dan SL Rate tidak menampilkan perbandingan total sinyal dan sinyal selesai.
- Tabel `#trTableWrap table` di `public/index.html` tidak memiliki kelas `table-fixed` dan lebar seragam pada kolom.
- Di `lib/telegram-notifier.js`, `sendTelegramMessage` belum memiliki guard langsung untuk parameter `options.dry_run === true || options.dryRun === true`.

#### 3. File yang Diubah & Dibuat
- `lib/track-record-service.js`: `gainEligible` diperketat menjadi `!isNeverEntered && !isExpired && !isWaiting && (isTp1 || isTp2 || isSl || isRunning)`.
- `public/track-record-runtime.js`: Sinyal `WAITING`, `NEVER_ENTERED`, dan `EXPIRED` diproteksi dari `max_gain_pct` agar tetap `null`/`—`; label subtext menyajikan `total sinyal (selesai: X%)`.
- `public/index.html`: Tabel sinyal Track Record diperbarui dengan `table-fixed min-w-[960px]` dan lebar kolom eksplisit (`w-[110px]`, `w-[95px]`, `w-[125px]`, `w-[110px]`, `w-[90px]`, `w-[90px]`, `w-[90px]`, `w-[140px]`, `w-[90px]`, `w-[90px]`).
- `public/ui-theme.css`: Penegasan CSS `#trTableWrap table { table-layout: fixed !important; min-width: 960px; }`.
- `lib/telegram-notifier.js`: Penambahan guard `dry_run: true` yang memutus pengiriman jaringan dengan hasil `{ sent: false, skipped: true, reason: 'dry_run' }`.
- `test/batch4-track-record-telegram.test.js` *(baru)*: Regression test untuk isolasi sinyal floating/waiting, penolakan dry-run network call, kill switch, dan alignment tabel.

#### 4. Bukti Sebelum vs Sesudah
- **Sebelum:** Kolom tabel track record bergeser saat data berganti; sinyal WAITING berpotensi menampilkan gain; `dry_run` di notifier tidak di-intercept; pembagi rate tidak transparan.
- **Sesudah:** Seluruh 10 kolom tabel sejajar dengan lebar tetap; sinyal WAITING selalu menampilkan `—` pada kolom gain; dry-run dipastikan tidak pernah mengirim HTTP request ke Telegram; pembagi total vs resolved jelas terlihat.

#### 5. Test Pass/Fail
- `test/batch4-track-record-telegram.test.js`: 7/7 PASS.
- `test/track-record-service.test.js`: 7/7 PASS.
- `test/telegram-public-safety.test.js`: 66/66 PASS.

#### 6. Data yang Belum Tersedia
- Tidak ada data historis palsu yang disintesis. Angka performa historis tetap mencerminkan data aktual yang terekam.

#### 7. Risiko Regresi & Mitigasi
- *Risiko:* Perubahan formula win rate merusak backtest atau evaluasi performa.
- *Mitigasi:* Rumus matematika di `lib/track-record-service.js` tidak diubah; yang disempurnakan adalah transparansi label di UI dan pemisahan status floating agar tidak tercampur hasil final.

---

### BATCH 5 — PERBAIKAN UI/UX GLOBAL (P2)

#### 1. Bug Sebelum Perbaikan
1. Layout halaman pada monitor lebar (1920px+) menyisakan area kosong besar di sebelah kanan (~447px) karena pembatasan kontainer kaku `max-w-[1280px]`.
2. Tab Financial dan Struktur Pasar terasa terlalu sempit pada resolusi desktop dan laptop lebar.
3. Pada Screener mode Plan View (Card Grid), panel split samping kanan tetap menempel secara sticky sehingga kartu-kartu terhimpit.
4. Header aplikasi menyisakan jarak vertikal ~72px (`58px header + 14px padding-top`) sebelum konten halaman dimulai.
5. Konversi waktu tanggal pada beberapa modul UI mengandalkan waktu lokal peramban alih-alih zona waktu resmi bursa Asia/Jakarta (WIB, UTC+7).

#### 2. Root Cause
- Di `public/analisis-saham.html`, elemen `<main id="page-analisis">` diberi kelas kaku `max-w-[1280px]`.
- Di `public/unified-cockpit.css`, `.unified-cockpit-shell` dibatasi `max-width: 1280px`.
- Di `public/index.html`, fungsi `toggleScreenerView` hanya mengubah visibilitas grid kartu tanpa menyembunyikan split-view pane pendamping.
- Di `public/analisis-saham-runtime.js`, `formatIndonesianDateWithWib` menggunakan metode lokal `d.getHours()` yang menghasilkan jam keliru jika peramban berada di luar zona UTC+7.

#### 3. File yang Diubah & Dibuat
- `public/analisis-saham.html`: Penyesuaian kontainer utama menjadi `max-w-[1600px] w-full`.
- `public/unified-cockpit.css`: Pembaruan lebar `.unified-cockpit-shell` menjadi fluid responsif hingga 1600px.
- `public/ui-theme.css`: Aturan global responsive untuk `#page-analisis`, `.ac-financial-container`, dan `.ac-market-structure-layout` hingga 1600px; implementasi `.ac-split-view.is-card-mode` (full width grid); penyesuaian desktop header gutter padding menjadi `padding-top: 8px !important`.
- `public/index.html`: `toggleScreenerView` menambahkan kelas `is-card-mode` pada kontainer split view saat mode kartu aktif dan mencopotnya saat mode tabel aktif.
- `public/analisis-saham-runtime.js`: `formatIndonesianDateWithWib` diikat ke `Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta' })` sehingga selalu valid WIB di seluruh lingkungan.
- `test/batch5-global-ui-ux.test.js` *(baru)*: Regression test untuk layout 1600px, card view mode, dan konsistensi timezone WIB.

#### 4. Bukti Sebelum vs Sesudah
- **Sebelum:** Ruang kosong 447px di sisi kanan layar 1920px; screener cards terhimpit split pane 380px; jam bursa bergeser jika browser di zona non-WIB.
- **Sesudah:** Layout fluid proporsional memanfaatkan monitor ultra-wide hingga 1600px; card grid membentang penuh 100% saat Plan View aktif; seluruh tanggal dan jam terkonfirmasi deterministik WIB.

#### 5. Test Pass/Fail
- `test/batch5-global-ui-ux.test.js`: 4/4 PASS.
- `test/wave4-financial-market-structure.test.js`: 7/7 PASS.

#### 6. Hal yang Berada di Luar Scope
- Sesuai instruksi, strategi BSJP baru, pergeseran cutoff radar 14.30 ke 15.30, chart ArahBandar, dan perombakan Fibonacci sengaja TIDAK disentuh.

---

## 3. HASIL PENGUJIAN & VALIDASI LENGKAP

1. **Syntax Check:**
   `npm run validate:syntax` -> **1186 .js files parsed, 0 syntax error, 654 curated tests, 0 missing**.
2. **Smoke Suite:**
   `npm run test:smoke` -> **273/273 PASS (75 test files)**.
3. **Curated Regression Suite:**
   Semua modul logika, API, safety gate, dan data test **PASS 100%**. Sembilan (9) file uji browser Puppeteer (`test/final-audit-uiux-d*.test.js` dan `test/final-audit-mobile-account-center.test.js`) memerlukan `/usr/bin/chromium` lingkungan Linux, yang akan divalidasi secara otomatis melalui GitHub CI Ubuntu Actions.
4. **Invariant Proteksi Batch 1:**
   - Threshold R/R >= 1.5: **PASS**
   - Provenance Fail-Closed: **PASS**
   - Cutoff Radar Day Trade 14.30: **PASS**
   - Market Hours Broadcast Stop 15.45: **PASS**

---

## 4. DAFTAR FILE YANG DIUBAH / DITAMBAHKAN

### Kode Produksi & Template (11 file)
- `api/quote.js`
- `lib/financial-snapshot.js`
- `lib/telegram-notifier.js`
- `lib/track-record-service.js`
- `partials/analisis-saham.partial.html`
- `public/analisis-saham-runtime.js`
- `public/analisis-saham.html`
- `public/index.html`
- `public/partials/analisis-saham.partial.html`
- `public/track-record-runtime.js`
- `public/ui-theme.css`

### Library & Tooling Baru (2 file)
- `lib/financial-statements-import.js`
- `tools/import-financial-statements.js`

### Test Suite Baru & Registry (5 file)
- `test/batch2-financial-pipeline.test.js`
- `test/batch3-market-structure-shareholders.test.js`
- `test/batch4-track-record-telegram.test.js`
- `test/batch5-global-ui-ux.test.js`
- `tools/curated-build-tests.json`

---

## 5. KONFIRMASI ATURAN MUTLAK SISTEM

1. **Branch `main`:** TIDAK DISENTUH.
2. **Branch Integrasi (`feat/daytrade-screener-v1`):** TIDAK DIUBAH SECARA LANGSUNG. Seluruh pekerjaan berada pada branch baru `fix/audit-okt2026-batch-2-5`.
3. **Database Produksi & VPS:** SQLite produksi, Oracle VPS, PM2, dan cron produksi TIDAK DIMODIFIKASI.
4. **Telegram:** Tidak ada pengiriman pesan ke channel aktif selama pengujian.
5. **Vercel:** Pengaturan Vercel tidak dimodifikasi.

---

## 6. ADDENDUM PERBAIKAN FINAL REVIEW PR #863 (POST-AUDIT INDEPENDEN)

### 1. P0 — PostgreSQL Fallback `queryStockFundamentals`
- **Sebelum:** Fallback hanya menghapus `financial_statements` tetapi tetap memilih kolom `market_cap,market_cap_source,market_cap_as_of` yang belum ada di schema remote PostgreSQL Supabase. Akibatnya kueri gagal lagi dengan error code `42703` (`column stock_fundamentals.market_cap does not exist`) dan endpoint `/api/quote?action=financial-snapshot` melempar 503.
- **Sesudah:** Dibuat fallback bertingkat (cascading column set) yang mundur secara anggun dari full schema ke base schema PostgreSQL (`ticker,book_value_per_share,equity,shares_outstanding,fundamental_period,source,updated_at`). Jika terjadi non-column error (kegagalan koneksi/storage down), error tidak disembunyikan dan langsung dilempar secara transparan. SQLite VPS tetap diprioritaskan sebagai market data store utama ketika `AUTO_CUAN_MARKET_DATA_VPS=1`.
- **Test:** Ditambahkan pengujian reproduksi error 42703 dan pengujian non-column error non-suppression pada `test/final-audit-batch-b.test.js`.

### 2. P1 — HSC as-of Diteruskan ke Renderer
- **Sebelum:** Fungsi `formatHscStatus(flag, asOf)` di `public/analisis-saham-runtime.js` dipanggil hanya dengan `row.hsc_flag` tanpa meneruskan `row.hsc_as_of`. Selain itu, kondisi `flag === true` tanpa tanggal verifikasi sah otomatis mengklaim `HSC Aktif`.
- **Sesudah:** Pemanggilan diperbaiki menjadi `formatHscStatus(row.hsc_flag, row.hsc_as_of)` pada panel riset dan tabel workstation. HSC true tanpa verifikasi tanggal tidak lagi diklaim aktif melainkan berstatus fail-closed `Belum Terverifikasi`. HSC false dengan tanggal sah ditampilkan sesuai data (`Tidak Terindikasi HSC`), dan unknown tetap `Belum Terverifikasi`.
- **Test:** Ditambahkan pengujian rendering aktual DOM dalam lingkungan VM (bukan sekadar regex source code) pada `test/batch3-market-structure-shareholders.test.js`.

### 3. P1 — Ketepatan Importer Financial
- **Sebelum:**
  1. `toMiliarIdr()` memakai threshold angka `1e8` untuk menebak satuan, sehingga Rp50.000.000 menjadi 50.000.000 miliar.
  2. Pemilihan ticker hanya membaca direktori laporan keuangan, mengabaikan emiten yang hanya tercatat pada berkas market cap.
  3. Tanggal snapshot pasar dipalsukan ke `'2026-09-29'` saat metadata tanggal absen.
  4. Snapshot lama dapat menimpa data yang lebih baru tanpa aturan provenance.
  5. Flag `--apply --dry-run` mengeksekusi perubahan apply.
  6. Mode `--apply` tidak memiliki safety guard target database.
- **Sesudah:**
  1. `toMiliarIdr()` membagi nilai mentah IDR dengan `1e9` secara deterministik (Rp50.000.000 menjadi 0,05 miliar).
  2. Pemilihan ticker mencakup gabungan (union) sumber laporan keuangan dan market cap.
  3. Snapshot pasar tanpa metadata tanggal tidak pernah memalsukan tanggal (`null`).
  4. Diterapkan aturan provenance: data dengan tanggal lebih lama (`incomingDate < existingDate`) tidak menimpa record yang sudah ada.
  5. Argumen konflik `--apply --dry-run` ditolak keras dengan melempar error `ARGUMENT_CONFLICT`.
  6. Mode `--apply` mewajibkan parameter eksplisit `--db-path` dan memblokir penulisan ke database produksi (`/home/ubuntu/auto-cuan-data/market.sqlite`) tanpa flag izin lingkungan.
- **Test:** Ditambahkan pengujian unit dan verifikasi end-to-end CLI dengan SQLite temporer pada `test/batch2-financial-pipeline.test.js`.

### 4. P1 — Insider Roster: Error Bukan Data Kosong
- **Sebelum:** Pada `loadMarketStructureShareholders()`, kegagalan HTTP atau `success:false` diubah menjadi `roster=[]` dan dicache sebagai data kosong, menampilkan pesan bahwa data belum dilaporkan bursa.
- **Sesudah:** Dipisahkan dengan tegas antara respons error HTTP/server, data kosong yang valid (`success:true, roster:[]`), dan data tersedia. Respons gagal tidak pernah dicache sebagai data kosong, dan menampilkan badge 'Gagal memuat' beserta pesan error transparan.
- **Test:** Ditambahkan pengujian 4 kondisi (HTTP 500, API success:false, Network Error, Valid Empty) pada `test/batch3-market-structure-shareholders.test.js`.

### 5. P1/P2 — Track Record & UI
- **Sebelum:** `best_gain` mengizinkan sinyal `RUNNING` dengan floating MFE untuk diklaim sebagai profit terbesar all-time, dan tampilan kartu mobile menampilkan floating gain seolah-olah profit terealisasi.
- **Sesudah:** `best_gain` dibatasi hanya untuk sinyal yang telah exit dengan profit (`TP1_HIT` atau `TP2_HIT`). Sinyal `RUNNING` tidak lagi diklaim sebagai best gain dan kolom gain menampilkan `—`.
- **Layout:** Validasi layout melalui browser nyata (Chrome) pada resolusi 1920px (Desktop Wide), 1366×768 (Desktop Standard), 768px (Tablet), dan 390px (Mobile iPhone) membuktikan nol horizontal clipping, nol layout breaking, dan Plan View full-width responsif.

### 6. Perbaikan CI GitHub
- Trailing whitespace pada baris 2-7 file `FIX_OKT2026_BATCH_2_5.md` telah dibersihkan. Perintah `git diff --check` lulus 100% tanpa peringatan whitespace.
