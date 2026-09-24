# AUDIT LOG — FASE 9 (23 SEPT)
# Fast Watcher Engine, Real-time Pipeline Gates, & Rejection Rules

**Mode:** Zero-trust, test-first forensic audit
**Subsystem:** Fast Watcher real-time pipeline (tick → scoring → confirmation gate → publication)
**Baseline suite before audit:** `test/intraday-fast-watcher.test.js` → 16/16 PASS
**Post-fix suite:** `node tools/run-build-test-suite.js --full` → **All 526 test files passed successfully**
**New regression suite:** [`test/audit-fase9-fast-watcher-bugs.test.js`](test/audit-fase9-fast-watcher-bugs.test.js:1) — 14/14 PASS (verified 2× consecutive)

---

## 1. REAL DEPENDENCY PROTOCOL

The task brief listed candidate filenames such as `lib/fast-watcher.js`, `lib/rejection-rules.js`,
`lib/pipeline-gate.js`, `lib/orderbook-analyzer.js`, `api/fast-watcher.js`. **None of those paths exist.**
The real runtime chain was mapped by traversal of `require()` edges and by grepping producers of each
consumed field. The actual Fast Watcher subsystem is spread across `lib/intraday-fast-watcher-*.js`
plus the shared engine/collector modules.

### 1.1 Real dependency graph (runtime, production path)

```
TICK / SNAPSHOT SOURCE
  tools/intraday-sample-collector.js
    . fetchFreshCandles(ticker)         -> Yahoo interval=1d chart
    . fetchWithFreshnessFallback(...)   -> freshness.is_stale / stale_reason
    . buildCandidateRecord(...)         -> current_price, entry_low/high,
                                           tp1, stop_loss, relative_volume
                                |
                                v
ENGINE / SCORING
  lib/daytrade-screener-engine.js
    . runDayTradeBatch(batch, runMode)  -> candidate rows for shortlist
    . calculateDayTradeScore() / scoreOrderFlowVelocity()
        +- consumes bid_dominance / bid_ratio / orderbook_dominance  (L3193)
  lib/intraday-volume-pace.js
    . sessionProgress() / calculateVolumePace() / enrichObservation()
        +- intraday_volume_pace_ratio, effective_session_progress
                                |
                                v
LIVE SHADOW COLLECTION
  lib/intraday-fast-watcher-live.js
    . runModeForTime()               -> MORNING_SCOUT / MIDDAY / AFTERNOON
    . normalizeProductionShortlistPayload()
    . collectLiveSnapshot()          -> observations[] (per tick)
                                |
                                v
* PIPELINE GATE (authoritative confirmation state)
  lib/intraday-fast-watcher-pool.js
    RULE_VERSION = 'FAST_WATCHER_VOLUME_PACE_V7'
    REQUIRED_CONFIRMATIONS = 3, CONFIRMATION_WINDOW_SIZE = 5
    . mergePayload()                 -> pool priority / fresh-slot reservation
    . process()                      -> WATCHING->READY_PENDING->READY_CONFIRMED
    . lockSetup() / withLockedSetup() -> frozen entry/SL/TP per setup
    . canonicalSetupMetrics() / structuralSetupReason()
                                |
                                v
* REJECTION RULES / SCORING (embedded, no separate module)
  lib/intraday-fast-watcher-momentum.js
    . EXPLICIT REJECT SETS: HARD_REJECT_VALUES / NEAR_MISS_VALUES
    . evaluate()                     -> terminal statuses:
        INVALID_DATA . STALE . INVALIDATED . BLOCKED_CHASE . SPIKE_RADAR
    . evaluateOpeningVelocityGuard() -> 09:16-09:30 WIB turnover-velocity gate
    . scoreObservation() / momentumFlowProxy()
    . isPrespikeRadar() / isEarlyMomentum()  <- radar rejection rules
  lib/intraday-production-eligibility.js (data-quality eligibility gate)
  lib/idx-tick-normalization.js (Fase 1 tick-size authority)
                                |
                                v
ORCHESTRATION / PUBLICATION
  lib/intraday-fast-watcher-guarded-live.js -> run()
  lib/intraday-fast-watcher-publisher.js      -> Supabase + Telegram (confirmed)
  lib/intraday-fast-watcher-radar-publisher.js-> radar Telegram
  lib/intraday-fast-watcher-early-watch*.js   -> informational Early Watch
  lib/telegram-templates.js getDayTradeMetrics() <- ORDERBOOK DOMINANCE LABEL
  lib/intraday-fast-watcher.js                -> shadow watcher (2-confirm)
  api/sector-hot.js -> FAST_WATCHER_LIVE detection (lines 13409-13413)
```

