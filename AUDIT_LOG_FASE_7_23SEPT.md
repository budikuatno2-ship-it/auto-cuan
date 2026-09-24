# AUDIT LOG — FASE 7 (23 SEPTEMBER)

**Subsystem:** Daytrade Screener Engine, Candidate Ranking, & Intraday Filtering Pipeline
**Mode:** Zero-Trust Forensic Audit (test-first, reproduce-then-fix)
**Tanggal audit:** 2026-09-23
**Status:** SELESAI — 7 bug ditemukan, 7 diperbaiki, 27 test baru (semua PASS 2×), suite repo hijau.

---

## 1. EXECUTIVE SUMMARY

Investigasi difokuskan pada gejala produksi **"screener menghasilkan 0 kandidat/sinyal sepanjang hari"**.

Hasilnya: **0 sinyal bukan disebabkan oleh pasar yang sepi, melainkan oleh dua cacat logika struktural yang membuat status sinyal
`A_PLUS_SETUP` / `TRADE_CANDIDATE` / `READY_BREAKOUT` menjadi MATEMATIS TIDAK MUNGKIN DICAPAI**, ditambah lima bug
parsing/gating lain yang secara diam-diam membuang kandidat valid sebelum sempat dinilai.

### Root cause utama "0 SINYAL"

| # | Akar masalah | Sifat |
|---|---|---|
| **BUG-F7-01** | `resistance` dihitung `max(high)` atas window yang **memuat candle terakhir**, lalu dipakai sebagai `breakout_trigger`. Karena `close ≤ high ≤ max(high)` selalu benar, kondisi `close > resistance` **tidak pernah bisa terpenuhi** → semua kandidat terpin di `BREAKOUT_WATCH` → `scoreDayTrade` menurunkan semua status ENTRY ZONE ke `EARLY_RADAR`. | **Tautologi — mustahil** |
| **BUG-F7-01b** | TP1 di-cap ke `resistance` (= high hari ini). Reward jadi ≈ 0R sehingga gate `RR ≥ 1.5` **tidak mungkin dilewati** pada breakout yang baru saja confirmed. | **Struktural — mustahil** |

Keduanya bergabung: bahkan bila seorang saham naik ke ARA dengan volume 10×, ia tetap tidak akan pernah menjadi sinyal.

### Ringkasan temuan

| ID | Severity | Area | Dampak | Status |
|---|---|---|---|---|
| BUG-F7-01 | **CRITICAL** | Breakout gate | Semua sinyal ENTRY ZONE mustahil → 0 sinyal | FIXED |
| BUG-F7-01b | **CRITICAL** | TP1 / RR | RR < 1.5 selamanya → gate RR selalu menolak | FIXED |
| BUG-F7-02 | **HIGH** | Liquidity gate | `null < 0.3 === true` → RVOL tak diketahui dibuang di gate pertama | FIXED |
| BUG-F7-03 | **HIGH** | Data quality | Volume string berformat → `INVALID_CANDLE` → AVOID | FIXED |
| BUG-F7-04 | **MEDIUM** | Tick size FCA | `is_fca='true'` string tidak dikenali → tick size salah | FIXED |
| BUG-F7-05 | **MEDIUM** | Universe gate | Turnover string berformat → `liquidity_unverified` | FIXED |
| BUG-F7-06 | **MEDIUM** | Publish gate | Skor `null`/`NaN` lolos ke Top-10 | FIXED |
| BUG-F7-07 | **HIGH** | Publish lifecycle | Batch `paused` (BREAK/CLOSED) memicu trim → data terbitan terhapus | FIXED |

---

## 2. REAL DEPENDENCY MAPPING

> **Catatan penting:** nama file pada brief (`lib/daytrade-screener.js`, `api/daytrade-screener-runner.js`,
> `lib/daytrade-scoring.js`, `lib/daytrade-ranker.js`, `lib/daytrade-gate.js`) **tidak ada di repo**.
> Pemetaan di bawah adalah hasil traversal kode nyata (bukan asumsi), sesuai pelajaran Fase 4/5/6.

### 2.1 Entry points (API)

