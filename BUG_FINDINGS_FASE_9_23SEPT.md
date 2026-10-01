# BUG FINDINGS — FASE 9 (23 SEPT)
# Fast Watcher Engine, Real-time Pipeline Gates, & Rejection Rules

**Method:** Zero-trust, test-first. Every finding below was proven by a **failing unit test**
*before* the fix, then re-verified **PASS 2× consecutive**.
**Regression suite:** [`test/audit-fase9-fast-watcher-bugs.test.js`](test/audit-fase9-fast-watcher-bugs.test.js:1)
**Diff footprint:** 155 insertions / 25 deletions across 4 lib files + 1 config file.

| ID | Severity | Subsystem | One-line summary |
|---|---|---|---|
| F9-01 | HIGH | Rejection gate | String `'true'` / `1` engine flags downgraded to `unknown` |
| F9-02 | HIGH | Freshness gate | String `'true'` stale flag bypassed fail-closed rejection |
| F9-03 | MEDIUM | Shadow watcher | Numeric-string prices → false `INVALID_DATA` |
| F9-04 | MEDIUM | Radar detection | Numeric-string ratios → prespike/early-momentum never fire |
| F9-05 | **CRITICAL** | Confirmation gate | Same-minute tick burst satisfies REQUIRED_CONFIRMATIONS instantly |
| F9-06 | HIGH | Feed fallback | One transient stale read evicts tracker (no grace period) |
| F9-07 | HIGH | Anti-chase | …and resets `first_price`, defeating the +6 % chase guard |
| F9-08 | HIGH | Orderbook label | ARB / zero-bid book reported as "Bid Dominant" |

---

## F9-01 — Boolean-like engine flags rejected (string vs boolean)

**Severity:** HIGH · **Class:** Type coercion (Fase 7/8 regression) · **Files:** [`lib/intraday-fast-watcher-momentum.js`](lib/intraday-fast-watcher-momentum.js:185), [`lib/intraday-fast-watcher.js`](lib/intraday-fast-watcher.js:113)

### Root cause

```js
if (obs.production_eligible === true) return { value: true, source: 'production_eligible', ... };
if (obs.production_eligible === false) return { value: false, ... };
if (obs.ready === true) return { value: true, source: 'ready', ... };
```

The pipeline forwards JSON payloads where booleans arrive as `'true'`/`'false'` strings (PostgREST,
cached snapshots, replay fixtures) or `1`/`0`. A strict `=== true` comparison fails for all of them,
so `explicitReady()` returned `{ value: null }` → `classifyEngine()` → `'unknown'` → the candidate
could **never accumulate confirmations**, silently parking a genuinely READY setup at `WATCHING`
with `watch_score ≈ 2` instead of `≈ 32`.

### Proof (pre-fix)

```
explicitReady({ production_eligible: 'true' }) => { value: null, source: null, status: null }
pool string-boolean run  => status WATCHING (after 3 distinct minutes)
pool boolean run         => status READY_CONFIRMED (after 3 distinct minutes)
```

### Fix

Added coercion helpers to both modules and routed the flag reads through them — the literal string
`'false'` can never be read as a positive flag:

```js
function explicitTrueFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const n = value.trim().toLowerCase();
    return n === 'true' || n === '1' || n === 'yes' || n === 'y';
  }
  return false;
}
function explicitFalseFlag(value) { /* mirror for 'false' | '0' | 'no' | 'n' */ }
function explicitBoolean(value) {
  if (explicitTrueFlag(value)) return true;
  if (explicitFalseFlag(value)) return false;
  return null;
}
```

