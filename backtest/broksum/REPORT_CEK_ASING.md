# LAPORAN AUDIT FORENSIK PENYIMPANAN BROKER SUMMARY ASING/DOMESTIK DI VPS PRODUKSI

> **Klasifikasi:** Laporan Audit Investigasi Penyimpanan Data Broker Summary Asing & Domestik  
> **Server Target:** VPS Oracle Cloud Produksi (`ubuntu@168.110.221.197`)  
> **Metode Pemeriksaan:** *Read-only* penuh (`find`, `wc`, `grep`, `fs.readSync`, `sqlite3 -readonly SELECT`, inspeksi AST codebase)  
> **Total Request API ke Server Eksternal/Arjum:** **0 request** (Batas Keras terpenuhi sempurna)  
> **Tanggal Sensus:** 17 Oktober 2026  
> **Prinsip AntiSlop §107:** Sensus menyeluruh 100% file (bukan sampel 1 file), tanpa asumsi, pelaporan bukti empiris apa adanya.

---

## 1. SENSUS NILAI FIELD `flow` DI SELURUH FILE BROKER SUMMARY VPS

Pemeriksaan komprehensif dijalankan terhadap **seluruh** file JSON pada direktori `/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/**.json` di VPS produksi menggunakan script sensus cepat [`backtest/broksum/census_all_flow_files.js`](backtest/broksum/census_all_flow_files.js) (hasil tersimpan di [`backtest/broksum/census_all_flow_result.json`](backtest/broksum/census_all_flow_result.json)):

### 1.1 Hasil Penghitungan Sensus Menyeluruh
- **Total Direktori Emiten (Tickers):** **970 emiten**
- **Total File JSON Disensus:** **186.912 file**
- **Waktu Eksekusi Sensus:** 29,12 detik

| Nilai Field `"flow"` | Jumlah File | Persentase | Keterangan |
|---|---|---|---|
| **`"all"`** | **186.625 file** | **99,85%** | Seluruh transaksi pasar reguler digabung (All Market Participants) |
| **`"F"`** (Asing) | **0 file** | **0,00%** | **TIDAK DITEMUKAN SATU FILE PUN** |
| **`"D"`** (Domestik) | **0 file** | **0,00%** | **TIDAK DITEMUKAN SATU FILE PUN** |
| **Lainnya (`"f"`, `"d"`, `"N"`, `"n"`)** | **0 file** | **0,00%** | Tidak ada |
| **Tanpa Field `"flow"`** (Legacy Accumulation) | **287 file** | **0,15%** | File format lama tanpa field `flow` (misal `AADI/2026-08-03.json`) |
| **Total File** | **186.912 file** | **100,00%** | — |

*Catatan Format Legacy (287 file):*  
File-file seperti `AADI/2026-08-03.json` merupakan payload lama dari endpoint akumulasi internal yang memuat key `[date, stock_code, net_status, net_label, net_flow, top_buyers, top_sellers]` tanpa field `flow` sama sekali. Di luar 287 file legacy ini, **100% file broker summary harian yang ada memuat `"flow": "all"`**.

---

## 2. PENCARIAN FOLDER ATAU FILE LAIN TERKAIT BROKSUM ASING/DOMESTIK

Pencarian mendalam menggunakan perintah sistem operasi Linux `find` pada direktori `/home/ubuntu`:
```bash
find /home/ubuntu -maxdepth 6 \( -iname "*broker*" -o -iname "*broksum*" -o -iname "*foreign*" -o -iname "*asing*" -o -iname "*flow*" \) -not -path "*/node_modules/*" -not -path "*/.git/*"
```

### 2.1 Hasil Pencarian Nama/Akhiran File Khusus
Pencarian khusus file dengan akhiran atau penanda varian `_F`, `_D`, `-foreign`, `-domestic`:
```bash
find /home/ubuntu -maxdepth 7 \( -iname '*_F.json' -o -iname '*_D.json' -o -iname '*-foreign.json' -o -iname '*-domestic.json' -o -iname '*_foreign.json' -o -iname '*_domestic.json' -o -iname '*foreign*.json' -o -iname '*asing*.json' \) -not -path '*/node_modules/*' -not -path '*/.git/*'
```
- **Hasil:** **`NONE` (0 file ditemukan)**. Tidak ada file dengan ekstensi atau akhiran penanda asing/domestik.

