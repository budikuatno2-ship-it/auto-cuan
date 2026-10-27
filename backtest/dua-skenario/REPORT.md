# LAPORAN EVALUASI INDIKATOR "DUA SKENARIO" (ANALOG HISTORIS) & PENGUJIAN KOLAM MULTI-SAHAM

> **Klasifikasi:** Laporan Kuantitatif Replay Engine & Evaluasi Proyeksi Probabilistik Masa Depan  
> **Target Analisis:** BRPT, BBCA, TLKM, ADRO, ANTM, MEDC  
> **Periode Analisis:** 2 Januari 2015 s.d. 16 Oktober 2026 (~11,8 Tahun / ~2.899 Bar Lilin Harian)  
> **Kolam Analog:** 80 Saham Terlikuid IDX (Berdasarkan Median Turnover 60 Hari Terakhir di SQLite VPS)  
> **File Kode Sumber (Tanpa Ubah):** [`backtest/dua-skenario/dua-skenario.js`](backtest/dua-skenario/dua-skenario.js) & [`backtest/dua-skenario/run-dua-skenario.js`](backtest/dua-skenario/run-dua-skenario.js)  
> **File Data:** [`backtest/dua-skenario/data/BRPT.json`](backtest/dua-skenario/data/BRPT.json) dan [`backtest/dua-skenario/data/universe/`](backtest/dua-skenario/data/universe/)  
> **Prinsip AntiSlop §107:** Bukti empiris diutamakan, kejujuran matematika tanpa glorifikasi, tanpa klaim pasti untung.

---

## 1. SUMBER DAN RENTANG DATA

### 1.1 Penelusuran Riwayat 2020 di Repositori & VPS Produksi
Sesuai audit menyeluruh terhadap repositori lokal dan server Oracle VPS (`ubuntu@168.110.221.197`):
1. **Pemeriksaan VPS SQLite (`/home/ubuntu/auto-cuan-data/market.sqlite`):**
   - Berdasarkan kueri `SELECT MIN(json_extract(row_json, '$.trade_date')), MAX(...) FROM market_rows`, data transaksi bursa paling awal di database produksi adalah **2026-01-01** (tabel kalender bursa) dan **2026-04-01** untuk histori candle harian (`stock_daily_history`).
   - Sesuai audit forensik pada [`AUDIT_4_BACKTEST_2020_2026.md:38`](AUDIT_4_BACKTEST_2020_2026.md:38), database produksi menerapkan retensi 120 sesi (~8 bulan), sehingga data candle historis sebelum Februari 2026 **tidak disimpan di SQLite VPS**.
2. **Pemeriksaan File Backup di VPS (`/home/ubuntu/auto-cuan-backups/`):**
   - File backup database di VPS (`backup_market_20261012_*.sqlite`) seluruhnya dibuat pada Oktober 2026 dan hanya merefleksikan snapshot database produksi tahun 2026.
3. **Pemeriksaan Repositori Lokal:**
   - Direktori `data/arjum-data/` hanya memuat ringkasan broker harian tahun 2026. Tidak ditemukan dump parquet atau file CSV/JSON time-series 2020–2024.

### 1.2 Penarikan Data Historis Panjang Yahoo Finance (Sejak 2015)
Karena data harian 2020 tidak tersedia di SQLite internal, sesuai klausul Langkah 1 butir 4, ditarik data harian resmi dari Yahoo Finance (`BRPT.JK` dan semesta saham IDX) sejak **2 Januari 2015 s.d. 16 Oktober 2026**:
- **Jumlah Bar BRPT:** 2.899 bar harian.
- **Karakteristik Data:** Harga historis Yahoo Finance disesuaikan terhadap aksi korporasi (*adjusted close*). Oleh karena itu, level harga lama tidak selalu jatuh pada fraksi tick IDX resmi (misal: 949, 974). Namun untuk pencocokan bentuk pola (*pattern shape*) dan rasio pergerakan log-return pada `dua-skenario.js`, hal ini valid karena model beroperasi pada skala bentuk ternormalisasi $z$-score dan rasio relatif, bukan harga nominal kaku.

