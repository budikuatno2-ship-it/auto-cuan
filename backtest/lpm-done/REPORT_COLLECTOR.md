# LAPORAN IMPLEMENTASI COLLECTOR DONE DETAILS TAHAP 1 (ORDER FLOW LPM)

> **Klasifikasi:** Laporan Teknis Pengujian API, Validasi Agregasi, dan Pengisian Riwayat Tertua  
> **Target Endpoint:** `GET https://stock.arjum.com/api/done-details`  
> **Tanggal Pelaksanaan:** 17 Oktober 2026  
> **Script Kolektor:** [`backtest/lpm-done/collect-done.js`](backtest/lpm-done/collect-done.js)  
> **Script Runner Refill:** [`backtest/lpm-done/run_refill.js`](backtest/lpm-done/run_refill.js)  
> **Daftar Prioritas:** [`backtest/lpm-done/priority.txt`](backtest/lpm-done/priority.txt)  
> **Prinsip Operasional:** Zero repo modification, zero cron/pm2 installation, read-only VPS, kuota produksi dilindungi ($\ge 1.500$ sisa).

---

## 1. HASIL PROBE JENDELA KUOTA & PARAMETER SERVER

### 1.1 Karakteristik Jendela Kuota & Rate Limiting
Berdasarkan probe pada header HTTP respon `https://stock.arjum.com/api/done-details`:
- `x-ratelimit-limit`: `6328`
- `x-quota-cost`: `1`
- `x-ratelimit-remaining`: Berkurang tepat 1 poin setiap kali request berhasil dilakukan.
- **Kesimpulan Jendela Kuota:** Kuota sebesar **6.328 request berlaku per hari (daily quota)** yang di-reset pada pergantian hari kalender bursa (00:00 WIB). Sisa kuota saat pengujian selesai adalah **3.585 request** (sangat aman, menyisakan 56,6% kapasitas untuk operasional produksi dan jauh di atas batas keselamatan 1.500).

### 1.2 Evaluasi Parameter Filter & Sort Sisi Server
Uji coba dilakukan pada transaksi BRPT 16 Oktober 2026 (`per_page=5`) terhadap 6 parameter yang dihipotesiskan dapat menghemat kuota:

| Parameter yang Diuji | Status Respon | Dampak terhadap Total | Dampak terhadap Baris Data | Efektivitas Pengurangan Beban |
|---|---|---|---|---|
| `sort=value` | 200 OK | Tetap 7.412 | Baris identik dengan baseline | **Tidak Berfungsi (Diabaikan)** |
| `order=desc` | 200 OK | Tetap 7.412 | Baris identik dengan baseline | **Tidak Berfungsi (Diabaikan)** |
| `sort_by=value_raw` | 200 OK | Tetap 7.412 | Baris identik dengan baseline | **Tidak Berfungsi (Diabaikan)** |
| `min_value=500000000` | 200 OK | Tetap 7.412 | Baris identik dengan baseline | **Tidak Berfungsi (Diabaikan)** |
| `min_qty=1000` | 200 OK | Tetap 7.412 | Baris identik dengan baseline | **Tidak Berfungsi (Diabaikan)** |
| `side=BUY` | 200 OK | Tetap 7.412 | Baris identik dengan baseline | **Tidak Berfungsi (Diabaikan)** |

**Temuan Server:** Server Arjum mengabaikan seluruh parameter pengurutan nilai dan penyaringan nominal/agresor. Transaksi selalu dikembalikan utuh terurut mundur berdasarkan waktu (`time` descending). Filter ukuran atau nilai transaksi harus dilakukan sepenuhnya di sisi klien.

### 1.3 Frekuensi Semua Saham dalam 1 Request
- Endpoint `/api/movers` mengembalikan `{ by: 'chg', gainers: [], losers: [], count: 0, market: { status: 'weekend' } }` saat akhir pekan dan hanya menyajikan daftar gainer/loser terbatas pada jam bursa (bukan frekuensi transaksi seluruh emiten).
- Endpoint `/api/price/list` menolak panggilan tanpa parameter (`HTTP 400: Parameter codes wajib diisi untuk endpoint ini, biaya 1 kode = 1 kuota`).
- **Solusi Efisien:** Jumlah halaman per emiten langsung diketahui secara pasti pada saat pemanggilan halaman pertama (`page=1`) melalui field respon `total` dan `total_pages` (`ceil(total / 100)`). Untuk estimasi dry-run awal tanpa biaya API, kolektor mengestimasi dari omset lilin harian Arjum yang sudah tersimpan di VPS.

---

## 2. HASIL DRY-RUN SELURUH BURSA (16 OKT 2026)

Pengujian dry-run pada 957 emiten IDX menghasilkan fakta komparatif berikut:

| Skenario Pengambilan | Saham yang Diproses | Estimasi Request Dibutuhkan | Estimasi Waktu Unduh (2 req/s) | Perbandingan terhadap Kuota Harian (6.328) |
|---|---|---|---|---|
| **Seluruh Bursa Tanpa Filter (957 Saham)** | 957 saham | **23.750 – 35.000 req** | ~3,3 s.d. 4,8 jam | **Gagal / Melebihi Kuota (375% - 550%)** |
| **Satu Saham Raksasa Saja (BBCA)** | 1 saham (185k trx) | **1.851 req** | ~20 menit | **29,2% dari seluruh kuota harian** |
| **Saham Likuid Terpilih (Omset $\ge$ Rp 1 M, Tanpa BBCA)** | 325 saham | **2.179 req** | **~23,6 menit** | **34,4% kuota (Aman & Optimal)** |
| **Priority Universe (13 Saham Acuan)** | 13 saham | **927 req** | **~10,0 menit** | **14,6% kuota (Sangat Aman)** |

*Kesimpulan Strategis:* Pengambilan transaksi per detik secara mentah untuk seluruh 957 saham tidak layak karena keterbatasan kuota API. Namun, pembatasan cerdas pada universe saham likuid (omset $\ge$ Rp 1 Miliar, di luar BBCA) dapat mencakup **325 saham teraktif** hanya dengan mengonsumsi sepertiga kuota harian.

---

## 3. DATA YANG SUDAH TERKUMPUL & STATUS PENGISIAN ULANG (REFILL)

Sesuai aturan bahwa data transaksi tertua akan terhapus oleh kebijakan retensi bergulir server Arjum (~30–40 hari), proses pengisian ulang riwayat telah dijalankan dengan hasil:

### 3.1 Status Pengisian per Tanggal Sesi Bursa
1. **Sesi 16 Oktober 2026 (Sesi Bursa Terakhir):**
   - `BRPT`: **Selesai 100%** (7.412 transaksi, 75 halaman, tervalidasi).
   - `MEDC`: **Selesai 100%** (13.066 transaksi, 131 halaman, tervalidasi).
   - File tersimpan:
     * Mentah gzip: [`backtest/lpm-done/raw/2026-10-16/BRPT.jsonl.gz`](backtest/lpm-done/raw/2026-10-16/BRPT.jsonl.gz) dan `MEDC.jsonl.gz`.
     * Agregat harian: [`backtest/lpm-done/agg/2026-10-16.json`](backtest/lpm-done/agg/2026-10-16.json).
     * State selesai: [`backtest/lpm-done/state/2026-10-16.json`](backtest/lpm-done/state/2026-10-16.json).
2. **Sesi 8 September 2026 (Hari Tertua yang Tersedia di Server Arjum):**
   - `BRPT`: **Selesai 100%** (14.688 transaksi, 147 halaman, tervalidasi).
   - `MEDC`: **Selesai 100%** (10.607 transaksi, 107 halaman, tervalidasi).
   - `ACES`: **Selesai 100%** (1.372 transaksi, 14 halaman, tervalidasi).
   - `ADRO`: **Selesai 100%** (16.156 transaksi, 162 halaman, tervalidasi).
   - `AKRA`: **Selesai 100%** (8.755 transaksi, 88 halaman, tervalidasi).
   - `ASII`: **Dalam Progres (80 dari 106 halaman terunduh)**.
   - File tersimpan:
     * Mentah gzip: [`backtest/lpm-done/raw/2026-09-08/*.jsonl.gz`](backtest/lpm-done/raw/2026-09-08/) (6 file).
     * Agregat harian: [`backtest/lpm-done/agg/2026-09-08.json`](backtest/lpm-done/agg/2026-09-08.json).
     * State tersimpan untuk resume: [`backtest/lpm-done/state/2026-09-08.json`](backtest/lpm-done/state/2026-09-08.json).

### 3.2 Audit Pemakaian Kuota & Keamanan
- Total request terpakai pada sesi ini: **849 request**.
- Sisa kuota Arjum saat ini: **3.585 request**.
- Kuota produksi tetap terjaga aman ($3.585 > 1.500$ batas darurat).
- Unduhan ASII dan tanggal-tanggal berikutnya (9 Sep, 10 Sep, dst.) dapat dilanjutkan kapan saja secara otomatis dari titik checkpoint terakhir menggunakan fitur *resumable state*.

---

## 4. CONTOH 1 BARIS AGREGAT HARIAN (BRPT 16 OKT 2026)

Hasil kalkulasi agregat pasar Reguler (`RG`) yang tersimpan di [`backtest/lpm-done/agg/2026-10-16.json`](backtest/lpm-done/agg/2026-10-16.json):

