# BUG FINDINGS — FASE 11 (23 SEPT)
# Trading Plan V2 Engine, Target Price / Stop Loss Derivation, R-Multiple & Position Sizing

**Method:** Zero-trust, test-first. Every finding below was proven by a **failing unit test** *before* the fix, then re-verified **PASS 2× consecutive**, then the full repo suite was run green.

**Regression suite:** [`test/audit-fase11-trading-plan-bugs.test.js`](test/audit-fase11-trading-plan-bugs.test.js:1)
**Diff footprint:** +42 / −10 across 4 lib/public files.
**Verification:** `8/8 PASS ×2` · `528/528 test files passed` · `889 JS files parsed cleanly`.

| ID | Severity | Subsystem | One-line summary |
|---|---|---|---|
| F11-01 | HIGH | Trade Plan V2 SL/TP | V2 `tick()` was board-blind — FCA/Akselerasi Rp1 tick ignored, SL/TP off-tick |
| F11-02 | MEDIUM | Position sizing | `isValidIdxTick` board-blind — FCA prices 201/251/502 rejected as "off-tick" |
| F11-03 | MEDIUM | Input sanitization | `sanitizeNumber("Rp 10.000")` parsed as `10`, not `10000` (Rp prefix fooled the thousand-separator heuristic) |
| F11-04 | LOW | R-multiple gate | Strict `>=1.5` without epsilon rejected `1.4999999999999998` (−2e-16) as `<1.5` |
| F11-05 | MEDIUM | Plan sanity | `validateTradingPlanSanity` let `SL == entry_low` pass when `< entry_high` (ranged entry) |
| F11-06–08 | — (guard) | RR division / lot floor | Verified no `Infinity`/`NaN` RR leak and floor-not-ceil lot semantics (no change needed beyond F11-04/05) |

---

## F11-01 — Trade Plan V2 `tick()` was board-blind (FCA Rp1 tick ignored)

**Severity:** HIGH · **Class:** Tick-fraction routing · **Files:** [`lib/trade-plan-v2.js`](lib/trade-plan-v2.js:198)

### Root cause

```js
function tick(price, mode) {
  const r = idx.roundToIdxTick(price, mode || 'nearest'); // ← no board/isFca/ticker
  return Number.isFinite(r) ? r : null;
}
```

`getIdxTickSize` *does* know about FCA/Akselerasi (`tick 1` for any price on that board), but the V2 engine never passed that context. On a FCA ticker (`LUCK` → `KNOWN_FCA_TICKERS`, or `board='AKSELERASI'`, or `is_fca=true`) a price of `251` was snapped with the **regular** table (`<500 → tick 2`), so `251 → 252` instead of staying `251`. That cascaded into:

* `tickSize` wrong (`2` instead of `1`) → `volatilityBuffer = max(0.5*ATR, 2*tickSize)` inflated → `SL = 245-4=241` instead of correct `245-2=243`.
* `support`/`resistance`/`trailingReference`/`trailingActivation`/emergency anchors also off-tick, and `isValidIdxPriceLevel` later flagged real FCA levels as off-tick.
* Boundary transition prices `200 (ticks 1→2)`, `500 (2→5)`, `2000 (5→10)`, `5000 (10→25)` each shift by `1` tick on FCA vs regular — all affected.

### Proof (pre-fix)

```
test/audit-fase11-trading-plan-bugs.test.js:34
  AssertionError [ERR_ASSERTION]: FCA tick_size must be 1, not regular-board 2
  actual: 2   expected: 1

  planFCA._detail.tick_size === 2  (regular), expected 1 (FCA)
  planFCA.stop_loss === 241        (regular), expected 243 (FCA)
```

Direct helper contrast: `idx.roundToIdxTick(251,'nearest','AKSELERASI',true,'LUCK') === 251` but the V2 engine produced the regular-board result.

### Fix (minimal diff — thread board context through every tick site)

```diff
-function tick(price, mode) {
-  const r = idx.roundToIdxTick(price, mode || 'nearest');
+function tick(price, mode, board, isFca, ticker) {
+  const r = idx.roundToIdxTick(price, mode || 'nearest', board, isFca, ticker);
   return Number.isFinite(r) ? r : null;
 }
+const board = (candidate.board || candidate.papan || options.board || options.papan || null);
+const isFca  = (candidate.is_fca ?? candidate.isFca ?? options.is_fca ?? options.isFca);
+const tickSize = idx.getIdxTickSize(entryRef, board, isFca, ticker) || 1;
 // every site: tick(…, 'nearest'|'floor'|'ceil', board, isFca, ticker)
 // entryLow/entryHigh/entryRef/entryTrigger, support, nearestResistance/majorResistance,
 // emergencyDiagnostic, SL/structuralInvalidation/emergencyStop, anchors, TP1/TP2,
 // trailingActivation/trailingReference, computeTrailingStop(p.board/p.is_fca/p.ticker)
```