### 2.2 Inventaris Folder/File Lain yang Cocok dengan Keyword
Dari total 2.139 baris hasil pencarian kata kunci di VPS ([`backtest/broksum/find_all_broksum_results.txt`](backtest/broksum/find_all_broksum_results.txt)), klasifikasi objek yang ditemukan adalah:
1. **Laporan Arus Kas Fundamental (1.928 file):**
   - File beralamat `/home/ubuntu/auto-cuan/data/arjum-data/financial-statements/<TICKER>/CASH_FLOW_REPORT-*.json`. Ini adalah laporan keuangan emiten (*operating/investing/financing cash flow*), bukan transaksi bursa.
2. **Indeks Broker Hunter:**
   - `/home/ubuntu/auto-cuan/data/arjum-data/broker-hunter/` dan `/home/ubuntu/auto-cuan/data/broker-hunter-indexes/`: File JSON peringkat aktivitas broker individual per periode jendela (`1d`, `7d`, `30d`), bukan breakdown asing/domestik.
3. **Cache Agregat Aliran Dana:**
   - `/home/ubuntu/auto-cuan/data/cache/bandarmologi-flow.json` (ukuran 18 KB, `updated_at: 2026-09-26`): File ini hanya menyimpan peringkat saham dengan akumulasi NBSA asing tertinggi per jendela waktu (top emiten per sesi 1, 7, 30 hari), **bukan** rincian transaksi per broker summary.
4. **Script & Worker Runner:**
   - File kode worker seperti `deploy/vps/run-daily-broker-update.sh`, `scripts/idx-sync/sync_foreign_flow.py` (sinkronisasi NBSA makro).
5. **Kesimpulan Pencarian Filesystem:**  
   **Tidak ditemukan folder atau file broker summary terpisah untuk transaksi asing maupun domestik di seluruh disk VPS.**

---

## 3. AUDIT BASIS DATA SQLite & POSTGRESQL

Audit database dilakukan terhadap seluruh 17 file database SQLite yang ditemukan di VPS (`market.sqlite`, `market.db`, dan direktori arsip backup):

### 3.1 Arsitektur Database SQLite VPS
Database aktif produksi `/home/ubuntu/auto-cuan-data/market.sqlite` menggunakan skema *document store* berbasis tabel tunggal:
```sql
CREATE TABLE market_rows (
  table_name TEXT,
  row_key TEXT,
  row_json TEXT,
  updated_at TIMESTAMP
);
```

### 3.2 Pemeriksaan Kolom & Atribut Pencarian
Pencarian terhadap field/atribut target (`flow`, `investor_type`, `buyer_type`, `foreign`, `asing`) pada seluruh entitas logis di `market_rows`:

| Atribut Target | Jumlah Tabel Ditemukan | Total Baris Cocok | Rincian Entitas & Isi Data |
|---|---|---|---|
| **`investor_type`** | **0 tabel** | **0 baris** | Tidak ada tabel/kolom dengan atribut ini di seluruh database |
| **`buyer_type`** | **0 tabel** | **0 baris** | Tidak ada tabel/kolom dengan atribut ini di seluruh database |
| **`broker`** | **0 tabel** | **0 baris** | Tidak ada tabel/kolom yang menyimpan breakdown broker di database |
| **`flow`** | **0 tabel** (broksum) | **944 baris** | 941 baris di `stock_fundamentals` (terkait *free cash flow*), 1 baris di `stock_boards`, 1 di `stock_daily_features`, 1 di `telegram_daily_picks`. **Nol baris terkait broker summary**. |
| **`asing`** | **0 tabel** | **0 baris** | Tidak ada |
| **`foreign`** | **3 tabel** | **118.589 baris** | Hanya menyimpan NBSA makro (bukan broker summary), lihat rincian di bawah. |

### 3.3 Rincian 3 Tabel Berisi Kata `foreign`
1. **`foreign_watchlist_daily`:**
   - **Total Baris:** 6.755 baris
   - **Rentang Tanggal:** `2026-07-21` s.d. `2026-08-11` (periode upload manual CSV admin)
   - **Jumlah Saham:** 965 saham unik
   - **Kolom yang Dimuat:** `foreign_buy`, `foreign_sell`, `foreign_net`, `nbsa`
   - **Status Data:** Data makro NBSA bursa, **tidak memuat breakdown kode broker asing**.
2. **`stock_daily_history`:**
   - **Total Baris:** 111.025 baris
   - **Rentang Tanggal:** `2026-02-19` s.d. `2026-10-16`
   - **Jumlah Saham:** 962 saham unik
   - **Kolom yang Dimuat:** `foreign_buy_value`, `foreign_sell_value`, `foreign_net_value`, `foreign_buy_lot`, `foreign_sell_lot`, `foreign_net_lot`
   - **Status Data:** Candle harian EOD (sumber Yahoo/bursa), **tidak memuat data broker summary**.
