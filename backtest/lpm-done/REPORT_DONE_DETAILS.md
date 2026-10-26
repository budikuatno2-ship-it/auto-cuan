# LAPORAN EVALUASI ENDPOINT ARJUM `/api/done-details` UNTUK LIQUIDITY PRESSURE MODEL (LPM) BERBASIS TRANSAKSI

> **Klasifikasi:** Laporan Teknis Evaluasi API & Kelayakan Order Flow / Tape Reading  
> **Target Endpoint:** `GET https://stock.arjum.com/api/done-details`  
> **Tanggal Evaluasi:** 17 Oktober 2026  
> **Lingkungan Pengujian:** Oracle VPS Produksi (`ubuntu@168.110.221.197`, Read-Only)  
> **Total Request Digunakan:** 29 request (dari batas keras maksimal 40 request, rate limit $\le 2\text{ req/detik}$)  
> **Artefak Sampel:** [`backtest/lpm-done/sample_BRPT_20261016.json`](backtest/lpm-done/sample_BRPT_20261016.json) (200 baris pertama transaksi BRPT 16 Okt 2026)  
> **Prinsip AntiSlop §107:** Bukti empiris tanpa fabrikasi, field absen ditulis "tidak ada", tanpa mencetak kunci rahasia.

---

## 1. DOKUMENTASI PARAMETER ENDPOINT

Berdasarkan probe empiris dan pengujian respon error HTTP 422 terhadap endpoint `https://stock.arjum.com/api/done-details`:

### 1.1 Parameter Wajib (Required)
- `code` (string, query parameter): Kode saham Bursa Efek Indonesia (misal: `BRPT`, `BBCA`).
  - Bila parameter ini tidak disertakan, server FastAPI Arjum mengembalikan respon **HTTP 422 Unprocessable Entity**:
    ```json
    {
      "detail": [
        {
          "type": "missing",
          "loc": ["query", "code"],
          "msg": "Field required",
          "input": null
        }
      ]
    }
    ```

### 1.2 Parameter Opsional yang Didukung
- `date` (string, format `YYYY-MM-DD`): Tanggal sesi bursa yang diminta (misal: `2026-10-16`).
  - Bila tidak disertakan, server otomatis mengembalikan data sesi bursa **terakhir / hari berjalan**.
- `page` (integer, query parameter $\ge 1$): Nomor halaman transaksi. Default adalah `1`.
- `per_page` (integer, query parameter): Jumlah baris transaksi per halaman.
  - **Batas Keras Server:** Maksimal **100 baris per request** (`le = 100`).
  - Jika klien meminta `per_page=200`, `500`, atau `1000`, server menolak dengan **HTTP 422**:
    ```json
    {
      "detail": [
        {
          "type": "less_than_equal",
          "loc": ["query", "per_page"],
          "msg": "Input should be less than or equal to 100",
          "input": "200",
          "ctx": { "le": 100 }
        }
      ]
    }
    ```

### 1.3 Parameter yang Tidak Didukung (Diabaikan oleh Server)
- **Filter Papan Bursa (`board` / `market_board`):**
  - Parameter `board=RG` atau `board=NG` diabaikan oleh server. Nilai `total` dan baris data transaksi yang dikembalikan tetap mencakup seluruh papan (pasar Reguler `RG` dan Negosiasi `NG` bercampur). Penyaringan papan bursa **wajib dilakukan di sisi klien/worker**.
- **Filter Jam / Waktu Transaksi (`start_time`, `hour`, `time_range`):**
  - Parameter jam diabaikan oleh server; server selalu mengembalikan transaksi terurut mundur dari penutupan sesi ($16:15 \rightarrow 09:00$ WIB).
- **Paging Cursor / Offset:**
  - Tidak menggunakan cursor token; paging murni berbasis offset halaman numerik (`page` dan `per_page`).

---

## 2. PENGUJIAN JANGKAUAN RIWAYAT HISTORIS (HISTORY DEPTH PROBE)

Pengujian dilakukan untuk mengetahui sejauh mana data transaksi *tick-by-tick* (done details) disimpan di server Arjum untuk emiten acuan **BRPT**:

