# AUDIT LOG — FASE 12 (23 SEPT)
# Trade Engine Core, Signal Generator State Machine, Multi-Indicator Confluence & Signal Dispatcher

**Method:** Zero-trust, test-first, autonomous protocol 23 SEPT. Every subsystem was treated as a *hypothesis* until proven on the **current** code. Failures were reproduced by **failing unit tests** before any fix, then re-verified **PASS 2× consecutive**, then the whole repo suite was run green.

**Regression suite:** [`test/audit-fase12-trade-engine-bugs.test.js`](test/audit-fase12-trade-engine-bugs.test.js:1) — 6 tests, 6 PASS ×2.
**Full repo suite:** `529 test files passed successfully` (`node tools/run-build-test-suite.js --full`).
**Syntax:** `890 .js files parsed cleanly` · curated list `529 entries, 0 missing`.

---

## 1. REAL DEPENDENCY MAPPING (traversed, not assumed)

Candidate targets from the brief were resolved by **filesystem inspection** — file names in the brief do not match reality. The actual trade/signal machinery is spread across these real modules:

| Brief name | Real file | Exists? | Role |
|---|---|---|---|
| `lib/trade-engine.js` | *none* | **no** | — (no single trade engine; logic is in lifecycle + V2 + screener engines) |
| `lib/signal-generator.js` | *none* | **no** | — (signal is `deriveSignalVerdict` + `reversal-breakout-lifecycle` + `daytrade-screener-engine-v7`) |
| `lib/trade-signal-service.js` | *none* | **no** | — |
| `lib/signal-state-machine.js` | [`lib/reversal-breakout-lifecycle.js`](lib/reversal-breakout-lifecycle.js:1) | **alias** | The only file that models a state machine (`PHASES`: `REVERSAL_EARLY → PRE_BREAKOUT → BREAKOUT_CONFIRMED → POST_BREAKOUT_CONTINUATION → INVALIDATED/NONE`) |
| `lib/trade-lifecycle.js` | [`lib/reversal-breakout-lifecycle.js`](lib/reversal-breakout-lifecycle.js:1) | **alias** | same |
| `api/trade-engine.js` | *none* | **no** | — |
| `api/signal-runner.js` | [`api/sector-hot.js`](api/sector-hot.js:1) | **alias** | Dispatches `screening` ↔ `trade_plan_v2` ↔ `telegram-notifier`; signal ranking via `api/analyze.js` |
| `lib/confluence-validator.js` | [`lib/bandarmologi-service.js: evaluateConfluenceSignal`](lib/bandarmologi-service.js:2630) + [`lib/bandarmologi-confluence.js`](lib/bandarmologi-confluence.js:1) + [`lib/daily-foreign-context.js`](lib/daily-foreign-context.js:1) | **alias** | Confluence is not a single file but a 3-way merge: broker/bandar + foreign flow + technical breakout |
| `lib/entry-trigger-evaluator.js` | [`lib/daytrade-execution-ranking.js`](lib/daytrade-execution-ranking.js:1) + [`lib/daytrade-entry-discipline.js`](lib/daytrade-entry-discipline.js:1) + [`lib/idx-tick-normalization.js: deriveSignalVerdict`](lib/idx-tick-normalization.js:892) | **alias** | Entry gate |

### 1.1 Signal state machine — the real one

[`lib/reversal-breakout-lifecycle.js`](lib/reversal-breakout-lifecycle.js:4) — `PHASES` and `derivePhase(row, context)` is the **only** canonical state machine that scores a candidate:

* Input: `row` (`last_price/resistance/support/breakout_confirmation_status/volume_ratio/status/risk_label/corporate_action_guard/data_quality_*`) + `context` (`mode/blocked/applyScore`).
* Output: `{ phase, phase_number, phase_label, confidence, breakout_quality, volume_quality, chase_risk }` and `scoreAdjustment` (`-2…+3`) applied via `applyLifecycle`.
* No cron, no memory store — idempotent row enrichment. Persistence is by **rewriting the row**; re-application is guarded by `lifecycle_version === VERSION`.

