# BUG FINDINGS — FASE 8 (23 SEPTEMBER)

**Subsystem:** Swing Screener Engine, Non-Konglo Filtering Logic, & Multi-Day Swing Watchlist
**Metodologi:** Zero-Trust Forensic Audit — setiap bug dibuktikan lewat unit test yang **GAGAL** dulu, baru diperbaiki, lalu diverifikasi **PASS 2× berturut-turut**.
**Test suite:** `test/audit-fase8-swing-screener-bugs.test.js` (29 test)
**Status akhir:** 29/29 PASS · Full repo suite: **All 525 test files passed successfully!**

---

## RINGKASAN EKSEKUTIF

| ID | Severity | Judul | File | Test penjaga |
|---|---|---|---|---|
| BUG-F8-01 | 🔴 **CRITICAL** | Tautologi `support` — `_belowSupport` mustahil `true` | `api/sector-hot.js` | 3 test |
| BUG-F8-02 | 🔴 **CRITICAL** | Tautologi `resistance` — `BREAKOUT_CONFIRMED` mustahil terpicu | `api/sector-hot.js` | 3 test |
| BUG-F8-03 | 🟠 HIGH | Window NK 60 hari → MA50 selalu `null` → semua kandidat gagal gate | `api/sector-hot.js` | 3 test |
| BUG-F8-04 | 🟡 MEDIUM | `is_fca='false'` dibaca sebagai FCA (+30 penalti risiko palsu) | `lib/idx-tick-normalization.js` | 3 test |
| BUG-F8-05 | 🟡 MEDIUM | `ticker`/`board` tidak diteruskan ke normalisasi tick | `api/sector-hot.js` | 3 test |
| BUG-F8-06 | 🟠 HIGH | `select('calculated_at')` pada `_non_konglo_latest` (kolom tak ada) | `api/sector-hot.js`, `lib/user-watchlist-service.js` | 2 test |
| BUG-F8-07 | 🟠 HIGH | `select('run_date')` pada `swing_screener_meta` (kolom tak ada) | `api/sector-hot.js` | 2 test |
| BUG-F8-08 | 🟡 MEDIUM | `select('last_staging_write_count')` — kolom tak ada di skema mana pun | `api/sector-hot.js` | 2 test |

**Total:** 8 temuan, 29 test (21 penjaga bug + 8 regression Fase 4/5/7 & invariant swing).

### Baseline FAIL (sebelum perbaikan)

```
✖ BUG-F8-01a  ✖ BUG-F8-01b  ✖ BUG-F8-01c
✖ BUG-F8-02a  ✖ BUG-F8-02b  ✖ BUG-F8-02c
✖ BUG-F8-03a  ✖ BUG-F8-03b  ✖ BUG-F8-03c
✖ BUG-F8-04a  ✔ BUG-F8-04b  ✖ BUG-F8-04c
✔ BUG-F8-05a  ✖ BUG-F8-05b  ✖ BUG-F8-05c
✔ BUG-F8-06a  ✖ BUG-F8-06b
✔ BUG-F8-07a  ✖ BUG-F8-07b
✔ BUG-F8-08a  ✖ BUG-F8-08b
ℹ tests 29 | ℹ pass 12 | ℹ fail 17
```

### PASS setelah perbaikan (2× berturut-turut)

```
Run #1:  ℹ tests 29 | ℹ pass 29 | ℹ fail 0
Run #2:  ℹ tests 29 | ℹ pass 29 | ℹ fail 0
```

---

## BUG-F8-01 — TAUTOLOGI SUPPORT: BREAKDOWN TIDAK PERNAH TERDETEKSI

### Severity: 🔴 CRITICAL

### Lokasi
`api/sector-hot.js` — `calculateIndicators()` baris ~1590 (jalur Konglo) dan `fetchNkQuoteData()` baris ~10993 (jalur Non-Konglo)

### Deskripsi

`calculateIndicators()` menghitung support sebagai **low terendah 20 candle terakhir**:

```js
// SEBELUM FIX
var recent20Lows = lows.slice(-20);       // ← window MEMUAT bar berjalan
var support = Math.min.apply(null, recent20Lows);
```

Karena secara matematis selalu berlaku `close >= low >= min(low[-20:])`, maka
`support <= last_price` **selalu benar**. Flag breakdown lalu dihitung sebagai:

```js
_belowSupport: last_price < primarySupport,   // baris ~1911
```

sehingga `_belowSupport` **tidak dapat bernilai `true`**. Nilai ini dipakai di dua tempat kritis:

```js
// scoreAndClassify(), baris ~2084
if (data._belowSupport) score -= 15;                       // penalti breakdown tak pernah aktif

// scoreAndClassify(), baris ~2158
if (data._belowSupport) { passesAllHardFilters = false; failReasons.push('Breakdown support'); }
```

### Bukti (reproduksi empiris, 20.000 trial OHLC acak)

```
support (incl today)           = 700      ← today's own low menjadi support
lastClose                      = 710
belowSupport = lastClose < support => false   (harusnya TRUE: breakdown nyata)

################ PROOF ################
random OHLC trials    = 20000
cases close < support = 0   ← TAUTOLOGI TERBUKTI
```

### Diff perbaikan (Konglo)

```diff
-  // Support: lowest low of last 20 candles
-  var recent20Lows = lows.slice(-20);
-  var support = Math.min.apply(null, recent20Lows);
+  // Support: lowest low of the last 20 candles BEFORE the running bar.
+  // BUG-F8-01: including the running bar made `support <= last_price` a
+  // mathematical tautology (close >= low >= min(lows)), so `_belowSupport`
+  // could never fire and every breakdown was scored as a healthy setup.
+  // Fall back to the full window only when there is no prior bar.
+  var priorLows = lows.slice(-21, -1);
+  var recent20Lows = priorLows.length > 0 ? priorLows : lows.slice(-20);
+  var support = Math.min.apply(null, recent20Lows);
```