| Tanggal yang Diuji | Status HTTP | Total Transaksi di Server | Baris Dikembalikan | Status Ketersediaan Data |
|---|---|---|---|---|
| **16 Okt 2026** (Hari bursa terakhir) | 200 OK | **7.412 baris** | 100 (p.1) | **TERSEDIA PENUH** |
| **12 Okt 2026** | 200 OK | **12.657 baris** | 100 (p.1) | **TERSEDIA PENUH** |
| **05 Okt 2026** | 200 OK | **9.844 baris** | 100 (p.1) | **TERSEDIA PENUH** |
| **01 Okt 2026** | 200 OK | **8.188 baris** | 100 (p.1) | **TERSEDIA PENUH** |
| **30 Sep 2026** | 200 OK | **10.334 baris** | 100 (p.1) | **TERSEDIA PENUH** |
| **25 Sep 2026** | 200 OK | **9.666 baris** | 100 (p.1) | **TERSEDIA PENUH** |
| **18 Sep 2026** | 200 OK | **9.641 baris** | 100 (p.1) | **TERSEDIA PENUH** |
| **15 Sep 2026** | 200 OK | **9.662 baris** | 100 (p.1) | **TERSEDIA PENUH** |
| **10 Sep 2026** | 200 OK | **16.664 baris** | 100 (p.1) | **TERSEDIA PENUH** |
| **08 Sep 2026** | 200 OK | **14.688 baris** | 100 (p.1) | **TERSEDIA (Batas Awal)** |
| **04 Sep 2026** (Jumat) | 200 OK | **0 baris** | 0 | **KOSONG / KADALUWARSA** |
| **03 Sep 2026** | 200 OK | **0 baris** | 0 | **KOSONG / KADALUWARSA** |
| **02 Sep 2026** | 200 OK | **0 baris** | 0 | **KOSONG / KADALUWARSA** |
| **01 Sep 2026** | 200 OK | **0 baris** | 0 | **KOSONG / KADALUWARSA** |
| **02 Jan 2026** | 200 OK | **0 baris** | 0 | **KOSONG / KADALUWARSA** |

### Kesimpulan Rentang Riwayat:
Server Arjum menerapkan kebijakan retensi bergulir (*rolling retention*) sekitar **30–40 hari kalender terakhir (efektif sejak 8 September 2026)**. Data transaksi per detik sebelum September 2026 (termasuk awal tahun 2026, 2025, 2020) **tidak tersedia** di endpoint ini.

---

## 3. STRUKTUR DATA TRANSAKSI & PEMENUHAN ELEMEN KRITIS LPM

Setiap baris transaksi di dalam array `data` mengembalikan objek dengan 15 field lengkap:

### 3.1 Contoh Data Riil (1 Baris Transaksi BRPT 16 Okt 2026):
```json
{
  "time": "16:10:35",
  "market_date": "2026-10-16",
  "market_board": "RG",
  "price": "1,210",
  "price_num": 1210,
  "lot": "15",
  "qty_num": 15,
  "value_raw": 1815000,
  "buyer": "CC",
  "seller": "MG",
  "buyer_type": "D",
  "seller_type": "D",
  "buy_order_number": "202610160004851521",
  "sell_order_number": "202610160004563176",
  "action": "BUY"
}
```

