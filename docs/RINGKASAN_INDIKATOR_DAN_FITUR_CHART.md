# RINGKASAN INDIKATOR DAN FITUR CHART WORKSTATION AUTO-CUAN

Dokumen ini mendokumentasikan spesifikasi teknis resmi, arsitektur layer, formula matematis eksak, 5 mode strategi dinamis, simulasi backtest scale-out, dan integrasi kuantitatif Screener Saham pada **Chart Workstation Auto-Cuan**.

---

## 1. DAFTAR 25 LAYER INDIKATOR (9 KATEGORI)

Chart Workstation mendukung 25 layer teknikal dan bandarmologi yang dikelompokkan ke dalam 9 kategori modular. Seluruh layer diatur secara independen melalui drawer pengaturan layer atau diaktifkan serentak melalui tombol preset mode.

### Kategori 1: Level & Area
1. **Support & Resistance (S/R) (`sr_levels`)**
   - **Lokasi Kode**: [`public/chart-workstation.js:828`](public/chart-workstation.js:828) ([`calculateSwingPivots()`](public/chart-workstation.js:828)) dan [`public/market-feature-runtime.js:431`](public/market-feature-runtime.js:431).
   - **Formula Eksak**: Menggunakan deteksi **5-bar Fractal Pivot High & Low** dalam jendela lookback mode aktif (8-60 bar):
     $$\text{Swing High: } H_t > H_{t-1}, H_t > H_{t-2}, H_t \ge H_{t+1}, H_t > H_{t+2}$$
     $$\text{Swing Low: } L_t < L_{t-1}, L_t < L_{t-2}, L_t \le L_{t+1}, L_t < L_{t+2}$$
     Tingkat harga dibulatkan ke fraksi tick IDX resmi. Jika fractal tidak ditemukan, sistem memiliki fallback ke nilai ekstrem $\min(L)$ dan $\max(H)$.
   - **Cara Membaca**: Garis putus-putus biru menandakan batas atas pasokan (Resistance), garis hijau menandakan batas bawah permintaan (Support).
2. **Visual Trading Plan (`trading_plan`)**
   - **Lokasi Kode**: [`public/chart-workstation.js:554`](public/chart-workstation.js:554) ([`calculateTradingPlan()`](public/chart-workstation.js:554)).
   - **Formula Eksak**:
     $$\text{Entry} = \text{roundToTick}(C_{\text{latest}})$$
     $$\text{Stop Loss (SL)} = \text{roundToTick}(\text{Support}_{\text{closed}} \times \text{slBufferPct})$$
     $$\text{Risk} = \text{Entry} - \text{SL}$$
     $$\text{Target 1 (TP1)} = \text{roundToTick}(\text{Entry} + \text{Risk} \times \text{tp1Multiplier})$$
     $$\text{Target 2 (TP2)} = \text{roundToTick}(\text{Entry} + \text{Risk} \times \text{tp2Multiplier})$$
     $$\text{R/R Ratio} = \frac{\text{TP1} - \text{Entry}}{\text{Risk}} \ge 1.50\text{x}$$
   - **Cara Membaca**: Empat garis horizontal interaktif: Biru Muda (Entry), Merah (Stop Loss), Hijau Muda (TP1 50%), dan Hijau Tua (TP2 50%).

### Kategori 2: Tren & EMA
3. **MA 20 (Hijau) (`ma20`)**: Rata-rata pergerakan sederhana 20 periode: $\text{SMA}_{20} = \frac{1}{20}\sum_{i=0}^{19} C_{t-i}$.
4. **MA 50 (Kuning) (`ma50`)**: Rata-rata pergerakan 50 periode sebagai garis tren menengah.
5. **MA 100 (Biru) (`ma100`)**: Moving average 100 periode untuk support dinamis tren primer.
6. **MA 200 (Ungu) (`ma200`)**: Batas pemisah pasar Bullish vs Bearish jangka panjang.
7. **EMA 20 (Sian) (`ema20`)**:
   $$\text{EMA}_{20, t} = C_t \times \left(\frac{2}{21}\right) + \text{EMA}_{20, t-1} \times \left(1 - \frac{2}{21}\right)$$
8. **EMA 50 (Merah Muda) (`ema50`)**: Exponential moving average 50 periode responsif.
9. **Bollinger Bands (20, 2) (`bollinger`)**:
   $$\text{Middle} = \text{SMA}_{20}, \quad \text{Upper} = \text{Middle} + 2\sigma, \quad \text{Lower} = \text{Middle} - 2\sigma$$

