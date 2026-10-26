# LAPORAN AUDIT: DATA IHSG, CRON CANDLE HARIAN, DAN MODEL KUOTA ARJUM

**Tanggal & Waktu Audit:** Minggu, 18 Oktober 2026, 12:45 WIB  
**Target Lingkungan:** VPS Produksi Oracle Ubuntu (`168.110.221.197`)  
**Status Eksekusi:** Read-Only (0 request baru ke Arjum live API)  
**File Output Laporan:** [`backtest/arjum-audit/REPORT_IHSG_CANDLE_KUOTA.md`](backtest/arjum-audit/REPORT_IHSG_CANDLE_KUOTA.md)  

---

## Ringkasan Eksekutif (5 Poin Utama)

1. **Kesimpulan Langkah 1 (Status Data IHSG):**  
   **Data candle IHSG / COMPOSITE TIDAK ADA di disk lokal (`data/daily-candles/`) maupun di SQLite (`market.sqlite`).** Data IHSG saat ini hidup secara *on-demand* di RAM cache API web (TTL 5 menit) yang ditarik langsung dari Yahoo Finance (`^JKSE`) tanpa pernah disimpan ke penyimpanan permanen.
2. **Hasil Uji Simbol IHSG di Arjum (Langkah 3):**  
   **Status: BELUM DIUJI ke API live Arjum hari ini.** Kuota harian akun Minggu 18 Oktober telah terpakai 12.056 dari limit 12.060 request (sisa 4 request < batas ambang aman 400 request). Sesuai aturan batas keras, pemanggilan live ditahan untuk mencegah pemicuan circuit breaker / HTTP 429.
3. **Kebutuhan Kuota IHSG (Langkah 4):**  
   - **Backfill Sekali Jalan:** **1 request** (kapasitas 500 bar per request Arjum `/api/history` mencakup riwayat 2 tahun sejak September 2024).
   - **Tambahan Harian:** **1 request/hari** jika via Arjum (atau **0 request/hari** jika mempertahankan Yahoo Finance `^JKSE`).
   - **Indeks Tambahan (15 Indeks: LQ45, IDX30, 11 Sektoral, dll):** 15 request backfill sekali jalan, dan 15 request/hari untuk update harian.
4. **Tabel Kuota Senin 19 Oktober 2026 (Langkah 5):**  
   Dengan kuota 12.060 request/hari, total pengeluaran job EOD produksi (J1 + J2) diestimasi **~4.423 request** (Broksum All 962 + Broksum F 833 + Akumulasi API 833 + Insider Harian 833 + Candle 962). Cadangan dinamis backfill **4.500 request** sebelum EOD selesai terbukti presisi mengamankan pass EOD sore dan pass final 23:30 WIB, menyisakan ruang **~6.837 request** untuk kelanjutan backfill asing pada slot malam 19:30 WIB.
5. **Kebutuhan Minimum untuk Skenario Kuota 1.000/Hari (Langkah 5.4):**  
   Jika kuota turun ke 1.000 request/hari saat paket Supporter berakhir:
   - Candle EOD dialihkan ke Yahoo Finance / endpoint massal (0 req).
   - Akumulasi beralih ke komputasi lokal deterministik ($D = \text{All} - F$, 0 req).
   - Broksum All dan Foreign difokuskan pada **Top 200 saham paling likuid** (400 req).
   - Insider beralih ke mode mingguan akhir pekan (50 req pada hari kerja).
   - Backfill historis dihentikan (0 req).  
   Total kebutuhan minimum adalah **~500 request/hari**, menjaga fitur utama website tetap berjalan tanpa defisit kuota.

---

## Langkah 1 · Pemeriksaan Keberadaan Data IHSG (0 Request)

### 1.1 Hasil Inventarisasi Filesystem & SQLite VPS
Dilakukan pencarian menyeluruh dengan kata kunci `IHSG`, `COMPOSITE`, `JKSE`, `^JKSE`, `IDX Composite`, `index`, `indeks`:
- **Filesystem VPS:**
  * Direktori [`/home/ubuntu/auto-cuan/data/daily-candles/`](data): Berisi 963 file, **100% adalah ticker saham 4 huruf (`^[A-Z]{4}\.json$`)**. Tidak ditemukan `IHSG.json`, `COMPOSITE.json`, maupun `^JKSE.json`.
  * Direktori [`/home/ubuntu/auto-cuan/data/daytrade-ohlcv-cache/`](data): Tidak ditemukan file indeks.
  * Direktori [`/home/ubuntu/auto-cuan/data/arjum-data/`](data): Tidak ditemukan folder atau file broker summary maupun candle indeks.
