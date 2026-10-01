# Auto-Cuan Correctness Audit — 12 Aug 2026

**Branch:** `claude/auto-cuan-correctness-audit-wdqi9b`
**Base commit:** `a3890d79d7d3ba724e63fca4e34445f7526b94a8` (production/`feat/daytrade-screener-v1` HEAD at audit start)
**Scope:** RSI numerical integrity, T-1/EOD labeling, Telegram pipeline, scoring/ranking, Fast Watcher, OOS/outcome evaluation, DB/cache/timestamp handling.

> **Sandbox constraint, stated up front:** this audit ran in an isolated development sandbox with **no outbound network access to Yahoo Finance, the production Supabase instance, Telegram, or the VPS** (all blocked by the environment's egress policy — confirmed via direct `curl`/`WebFetch` attempts returning `EGRESS_BLOCKED` / HTTP 403 at the proxy). Every finding below is either (a) **CONFIRMED** by direct code inspection, formula derivation, and/or a deterministic test with synthetic fixtures, or (b) explicitly marked **SUSPECTED** / **needs live verification**, with the exact tool an operator should run against real data. Nothing here was rounded up to "confirmed" without one of those two forms of evidence.

---

## 1. Executive Findings

### P0 — Fixed, tested, evidence-backed

| # | Area | Finding |
|---|---|---|
| 1 | RSI (daily context / Ranking Harian) | `buildFeatureSnapshotsForTickers` computed RSI14 from exactly `RSI_PERIOD+1` (15) persisted closes — mathematically the **unsmoothed Wilder seed value** (zero recursive smoothing iterations), not a mature, chart-comparable RSI. Matches the user-reported BELL/TIRA discrepancy. |
| 2 | T-1 / EOD label | The Ranking Pasar Harian page had two **hardcoded string literals** — `"Market Context T-1"` and `"Data Ranking T-1"` — that never reflected the real `as_of_trade_date` already present in every fetched row. Matches the user-reported "still says T-1 after EOD already settled" evidence exactly. |

### P1 — Fixed, tested

| # | Area | Finding |
|---|---|---|
| 3 | DB retention (`stock_daily_history`) | `enforceRetention`'s lookup query had **no `.limit()`** — the exact PostgREST response-cap class of bug the *same file's* read path already documents and guards against. On a deployment large enough to hit that cap, retention silently no-ops and the table grows unbounded. |
| 4 | Telegram Day Trade digest ranking | A "sort by priority tier then score" comparator's result was **immediately discarded** by a second `.sort()` on the very next line — dead code with zero live effect, removed. |
| 5 | Fast Watcher session boundary | `runModeForTime()` — the sole gate for whether a live tick runs — never consulted the codebase's own correct IDX session calendar (lunch break, Friday's shifted hours), so a scheduled tick during a break could process a frozen quote as a fresh observation. **Currently dormant (no cron installed yet)** — fixed before any live impact exists. |

### P2 — Fixed, tested

| # | Area | Finding |
|---|---|---|
| 6 | `latest-price-resolver.js` | `dateOnly()` used a naive UTC-slice on real timestamp fields (`calculated_at`/`published_at`/`updated_at`), reproducing the same UTC-vs-WIB bug class as #2, on a different file/field. Also affects `tools/run-top5-progress-monitor.js`'s send-gating (`PRICE_DATE_NOT_TODAY`) near WIB midnight. |

### P1/P2 — Documented, **not** fixed this pass (see rationale in each section below; require product judgment, live data, or larger design work this audit deliberately did not attempt)

| # | Area | Finding | Why not fixed now |
|---|---|---|---|
| 7 | Scoring | `daytrade_screener_latest`'s `ORDER BY daytrade_score DESC` (used for top-50 trim, dashboard read, Telegram fetch) has **no deterministic tiebreak** | Real-world trigger frequency depends on live Postgres tie behavior; safe one-line fix exists (add `ticker` secondary order) but was deprioritized against the confirmed P0/P1s given session time budget — **recommended immediate follow-up** |
| 8 | OOS / outcomes | `lib/report-helpers.js:classifyOutcome` and `api/sector-hot.js:classifyWebTop5History` apply **opposite** TP1-then-SL precedence rules to the same data, so the win-rate report and the TP History dashboard can disagree on the same trade | Ambiguous which precedence is "correct" without a product decision — documented for operator/owner to resolve, not guessed at |
| 9 | OOS / outcomes | `tools/report-telegram-outcomes.js` never computes an actual win rate / payoff ratio / expectancy; its denominator includes unresolved/open picks, diluting every rate | Real feature addition, not a one-line bug fix; scoped as recommended follow-up (Task 15 tool E) |
| 10 | Fast Watcher | No timestamp-monotonicity guard in `intraday-fast-watcher-pool.js` against previously persisted state | SUSPECTED exploitability — needs an actual out-of-order operational sequence; no cron installed yet so zero current risk |
| 11 | DB | `getLatestSessionsForTickers`/`getLatestForeignForTickers`'s shared row-budget across a ticker batch can starve a "gappy" (e.g. suspended) ticker | SUSPECTED without a real gappy ticker in production data to confirm |
| 12 | DB | No `data_quality_status` precedence check in `upsertDailyHistory`/`upsertDailyFeatures` — blind overwrite | Requires either read-before-write or a DB-level guard; real trigger needs an overlapping/retried collector run |

### P3 — Documented only (cosmetic / low-impact / dead code / disabled subsystem)