### 1.2 File inventory actually audited

| File | Size | Role |
|---|---:|---|
| [`lib/intraday-fast-watcher.js`](lib/intraday-fast-watcher.js:1) | 18.9 KB | Shadow watcher engine, 2-confirm, anti-chase, event log |
| [`lib/intraday-fast-watcher-momentum.js`](lib/intraday-fast-watcher-momentum.js:1) | 29.1 KB | **Rejection rules + scoring + velocity gate** |
| [`lib/intraday-fast-watcher-pool.js`](lib/intraday-fast-watcher-pool.js:1) | 25.7 KB | **Authoritative 2-of-3 confirmation gate** |
| [`lib/intraday-fast-watcher-live.js`](lib/intraday-fast-watcher-live.js:1) | 12.9 KB | Snapshot collection |
| [`lib/intraday-fast-watcher-guarded-live.js`](lib/intraday-fast-watcher-guarded-live.js:1) | 9.1 KB | Orchestrator / kill switches |
| [`lib/intraday-fast-watcher-early-watch.js`](lib/intraday-fast-watcher-early-watch.js:1) | 26.8 KB | Informational tracker + grace semantics |
| [`lib/intraday-volume-pace.js`](lib/intraday-volume-pace.js:1) | 321 L | Session calendar + pace baselines |
| [`lib/intraday-production-eligibility.js`](lib/intraday-production-eligibility.js:1) | 92 L | Data-quality gate |
| [`lib/idx-tick-normalization.js`](lib/idx-tick-normalization.js:1) | 1208 L | Fase-1 IDX tick-size authority |
| [`lib/telegram-templates.js`](lib/telegram-templates.js:1) | 1034 L | Orderbook-dominance label rendering |

**Not present in repo (brief assumption corrected):** `fast-watcher.js`, `rejection-rules.js`,
`pipeline-gate.js`, `signal-gate.js`, `orderbook-analyzer.js`, `bid-offer-guard.js`,
`api/fast-watcher.js`, `api/watcher-runner.js`. There is **no standalone orderbook module**;
depth/spread logic lives in `daytrade-screener-engine.js` (`scoreOrderFlowVelocity`, L3190)
and the Telegram dominance label (`getDayTradeMetrics`, L466).

---

## 2. ZERO-TRUST: HISTORICAL CLAIMS vs CURRENT CODE

| Historical claim (docs / prior audits) | Current-code reality | Verdict |
|---|---|---|
| "2/2 confirmation is a frozen, distinct-observation rule" | `pool.js` uses `REQUIRED_CONFIRMATIONS = 3` but counted **ticks, not distinct minutes** | CONTRADICTED (F9-05) |
| "Stale data fails closed" | String `'true'` stale flags bypassed the gate entirely | CONTRADICTED (F9-02) |
| "Anti-chase baseline is locked at first observation" | One transient stale read evicted the tracker and reseeded `first_price` | CONTRADICTED (F9-06/07) |
| "Score alone never creates READY" | TRUE — engine-owned flag still mandatory | CONFIRMED |
| "Opening Range Velocity Guard blocks 09:16-09:30 weak turnover" | TRUE — verified with live scenarios | CONFIRMED |
| "Pool hard-caps active state at 30, reserves >=10 fresh slots" | TRUE | CONFIRMED |
| "data-quality-risk cannot enter confirmation" | TRUE | CONFIRMED |
| "ARB/ARA or any zero-bid book is labelled honestly" | `0` collapsed to `'Bid Dominant'` | CONTRADICTED (F9-08) |

---

## 3. METRICS & THRESHOLD MAP (as implemented)

### 3.1 Confirmation gate — [`lib/intraday-fast-watcher-pool.js`](lib/intraday-fast-watcher-pool.js:8)