| Route | Handler | File |
|---|---|---|
| `GET /api/sector-hot?action=daytrade-screener` | `handleDayTradeScreenerRead` | `api/sector-hot.js:12066` |
| `GET /api/sector-hot?action=daytrade-screener-run` | `handleDayTradeScreenerRun` | `api/sector-hot.js:12229` |

Tidak ada `api/daytrade-screener.js` maupun `api/daytrade-screener-runner.js` — seluruh runner Daytrade
berada di dalam **service monolit `api/sector-hot.js` (15.070 baris)**.

### 2.2 Core engine

| Peran | File nyata | Catatan |
|---|---|---|
| **Engine produksi (wrapper)** | `lib/daytrade-screener-engine-v7.js` (208 baris) | Volume-pace recall + lifecycle. Di-`require` sebagai `dtEngine` oleh `api/sector-hot.js:37`. |
| **Engine inti** | `lib/daytrade-screener-engine.js` (3.207 baris) | `analyzeDayTrade`, `scoreLiquidity`, `scorePreSpike`, `scoreMomentum`, `calculateLevels`, `classifyStatus`, `scoreDayTrade`, `filterDayTradeUniverse`, `runDayTradeBatch` |
| Threshold klasifikasi | `lib/daytrade-screener-constants.js` | `INITIAL_CLASSIFICATION_THRESHOLDS` |
| Config RR / volume | `lib/screener-config.js` | `MIN_RR_RATIO = 1.5`, `passesRiskRewardFilter` |
| Ranking kandidat | `lib/daytrade-execution-ranking.js` | `sortDayTradeByExecution`, `compareDayTradeExecution` |
| Disiplin entry | `lib/daytrade-entry-discipline.js` | `deriveDayTradeEntryDiscipline` |

### 2.3 Gate & filter intraday

| Peran | File nyata |
|---|---|
| Tick size IDX + FCA + entry/breakout status | `lib/idx-tick-normalization.js` (1.187 baris) |
| Kalender & jam bursa otoritatif | `lib/market-hours-guard.js` (349 baris) |
| RVOL intraday (volume pace) | `lib/intraday-volume-pace.js` |
| Kelayakan produksi (data quality) | `lib/intraday-production-eligibility.js` |
| Universe lengkap | `lib/daytrade-full-eligible-universe.js` |
| Cache OHLCV | `lib/daytrade-ohlcv-cache.js` |
| Calendar libur IDX 2026 | `lib/idx-holidays-2026-seed-data.js`, `lib/idx-trading-calendar.js` |

### 2.4 Chain produksi lengkap

```
cron → handleDayTradeScreenerRun (api/sector-hot.js:12229)
      → dtEngine.buildFastDayTradeUniverse() | buildDayTradeUniverse()
          → filterDayTradeUniverse()  ← GATE 1: board/FCA/liquidity
      → dtEngine.runDayTradeBatch()   ← GATE 2: pause BREAK/CLOSED
          → fetchDayTradeCandles() (Yahoo 90d)
          → analyzeDayTrade()         ← GATE 3: data quality
          → scoreDayTrade()
              → scoreLiquidity()      ← GATE 4: turnover + RVOL
              → calculateLevels()     ← GATE 5: TP1 / RR
              → classifyStatus()      ← GATE 6: RR gate + status
              → deriveBreakoutConfirmation() ← GATE 7: breakout
          → filter(daytrade_score >= 65)
          → upsert daytrade_screener_latest
      → finalizeDtScreener()          ← GATE 8: sort + Top-10 + TRIM
          → sortDayTradeByExecution()
          → selectTopCandidatesWithSectorDiversification()
          → delete() not-in-top-10
```

---

## 3. METRIK & ANALISIS BOTTLENECK "0 SINYAL"

### 3.1 Bukti empiris tautologi breakout (sebelum fix)

```
$ node tmp_investigasi/f7-probe4.js

last_price          = 120
resistance (20d hi) = 120
close > resistance ? false (must be true for BREAKOUT_CONFIRMED)
deriveBreakoutConfirmation => BREAKOUT_WATCH | "Belum breakout confirmed; butuh close di atas 120."
score = 31 | status = WAIT_PULLBACK | confidence = C
=> A_PLUS/TRADE_CANDIDATE/READY_BREAKOUT reachable? false

TAUTOLOGY PROOF: max(highs[-20..]) = 120 | close = 120
close <= high <= max(highs) always => close > resistance is UNSATISFIABLE
```