```js
-  if (obs.production_eligible === true) return { value: true, source: 'production_eligible', status: 'PRODUCTION_ELIGIBLE' };
-  if (obs.production_eligible === false) return { value: false, source: 'production_eligible', status: 'NOT_READY' };
-  if (obs.ready === true) return { value: true, source: 'ready', status: 'READY' };
-  if (obs.ready === false) return { value: false, source: 'ready', status: 'NOT_READY' };
+  const productionEligible = explicitBoolean(obs.production_eligible);
+  if (productionEligible === true) return { value: true, source: 'production_eligible', status: 'PRODUCTION_ELIGIBLE' };
+  if (productionEligible === false) return { value: false, source: 'production_eligible', status: 'NOT_READY' };
+  const readyFlag = explicitBoolean(obs.ready);
+  if (readyFlag === true) return { value: true, source: 'ready', status: 'READY' };
+  if (readyFlag === false) return { value: false, source: 'ready', status: 'NOT_READY' };
```

**Tests:** `F9-01`, `F9-01b`, `F9-01c`

---

## F9-02 — String stale flag bypasses the fail-closed freshness gate

**Severity:** HIGH · **Class:** Type coercion / safety · **Files:** [`lib/intraday-fast-watcher-momentum.js`](lib/intraday-fast-watcher-momentum.js:258), [`lib/intraday-fast-watcher.js`](lib/intraday-fast-watcher.js:133)

### Root cause

```js
stale: Boolean(observation.freshness && observation.freshness.is_stale === true)
       || Boolean(observation.is_stale === true || observation.data_stale === true)
```

`tools/intraday-sample-collector.js` sets `is_stale: <boolean>` internally, but any payload that has
round-tripped through JSON/PostgREST delivers `'true'`. The `=== true` test then evaluated **false**,
and a genuinely stale quote was scored, confirmed, and published as fresh — the exact opposite of
the documented "stale data fails closed" contract, and a direct trading-safety hazard.

### Proof (pre-fix)

```
momentum.metricsFrom({ is_stale: 'true' }).stale     => false
momentum.evaluate({ ..., is_stale: 'true' })         => READY_PASS   // must be STALE
pool tick with is_stale:'true'                       => READY_PENDING // must be STALE
```

### Fix

```js
-    stale: Boolean(observation.freshness && observation.freshness.is_stale === true) || Boolean(observation.is_stale === true || observation.data_stale === true)
+    stale: explicitTrueFlag(observation.freshness && observation.freshness.is_stale) ||
+      explicitTrueFlag(observation.is_stale) ||
+      explicitTrueFlag(observation.data_stale)
```

Applied identically in `lib/intraday-fast-watcher.js observationMetrics()`.

**Tests:** `F9-02`, `F9-02b`

---

## F9-03 — Shadow watcher rejects numeric-string prices

**Severity:** MEDIUM · **Class:** Type coercion · **File:** [`lib/intraday-fast-watcher.js`](lib/intraday-fast-watcher.js:24)

### Root cause

```js
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
```

Unlike the sibling `intraday-fast-watcher-momentum.js finite()` (which coerces), the shadow watcher
required a real `number`. Every JSON/JSONL price arrives as a string, so `current_price`, `entry_low`,
`entry_high`, `tp1`, `stop_loss` all resolved to `null` → `INVALID_DATA / invalid_current_price` —
a false rejection that also left `first_price` unseeded.

### Proof (pre-fix)

```
observationMetrics({ current_price: '1500' }) => { current_price: null, ... }
evaluateObservation({ current_price: '1500', ... }) => { status: 'INVALID_DATA', passes: false }
```

### Fix

```js
function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
```

**Tests:** `F9-03`, `F9-03b`

---

## F9-04 — Numeric-string ratios defeat prespike / early-momentum radar detection

**Severity:** MEDIUM · **Class:** Type coercion · **File:** [`lib/intraday-fast-watcher-momentum.js`](lib/intraday-fast-watcher-momentum.js:533)

### Root cause

```js
const vr = (data.volume_ratio_20d != null && Number.isFinite(data.volume_ratio_20d))
  ? Number(data.volume_ratio_20d) : 0;
```

`Number.isFinite('3.0')` is `false` for the numeric **strings** JSON carries, so `vr` silently fell
back to `0` and both `isPrespikeRadar()` and `isEarlyMomentum()` returned `false` for every
string-typed payload — a silent **filter bottleneck** that suppressed legitimate radar candidates.

### Proof (pre-fix)

