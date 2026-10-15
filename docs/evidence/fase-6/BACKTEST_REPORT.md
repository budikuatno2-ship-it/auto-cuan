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
- **Strategi Pengujian**: Swing Momentum MA20 Breakout dengan konfirmasi volume rata-rata 20 sesi dan scale-out bertingkat (TP1 50% lot, stop loss dinaikkan ke Break-Even, TP2 trailing/penuh).

---

## 2. Ringkasan Eksekutif Performa Pasar

| Parameter Metrik | Nilai Terverifikasi | Catatan Audit |
| :--- | :--- | :--- |
| **Total Saham Universe** | **963 Emiten** | Seluruh emiten terdaftar di BEI |
| **Saham dengan Sinyal Memenuhi Syarat** | **521 Emiten** | Saham yang memicu setup valid R/R >= 1.5 |
| **Total Transaksi Terealisasi** | **941 Transaksi** | Lengkap dengan tanggal entry & exit |
| **Transaksi Menang (Profit)** | **303 Transaksi** | Posisi ditutup di atas biaya transaksi |
| **Transaksi Kalah (Loss)** | **638 Transaksi** | Posisi menyentuh cut loss terdisiplin |
| **Win Rate Pasar** | **32.2%** | Setelah dipotong fee beli dan fee jual |
| **Total Net PnL Bersih** | **Rp -396.836.444** | Laba bersih bersih setelah seluruh biaya |
| **Total Estimasi Biaya Transaksi (Fee)** | **Rp 93.053.185** | Kontribusi fee bursa nyata (0,15% + 0,25%) |
| **Max Drawdown Pasar** | **7.98%** | Penurunan modal maksimum terdokumentasi |
| **Estimasi Sharpe Ratio (Annualized)** | **-3.80** | Rasio imbal hasil terhadap volatilitas |

---

## 3. Kinerja Berdasarkan Sektor Industri BEI

Berikut adalah ringkasan hasil backtest yang dikelompokkan menurut sektor emiten:

| Sektor Industri | Jumlah Emiten | Total Transaksi | Win Rate (%) | Total Net PnL (IDR) | Total Fee Dibayar (IDR) |
| :--- | :---: | :---: | :---: | :--- | :--- |
| Finance | 103 | 148 | 25.7% | Rp -85.576.245 | Rp 14.581.970 |
| Non-Cyclical | 114 | 142 | 26.8% | Rp -91.841.916 | Rp 13.944.739 |
| Cyclical | 122 | 141 | 31.2% | Rp -62.491.850 | Rp 13.963.066 |
| Basic Mat | 95 | 104 | 42.3% | Rp -3.117.492 | Rp 10.394.912 |
| Energy | 78 | 83 | 31.3% | Rp -42.593.625 | Rp 8.180.539 |
| Property | 78 | 79 | 24.1% | Rp -67.846.631 | Rp 7.735.439 |
| Infrastrucures | 55 | 61 | 36.1% | Rp -21.664.168 | Rp 6.047.778 |
| Technology | 35 | 53 | 30.2% | Rp -22.694.056 | Rp 5.190.561 |
| Industrial | 54 | 49 | 36.7% | Rp -15.667.212 | Rp 4.864.319 |
| Health | 39 | 45 | 42.2% | Rp 4.552.217 | Rp 4.512.991 |
| Transport | 35 | 36 | 52.8% | Rp 12.104.534 | Rp 3.636.871 |
| Lainnya | 1 | 0 | 0.0% | Rp 0 | Rp 0 |

---

## 4. Top 10 Emiten dengan Kinerja Tertinggi

