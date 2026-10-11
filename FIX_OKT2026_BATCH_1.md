# LAPORAN PERBAIKAN TAHAP 2 — BATCH 1: SAFETY GATE DAN JAM BURSA (REVISI REVIEW PR #862)

**Branch Perbaikan:** `fix/audit-okt2026-batch-1`
**Baseline Git:** `origin/feat/daytrade-screener-v1` (commit `554810fcd3090ee77085e020ffb1ebe09b6af691`)
**SHA Referensi (pre-koreksi final):** `e4362cd672cdb199feffb9fdd0d3090117dc2ef1`
**SHA Koreksi Final Review (kode + test):** `30130b7e` — commit ini memuat seluruh perubahan P0-1/P0-2 beserta 11 test closure baru. Commit dokumentasi setelah SHA tersebut hanya menyentuh berkas Markdown dan tidak mengubah kode/test.
**Target Pull Request:** `feat/daytrade-screener-v1`
**Pull Request URL:** https://github.com/budikuatno2-ship-it/auto-cuan/pull/862
**Tanggal:** Minggu, 11 Oktober 2026
**Status Batch:** REVISI REVIEW FINAL PR #862 SELESAI — SIAP REVIEW ULANG.

---

## 1. RINGKASAN TEMUAN YANG DIPERBAIKI (TERMASUK TEMUAN REVIEW)

Batch 1 difokuskan sepenuhnya pada **P0: Safety Gate dan Jam Bursa** untuk menjamin tidak ada sinyal yang tidak valid, tidak aman, salah waktu, atau memiliki rasio Risk/Reward (R/R) di bawah standar produk (minimal 1.5) yang lolos ke status siap eksekusi / broadcast channel Telegram.

### A. Risk/Reward (R/R) Gate & Review Findings
1. **Penyeragaman Minimum R/R 1.5 di Seluruh Jalur Eksekusi:** Menghilangkan disparitas threshold R/R 1.3 pada Day Trade (`api/sector-hot.js`) dan 1.2 pada `lib/idx-tick-normalization.js`, sehingga seluruh kategori sinyal siap eksekusi (Day Trade, Swing Konglo, Swing Non-Konglo, Top 5) seragam wajib memiliki R/R aktual ke TP1 minimal 1.5.
2. **P0 Recalculation R/R Fail-Closed & Level Priority:**
   - Pemanggilan `passesRiskRewardFilter` di `candidatePassesPublicTelegramSafetyGate` (`api/sector-hot.js`) dan `publishConfirmed` (`lib/intraday-fast-watcher-publisher.js`) kini mengaktifkan `{ recalculate: true }`.
   - Jika recalculation diwajibkan tetapi level tidak lengkap atau invalid, evaluasi wajib FAIL-CLOSED (`return false;`), tidak boleh fallback ke nilai `risk_reward` lama.
   - Prioritas ekstraksi level menempatkan root candidate di posisi teratas sehingga level final aktual tidak dapat dikalahkan oleh level lama pada objek nested (`candidate.levels`, `candidate.trade_plan_v2`, `candidate.metrics`, `candidate.observation`).
   - Teruji langsung pada regression test: `entry_high=1000, stop_loss=900, tp1=1120, risk_reward=1.8` ditolak karena R/R aktual 1.2 (< 1.5).
3. **P0 Presisi Float Asli Tanpa Pembulatan Dua Desimal Sebelum Gate:**
   - `recalculateRiskReward` di `lib/screener-config.js` mengembalikan nilai float murni tanpa `Math.round(rr * 100) / 100`. Pembulatan dua desimal hanya boleh digunakan untuk tampilan UI/notifikasi.
   - Teruji pada batas kritis: R/R 1.496 dan 1.499 gagal, sedangkan 1.500 dan 1.501 lolos.
4. **P0 Minimum R/R Floor FastWatcher:**
   - `metricsFrom()` pada `lib/intraday-fast-watcher-momentum.js` menggunakan `Math.max(1.5, ...)` sehingga `observation.minimum_risk_reward=1.0` atau `plan.minimum_rr_to_tp1=1.2` tidak dapat menurunkan ambang minimum 1.5 sinyal eksekusi (`READY_CONFIRMED` / `entry_eligible`).
   - Radar informasional (`SPIKE_RADAR`, pre-confirmation radar) tetap dipisahkan dari sinyal terkonfirmasi.
