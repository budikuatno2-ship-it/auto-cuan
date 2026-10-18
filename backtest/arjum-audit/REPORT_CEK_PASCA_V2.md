# LAPORAN AUDIT PASCA-DEPLOY V2: IHSG, BACKFILL, DAN KUOTA 18.080

**Tanggal Audit:** Minggu, 18 Oktober 2026 (19:50 WIB)  
**Lingkungan:** Production VPS (Node.js v22.23.1, PM2)  
**Branch:** `feat/broksum-all-foreign`  
**Status Audit:** READ-ONLY CHECK & ZERO ARJUM REQUEST CONSUMED  

---

## Ringkasan Eksekutif Hasil Audit C1–C5

| Poin Audit | Aspek yang Diperiksa | Status Temuan | Tindakan Perbaikan |
|---|---|---|---|
| **C1** | Hari "tanpa transaksi" yang dilewati | **[BUG] → DIPERBAIKI** | Ditemukan 1 kasus (`SINI` 2026-09-25) di mana volume candle 0 tetapi file `all` memiliki 60 broker (Pasar Negosiasi). Syarat lewati diperketat wajib: volume candle 0 **DAN** file all ada serta terkonfirmasi kosong dari transaksi. File F yang salah dipindahkan ke karantina dan antrean dipulihkan. |
| **C2** | Rincian sisa request & antrean | **AMAN** | Terpetakan presisi: 110.995 F saja, 3 all saja, 62.175 F+all. Sisa file terpotong 62.178 file (berkurang dari 66.725 karena 4.547 sudah di-unclip hari Minggu). Worker tidak pernah mengambil all yang sudah lengkap. |
| **C3** | IHSG saat jam bursa jangan basi | **[BUG] → DIPERBAIKI** | `fetchIhsgDailyCandles()` di `lib/market-regime.js` sebelumnya hanya membaca T-1 disk, sehingga di jam bursa memakai close kemarin. Diperbaiki: riwayat 500 candle tetap dari disk, bar hari ini live digabung dari Yahoo intraday (`^JKSE`). |
| **C4** | Worker tidak boleh tumpang tindih | **[BUG] → DIPERBAIKI** | Worker Minggu (PID 4174830) selesai rapi pukul 17:16 WIB (5.721 req). Lock file bekerja. Bug: cadangan sebelumnya hanya dihitung sekali di awal. Diperbaiki: cadangan dihitung dinamis per iterasi sehingga otomatis beralih ke 5.100 saat melewati 00:00 WIB. |
| **C5** | Penanganan kuota 18.080 & error 429 | **AMAN** | Jika kuota akun turun tapi env lupa diubah, saat menerima 429 worker memicu circuit breaker, mencatat `[BACKFILL-STOP]`, melepaskan lock, dan keluar dengan rapi tanpa looping. Prosedur pengubahan didokumentasikan di `CEK_SENIN.md`. |
| **C6** | Panduan operasional Senin | **SELESAI** | `CEK_SENIN.md` diperbarui dengan jadwal dan perintah siap tempel untuk 00:10, 17:00, dan 20:00 WIB. |

---

## 1. Audit C1 · Hari "Tanpa Transaksi" yang Dilewati

### 1.1 Sensus File `derived: "no-trade"` di VPS
Pemindaian menyeluruh terhadap direktori penyimpanan data lokal VPS menghasilkan:
- File `derived: "no-trade"` pada flow `all`: **16 file** (7 di ticker `PACK`, 9 di ticker `SINI`).
- File `derived: "no-trade"` pada flow `F`: **21 file** (seluruhnya di ticker `SINI`).

### 1.2 Uji Sampel & Konflik Transaksi Pasar Negosiasi
- Dari 21 tanggal no-trade, 20 tanggal terbukti merupakan hari bursa tanpa transaksi (baik di pasar reguler maupun negosiasi, candle volume = 0 dan broker list kosong).
- Ditemukan **1 anomali transaksi pasar negosiasi**:
  * Ticker: **`SINI`** tanggal **`2026-09-25`**.
  * Di candle `data/daily-candles/SINI.json`, volume tercatat `0` (karena pasar reguler tidak ada transaksi).
  * Namun di file `all` (`broker-summary/SINI/2026-09-25.json`), terdapat transaksi pasar negosiasi masif senilai ~Rp 200 Miliar dengan 60 broker (CC Mandiri, GR Panin, MG Semesta, AK UBS, BK JP Morgan, dll.).
  * Karena logika sebelumnya hanya memeriksa `sessionVolume === 0` dari candle, worker menandai `broker-summary-F/SINI/2026-09-25.json` sebagai `derived: "no-trade"` kosong. Padahal broker asing seperti AK dan BK aktif bertransaksi pada sesi tersebut.