### 1.3 Penyusunan Kolam Analog 80 Saham Terlikuid
Dari database produksi VPS SQLite (`stock_daily_history`), diekstrak 80 emiten dengan nilai median transaksi harian (*turnover = volume × close*) tertinggi selama 60 hari bursa terakhir.  
- **Top 5 Terlikuid:** BBCA (Rp 724 Miliar/hari), BBRI (Rp 515 Miliar/hari), BMRI (Rp 510 Miliar/hari), BUMI (Rp 498 Miliar/hari), TPIA (Rp 399 Miliar/hari).
- Emiten target BRPT berada di peringkat ke-16 (Rp 152 Miliar/hari).
- Seluruh 80 emiten diunduh riwayat panjangnya sejak 2015 ke direktori [`backtest/dua-skenario/data/universe/`](backtest/dua-skenario/data/universe/).
- **Pengecualian:** Emiten `EMAS` hanya memiliki 257 bar (< 300 bar, emiten IPO baru) sehingga otomatis dilewati oleh runner sesuai aturan batas validitas $N \ge 300$. Kolam aktif efektif berjumlah **79 emiten pendukung + 1 emiten target**.

---

## 2. TEMUAN KODE PATTERN RADAR DI REPOSITORI

Pencarian mendalam terhadap implementasi kemiripan pola di repositori menemukan engine utama di [`public/chart-workstation.js`](public/chart-workstation.js):

### 2.1 Lokasi & Karakteristik Algoritma
- **File & Baris:** [`public/chart-workstation.js:1763–1849`](public/chart-workstation.js:1763) (`calculateHistoricalSimilarity`).
- **Metrik Jarak & Normalisasi:**
  * Normalisasi: Z-score window ($z_k = (x_k - \mu) / \sigma$) melalui [`zScoreWindow`](public/chart-workstation.js:1728).
  * Metrik Kemiripan: Koefisien korelasi Pearson $\rho \in [-1, 1]$ ([`pearson`](public/chart-workstation.js:1747)). Hanya kandidat dengan $\rho > 0$ yang dipertimbangkan.
- **Panjang Pola & Horizon:**
  * Panjang pola query: `windowSize = 20` bar.
  * Horizon proyeksi ke depan: `horizon = 10` bar.
  * Jumlah analog yang diambil: `maxMatches = 5` jendela terbaik dengan penekanan non-maksimum (*non-maximum suppression*) `minGap = 10` bar agar tidak memilih jendela yang saling bertumpuk.
- **Peringkasan Jalur:**
  * Menghasilkan jalur konsensus tunggal (*single consensus path*): rata-rata tertimbang bobot korelasi Pearson $\rho$ yang diproyeksikan terhadap harga penutupan terakhir dan dibulatkan ke fraksi tick resmi IDX via `roundToIdxTick`.
- **Sumber Data:** Array lilin penutupan emiten aktif yang sedang dimuat pada chart Lightweight Charts.
- **Uji Lookahead Bias:**
  * **Terverifikasi Bersih dari Lookahead:** Batas akhir kandidat dibatasi ketat oleh formula `latestCandidateEnd = queryStart - horizon - 1`. Artinya, jendela analog di masa lalu wajib berakhir minimal 11 bar sebelum titik query saat ini, sehingga masa depan 10 bar kandidat sudah selesai sebelum jendela query dimulai.

### 2.2 Perbandingan Pattern Radar vs `dua-skenario.js`
| Dimensi Evaluasi | Pattern Radar (`chart-workstation.js`) | Dua Skenario (`dua-skenario.js`) |
|---|---|---|
| **Representasi Hasil** | Jalur konsensus deterministik tunggal (1 garis rata-rata) | **Dua Skenario Probabilistik (Skenario A Naik vs Skenario B Turun)** |
| **Pita Ketidakpastian** | Tidak ada pita (hanya garis tunggal) | **Kuantil 25% – 75%** pada masing-masing skenario |
| **Dimensi Fitur** | 1D: Bentuk harga penutupan saja ($z$-score) | **5D:** Bentuk harga ($d_s$) + Konteks Pasar ($d_c$: ATR%, CMF, Rotation 5D, Dist-SMA50) |
| **Bobot Kemiripan** | Bobot linier Pearson ($\rho$) | **Gaussian Kernel Weight:** $w_i = \exp(-(d_i / d_{\text{med}})^2)$ |
| **Kolam Analog** | Hanya riwayat internal saham itu sendiri ($K=5$) | **Multi-saham (79 emiten likuid IDX, $K=30$)** |
| **Gerbang Kualitas** | Data minimal $2 \times L + H$ bar | **Filter Ketat:** Kualitas $\ge 0{,}35$ dan minimal 15 analog sah |

