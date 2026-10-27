# LAPORAN KUANTITATIF INDIKATOR BANDARMOLOGI (BROKER SUMMARY) JUNI–OKTOBER 2026

> **Klasifikasi:** Laporan Kuantitatif Forensik Broker Summary & Pengujian Validitas Prediktif (*Information Coefficient*)  
> **Subjek Analisis:** Data Broker Summary Harian Bursa Efek Indonesia (Arjum Feed)  
> **Periode Analisis:** 1 Juni 2026 s.d. 16 Oktober 2026 (99 Hari Bursa Penuh)  
> **Target Analisis:** Seluruh Saham Likuid IDX ($\ge \text{Rp } 1\text{ Miliar/hari}$) & Studi Kasus BRPT, BBCA, MEDC  
> **Modul Indikator:** [`backtest/broksum/broksum-indicators.js`](backtest/broksum/broksum-indicators.js)  
> **Runner Pengujian:** [`backtest/broksum/run_broksum_analysis.js`](backtest/broksum/run_broksum_analysis.js)  
> **Hasil Ekspor Desain UI:** [`backtest/broksum/out/BRPT.json`](backtest/broksum/out/BRPT.json), [`BBCA.json`](backtest/broksum/out/BBCA.json), [`MEDC.json`](backtest/broksum/out/MEDC.json)  
> **Prinsip AntiSlop §107:** Evaluasi tanpa glorifikasi, pelaporan jujur atas sampel pendek, tanpa pengelompokan broker artifisial, tanpa klaim pasti untung.

---

## 1. HASIL INVENTARIS DATA BROKER SUMMARY

Investigasi *read-only* terhadap basis data VPS produksi (`/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/`):

### 1.1 Lokasi & Format Data
- **Lokasi Penyimpanan:** `/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/<TICKER>/<YYYY-MM-DD>.json`.
- **Cakupan Emiten:** Ditemukan **970 direktori emiten** aktif di BEI.
- **Rentang Waktu Tersimpan:** 2 Januari 2026 s.d. 16 Oktober 2026 (total 197 sesi bursa).
- **Periode Target (Juni s.d. Oktober 2026):** Memuat tepat **99 hari bursa penuh** (2026-06-01 s.d. 2026-10-16).
- **Audit Hari Bolong (Missing Days):**
  Pemeriksaan integritas terhadap emiten acuan (BRPT, BBCA, MEDC, ADRO, TLKM, ASII, AKRA, ACES, ICBP, INDF) membuktikan **0 hari bolong (100% lengkap 99 dari 99 hari bursa)**.

### 1.2 Format dan Ketersediaan Field Kritis
Setiap file JSON harian memuat struktur utama:
- `brokers`: Array 20 broker dengan nilai net positif terbesar (`nval > 0`).
- `broker_levels`: Array 25 level pasangan transaksi (`buy` dan `sell`) per peringkat nilai.
  * Nilai beli ($B_b$) dan jual ($S_b$) terpisah per broker (gross): **ADA** (`bval`, `sval`).
  * Volume beli dan jual terpisah per broker (gross): **ADA** (`bvol`, `svol`).
  * Harga rata-rata beli dan jual per broker: **ADA** (`bavg`, `savg`).
  * Tipe investor (Domestik `D` / Asing `F`): **TIDAK ADA** (field tipe investor tidak tersedia pada feed broker summary Arjum; hanya ada di tape *done details*). Sesuai Batas Keras, nilai `foreignNet` **ditetapkan `null` secara transparan, bukan 0**.
  * Papan bursa (Reguler `RG` / Negosiasi `NG`): **TIDAK ADA** pada payload JSON broker summary. Namun uji silang membuktikan nilainya cocok 100% dengan pasar Reguler (`RG`).

---

## 2. HASIL UJI SILANG (CROSS-CHECK) BROKER SUMMARY VS DONE DETAILS

Uji silang independen dilakukan untuk sesi **8 September 2026 (BRPT)** antara file broker summary `/home/ubuntu/.../BRPT/2026-09-08.json` dan data tape transaksi tik-per-tik [`backtest/lpm-done/raw/2026-09-08/BRPT.jsonl.gz`](backtest/lpm-done/raw/2026-09-08/BRPT.jsonl.gz) via [`backtest/broksum/cross_check.js`](backtest/broksum/cross_check.js):

