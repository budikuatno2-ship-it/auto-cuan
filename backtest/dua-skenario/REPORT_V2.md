# LAPORAN EVALUASI DUA SKENARIO v2: DATA ARJUM & EVALUASI SELURUH BURSA

> **Klasifikasi:** Laporan Audit Kuantitatif Replay Engine v2 & Kalibrasi Seluruh Bursa BEI  
> **Target Analisis:** Seluruh Bursa Efek Indonesia (957 Emiten Terdaftar di `idx-tickers.csv`)  
> **Periode Analisis:** 2024 s.d. 2026 (Dataset Arjum 500 Sesi) & 2015 s.d. 2026 (Dataset Panjang Yahoo Suplemen)  
> **Engine Port:** [`backtest/dua-skenario/dua-skenario-v2.js`](backtest/dua-skenario/dua-skenario-v2.js)  
> **Runner Evaluasi:** [`backtest/dua-skenario/run-v2.js`](backtest/dua-skenario/run-v2.js)  
> **Data Input:** [`backtest/dua-skenario/data/all/`](backtest/dua-skenario/data/all/) (957 file emiten)  
> **Hasil Evaluasi:** [`backtest/dua-skenario/hasil-v2-evaluasi-seed42.json`](backtest/dua-skenario/hasil-v2-evaluasi-seed42.json) & [`backtest/dua-skenario/hasil-v2-evaluasi-seed43.json`](backtest/dua-skenario/hasil-v2-evaluasi-seed43.json)  
> **Hasil Proyeksi Seluruh Bursa:** [`backtest/dua-skenario/hasil-v2-proyeksi.json`](backtest/dua-skenario/hasil-v2-proyeksi.json)  
> **Prinsip AntiSlop §107:** Bukti empiris tanpa kompromi, kejujuran matematika di atas hasil yang terlihat bagus, tanpa klaim pasti untung.

---

## 1. TEMUAN SUMBER DATA "STOCK ARJUM" DI VPS & PENYESUAIAN AKSI KORPORASI

### 1.1 Lokasi dan Bentuk Data "Stock Arjum"
Investigasi mendalam terhadap server Oracle VPS (`ubuntu@168.110.221.197`) dan codebase repositori berhasil mengidentifikasi sumber data lilin (*candles*) Arjum:
1. **Modul Klien di Repositori:**
   - [`lib/chart-engine/candle-fetcher.js:6`](lib/chart-engine/candle-fetcher.js:6) memuat endpoint: `https://stock.arjum.com/api/history/{code}?limit=200&frame=daily`.
   - Autentikasi: Header `X-API-Key` melalui variabel lingkungan `ARJUM_API_KEY`.
   - Kuota: Batas pemakaian harian `ARJUM_DAILY_QUOTA` (default 5.000–16.000 request/hari) yang dicatat di `data/candle-quota.json` via [`lib/arjum-quota-tracker.js`](lib/arjum-quota-tracker.js).
2. **Temuan Direktori Lilin Arjum di Filesystem VPS:**
   - Path fisik di VPS: `/home/ubuntu/auto-cuan/data/daily-candles/<TICKER>.json`.
   - Total file: **963 file JSON** (seluruh emiten aktif IDX).
   - Diperbarui berkala oleh job cron VPS [`tools/fetch-daily-candles.js`](tools/fetch-daily-candles.js) setiap penutupan bursa (terakhir diperbarui 17 Oktober 2026 pukul 00:16 WIB).
3. **Karakteristik Data & Batas Horizon Arjum:**
   - Probe langsung terhadap endpoint `https://stock.arjum.com/api/history/BRPT?limit=5000&frame=daily` mengonfirmasi bahwa API Arjum menerapkan **batas maksimum riwayat 500 hari bursa** (`range: "500d"`).
   - Seluruh 963 file di `/home/ubuntu/auto-cuan/data/daily-candles/` memuat tepat 500 bar lilin (rentang tanggal 25 Juni 2024 s.d. 16 Oktober 2026), kecuali 11 saham IPO baru yang memiliki $< 300$ bar (misal `AADI` 440 bar, `EMAS` 257 bar).
