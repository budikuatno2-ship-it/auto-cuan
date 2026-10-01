# BUG FINDINGS — FASE 15 & 16 (24 SEPT)
# Historical Candlestick & Volume Ingestion Pipeline (1-Year) + E2E Stress & Build Lock

**Method:** Zero-trust, test-first. Setiap temuan dibuktikan dengan **unit test yang GAGAL (FAIL)** *sebelum* perbaikan, lalu re-verifikasi **PASS 2× berturut-turut**, lalu full suite repo tetap hijau.

**Regression suite:** [`test/audit-fase15-16-pipeline-stress-bugs.test.js`](test/audit-fase15-16-pipeline-stress-bugs.test.js:1) — 12 tests
**Diff footprint:** [`lib/chart-engine/candle-fetcher.js`](lib/chart-engine/candle-fetcher.js:112) — introduced `toFeedNumber()` + locale-safe coercion + export + doc header `limit 120→200`. No behavioral tightening on 429/throttling path.
**Verification:** `12/12 PASS ×2` · `892 JS parsed cleanly` · `531/531 curated tests PASS` via `node tools/run-build-test-suite.js --full`.

| ID | Severity | Subsystem | One-line summary |
|---|---|---|---|
| **F15-02** | **MEDIUM** | `chart-engine/candle-fetcher` normalizePayload | Locale string `"1,234"` / `"1.234,56"` becomes `NaN` via raw `Number()`, silently dropping 1y history rows |
| F15-01, F15-03–F15-09, F16-01/02 | — (pass-kunci) | 1y window / holiday gap / bulk 200 / 429 / memory / e2e signal / build lock | Already correct — locked as BEWIS invariants, documented here for audit trace |

---

## F15-02 — `normalizePayload` silently drops locale-formatted candles (MEDIUM)

**Severity:** MEDIUM · **Class:** Data loss / silent filter · **Files:** [`lib/chart-engine/candle-fetcher.js:141`](lib/chart-engine/candle-fetcher.js:141)

### Root cause

```js
// before (buggy)
open: Number(c.open || c.o),
high: Number(c.high || c.h),
...
}).filter(c => Number.isFinite(c.open) && ... )
```

In JS, `Number("1,234") === NaN`, `Number("1.234,56") === NaN`. If Arjum (or any upstream) emits Indonesian/thousand-formatted strings, every affected candle is silently filtered out — the 1-year window shrinks without error, corrupting downstream MA/RSI/weekly pivots. The existing `isFinite` filter *contains* NaN from propagating but does so by dropping rows — data loss, not sanitization.

### Proof (pre-fix) — reproducer

```
Number("1,234")        → NaN  (JS)
Number("1.234,56")     → NaN
Number("1,234.56")     → NaN

normalizePayload('BBCA', { rows: [{ open:'1,234', high:'1,235', ... }] })
  → filter removes the row (isFinite false) → candles.length 0 → history gap
```

Test `F15-02` required explicit comma/dot sanitization before coercion:

```js
const hasSanitize = /toFeedNumber|toNumberLoose|replace\([^)]*,/.test(src)
assert.ok(hasSanitize, 'must sanitize comma/thousand separators before Number()')
```

Before fix: **FAIL** (no sanitizer). After fix: **PASS**.

### Fix

Introduced `toFeedNumber(raw)` (Indonesian locale heuristic):
- Both `'.'` and `','` present → if last `','` > last `'.'` then `','` is decimal (ID: `"1.234,56"` → `"1234.56"`), else `','` is thousand (`"1,234.56"` → `"1234.56"`).
- Only `','` present → if single comma with ≤2 trailing digits, treat as decimal; otherwise thousand.
- Strips remaining whitespace before `Number()`.

Also exported `toFeedNumber` + `normalizePayload` for unit testing and corrected doc header `limit=120` → `limit=200` (1-year window). No change to throttling/429 path.

**After-fix proof:**

