# EVALUASI PERUBAHAN CUTOFF 15:30 WIB DAN PERANCANGAN STRATEGI BSJP (BELI SORE JUAL PAGI)

**Dokumen Perencanaan Teknis & Analisis Risiko**
**Penyusun:** Tim Engineering Auto-Cuan
**Tanggal:** 11 Oktober 2026
**Status:** DRAFT EVALUASI — FASE B (Khusus Perencanaan; tanpa perubahan perilaku kode)
**Target Rilis:** Branch & PR Terpisah (setelah Safety Gate PR #862 stabil dan disetujui)

> **CATATAN SCOPE (koreksi final review PR #862):** Dokumen ini SECARA HISTORIS SUDAH
> TERMASUK dalam diff PR #862 (terbawa saat normalisasi line ending commit `40a388a0`).
> Dokumen murni perencanaan dan TIDAK mengubah perilaku kode apa pun di PR #862.
> Sesuai batas scope, implementasi BSJP TIDAK dilakukan di PR #862 dan disimpan untuk
> fase berikutnya pada branch terpisah (`feat/bsjp-strategy-cutoff-1530`).

> **PERINGATAN METODOLOGI:** Seluruh angka historis pada dokumen ini (persentase
> peningkatan volume, pola akumulasi, karakteristik risiko) adalah **HIPOTESIS
> perencanaan yang BELUM terbukti** — BUKAN hasil backtest. Belum ada sampel data,
> metodologi, dan hasil terukur yang memverifikasi angka-angka tersebut. Verifikasi
> eksplisit adalah prasyarat wajib sebelum fase implementasi dimulai.

---

## 1. LATAR BELAKANG & TUJUAN

Berdasarkan review arsitektur dan kebutuhan strategi perdagangan IDX, cutoff Radar Day Trade saat ini berada pada pukul **14:30 WIB** (`DAYTRADE_RADAR_CUTOFF_MINUTES = 870`). Alasan awal pemasangan cutoff 14:30 WIB adalah aturan `AFTERNOON_EXIT` konvensional: sisa waktu perdagangan intraday (14:31–15:50) dinilai terlalu singkat untuk menyelesaikan siklus swing intraday (entry, TP1, hingga exit sebelum closing).

Namun, pada dinamika pasar IDX riil:
1. Pukul **14:30 s/d 15:30 WIB** sering kali menjadi jendela akumulasi akhir sesi (*closing run / power hour*), di mana bandar/market maker mengakumulasi saham untuk persiapan gap-up pagi hari berikutnya.
2. Strategi **BSJP (Beli Sore Jual Pagi)** memerlukan penangkapan momentum pada rentang 14:30–15:30 WIB dengan kriteria yang berbeda dari Day Trade biasa (bukan untuk *intraday exit*, melainkan *overnight carry* dengan *morning pre-opening/opening exit*).
3. Pengguna membutuhkan sinyal yang jelas, terukur, dan terpisah secara tegas antara sinyal yang wajib ditutup hari itu juga (Day Trade murni) vs sinyal yang sengaja di-hold semalam (BSJP).

---

## 2. AUDIT INVENTARIS CUTOFF 14:30 WIB DI CODEBASE

Audit kode menunjukkan cutoff 14:30 WIB terdistribusi pada modul-modul berikut:

| File / Modul | Baris Kode | Penggunaan & Dampak |
|---|---|---|
| [`lib/market-hours-guard.js`](lib/market-hours-guard.js:116) | `DAYTRADE_RADAR_CUTOFF_MINUTES = 14 * 60 + 30` (870 menit) | Nilai dasar konstanta jam bursa Jakarta. |
| [`lib/market-hours-guard.js`](lib/market-hours-guard.js:289) | `base.radar_cutoff_passed` | Mengembalikan boolean bila jam saat ini > 14:30. |
| [`lib/market-hours-guard.js`](lib/market-hours-guard.js:384) | `isDayTradeRadarCutoffPassed()` & `evaluateDayTradeRadarWindow()` | Menolak radar pantauan jika waktu > 14:30 WIB (`reason: 'after_1430_wib_cutoff'`). |
| [`lib/intraday-fast-watcher-radar-publisher.js`](lib/intraday-fast-watcher-radar-publisher.js:146) | `isPastDayTradeRadarCutoff()` | Memeriksa apakah `item.time` melebihi cutoff 14:30. |
| [`lib/intraday-fast-watcher-radar-publisher.js`](lib/intraday-fast-watcher-radar-publisher.js:348) | `isRadarWindowAllowed()` | Memblokir publikasi radar jika sample date/time melebihi cutoff 14:30. |
| [`lib/intraday-fast-watcher-radar-publisher.js`](lib/intraday-fast-watcher-radar-publisher.js:413) | `publishRadar()` | Gerbang perlindungan waktu telegram radar: `!guard.allowed` menolak `after_1430_wib_cutoff`. |
| [`lib/daytrade-screener-engine.js`](lib/daytrade-screener-engine.js:245) | Dokumentasi & run-mode | Klasifikasi run-mode `AFTERNOON_EXIT`. |
| [`lib/intraday-collector-vps-audit.js`](lib/intraday-collector-vps-audit.js:46) | Daftar interval pengambilan snapshot | Jadwal cron audit: 14:30, 14:45, dst. |
| [`test/audit-fase3-market-hours-bugs.test.js`](test/audit-fase3-market-hours-bugs.test.js:299) | `assert.equal(guard.DAYTRADE_RADAR_CUTOFF_MINUTES, 870)` | Verifikasi nilai menit 870. |
| [`test/stage-2-daytrade-live-and-telegram-cleanup.test.js`](test/stage-2-daytrade-live-and-telegram-cleanup.test.js:207) | Tests A9, A10, A11, A12 | Pengujian unit cut-off 14:30 WIB dan pemblokiran radar 15:37 WIB. |
| [`test/batch1-market-hours-synchronization.test.js`](test/batch1-market-hours-synchronization.test.js:154) | Test B5 | Pengujian ketat `isDayTradeRadarCutoffPassed` pada 14:30 vs 14:31 WIB. |

---

## 3. HIPOTESIS PELUANG 14:31–15:30 WIB (BELUM DIVERIFIKASI — BUKAN BACKTEST)

> **STATUS BUKTI: HIPOTESIS.** Bagian ini sebelumnya diberi judul "Evaluasi Empiris".
> Tidak ada sampel data, metodologi, maupun hasil terukur yang disertakan; karena itu
> angka-angka di bawah adalah hipotesis perencanaan, bukan temuan terverifikasi.
> Implementasi BSJP tidak boleh dimulai sebelum hipotesis ini diuji dengan data nyata.

Hipotesis awal (perlu pengujian data sebelum dijadikan dasar keputusan):

1. **Karakteristik Volume (hipotesis):**
   - 14:30–15:00 WIB: Diduga volume perdagangan cenderung meningkat dibanding sesi siang (13:30–14:30) karena institusi menyelesaikan order execution (TWAP/VWAP). Besaran peningkatan **belum diukur**.
   - 15:00–15:30 WIB: Diduga akumulasi terjadi pada saham-saham breakout yang bertahan di atas resistance harian (*high of the day / HOD*). **Belum diukur**.
2. **Karakteristik Risiko (kualitatif):**
   - **Overnight Gap Risk:** Saham yang dibeli sore menghadapi risiko gap-down keesokan hari akibat sentimen bursa global atau berita emiten semalam. Besaran risiko **belum diukur**.
   - **Pre-Closing Auction Lock (15:50–16:00 WIB):** Likuiditas membeku pada order book blind-auction; trader tidak dapat langsung keluar dengan market order jika terjadi penurunan tiba-tiba.
   - **False Breakout Sore:** Sebagian saham dinaikkan untuk kebutuhan *marking the close* tanpa akumulasi riil bandar (*spoofing/pumping*) — indikasi anekdotal, belum diuji statistik.

---

## 4. DESAIN ARSITEKTUR PEMISAHAN: DAY TRADE VS BSJP

Pemisahan antara Day Trade murni dan BSJP wajib dilakukan secara struktural, bukan sekadar mengganti jam:

```
                          [ Evaluasi Waktu WIB ]
                                    |
            +-----------------------+-----------------------+
            |                                               |
     09:00 - 14:30 WIB                               14:31 - 15:30 WIB
            |                                               |
   [ Sinyal Day Trade ]                            [ Mode Pemilihan ]
            |                                               |
  * Tipe: Intraday Scalp / Breakout               +---------+---------+
  * Target Exit: Sesi 2 Hari Ini                  |                   |
  * Cutoff: 14:30 WIB                             |                   |
                                            [ Day Trade ]      [ Sinyal BSJP ]
                                                  |                   |
                                            * DITUTUP           * Label: BSJP
                                            * Alasan: Sisa sesi * Target Exit: 09:00-09:15 Besok
                                              terlalu pendek    * Kriteria Ekstra:
                                                                  1. Close near HOD (>= 90%)
                                                                  2. Volume Pace > 1.5x
                                                                  3. Akumulasi Bandar Konsisten
                                                                  4. R/R >= 1.5 ke TP1 Pagi
                                                                  5. IHSG / Market Not Crash
```

### Aturan Khusus BSJP:
1. **Label Spesifik:** Harus memiliki tag `STRATEGY_BSJP` atau `BELI SORE JUAL PAGI` yang eksplisit pada kartu Telegram, dashboard UI, dan API response.
2. **Kriteria Teknis:**
   - Posisi harga saat sinyal muncul wajib berada di 10% rentang teratas harian (`range_position >= 90%`).
   - Wajib ditopang oleh konfirmasi volume breakout (`volume_ratio >= 1.5` dan `intraday_volume_pace_ratio >= 1.3`).
   - Tidak ada distribusi bandar pada 1 hari dan 5 hari (`broker_summary !== 'DISTRIBUTION'`).
   - Bukan saham papan akselerasi atau saham ARB recovery tanpa struktur.
3. **Safety Gate & R/R Invariant:**
   - Wajib lolos `passesRiskRewardFilter(candidate, 1.5, { recalculate: true })`.
   - SL wajib ditempatkan di bawah support terdekat / low sesi 2 (maksimal risiko -3% s/d -4%).
   - TP1 pagi dihitung konservatif (+2.5% s/d +4.0%) dengan R/R aktual >= 1.5.

---

## 5. BATAS WAKTU & INVARIANT SISTEM YANG WAJIB DIPERTAHANKAN

Dalam implementasi cutoff 15:30 WIB dan BSJP nantinya, batas-batas berikut **TIDAK BOLEH DILONGGARKAN**:

1. **Batas Akhir Sinyal BSJP:** Tepat **15:30:00 WIB** (tidak ada sinyal baru setelah 15:30 WIB).
2. **Batas Akhir Broadcast Telegram:** Tepat **15:45:00 WIB** (`SESSION_2_END_MINUTES`). Tidak ada pesan apapun yang boleh dikirim ke channel setelah 15:45:00 WIB.
3. **Batas Akhir Sesi Reguler:** Tepat **15:49:59 WIB** (`FULL_SESSION_2_END_MINUTES` = 15:50).
4. **Pre-Closing Auction Protection:** 15:50:00 s/d 16:00:00 WIB mutlak `CLOSED` untuk broadcast maupun sinyal baru.

---

## 6. RENCANA IMPLEMENTASI TEKNIS & TEST PLAN (FASE B)

### Modul yang Akan Diubah pada Branch Terpisah:
1. `lib/market-hours-guard.js`:
   - Tambahkan konstanta `BSJP_RADAR_CUTOFF_MINUTES = 15 * 60 + 30` (930 menit).
   - Buat fungsi evaluasi spesifik: `evaluateBsjpWindow(dateInput)`.
   - Pertahankan `DAYTRADE_RADAR_CUTOFF_MINUTES = 14 * 60 + 30` untuk Day Trade konvensional.
2. `lib/bsjp-strategy-engine.js` (Modul Baru):
   - Engine evaluasi khusus BSJP dengan filter HOD, volume pace sore, dan bandarmologi.
3. `lib/intraday-fast-watcher-radar-publisher.js`:
   - Penambahan handler format pesan dan template Telegram kartu BSJP terpisah.
4. `test/bsjp-strategy-and-cutoff.test.js` (Test Suite Baru):
   - Pengujian batas jam: 14:30 (Day Trade tutup), 14:31–15:30 (BSJP aktif), 15:31+ (BSJP tutup).
   - Pengujian invariant: Broadcast tetap diblokir di 15:45:01, sesi selesai di 15:50.
   - Pengujian R/R: Semua kandidat BSJP wajib R/R >= 1.5.

---

## 7. KESIMPULAN & REKOMENDASI

1. Perubahan cutoff 15:30 WIB **sangat layak dan bernilai strategis tinggi** jika diwujudkan dalam bentuk strategi BSJP yang independen dan terisolasi dari Day Trade biasa.
2. **JANGAN campur perubahan ini ke PR #862.** PR #862 harus tetap fokus dan minimalis untuk menyelesaikan audit safety gate P0/P1.
3. Setelah PR #862 di-merge ke `feat/daytrade-screener-v1`, buat branch baru `feat/bsjp-strategy-cutoff-1530` untuk mengimplementasikan rancangan ini secara bertahap dengan regression testing lengkap.
