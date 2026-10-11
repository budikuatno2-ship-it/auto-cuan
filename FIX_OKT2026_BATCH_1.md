# LAPORAN PERBAIKAN TAHAP 2 — BATCH 1: SAFETY GATE DAN JAM BURSA

**Branch Perbaikan:** `fix/audit-okt2026-batch-1`  
**Baseline Git:** `origin/feat/daytrade-screener-v1` (commit `554810fcd3090ee77085e020ffb1ebe09b6af691`)  
**Target Pull Request:** `feat/daytrade-screener-v1`  
**Tanggal:** Minggu, 11 Oktober 2026  
**Status Batch:** SELESAI (Lokal). Menunggu persetujuan eksplisit pengguna sebelum push, pembuatan PR, atau merge.

---

## 1. RINGKASAN TEMUAN YANG DIPERBAIKI

Batch 1 difokuskan sepenuhnya pada **P0: Safety Gate dan Jam Bursa** untuk menjamin tidak ada sinyal yang tidak valid, tidak aman, salah waktu, atau memiliki rasio Risk/Reward (R/R) di bawah standar produk (minimal 1.5) yang lolos ke status siap eksekusi / broadcast channel Telegram.

### A. Risk/Reward (R/R) Gate
1. **Penyeragaman Minimum R/R 1.5 di Seluruh Jalur Eksekusi:** Menghilangkan disparitas threshold R/R 1.3 pada Day Trade (`api/sector-hot.js`) dan 1.2 pada `lib/idx-tick-normalization.js`, sehingga seluruh kategori sinyal siap eksekusi (Day Trade, Swing Konglo, Swing Non-Konglo, Top 5) seragam wajib memiliki R/R aktual ke TP1 minimal 1.5.
2. **Pencegahan Stale R/R & Recalculation Integrity:** `passesRiskRewardFilter` di `lib/screener-config.js` kini menghitung ulang R/R aktual dari level final (`entry_high`, `stop_loss`, `tp1`) dan fail-closed jika data level tidak valid (`stop_loss >= entry_high`, `tp1 <= entry_high`, `sl <= 0`, non-finite, NaN, Infinity).
3. **Pemisahan Sinyal Terkonfirmasi vs Radar Pantauan:** Sinyal dengan R/R 1.0–1.49 tetap diizinkan di Radar Pantauan FastWatcher (`lib/intraday-fast-watcher-radar-publisher.js`) dengan label informasional eksplisit *"Pantauan, belum sinyal beli"*, tetapi dicegah naik menjadi sinyal siap eksekusi (`READY_CONFIRMED` / `entry_eligible`).
4. **FastWatcher Confirmed Publisher Gate:** Menambahkan pemeriksaan wajib `passesRiskRewardFilter(..., 1.5)` pada fungsi `publishConfirmed` (`lib/intraday-fast-watcher-publisher.js`) sebelum sinyal live dapat dikirim via Telegram atau disimpan ke database publik.
5. **Trade Plan Legacy Fallback Gate:** Memastikan trade plan fallback tidak dapat melewati gerbang keselamatan `candidatePassesPublicTelegramSafetyGate`.

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
4. **Integrasi Hari Libur Bursa pada Volume Pace:** Mengintegrasikan `isExchangeHoliday` pada `lib/intraday-volume-pace.js` sehingga hari libur di hari kerja tidak dihitung sebagai hari bursa aktif.
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
| `lib/screener-config.js` | +43, -2 | Menambahkan `recalculateRiskReward`, validasi level struktural fail-closed (SL >= entry, TP1 <= entry, SL <= 0), dan opsi recalculate R/R dari level final. |
| `api/sector-hot.js` | +5, -2 | Menyeragamkan `getMinRRForCategory` ke 1.5 untuk seluruh kategori; memasang guard `passesRiskRewardFilter(candidate, MIN_RR_RATIO, { recalculate: true })` di `candidatePassesPublicTelegramSafetyGate`. |
| `lib/idx-tick-normalization.js` | +2, -1 | Menyeragamkan threshold `minRR` pada `derivePlanQuality` ke 1.5 untuk seluruh kategori. |
| `lib/intraday-fast-watcher-momentum.js` | +2, -1 | Mengubah fallback `minimum_risk_reward` dari 1 menjadi 1.5 untuk sinyal terkonfirmasi. |
| `lib/intraday-fast-watcher-pool.js` | +2, -2 | Menyelaraskan default `locked_minimum_risk_reward` dari 1 menjadi 1.5. |
| `lib/intraday-fast-watcher-publisher.js` | +27, -2 | Menambahkan filter keselamatan R/R >= 1.5 di `publishConfirmed`; menambahkan pengecekan `isMarketOpen` sebelum publish; menyelaraskan `getMarketSession` ke `marketHoursGuard`. |
| `lib/intraday-fast-watcher-radar-publisher.js` | +16, -2 | Menyelaraskan pengecekan jendela radar ke `marketHoursGuard.getMarketSessionStatus` dengan parameter `sampleDate`. |
| `lib/intraday-volume-pace.js` | +14, -0 | Mengintegrasikan `isExchangeHoliday` pada `tradingSchedule`; menambahkan `isRegularTradingTime` dan flag `is_regular_session` pada `sessionProgress`. |
| `lib/intraday-fast-watcher-live.js` | +8, -2 | Membatasi sesi reguler aktif `runModeForTime` agar berhenti sebelum 15:50 WIB (15:49:59) ketika `sampleDate` diberikan. |
| `lib/market-hours-guard.js` | +2, -0 | Mengekspor konstanta `FULL_SESSION_2_END_MINUTES = 15 * 60 + 50`. |
| `test/batch1-risk-reward-safety-gates.test.js` | Baru (+195) | Suite regression test lengkap membuktikan R/R < 1.5 tidak dapat lolos di seluruh jalur. |
| `test/batch1-market-hours-synchronization.test.js` | Baru (+176) | Suite regression test lengkap untuk batas sesi, buffer broadcast, libur, dan cutoff FastWatcher. |

