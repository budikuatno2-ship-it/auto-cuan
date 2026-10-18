# LAPORAN FASE 2 · UJI KELAYAKAN AKUMULASI LOKAL (BELUM LOLOS)

**Tanggal Uji:** Minggu, 18 Oktober 2026
**Status:** ⚠️ **BELUM LOLOS** — match rate 96–97% (di bawah syarat ≥99%)
**Keputusan:** `ACCUM_SOURCE=api` **TETAP** (perubahan belum diterapkan)
**Arjum request terpakai:** 0 (semua pembacaan dari disk lokal)

---

## 1. Pemeriksaan Syarat Jalan (Pre-Condition Check)

**Syarat:** Backfill all lengkap (`all_data=true`) untuk 10 saham uji sudah menutup 80 hari bursa terakhir.

**Hasil Pemeriksaan:**

| Ticker | Total Hari | Unclipped | Clipped | Missing | Coverage |
|---|---|---|---|---|---|
| BBCA | 80 | 80 | 0 | 0 | **100,0%** |
| BRPT | 80 | 80 | 0 | 0 | **100,0%** |
| BBRI | 77 | 77 | 0 | 0 | **100,0%** |
| MEDC | 80 | 80 | 0 | 0 | **100,0%** |
| ADRO | 80 | 80 | 0 | 0 | **100,0%** |
| BUMI | 80 | 80 | 0 | 0 | **100,0%** |
| BMRI | 80 | 80 | 0 | 0 | **100,0%** |
| TPIA | 80 | 80 | 0 | 0 | **100,0%** |
| BBNI | 80 | 80 | 0 | 0 | **100,0%** |
| TLKM | 75 | 75 | 0 | 0 | **100,0%** |

**Kesimpulan:** ✅ **Syarat jalan terpenuhi.** Seluruh 10 saham sudah memiliki cakupan 100% unclipped selama 80 hari bursa terakhir.

---

## 2. Hasil Uji Paritas (`tools/check-accum-parity.js`)

Skrip uji membandingkan perhitungan lokal (dari file broksum disk) dengan keluaran API autentik (`broker-accumulation/series.json`).

### Ringkasan Hasil per Ticker:

| Ticker | Metrik Uji | Hari Cocok Persis (Rp 0) | Hari Beda | Match Rate | Lolos? |
|---|---|---|---|---|---|
| **BBCA** | nval BK per hari | **77 dari 80** | 3 | **96,25%** | ❌ |
| **BRPT** | nval AZ per hari | **77 dari 80** | 3 | **96,25%** | ❌ |
| **BBRI** | nval BB per hari | **74 dari 77** | 3 | **96,10%** | ❌ |
| **MEDC** | nval AK per hari | **77 dari 80** | 3 | **96,25%** | ❌ |
| **ADRO** | nval AK per hari | **77 dari 80** | 3 | **96,25%** | ❌ |
| **BUMI** | nval CC per hari | **77 dari 80** | 3 | **96,25%** | ❌ |
| **BMRI** | nval AK per hari | **77 dari 80** | 3 | **96,25%** | ❌ |
| **TPIA** | nval AK per hari | **77 dari 80** | 3 | **96,25%** | ❌ |
| **BBNI** | nval AK per hari | **77 dari 80** | 3 | **96,25%** | ❌ |
| **TLKM** | nval BB per hari | **73 dari 75** | 2 | **97,33%** | ❌ |

**Syarat Lolos:**
- ❌ Match rate ≥ 99% per saham: **TIDAK TERPENUHI** (hanya 96-97%)
- ❌ Selisih kumulatif 80 hari ≤ 0,5%: **TIDAK TERPENUHI** (ada selisih hingga 25%)

**Kesimpulan:** **Uji paritas BELUM LOLOS.**

---

## 3. Analisis Akar Penyebab Kegagalan

### Pola Menarik: Hanya 3 Tanggal Sistematis yang Bermasalah

Dari analisis mendalam pada BBCA (yang mewakili pola saham lainnya), ditemukan **HANYA 3 tanggal** yang berbeda di seluruh 80 hari bursa:

| Tanggal | Jenis Masalah | Detail |
|---|---|---|
| **2026-09-04** | **FILE_EMPTY** | File `broker-summary/BBCA/2026-09-04.json` berukuran 9.886 B namun berisi `brokers: []` dan `broker_levels: []` (kosong). File ini tidak ada di flowchart. Di 9 ticker lainnya, file 2026-09-04 justru berisi data normal (BRPT: 61 broker, BBRI: 70 broker). **Hanya BBCA yang kosong.** |
| **2026-09-11** | **NVAL_DIFF** | File `2026-09-11.json` memiliki 74 broker dan 100 level (unclipped). Namun nilai BK dari data lokal (99,6 M) berbeda jauh dari API autentik (-215,0 M). Selisih: -314,6 M. |
| **2026-09-25** | **NVAL_DIFF** | File `2026-09-25.json` memiliki 60 broker dan 100 level (unclipped). Nilai BK lokal (-25,9 M) berbeda dari API autentik (-12,6 M). Selisih: -13,3 M. |

