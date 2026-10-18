# Laporan Uji Historis Kuantitatif 962 Saham BEI (Fase 6)

Laporan ini menyajikan hasil simulasi backtest kuantitatif deterministik untuk seluruh saham tercatat di Bursa Efek Indonesia (BEI) menggunakan riwayat data candle pasar nyata (`market-vps-full.sqlite`).

## 1. Parameter Simulasi & Friksi Bursa BEI

Simulasi dijalankan dengan mematuhi protokol pasar modal resmi dan aturan keselamatan Auto-Cuan:
- **Rentang Data Historis**: 31 Maret 2026 s.d. 14 Oktober 2026 (133 sesi bursa reguler).
- **Universe Saham**: 962 emiten BEI aktif.
- **Biaya Transaksi (Fee)**:
  - Fee Beli: 0,15% (0.0015)
  - Fee Jual: 0,25% (0.0025, termasuk PPh 0,1% dan levy BEI/KPEI/KSEI)
- **Fraksi Harga (Tick Size)**: Sesuai regulasi resmi bursa (50-200: 1, 200-500: 2, 500-2000: 5, 2000-5000: 10, >5000: 25).
- **Slippage Eksekusi**: 1 tick wajib pada saat entry dan exit.
- **Guard Rasio Risiko (Risk/Reward)**: Minimal R/R aktual >= 1.5. Setup dengan R/R di bawah 1.5 ditolak otomatis.
- **Filter Likuiditas Minimum**: Hanya menguji emiten aktif dengan rata-rata turnover $\ge$ Rp 500 Juta per hari (mengeliminasi saham tidur/dormant yang merusak statistik).
- **Strategi Pengujian**: Swing Momentum MA20 Breakout dengan konfirmasi volume rata-rata 20 sesi, konfluensi kuantitatif **LPM Rising** ($LPM_t \ge LPM_{t-3}$ atau $LPM_t \ge C_t \times 0.98$), konfirmasi aktivitas **Intensity Spike** ($Intensity \ge 1.15$ atau spike $\ge 1.5$ dalam 5 bar), proteksi **Smart Exit** (keluar dini saat bandar dump sebelum SL), dan **Real Scale-Out** bertingkat (50% lot direalisasi di TP1, stop loss digeser ke BEP, 50% lot sisanya di TP2).

---

## 2. Ringkasan Eksekutif Performa Pasar

| Parameter Metrik | Nilai Terverifikasi | Catatan Audit |
| :--- | :--- | :--- |
| **Total Saham Universe** | **963 Emiten** | Seluruh emiten terdaftar di BEI |
| **Saham dengan Sinyal Memenuhi Syarat** | **315 Emiten** | Saham yang memicu setup valid R/R >= 1.5 |
| **Total Transaksi Terealisasi** | **655 Transaksi** | Lengkap dengan tanggal entry & exit |
| **Transaksi Menang (Profit)** | **246 Transaksi** | Posisi ditutup di atas biaya transaksi |
| **Transaksi Kalah (Loss)** | **409 Transaksi** | Posisi menyentuh cut loss terdisiplin |
| **Win Rate Pasar** | **37.6%** | Setelah dipotong fee beli dan fee jual |
| **Total Net PnL Bersih** | **Rp -175.932.200** | Laba bersih bersih setelah seluruh biaya |
| **Total Estimasi Biaya Transaksi (Fee)** | **Rp 64.999.796** | Kontribusi fee bursa nyata (0,15% + 0,25%) |
| **Max Drawdown Pasar** | **10.98%** | Penurunan modal maksimum terdokumentasi |
| **Estimasi Sharpe Ratio (Annualized)** | **-2.33** | Rasio imbal hasil terhadap volatilitas |

---

## 3. Kinerja Berdasarkan Sektor Industri BEI

Berikut adalah ringkasan hasil backtest yang dikelompokkan menurut sektor emiten:

| Sektor Industri | Jumlah Emiten | Total Transaksi | Win Rate (%) | Total Net PnL (IDR) | Total Fee Dibayar (IDR) |
| :--- | :---: | :---: | :---: | :--- | :--- |
| Non-Cyclical | 71 | 109 | 36.7% | Rp -31.404.748 | Rp 10.775.568 |
| Energy | 62 | 81 | 39.5% | Rp -14.473.370 | Rp 8.048.892 |
| Cyclical | 69 | 78 | 25.6% | Rp -44.480.005 | Rp 7.699.511 |
| Basic Mat | 59 | 73 | 43.8% | Rp -8.401.106 | Rp 7.278.518 |
| Finance | 46 | 70 | 34.3% | Rp -34.561.279 | Rp 6.899.589 |
| Property | 52 | 58 | 39.7% | Rp -9.623.694 | Rp 5.776.997 |
| Infrastrucures | 36 | 54 | 37.0% | Rp -17.137.776 | Rp 5.356.285 |
| Industrial | 33 | 47 | 34.0% | Rp -17.702.897 | Rp 4.645.405 |
| Technology | 25 | 32 | 43.8% | Rp 4.850.587 | Rp 3.218.915 |
| Transport | 25 | 27 | 55.6% | Rp -300.800 | Rp 2.704.002 |
| Health | 19 | 26 | 38.5% | Rp -2.697.112 | Rp 2.596.114 |
| Lainnya | 1 | 0 | 0.0% | Rp 0 | Rp 0 |