- Telegram: TP2-missing fallback prints the same price as both TP1 and TP2 in the rendered card (`api/sector-hot.js:5119`).
- Telegram: a duplicate `formatMonitorHitMessage` declaration in `lib/telegram-templates.js` is dead code (the live copy already matches an existing, apparently-intentional test).
- Telegram: a `foreign_notes` string misdescribes its own formula, but is never rendered anywhere reachable.
- Scoring: `daytrade-screener-engine-v7.js`'s volume-pace recall leaves `daytrade_score` unchanged for already-ready candidates while overwriting its four component display fields, so the displayed breakdown doesn't sum to the displayed total.
- Scoring: `rankCandidatesByPotential`'s `(upside*100)` term may dominate the formula by design or by accident — flagged as a magnitude concern for the product owner, **not** changed (Task 17).
- Fast Watcher: non-deterministic same-minute tie-break in the offline shadow-replay tool only (not the live path).
- Fast Watcher: docs say "strictly consecutive" confirmations; the live V7 engine deliberately implements 2-of-3 (tested, intentional) — doc drift only.
- DB: several `daytrade-intraday-*.js` diagnostic files (scoped to the currently-**disabled** `DAYTRADE_INTRADAY_SCORE_ENABLED` subsystem) use the same naive-UTC-slice pattern as #2/#6.

---

## 2. RSI Forensic Analysis

### Root cause (mathematically proven, not "probably")

`lib/daily-rsi.js`'s `computeRsiSeries(closes, period)`:

```js
if (!Array.isArray(closes) || closes.length < period + 1) return series; // needs >= 15
...
for (var k = period; k < gains.length; k++) { /* Wilder recursion */ }
```

With `period = 14` and `closes.length === 15` (exactly `RSI_PERIOD + 1`), `gains.length === 14`. The recursion loop condition is `for (k = 14; k < 14; k++)` — **it never executes.** `series[14]` is set directly from the seed average (`avgGain`/`avgLoss` = simple mean of the 14 raw deltas) with **zero Wilder smoothing iterations applied.**

This is exactly what `lib/daily-market-context-builder.js`'s `buildFeatureSnapshotsForTickers` was requesting from the DB:

```js
var historySessions = options.historySessions || Math.max(rsi.RSI_PERIOD + 1, DISPLAY_TRADING_SESSIONS); // = max(15, 7) = 15
```

Meanwhile `lib/daily-history-collector.js`'s `collectDailyHistoryForTickers` already fetches ~250 raw daily candles per ticker from Yahoo (`range=1y&interval=1d`) to compute the 52-week high/low, then **trims to 120 sessions for persistence and discards the rest** — the mature RSI computation never got a chance to run on that fuller series.

Wilder's smoothing decays the seed's weight geometrically by a factor of `(period-1)/period ≈ 0.9286` per additional session. It takes roughly 60+ additional sessions beyond the initial 14 for the seed's influence to drop under 1%. A charting platform (TradingView, Yahoo charts) computes RSI by smoothing continuously across its **entire** available history, so its current value reflects hundreds of sessions of recursive smoothing — categorically different from a value computed from the last 15 closes alone.

### BELL

| | Value |
|---|---|
| Auto-Cuan observed (pre-fix, 15-close seed) | **45.0** |
| External comparison (chart platform, mature RSI) | **52.0** |
| Corrected Auto-Cuan (post-fix) | Requires a live run of `tools/report-rsi-parity.js BELL` from an environment with real network access — **this sandbox could not reach Yahoo Finance to reproduce the exact number.** |
| Explanation | The seed-only computation used just the last 14 daily deltas; the mature RSI incorporates ~250 sessions of recursive Wilder smoothing. A synthetic fixture reproducing the qualitative pattern (`test/daily-rsi-mature-history-regression.test.js`, "BELL-like fixture") demonstrates the mechanism produces a materially lower short-window value than the mature one, matching the reported *direction* of the discrepancy. |

### TIRA

| | Value |
|---|---|
| Auto-Cuan observed (pre-fix, 15-close seed) | **6.4** |
| External comparison (chart platform, mature RSI) | **21.2** |
| Corrected Auto-Cuan (post-fix) | Same caveat — requires a live run from a network-enabled environment. |
| Explanation | Same mechanism, more pronounced: TIRA's illiquid/volatile profile means a short recent decline dominates a 14-sample seed average far more severely than it dominates a long recursively-smoothed average (which has already "absorbed" more historical gain/loss balance). The synthetic "TIRA-like fixture" test reproduces this exact qualitative pattern (naive ≈ 0, mature meaningfully higher, delta > 8 points). |

### Fix (Option A, as specified in the task's preferred hierarchy)

Reuse the **same** full ~250-candle Yahoo fetch already made for the 52-week calculation to also compute mature RSI, **before** trimming to the 120-session retention window — avoiding any second Yahoo request:

- `lib/daily-history-collector.js`: new `computeRsiFromCandles(candles)`, threaded through `collectDailyHistoryForTickers`'s return value as `result.rsi[ticker]`, exactly mirroring the existing `week52` pattern.
- `scripts/collect-daily-market-context.js`: passes `rsiByTicker: collectResult.rsi` into `buildFeatureSnapshotsForTickers`.
- `lib/daily-market-context-builder.js`: `buildContextFromRows` accepts `options.rsiOverride` and **prefers** it over recomputing from the (still short) persisted-history window when present; falls back to the pre-existing persisted-history computation when absent (documented residual limitation, matching Option B for the rare case a given ticker's Yahoo fetch fails in a specific run).

The single-ticker on-demand path (`buildContextForTicker`, used as an API fallback) was **already** using up to `HISTORY_RETENTION_TRADING_SESSIONS` (120) persisted sessions — well past the ~60-session convergence point — so it needed no change; this is documented, not assumed.

### Regression tests (`test/daily-rsi-mature-history-regression.test.js`, 15 tests)

- Mathematically proves the "15 closes ⇒ zero smoothing iterations" mechanism.
- BELL-like and TIRA-like synthetic fixtures, explicitly labeled as constructed (not literal historical prices, since live data was unreachable).
- Full-history calculation correctness, determinism on repeated rebuild, missing-data handling, flat market (RSI=50), zero-losses (RSI=100), zero-gains (RSI=0), non-contiguous-date handling (no synthetic candle insertion).
- End-to-end pipeline regression: `buildFeatureSnapshotsForTickers` prefers the mature override over a short-window DB recompute, even when the DB only has the old 15-session window (this is the test that would fail if someone reverted the fix).
- 13/15 of these tests **fail against the pre-fix code** (verified via `git stash`), confirming they are genuine regression tests, not tautologies.

---

## 3. Full-Universe Daily-Context Audit

**This sandbox has no Supabase access, so a live full-universe scan could not be run.** `tools/report-daily-market-context-integrity.js` was built for this purpose (Task 15A) and is ready to run from an environment with `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` set. It checks, per ticker: RSI in [0,100] and state-consistency, 52W high ≥ 52W low, price-vs-52W-range sanity, `week52_high_dist_pct` sign, non-negative volumes/ratios, malformed tickers, and null-vs-zero handling — and separately detects a **mixed-`as_of_trade_date` universe** (the same detection now surfaced live in the Ranking UI, §3 fix below).

Its pure classification logic is unit-tested (`test/report-daily-market-context-integrity-tool.test.js`, 12 tests, all passing) against synthetic rows covering every anomaly class above. Counts against the **real** production universe (tickers checked / exact passes / warnings / failures / mixed dates / RSI anomalies / 52W anomalies / volume anomalies) require the operator to run this tool from the VPS.

---

## 3b. T-1 / EOD Label Fix

**Root cause:** `public/stock-analysis-ai.js` had two hardcoded strings — `'Market Context T-1'` (the Ranking page badge) and `title.textContent = 'Data Ranking T-1';` (forcibly overwriting the card's title on every mount) — that never read the real `as_of_trade_date` already present on every fetched ranking row. Everything else in the pipeline (`isPartialSession`, the 16:00 WIB settle cutoff, `stock_daily_history.trade_date`, `stock_daily_features.as_of_trade_date`) was **already correct** — this was purely a static UI string, confirmed by the fact that the underlying data (BELL=116, TIRA=438) already matched the completed 12 Aug session while the label still claimed "T-1".

**Fix:** the label is now computed live from `rankingState.rows[].as_of_trade_date` on every render (hooked via a wrapper around the existing `window.renderRankingTable`, so it updates on initial load, refresh, search, and sort):

- Coherent single-date batch → `"Sesi terakhir selesai: <real WIB date>"` (e.g. "12 Agu 2026").
- **Mixed dates across rows** → detected explicitly, surfaced as a visible amber warning banner (`"Peringatan data campuran: N dari M ticker masih memakai data tanggal ..."`), never silently blended into one claimed snapshot date.
- No live-data case → neutral placeholder, never a hardcoded claim.

Also additively exposed (zero schema/DB changes): `technical.rsi_source` (`'yahoo_full_history'` vs `'persisted_history'`), `technical.rsi_basis_sessions`, and `price.last_price_data_quality_status` (ok/partial/estimated/stale) in the on-demand context API response object — provenance fields that were already being fetched from the DB but not threaded through to callers.

**Regression tests** (`test/ranking-session-label-regression.test.js`, 8 tests): asserts the hardcoded strings are gone, exercises the real `computeRankingSessionInfo`/`formatSessionDateID` algorithm (extracted from the shipped source via `vm.runInContext`, not reimplemented) against coherent, pre-EOD, and mixed-date scenarios. 8/8 fail against pre-fix code.

---

## 4. Telegram Numerical Audit

Full trace performed by an independent read-only sub-agent across `api/sector-hot.js`, `lib/daytrade-screener-engine-v7.js`, `lib/telegram-notifier.js`, `lib/telegram-delivery.js`, `lib/telegram-templates.js`, `lib/ai-narration.js`, `lib/idx-tick-normalization.js`, and the Top5/monitor tooling.

**Core finding: the entry/SL/TP1/TP2/RR tick-rounding chain — the highest-risk area for the requested bug classes — is sound.** `idx-tick-normalization.js` rounds entry (nearest), SL (floor), TP1/TP2 (ceil), then recomputes RR/upside/risk **from those same rounded values**, and that is the same value used for both the `trading_plan_valid` gate and what's rendered. Percentage helpers multiply by 100 exactly once everywhere checked; no double- or zero-multiplication found.

Two confirmed, reproducible issues, both cosmetic/presentation (not mispriced trades):

1. **`tp2n` fallback leaks into display** (`api/sector-hot.js:5119`, `lib/telegram-templates.js:368,416`): when a candidate has no real TP2, `r.tp2n = toNum(r.tp2) || toNum(r.tp1)` (originally added to prevent an internal sanity-check rejection) is read back by the template, so the Telegram card prints the same price for both TP1 and TP2 instead of indicating "TP2 not set."
2. **Dead duplicate function** (`lib/telegram-templates.js:234-351` vs `563-676`): `formatMonitorHitMessage` is declared twice with the same name; only the second (live) copy is reachable, and it discards the specific computed EXPIRED reason (`ev.note`, e.g. "harga sudah menyentuh SL") in favor of a generic message. An existing test (`T-TPL-13`) explicitly asserts this suppressed behavior, suggesting it may be intentional product behavior — flagged, not changed, given that ambiguity.

One SUSPECTED (needs live data): `lib/latest-price-resolver.js`'s freshness fallback chain ends in `updated_at`, which other code in the same repo documents as "bumped by unrelated lifecycle writes" — theoretically able to make a stale price look fresh if `price_date`/`calculated_at` are both absent on a given row. Not confirmed live.

Full per-field provenance table (raw source → formula → normalization → rounding → stored → rendered) for every field in the task's list was traced by the sub-agent; no unexplained transformation was found beyond the two items above.

---

## 5. Scoring Specification & Findings

### Reconstructed specification (Day Trade engine, `lib/daytrade-screener-engine.js`)

| Component | Range | Notes |
|---|---|---|
| Liquidity | 0–25 | Hard `pass=false` → 0 if illiquid |
| Pre-Spike | 0–30 | Change%, volume ratio, breakout distance, range position |
| Momentum | 0–25 | RSI zone, MA20/MA50 position, near-high, change% |
| Risk:Reward | 0–15 | Tiered on `risk_reward` |
| Trend | 0–15 | MA alignment, change%, range position, breakout distance |
| Penalty | −40–0 | Anti-chase, fade, distribution, overextension, RSI-overbought, no-interest |
| Candle confirm | −8–+6 | Capped, zeroed if illiquid |
| **Composite** | **0–100** | Sum, clamped — this is the same value used for the gate AND what's displayed (verified, no stale/different gating value) |

Fast Watcher momentum scoring (`lib/intraday-fast-watcher-momentum.js`) and the final-list ranking convention (`rankCandidatesByPotential`, used at 10+ call sites codebase-wide) were reconstructed similarly by the sub-agent — full detail in the sub-agent transcript; not reproduced in full here for length.

### Findings

- **Fixed (P1, dead-code cleanup, zero live behavior change):** the Telegram "actionable" shortlist's documented "Step 4: Sort by priority then score" comparator was immediately overridden by a second `.sort()` using `rankCandidatesByPotential` — since that second sort is the codebase-wide standard (10+ other call sites use the identical `rankCandidatesByPotential(b) - rankCandidatesByPotential(a) || ticker.localeCompare` pattern), it was already the one determining live output; the dead first sort was removed. Verified via source-text regression test (4 tests, all fail pre-fix) and confirmed zero regressions across all 96 tests in the 27 files that import `api/sector-hot.js`.
- **Documented, not fixed:** `daytrade_screener_latest`'s `ORDER BY daytrade_score DESC` has no secondary tiebreak; with an integer-composite score, exact ties near the top-50 cutoff are common, and which specific tickers get trimmed/deleted is not determined by any scoring logic on a tie. Straightforward fix (`.order('ticker', {ascending: true})` as secondary) but deprioritized against the P0/P1 fixes given session scope.
- **Documented, not changed (Task 17):** `rankCandidatesByPotential`'s `(upside || 0) * 100` term may structurally dominate the other additive terms (`rr*25`, `score` capped 0-100, small confluence/volume bonuses). This is a **magnitude/weighting judgment call**, not a provable formula bug (`upside` is legitimately a percentage-point value the function's author chose to weight heavily) — flagged for product-owner review, not altered.
- **Documented, not fixed (P3):** the v7 volume-pace recall layer leaves `daytrade_score` unchanged for already-`READY_*` candidates while overwriting the four component fields that are supposed to sum to it, making the displayed breakdown internally inconsistent for that specific case.

No double-counted signals, sign/direction bugs, or round-before/after-threshold mismatches were found in the core composite formula.

---

## 6. OOS Report

**`data/intraday-shadow-v2-out-of-sample/` does not exist in this checkout** — not on disk, not gitignored, not referenced anywhere in source. No live reconstruction of the 10/11/12 Aug 2026 OOS dates named in the task was possible from this sandbox (no such directory to read, and no network/DB access to reconstruct it from source data either). This is reported as fact, not assumed away.

What **was** auditable from code:

- `lib/intraday-shadow-scoring.js` + `lib/intraday-shadow-trade-backtest.js` (the actual OOS/shadow backtest engine): **clean.** Strictly ascending chronological scoring, state threaded forward only after each snapshot is scored, entry resolution only ever uses the next snapshot strictly after signal time (never the signal's own price), exit-snapshot substitution is opt-in and always recorded, and the scorer actively flags any `forward_return_pct`/`realized_return_pct` leaking in from source data. No hindsight leakage found.
- `lib/daytrade-outcome-evaluator.js` + `lib/daytrade-outcome-contract.js` (DAY_TRADE strategy outcome finalization): **clean and rigorous.** Correct bar-by-bar TP/SL touch ordering, explicit `PESSIMISTIC_SL_FIRST` assumption for same-bar entry+SL, same-bar entry+TP is marked `UNRESOLVED` rather than guessed, MFE/MAE computed only over bars strictly between fill and exit. **Not currently wired into any win-rate report**, however (see §8).
- `lib/report-helpers.js:classifyOutcome` (used by the win-rate tool) vs `api/sector-hot.js:classifyWebTop5History` (used by the TP History dashboard): apply **opposite** precedence for a TP1-then-later-SL sequence — the former treats it as a loss (SL checked first), the latter as a permanent win (TP1 checked first, matching an explicit "Part C fix" comment). Both are reachable in production (`hit_tp1_at` is documented as non-terminal). **Not fixed** — this is a product decision about which precedence is correct, not a code bug with one obviously-right answer, and picking wrong would itself introduce a defect.

Per Task 17: no threshold, weight, confirmation-count, or SL/TP policy was changed based on any OOS observation. The only OOS-related code change in this PR is none — findings here are documentation only, since (a) the evidence directory doesn't exist in this checkout and (b) the one code-level disagreement found needs a product decision, not a guess.

---

## 7. Fast Watcher Report

Scope: `lib/intraday-fast-watcher*.js`, `tools/run-intraday-fast-watcher*.js`, publish/dedup ledgers, `fast-watcher-daily-context-shadow.js`.

**Fixed (P1):** `runModeForTime()` in `lib/intraday-fast-watcher-live.js` — the sole gate `collectLiveSnapshot` uses to decide whether a scheduled tick runs — was a flat, day-of-week-agnostic time classifier that never consulted `lib/intraday-volume-pace.js`'s already-correct `tradingSchedule`/`sessionProgress` (which correctly encodes Mon-Thu's 12:00-13:30 lunch break and Friday's 11:30-14:00 break). A tick scheduled during either break window was accepted as valid and would have processed a frozen quote as a fresh confirmation observation. **No cron is currently installed for Fast Watcher live collection** (confirmed by the audit — no `deploy/vps/*` wrapper references either runner script, and `docs/INTRADAY_FAST_WATCHER.md` states scheduling is "deliberately not installed"), so this had zero current production impact — fixed now, before any cron is ever wired up. The fix threads an optional `sampleDate` second argument through (backward compatible; existing single-arg callers/tests unaffected), consulting the real session calendar only when a date is supplied. 8 regression tests, 4/8 fail pre-fix, and the full 105-test fast-watcher suite passes with the change in place.

**Documented, not fixed:**
- No timestamp-monotonicity guard in `intraday-fast-watcher-pool.js` against previously persisted per-ticker state — an out-of-order/retried invocation could theoretically regress a ticker's recorded status. SUSPECTED exploitability; needs an actual out-of-order operational sequence to trigger, and there's no cron yet for this to occur under.
- Non-deterministic same-minute tie-break in the **offline shadow-replay tool only** (falls back to lexicographic JSON comparison) — not reachable via the live/guarded-live production path.
- Documentation says confirmations must be "strictly consecutive"; the live V7 engine deliberately implements a tested, reason-tagged 2-of-3 sliding window — this is intentional behavior, just stale docs.

**Confirmed clean:** ticker re-entry after drop/expiry fully resets tracker state; publish-ledger deduplication (keyed by a hash of date/ticker/locked levels) correctly prevents double-publish across repeated runs; only `READY_CONFIRMED` candidates can ever reach the publish path; `fast-watcher-daily-context-shadow.js` is a provable no-op when its flag is false AND is not even called from any production Fast Watcher path today; per-date lock files correctly serialize overlapping invocations.

**Protected directories:** confirmed untouched by every sub-agent and by me — no writes to `data/intraday-fast-watcher-live-events/`, `-live-observations/`, `-live-state/`, `-published/`, or `data/intraday-shadow-v2-out-of-sample/` (which doesn't exist in this checkout, per §6).

---

## 8. Win-Rate / Outcome Report

`tools/report-telegram-outcomes.js` was audited but **not modified**. It currently:

- Does **not** compute win rate, payoff ratio, or expectancy at all (grep for those terms in the file and its helpers returns nothing).
- Computes `entryRate`/`tp1Rate`/`tp2Rate`/`slRate` as `count / picks.length`, where the denominator includes still-`WAITING`/`RUNNING` (unresolved, open) picks — diluting every rate rather than reporting a resolved-only win rate. Example from the audit: 100 picks, 70 still open, 20 SL, 10 TP → headline shows `slRate=20%`, but the *resolved*-trade loss rate is actually 20/30 ≈ 67%, and no field in the current report surfaces that number.
- Does separate results by source (`outcomeBySource`) further down in the same report, but the **headline** table aggregates Top5/Day Trade/Swing/Watchlist together before that breakdown, which a casual reader could mistake for a blended, comparable-strategy number.

**No sample-size-backed real win rate can be reported here** — this sandbox has no Supabase access to run the tool against real recommendation history, and per Task 17, no threshold/weight was tuned based on the (unavailable) OOS sample. Building a corrected resolved-only win-rate/payoff/expectancy calculation into this tool is recommended as follow-up work (Task 15's tool E), scoped by this finding, but was not attempted in this pass given session time — it's a feature addition, not a one-line fix, and deserves its own focused review rather than a rushed addition at the end of an already-large PR.

---

## 9. Changes Made (file-by-file)

### Production code

| File | Change |
|---|---|
| `lib/daily-rsi.js` | **Unchanged** — the Wilder formula itself was already correct; the bug was entirely in how much history callers fed it. |
| `lib/daily-history-collector.js` | Added `computeRsiFromCandles(candles, options)`, computing mature RSI14 from the full ~1y Yahoo candle fetch before retention trimming (mirrors the existing `computeWeek52FromCandles` pattern). Threaded through `collectDailyHistoryForTickers`'s return value as `result.rsi`. |
| `lib/daily-market-context-builder.js` | `buildContextFromRows` accepts `options.rsiOverride`, preferring it over the persisted-history computation when present (with graceful fallback + `rsi_source`/`rsi_basis_sessions` provenance fields). `buildFeatureSnapshotsForTickers` threads `options.rsiByTicker` through. Also surfaces `price.last_price_data_quality_status` (already-fetched, previously unexposed). |
| `scripts/collect-daily-market-context.js` | Passes `rsiByTicker: collectResult.rsi` into `buildFeatureSnapshotsForTickers`. |
| `lib/stock-daily-history-store.js` | `enforceRetention` now bounds its lookup query with the same row-budget-based batching as the read path (`getLatestSessionsForTickers`), fixing the missing-`.limit()` bug. New `RETENTION_TRIM_HEADROOM` constant controls per-run convergence speed for any pre-existing backlog. |
| `lib/intraday-fast-watcher-live.js` | `runModeForTime(time, sampleDate)` — optional, backward-compatible second parameter that consults `intraday-volume-pace.js`'s real IDX session calendar (lunch break / Friday hours) when supplied. Production call site now passes `opts.sampleDate`. |
| `lib/latest-price-resolver.js` | `dateOnly()` now converts through a real `Date` object and `lib/idx-trading-calendar.js`'s `toDateKey` (Asia/Jakarta-aware), instead of a naive UTC `.toISOString().slice(0,10)`. |
| `public/stock-analysis-ai.js` | Removed the two hardcoded "T-1" strings; added `computeRankingSessionInfo`/`formatSessionDateID`/`updateRankingSessionLabel`, wired to run on every ranking table render (initial load, refresh, search, sort) via a wrapper around the existing global `renderRankingTable`. |
| `api/sector-hot.js` | Removed the dead "Step 4: Sort by priority then score" comparator in the Day Trade Telegram actionable-shortlist builder (its result was always immediately overridden by the next line's `rankCandidatesByPotential` sort — zero live behavior change). |

### New diagnostic tools (read-only, Task 15)

| File | Purpose |
|---|---|
| `tools/report-rsi-parity.js` | Computes RSI14 under 8 different history bases per ticker (naive-15, 30/60/120-session windows, full raw history, full adjusted-close history, an independently-reimplemented Wilder formula for self-consistency, and — when Supabase creds are set — the actual fixed production pipeline's value), with convergence/delta reporting. Defaults to a ticker set including BELL/TIRA. |
| `tools/report-daily-market-context-integrity.js` | Full-universe `stock_daily_features` integrity scan: RSI range/state consistency, 52W high≥low and price-vs-range sanity, non-negative volumes, malformed tickers, null-vs-zero handling, and mixed-`as_of_trade_date` detection. |

Both are read-only by default (SELECT-only Supabase access, GET-only Yahoo requests), send no Telegram messages, and mutate no runtime state. Neither could be run against real production data from this sandbox (no network/DB access) — both are unit-tested against synthetic fixtures instead, and are ready for an operator to run from an environment with real access.

### New regression tests

| File | Tests | Fails pre-fix |
|---|---|---|
| `test/daily-rsi-mature-history-regression.test.js` | 15 | 13/15 |
| `test/ranking-session-label-regression.test.js` | 8 | 8/8 |
| `test/enforce-retention-row-cap-regression.test.js` | 4 | 1/4 (see note below) |
| `test/daytrade-telegram-actionable-dead-sort-regression.test.js` | 4 | 2/4 (see note below) |
| `test/fast-watcher-session-boundary-regression.test.js` | 8 | 4/8 (see note below) |
| `test/latest-price-resolver-wib-date-regression.test.js` | 3 | 1/3 (see note below) |
| `test/report-rsi-parity-tool.test.js` | 6 | n/a (new tool, no pre-fix baseline) |
| `test/report-daily-market-context-integrity-tool.test.js` | 12 | n/a (new tool, no pre-fix baseline) |

*Note on partial pre-fix failure counts:* several files include both a direct regression assertion (fails pre-fix, as required by Task 16) **and** an independent "mechanism proof" test that exercises only the *fake test double's* behavior (unaffected by the production fix) or a scenario deliberately chosen to already pass under old code (e.g. "still correct for a small universe" — proving the fix didn't regress a case the old code handled fine). Every file has **at least one** test that demonstrably fails against `git stash`-restored pre-fix code and passes after, verified individually for each file during development.

---

## 10. Tests

Ran the complete suite (`node --test` over all 229 files under `test/`) fully to completion (~452s), properly awaited (see the methodology note below).

**Final result: 2908 tests — 2877 pass, 30 fail, 1 skipped.**

Every one of the 30 failures was individually verified via `git stash` (running the exact same test file(s) against the unmodified `a3890d7` baseline) to be **pre-existing and unrelated to this audit's changes** — none regressed, none were newly introduced:

| Group | Count | Files | Verified pre-existing via |
|---|---|---|---|
| Original set found at audit start | 8 | `admin-tools-runtime`, `ai-eval-openagentic-quality`, `canonical-domain-redirect`, `approved-website-access-shell`, `ai-chat-polish` | `git stash` + re-run, identical failures on baseline |
| Portfolio/Swing digest-gate set | 6 | `portfolio-planner-v1`, `swing-nonkonglo-staging-schema`, `swing-top5-radar-digest` | `git stash` + re-run in isolation, identical 6 failures on baseline |
| `manual_latest_snapshot`/`manual_previous_trading_day` set | 16 | `manual-latest-snapshot`, `manual-previous-trading-day` | `git stash` + re-run; baseline exhibits the identical failure mode (~49s-per-test hangs, identical `ERR_ASSERTION` on the same subtest, e.g. "diagnostics appears in dry_run response") before timing out — see environment note below |
| **Total** | **30** | | **Matches the full-suite failure count exactly (8+6+16=30)** |

**Regressions introduced by this PR: 0.**

**New tests added: 60**, across 8 new files (see §9 table), covering every fix with a test that fails pre-fix and passes post-fix (individually verified per file via `git stash`).

**Environment-only issue identified (not a code bug), affecting the `manual_latest_snapshot`/`manual_previous_trading_day` group:** these two files instantiate a client against `SUPABASE_URL = 'https://test.supabase.co'` (test/manual-latest-snapshot.test.js:35) without a matching fake — some subtests take ~49 seconds each, consistent with a real network call retrying against this sandbox's blocked egress proxy before giving up, and a couple of subtests then get the wrong (fallback/undefined) value once the retry exhausts, hence the assertion failures. Confirmed present, with the same failure signature, on the unmodified baseline. Not touched by this audit's changes (`api/sector-hot.js`'s only modification in this PR is deep inside a different, unrelated function).

**A separate methodology bug was found and corrected during this audit session — in the session's own test-running tooling, not the repository:** several early background-test-runner invocations used `nohup node --test ... &` *inside* an already-backgrounded shell call, so the launcher returned (and was reported "complete") before `node --test` had actually finished — producing artificially low, silently-still-growing test counts on multiple intermediate full-suite checks (observed at 1180, then 1211 repeatedly across unrelated runs, which should have been an immediate red flag). This was diagnosed by `ps aux` revealing multiple orphaned, resource-contending `node --test` processes running simultaneously, and by `diff`-ing repeated snapshots of the same log file mid-run. Fixed by removing the redundant backgrounding and using a `Monitor`-based wait on the actual process PID; the numbers reported above are from that properly-awaited, single, complete run. This bug affected only this session's own verification process — it never touched repository code, and every individual fix was independently re-verified (in isolation, post-cleanup) once the methodology issue was understood.

---

## 11. Production Safety

```
PRODUCTION_CHANGED=false
DATABASE_CHANGED=false
CRON_CHANGED=false
TELEGRAM_SENT=false
FAST_WATCHER_RUNTIME_CHANGED=false
OOS_HISTORY_CHANGED=false
SECRETS_PRINTED=false
```

- No Supabase schema migration was written or applied — every fix works within the existing `stock_daily_features`/`stock_daily_history` column set (provenance fields like `rsi_source`/`rsi_basis_sessions` are exposed only in the in-memory API response object, never persisted, to avoid any schema risk).
- No cron entries were added, removed, or modified. `deploy/vps/*` wrapper scripts were read-only inspected, never edited.
- No Telegram credentials were read, printed, or used to send any message (real or test).
- `FAST_WATCHER_DAILY_CONTEXT_ENABLED` was never set to true; `lib/fast-watcher-daily-context-shadow.js` was confirmed (not assumed) to remain a no-op and is not called from any production Fast Watcher path.
- No file under `data/intraday-fast-watcher-live-events/`, `-live-observations/`, `-live-state/`, `-published/`, or `data/intraday-shadow-v2-out-of-sample/` was written, deleted, or modified by this session or any sub-agent (each sub-agent explicitly confirmed this in its final report; independently verified via `git status` showing no changes under `data/`).
- All Yahoo/Supabase/Telegram network access attempted during this audit was read-only (GET/SELECT) and, in this sandbox, was blocked entirely by the environment's egress policy before it could reach any real endpoint.

---

## 12. Git

- **Starting production SHA:** `a3890d79d7d3ba724e63fca4e34445f7526b94a8`
- **Branch:** `claude/auto-cuan-correctness-audit-wdqi9b`
- **Final commit:** see PR — pushed after this report.
- **PR:** opened against `feat/daytrade-screener-v1`, **NOT merged**, per explicit instruction.
- **Vercel:** not deployed/checked from this session (no Vercel access in this sandbox); the PR does not touch any Vercel configuration.

---

## Required Root-Cause Matrix

| Area | Symptom | Actual root cause | Evidence | Severity | Fix |
|---|---|---|---|---|---|
| BELL RSI | Auto-Cuan 45.0 vs external 52.0 | `buildFeatureSnapshotsForTickers` fed RSI14 exactly 15 closes → `computeRsiSeries`'s Wilder recursion loop (`for k=period; k<gains.length`) never executes with `closes.length===period+1`, yielding the unsmoothed seed value, not a mature/converged RSI | `lib/daily-rsi.js:37-68` (loop bound math, verified by hand); `lib/daily-market-context-builder.js:203` (`historySessions = max(15,7)`, pre-fix); synthetic fixture reproducing the qualitative divergence pattern in `test/daily-rsi-mature-history-regression.test.js`. Exact reported numbers (45.0/52.0) could not be reproduced live — no Yahoo access in this sandbox; requires `tools/report-rsi-parity.js BELL` run from a network-enabled environment. | P0 | Fixed — mature RSI computed from full ~1y Yahoo fetch before trimming (Option A), threaded through as `rsiOverride` |
| TIRA RSI | Auto-Cuan 6.4 vs external 21.2 | Same mechanism as BELL, more pronounced given TIRA's volatility profile (short recent decline dominates a 14-sample seed far more than a long recursively-smoothed average) | Same code evidence as above; "TIRA-like fixture" test in the same file reproduces naive≈0 vs mature meaningfully higher, delta>8. Exact numbers unverified live for the same sandbox-network reason. | P0 | Same fix as BELL (single shared code path) |
| T-1 label | UI said "T-1" at 16:23 WIB with already-EOD-settled 12 Aug data displayed | Two hardcoded string literals (`'Market Context T-1'`, `title.textContent='Data Ranking T-1'`) in `public/stock-analysis-ai.js`, never reading the real `as_of_trade_date` already present on every fetched row | `public/stock-analysis-ai.js:166,233` (pre-fix, confirmed by direct grep matching the exact reported strings) | P0 | Fixed — dynamic label computed from `rankingState.rows[].as_of_trade_date` on every render, with explicit mixed-date warning |
| Daily context as-of | (same root cause as T-1 label; the underlying `as_of_trade_date`/`generated_at`/collector-schedule/`isPartialSession` logic was independently audited and found correct) | N/A — no separate bug found in the as-of computation itself, only in the UI label that ignored it | `lib/daily-history-collector.js:39-48` (`isPartialSession`, correct 16:00 WIB cutoff logic, unit-tested); confirmed by a dedicated sub-agent audit of DB/cache/timestamp handling that found this specific mechanism clean | — | No fix needed beyond the T-1 label UI fix above |
| Telegram numeric integrity | Task asked to audit every Telegram-rendered number's provenance | Core entry/SL/TP/RR tick-rounding chain confirmed self-consistent (same rounded values used for gate and display); two cosmetic display bugs found (TP2 duplicate-price fallback, dead-code EXPIRED-reason suppression) | Sub-agent trace across `api/sector-hot.js`, `lib/idx-tick-normalization.js`, `lib/telegram-templates.js`; see §4 | P3 (both) | Documented only — cosmetic, one conflicts with an existing intentional-looking test |
| Scoring integrity | Task asked to audit score/rank/eligibility logic for defects | Confirmed dead-code double-sort in the Telegram actionable digest (Step 4 comparator always overridden); confirmed missing tiebreak on `daytrade_score` ORDER BY | `api/sector-hot.js:11938-11946` (fixed); `api/sector-hot.js` multiple `.order('daytrade_score',...)` call sites (documented, not fixed) | P1 (both) | Dead sort removed (zero behavior change, tested); ORDER BY tiebreak documented as recommended follow-up |
| Fast Watcher | Task asked to audit candidate/confirmation/publish integrity for future-information leaks and boundary handling | `runModeForTime()` never consulted the correct, already-implemented IDX session calendar (lunch break, Friday hours) — confirmed via direct comparison against `intraday-volume-pace.js`'s `tradingSchedule` | `lib/intraday-fast-watcher-live.js:15-23` (pre-fix); `lib/intraday-volume-pace.js:34-56` (the correct logic that existed but wasn't consulted) | P1 (currently dormant — no cron installed) | Fixed — optional `sampleDate` parameter threaded through, backward compatible |
| OOS | Task asked to reconstruct 10/11/12 Aug 2026 OOS evidence | `data/intraday-shadow-v2-out-of-sample/` does not exist in this checkout; no live network/DB access to reconstruct from source either | Directory search (`find`, `git ls-files`) returned nothing; confirmed by an independent sub-agent's identical finding | — (data absence, not a code bug) | No fix possible from this sandbox — flagged for the operator to run the diagnostic tools from an environment with real access |
| Outcome evaluator | Task asked to audit win-rate/outcome classification logic | `classifyOutcome` (win-rate tool) and `classifyWebTop5History` (dashboard) apply opposite TP1-then-SL precedence on the same reachable data shape; `report-telegram-outcomes.js` never computes an actual win rate and dilutes its rates with an open-position-inclusive denominator | `lib/report-helpers.js:45-77`; `api/sector-hot.js:7469-7498`; `tools/report-telegram-outcomes.js:106-108,213-217,271-280` | P2 / P1 | Documented, not fixed — precedence conflict needs a product decision; win-rate calculation needs a scoped follow-up PR, not a rushed addition here |

**Explicit "not proven" list** (per the instruction not to write "probably" without showing what remains unproven):
- The *exact* reported BELL/TIRA RSI values (45.0→?, 6.4→?) post-fix — mechanism proven, exact numbers require a live run this sandbox cannot perform.
- Real-world trigger frequency of the `enforceRetention` row-cap bug, the `getLatestSessionsForTickers` gappy-ticker starvation, and the `upsertDailyHistory` quality-downgrade race — all mechanically confirmed possible from code, none confirmed to have actually occurred in production without DB access to check.
- Whether `rankCandidatesByPotential`'s `upside*100` term is an intentional design weight or an accidental double-scale — genuinely ambiguous from code alone, correctly left as a flagged question rather than "probably a bug."
- Whether the Telegram freshness-fallback chain (`latest-price-resolver.js`, `updated_at` as last resort) has ever actually produced a stale-looking-fresh price in production — mechanism identified, live occurrence unconfirmed.