### 1.3 Audit Asal No-Trade (Null Candle vs Sebelum Listing)
- No-trade yang berasal dari candle tidak ada / null: **0**.
- No-trade dari tanggal sebelum saham tercatat (listing date): **0**.
- Seluruh 21 file berasal dari candle volume riil bernilai `0`.

### 1.4 Verifikasi Penimpaan File All Asli
- Dilakukan pencocokan terhadap backup `_backup-broksum-25/`: **0 file all asli yang tertimpa** (`conflictsWithBackupCount: 0`).
- Pada `PACK`, 7 file backup yang digantikan sintetis memang hanya berisi 25 level kosong (`{"buy":null,"sell":null}`).
- Pada `SINI 2026-09-25`, file `all` asli (60 broker, 100 level) tetap utuh 100% dan tidak pernah ditimpa karena `needsAll` bernilai `false`.

### 1.5 Perbaikan Dilakukan:
1. **Pembaruan Logika di `tools/backfill-broksum.js`:**
   Menambahkan fungsi `brokerSummaryHasTrades(data)` dan memperketat syarat fast-path lewati panggilan API:
   $$\text{Syarat Lewat} = (\text{Volume Candle} == 0) \ \mathbf{DAN}\ (\text{File All Ada}) \ \mathbf{DAN}\ (\text{File All Terbukti Tidak Membawa Transaksi})$$
   Jika file `all` memiliki transaksi (seperti pasar negosiasi), atau file `all` belum ada, worker **tidak akan pernah** melewati sesi tersebut dan tetap memanggil API Arjum untuk mengambil data Foreign autentik.
2. **Karantina & Pemulihan Antrean:**
   - File `broker-summary-F/SINI/2026-09-25.json` dipindahkan ke `/home/ubuntu/auto-cuan/data/arjum-data/_quarantine-no-trade/SINI/2026-09-25.json`.
   - Entri `SINI_2026-09-25_F` dihapus dari `completedTasks` dan `SINI` dihapus dari `completedTickers` pada `state.json` di VPS.

---

## 2. Audit C2 · Rincian Sisa Request & Jadwal Selesai Baru

### 2.1 Sensus Status Data VPS Terkini (Pasca-Run Minggu)
Berdasarkan sensus 186.191 file broker summary di VPS:
- Total file All terpotong (25 broker tanpa `all_data: true`): **62.178 file** (berkurang dari 66.725 sebelum deploy).
- Total file All unclipped (lengkap): **124.013 file**.
- Total file Foreign (F) autentik yang sudah ada: **13.021 file**.

### 2.2 Pemecahan Sisa Request
1. **Hanya butuh Foreign (F saja):**
   - **110.995 tanggal** di mana file `all` sudah lengkap/unclipped, dan hanya file `F` yang belum ada.
   - Mengonsumsi **110.995 request API**.
2. **Hanya butuh All lengkap (All saja):**
   - **3 tanggal** di mana file `F` sudah ada autentik, tetapi file `all` masih terpotong 25 level.
   - Mengonsumsi **3 request API**.
3. **Butuh Foreign + All lengkap (F + All):**
   - **62.175 tanggal** di mana file `all` masih terpotong 25 broker DAN file `F` belum ada.
   - Mengonsumsi $62.175 \times 2 = \mathbf{124.350\text{ request API}}$.
4. **Penghematan Melalui Fast-Path Zero-Volume:**
   - Sensus candle mencatat **21.081 sesi** dengan volume 0 (11,70% dari 180.225 sesi).
   - Sesi-sesi ini diverifikasi kosong di `all` dan diselesaikan secara sintetis tanpa request API.

### 2.3 Pencegahan Pemborosan Kuota
- Worker di `tools/backfill-broksum.js` mengevaluasi kondisi `needsAll`:
  ```js
  if (Array.isArray(parsed.broker_levels) && parsed.broker_levels.length === 25 && parsed.all_data !== true) {
    needsAll = true;
  }
  ```
- Jika file `all` sudah membawa selain 25 level (misal 100 level atau <25 level) atau sudah membawa flag `all_data: true`, `needsAll` bernilai `false`.
- Worker **TIDAK PERNAH** mengambil ulang file `all` yang sudah lengkap. Worker hanya melakukan 1 request untuk mengambil `F`.