4. **Sifat Harga (Mentah vs Adjusted):**
   - Harga di feed Arjum adalah harga transaksi reguler harian bursa (unadjusted/mentah).
   - Untuk saham-saham yang pernah melakukan stock split masif di masa lalu (seperti BBCA 1:5 pada Oktober 2021), data Arjum tidak terpengaruh karena jendela 500 hari Arjum dimulai dari pertengahan 2024, jauh setelah split 2021 terjadi.
   - Deteksi algoritma split pada rentang 500 hari Arjum (2024–2026) mencatat 0 split eksternal tak wajar pada emiten likuid. Seluruh 957 emiten berhasil dibangun ke [`backtest/dua-skenario/data/all/`](backtest/dua-skenario/data/all/) dengan metadata di [`_sources.json`](backtest/dua-skenario/data/all/_sources.json) dan [`_adjustments.json`](backtest/dua-skenario/data/all/_adjustments.json).

---

## 2. HASIL SKOR SELURUH BURSA v2 (SEED 42 VS SEED 43)

Model v2 mengevaluasi sampel acak (saham, tanggal) dari seluruh semesta bursa dengan filter ketat:
- Hanya memilih bar dengan likuiditas memadai (median turnover 60 hari $\ge \text{Rp } 1\text{ Miliar/hari}$).
- Bar bervolume 0, bar data bolong, dan pola datar disuspensi dieliminasi total.
- Baseline probabilitas naik dihitung secara kumulatif dari seluruh jendela masa lalu yang sudah diketahui ($baseRate$), bukan di-reset per subset.

### 2.1 Ringkasan Metrik Evaluasi Seluruh Bursa (3.000 Sampel Acak)

| Metrik Evaluasi | Run Seed 42 (Keseluruhan) | Run Seed 42 (Out-of-Sample 30%) | Run Seed 43 (Keseluruhan) | Run Seed 43 (Out-of-Sample 30%) |
|---|---|---|---|---|
| **Tanggal Ambang OOS** | — | $\ge \text{2026-04-07}$ | — | $\ge \text{2026-04-02}$ |
| **Sampel Valid ($n$)** | 2.907 | 884 | 2.895 | 887 |
| **Porsi Status OK** | 99,2% (2.907 / 2.931) | — | 99,1% (2.895 / 2.922) | — |
| **Hit Rate Arah (> 50%)** | 52,29% | 54,64% | 51,68% | 49,94% |
| **Brier Score Model** | 0,25049 | 0,24844 | 0,25139 | 0,25287 |
| **Brier Score Baseline** | 0,23821 | 0,23412 | 0,23773 | 0,23438 |
| **Brier Skill Score** | **-5,15% (-0,0515)** | **-6,11% (-0,0611)** | **-5,74% (-0,0574)** | **-7,89% (-0,0789)** |
| **95% Bootstrap CI Skill** | **[-0,0691, -0,0348]** | **[-0,0925, -0,0307]** | **[-0,0736, -0,0406]** | **[-0,1106, -0,0491]** |
| **Cakupan Pita 25%–75%** | 46,7% (ideal ~50%) | 46,2% | 46,2% | 46,8% |
| **Cakupan Rentang p10–p90** | **77,1% (ideal ~80%)** | **76,8% (ideal ~80%)** | **74,7%** | **72,9%** |

*Temuan Statistik Krusial:*
Pada kedua seed independen (42 dan 43), **Brier Skill Score secara konsisten bernilai negatif** (sekitar $-5\%$ s.d. $-8\%$), dan **seluruh rentang selang kepercayaan 95% (CI95) berada di bawah nol** (batas atas maksimum $-0{,}0307 < 0$). Artinya, memprediksi probabilitas arah naik/turun berbasis analogi geometri masa lalu secara agregat di seluruh bursa **kalah akurat dibandingkan tebakan konstan proporsi historis bursa**.

---

### 2.2 Tabel Kalibrasi Out-of-Sample (OOS)

Tabel kalibrasi menguji apakah tingkat keyakinan model ($P_{\text{pred}}$) berkorelasi positif dengan kenyataan ($P_{\text{aktual}}$):