---

## 5. HASIL TEST SEBELUM DAN SESUDAH

### Sebelum Perbaikan (Baseline Commit `554810fc`)
- `test/batch1-risk-reward-safety-gates.test.js`:
  - **5 FAIL, 3 PASS**
  - Bukti kegagalan:
    1. Stale R/R 1.8 lolos padahal level aktual R/R 1.2 (`AssertionError: true !== false`).
    2. `sectorHot.getMinRRForCategory('daytrade')` mengembalikan `1.3`, bukan `1.5`.
    3. `derivePlanQuality` memberi status `'OK'` untuk Day Trade R/R 1.3 alih-alih `'POOR_RR'`.
    4. `candidatePassesPublicTelegramSafetyGate` meloloskan sinyal Day Trade R/R 1.3 ke Telegram.
    5. `momentum.metricsFrom` memberi `minimum_risk_reward: 1` alih-alih `1.5`.
- `test/batch1-market-hours-synchronization.test.js`:
  - **3 FAIL, 3 PASS**
  - Bukti kegagalan:
    1. Pada 15:49 WIB, `getMarketSessionStatus` mengembalikan `CLOSED` (seharusnya sesi reguler masih buka sampai 15:49:59).
    2. `FastWatcher.runModeForTime('15:50', '2026-10-12')` mengembalikan `'AFTERNOON_EXIT'` alih-alih `null`.
    3. `volumePace` tidak menandai hari libur bursa sebagai `NON_TRADING_DAY`.

### Sesudah Perbaikan (Branch `fix/audit-okt2026-batch-1`)
- `test/batch1-risk-reward-safety-gates.test.js`:
  - **8 PASS, 0 FAIL** (100% lulus)
- `test/batch1-market-hours-synchronization.test.js`:
  - **6 PASS, 0 FAIL** (100% lulus)
- **Suite Regresi Lengkap Modul Terkait (21 file uji):**
  - `test/market-hours-guard.test.js` (PASS)
  - `test/fast-watcher-session-boundary-regression.test.js` (PASS)
  - `test/intraday-fast-watcher-v7-volume-pace.test.js` (PASS)
  - `test/broadcast-market-guard.test.js` (PASS)
  - `test/swing-eod-market-guard.test.js` (PASS)
  - `test/risk-reward-filter.test.js` (PASS)
  - `test/daytrade-screener-status-rr.test.js` (PASS)
  - `test/swing-screener-rr-gate.test.js` (PASS)
  - `test/fast-watcher-telegram-radar.test.js` (PASS)
  - `test/trade-plan-v2.test.js` (PASS)
  - `test/trade-plan-v2-integration.test.js` (PASS)
  - `test/fast-watcher-momentum-flow.test.js` (PASS)
  - `test/fast-watcher-monitor-registration.test.js` (PASS)
  - `test/fast-watcher-opening-velocity-guard.test.js` (PASS)
  - `test/fast-watcher-early-watch.test.js` (PASS)
  - `test/fast-watcher-guarded-live-v2.test.js` (PASS)
  - `test/fast-watcher-locked-setup-regression.test.js` (PASS)
  - `test/stage-2-daytrade-live-and-telegram-cleanup.test.js` (PASS)
  - `test/intraday-fast-watcher.test.js` (PASS)
  - **Total 292 tests: 292 PASS, 0 FAIL**