### 3.2 Matriks 8 Elemen Kritis untuk Pembentukan LPM Kuantitatif:
| Elemen Kritis yang Dibutuhkan | Status di Endpoint | Nama Field | Nilai Contoh | Keterangan & Nilai Analisis |
|---|---|---|---|---|
| **Waktu sampai detik** | **ADA** | `time` | `"16:10:35"` | Presisi waktu tinggi (WIB, format `HH:MM:SS`). |
| **Harga Transaksi** | **ADA** | `price_num` | `1210` | Tersedia tipe numerik integer langsung tanpa pemisah ribuan. |
| **Lot atau Volume** | **ADA** | `qty_num` | `15` | Jumlah lot transaksi (1 lot = 100 lembar $\rightarrow$ 1.500 lembar). |
| **Nilai Nominal Transaksi** | **ADA** | `value_raw` | `1815000` | Nilai transaksi dalam Rupiah ($15 \times 100 \times 1.210 = \text{Rp } 1.815.000$). |
| **Sisi Agresor (Order Flow Side)** | **ADA** | `action` | `"BUY"` / `"SELL"` | **Sangat Krusial:** Menunjukkan apakah transaksi terjadi karena pembeli memakan antrian offer (`BUY`) atau penjual menghantam bid (`SELL`). |
| **Kode Broker Pembeli & Penjual** | **ADA** | `buyer`, `seller` | `"CC"`, `"MG"` | Kode broker 2 huruf anggota bursa BEI. |
| **Tipe Investor (Domestik/Asing)** | **ADA** | `buyer_type`, `seller_type` | `"D"` / `"F"` | `"D"` = Domestik, `"F"` = Asing (*Foreign*). |
| **Papan Bursa (Market Board)** | **ADA** | `market_board` | `"RG"`, `"NG"` | Memungkinkan pemisahan pasar Reguler (`RG`) vs Negosiasi (`NG`). |

### 3.3 Perbandingan Karakteristik BRPT vs BBCA (16 Okt 2026):
- **Barito Pacific Tbk (`BRPT`):**
  * Total transaksi: **7.412 baris**.
  * Jumlah request halaman (`per_page=100`): **75 request**.
  * Ukuran payload JSON mentah per halaman: **~30,2 KB**.
  * Total estimasi payload mentah 1 hari: **~2,26 MB**.
  * Waktu respon server per request: **500 ms – 1.640 ms** (rata-rata ~650 ms).
- **Bank Central Asia Tbk (`BBCA`):**
  * Total transaksi: **185.087 baris**.
  * Jumlah request halaman (`per_page=100`): **1.851 request**.
  * Ukuran payload JSON mentah per halaman: **~30,1 KB**.
  * Total estimasi payload mentah 1 hari: **~55,7 MB**.
  * Waktu respon server per request: **~489 ms**.

### 3.4 Informasi Header Kuota & Rate Limiting:
Pada setiap panggilan sukses, server Arjum menyertakan response header kuota:
- `x-quota-cost`: `"1"` (setiap request mengonsumsi 1 kuota).
- `x-ratelimit-limit`: `"6328"` (total kuota harian akun).
- `x-ratelimit-remaining`: `"4427"` (sisa kuota saat pengujian selesai).

---

## 4. ESTIMASI BEBAN PENGAMBILAN HARIAN (SELURUH BURSA VS TARGET SELEKTIF)

### 4.1 Estimasi Beban jika Mengambil Seluruh Bursa (± 950 Saham):
- Saham teraktif/bluechip papan atas (Top 20 seperti BBCA, BBRI, BMRI, BBNI, ASII) mencatatkan 40.000 s.d. 185.000 transaksi/hari ($\approx 400 - 1.850\text{ request/saham}$).
- Saham lapis dua aktif (Top 21–100) mencatatkan 3.000 s.d. 15.000 transaksi/hari ($\approx 30 - 150\text{ request/saham}$).
- Saham lapis tiga / illikuid (850 saham) mencatatkan 10 s.d. 1.000 transaksi/hari ($\approx 1 - 10\text{ request/saham}$).
- **Total Request Seluruh Bursa per Hari:** Diperkirakan mencapai **$\mathbf{20.000 - 35.000\text{ request/hari}}$**.
  - **Kendala Kuota Kritis:** Batas harian API Arjum tercatat **6.328 request/hari** (`x-ratelimit-limit`). Mengambil seluruh data transaksi detail 950 saham setiap hari **TIDAK MUNGKIN DILAKUKAN** karena melampaui kuota API lebih dari $300\%$.
  - **Waktu Eksekusi:** Pada batas aman 2 request/detik, $25.000\text{ request}$ membutuhkan $12.500\text{ detik} \approx \mathbf{3{,}5\text{ jam}}$ proses unduh nonstop.
  - **Ukuran Data Mentah:** Sekitar **$600\text{ MB} - 1{,}2\text{ GB}$ per hari** ($\approx 15 - 25\text{ GB}$ per bulan).