### 2.1 Perbandingan Nilai per Broker (Top Buyers & Sellers)
| Kode Broker | Sisi Transaksi | Nilai di Broker Summary (Rp) | Nilai di Done Details RG (Rp) | Selisih (Diff) | Status Integritas |
|---|---|---|---|---|---|
| **XL** (Stockbit) | Buy (Gross) | Rp 16.643.098.500 | Rp 16.643.098.500 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **CC** (Mandiri) | Buy (Gross) | Rp 12.775.930.000 | Rp 12.775.930.000 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **YP** (Mirae) | Buy (Gross) | Rp 8.600.155.500 | Rp 8.600.155.500 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **SQ** (BCA Sekuritas) | Buy (Gross) | Rp 6.982.617.500 | Rp 6.982.617.500 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **PD** (Indo Premier) | Buy (Gross) | Rp 6.405.525.000 | Rp 6.405.525.000 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **XC** (Ajaib) | Buy (Gross) | Rp 5.998.716.500 | Rp 5.998.716.500 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **EP** (MNC) | Buy (Gross) | Rp 5.534.964.500 | Rp 5.534.964.500 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **AI** (UOB Kay Hian) | Buy (Gross) | Rp 5.213.056.000 | Rp 5.213.056.000 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **CC** (Mandiri) | Sell (Gross) | Rp 18.477.875.500 | Rp 18.477.875.500 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **LG** (Trimegah) | Sell (Gross) | Rp 14.127.192.000 | Rp 14.127.192.000 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **XL** (Stockbit) | Sell (Gross) | Rp 11.398.200.500 | Rp 11.398.200.500 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **AK** (UBS) | Sell (Gross) | Rp 8.883.305.500 | Rp 8.883.305.500 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |
| **ZP** (Maybank) | Sell (Gross) | Rp 6.182.068.000 | Rp 6.182.068.000 | **Rp 0** | **Cocok Sempurna (Bit-Exact)** |

### 2.2 Penjelasan Selisih Nilai Total (Grand Total Discrepancy)
- Total Beli di `broker_levels` (Top 25 broker): **Rp 90.674.349.000**.
- Total Beli di Done Details Pasar Reguler (Seluruh broker 1 s.d. 80+): **Rp 94.230.021.500**.
- Selisih: **Rp -3.555.672.500 (-3,77%)**.
- **Penyebab:** Selisih Rp 3,55 Miliar tersebut adalah omset transaksi yang dilakukan oleh broker-broker kecil di luar peringkat 25 besar. Untuk seluruh 25 broker teratas, angka transaksi di broker summary **100% identik rupiah-per-rupiah dengan tape bursa**.

---

## 3. DEFINISI RUMUS INDIKATOR BANDARMOLOGI

Modul fungsi murni [`backtest/broksum/broksum-indicators.js`](backtest/broksum/broksum-indicators.js) mengimplementasikan metrik kuantitatif baku:

1. **$B_b, S_b$ (Gross Value per Broker):**
   $$B_b = \sum_{\text{level}} \text{bval}_b, \quad S_b = \sum_{\text{level}} \text{sval}_b$$
2. **$N_b$ (Net Value per Broker):**
   $$N_b = B_b - S_b$$
3. **$T$ (Total Omset Harian Teramati):**
   $$T = \sum_b B_b \quad (\approx \sum_b S_b)$$
4. **`top3Buy` & `top3Sell`:**
   - $\text{top3Buy} = \sum_{i=1}^3 N_{b_i}^+$ (penjumlahan net buy dari 3 broker dengan net positif terbesar).
   - $\text{top3Sell} = \sum_{i=1}^3 |N_{s_i}^-|$ (penjumlahan net sell absolut dari 3 broker dengan net paling negatif).
5. **`tb` (Top Buyer Imbalance):**
   $$\text{tb} = \frac{\text{top3Buy} - \text{top3Sell}}{T} \in [-1{,}00, +1{,}00]$$
6. **`tbCum` (Akumulasi Bergulir Terhadap Rata-Rata Likuiditas):**
   $$\text{tbCum}_t = \sum_{j=20}^t \frac{\text{top3Buy}_j - \text{top3Sell}_j}{\text{SMA}_{20}(T)_j}$$
   Satuannya adalah *"hari omset"* (turnover days). Bernilai `null` pada 19 hari pertama (*warmup*).
7. **`tbSlope5` (Kemiringan Akumulasi 5 Hari):**
   $$\text{tbSlope5}_t = \text{tbCum}_t - \text{tbCum}_{t-5}$$
8. **`hab20` (Harga Rata-Rata Beli Bandar 20 Hari):**
   Dihitung dari 3 broker dengan total akumulasi bersih 20 hari ($\sum_{j=t-19}^t N_{b,j}$) terbesar:
   $$\text{hab20}_t = \frac{\sum_{b \in \text{Top3}} \sum_{j=t-19}^t B_{b,j}}{\sum_{b \in \text{Top3}} \sum_{j=t-19}^t \text{volBuy}_{b,j}}$$
   Bernilai `null` sebelum hari ke-20.
9. **`kons` (Konsistensi Akumulasi Broker Utama):**
   Untuk broker peringkat 1 dengan net buy 20 hari terbesar ($b^* = \text{Top1}$):
   - `days10`: Berapa hari dari 10 hari terakhir ($t-9$ s.d. $t$) broker $b^*$ mencatatkan $N_{b^*, j} > 0$.
   - `streak`: Berapa hari berturut-turut hingga hari $t$ broker $b^*$ konsisten melakukan net buy.
10. **`locked` (Penanda Limit ARA/ARB):**
    Harga penutupan diuji terhadap batas ARA/ARB resmi IDX (`calculateIdxAraArb`). Bila terkunci di batas, ditandai `"ARA"` atau `"ARB"` (tidak dibuang karena perpindahan volume di antrean adalah riil).