### Kategori 3: Struktur Pasar
10. **Break of Structure (BOS) (`market_structure`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:894`](public/chart-workstation.js:894) ([`calculateBOS()`](public/chart-workstation.js:894)) dan [`public/market-feature-runtime.js:460`](public/market-feature-runtime.js:460).
    - **Formula Eksak**:
      $$\text{Bullish BOS} \iff C_t > \text{Recent Swing High}$$
      $$\text{Bearish BOS} \iff C_t < \text{Recent Swing Low}$$
    - **Cara Membaca**: Garis titik sian horizontal menandakan titik konfirmasi kelanjutan tren naik (Bullish BOS), sedangkan garis titik magenta menandakan konfirmasi pembalikan tren turun (Bearish BOS).

### Kategori 4: Sinyal
11. **Marker Sinyal Beli/Jual (`signal_markers`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:1913`](public/chart-workstation.js:1913) ([`calculateHistoricalBacktest()`](public/chart-workstation.js:1913)) dan [`public/market-feature-runtime.js:630`](public/market-feature-runtime.js:630).
    - **Formula Eksak**: Mengambil penanda eksekusi dari mesin backtest: panah hijau `BUY` di bawah bar candle, serta panah `TP1 50%`, `TP2 WIN`, `BEP 50%`, atau `SL` di atas bar candle saat posisi ditutup.

### Kategori 5: Volume
12. **Bar Volume Transaksi (`volume_bars`)**: Histogram volume harian dengan kode warna hijau ($C \ge O$) dan merah ($C < O$).
13. **Volume Rata-rata 20 Hari (`vol_avg20`)**: Garis acuan likuiditas rata-rata bergerak 20 periode.
14. **Volume Profile (`vol_profile`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:951`](public/chart-workstation.js:951) ([`calculateVolumeProfile()`](public/chart-workstation.js:951)) dan [`public/market-feature-runtime.js:475`](public/market-feature-runtime.js:475).
    - **Formula Eksak**:
      - Membagi rentang harga $[\min(L), \max(H)]$ 60 bar terakhir ke dalam 12 zona harga (bins).
      - Menjumlahkan akumulasi volume pada setiap bin berdasarkan Typical Price $(\frac{H+L+C}{3})$.
      - **POC (Point of Control)**: Bin harga dengan volume akumulasi tertinggi.
      - **Value Area (VAH & VAL)**: Rentang harga di sekitar POC yang mencakup 70% dari total volume transaksi.
    - **Cara Membaca**: Garis tebal oranye menandakan harga yang paling banyak ditransaksikan (POC). Area antara garis VAH dan VAL mencerminkan zona konsensus nilai pasar yang adil.

### Kategori 6: Fibonacci
15. **Fibonacci Retracement (`fibonacci`)**
    - **Lokasi Kode**: [`api/quote.js:2986`](api/quote.js:2986) dan [`public/market-feature-runtime.js:560`](public/market-feature-runtime.js:560).
    - **Formula Eksak**: Mengukur swing 60 bar dengan rasio emas 23.6%, 38.2%, 50.0%, 61.8%, dan 78.6% yang diselaraskan dengan fraksi harga resmi BEI.

### Kategori 7: Pola Klasik
16. **Pola Grafik Klasik (`classic_patterns`)**
    - **Lokasi Kode**: [`lib/classic-chart-patterns.js:25`](lib/classic-chart-patterns.js:25).
    - **Formula Eksak**: Regresi linear batas atas dan bawah untuk mendeteksi *Ascending/Descending/Symmetrical Triangle*, *Bull/Bear Flag*, serta deteksi fractal ganda untuk *Double Bottom* dan *Double Top*.

### Kategori 8: Osilator
17. **RSI 14 (`rsi14`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:446`](public/chart-workstation.js:446).
    - **Formula Eksak**: Wilder's Smoothing RMA:
      $$\text{RSI} = 100 - \frac{100}{1 + \frac{\text{AvgGain}}{\text{AvgLoss}}}$$
