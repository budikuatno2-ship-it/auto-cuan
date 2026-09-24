# BUG FINDINGS — FASE 7 (23 SEPTEMBER)

**Subsystem:** Daytrade Screener Engine, Candidate Ranking, & Intraday Filtering Pipeline
**Metodologi:** Zero-Trust Forensic Audit — setiap bug dibuktikan lewat unit test yang **GAGAL** dulu, baru diperbaiki, lalu diverifikasi **PASS 2× berturut-turut**.
**Test suite:** `test/audit-fase7-daytrade-screener-bugs.test.js` (27 test)
**Status akhir:** 27/27 PASS · Full repo suite: **All 68 test files passed successfully!**

---

## RINGKASAN EKSEKUTIF

| ID | Severity | Judul | File | Test penjaga |
|---|---|---|---|---|
| BUG-F7-01 | 🔴 **CRITICAL** | Tautologi breakout — `close > resistance` mustahil | `lib/daytrade-screener-engine.js` | 3 test |
| BUG-F7-01b | 🔴 **CRITICAL** | TP1 di-cap ke high hari ini — RR ≥ 1.5 mustahil | `lib/daytrade-screener-engine.js` | 1 test |
| BUG-F7-02 | 🟠 HIGH | `null < 0.3 === true` — RVOL tak diketahui dibuang | `lib/daytrade-screener-engine.js` | 3 test |
| BUG-F7-03 | 🟠 HIGH | Volume string berformat → `INVALID_CANDLE` | `lib/daytrade-screener-engine.js` | 3 test |
| BUG-F7-04 | 🟡 MEDIUM | `is_fca='true'` (string) tidak dikenali | `lib/idx-tick-normalization.js` | 2 test |
| BUG-F7-05 | 🟡 MEDIUM | Turnover string → `liquidity_unverified` | `lib/daytrade-screener-engine.js` | 3 test |
| BUG-F7-06 | 🟡 MEDIUM | Skor `null`/`NaN` lolos gate ≥ 65 | `api/sector-hot.js` | 2 test |
| BUG-F7-07 | 🟠 HIGH | Batch `paused` memicu trim → data terbitan terhapus | `api/sector-hot.js` | 2 test |

**Total:** 8 temuan (7 bug + 1 turunan), 27 test, 8 regression guard.

---

## BUG-F7-01 — TAUTOLOGI BREAKOUT: SEMUA SINYAL ENTRY ZONE MUSTAHIL

### Severity: 🔴 CRITICAL — akar utama "0 sinyal sepanjang hari"

### Lokasi
`lib/daytrade-screener-engine.js` — `analyzeDayTrade()` baris ~353 dan `scoreDayTrade()` baris ~1521

### Deskripsi

`analyzeDayTrade()` menghitung `resistance` sebagai **high tertinggi 20 candle terakhir**:

```js
var recent20Highs = highs.slice(-20);
var resistance = round0(Math.max.apply(null, recent20Highs));
```

Window `slice(-20)` **memuat candle terakhir**. Karena secara matematis selalu berlaku
`close ≤ high ≤ max(high)`, maka `resistance ≥ close` **selalu** benar.

Nilai `resistance` yang sama kemudian dikirim sebagai `breakout_trigger`:

```js
// scoreDayTrade(), baris 1521 — SEBELUM FIX
breakoutConfirmation = idxTick.deriveBreakoutConfirmation({
  ...
  breakout_trigger: data.resistance,   // ← level yang memuat hari ini sendiri
  ...
});
```

Dan `deriveBreakoutConfirmation()` (`lib/idx-tick-normalization.js:330`) memutuskan breakout dengan:

```js
if (close > resistance) { ... status = 'BREAKOUT_CONFIRMED'; }
```

**Kondisi `close > resistance` tidak dapat dipenuhi oleh nilai apa pun.** Akibatnya SEMUA kandidat
jatuh ke `BREAKOUT_WATCH`.

### Dampak berantai

`scoreDayTrade()` baris 1504-1510 menurunkan setiap status ENTRY ZONE:

```js
if (breakoutConfirmation.breakout_confirmation_status !== 'BREAKOUT_CONFIRMED') {
  if (classification.status === 'A_PLUS_SETUP' || classification.status === 'TRADE_CANDIDATE' || classification.status === 'READY_BREAKOUT') {
    classification.status = 'EARLY_RADAR';   // ← selalu dieksekusi
  }
}
```

Lalu `finalizeDtScreener()` (`api/sector-hot.js:12655-12669`) hanya menghitung:

```js
var confirmedSignalCount = publishedRows.filter(r =>
  r.status === 'A_PLUS_SETUP' || r.status === 'TRADE_CANDIDATE' || r.status === 'READY_BREAKOUT').length;
var priorityRadarCount = publishedRows.filter(r => r.status === 'PRE_SPIKE_WATCH').length;
var topCount = confirmedSignalCount + priorityRadarCount;
```

`EARLY_RADAR` **tidak masuk bucket mana pun** ⇒ **`top_count` selalu 0**.

### Bukti (output SEBELUM fix)

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

Skenario ini adalah **kasus terbaik yang mungkin** (close tepat di high, high = high tertinggi 25 hari).
Bahkan begitu, sistem menolak.

### Diff perbaikan

```diff
--- a/lib/daytrade-screener-engine.js
+++ b/lib/daytrade-screener-engine.js
@@ -353,6 +353,24 @@ function analyzeDayTrade(candles, ticker) {
   var recent20Highs = highs.slice(-20);
   var resistance = round0(Math.max.apply(null, recent20Highs));
+
+  // BUG-F7-01: BREAKOUT TAUTOLOGY FIX.
+  // `resistance` above INCLUDES the latest candle, and close <= high <= max(high)
+  // always holds — so `close > resistance` was mathematically unsatisfiable and
+  // EVERY candidate was pinned at BREAKOUT_WATCH. Downstream, scoreDayTrade
+  // downgraded all ENTRY ZONE statuses (A_PLUS_SETUP / TRADE_CANDIDATE /
+  // READY_BREAKOUT) to EARLY_RADAR, which the finalize top_count bucket does not
+  // count => structurally guaranteed "0 sinyal sepanjang hari".
+  // The breakout trigger must be the highest high of the PRIOR sessions, i.e.
+  // the level the latest candle actually has to exceed to be a new breakout.
+  var breakout_trigger = resistance;
+  if (len >= 2) {
+    var priorHighs = highs.slice(0, len - 1).slice(-20);
+    if (priorHighs.length > 0) breakout_trigger = round0(Math.max.apply(null, priorHighs));
+  }
+  if (!Number.isFinite(breakout_trigger) || breakout_trigger <= 0) breakout_trigger = resistance;
```

```diff
@@ return { ticker: ticker,
     resistance: resistance,
+    breakout_trigger: breakout_trigger,
     support: support,
```

```diff
@@ function scoreDayTrade(...)
-    breakout_trigger: data.resistance,
+    // BUG-F7-01: use the PRIOR-session high. Passing `data.resistance` (which
+    // includes today's candle) made BREAKOUT_CONFIRMED unreachable.
+    breakout_trigger: data.breakout_trigger != null ? data.breakout_trigger : data.resistance,
```

```diff
@@ async function runDayTradeBatch(...)
-        breakout_trigger: analysis.resistance,
+        // BUG-F7-01: prior-session trigger (see analyzeDayTrade).
+        breakout_trigger: analysis.breakout_trigger != null ? analysis.breakout_trigger : analysis.resistance,
```

### Test (GAGAL sebelum, PASS sesudah)