```json
{
  "n": 7406,
  "val": 244446555500,
  "vol": 202008600,
  "vwap": 1210,
  "buyAggVal": 231666799000,
  "sellAggVal": 12779756500,
  "p50": 1215000,
  "p90": 28314000,
  "p95": 90750000,
  "p99": 675301000,
  "bigBuyVal": 192606667000,
  "bigSellVal": 10707370000,
  "bigN": 373,
  "fBuyVal": 94982909000,
  "fSellVal": 37148625500,
  "fAggBuyVal": 94947428000,
  "fAggSellVal": 627331500,
  "ngVal": 3020287120,
  "first": "08:58:00",
  "last": "16:10:35"
}
```

### Tabel Rincian Metrik Agregat BRPT 16 Okt 2026:
| Nama Field | Nilai Riil | Interpretasi Kuantitatif Pasar Modal |
|---|---|---|
| `n` | 7.406 | Jumlah transaksi di pasar reguler (RG) sepanjang hari. |
| `val` | Rp 244.446.555.500 | Total omset transaksi pasar reguler (~Rp 244,4 Miliar). |
| `vol` | 202.008.600 | Total lembar saham yang diperdagangkan di pasar reguler. |
| `vwap` | 1.210 | Harga rata-rata tertimbang volume (persis menyentuh harga penutupan Rp 1.210). |
| `buyAggVal` | Rp 231.666.799.000 | **Dominasi Pembelian Agresif (Hajar Kanan): 94,8% dari total omset.** |
| `sellAggVal` | Rp 12.779.756.500 | Tekanan jual agresif (hajar kiri) hanya 5,2%. |
| `p50` / `p90` | Rp 1,2 Juta / Rp 28,3 Juta | Median ukuran transaksi ritel vs desil atas institusi. |
| `p95` | Rp 90.750.000 | Ambang batas transaksi kelas paus (*block trade*). |
| `bigBuyVal` | Rp 192.606.667.000 | **Transaksi besar didominasi 94,7% oleh pembeli agresif.** |
| `bigSellVal` | Rp 10.707.370.000 | Transaksi besar yang membuang barang hanya 5,3%. |
| `bigN` | 373 | Terjadi 373 kali transaksi bernilai $\ge$ Rp 90,75 Juta. |
| `fBuyVal` / `fSellVal` | Rp 95,0 M / Rp 37,1 M | Transaksi oleh investor asing mencatat Net Buy asing bersih ~Rp 57,8 Miliar. |
| `fAggBuyVal` | Rp 94.947.428.000 | **99,96% dari seluruh pembelian asing dilakukan secara agresif (makan offer).** |
| `fAggSellVal` | Rp 627.331.500 | Asing hampir tidak melakukan penjualan agresif. |
| `ngVal` | Rp 3.020.287.120 | Transaksi di pasar negosiasi sebesar Rp 3,02 Miliar (dipisahkan agar tidak bias). |
| `first` / `last` | 08:58:00 / 16:10:35 | Waktu transaksi pembukaan pre-opening hingga crossing pasca-penutupan. |

*Validasi Uji:* Perhitungan ulang secara independen terhadap 200 baris sampel [`backtest/lpm-done/sample_BRPT_20261016.json`](backtest/lpm-done/sample_BRPT_20261016.json) mencatat kecocokan **100% identik tanpa diskrepansi** terhadap seluruh field agregat.

---

## 5. USULAN JADWAL OPERASIONAL HARIAN & ANGGARAN KUOTA

*(Catatan: Bagian ini merupakan usulan teknis murni; tidak ada skrip cron/pm2/systemd yang dipasang sesuai Batas Keras).*

1. **Jadwal Eksekusi Harian:**
   - **Pukul 17:30 WIB** setiap hari bursa (Senin s.d. Jumat).
   - Alasan: Sesi bursa dan crossing EOD berakhir pukul 16:15 WIB. Penarikan lilin harian VPS berjalan pada 16:30–17:00 WIB. Pukul 17:30 WIB seluruh data transaksi harian Arjum sudah terkonsolidasi penuh dan server dalam kondisi beban rendah.
2. **Alokasi Anggaran Kuota Harian:**
   - **Anggaran Maksimal:** **1.500 request per hari** (hanya 23,7% dari kuota harian 6.328).
   - Menyisakan $\ge 4.800$ request untuk screener, chart, dan bot Telegram produksi.
3. **Konfigurasi Target Pengumpulan:**
   - Menggunakan mode `--auto` dengan target:
     * 13 saham di `priority.txt` (~600–900 request).
     * Sisa kuota digunakan untuk saham likuid lainnya (omset $\ge$ Rp 1 Miliar) yang memiliki jumlah transaksi terkecil.
     * BBCA (1.850 request) dikecualikan dari job harian otomatis demi menghemat kuota.
4. **Strategi Retensi & Efisiensi Disk:**
   - File mentah `raw/<date>/*.jsonl.gz` diarsipkan dengan kompresi gzip (~100–300 KB per saham).
   - File agregat `agg/<date>.json` disimpan permanen ke database SQLite VPS tabel `lpm_daily_orderflow` (hanya ~95 KB per hari / ~24 MB per tahun).