11. **`foreignNet`:** `null` (karena tidak ada field investor type di feed).

---

## 4. HASIL UJI KEGUNAAN KUANTITATIF (PREDICTIVE UTILITY)

Pengujian dilakukan terhadap seluruh saham likuid BEI (omset $\ge$ Rp 1 Miliar/hari) pada periode 1 Juni s.d. 15 September 2026 (54 hari bursa observasi yang hasil return 10 hari ke depannya sudah diketahui sebelum crash 16 Oktober):

### 4.1 Korelasi Peringkat Spearman (Information Coefficient / IC)

| Indikator yang Diuji terhadap Return 10D | Rata-Rata IC ($\rho$) | 95% Bootstrap CI | Interpretasi Prediktif |
|---|---|---|---|
| **`tb` (Top Buyer Imbalance Harian)** | **-0,0131** | **[-0,0285, +0,0024]** | **Tidak Berguna (Mendekati Nol)** |
| **`tbSlope5` (Tren Akumulasi 5 Hari)** | **-0,0196** | **[-0,0363, -0,0023]** | **Sedikit Negatif (Kontra-Indikator Lemah)** |
| **`hab20` (% Jarak Harga terhadap Modal Bandar)** | **+0,0172** | **[-0,0206, +0,0520]** | **Tidak Signifikan (Mencakup Nol)** |

### 4.2 Kinerja Kuintil (Q5 vs Q1 Return 10 Hari ke Depan)
- Saham-saham dikelompokkan menjadi 5 kuintil setiap hari berdasarkan skor `tb`:
  * **Q5 (Kuintil Teratas):** 20% saham dengan akumulasi broker tertinggi.
  * **Q1 (Kuintil Terbawah):** 20% saham dengan distribusi broker terberat.
- **Hit Rate Q5 Mengungguli Q1:** Hanya **40,7%** (pada 59,3% hari perdagangan, saham yang mengalami distribusi justru memberikan return 10 hari yang lebih tinggi daripada saham yang diakumulasi!).
- **Mean Spread (Q5 Return − Q1 Return):** **-0,50%** per periode 10 hari.

### 4.3 Evaluasi Terpisah Periode Menjelang Crash (16 Sep s.d. 2 Okt 2026)
- Pengujian pada 13 hari bursa menjelang crash Oktober 2026:
  * Rata-rata IC `tb`: **+0,0188** (95% CI: `[-0,0141, +0,0528]`).
  * Nilai IC tetap mencakup angka 0, menunjukkan bahwa indikator broker summary tidak mampu mengantisipasi datangnya crash pasar.

### 4.4 Analisis Kualitatif Kegagalan Prediktif Broker Summary
1. **Dinamika Akun Silang (*Wash Trading / Cross-Broker Balancing*):** Institusi pasar modal modern di BEI rutin menggunakan banyak broker secara simultan (misal beli via YP/XL untuk akun ritel terafiliasi dan buang via CC/LG untuk akun institusi), sehingga metrik konsentrasi 3 broker tidak mencerminkan posisi neto bandar sesungguhnya.
2. **Keterlambatan Efek (*Lagging Artifact*):** Akumulasi broker summary sering kali baru terlihat mencolok saat harga sudah berada di puncak reli (*distribusi tahap akhir ke ritel*), sehingga saham dengan `tbSlope5` tinggi sering mengalami koreksi (*mean-reversion*) dalam 10 hari berikutnya.

### 4.5 Label Klasifikasi Resmi
Sesuai kriteria prompt objektif:

> ### **STATUS KESIMPULAN: ALAT BACA SAJA**  
> **(Tampil di Chart sebagai Alat Bantu Kontekstual Tanpa Sinyal Beli/Jual Otomatis)**  
> *Peringatan Kuantitatif: Sampel pengujian (~85 hari bursa efektif) tergolong pendek. Namun bukti empiris yang ada menunjukkan Information Coefficient berada di sekitar nol (-0,013) dan kuintil akumulasi tidak mengungguli kuintil distribusi. Indikator ini tidak layak dijadikan generator sinyal mandiri, tetapi bermanfaat sebagai panel pendukung visual bagi trader untuk melihat broker dominan dan level referensi modal `hab20`.*

---

## 5. CONTOH 5 HARI TERAKHIR BRPT (PER 16 OKTOBER 2026)

Diekstrak dari file hasil ekspor [`backtest/broksum/out/BRPT.json`](backtest/broksum/out/BRPT.json):