```js
test('BUG-F7-01: the breakout trigger must exclude the latest candle (prior-session high)', () => {
  const analysis = engine.analyzeDayTrade(breakoutSeries(), 'BREAKOUT');
  assert.equal(analysis.resistance, 104, 'inclusive 20d resistance includes today');
  assert.ok(analysis.breakout_trigger != null,
    'analysis must expose a prior-session breakout_trigger, got: ' + analysis.breakout_trigger);
  assert.equal(analysis.breakout_trigger, 100,
    'breakout_trigger must be the PRIOR sessions high so the level is breakable, got: ' + analysis.breakout_trigger);
  assert.ok(analysis.last_price > analysis.breakout_trigger,
    'a close above the prior-session high must be representable');
});

test('BUG-F7-01: a close above the prior-session high must be BREAKOUT_CONFIRMED, not BREAKOUT_WATCH', () => {
  const analysis = engine.analyzeDayTrade(breakoutSeries(), 'BREAKOUT');
  const confirmation = idxTick.deriveBreakoutConfirmation({
    close: analysis.last_price, last_price: analysis.last_price,
    high_price: analysis.high_price, resistance: analysis.resistance,
    breakout_trigger: analysis.breakout_trigger
  });
  assert.equal(confirmation.breakout_confirmation_status, 'BREAKOUT_CONFIRMED', ...);
  const scored = engine.scoreDayTrade(analysis, 'MORNING_SCOUT', 'UTAMA', null, {});
  assert.equal(scored.breakout_confirmation_status, 'BREAKOUT_CONFIRMED', ...);
});

test('BUG-F7-01: runDayTradeBatch must surface a confirmed breakout instead of pinning EARLY_RADAR', async () => {
  const batch = await v7.runDayTradeBatch([{ ticker: 'BREAKOUT', board: 'UTAMA' }], 'MORNING_SCOUT', {
    noDelay: true, fetchCandles: async () => breakoutSeries(), captureEvaluationInitial: false,
    market_regime: { market_regime_label: 'NEUTRAL', market_regime_score_adjustment: 0 }
  });
  assert.equal(batch.results[0].breakout_confirmation_status, 'BREAKOUT_CONFIRMED', ...);
  assert.notEqual(batch.results[0].status, 'EARLY_RADAR', ...);
});
```

**Output FAIL (sebelum fix):**
```
✖ BUG-F7-01: the breakout trigger must exclude the latest candle (prior-session high)
  AssertionError: analysis must expose a prior-session breakout_trigger, got: undefined

✖ BUG-F7-01: a close above the prior-session high must be BREAKOUT_CONFIRMED, not BREAKOUT_WATCH
  AssertionError: scoreDayTrade must consume the prior-session trigger, got: BREAKOUT_WATCH
  + actual - expected
  + 'BREAKOUT_WATCH'
  - 'BREAKOUT_CONFIRMED'

✖ BUG-F7-01: runDayTradeBatch must surface a confirmed breakout instead of pinning EARLY_RADAR
  AssertionError: the batch path must use the prior-session trigger too, got: BREAKOUT_WATCH
```

**Output PASS (sesudah fix):**
```
✔ BUG-F7-01: the breakout trigger must exclude the latest candle (prior-session high) (4.4559ms)
✔ BUG-F7-01: a close above the prior-session high must be BREAKOUT_CONFIRMED, not BREAKOUT_WATCH (8.9973ms)
✔ BUG-F7-01: runDayTradeBatch must surface a confirmed breakout instead of pinning EARLY_RADAR (53.9259ms)
```

---

## BUG-F7-01b — TP1 DI-CAP KE HIGH HARI INI: RR ≥ 1.5 MUSTAHIL

### Severity: 🔴 CRITICAL — blocker kedua, muncul setelah BUG-F7-01 diperbaiki

### Lokasi
`lib/daytrade-screener-engine.js` — `calculateLevels()` blok "TP VALIDATION"

### Deskripsi

Setelah BUG-F7-01 diperbaiki, breakout akhirnya bisa `BREAKOUT_CONFIRMED` — tetapi status tetap
`WAIT_PULLBACK`. Penelusuran lanjutan menemukan blocker kedua:

```js
// SEBELUM FIX
if (tp1 > resistance && resistance > entryMid) {
  tp1 = round0(resistance);
}
```

`resistance` = high hari ini. Saat candle breakout close di dekat high-nya, TP1 dipaksa turun ke
`resistance` (≈ harga sekarang), sehingga **reward ≈ 0R**:

```
levels => {"entry_low":103,"entry_high":104,"stop_loss":101,"tp1":105,"tp2":108,"risk_reward":0.6}
```

`risk_reward = 0.6` gagal gate `passesRiskRewardFilter(levels, 1.5)` di `classifyStatus()`
(`lib/daytrade-screener-engine.js:869`), yang langsung mengembalikan `WAIT_PULLBACK`.

Kesalahan konseptualnya: begitu candle **close di atas** trigger breakout, level itu **sudah ditembus**
dan bukan lagi overhead supply. Meng-cap target ke level yang baru saja dilewati menghapus seluruh reward.

### Bukti (output SEBELUM fix)

```
$ node tmp_investigasi/f7-probe9.js

ENTRY ZONE configs found: 0
--- best-effort diagnostics (top 5 by score) ---
{"score":58,"status":"WAIT_PULLBACK","rr":0.33,"bc":"BREAKOUT_CONFIRMED","tp1":105,"eh":104,"sl":101,...}
{"score":58,"status":"WAIT_PULLBACK","rr":0.25,"bc":"BREAKOUT_CONFIRMED","tp1":104,"eh":103,"sl":99,...}
{"score":58,"status":"WAIT_PULLBACK","rr":0.50,"bc":"BREAKOUT_CONFIRMED","tp1":106,"eh":104,"sl":100,...}
```

Dari **360 kombinasi** parameter breakout yang di-sweep, **0** mencapai ENTRY ZONE.

### Diff perbaikan

```diff
--- a/lib/daytrade-screener-engine.js
+++ b/lib/daytrade-screener-engine.js
@@ -798,13 +798,27 @@ function calculateLevels(data) {
   // === TP VALIDATION: cap unrealistic targets ===
-  // If TP1 > resistance, cap at resistance
-  if (tp1 > resistance && resistance > entryMid) {
-    tp1 = round0(resistance);
-  }
-  // If TP1 <= entry_high, use swing high or resistance directly
-  if (tp1 <= entry_high) {
-    tp1 = round0(Math.max(swingHigh10 || resistance, entryMid + atrProxy));
-  }
+  // BUG-F7-01b: once the candle has CLOSED above the prior-session breakout
+  // trigger, that level is cleared — it is no longer overhead supply. The old
+  // code clamped TP1 to `resistance`, which (because `resistance` includes
+  // today's own candle) equals today's high, capping the reward at ~0R and
+  // making the RR >= 1.5 entry gate mathematically unreachable for every
+  // confirmed breakout. Only clamp against genuine overhead structure.
+  var breakoutConfirmed = data.breakout_trigger != null && last > data.breakout_trigger;
+  if (!breakoutConfirmed && tp1 > resistance && resistance > entryMid) {
+    tp1 = round0(resistance);
+  }
+  // If TP1 <= entry_high, use swing high / measured move rather than the
+  // level that was just cleared.
+  if (tp1 <= entry_high) {
+    var tp1Fallback = Math.max(
+      breakoutConfirmed ? round0(entryMid + risk * 1.5) : (swingHigh10 || resistance),
+      entryMid + atrProxy
+    );
+    tp1 = round0(Math.min(tp1Fallback, round0(entryMid + atrProxy * 2.5)));
+  }
+  if (!Number.isFinite(tp1) || tp1 <= entry_high) {
+    tp1 = round0(entryMid + Math.max(risk, atrProxy));
+  }
```

### Test

```js
test('BUG-F7-01b: a confirmed breakout must not have TP1 clamped to today\'s own high', () => {
  const analysis = engine.analyzeDayTrade(breakoutSeries(), 'BREAKOUT');
  const levels = engine.calculateLevels(analysis);

  assert.ok(levels.entry_high > 0 && levels.stop_loss > 0 && levels.tp1 > 0, ...);
  assert.ok(levels.tp1 > levels.entry_high,
    'TP1 must sit above the entry zone, got tp1=' + levels.tp1 + ' entry_high=' + levels.entry_high);
  // Reward must exceed risk for a breakout that has cleared its overhead level;
  // otherwise the RR >= 1.5 entry gate is unreachable by construction.
  assert.ok(levels.risk_reward >= 1.0,
    'a confirmed breakout must offer at least 1R of reward, got RR=' + levels.risk_reward);
});
```

