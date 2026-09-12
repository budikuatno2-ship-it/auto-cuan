# LAPORAN AUDIT FORENSIK KLASTER 2: DAY TRADE SCREENER V7 & INTRADAY FAST WATCHER
**Target Branch:** `feat/daytrade-screener-v1` (STRICTLY LOCAL)
**Status Audit:** SELESAI (100% PASS, 0 REGRESI)
**Lead Algorithmic Auditor & Systems Performance Engineer**
**Tanggal:** 12 September 2026

---

## 1. RINGKASAN EKSEKUTIF & STATUS PULL REQUEST

Audit forensik Klaster 2 berfokus pada verifikasi matematis, integritas alur algoritma (*control flow*), dan performa engine trading intraday terhadap rangkaian PR:
- **PR #518 (`03b1886`)**: Urutan Evaluasi Early Radar vs Prespike Watch.
- **PR #521 (`992b4cd`)**: Candle Pattern Trend-Aware Detection (Hammer vs Hanging Man).
- **PR #522 (`1193e71`)**: Unknown 20D Volume Ratio Sentinel Null & Preserve Range Position 0.
- **PR #611 (`ba6041e`)**: Friday Market Break Window (11:30 - 14:00 WIB) & Lifecycle Timer Guard.
- **PR #612 (`c91f5b1`)**: Opening Velocity Guard (09:16 - 09:30 WIB) & Volume Pace Zero-Division Immunity.
- **PR #613 (`20a1a2a`)**: Dynamic Break-Even +2% Lock, Scoring Meritocracy, dan Sector Diversification.

### Temuan Utama & Critical Bug Discovery:
1. **Temuan Kritis (Latent Fatal Crash):**
   Pada `lib/daytrade-screener-engine.js` baris 902 dan 906, ditemukan pemanggilan `data.volume_ratio_20d.toFixed(2)` tanpa proteksi `null`. Ketika PR #522 memperkenalkan sentinel `volume_ratio_20d: null` untuk emiten berdata historis < 20 candle, evaluasi emiten berskor 70–74 langsung melempar exception:
   `TypeError: Cannot read properties of null (reading 'toFixed')`.
   **Solusi:** Telah dipasang safe-guard format string `var volStr = (data.volume_ratio_20d != null && Number.isFinite(data.volume_ratio_20d)) ? data.volume_ratio_20d.toFixed(2) + 'x' : 'N/A';`.
2. **Kepatuhan Alur Logika (Control Flow Integrity):** Seluruh 5 fokus inspeksi telah terbukti kokoh dan lulus verifikasi 100%.
3. **Hasil Uji Mandiri & Smoke Test:**
   - Test suite mandiri `test/daytrade-v7-engine-integrity.test.js`: **20/20 PASS (100%)**.
   - Stress test `tools/stress-test-intraday-replay.js`: **1.000 kandidat, Throughput 8.718 ops/sec, Latensi 0,11ms, Error 0,00%, Heap Delta +0,42MB (Zero Leak)**.
   - Smoke test `npm run test:smoke`: **67 file uji, 77 test suites, 100% PASS**.

---

## 2. AUDIT FORENSIK MENDALAM PER FOKUS INSPEKSI

### Fokus 1: Urutan Evaluasi Early Radar vs Prespike (PR #518)
*File Terkait: `lib/daytrade-screener-engine.js` (fungsi `classifyStatus`)*