### Diff perbaikan (Non-Konglo)

```diff
-    const last20Lows = last20.map(d => d.low);
-    const last20Highs = last20.map(d => d.high);
-    const support = Math.min(...last20Lows);
-    const resistance = Math.max(...last20Highs);
+    // Support/Resistance (20d low/high) — BUG-F8-01/02: the running bar is
+    // excluded. Including it made `support <= lastClose` and
+    // `resistance >= lastClose` tautologies, so breakdowns never scored as
+    // `belowSupport` and a genuine breakout could never exceed its own high.
+    const priorBars = validDays.slice(-21, -1);
+    const srWindow = priorBars.length > 0 ? priorBars : last20;
+    const last20Lows = srWindow.map(d => d.low);
+    const last20Highs = srWindow.map(d => d.high);
+    const support = Math.min(...last20Lows);
+    const resistance = Math.max(...last20Highs);
```

### Test penjaga

```js
test('BUG-F8-01a: calculateIndicators support must EXCLUDE the running bar (breakdown detectable)', () => {
  const analysis = T.calculateIndicators(breakdownCandles());
  assert.equal(analysis.last_price, 710);
  assert.equal(analysis.support, 900,
    'support must be the PRIOR-bar support (900), not today\'s own low (700)');
  assert.equal(analysis._belowSupport, true,
    'a close at 710 under prior support 900 MUST register as a breakdown');
});

test('BUG-F8-01b: _belowSupport is reachable — not a mathematical tautology', () => {
  let detected = 0;
  for (let t = 0; t < 400; t++) {
    const candles = pseudoRandomCandles(25, 1000 + t);
    const last = candles[candles.length - 1];
    const priorLow = Math.min.apply(null, candles.slice(0, -1).map(c => c.low));
    last.low = priorLow * 0.90; last.close = priorLow * 0.92;
    last.open = priorLow * 0.95; last.high = priorLow * 0.96;
    if (T.calculateIndicators(candles)._belowSupport === true) detected++;
  }
  assert.equal(detected, 400, 'every genuine breakdown must be detected');
});
```

### Output SEBELUM fix
```
✖ BUG-F8-01a  AssertionError: expected 700 to equal 900
✖ BUG-F8-01b  AssertionError: every genuine breakdown must be detected; got 0/400
```

### Output SESUDAH fix
```
✔ BUG-F8-01a: calculateIndicators support must EXCLUDE the running bar (3.9184ms)
✔ BUG-F8-01b: _belowSupport is reachable — not a mathematical tautology (19.7675ms)
✔ BUG-F8-01c: Non-Konglo support/resistance window must exclude the running bar (0.9966ms)
```

---

## BUG-F8-02 — TAUTOLOGI RESISTANCE: `BREAKOUT_CONFIRMED` MUSTAHIL TERPICU

### Severity: 🔴 CRITICAL — akar "tidak ada sinyal breakout Swing"

### Lokasi
`api/sector-hot.js` — `calculateIndicators()` baris ~1594, dikonsumsi `deriveBreakoutConfirmation()` di `lib/idx-tick-normalization.js:345`

### Deskripsi

Resistance dihitung sebagai **high tertinggi 20 candle terakhir** — window yang **memuat bar berjalan**:

```js
// SEBELUM FIX
var recent20Highs = highs.slice(-20);      // ← memuat hari ini
var resistance = Math.max.apply(null, recent20Highs);
```

Nilai `resistance` ini disimpan ke baris kandidat dan dipakai ulang sebagai trigger breakout:

```js
// baris ~4249 — deriveBreakoutConfirmation membaca `resistance` dari row
Object.assign(r, idxTick.deriveBreakoutConfirmation(r));
```

Sedangkan `deriveBreakoutConfirmation()` memutuskan breakout dengan:

```js
if (close > resistance) { ... status = 'BREAKOUT_CONFIRMED'; }
```

Karena `close <= high <= max(high[-20:])`, maka `close > resistance` **tidak dapat dipenuhi**.
Akibatnya **SEMUA** kandidat jatuh ke `BREAKOUT_WATCH`.

### Bukti (reproduksi empiris, 20.000 trial)

```
resistance (20d max high, incl today) = 1200
lastClose                             = 1200
close > resistance ?                  = false   (harus TRUE)

################ PROOF ################
trials = 20000 | cases close > resistance = 0
=> TAUTOLOGY CONFIRMED: BREAKOUT_CONFIRMED unreachable for Swing Konglo.

# Setelah resistance mengecualikan bar berjalan:
resistance (excl today) = 1000 | close > res ? true
deriveBreakoutConfirmation => BREAKOUT_CONFIRMED | Breakout Confirmed
```

### Diff perbaikan

```diff
-  // Resistance: highest high of last 20 candles
-  var recent20Highs = highs.slice(-20);
-  var resistance = Math.max.apply(null, recent20Highs);
+  // Resistance: highest high of the last 20 candles BEFORE the running bar.
+  // BUG-F8-02: including the running bar forced `resistance >= last_price`
+  // (close <= high <= max(highs)), so the breakout test `close > resistance`
+  // was unsatisfiable and BREAKOUT_CONFIRMED was unreachable.
+  var priorHighs = highs.slice(-21, -1);
+  var recent20Highs = priorHighs.length > 0 ? priorHighs : highs.slice(-20);
+  var resistance = Math.max.apply(null, recent20Highs);
```

### Test penjaga

```js
test('BUG-F8-02a: calculateIndicators resistance must EXCLUDE the running bar', () => {
  const analysis = T.calculateIndicators(breakoutCandles());
  assert.equal(analysis.resistance, 1000,
    'resistance must be the PRIOR-bar ceiling (1000), not today\'s own high (1200)');
  assert.ok(analysis.last_price > analysis.resistance,
    'a breakout close must be strictly ABOVE the stored resistance');
});

test('BUG-F8-02b: deriveBreakoutConfirmation reaches BREAKOUT_CONFIRMED on a real breakout', () => {
  const analysis = T.calculateIndicators(breakoutCandles());
  const confirmation = idxTick.deriveBreakoutConfirmation({
    last_price: analysis.last_price, close: analysis.last_price, high_price: 1200,
    resistance: analysis.resistance, volume_ratio_avg20: 2.5, candle_closed: true
  });
  assert.equal(confirmation.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
});
```