- **Syntax Check Seluruh Repository (`npm run validate:syntax`):**
  - 1,178 file `.js` ter-parse bersih (Zero syntax errors).
- **Smoke / Contract Build Suite (`npm run test:smoke`):**
  - 75 test files: 272 tests: **272 PASS, 0 FAIL**.

---

## 6. BUKTI KODE DAN OUTPUT TEST

### Output Test Terverifikasi
```
✔ BATCH 1 - B1: Regular session boundaries (Mon-Thu vs Friday) (5.5653ms)
✔ BATCH 1 - B2: Weekend and Exchange Holiday handling (fail-closed) (0.5405ms)
✔ BATCH 1 - B3: volumePace regular tradingSchedule, sessionProgress, and holiday handling (1.4712ms)
✔ BATCH 1 - B4: FastWatcher runModeForTime terminates after 15:49:59 (returns null) (0.8491ms)
✔ BATCH 1 - B5: Day Trade Radar cutoff strictly enforced at 14:30 WIB (0.5403ms)
✔ BATCH 1 - B6: FastWatcher publishConfirmed blocks broadcast when market is closed for broadcast (1.4651ms)
✔ BATCH 1 - A1: passesRiskRewardFilter recalculates R/R from final levels after resistance cap/tick (3.4397ms)
✔ BATCH 1 - A2: passesRiskRewardFilter fails closed on invalid, zero, or non-finite levels (0.7905ms)
✔ BATCH 1 - A3: sector-hot getMinRRForCategory enforces 1.5 across ALL categories (1.0081ms)
✔ BATCH 1 - A4: idx-tick-normalization derivePlanQuality flags R/R < 1.5 as POOR_RR for Day Trade (4.037ms)
✔ BATCH 1 - A5: candidatePassesPublicTelegramSafetyGate strictly rejects R/R < 1.5 (5.1831ms)
✔ BATCH 1 - A6: FastWatcher momentum & pool enforce minimum R/R >= 1.5 for READY_CONFIRMED (5.1678ms)
✔ BATCH 1 - A7: FastWatcher publisher publishConfirmed blocks candidate with R/R < 1.5 (5.1018ms)
✔ BATCH 1 - A8: Trade Plan V2 isPlanV2Usable rejects plans with rr_to_tp1 < 1.5 for public/executable use (0.6276ms)
...
ℹ tests 292
ℹ suites 0
ℹ pass 292
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1355.0737
```

---

## 7. RISIKO REGRESI DAN MITIGASI

1. **Volume Sinyal Eksekusi Menurun:** Dengan menaikkan threshold Day Trade dari 1.3 ke 1.5, setup dengan R/R marjinal (1.3–1.49) tidak lagi diterbitkan sebagai sinyal terkonfirmasi.  
   *Mitigasi:* Sinyal-sinyal tersebut tetap dapat dipantau di Radar Pantauan / Watchlist, sehingga pengguna tetap memiliki visibilitas tanpa terbebani risiko posisi asimetris yang buruk.
2. **Backward Compatibility Pemanggilan Fungsi:**  
   *Mitigasi:* `passesRiskRewardFilter` tetap menerima parameter `minRatio` custom jika pemanggil memerlukan threshold khusus, dengan default aman 1.5. `runModeForTime(time)` mempertahankan kompatibilitas pemanggilan argumen tunggal tanpa `sampleDate`.
3. **Penghentian Pemrosesan EOD:**  
   *Mitigasi:* Jalur pemrosesan malam hari (EOD 19:00 WIB) mempertahankan flag `skip_market_guard: true` dan diuji secara independen melalui `test/swing-eod-market-guard.test.js`.

---

## 8. STATUS KESIAPAN PULL REQUEST

- **Branch Saat Ini:** `fix/audit-okt2026-batch-1`
- **Target Integrasi:** `feat/daytrade-screener-v1`
- **Branch `main`:** Bersih dan TIDAK DISENTUH.
- **Git Push Remote:** BELUM DILAKUKAN (Menunggu persetujuan pengguna).
- **PR Creation:** BELUM DILAKUKAN (Menunggu persetujuan pengguna).

---

## 9. TINDAKAN PRODUKSI YANG MASIH MEMBUTUHKAN PERSETUJUAN

1. Persetujuan untuk git commit pada branch `fix/audit-okt2026-batch-1`.
2. Persetujuan untuk `git push origin fix/audit-okt2026-batch-1`.
3. Persetujuan untuk pembukaan Pull Request ke `feat/daytrade-screener-v1`.
4. Persetujuan untuk melanjutkan ke **BATCH 2 (P1: Financial Data Pipeline)**.