| Constant | Value | Notes |
|---|---|---|
| `RULE_VERSION` | `FAST_WATCHER_VOLUME_PACE_V7` | state compatibility key |
| `REQUIRED_CONFIRMATIONS` | 3 | window count |
| `CONFIRMATION_WINDOW_SIZE` | 5 | sliding window (`two_of_three_confirmation`) |
| `INITIAL_WATCH_MINUTES` | 12 | then adaptive extension |
| `WATCH_EXTENSION_MINUTES` | 12 | up to `MAX_WATCH_MINUTES = 48` |
| `MIN_EXTENSION_SCORE` | 42 | `watch_score` floor for extension |
| `MIN_FRESH_SHORTLIST_SLOTS` | 10 | anti-starvation |
| `MAX_ACTIVE_POOL` | 30 | hard cap |
| `MAX_PUBLISH_COUNT` | 3 | confirmed -> publishable |
| `STALE_GRACE_MAX` | **2 (new)** | consecutive stale reads tolerated |

Comparison: [`lib/intraday-fast-watcher.js`](lib/intraday-fast-watcher.js:9) shadow watcher uses
`REQUIRED_CONFIRMATIONS = 2` and `MAX_ADVANCE_PCT = 6` — a **deliberate divergence** from pool's 3.
This is a documentation risk (Early Watch comments still say "frozen 2/2"), not a bug.

### 3.2 Rejection-rule taxonomy — [`lib/intraday-fast-watcher-momentum.js`](lib/intraday-fast-watcher-momentum.js:5)

```js
READY_VALUES       = READY, ENTRY_READY, QUALIFIED, SENDABLE, CONFIRMED,
                     A_PLUS_SETUP, TRADE_CANDIDATE, READY_BREAKOUT
NEAR_MISS_VALUES   = EARLY_RADAR, PRE_SPIKE_WATCH, WAIT_PULLBACK,
                     MOMENTUM_CONTINUATION, RECLAIM_CANDIDATE, WATCHING, WAIT
HARD_REJECT_VALUES = BLOCKED, REJECTED, NO_ACTION, INVALID, SPECULATIVE, AVOID
```

Terminal statuses produced by [`evaluate()`](lib/intraday-fast-watcher-momentum.js:470):

| Status | Trigger | Recovery |
|---|---|---|
| `INVALID_DATA` | price <= 0 / invalid entry zone / missing `first_price` | next valid tick |
| `STALE` | `freshness.is_stale` / `is_stale` / `data_stale` | *now* grace, then terminal |
| `INVALIDATED` | `current_price <= stop_loss`, engine hard-reject | terminal |
| `BLOCKED_CHASE` | price > entry high + tolerance, TP1 reached, advance > adaptive cap | terminal |
| `SPIKE_RADAR` | chase while momentum+volume strong | informational only |
| `WAIT_PULLBACK` | velocity gate blocked in 09:16-09:30 window | next tick |
| `WATCHING` | RVOL < 1.2, missing/below-minimum RR, non-ready engine | next tick |

### 3.3 Anti-chase proportionality (Fase-1 tick-size cross-check)

`evaluate()` computes `maxAdvance = clamp(max(2.5, volatility_pct x 1.5), 2.5, 6)` and
entry-overshoot tolerance `clamp(volatility_pct x 0.35, 0.25, 1.25)`.

Cross-checked against [`lib/idx-tick-normalization.js getIdxTickSize()`](lib/idx-tick-normalization.js:49):

| Reference price | IDX tick | One-tick overshoot | Tolerance | One-tick blocked? |
|---:|---:|---:|---:|---|
| Rp100 | 1 | 1.000 % | 0.350 % | **YES** |
| Rp450 | 2 | 0.444 % | 0.250 % | **YES** |
| Rp1,500 | 5 | 0.333 % | 0.250 % | **YES** |
| Rp4,500 | 10 | 0.222 % | 0.250 % | no (tolerated) |

**Analysis:** the 0.25 % floor is *tighter* than one legal tick for sub-Rp500 boards, so a
legitimate single-tick print above the entry high on a low-priced/high-volatility stock is
classified `BLOCKED_CHASE`/`SPIKE_RADAR`. This is a **conservative false-rejection**
(over-blocking, not under-blocking) — documented as an observation, not patched, because
loosening it would weaken the anti-chase guard on genuinely illiquid boards. No division-by-zero
exists here (all denominators guarded by `entry_high > 0` and `first_price > 0`).

### 3.4 Opening Range Velocity Guard (09:16-09:30 WIB)

| Board | Threshold | Constant |
|---|---:|---|
| UTAMA / PENGEMBANGAN | Rp 250,000,000 | `VELOCITY_THRESHOLD_MAIN_DEVELOPMENT` |
| AKSELERASI / SMALL / FCA | Rp 100,000,000 | `VELOCITY_THRESHOLD_ACCELERATION` |