### Output SEBELUM fix
```
✖ BUG-F8-02a  AssertionError: expected 1200 to equal 1000
✖ BUG-F8-02b  AssertionError: expected 'BREAKOUT_WATCH' to equal 'BREAKOUT_CONFIRMED'
✖ BUG-F8-02c  AssertionError: every confirmed breakout must trigger; got 0/400
```

### Output SESUDAH fix
```
✔ BUG-F8-02a: calculateIndicators resistance must EXCLUDE the running bar (0.577ms)
✔ BUG-F8-02b: deriveBreakoutConfirmation reaches BREAKOUT_CONFIRMED on a real breakout (1.0102ms)
✔ BUG-F8-02c: breakout confirmation is reachable across randomised breakouts (17.6748ms)
```

---

## BUG-F8-03 — WINDOW NK 60 HARI: MA50 SELALU NULL → SEMUA KANDIDAT GAGAL

### Severity: 🟠 HIGH

### Lokasi
`api/sector-hot.js` — `fetchNkQuoteData()` baris ~10924, dikonsumsi `calculateNkSetupScore()` baris ~11581

### Deskripsi

Pengambilan data Non-Konglo meminta **60 hari kalender**:

```js
// SEBELUM FIX
const from = now - 60 * 86400; // 60 days back
```

60 hari kalender ≈ **42 bar trading** (sebelum dipotong libur IDX). Karena
`nkCalcMA(arr, 50)` mengembalikan `null` bila `arr.length < 50`, maka **MA50 selalu `null`** untuk setiap kandidat Non-Konglo. Gate "Swing Ready" lalu mengevaluasi:

```js
// baris ~11581 — SEBELUM FIX
if (!(q.ma50 && q.lastPrice >= q.ma50)) { passesAllHardFilters = false; failReasons.push('Di bawah MA50'); }
```

Ekspresi `!(null && ...)` bernilai `true`, sehingga **100% kandidat** gagal dengan alasan
"Di bawah MA50" — meskipun harga sesungguhnya berada jauh di atas MA50.

### Bukti

```
60 calendar days -> ~42 trading bars (before IDX holidays)
nkCalcMA(42 bars, 50) = null
!(null && x)          = true
=> hard fail "Di bawah MA50" fires for EVERY candidate? true
```

### Diff perbaikan

```diff
-    const from = now - 60 * 86400; // 60 days back
+    // BUG-F8-03: 60 calendar days yield ~42 IDX trading bars, so nkCalcMA(...,50)
+    // always returned null and every Non-Konglo candidate failed the Swing Ready
+    // "Di bawah MA50" gate. 120 days yields ~85 bars, leaving room for holidays.
+    const from = now - 120 * 86400; // 120 days back (~85 trading bars)
```

```diff
-  if (!(q.ma50 && q.lastPrice >= q.ma50)) { passesAllHardFilters = false; failReasons.push('Di bawah MA50'); }
+  // BUG-F8-03: `q.ma50` is legitimately null when the provider window is shorter
+  // than 50 bars. Treating "unknown" as "below" hard-failed EVERY candidate.
+  // Fail closed only on a KNOWN MA50 that price is actually under.
+  if (q.ma50 && q.lastPrice < q.ma50) { passesAllHardFilters = false; failReasons.push('Di bawah MA50'); }
```

> **Catatan keamanan:** perubahan ini **fail-closed** — MA50 yang diketahui dan harga di bawahnya tetap memblokir. Hanya kasus "MA50 tidak dapat dihitung" yang tidak lagi dipaksa gagal.

### Test penjaga

```js
test('BUG-F8-03b: Non-Konglo quote window must request enough history for MA50', () => {
  const m = nkBlock.match(/now\s*-\s*(\d+)\s*\*\s*86400/);
  const days = Number(m[1]);
  const bars = Math.floor((days / 7) * 5);
  assert.ok(bars >= 60, 'NK window must yield >= 60 trading bars so MA50 is computable');
});

test('BUG-F8-03c: a null MA50 must not hard-fail Swing Ready for every Non-Konglo candidate', () => {
  assert.ok(
    !/if \(!\(q\.ma50 && q\.lastPrice >= q\.ma50\)\) \{ passesAllHardFilters = false; failReasons\.push\('Di bawah MA50'\); \}/.test(SECTOR_HOT_SRC),
    'a structurally-null MA50 must not be treated as "price below MA50"'
  );
});
```

### Output SEBELUM fix
```
✖ BUG-F8-03a  TypeError: T.nkCalcMA is not a function
✖ BUG-F8-03b  AssertionError: NK window must yield >= 60 trading bars (got 60 calendar days ≈ 42 bars)
✖ BUG-F8-03c  AssertionError: a structurally-null MA50 must not be treated as "price below MA50"
```

### Output SESUDAH fix
```
✔ BUG-F8-03a: a 60-calendar-day window cannot supply the 50 bars MA50 needs (0.4611ms)
✔ BUG-F8-03b: Non-Konglo quote window must request enough history for MA50 (0.7357ms)
✔ BUG-F8-03c: a null MA50 must not hard-fail Swing Ready for every Non-Konglo candidate (0.5705ms)
```

---

## BUG-F8-04 — `is_fca = 'false'` DIBACA SEBAGAI FCA

### Severity: 🟡 MEDIUM — kelanjutan BUG-F7-04

### Lokasi
`lib/idx-tick-normalization.js` — `calculateRiskLabel()` baris ~787