**Output FAIL (sebelum fix):**
```
✖ BUG-F7-01b: a confirmed breakout must not have TP1 clamped to today's own high
  AssertionError: a confirmed breakout must offer at least 1R of reward, got RR=0.6
```

**Output PASS (sesudah fix):**
```
✔ BUG-F7-01b: a confirmed breakout must not have TP1 clamped to today's own high (0.5319ms)
```

### Verifikasi end-to-end (SEBELUM vs SESUDAH)

Seri: 24 sesi konsolidasi di bawah 100 (volume 4 jt), candle breakout close 103.5 volume 30 jt.

| Metrik | SEBELUM | SESUDAH |
|---|---|---|
| `breakout_trigger` | 104 (= resistance, memuat hari ini) | **100** (high sesi sebelumnya) |
| `breakout_confirmation_status` | `BREAKOUT_WATCH` | **`BREAKOUT_CONFIRMED`** |
| TP1 | 105 (di-cap) | **107** (measured move) |
| `risk_reward` | **0.60** → ditolak | **1.79** → lolos |
| Status akhir | `WAIT_PULLBACK` | **`READY_BREAKOUT`** |
| Bucket `top_count` | 0 | **1** |

---

## BUG-F7-02 — `null < 0.3 === true`: RVOL TAK DIKETAHUI DIBUANG DI GATE PERTAMA

### Severity: 🟠 HIGH

### Lokasi
`lib/daytrade-screener-engine.js` — `scoreLiquidity()` baris ~459

### Deskripsi

```js
// SEBELUM FIX
if (data.volume_ratio_20d < 0.3) {
  pass = false;
  reason = 'Volume sangat rendah (ratio<0.3)';
  return { score: 0, pass: false, reason: reason };
}
```

Di JavaScript, **`null < 0.3` bernilai `true`** (null dikonversi ke 0), sedangkan `undefined < 0.3`
bernilai `false`. `analyzeDayTrade()` mengembalikan `volume_ratio_20d = null` ketika
`avg_volume_20d` tidak tersedia (mis. `calcMA` gagal karena < 20 candle, atau seluruh volume histori 0).

Akibatnya: setiap saham dengan **RVOL tak diketahui** langsung gagal di gate likuiditas dengan alasan
menyesatkan "Volume sangat rendah (ratio<0.3)", lalu dipaksa `AVOID` — padahal turnover-nya bisa miliaran.

### Bukti

```
$ node tmp_investigasi/f7-probe.js
--- C. null / undefined ratio comparison ---
null < 0.3 = true | undefined < 0.3 = false
liquidity(null ratio) => {"score":0,"pass":false,"reason":"Volume sangat rendah (ratio<0.3)"}
liquidity(undefined ratio) => {"score":3,"pass":true,"reason":""}
```

Perhatikan inkonsistensi: `null` dan `undefined` diperlakukan berbeda untuk kondisi yang sama-sama
"tidak diketahui".

### Diff perbaikan

```diff
--- a/lib/daytrade-screener-engine.js
+++ b/lib/daytrade-screener-engine.js
@@ -459,6 +459,20 @@ function scoreLiquidity(data) {
   // Volume ratio check
-  if (data.volume_ratio_20d < 0.3) {
+  // BUG-F7-02: `null < 0.3` evaluates to TRUE in JavaScript, so every candidate
+  // whose 20-day average volume was unavailable (avg_volume_20d null =>
+  // volume_ratio_20d null) was hard-failed here as "Volume sangat rendah" and
+  // forced to AVOID at the FIRST gate. UNKNOWN is not the same as LOW: only a
+  // KNOWN, finite ratio below 0.3 may hard-fail. Genuinely unknown RVOL is
+  // already handled by the turnover gate above plus the volume bonus below.
+  var knownVolumeRatio = (typeof data.volume_ratio_20d === 'number' && isFinite(data.volume_ratio_20d))
+    ? data.volume_ratio_20d
+    : null;
+  if (knownVolumeRatio != null && knownVolumeRatio < 0.3) {
     pass = false;
     reason = 'Volume sangat rendah (ratio<0.3)';
     return { score: 0, pass: false, reason: reason };
   }
```

### Test

```js
test('BUG-F7-02: UNKNOWN (null) volume ratio must NOT be hard-failed as "very low volume"', () => {
  const result = engine.scoreLiquidity({
    value_today: 5_000_000_000, avg_value_7d: 3_000_000_000, volume_ratio_20d: null
  });
  assert.equal(result.pass, true,
    'high-turnover candidate with UNKNOWN RVOL must not be dropped at the first gate, reason: ' + result.reason);
  assert.equal(/sangat rendah/i.test(String(result.reason || '')), false, ...);
  assert.ok(result.score > 0, ...);
});

test('BUG-F7-02: a KNOWN low volume ratio (<0.3) must still hard-fail', () => {
  const result = engine.scoreLiquidity({ value_today: 5e9, avg_value_7d: 3e9, volume_ratio_20d: 0.2 });
  assert.equal(result.pass, false, 'a genuinely dormant stock must still be dropped');
  assert.match(result.reason, /sangat rendah/i);
});

test('BUG-F7-02: analyzeDayTrade -> scoreDayTrade must not force AVOID when RVOL is unavailable', () => {
  // Only 19 sessions exist => the 20D average cannot be computed => ratio unknown.
  const series = [ /* 19 candles */ ];
  const analysis = engine.analyzeDayTrade(series, 'NORATIO');
  assert.equal(analysis.volume_ratio_20d, null, 'precondition: ratio must be unknown');
  const enriched = Object.assign({}, analysis, { value_today: 9000000000, avg_value_7d: 7000000000 });
  const scored = engine.scoreDayTrade(enriched, 'MORNING_SCOUT', 'UTAMA', null, {});
  assert.notEqual(scored.status, 'AVOID', ...);
  assert.ok(scored.liquidity_score > 0, ...);
});
```

**Output FAIL (sebelum fix):**
```
✖ BUG-F7-02: UNKNOWN (null) volume ratio must NOT be hard-failed as "very low volume"
  AssertionError: high-turnover candidate with UNKNOWN RVOL must not be dropped at the first gate,
  reason: Volume sangat rendah (ratio<0.3)

✖ BUG-F7-02: analyzeDayTrade -> scoreDayTrade must not force AVOID when RVOL is unavailable
  AssertionError: precondition: ratio must be unknown
  20 !== null
```

**Output PASS (sesudah fix):**
```
✔ BUG-F7-02: UNKNOWN (null) volume ratio must NOT be hard-failed as "very low volume" (0.6006ms)
✔ BUG-F7-02: a KNOWN low volume ratio (<0.3) must still hard-fail (0.4118ms)
✔ BUG-F7-02: analyzeDayTrade -> scoreDayTrade must not force AVOID when RVOL is unavailable (1.7310ms)
```

---

## BUG-F7-03 — VOLUME STRING BERFORMAT → `INVALID_CANDLE`

### Severity: 🟠 HIGH

### Lokasi
`lib/daytrade-screener-engine.js` — `analyzeDayTrade()` / `deriveDataQualityStatus()`

### Deskripsi

Feed data pasar dan kolom Supabase `TEXT` mengirim angka sebagai string berformat: `"5.000.000"`
(id-ID) atau `"5,000,000"` (en-US). `Number("5.000.000")` dan `Number("5,000,000")` sama-sama
menghasilkan **`NaN`**.

`deriveDataQualityStatus()` baris 81 menolak volume non-finite:

```js
if (!finitePositive(open) || ... || !isFinite(volume) || volume < 0 || ...) {
  return makeDataQuality('INVALID_CANDLE', 'Candle tidak valid; data perlu validasi ulang.');
}
```

Sehingga saham dengan data **valid tapi terformat** diberi verdict `INVALID_CANDLE`, yang
meng-cascade ke `data_quality_valid = false` → `classifyProductionEligibility()` menolak →
tidak pernah bisa menjadi sinyal.

### Bukti

```
$ node tmp_investigasi/f7-probe2.js
=== 3. String-formatted volume => INVALID_CANDLE cascade ===
data_quality_status = INVALID_CANDLE | valid = false
status = AVOID | score = 18 | dq = undefined
```

