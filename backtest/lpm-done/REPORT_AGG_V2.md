# LAPORAN PERBAIKAN AGREGAT DONE DETAILS v2: ELIMINASI ARTEFAK HARGA TERKUNCI (ARA/ARB) & PEMISAHAN SESI LELANG

> **Klasifikasi:** Laporan Kuantitatif Forensik Mikrostruktur Pasar Modal & Kalibrasi Ulang Tape Reading  
> **Subjek Analisis:** Data Transaksi Tik-per-Tik (*Done Details / Order Flow Tape*) Bursa Efek Indonesia  
> **Target Pengujian:** BRPT, MEDC, ADRO, AKRA, ACES, ASII (Sesi 8 September 2026 & 16 Oktober 2026)  
> **Modul Pembaruan:** [`backtest/lpm-done/aggregate_v2.js`](backtest/lpm-done/aggregate_v2.js)  
> **Runner Rekalkulasi:** [`backtest/lpm-done/recalculate_v2.js`](backtest/lpm-done/recalculate_v2.js)  
> **Data Agregat Baru:** [`backtest/lpm-done/agg_v2/`](backtest/lpm-done/agg_v2/) (Tanpa menimpa `agg/` lama)  
> **Prinsip AntiSlop §107:** Koreksi ilmiah tanpa kompromi, kejujuran matematika di atas interpretasi yang keliru.

---

## 1. PEMBATALAN KLAIM AWAL (RETRACTION OF PREVIOUS INTERPRETATION)

Pada laporan sebelumnya ([`backtest/lpm-done/REPORT_COLLECTOR.md`](backtest/lpm-done/REPORT_COLLECTOR.md)), pembacaan awal terhadap data BRPT sesi **16 Oktober 2026** menyimpulkan adanya *"94,8% pembeli agresif (hajar kanan Rp 231,6 Miliar)"* dan *"akumulasi asing agresif Rp 94,9 Miliar"*.

### **PERNYATAAN PEMBATALAN RESMI:**
**Interpretasi tersebut SECARA RESMI DIBATALKAN KARENA CACAT METODOLOGI MIKROSTRUKTUR TAPE:**
1. Pada 16 Oktober 2026, saham BRPT **mengalami Auto Rejection Bawah (ARB) di harga Rp 1.210** (turun -14,79% dari harga penutupan hari sebelumnya Rp 1.420).
2. Ketika suatu saham terkunci di batas bawah ARB, antrean jual masif menumpuk di sisi offer pada harga batas tersebut (Rp 1.210).
3. Setiap transaksi yang terjadi di harga ARB adalah pembeli yang mengambil antrean antrean jual yang sudah pasif tersebut. Akibatnya, bursa dan feed broker summary secara otomatis mencatat `action: "BUY"`.
4. **Itu bukan tekanan beli agresif (*buying pressure*). Itu adalah artefak mekanis antrean batas bawah (*limit-locked artifact*).** Pasar sebenarnya sedang berada dalam kondisi tekanan jual ekstrem (*extreme selling panic*).
5. Jika transaksi di harga terkunci ini dihitung sebagai akumulasi, algoritma Liquidity Pressure Model (LPM) akan mengalami disonansi fatal: **membaca hari kejatuhan pasar (*crash day*) sebagai akumulasi paus terbesar**.

---

## 2. JAM SESI PERDAGANGAN DARI DATA EMPIRIS

Penentuan jam sesi perdagangan dibuktikan langsung melalui audit menit-demi-menit terhadap 5 dataset transaksi riil (BRPT, MEDC, ADRO pada 8 Sep 2026 dan BRPT, MEDC pada 16 Okt 2026) via [`backtest/lpm-done/analyze_sessions.js`](backtest/lpm-done/analyze_sessions.js):

### 2.1 Peta Sesi Berdasarkan Data Transaksi Aktual
```
+---------------------------------------------------------------------------------------------------+
|  08:58 - 08:59  |   09:00 - 11:30/12:00   |   JEDA SIANG    |   13:30/14:00 - 15:49   |  15:50-16:00  | 16:01-16:15 |
| Lelang Pra-Buka |    Kontinu Sesi 1       |  (0 Transaksi)  |     Kontinu Sesi 2      | Lelang Tutup  | Pasca-Tutup |
|  [AUCTION VAL]  |     [CONTINUOUS]        |   ISTIRAHAT     |      [CONTINUOUS]       | [AUCTION VAL] | [POST VAL]  |
+---------------------------------------------------------------------------------------------------+
```

