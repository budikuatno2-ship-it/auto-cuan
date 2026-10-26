# Panduan Ekspor Data TradingView untuk Paritas Indikator LPM BRPT

Sesuai instruksi audit pada `audit/AUTO_CUAN_AUDIT.md` bagian B6 dan Langkah 1 prompt paritas & backtest, file referensi TradingView belum ditemukan di repositori maupun direktori lokal.

Agar proses porting indikator menghasilkan paritas identik (*bit-exact*) dan backtest dapat dieksekusi secara valid tanpa angka fabrikasi/sintetis, pemilik produk diminta untuk menyediakan file referensi berikut:

---

## 1. Lokasi Penempatan File Target

1. **File CSV Data Bar & Plot Indikator:**
   - Path target: `audit/reference/BRPT_1D_tradingview.csv`
2. **File Kode Sumber Pine Script (Sangat Direkomendasikan):**
   - Path target: `audit/reference/lpm.pine`

---

## 2. Yang Perlu Diekspor dari TradingView

### A. Konfigurasi Chart
- **Ticker:** `BRPT` (Barito Pacific Tbk, IDX)
- **Timeframe:** `1D` (Daily)
- **Range Data:** Seluruh riwayat yang tersedia di chart TradingView (semakin panjang rentang bar, semakin komprehensif uji paritas dan backtest).

### B. Indikator yang Harus Terpasang di Chart
Pastikan indikator-indikator berikut aktif dan nilainya ter-plot di panel chart sebelum diekspor:
1. **Liquidity Pressure Model (LPM)**
2. **Foreign Flow** (akumulasi/net foreign flow)
3. **Money Flow** (atau MFV/CMF yang digunakan)
4. **Corr F** (Foreign Correlation)
5. **Par F** (Foreign Participation)
6. **Intensity** (Intensity Histogram)
7. **Volume Rotation**

### C. Kolom yang Wajib Ada di File CSV
Hasil ekspor harus memuat:
- Kolom waktu: `time` (format ISO `YYYY-MM-DD` atau UNIX timestamp)
- Kolom candlestick: `open`, `high`, `low`, `close`, `volume`
- Kolom data plot untuk masing-masing indikator di atas (misalnya `Foreign Flow`, `Money Flow`, `Corr F`, `Par F`, `Intensity`, `Volume Rotation`).

---

## 3. Langkah-Langkah Ekspor dari TradingView

1. Buka aplikasi web atau desktop **TradingView** dan muat layout chart Anda untuk **BRPT (1D)**.
2. Pastikan semua plot indikator di atas telah muncul pada chart.
3. Klik tombol menu **Opsi Chart** (ikon titik tiga atau menu dropdown di toolbar atas chart).
4. Pilih opsi **"Export chart data..."** (atau **"Unduh data chart..."**).
5. Pada kotak dialog ekspor:
   - Pilih format **ISO time format** (jika tersedia opsi).
   - Pastikan semua indikator tercentang untuk ikut diekspor.
   - Klik **Export**.
6. Simpan/pindahkan file hasil download tersebut ke:
   `d:\auto-cuan-2\audit\reference\BRPT_1D_tradingview.csv`
7. Buka tab **Pine Editor** di bagian bawah chart TradingView pada indikator LPM:
   - Salin seluruh kode Pine Script indikator tersebut.
   - Buat file baru dan simpan kode tersebut ke:
     `d:\auto-cuan-2\audit\reference\lpm.pine`

---

## 4. Kelanjutan Eksekusi

Setelah file `audit/reference/BRPT_1D_tradingview.csv` dan `audit/reference/lpm.pine` tersedia:
1. Jalankan kembali prompt ini.
2. Sistem akan memvalidasi data CSV (rentang tanggal, jumlah baris, satuan volume lot vs lembar).
3. Porting fungsi murni (*pure function*) ke `backtest/brpt-lpm/indicators.js`.
4. Uji paritas menyeluruh di `backtest/brpt-lpm/parity.test.js` bar demi bar.
5. Eksekusi backtest sinyal objektif dan penyusunan `backtest/brpt-lpm/REPORT.md`.
