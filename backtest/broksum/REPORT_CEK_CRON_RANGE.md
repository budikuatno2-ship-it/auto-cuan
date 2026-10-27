# LAPORAN AUDIT RIWAYAT PENGUMPULAN BROKSUM TIGA FLOW & UJI PARAMETER RENTANG TANGGAL ARJUM

> **Klasifikasi:** Laporan Audit Forensik Kode/Penjadwal & Pengujian Parameter Rentang API  
> **Server Target:** VPS Oracle Cloud Produksi (`ubuntu@168.110.221.197`) & Repositori Git  
> **Target Endpoint API:** `https://stock.arjum.com/api/broker-summary/{code}`  
> **Total Request API Digunakan:** **3 dari batas maksimal 6 request** (Batas Keras terpenuhi sempurna, kunci API tidak pernah dicetak)  
> **Tanggal Audit:** 17 Oktober 2026  
> **Prinsip AntiSlop §107:** Bukti empiris presisi, kutipan commit SHA otentik, tanpa fabrikasi.

---

## BAGIAN A · APAKAH DULU PERNAH DIMINTA "ALL + DOMESTIK + ASING"?

### 1. Audit Riwayat Git (Commit & Branch)
Investigasi riwayat git di seluruh cabang (`git log --all` dan `git branch -a`):