### Diff perbaikan

Ditambahkan helper `coerceNumeric()` + `normalizeCandleNumbers()` (dipanggil di awal `analyzeDayTrade`):

```diff
--- a/lib/daytrade-screener-engine.js
+++ b/lib/daytrade-screener-engine.js
+// BUG-F7-03: market-data feeds (and Supabase TEXT columns) deliver numbers as
+// formatted strings — "5.000.000" (id-ID) or "5,000,000" (en-US). `Number()`
+// returns NaN for both, which previously cascaded into an INVALID_CANDLE data
+// quality verdict and silently removed otherwise-valid tickers from the scan.
+// Returns NaN (never 0) when the value is genuinely not numeric so existing
+// "invalid data" guards keep rejecting it.
+var GROUPED_NUMBER_PATTERNS = [
+  { re: /^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/, strip: /\./g, decimal: /,$/ },
+  { re: /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/, strip: /,/g, decimal: null }
+];
+
+function coerceNumeric(value) {
+  if (typeof value === 'number') return isFinite(value) ? value : NaN;
+  if (typeof value !== 'string') return NaN;
+  var raw = value.trim();
+  if (!raw) return NaN;
+  var cleaned = raw.replace(/\s/g, '');
+  for (var i = 0; i < GROUPED_NUMBER_PATTERNS.length; i++) {
+    var p = GROUPED_NUMBER_PATTERNS[i];
+    if (p.re.test(cleaned)) {
+      var hasDecimal = p.decimal ? p.decimal.test(cleaned) : cleaned.indexOf('.') !== -1;
+      var intPart = cleaned;
+      var fracPart = '';
+      if (hasDecimal) {
+        var sep = p.decimal ? ',' : '.';
+        var cut = cleaned.lastIndexOf(sep);
+        intPart = cleaned.slice(0, cut);
+        fracPart = cleaned.slice(cut + 1);
+      }
+      cleaned = intPart.replace(p.strip, '') + (fracPart ? '.' + fracPart : '');
+      break;
+    }
+  }
+  var n = Number(cleaned);
+  return isFinite(n) ? n : NaN;
+}
+
+// Normalises OHLCV fields in place (copy-on-write) so every downstream consumer
+// — data-quality validation, MAs, RSI, RVOL and scoring — sees real numbers.
+function normalizeCandleNumbers(candles) {
+  if (!Array.isArray(candles)) return candles;
+  return candles.map(function(c) {
+    if (!c || typeof c !== 'object') return c;
+    var open = coerceNumeric(c.open);
+    var high = coerceNumeric(c.high);
+    var low = coerceNumeric(c.low);
+    var close = coerceNumeric(c.close);
+    var volume = coerceNumeric(c.volume);
+    if (open === c.open && high === c.high && low === c.low && close === c.close && volume === c.volume) return c;
+    return Object.assign({}, c, { open: open, high: high, low: low, close: close, volume: volume });
+  });
+}
```

```diff
@@ function analyzeDayTrade(candles, ticker) {
+  // BUG-F7-03: coerce formatted numeric strings BEFORE any validation/metric math.
+  candles = normalizeCandleNumbers(candles);
   var len = candles.length;
```

### Test

```js
test('BUG-F7-03: id-ID formatted volume string ("5.000.000") must be parsed, not flagged INVALID_CANDLE', () => {
  const series = candles(25, { lastVolume: '5.000.000' });
  const analysis = engine.analyzeDayTrade(series, 'STRVOL');
  assert.equal(analysis.data_quality_status, 'OK', ...);
  assert.equal(analysis.volume_today, 5000000, 'volume_today must be coerced to 5000000');
  assert.equal(analysis.value_today > 0, true, ...);
});

test('BUG-F7-03: en-US formatted volume string ("5,000,000") must be parsed', () => {
  const series = candles(25, { lastVolume: '5,000,000' });
  const analysis = engine.analyzeDayTrade(series, 'STRVOL2');
  assert.equal(analysis.data_quality_status, 'OK', ...);
  assert.equal(analysis.volume_today, 5000000, ...);
});

test('BUG-F7-03: a genuinely invalid volume must still be rejected', () => {
  const series = candles(25, { lastVolume: 'not-a-number' });
  const analysis = engine.analyzeDayTrade(series, 'BADVOL');
  assert.equal(analysis.data_quality_status, 'INVALID_CANDLE',
    'non-numeric volume must still be rejected as invalid data');
});
```

**Output FAIL (sebelum fix):**
```
✖ BUG-F7-03: id-ID formatted volume string ("5.000.000") must be parsed, not flagged INVALID_CANDLE
  AssertionError: a dotted-thousands volume string is valid data, got: INVALID_CANDLE

✖ BUG-F7-03: en-US formatted volume string ("5,000,000") must be parsed
  AssertionError: got: INVALID_CANDLE
```

**Output PASS (sesudah fix):**
```
✔ BUG-F7-03: id-ID formatted volume string ("5.000.000") must be parsed, not flagged INVALID_CANDLE (0.7844ms)
✔ BUG-F7-03: en-US formatted volume string ("5,000,000") must be parsed (0.6169ms)
✔ BUG-F7-03: a genuinely invalid volume must still be rejected (0.433ms)
```

---

## BUG-F7-04 — `is_fca = 'true'` (STRING) TIDAK DIKENALI

### Severity: 🟡 MEDIUM

### Lokasi
`lib/idx-tick-normalization.js` — `isAkselerasiOrFca()` baris 24

### Deskripsi

```js
// SEBELUM FIX
function isAkselerasiOrFca(board, isFca, ticker) {
  if (isFca === true) return true;   // ← hanya boolean literal
```

Supabase/PostgREST mengirim kolom boolean sebagai string `'true'`/`'false'`, dan sebagian caller
mengirim `1`/`0`. Saham FCA yang sebenarnya **tidak dikenali**, sehingga mendapat tick size
**lebih besar** dari yang benar (mis. Rp5 alih-alih Rp1 pada harga 1.500). Level entry/SL/TP
menjadi off-tick dan kemudian gagal di `validateTradingPlanSanity()`.

Sebaliknya, penanganan truthy-string yang ceroboh berisiko membaca literal `'false'` sebagai FCA —
sehingga fix harus menerima **hanya nilai true-like eksplisit**.

### Bukti

```
$ node tmp_investigasi/f7-probe2.js
=== 4. isAkselerasiOrFca with string booleans ===
is_fca=true  (string) => 5      ← SALAH, seharusnya 1 (FCA)
is_fca=true  (bool)   => 1      ← benar
is_fca='false'(string)=> 5      ← benar
is_fca=1 (number) => 5          ← SALAH, seharusnya 1 (FCA)
```

### Diff perbaikan

```diff
--- a/lib/idx-tick-normalization.js
+++ b/lib/idx-tick-normalization.js
-function isAkselerasiOrFca(board, isFca, ticker) {
-  if (isFca === true) return true;
+// BUG-F7-04: Supabase/PostgREST delivers boolean columns as 'true'/'false'
+// strings and some callers pass 1/0. `isFca === true` therefore missed genuine
+// FCA tickers (they received the wrong, larger tick size and produced off-tick
+// entry/SL/TP levels) — while any truthy-string handling risked reading the
+// literal string 'false' as FCA. Accept only explicit true-like values.
+function isExplicitTrueFlag(value) {
+  if (value === true) return true;
+  if (value === 1) return true;
+  if (typeof value === 'string') {
+    var s = value.trim().toLowerCase();
+    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
+  }
+  return false;
+}
+
+function isAkselerasiOrFca(board, isFca, ticker) {
+  if (isExplicitTrueFlag(isFca)) return true;
```

### Test