1. **Lelang Pra-Pembukaan (*Pre-Opening Auction*):**
   - **Rentang Jam:** Tepat **`08:58:00` s.d. `08:59:59`** WIB.
   - **Bukti Empiris:** 95 transaksi BRPT (8 Sep), 277 transaksi ADRO (8 Sep), 656 transaksi BRPT (16 Okt), dan 616 transaksi MEDC (16 Okt) terjadi serentak di detik `08:58:00`.
   - **Karakteristik:** Transaksi lelang terjadi pada satu harga ekuilibrium pembukaan (*call auction*). Tidak ada konsep *bid-ask crossing* agresif.
2. **Perdagangan Kontinu Sesi 1 (*Continuous Trading Session 1*):**
   - **Senin – Kamis:** Berlangsung dari **`09:00:00` s.d. `11:59:59`** WIB.
   - **Jumat (Sesi Pendek):** Berlangsung dari **`09:00:00` s.d. `11:29:59`** WIB.
   - **Karakteristik:** Eksekusi order kontinu di mana aksi pembeli memakan antrean offer (`action: "BUY"`) atau penjual menghantam bid (`action: "SELL"`) memiliki makna agresor yang valid.
3. **Jeda Istirahat Bursa (*Market Break*):**
   - **Senin – Kamis:** `12:00:00` s.d. `13:29:59` WIB (terbukti **0 transaksi** pada 8 Sep).
   - **Jumat:** `11:30:00` s.d. `13:59:59` WIB (terbukti **0 transaksi** pada 16 Okt).
4. **Perdagangan Kontinu Sesi 2 (*Continuous Trading Session 2*):**
   - **Senin – Kamis:** Berlangsung dari **`13:30:00` s.d. `15:49:59`** WIB.
   - **Jumat:** Berlangsung dari **`14:00:00` s.d. `15:49:59`** WIB.
   - Transaksi kontinu reguler berakhir tepat pada pukul **`15:49:59`** WIB.
5. **Lelang Pra-Penutupan (*Pre-Closing Auction Matching*):**
   - Pukul `15:50:00` s.d. `15:59:59` WIB adalah pembentukan order lelang tanpa eksekusi.
   - Tepat di **`16:00:00` s.d. `16:00:59`** WIB, terjadi eksekusi serentak lelang penutupan:
     * BRPT 8 Sep: 290 transaksi serentak di `16:00`.
     * ADRO 8 Sep: 259 transaksi serentak di `16:00`.
     * MEDC 8 Sep: 202 transaksi serentak di `16:00`.
     * MEDC 16 Okt: 62 transaksi serentak di `16:00`.
6. **Sesi Pasca-Penutupan (*Post-Trading Session*):**
   - Berlangsung dari **`16:01:00` s.d. `16:15:00`** WIB (transaksi pada harga penutupan yang sudah terbentuk).
   - Transaksi terakhir hari itu tercatat di detik `16:14:59` WIB.

---

## 3. ATURAN DETEKSI HARGA TERKUNCI (ARA/ARB) & FRAKSI TICK IDX

### 3.1 Sumber Aturan Resmi Bursa Efek Indonesia
Perhitungan batas Auto Rejection mengacu pada:
- **Keputusan Direksi PT Bursa Efek Indonesia Nomor Kep-00055/BEI/03-2023** jo. **Kep-00096/BEI/12-2023** mengenai normalisasi batasan Auto Rejection di pasar reguler dan tunai.
- **Surat Keputusan Direksi PT BEI Nomor Kep-00023/BEI/03-2020** perihal fraksi harga (*tick size*) bursa.
- Implementasi sistem pada [`lib/idx-tick-normalization.js:1007-1039`](lib/idx-tick-normalization.js:1007).

### 3.2 Rumus Perhitungan Batas Harga
1. **Auto Rejection Atas (ARA):**
   - Rentang harga $> \text{Rp } 5.000$: $+20\%$
   - Rentang harga $\text{Rp } 200 - \text{Rp } 5.000$: $+25\%$
   - Rentang harga $\text{Rp } 50 - \text{Rp } 200$: $+35\%$
   - $\text{araPx} = \text{roundToIdxTick}(\text{prevClose} \times (1 + \text{araPct}), \text{'floor'})$
2. **Auto Rejection Bawah (ARB):**
   - Batas normalisasi asimetris BEI dengan batas bawah Rp1:
     $$\text{arbRaw} = \max(1, \lfloor \text{prevClose} \times 0{,}85 \rfloor)$$
     $$\text{arbPx} = \text{roundToIdxTick}(\text{arbRaw}, \text{'ceil'})$$