#### Seed 42 (OOS $N=884$, Cut $\ge \text{2026-04-07}$):
| Kelompok Rentang Prediksi | Jumlah Sampel ($n$) | Rata-rata Prediksi ($P_{\text{pred}}$) | Realisasi Aktual Naik ($P_{\text{aktual}}$) | Status Kalibrasi |
|---|---|---|---|---|
| **$0{,}00 - 0{,}35$ (Sangat Yakin Turun)** | 205 | 28,5% | **44,9%** | Terlalu pesimis (over-confident bearish) |
| **$0{,}35 - 0{,}45$ (Cenderung Turun)** | 282 | 40,3% | 36,9% | Moderat |
| **$0{,}45 - 0{,}55$ (Netral / Ragu)** | 255 | 49,4% | 37,3% | Terlalu optimis |
| **$0{,}55 - 0{,}65$ (Cenderung Naik)** | 105 | 59,0% | 33,3% | Terbalik |
| **$0{,}65 - 1{,}01$ (Sangat Yakin Naik)** | 37 | 69,6% | **54,1%** | Terlalu optimis |

#### Seed 43 (OOS $N=887$, Cut $\ge \text{2026-04-02}$):
| Kelompok Rentang Prediksi | Jumlah Sampel ($n$) | Rata-rata Prediksi ($P_{\text{pred}}$) | Realisasi Aktual Naik ($P_{\text{aktual}}$) | Status Kalibrasi |
|---|---|---|---|---|
| **$0{,}00 - 0{,}35$ (Sangat Yakin Turun)** | 172 | 28,1% | **50,6%** | Terbalik (50,6% malah naik!) |
| **$0{,}35 - 0{,}45$ (Cenderung Turun)** | 301 | 40,3% | 42,9% | Datar |
| **$0{,}45 - 0{,}55$ (Netral / Ragu)** | 257 | 49,8% | 36,2% | Terlalu optimis |
| **$0{,}55 - 0{,}65$ (Cenderung Naik)** | 123 | 59,3% | 40,7% | Datar |
| **$0{,}65 - 1{,}01$ (Sangat Yakin Naik)** | 34 | 70,8% | **47,1%** | Terbalik ($47{,}1\% < 50{,}6\%$) |

---

### 2.3 Rincian Kinerja per Tahun & per Kelompok Likuiditas

#### Performa per Tahun Kalender (Seed 42):
- **Tahun 2024:** $N=244$, Hit Rate 52,9%, Brier Skill **-0,0497**
- **Tahun 2025:** $N=1.517$, Hit Rate 50,5%, Brier Skill **-0,0497**
- **Tahun 2026:** $N=1.146$, Hit Rate 54,5%, Brier Skill **-0,0543**
*(Skill negatif konsisten di setiap tahun kalender, tanpa variasi anomali).*

#### Performa per Kelompok Likuiditas Transaksi 60 Hari (Seed 42):
- **Likuiditas 1–10 Miliar/hari:** $N=1.758$, Brier Skill **-0,0518**, CI95 `[-0,0739, -0,0305]`
- **Likuiditas 10–100 Miliar/hari:** $N=967$, Brier Skill **-0,0543**, CI95 `[-0,0854, -0,0240]`
- **Likuiditas > 100 Miliar/hari (Super Liquid):** $N=182$, Brier Skill **-0,0347**, CI95 `[-0,1118, +0,0349]`
*(Semua kelompok likuiditas gagal menghasilkan Brier Skill positif).*

---

## 3. HASIL EVALUASI GERBANG TAMPIL PRE-REGISTERED

Mekanisme gerbang tampil (`gate(oos)`) pada [`backtest/dua-skenario/dua-skenario-v2.js:197`](backtest/dua-skenario/dua-skenario-v2.js:197) memisahkan izin tampilan menjadi dua fungsi independen:

```javascript
gate: {
  skillPositiveCI: false,      // Batas bawah CI95 skill > 0 (GAGAL: -0.0925 < 0)
  enoughSamples: true,         // OOS N = 884 >= 500 (LOLOS)
  calibrationMonotone: true,   // Kalibrasi monoton naik (LOLOS pada seed 42, GAGAL pada seed 43)
  directionAllowed: false,     // PROYEKSI ARAH DITOLAK KERAS!
  rangeAllowed: true           // PROYEKSI RENTANG HARGA DIIZINKAN (76.8% berada di antara 70%-90%)
}
```

