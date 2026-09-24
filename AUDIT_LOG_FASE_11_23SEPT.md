# AUDIT LOG — FASE 11 (23 SEPT)
# Trading Plan V2 Engine, Target Price / Stop Loss Derivation, R-Multiple & Position Sizing

**Method:** Zero-trust, test-first, autonomy protocol 23 SEPT. Every subsystem was treated as a *hypothesis* until proven on the **current** code. Failures were reproduced by **failing unit tests** before any fix, then re-verified **PASS 2× consecutive**, then the whole repo suite was run green.

**Regression suite:** [`test/audit-fase11-trading-plan-bugs.test.js`](test/audit-fase11-trading-plan-bugs.test.js:1) — 8 tests, 8 PASS ×2.
**Full repo suite:** `528 test files passed successfully` (`node tools/run-build-test-suite.js --full`).
**Syntax:** `889 .js files parsed cleanly` · curated list `528 entries, 0 missing`.

---

## 1. REAL DEPENDENCY MAPPING (traversed, not assumed)

Candidate targets from the brief were resolved by **filesystem inspection**, not by faith in prior audit notes — file names in the brief do not match reality.

| Brief name | Real file | Exists? | Role |
|---|---|---|---|
| `lib/trading-plan-v2.js` | [`lib/trade-plan-v2.js`](lib/trade-plan-v2.js:1) | **no / alias** | Canonical V2 engine (ONE source of Entry/SL/TP/RR/trailing) |
| `lib/trading-plan-service.js` | `lib/trade-plan-v2-integration.js` + `lib/trade-plan-v2-source-adapters.js` | **no** | Screener↔V2 wiring + shadow/public gating |
| `lib/trade-planner.js` | *none* | **no** | — |
| `lib/risk-management.js` | [`lib/idx-tick-normalization.js`](lib/idx-tick-normalization.js:1) (risk labels V1/V2, tick table, RR sanity, plan quality) | **no** | Tick table + `derivePlanQuality` / `calculateRiskLabel` / `validateTradingPlanSanity` |
| `lib/position-sizer.js` | [`public/position-sizing-calculator.js`](public/position-sizing-calculator.js:1) | **no** | Lot/IDR sizing (floor to `100` shares, never `ceil`) |
| `lib/daytrade-execution-ranking.js` | [`lib/daytrade-execution-ranking.js`](lib/daytrade-execution-ranking.js:1) | **yes** | Execution-readiness ranking (delegates chase check to `daytrade-entry-discipline`) |
| `lib/daytrade-screener-engine.js` | [`lib/daytrade-screener-engine.js`](lib/daytrade-screener-engine.js:740) | **yes** | Day-trade level derivation `calculateLevels` + respect-zone refinement + V6 final tick normalization |
| `lib/idx-tick-normalization.js` | [`lib/idx-tick-normalization.js`](lib/idx-tick-normalization.js:49) | **yes** | IDX tick table (1/2/5/10/25 + FCA Rp1) + `normalizeTradingPlanLevels` / `roundToIdxTick` |

### 1.1 Canonical V2 engine

[`lib/trade-plan-v2.js`](lib/trade-plan-v2.js:1) — `buildTradePlanV2(candidate, options)` is the **single** place that derives structural SL, `TP1`/`TP2` (R-target vs nearest resistance capped by `TP1_ATR_BUFFER`), `RR`, and the ratcheting trailing stop for **all three** screeners (`DAY_TRADE` / `SWING_NON_KONGLO` / `SWING_KONGLO`). It is pure, deterministic (`generated_at` is passed in), and advisory — `REDUCE_POSITION_SIZE` never mutates a portfolio.

Profiles (`SCREENER_PROFILES` [:56](lib/trade-plan-v2.js:56)): `volatility_buffer_atr` (`0.50 / 0.75 / 1.00`), `trailing_atr_multiplier` (`1.00 / 1.50 / 2.00`), `min_rr_to_tp1` (`1.00 / 1.20 / 1.20`), `risk_budget_pct` (`4 / 8 / 10`), `reject_stop_pct` (`7 / 14 / 16`).