#### Analisis Alur Logika (Branching Hierarchy):
- **Masalah Sebelum PR #518:** Cabang `EARLY_RADAR` (threshold skor >= 62) ditaruh mendahului cabang `PRE_SPIKE_WATCH` (threshold skor >= 70). Akibatnya, saham matang dengan skor 70–74 dan volume terkonfirmasi (>= 1.2x) yang berada dekat area breakout (jarak <= 5%) terdegradasi secara prematur menjadi `EARLY_RADAR`.
- **Perbaikan PR #518:** Urutan dievaluasi ulang dengan memprioritaskan sinyal kualifikasi tinggi:
  1. `A_PLUS_SETUP` (skor >= 88, konfirmasi ketat)
  2. `TRADE_CANDIDATE` (skor >= 78, vol >= 1.2x)
  3. `READY_BREAKOUT` (skor >= 75)
  4. `PRE_SPIKE_WATCH` (skor >= 70, vol >= 1.2x, harga > open, jarak <= 3-4%)
  5. `EARLY_RADAR` (skor >= 70 namun vol < 1.2x DAN jarak <= 4%, ATAU skor 62–69 dengan tanda awal)
  6. `SPECULATIVE` (skor >= 70 namun vol < 1.2x DAN jarak > 4%)
  7. `WAIT_PULLBACK` (skor >= 60 namun terhalang Gap/Overheat/RR buruk)

#### Pertahanan Terhadap Anomali Bid-Offer Tipis:
- Jika lonjakan harga terjadi akibat bid-offer tipis (misal naik > 5% dengan 1 lot tanpa volume memadai `volume_ratio_20d < 1.5`), guard `data.change_pct > 5.0 && data.volume_ratio_20d < 1.5` langsung memasukkan `'Gap tinggi tanpa vol kuat'` ke dalam array `hardFails`.
- Saham ini **DIKUNCI KELUAR** dari `PRE_SPIKE_WATCH`, `READY_BREAKOUT`, dan `EARLY_RADAR`, lalu dialihkan ke status `WAIT_PULLBACK` dengan label `'Wait - Gap/Overheat'` dan catatan `'Hindari chase, tunggu pullback/konfirmasi lanjutan'`.
- Tidak ada ticker tipis yang lolos menjadi sinyal matang.

---

### Fokus 2: Opening Velocity Guard & Pace Volume (PR #612)
*File Terkait: `lib/intraday-fast-watcher-momentum.js`, `lib/intraday-volume-pace.js`*

#### 1. Pembagian Waktu Pembukaan Pasar:
- **09:00 - 09:15 WIB (Whipsaw Pembukaan Guard):**
  Publikasi alert Telegram diblokir total oleh `isSignalPublicationTimeRestrictedWib` (`api/sector-hot.js`) dengan alasan `whipsaw_pembukaan_blocked`. Ini mencegah false breakout dari anomali pembukaan bursa.
- **09:16 - 09:30 WIB (Opening Range Velocity Window):**
  Fungsi `isOpeningRangeVelocityWindow(time)` aktif pada rentang menit ke-556 (09:16) hingga 570 (09:30).
  Fungsi `evaluateOpeningVelocityGuard` menghitung lonjakan turnover riil 5 menit terakhir (`delta_turnover_5m`):
  - **Papan Utama & Pengembangan:** Wajib memiliki `delta_turnover_5m >= Rp 250.000.000` (Rp 250 Juta).
  - **Papan Akselerasi:** Wajib memiliki `delta_turnover_5m >= Rp 100.000.000` (Rp 100 Juta).
  - Jika transaksi riil di bawah ambang batas (misal hanya Rp 50 Juta), evaluasi mengembalikan `passes: false, reason: 'opening_range_velocity_insufficient'`.
  - Pada `applyOpeningVelocityGuard`, status kandidat langsung diturunkan menjadi `WAIT_PULLBACK` dengan flag `velocity_held: true`. Lonjakan semu 1-lot langsung dinetralkan.

#### 2. Imunitas Zero-Division pada Pace Volume (`lib/intraday-volume-pace.js`):
- **Pada Pukul Tepat 09:00:00 (Menit 540):**
  - `active_trading_minutes = 540 - 540 = 0`.
  - `session_progress_fraction = 0 / 330 = 0`.
  - `effective_session_progress = null`.
  - Evaluasi proyeksi volume hari penuh:
    ```javascript
    const projected = currentSessionPresent && volumeToday != null && volumeToday >= 0 && effective != null && effective > 0
      ? volumeToday / effective
      : null;
    ```
    Karena `effective === null`, `projected` bernilai `null` tanpa pernah melakukan pembagian nol.