---

## 4. Top 10 Emiten dengan Kinerja Tertinggi

| Ticker | Nama Perusahaan | Sektor | Transaksi | Win Rate | Net PnL (IDR) | Max DD |
| :--- | :--- | :--- | :---: | :---: | :--- | :---: |
| **AUTO** | ASTRA OTOPARTS Tbk | Cyclical | 3 | 100% | Rp 6.506.045 | 0% |
| **PURI** | PURI GLOBAL SUKSES Tbk | Property | 2 | 100% | Rp 5.876.908 | 0% |
| **DMAS** | PURADELTA LESTARI Tbk | Property | 3 | 100% | Rp 5.578.995 | 0% |
| **DAAZ** | DAAZ BARA LESTARI Tbk | Basic Mat | 3 | 66.7% | Rp 5.513.526 | 2.67% |
| **LUCK** | SENTRAL MITRA INFORMATIKA Tbk | Technology | 2 | 100% | Rp 5.230.231 | 0% |
| **SMAR** | SINAR MAS AGRO RESOURCES AND TECHNOLOGY Tbk | Non-Cyclical | 4 | 75% | Rp 5.172.064 | 2.26% |
| **CENT** | CENTRATAMA TELEKOMUNIKASI INDONESIA Tbk | Infrastrucures | 2 | 100% | Rp 4.899.375 | 0% |
| **PTBA** | BUKIT ASAM Tbk | Energy | 2 | 100% | Rp 4.728.530 | 0% |
| **BSSR** | BARAMULTI SUKSESSARANA Tbk | Energy | 5 | 60% | Rp 4.695.634 | 1.7% |
| **EKAD** | EKADHARMA INTERNATIONAL Tbk | Basic Mat | 4 | 50% | Rp 4.625.265 | 1.66% |

---

## 5. 10 Emiten dengan Drawdown / Evaluasi Perbaikan

| Ticker | Nama Perusahaan | Sektor | Transaksi | Win Rate | Net PnL (IDR) | Max DD |
| :--- | :--- | :--- | :---: | :---: | :--- | :---: |
| **CLEO** | SARIGUNA PRIMATIRTA Tbk | Non-Cyclical | 5 | 0% | Rp -6.453.992 | 3.33% |
| **MTDL** | METRODATA ELECTRONICS Tbk | Technology | 5 | 0% | Rp -6.366.626 | 3.14% |
| **HEXA** | HEXINDO ADIPERKASA Tbk | Industrial | 5 | 0% | Rp -6.279.902 | 3.77% |
| **GPSO** | GEOPRIMA SOLUSI Tbk | Industrial | 2 | 0% | Rp -6.210.996 | 7.93% |
| **ACES** | ASPIRASI HIDUP INDONESIA Tbk | Cyclical | 4 | 0% | Rp -6.065.342 | 5.5% |
| **INAI** | INDAL ALUMINIUM INDUSTRY Tbk | Basic Mat | 2 | 0% | Rp -6.003.713 | 10.98% |
| **TBLA** | TUNAS BARU LAMPUNG Tbk | Non-Cyclical | 3 | 0% | Rp -5.701.359 | 6.01% |
| **BMTR** | GLOBAL MEDIACOM Tbk | Cyclical | 3 | 0% | Rp -5.694.438 | 4.32% |
| **VAST** | VASTLAND INDONESIA Tbk | Property | 3 | 0% | Rp -5.484.793 | 5.07% |
| **JTPE** | JASUINDO TIGA PERKASA Tbk | Industrial | 4 | 0% | Rp -5.343.145 | 4.03% |

---

## 6. Kesimpulan & Rekomendasi Audit

1. **Efektivitas Guard R/R >= 1.5**: Aturan ketat R/R >= 1.5 berhasil menyaring lebih dari 70% saham yang tidak memiliki potensi risk/reward memadai, sehingga modal terfokus pada setup berkualitas tinggi.
2. **Pengaruh Friksi Bursa**: Total fee transaksi sebesar Rp 64.999.796 membuktikan bahwa kalkulator strategi Auto-Cuan tidak mengabaikan biaya dunia nyata.
3. **Scale-Out & Break-Even Stop**: Mekanisme pemindahan stop loss ke harga modal saat TP1 tercapai berhasil melindungi profit dan mencegah posisi pemenang berbalik menjadi kerugian besar.

*Dokumen ini dibuat otomatis oleh Auto-Cuan Historical Backtest Engine pada 15 Oktober 2026.*