`lib/daytrade-screener-engine-v7.js` is the day-trade recall path that **re-applies** that lifecycle during VPS EOD closeout (`isSafeStructure` guard). `api/sector-hot.js` applies it inline for Swing.

### 1.2 Canonical V2 engine

[`lib/trade-plan-v2.js: buildTradePlanV2`](lib/trade-plan-v2.js:661) — ONE canonical derivation of `entry_zone`, structural SL, TP1/TP2 (R-target vs nearest resistance capped by `TP1_ATR_BUFFER`), RR, trailing activation and `emergency_stop` for **all three** profiles (`DAY_TRADE / SWING_NON_KONGLO / SWING_KONGLO`). Deterministic, advisory-only (`REDUCE_POSITION_SIZE` never mutates a portfolio). Observable diagnostics (`candle-structure`, `gap-areas`, `liquidity-sweep`) are additive and neutral when no observation/gap data is supplied.

Integration seam: [`lib/trade-plan-v2-integration.js`](lib/trade-plan-v2-integration.js:1) — `isPlanV2Usable` / `resolvePublicTradePlan` / `buildProductionTrailing` / `decorateRowsForWeb`. Formatter: `lib/trade-plan-v2-formatter.js`. Source adapters: `lib/trade-plan-v2-source-adapters.js`.

### 1.3 Confluence validator — the real one

Three layers, not one:

1. **Swing gate**: [`lib/swing-screener-engine.js: verifySwingHighConviction`](lib/swing-screener-engine.js:255) — calls `evaluateConfluenceSignal`; on `HINDARI` (massive distribution in both bandar and foreign) it returns `null` (fatal reject).
2. **Bandarmologi display confluence**: [`lib/bandarmologi-confluence.js`](lib/bandarmologi-confluence.js:1) — `computeBandarmologiConfluence(ticker)` windows `3D/7D/1M(≥20 days)/3M(≥60 days)` with `MEMORY_CACHE` 45 min; feeds badge `Accumulation/Distribution/Mixed` via `getBandarTrendLabel`.
3. **Foreign daily context**: [`lib/daily-foreign-context.js: buildForeignContext`](lib/daily-foreign-context.js:45) — `foreign_net_today/3d/5d/7d` with `sessions_missing` and streak; treats `null` as **missing** (excluded from sums), not zero.

Authoritative foreign source: [`lib/bandarmologi-service.js: getNetForeignFlow`](lib/bandarmologi-service.js:2555) + [`evaluateConfluenceSignal`](lib/bandarmologi-service.js:2630) — day-level `readDiskCache('broker-summary', ticker, date)` with thresholds `|foreignNet| > 2M` + whale ratio `buy/sell < 0.25` + `net_status BIG_*`.

### 1.4 Dispatcher / signal verb

The repo has **no `WATCHLIST→ARMED→TRIGGERED→CONFIRMED→EXITED`** state machine as named. The real dispatcher verbs are:

* Screener scoring + `status` strings (`A_PLUS_SETUP / TRADE_CANDIDATE / READY_BREAKOUT / EARLY_RADAR / … / INVALIDATED`) → `deriveSignalVerdict` → `signal_action` (`ENTRY_AREA / WATCHLIST / WAIT_PULLBACK / AVOID / DATA_LIMITED`) in [`lib/idx-tick-normalization.js: deriveSignalVerdict`](lib/idx-tick-normalization.js:892) → `confidence` capped by `applyRiskV2ConfidenceGuard`.
* Execution ranking: [`lib/daytrade-execution-ranking.js: deriveDayTradeExecutionQuality`](lib/daytrade-execution-ranking.js:51) — `execution_bucket` `EXECUTABLE / PENDING / BLOCKED`.

---

## 2. STATE MACHINE TRANSITIONS (matrix)