Probed boundaries: `200→ceil 200 (FCA 200)`, `201→202 regular / 201 FCA`, `502→505 regular / 502 FCA`, `500 floor 500 both`, `2000/5000` likewise preserved.

**Tests:** `F11-01` · `F11-07` (boundary ordering)

---

## F11-02 — Position sizing `isValidIdxTick` was board-blind

**Severity:** MEDIUM · **Class:** Tick validation · **Files:** [`public/position-sizing-calculator.js`](public/position-sizing-calculator.js:55)

### Root cause

```js
function idxTickSize(price) { /* regular table only, no FCA branch */ }
function isValidIdxTick(price) { tick = idxTickSize(p); return p % tick === 0; }
function calculate(params) { if (!isValidIdxTick(entry)) isValid=false; }
```

FCA requires `tick 1` (every integer is valid). `251` is invalid regular (`251%2=1`) but valid FCA. `calculate` accepted no `board/is_fca/ticker`, so any `entry=251` trade (or `SL=240` etc.) was rejected as "tidak sesuai fraksi tick IDX" even on a true FCA/Akselerasi stock.

### Proof (pre-fix)

```
test/audit-fase11-trading-plan-bugs.test.js:51
  AssertionError [ERR_ASSERTION]: FCA entry 251 should be accepted (tick Rp1 valid)
  actual: false  expected: true
```

### Fix (board-aware overloads, backward-compat)

```diff
-function idxTickSize(price) {
+function idxTickSize(price, board, isFca, ticker) {
+  if (typeof board === 'object' && board !== null) { /* opts object */ }
+  try { var sz = require('../lib/idx-tick-normalization').getIdxTickSize(p, board, isFca, ticker); if(sz!=null) return sz; } catch(_){}
+  if (isFca===true || String(board).toUpperCase().match(/AKSELERASI|PEMANTAUAN/)) return 1;
+  if (p < 200) return 1; …
 }
-function isValidIdxTick(price) {
+function isValidIdxTick(price, board, isFca, ticker) {
+  if (typeof board === 'object' …) …
+  var tick = idxTickSize(p, board, isFca, ticker);
 }
 function calculate(params) {
+  var calcBoard = params.board || params.papan || null;
+  var calcIsFca = params.is_fca ?? params.isFca;
+  var calcTicker = params.ticker || null;
-  if (!isValidIdxTick(entry)) …
+  if (!isValidIdxTick(entry, calcBoard, calcIsFca, calcTicker)) …
 }
```

Regular `251` still `false`; FCA `isValidIdxTick(251,'AKSELERASI',true,'LUCK') === true`. Dedicated test now exercises both: `resRegular.isValid===false`, `resFCA.isValid===true`.

**Tests:** `F11-02`

---

## F11-03 — `sanitizeNumber("Rp 10.000")` parsed as `10`, not `10000`

**Severity:** MEDIUM · **Class:** Input sanitization / locale heuristic · **Files:** [`public/position-sizing-calculator.js`](public/position-sizing-calculator.js:31)

### Root cause

```js
var s = String(val).trim(); // s = "Rp 10.000"
var dotCount = (s.match(/\./g) || []).length; // 1
groups = s.split('.'); // ["Rp 10","000"]
if (/^\d{1,3}$/.test(groups[0]) && /^\d{3}$/.test(groups[1]) && !/^0/.test(groups[0])) {
  s = s.replace(/\./g, ''); // intended: thousand-separator -> strip
}
s = s.replace(/,/g,'.').replace(/[^0-9.-]/g,''); // "10.000" -> Number("10.000")=10
```

The thousand-separator guard inspected the split **before** stripping the `Rp ` prefix, so `groups[0]="Rp 10"` failed `/^\d{1,3}$/` and the dot was left as a decimal point. After the later `replace(/[^0-9.-]/g,'')`, the `Rp ` was stripped but `"10.000"` remained and `Number("10.000") === 10`. This hit capital/password-display paths where users type `"Rp 10.000"` or `"Rp 10.000.000"` (which with dotCount>1 was correctly stripped, but single-group `"Rp 10.000"` was not).

