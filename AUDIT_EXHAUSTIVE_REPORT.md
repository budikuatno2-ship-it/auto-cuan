# LAPORAN AUDIT LOGIKA MENYELURUH AUTO-CUAN (EXHAUSTIVE MASTER AUDIT)
Tanggal Audit: 11 September 2026  
Status Protokol: 100% READ-ONLY (Zero Write / Zero Commit Aplikasi)  
Lingkup Pemeriksaan: Layer 1 (Serverless API), Layer 2 (Engine & Services), Layer 3 (Frontend Runtime), Layer 4 (Supabase SQL)

---

## 1. RINGKASAN EKSEKUTIF (EXECUTIVE SUMMARY)

Audit kode menyeluruh (deep exhaustive audit) telah dilaksanakan secara berurutan (*sequential non-swarm mode*) mencakup seluruh lapisan sistem Auto-Cuan:
- **Layer 1: Backend Serverless API (`api/`)** — 12 file (termasuk gateway utama `sector-hot.js` 14.274 baris dan `quote.js` 2.768 baris).
- **Layer 2: Core Engine & Services (`lib/`)** — 175 file (Bandarmologi, Market Context, Day Trade Screener, Fast Watcher, Trade Plan V2, AI Routing, Auth & Subscription, Telegram Notifier).
- **Layer 3: Frontend Client-Side Runtime (`public/`)** — 50 file JS runtime (Bandarmologi Runtime, Day Trade UI, Pattern Engine, Portfolio Command Center, Auth V2).
- **Layer 4: Database Schema & Migration Integrity (`supabase/`)** — 55 file SQL migration & schema constraints.

Dari penelusuran baris demi baris, ditemukan **16 anomali sistemik dan cacat logika**:
- **Critical:** 0
- **High:** 3
- **Medium:** 5
- **Low:** 8

---

## 2. TABEL MASTER ANOMALI KODE & CACAT LOGIKA