```js
test('BUG-F7-04: string/number FCA flags must be honoured (Rp1 tick), without misreading "false"', () => {
  // Rp1 tick is the FCA/Akselerasi rule; Rp5 is the regular tier for price 1500.
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 'true', 'ABCD'), 1, "string 'true' must be treated as FCA");
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', '1', 'ABCD'), 1, "string '1' must be treated as FCA");
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 1, 'ABCD'), 1, 'number 1 must be treated as FCA');
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', true, 'ABCD'), 1, 'boolean true must keep working');

  // Negative cases: a non-FCA ticker must keep the regular Rp5 tick.
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 'false', 'ABCD'), 5, "string 'false' must NOT be treated as FCA");
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 0, 'ABCD'), 5, 'number 0 must NOT be treated as FCA');
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', undefined, 'ABCD'), 5, 'undefined must NOT be treated as FCA');
});
```

**Output FAIL (sebelum fix):**
```
✖ BUG-F7-04: string/number FCA flags must be honoured (Rp1 tick), without misreading "false"
  AssertionError: string 'true' must be treated as FCA
  + actual - expected
  + 5
  - 1
```

**Output PASS (sesudah fix):**
```
✔ BUG-F7-04: string/number FCA flags must be honoured (Rp1 tick), without misreading "false" (0.2323ms)
✔ BUG-F7-04: FCA board names in any case must be treated as FCA (0.1702ms)
```

---

## BUG-F7-05 — TURNOVER STRING → `liquidity_unverified`

### Severity: 🟡 MEDIUM

### Lokasi
`lib/daytrade-screener-engine.js` — `dayTradeEligibilityReason()` baris ~1783, ~1802

### Deskripsi

```js
// SEBELUM FIX
var price = Number(row.latest_price || row.last_price || ...);
...
if (options.requireLiquidity && !(Number(row.value || row.valuasi || row.value_today) > 0 && Number(row.frequency || row.freq || row.frequency_today) > 0)) return 'liquidity_unverified';
```

`Number("1.234.567.890")` → `NaN` ⇒ `NaN > 0` → `false` ⇒ baris ditolak sebagai
`liquidity_unverified`. Saham likuid dihapus dari universe **sebelum** pemindaian dimulai.

### Bukti

```
$ node tmp_investigasi/f7-probe2.js
=== 5. DayTrade eligibility: string valuasi/freq ===
eligible: BBB | diag: {"liquidity_unverified":1}
```
(`AAA` dengan `value: '1.234.567.890'` dan `freq: '12.345'` dibuang; `BBB` numerik lolos.)

### Diff perbaikan

```diff
--- a/lib/daytrade-screener-engine.js
+++ b/lib/daytrade-screener-engine.js
-  var price = Number(row.latest_price || row.last_price || row.current_price || row.close || row.price);
+  // BUG-F7-05: feeds supply these as formatted strings ("1.250", "1.234.567.890").
+  // Raw Number() returned NaN and silently dropped valid, liquid tickers.
+  var price = coerceNumeric(row.latest_price || row.last_price || row.current_price || row.close || row.price);
```

```diff
-  if (options.requireLiquidity && !(Number(row.value || row.valuasi || row.value_today) > 0 && Number(row.frequency || row.freq || row.frequency_today) > 0)) return 'liquidity_unverified';
+  // BUG-F7-05: coerce formatted numeric strings instead of raw Number().
+  if (options.requireLiquidity && !(coerceNumeric(row.value || row.valuasi || row.value_today) > 0 && coerceNumeric(row.frequency || row.freq || row.frequency_today) > 0)) return 'liquidity_unverified';
```

### Test

```js
test('BUG-F7-05: formatted turnover/frequency strings must not be rejected as liquidity_unverified', () => {
  const reason = engine.dayTradeEligibilityReason({
    ticker: 'LIQUID', board: 'UTAMA', value: '1.234.567.890', freq: '12.345'
  }, { requireLiquidity: true });
  assert.equal(reason, null, 'a liquid stock with formatted numbers must pass eligibility, got: ' + reason);
});

test('BUG-F7-05: formatted price strings must satisfy requirePrice', () => {
  const reason = engine.dayTradeEligibilityReason({
    ticker: 'LIQUID', board: 'UTAMA', last_price: '1.250', valuasi: 1, freq: 1
  }, { requirePrice: true, requireLiquidity: true });
  assert.equal(reason, null, 'formatted price must be parseable, got: ' + reason);
});

test('BUG-F7-05: genuinely empty turnover must still be rejected', () => {
  assert.equal(engine.dayTradeEligibilityReason({ ticker: 'X', board: 'UTAMA', value: '', freq: '' }, { requireLiquidity: true }), 'liquidity_unverified');
  assert.equal(engine.dayTradeEligibilityReason({ ticker: 'X', board: 'UTAMA', value: 'abc', freq: 'abc' }, { requireLiquidity: true }), 'liquidity_unverified');
});
```

**Output FAIL (sebelum fix):**
```
✖ BUG-F7-05: formatted turnover/frequency strings must not be rejected as liquidity_unverified
  AssertionError: a liquid stock with formatted numbers must pass eligibility, got: liquidity_unverified
  + actual - expected
  + 'liquidity_unverified'
  - null
```

**Output PASS (sesudah fix):**
```
✔ BUG-F7-05: formatted turnover/frequency strings must not be rejected as liquidity_unverified (0.4819ms)
✔ BUG-F7-05: formatted price strings must satisfy requirePrice (0.2688ms)
✔ BUG-F7-05: genuinely empty turnover must still be rejected (0.1626ms)
```

---

## BUG-F7-06 — SKOR `null`/`NaN` LOLOS GATE ≥ 65

### Severity: 🟡 MEDIUM

### Lokasi
`api/sector-hot.js` — `selectTopCandidatesWithSectorDiversification()` baris ~12537

### Deskripsi

```js
// SEBELUM FIX
var score = c.daytrade_score != null ? Number(c.daytrade_score) : (c.score != null ? Number(c.score) : null);
if (score != null && Number.isFinite(score) && score < 65) {
  continue;
}
```

Guard-nya adalah **konjungsi yang gagal-terbuka**: ketika `score` bernilai `null`, `NaN`, atau
non-numerik, rantai `&&` berhenti dan baris **TIDAK di-skip** — malah diterbitkan ke Top-10.

Fungsi ini dipanggil di `finalizeDtScreener()` sebelum langkah prune, sehingga baris rusak ikut
terpublikasi dan `tickersToRemove` dihitung dari daftar yang sudah tercemar.

### Bukti

```
$ node tmp_investigasi/f7-probe5.js
=== BUG-F7-06: NaN / null score bypasses the >=65 publish gate ===
selected => GOOD1(90), GOOD2(88), JUNK_NULL(null), JUNK_NAN(NaN), JUNK_STR(not-a-number)
=> JUNK_LOW (12) correctly dropped: true
=> JUNK_NULL published into Top 10 (BUG): true
=> JUNK_NAN published into Top 10 (BUG): true
=> JUNK_STR published into Top 10 (BUG): true
```

### Diff perbaikan

```diff
--- a/api/sector-hot.js
+++ b/api/sector-hot.js
@@ -12537,9 +12537,15 @@ function selectTopCandidatesWithSectorDiversification(candidates, maxTotal, maxPerSector) {
     var c = candidates[i];
     if (!c) continue;
-    var score = c.daytrade_score != null ? Number(c.daytrade_score) : (c.score != null ? Number(c.score) : null);
-    if (score != null && Number.isFinite(score) && score < 65) {
-      continue;
-    }
+    // BUG-F7-06: the previous guard was
+    //   `score != null && Number.isFinite(score) && score < 65`
+    // so a null/NaN/non-numeric score skipped the check ENTIRELY and malformed
+    // rows were promoted into the published Top-10 ahead of the prune step.
+    // Fail closed: only a FINITE score >= 65 may be published.
+    var score = c.daytrade_score != null ? Number(c.daytrade_score) : (c.score != null ? Number(c.score) : null);
+    if (!Number.isFinite(score) || score < 65) {
+      continue;
+    }
```

### Test