```
toFeedNumber("1,234")     → 1234
toFeedNumber("1.234,56")  → 1234.56
toFeedNumber("1,234.56")  → 1234.56
normalizePayload(..., rows:[{open:'1,234', close:'1,234', volume:'1,234,567'}])
  → close 1234, volume 1234567 (row preserved, not dropped)
```

### Regression scope

- Existing filter `Number.isFinite` still guards downstream NaN.
- No change to `fetchDailyCandles` throttle/quota or `fetchRemote` 429 handling.
- Full suite `531/531 PASS` after fix.

---

## F15-01 — 1-Year window default limit (PASS-KUNCI, BEWIS)

**Status:** Correct — locked, not changed (doc header fixed only)

- `lib/chart-engine/candle-fetcher.js:173` — `Math.max(20, Number(opts.limit) || 200)` — default 200
- `lib/daily-history-collector.js:112` — `?range=1y&interval=1d`
- Backfill `--limit=200` default. MIN_CANDLES 170 floor guarantees January-2026 coverage.
- Test `F15-01`/`F15-01b` assert `>=200` + `range=1y` — PASS.

## F15-03 — Holiday gap (PASS-KUNCI)

**Status:** Correct — no synthetic `close:0` / `volume:0` fillers

- `candlesToHistoryRows` chains `previous_close` from real prior candle, `null` for first row.
- No `close: 0` string literal in collector (asserted).
- Test injects 2 candles → 2 rows, no gap row — PASS.

## F15-04 / F15-08 — Bulk ingestion (PASS-KUNCI)

**Status:** Correct

- `UPSERT_BATCH_SIZE=200`, `onConflict 'ticker,trade_date'`, deduped Map, 260 rows → 2 batches.
- Validated in Fase 14 as well; re-locked here.

## F15-05 — Throttling & HTTP 429 (PASS-KUNCI)

**Status:** Correct

- `fetchRemote` returns `rateLimited: status===429` → surfaced by `fetchDailyCandles`.
- `arjum-client.js` has serial queue + 800ms throttle + circuit breaker (F14-05).
- `backfill-historical-candles.js` sequential `for (ticker) await fetch` + `quota_stop` on `rateLimited`.
- No parallel fan-out that would burst 800 tickers — PASS.

## F15-06 — Memory leak & GC sweep (PASS-KUNCI)

**Status:** Correct

- `candle-fetcher` — no global `Map`, disk cache only (bounded).
- `daytrade-ohlcv-cache` — `slice(-90)` trim.
- `stock-daily-history-store` — per-ticker `.limit(count)`, no unbounded universe×260 load.
- 800×260 synthetic alloc+clear stable — PASS.

## F15-07 — E2E signal consistency 260 candles (PASS-KUNCI)

**Status:** Correct

- EMA20/50 finite, `ema(NaN)→null` contained, `classifySwingTrend` valid, `applySwingScoringPenalties` finite, telegram-templates load crash-free.
- Covers Ingest → MA/EMA → Swing → Screener → Watcher Gate → Telegram formatter.

## F15-09 — Volume NaN containment (PASS-KUNCI)

**Status:** Correct

- `lib/chart-engine/volume-analyzer.js` uses `Number.isFinite` guards (`maVolume`, `relativeVolume`).
- `candle-fetcher` filters `isFinite(close)` before volume math — volume NaN rows do not poison aggregates.

## F16-01 / F16-02 — Build lock (PASS-KUNCI)

**Status:** Correct after registration

- `F16-01` initially FAIL (unregistered file is silently skipped by `--full`). Fixed by inserting `test/audit-fase15-16-pipeline-stress-bugs.test.js` at index 0 of `tools/curated-build-tests.json` (531 entries).
- `run-build-test-suite.js` guards with `unregistered` check — PASS.
- `F16-02` asserts `frame=daily`, `limit` param, `MIN_CANDLES 170` — PASS.

---

**Total bugs fixed in Fase 15-16:** 1 (F15-02) — locale sanitization data-loss path.
**BEWIS invariants locked:** 11 (F15-01/03–09 + F16-01/02) — verified PASS 2×, full suite green.

*— End of findings, 24 Sept 2026 —*