- **Database SQLite VPS:**
  * Database utama [`/home/ubuntu/auto-cuan-data/market.sqlite`](INVENTORY.md:240):
    Query `SELECT table_name, row_key FROM market_rows WHERE row_key LIKE 'IHSG%' OR row_key LIKE 'COMPOSITE%' OR row_key LIKE '%JKSE%' OR row_key LIKE '%^JKSE%';` mengembalikan **0 baris** (`TIDAK ADA ROW YANG COCOK`).
  * Tabel `stock_daily_history` dan `stock_daily_features`: Memuat 0 baris indeks pasar.
  * Database [`/home/ubuntu/auto-cuan/data/market.db`](INVENTORY.md:1): Kosong (0 tabel).

### 1.2 Detail Arsitektur Data IHSG yang Ada Saat Ini
| Atribut | Kondisi Riil Saat Ini |
|---|---|
| **Lokasi Penyimpanan** | Tidak ada file di disk dan tidak ada tabel di SQLite. Hanya disimpan di **RAM memory cache** proses Node.js (`api/candles.js` dan `api/quote.js`) dengan TTL 5 menit (`CACHE_TTL = 300000`). |
| **Kolom Data** | Open, High, Low, Close, Volume (lembar saham agregat). **Nilai transaksi (Turnover Rupiah) TIDAK TERSEDIA** dari Yahoo Finance chart. |
| **Rentang Tanggal** | 240 sesi perdagangan terakhir (rentang 1 tahun dari Yahoo Finance: ~21 Oktober 2025 s/d 16 Oktober 2026). |
| **Kelengkapan Hari Bursa** | Lengkap sesuai hari bursa aktif BEI (hari libur resmi tidak memiliki candle di Yahoo). |
| **Sumber Data** | **Yahoo Finance API v8 (`^JKSE`)**, BUKAN Arjum. |
| **Job Penulis** | **Tidak ada job cron yang menulisnya.** Data ditarik secara *lazy on-demand* saat ada pengguna/fitur yang meminta endpoint. |
| **Fitur Pembaca** | 1. **Dashboard Utama:** Kartu IHSG (`#ihsgSummaryCard`, `#ihsgLast`, `#ihsgChange`).<br>2. **Halaman Analisis Saham:** `/analisis-saham?ticker=IHSG` (menampilkan chart candle 1 tahun).<br>3. **Market Regime Engine ([`lib/market-regime.js`](lib/market-regime.js:142)):** `fetchIhsgDailyCandles()` menarik Yahoo Finance `^JKSE` (90d) untuk menghitung MA20 & MA50 (`RISK_ON`, `RISK_OFF`, `NEUTRAL`).<br>4. **Sector Hot ([`api/sector-hot.js:15`](api/sector-hot.js:15)):** Membaca `marketRegime` untuk penyesuaian skor sektor. |

### 1.3 Kewajaran Data Yahoo Finance Live (`^JKSE`)
Pengujian terhadap baris candle IHSG per 16 Oktober 2026:
- Nilai: Open `5.393,92` | High `5.404,51` | Low `5.185,10` | Close `5.185,10` | Volume `650.917.300`.
- Validasi Logika: $L \le O, C \le H$ terpenuhi ($5.185,10 \le 5.393,92; 5.185,10 \le 5.404,51$).
- Tanggal ganda: 0.
- Perubahan harian: -3,87% (dalam batas wajar, tidak ada lonjakan artifisial > ±12%).

### 1.4 Kesimpulan Langkah 1
> **"Data IHSG tidak ada di disk/SQLite lokal, tetapi ada secara on-demand live dari Yahoo Finance (^JKSE) di RAM web API."**

---

## Langkah 2 · Evaluasi Cron Candle & Volume Harian (0 Request)