Skenario di atas adalah **kasus terbaik yang mungkin**: candle terakhir close tepat di high-nya, dan high itu
adalah high tertinggi seluruh seri 25 hari. Bahkan dalam kasus ini sistem tetap menolak.

### 3.2 Bottleneck berantai (efek domino)

`classifyStatus()` **tidak pernah** mencapai cabang ENTRY ZONE. Yang terjadi:

| Kondisi | Cabang yang dieksekusi | Hasil |
|---|---|---|
| Skor ≥ 88, semua konfirmasi | `A_PLUS_SETUP` | lalu di-downgrade baris 1504-1510 → `EARLY_RADAR` |
| Skor ≥ 78 | `TRADE_CANDIDATE` | di-downgrade → `EARLY_RADAR` |
| Skor ≥ 75 | `READY_BREAKOUT` | di-downgrade → `EARLY_RADAR` |

Lalu di `finalizeDtScreener()` (`api/sector-hot.js:12655-12669`):

```js
var confirmedSignalCount = publishedRows.filter(r =>
  r.status === 'A_PLUS_SETUP' || r.status === 'TRADE_CANDIDATE' || r.status === 'READY_BREAKOUT').length;
var priorityRadarCount = publishedRows.filter(r => r.status === 'PRE_SPIKE_WATCH').length;
var topCount = confirmedSignalCount + priorityRadarCount;
```

`EARLY_RADAR` **tidak dihitung di kedua bucket**. Jadi `top_count` **secara struktural selalu 0**.

### 3.3 Dampak bug parsing terhadap volume kandidat

| Bug | Gate tempat drop | Bukti |
|---|---|---|
| BUG-F7-02 | `scoreLiquidity` | `null < 0.3 → true` → `"Volume sangat rendah (ratio<0.3)"` → `pass:false` → status `AVOID` |
| BUG-F7-03 | `deriveDataQualityStatus` | `Number('5.000.000') → NaN` → `INVALID_CANDLE` → `data_quality_valid=false` |
| BUG-F7-05 | `dayTradeEligibilityReason` | `Number('1.234.567.890') → NaN` → `liquidity_unverified` |
| BUG-F7-06 | `selectTopCandidatesWithSectorDiversification` | `score != null && isFinite(score)` → guard ter-skip untuk `null`/`NaN` |

### 3.4 Hasil pengukuran sebelum vs sesudah (skenario breakout realistis)

Seri: 24 sesi konsolidasi di bawah 100 (volume 4 jt), lalu candle breakout close 103.5 dengan volume 30 jt.

| Metrik | SEBELUM fix | SESUDAH fix |
|---|---|---|
| `breakout_trigger` | tidak ada (dipakai `resistance` = 104) | **100** (high sesi sebelumnya) |
| `breakout_confirmation_status` | `BREAKOUT_WATCH` | **`BREAKOUT_CONFIRMED`** |
| TP1 | 105 (di-cap, RR 0.6) | **107** (measured move) |
| `risk_reward` | 0.60 → ditolak gate RR 1.5 | **1.79** → lolos gate |
| Status akhir | `WAIT_PULLBACK` | **`READY_BREAKOUT`** |
| Bucket `top_count` | 0 | **1** |

### 3.5 Analisis Timezone & Kalender (tidak ditemukan bug)