5. **Pemisahan Sinyal Terkonfirmasi vs Radar Pantauan:** Sinyal dengan R/R 1.0–1.49 tetap diizinkan di Radar Pantauan FastWatcher (`lib/intraday-fast-watcher-radar-publisher.js`) dengan label informasional eksplisit *"Pantauan, belum sinyal beli"*, tetapi dicegah naik menjadi sinyal siap eksekusi (`READY_CONFIRMED` / `entry_eligible`).
6. **FastWatcher Confirmed Publisher Gate:** Menambahkan pemeriksaan wajib `passesRiskRewardFilter(..., 1.5, { recalculate: true })` pada fungsi `publishConfirmed` (`lib/intraday-fast-watcher-publisher.js`) sebelum sinyal live dapat dikirim via Telegram atau disimpan ke database publik.

### B. Jam Bursa & Sinkronisasi Sesi
1. **Penyelarasan Sumber Waktu (Single Source of Truth):** Menyelaraskan kontrak waktu antara `lib/market-hours-guard.js`, `lib/intraday-volume-pace.js`, dan `lib/intraday-fast-watcher-live.js`.
2. **Pemisahan Jendela Observasi vs Gerbang Broadcast:**
   - **Sesi Reguler IDX (Observasi):**
     - Senin–Kamis: Sesi 1 (09:00–12:00 WIB), Istirahat (12:00–13:30 WIB), Sesi 2 (13:30–15:49:59 WIB).
     - Jumat: Sesi 1 (09:00–11:30 WIB), Istirahat (11:30–14:00 WIB), Sesi 2 (14:00–15:49:59 WIB).
     - Sabtu, Minggu, dan Libur Bursa (Seed 2026): Tutup (`CLOSED`, `OUTSIDE_MARKET`, `NON_TRADING_DAY`).
   - **Gerbang Broadcast Telegram (Buffer Pengaman):**
     - Sesi 1 Senin–Kamis berhenti tepat pada **11:58 WIB**.
     - Sesi 1 Jumat berhenti tepat pada **11:28 WIB**.
     - Sesi 2 berhenti tepat pada **15:45 WIB**.
     - Cutoff Radar Day Trade tetap pada **14:30 WIB**.
3. **Penghentian Loop FastWatcher Pasca-15:49:59:** Memperbaiki fungsi `runModeForTime` pada `lib/intraday-fast-watcher-live.js` agar tick 15:50–16:00 WIB menghasilkan `null` (tidak diklasifikasikan sebagai sesi reguler aktif `AFTERNOON_EXIT`).
4. **Integrasi Hari Libur Bursa pada Volume Pace:** Mengintegrasikan `isExchangeHoliday` pada `lib/intraday-volume-pace.js` sehingga hari libur di hari kerja tidak dihitung sebagai hari bursa aktif, dengan tetap mempertahankan denominator durasi penuh (330/270 menit) untuk konsistensi matematis proyeksi volume harian terhadap rata-rata 20D.
5. **Perlindungan Pemrosesan EOD:** Mempertahankan izin eksekusi EOD (`skip_market_guard: true` pada Swing EOD dan Top 5 EOD pukul 19:00 WIB).

---

## 2. BUG ID DARI AUDIT FINAL YANG DISELESAIKAN