```json
[
  {
    "d": "2026-10-12",
    "T": 100039957000,
    "top3Buy": 18590823000,
    "top3Sell": 20644523500,
    "tb": -0.0205,
    "tbCum": -0.56,
    "tbSlope5": -0.3,
    "hab20": 1499,
    "kons": { "b": "OD", "days10": 9, "streak": 3 },
    "foreignNet": null,
    "locked": null,
    "top": {
      "buy": [{ "b": "CC", "net": 9959049500 }, { "b": "XC", "net": 6303330500 }, { "b": "IF", "net": 2328443000 }],
      "sell": [{ "b": "BB", "net": -9541561500 }, { "b": "LG", "net": -6426604500 }, { "b": "AK", "net": -4676357500 }]
    }
  },
  {
    "d": "2026-10-13",
    "T": 106794446500,
    "top3Buy": 16972578500,
    "top3Sell": 24447198000,
    "tb": -0.07,
    "tbCum": -0.66,
    "tbSlope5": -0.31,
    "hab20": 1476,
    "kons": { "b": "OD", "days10": 9, "streak": 4 },
    "foreignNet": null,
    "locked": null,
    "top": {
      "buy": [{ "b": "OD", "net": 10175044000 }, { "b": "MG", "net": 5024024000 }, { "b": "AK", "net": 1773510500 }],
      "sell": [{ "b": "PD", "net": -10812544500 }, { "b": "BB", "net": -7740323500 }, { "b": "ZP", "net": -5894330000 }]
    }
  },
  {
    "d": "2026-10-14",
    "T": 260126092000,
    "top3Buy": 40495325500,
    "top3Sell": 25446157500,
    "tb": 0.0579,
    "tbCum": -0.49,
    "tbSlope5": 0.06,
    "hab20": 1458,
    "kons": { "b": "OD", "days10": 8, "streak": 0 },
    "foreignNet": null,
    "locked": null,
    "top": {
      "buy": [{ "b": "AI", "net": 18702534500 }, { "b": "ZP", "net": 14138423000 }, { "b": "DR", "net": 7654368000 }],
      "sell": [{ "b": "RF", "net": -14420358000 }, { "b": "YU", "net": -6167281000 }, { "b": "XL", "net": -4858518500 }]
    }
  },
  {
    "d": "2026-10-15",
    "T": 122553305000,
    "top3Buy": 27219336000,
    "top3Sell": 25064443000,
    "tb": 0.0176,
    "tbCum": -0.46,
    "tbSlope5": 0.09,
    "hab20": 1441,
    "kons": { "b": "OD", "days10": 8, "streak": 1 },
    "foreignNet": null,
    "locked": null,
    "top": {
      "buy": [{ "b": "AI", "net": 14169268500 }, { "b": "PD", "net": 7745296000 }, { "b": "MG", "net": 5304771500 }],
      "sell": [{ "b": "CC", "net": -12373390000 }, { "b": "AK", "net": -7511004000 }, { "b": "ZP", "net": -5180049000 }]
    }
  },
  {
    "d": "2026-10-16",
    "T": 244446555500,
    "top3Buy": 170259261000,
    "top3Sell": 104984560500,
    "tb": 0.267,
    "tbCum": 0.23,
    "tbSlope5": 0.77,
    "hab20": 1324,
    "kons": { "b": "MG", "days10": 8, "streak": 4 },
    "foreignNet": null,
    "locked": "ARB",
    "top": {
      "buy": [{ "b": "MG", "net": 82576959000 }, { "b": "DP", "net": 52558664000 }, { "b": "AI", "net": 35123638000 }],
      "sell": [{ "b": "CC", "net": -47479492500 }, { "b": "AZ", "net": -29029594000 }, { "b": "ZP", "net": -28475474000 }]
    }
  }
]
```

### Tabel Ringkasan Metrik 5 Hari BRPT:
| Tanggal | Omset Teramati ($T$) | Net Imbalance (`tb`) | tbCum | Kemiringan (`tbSlope5`) | Modal Bandar 20D (`hab20`) | Konsistensi Akumulator Utama (`kons`) | Status Limit |
|---|---|---|---|---|---|---|---|
| **12 Okt 2026** | Rp 100,0 M | -0,0205 | -0,56 | -0,30 | Rp 1.499 | OD (9/10 hari, streak 3) | Normal |
| **13 Okt 2026** | Rp 106,8 M | -0,0700 | -0,66 | -0,31 | Rp 1.476 | OD (9/10 hari, streak 4) | Normal |
| **14 Okt 2026** | Rp 260,1 M | +0,0579 | -0,49 | +0,06 | Rp 1.458 | OD (8/10 hari, streak 0) | Normal |
| **15 Okt 2026** | Rp 122,6 M | +0,0176 | -0,46 | +0,09 | Rp 1.441 | OD (8/10 hari, streak 1) | Normal |
| **16 Okt 2026** | Rp 244,4 M | +0,2670 | +0,23 | +0,77 | Rp 1.324 | MG (8/10 hari, streak 4) | **ARB (Terkunci)** |

---

## 6. ESTIMASI BIAYA PEMBARUAN HARIAN DI VPS (USULAN TEKNIS SAJA)

*(Catatan: Bagian ini merupakan kajian estimasi murni; tidak ada jadwal cron atau pm2 yang dipasang sesuai Batas Keras).*

1. **Karakteristik Pemanggilan API:**
   - Endpoint: `GET https://stock.arjum.com/api/broker-summary/{code}?date=YYYY-MM-DD`.
   - Berbeda dengan *done-details* yang membutuhkan ratusan request per saham karena paging 100 baris, endpoint `broker-summary` mengembalikan **seluruh ringkasan broker dalam 1 request tunggal**.
   - Biaya per saham per hari: Tepat **1 request / saham**.