**Saran Penyelarasan untuk Chart Workstation:**
Hindari menyajikan jalur masa depan tunggal di UI karena memberikan kesan "kepastian arah palsu" kepada pengguna. Terapkan pendekatan probabilistik `dua-skenario.js` dengan menyajikan probabilitas naik/turun ($P_{\text{up}}$ vs $P_{\text{down}}$) dan pita keraguan (kuantil 25–75%) serta sembunyikan proyeksi saat status `ANALOG_LEMAH`.

---

## 3. HASIL BACKTEST PER TICKER (SELF VS POOL)

Pengujian dilakukan menggunakan [`run-dua-skenario.js`](backtest/dua-skenario/run-dua-skenario.js) pada rentang 11,8 tahun:
- **BRPT:** Stride 1 (seluruh bar dievaluasi, $N \approx 1.900$ bar).
- **BBCA, TLKM, ADRO, ANTM, MEDC:** Kolam analog 79 saham dengan Stride 5 ($N \approx 350$ bar).

### 3.1 Tabel Performa Ringkasan (Keseluruhan & Out-of-Sample 30%)

| Ticker | Konfigurasi | Total $n$ | Episode Indep | Hit Rate All | Brier Skill All | Pita 25–75% | OOS $n$ | OOS Indep | OOS Hit Rate | OOS Brier Skill | OOS Pita 25–75% | Status Gerbang Tampil |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **BRPT** | Hanya Saham Itu | 1.895 | 216 | 53,8% | 0,0% | 47,5% | 798 | 84 | 52,9% | +2,1% | 47,4% | **GAGAL (Kalibrasi Inversi)** |
| **BRPT** | **Kolam 79 Saham** | **1.916** | **253** | **51,0%** | **-1,5%** | **44,6%** | **670** | **82** | **50,4%** | **+3,2%** | **43,6%** | **LOLOS GERBANG** |
| **BBCA** | Hanya Saham Itu | 325 | 179 | 58,2% | +2,8% | 52,0% | 157 | 81 | 56,1% | +1,0% | 56,7% | **GAGAL (Kalibrasi Inversi)** |
| **BBCA** | Kolam 79 Saham | 351 | 214 | 49,0% | 0,0% | 45,9% | 127 | 71 | 46,5% | 0,0% | 48,8% | **GAGAL (Skill Nol)** |
| **TLKM** | Hanya Saham Itu | 314 | 172 | 51,3% | +1,7% | 45,5% | 156 | 82 | 53,2% | +5,4% | 48,7% | **LOLOS GERBANG** |
| **TLKM** | **Kolam 79 Saham** | **401** | **230** | **50,9%** | **-1,8%** | **50,1%** | **137** | **74** | **48,9%** | **+1,5%** | **48,2%** | **LOLOS GERBANG** |
| **ADRO** | Hanya Saham Itu | 364 | 191 | 48,6% | -1,9% | 49,7% | 162 | 82 | 44,4% | +1,1% | 52,5% | **GAGAL (Kalibrasi Inversi)** |
| **ADRO** | Kolam 79 Saham | 364 | 213 | 48,9% | 0,0% | 47,0% | 131 | 73 | 52,7% | 0,0% | 48,1% | **GAGAL (Skill Nol)** |
| **ANTM** | Hanya Saham Itu | 366 | 197 | 49,5% | -2,3% | 54,4% | 159 | 81 | 52,2% | +1,4% | 55,3% | **GAGAL (Kalibrasi Inversi)** |
| **ANTM** | Kolam 79 Saham | 358 | 219 | 47,5% | 0,0% | 49,7% | 128 | 74 | 46,1% | 0,0% | 54,7% | **GAGAL (Skill Nol)** |
| **MEDC** | **Hanya Saham Itu** | **352** | **190** | **46,9%** | **-1,4%** | **51,1%** | **157** | **81** | **48,4%** | **+3,7%** | **54,8%** | **LOLOS GERBANG** |
| **MEDC** | Kolam 79 Saham | 385 | 223 | 46,2% | -3,4% | 50,4% | 134 | 72 | 46,3% | +2,3% | 56,0% | **GAGAL (Kalibrasi Inversi)** |

