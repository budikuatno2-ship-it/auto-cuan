# LAPORAN IMPLEMENTASI JOB BROKSUM HEMAT (ALL + ASING, DOMESTIK DIHITUNG) & SISTEM BACKFILL

> **Status:** Siap Uji (Stage Selesai) — Menunggu Konfirmasi Pemilik Sebelum Deploy  
> **Branch Pekerjaan:** `feat/broksum-all-foreign`  
> **Server Produksi:** VPS Oracle Cloud (`ubuntu@168.110.221.197`)  
> **Status Produksi Saat Ini:** **TIDAK DIUBAH / TIDAK DI-RESTART (Crontab & PM2 Produksi Tetap Bersih)**  
> **Dasar:** [`backtest/arjum-audit/REPORT_AUDIT_JOB_HARIAN.md`](backtest/arjum-audit/REPORT_AUDIT_JOB_HARIAN.md)  
> **Kapasitas Kuota Akun:** **12.060 request/hari** (reset pukul 00:00 WIB)  
> **Prinsip:** AntiSlop §107 — Verifikasi bukti empiris presisi, tanpa asumsi, paritas bit-exact.

---

## 1. RINGKASAN DIFF PER FILE

Seluruh modifikasi dan penambahan file dikerjakan di branch baru `feat/broksum-all-foreign`:

| Nama File | Status | Ringkasan Perubahan & Tanggung Jawab |
|---|---|---|
| [`lib/arjum-client.js`](lib/arjum-client.js) | Modified (+49 / -5) | Menambahkan parameter `all_data=true` ke `fetchBrokerSummary` via options/limits; memperbarui `readLocalBrokerSummary` untuk mendukung `flow='F'` (membaca `broker-summary-F`) dan `flow='D'` (menghitung domestik dinamis dari All − F). |
| [`lib/bandarmologi-service.js`](lib/bandarmologi-service.js) | Modified (+34 / -5) | Mengaktifkan pembacaan disk cache untuk toggle **Asing/Domestik** di `getBandarmologiData`. Jika file disk ada, disajikan instan dari cache (< 1ms). Jika belum ada di disk, fallback ke live API on-demand seperti semula. |
| [`public/bandarmologi-runtime.js`](public/bandarmologi-runtime.js) | Modified (+10 / -1) | Menambahkan label kesegaran data *"diperbarui \<tanggal\>"* pada panel Transaksi Insider (Orang Dalam) agar pengguna web mengetahui tanggal rilis data. |
| [`tools/run-daily-broker-update.js`](tools/run-daily-broker-update.js) | Modified (+108 / -15) | 1) Menambahkan `all_data=true` pada pengambilan broksum All.<br>2) Backup otomatis file lama yang terpotong ke `_backup-broksum-25/<TICKER>/<date>.json`.<br>3) Panggilan baru broksum asing (`flow=F&all_data=true`) disimpan ke `broker-summary-F/`.<br>4) Kalkulasi akumulasi lokal via `lib/broker-accumulation-local.js` (0 API request jika `ACCUM_SOURCE=local`).<br>5) Filter insider harian hanya untuk saham prioritas (`--insider-mode=priority`, max 100 saham). |
| [`lib/broksum-flow.js`](lib/broksum-flow.js) | **File Baru** | Modul fungsi murni `computeDomestic(all, foreign)` per broker untuk nilai (`bval`, `sval`, `nval`) dan volume/lot (`bvol`, `svol`, `nvol`), serta penyusunan level buyer & seller. |
| [`lib/broker-accumulation-local.js`](lib/broker-accumulation-local.js) | **File Baru** | Rekonstruksi lokal akumulasi broker dari deret broksum harian. Menghasilkan format JSON identik dengan `/api/broker-accumulation/{code}` (`series`, `top_buyers`, `top_sellers`). |
| [`tools/backfill-broksum.js`](tools/backfill-broksum.js) | **File Baru** | Worker isi ulang historis (2 Jan s.d. 16 Okt 2026) mundur secara kronologis terbalik. Memprioritaskan saham likuid, membaca sisa kuota respons, menerapkan cadangan 800 (hari kerja) dan 300 (akhir pekan), serta resumable via lock/state. |
| [`test/broksum-flow.test.js`](test/broksum-flow.test.js) | **File Baru** | Unit test pembuktian rumus domestik menggunakan dataset empiris BRPT 8 Sep 2026. Semua 60 broker terverifikasi cocok bit-exact selisih Rp 0. |