- **Pada Pukul 09:01:00 (Menit 541):**
  - `active_trading_minutes = 1`.
  - `progress = 1 / 330 = 0.003`.
  - Logika clamping: `const effective = progress > 0 ? (progress >= 1 ? 1 : Math.max(progress, MIN_EFFECTIVE_PROGRESS)) : null;`.
  - `MIN_EFFECTIVE_PROGRESS` bernilai `0.15`.
  - Denominator pembagi langsung dikunci pada angka aman `0.15` (tidak membagi dengan pecahan ekstrim `0.003` yang bisa mendistorsi proyeksi hingga ratusan kali lipat).
- **Proteksi Baseline:**
  Pembagi `baselines.avg_volume_20d_ex_today > 0` dan `baselines.previous_day_volume > 0` diperiksa ketat, mencegah `NaN` atau `Infinity`.

---

### Fokus 3: Break-Even +2% Exit Management & Scoring Rework (PR #613)
*File Terkait: `api/sector-hot.js`, `lib/daytrade-screener-engine.js`*

#### 1. Dynamic Break-Even Lock (+2.0% Intraday):
- Pada posisi aktif Day Trade (`status === 'RUNNING'` atau `'ACTIVE'`):
  Ketika `highSinceEntry >= entryMid * 1.020`, flag `bepLocked` berubah menjadi `true`.
- **Mekanisme Tick Uplift:**
  Tingkat SL efektif dinaikkan dari stop loss struktural awal menjadi `entryMid + 1 tick` (dihitung via `idxTick.getIdxTickSize` dan dibulatkan via `idxTick.roundToIdxTick`).
  Contoh: Entry Rp 10.000 -> saat harga menyentuh Rp 10.250 (+2.5%), BEP terkunci pada Rp 10.025.
- **Transisi Outcome:**
  Jika harga berbalik arah dan menyentuh `effective_sl` (Rp 10.025):
  Status bertransisi ke `'BEP_CLOSED'` dengan catatan:
  `'Posisi ditutup di level Break-Even (+2% lock tercapai sebelumnya)'`.
  Field metrik dicatat dengan `loss_pct: 0` dan `pnl_pct: 0`. Sistem **TIDAK PERNAH** mencatatnya sebagai `SL_HIT`.
- **Preservasi Posisi Menang (TP1 Hit):**
  Jika harga telah menyentuh TP1 (`pick.hit_tp1_at` atau `status === 'TP1_HIT'`), lalu harga jatuh ke bawah SL, status tetap dipertahankan sebagai `'TP1_HIT'` (tidak pernah ditimpa oleh `SL_HIT`).

#### 2. Meritokrasi Skor Transaksi Riil:
- Konstanta dasar: `BASE_SCORE = 25` dan `TRADEABLE_SCORE_THRESHOLD = 65`.
- Komponen skor teknikal (kenaikan harga, RSI, posisi range, jarak breakout) maksimal bernilai 30 poin.
- **Plafon Volume Wajib (Hard Ceiling 64):**
  Jika `volume_ratio_20d < 1.0` atau lonjakan volume riil tidak terdeteksi (`volSurge === 0`):
  Skor teknikal dibatasi maksimal 24, dan skor total **DIKUNCI MAKSIMAL PADA 64**:
  ```javascript
  if ((vr < 1.0 || volSurge === 0) && total >= 65) {
    total = 64; // Hard ceiling if volume ratio < 1.0
  }
  ```
  Saham tanpa transaksi volume riil mustahil menembus batas kelayakan eksekusi (65).

#### 3. Diversifikasi Sektor Top 10 (`selectTopCandidatesWithSectorDiversification`):
- Filter kelayakan: Hanya kandidat dengan `score >= 65` yang diproses.
- Kuota Sektor: Dibatasi maksimal **3 emiten per sektor**.
- Kuota Total: Dibatasi maksimal **10 emiten terbaik**.
- Mencegah portofolio hari perdagangan terkonsentrasi pada satu sektor saja (misal jika 7 saham perbankan mendominasi skor, hanya 3 terbaik yang diambil).