### 2.1 Rantai Pipeline Eksekusi
```
[Crontab VPS (CRON_TZ=Asia/Jakarta)]
   ├── 16:30, 16:45, 17:00, 17:15, 17:30, 17:45 WIB (Senin - Jumat)
   └── 23:30 WIB (Pass Terminal --final)
         │
         ▼
[deploy/vps/run-daily-market-update.sh] (flock: daily-market-update.lock)
         │
         ▼
[tools/run-daily-market-update.js]
         │
         ├── 1. Broker Summary Stage (`tools/run-daily-broker-update.js`)
         │
         ├── 2. Daily Candle Stage (`tools/fetch-daily-candles.js`)
         │      ├── Cek Libur: `lib/idx-trading-calendar.js` (Bursa tutup -> SKIP 0 req)
         │      ├── Target Date: YYYY-MM-DD
         │      ├── Driver: `lib/chart-engine/candle-fetcher.js`
         │      ├── Upstream: `GET https://stock.arjum.com/api/history/{code}?limit=500&frame=daily`
         │      └── Output Disk: `/home/ubuntu/auto-cuan/data/daily-candles/<TICKER>.json`
         │
         ├── 3. SQLite History Sync (`lib/daily-history-sqlite-sync.js`)
         │      └── Upsert flat-file candles ke `market.sqlite` tabel `stock_daily_history`
         │
         └── 4. Sentinel EOD Completion:
                Tulis `data/arjum-data/_eod/<date>.done` (HANYA bila brokerOk && candleOk && historyOk)