18. **MACD (12, 26, 9) (`macd`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:468`](public/chart-workstation.js:468).
    - **Formula Eksak**: $\text{MACD Line} = \text{EMA}_{12}(C) - \text{EMA}_{26}(C)$, $\text{Signal} = \text{EMA}_9(\text{MACD})$, $\text{Histogram} = \text{MACD} - \text{Signal}$.

### Kategori 9: Kuantitatif Bandar Metrics
19. **Liquidity Pressure Model (LPM) (`bandar_lpm`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:799`](public/chart-workstation.js:799) ([`calculateLPMSeries()`](public/chart-workstation.js:799)), [`public/market-feature-runtime.js:335`](public/market-feature-runtime.js:335), dan [`lib/market-intelligence-engine.js:530`](lib/market-intelligence-engine.js:530).
    - **Formula Eksak & Proyeksi Rentang Harga**:
      1. Menghitung Money Flow Multiplier harian:
         $$\text{MFM}_t = \frac{(C_t - L_t) - (H_t - C_t)}{H_t - L_t \parallel 1}$$
      2. Menghitung Tekanan Likuiditas harian tertimbang omset:
         $$\text{LiqPressure}_t = \text{MFM}_t \times \text{Turnover}_t \quad (\text{Turnover}_t = V_t \times C_t)$$
      3. Akumulasi berjalan Tekanan Likuiditas:
         $$\text{CumLiq}_t = \sum_{j=1}^t \text{LiqPressure}_j$$
      4. Normalisasi dan proyeksi ke skala harga saham berjalan (20 periode):
         $$\text{NormPressure}_t = \frac{\text{CumLiq}_t - \overline{\text{CumLiq}}_{20}}{\frac{\max(\text{CumLiq}_{20}) - \min(\text{CumLiq}_{20})}{2}}$$
         $$\text{LPM}_t = \text{round}\left(\overline{C}_{20} + \text{NormPressure}_t \times \text{HalfPriceRange}_{20} \times 1.35\right)$$
    - **Cara Membaca & Bullish LPM Divergence**:
      - Garis hijau LPM di-overlay langsung pada canvas harga candlestick (menggunakan skala harga kanan yang sama).
      - **Bullish LPM Divergence**: Ketika harga saham bergerak sideways atau turun tipis, tetapi akumulasi likuiditas bandar terus meningkat sehingga garis hijau LPM bergerak naik drastis menembus harga candlestick ke atas. Ini merupakan indikasi kuat akumulasi tersembunyi (*smart money absorption*).
      - **Bearish LPM Divergence**: Ketika harga dipompa ke level tinggi namun garis LPM menukik tajam ke bawah harga, menandakan distribusi bandar ke antrean bid ritel.
20. **Kumulatif Aliran Asing (`bandar_foreign`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:714`](public/chart-workstation.js:714) ([`calculateForeignFlowCumulative()`](public/chart-workstation.js:714)).
    - **Formula Eksak**: Akumulasi berkesinambungan aliran bersih asing: $\text{CumForeign}_t = \text{CumForeign}_{t-1} + \text{NetForeign}_t$.
21. **Smart Money Flow / CMF (`bandar_cmf`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:684`](public/chart-workstation.js:684) ([`calculateCMF()`](public/chart-workstation.js:684)).
    - **Formula Eksak**:
      $$\text{MFM} = \frac{(C - L) - (H - C)}{H - L}, \quad \text{CMF} = \frac{\sum_{i=1}^{20} \text{MFM}_i \times V_i}{\sum_{i=1}^{20} V_i}$$