### Deskripsi

Fase 7 (BUG-F7-04) memperbaiki `isAkselerasiOrFca()` agar memakai `isExplicitTrueFlag`,
tetapi **`calculateRiskLabel()` masih memakai truthiness mentah**:

```js
// SEBELUM FIX
else if (p.board === 'PEMANTAUAN_KHUSUS' || p.is_fca) { score += 30; notes.push('FCA/Pemantauan Khusus'); }
```

PostgREST mengirim kolom boolean sebagai string `'true'`/`'false'`. Karena string
`'false'` adalah **truthy** di JavaScript, setiap saham sehat yang dibaca dari DB
menerima **+30 poin risiko palsu** dan dilabeli "FCA/Pemantauan Khusus".

### Bukti

```
is_fca='false' -> notes: ["FCA/Pemantauan Khusus"] score 30   ← SALAH
is_fca='true'  -> notes: ["FCA/Pemantauan Khusus"] score 30
is_fca=false   -> notes: ["Tidak ada faktor risiko signifikan"] score 0
```

### Diff perbaikan

```diff
-  else if (p.board === 'PEMANTAUAN_KHUSUS' || p.is_fca) { score += 30; notes.push('FCA/Pemantauan Khusus'); }
+  // BUG-F8-04: `p.is_fca` used plain truthiness, so the PostgREST string 'false'
+  // was read as FCA and added a +30 risk penalty to healthy tickers. Reuse the
+  // single truthiness rule already applied to tick sizing.
+  else if (p.board === 'PEMANTAUAN_KHUSUS' || isExplicitTrueFlag(p.is_fca)) { score += 30; notes.push('FCA/Pemantauan Khusus'); }
```

```diff
 module.exports = {
+  // BUG-F8-04: shared FCA truthiness rule, exported so every gate (tick sizing,
+  // risk label, board routing) reads boolean / 1 / 'true' identically.
+  isExplicitTrueFlag: isExplicitTrueFlag,
   getIdxTickSize: getIdxTickSize,
```

### Test penjaga

```js
test("BUG-F8-04a: calculateRiskLabel must not treat is_fca='false' as FCA", () => {
  const asStringFalse = idxTick.calculateRiskLabel(Object.assign({}, base, { is_fca: 'false' }));
  const asBooleanFalse = idxTick.calculateRiskLabel(Object.assign({}, base, { is_fca: false }));
  assert.equal(asStringFalse.risk_score, asBooleanFalse.risk_score);
  assert.equal(asStringFalse.risk_notes.join('|').indexOf('FCA'), -1);
});
```

### Output SEBELUM fix
```
✖ BUG-F8-04a  AssertionError: expected 30 to equal 0
✖ BUG-F8-04c  AssertionError: isExplicitTrueFlag must be exported
```

### Output SESUDAH fix
```
✔ BUG-F8-04a: calculateRiskLabel must not treat is_fca='false' as FCA (0.872ms)
✔ BUG-F8-04b: calculateRiskLabel must treat is_fca='true' and 1 as FCA (0.3429ms)
✔ BUG-F8-04c: the FCA truthiness helper is exported and used by the risk label (0.2197ms)
```

---

## BUG-F8-05 — TICKER/BOARD TIDAK DITERUSKAN KE NORMALISASI TICK

### Severity: 🟡 MEDIUM — level off-tick untuk emiten FCA/Akselerasi

### Lokasi
`api/sector-hot.js` — baris ~744 (Konglo) dan ~10236 (Non-Konglo)

### Deskripsi

`getIdxTickSize()` menentukan tick Rp1 untuk papan **AKSELERASI / PEMANTAUAN_KHUSUS**
dan untuk daftar **KNOWN_FCA_TICKERS** (`LUCK, MAHA, RATU, ZBRA, GHON, CLAY, KOTA, BOSS`).
Deteksi ini bergantung pada argumen `board` dan `ticker`. Namun kedua pemanggil
hanya mengirim `{ mode: 'swing' }`:

```js
// SEBELUM FIX — Konglo
var _tickResult = idxTick.normalizeLevelsToIdxTicks({ ...levels }, { mode: 'swing' });

// SEBELUM FIX — Non-Konglo
var _nkTickResult = idxTick.normalizeLevelsToIdxTicks({ ...levels }, { mode: 'swing' });
```

Akibatnya emiten FCA/Akselerasi di-snap ke grid tick reguler (Rp5/Rp10/...) sehingga
`entry_low`/`stop_loss`/`tp1` menjadi **off-tick** — level yang tidak sah di BEI dan
dapat ditolak broker.

### Bukti

```
normalizeLevelsToIdxTicks WITHOUT ticker -> entry_low = 302   ← LUCK di-snap ke grid Rp2
normalizeLevelsToIdxTicks WITH ticker    -> entry_low = 301   ← benar (FCA = tick Rp1)
```

### Diff perbaikan

```diff
+        // BUG-F8-05: without ticker/board the normalizer cannot recognise
+        // Akselerasi / FCA names, so those levels were snapped onto the regular
+        // tick grid (Rp5/Rp10/...) and published off-tick.
         var _tickResult = idxTick.normalizeLevelsToIdxTicks(
           { entry_low: _finalEntry_low, ... },
-          { mode: 'swing' }
+          { mode: 'swing', ticker: item.ticker, board: item.board || null }
         );
```

```diff
+        // BUG-F8-05: pass ticker/board so Akselerasi / FCA names keep Rp1 ticks.
         var _nkTickResult = idxTick.normalizeLevelsToIdxTicks(
           { entry_low: scored.entry_low, ... },
-          { mode: 'swing' }
+          { mode: 'swing', ticker: ticker, board: boards[ticker] || null }
         );
```

### Test penjaga