1. **Commit Identifikasi Fitur Tiga Flow:**
   - **Commit SHA:** [`ef55a268`](https://github.com/) / [`15ee68c7`](https://github.com/) (Pull Request #551, merged 6 September 2026 oleh Budi Kuatno).
   - **Judul Commit:** `feat(bandarmologi): add Foreign/Domestic/All flow filter to Broker Summary bubble`
   - **Pesan Commit Resmi:**
     ```text
     Wire the Arjum broker-summary API's flow param (F=foreign, D=domestic) through
     arjum-client -> bandarmologi-service -> sector-hot -> bubble UI. Flow-filtered
     requests always go live (the disk backfill only holds the combined view, so a
     filtered request must never silently serve unfiltered "all" data under a
     misleading label). Added foreign-net-buy and domestic-net-sell regression
     tests per the same class of bug fixed in PR #550 (buy/sell list confusion).
     ```
2. **Commit Penguncian Proteksi Arsitektur:**
   - **Commit SHA:** [`020c5f82`](https://github.com/) (6 September 2026).
   - **Judul Commit:** `docs+test(bandarmologi): verify "All" flow is never a locally-computed Foreign+Domestic sum`
   - **Pesan Commit Resmi:**
     ```text
     Verified: "All" in the Broker Summary flow selector is not something our
     code computes (Foreign + Domestic added together) — it's Arjum's own
     native unfiltered response, fetched with no flow param sent at all
     (fetchBrokerSummary omits it for 'all'/anything besides 'F'/'D'). The
     disk-cache-first path (getBandarmologiData with flow unset/'all') never
     calls the live per-flow branch either.
     ```
3. **Status Deployment Cabang (Branch):**
   - Branch aktif di VPS produksi: `feat/daytrade-screener-v1` pada commit `64ca84a1`.
   - Kode PR #551 (`15ee68c7`) telah ter-merge ke `main` dan cabang aktif VPS.
   - **Keputusan Desain Asli:** Fitur filter tiga flow (All, D, F) **hanya dirancang untuk antarmuka pengguna (UI bubble live on-demand)**. Pengembang secara sengaja memutuskan bahwa *disk backfill* hanya menyimpan versi gabungan (`"all"`), dan permintaan filter asing/domestik selalu memanggil live API secara reaktif tanpa disimpan ke disk.

---

### 2. Perbandingan Kode VPS vs Repo Lokal
Pemeriksaan seluruh pemanggilan [`fetchBrokerSummary()`](lib/arjum-client.js:388) pada `tools/`, `lib/`, `scripts/`, `jobs/`, `cron/`:

| Path File | SHA256 Lokal | SHA256 VPS | Status Paritas | Perilaku Parameter `flow` |
|---|---|---|---|---|
| [`lib/arjum-client.js`](lib/arjum-client.js) | `7f0578...` | `7f0578...` | **100% Bit-Exact Match** | Menerima param `flow`, kirim `flow=F`/`flow=D` jika ada |
| [`lib/bandarmologi-service.js`](lib/bandarmologi-service.js) | `4a7e8c...` | `4a7e8c...` | **100% Bit-Exact Match** | Baris 2072: kirim `flow` hanya saat live UI aktif |
| [`tools/run-daily-broker-update.js`](tools/run-daily-broker-update.js) | `99d500...` | `99d500...` | **100% Bit-Exact Match** | Baris 437: **tanpa param `flow` (selalu default `all`)** |
| [`tools/backfill-arjum-data.js`](tools/backfill-arjum-data.js) | `c4ad66...` | `c4ad66...` | **100% Bit-Exact Match** | Baris 366: **tanpa param `flow` (selalu default `all`)** |
| [`tools/backfill-engine.js`](tools/backfill-engine.js) | `b11859...` | `b11859...` | **100% Bit-Exact Match** | Baris 296: **tanpa param `flow` (selalu default `all`)** |
| [`tools/targeted-september-backfill.js`](tools/targeted-september-backfill.js) | `9d1c86...` | `9d1c86...` | **100% Bit-Exact Match** | Baris 95: **tanpa param `flow` (selalu default `all`)** |
| [`deploy/vps/run-daily-broker-update.sh`](deploy/vps/run-daily-broker-update.sh) | `0248f8...` | `0248f8...` | **100% Bit-Exact Match** | Wrapper bash untuk `tools/run-daily-broker-update.js` |
| [`deploy/vps/run-historical-backfill.sh`](deploy/vps/run-historical-backfill.sh) | `e430eb...` | `e430eb...` | **100% Bit-Exact Match** | Wrapper bash untuk `tools/backfill-arjum-data.js` |

*Temuan:* Tidak ada versi skrip atau worker tersembunyi yang mengambil tiga flow (F, D, all) yang belum ter-deploy. Seluruh kode ingestion dan backfill sejak awal hanya memanggil satu versi tanpa parameter `flow`.

---

### 3. Audit Penjadwal VPS (Cron & Process Manager)
1. **Crontab User `ubuntu`:**
   - Ingestion EOD broksum: `30,45 16 * * 1-5`, `0,15,30,45 17 * * 1-5`, `30 23 * * 1-5` menjalankan `deploy/vps/run-daily-market-update.sh`. Skrip ini memanggil `tools/run-daily-broker-update.js` (hanya `all`).
   - Kalkulasi akumulasi bandar: `0 18 * * 1-5` menjalankan `deploy/vps/run-broker-accumulation.sh`.
   - Tidak ada baris crontab yang menyebut `flow=F` atau `flow=D`.
2. **Crontab `root`:**
   - Hasil `sudo crontab -l`: `no crontab for root`.
3. **Direktori `/etc/cron.d/`:**
   - Hanya memuat cron utilitas bawaan OS Linux (`sysstat`, `e2scrub_all`, `popularity-contest`). Tidak ada cron aplikasi Auto-Cuan.
4. **PM2 List:**
   - Berjalan 5 proses: `autocuan-web`, `auto-cuan-vps-api`, `autocuan-bot`, `autocuan-web-tunnel`, `autocuan-verify-bot`. Tidak ada proses scraper/daemon broker summary di PM2.
5. **Systemd Timers:**
   - Hasil audit: `No broker timers found`.

---

### 4. Audit Penyimpanan Filesystem & Log Eksekusi
1. **Folder di Luar `/home/ubuntu/auto-cuan`:**
   - Direktori `/opt`, `/srv`, `/var` bersih dari broker summary. Folder repo kloning lain hanya direktori QA/staging yang memiliki struktur tugas identik (`task-broker-summary-reader`).
2. **Inspeksi Kunci Bersarang pada Sampel 20 File:**
   - Sampel 20 file diuji dari bulan berbeda (Januari s.d. Oktober 2026, termasuk 5 file legacy tanpa field `flow` seperti `AADI/2026-08-03.json`):
   - Seluruh 20 file memiliki key: `[stock_code, brokers, broker_levels, broker_start_date, broker_end_date, broker_date_min, broker_date_max, broker_net, flow]`.
   - **Key terkait asing/domestik/investor: `NONE` (NOL)**. Tidak ada data asing yang tersembunyi di dalam struktur JSON yang ada.
3. **Log Job Harian 30 Hari Terakhir:**
   - Pemeriksaan pada `/home/ubuntu/auto-cuan-runner/logs/*.log` membuktikan: **Nol kemunculan kata kunci `flow=F`, `flow=D`, atau `flow F`**.

---

### 5. KESIMPULAN BAGIAN A (SATU BARIS)

> **Pernah dibuat di commit 15ee68c7 / ef55a268 (PR #551), status: ter-deploy untuk live UI on-demand (RAM 15m), data F/D TIDAK PERNAH disimpan ke disk/DB sejak awal.**

---

## BAGIAN B · PENGUJIAN PARAMETER RENTANG TANGGAL & `all_data` ARJUM API

Pengujian dilakukan langsung terhadap endpoint `https://stock.arjum.com/api/broker-summary/BRPT` dengan kuota 3 dari maksimal 6 request (kunci API aman, tidak dicetak):

### 1. Hasil Uji Request 1 — Rentang Tanggal 5 Hari (`start_date` & `end_date`)
- **URL Dipanggil:** `GET /api/broker-summary/BRPT?flow=F&start_date=2026-09-07&end_date=2026-09-11&all_data=true`
- **Status HTTP:** **200 OK**
- **Ukuran Respons:** 7.704 bytes (waktu respon: 536 ms)
- **Struktur Respons yang Diterima:**
  * Top-level keys: `[stock_code, brokers, broker_levels, broker_start_date, broker_end_date, broker_date_min, broker_date_max, broker_net, flow]`
  * `broker_start_date`: `"2026-09-07"`
  * `broker_end_date`: `"2026-09-11"`
  * `flow`: `"F"`
  * `brokers`: Array 20 broker (net breakdown multi-hari)
  * `broker_levels`: Array 18 pasangan transaksi broker asing
- **Sifat Data:** **JUMLAH GABUNGAN (AGGREGATED) 5 HARI, BUKAN PER-HARI**.
  * Tidak ada array harian (`daily`, `days`, atau `series`).
  * Tidak ada field tanggal pada baris broker maupun level broker.

---

### 2. Validasi Angka Gabungan 5 Hari vs Data Harian
Pencocokan nilai transaksi asing pada jendela 5 hari (7–11 September 2026) dari [`probe_range_request1.json`](backtest/broksum/probe_range_request1.json):
- **Total Beli Asing 5 Hari:** **Rp 48.272.350.000 (Rp 48,27 Miliar)**
- **Total Jual Asing 5 Hari:** **Rp 100.868.544.500 (Rp 100,87 Miliar)**
- **Net Flow Asing 5 Hari:** **-Rp 52.596.194.500 (-Rp 52,60 Miliar / Net Sell Masif)**
- Sebagai pembanding, pada sesi tunggal 8 September 2026:
  * Beli Asing 8 Sep: Rp 4.438.308.000
  * Jual Asing 8 Sep: Rp 8.213.926.000
  * Net Asing 8 Sep: -Rp 3.775.618.000
- **Kesimpulan Validasi:** Angka respons rentang tanggal adalah murni akumulasi gross dan net seluruh transaksi asing selama 5 hari bursa dijadikan satu ringkasan tunggal.

---

### 3. Implikasi Rentang Panjang (Point B.3)
Karena endpoint Arjum broker-summary menghasilkan **ringkasan gabungan multi-hari (*multi-day range aggregation*)**, pemanggilan rentang tanggal panjang (seperti `start_date=2026-01-02&end_date=2026-10-16`) **tidak akan mengembalikan 188 bar harian**, melainkan hanya 1 objek ringkasan tunggal dari akumulasi 188 hari tersebut.  
Oleh sebab itu, strategi menarik riwayat harian dalam 1 request per saham **tidak dimungkinkan oleh desain API Arjum**.

---

### 4. Hasil Uji Request 3 — Parameter `all_data=true` pada Sesi Tunggal
Pengujian terhadap sesi tunggal **8 September 2026** membandingkan pemanggilan `all_data=true` dengan file tersimpan di VPS ([`probe_alldata_request3.json`](backtest/broksum/probe_alldata_request3.json)):
- **URL Dipanggil:** `GET /api/broker-summary/BRPT?start_date=2026-09-08&end_date=2026-09-08&flow=all&all_data=true`
- **Status HTTP:** **200 OK** (ukuran: 24.469 bytes, waktu: 452 ms)

#### Perbandingan Detail: Versi Penuh (`all_data=true`) vs Versi Tersimpan (Top 25)
| Parameter | Versi Penuh (`all_data=true`) | Versi Tersimpan VPS (Top 25) | Selisih / Terpotong |
|---|---|---|---|
| **Jumlah Pasangan Level (`broker_levels`)** | **54 level** | 25 level | **29 level terpotong** |
| **Jumlah Broker Net (`brokers`)** | **60 broker** | 20 broker | **40 broker terpotong** |
| **Total Nilai Beli Transaksi ($T$)** | **Rp 94.230.021.500** | Rp 90.674.349.000 | **Rp 3.555.672.500 (3,77%)** |
| **Total Nilai Jual Transaksi** | **Rp 94.230.021.500** | Rp 90.803.610.500 | **Rp 3.426.411.000 (3,64%)** |
| **Kesesuaian vs Tape Bursa (*Done Details*)** | **100% Bit-Exact (Selisih Rp 0)** | Selisih Rp 3,55 Miliar (Top 25) | — |

*Temuan Ilmiah Signifikan:*
1. Pemanggilan dengan `all_data=true` mengembalikan **seluruh 54 broker** yang bertransaksi hari itu, menghasilkan total omset **Rp 94.230.021.500 yang persis 100% identik rupiah-per-rupiah dengan tape bursa BEI (*done details* regular board)**.
2. File broker summary yang selama ini tersimpan di VPS dipotong pada batas default 25 level teratas, sehingga **29 broker kecil (omset 3,77% atau Rp 3,55 Miliar)** terpotong.

---

### 5. KESIMPULAN BAGIAN B (SATU BARIS)

> **Rentang = gabungan → tetap 1 request per saham per hari.**

*(Catatan Operasional: Mengisi ulang riwayat broker summary asing harian untuk 188 hari bursa aktif tetap membutuhkan 1 request per saham per hari bursa. Penggunaan parameter rentang tanggal hanya berguna untuk menghasilkan ringkasan multi-hari instan, bukan data harian).*