### 4.2 Solusi Praktis: Pengambilan Terarah (Universe Likuid / Screener):
Jika koleksi harian dibatasi khusus untuk **50 saham teraktif (Top Liquid)**:
- Total request: $50\text{ saham} \times 40\text{ request rata-rata} \approx \mathbf{2.000\text{ request/hari}}$ (hanya ~31% dari kuota harian 6.328).
- Waktu unduh: $\approx 1.000\text{ detik} = \mathbf{16{,}6\text{ menit}}$ (sangat realistis dijalankan pasca penutupan bursa pukul 16:30 WIB).

### 4.3 Efisiensi Penyimpanan Agregat Harian per Saham (Pre-Computed LPM Metrics):
Alih-alih menyimpan jutaan baris JSON mentah di disk VPS, worker pengumpul dapat langsung memproses transaksi saat diunduh dan hanya menyimpan **1 baris ringkasan agregat per saham per hari** (~10 angka kuantitatif):
1. `trade_date` (tanggal bursa)
2. `ticker` (kode saham)
3. `aggressive_buy_vol` (total volume transaksi agresor beli / hajar kanan)
4. `aggressive_sell_vol` (total volume transaksi agresor jual / hajar kiri)
5. `aggressive_buy_val` (total nominal rupiah beli agresif)
6. `aggressive_sell_val` (total nominal rupiah jual agresif)
7. `foreign_buy_aggr_val` (nominal beli agresif oleh investor asing)
8. `foreign_sell_aggr_val` (nominal jual agresif oleh investor asing)
9. `vwap_aggressive_buy` (harga rata-rata tertimbang pembeli agresif)
10. `vwap_aggressive_sell` (harga rata-rata tertimbang penjual agresif)

- **Ukuran Penyimpanan Agregat:**
  - $950\text{ saham} \times 1\text{ baris} \times 100\text{ byte} \approx \mathbf{95\text{ KB per hari}}$!
  - 1 tahun perdagangan (250 sesi): hanya **$\mathbf{\sim 23{,}7\text{ MB per tahun}}$** (sangat ringan dan muat di SQLite VPS tanpa membebani disk).

---

## 5. REKOMENDASI TEKNIS UNTUK PEMBANGUNAN LPM AUTO-CUAN

Data dari endpoint `/api/done-details` adalah **emas kuantitatif** untuk bandarmologi dan *order flow*:
1. **Perhitungan LPM Sejati:** Alih-alih mengestimasi Liquidity Pressure dari formula candle harian ($MFM = \frac{(C-L)-(H-C)}{H-L}$), LPM dapat dihitung langsung dari **Net Aggressive Buying Pressure** riil:
   $$\text{LPM Pressure} = \text{Aggressive Buy Value} - \text{Aggressive Sell Value}$$
2. **Level Support/Resistance Likuiditas:** Level LPM institusi adalah harga rata-rata transaksi agresif bervolume besar (*large-lot block trades*).
3. **Pemisahan Pasar:** Worker wajib memfilter `market_board === 'RG'` agar transaksi *crossing* negosiasi (`NG`) yang sering kali menggunakan harga diskon/anomali tidak mendistorsi perhitungan harga wajar likuiditas.

---

## 6. KESIMPULAN AKHIR

Sesuai kriteria kesimpulan baku pada prompt:

> ### **KESIMPULAN: RIWAYAT TERSEDIA**  
> **(Sejak 8 September 2026 / rentang retensi bergulir ~30–40 hari kalender terakhir)**

### Implikasi Operasional:
1. **Untuk Backtest Jangka Panjang:** Endpoint ini **tidak dapat digunakan untuk backtest riwayat tahunan (2020–2025)** karena server Arjum hanya menyimpan riwayat transaksi mikro sekitar 1 bulan terakhir.
2. **Untuk Operasional Produksi:** Endpoint ini **sangat layak dan ideal digunakan untuk sistem live/harian**. Auto-Cuan disarankan mulai mengaktifkan worker pengumpul harian (*daily order flow collector*) pasca penutupan bursa untuk membangun basis data LPM berbasis transaksi riil secara mandiri ke depan.