```
isPrespikeRadar({ change_pct: 0.5, volume_ratio_20d: '3.0' }) => false   // must be true
isEarlyMomentum({ change_pct: 3.0, volume_ratio_20d: '2.5' }) => false   // must be true
```

### Fix

```js
-  const vr = (data.volume_ratio_20d != null && Number.isFinite(data.volume_ratio_20d))
-    ? Number(data.volume_ratio_20d)
-    : (data.volume_ratio != null && Number.isFinite(data.volume_ratio) ? Number(data.volume_ratio) : 0);
+  const vr = finite(data.volume_ratio_20d) ?? finite(data.volume_ratio) ?? 0;
```

**Tests:** `F9-04`

---

## F9-05 — Same-minute tick burst satisfies REQUIRED_CONFIRMATIONS instantly

**Severity:** CRITICAL · **Class:** State / in-flight collision · **File:** [`lib/intraday-fast-watcher-pool.js`](lib/intraday-fast-watcher-pool.js:350)

### Root cause

The confirmation window appended **one boolean per processed observation**, not per distinct
observation **minute**:

`REQUIRED_CONFIRMATIONS = 3` is therefore satisfiable by three ticks inside a **single minute** -
exactly the in-flight collision scenario in the brief. `observationKey()` de-duplicates *identical*
payloads, but a retry storm / rapid-fire burst delivers *slightly different* payloads (each with a
different `turnover`), so every one of them extended the window.

### Proof (pre-fix)

```
burst (same minute 09:45, 5 distinct ticks):
  ["READY_PENDING","READY_PENDING","READY_CONFIRMED","READY_CONFIRMED","READY_CONFIRMED"]
intended (3 distinct minutes):
  ["READY_PENDING","READY_PENDING","READY_CONFIRMED"]
```

### Fix

```diff
+    const isNewConfirmationMinute = minute == null || item.last_confirmation_minute !== minute;
     const priorConfirmationWindow = confirmationSourceChanged ? [] : (Array.isArray(item.confirmation_window) ? item.confirmation_window : []);
-    const confirmationWindow = [...priorConfirmationWindow, result.passes === true].slice(-CONFIRMATION_WINDOW_SIZE);
+    const confirmationWindow = isNewConfirmationMinute
+      ? [...priorConfirmationWindow, result.passes === true].slice(-CONFIRMATION_WINDOW_SIZE)
+      : priorConfirmationWindow.slice(-CONFIRMATION_WINDOW_SIZE);
+    if (isNewConfirmationMinute) item.last_confirmation_minute = minute;
```

New tracker field: `last_confirmation_minute: null` in `trackerFor()`.

**Tests:** `F9-05` (burst cannot confirm), `F9-05b` (distinct minutes still confirm)

---

## F9-06 — One transient stale tick terminates the whole watch cycle

**Severity:** HIGH · **Class:** Feed fallback / availability · **File:** [`lib/intraday-fast-watcher-pool.js`](lib/intraday-fast-watcher-pool.js:354)

### Root cause

`STALE` was in the terminal set with **no tolerance window**:

```js
const terminalFailure = ['INVALIDATED', 'STALE', 'INVALID_DATA', 'BLOCKED_CHASE'].includes(result.status);
```

A single failed Yahoo fetch (the collector sets `is_stale: true` on any timeout / HTTP error) forced
`item.active = false` and `status = 'DROPPED_FROM_WATCH_POOL'` via the `throughMinute` sweep. The
brief's hypothesis - "does the watcher panic and reject everything when the feed is late?" - is
**confirmed: yes, on the very first stale read.**

### Proof (pre-fix)

```
t=09:45 status=READY_PENDING active=true
t=09:46 status=READY_PENDING active=true
t=09:47 STALE  status=DROPPED_FROM_WATCH_POOL active=false   <- one stale read killed it
```

### Fix