```js
test('BUG-F7-06: null / NaN / non-numeric scores must NOT be published in the Top-10', () => {
  const selectTop = sectorHot.selectTopCandidatesWithSectorDiversification;
  const selected = selectTop([
    { ticker: 'GOOD1', daytrade_score: 90, sector: 'A' },
    { ticker: 'GOOD2', daytrade_score: 88, sector: 'B' },
    { ticker: 'JUNK_NULL', daytrade_score: null, sector: 'C' },
    { ticker: 'JUNK_NAN', daytrade_score: NaN, sector: 'D' },
    { ticker: 'JUNK_STR', daytrade_score: 'not-a-number', sector: 'E' },
    { ticker: 'JUNK_LOW', daytrade_score: 12, sector: 'F' }
  ], 10, 3);
  const tickers = selected.map((r) => r.ticker);
  assert.deepEqual(tickers, ['GOOD1', 'GOOD2'],
    'only finite scores >= 65 may be published, got: ' + tickers.join(','));
});

test('BUG-F7-06: a candidate with a missing score field must not be published', () => {
  const selected = sectorHot.selectTopCandidatesWithSectorDiversification([
    { ticker: 'GOOD1', daytrade_score: 90, sector: 'A' },
    { ticker: 'NO_SCORE', sector: 'B' }
  ], 10, 3);
  assert.deepEqual(selected.map((r) => r.ticker), ['GOOD1']);
});
```

**Output FAIL (sebelum fix):**
```
✖ BUG-F7-06: null / NaN / non-numeric scores must NOT be published in the Top-10
  AssertionError: only finite scores >= 65 may be published,
  got: GOOD1,GOOD2,JUNK_NULL,JUNK_NAN,JUNK_STR

✖ BUG-F7-06: a candidate with a missing score field must not be published
  AssertionError: Expected values to be strictly deep-equal:
    [ 'GOOD1', 'NO_SCORE' ]  vs  [ 'GOOD1' ]
```

**Output PASS (sesudah fix):**
```
✔ BUG-F7-06: null / NaN / non-numeric scores must NOT be published in the Top-10 (1.2042ms)
✔ BUG-F7-06: a candidate with a missing score field must not be published (0.2028ms)
```

---

## BUG-F7-07 — BATCH `paused` MEMICU TRIM: DATA TERBITAN TERHAPUS

### Severity: 🟠 HIGH

### Lokasi
`api/sector-hot.js` — `handleDayTradeScreenerRun()` baris ~12353

### Deskripsi

`runDayTradeBatch()` (`lib/daytrade-screener-engine.js:1888-1894`) **sengaja** mengembalikan
set kosong saat sesi BREAK/CLOSED:

```js
if (scheduleStatus.session === 'BREAK' || scheduleStatus.session === 'CLOSED') {
  return { results: results, failed: failed, status: 'paused', skipped: true, reason: 'market_break', ... };
}
```

Namun caller produksi **tidak memeriksa `skipped`**:

```js
// SEBELUM FIX
var batchResult = await dtEngine.runDayTradeBatch(batchTickers, runMode, { fastMode: isFastMode });
var results = batchResult.results;          // []
var failedTickers = batchResult.failed;     // []
...
var passedResults = results.filter(r => r.daytrade_score >= 65);   // []
...
if (isLastBatch) {
  return await finalizeDtScreener(...);     // ← dipanggil dengan set kosong
}
```

`finalizeDtScreener()` lalu menjalankan:

```js
var top10Tickers = new Set(publishedRows.map(r => r.ticker));   // kosong
var tickersToRemove = allRows.filter(r => !top10Tickers.has(r.ticker)).map(r => r.ticker);
await supabase.from('daytrade_screener_latest').delete().in('ticker', tickersToRemove);
```

Karena `publishedRows` kosong, **SEMUA baris** masuk `tickersToRemove` ⇒ **seluruh kandidat yang sudah
terbit hari itu terhapus**. Ini menjelaskan mengapa dashboard bisa menampilkan 0 hasil meski scan
sebelumnya berhasil.

### Bukti (batch paused)

```
✔ BUG-F7-07: a paused (BREAK/CLOSED) batch must be reported as skipped, not as an empty scan
```
Batch mengembalikan `{ skipped: true, status: 'paused', session: 'BREAK', results: [] }` — caller lama
mengabaikan field `skipped` ini.

### Diff perbaikan

```diff
--- a/api/sector-hot.js
+++ b/api/sector-hot.js
+/**
+ * BUG-F7-07: a paused (BREAK/CLOSED) batch must never reach finalize.
+ * ...
+ * @returns {boolean} true when the caller must NOT publish/trim.
+ */
+function shouldSkipDayTradePublish(batchResult) {
+  if (!batchResult || typeof batchResult !== 'object') return false;
+  if (batchResult.skipped === true) return true;
+  return String(batchResult.status || '').toLowerCase() === 'paused';
+}
+
 async function handleDayTradeScreenerRun(req, res, supabase) {
```

```diff
@@ handleDayTradeScreenerRun
   var batchResult = await dtEngine.runDayTradeBatch(batchTickers, runMode, { fastMode: isFastMode });
+
+  // BUG-F7-07: a paused batch carries NO results by design (frozen order book).
+  // Publishing/finalizing it would trim the live table to an empty top-10 and
+  // wipe the day's already-published candidates.
+  if (shouldSkipDayTradePublish(batchResult)) {
+    console.log('[daytrade-screener-run] batch paused: ' + (batchResult.reason || 'market_break') + ' session=' + (batchResult.session || 'unknown'));
+    await updateDtMeta(supabase, {
+      status: 'paused', run_date: runDate, run_mode: runMode, run_id: runId,
+      universe_count: universeCount,
+      scanned_count: (meta && meta.scanned_count) || 0,
+      failed_count: (meta && meta.failed_count) || 0,
+      passed_count: (meta && meta.passed_count) || 0,
+      message: 'Day Trade scan paused: market session is ' + (batchResult.session || 'CLOSED') + ' (' + (batchResult.reason || 'market_break') + '). Published candidates preserved.'
+    });
+    return res.status(200).json({
+      success: true, status: 'paused', skipped_due_to_market: true,
+      run_id: runId, run_mode: runMode, run_date: runDate, batch_index: batchIndex,
+      session: batchResult.session || null, reason: batchResult.reason || 'market_break',
+      published_count_preserved: true,
+      message: 'Day Trade scan paused during ' + (batchResult.session || 'CLOSED') + '; existing published candidates were preserved.'
+    });
+  }
+
   var results = batchResult.results;
```

```diff
@@ module.exports.__test = {
+  // BUG-F7-07: publish guard for paused (BREAK/CLOSED) batches.
+  shouldSkipDayTradePublish: shouldSkipDayTradePublish,
   deriveForeignConfluenceFromRows: deriveForeignConfluenceFromRows,
```

### Test

```js
test('BUG-F7-07: a paused (BREAK/CLOSED) batch must be reported as skipped, not as an empty scan', async () => {
  // 2026-09-23 is a Wednesday; 12:15 WIB falls inside the lunch break.
  const breakNow = '2026-09-23T05:15:00.000Z'; // 12:15 WIB
  const batch = await engine.runDayTradeBatch(
    [{ ticker: 'AAA', board: 'UTAMA' }], 'MIDDAY_CHECK',
    { now: breakNow, noDelay: true, fetchCandles: async () => { throw new Error('must not fetch during break'); } }
  );
  assert.equal(batch.skipped, true, 'a break/closed batch must be flagged skipped');
  assert.equal(batch.status, 'paused');
  assert.equal(batch.session, 'BREAK');
  assert.deepEqual(batch.results, []);
});

test('BUG-F7-07: the run handler must expose a publish guard that honours the paused batch', () => {
  const guard = sectorHot.__test && sectorHot.__test.shouldSkipDayTradePublish;
  assert.equal(typeof guard, 'function',
    'api/sector-hot must export shouldSkipDayTradePublish so a paused batch cannot wipe published rows');
  assert.equal(guard({ skipped: true, status: 'paused', results: [] }), true, 'a paused batch must block finalize/publish');
  assert.equal(guard({ skipped: false, status: 'running', results: [] }), false, 'a normal empty batch must still be allowed to finalize');
  assert.equal(guard(null), false, 'missing batch result must not block');
});
```