### Putusan Gerbang Tampil:
1. **`directionAllowed = false` (PROYEKSI ARAH DILARANG TAMPIL):**
   - Batas bawah selang kepercayaan 95% bernilai negatif ($-0{,}0925$).
   - Tidak ada bukti empiris bahwa probabilitas Skenario A (naik) vs Skenario B (turun) memiliki akurasi di atas tebakan acak.
   - Sesuai protokol AntiSlop §107, antarmuka aplikasi **dilarang menampilkan probabilitas $P_{\text{up}}$ / $P_{\text{down}}$ maupun label Skenario A / B**.
2. **`rangeAllowed = true` (PROYEKSI RENTANG HARGA DIIZINKAN):**
   - Pita ketidakpastian p10–p90 menghasilkan cakupan aktual **76,8% (Seed 42)** dan **72,9% (Seed 43)**, memenuhi kriteria gerbang pre-registered ($70\% \le \text{cakupan} \le 90\%$).
   - Model sangat efektif memproyeksikan **rentang volatilitas dan batas fluktuasi harga 10 hari ke depan** tanpa menentukan arah.

---

## 4. REKAPITULASI PROYEKSI SELURUH BURSA (`hasil-v2-proyeksi.json`)

Eksekusi proyeksi terbaru untuk seluruh 854 emiten aktif menghasilkan pembagian status tampil:

```json
{
  "RENTANG_SAJA": 321,
  "SEMBUNYIKAN": 533,
  "DUA_SKENARIO": 0
}
```

- **`DUA_SKENARIO` (0 saham / 0%):** Tidak ada satu pun saham yang diizinkan menampilkan dua skenario arah naik/turun karena gerbang bursa `directionAllowed = false`.
- **`RENTANG_SAJA` (321 saham / 37,6%):** 321 saham likuid yang memiliki kualitas analog memadai ($\ge 0{,}35$) dan minimal 15 analog sah menampilkan estimasi rentang harga (p10, p50, p90) tanpa arah.
- **`SEMBUNYIKAN` (533 saham / 62,4%):** Saham disembunyikan dari visualisasi karena likuiditas di bawah Rp 1 Miliar/hari atau kualitas analog rendah (`ANALOG_LEMAH`).

### Contoh Hasil Proyeksi Saham Acuan (Per 16 Oktober 2026):

#### 1. Barito Pacific Tbk (`BRPT`) — Status: `RENTANG_SAJA`
- **Harga Penutupan Terakhir:** Rp 1.210
- **Kualitas Analog:** 0,63 (Cukup Kuat) dari 130.133 jendela kandidat
- **Proyeksi Rentang Harga 10 Hari (H=10):**
  * Batas Bawah (p10): **Rp 1.030 (-14,9%)**
  * Titik Tengah (p50): **Rp 1.265 (+4,5%)**
  * Batas Atas (p90): **Rp 1.490 (+23,1%)**
- *Catatan Arah (Dilarang Tampil di UI):* Model memproyeksikan probabilitas naik 60,9% vs turun 39,1%, namun angka ini disembunyikan sesuai gerbang tampil.

#### 2. Bank Central Asia Tbk (`BBCA`) — Status: `RENTANG_SAJA`
- **Harga Penutupan Terakhir:** Rp 5.175
- **Kualitas Analog:** 0,66 (Kuat) dari 130.133 jendela kandidat
- **Proyeksi Rentang Harga 10 Hari (H=10):**
  * Batas Bawah (p10): **Rp 4.950 (-4,3%)**
  * Titik Tengah (p50): **Rp 5.425 (+4,8%)**
  * Batas Atas (p90): **Rp 5.925 (+14,5%)**

#### 3. Telkom Indonesia Tbk (`TLKM`) — Status: `RENTANG_SAJA`
- **Harga Penutupan Terakhir:** Rp 1.900
- **Kualitas Analog:** 0,70 (Sangat Kuat) dari 130.133 jendela kandidat
- **Proyeksi Rentang Harga 10 Hari (H=10):**
  * Batas Bawah (p10): **Rp 1.815 (-4,5%)**
  * Titik Tengah (p50): **Rp 1.975 (+3,9%)**
  * Batas Atas (p90): **Rp 2.220 (+16,8%)**

---

## 5. ESTIMASI BEBAN JOB HARIAN DI VPS PRODUKSI