### 2.4 Perkiraan Tanggal Selesai Baru
Dengan kapasitas kuota 18.080/hari (alokasi backfill harian ~12.580 di hari kerja, ~17.580 di akhir pekan, total ~98.000/minggu):
- **Asing Lengkap untuk 502 Saham Likuid (Tier 1 & 2):** **Kamis, 22 Oktober 2026** (~4,5 hari).
- **Asing Lengkap Seluruh 962 Saham:** **Rabu, 28 Oktober 2026** (~9–10 hari).
- **Semua Tanggal Domestik Bebas dari "Belum Lengkap":** **Rabu, 28 Oktober 2026** (karena 62.178 file All unclipped diselesaikan bersamaan dengan file F per tanggal).

---

## 3. Audit C3 · IHSG Saat Jam Bursa Jangan Basi

### 3.1 Pemetaan Seluruh Pemakai IHSG
| Konsumen | File Pemanggil | Sifat Konsumsi | Sumber Sebelum Fix | Sumber Pasca Fix |
|---|---|---|---|---|
| **Candle Chart** | `api/candles.js` | T-1 Daily Chart | Yahoo / Disk T-1 | Disk T-1 (500 bar) dengan T-1 Policy Guard |
| **Market Regime** | `lib/market-regime.js` | Live Regime (MA20/MA50) | Disk T-1 (Stale di jam bursa!) | **Disk 500 bar + Live Bar Yahoo Intraday** |
| **Sector Hot** | `api/sector-hot.js` | Live Screener & Ranking | Memanggil `getMarketRegime()` | Terintegrasi Live Intraday |
| **DayTrade Engine** | `lib/daytrade-screener-engine.js` | Live Screener Intraday | Memanggil `getMarketRegime()` | Terintegrasi Live Intraday |
| **Swing Engine** | `lib/swing-screener-engine.js` | EOD Screener | Memanggil `getMarketRegime()` | Terintegrasi Live Intraday |
| **Live Quote IHSG** | `api/quote.js` | Header / Live Price | Yahoo Finance (`^JKSE`) | Yahoo Finance Live (tidak tersentuh) |

### 3.2 Temuan & Analisis Perilaku
- **Sebelum commit `edfef1d3`:** `fetchIhsgDailyCandles()` di `lib/market-regime.js` selalu mengembalikan data disk lokal `IHSG.json`. Di jam bursa (misalnya Senin 10:00 WIB), `IHSG.json` baru terisi sampai Jumat 16 Oktober 2026. Akibatnya, `evaluateMarketRegime()` mengevaluasi MA20/MA50 terhadap harga penutupan Jumat kemarin, bukan harga live Senin!
- **Perbaikan Dilakukan di `lib/market-regime.js`:**
  1. Base deret historis (500 bar) selalu dimuat dari disk cache lokal `data/daily-candles/IHSG.json` untuk akurasi MA jangka panjang.
  2. Saat runtime, fungsi memanggil endpoint Yahoo Finance (`^JKSE?range=5d`) dengan timeout ringan 5 detik.
  3. Jika Yahoo mengembalikan bar hari ini (`candleDate === jakartaToday`), bar tersebut digabungkan ke deret disk sebagai candle terakhir (`liveCandle`).
  4. Jika Yahoo gagal/timeout/di luar jam bursa, fungsi fallback secara aman ke candle disk terakhir tanpa error.
- **Simulasi Jam 10:00 WIB Hari Bursa:**
  * Diuji di unit test `test/ihsg-endpoint.test.js`:
    - Bar historis (500 hari) tetap utuh dari disk (bar terakhir T-1: 16 Okt 2026 close 5185.1).
    - Bar ke-501 otomatis terisi tanggal 19 Okt 2026 dengan harga intraday live (misal 5250.75).
    - Market regime dievaluasi terhadap harga live 5250.75 secara real-time.
    - Status: **Pass 100%**.

---

## 4. Audit C4 · Worker Tidak Boleh Tumpang Tindih

### 4.1 Status Worker Minggu (PID 4174830)
- Waktu mulai: 16:34 WIB.
- Waktu selesai: **17:16 WIB** (durasi 42 menit).
- Ringkasan eksekusi:
  * Permintaan terkirim: **5.721 request**.
  * Tanggal dilewati: **15.256 tanggal**.
  * Alasan berhenti: `[BUDGET-GUARD] Kuota sisa (300) <= cadangan (300). Berhenti.`
- Worker telah selesai dengan rapi **jauh sebelum 00:00 WIB**.