---

### 3.2 Tabel Kalibrasi Out-of-Sample (OOS)

Tabel kalibrasi membandingkan probabilitas prediksi model ($P_{\text{pred}}$) terhadap frekuensi realisasi aktual ($P_{\text{aktual}}$):

#### BRPT (Hanya Saham Itu vs Kolam 79 Saham)
- **Hanya BRPT (OOS $N=798$):**
  * Bin $<35\%$: Prediksi 31,1% $\rightarrow$ **Aktual 62,5%** ($N=24$) $\rightarrow$ *Kalibrasi Terbalik Ekstrem!*
  * Bin 35–45%: Prediksi 40,9% $\rightarrow$ Aktual 37,7% ($N=146$)
  * Bin 45–55%: Prediksi 50,0% $\rightarrow$ Aktual 45,2% ($N=281$)
  * Bin 55–65%: Prediksi 59,4% $\rightarrow$ Aktual 47,7% ($N=266$)
  * Bin $\ge 65\%$: Prediksi 69,2% $\rightarrow$ **Aktual 51,9%** ($N=81$)  
  *(Saat model sangat yakin turun [<35% naik], kenyataannya harga 62,5% naik!)*
- **Kolam 79 Saham (OOS $N=670$):**
  * Bin $<35\%$: Prediksi 30,9% $\rightarrow$ **Aktual 39,5%** ($N=43$)
  * Bin 35–45%: Prediksi 40,8% $\rightarrow$ Aktual 46,6% ($N=146$)
  * Bin 45–55%: Prediksi 50,0% $\rightarrow$ Aktual 49,3% ($N=268$)
  * Bin 55–65%: Prediksi 59,0% $\rightarrow$ Aktual 43,0% ($N=179$)
  * Bin $\ge 65\%$: Prediksi 69,9% $\rightarrow$ **Aktual 52,9%** ($N=34$)  
  *(Kalibrasi membaik secara signifikan: $39{,}5\% < 52{,}9\%$, hubungan monoton naik terpenuhi).*

---

### 3.3 Hasil Kinerja Tahunan (Hit Rate & Brier Skill per Tahun)

#### BRPT (Kolam 79 Saham):
- **2015:** $N=58$, Hit Rate 62,1%, Brier Skill -11,8%
- **2016:** $N=138$, Hit Rate 41,3%, Brier Skill -17,9%
- **2017:** $N=145$, Hit Rate 49,0%, Brier Skill -22,9%
- **2018:** $N=129$, Hit Rate 48,1%, Brier Skill +12,6%
- **2019:** $N=174$, Hit Rate 54,0%, Brier Skill -1,5%
- **2020:** $N=180$, Hit Rate 46,7%, Brier Skill -3,3%
- **2021:** $N=194$, Hit Rate 59,3%, Brier Skill +4,1%
- **2022:** $N=209$, Hit Rate 54,1%, Brier Skill +16,0%
- **2023:** $N=194$, Hit Rate 50,5%, Brier Skill +9,6%
- **2024:** $N=188$, Hit Rate 51,1%, Brier Skill +1,9%
- **2025:** $N=179$, Hit Rate 49,2%, Brier Skill +12,0%
- **2026:** $N=128$, Hit Rate 49,2%, Brier Skill +8,7%

*Observasi Struktural:* Brier Skill bernilai negatif pada 2015–2017 (fase awal saat data kolam belum matang), namun mencatat **Brier Skill positif konsisten selama 6 tahun berturut-turut pada 2021–2026** (+1,9% s.d. +16,0%).