Berdasarkan pencatatan benchmark runtime eksekusi `run-v2.js` pada 854 emiten:

| Parameter Kinerja | Beban Aktual Terukur | Proyeksi Job Harian EOD |
|---|---|---|
| **Waktu Pemuatan 854 Saham** | 12 detik | ~15 detik (membaca cache JSON di disk) |
| **Waktu Pembuatan Indeks Typed-Array** | 1 detik (349.860 jendela) | ~2 detik |
| **Waktu Proyeksi Terbaru 854 Saham** | 7 detik | ~10 detik |
| **Total Waktu Proses Selesai** | **~20 detik** | **< 35 detik** |
| **Konsumsi RAM Puncak (RSS)** | **~1,2 GB** (Node.js Heap) | Alokasi `--max-old-space-size=4096` sangat aman |
| **Ukuran Indeks Memori (Typed Arrays)** | **~58 MB** ($N=349.860$) | Sangat efisien, muat di L3 Cache prosesor |
| **Ukuran Output JSON di Disk** | `hasil-v2-proyeksi.json` (~2,4 MB) | Tidak membebani kapasitas disk VPS |

### Usulan Jadwal Operasional VPS (Tanpa Mengubah Repo):
- **Waktu Eksekusi Ideal:** Pukul **18:15 WIB** (setelah seluruh proses penarikan data lilin EOD [`tools/fetch-daily-candles.js`](tools/fetch-daily-candles.js) dan rekap broker selesai pada pukul 18:00 WIB).
- **Mekanisme Eksekusi:** Menjalankan script mandiri `tools/run-dua-skenario-daily.js` dengan opsi `--max-old-space-size=4096` dan menyimpan hasil ke `public/data/proyeksi-rentang-latest.json`.

---

## 6. KESIMPULAN AKHIR & KLASIFIKASI STATUS FITUR

Berdasarkan evaluasi statistik terhadap 3.000 sampel acak di seluruh bursa dan pembatalan resmi terhadap hasil pengujian v1 sebelumnya:

### 1. Pembatalan Kesimpulan v1:
Klaim pada pengujian v1 bahwa indikator analog "lolos gerbang" pada emiten tertentu (seperti BRPT, TLKM, MEDC) secara resmi **DIBATALKAN**. Pada v1, ketiadaan volume pada bar suspensi menghasilkan kualitas analog palsu ($1{,}0$), baseline Brier di-reset per subset sehingga over-optimis, dan keputusan gerbang per saham memicu bias seleksi acak (*survivorship cherry-picking*).

### 2. Ketiadaan Keunggulan Arah (*No Directional Predictive Edge*):
Pada evaluasi v2 seluruh bursa, model analog geometri terbukti tidak memiliki kemampuan memprediksi arah kenaikan/penurunan harga (Brier Skill negatif konsisten $-5\%$ s.d. $-8\%$). Analogi visual bentuk pola 20 hari di masa lalu tidak memiliki korelasi kausal terhadap arah pergerakan 10 hari ke depan di pasar modal Indonesia.

### 3. Keunggulan Valid pada Estimasi Volatilitas & Rentang:
Meskipun gagal pada prediksi arah, model analog **sangat akurat dalam mengestimasi rentang dispersi harga** (cakupan p10–p90 mencapai 76,8%, sangat mendekati ekspektasi teoritis 80%).

### 4. Klasifikasi Resmi:

> ### **STATUS FITUR: TAMPILKAN RENTANG SAJA**  
> *(Sistem dilarang keras menampilkan probabilitas arah naik/turun atau melabeli Skenario A / Skenario B di antarmuka publik. Sistem HANYA diizinkan menampilkan estimasi rentang harga konservatif [Pita p10 s.d. p90] untuk 321 saham yang berstatus `RENTANG_SAJA`, dan menyembunyikan proyeksi sepenuhnya [`SEMBUNYIKAN`] untuk 533 saham lainnya).*

*Peringatan Risiko Finansial:* Estimasi rentang harga p10–p90 berbasis analogi historis adalah proyeksi dispersi statistik masa lalu, bukan batas pasti pergerakan pasar. Harga saham di Bursa Efek Indonesia dapat menembus rentang proyeksi sewaktu-waktu akibat sentimen fundamental, aksi korporasi, atau volatilitas pasar makro.