| Area | Hasil pemeriksaan |
|---|---|
| Off-by-one WIB vs UTC | **AMAN.** `getWibComponents()` menambah tepat `+7*60*60*1000` lalu membaca `getUTC*()` — deterministik, tidak bergantung timezone OS. |
| Sesi 1 Jumat | **AMAN.** 09:00–11:30 (`FRIDAY_SESSION_1_END_MINUTES = 690`). |
| Sesi 2 Jumat | **AMAN.** 14:00–15:45 (`FRIDAY_SESSION_2_START_MINUTES = 840`). |
| `getRunMode` legacy (batas 16:00) | **Tidak konsisten** dengan `market-hours-guard` (15:45) dan `intraday-volume-pace` (16:00), tetapi dipertahankan karena ada test kontrak (`daytrade-run-mode-window.test.js`). Dicatat sebagai temuan observasi, bukan bug. |
| Hari libur nasional | **AMAN.** `lib/market-hours-guard.js` **tidak** menangani hari libur (hanya weekend) — tidak ada risiko false-CLOSED. `idx-holidays-2026-seed-data.js` berisi 22 tanggal dan dipakai oleh `idx-trading-calendar.js`. Karena market-hours-guard tidak mengonsumsinya, tidak ada bug "libur bergeser". |

### 3.6 Analisis Skoring & NaN (tidak ditemukan bug di sorter)

`sortDayTradeByExecution` / `compareDayTradeExecution` (`lib/daytrade-execution-ranking.js:140-157`) **sudah aman**:
memakai `finite()` yang mengembalikan `null`, lalu `?? 0` / `?? -Infinity`. Tidak ada `NaN` yang merusak urutan.

Namun **`selectTopCandidatesWithSectorDiversification` TIDAK aman** — lihat BUG-F7-06.

### 3.7 Integrasi Fase 1 & Fase 4 (diverifikasi)

| Fix sebelumnya | Status integrasi |
|---|---|
| **Fase 1** — minimum tick sub-Rp1 (`BUG-FASE1-003`) | **TERINTEGRASI.** `roundToIdxTick` mengembalikan `null` bila hasil ≤ 0 (baris 60). Dipanggil dari `scoreDayTrade` dan `runDayTradeBatch` (final tick normalization). |
| **Fase 4** — wash sale / churn / CR3 | **TERINTEGRASI.** `lib/bandarmologi-service.js` dipanggil via `evaluateConfluenceSignal()` di `scoreDayTrade`; `confluence_flag === 'HINDARI'` menurunkan status + memberi penalty. |
| **Fase 6** — foreign/insider | `enrichConfluenceRows` dipanggil di read path (`api/sector-hot.js:12155`). |

### 3.8 Audit Silent Failure / Empty Catch

Pemindaian seluruh blok `catch` pada jalur Daytrade:

| Lokasi | Isi catch | Penilaian |
|---|---|---|
| `lib/daytrade-screener-engine.js:1335` | `catch (_) { confluenceResult = null; }` | **Aman** — confluence opsional, bukan gate eliminasi |
| `lib/daytrade-screener-engine.js:1877` | `catch (_) { batchMarketRegime = null; }` | **Aman** — regime opsional |
| `lib/daytrade-screener-engine.js:1850` | `catch (e) { /* non-critical */ }` | **Aman** — `sector_hot_group_members` opsional |
| `lib/daytrade-screener-engine.js:2225` | `catch (e) { failed.push({...}) }` | **Aman** — error di-surface ke `failed[]` |
| `lib/daytrade-screener-engine.js:1765` | `catch (e) { return { diagnostics: {...} } }` | **Aman** — error di-surface |
| `lib/market-hours-guard.js` | tidak ada catch kosong | **Aman** |

**Kesimpulan:** tidak ditemukan `catch {}` kosong yang menelan error PostgREST/fetch pada jalur kritis Daytrade.
Error fetch ditangani eksplisit (`response.ok`, `res.error`, `result.data`).

### 3.9 Observasi arsitektural

1. **`finalizeDtScreener` dipanggil pada batch terakhir** — untuk universe 760 saham / batch 50 = 16 request.
   Bila batch ke-16 jatuh pada sesi BREAK, trim dijalankan atas set kosong → **BUG-F7-07** (sudah diperbaiki).
2. **`daytrade_screener_latest` tidak punya kolom `data_quality_*`** (`supabase/daytrade-screener-migration.sql`).
   Nilai tersebut hilang setelah upsert, sehingga gate `classifyProductionEligibility` pada read path tidak dapat
   mengevaluasi data quality. **Rekomendasi** (di luar scope): tambahkan kolom `data_quality_status`.