Verified live: 09:20 with delta-turnover Rp500 jt -> CONFIRMED; Rp50 jt -> held at `WAIT_PULLBACK`;
09:45 outside window -> normal Phase-1 rules. **Gate works as documented.**

### 3.5 Feed-latency / fallback contract

- [`tools/intraday-sample-collector.js fetchWithFreshnessFallback()`](tools/intraday-sample-collector.js:430)
  marks network failure as `is_stale: true` with `stale_reason = network_failed_using_stale_cache_age_*`.
- HTTP non-200 -> `http_<status>`; timeout -> `timeout`; no data -> `no_data_in_response`.
- **Before fix:** a *single* stale read pushed `STALE` -> terminal -> tracker evicted with **zero grace**.
- **After fix:** up to `STALE_GRACE_MAX = 2` consecutive stale reads hold status and preserve the
  anti-chase baseline; a 3rd consecutive stale read terminates normally.

---

## 4. STATE-RACE ANALYSIS

### 4.1 Concurrency model

| Layer | Mechanism | Verdict |
|---|---|---|
| Shadow watcher | `acquireLock(lockFile)` + PID-liveness + stale-lock takeover ([`lib/intraday-fast-watcher.js`](lib/intraday-fast-watcher.js:379)) | safe |
| Guarded live | separate `.guarded-live.lock` ([`lib/intraday-fast-watcher-guarded-live.js`](lib/intraday-fast-watcher-guarded-live.js:32)) | safe |
| Live snapshot | `runLiveFastWatcher` takes `.live.lock` | safe |
| State write | `writeJsonAtomic` (write temp -> `rename`) | atomic |
| Event write | `appendEvents` (append-only JSONL) | safe |
| **In-flight `process()` calls** | **pure, synchronous, single-threaded** | no interleaving |