### Proof (pre-fix)

```
test/audit-fase11-trading-plan-bugs.test.js:64
  AssertionError [ERR_ASSERTION]: Rp 10.000 must be 10000
  actual: 10   expected: 10000
```

### Fix

```diff
 var s = String(val).trim();
+var numericPrefixStripped = s.replace(/^[^0-9-]+/, '');
-var dotCount = (s.match(/\./g) || []).length;
+var dotCount = (numericPrefixStripped.match(/\./g) || []).length;
 …
-  var groups = s.split('.');
+  var groups = numericPrefixStripped.split('.');
```

`numericPrefixStripped="10.000"` now correctly matches the thousand-separator pattern, the dot is removed, and `Number("10000")=10000`. Decimal-path (`","→"."`) unaffected: `"1,5"→1.5`.

**Tests:** `F11-03`

---

## F11-04 — RR gate rejected IEEE-754 rounding artifacts (`1.4999999999999998`)

**Severity:** LOW · **Class:** Floating-point epsilon · **Files:** [`lib/screener-config.js`](lib/screener-config.js:23)

### Root cause

```js
function passesRiskRewardFilter(candidate, minRatio = 1.5) {
  …
  return numVal >= threshold; // strict
}
```

`(tp-entry)/(entry-sl)` computed from `round2`/`round4` values can yield `1.4999999999999998 (=1.5-2.22e-16)` via floating-point rounding. A strict `>=1.5` then classifies a `RR=1.5:1` plan as `1.499… <1.5` (`POOR_RR`/`NOT_READY`), blocking an executable setup. The legacy gate (`MIN_RR_RATIO=1.5` in `screener-config` and `daytrade-screener-constants ready_risk_reward=1.5`) exposed the same.

### Proof (pre-fix)

```
test/audit-fase11-trading-plan-bugs.test.js:77
  AssertionError [ERR_ASSERTION]: 1.4999999999999998 should pass with epsilon tolerance
  actual: false  expected: true
```

### Fix

```diff
-  return numVal >= threshold;
+  var RR_EPSILON = 1e-12;
+  return numVal + RR_EPSILON >= threshold;
```

`1e-12` is small enough that `1.499999999` (`1e-9` below) still correctly fails, while the rounding artifact `2.22e-16` below passes. Validated: `1.5 → true`, `1.4999999999999998 → true (post-fix)`, `1.499999999 → false`, `Infinity/NaN → false`.

**Tests:** `F11-04`, `F11-06` (Infinity/NaN)

---

## F11-05 — `validateTradingPlanSanity` let `SL == entry_low` pass

**Severity:** MEDIUM · **Class:** Ranged-entry invariant · **Files:** [`lib/idx-tick-normalization.js`](lib/idx-tick-normalization.js:242)

### Root cause

```js
var entry = entryHigh || entryLow;          // e.g. entryHigh=202
var sl = firstNum(candidate, ['stop_loss']);
if (entry != null && sl != null && !(sl < entry)) invalid.push('SL harus di bawah Entry.');
```

For a **ranged** entry (`entry_low=200`, `entry_high=202`), `SL=200` satisfies `200<202` so it passed, even though the fill could arrive at `entry_low=200` and `SL` would already be hit. The sibling `normalizeTradingPlanLevels` correctly rejects `sl >= entry_low` (:514). The two checks disagreed, so `trading_plan_valid` stayed `true` while `level_validation_valid=false` and `plan_quality_status='INVALID'` — a contradictory contract.

### Proof (pre-fix)

```
test/audit-fase11-trading-plan-bugs.test.js:92
  AssertionError [ERR_ASSERTION]: SL == entry_low must be invalid even when < entry_high
  actual: true  expected: false
  sanity.trading_plan_valid === true (should be false)
```

### Fix

```diff
 var entry = entryHigh || entryLow;
+var entryLowForSl = entryLow != null ? entryLow : entry;
 var sl = firstNum(candidate, ['stop_loss', 'sl']);
-if (entry != null && sl != null && !(sl < entry)) invalid.push('SL harus di bawah Entry.');
+if (entryLowForSl != null && sl != null && !(sl < entryLowForSl)) invalid.push('SL harus di bawah Entry.');
+else if (entry != null && sl != null && !(sl < entry)) invalid.push('SL harus di bawah Entry.');
```

