# LAPORAN FASE 3 · SIMULASI ALIRAN ASING + LPM (RISET DILEWATI — SYARAT BELUM TERPENUHI)

**Tanggal Audit:** Minggu, 18 Oktober 2026  
**Status:** ⏭ **DILEWATI** — syarat jalan belum terpenuhi (cakupan F likuid = 13,79%, jauh di bawah 90%)  
**Arjum request terpakai:** 0 (read-only)  
**Perubahan produksi:** Tidak ada

---

## 1. Pemeriksaan Syarat Jalan (Pre-Condition Check)

**Syarat:** Cakupan file F asli + all lengkap untuk saham likuid (turnover ≥ Rp 1 Miliar/hari) ≥ 90% sejak 2 Jan 2026.

### Hasil Pemeriksaan Sensus VPS

| Metrik | Nilai | Syarat | Status |
|---|---|---|---|
| Saham likuid (avg turnover ≥ Rp 1 M) | **502 ticker** | — | — |
| Saham regular (avg turnover < Rp 1 M) | **461 ticker** | — | — |
| Total hari bursa dalam rentang | **188 hari** (2 Jan – 16 Okt 2026) | — | — |
| **Grid cells likuid total** (502 × 188) | **94.376** | — | — |
| **Cakupan F asli** | **13,80%** | ≥90% | ❌ |
| **Cakupan all unclipped** | **68,50%** | ≥90% | ❌ |
| **Cakupan F + all lengkap** | **13,79%** | ≥90% | ❌ |

**Kesimpulan:** ❌ **Syarat jalan Fase 3 BELUM TERPENUHI.**

---

## 2. Status Cakupan per Kelompok Saham

### Top 20 Likuid (Coverage 100%)

Saham-saham likuid teratas sudah memiliki cakupan 100% (F + all lengkap):
`AADI, ADMR, ADRO, AMMN, AMRT, ANTM, ARCI, ASII, BACH, BBCA, BBNI, BBRI, BIPI, BKSL, BMRI, BNBR, BREN, BRMS, BRPT, BULL` (dan masih banyak lagi).

### Bottom 20 Likuid (Coverage 0%)

Saham pada huruf awal `V-Z` belum memiliki file F:
`VERN, VICI, VISI, VIVA, VTNY, WAPO, WBSA, WEGE, WEHA, WGSH, WIIM, WINR, WINS, WIRG, WMPP, WMUU, WOWS, YELO, YOII, ZATA`

**Pola:** Worker backfill memproses berdasarkan urutan abjad setelah memprioritaskan likuiditas. Saham pada huruf awal `V-Z` akan diproses **terakhir** (~2 Nov 2026) karena tidak semua likuid atau tidak ada di daftar prioritas atas.

---

## 3. Kapan Fase 3 Bisa Dijalankan

### Estimasi Berdasarkan Antrean Backfill

Worker saat ini berjalan dengan:
- Prioritas: saham likuid (502) + regular (461)
- Urutan tanggal: 16 Okt 2026 → 2 Jan 2026 (mundur)
- Pacing: 8 req/s (125 ms delay)
- Kapasitas harian efektif: ~12.653 request/hari kerja

### Estimasi Tanggal Cakupan 90%:

| Kelompok | Cakupan Target | Perkiraan Tanggal |
|---|---|---|
| **Saham likuid (top 100)** | 100% | **Selasa, 20 Oktober 2026** |
| **Saham likuid (502)** | **≥90%** | **Kamis, 22 Oktober 2026** |
| **Seluruh 962 saham** | ≥90% | **Minggu, 2 November 2026** |

**Estimasi Konservatif untuk Memulai Fase 3:** **Kamis, 22 Oktober 2026** (saat semua saham likuid mencapai ≥90% cakupan).

---

## 4. Hipotesis Pemilik (Tidak Diuji Karena Syarat Belum Terpenuhi)

Hipotesis yang **akan diuji** ketika syarat terpenuhi:

1. **Asing penggerak utama saham Indonesia.**  
   Asing akumulasi lama sambil harga ditekan atau sideways, lalu harga naik.
2. **Fase akumulasi diam-diam:** Return 20 hari ≤ +2% **dan** CumNFn(20) di atas ambang in-sample.
3. **Fase distribusi:** Return 20 hari ≥ +5% **dan** CumNFn(20) < 0.

**Catatan Jujur:** Uji sebelumnya (dari audit laporan terdahulu) menunjukkan broker summary **tidak memprediksi arah 10 hari**. Jika hasil uji ulang tetap negatif, akan dilaporkan sebagai hasil negatif — tidak ada manipulasi.