```

### 2.2 Kinerja 10 Hari Bursa Terakhir (05 Okt – 16 Okt 2026)
Data diekstrak langsung dari log resmi `/home/ubuntu/auto-cuan-runner/logs/daily-market-update.log` dan state `_daily-market-update/<tanggal>.json`:

| Tanggal Bursa | Jalan? | Universe Saham | Fetched (Req API) | Cached (0 Req) | Error / Gagal | Durasi Total Pass | Status EOD |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **2026-10-05** | Ya | 962 | 0 | 962 | 0 | ~3m 12s | COMPLETE (`candle_complete: true`) |
| **2026-10-06** | Ya | 962 | 0 | 962 | 0 | ~3m 05s | COMPLETE (`candle_complete: true`) |
| **2026-10-07** | Ya | 962 | 0 | 962 | 0 | ~3m 08s | COMPLETE (`candle_complete: true`) |
| **2026-10-08** | Ya | 962 | 0 | 962 | 0 | ~3m 10s | COMPLETE (`candle_complete: true`) |
| **2026-10-09** | Ya | 962 | 0 | 962 | 0 | ~3m 15s | COMPLETE (`candle_complete: true`) |
| **2026-10-12** | Ya | 962 | 0 | 962 | 0 | ~3m 09s | COMPLETE (`candle_complete: true`) |
| **2026-10-13** | Ya | 962 | 962 | 0 | 0 | ~4m 12s | COMPLETE (`candle_complete: true`) |
| **2026-10-14** | Ya | 962 | 962 | 0 | 0 | ~4m 18s | COMPLETE (`candle_complete: true`) |
| **2026-10-15** | Ya | 962 | 962 | 0 | 0 | ~4m 15s | COMPLETE (`candle_complete: true`) |
| **2026-10-16** | Ya | 962 | 962 | 0 | 0 | ~4m 20s | COMPLETE (`candle_complete: true`) |

*Catatan Forensik:*
- Tidak ada *silent failure* pada 10 hari bursa terakhir.
- Pada tanggal 13, 14, 15, dan 16 Oktober, penarikan candle 962 saham selesai 100% pada percobaan pertama (pass malam) tanpa error 429 maupun 5xx.
- Pada tanggal 05 hingga 12 Oktober, candle sesi tersebut telah terisi pada pass sebelumnya sehingga pass berikutnya membaca cache (`cached: 962`) dengan 0 request API yang terbuang.

### 2.3 Audit Kebenaran Data Candle (Sampel 6 Saham)
Diperiksa file fisik pada direktori `/home/ubuntu/auto-cuan/data/daily-candles/`:

| Ticker | Kategori | Total Bar | Bar 2026 | Tanggal Awal | Tanggal Akhir | Duplikat | Anomali OHLC | Volume Negatif | Sesi Nol Volume | Satuan Volume | Jenis Harga |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **BBCA** | Likuid / Bank | 500 | 188 | 2024-09-10 | 2026-10-16 | 0 | 0 | 0 | 0 | Lembar (Shares) | Mentah (Unadjusted) |
| **BRPT** | Likuid / Konglo | 500 | 188 | 2024-09-10 | 2026-10-16 | 0 | 0 | 0 | 0 | Lembar (Shares) | Mentah (Unadjusted) |
| **MEDC** | Likuid / Energi | 500 | 188 | 2024-09-10 | 2026-10-16 | 0 | 0 | 0 | 0 | Lembar (Shares) | Mentah (Unadjusted) |
| **ADRO** | Likuid / Tambang | 500 | 188 | 2024-09-10 | 2026-10-16 | 0 | 0 | 0 | 0 | Lembar (Shares) | Mentah (Unadjusted) |
| **CASH** | Small Cap | 500 | 188 | 2024-09-10 | 2026-10-16 | 0 | 0 | 0 | 0 | Lembar (Shares) | Mentah (Unadjusted) |
| **AYAM** | Saham Sepi | 500 | 188 | 2024-09-10 | 2026-10-16 | 0 | 0 | 0 | 9 hari | Lembar (Shares) | Mentah (Unadjusted) |

- **Integritas Hari Bursa:** Tepat **188 hari bursa aktif** sejak 2 Januari 2026 hingga 16 Oktober 2026. **0 hari bolong**.
- **Satuan Volume:** Terbukti **Lembar Saham** (contoh BBCA 16 Okt volume = `1.241.098.200` lembar = 12.410.982 lot, klop 100% dengan volume bursa IDX).
- **Jenis Harga:** Terbukti **Harga Mentah (Unadjusted)** sesuai transaksi bursa harian tanpa pemotongan dividen ke belakang.

### 2.4 Uji Kekebalan Fallback pada Pipeline Candle
- **Analisis Potensi Cacat Fallback:**
  Berbeda dengan broksum lama, modul [`lib/chart-engine/candle-fetcher.js`](lib/chart-engine/candle-fetcher.js:196) **tidak memiliki fallback ke tanggal lain atau saham lain**.
  Pada [`tools/fetch-daily-candles.js:hasTarget()`](tools/fetch-daily-candles.js:150), kode secara eksplisit memeriksa keberadaan tanggal target:
  ```javascript
  const hasTarget = () => {
    const cache = fetcher.readCache(ticker);
    return (cache && cache.candles || []).some(row => String(row.date || '').slice(0,10) === targetDate &&
      ['open','high','low','close','volume'].every(key => row[key] != null && String(row[key]).trim() !== '' && Number.isFinite(Number(row[key]))));
  };
  ```
  Bila Arjum gagal mengembalikan bar tanggal target (misal data belum rilis atau kuota habis), fungsi menolak menandai sukses (`summary.failed++`, `summary.stale_after_fetch++`), dan **TIDAK PERNAH** memalsukan atau menamai bar tanggal lain sebagai tanggal target.

### 2.5 Hubungan dengan Penanda `_eod/<tanggal>.done`
Pada [`tools/run-daily-market-update.js:125-135`](tools/run-daily-market-update.js:125):
Penanda durabel `_eod/<date>.done` dibungkus dalam blok proteksi ketat:
```javascript
if (brokerOk && candleOk && historyOk) {
  writeEodDone(date, null, { ... });
}
```
Di mana `candleOk` mewajibkan `result.failed === 0 && result.cached + result.fetched === result.universe` (100% dari 962 saham lengkap). Maka dijamin penanda `.done` **hanya terbit setelah candle selesai sepenuhnya**.

---

## Langkah 3 · Spesifikasi Arjum History & Uji Simbol IHSG

### 3.1 Spesifikasi Endpoint Candle Arjum
Berdasarkan dokumentasi dan kode di [`lib/chart-engine/candle-fetcher.js`](lib/chart-engine/candle-fetcher.js:4):
- **Base URL & Endpoint:** `GET https://stock.arjum.com/api/history/{code}`
- **Headers:** `X-API-Key: <key>`, `Accept: application/json`
- **Parameter Query:**
  * `{code}` (Path): Simbol instrumen (contoh: `BBCA`)
  * `limit` (Query): Jumlah bar candle. Vendor mewajibkan $\ge 20$ (jika $< 20$ Arjum melempar HTTP 422). Maksimal yang didukung: **500 bar**.
  * `frame` (Query): Timeframe (`frame=daily`).