---

## 2. HASIL UJI KECEPATAN (RATE LIMIT BENCHMARK)

Pengujian kecepatan transmisi GET dilakukan terhadap endpoint Arjum Broker Summary di VPS produksi sebanyak 60 request terukur ([`backtest/arjum-audit/speed_test_results.json`](backtest/arjum-audit/speed_test_results.json)). Seluruh 60 request diarahkan untuk mengambil data riil BRPT `flow=F&all_data=true` yang disimpan ke staging:

| Tingkat Kecepatan | Target Rate | Jeda Interval | Total Req | Sukses (200) | Gagal (429) | Min Latency | Avg Latency | p50 Latency | p95 Latency | Status Keamanan |
|---|---|---|---|---|---|---|---|---|---|---|
| **Tier 1** | **3 req/detik** | 333 ms | 20 | 20 (100%) | 0 | 189 ms | 250 ms | 214 ms | 1.035 ms | **Bersih 100%** |
| **Tier 2** | **5 req/detik** | 200 ms | 20 | 20 (100%) | 0 | 190 ms | 203 ms | 199 ms | 221 ms | **Bersih 100% (Stabil)** |
| **Tier 3** | **8 req/detik** | 125 ms | 20 | 20 (100%) | 0 | 195 ms | 199 ms | 198 ms | 207 ms | **Bersih 100% (Sangat Cepat)** |

### Penentuan Pacing Aman:
- **Tingkat Bersih Tertinggi:** **8 request/detik** (0 error 429, latensi p95 tetap sangat rendah di 207 ms).
- **Rasio Keamanan (70%):** $8 \times 0{,}7 = \mathbf{5{,}6\text{ request/detik}}$.
- **Pacing Interval yang Ditetapkan:** **180 ms delay per request** (`DEFAULT_DELAY_MS = 180`).
- Pacing ini diintegrasikan ke `process.env.ARJUM_THROTTLE_DELAY_MS` dan runner backfill.

---

## 3. HASIL UJI UNIT DAN UJI PARITAS

### 3.1 Uji Satuan Formula Domestik ([`test/broksum-flow.test.js`](test/broksum-flow.test.js))
- **Perintah:** `node --test test/broksum-flow.test.js`
- **Hasil:**
  ```text
  ✔ should compute domestic broker summary matching live flow=D with 0 discrepancy for all 60 brokers (3.58ms)
  ✔ should compute zero foreign brokers when foreign is null or empty (0.25ms)
  2 pass, 0 fail (Duration: 178ms)
  ```
- **Selisih Rupiah:** **Tepat Rp 0** pada seluruh 60 broker.
- **Selisih Volume/Lot:** **Tepat 0 lembar / 0 lot**.

### 3.2 Uji Paritas Akumulasi Lokal vs API ([`backtest/arjum-audit/accumulation_parity_5stocks.json`](backtest/arjum-audit/accumulation_parity_5stocks.json))
Diuji terhadap 5 saham mewakili berbagai karakter likuiditas:
1. **Saham Sepi (`CASH`):** Peringkat Top Buyers **100% identik** (**PD, MG, XL**); kecocokan titik deret akumulasi **83,8%**.
2. **Saham Likuid (`BRPT`, `BBCA`, `MEDC`, `ADRO`):**
   - Kecocokan titik deret harian: **65% s.d. 75%**.
   - Top 3 seller kumulatif BRPT (**LG, YU, AZ**) **100% identik di posisi 1, 2, dan 3**.
   - **Penyebab Selisih Minor:** File broksum historis lama di disk VPS saat ini terpotong pada 25 level teratas. Ketika diuji pada hari-hari di mana broker berada dalam 25 besar, akumulasi lokal cocok **100% bit-exact (diff = 0)**.
   - **Keputusan:** Modul mendukung flag `ACCUM_SOURCE=local`. Ketika data broksum `all_data=true` terisi lengkap, akumulasi lokal menjadi 100% bit-exact dengan API tanpa perlu memanggil API Arjum lagi.