| Bug ID | Modul | Kategori | Ringkasan Temuan Audit | Solusi Terverifikasi |
|---|---|---|---|---|
| **E4 / SAFE-1** | FastWatcher Radar | HIGH | FastWatcher radar mem-broadcast kandidat dengan R/R serendah 1.0. | Diproteksi dengan label informasional tegas "Pantauan, belum sinyal beli", dan dijamin tidak dapat naik menjadi `READY_CONFIRMED`. |
| **E4 / SAFE-2** | FastWatcher Momentum | HIGH | FastWatcher terkonfirmasi memakai default minimum R/R 1.0. | Default `minimum_risk_reward` diselaraskan ke 1.5; hanya kandidat R/R >= 1.5 yang dapat memperoleh `entry_eligible: true`. |
| **E4 / SAFE-3** | Safety Gate Telegram | MEDIUM | `candidatePassesPublicTelegramSafetyGate` tidak memverifikasi R/R secara langsung. | Ditambahkan verifikasi langsung `passesRiskRewardFilter(candidate, MIN_RR_RATIO, { recalculate: true })` di gerbang final Telegram. |
| **E4 / SAFE-5** | Day Trade Gate | HIGH | Day Trade `getMinRRForCategory` di `api/sector-hot.js` memakai threshold 1.3 (inkonsisten dengan 1.5). | `getMinRRForCategory` diubah untuk mengembalikan `MIN_RR_RATIO` (1.5) untuk seluruh kategori tanpa terkecuali. |
| **E4 / SAFE-6** | String Matcher | MEDIUM | Pencocokan string `indexOf('day')` rapuh terhadap kategori non-daytrade. | Dieliminasi; fungsi selalu mengembalikan nilai konstanta `MIN_RR_RATIO` (1.5). |
| **E5 / SAFE-8** | Jam Bursa | MEDIUM | Selisih 15.45 (broadcast gate) vs 15.49 (akhir sesi reguler bursa). | Dipisahkan dengan jelas antara batas broadcast (15:45) dan batas akhir sesi reguler (15:49:59). |
| **E5 / SAFE-9** | FastWatcher Loop | MEDIUM | FastWatcher loop berjalan hingga 16:00 WIB dan menulis observasi di luar sesi reguler. | `runModeForTime` dihentikan tepat pukul 15:49:59 (menit 950+ mengembalikan `null`). |
| **E5 / SAFE-10** | Sinkronisasi Waktu | LOW | Inkonsistensi sumber jam antara 15.45, 15.49, dan 16.00. | Sumber waktu disinkronkan ke `lib/market-hours-guard.js`. |
| **PF-7 (Addendum)**| FastWatcher Session | HIGH | FastWatcher tick 15:50 dan 15:55 Senin-Jumat memproses pasar seolah-olah aktif. | Disinkronkan melalui `volumePace.is_regular_session` dan `runModeForTime` sehingga tick 15:50+ mengembalikan `null`. |

---

## 3. AKAR MASALAH YANG TELAH DIVERIFIKASI

1. **Disparitas Nilai Threshold Historis:** Konstanta `MIN_RR_RATIO = 1.5` telah ada di `lib/screener-config.js`, namun modul `api/sector-hot.js` (baris 4149) masih mempertahankan fungsi legacy `getMinRRForCategory` yang mengembalikan 1.3 untuk Day Trade, serta `lib/idx-tick-normalization.js` yang mengembalikan 1.2 untuk Day Trade.
2. **Ketiadaan Recalculation Check di Gate Validasi:** `passesRiskRewardFilter` awalnya hanya mengekstrak nilai float dari properti `risk_reward`. Jika nilai tersebut basi (misal sebelum resistance cap memotong TP1), candidate yang R/R riilnya turun di bawah 1.5 tetap lolos.
3. **Default Nilai Minimum di FastWatcher Pool:** `lib/intraday-fast-watcher-momentum.js` dan `pool.js` menggunakan fallback default `1` untuk `minimum_risk_reward`, sehingga setup intraday dengan R/R 1.0–1.49 dapat memperoleh status `READY_CONFIRMED`.
4. **Batas Window Intraday 16:00 vs 15:49:59:** Script `lib/intraday-fast-watcher-live.js` mengizinkan `AFTERNOON_EXIT` sampai menit `16 * 60` (16:00 WIB), mencakup periode lelang penutupan (pre-closing 15:50–16:00 WIB) yang seharusnya bukan sesi perdagangan reguler aktif.

---

## 4. DAFTAR FILE BERUBAH BESERTA ALASAN