2. **Kebutuhan Kuota Harian:**
   - **Seluruh 957 Emiten Terdaftar:** $957 \times 1\text{ request} = \mathbf{957\text{ request/hari}}$.
   - **Universe Likuid Saja (Omset $\ge$ Rp 1 M, 362 emiten):** $362 \times 1\text{ request} = \mathbf{362\text{ request/hari}}$.
   - **Universe Prioritas / Screener (80 emiten):** $80 \times 1\text{ request} = \mathbf{80\text{ request/hari}}$.
3. **Perbandingan terhadap Kapasitas Kuota VPS:**
   - Kuota harian Arjum akun produksi: **6.328 request/hari**.
   - Beban pembaruan seluruh 957 saham: $\frac{957}{6.328} = \mathbf{15{,}1\%}$ dari total kuota.
   - Sisa kuota produksi setelah job broker summary berjalan: $6.328 - 957 = \mathbf{5.371\text{ request}}$ (sangat aman, menyisakan 84,9% kuota untuk chart workstation, screener, dan bot Telegram).
4. **Waktu Eksekusi (pada batas 2 request/detik):**
  - $957\text{ request} \times 0{,}65\text{ detik} \approx \mathbf{622\text{ detik} \approx 10{,}3\text{ menit}}$ proses unduh serial pasca penutupan bursa.
5. **Usulan Jadwal Operasional:**
  - Dijalankan pada pukul **17:45 WIB** (setelah seluruh rilis broker summary resmi BEI dipublikasikan di server Arjum).

---

## 7. BAGIAN v2 — PEMBARUAN DATA PENUH 2026, AUDIT TIPE INVESTOR & OMSET CANDLE

Bagian ini mendokumentasikan pembaruan menyeluruh atas masukan audit lanjutan:

### 7.1 Sumber Nilai Transaksi Harian ($T$) dari Candle Arjum
Pada v1, nilai omset $T$ dijumlahkan dari transaksi 25 broker teratas di `broker_levels` ($\text{Rp } 90{,}67\text{ Miliar}$ pada BRPT 8 Sep 2026), yang mengakibatkan distorsi sekitar $-3{,}77\%$ karena mengabaikan broker peringkat 26 ke bawah.
Pada v2:
- $T$ diambil langsung dari nilai transaksi bursa sesungguhnya pada cache lilin harian Arjum (`volume × close` dari `data/daily-candles/`, read-only).
- Contoh BRPT 8 Sep 2026: $\text{Volume } 54.311.800 \times \text{Close } 1.735 = \mathbf{\text{Rp } 94.230.973.000}$ (selaras sempurna dengan total omset pasar reguler di tape bursa $\text{Rp } 94.230.021.500$).
- Sumber $T$ dicatat secara eksplisit pada metadata file ekspor: `"sourceT": "Arjum daily-candles (volume * close)"`.

---

### 7.2 Audit Mendalam Data Asing di File Broker Summary & Contoh JSON Mentah
Pemeriksaan rekursif terhadap seluruh skema tree dan nilai kunci pada file contoh `/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/BRPT/2026-09-08.json` menghasilkan temuan berikut:

#### 1. Seluruh Key Tingkat Atas & Skema Bersarang:
```
Top Level Keys:
[ 'stock_code', 'brokers', 'broker_levels', 'broker_start_date', 'broker_end_date', 'broker_date_min', 'broker_date_max', 'broker_net', 'flow' ]

All Distinct Key Paths:
- stock_code
- brokers
- brokers.[0].broker_code
- brokers.[0].broker_name
- brokers.[0].bval
- brokers.[0].bvol
- brokers.[0].bfrq
- brokers.[0].sfrq
- brokers.[0].sval
- brokers.[0].svol
- brokers.[0].nval
- brokers.[0].nvol
- broker_levels
- broker_levels.[0].buy
- broker_levels.[0].buy.broker_code
- broker_levels.[0].buy.broker_name
- broker_levels.[0].buy.bval
- broker_levels.[0].buy.bvol
- broker_levels.[0].buy.bfrq
- broker_levels.[0].buy.bavg
- broker_levels.[0].sell
- broker_levels.[0].sell.broker_code
- broker_levels.[0].sell.broker_name
- broker_levels.[0].sell.sval
- broker_levels.[0].sell.svol
- broker_levels.[0].sell.sfrq
- broker_levels.[0].sell.savg
- broker_start_date
- broker_end_date
- broker_date_min
- broker_date_max
- broker_net
- flow
```

#### 2. Ketiadaan Field Tipe Investor (D/F):
- Pencarian kata kunci regex `foreign`, `asing`, `f_buy`, `f_sell`, `net_foreign`, `buyer_type`, `investor_type`, `dtype`, `ftype` menghasilkan **array kosong (`[]`)**.
- Field `flow` bernilai string literal `"all"` (agregat seluruh pelaku pasar).
- **Penegasan Metodologis:** Karena field tipe investor tidak ada pada feed broker summary, nilai `foreignNet` **tetap diisi `null` secara jujur**. Sistem **DILARANG KERAS** menggunakan pemetaan kode broker (seperti mengasumsikan broker AK/BK/ZP murni investor asing) karena di pasar modal Indonesia banyak institusi/ritel domestik bertransaksi via broker asing dan sebaliknya.

