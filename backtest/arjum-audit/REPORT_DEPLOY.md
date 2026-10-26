# LAPORAN DEPLOYMENT PRODUKSI: BRANCH BROKSUM ALL + FOREIGN & PERBAIKAN PETA CRON

**Tanggal & Waktu Deploy:** Minggu, 18 Oktober 2026, 09:15 WIB (02:15 UTC)  
**Target Lingkungan:** VPS Produksi Oracle Ubuntu (`168.110.221.197`)  
**Git Tag Pra-Deploy:** [`pre-broksum-deploy-20261018`](deploy/vps/final-schedule.cron) (berbasis commit `64ca84a1`)  
**Branch Terdeploy:** [`feat/broksum-all-foreign`](deploy/vps/final-schedule.cron)  
**HEAD Commit:** `13b8e5a1` (`chore(cron): update final-schedule.cron for broksum deploy`)  
**Status Layanan:** `autocuan-web` (PM2 PID `4162975`) online & responsif (HTTP 200 OK)  

---

## 1. Ringkasan Eksekutif

Deployment ini menyelesaikan modernisasi infrastruktur broker summary (broksum) Auto-Cuan dengan penghematan kuota API hingga 67% sekaligus menyelesaikan 4 temuan penting dari audit peta cron:
1. **Pengumpulan Data Hemat Kuota:** Sistem kini hanya mengambil aliran **All** (`all_data=true`) dan **Foreign (F)** (`flow=F&all_data=true`), sedangkan data **Domestik (D)** dihitung secara lokal via modul fungsional deterministik ($D = \text{All} - F$) dengan paritas matematis 100% (selisih Rp 0).
2. **Backfill Historis Asing Selesai:** Seluruh data broker summary asing untuk 962 emiten sejak 2 Januari 2026 telah rampung diunduh (180.856 request terkirim tanpa melanggar batasan kuota).
3. **Penyatuan Penulis Akumulasi (Single Writer):** Mengeliminasi konflik multi-writer antara J1 dan J3 dengan menetapkan API Arjum sebagai satu-satunya penulis resmi hingga backfill data unclipped selesai.
4. **Perlindungan Kuota & Log:** Sentinel EOD dinamis (`_eod/<date>.done`) melindungi pass EOD malam (23:30 WIB) dari defisit kuota, dan logging `vps_local_cache_stale` pada `autocuan-web` diredam agar tidak membanjiri disk.

---

## 2. Status Implementasi 4 Temuan Audit Peta Cron

### 2a. Broker Accumulation Writer Unity & Uji Paritas
- **Uji Paritas 5 Saham:** Dilakukan pengujian komparasi antara modul akumulasi lokal (`brokerAccumulationLocal`) dengan data API resmi Arjum untuk 5 saham uji (`BRPT`, `BBCA`, `MEDC`, `ADRO`, `CASH`):
  * `BRPT`: 84% kesesuaian titik tanggal
  * `BBCA`: 78% kesesuaian titik tanggal
  * `MEDC`: 72% kesesuaian titik tanggal
  * `ADRO`: 70% kesesuaian titik tanggal
  * `CASH`: 65% kesesuaian titik tanggal
- **Akar Masalah:** File broker summary historis yang ada di disk saat ini masih terkliping 25 level (menyebabkan deviasi akumulasi ~3.77% omzet). Akumulasi internal Arjum dihitung dari data order book bursa penuh.
- **Keputusan Desain:** Sesuai aturan prompt, **API Arjum ditetapkan sebagai Single Writer resmi** (`ACCUM_SOURCE=api`). Generator lokal `tools/generate-broker-accumulation.js` (J3) dinonaktifkan dari crontab untuk mencegah inkonsistensi skema dan race condition. Local accumulation disiapkan sebagai fallback pasca-backfill unclipped.

### 2b. Kebijakan Insider & Perlindungan `latest.json`
- **Kebijakan Frekuensi:** Tetap berjalan **Harian** untuk seluruh emiten aktif (`INSIDER_MODE=daily`) memanfaatkan kapasitas kuota 16.000 req/hari yang masih sangat mencukupi (pengeluaran J1 saat ini ~2.628 req/hari). Opsi `weekly` (100 prioritas harian + all weekend) telah disiapkan dalam flag `--insider-mode=weekly` namun tidak diaktifkan.
- **Perlindungan `latest.json`:** Pada [`tools/run-daily-broker-update.js`](tools/run-daily-broker-update.js:630), ditambahkan logika `latestInsiderTradeDate`. Jika respons Arjum tidak memuat transaksi baru setelah tanggal transaksi terakhir yang telah tersimpan, dated snapshot distempel dengan `no_new_insider_trades: true`, dan file `latest.json` dipertahankan tidak digeser maju secara keliru.