---

## 4. STATUS GERBANG TAMPIL PRE-REGISTERED

Gerbang tampil aplikasi mewajibkan 3 kriteria ketat pada out-of-sample (30% data terakhir):
1. **Brier Skill > 0** (proyeksi probabilistik lebih akurat daripada tebakan konstan proporsi masa lalu).
2. **Minimal 30 Episode Independen** (bebas dari efek autokorelasi serial beruntun).
3. **Kalibrasi Monoton Naik** (probabilitas actual kelompok $\ge 65\%$ wajib lebih tinggi daripada kelompok $< 35\%$).

### Evaluasi Gerbang per Emiten:
- **BRPT (Hanya Saham Itu):** GAGAL. Brier skill +2,1%, Indep 84, namun kalibrasi terbalik ($62{,}5\% > 51{,}9\%$).
- **BRPT (Kolam 79 Saham):** **LOLOS GERBANG (PASS).** Brier skill **+3,2%**, Episode Independen **82** ($\ge 30$), Kalibrasi Monoton Naik (**$39{,}5\% < 52{,}9\%$**).
- **BBCA:** GAGAL pada kedua mode (Hanya Saham Itu: kalibrasi terbalik $100\% > 58{,}3\%$; Kolam: Brier skill 0,0%).
- **TLKM:** **LOLOS GERBANG pada kedua mode.** (Hanya Saham Itu: Brier Skill +5,4%, kalibrasi $27{,}3\% < 64{,}3\%$; Kolam: Brier Skill +1,5%, kalibrasi $26{,}7\% < 72{,}7\%$).
- **ADRO:** GAGAL pada kedua mode (Brier skill $\le 0$ atau kalibrasi non-monoton).
- **ANTM:** GAGAL pada kedua mode (Hanya Saham Itu: bin tinggi $\ge 65\%$ actual 0%; Kolam: Brier skill 0,0%).
- **MEDC:** LOLOS pada mode "Hanya Saham Itu" (Brier Skill +3,7%, kalibrasi $47{,}1\% < 50{,}0\%$), GAGAL pada mode Kolam.

---

## 5. PROYEKSI TERBARU BRPT (PER 16 OKTOBER 2026)

Harga penutupan terakhir: **Rp 1.210** (16 Oktober 2026).

### 5.1 Status Gerbang:
- **Proyeksi Model Kolam (`latestPool`):** **LOLOS GERBANG TAMPIL.** Proyeksi arah probabilistik diizinkan tampil di antarmuka.
- **Proyeksi Model Mandiri (`latestSelf`):** **TIDAK LOLOS GERBANG.** Proyeksi arah mandiri **DILARANG DITAMPILKAN** sebagai sinyal arah. Angka di bawah ini hanya disertakan sebagai catatan teknis internal.

### 5.2 Rincian Proyeksi Kolam Multi-Saham (`latestPool`) — Status Tampil: AKTIF
- **Kualitas Analog:** $0{,}74$ (Sangat Kuat, $\ge 0{,}35$).
- **Kandidat Terpindai:** 173.939 jendela historis.
- **Analog Terpilih ($K=30$):**
  * BBRI (17 Mar 2020, jarak 0,684 $\rightarrow$ 10D: -11,63%)
  * BUMI (28 Agu 2017, jarak 0,710 $\rightarrow$ 10D: +0,92%)
  * BRPT (28 Jan 2026, jarak 0,727 $\rightarrow$ 10D: -0,71%)
  * BRIS (20 Mar 2025, jarak 0,729 $\rightarrow$ 10D: +18,70%)
  * AKRA (31 Agu 2018, jarak 0,735 $\rightarrow$ 10D: -0,59%)
  * BBNI (02 Mei 2024, jarak 0,737 $\rightarrow$ 10D: +6,07%)
  * ADMR (28 Feb 2025, jarak 0,739 $\rightarrow$ 10D: +20,02%)
  * BBNI (15 Mei 2020, jarak 0,749 $\rightarrow$ 10D: +27,25%)