### 3.3 Pencocokan Matematika pada BRPT 16 Oktober 2026:
- $\text{prevClose}$ (penutupan 15 Okt 2026) = **Rp 1.420**.
- Rentang harga Rp 1.420 berada pada fraksi tick Rp 5.
- Batas ARA: $1.420 \times 1{,}25 = 1.775 \rightarrow \text{araPx} = \mathbf{1.775}$.
- Batas ARB: $\lfloor 1.420 \times 0{,}85 \rfloor = 1.207 \rightarrow$ pembulatan ke atas tick Rp 5 $\rightarrow \text{arbPx} = \mathbf{1.210}$.
- **Kenyataan di Pasar:** Pada 16 Oktober 2026, harga terendah, harga penutupan, dan VWAP BRPT berada persis di **Rp 1.210**.
- Dari 7.412 transaksi BRPT hari itu, sebanyak **7.321 transaksi (98,8%) dieksekusi di harga Rp 1.210**. Saham terkunci total di ARB.

---

## 4. METODOLOGI AGREGASI v2 (FILTERING BERSIH)

Dalam modul [`backtest/lpm-done/aggregate_v2.js`](backtest/lpm-done/aggregate_v2.js), aturan kalkulasi disempurnakan:
1. **Pemisahan Sesi:**
   - `auctionVal`: Transaksi jam `< 09:00:00` dan `15:50:00` s.d. `16:00:59`.
   - `postVal`: Transaksi jam `> 16:00:59`.
   - `contVal`: Transaksi kontinu jam `09:00:00` s.d. `15:49:59`.
2. **Eliminasi Transaksi Terkunci (*Locked Trades*):**
   - Setiap transaksi kontinu dengan $\text{price} \ge \text{araPx}$ atau $\text{price} \le \text{arbPx}$ diberi flag `locked`.
   - Nilainya dicatat terpisah ke `lockedVal`, `lockedSide` (`"ARA"` / `"ARB"`), dan `lockedShare` (`lockedVal / totalVal`).
   - Transaksi terkunci **TIDAK DIHITUNG** di dalam:
     `buyAggVal`, `sellAggVal`, `bigBuyVal`, `bigSellVal`, `fAggBuyVal`, `fAggSellVal`.
3. **Persentil Bersih (*Clean Continuous Percentiles*):**
   - Nilai $p50$, $p90$, $p95$, $p99$, dan identifikasi transaksi paus ($bigN$) dihitung **HANYA dari transaksi kontinu yang tidak terkunci** (`cleanContinuousRows`).

---

## 5. TABEL KOMPARASI LENGKAP: v1 (NAIVE) VS v2 (FILTERED)

Dihitung ulang dari seluruh file `raw/*.jsonl.gz` yang ada via [`backtest/lpm-done/recalculate_v2.js`](backtest/lpm-done/recalculate_v2.js):