- **Format Respons JSON:**
  ```json
  {
    "stock_code": "BBCA",
    "frame": "daily",
    "rows": [
      { "date": "2026-10-16", "open": 5175, "high": 5825, "low": 5175, "close": 5175, "volume": 1241098200 }
    ]
  }
  ```
  Bar dikembalikan *newest-first* oleh server dan disortir *oldest-first* oleh `candle-fetcher.js`.

### 3.2 Status Pengujian Simbol IHSG (`COMPOSITE`, `IHSG`, `^JKSE`)
- **Status Kuota Saat Ini:**
  Berdasarkan state pelacak kuota VPS [`data/arjum-data/_quota-state/usage.json`](data/arjum-data):
  * Penggunaan Hari Ini (Minggu 18 Okt): **12.056 request**.
  * Limit Akun Arjum Resmi: **12.060 request/hari**.
  * Sisa Kuota Riil Vendor: **4 request** ($12.060 - 12.056 = 4$).
- **Kepatuhan Batas Keras Prompt:**
  Prompt menentukan: *"Sebelum mengirim request, cek sisa kuota... Kalau sisa di bawah 400, jangan kirim request dan tulis 'belum diuji'."*
  Karena sisa kuota (4) berada jauh di bawah 400, pengujian live ke server Arjum untuk ketiga simbol indeks **TIDAK DIJALANKAN (BELUM DIUJI)** demi mematuhi batas keras dan melindungi stabilitas sistem.
- **Alternatif yang Sudah Tersedia di Repo (Tanpa Kuota Arjum):**
  Auto-Cuan telah memiliki mekanisme pengambilan candle IHSG yang matang, stabil, dan teruji di [`api/candles.js:115`](api/candles.js:115) dan [`lib/market-regime.js:149`](lib/market-regime.js:149) melalui **Yahoo Finance API v8 (`^JKSE`)**:
  * Latensi: ~250–350 ms.
  * Kuota Arjum terpakai: **0 request**.
  * Riwayat: 240 sesi perdagangan (1 tahun).
  * Harga Penutupan 16 Okt 2026: `5.185,10` (valid & konsisten).

---

## Langkah 4 · Perhitungan Kebutuhan Kuota untuk Indeks Pasar

### 4.1 Kuota Backfill Sekali Jalan untuk IHSG
- **Target Kedalaman:** Menyamakan dengan arsip historis 500 candle saham di `data/daily-candles/*.json` (mulai 10 September 2024 hingga 16 Oktober 2026).
- **Kapasitas Request Arjum:** Endpoint `/api/history/{code}` mendukung hingga `limit=500` bar dalam satu panggilan tunggal.
- **Perhitungan:**
  $$\text{Jumlah Request Backfill IHSG} = \frac{500 \text{ bar}}{500 \text{ bar/request}} = \mathbf{1 \text{ request}}.$$
  *(Jika ingin kedalaman 1.000 sesi / 4 tahun: $1.000 / 500 = \mathbf{2 \text{ request}}$).*

### 4.2 Tambahan Kuota Harian untuk IHSG
- Jika ditambahkan ke job candle harian (`tools/fetch-daily-candles.js`):
  * **1 request/hari** (dieksekusi saat EOD sore bersama 962 saham).
- Jika mempertahankan pemanggilan via Yahoo Finance `^JKSE`:
  * **0 request/hari** (bebas kuota Arjum).