---

### Fokus 4: Candle Pattern & Null Sentinels (PR #521, #522)
*File Terkait: `lib/candle-pattern-engine.js`, `lib/daytrade-screener-engine.js`*

#### 1. Sensitivitas Tren pada Pola Lilin (Hammer vs Hanging Man):
- Candle merah dengan badan kecil dan bayangan bawah panjang (`lowerShadow >= body * 2`, `upperShadow <= 0.15`):
  - **Di Area Support / Pasca Koreksi:**
    Jika `c0.low <= ctx.support * 1.03` atau `ctx.changePct <= 0`:
    Diklasifikasikan sebagai **`Hammer` (Bullish)**. Ini mengindikasikan adanya penolakan harga bawah (*buying absorption*) di level kritis.
  - **Di Puncak Rally / Extended Uptrend:**
    Jika `c0.low > ctx.support * 1.03` dan `ctx.changePct > 0`:
    Diklasifikasikan sebagai **`Hanging Man` (Bearish)**.
- **Proteksi Downgrade Screener:**
  Pada `lib/daytrade-screener-engine.js:1183`, penalti candle Hanging Man (`candleScore -= 4; candleDowngrade = true;`) hanya diberlakukan jika harga benar-benar extended di atas support (`data.last_price > data.support * 1.03`).

#### 2. Sentinel Nilai Unknown 20D Volume Ratio (PR #522 & Penanganan Bug):
- Untuk emiten baru IPO atau data historis < 20 baris, `analyzeDayTrade` mengembalikan `avg_volume_20d: null` dan `volume_ratio_20d: null`.
- Menghindari angka palsu 0 yang dapat merusak perhitungan rasio atau menyebabkan pembagian dengan nol.
- **Perbaikan Baris 902 & 906:** Telah dipasang safe string guard sehingga tidak terjadi exception saat merender catatan status.

---

### Fokus 5: Jam Istirahat Hari Jumat & Deteksi Timer Leak (PR #611)
*File Terkait: `lib/intraday-fast-watcher-live.js`, `lib/intraday-volume-pace.js`*

#### 1. Jendela Istirahat Khusus Hari Jumat (11:30 - 14:00 WIB):
- **Klarifikasi Jadwal Resmi BEI:**
  - Hari Senin–Kamis: Sesi I tutup pukul 12:00 WIB, Sesi II buka pukul 13:30 WIB (istirahat 90 menit).
  - Hari Jumat: Sesi I tutup pukul **11:30 WIB**, Sesi II buka pukul **14:00 WIB** (istirahat 150 menit untuk ibadah sholat Jumat).
- **Implementasi Guard:**
  Pada `lib/intraday-fast-watcher-live.js` baris 37–41:
  ```javascript
  if (day === 5) {
    if (total >= 11 * 60 + 30 && total < 14 * 60) {
      return null;
    }
  }
  ```
  Pada hari Jumat di antara 11:30 dan 14:00 WIB, fungsi `runModeForTime` mengembalikan `null`. Watcher tidak memproses tick apapun untuk mencegah false confirmation pada quote beku (*frozen market quote*).

#### 2. Audit Timer Leak & Zombie Process:
- Script backend seperti `tools/run-intraday-fast-watcher-guarded-live.js` beroperasi dengan arsitektur *ephemeral execution* (dijalankan via systemd timer/cron per tick, lalu proses Node.js langsung `process.exit()`). Tidak ada `setInterval` liar yang berjalan terus menerus di latar belakang VPS.
- Interval frontend (`_dtPollInterval`, `patternPollInterval`) dibersihkan secara eksplisit (`clearInterval`) saat pengguna berpindah tab.
- Stress test 1.000 iterasi mengonfirmasi kenaikan heap hanya sebesar **+0,42 MB**, jauh di bawah ambang batas kebocoran memori (30 MB).

---

## 3. HASIL PENGUJIAN OTOMATIS & STRESS TEST