**Conclusion:** there is no true multi-writer race on the state file — the lock covers each
`run()`. The real defect is a **logical in-flight collision inside a single `process()` batch**
(hypothesis #1 in the brief): multiple observations for the same ticker within the *same minute*
each advanced the confirmation window, so a retry storm / tick burst confirmed a setup without
any temporal separation. Tracked as **F9-05**.

### 4.2 Confirmation-window data flow (post-fix)

```
observation (ticker, time, obs)
        |
        +- observationKey(ticker,time,obs)  -> dedupe identical payloads
        |
        +- minute = toMinutes(time)
        +- isNewConfirmationMinute = (last_confirmation_minute !== minute)   <- F9-05 fix
        |
        +- result = momentum.evaluate(withLockedSetup(obs), item)
        |
        +- staleOnly  = result.status === 'STALE'
        +- stale_grace_count = staleOnly ? prev+1 : 0                        <- F9-06 fix
        +- withinStaleGrace  = staleOnly && stale_grace_count <= 2
        |
        +- confirmation_window = isNewConfirmationMinute
        |       ? [...prior, result.passes].slice(-5)
        |       : prior.slice(-5)                                            <- no minute advance
        |
        +- terminalFailure = !withinStaleGrace && status in
        |       {INVALIDATED, STALE, INVALID_DATA, BLOCKED_CHASE}
        |
        +- to = withinStaleGrace ? preservedStatus
                 : (READY_CONFIRMED | READY_PENDING | ...)
                 +- reasons += 'stale_grace_pending'
```

### 4.3 Anti-chase baseline persistence (post-fix)

`first_price` is seeded once per tracker lifetime and is **not** reset while the tracker remains
active. A transient `STALE` read no longer flips `active = false`, so `resetTrackerForReentry()`
is not reached and the baseline survives. This closes the F9-06 -> F9-07 chained defect where a
feed hiccup mid-spike allowed an +8.6 % extended price to become `READY_PENDING`.

---

## 5. ZERO-DENOMINATOR / ARA-ARB REVIEW

The brief asked specifically about division by zero when the offer queue is empty (ARA) or the bid
queue is empty (ARB). Findings:

| Location | Expression | Guard present? | Verdict |
|---|---|---|---|
| [`intraday-volume-pace.js calculateVolumePace()`](lib/intraday-volume-pace.js:244) | `volumeToday / effective` | `effective != null && effective > 0` | safe |
| [`intraday-volume-pace.js`](lib/intraday-volume-pace.js:247) | `projected / avg_volume_20d_ex_today` | `> 0` check | safe |
| [`intraday-volume-pace.js`](lib/intraday-volume-pace.js:250) | `projected / previous_day_volume` | `> 0` check | safe |
| [`intraday-volume-pace.js deriveBaselines()`](lib/intraday-volume-pace.js:206) | `((avg*n) - cur) / (n - 1)` | `count = max(2, ...)` | safe |
| [`intraday-fast-watcher-momentum.js volatilityPct()`](lib/intraday-fast-watcher-momentum.js:262) | `atr14 / current_price` | `current_price <= 0` early-return | safe |
| [`intraday-fast-watcher-momentum.js scoreObservation()`](lib/intraday-fast-watcher-momentum.js:353) | `priceChangePct / max(0.15, ...)` | `max()` floor | safe |
| [`intraday-fast-watcher-momentum.js momentumFlowProxy()`](lib/intraday-fast-watcher-momentum.js:287) | `volume_rate / (avg/330)` | `average_volume > 0` | safe |
| [`daytrade-screener-engine.js scoreOrderFlowVelocity()`](lib/daytrade-screener-engine.js:3190) | dominance ratio | no queue division | safe |
| [`intraday-fast-watcher-early-watch.js applyObservationToTracker()`](lib/intraday-fast-watcher-early-watch.js:284) | `(price-ref) / ref` | `reference_price == null` early-return | safe |

**No NaN/Infinity paths found from empty bid/offer queues.** The ARA/ARB failure mode is instead a
**semantic** one: a legitimate `bid_dominance = 0` was collapsed by a logical-OR chain into the
fallback label `'Bid Dominant'`. Tracked as **F9-08** (fixed).

---

## 6. STRING-vs-NUMBER AUDIT (regression class from Fase 7 & 8)

Grep-driven sweep for raw truthiness / strict-type comparisons on payload fields:

| Module | Field | Original test | Fixed helper |
|---|---|---|---|
| `intraday-fast-watcher.js` | `production_eligible`, `ready` | `=== true` | `explicitBoolean()` |
| `intraday-fast-watcher.js` | `is_stale`, `data_stale`, `freshness.is_stale` | `Boolean(x === true)` | `explicitTrueFlag()` |
| `intraday-fast-watcher-momentum.js` | `production_eligible`, `ready` | `=== true` | `explicitBoolean()` |
| `intraday-fast-watcher-momentum.js` | stale flags | `x === true` | `explicitTrueFlag()` |
| `intraday-fast-watcher-momentum.js` | `volume_ratio_20d` | `Number.isFinite(raw)` | `finite()` coercion |
| `intraday-fast-watcher-momentum.js` | price / level fields | already coerced via `finite()` | unchanged |
| **`intraday-fast-watcher.js`** | **price / level fields** | **`typeof value === 'number'`** | **`finite()` coercion (F9-03)** |

The pattern in `idx-tick-normalization.js isExplicitTrueFlag()` (BUG-F7-04) was the correct precedent
and is now mirrored consistently across the watcher pipeline.

---

## 7. ZOMBIE-STATE REVIEW (Fase 2 regression class)

| Concern | Result |
|---|---|
| `locked_setup_id` permanently poisoning a ticker | **Not confirmed.** A first observation with a missing `stop_loss` yields `DROPPED_FROM_WATCH_POOL`; re-entry triggers `resetTrackerForReentry()` which clears the lock, and the next healthy tick proceeds (`READY_PENDING`). |
| `rejected_reason` exported honestly | Improved — `stale_grace_pending` now distinguishes a tolerated hiccup from a terminal `stale`. |
| `DROPPED_FROM_WATCH_POOL` permanence | Re-entry resets correctly (verified by `intraday-fast-watcher-lifecycle-reset.test.js`). |
| Terminal statuses recovering | `INVALIDATED` / `STALE` / `BLOCKED_CHASE` / `INVALID_DATA` all re-enter via shortlist refresh. |

---

## 8. TEST-FIRST EVIDENCE SUMMARY

**Pre-fix failure run** (`node --test test/audit-fase9-fast-watcher-bugs.test.js`):

```
FAIL F9-01  momentum.explicitReady accepts boolean-like production_eligible/ready
FAIL F9-01b watcher.explicitReady accepts boolean-like production_eligible
FAIL F9-01c pool: a string-typed production_eligible still confirms like a boolean one
FAIL F9-02  momentum treats a string stale flag as stale
FAIL F9-02b momentum.evaluate rejects a string-stale observation
FAIL F9-03  watcher.observationMetrics coerces numeric strings
FAIL F9-03b watcher.evaluateObservation passes a numeric-string observation
FAIL F9-04  isPrespikeRadar and isEarlyMomentum accept numeric-string ratios
FAIL F9-05  a same-minute tick burst cannot reach READY_CONFIRMED
PASS F9-05b distinct minutes still confirm normally
FAIL F9-06  a single stale tick is tolerated instead of dropping the tracker
PASS F9-06b a sustained stale feed still fails closed
PASS F9-07  transient stale must not reset the adaptive chase guard
FAIL F9-08  zero bid dominance is reported honestly, not as "Bid Dominant"
tests 14 | pass 3 | fail 11
```

Representative captured assertions:

- F9-05: `got ["READY_PENDING","READY_PENDING","READY_CONFIRMED","READY_CONFIRMED","READY_CONFIRMED"]`
- F9-06: `one stale read must not evict the tracker -> false !== true`
- F9-08: `got "Dominasi Bid/Offer: Bid Dominant"` for `bid_dominance: 0`
- F9-01: `{ value: null, source: null, status: null }` for `production_eligible: 'true'`

**Post-fix verification (2x consecutive):**

```
Run #1 -> tests 14 | pass 14 | fail 0
Run #2 -> tests 14 | pass 14 | fail 0
```

**Full curated suite:** `node tools/run-build-test-suite.js --full`
-> `All 526 test files passed successfully!`

---

## 9. FILES MODIFIED

| File | Change | Bug IDs |
|---|---|---|
| [`lib/intraday-fast-watcher-momentum.js`](lib/intraday-fast-watcher-momentum.js:1) | added `explicitTrueFlag/explicitFalseFlag/explicitBoolean`; coerced `explicitReady`, stale flags, radar ratios | F9-01, F9-02, F9-04 |
| [`lib/intraday-fast-watcher.js`](lib/intraday-fast-watcher.js:1) | coerced `finite()`; added flag helpers; coerced `explicitReady` + staleness; exported helpers | F9-01b, F9-03 |
| [`lib/intraday-fast-watcher-pool.js`](lib/intraday-fast-watcher-pool.js:1) | distinct-minute confirmation window; `STALE_GRACE_MAX` grace period; baseline preservation; exported constant | F9-05, F9-06, F9-07 |
| [`lib/telegram-templates.js`](lib/telegram-templates.js:1) | numeric-aware dominance label (Offer/Balanced/Bid) | F9-08 |
| [`tools/curated-build-tests.json`](tools/curated-build-tests.json:1) | registered new regression test (full-suite gate) | - |
| [`test/audit-fase9-fast-watcher-bugs.test.js`](test/audit-fase9-fast-watcher-bugs.test.js:1) | new 14-test regression suite | F9-01...F9-08 |

---

## 10. RESIDUAL RISKS / NON-PATCHED OBSERVATIONS

1. **Tick-proportional overshoot tolerance (3.3)** — the 0.25 % floor over-blocks legitimate
   one-tick prints on sub-Rp500 boards. Documented, not changed (deliberate conservatism).
2. **`REQUIRED_CONFIRMATIONS` divergence** — shadow watcher = 2, production pool = 3, Early Watch
   comments still reference "2/2". Documentation drift only; behaviour is correct.
3. **No dedicated orderbook-depth module** — spread/depth logic is embedded in the screener engine
   and the Telegram renderer, so depth-guard coverage relies on the dominance field only. A future
   standalone `bid-offer-guard` would improve testability (out of scope).
4. **`STALE_GRACE_MAX = 2`** is tuned for a few-second feed hiccup at ~1-minute tick cadence;
   revisit if the tick cadence changes materially.

---

## 11. VERDICT

The Fast Watcher confirmation gate, velocity guard, pool-capacity reservation, and data-quality
eligibility all behave as documented. Eight real defects were proven by failing tests and fixed with
minimal diffs:

- **2** state/logic defects in the confirmation gate (same-minute burst confirmation, stale-feed
  panic with chase-baseline reset),
- **1** semantic orderbook defect (ARB/zero-bid mislabelled as Bid Dominant),
- **5** type-coercion defects (string booleans, string stale flags, numeric-string prices/levels,
  numeric-string radar ratios).

All 14 new tests pass twice consecutively and the entire 526-file curated suite remains green.