| File | Baris | Alasan Perubahan |
|---|---|---|
| `lib/screener-config.js` | +112, -36 | Menambahkan `extractCandidateLevels`, `recalculateRiskReward`, validasi level struktural fail-closed (SL >= entry, TP1 <= entry, SL <= 0), dan opsi recalculate R/R dari level final. |
| `api/sector-hot.js` | +8, -2 | Menyeragamkan `getMinRRForCategory` ke 1.5 untuk seluruh kategori; memasang guard `passesRiskRewardFilter(candidate, MIN_RR_RATIO, { recalculate: true })` di `candidatePassesPublicTelegramSafetyGate`. |
| `lib/idx-tick-normalization.js` | +3, -1 | Menyeragamkan threshold `minRR` pada `derivePlanQuality` ke 1.5 untuk seluruh kategori. |
| `lib/intraday-fast-watcher-momentum.js` | +3, -1 | Mengubah fallback `minimum_risk_reward` dari 1 menjadi 1.5 untuk sinyal terkonfirmasi. |
| `lib/intraday-fast-watcher-pool.js` | +4, -2 | Menyelaraskan default `locked_minimum_risk_reward` dari 1 menjadi 1.5. |
| `lib/intraday-fast-watcher-publisher.js` | +29, -2 | Menambahkan filter keselamatan R/R >= 1.5 di `publishConfirmed`; menambahkan pengecekan `isMarketOpen` sebelum publish; menyelaraskan `getMarketSession` ke `marketHoursGuard`. |
| `lib/intraday-fast-watcher-radar-publisher.js` | +18, -2 | Menyelaraskan pengecekan jendela radar ke `marketHoursGuard.getMarketSessionStatus` dengan parameter `sampleDate`. |
| `lib/intraday-volume-pace.js` | +14, -0 | Mengintegrasikan `isExchangeHoliday` pada `tradingSchedule`; menambahkan `isRegularTradingTime` dan flag `is_regular_session` pada `sessionProgress`. |
| `lib/intraday-fast-watcher-live.js` | +9, -2 | Membatasi sesi reguler aktif `runModeForTime` agar berhenti sebelum 15:50 WIB (15:49:59) ketika `sampleDate` diberikan. |
| `lib/market-hours-guard.js` | +2, -0 | Mengekspor konstanta `FULL_SESSION_2_END_MINUTES = 15 * 60 + 50`. |
| `test/batch1-risk-reward-safety-gates.test.js` | Baru (+226) | Suite regression test lengkap membuktikan R/R < 1.5 tidak dapat lolos di seluruh jalur. |
| `test/batch1-market-hours-synchronization.test.js` | Baru (+197) | Suite regression test lengkap untuk batas sesi, buffer broadcast, libur, dan cutoff FastWatcher. |
| `test/batch1-pre-pr-verification.test.js` | Baru (+253) | Suite pengujian verifikasi mendalam untuk celah A, B, dan C pada payload nyata produksi. |

---

## 5. HASIL TEST SEBELUM DAN SESUDAH

### Sebelum Perbaikan (Baseline Commit `554810fc`)
- `test/batch1-risk-reward-safety-gates.test.js`:
  - **5 FAIL, 3 PASS**
- `test/batch1-market-hours-synchronization.test.js`:
  - **3 FAIL, 3 PASS**

### Sesudah Perbaikan Review PR #862
- `test/batch1-risk-reward-safety-gates.test.js`:
  - **10 PASS, 0 FAIL** (100% lulus, termasuk uji 1.496, 1.499, 1.500, 1.501, dan recalculate fail-closed)
- `test/batch1-market-hours-synchronization.test.js`:
  - **6 PASS, 0 FAIL** (100% lulus, mencakup batas 15:45, 15:46, 15:49:59, 15:50 Senin–Kamis dan Jumat)
- `test/batch1-pre-pr-verification.test.js`:
  - **8 PASS, 0 FAIL** (100% lulus)
- `test/potential-radar-gate.test.js`:
  - **42 PASS, 0 FAIL** (100% lulus)
- `test/telegram-public-safety.test.js`:
  - **66 PASS, 0 FAIL** (100% lulus)
- `test/tp1-observed-high-publication-guard.test.js`:
  - **10 PASS, 0 FAIL** (100% lulus)
- `test/stage-2-daytrade-live-and-telegram-cleanup.test.js`:
  - **26 PASS, 0 FAIL** (100% lulus)
- `test/ui-redesign-a11y.test.js`:
  - **28 PASS, 0 FAIL** (100% lulus)
- **Syntax Check Seluruh Repository (`npm run validate:syntax`):**
  - 1,179 file `.js` ter-parse bersih, 649 entri curated test terdaftar, 0 missing.