### A. Test Suite Mandiri (`test/daytrade-v7-engine-integrity.test.js`):
Dieksekusi menggunakan runner bawaan Node.js:
```
✔ Cluster 2 - Focus 1: Confirmed volume (>= 1.2x) with score 70-74 qualifies for PRE_SPIKE_WATCH (1.86ms)
✔ Cluster 2 - Focus 1: Unconfirmed volume (< 1.2x) with score >= 70 near breakout correctly routes to EARLY_RADAR (0.21ms)
✔ Cluster 2 - Focus 1: Unconfirmed volume (< 1.2x) with score >= 70 far from breakout routes to SPECULATIVE (0.25ms)
✔ Cluster 2 - Focus 1: Thin anomaly (jump > 5% without volume >= 1.5) triggers Gap/Overheat guard -> WAIT_PULLBACK (0.26ms)
✔ Cluster 2 - Focus 1: Regression Test - volume_ratio_20d null does NOT throw TypeError and formats as N/A (0.34ms)
✔ Cluster 2 - Focus 2: Opening Velocity Guard rejects low delta turnover in 09:16-09:30 WIB window for Main board (1.45ms)
✔ Cluster 2 - Focus 2: Opening Velocity Guard passes high delta turnover in 09:16-09:30 WIB window for Main board (0.24ms)
✔ Cluster 2 - Focus 2: Opening Velocity Guard applies 100M threshold for Acceleration Board (0.18ms)
✔ Cluster 2 - Focus 2: Opening Velocity Guard is inactive after 09:30 WIB (0.21ms)
✔ Cluster 2 - Focus 2: Volume pace zero-division immunity at exactly 09:00:00 (1.06ms)
✔ Cluster 2 - Focus 2: Volume pace clamps effective progress to MIN_EFFECTIVE_PROGRESS (0.15) at 09:01:00 (0.34ms)
✔ Cluster 2 - Focus 3: BEP +2% lock activates when price gains >= 2.0% from entry and protects with BEP_CLOSED (0% loss) (2.89ms)
✔ Cluster 2 - Focus 3: TP1 Hit takes precedence and is NEVER overwritten by SL_HIT on subsequent retrace (0.24ms)
✔ Cluster 2 - Focus 3: Scoring Meritocracy - BASE_SCORE 25 and hard ceiling 64 when volume_ratio_20d < 1.0 (0.40ms)
✔ Cluster 2 - Focus 3: selectTopCandidatesWithSectorDiversification enforces Top 10 and max 3 per sector (0.36ms)
✔ Cluster 2 - Focus 4: Red candle with long lower shadow at support is classified as Hammer (Bullish) (0.75ms)
✔ Cluster 2 - Focus 4: Red candle with long lower shadow extended far above support is classified as Hanging Man (Bearish) (0.17ms)
✔ Cluster 2 - Focus 4: Unknown 20D volume ratio returns null sentinel (not 0) and does not divide by zero (0.94ms)
✔ Cluster 2 - Focus 5: Friday break window (11:30 - 14:00 WIB) strictly returns null runMode (0.29ms)
✔ Cluster 2 - Focus 5: Thursday market schedule allows trading between 11:30 and 12:00 WIB (0.30ms)

TOTAL: 20 passed, 0 failed, 0 skipped (Duration: ~250ms)
```

### B. Mock Replay & Stress Test (`tools/stress-test-intraday-replay.js`):
```
================================================================
⚡ INTRADAY SCREENER ENGINE — MOCK REPLAY & STRESS TEST REPORT
================================================================
Total Payloads Processed : 1.000 candidates
Total Wall-Clock Time   : 114.7 ms
Throughput              : 8.718 ops/sec (Target: >= 500)
Average Latency         : 0.1147 ms/eval (Target: < 5 ms)
Latency Percentiles     : p50: 0.0654ms | p95: 0.1841ms | p99: 0.3874ms | max: 27.4471ms
Error Rate              : 0.00% (0 errors)
----------------------------------------------------------------
MEMORY USAGE & ZERO-LEAK AUDIT:
  Initial Heap : 7.4 MB
  Final Heap   : 7.82 MB
  Heap Delta   : +0.42 MB (Threshold: < 30 MB)
  RSS Delta    : +15.25 MB
----------------------------------------------------------------
GATE CHECK VERDICT:
  [PASS] Latency Check (< 5.0ms)     : 0.1147 ms
  [PASS] Memory Leak Check (< 30MB) : 0.42 MB
  [PASS] Error Rate Check (0%)       : 0%
  [PASS] Throughput Check (>= 500)   : 8718 ops/sec
================================================================
 OVERALL VERDICT: ALL STRESS & LEAK TESTS PASSED!
================================================================
```