| From / guard | Guard | To | Confidence | Volume chase penalty |
|---|---|---|---|---|
| any + `blocked/data_quality_valid===false/corporate_action_guard==='BLOCKED'/status ∈ AVOID/INVALID/TP*_HIT/risk VERY HIGH` | `isBlocked` | `INVALIDATED` | 100 | — |
| `postByStatus ∪ extendedFollowThrough(≥1.03×res, ≥1.0 vol, ≥2.5% chg, ≥3% chase)` | — | `POST_BREAKOUT_CONTINUATION` | 68±10±3±8 | HIGH −2 |
| `BREAKOUT_CONFIRMED ∨ (READY_* ∧ price≥res ∧ vol≥1.0)` | — | `BREAKOUT_CONFIRMED` | 72±… | WEAK −2 |
| `PRE_BY_STATUS ∨ (distToBreakout ≤3 ∧ ≥−1 ∧ vol≥0.8)` | — | `PRE_BREAKOUT` | 64±… | — |
| `REVERSAL_BY_STATUS ∨ (price>support ∧ 30≤rsi≤50 ∧ chg≥0)` | — | `REVERSAL_EARLY` | 58±… | — |
| none matched | — | `NONE` | 45 (no bonus) | — |

Deadlock concern: `BREAKOUT_CONFIRMED` requires either **explicit `BREAKOUT_CONFIRMED` status** or `priceAboveResistance + volume≥1.0` with a `READY_*` status. A row with price **just below** resistance and no qualifying status sits in `PRE_BREAKOUT` or `NONE` forever — but that is intentional (no volume-confirmed breakout ⇒ no promotion). There is **no intermediate TRIGGERED that stalls** in this machine; the stalling surface lives in `api/analyze.js`'s richer `deriveSignalVerdict` flow, which is correctly conservative (`WATCHLIST` fallback when entry not in zone or RR unattractive).

**Expiry / stale surfaces**: `data_quality_valid===false / data_quality_needs_revalidation / stash stale label` → `INVALIDATED` (not a time-based expiry). There is **no `$N` minutes expiry clock** for TRIGGERED→CONFIRMED; instead, `deriveSignalVerdict` downgrades `Very High Risk / Weak Respect / Stale Data / Below SL` to `AVOID/DATA_LIMITED` with priority 78–100, which is the de-facto expiry. No in-memory `Map` of signals is kept across requests (Vercel serverless) — the only in-memory cache is `bandarmologi-confluence MEMORY_CACHE` (TTL 45 min) and `daytrade-ohlcv-cache`.

---

## 3. MULTI-INDICATOR CONFLUENCE (weighting)

Technical breakout is the **primary gate**; bandarmologi/foreign are **confluence modulators**, not co-equal weights:

* **Swing** (`verifySwingHighConviction`): `evaluateConfluenceSignal` with **fatal** `HINDARI` path — if `is_massive_distribution` (foreign `BIG_DISTRIBUTION` + negative foreign net and whale `net_flow<-3B`), the score-positive technical breakout is **rejected entirely** (`return null`). No technical dominance bypass.
* **Day-trade**: `confluence` currently only decorates (risk/foreign fields are surfaced but `verifySwingHighConviction` is not called for day-trade). Foreign omission is therefore **not** a blocker for day-trade — intentional; day-trade frequency would collapse if EOD foreign were mandatory.
* **Foreign null ⇒ `NEUTRAL`**: `evaluateConfluenceSignal` returns `NEUTRAL/HOLD/0` when `!has_data` — does **not** null-penalty a valid technical setup.
* **Bandarmologi scoring** (`lib/bandarmologi-screener-scoring.js: calculateBandarmologiScore`) is **additive** (+0…+~80, bounded clamp `0…100`) and can go **negative** (`−20` when retail chases distribution) — but the confluence block above still dominates: a beautiful bandarmologi score does not rescue a `HINDARI` row.

---

## 4. TRADING PLAN V2 + SIZING