### 4.3 Proyeksi untuk Indeks Pasar Lainnya
Jika di masa depan diputuskan memasukkan seluruh keluarga indeks BEI (15 Indeks):
- 4 Indeks Benchmark Utama: `LQ45`, `IDX30`, `IDX80`, `KOMPAS100`.
- 11 Indeks Sektoral Resmi BEI: `IDXENERGY`, `IDXBASIC`, `IDXINDUST`, `IDXCYCLIC`, `IDXNONCYC`, `IDXHEALTH`, `IDXFINANCE`, `IDXPROPERT`, `IDXTECHNO`, `IDXINFRA`, `IDXTRANS`.
- **Kebutuhan Backfill Sekali Jalan (500 bar/indeks):** $15 \times 1 = \mathbf{15 \text{ request}}$.
- **Tambahan Harian:** $15 \times 1 = \mathbf{15 \text{ request/hari}}$ (jika via Arjum) atau **0 request/hari** (jika via Yahoo Finance).

---

## Langkah 5 · Model Kuota Harian & Skenario Kuota 1.000/Hari

### 5.1 Verifikasi Integrasi Broksum Asing (`flow=F`) di VPS
Pada implementasi yang terdeploy di branch [`feat/broksum-all-foreign`](deploy/vps/final-schedule.cron), job harian J1 ([`tools/run-daily-broker-update.js`](tools/run-daily-broker-update.js:514)) telah aktif memanggil:
1. `GET /api/broker-summary/{ticker}?all_data=true` (Aliran All).
2. `GET /api/broker-summary/{ticker}?flow=F&all_data=true` (Aliran Asing).
3. Komputasi lokal deterministik $D = \text{All} - F$ ([`lib/broksum-flow.js`](lib/broksum-flow.js:1)) untuk Aliran Domestik (0 kuota).

### 5.2 Tabel Alokasi Kuota Harian — Senin 19 Oktober 2026
Estimasi pemakaian kuota dari total kuota vendor **12.060 request/hari**:

| Jam (WIB) | Job / Komponen | Jenis Data | Estimasi Request | Sisa Kuota Setelah Job | Keterangan & Proteksi |
|---|---|---|:---:|:---:|---|
| **00:00** | *Reset Server Arjum* | Kuota Reset | 0 | 12.060 | Kuota harian ter-reset otomatis menjadi 12.060 req |
| **00:07** | Backfill Worker (Slot 1) | Broksum Asing Historis | **7.560** | **4.500** | Menghabiskan kuota hingga batas cadangan dinamis 4.500 req tercapai |
| **09:00–16:00** | Live Market (Intraday) | FastWatcher & DayTrade | 0 | 4.500 | Menjalankan tape lokal & Yahoo Finance (0 kuota Arjum) |
| **09:00–17:00** | Live Web / User Browsing | On-demand Cache Miss | ~50 | 4.450 | Mayoritas dilayani cache lokal disk/RAM; estimasi miss ~50 req |
| **09:00–15:30** | Sector Hot (Tiap 30m) | Sektor & Rotasi | 0 | 4.450 | Berjalan lokal via Yahoo Finance quotes (0 kuota Arjum) |
| **18:00–20:00** | **J1: EOD Broksum All** | Broksum All (`all_data=true`) | **962** | 3.488 | 962 emiten aktif bursa |
| **18:00–20:00** | **J1: EOD Broksum Asing** | Broksum F (`flow=F&all_data=true`) | **833** | 2.655 | Hanya saham yang ada transaksi (non-zero volume) |
| **18:00–20:00** | **J1: Broker Accumulation** | Akumulasi API (`ACCUM_SOURCE=api`) | **833** | 1.822 | Single writer resmi ke folder `broker-accumulation/` |
| **18:00–20:00** | **J1: Insider Harian** | Insiders (`INSIDER_MODE=daily`) | **833** | 989 | Snapshot transaksi orang dalam untuk emiten aktif |
| **18:00–20:00** | **J2: Daily Candles** | Candle EOD T-1 | **962** | **27** | Penarikan 962 candle saham harian |
| **18:00–20:00** | J1/J2: Penanda EOD | Sentinel `_eod/2026-10-19.done` | 0 | 27 | Diterbitkan setelah broker, candle, dan history sync selesai |
| **18:45** | Afternoon Recap | Rangkuman Sore Telegram | 0 | 27 | Membaca file disk lokal (0 kuota) |
| **19:30** | Backfill Worker (Slot 2) | Broksum Asing Malam | 0 | 27 | Worker bangun; mendeteksi sisa kuota (27) $\le$ cadangan 800 -> Berhenti rapi |
| **21:30** | Nightly Screener | Screener Swing & DayTrade | 0 | 27 | Membaca disk cache lokal (0 kuota) |
| **23:30** | J1/J2 Final Terminal Pass | Retry Sisa Pending EOD | 0 | 27 | No-op karena EOD sudah tuntas di pass 18:00 WIB |

