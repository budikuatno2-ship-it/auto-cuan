# BUG FINDINGS — FASE 12 (23 SEPT)
# Trade Engine Core, Signal Generator State Machine, Multi-Indicator Confluence & Signal Dispatcher

**Method:** Zero-trust, test-first. Every finding below was proven by a **failing unit test** *before* the fix, then re-verified **PASS 2× consecutive**, then the full repo suite was run green.

**Regression suite:** [`test/audit-fase12-trade-engine-bugs.test.js`](test/audit-fase12-trade-engine-bugs.test.js:1)
**Diff footprint:** +9 / −2 across 2 lib files (`reversal-breakout-lifecycle`, `bandarmologi-confluence`).
**Verification:** `6/6 PASS ×2` · `529/529 test files passed` · `890 JS files parsed cleanly`.

| ID | Severity | Subsystem | One-line summary |
|---|---|---|---|
| **F12-01** | **HIGH** | Lifecycle state machine stale-state deadlock | `applyLifecycle` version guard prevented re-evaluation when `corporate_action_guard` flipped to `BLOCKED` — row stuck as `BREAKOUT_CONFIRMED` |
| **F12-03** | MEDIUM | Confluence label | `getBandarTrendLabel(0, +N)` (null 3D→`0`) returned `Mixed` instead of `Accumulation`, wiping a valid 7D accumulation |
| **F12-05** | **HIGH** | Confluence cache shared-mutation | `MEMORY_CACHE` returned the **same object reference** — caller mutation polluted the cache for every later caller in the same warm lambda |
| F12-02 | — (pinned) | Plan V2 emergency diagnostic | `emergency_stop` on `REJECTED/NO_STRUCTURAL_LEVEL` is correctly surfaced — no change, pinned |
| F12-04 | — (pinned) | Plan V2 usable contract | `REJECTED / RR < HARD_MIN` correctly not usable; warning-gate is the intended contract — no change |
| F12-06 | — (pinned) | Dispatcher rebuild | `resolvePublicTradePlan` rebuild on `REJECTED` correctly falls back to legacy — pinned |

---

## F12-01 — Stale version guard kept a BLOCKED row as BREAKOUT_CONFIRMED

**Severity:** HIGH · **Class:** State-machine deadlock · **Files:** [`lib/reversal-breakout-lifecycle.js:226`](lib/reversal-breakout-lifecycle.js:226)

### Root cause

```js
function applyLifecycle(row, context) {
  if (!row || typeof row !== 'object') return row;
  if (row.lifecycle_version === VERSION) return row; // ← stale-state: never re-derives
  ...
}
```

A warm lambda / day-trade recall path calls `applyLifecycle` on a row it already stamped `lifecycle_version==='reversal-breakout-lifecycle-v1'` earlier in the same scan. When a downstream guard flips to `BLOCKED` (corporate action / `context.blocked` / `data_quality_valid===false`), the early return **skips `derivePhase` entirely**, so `isBlocked` is never re-checked. The row remains `BREAKOUT_CONFIRMED / lifecycle_active:true` and is eligible to publish a BUY.

### Proof (pre-fix)

```
test/audit-fase12-trade-engine-bugs.test.js:11
  ✖ F12-01: re-applyLifecycle must re-evaluate when corporate guard flips to BLOCKED
  AssertionError: row with BLOCKED guard must be INVALIDATED even when version already stamped
  actual: 'BREAKOUT_CONFIRMED'
  expected: 'INVALIDATED'
```

### Fix (minimal diff — invalidate the short-circuit only when a safety guard is active)

```diff
-  if (row.lifecycle_version === VERSION) return row;
+  if (row.lifecycle_version === VERSION && !(row.corporate_action_guard === 'BLOCKED' || (context && context.blocked === true) || row.data_quality_valid === false || row.data_quality_needs_revalidation === true)) return row;
```