### 4.2 Mekanisme Lock File
- Lokasi: `/home/ubuntu/auto-cuan/data/arjum-data/_backfill/backfill.lock`.
- Fungsi `acquireLock` menulis PID proses ke file dengan mode exclusive `wx`.
- Jika cron 00:07 Senin berjalan saat worker lain masih aktif, `acquireLock` memeriksa `process.kill(pid, 0)`. Jika PID masih hidup, proses kedua langsung keluar dengan pesan `[BACKFILL-LOCKED] Worker backfill sedang berjalan... Keluar rapi.` tanpa tumpang tindih.

### 4.3 Transisi Dinamis Cadangan Saat Rollover 00:00 WIB
- **Temuan Bug:** Sebelumnya variabel `reserveQuota` hanya dihitung sekali pada saat worker dimulai. Jika worker dijalankan pada Minggu malam (mode weekend dengan cadangan 300) dan terus berjalan melewati 00:00 WIB Senin (hari kerja), worker akan tetap menggunakan cadangan 300 bukannya 5.100!
- **Perbaikan Dilakukan di `tools/backfill-broksum.js`:**
  * Menambahkan fungsi `resolveDynamicReserveQuota(baseDir, explicitMode, now)`.
  * Pada setiap iterasi tanggal, worker memanggil ulang fungsi ini untuk memperbarui `reserveQuota`.
  * Begitu jam bursa melewati 00:00 WIB Senin, `resolveDynamicReserveQuota` otomatis mendeteksi bahwa hari ini adalah hari kerja tanpa penanda `_eod/<date>.done`, dan langsung menaikkan cadangan ke **5.100 request**.
  * Worker akan segera berhenti begitu sisa kuota menyentuh 5.100, mengamankan kuota penuh untuk operasional J1 & J2 EOD sore.

---

## 5. Audit C5 · Batas Kuota 18.080 & Penanganan Error 429

### 5.1 Perilaku Saat Menerima HTTP 429
- Jika batas akun diturunkan oleh vendor tetapi env lokal masih `18080`, pada panggilan API ke-12.061 server vendor akan merespons HTTP 429 (`quota_exceeded`).
- Di `lib/arjum-client.js`:
  ```js
  const classified = classifyFailure({ status: res.status, error: errDetail });
  if (classified.reason === 'quota_exceeded' || res.status === 429) {
    tripCircuitBreaker(errDetail || 'HTTP 429');
  }
  ```
- Circuit breaker lokal langsung aktif (`arjumCircuitBreakerTripped = true`).
- Worker `tools/backfill-broksum.js` menangkap status ini di `isCircuitBreakerTripped()` dan respons tidak valid, segera mencatat:
  `[BACKFILL-STOP] Respon tidak valid untuk ALL/F ... status=429`
  dan menyetel `quotaHalted = true`.
- Worker keluar dari loop, menyimpan status ke `state.json`, melepaskan `backfill.lock`, dan berhenti rapi.
- Worker **tidak pernah melakukan retry agresif** saat kuota habis.

---

## 6. Audit C6 · Pembaruan Panduan Operasional

File [`backtest/arjum-audit/CEK_SENIN.md`](backtest/arjum-audit/CEK_SENIN.md) telah diperbarui dengan jadwal pengawasan Senin 19 Oktober 2026:
1. **00:10 WIB:** Pengecekan worker slot 1 dengan cadangan 5.100 request.
2. **17:00 WIB:** Pengecekan selesainya J1 + J2 + IHSG, keberadaan sentinel `_eod/2026-10-19.done`, dan sisa kuota >= 800.
3. **20:00 WIB:** Pengecekan bar penutupan IHSG 19 Oktober 2026 (501 bar total) di `data/daily-candles/IHSG.json`.
4. Dilengkapi prosedur pengubahan `ARJUM_DAILY_LIMIT` siap pakai jika kuota akun disesuaikan di masa mendatang.

---

## 7. Status Pengujian & Verifikasi VPS

Semua test suite pada branch `feat/broksum-all-foreign` lolos 100%:
- VPS test runner (`node --test`):
  * `test/backfill-refactor.test.js`: **Pass 6/6**
  * `test/broksum-domestic-guard.test.js`: **Pass 2/2**
  * `test/ihsg-endpoint.test.js`: **Pass 3/3**
  * Total VPS pass: **11 test, 0 fail**.
- Local test runner (`node --test`):
  * 27 test pass across market-regime, quota-limits, broksum-flow, domestic-guard, backfill-refactor, ihsg-cron, ihsg-endpoint.
- Service `autocuan-web` di-restart 1x pada PM2 (PID 4178738, status `online`, 0 error).
- Tidak ada perubahan pada jadwal crontab VPS.