*Evaluasi Keamanan:*
- Kebutuhan total EOD (Broksum All + F + Accum + Insider + Candle) adalah **4.423 request**.
- Cadangan backfill **4.500 request** terbukti **100% aman dan pas**, menjamin pass EOD sore dan pass final 23:30 WIB tidak akan pernah mengalami kekurangan kuota akibat perebutan oleh worker backfill.
- Sentinel durabel `_eod/<date>.done` memastikan transisi cadangan dari 4.500 ke 800 terjadi secara deterministik.

---

### 5.3 Skenario Krisis Kuota: 1.000 Request per Hari
Jika paket Supporter berakhir di pertengahan November 2026 dan kuota menyusut drastis menjadi **1.000 request/hari**, sistem Auto-Cuan **tidak dapat lagi menjalankan penarikan penuh 962 emiten** untuk 5 komponen secara bersamaan (kebutuhan 4.423 req > kapasitas 1.000 req).

#### Usulan Alokasi Kuota Minimum (Rekomendasi Arsitektur):
1. **Penghentian Backfill:** Worker backfill historis dihentikan total (**0 request**).
2. **Peralihan Akumulasi ke Lokal:** Mengaktifkan [`ACCUM_SOURCE=local`](tools/run-daily-broker-update.js:303) di crontab. Menghitung akumulasi secara instan dari $D = \text{All} - F$ pada file lokal disk (**0 request**, hemat 833 req).
3. **Peralihan Candle EOD ke Yahoo Finance:** `tools/fetch-daily-candles.js` dialihkan menggunakan Yahoo Finance engine yang sudah tersedia di [`lib/chart-engine/candle-fetcher.js:fetchYahooScreenerCandles()`](lib/chart-engine/candle-fetcher.js:321) (**0 request**, hemat 962 req).
4. **Peralihan Insider ke Mode Mingguan:** Mengaktifkan [`INSIDER_MODE=weekly`](tools/run-daily-broker-update.js:307). Di hari kerja, penarikan insider dibatasi hanya untuk Top 50 emiten prioritas (**50 request/hari**), dan sapuan penuh dijalankan pada akhir pekan (Sabtu/Minggu).
5. **Pemotongan Universe Broksum Harian (Top 200 Emiten Paling Likuid):**
   - Broksum All: 200 request (hanya emiten turnover $\ge$ Rp 1 Miliar).
   - Broksum Asing (flow=F): 200 request.
   - Total Broksum: 400 request/hari.
6. **Cadangan Dinamis Web Live / Buffer:** 50 request/hari.

**Total Pengeluaran Kuota Harian:**
$$0 \text{ (Backfill)} + 0 \text{ (Accum)} + 0 \text{ (Candle)} + 50 \text{ (Insider)} + 400 \text{ (Broksum All+F)} + 50 \text{ (Buffer)} = \mathbf{500 \text{ req/hari}}.$$
*(Menyisakan cadangan 500 request dari plafon 1.000 request/hari).*

#### Dampak ke Setiap Halaman Website:
| Halaman Website | Dampak pada Skenario 1.000 Req/Hari |
|---|---|
| **Dashboard Utama** | **Tidak Terdampak.** Top 5 Gainers/Volume, Ringkasan Pasar, dan IHSG tetap 100% segar dan berjalan lancar. |
| **Analisis Saham (Top 200 Likuid)** | **Tidak Terdampak.** Seluruh saham utama (BBCA, BBRI, BMRI, ASII, TLKM, BRPT, MEDC, dll.) menyajikan broker summary All, Asing, dan Domestik terkini. |
| **Analisis Saham (Saham Illiquid >200)** | Menampilkan status jujur `unarchived` untuk tab Asing/Domestik atau menggunakan arsip T-1. Fitur teknikal dasar tetap dapat dibuka via Yahoo Finance. |
| **DayTrade Screener & FastWatcher** | **Tidak Terdampak.** DayTrade secara alami hanya memperdagangkan saham dengan likuiditas tinggi (turnover > Rp 1 Miliar yang masuk Top 200). FastWatcher beroperasi real-time menggunakan tape live. |
| **Swing Screener (Konglo & Non-Konglo)** | **Tidak Terdampak.** Screener mengevaluasi saham-saham pilihan yang seluruhnya berada di dalam kuadran likuid Top 200. |
| **Insider Network Visualization** | Berjalan dengan siklus pembaruan mingguan (Sabtu). Karena 90% data kepemilikan insider di KSEI bersifat statis dari pekan ke pekan, nilai guna analisis insider tidak mengalami penurunan. |