| No | Layer | File & Baris | Deskripsi Cacat Logika / Bug | Efek Riil di Web | Severity |
|:---|:---|:---|:---|:---|:---:|
| 1 | Layer 2A (Core Engine) | `lib/idx-holidays-2026-seed-data.js:47` & `supabase/idx-holidays-2026-seed.sql:41` | **Kesalahan Tanggal Libur Nasional (1 Muharam 1448H):** Tanggal Tahun Baru Islam di-seed sebagai `2026-06-16` (Selasa), padahal kalender resmi SKB 3 Menteri menetapkan jatuh pada hari Rabu, `2026-06-17`. | Pada 16 Juni 2026 sistem bursa mengira libur sehingga screener & watcher tidak berjalan di jam bursa aktif. Pada 17 Juni 2026 sistem mengira bursa buka sehingga memicu crash/warning data kosong saat BEI libur. | **High** |
| 2 | Layer 2A (Core Engine) | `lib/bandarmologi-service.js:283-285` | **Normalisasi VWAP Menggelembungkan Penny Stock 100x:** Fallback `normalizeVwapPrice` saat `refPrice` nol/tidak diketahui mengevaluasi `if (raw < 50 && raw * 100 >= 50 && raw * 100 <= 50000) return Math.round(raw * 100)`. Saham FCA yang bertransaksi murni di bawah Rp 50 (misal Rp 42) dipaksa dikalikan 100 menjadi Rp 4.200. | Modal bandar saham gocap/penny stock pada papan pemantauan khusus melonjak 100x lipat (Rp 42 menjadi Rp 4.200), memunculkan anomali perhitungan diskon bandar yang keliru. | **High** |
| 3 | Layer 2C (Daytrade Screener) | `lib/daytrade-ohlcv-cache.js:188-214` | **Stale Cache Pre-Market Menembus Jam Perdagangan Aktif:** `isCacheFresh` hanya mengecek `(nowMs - updatedAtMs) <= 15 menit` tanpa mengecek batas crossing sesi bursa buka (09:00 WIB). Cache yang ter-update pada 08:55 WIB dianggap fresh hingga 09:10 WIB. | Pada 10 menit pertama sesi pembukaan pasar (09:00–09:10 WIB) yang merupakan waktu tersengit day trading, screener menyajikan candle kemarin dan melewatkan lonjakan volume open bursa. | **High** |
| 4 | Layer 2B (Auth & Billing) | `lib/subscription-manual-handler.js:340-345` | **Persetujuan Syarat Pembayaran Dapat Di-Bypass:** Pengecekan `if (req.body.paymentTermsAccepted !== undefined || req.body.termsAccepted !== undefined)` melewatkan validasi jika client tidak menyertakan kedua field tersebut dalam payload POST. | User dapat mengirimkan bukti pembayaran manual tanpa mencentang persetujuan syarat dan ketentuan subscription jika frontend/bot tidak mengirimkan flag tersebut. | **Med** |
| 5 | Layer 2B (AI Engine) | `lib/context-ai-router-v7.js:560-579` | **Duplikasi Streaming Response saat Fallback Retry:** Saat percobaan primer Gemini gagal di tengah jalan (setelah sebagian SSE terkirim), attempt 2/3 langsung menyalurkan chunk baru ke stream tanpa sinyal reset/pembersihan buffer ke client. | Balasan analisis AI pada UI chat menjadi berantakan dan terduplikasi (teks attempt 1 yang putus disambung langsung dengan awal teks attempt 2). | **Med** |
| 6 | Layer 3 (Frontend Runtime) | `public/daytrade-runtime.js:62-67` | **Timezone Mismatch UTC vs WIB Menghasilkan STALE False Alarm:** `dtCalcDateStr` dihitung dari UTC (`.toISOString().slice(0, 10)`), sedangkan `dtTodayStr` dihitung dari WIB (`Date.now() + 7 jam`). | Pada dini hari (00:00–07:00 WIB), badge header Day Trade memunculkan peringatan palsu `⚠️ STALE · Data day trade sudah lama` meskipun data baru dihitung beberapa jam sebelumnya. | **Med** |
| 7 | Layer 3 (Frontend Runtime) | `public/portfolio-command-center.css:16` | **Pemotongan Area Input AI Chat pada Layar Laptop Standar:** Container `.ai-chat` menetapkan `height: clamp(660px, calc(100dvh - 110px), 960px)` dengan `min-height: 620px; overflow: hidden;`. | Pada resolusi laptop 1366x768 (viewport efektif browser ~580–620px), kotak input chat `.ai-compose` di bagian bawah terpotong keluar dari layar dan tidak bisa dijangkau. | **Med** |
| 8 | Layer 1B (Backend API) | `api/candles.js:205` | **Falsy Evaluation pada Rata-Rata Volume Nol:** Pengecekan `calcMA(volumeArr, 20) ? ... : null` mengembalikan `null` jika moving average volume saham adalah `0` (saham yang baru keluar dari suspensi 20 hari berturut-turut). | Respons API candles memberikan `null` alih-alih `0`, memicu potensi `NaN` atau error rendering indikator volume pada chart. | **Low** |
| 9 | Layer 1A (Backend API) | `api/quote.js:304` | **Missing Body Parameter Reading pada POST Method:** `var portfolioPriceOnly = req.query && req.query.portfolio === '1'` hanya mengecek `req.query`, padahal endpoint mendukung request POST dengan body JSON. | Request POST portofolio yang mengirim `{ "portfolio": "1" }` di body tidak memicu bypass Yahoo cache, tetap menerima quote cache 5 menit. | **Low** |
| 10 | Layer 2B (AI Engine) | `lib/ai-gemini-provider.js:174` | **Silent Catch Menelan Error Write-After-End:** Di dalam `parseSseStream`, pemanggilan `onChunk` dibungkus try-catch yang menelan seluruh error secara diam-diam (`catch (_) {}`). | Jika koneksi client HTTP terputus di tengah jalan, loop pembacaan upstream stream tetap berlanjut dan memboroskan memori serverless. | **Low** |
| 11 | Layer 3 (Frontend Runtime) | `public/pattern-stable-runtime.js:638-644` | **Unbounded Global Interval Polling:** `root.setInterval(function() { ... }, 1000)` dijalankan terus menerus tanpa mekanisme pembatalan (`clearInterval`) saat user berpindah fitur. | Memboroskan resource CPU dan baterai perangkat pengguna di latar belakang tab browser. | **Low** |
| 12 | Layer 4 (Database Schema) | `supabase/foreign-watchlist-daily-migration.sql:23` | **Duplikasi B-Tree Index Kolom Unique:** Indeks `idx_foreign_watchlist_daily_trade_date_ticker` sepenuhnya redundan dengan constraint UNIQUE `foreign_watchlist_daily_trade_date_ticker_key`. | Menambah konsumsi disk storage dan beban IOPS saat upsert foreign flow harian. | **Low** |
| 13 | Layer 4 (Database Schema) | `supabase/sector-hot.sql:85` | **Redundant Leading Column Index:** Indeks `idx_shgm_group` redundan karena kolom `group_code` sudah menjadi awalan dari constraint `UNIQUE(group_code, ticker)`. | Membuang alokasi storage indeks Supabase tanpa memberikan keuntungan query planner. | **Low** |
| 14 | Layer 4 (Database Schema) | `supabase/swing-screener-non-konglo.sql:88` | **Overlapping Date Index:** `idx_nk_jobs_run_date` redundan dengan indeks komposit `idx_nk_jobs_run_status` dan `idx_nk_jobs_run_batch_unique` yang sama-sama berawalan `run_date`. | Sedikit memperlambat operasi DML batch execution saat scanning non-konglo. | **Low** |
| 15 | Layer 4 (Database Schema) | `supabase/swing-screener-non-konglo.sql:135` | **Overlapping Date Index:** `idx_nk_staging_run_date` redundan dengan indeks unik `idx_nk_staging_run_ticker_unique`. | Menurunkan throughput saat staging ratusan ticker non-konglo. | **Low** |
| 16 | Layer 4 (Database Schema) | `supabase/stock-daily-context-migration.sql:84-85` & `supabase/telegram-daily-picks-migration.sql:59` | **Functional Duplicate Index pada History & Telegram Picks:** Indeks `(ticker, trade_date)` dan `idx_telegram_daily_picks_date` redundan dengan constraint UNIQUE dan indeks komposit status. | Duplikasi penyimpanan B-Tree pada tabel transaksi bursa bervolume tinggi. | **Low** |