### C. Curated Smoke Test Suite (`npm run test:smoke`):
```
All 67 test files passed successfully!
77 passed, 0 failed, 0 cancelled (Duration: ~821ms)
```

---

## 4. PERUBAHAN KODE LOKAL (GIT STATUS)

Berikut adalah status berkas lokal pada cabang `feat/daytrade-screener-v1` yang belum di-commit:
1. `lib/daytrade-screener-engine.js`:
   Perbaikan format string pada `data.volume_ratio_20d` (mencegah error `null.toFixed(2)`).
2. `tools/curated-build-tests.json`:
   Mendaftarkan `test/daytrade-v7-engine-integrity.test.js` ke dalam pipeline automated smoke test.
3. `test/daytrade-v7-engine-integrity.test.js`:
   File test suite baru yang mencakup 20 skenario forensik Klaster 2.

```diff
diff --git a/lib/daytrade-screener-engine.js b/lib/daytrade-screener-engine.js
--- a/lib/daytrade-screener-engine.js
+++ b/lib/daytrade-screener-engine.js
@@ -896,14 +896,17 @@ function classifyStatus(...) {
   // PRE_SPIKE blocked due to low volume but score decent
   else if (compositeScore >= DT_INITIAL.prespike_score && hardFails.length === 0 && hasLowVolume && !isAfternoon) {
     // V3: if near breakout + some signs, classify as EARLY_RADAR instead of SPECULATIVE
+    var volStr = (data.volume_ratio_20d != null && Number.isFinite(data.volume_ratio_20d))
+      ? data.volume_ratio_20d.toFixed(2) + 'x'
+      : 'N/A';
     if (data.distance_to_breakout_pct <= 4.0 && data.change_pct >= 0 && !hasDistribution) {
       status = 'EARLY_RADAR';
       setup = 'Early Radar - Volume Belum';
-      notes = 'Dekat breakout tapi volume belum konfirmasi (vol ' + data.volume_ratio_20d.toFixed(2) + 'x). Monitor volume build-up.';
+      notes = 'Dekat breakout tapi volume belum konfirmasi (vol ' + volStr + '). Monitor volume build-up.';
     } else {
       status = 'SPECULATIVE';
       setup = 'Speculative - Volume Belum Konfirmasi';
-      notes = 'Belum ada konfirmasi volume untuk pre-spike (vol ratio ' + data.volume_ratio_20d.toFixed(2) + 'x < 1.2x). Monitor saja.';
+      notes = 'Belum ada konfirmasi volume untuk pre-spike (vol ratio ' + volStr + ' < 1.2x). Monitor saja.';
     }
   }
```

---

## 5. REKOMENDASI AUDITOR & KOMITMEN ZERO-PUSH

- **Pematuhan Batasan Kerja:**
  Sesuai instruksi mutlak, **TIDAK ADA `git commit` MAUPUN `git push`** yang dilakukan ke remote repository. Seluruh perubahan berada dalam lingkungan lokal.
- **Rekomendasi Rilis:**
  Seluruh logika matematis dan arsitektur Klaster 2 (PR #518, #521, #522, #611, #612, #613) berada dalam status **PRODUCTION-READY** setelah perbaikan bug `null.toFixed(2)` di baris 902/906.
- Menunggu persetujuan Lead Engineer sebelum melanjutkan ke tahap git commit dan sinkronisasi branch.