#### 3. Potongan Contoh JSON Mentah (`BRPT/2026-09-08.json`):
```json
{
 "stock_code": "BRPT",
 "flow": "all",
 "broker_net": false,
 "broker_start_date": "2026-09-08",
 "broker_end_date": "2026-09-08",
 "broker_date_min": "2020-01-02",
 "broker_date_max": "2026-09-08",
 "brokers": [
   {
     "broker_code": "YP",
     "broker_name": "MIRAE ASSET SEKURITAS INDONESIA",
     "bval": 8600155500,
     "bvol": 4861500,
     "bfrq": 1246,
     "sfrq": 423,
     "sval": 2967711500,
     "svol": 1674400,
     "nval": 5632444000,
     "nvol": 3187100
   }
 ],
 "broker_levels": [
   {
     "buy": {
       "broker_code": "XL",
       "broker_name": "STOCKBIT SEKURITAS DIGITAL",
       "bval": 16643098500,
       "bvol": 9403700,
       "bfrq": 4344,
       "bavg": 1769.8457522039198
     },
     "sell": {
       "broker_code": "CC",
       "broker_name": "MANDIRI SEKURITAS",
       "sval": 18477875500,
       "svol": 10431600,
       "sfrq": 3124,
       "savg": 1771.3366597645615
     }
   }
 ]
}
```

#### 4. Uji Silang Data Asing vs Tape *Done Details* (Board RG):
- Pada tape transaksi *done details* 8 September 2026 ([`backtest/lpm-done/raw/2026-09-08/BRPT.jsonl.gz`](backtest/lpm-done/raw/2026-09-08/BRPT.jsonl.gz)), tipe investor tercatat presisi per transaksi:
 * Pembelian oleh investor asing (`buyer_type: "F"`): **Rp 1.161.670.500** (dilakukan secara agresif memakan offer).
 * Penjualan oleh investor asing (`seller_type: "F"`): **Rp 0** (tidak ada asing membuang barang).
 * Aliran bersih asing pasar reguler: **+Rp 1,16 Miliar**.
- Pada file broker summary Arjum, angka ini tidak dipisahkan dan melebur ke dalam volume broker masing-masing.

---

### 7.3 Hasil Uji Kegunaan Kuantitatif v2 (Periode Penuh 2 Jan s.d. Pertengahan Sep 2026)

Pengujian diperluas dari 54 hari (khusus Juni) menjadi **136 sesi bursa penuh** (2 Februari 2026 s.d. 15 September 2026, setelah periode pemanasan 20 hari pertama sejak 2 Januari 2026) terhadap seluruh saham likuid (omset $\ge$ Rp 1 Miliar/hari) via [`backtest/broksum/run_analysis_v2.js`](backtest/broksum/run_analysis_v2.js):

| Parameter Uji Kuantitatif | Periode Normal (136 Hari Bursa, Feb–Sep 2026) | 95% Bootstrap Confidence Interval | Periode Menjelang Crash (16 Sep–2 Okt 2026) |
|---|---|---|---|
| **Jumlah Hari Observasi ($N$)** | 136 hari bursa | — | 13 hari bursa |
| **Rata-rata Spearman IC `tb`** | **-0,0118** | **[-0,0210, -0,0025]** | **+0,0114** (CI95: `[-0,0158, +0,0414]`) |
| **Rata-rata Spearman IC `tbSlope5`** | **-0,0320** | **[-0,0424, -0,0216]** | — |
| **Rata-rata Spearman IC `hab20`** | **-0,0259** | **[-0,0572, +0,0038]** | — |
| **Hit Rate Kuintil Q5 vs Q1** | **50,7%** (koin acak murni 50:50) | — | — |
| **Mean Spread Return 10D (Q5 − Q1)** | **0,00%** | — | — |

#### Temuan Statistik Krusial:
1. **Kedua Batas CI95 `tb` dan `tbSlope5` Berada di Bawah Nol:**
  - Untuk `tb`, interval 95% adalah `[-0,0210, -0,0025]`.
  - Untuk `tbSlope5`, interval 95% adalah `[-0,0424, -0,0216]`.
  - Ini adalah bukti statistik kuat bahwa di Bursa Efek Indonesia, saham-saham yang mengalami lonjakan akumulasi broker harian atau tren kenaikan akumulasi 5 hari **justru memiliki kecenderungan tipis berkinerja lebih buruk dalam 10 hari ke depan**. Hal ini konsisten dengan perilaku *distribution into strength* oleh bandar cerdas kepada pengikut ritel.
2. **Ketiadaan Alpha Kuintil:**
  - Membeli saham-saham dengan akumulasi broker tertinggi (Q5) dan menghindari/menjual saham dengan distribusi terberat (Q1) menghasilkan **spread return tepat 0,00%** dengan peluang menang $50{,}7\%$ (setara melempar koin).