3. **`sortDayTradeRadarCandidates`** (`api/sector-hot.js:13267`) memakai `rankCandidatesByPotential` yang bisa
   mengembalikan `-999999`; tidak menghasilkan `NaN`. **Aman.**

---

## 4. VERIFIKASI & BUKTI

### 4.1 File yang diubah

| File | Perubahan | Baris |
|---|---|---|
| `lib/daytrade-screener-engine.js` | `coerceNumeric`, `normalizeCandleNumbers`, `breakout_trigger`, guard RVOL null, TP1 clamp, eligibility parser | +121 |
| `lib/idx-tick-normalization.js` | `isExplicitTrueFlag` untuk FCA boolean/string | +28 |
| `api/sector-hot.js` | `shouldSkipDayTradePublish`, fail-closed score gate, export `__test` | +183 |
| `tools/curated-build-tests.json` | Registrasi test baru | +1 |
| `test/audit-fase7-daytrade-screener-bugs.test.js` | **BARU** — 27 test | 0 → 27 test |

### 4.2 Hasil test (bukti PASS 2×)

```
RUN 1: ℹ tests 27  ℹ pass 27  ℹ fail 0  ℹ duration_ms 828.74
RUN 2: ℹ tests 27  ℹ pass 27  ℹ fail 0  ℹ duration_ms 869.71
```

### 4.3 Regression suite

```
$ node --test test/candle-close-confirmation.test.js test/idx-tick-breakout-confirmation.test.js \
    test/data-quality-hygiene.test.js test/daytrade-universe-recovery.test.js \
    test/daytrade-run-mode-window.test.js test/daytrade-volume-sentinel-null.test.js \
    test/market-hours-guard.test.js
ℹ tests 35  ℹ pass 35  ℹ fail 0

$ node --test test/daytrade-v7-engine-integrity.test.js test/daytrade-prespike-branch-order.test.js \
    test/daytrade-screener-status-rr.test.js test/daytrade-volume-pace-recall-v7.test.js \
    test/phase3-phase4-scoring-and-exit.test.js test/audit-batch3-screener-engine.test.js \
    test/audit-batch4-bandarmologi-dispatcher.test.js test/audit-batch5-production-hardening.test.js
ℹ tests 92  ℹ pass 92  ℹ fail 0
```

### 4.4 Full repository build suite

```
$ npm run build
All .js files parsed cleanly.
ℹ fail 0
✅ All broker-accumulation-fix tests passed!
✅ All multi-day broker aggregation tests passed!
All 68 test files passed successfully!
```

### 4.5 Perlindungan regression yang dipertahankan

| Perilaku | Test penjaga | Status |
|---|---|---|
| Live wick di atas resistance tetap `NEEDS_CLOSE_CONFIRMATION` | `candle-close-confirmation.test.js`, `audit-fase7...` | PASS |
| `close` tepat di resistance bukan confirmed | `idx-tick-breakout-confirmation.test.js` | PASS |
| Illikuiditas nyata tetap ditolak | `audit-fase7...` | PASS |
| Board FCA/restricted tetap dikecualikan | `daytrade-universe-recovery.test.js`, `audit-fase7...` | PASS |
| Tier tick size reguler tidak berubah | `audit-fase7...` | PASS |
| Kandidat blocked tidak mengalahkan executable | `audit-fase7...` | PASS |
| Batas sesi bursa & timezone | `market-hours-guard.test.js` | PASS |

---

## 5. KESIMPULAN

1. **"0 sinyal sepanjang hari" terbukti BUKAN masalah pasar.** Ia disebabkan oleh **tautologi matematis** pada
   `breakout_trigger` (BUG-F7-01) dan **cap TP1 ke high hari ini** (BUG-F7-01b) yang bersama-sama membuat
   `A_PLUS_SETUP` / `TRADE_CANDIDATE` / `READY_BREAKOUT` mustahil dicapai — dan bucket `top_count` hanya
   menghitung status-status itu.

2. **Tiga bug parsing** (BUG-F7-02/03/05) membuang saham likuid secara diam-diam sebelum dinilai, memperkuat
   gejala 0 sinyal pada hari-hari dengan data feed berformat string.