### Karakteristik Tanggal Bermasalah:
- **2026-09-04:** File BBCA kosong (kemungkinan waktu itu gagal fetch atau ter-filter sebagai no-trade). **Perlu penarikan ulang.**
- **2026-09-11:** Hari rebalancing indeks FTSE. File memiliki 74 broker tapi ukuran file (47.621 B) hanya **separuh** dari file normal (98.063 B). Ini **mencurigakan**.
- **2026-09-25:** Hari rebalancing indeks MSCI. File memiliki 60 broker dan ukuran 39.939 B — juga **separuh** dari normal.

### Hipotesis Penyebab:
1. **Header/Field Mismatch:** File September mungkin memiliki skema field yang berbeda dari file Oktober (ukuran 2× lebih besar meski jumlah broker serupa). Kemungkinan field `bavg`/`savg`/`bfrq`/`sfrq` tambahan di file Oktober tidak ada di file September.
2. **Bucket `brokers` vs `broker_levels`:** Ketika kedua array ada, `parseDailyBroksumLevels` memilih `brokers`. Namun jika `brokers` memiliki subset broker (74) sementara `broker_levels` memiliki superset (100), ada broker yang nilainya hilang dari perhitungan lokal.
3. **Data stale/cacat historis:** File September mungkin dihasilkan oleh versi pipeline lama dengan logika berbeda.

---

## 4. Kapan Fase 2 Bisa Diuji Ulang

### Perbaikan yang Harus Terjadi Sebelum Uji Ulang:
1. **Re-fetch file 2026-09-04 untuk BBCA** dengan `all_data=true`.
2. **Re-fetch file 2026-09-11 dan 2026-09-25 untuk semua saham** dengan `all_data=true` segar dari Arjum (bukan hasil load lama).
3. **Inspeksi skema file September vs Oktober** untuk memastikan field konsisten.

### Estimasi Tanggal:
- Backfill worker saat ini sedang memproses saham likuid (BBCA, BBRI, BMRI, dll.) mundur dari 16 Okt 2026.
- Karena tanggal 11 Sep dan 25 Sep ada dalam jangkauan backfill, **keduanya akan otomatis di-refresh** saat worker menembus tanggal tersebut.
- **Estimasi perbaikan otomatis:** **Rabu–Kamis, 21–22 Oktober 2026** (saat worker mencapai tanggal tersebut untuk saham likuid).
- **Uji ulang Fase 2 dapat dijalankan ulang:** **Kamis, 22 Oktober 2026**.

### Perintah Uji Ulang Siap Tempel:
```bash
# 1. Periksa coverage 80 hari terakhir untuk 10 saham uji
cd /home/ubuntu/auto-cuan
node tools/check-accum-parity.js

# 2. Jika match rate ≥ 99% untuk semua saham:
#    Salin dan set ACCUM_SOURCE=local di .env runner
cp /home/ubuntu/auto-cuan-runner/.env /home/ubuntu/auto-cuan-runner/.env.before-accum-local
sed -i 's/^ACCUM_SOURCE=.*/ACCUM_SOURCE=local/' /home/ubuntu/auto-cuan-runner/.env
sed -i 's/^ACCUM_SOURCE=.*/ACCUM_SOURCE=local/' /home/ubuntu/auto-cuan/.env

# 3. Restart web server (SEKALI)
pm2 restart autocuan-web --update-env

# 4. Verifikasi tampilan Bandarmologi BBCA dan BRPT (sebelum vs sesudah)
curl -s "http://127.0.0.1:3000/api/sector-hot?action=bandarmologi&ticker=BBCA" | head -c 200
curl -s "http://127.0.0.1:3000/api/sector-hot?action=bandarmologi&ticker=BRPT" | head -c 200

# 5. Jika ada masalah, kembalikan:
# cp /home/ubuntu/auto-cuan-runner/.env.before-accum-local /home/ubuntu/auto-cuan-runner/.env
# pm2 restart autocuan-web --update-env
```

---

## 5. Keputusan Saat Ini

| Aspek | Status |
|---|---|
| Set `ACCUM_SOURCE=local` | ❌ **TIDAK DILAKUKAN** |
| Konfigurasi saat ini | ✅ `ACCUM_SOURCE=api` (tetap seperti semula) |
| Commit di branch | ❌ Tidak ada perubahan |
| Restart PM2 | ❌ Tidak dilakukan |
| Kuota yang dihemat (potensial) | 834 request/hari (~4.170/minggu) — **belum berlaku** |

---

## 6. Batasan Sampel & Catatan Jujur

1. **3 tanggal bermasalah** dari 77-80 hari = **96-97% match rate**, tidak memenuhi syarat ≥99%.
2. **Tidak ada manipulasi data.** Semua angka diambil langsung dari pembacaan file disk saat ini tanpa inferensi.
3. **Tanggal 2026-09-04 untuk BBCA kosong** — ini adalah defek data nyata, bukan bug perhitungan.
4. **Tanggal 2026-09-11 dan 2026-09-25** memiliki nilai berbeda yang tidak dapat dijelaskan oleh clipping (file sudah unclipped 100 level). Ini memerlukan re-fetch.
5. **Setelah backfill selesai (22 Okt 2026), uji ulang wajib dijalankan** sebelum keputusan final.