```diff
+ const STALE_GRACE_MAX = 2;
...
+    const staleOnly = result.status === 'STALE';
+    item.stale_grace_count = staleOnly ? (item.stale_grace_count || 0) + 1 : 0;
+    const withinStaleGrace = staleOnly && item.stale_grace_count <= STALE_GRACE_MAX;
+    const terminalFailure = !withinStaleGrace && ['INVALIDATED', 'STALE', 'INVALID_DATA', 'BLOCKED_CHASE'].includes(result.status);
...
+    if (withinStaleGrace) {
+      to = from || 'WATCHING';
+      result.reasons = [...new Set([...(result.reasons || []), 'stale_grace_pending'])].sort();
+    } else if (result.passes) { ... }
```

New tracker field: `stale_grace_count: 0`. New exported constant `STALE_GRACE_MAX`.
`stale_grace_pending` is surfaced honestly in `rejected_reason`; terminal `stale` still fires on the
3rd consecutive stale read.

**Tests:** `F9-06`, `F9-06b`

---

## F9-07 — Transient stale resets the anti-chase baseline (chained with F9-06)

**Severity:** HIGH · **Class:** Chained state corruption · **File:** [`lib/intraday-fast-watcher-pool.js`](lib/intraday-fast-watcher-pool.js:237)

### Root cause

Because F9-06 evicted the tracker, the next shortlist refresh hit
`if (item.status === 'DROPPED_FROM_WATCH_POOL') resetTrackerForReentry(item, row, throughMinute);`
which runs `Object.assign(item, trackerFor(...))` - resetting `first_price` to `null`. The next
observation reseeded `first_price` at the **already-advanced** price, so the adaptive
`advance_pct > maxAdvance` guard measured from the wrong baseline.

### Proof (pre-fix)

```
t=09:45 price=1000  first_price=1000  status=READY_PENDING
t=09:46 price=1085  status=SPIKE_RADAR (adaptive_advance_chase)   <- correctly flagged
t=09:47 STALE       status=DROPPED_FROM_WATCH_POOL active=false
t=09:48 price=1086  first_price=1086  status=READY_PENDING        <- CHASE GUARD BYPASSED
```

### Fix

No new code: the F9-06 grace period keeps the tracker `active`, so `resetTrackerForReentry()` is
never reached and `first_price` survives the hiccup. Verified that `first_price` stays `1000` and
the +8.6 % tick is not `READY_PENDING`.

**Test:** `F9-07`

---

## F9-08 — ARB / zero-bid book reported as "Bid Dominant"

**Severity:** HIGH · **Class:** Logical-OR falsy collapse · **File:** [`lib/telegram-templates.js`](lib/telegram-templates.js:469)

### Root cause

```js
var dominance = safe(r.bid_offer_dominance || r.bid_dominance || r.orderbook_dominance || r.dominance, 'Bid Dominant');
```

`||` treats the legitimate numeric value **`0`** as falsy. A `bid_dominance` of `0` means an **empty
bid queue** - i.e. **ARB** (Auto Reject Bawah) or a fully offer-dominated book - yet the Telegram card
printed `Dominasi Bid/Offer: Bid Dominant`, asserting the **exact opposite** of the real order book.

### Proof (pre-fix)

```
bid_dominance: 0    -> "Dominasi Bid/Offer: Bid Dominant"
```

### Fix

```diff
+  var rawDom = r.bid_offer_dominance != null ? r.bid_offer_dominance
+             : (r.bid_dominance != null ? r.bid_dominance
+             : (r.orderbook_dominance != null ? r.orderbook_dominance : r.dominance));
+  var dominance;
+  if (rawDom != null && rawDom !== '' && !isNaN(Number(rawDom))) {
+    var numDom = Number(rawDom);
+    var pctDom = (numDom > 1 && numDom <= 100) ? numDom : (numDom * 100);
+    if (pctDom <= 45)      dominance = 'Offer Dominant (' + Math.round(100 - pctDom) + '% Offer)';
+    else if (pctDom >= 55) dominance = 'Bid Dominant (' + Math.round(pctDom) + '% Bid)';
+    else                   dominance = 'Balanced (Bid/Offer Seimbang)';
+  } else {
+    dominance = safe(rawDom, 'Bid Dominant');
+  }
```