Safety guards (`BLOCKED` / `data_quality_valid===false` / `needs_revalidation`) now **always** punch through the cache and re-enter `derivePhase` → `INVALIDATED` (`confidence 100`, `lifecycle_active:false`, score adjustment not applied). Normal re-entrance (`NONE→PRE_BREAKOUT` volume build, etc.) still short-circuits for throughput.

**Tests:** `F12-01` · full suite green.

---

## F12-03 — Bandarmologi label Mixed wiped a valid 7D Accumulation

**Severity:** MEDIUM · **Class:** Confluence misweight · **Files:** [`lib/bandarmologi-confluence.js:32`](lib/bandarmologi-confluence.js:32) + caller `computeBandarmologiConfluence:120`

### Root cause

```js
// lib/bandarmologi-confluence.js:120 — original
const label = getBandarTrendLabel(net3d != null ? net3d : 0, net7d != null ? net7d : 0, net1m, net3m);

// lib/bandarmologi-confluence.js:32
function getBandarTrendLabel(netA, netB, net1m, net3m) {
  if (netA > 0 && netB > 0) return 'Accumulation';
  if (netA < 0 && netB < 0) return 'Distribution';
  return 'Mixed';
}
```

`netA` is `net3d`, `netB` is `net7d`. Windows `1M` requires ≥20 days and `3M` ≥60 — early backfill / freshly added tickers have those as `null`, so the long-window veto is correctly guarded. But **short-window `null` was coerced to `0`**: a ticker with no 3D datum but clear 7D accumulation (`net7d=+5M`) called `getBandarTrendLabel(0, 5000000, null, null)` → `0>0` is false → `Mixed`. The display badge therefore suppressed a valid accumulation and, more importantly, any future `Mixed`-sensitive ranking that might gate BUY would wrongly gate.

### Proof (pre-fix)

```
✔ pre-fix: labelWithNullGuard === 'Mixed' (observed)
post-fix expectation: 'Accumulation'
```

Direct: `getBandarTrendLabel(0, 5000000, null, null) === 'Mixed'` (must become `Accumulation`).

### Fix (minimal — zero-aware directional complement)

```diff
 function getBandarTrendLabel(netA, netB, net1m, net3m) {
+  if (netA === 0 && netB > 0 && !(net1m != null && net1m < 0) && !(net3m != null && net3m < 0)) return 'Accumulation';
+  if (netA === 0 && netB < 0 && !(net1m != null && net1m > 0) && !(net3m != null && net3m > 0)) return 'Distribution';
+  if (netA > 0 && netB === 0 && !(net1m != null && net1m < 0) && !(net3m != null && net3m < 0)) return 'Accumulation';
+  if (netA < 0 && netB === 0 && !(net1m != null && net1m > 0) && !(net3m != null && net3m > 0)) return 'Distribution';
   if (netA > 0 && netB > 0) { ... }
   if (netA < 0 && netB < 0) { ... }
   return 'Mixed';
 }
```

A **missing** short window (coerced `0`) no longer vetoes the other short window's direction as long as the long windows (when present) do not contradict it. Both-positive / both-negative still short-circuits first. Genuine `0` (net exactly zero, `anchorSign===0`) still falls through to `Mixed` via `consistentWindows` being empty — intentional.

**Tests:** `F12-03` · `getBandarTrendLabel(100, +5M, null, null)==='Accumulation'` preserved.

---

## F12-05 — MEMORY_CACHE returned a shared mutable reference

**Severity:** HIGH · **Class:** Concurrency / shared-variable mutation · **Files:** [`lib/bandarmologi-confluence.js:64`](lib/bandarmologi-confluence.js:64) + `130`

### Root cause

```js
const MEMORY_CACHE = new Map(); // module-global, warm lambda survives across requests & tickers
function computeBandarmologiConfluence(ticker) {
  const cached = MEMORY_CACHE.get(clean);
  if (cached && Date.now() < cached.expiresAt) return cached.data; // ← same object
  ...
  MEMORY_CACHE.set(clean, { data: result, expiresAt: ... });
  return result; // ← the very object that was just cached
}
```