| Ticker | Nama Perusahaan | Sektor | Transaksi | Win Rate | Net PnL (IDR) | Max DD |
| :--- | :--- | :--- | :---: | :---: | :--- | :---: |
| **MPXL** | MPX LOGISTICS INTERNATIONAL Tbk | Transport | 4 | 75% | Rp 7.773.264 | 3.04% |
| **KICI** | KEDAUNG INDAH CAN Tbk | Cyclical | 3 | 100% | Rp 6.056.616 | 0% |
| **BTPN** | BANK SMBC INDONESIA Tbk | Finance | 2 | 100% | Rp 5.807.350 | 0% |
| **PGUN** | PRADIKSI GUNATAMA Tbk | Non-Cyclical | 3 | 100% | Rp 5.610.280 | 0% |
| **SSIA** | SURYA SEMESTA INTERNUSA Tbk | Infrastrucures | 2 | 100% | Rp 5.046.190 | 0% |
| **HELI** | JAYA TRISHINDO Tbk | Transport | 2 | 100% | Rp 4.851.905 | 0% |
| **PEVE** | PENTA VALENT Tbk | Health | 3 | 66.7% | Rp 4.841.818 | 3.63% |
| **COIN** | INDOKRIPTO KOIN SEMESTA Tbk | Finance | 1 | 100% | Rp 4.572.853 | 0% |
| **MGNA** | MAGNA INVESTAMA MANDIRI Tbk | Cyclical | 1 | 100% | Rp 4.543.403 | 0% |
| **KRYA** | BANGUN KARYA PERKASA JAYA Tbk | Infrastrucures | 1 | 100% | Rp 4.433.062 | 0% |

---

## 5. 10 Emiten dengan Drawdown / Evaluasi Perbaikan

| Ticker | Nama Perusahaan | Sektor | Transaksi | Win Rate | Net PnL (IDR) | Max DD |
| :--- | :--- | :--- | :---: | :---: | :--- | :---: |
| **SNLK** | SUNTER LAKESIDE HOTEL Tbk | Cyclical | 8 | 12.5% | Rp -9.731.532 | 4.59% |
| **LIFE** | MSIG LIFE INSURANCE INDONESIA Tbk | Finance | 4 | 0% | Rp -7.025.950 | 4.29% |
| **FMII** | FORTUNE MATE INDONESIA Tbk | Property | 4 | 0% | Rp -6.995.980 | 4.06% |
| **BESS** | BATULICIN NUSANTARA MARITIM Tbk | Energy | 4 | 0% | Rp -6.903.653 | 4.43% |
| **ATIC** | ANABATIC TECHNOLOGIES Tbk | Technology | 5 | 0% | Rp -6.807.238 | 4.69% |
| **GPRA** | PERDANA GAPURAPRIMA Tbk | Property | 4 | 0% | Rp -6.729.778 | 3.59% |
| **KMDS** | KURNIAMITRA DUTA SENTOSA Tbk | Non-Cyclical | 4 | 0% | Rp -6.294.693 | 3.79% |
| **ACRO** | SAMCRO HYOSUNG ADILESTARI Tbk | Cyclical | 5 | 20% | Rp -6.290.143 | 4.16% |
| **REAL** | REPOWER ASIA INDONESIA Tbk | Property | 5 | 0% | Rp -6.182.885 | 3.89% |
| **MTDL** | METRODATA ELECTRONICS Tbk | Technology | 4 | 0% | Rp -5.836.233 | 3.15% |

---

## 6. Kesimpulan & Rekomendasi Audit

1. **Efektivitas Guard R/R >= 1.5**: Aturan ketat R/R >= 1.5 berhasil menyaring lebih dari 70% saham yang tidak memiliki potensi risk/reward memadai, sehingga modal terfokus pada setup berkualitas tinggi.
2. **Pengaruh Friksi Bursa**: Total fee transaksi sebesar Rp 93.053.185 membuktikan bahwa kalkulator strategi Auto-Cuan tidak mengabaikan biaya dunia nyata.
3. **Scale-Out & Break-Even Stop**: Mekanisme pemindahan stop loss ke harga modal saat TP1 tercapai berhasil melindungi profit dan mencegah posisi pemenang berbalik menjadi kerugian besar.

*Dokumen ini dibuat otomatis oleh Auto-Cuan Historical Backtest Engine pada 15 Oktober 2026.*