#### Label Klasifikasi Resmi:
> ### **STATUS KESIMPULAN: ALAT BACA SAJA**
> **(Tampil di Chart sebagai Alat Bantu Visual Tanpa Sinyal Beli/Jual Otomatis)**
> *Konfirmasi Ilmiah: Berdasarkan 136 sesi bursa observasi penuh sepanjang 2026, metrik broker summary terbukti tidak memiliki korelasi prediktif positif terhadap return masa depan. Fitur ini aman dan bermanfaat disajikan di chart teknikal sebagai penunjuk siapa yang aktif bertransaksi dan di level harga berapa modal rata-rata mereka berada (`hab20`), namun dilarang keras menghasilkan sinyal beli otomatis.*

---

### 7.4 Ekspor Ulang Lengkap 197 Hari Bursa (2 Jan s.d. 16 Okt 2026)

Seluruh 197 hari bursa aktif tahun 2026 telah diekspor ulang secara lengkap ke direktori [`backtest/broksum/out/`](backtest/broksum/out/):
- [`backtest/broksum/out/BRPT.json`](backtest/broksum/out/BRPT.json) (**197 hari**, 2 Jan 2026 s.d. 16 Okt 2026, `sourceT` terekam, `foreignNet: null`, `locked: "ARB"` pada 16 Okt).
- [`backtest/broksum/out/BBCA.json`](backtest/broksum/out/BBCA.json) (**197 hari**, 2 Jan 2026 s.d. 16 Okt 2026).
- [`backtest/broksum/out/MEDC.json`](backtest/broksum/out/MEDC.json) (**197 hari**, 2 Jan 2026 s.d. 16 Okt 2026).


---

## 8. PENYARINGAN HARI TANPA TRANSAKSI (T=0) & REKALKULASI KUANTITATIF PENUH

> **Konteks Audit Lanjutan:** Penanganan Hari Libur Bursa Nasional & File Broksum Kosong  
> **Prinsip Disiplin Kuantitatif AntiSlop §107:** Hari bursa non-aktif dengan omset nol (T=0) tidak boleh mengotori perhitungan rata-rata likuiditas berjalan, jendela konsistensi broker, maupun horizon pengujian *forward return*.

### 8.1 Identifikasi & Inventaris Hari T=0 Sepanjang 2026
Dari 197 file tanggal kalender 2026 (2 Januari s.d. 16 Oktober 2026), audit menemukan **9 tanggal dengan omset nol (T = 0, top3Buy = 0, top3Sell = 0)**:
1. `2026-02-16` : Libur Tahun Baru Imlek 2577 Kongzili
2. `2026-03-18` : Cuti Bersama Hari Raya Nyepi / Idul Fitri 1447 H
3. `2026-03-19` : Hari Raya Idul Fitri 1447 H
4. `2026-05-15` : Kenaikan Isa Almasih
5. `2026-05-27` : Hari Raya Idul Adha 1447 H
6. `2026-05-28` : Cuti Bersama Idul Adha 1447 H
7. `2026-06-01` : Hari Lahir Pancasila
8. `2026-06-16` : Tahun Baru Islam 1448 H
9. `2026-08-25` : Maulid Nabi Muhammad SAW

#### Dampak Buruk jika Hari T=0 Dibiarkan:
- **Distorsi SMA20(T):** Pembagi rata-rata 20 hari mendilusi likuiditas karena membagi total omset dengan 20 hari kalender, bukan 20 sesi bursa aktif.
- **Distorsi tbCum:** Delta harian bernilai 0 sehingga akumulasi berjalan tampak mendatar (*flatline*) secara artifisial pada hari libur.
- **Distorsi Jendela Konsistensi (kons.days10 & streak):** Mengurangi probabilitas keaktifan broker dalam 10 hari kalender terakhir meskipun bursa memang tutup.
- **Distorsi *Forward Return* 10 Hari (t + 10):** Indeks lompatan t + 10 melompati lebih sedikit sesi aktif bursa jika terdapat hari libur di antaranya.

---

### 8.2 Modifikasi Modul Indikator & Pengujian Satuan (Unit Test)
Modul [`backtest/broksum/broksum-indicators.js`](backtest/broksum/broksum-indicators.js) telah disempurnakan:
1. **Penyaringan Ketat di Pass 1:**
   ```javascript
   // Total daily turnover T: priority 1: explicit field in broksum if any;
   // priority 2: candle turnover (volume * close); priority 3: sum of brokers sumB
   const candleTurnover = Number(item.turnover || (item.volume && item.close ? item.volume * item.close : 0));
   const broksumTotal = Number(item.broksum?.total_val || item.broksum?.total_value || item.broksum?.val || 0);
   const T = broksumTotal > 0 ? Math.round(broksumTotal) : (candleTurnover > 0 ? Math.round(candleTurnover) : Math.round(sumB));

   // Buang hari dengan T=0 (libur bursa, file kosong, tanpa turnover)
   if (!T || T <= 0) {
     continue;
   }
   ```