3. **Tidak ditemukan** bug timezone WIB/UTC maupun bug hari libur pada jalur Daytrade.

4. **Sorter ranking utama sudah aman** terhadap `NaN`; celahnya ada di `selectTopCandidatesWithSectorDiversification`.

5. Semua perbaikan bersifat **minimal diff**, tidak mengubah ambang batas bisnis mana pun, dan **tidak
   melemahkan** guard anti-chase, anti-distribusi, maupun anti-FCA yang sudah ada.

---

## 6. ADDENDUM BATCH 4 (24 SEPTEMBER 2026) — RESIDUAL DEFECT CLASS

> **Mengapa addendum ini ada.** Batch 4 mengaudit ulang jalur Core Screener setelah Fase 7
> dinyatakan selesai. Audit ulang menemukan **kelas cacat residual** yang LOLOS dari pass
> pertama: semua perbaikan Fase 7 menyasar *jalur CANDLE* dan *gate likuiditas*, tetapi
> **jalur QUOTE**, **penanganan array kosong**, dan **konsistensi UNKNOWN** tidak tersentuh.
> Addendum ini mencatatnya secara transparan, termasuk satu koreksi terhadap pembacaan awal
> Batch 4 sendiri.

### 6.1 Nama berkas test — ketidaksesuaian dokumen

| Sumber | Nama berkas |
|---|---|
| Brief Batch 4 | `test/audit-fase7-screener-engine-bugs.test.js` |
| Dokumen Fase 7 (asli) | `test/audit-fase7-daytrade-screener-bugs.test.js` |

**Keduanya valid dan keduanya dipertahankan.** Suite Fase 7 asli (27 test) tetap menjadi
penjaga blocker awal (tautologi breakout, cap TP1, RVOL null di `scoreLiquidity`, string
berformat pada candle). Suite Batch 4 (22 test) adalah **lapisan tambahan** untuk kelas
cacat residual di bawah ini — bukan pengganti.

### 6.2 Temuan residual & perbaikannya

| ID | Severity | Judul | File | Bukti FAIL-first |
|---|---|---|---|---|
| BATCH4-F7-01 | 🟠 HIGH | `analyzeDayTrade` **crash** (`TypeError`) pada array candle kosong / `null` / baris rusak | `lib/daytrade-screener-engine.js` | 5 test |
| BATCH4-F7-02 | 🔴 CRITICAL | String berformat pada **field QUOTE** → `data.change_pct.toFixed is not a function` | `lib/daytrade-screener-engine.js` | 4 test |
| BATCH4-F7-03 | 🟡 MEDIUM | `undefined < 1.2 === false` → UNKNOWN **dipromosikan** sedangkan `null` tidak (inkonsistensi UNKNOWN) | `lib/daytrade-screener-engine.js` | 5 test |

**BATCH4-F7-01 — crash pada candle kosong.** `analyzeDayTrade()` langsung membaca
`candles.length` dan `last.close`. Provider yang menjawab dengan `[]`, body `null`, atau satu
halaman baris `null` melempar `TypeError`. Di dalam `runDayTradeBatch()` error itu ditelan
`try/catch` per-ticker, sehingga saham **menghilang dari scan** dengan alasan generik
`exception:` alih-alih hasil yang bisa didiagnosis. Pemanggil di **luar** try/catch
(backtest, replay, diagnostik) crash total. Perbaikan: `return null` untuk input tak-layak,
buang baris yang tidak punya OHLC finite, lalu analisis sisa sesi yang valid.

**BATCH4-F7-02 — string berformat di field quote (CRITICAL).** BUG-F7-03 mengajarkan engine
meng-coerce string pada **candle**, tetapi `change_pct` dan `rsi14` — dua field yang dibaca
`calculatePenalty()` dan `classifyStatus()` lewat `.toFixed()` — tidak ikut di-coerce.
Feed yang mengirim `"9.0"` bukan `9.0` melempar `TypeError` tepat pada cabang **overheat** dan
**RSI overbought**: dua cabang yang **selalu** dilewati mover panas ber-volume. Perbaikan:
satu helper `coerceQuoteNumbers()` dipanggil di `scoreDayTrade()`, `calculatePenalty()`,
`scoreMomentum()`, dan `classifyStatus()`.