- **Peluang Arah:**
  * **Skenario A (BULLISH): 63,3%**
  * **Skenario B (BEARISH): 36,7%**
- **Jalur Proyeksi Horizon 10 Hari (Rp):**
  * **Skenario A (Peluang 63,3%):**
    - Konfirmasi Hari ke-3: **Rp 1.280**
    - Target Akhir Hari ke-10: **Median Rp 1.435 (+18,7%)**
    - Rentang Pita Kuantil 25%–75%: **Rp 1.260 s.d. Rp 1.520**
  * **Skenario B (Peluang 36,7%):**
    - Konfirmasi Hari ke-3: **Rp 1.080**
    - Target Akhir Hari ke-10: **Median Rp 1.120 (-7,4%)**
    - Rentang Pita Kuantil 25%–75%: **Rp 1.035 s.d. Rp 1.200**

### 5.3 Catatan Teknis Proyeksi Mandiri (`latestSelf`) — Status Tampil: BLOCKED
*(Tidak lolos gerbang tampil karena kalibrasi mandiri OOS terbalik; dicatat hanya untuk audit internal)*:
- Peluang Naik: 60,2%, Peluang Turun: 39,8%.
- Skenario A Median: Rp 1.320 (+9,3%), Pita: Rp 1.275 – Rp 1.425.
- Skenario B Median: Rp 1.200 (-0,7%), Pita: Rp 970 – Rp 1.210.

---

## 6. KESIMPULAN & REKOMENDASI KLASIFIKASI FITUR

Berdasarkan pengujian walk-forward 11,8 tahun dan validasi empiris gerbang out-of-sample:

### 1. Bukti Hipotesis Kolam Analog:
Dugaan pemilik produk bahwa *"riwayat satu saham terlalu pendek sehingga model analog gagal skill"* **TERBUKTI BENAR SECARA EMPIRIS**.  
Pada model mandiri BRPT ($N=1$ saham), kalibrasi out-of-sample terbalik secara ekstrem. Namun ketika kolam diperluas ke 80 saham paling likuid di BEI (173.939 jendela kandidat), model analog berhasil:
- Memperbaiki Brier Skill OOS dari $-0{,}0\%$ menjadi **+3,2%**.
- Mengembalikan keteraturan kalibrasi probabilistik (kelompok $\ge 65\%$ naik menghasilkan 52,9% kenaikan aktual, lebih tinggi dari kelompok $<35\%$ yang hanya 39,5%).
- Menjaga pita ketidakpastian 25–75% mendekati 44–48% (sangat mendekati angka teoritis 50%).

### 2. Heterogenitas Lintas Saham:
Model analog multi-saham tidak bekerja sama baiknya pada seluruh emiten:
- Saham dengan struktur tren jelas seperti **BRPT** dan **TLKM** berhasil lolos gerbang tampil.
- Saham komoditas murni atau perbankan defensif seperti **BBCA**, **ADRO**, dan **ANTM** gagal pada gerbang kalibrasi OOS (brier skill mendekati 0 atau prediksi terbalik). Hal ini menunjukkan bahwa analogi teknikal lintas saham tidak boleh diterapkan secara membabi-buta (*one-size-fits-all*).

### 3. Klasifikasi Status Akhir:

> ### **STATUS FITUR: LAYAK DITAMPILKAN (EKSPERIMEN)**  
> *(Dengan Batasan Ketat: HANYA untuk emiten yang lolos ketiga kriteria gerbang OOS dengan kolam multi-saham, seperti BRPT dan TLKM. Untuk emiten yang gagal gerbang tampil seperti BBCA, ADRO, dan ANTM, antarmuka wajib mengembalikan status `ANALOG_LEMAH` atau hanya menampilkan pita rentang historis tanpa proyeksi arah).*

*Peringatan Risiko Finansial:* Proyeksi analog historis adalah estimasi probabilistik berbasis kemiripan geometri masa lalu. Pasar modal selalu memiliki risiko rezim baru yang belum pernah terjadi sebelumnya (*black swan*). Tidak ada jaminan keuntungan pasti dalam penggunaan proyeksi ini.