3. **`stock_daily_features`:**
   - **Total Baris:** 809 baris (snapshot fitur teknikal hari berjalan: `foreign_net_today`, `foreign_net_3d`, `foreign_net_streak`).

### 3.4 Status PostgreSQL
Pemeriksaan koneksi PostgreSQL lokal:
- Perintah: `pg_isready`
- Hasil: `/var/run/postgresql:5432 - no response` (Layanan Postgres lokal tidak aktif / aplikasi menggunakan SQLite lokal dan koneksi Supabase cloud untuk auth/admin).

---

## 4. AUDIT PENANGANAN CACHE & LOG PADA KODE SUMBER

Pemeriksaan alur penanganan pemanggilan `flow=F` pada modul Bandarmologi ([`lib/bandarmologi-service.js:2062-2101`](lib/bandarmologi-service.js:2062)):

### 4.1 Mekanisme Pemanggilan On-Demand
Komentar resmi arsitektur pada baris 2062 menegaskan:
```javascript
// Foreign/Domestic flow filtering is not part of the backfilled disk cache
// (which only holds the combined/"all" view), so a flow-filtered request
// always goes straight to the live Arjum API for a single date rather than
// serving disk-cached "all" data under a misleading filter.
if (isFlowFiltered) {
  if (!arjumClient.hasArjumApiKey()) {
    return { success: false, error: 'Filter Foreign/Domestic butuh koneksi API live (ARJUM_API_KEY belum tersedia).' };
  }
  const [sumRes, accRes, insRes] = await Promise.all([
    arjumClient.fetchBrokerSummary(ticker, targetDate, flow),
    arjumClient.fetchBrokerAccumulation(ticker),
    arjumClient.fetchInsiders(ticker, 1, 15)
  ]);
  ...
  setCache(cacheKey, payload);
  return Object.assign({ success: true, live: true }, payload);
}
```

### 4.2 Sifat Penyimpanan `setCache` vs `writeDiskCache`
1. **Hanya Tersimpan di RAM ([`lib/bandarmologi-service.js:105-130`](lib/bandarmologi-service.js:105)):**
   - Fungsi [`setCache()`](lib/bandarmologi-service.js:118) hanya menulis ke variabel memori proses:
     ```javascript
     const MEMORY_CACHE = new Map();
     ```
   - Karakteristik `MEMORY_CACHE`:
     * Masa kedaluwarsa (*TTL*): Dibatasi maksimal **15 menit** (`Math.min(ttlMs, 15 * 60 * 1000)`).
     * Kapasitas maksimum: Maksimal **300 entri** (entri tertua otomatis dihapus via LRU eviction).
     * Ketahanan (*persistence*): Data **lenyap seketika** jika proses Node.js di-restart atau setelah 15 menit.
2. **Tidak Pernah Ditulis ke Disk ([`lib/bandarmologi-service.js:232`](lib/bandarmologi-service.js:232)):**
   - Fungsi [`writeDiskCache()`](lib/bandarmologi-service.js:232) sama sekali **TIDAK PERNAH DIPANGGIL** di dalam blok `isFlowFiltered`.
   - [`writeDiskCache()`](lib/bandarmologi-service.js:232) hanya dipanggil di baris 2400 untuk panggilan umum tanpa parameter `flow` (`flow: "all"`).
3. **Skrip Koleksi Harian VPS ([`tools/run-daily-broker-update.js:437`](tools/run-daily-broker-update.js:437)):**
   - Skrip yang dijalankan oleh cron job EOD setiap sore hanya memanggil:
     ```javascript
     const res = await arjumClient.fetchBrokerSummary(ticker, dateArg);
     ```
     Parameter `flow` tidak dikirimkan, sehingga Arjum selalu mengembalikan versi gabungan (`flow: "all"`).
   - Log eksekusi `/home/ubuntu/auto-cuan-runner/logs/daily-broker-update.log` mengonfirmasi bahwa runner hanya mengambil versi `all`.

---

## 5. KESIMPULAN AKHIR

Berdasarkan sensus 100% terhadap 186.912 file broker summary, audit seluruh 17 database SQLite, pencarian filesystem komprehensif, dan penelusuran eksekusi kode:

> ### **Broksum asing tidak tersimpan; halaman mengambilnya langsung dari API saat dibuka.**

*(Catatan Teknis: Seluruh 186.625 file broker summary yang tersimpan di disk VPS sejak 2 Januari 2026 hingga 16 Oktober 2026 adalah versi gabungan seluruh investor atau `flow="all"`. Permintaan data broker summary asing `flow=F` pada halaman Bandarmologi bersifat live on-demand dan hanya disimpan sementara di RAM proses maksimal 15 menit tanpa pernah ditulis ke disk atau database).*