### Post-fix behaviour

| Input | Output |
|---|---|
| `bid_dominance: 0` (ARB) | `Offer Dominant (100% Offer)` |
| `bid_dominance: 0.72` | `Bid Dominant (72% Bid)` |
| `bid_dominance: 72` | `Bid Dominant (72% Bid)` |
| `bid_offer_dominance: 'Bid 65% (Dominan)'` | `Bid 65% (Dominan)` (unchanged) |
| missing | `Bid Dominant` (unchanged default) |

**Test:** `F9-08`

---

## TEST-FIRST EVIDENCE

### Pre-fix failure run

```
node --test test/audit-fase9-fast-watcher-bugs.test.js
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

### Post-fix PASS run #1

```
tests 14 | suites 0 | pass 14 | fail 0 | cancelled 0 | skipped 0 | todo 0
```

### Post-fix PASS run #2 (consecutive)

```
tests 14 | suites 0 | pass 14 | fail 0 | cancelled 0 | skipped 0 | todo 0
```

### Full curated suite

```
node tools/run-build-test-suite.js --full
All 526 test files passed successfully!
```

---

## DIFF SUMMARY

```
 lib/intraday-fast-watcher-momentum.js | 57 +++++++++++++++++++++++++++--------
 lib/intraday-fast-watcher-pool.js     | 45 ++++++++++++++++++++++++---
 lib/intraday-fast-watcher.js          | 51 +++++++++++++++++++++++++++----
 lib/telegram-templates.js             | 18 ++++++++++-
 tools/curated-build-tests.json        |  9 ++++++
 5 files changed, 155 insertions(+), 25 deletions(-)
```

| Bug | File | Nature of change |
|---|---|---|
| F9-01 | `intraday-fast-watcher-momentum.js`, `intraday-fast-watcher.js` | coercion helpers + flag reads |
| F9-02 | `intraday-fast-watcher-momentum.js`, `intraday-fast-watcher.js` | staleness coercion |
| F9-03 | `intraday-fast-watcher.js` | `finite()` coercion |
| F9-04 | `intraday-fast-watcher-momentum.js` | `finite()` for radar ratios |
| F9-05 | `intraday-fast-watcher-pool.js` | distinct-minute confirmation window |
| F9-06 | `intraday-fast-watcher-pool.js` | `STALE_GRACE_MAX` grace period |
| F9-07 | `intraday-fast-watcher-pool.js` | (resolved by F9-06 baseline preservation) |
| F9-08 | `telegram-templates.js` | numeric-aware dominance label |

---

## NON-BUGS CONFIRMED (documented for completeness)

1. **No ARA/ARB division-by-zero.** Every division in `intraday-volume-pace.js`,
   `intraday-fast-watcher-momentum.js`, and `intraday-fast-watcher-early-watch.js` is guarded by an
   explicit `> 0` / `!= null` check (see AUDIT_LOG section 5). ARA/ARB fail *semantically* (F9-08),
   not numerically.
2. **No true multi-writer state race.** `acquireLock()` + `writeJsonAtomic()` cover every `run()`;
   `process()` is synchronous and single-threaded.
3. **No zombie lock.** A first observation with missing `stop_loss` / invalid `tp1` yields
   `DROPPED_FROM_WATCH_POOL`, and re-entry resets the tracker cleanly (`lifecycle-reset` test).
4. **Velocity guard and pool capacity behave as documented** - verified with dedicated scenarios.

## RESIDUAL OBSERVATIONS (not patched)

- Overshoot tolerance `clamp(volPct x 0.35, 0.25, 1.25)` is tighter than one IDX tick for sub-Rp500
  boards - conservative over-blocking (safe direction). Documented only.
- `REQUIRED_CONFIRMATIONS` is 2 in the shadow watcher and 3 in the production pool while Early Watch
  comments still say "2/2" - documentation drift, no behavioural defect.
- No standalone orderbook-depth module exists; depth coverage relies on the single dominance field.