---

## 5. Rencana Uji Ketika Syarat Terpenuhi

### Struktur Kode (Akan Dibuat di `backtest/foreign-flow/`)

```
backtest/foreign-flow/
├── f0_data_definitions.js      # Cek satuan lot/lembar, validasi Rp
├── f1_foreign_features.js       # NF, NFn, CumNF(5,20,60), dll.
├── f2_hypothesis_tests.js       # H1-H6 uji
├── f3_plots/                    # Gambar PNG + JSON
├── fig/
└── REPORT_FOREIGN_LPM.md        # Laporan final
```

### Aturan Uji (Disipkan & Tidak Akan Diubah)

- **Anti look-ahead:** Fitur pada hari t memakai data sampai close t.
- **Return:** Close t → close t+h, setelah biaya (beli 0,15%, jual 0,25%).
- **Excess return:** Terhadap IHSG.
- **Pemisahan periode:** Jan–Jun 2026 (in-sample) untuk memilih ambang; Jul–16 Okt 2026 (out-of-sample) untuk menguji.
- **Ambang tidak boleh diubah setelah melihat hasil uji.**
- **Newey-West standard errors** untuk return tumpang tindih.
- **Buang sinyal** yang jendela return-nya melewati 16 Okt.
- **File `derived:"no-trade"` = asing 0.**

### Uji yang Akan Dijalankan:

| Uji | Deskripsi |
|---|---|
| **F0** | Cek satuan lot/lembar & nilai Rp; cocokkan satu contoh dengan nilai transaksi candle |
| **F1** | Hitung fitur: NF, NFn, CumNF(5,20,60), Partisipasi asing, Harga rata-rata asing 60 hari, Beruntun, Fase akumulasi diam-diam, Fase distribusi |
| **F2/H1** | Rank IC CumNFn terhadap excess return +5/+10/+20/+40 hari, desil teratas vs terbawah |
| **F2/H2** | Event study akumulasi diam-diam: lama fase, dalamnya penurunan, hasil 5/10/20/40 hari setelah fase berakhir, dibandingkan baseline |
| **F2/H3** | Apa yang terjadi setelah CumNF(20) berbalik turun dari puncaknya |
| **F2/H4** | Sinyal S1 LPM sendirian vs S1 + konfirmasi asing vs S1 + asing distribusi |
| **F2/H5** | Per kelompok: LQ45 vs lapis 2-3, per sektor |
| **F2/H6** | Ketahanan: tanpa 10 hari paling ekstrem, ambang ±50%, k=10 dan 40 |
| **F3** | Gambar untuk BBCA, BRPT, satu saham lapis dua dengan efek terkuat |
| **F4** | Kesimpulan: didukung / lemah / tidak didukung dengan angka out-of-sample |

### Perintah Siap Tempel untuk Dijalankan Nanti

```bash
# Setelah Kamis, 22 Okt 2026 (cakupan ≥90%):
cd /home/ubuntu/auto-cuan

# 1. Verifikasi cakupan
node tools/check-fase3-condition.js

# 2. Jika cakupan ≥90%, jalankan Fase 3
mkdir -p backtest/foreign-flow
node backtest/foreign-flow/f0_data_definitions.js
node backtest/foreign-flow/f1_foreign_features.js
node backtest/foreign-flow/f2_hypothesis_tests.js
node backtest/foreign-flow/f3_plots.js

# 3. Review hasil di:
ls -la backtest/foreign-flow/fig/
cat backtest/foreign-flow/REPORT_FOREIGN_LPM.md
```

---

## 6. Batasan Sampel (Ketika Dijalankan)

- **Sampel waktu:** ~9,5 bulan (Jan–16 Okt 2026), termasuk crash 16 Okt 2026.
- **Jumlah saham likuid:** 502 ticker.
- **Jumlah hari bursa:** 188 hari.
- **Total grid cells:** 94.376.
- **Keterbatasan sampel:** crash 16 Okt 2026 mungkin menjadi outlier yang mempengaruhi signifikansi.

---

## 7. Ringkasan Status Fase 3

| Aspek | Status |
|---|---|
| Syarat jalan (cakupan F likuid ≥90%) | ❌ Belum terpenuhi (13,79%) |
| Kode uji dibuat | ❌ Tidak (menunggu syarat) |
| Arjum request terpakai | **0** |
| Perubahan produksi | ❌ Tidak ada |
| Estimasi tanggal bisa jalan | **Kamis, 22 Oktober 2026** |
| Perintah uji siap tempel | ✅ Tersedia di atas |