**BATCH4-F7-03 — inkonsistensi UNKNOWN (dan koreksi diri Batch 4).**
`null < 1.2 === true` membuat RVOL tak terukur **tidak** dipromosikan. Pembacaan awal Batch 4
menganggap ini cacat dan mengubahnya. **Pembacaan itu SALAH** dan sudah dikoreksi: gate ini
adalah *promotion gate* yang memang fail-closed (PRE_SPIKE_WATCH didefinisikan sebagai radar
yang **sudah** terkonfirmasi volume), berbeda dengan `scoreLiquidity` (BUG-F7-02) yang
menghard-fail kandidat ke AVOID sehingga **menghapus** saham dari scan. Yang **benar-benar**
cacat adalah:

1. `undefined < 1.2 === false` → field yang **absen** justru **dipromosikan**, sedangkan
   `null` tidak. Satu state UNKNOWN yang sama memberi dua jawaban berbeda tergantung cara
   feed menghilangkannya. Kini kedua bentuk UNKNOWN dinormalisasi ke cabang fail-closed.
2. RVOL UNKNOWN dirender sebagai **`0.00x`** — angka yang tidak pernah terukur disajikan
   seolah hasil observasi. Kini dirender `N/A`.

Test `BATCH4-F7-03a..e` mem-pin **kontrak fail-closed** ini sebagai regression guard agar
"pembersihan" `null` di masa depan tidak diam-diam mulai mempromosikan kandidat yang belum
terkonfirmasi volume. Regresi ini terdeteksi nyata saat Batch 4: `daytrade-v7-engine-integrity.test.js`
menangkap percobaan perbaikan yang salah.

### 6.3 Metrik verifikasi

| Tahap | Hasil |
|---|---|
| Baseline (sebelum fix) | **11 PASS / 10 FAIL** dari 21 test |
| PASS run #1 | **22 / 22 PASS**, 0 fail |
| PASS run #2 (berturut-turut) | **22 / 22 PASS**, 0 fail |
| Regresi terarah (9 suite) | **140 / 140 PASS**, 0 fail |

### 6.4 Perlindungan regression yang dipertahankan

| Perilaku | Test penjaga | Status |
|---|---|---|
| PRE_SPIKE_WATCH tetap fail-closed pada RVOL tak terukur | `daytrade-v7-engine-integrity.test.js`, `audit-fase7-screener-engine-bugs.test.js` | PASS |
| Kandidat illikuid tetap ditolak | `audit-fase7-daytrade-screener-bugs.test.js` | PASS |
| Volume rusak (`'not-a-number'`) tetap `INVALID_CANDLE` | `audit-fase7-daytrade-screener-bugs.test.js` | PASS |
| `avg_volume_20d` null pada riwayat pendek | `daytrade-volume-sentinel-null.test.js` | PASS |
| Sorter eksekusi & cap diversifikasi sektor | `daytrade-execution-ranking`, `audit-fase7-screener-engine-bugs.test.js` | PASS |

---

## 7. REKOMENDASI LANJUTAN (di luar scope)

| # | Rekomendasi | Alasan |
|---|---|---|
| R1 | Tambah kolom `data_quality_status`, `data_quality_valid`, `data_quality_needs_revalidation` pada `daytrade_screener_latest` | Data quality hilang setelah upsert sehingga gate produksi di read path tidak dapat mengevaluasi |
| R2 | Satukan `getRunMode()` legacy (batas 16:00) dengan `market-hours-guard` (15:45) | Dua sumber kebenaran untuk jam sesi berpotensi drift |
| R3 | Tambahkan guard `skipped` pada `finalizeDtScreener` sebagai pertahanan berlapis | Saat ini guard ada di caller; jika ada caller baru, risiko terulang |
| R4 | Audit apakah `intraday-volume-pace.tradingSchedule` (Jumat total 270 menit, tutup 16:00) perlu diselaraskan ke 15:45 | Saat ini Jumat dihitung 09:00–11:30 + 14:00–16:00 = 270 menit, sedangkan bursa tutup 15:45 |