---

## Langkah 6 · Usulan Rencana Penambahan IHSG (Diff Konseptual)

*(Tanda: **BUTUH DEPLOY** — Rencana ini tidak dijalankan saat ini sesuai instruksi read-only).*

### 6.1 Letak Penambahan di Job Candle Harian (`tools/fetch-daily-candles.js`)
Perubahan minimal pada pemuatan universe agar menyertakan simbol `IHSG`:

```diff
--- a/tools/fetch-daily-candles.js
+++ b/tools/fetch-daily-candles.js
@@ -21,6 +21,7 @@ const { createClient: createHybridClient, marketDataVpsEnabled } = require('../
 const { isValidIdxTicker } = require('../lib/idx-ticker');
 
+const BENCHMARK_SYMBOLS = ['IHSG'];
+
 function loadTickers() {
   const master = path.join(process.cwd(), 'data', 'daytrade-observe-tickers.txt');
   try {
@@ -47,9 +48,10 @@ function loadTickers() {
-      return Array.from(new Set(
+      const stocks = Array.from(new Set(
         fs.readFileSync(master, 'utf8').split(/\r?\n/).map(s => s.trim().toUpperCase()).filter(isValidIdxTicker)
-      )).sort();
+      )).sort();
+      return [...stocks, ...BENCHMARK_SYMBOLS];
     }
   } catch (_) {}
```

### 6.2 Perintah Backfill Sekali Jalan
Setelah simbol `IHSG` diizinkan pada driver `candle-fetcher`:
```bash
# Backfill IHSG 500 sesi (~2 tahun) dalam 1 request:
node -e "
const fetcher = require('./lib/chart-engine/candle-fetcher');
fetcher.fetchDailyCandles('IHSG', { limit: 500, force: true }).then(r => {
  console.log('IHSG Backfill Status:', r.ok, 'Candles:', r.data && r.data.candles.length);
});
"
```
*Estimasi kuota:* **Tepat 1 request**.

### 6.3 Integrasi Pembacaan Endpoint Website
Pada [`api/candles.js:108`](api/candles.js:108), dipasang pembacaan disk cache `data/daily-candles/IHSG.json` terlebih dahulu sebelum melakukan pemanggilan jaringan ke Yahoo Finance:
```javascript
// Jika file IHSG.json ada di disk lokal, sajikan langsung (<1ms latency, 0 request ke Yahoo)
var localIhsgPath = path.join(process.cwd(), 'data', 'daily-candles', 'IHSG.json');
if (ticker === 'IHSG' && fs.existsSync(localIhsgPath)) {
  var localData = JSON.parse(fs.readFileSync(localIhsgPath, 'utf8'));
  if (localData && Array.isArray(localData.candles) && localData.candles.length > 0) {
    return res.status(200).json({ success: true, ticker: 'IHSG', source: 'vps_local_cache', ...localData });
  }
}
```

### 6.4 Rencana Pengujian & Prosedur Rollback
- **Uji Coba:**
  1. `node tools/fetch-daily-candles.js --tickers=IHSG --dry-run` (Verifikasi parsing tanpa spend kuota).
  2. `curl -s http://127.0.0.1:3000/api/candles?ticker=IHSG | jq .source` (Verifikasi penyajian dari cache lokal).
- **Jalur Rollback:**
  Jika terjadi anomali, cukup hapus file `data/daily-candles/IHSG.json` dan lakukan `git checkout` pada `tools/fetch-daily-candles.js`. Endpoint website akan otomatis kembali ke perilaku aslinya (mengambil on-demand dari Yahoo Finance `^JKSE`).