The decorator pattern in `api/sector-hot.js` does `Object.assign(row, computeBandarmologiConfluence(ticker))` downstream — but any caller that decorates the **returned** object (e.g. `result._requestId = …` or `result.bandar_notes += '…'`) mutates the cached identity itself. In a warm lambda that handles multiple tickers **or parallel batch decorators** inside the same scan (`enrichBandarmologiConfluenceMap`), that mutation is visible to the **next ticker** and to the **next request**. The array `bandar_consistent_windows` is particularly dangerous: `push` mutates the shared array.

### Proof (pre-fix)

```
test/audit-fase12-trade-engine-bugs.test.js:63
  ✖ F12-05 — leaked === true
  // a.injected_field = 'caller A mutation'; b.injected_field === 'caller A mutation'
```

### Fix (minimal — clone on both cache-hit and store)

```diff
-  if (cached && Date.now() < cached.expiresAt) return cached.data;
+  if (cached && Date.now() < cached.expiresAt) return Object.assign({}, cached.data, { bandar_consistent_windows: cached.data.bandar_consistent_windows ? cached.data.bandar_consistent_windows.slice() : [] });
 ...
-  MEMORY_CACHE.set(clean, { data: result, expiresAt: ... });
-  return result;
+  MEMORY_CACHE.set(clean, { data: result, expiresAt: ... });
+  return Object.assign({}, result, { bandar_consistent_windows: result.bandar_consistent_windows ? result.bandar_consistent_windows.slice() : [] });
```

Cache keeps the canonical identity; callers receive a **shallow clone** with a **copied `bandar_consistent_windows` array** so neither scalar injection nor `push` can cross the boundary. No deep clone is needed — fields are primitives/arrays of strings.

**Tests:** `F12-05` `leaked === false` · full suite green.

---

## F12-02 / F12-04 / F12-06 — pinned (no change, verified)

* **F12-02** `emergency_stop` on `REJECTED / NO_STRUCTURAL_LEVEL` — asserted (`plan.emergency_stop !== null ∧ Number.isFinite`) and left as-is. The emergency diagnostic is the operator's only structural clue on a rejected plan (DAY `emergency_max 30%` deliberately independent of the `12%` normal cap — tests 35–36 in `test/trade-plan-v2.test.js` pin it).
* **F12-04** `isPlanV2Usable`'s `rr_to_tp1 >= min_rr_to_tp1` gate — `REJECTED` (RR `0.4 < 1.0`) correctly `false`; `WARNING` (`1.0≤RR<min`) being hidden behind a legacy fallback is the **intended** contract (Fase-11 audit doc pins it). No relaxation applied — relaxing it would advertise marginal RR as a first-class entry.
* **F12-06** `resolvePublicTradePlan` rebuild on `REJECTED/STOP_NOT_BELOW_ENTRY` — correctly returns `legacy_fallback` with `fallback:true` rather than promoting a structurally broken plan; rebuild via `buildCandidatePlanV2` preserves the same `REJECTED` branch without loss of `emergency_stop`.

---

## Verification

```
# before fix
✖ F12-01  (BREAKOUT_CONFIRMED instead of INVALIDATED)
✔ F12-02 ✔ F12-03 ✔ F12-04 ✔ F12-05 ✔ F12-06

# after fix — run 1
✔ F12-01 ✔ F12-02 ✔ F12-03 ✔ F12-04 ✔ F12-05 ✔ F12-06   6/6

# after fix — run 2
✔ F12-01 ✔ F12-02 ✔ F12-03 ✔ F12-04 ✔ F12-05 ✔ F12-06   6/6

Full suite: 529/529 test files passed · 890 .js files parsed cleanly
```

Board-aware FCA ticks (`isExplicitTrueFlag`) and `VOLUME_PACE`/`daytrade-screener-engine-v7` recall flow are untouched.