Every `buildTradePlanV2` result always carries a **valid payload** (entry/SL/TP/RR) or a **typed `REJECTED`** with `reject_reason` (`NO_STRUCTURAL_LEVEL / STOP_NOT_BELOW_ENTRY / RISK_CANNOT_BE_CONTROLLED / INSUFFICIENT_RR / NO_RESISTANCE_TP1_UNAVAILABLE / STALE_DATA`). `isPlanV2Usable` enforces the public gate: `REJECTED` never usable, `is_stale===false` required, `rr_to_tp1 >= min_rr_to_tp1`, and `STOP_NOT_BELOW_ENTRY / RISK_CANNOT_BE_CONTROLLED / STALE_DATA / NO_STRUCTURAL_LEVEL / NO_RESISTANCE_TP1` warnings are mandatory rejections. When V2 is not usable the **legacy plan** is the fallback; tick correctness for `LUCK`/`AKSELERASI` (Rp1) was fixed in F11-01.

Expiry hygiene: `emergency_stop` (`value - 2×volatilityBuffer` below deepest major/emergency anchor) is **always** surfaced, even on `REJECTED/NO_STRUCTURAL_LEVEL`, so the operator never loses the diagnostic structural level. `DAY_TRADE` `max_structural_distance 12%` / `emergency_max 30%` are profile-owned (F11 guard was the read-site for `emergency_max`).

---

## 5. PAYLOAD SANITATION & CONCURRENCY

* **Tick sanitization**: Every price (`entryLow/High, support, resistance, SL, TP1/TP2, emergency_*`) is snapped via `tick(price, mode, board, isFca, ticker)` (F11-01 board-aware) or `normalizeTradingPlanLevels`; no `null/slot` is invented.
* **Parallel-generator guard**: The repo runs on Vercel serverless — no long-lived shared `Map` of signals across requests. Within a single scan, `runDayTradeBatch` writes each ticker's row **independently** (per-ticker `analyzeDayTrade` → per-ticker `applyLifecycle` → per-ticker `buildCandidatePlanV2`); no module-global mutable `currentRow` is reused across tickers. The sole module-global mutable that **could** leak across callers in the same warm lambda was `bandarmologi-confluence MEMORY_CACHE` — fixed as **F12-05** (clone on return) and **F12-01** stale-version guard.
* **Race hygiene**: `daytrade-intraday-eod-closeout` and `intraday-fast-watcher` apply `deriveSignalVerdict` / `applyRiskV2ConfidenceGuard` **after** lifecycle so a `Very High Risk` never ships as `ENTRY_AREA`.

---

## 6. OUTCOME

| Fix | Scope | Root cause (one line) |
|---|---|---|
| **F12-01** | `reversal-breakout-lifecycle` stale-state deadlock | `applyLifecycle` early-returned on `lifecycle_version===VERSION` so a `CORPORATE_ACTION_GUARD==='BLOCKED'` flip was never re-evaluated; row stayed `BREAKOUT_CONFIRMED` forever |
| **F12-03** | `bandarmologi-confluence` mixed-label deflation | `getBandarTrendLabel(0, +N)` (null 3d coerced to `0`) returned `Mixed` though 7D is clearly `Accumulation` |
| **F12-05** | `bandarmologi-confluence` shared-mutation leak | `computeBandarmologiConfluence` returned the **same object reference** from `MEMORY_CACHE` — caller mutation polluted the cache for every later caller in the same warm lambda |

No-fix but pinned:

* **F12-02** — `emergency_stop` as diagnostic on `REJECTED/NO_STRUCTURAL_LEVEL` is correct; pinned with no change.
* **F12-04** — `isPlanV2Usable`'s `rr_to_tp1 >= min_rr_to_tp1` strict gate is correct; `REJECTED / RR<1.0` must not be usable, so `WARNING (RR≥1.0, <profile min)` being hidden is the **intended** contract rather than a bug.
* **F12-06** — `resolvePublicTradePlan` rebuild path on `REJECTED/STOP_NOT_BELOW_ENTRY` correctly falls back to `legacy_fallback`; pinned.

**Verification:** `6/6 PASS ×2` · `529/529 test files passed` · `890 .js files parsed cleanly` · board-aware `FCA Rp1` ticks preserved (`F11-01`).