### 2c. Guard Window J1, Sentinel EOD, & Cadangan Kuota Dinamis
- **Analisis Slot 16:45–23:30 WIB:** Slot pukul 16:30 dan 16:45 WIB terbukti aman karena memiliki guard otomatis `hour < 18` di level data, sehingga tidak pernah membakar kuota jika bursa belum merilis broker summary.
- **Sentinel EOD:** Pada [`tools/run-daily-market-update.js`](tools/run-daily-market-update.js:45), koordinator kini menulis sentinel persisten `data/arjum-data/_eod/<date>.done` segera setelah tahapan broker, candle, dan history sync selesai untuk tanggal tersebut.
- **Cadangan Kuota Dinamis Backfill:** Pada [`tools/backfill-broksum.js`](tools/backfill-broksum.js:60):
  * **Sebelum `.done` ada (Hari Kerja):** Cadangan dinaikkan menjadi **4.500 request** untuk menjamin pass EOD sore dan pass final 23:30 WIB selalu memiliki kuota yang cukup.
  * **Setelah `.done` ada (Hari Kerja):** Cadangan otomatis turun menjadi **800 request**.
  * **Hari Libur Kerja / Weekend:** Otomatis beralih ke mode `weekend` dengan cadangan minimal **300 request**.

### 2d. Verifikasi Kesegaran Sector Hot
- **Investigasi:** Diperiksa file `data/sector-hot-*.json`, tabel Supabase `idx_sector_hot_history`, dan skrip [`scripts/refresh-sector-hot.js`](scripts/refresh-sector-hot.js:1).
- **Hasil:** Data sektor berjalan sehat dan segar, terakhir diperbarui pada Jumat 16 Okt 2026 pukul 15:31 WIB via Yahoo Finance langsung ke database Supabase. File `sector-hot-2026-09-22.done` di disk adalah penanda statis legacy dari rilis Fase 9 yang tidak dipakai oleh pipeline runner aktif. Tidak ada kuota Arjum yang dipakai oleh fitur ini (0 req).

### 2e. Reduksi Log Noise `vps_local_cache_stale` (8.21 MB)
- **Klasifikasi:** Ditetapkan sebagai **NOISE** logging, bukan bug logika. Noise terjadi karena pengecekan VWAP snapshot di [`lib/vps-data-fetcher.js`](lib/vps-data-fetcher.js:890) selalu mencatat warning ke `autocuan-web-error.log` setiap kali cache offline diakses saat bridge tidak aktif.
- **Perbaikan:**
  * Diintegrasikan dengan [`lib/market-hours-guard.js`](lib/market-hours-guard.js:18).
  * Di luar jam bursa resmi IDX: warning **tidak dicatat sama sekali** (0 baris log).
  * Selama jam bursa: logging diredam (throttled) dengan ambang batas **maksimal sekali per 10 menit** dengan level `warn`. File log fisik tidak dihapus (integritas audit terjaga).

---

## 3. Hasil Pengujian Pra-Deploy (Langkah 3)

| Komponen Uji | Target Verifikasi | Hasil | Keterangan |
|---|---|---|---|
| Unit Test Flow | `test/broksum-flow.test.js` | **PASS (2/2)** | Paritas $D = \text{All} - F$ bit-exact 0 selisih |
| Regresi Komit 020c5f82 | `test/bandarmologi-integration.test.js` | **PASS (31/31)** | Menjamin flow `All` tidak pernah dijumlahkan lokal |
| Cache & Ingestion Guard | `test/audit-fase3-ingestion-cache-bugs.test.js` | **PASS (11/11)** | Snapshot stale tetap terdeteksi & labelled jujur |
| Throttling Log 2e | `backtest/arjum-audit/test_2e.js` | **PASS (4/4)** | 0 warning di luar jam bursa, throttled 10m saat live |
| Dry-Run Coordinator | `tools/run-daily-broker-update.js --dry-run` | **PASS (0 err)** | Target 16 Okt selesai tanpa error runtime |
| Staging 10 Saham VPS | BBCA, BBRI, BMRI, BBNI, TLKM, ASII, BRPT, MEDC, ADRO, CASH | **PASS (10/10)** | Format All, F, D, Accum, Insider terverifikasi lengkap |
| UI Web Lokal | `bandarmologiService.getBandarmologiData` | **PASS (10/10)** | Respons disk <10ms, tab All, F, D terbuka sempurna |

---

## 4. Diff Crontab Produksi (Langkah 5)

Berikut perbandingan resmi crontab sebelum vs sesudah deployment:

```diff
--- /home/ubuntu/crontab.backup-20261018.txt	2026-10-18 00:55:01 WIB
+++ crontab (terpasang aktif)	2026-10-18 09:14:59 WIB
@@ -1,7 +1,7 @@
-# BEGIN AUTO-CUAN FINAL SCHEDULE — 4 PILAR (LIVE vs EOD) — 2026-10-13
+# BEGIN AUTO-CUAN FINAL SCHEDULE — 4 PILAR (LIVE vs EOD) — 2026-10-18
 # Timezone: Asia/Jakarta (WIB = UTC+7). Semua jam di bawah adalah WIB.
 # Live bursa: 09:00-16:00 WIB (02:00-09:00 UTC) — hanya FastWatcher & Daytrade
 #
-# REVISI 2026-10-13 (audit 1-12 Okt):
+# REVISI 2026-10-18 (Deploy branch feat/broksum-all-foreign):
+#   * J1: EOD update memakai --accum-source=api --insider-mode=daily.
+#     Menyimpan broker-summary All (unclipped) + Foreign (F) + kalkulasi Domestik (D=All-F).
+#   * J3: Generator lokal broker-accumulation dinonaktifkan (J1 single writer).
+#   * Backfill otomatis harian & akhir pekan (00:07 & 19:30 WIB) ditambahkan.
 CRON_TZ=Asia/Jakarta
 
 # ── INFRA HARIAN ──────────────────────────────────────────────────────────
 # Backfill candle historis (tengah malam)
 5 0 * * * /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-historical-candles.js --max-requests=2500 >> /home/ubuntu/auto-cuan-runner/logs/backfill-candles.log 2>&1
+
+# Backfill otomatis broker summary asing (Hari kerja slot 1: 00:07 WIB)
+7 0 * * 1-5 /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-broksum.js --mode=weekday --only-foreign >> /home/ubuntu/auto-cuan-runner/logs/backfill-broksum-foreign.log 2>&1
+
+# Backfill otomatis broker summary asing (Hari kerja slot 2: 19:30 WIB)
+30 19 * * 1-5 /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-broksum.js --mode=weekday --only-foreign >> /home/ubuntu/auto-cuan-runner/logs/backfill-broksum-foreign.log 2>&1
+
+# Backfill otomatis broker summary asing (Akhir pekan: Sabtu & Minggu 00:07 WIB)
+7 0 * * 6,0 /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-broksum.js --mode=weekend --only-foreign >> /home/ubuntu/auto-cuan-runner/logs/backfill-broksum-foreign.log 2>&1
+
 # Lifecycle evaluator (sore, setelah bursa tutup)
 30 16 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-lifecycle-evaluator.sh --apply >> /home/ubuntu/auto-cuan-runner/logs/lifecycle-evaluator.log 2>&1
 
 # ── EOD MARKET DATA / BROKSUM INGESTION (16:30-17:30 WIB) ─────────────────
-30,45 16 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
-0,15,30,45 17 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
-30 23 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --final >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
+30,45 16 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --accum-source=api --insider-mode=daily >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
+0,15,30,45 17 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --accum-source=api --insider-mode=daily >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
+30 23 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --final --accum-source=api --insider-mode=daily >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
 
-# ── KALKULASI AKUMULASI BANDAR (tepat 18:00 WIB) ──────────────────────────
-# 0 18 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-broker-accumulation.sh >> /home/ubuntu/auto-cuan-runner/logs/broker-accumulation.log 2>&1
+# ── KALKULASI AKUMULASI BANDAR (DINONAKTIFKAN — 2026-10-18) ───────────────
+# J1 adalah single writer resmi ke data/arjum-data/broker-accumulation/ via API.
+# Generator lokal J3 dinonaktifkan untuk mencegah race condition / double-write.
+# 0 18 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-broker-accumulation.sh >> /home/ubuntu/auto-cuan-runner/logs/broker-accumulation.log 2>&1
```

---

## 5. Status Layanan Pasca-Deploy & Uji Live

Pengecekan live di VPS produksi menunjukkan seluruh servis berjalan normal:
- **`autocuan-web`:** Online, memory 75 MB (sehat), respons HTTP 200 OK.
- **Endpoint Bandarmologi:**
  ```bash
  curl -s "http://127.0.0.1:3000/api/sector-hot?action=bandarmologi&ticker=BBCA&date=latest&flow=F"
  # Mengembalikan data Foreign BBCA dengan status from_cache: true, is_demo: false, latensi <10ms
  
  curl -s "http://127.0.0.1:3000/api/sector-hot?action=bandarmologi&ticker=BBCA&date=latest&flow=D"
  # Mengembalikan data Domestik BBCA hasil komputasi All - F dengan status from_cache: true, latensi <10ms
  ```

---

## 6. Prosedur Rollback Cepat

Jika operator mendapati kendala kritis pada hari Senin 19 Oktober 2026, lakukan prosedur rollback 4 langkah berikut:
```bash
# 1. Kembali ke git tag pra-deploy
cd /home/ubuntu/auto-cuan
git checkout pre-broksum-deploy-20261018

# 2. Pulihkan konfigurasi crontab lama
crontab /home/ubuntu/crontab.backup-20261018.txt

# 3. Restart web server
pm2 restart autocuan-web

# 4. Verifikasi status
pm2 list
curl -I -s http://127.0.0.1:3000
```
*(Catatan: File cache di `broker-summary/` dan `broker-summary-F/` bersifat backward-compatible dan tidak perlu dihapus).*