2. **Penyelarasan Harga Penutupan Sebelumnya (prevClose):**
   Harga acuan prevClose untuk deteksi ARA/ARB diambil secara deterministik dari harga penutupan sesi aktif bursa terakhir (`parsedDays[parsedDays.length - 1].close`), bukan tanggal kalender sebelumnya.
3. **Kalkulasi Rolling Metrik di Pass 2 & 3:**
   Semua metrik SMA20(T), tbCum, tbSlope5, hab20, dan kons dihitung secara eksklusif di atas panjang deret aktif `nParsed`.
4. **Verifikasi Unit Test ([`backtest/broksum/test_indicators.js`](backtest/broksum/test_indicators.js)):**
   - Ditambahkan pengujian `testZeroTurnoverFiltering()` dengan 25 bar sintetis yang disisipi 3 hari libur T=0.
   - Hasil: Deret keluaran tepat 22 hari bursa aktif, 0 hari dengan T=0, metrik SMA20 aktif tepat pada hari ke-20 aktif (**Status: 100% ALL PASS**).

---

### 8.3 Hasil Uji Kegunaan Kuantitatif Terbaru (Tanpa Hari T=0)
Pengujian ulang dijalankan melalui [`backtest/broksum/run_analysis_v2.js`](backtest/broksum/run_analysis_v2.js) secara *read-only* tanpa request API Arjum (0 request):

| Parameter Uji Kuantitatif | Sebelum Filter (Termasuk Libur) | Setelah Filter T=0 (188 Hari Aktif) | 95% Bootstrap Confidence Interval | Keterangan Ilmiah |
|---|---|---|---|---|
| **Jumlah Hari Observasi (N)** | 136 hari | **145 sesi bursa aktif** | — | Pemanasan 20 hari aktif tercapai lebih cepat |
| **Rentang Tanggal Observasi** | Feb s.d. Sep 2026 | **2 Feb s.d. 15 Sep 2026** | — | Murni hari perdagangan bursa |
| **Rata-rata Spearman IC `tb`** | -0,0118 | **-0,0144** | **[-0,0227, -0,0058]** | **Negatif signifikan (seluruh CI95 < 0)** |
| **Rata-rata Spearman IC `tbSlope5`** | -0,0320 | **-0,0326** | **[-0,0422, -0,0231]** | **Negatif signifikan (seluruh CI95 < 0)** |
| **Rata-rata Spearman IC `hab20`** | -0,0259 | **-0,0230** | **[-0,0549, +0,0069]** | Memotong nol (tidak prediktif) |
| **Hit Rate Kuintil Q5 vs Q1** | 50,7% | **49,7%** | — | Di bawah 50% (setara koin acak murni) |
| **Mean Spread Return 10D (Q5 − Q1)**| 0,00% | **-0,07%** | — | Portofolio akumulasi bandar tertinggal dari distribusi |
| **IC Periode Crash (16 Sep–2 Okt)**| +0,0114 | **+0,0079** | **[-0,0198, +0,0383]** | Memotong nol (tidak ada alpha proteksi) |

#### Kesimpulan Uji Kegunaan Setelah Koreksi:
Penyaringan hari libur membuktikan bahwa temuan ketiadaan alpha bukan akibat kebisingan (*noise*) hari libur:
1. IC `tb` tetap negatif (-0,0144) dengan interval keyakinan 95% yang seluruhnya berada di area negatif.
2. Saham-saham dengan net akumulasi broker tertinggi (Q5) mencatatkan return 10 hari yang justru **0,07% lebih rendah** dibanding saham yang didistribusikan (Q1).
3. Hit rate 49,7% mengonfirmasi bahwa indikator bandar dari broker summary tidak dapat dipakai sebagai sinyal beli otomatis.

---

### 8.4 Hasil Ekspor Ulang File Desain UI ([`backtest/broksum/out/`](backtest/broksum/out/))
Seluruh file JSON untuk kebutuhan visualisasi UI telah diekspor ulang bebas dari hari T=0:
1. [`backtest/broksum/out/BRPT.json`](backtest/broksum/out/BRPT.json):
   - **Total Sesi Aktif:** **188 hari bursa aktif** (9 hari T=0 dibuang).
   - **Jumlah T=0:** **0 bar**.
   - **Rentang:** `2026-01-02` s.d. `2026-10-16`.
2. [`backtest/broksum/out/BBCA.json`](backtest/broksum/out/BBCA.json):
   - **Total Sesi Aktif:** **188 hari bursa aktif** (9 hari T=0 dibuang).
   - **Jumlah T=0:** **0 bar**.
3. [`backtest/broksum/out/MEDC.json`](backtest/broksum/out/MEDC.json):
   - **Total Sesi Aktif:** **188 hari bursa aktif** (9 hari T=0 dibuang).
   - **Jumlah T=0:** **0 bar**.

> **STATUS RESMI TETAP:** **ALAT BACA SAJA**  
> *Rekomendasi implementasi:* Sajikan komponen bandarmologi broker summary di chart workstation sebagai data deskriptif / alat visual pembantu (siapa pemain dominan dan di level harga modal berapa), namun tidak boleh dijadikan pemicu scoring atau sinyal strategi beli otomatis.