---

## 3. ANALISIS DETAIL PER KLASTER & REKOMENDASI SOLUSI

### Klaster A: Data Integrity & Market Context (Prioritas 1)
- **Bug #1 (`idx-holidays-2026-seed-data.js` & SQL seed):** Ganti tanggal `2026-06-16` menjadi `2026-06-17` pada data seed kalender bursa 1 Muharam 1448H agar sinkron dengan hari libur BEI sebenarnya.
- **Bug #2 (`bandarmologi-service.js`):** Tambahkan kondisi batas bawah atau jangan kalikan 100 jika emiten berada di papan Akselerasi/FCA (`price <= 50`), agar harga modal saham gocap tidak melompat ke Rp 4.200.
- **Bug #3 (`daytrade-ohlcv-cache.js`):** Tambahkan pengecekan session boundary: jika `nowMs` telah memasuki jam bursa aktif (>= 09:00 WIB hari ini), sedangkan `updatedAtMs` tercatat sebelum pukul 09:00 WIB hari ini, maka cache wajib dinyatakan `stale = true` terlepas dari selisih menitnya.

### Klaster B: UX & Timezone/UI Precision (Prioritas 2)
- **Bug #6 (`daytrade-runtime.js`):** Ubah `dtCalcDateStr` agar dikonversi ke tanggal WIB dengan menambahkan offset 7 jam sebelum di-slice ISO, sehingga perbandingan `dtCalcDateStr === dtTodayStr` konsisten di seluruh 24 jam.
- **Bug #7 (`portfolio-command-center.css`):** Sesuaikan tinggi `.ai-chat` menggunakan `max-height: calc(100dvh - 120px); min-height: 480px; height: 100%;` agar fleksibel dan tidak memotong form input pada monitor laptop 768p.
- **Bug #5 (`context-ai-router-v7.js`):** Kirimkan event SSE khusus (misal event `clear` atau `retry`) ke frontend sebelum menjalankan model fallback, agar client dapat mereset teks buffer parsial yang gagal.

### Klaster C: Defensive API & Database Sanitization (Prioritas 3)
- **Bug #4 (`subscription-manual-handler.js`):** Ubah validasi terms menjadi mandatory: `const termsAccepted = req.body && (req.body.paymentTermsAccepted === true || req.body.termsAccepted === true); if (!termsAccepted) return 400;`.
- **Bug #8 & #9 (`candles.js` & `quote.js`):** Gunakan nullish coalescing `calcMA(...) ?? null` dan periksa `req.body.portfolio === '1'` pada method POST.
- **Bug #10 & #11 (`ai-gemini-provider.js` & `pattern-stable-runtime.js`):** Hentikan stream generator jika client disconnect, dan simpan interval ID untuk dibersihkan saat lifecycle unmount.
- **Bug #12–#16 (Supabase SQL Migrations):** Buat migration patch `DROP INDEX IF EXISTS` untuk membersihkan 5 indeks redundan yang tidak diperlukan.

---

## 4. KESIMPULAN AUDIT
Sistem Auto-Cuan telah memiliki fondasi arsitektur yang sangat kokoh dengan validasi token session yang baik di level API gateway. Seluruh 16 anomali yang terdeteksi di atas bersifat terlokalisasi dan dapat diperbaiki secara terarah dalam 3 batch pengerjaan tanpa risiko merusak arsitektur inti platform.