| Kode Saham & Tanggal | prevClose (ARA/ARB) | Total Omset (Rp) | v1 Buy Aggressive | v2 Clean Buy Agg | v1 Asing Beli Aggr | v2 Clean Asing Beli Aggr | Nilai Terkunci (Locked Val & Share) | Nilai Lelang & Pasca-Tutup | Keterangan Fenomena |
|---|---|---|---|---|---|---|---|---|---|
| **BRPT 16 Okt 2026** | 1.420 (1.775 / 1.210) | Rp 244,45 M | **Rp 231,67 M (94,8%)** | **Rp 1,98 M (0,8%)** | **Rp 94,95 M** | **Rp 7,20 Juta** | **Rp 233,70 M (95,6% ARB)** | Rp 6,83 M | **Terkunci ARB (Crash). Akumulasi semu v1 dieliminasi total!** |
| **MEDC 16 Okt 2026** | 1.515 (1.890 / 1.290) | Rp 134,84 M | Rp 74,75 M (55,4%) | Rp 45,12 M (35,7%) | Rp 41,06 M | Rp 35,06 M | **Rp 45,25 M (33,6% ARB)** | Rp 8,40 M | Sempat tersentuh ARB (1.290) lalu memantul. Porsi locked disaring bersih. |
| **BRPT 08 Sep 2026** | 1.770 (2.210 / 1.505) | Rp 94,23 M | Rp 34,03 M (36,1%) | Rp 29,96 M (36,3%) | Rp 1,63 M | Rp 1,16 M | **Rp 0 (0,0% - Normal)** | Rp 11,82 M | **Hari normal.** Selisih v1 vs v2 murni karena pemisahan lelang. |
| **MEDC 08 Sep 2026** | 1.485 (1.855 / 1.265) | Rp 134,54 M | Rp 79,53 M (59,1%) | Rp 67,01 M (55,2%) | Rp 25,43 M | Rp 24,68 M | **Rp 0 (0,0% - Normal)** | Rp 13,05 M | **Hari normal.** Selisih murni karena lelang & crossing pasca-tutup. |
| **ACES 08 Sep 2026** | 358 (446 / 304) | Rp 3,05 M | Rp 1,34 M (44,0%) | Rp 1,28 M (43,4%) | Rp 208 Juta | Rp 208 Juta | **Rp 0 (0,0% - Normal)** | Rp 88 Juta | Hari normal likuiditas sedang. |
| **ADRO 08 Sep 2026** | 2.700 (3.370 / 2.300) | Rp 91,24 M | Rp 37,60 M (41,2%) | Rp 34,03 M (39,7%) | Rp 12,25 M | Rp 11,36 M | **Rp 0 (0,0% - Normal)** | Rp 5,54 M | Hari normal bervolume tinggi. |
| **AKRA 08 Sep 2026** | 1.450 (1.810 / 1.235) | Rp 73,54 M | Rp 47,52 M (64,6%) | Rp 45,96 M (65,1%) | Rp 14,49 M | Rp 14,09 M | **Rp 0 (0,0% - Normal)** | Rp 2,89 M | Hari normal akumulasi teratur. |
| **ASII 08 Sep 2026** | 4.910 (6.125 / 4.180) | Rp 162,04 M | *(v1 belum dihitung)* | Rp 58,07 M (46,2%) | - | Rp 35,13 M | **Rp 0 (0,0% - Normal)** | Rp 36,25 M | Lelang penutupan ASII sangat besar (Rp 36,1 Miliar di 16:00 WIB). |

---

## 6. UJI INTEGRITAS IDENTITAS PADA HARI NORMAL

Pada hari perdagangan normal di mana harga saham bergerak wajar di dalam rentang batas (misalnya **BRPT pada 8 September 2026**):
1. **Identitas Nilai Utuh:**
   $$\text{contVal (Rp 82,41 M)} + \text{auctionVal (Rp 5,48 M)} + \text{postVal (Rp 6,34 M)} = \mathbf{\text{totalVal (Rp 94,23 M)}}$$
   Selisih penjumlahan adalah tepat **0 Rupiah (100% Match)**.
2. **Kestabilan Rasio Agresor:**
   - Pada v1: Rasio beli agresif adalah $\frac{34{,}03}{94{,}23} = \mathbf{36{,}1\%}$.
   - Pada v2: Rasio beli agresif kontinu adalah $\frac{29{,}96}{82{,}41} = \mathbf{36{,}3\%}$.
   - Rasio agresor pada hari normal terbukti **sangat stabil**, membuktikan bahwa v2 tidak merusak sinyal perdagangan normal melainkan hanya membersihkan transaksi lelang statis ($16:00$ WIB).
3. **Penyelamatan Sinyal pada Hari Crash (BRPT 16 Okt 2026):**
   - Pada v1: Menghasilkan rasio beli agresif palsu **94,8%**.
   - Pada v2: Mengoreksi rasio beli agresif riil menjadi **0,8%**, dan menandai `lockedSide: "ARB"` dengan `lockedShare: 95.6%`.
   - **Dampak Kritis:** Algoritma LPM Auto-Cuan berhasil diselamatkan dari sinyal palsu yang menjebak trader membeli saham yang sedang terkunci di dasar ARB.

---

## 7. KESIMPULAN & STATUS ARTEFAK BARU

1. Seluruh 8 file dataset mentah telah berhasil dihitung ulang dan disimpan secara permanen di [`backtest/lpm-done/agg_v2/`](backtest/lpm-done/agg_v2/) tanpa menimpa folder `agg/` lama.
2. File perbandingan komparatif lengkap tersimpan di [`backtest/lpm-done/comparison_v1_v2.json`](backtest/lpm-done/comparison_v1_v2.json).
3. Modul agregasi v2 ([`backtest/lpm-done/aggregate_v2.js`](backtest/lpm-done/aggregate_v2.js)) kini menjadi standar acuan untuk seluruh pemrosesan data *order flow tape* di Auto-Cuan, menjamin perhitungan Liquidity Pressure Model yang kredibel, objektif, dan kebal dari artefak teknis bursa.