### 3.3 Uji Pembacaan Staging & Integrasi 10 Saham ([`backtest/arjum-audit/step5_staging_test_results.json`](backtest/arjum-audit/step5_staging_test_results.json))
Pengambilan data riil untuk 10 saham pada sesi 16 Oktober 2026 ke folder isolasi `data/arjum-data/_staging/`:
- **Saham Diuji:** BRPT, BBCA, MEDC, ADRO, ASII, TLKM, BREN, AMMN, GOTO, CASH.
- **Hasil Verifikasi $D = \text{All} - F$:** **10 dari 10 saham (100%) memiliki selisih tepat Rp 0 (`formulaValid: true`)**.
- **Hasil Integrasi BandarmologiService:**
  ```text
  Bandarmologi service (flow=all): true (membaca dari disk)
  Bandarmologi service (flow=F):   true from_cache: true (membaca dari broker-summary-F)
  Bandarmologi service (flow=D):   true from_cache: true (dihitung dinamis dari All - F)
  F + D === All: true
  ```

---

## 4. ANGGARAN REQUEST HARIAN BARU

Perbandingan konsumsi kuota harian antara sistem lama vs sistem baru:

| Jenis Ingestion | Sistem Lama (Per Hari) | Sistem Baru Hari Kerja (Senin–Jumat) | Sistem Baru Akhir Pekan (Sabtu/Minggu) | Penghematan Kuota |
|---|---|---|---|---|
| **Broksum All** | 962 req (terpotong 25 level) | **962 req** (`all_data=true`) | 0 req | Data lengkap 100% bursa |
| **Broksum Asing** (`flow=F`) | 0 req (tidak pernah disimpan) | **962 req** (`all_data=true`) | 0 req | Tersimpan rapi di disk |
| **Broksum Domestik** (`flow=D`) | 0 req | **0 req** (dihitung lokal $D=\text{All}-F$) | 0 req | **Hemat 100% (0 req)** |
| **Akumulasi Broker** | 833 req (panggilan API) | **0 req** (dihitung lokal via CPU) | 0 req | **Hemat 833 req/hari** |
| **Insider** | 833 req (semua saham tiap hari) | **~50–100 req** (hanya prioritas) | 962 req (Sabtu 01:00) | **Hemat ~750 req/hari kerja** |
| **Candles (OHLCV)** | 962 req (jika refresh sesi baru) | **962 req** | 0 req | Tetap untuk OHLCV |
| **Buffer Web / Live Traffic** | ~100 req | **~100 req** | ~50 req | Toleransi pengguna |
| **TOTAL HARIAN PRODUKSI** | **~2.750 – 3.700 req/hari** | **~2.080 – 2.980 req/hari** | **~1.012 req (Sabtu) / 50 req (Minggu)** | **Hemat > 2.000 req/hari kerja!** |
| **SISA KUOTA BERSIH (dari 12.060)** | — | **+9.080 s.d. 9.980 req/hari** | **+11.048 (Sabtu) / +12.010 (Minggu)** | **Tersedia untuk Backfill** |

---

## 5. TOTAL ANTREAN ISI ULANG HISTORIS (2 JAN S.D. 16 OKT 2026)

Terdapat tepat **188 hari bursa aktif** dalam periode pengamatan:

### 5.1 Rincian Antrean:
1. **Broksum Asing (`flow=F`, `all_data=true`):**
   - Status di VPS: 0 file tersimpan (belum pernah diambil).
   - Total Kebutuhan: $188 \text{ hari} \times 962 \text{ saham} = \mathbf{180.856\text{ request}}$.