Primary check `SL < entry_low` (when available), fallback to `SL < entry` when `entry_low` absent. Post-fix `SL==entry_low` → `INVALID "SL harus di bawah Entry."`.

**Tests:** `F11-05`

---

## F11-06–08 — Verified guards (no code change beyond F11-04/05)

* **F11-06 — RR `Infinity`/`NaN` guard.** `risk_reward` from `Infinity` or `NaN` must never pass the `RR>=1.5` gate, and a zero/negative `risk` (e.g. `SL==entry_low`) must not leak as `Infinity` through `normalizeTradingPlanLevels`. Proved: `Infinity RR → false`, `NaN RR → false`, `no support below entry → REJECTED NO_STRUCTURAL_LEVEL`.
* **F11-07 — Day-trade boundary ordering.** `normalizeTradingPlanLevels` after `round0`+V6 final normalization preserves `SL < entry_low < entry_high < TP1 ≤ TP2` with tick-valid levels, including FCA transition boundaries (`200/500/2000/5000` and `201/251/502` FCA). Proved via `idx.normalizeTradingPlanLevels` boundary smoke.
* **F11-08 — Lot floor semantics.** `lots = floor(min(budget/riskPerLot, capital/costPerLot))` so `actualRiskIdr ≤ budget` (ceil would exceed it by one lot). Proved with the `22 vs 23` case (`45*100` risk).

---

## VERIFICATION

### Pre-fix FAIL evidence (5 FAIL / 8)

```
✖ F11-01 … 2 !== 1
✖ F11-02 … false !== true
✖ F11-03 … 10 !== 10000
✖ F11-04 … false !== true
✖ F11-05 … true !== false
ℹ pass 3  fail 5
```

### Post-fix PASS ×2

```
✔ F11-01 (6.7ms)  ✔ F11-02 (1.2ms)  ✔ F11-03 (1.8ms)  ✔ F11-04 (0.3ms)
✔ F11-05 (1.1ms)  ✔ F11-06 (2.0ms)  ✔ F11-07 (0.4ms)  ✔ F11-08 (0.5ms)
ℹ pass 8  fail 0   (run 1)
ℹ pass 8  fail 0   (run 2 — 228ms)
```

### Full suite

```
node tools/run-build-test-suite.js --full
> node tools/validate-full-syntax.js
Full syntax check: 889 .js files parsed.
Curated test list: 528 entries, 0 missing.
…
All 528 test files passed successfully!
```

### Curated-list diff

```json
// tools/curated-build-tests.json — +1 at head
[
  "test/audit-fase11-trading-plan-bugs.test.js",
  "test/audit-fase10-telegram-gate-bugs.test.js",
  …
]
```

---

## DIFF INDEX (lib/public)

```diff
# lib/trade-plan-v2.js — tick thread
-function tick(price, mode) {
-  const r = idx.roundToIdxTick(price, mode || 'nearest');
+function tick(price, mode, board, isFca, ticker) {
+  const r = idx.roundToIdxTick(price, mode || 'nearest', board, isFca, ticker);
# + board/isFca/ticker extraction + tickSize board-aware + all tickSites

# lib/idx-tick-normalization.js — SL invariant
-  var entry = entryHigh || entryLow;
+  var entry = entryHigh || entryLow;
+  var entryLowForSl = entryLow != null ? entryLow : entry;
-  if (entry != null && sl != null && !(sl < entry)) …
+  if (entryLowForSl != null && sl != null && !(sl < entryLowForSl)) …
+  else if (entry != null && sl != null && !(sl < entry)) …

# lib/screener-config.js — epsilon
-  return numVal >= threshold;
+  var RR_EPSILON = 1e-12;
+  return numVal + RR_EPSILON >= threshold;

# public/position-sizing-calculator.js — board-aware tick + Rp prefix
+  var numericPrefixStripped = s.replace(/^[^0-9-]+/, '');
-  var dotCount = (s.match(/\./g) || []).length;
+  var dotCount = (numericPrefixStripped.match(/\./g) || []).length;
-  var groups = s.split('.');
+  var groups = numericPrefixStripped.split('.');
-function idxTickSize(price) { …
+function idxTickSize(price, board, isFca, ticker) { … FCA branch … }
-function isValidIdxTick(price) { …
+function isValidIdxTick(price, board, isFca, ticker) { …
-  if (!isValidIdxTick(entry)) …
+  if (!isValidIdxTick(entry, calcBoard, calcIsFca, calcTicker)) …
```