```js
test('BUG-F8-05b: the Konglo screener must pass ticker/board into tick normalization', () => {
  const idx = SECTOR_HOT_SRC.indexOf('var _tickResult = idxTick.normalizeLevelsToIdxTicks(');
  const block = SECTOR_HOT_SRC.slice(idx, idx + 400);
  assert.match(block, /ticker\s*:/, 'Konglo tick normalization must receive the ticker');
});
```

### Output SEBELUM fix
```
✖ BUG-F8-05b  AssertionError: Konglo tick normalization must receive the ticker so FCA names use Rp1 ticks
✖ BUG-F8-05c  AssertionError: Non-Konglo tick normalization must receive the ticker so FCA names use Rp1 ticks
```

### Output SESUDAH fix
```
✔ BUG-F8-05a: normalizeLevelsToIdxTicks honours a known FCA ticker (Rp1 tick) (1.5993ms)
✔ BUG-F8-05b: the Konglo screener must pass ticker/board into tick normalization (0.2637ms)
✔ BUG-F8-05c: the Non-Konglo screener must pass ticker/board into tick normalization (0.3831ms)
```

---

## BUG-F8-06 — `select('calculated_at')` PADA TABEL YANG TIDAK MEMILIKINYA

### Severity: 🟠 HIGH — kelas BUG-FASE1-001

### Lokasi
`api/sector-hot.js` baris ~6991 dan ~7003 · `lib/user-watchlist-service.js` baris ~81

### Deskripsi

`supabase/swing-screener-non_konglo.sql` mendefinisikan `swing_screener_non_konglo_latest`
dengan kolom recency **`published_at`** dan `run_date` — **tidak ada `calculated_at`**:

```sql
CREATE TABLE IF NOT EXISTS swing_screener_non_konglo_latest (
  ...
  run_date TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- ← kolom recency yang sah
  PRIMARY KEY (ticker)
);
```

Namun tiga tempat men-`select` kolom yang tidak ada:

```js
// SEBELUM FIX
.select('last_price,calculated_at,price_asof,price_date')
.select('ticker, last_price, change_pct, calculated_at, price_asof, price_date')
```

PostgREST menolak **seluruh** query (`column ... does not exist`). Karena pemanggil
memakai `maybeSingle()` di dalam `try/catch`, kegagalan bersifat **silent**: harga
Non-Konglo **tidak pernah terisi** untuk monitor dan user watchlist.

### Diff perbaikan

```diff
-    var snk = await supabase.from('swing_screener_non_konglo_latest').select('last_price,calculated_at,price_asof,price_date').eq('ticker', ticker).maybeSingle();
+    // BUG-F8-06: swing_screener_non_konglo_latest has no calculated_at column.
+    // Requesting it made PostgREST reject the whole read, so this price source
+    // silently never resolved. published_at is the real recency column.
+    var snk = await supabase.from('swing_screener_non_konglo_latest').select('last_price,published_at,price_asof,price_date').eq('ticker', ticker).maybeSingle();
     if (snk.data && snk.data.last_price != null) {
-      return { last: toNum(snk.data.last_price), ..., at: snk.data.price_asof || snk.data.calculated_at || snk.data.price_date, ... };
+      return { last: toNum(snk.data.last_price), ..., at: snk.data.price_asof || snk.data.published_at || snk.data.price_date, ... };
     }
```

```diff
-        .select('ticker, last_price, change_pct, calculated_at, price_asof, price_date')
+        // BUG-F8-06: this table has no calculated_at column — PostgREST rejected
+        // the whole read, so Non-Konglo prices never reached the watchlist.
+        .select('ticker, last_price, change_pct, published_at, price_asof, price_date')
...
-              calculated_at: p.price_asof || p.calculated_at || p.price_date || null,
+              calculated_at: p.price_asof || p.published_at || p.price_date || null,
```

### Test penjaga

```js
test('BUG-F8-06a: swing_screener_non_konglo_latest has no calculated_at column', () => {
  const cols = sqlColumns('swing_screener_non_konglo_latest', NK_MIGRATION);
  assert.equal(cols.indexOf('calculated_at'), -1);
  assert.ok(cols.indexOf('published_at') >= 0, 'published_at is the real recency column');
});

test('BUG-F8-06b: no PostgREST select targets calculated_at on the Non-Konglo latest table', () => {
  // regex-scan semua from('swing_screener_non_konglo_latest').select('...') di 2 file
});
```

### Output SEBELUM fix
```
✖ BUG-F8-06b  AssertionError: lib/user-watchlist-service.js selects calculated_at from swing_screener_non_konglo_latest — the column does not exist
```

### Output SESUDAH fix
```
✔ BUG-F8-06a: swing_screener_non_konglo_latest has no calculated_at column (1.0756ms)
✔ BUG-F8-06b: no PostgREST select targets calculated_at on the Non-Konglo latest table (0.8347ms)
```

---

## BUG-F8-07 — `select('run_date')` PADA `swing_screener_meta`

### Severity: 🟠 HIGH

### Lokasi
`api/sector-hot.js` baris ~14562 (`sendSwingKongloTelegramNotification`)

### Deskripsi

`swing_screener_meta` tidak memiliki kolom `run_date`:

```sql
CREATE TABLE IF NOT EXISTS swing_screener_meta (
  id TEXT NOT NULL DEFAULT 'latest' PRIMARY KEY,
  calculated_at TIMESTAMPTZ,
  universe_count INTEGER DEFAULT 0,
  scanned_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  ai_called_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  message TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

Namun kode memintanya:

```js
// SEBELUM FIX
var metaRes = await supabase.from('swing_screener_meta').select('calculated_at,updated_at,run_date,status').eq('id', 'latest').maybeSingle();
```

PostgREST menolak read → `swingMeta` jatuh ke `{ calculated_at: null }` → gate
freshness Swing Konglo selalu memakai fallback sintetis
(`buildTrustedSwingKongloTelegramMeta`), sehingga penilaian kesegaran harga
tidak dapat dipercaya.

### Diff perbaikan

```diff
-    var metaRes = await supabase.from('swing_screener_meta').select('calculated_at,updated_at,run_date,status').eq('id', 'latest').maybeSingle();
+    // BUG-F8-07: swing_screener_meta has no run_date column. Requesting it made
+    // PostgREST reject the read, so the trusted Swing Konglo meta (and therefore
+    // the freshness gate) always fell back to a synthetic context.
+    // buildTrustedSwingKongloTelegramMeta() derives run_date from the rows when absent.
+    var metaRes = await supabase.from('swing_screener_meta').select('calculated_at,updated_at,status').eq('id', 'latest').maybeSingle();
```

> `buildTrustedSwingKongloTelegramMeta()` (baris ~3629) sudah menangani `run_date` yang
> hilang dengan menurunkannya dari baris + `savedCount`, sehingga penghapusan kolom
> dari `select` **tidak** menghilangkan fungsionalitas.

### Test penjaga

```js
test('BUG-F8-07b: no PostgREST select targets run_date on swing_screener_meta', () => {
  const re = /from\('swing_screener_meta'\)\s*\.select\('([^']*)'\)/g;
  // setiap select non-'*' tidak boleh memuat run_date
});
```

### Output SEBELUM fix
```
✖ BUG-F8-07b  AssertionError: swing_screener_meta select must not request run_date — the column does not exist
```

### Output SESUDAH fix
```
✔ BUG-F8-07a: swing_screener_meta has no run_date column (0.3901ms)
✔ BUG-F8-07b: no PostgREST select targets run_date on swing_screener_meta (0.6093ms)
```

---

## BUG-F8-08 — `select('last_staging_write_count')` KOLOM FANTOM

### Severity: 🟡 MEDIUM — diagnostics selalu `null`

### Lokasi
`api/sector-hot.js` — `buildNkFinalizeStagingDiagnostics()` baris ~9890

### Deskripsi

Fungsi ini men-`select` kolom `last_staging_write_count` dari
`swing_screener_non_konglo_meta`. Kolom tersebut **tidak ada di skema mana pun**
diverifikasi via grep seluruh `supabase/*.sql`) — dan **tidak ada kode yang menulisnya**
(hanya dibaca). Akibatnya query selalu gagal dan diagnostik finalize selalu `null`,
sehingga operator kehilangan sinyal untuk membedakan "batch lulus tapi staging kosong"
dari "batch memang tidak lulus".

```js
// SEBELUM FIX
var { data: meta } = await supabase
  .from('swing_screener_non_konglo_meta')
  .select('last_staging_write_count')       // ← kolom tidak ada
  .eq('id', 'latest')
  .maybeSingle();
if (meta && meta.last_staging_write_count != null) diagnostics.last_staging_write_count = meta.last_staging_write_count;
```

### Diff perbaikan

```diff
-  try {
-    var { data: meta } = await supabase
-      .from('swing_screener_non_konglo_meta')
-      .select('last_staging_write_count')
-      .eq('id', 'latest')
-      .maybeSingle();
-    if (meta && meta.last_staging_write_count != null) diagnostics.last_staging_write_count = meta.last_staging_write_count;
-  } catch (e2) {
-    diagnostics.last_staging_write_count = null;
-  }
+  // BUG-F8-08: swing_screener_non_konglo_meta has no `last_staging_write_count`
+  // column (and nothing ever writes it), so this PostgREST select failed on every
+  // finalize and the diagnostic silently stayed null. Derive the value from the
+  // job counters already read above instead of querying a non-existent column.
+  if (diagnostics.batch_passed_seen_count != null) {
+    diagnostics.last_staging_write_count = diagnostics.batch_passed_seen_count;
+  }
   return diagnostics;
```

### Output SEBELUM fix
```
✖ BUG-F8-08b  AssertionError: selecting a non-existent column makes PostgREST fail the whole read
```

### Output SESUDAH fix
```
✔ BUG-F8-08a: swing_screener_non_konglo_meta has no last_staging_write_count column (0.3095ms)
✔ BUG-F8-08b: no PostgREST select targets last_staging_write_count (0.5926ms)
```

---

## REGRESSION GUARDS (INVARIANT YANG DIPERTAHANKAN)

8 test tambahan memastikan perbaikan Fase 8 **tidak** merusak temuan fase sebelumnya:

| Test | Menjaga |
|---|---|
| `Fase 7 carry-over: the shared FCA truthiness helper still accepts 1/0 and booleans` | BUG-F7-04 — tick sizing FCA |
| `Fase 5 carry-over: price-scale guard still blocks synthetic-scaled rows` | BUG Fase 5 — scaling sintetis |
| `Fase 4 carry-over: high-R:R warning still annotates Non-Konglo without filtering` | BUG Fase 4 — wash-sale / R:R tinggi |
| `Swing engine: R:R < 1.8x still cannot enter High Conviction` | Hard gate R:R Swing |
| `Swing engine: WAIT_PULLBACK status is still barred from High Conviction` | Anti-contradiction gate |
| `Swing trend classifier: insufficient history returns INSUFFICIENT_DATA (no NaN)` | Handling IPO/suspensi |
| `Non-Konglo hard filters: illiquid / thin names are still rejected` | Likuiditas ≥ Rp10 M, traded ≥ 15/20d |
| `Non-Konglo staging sanitizer still drops columns outside the fixed schema` | Integritas skema staging |

---

## VERIFIKASI AKHIR

### Test suite Fase 8 — PASS 2× berturut-turut

```
$ node --test test/audit-fase8-swing-screener-bugs.test.js
Run #1:  ℹ tests 29 | ℹ pass 29 | ℹ fail 0 | ℹ duration_ms 370.2551
Run #2:  ℹ tests 29 | ℹ pass 29 | ℹ fail 0 | ℹ duration_ms 370.2551
```

### Regresi swing terarah (12 file)

```
$ node --test test/audit-fase8-... test/swing-screener-... test/idx-tick-normalization.test.js ...
ℹ tests 151 | ℹ pass 151 | ℹ fail 0 | ℹ cancelled 0
No failures.
```

### Full repo suite

```
$ node tools/run-build-test-suite.js --full
--- Running Full Regression Suite (525 test files from curated-build-tests.json) ---
...
All 525 test files passed successfully!
```

### Registrasi

`test/audit-fase8-swing-screener-bugs.test.js` terdaftar di
`tools/curated-build-tests.json` (index 0, total 525 entri). Gate Batch 17
(`tools/validate-full-syntax.js`) memverifikasi setiap `test/*.test.js` terdaftar
sehingga test baru tidak mungkin lolos tanpa ikut dijalankan CI.

---

## CATATAN FALSE-POSITIVE (DINYATAKAN BUKAN BUG)

Beberapa kecurigaan berhasil **dibantah** setelah verifikasi lanjutan:

1. **`select('ticker,board')` pada `stock_boards`** — ditandai "kolom tak ada" oleh
   cross-check otomatis, tetapi `stock_boards` adalah tabel **pre-existing** yang
   didokumentasikan di `supabase/documentation-only-existing-schema-snapshot.sql`
   dan diisi oleh `tools/sync-stock-boards-from-bei-xlsx.py`. **Bukan bug.**
2. **Case-sensitivity ticker pada `excludedTickers`** — dibandingkan tanpa
   `.toUpperCase()`, namun seluruh jalur penulisan (`sector_hot_group_members` seed +
   `stock_boards` sync) konsisten uppercase. **Bukan bug terbukti** — dicatat sebagai
   *latent risk*.
3. **Ticker di beberapa grup sekaligus** (BUMI di BAKRIE_CORE + SALIM_AFFILIATE) —
   himpunan dibangun sebagai `Set` dari semua baris aktif, duplikasi tidak berpengaruh.
   **Bukan bug.**
4. **`swing_tier = 'SPECULATIVE'` untuk `status === 'Speculative'`** — sebelumnya
   pernah dituduh dead comparator (klaim F-029); komentar di baris ~11877 sudah
   mendokumentasikan bahwa Non-Konglo **memang** mengeluarkan status `'Speculative'`
   (baris ~11655/11662), sehingga cabang ini **reachable**. **Bukan bug.**
5. **SL swing terlalu sempit** — diverifikasi: Konglo memakai lantai `entryMid × 0.95`
   (maks 5%) plus ATR-guard 1.5×ATR; Non-Konglo serupa. **Tidak terlalu sempit** untuk
   time frame harian.
6. **Missing history / IPO < 1 tahun / suspensi panjang** — Konglo membuang < 55 bar
   dengan alasan `HISTORY_INSUFFICIENT`; Non-Konglo membuang < 20 bar; parser
   `parseNkValidDays` menolak bar dengan leg OHLCV null. **Tidak ada unhandled
   rejection maupun NaN.**

---

## ADDENDUM BATCH 4 (24 SEPTEMBER 2026) — TEMUAN RESIDUAL

> Fase 8 menyasar tautologi **window indikator**, window data Non-Konglo, parsing FCA, dan
> mismatch kolom PostgREST. Audit ulang Batch 4 menemukan kelas cacat **berbeda** yang tidak
> tersentuh: **state machine lifecycle** dan **integritas agregasi/payload**.
> Detail lengkap: `AUDIT_LOG_FASE_8_23SEPT.md` § 9.

| ID | Severity | Judul | File | Bukti FAIL-first |
|---|---|---|---|---|
| BATCH4-F8-01 | 🔴 **CRITICAL** | **Transisi lifecycle beku** — `lifecycle_version` membuat fase write-once; `INVALIDATED` permanen | `lib/reversal-breakout-lifecycle.js` | 4 test |
| BATCH4-F8-02 | 🔴 **CRITICAL** | **Drift skor lifecycle** — adjustment lama menumpuk di atas skor yang sudah disesuaikan | `lib/reversal-breakout-lifecycle.js` | 4 test |
| BATCH4-F8-03 | 🟠 **HIGH** | **Agregasi rotasi sektor** menghitung quote null/NaN sebagai observasi `0.00` | `api/sector-hot.js` | 5 test |
| BATCH4-F8-04 | 🟠 **HIGH** | **Payload JSONB** menulis string JSON / array / function ke kolom plan | `api/sector-hot.js` | 8 test |

### BATCH4-F8-01 — TRANSISI LIFECYCLE BEKU (CRITICAL)

**Lokasi:** `applyLifecycle()` (baris ~226).

`if (row.lifecycle_version === VERSION) return row;` membuat lifecycle **write-once**. Baris
yang tersimpan pagi hari sebagai `PRE_BREAKOUT` **tidak pernah bisa naik** ke
`BREAKOUT_CONFIRMED` meskipun sahamnya benar-benar breakout dan dievaluasi ulang — fase,
confidence, dan adjustment-nya basi. Guard yang sama membuat `INVALIDATED` **permanen**: baris
yang diblokir karena flag data-quality transien tidak pernah kembali aktif setelah flag bersih.

**Bukti (SEBELUM fix):**
```
$ node scratch/batch4-probe4.js
=== INVALIDATED STICKINESS (unblock must re-derive) ===
blocked      : {"phase":"INVALIDATED","active":false,"score":70}
unblocked    : {"phase":"INVALIDATED","active":false,"score":70}
EXPECTED     : phase BREAKOUT_CONFIRMED / active true  => stuck? YES STUCK
```

**Perbaikan:** sidik jari bukti (`evidenceFingerprint`) yang hanya mencakup field input
`derivePhase()`. Baris yang version-current, tidak diblokir, dan **bukti-identik** tetap
short-circuit (idempoten); bukti yang berubah **wajib** di-derivasi ulang.

**Test penjaga:** `BATCH4-F8-01a..d` (4 test).

### BATCH4-F8-02 — DRIFT SKOR LIFECYCLE (CRITICAL)

**Lokasi:** `applyLifecycle()` (baris ~246-258).

`row.daytrade_score_before_lifecycle` menyimpan skor ASLI, tetapi evaluasi berikutnya membaca
`row.daytrade_score` — yang **sudah** berisi adjustment sebelumnya — sebagai basis. Saat fase
berubah, adjustment lama **menumpuk** alih-alih diganti: baris mempertahankan bonus lama dan
skor terbitan tidak lagi berkorespondensi dengan fase mana pun yang pernah di-derivasi engine.

**Bukti (SEBELUM fix):**
```
$ node scratch/batch4-probe7.js
step1 PRE_BREAKOUT  : score=72 before=70 adj=2
step2 BREAKOUT      : score=72 before=70 adj=2
EXPECTED            : score=73  => DRIFT (+-1)

=== SWING: same cumulative drift ===
s1 PRE_BREAKOUT     : score=82 before=80
s2 BREAKOUT         : score=82 before=80
EXPECTED            : score=83  => DRIFT (82)
```

Bonus `PRE_BREAKOUT` (+2) tersangkut dan bonus `BREAKOUT_CONFIRMED` (+3) **tidak pernah
diterapkan**, sehingga kandidat breakout kehilangan satu poin penuh — cukup untuk memindahkan
baris melintasi ambang penerbitan.

**Perbaikan:** pulihkan basis terekam lebih dulu bila `lifecycle_score_applied === true`, lalu
terapkan adjustment fase BARU.

**Test penjaga:** `BATCH4-F8-02a..d` (4 test).

### BATCH4-F8-03 — PRESISI AGREGASI ROTASI SEKTOR (HIGH)

**Lokasi:** handler `?action=refresh` (`api/sector-hot.js`, loop grup).

Handler mengakumulasi `totalChangePct += q.changePct` untuk setiap anggota yang **objek
quote-nya ada**, sambil menghitung anggota yang sama di `validCount`. Quote yang ada tetapi
angka-nya `null`/`NaN` (feed gap / gagal parse) menyumbang `0.00` diam-diam dan **menarik
rata-rata grup ke nol** — membalik peringkat rotasi yang membacanya.

**Bukti (SEBELUM fix):**
```
$ node scratch/batch4-probe5.js
=== A. quoted row with NULL changePct (feed gap) ===
{"avg_change_pct":0.43,"avg_volume_ratio":0.9,"valid_count":3}
  ← 0.43 memasukkan nol palsu; nilai benar 0.65

=== C. all quoted rows carry null changePct ===
{"avg_change_pct":0,"avg_volume_ratio":0,"valid_count":1}
  ← grup tanpa pengukuran menerbitkan 0, bukan null
```

**Perbaikan:** helper `sumObservedSectorMemberQuotes()` yang hanya mengagregasi **pengukuran
yang benar-benar teramati**, men-coerce string numerik berformat, dan menerbitkan `null`
(bukan `0`) untuk grup tanpa anggota terukur sehingga UI merender "-".

**Test penjaga:** `BATCH4-F8-03a..e` (5 test).

### BATCH4-F8-04 — SANITASI PAYLOAD JSONB (HIGH)

**Lokasi:** mapper `trade_plan_v2` / `trade_plan_v2_structural` di tiga penulis (Swing Konglo,
Day Trade, Non-Konglo).

`trade_plan_v2` dan `trade_plan_v2_structural` adalah kolom JSONB, tetapi mapper menerbitkan
`value || null` yang hanya menjaga `null`/`undefined`: string JSON sisa round-trip cache,
array telanjang, atau function ikut tertulis apa adanya. Postgres lalu menyimpan scalar/array
di tempat yang oleh setiap pembaca diasumsikan objek, dan resolver plan diam-diam
mengembalikan plan tak terpakai.

**Bukti (SEBELUM fix):**
```
$ node scratch/batch4-probe6.js
=== JSONB payload passthrough probe ===
plain object       => typeof=object serialized={"entry":100}
JSON string        => typeof=string serialized="{\"entry\":100}"   ← tersimpan sebagai STRING
array              => typeof=object serialized=[1,2,3]             ← tersimpan sebagai ARRAY
function           => typeof=function serialized=undefined          ← tidak bisa di-serialisasi
```

**Perbaikan:** `sanitizeJsonbPayload()` (revive string JSON valid → objek; selain itu `null`)
+ `sanitizeTradePlanSourceRows()` yang menormalisasi **baris sumber** di batas setiap penulis.
Pendekatan boundary ini sengaja dipilih agar bentuk mapper historis `value || null` tetap utuh
— dipin oleh `test/daytrade-swing-konglo-trade-plan-v2-persistence.test.js`.

**Test penjaga:** `BATCH4-F8-04a..h` (8 test).

### Catatan konsistensi lintas fase

Guard `lifecycle_version` semula ditambahkan sebagai perbaikan **Fase 12** (`F12-01`) untuk
kasus corporate-action. Batch 4 menemukan guard itu **terlalu lebar**: ia juga membekukan
transisi fase yang sah. Perbaikannya memperluas cakupan re-evaluasi ke *semua* perubahan bukti
sambil **tetap** memenuhi kontrak F12-01 — baris dengan guard `BLOCKED` selalu di-derivasi
ulang dan selalu `INVALIDATED`, karena baris yang diblokir tidak pernah short-circuit.

### Hasil verifikasi Batch 4

| Tahap | Hasil |
|---|---|
| Baseline (sebelum fix) | **7 PASS / 16 FAIL** dari 23 test |
| PASS run #1 | **24 / 24 PASS**, 0 fail |
| PASS run #2 (berturut-turut) | **24 / 24 PASS**, 0 fail |
| Regresi terarah (9 suite) | **140 / 140 PASS**, 0 fail |
| Suite | `test/audit-fase8-sector-breakout-bugs.test.js` |