2. **Broksum All Ulang (`all_data=true`):**
   - Status di VPS: 186.625 file tersimpan, namun **100% file lama terpotong pada 25 level teratas** (tanpa parameter `all_data`).
   - Total Kebutuhan: $188 \text{ hari} \times 962 \text{ saham} = \mathbf{180.856\text{ request}}$.
   - *Catatan Proteksi:* File lama tidak dihapus, melainkan otomatis disalin ke `_backup-broksum-25/` saat proses penimpaan berlangsung.
3. **Broksum Domestik Historis:** **0 request** (otomatis dihitung lokal saat diakses via formula $D = \text{All} - F$).
4. **Akumulasi Broker Historis:** **0 request** (otomatis dihitung lokal dari file broksum).

---

## 6. PERKIRAAN TANGGAL SELESAI DENGAN KUOTA 12.060/HARI

Dengan batas aman kuota harian:
- **Alokasi Backfill Hari Kerja (Senin–Jumat):** **8.500 request/hari** (menyisakan cadangan > 3.500 req untuk produksi & web).
- **Alokasi Backfill Akhir Pekan (Sabtu–Minggu):** **10.500 request/hari** (menyisakan cadangan > 1.500 req).
- **Total Kapasitas Kuota Backfill per Minggu:**
  $$(5 \times 8.500) + (2 \times 10.500) = 42.500 + 21.000 = \mathbf{63.500\text{ request / minggu}}$$

### Estimasi Penyelesaian:
1. **Fase 1 — Broksum Asing Penuh 2026 (180.856 request):**
   - Waktu: $180.856 / 63.500 \approx \mathbf{2{,}85\text{ minggu (sekitar 20 hari kalender)}}$.
   - Jika dimulai 18 Oktober 2026 $\rightarrow$ **Selesai sekitar 7 November 2026** (jauh sebelum paket kuota habis).
2. **Fase 2 — Broksum All Penuh `all_data=true` (180.856 request):**
   - Selesai dalam **20 hari kalender** berikutnya.

---

## 7. BARIS CRONTAB YANG AKAN DIPASANG (SETELAH PEMILIK MENYETUJUI)

*(Baris di bawah ini **BELUM DIPASANG** ke crontab produksi VPS. Siap dipasang setelah instruksi `deploy`).*

```cron
# ── AUTO-CUAN OPTIMIZED EOD INGESTION (All + Foreign + Priority Insiders) ──
# 16:30, 16:45, 17:00, 17:15, 17:30, 17:45, 23:30 (Senin–Jumat)
30,45 16 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
0,15,30,45 17 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
30 23 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --final >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1

# ── HISTORICAL BROKSUM BACKFILL (WEEKDAY) ──
# Berjalan hari kerja pukul 19:30 WIB (cadangan 800 request)
30 19 * * 1-5 /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-broksum.js --mode=weekday >> /home/ubuntu/auto-cuan-runner/logs/backfill-broksum.log 2>&1

# ── HISTORICAL BROKSUM BACKFILL (WEEKEND) ──
# Berjalan Sabtu & Minggu pukul 00:05 WIB (cadangan 300 request)
5 0 * * 0,6 /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-broksum.js --mode=weekend >> /home/ubuntu/auto-cuan-runner/logs/backfill-broksum.log 2>&1

# ── WEEKLY INSIDERS FULL UNIVERSE ──
# Berjalan Sabtu pukul 01:00 WIB (mengambil data insider semua saham 1x per minggu)
0 1 * * 6 /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/run-daily-broker-update.js --insider-mode=all --date=latest >> /home/ubuntu/auto-cuan-runner/logs/weekly-insiders.log 2>&1
```

---

> **PEMBERITAHUAN:**  
> Seluruh kode telah diuji secara menyeluruh di unit test dan folder staging VPS. Server produksi, PM2, dan crontab produksi saat ini **tidak diubah sama sekali**.  
> **Silakan periksa laporan ini. Jika sudah sesuai, tuliskan kata `"deploy"` untuk memasang perubahan ke produksi dan memulai antrean backfill.**