Additional observable diagnostics wired additively: `trade-plan-v2-candle-structure`, `trade-plan-v2-gap-areas`, `trade-plan-v2-liquidity-sweep` — all safe-neutral when no observation/gap data is supplied.

### 1.2 Tick table (IDX + FCA/Akselerasi)

Single source of truth: [`lib/idx-tick-normalization.js:getIdxTickSize`](lib/idx-tick-normalization.js:49) / [`roundToIdxTick`](lib/idx-tick-normalization.js:60) / [`isValidIdxPriceLevel`](lib/idx-tick-normalization.js:82) / [`normalizeTradingPlanLevels`](lib/idx-tick-normalization.js:473).

Regular board: `<200 → 1 | <500 → 2 | <2000 → 5 | <5000 → 10 | ≥5000 → 25`. FCA/Akselerasi/`PEMANTAUAN_KHUSUS`/known ticker (`LUCK`, `MAHA`, …) → `1`. The FCA predicate is unified via [`isExplicitTrueFlag`](lib/idx-tick-normalization.js:29) (accepts `true / 1 / 'true' / '1' / 'yes' / 'y'`, never the string `'false'`) — fixed `F7-04`/`F8-04` across tick sizing [[:52](lib/idx-tick-normalization.js:52)] and risk scoring [[:790](lib/idx-tick-normalization.js:790)].

### 1.3 Position sizing

[`public/position-sizing-calculator.js:calculate`](public/position-sizing-calculator.js:144) — risk-budget `lots = min( floor(budget / riskPerLot), floor(capital / costPerLot) )` (:186), never `ceil`, so `actualRiskIdr` never exceeds `capital * riskPct/100`. `cappedByCapital` is retained. `isValidIdxTick` is board-aware via fallback to the canonical tick table (F11-02 fix).

### 1.4 Day-trade execution ranking

[`lib/daytrade-execution-ranking.js:deriveDayTradeExecutionQuality`](lib/daytrade-execution-ranking.js:51) — separates raw score from executability. `entryDiscipline.deriveDayTradeEntryDiscipline` owns the chase pullback gate; `READY_STATUSES` (`A_PLUS_SETUP` / `TRADE_CANDIDATE` / `READY_BREAKOUT`) vs `BLOCKED_STATUSES` ([`AVOID` / `INVALID` / `INVALID_BELOW_SL`](lib/daytrade-execution-ranking.js:23)) are disjoint by construction. RR band mapping `rrBand` [[:42](lib/daytrade-execution-ranking.js:42)]: `<1.0 BLOCKED | <1.2 MARGINAL (-10) | <1.5 ADEQUATE (-4) | <2.0 GOOD (+0) | ≥2.0 STRONG (+4)`. Comparator `compareDayTradeExecution` [[:140](lib/daytrade-execution-ranking.js:140)] is lexicographic on `(bucket, executableScore, RR, rawScore, ticker)`.

### 1.5 Day-trade screener engine (level derivation block)

`calculateLevels(data)` [[:743](lib/daytrade-screener-engine.js:743)] derives `entry`, `SL`, `TP1/TP2`, `RR` before the V6 final normalization:

* Entry (`entryAnchor = max(swLow5||low, min(open,support))`, `entry_low = max(anchor, last-0.7*atr, last*0.98)`, `entry_high = min(low+0.5*atr, last*1.005, high)`), swapped when `low > high`, clamped to `last*0.98`.
* SL (`sl_swing = swLow5||low - 0.3*atr`, `sl_pct = 0.97*entryMid`, cheaper-tighter `max(sl_swing, sl_pct)`, ATR width guards `0.5–2.5*atr`, `entry_low-0.5*atr` fallback, `0.95*entryMid` cap — [[:778](lib/daytrade-screener-engine.js:778)].
* TP1 candidates (`swHigh10 || resistance`, `1.5*risk`, `resistance`; filtered by `> entryMid + 0.7*atr`, capped by breakout-confirmed logic [[:840](lib/daytrade-screener-engine.js:840)]).
* TP2 (`min(2.5*risk, 2.5*atr, 1.02*resistance)` , `tp1+0.5*atr` floor).
* Final `RR = (tp1-entryMid)/(entryMid-SL)` with `0` fallback for non-finite [[:860](lib/daytrade-screener-engine.js:860)], then `V6 normalizeLevelsToIdxTicks` [[:2117](lib/daytrade-screener-engine.js:2117)] snaps every level and recomputes RR with the tick-aware risk.
* `refineLevelsWithRespectZones` [[:2948](lib/daytrade-screener-engine.js:2948)] is guarded: zones derived from `5D/10D` touches, half-candle-debt, and `RR < minRR` triggers full fallback to base levels — no upside invented.

### 1.6 Integration

[`lib/trade-plan-v2-integration.js`](lib/trade-plan-v2-integration.js:1) — shadow/public gating, `isPlanV2Usable` (:233), and formatter path `trade-plan-v2-formatter`. `lib/trade-plan-v2-source-adapters.js` maps runtime screener structures (local supports/swing lows, ATR, demand/supply gaps, OHLC) into the canonical input so a `NO_STRUCTURAL_LEVEL` no longer falls back to recomputing support from the legacy SL.

---

## 2. FORMULA VALIDATION (risk math)

| Concern | Canonical definition | Validated? |
|---|---|---|
| Structural SL | `SL = tick( structural_anchor - max( ATR*buffer, 2*tickSize ), 'floor', board, isFca, ticker )` | F11-01 pass (FCA now correct) |
| Tick snapping | `entry:nearest, SL:floor, TP:ceil→floor at resistance` (board-aware) | boundary cases 200/500/2000/5000 + FCA 201/251/502 pass |
| R-multiple | `RR = (TP - entry) / (entry - SL)` via `round4(reward/risk)`, guarded vs `≤0` risk (`null`/`REJECTED`) | division-by-zero produces no `Infinity` (F11-06) |
| RR gate | `passesRiskRewardFilter` with epsilon `1e-12` (≈ `1.5−2e-16` passes, `1.5−1e-9` fails) | F11-04 pass |
| Position size | `riskPerLot = 100*(entry−SL)`, `lots = floor(min(budget/riskPerLot, capital/costPerLot))` with `Math.ceil` for `minCapitalFor1LotRisk` | floor never `ceil` (F11-08), negatives rejected |

The day-trade engine's `round2( n*100 )/100` ([`screener-config`](lib/screener-config.js:9), `MIN_RR_RATIO=1.5`) is the legacy screener's RR gate; V2 uses `round4` with `min_rr_to_tp1` per profile. Both were proven — the `F10-08` orderbook-label bug is already in-tree ([`getDayTradeMetrics`](lib/telegram-templates.js:470)).

---

## 3. CHECKLIST RESULTS (line-by-line)

### 3.1 Validitas fraksi tick BEI pada SL dan TP

The tick table itself was already correct. Bugs were in the **call sites**:

* F11-01 — **V2 engine was board-blind:** internal `tick(price, mode)` called `idx.roundToIdxTick` **without** `board/isFca/ticker`, so FCA (tick Rp1) was snapped with the regular table. At `255` (`tick2` regular) `251→252`, `241` vs correct `243`. Fixed by making `tick(price, mode, board, isFca, ticker)` board-aware and threading `board/isFca/ticker` from `candidate`/`options` into every `tick(..., 'nearest'|'floor'|'ceil')` site (entry, `entryRef`, `entryTrigger`, `support`, `tickSize`, resistances, emergency diagnostics, SL/invalidation/emergency, TP1/TP2, `trailingActivation`, `trailingReference`, structural anchors), and by letting `computeTrailingStop` inherit the board from `p.board/p.is_fca/p.ticker`. Probe: `251 → FCA 251` vs `regular 252`.

* F11-07 — **Day-trade `round0` + V6 normalization:** `calculateLevels` uses `round0(Math.round)` before the V6 `normalizeLevelsToIdxTicks` which re-snaps with the FCA-aware tick table (floor SL, ceil TP) and recomputes RR. The refinement path preserves ordering (`SL < entry_low < entry_high < TP1 ≤ TP2`) and the `RR < minRR` guard forces fallback to base levels when a TP lift would degrade RR. Validated with `entry 199/201 @ 195/205/210` regular + `FCA 500/505` boundaries.

* Position sizing — `isValidIdxTick`/`calculate` were board-blind: `201/251/502` (valid FCA, invalid regular tick `2/5/25`) were wrongly rejected. Fixed by adding board-aware overloads (`board/isFca/ticker` or `opts` object) to `idxTickSize`/`isValidIdxTick`, with `require('../lib/idx-tick-normalization')` passthrough (and browser fallback via `root.getIdxTickSize`) and FCA straight `→1`. `calculate(params)` now reads `board/papan/is_fca/isFca/ticker` from `params`.

* `isValidIdxPriceLevel` already board-aware; `normalizeTradingPlanLevels` correctly does `SL:floor, TP:ceil` and flags `sl >= entry_low` / `tp1 <= entry_high` as invalid. No regression.

### 3.2 Kalkulasi R-multiple & pembagian nol

* Canonical RR in [`idx.normalizeTradingPlanLevels`](lib/idx-tick-normalization.js:524): `risk_reward = round2((tp1 - entry_high) / (entry_high - sl))` — computed only when `sl < entry_low && tp1 > entry_high`. No bare `Reward/Risk` division-by-zero path leaks.
* Day-trade RR [[:858](lib/daytrade-screener-engine.js:858)]: `risk_reward = Number.isFinite(reward1/finalRisk) ? round2(reward1/finalRisk) : 0` with `finalRisk>0` guard ([`finalRisk = entryMid-SL` requiring `rlAdj...riskDistancePct`](lib/daytrade-screener-engine.js:875) near `1.5` boundary). `Infinity`/`NaN` fall to `0` and `validateTradingPlanSanity` marks the plan invalid.
* Gate `passesRiskRewardFilter` (`lib/screener-config.js` [`MIN_RR_RATIO=1.5`](lib/screener-config.js:9)) previously did strict `numVal >= threshold` — `1.4999999999999998 (=1.5-2.2e-16)` failed due to IEEE-754 rounding of a `1.5` computation. Fixed with epsilon `1e-12`: `numVal + 1e-12 >= threshold`, so `1.5-2e-16` passes while `1.5-1e-9 (=1.499999999)` still correctly fails. Verified F11-04.
* `trade-plan-v2.js:1104` computes `rrToTp1 = round4(reward/riskAmount)` with `riskAmount` guarded; `riskAmount <= 0` would be caught by the `STOP_NOT_BELOW_ENTRY` reject earlier.

### 3.3 Position sizing & pembulatan lot

`public/position-sizing-calculator:calculate` (:186): `lots = min(floor(budget/riskPerLot), floor(capital/costPerLot))`, `riskPerLot=100*deltaP`, `costPerLot=100*entry`, `actualRisk= lots*riskPerLot ≤ maxRiskBudget` because `floor` never `ceil`. `minCapitalFor1LotRisk = ceil(riskPerLot / (riskPct/100))` correctly floors to the smallest safe capital. `<1 lot` → `lots=0` with `actualRisk=0`. The delta `entry-SL <= 0` early exit returns `isValid:false` with the correct guard label, before any division. Dedicated F11-08 test pins the `floor` vs `ceil` value (`22` vs `23`) and the `≤ budget` invariant.

### 3.4 Sanitasi input & fallback default

* `sanitizeNumber` / `coerceNumeric` / `toNum` / `num` are number-safe: `null/""/undefined → fallback`, non-finite → `null`/`fallback`, never `NaN` leak. The position calculator's map `sanitizeNumber(entry,0)` then validates `entry/sl <=0 → isValid:false`.
* F11-03 — `sanitizeNumber` bug: the dot-count thousand-separator heuristic ran on the raw string including the `Rp ` prefix, so `"Rp 10.000"` had `groups=["Rp 10","000"]` which failed `/^\d{1,3}$/` and the dot was left as a decimal point; after `replace(/[^0-9.-]/g,'')` → `"10.000"` → `Number("10.000")=10`. Fixed by running the dot heuristic on `numericPrefixStripped = s.replace(/^[^0-9-]+/, '')` (`"10.000"`), so the single dot is recognised as a thousand separator and removed before `Number("10000")`.
* F11-05 — `validateTradingPlanSanity` used `entry = entryHigh || entryLow` and rejected only `sl < entry`. That let `entry_low=200, entry_high=202, sl=200` pass (`200<202`) even though `SL == entry_low` (ranged entry starts at `entry_low`). Fixed: primary check `sl < entry_low` (`entryLowForSl = entryLow ?? entry`), with the old `sl < entry` as secondary fallback when `entry_low` is absent.
* FCA `is_fca` as `'false'` string is now correctly not-FCA via `isExplicitTrueFlag`; ticker `LUCK` forces FCA regardless of flag.

---

## 4. METRICS

| Metric | Value |
|---|---|
| Files audited (read fully) | 6 + 4 deps (trade-plan-v2, idx-tick-normalization, screener-config, position-sizing-calculator, daytrade-screener-engine, daytrade-execution-ranking; + integration, source-adapters, constants, screener-config) |
| Bugs found & fixed | 5 (board-blind V2 tick, board-blind position sizing, `Rp ` thousand-separator, RR epsilon, `SL<entry_low` check) |
| New tests | 8 (`audit-fase11-trading-plan-bugs.test.js`) |
| Fix footprint | **+42 / −10** across 4 files (plus 2-file test amendment) |
| Curated-list delta | +1 (`528 entries, 0 missing`) |
| Full-suite result | **528/528 test files passed** |
| Syntax validation | **889/889 JS files parsed cleanly** |

---

## 5. ERROR-HANDLING MATRIX (post-fix)

| Scenario | `idx.normalizeTradingPlanLevels` | `trade-plan-v2.buildTradePlanV2` | `PositionSizing.calculate` |
|---|---|---|---|
| No support below entry | `level_validation_valid=false → tick_normalized=false` | `REJECTED NO_STRUCTURAL_LEVEL` | n/a |
| `SL >= entry_low` | `level_validation_valid=false` + `trading_plan_valid=false` (F11-05 strict) | `REJECTED STOP_NOT_BELOW_ENTRY` | `isValid:false 'SL harus lebih rendah …'` |
| `risk ≤ 0` / `RR Infinity/NaN` | no RR, marked invalid | rejected before RR | `Infinity→false` filter, lots 0 |
| `RR = 1.499…-eps` near gate | `rr_minimum=1.5` ⇒ `POOR_RR` | `WARNING/REJECTED` per profile `min_rr_to_tp1` | `passesRiskRewardFilter` epsilon correct |
| FCA tick (`201/251/502`) | FCA passthrough → valid | `tickSize=1`, SL correct (**243** not **241**) | FCA `isValidIdxTick(…, board,…)` true |
| `Rp 10.000` string | n/a | n/a | `sanitizeNumber → 10000` (was 10) |
| Budget too small for 1 lot | n/a | n/a | `lots=0, actualRisk=0, positionValue=0` |

---

## 6. DIFF INDEX

Finest-grained index: see `BUG_FINDINGS_FASE_11_23SEPT.md` per-id `git diff -U` excerpts. Raw stat:

```
 lib/idx-tick-normalization.js        |  3 ++-
 lib/screener-config.js               |  2 +-
 lib/trade-plan-v2.js                 | 26 +++++++++++++++++++-------
 public/position-sizing-calculator.js | 29 ++++++++++++++++++++++++-----
 4 files changed, 42 insertions(+), 10 deletions(-)
```