- **Smoke / Contract Build Suite (`npm run test:smoke`):**
  - 75 test files: 273 tests: **273 PASS, 0 FAIL**.

---

## 6. KOREKSI FINAL REVIEW PR #862 (P0-1 DAN P0-2)

### P0-1: FastWatcher Status Internal Konsisten dengan Entry Eligibility
- **Masalah terkonfirmasi (reproduksi empiris):** `entry_eligible` sudah memakai minimum R/R 1.5, tetapi `passes` tetap `true` dan `status` tetap `READY_PASS` saat R/R di bawah minimum eksekusi. Pool membangun confirmation window dari `result.passes`, sehingga payload dengan R/R 1.2 + `minimum_risk_reward=1.0` mencapai `READY_CONFIRMED` dan `publishable` pada menit konfirmasi ke-3. Selain itu R/R hasil hitung ulang dibulatkan `round2` sehingga 1.496 tampak 1.5 dan lolos gate.
- **Perbaikan:**
  - `lib/intraday-fast-watcher-momentum.js` — `passes`, `entry_eligible`, dan `status` kini fail-closed dan konsisten: R/R aktual di bawah `execution_minimum_risk_reward` (floor 1.5) tidak pernah menghasilkan `READY_PASS`; setup tetap boleh menjadi radar informasional `WATCHING` dengan reason `risk_reward_below_execution_minimum`.
  - `lib/intraday-fast-watcher-momentum.js` — R/R aktual DIHITUNG ULANG dari level final (bukan metadata basi) dan TIDAK dibulatkan sebelum gate (`reported_risk_reward` disimpan terpisah untuk observabilitas).
  - `lib/intraday-fast-watcher-pool.js` — `canonicalSetupMetrics` tidak lagi membulatkan R/R sebelum penguncian; ditambah verifikasi pertahanan-berlapis sebelum confirmation window sehingga R/R < 1.5 tidak pernah masuk `READY_PENDING`/`READY_CONFIRMED`/`publishable`.
- **Bukti:** `test/batch1-fastwatcher-rr-status-closure.test.js` (11 test) — pool.process() lintas menit berbeda; R/R 1.2 & 1.496 & metadata basi tidak pernah `READY_CONFIRMED`; R/R 1.6 tetap terkonfirmasi normal (tanpa over-blocking).

### P0-2: Ekstraksi Level Final Wajib Fail-Closed
- **Masalah terkonfirmasi (reproduksi empiris):**
  1. `entry_high=NaN, entry_low=950, sl=900, tp1=1100` → level eksplisit invalid lolos lewat fallback ke `entry_low` (R/R palsu 3.0).
  2. Root `entry_low=950, sl=900, tp1=1100` + `candidate.levels.entry_high=1000` → entry konservatif 950 dipilih (R/R palsu 3.0) alih-alih batas atas 1000 (R/R 1.0).
  3. Level dari setup/snapshot berbeda (entry+SL root, TP1 nested) digabung menjadi R/R valid palsu 6.0.
- **Perbaikan (`lib/screener-config.js` — `extractCandidateLevels`):**
  - Nilai eksplisit invalid (NaN/Infinity/negatif) pada level apa pun ⇒ fail-closed; tidak boleh diselamatkan fallback.
  - Entry = batas ATAS paling konservatif dari seluruh sumber (batas atas kapan pun mengalahkan lower bound).
  - SL & TP1 wajib berasal dari SATU sumber yang sama; gabungan lintas sumber ⇒ fail-closed.
  - Level yang diisi tapi tidak lengkap ⇒ `passesRiskRewardFilter` fail-closed dan tidak boleh fallback ke metadata `risk_reward` lama (berlaku juga pada jalur non-recalculate).
  - Alias legacy valid (`entry1`/`entry2`/`sl`/`tp1n`/`entry_high` dalam satu sumber) tetap didukung.
- **Bukti:** `test/batch1-fastwatcher-rr-status-closure.test.js` P0-2a s/d P0-2e; seluruh suite safety gate lama tetap lulus.