22. **Histogram Intensitas Bandar (`bandar_intensity`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:736`](public/chart-workstation.js:736) ([`calculateIntensityHistogram()`](public/chart-workstation.js:736)) dan [`lib/market-intelligence-engine.js:578`](lib/market-intelligence-engine.js:578).
    - **Formula Eksak (Ukuran Aktivitas Non-Negatif $\ge 0$)**:
      $$\text{VolRatio} = \frac{V_t}{\text{SMA}_{20}(V)_t}$$
      $$\text{BodyRatio} = \frac{|C_t - O_t|}{H_t - L_t \parallel 1}$$
      $$\text{Intensity} = \text{VolRatio} \times (0.40 + 0.60 \times \text{BodyRatio}) \ge 0$$
    - **Kode Warna Standar Video Auto-Cuan**:
      - **Hijau (`#10b981`)**: Jika $C \ge O$ (aktivitas didominasi oleh inisiator beli/buyer).
      - **Merah (`#ef4444`)**: Jika $C < O$ (aktivitas didominasi oleh inisiator jual/seller).
      - **Oranye / Kuning (`#f59e0b`)**: Jika $\text{Intensity} \ge 2.0\text{x}$ (lonjakan intensitas ekstrem di atas 200% rata-rata, menandakan intervensi pasar yang tidak biasa).
23. **Histogram Rotasi Volume (`bandar_rotation`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:766`](public/chart-workstation.js:766) ([`calculateVolumeRotation()`](public/chart-workstation.js:766)).
    - **Formula Eksak**: Rasio turnover harian terhadap median turnover 20 hari terakhir.
24. **Korelasi Harga-Asing / Corr F (`bandar_corr_f`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:1035`](public/chart-workstation.js:1035) ([`calculateCorrF()`](public/chart-workstation.js:1035)).
    - **Formula Eksak**: Korelasi Pearson bergulir 20 hari antara return harian harga dan aliran bersih asing.
25. **Partisipasi Asing / Par F (`bandar_par_f`)**
    - **Lokasi Kode**: [`public/chart-workstation.js:1081`](public/chart-workstation.js:1081) ([`calculateParF()`](public/chart-workstation.js:1081)).
    - **Formula Eksak**: Porsi volume transaksi beli dan jual investor asing terhadap total omset bursa dua arah:
      $$\text{Par F} = \frac{\sum (\text{ForeignBuy} + \text{ForeignSell})}{\sum V \times 2} \times 100\%$$

---

## 2. TABEL PARAMETER 5 MODE STRATEGI & TIMEFRAME

| Parameter Strategi | SIMPEL | SCALPING | SWING | INVESTOR | PRO |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Gaya Trading** | Baseline Swing | Fast Momentum | Trend Following | Position Value | Multi-Factor Quant |
| **Lookback S/R Pivot** | 20 Lilin | 8 Lilin | 20 Lilin | 60 Lilin | 30 Lilin |
| **Stop Loss Buffer** | 3% di bawah support | 3 Tick (~1.5% - 2.5%) | 3.5% di bawah support | 8% di bawah support | 4% di bawah support |
| **Target Profit 1 (50%)** | $+1.60 \times \text{Risk}$ | $+1.50 \times \text{Risk}$ | $+1.60 \times \text{Risk}$ | $+1.80 \times \text{Risk}$ | $+1.75 \times \text{Risk}$ |
| **Target Profit 2 (50%)** | $+2.80 \times \text{Risk}$ | $+2.50 \times \text{Risk}$ | $+2.80 \times \text{Risk}$ | $+3.50 \times \text{Risk}$ | $+3.00 \times \text{Risk}$ |
| **Syarat Entry Beli** | $C > \text{MA20} \land V \ge 1.05\text{x}$ | $C > \text{EMA20} \land V \ge 1.15\text{x}$ | $C > \text{MA20} \land \text{MA20} \ge \text{MA50}$ | $C > \text{MA50} \land C > \text{MA200}$ | $C > \text{MA20} \land \text{CMF} \ge 0 \land V \ge 1.05\text{x}$ |
| **Max Hold (1D)** | 12 Hari | 3 Hari | 12 Hari | 45 Hari | 15 Hari |
| **Max Hold (1W)** | 6 Minggu | 2 Minggu | 6 Minggu | 16 Minggu | 8 Minggu |

---

## 3. MEKANISME REAL SCALE-OUT & SINKRONISASI RISK GATE

### Logika Eksekusi 50% TP1 / 50% TP2 (BEP Protection):
1. **Realisasi Leg 1 (50% Lot)**: Ketika harga tertinggi bar mencapai level Target 1 (`high >= tp1`), 50% posisi langsung direalisasikan pada harga TP1. Return bersih dihitung setelah dipotong fee beli (0.15%) dan jual (0.25%).
2. **Kunci Modal (Trailing Stop to BEP)**: Stop loss untuk 50% lot sisanya digeser ke level harga Entry (`currentPos.sl = currentPos.entry`).
3. **Realisasi Leg 2 (50% Lot Sisa)**: Keluar saat menyentuh TP2, terkena stop di level BEP, atau batas waktu holding days habis.
4. **Hasil Bersih Positif**: Meskipun 50% sisa posisi terkena exit di harga entry (BEP), akumulasi keuntungan dari Leg 1 tetap menghasilkan keuntungan bersih positif, sehingga trade tercatat secara akurat sebagai **WIN (`isWin = true`)**.

### Sinkronisasi Mutlak Risk Gate Bagian J ($R/R \ge 1.50\text{x}$):
- Screener Saham menghitung target harga secara dinamis dengan syarat wajib $\frac{\text{TP1} - \text{Entry}}{\text{Entry} - \text{SL}} \ge 1.50\text{x}$.
- Jarak risiko Stop Loss dikunci secara proporsional (maksimal 4% untuk Scalping dan 8% untuk Swing) agar tidak terjadi deviasi ekstrem.
- Saat user menekan tombol **"Buka di Chart Workstation"**, fungsi `openScreenerInChartWorkstation` mengoper preset dan level harga yang sudah tervalidasi lolos Risk Gate, memastikan antarmuka tidak lagi memunculkan peringatan ditolak.