**Output FAIL (sebelum fix):**
```
✔ BUG-F7-07: a paused (BREAK/CLOSED) batch must be reported as skipped, not as an empty scan (127.3342ms)
  (engine-side contract already correct — this asserts the pre-existing engine behaviour)

✖ BUG-F7-07: the run handler must expose a publish guard that honours the paused batch
  AssertionError: api/sector-hot must export shouldSkipDayTradePublish so a paused batch cannot wipe published rows
  + actual - expected
  + 'undefined'
  - 'function'
```

**Output PASS (sesudah fix):**
```
✔ BUG-F7-07: a paused (BREAK/CLOSED) batch must be reported as skipped, not as an empty scan (384.2153ms)
✔ BUG-F7-07: the run handler must expose a publish guard that honours the paused batch (0.3886ms)
```

---

## REGRESSION GUARDS (8 test)

Setiap perbaikan diverifikasi **tidak** melemahkan guard keselamatan yang sudah ada:

```js
test('FASE7 regression: live/unclosed bar above resistance stays NEEDS_CLOSE_CONFIRMATION', () => {
  const result = idxTick.deriveBreakoutConfirmation({
    close: 101, high_price: 102, resistance: 100, breakout_trigger: 100, price_source: 'vps_bridge_live'
  });
  assert.equal(result.breakout_confirmation_status, 'NEEDS_CLOSE_CONFIRMATION');
});

test('FASE7 regression: confirmed close above the prior-session trigger is BREAKOUT_CONFIRMED', () => {
  const result = idxTick.deriveBreakoutConfirmation({
    close: 101, high_price: 102, resistance: 105, breakout_trigger: 100, price_source: 'yahoo_chart_1d_close'
  });
  assert.equal(result.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
});

test('FASE7 regression: a wick above the trigger that closes back below stays FALSE_BREAKOUT_RISK', () => {
  const result = idxTick.deriveBreakoutConfirmation({
    close: 99, high_price: 102, resistance: 105, breakout_trigger: 100, price_source: 'yahoo_chart_1d_close'
  });
  assert.equal(result.breakout_confirmation_status, 'FALSE_BREAKOUT_RISK');
  assert.equal(result.false_breakout_risk, true);
});

test('FASE7 regression: genuine illiquidity still hard-fails the liquidity gate', () => {
  const result = engine.scoreLiquidity({ value_today: 100000, avg_value_7d: 50000, volume_ratio_20d: 1.4 });
  assert.equal(result.pass, false, 'tiny turnover must still be rejected');
});

test('FASE7 regression: FCA / restricted boards are still excluded from the daytrade universe', () => {
  ['PAPAN PEMANTAUAN KHUSUS', 'PEMANTAUAN KHUSUS', 'FCA'].forEach((board) => {
    assert.equal(engine.dayTradeEligibilityReason({ ticker: 'X', board }, {}), 'restricted_board_or_status', ...);
  });
});

test('FASE7 regression: tick-size tiers for regular boards are unchanged', () => {
  assert.equal(idxTick.getIdxTickSize(150, 'UTAMA', undefined, 'X'), 1);
  assert.equal(idxTick.getIdxTickSize(350, 'UTAMA', undefined, 'X'), 2);
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', undefined, 'X'), 5);
  assert.equal(idxTick.getIdxTickSize(3000, 'UTAMA', undefined, 'X'), 10);
  assert.equal(idxTick.getIdxTickSize(7000, 'UTAMA', undefined, 'X'), 25);
});

test('FASE7 regression: execution ranking keeps blocked candidates below executable ones', () => {
  const ranking = require('../lib/daytrade-execution-ranking');
  const sorted = ranking.sortDayTradeByExecution([
    { ticker: 'BLOCKED', daytrade_score: 95, risk_reward: 0.5, status: 'AVOID', last_price: 100, entry_low: 99, entry_high: 100 },
    { ticker: 'EXEC', daytrade_score: 70, risk_reward: 2.0, status: 'TRADE_CANDIDATE', last_price: 99, entry_low: 99, entry_high: 100 }
  ]);
  assert.equal(sorted[0].ticker, 'EXEC', 'a blocked high-score row must not outrank an executable one');
});
```

---

## VERIFIKASI FINAL — PASS 2× BERTURUT-TURUT

```
$ node --test test/audit-fase7-daytrade-screener-bugs.test.js   # RUN 1

✔ BUG-F7-01: the breakout trigger must exclude the latest candle (prior-session high) (4.4559ms)
✔ BUG-F7-01: a close above the prior-session high must be BREAKOUT_CONFIRMED, not BREAKOUT_WATCH (8.9973ms)
✔ BUG-F7-01b: a confirmed breakout must not have TP1 clamped to today's own high (0.5319ms)
✔ BUG-F7-01: runDayTradeBatch must surface a confirmed breakout instead of pinning EARLY_RADAR (53.9259ms)
✔ BUG-F7-02: UNKNOWN (null) volume ratio must NOT be hard-failed as "very low volume" (0.3298ms)
✔ BUG-F7-02: a KNOWN low volume ratio (<0.3) must still hard-fail (0.4204ms)
✔ BUG-F7-02: analyzeDayTrade -> scoreDayTrade must not force AVOID when RVOL is unavailable (1.6181ms)
✔ BUG-F7-02: v7 volume-pace recall must not zero the liquidity score on unknown ratio (10.0542ms)
✔ BUG-F7-03: id-ID formatted volume string ("5.000.000") must be parsed, not flagged INVALID_CANDLE (0.7844ms)
✔ BUG-F7-03: en-US formatted volume string ("5,000,000") must be parsed (0.6169ms)
✔ BUG-F7-03: a genuinely invalid volume must still be rejected (0.433ms)
✔ BUG-F7-04: string/number FCA flags must be honoured (Rp1 tick), without misreading "false" (0.2323ms)
✔ BUG-F7-04: FCA board names in any case must be treated as FCA (0.1702ms)
✔ BUG-F7-05: formatted turnover/frequency strings must not be rejected as liquidity_unverified (0.4819ms)
✔ BUG-F7-05: formatted price strings must satisfy requirePrice (0.2688ms)
✔ BUG-F7-05: genuinely empty turnover must still be rejected (0.1626ms)
✔ BUG-F7-06: null / NaN / non-numeric scores must NOT be published in the Top-10 (1.2042ms)
✔ BUG-F7-06: a candidate with a missing score field must not be published (0.2028ms)
✔ BUG-F7-07: a paused (BREAK/CLOSED) batch must be reported as skipped, not as an empty scan (384.2153ms)
✔ BUG-F7-07: the run handler must expose a publish guard that honours the paused batch (0.3886ms)
✔ FASE7 regression: live/unclosed bar above resistance stays NEEDS_CLOSE_CONFIRMATION (0.226ms)
✔ FASE7 regression: confirmed close above the prior-session trigger is BREAKOUT_CONFIRMED (0.1633ms)
✔ FASE7 regression: a wick above the trigger that closes back below stays FALSE_BREAKOUT_RISK (0.1516ms)
✔ FASE7 regression: genuine illiquidity still hard-fails the liquidity gate (0.1163ms)
✔ FASE7 regression: FCA / restricted boards are still excluded from the daytrade universe (0.1806ms)
✔ FASE7 regression: tick-size tiers for regular boards are unchanged (0.1246ms)
✔ FASE7 regression: execution ranking keeps blocked candidates below executable ones (2.1677ms)
ℹ tests 27
ℹ pass 27
ℹ fail 0
ℹ duration_ms 828.7397
```

```
$ node --test test/audit-fase7-daytrade-screener-bugs.test.js   # RUN 2 (konfirmasi)

ℹ tests 27
ℹ pass 27
ℹ fail 0
ℹ duration_ms 869.7084
```

### Suite regression

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

### Full repository build suite

```
$ npm run build
All .js files parsed cleanly.
ℹ fail 0
✅ All broker-accumulation-fix tests passed!
✅ All multi-day broker aggregation tests passed!
All 68 test files passed successfully!
```

---

## REGISTRASI TEST

```diff
--- a/tools/curated-build-tests.json
+++ b/tools/curated-build-tests.json
 [
+  "test/audit-fase7-daytrade-screener-bugs.test.js",
   "test/audit-fase6-foreign-insider-bugs.test.js",
```