### P0-2 Lanjutan (Review Akhir): Provenance Root vs Nested — Root Final Tidak Boleh Tertimpa
- **Masalah terkonfirmasi (reproduksi empiris, sebelum perbaikan):**
  1. Root `entry_high=1000, stop_loss=1100` (eksplisit invalid) + nested `levels:{entry_high:1000, stop_loss:900, tp1:1200}` → pasangan nested menyelamatkan root ⇒ R/R palsu 2.0 lolos, termasuk `candidatePassesPublicTelegramSafetyGate` mengembalikan `true`.
  2. Root `entry_high=1000, tp1=900` (eksplisit invalid) + nested `levels:{stop_loss:900, tp1:1200}` → R/R palsu 2.0 lolos.
  3. Root hanya `entry_high=1000` + nested `levels:{stop_loss:900, tp1:1600}` → R/R palsu 6.0 lolos (provenance tidak dapat dibuktikan).
- **Perbaikan (`extractCandidateLevels`):**
  - Pasangan SL/TP1 wajib LENGKAP di sumber pertama yang memuat salah satunya; pasangan parsial tidak boleh dilengkapi dari sumber lain ⇒ fail-closed.
  - Provenance same-setup ditegakkan: pasangan harus berasal dari sumber level pertama (sumber batas entry final), atau dari sumber fallback entry bila entry memakai referensi harga; entry root + pasangan nested (atau sebaliknya) ⇒ fail-closed.
  - Validasi struktural terhadap entry final (SL < entry dan TP1 > entry) tanpa substitusi dari sumber lain ⇒ fail-closed bila invalid.
  - Root final tetap berprioritas tertinggi: nilai nested lama tidak dapat menimpa atau menyelamatkan level root yang invalid.
- **Bukti (sesudah perbaikan):** skenario 1–3 `recalculateRiskReward=null` + `passesRiskRewardFilter=false` (default & recalculate) + gate publik `false`; payload sah (nested-only valid, alias legacy, setup lengkap R/R ≥ 1.5, nested `observation.metrics`) tetap lolos. Regression: `test/batch1-fastwatcher-rr-status-closure.test.js` P0-2f s/d P0-2j (16/16 PASS).

### Catatan Scope Dokumentasi BSJP
- Dokumen `docs/EVALUASI_CUTOFF_1530_DAN_STRATEGI_BSJP.md` SECARA HISTORIS SUDAH TERMASUK dalam diff PR #862 (terbawa oleh commit `40a388a0` saat normalisasi line ending). Dokumen tersebut murni perencanaan dan TIDAK mengubah perilaku kode apa pun di PR ini.
- Sesuai batas scope: implementasi BSJP TIDAK dilakukan di PR #862. Isi dokumen tetap disimpan untuk fase berikutnya pada branch terpisah (`feat/bsjp-strategy-cutoff-1530`) setelah PR #862 stabil.
- Angka historis pada dokumen BSJP (peningkatan volume 20–35%, akumulasi 15:00–15:30, dll.) adalah HIPOTESIS perencanaan yang BELUM terbukti — bukan hasil backtest. Dokumen telah ditandai demikian; verifikasi dengan sampel data, metodologi, dan hasil terukur adalah prasyarat fase implementasi.

---

## 7. STATUS PULL REQUEST

- **Branch:** `fix/audit-okt2026-batch-1`
- **Target Integrasi:** `feat/daytrade-screener-v1`
- **Branch `main`:** Bersih dan TIDAK DISENTUH.
- **SHA Referensi:** `e4362cd672cdb199feffb9fdd0d3090117dc2ef1` (sebelum koreksi final review).
- **SHA Koreksi Final Review (P0-1 + P0-2 + provenance lanjutan):** HEAD branch setelah push koreksi provenance terakhir; lihat `git log` untuk nilai pasti.
- **Pull Request URL:** https://github.com/budikuatno2-ship-it/auto-cuan/pull/862
- **Status:** SIAP DIREVIEW — BELUM DI-MERGE (Menunggu persetujuan pengguna).

---

## 8. TINDAKAN PRODUKSI YANG MASIH MEMBUTUHKAN PERSETUJUAN

1. Persetujuan untuk me-merge Pull Request #862 ke branch `feat/daytrade-screener-v1`.
2. Persetujuan untuk memulai **BATCH 2 (P1: Financial Data Pipeline)**.
3. Persetujuan fase implementasi BSJP (branch terpisah) setelah PR #862 stabil.