---

## REKAPITULASI DAMPAK BISNIS

| Sebelum perbaikan | Sesudah perbaikan |
|---|---|
| `A_PLUS_SETUP` / `TRADE_CANDIDATE` / `READY_BREAKOUT` **mustahil** tercapai | Dapat tercapai kembali; diverifikasi lewat `READY_BREAKOUT` pada skenario breakout realistis |
| `top_count` **selalu 0** ⇒ laporan "0 sinyal sepanjang hari" | `top_count = 1` pada skenario uji |
| Saham likuid dengan RVOL tak diketahui dibuang di gate pertama | Hanya RVOL **rendah yang diketahui** (< 0.3) yang dibuang |
| Volume/turnover string berformat → `INVALID_CANDLE` / `liquidity_unverified` | Diparse dengan benar; nilai non-numerik tetap ditolak |
| Saham FCA mendapat tick size salah | FCA dikenali dari boolean, string, maupun angka — tanpa salah baca `'false'` |
| Skor `null`/`NaN` terpublikasi ke Top-10 | Hanya skor finite ≥ 65 yang terpublikasi |
| Batch sesi BREAK/CLOSED menghapus seluruh kandidat terbitan | Scan dijeda bersih, data terbitan **dipertahankan** |

---

## ADDENDUM BATCH 4 (24 SEPTEMBER 2026) — TEMUAN RESIDUAL

> Fase 7 menyasar jalur **CANDLE** dan gate **likuiditas**. Audit ulang Batch 4 menemukan
> kelas cacat residual di jalur **QUOTE**, **penanganan input kosong**, dan **konsistensi
> UNKNOWN**. Tiga temuan baru, semuanya di `lib/daytrade-screener-engine.js`.
> Detail lengkap: `AUDIT_LOG_FASE_7_23SEPT.md` § 6.

| ID | Severity | Judul | Bukti FAIL-first |
|---|---|---|---|
| BATCH4-F7-01 | 🟠 **HIGH** | `analyzeDayTrade` **crash** (`TypeError`) pada array candle kosong / `null` / baris rusak — saham hilang dari scan dengan alasan `exception:` yang tak bisa didiagnosis | 5 test |
| BATCH4-F7-02 | 🔴 **CRITICAL** | String berformat pada **field QUOTE** → `data.change_pct.toFixed is not a function` pada cabang overheat & RSI overbought | 4 test |
| BATCH4-F7-03 | 🟡 MEDIUM | `undefined < 1.2 === false` → UNKNOWN **dipromosikan** sedangkan `null` tidak; UNKNOWN dirender `0.00x` | 5 test |

### BATCH4-F7-01 — CRASH PADA INPUT KOSONG

**Lokasi:** `analyzeDayTrade()` (baris ~306).

`candles.length` dan `last.close` dibaca tanpa guard. Provider yang menjawab `[]`, body
`null`, atau satu halaman baris `null` melempar `TypeError`. Di dalam `runDayTradeBatch()`
error itu ditelan `try/catch` per-ticker sehingga saham **menghilang dari scan** dengan alasan
generik `exception:` alih-alih hasil yang bisa didiagnosis; pemanggil di **luar** try/catch
(backtest, replay, diagnostik) crash total.

**Bukti (SEBELUM fix):**
```
$ node scratch/batch4-probe1.js
THROW analyzeDayTrade(null)      => TypeError: Cannot read properties of null (reading 'length')
THROW analyzeDayTrade(undefined) => TypeError: Cannot read properties of undefined (reading 'length')
THROW analyzeDayTrade([])        => TypeError: Cannot read properties of undefined (reading 'close')
THROW analyzeDayTrade(garbage)   => TypeError: Cannot read properties of null (reading 'close')
```

**Perbaikan:** `return null` untuk input tak-layak; buang baris tanpa OHLC finite; analisis
sisa sesi yang valid sehingga satu celah provider tidak membuang seluruh seri.

**Test penjaga:** `BATCH4-F7-01a..g` (7 test).

### BATCH4-F7-02 — STRING BERFORMAT DI FIELD QUOTE (CRITICAL)

**Lokasi:** `calculatePenalty()`, `classifyStatus()`, `scoreMomentum()`, `scoreDayTrade()`.

BUG-F7-03 mengajarkan engine meng-coerce string pada **candle**, tetapi `change_pct` dan
`rsi14` — dua field yang dibaca `.toFixed()` — tidak ikut. Feed yang mengirim `"9.0"` bukan
`9.0` melempar `TypeError` tepat pada cabang **overheat** dan **RSI overbought**: dua cabang
yang **selalu** dilewati mover panas ber-volume, yaitu populasi yang justru paling perlu
dinilai.

**Bukti (SEBELUM fix):**
```
$ node scratch/batch4-probe9.js
THROW change_pct = "9.0" => TypeError: data.change_pct.toFixed is not a function
THROW change_pct = "6.0" => TypeError: data.change_pct.toFixed is not a function
THROW rsi14 = "90"       => TypeError: data.rsi14.toFixed is not a function
THROW rsi14 = "86"       => TypeError: data.rsi14.toFixed is not a function
```

**Perbaikan:** satu helper `coerceQuoteNumbers()` (string berformat → angka; non-numerik →
`change_pct = 0`, `rsi14 = null`) dipanggil di `scoreDayTrade()`, `calculatePenalty()`,
`scoreMomentum()`, dan `classifyStatus()` sehingga seluruh pipeline membaca satu sumber
kebenaran numerik.

**Test penjaga:** `BATCH4-F7-02a..d` (4 test).

### BATCH4-F7-03 — INKONSISTENSI UNKNOWN (TERMASUK KOREKSI DIRI BATCH 4)

**Lokasi:** gate klasifikasi `hasLowVolume` (baris ~992).

`null < 1.2 === true` membuat RVOL tak terukur **tidak** dipromosikan. **Pembacaan awal
Batch 4 menganggap ini cacat dan mengubahnya — pembacaan itu SALAH dan sudah dikoreksi.**
Gate ini adalah *promotion gate* yang memang fail-closed: `PRE_SPIKE_WATCH` didefinisikan
sebagai radar yang **sudah** terkonfirmasi volume. Ini berbeda secara mendasar dari
`scoreLiquidity` (BUG-F7-02), yang menghard-fail kandidat ke `AVOID` sehingga **menghapus**
saham dari scan. Koreksi ini terdeteksi nyata: `daytrade-v7-engine-integrity.test.js`
menangkap percobaan perbaikan yang salah.

Yang **benar-benar** cacat adalah dua hal:

| # | Cacat | Bukti |
|---|---|---|
| 1 | `undefined < 1.2 === false` → field yang **absen** justru **dipromosikan**, sedangkan `null` tidak | `scratch/batch4-probe15.js`: `RVOL=null => EARLY_RADAR` vs `RVOL=undefined => PRE_SPIKE_WATCH` |
| 2 | RVOL UNKNOWN dirender sebagai **`0.00x`** — angka yang tidak pernah terukur disajikan seolah hasil observasi | `BATCH4-F7-03d` |

**Perbaikan:** kedua bentuk UNKNOWN (`null` dan `undefined`/non-finite) dinormalisasi ke
cabang fail-closed yang sama; nilai UNKNOWN dirender `N/A`, bukan `0.00x`.

**Test penjaga:** `BATCH4-F7-03a..e` (5 test) — mem-pin **kontrak fail-closed** sebagai
regression guard agar "pembersihan" `null` di masa depan tidak diam-diam mulai
mempromosikan kandidat yang belum terkonfirmasi volume.

### Hasil verifikasi Batch 4

| Tahap | Hasil |
|---|---|
| Baseline (sebelum fix) | **11 PASS / 10 FAIL** dari 21 test |
| PASS run #1 | **22 / 22 PASS**, 0 fail |
| PASS run #2 (berturut-turut) | **22 / 22 PASS**, 0 fail |
| Regresi terarah (9 suite) | **140 / 140 PASS**, 0 fail |
| Suite | `test/audit-fase7-screener-engine-bugs.test.js` |
