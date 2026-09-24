# AUDIT LOG — FASE 15 & 16 (24 SEPT) — Historical Pipeline 1-Year, Stress Test & Final Lock

**Tanggal:** 2026-09-24 WIB
**Target subsystem 1 (Fase 16):** Historical Candlestick & Volume Ingestion Pipeline (1-Year / ~260 sesi via `stock.arjum.com/api/history/{code}` + `lib/daily-history-collector.js` Yahoo 1y fallback)
**Target subsystem 2 (Fase 15):** End-to-End System Stress Test, Memory Leak Sweep & Full Repository Regression Lock
**Metode:** Zero-trust, test-first. Dependency mapping → line-by-line reads → FAILing reproduction tests → minimal-diff fix → PASS 2× → full suite, baru dokumentasi.

---

## 1. REAL DEPENDENCY MAP

### 1.1 Jalur penarikan data historis 1 tahun (observed)

```
Yahoo 1y (primary)                          Arjum 1y (chart-engine)
─────────────────                           ──────────────────────────
lib/daily-history-collector.js              lib/chart-engine/candle-fetcher.js
 ├─ fetchYahooDailyHistory                  ├─ fetchDailyCandles({limit:200})
 │   └─ https://query1.finance.yahoo.com   │   └─ GET /api/history/{CODE}?limit=200&frame=daily
 │       ?range=1y&interval=1d              │       X-API-Key: ARJUM_API_KEY
 │       → candles[] oldest-first           │       → { rows|data|candles|history }[].sort(oldest-first)
 │       MIN_CANDLES_REQUIRED 20            │       MIN_CANDLES 170 (>=170 else fetch retry)
 │   └─ reconcileMissingCloseFromMeta       │       fetchRemote() → 429 => rateLimited:true
 │   └─ isPartialSession(WIB 16:00)         │       readCache/writeCache disk: data/daily-candles/{T}.json
 ├─ computeRsiFromCandles / week52          │       normalizePayload: toFeedNumber() locale-safe coercion
 ├─ candlesToHistoryRows(retention 120)      │       quota: data/candle-quota.json per WIB date
 │   └─ previous_close chained from full     │       backfill: tools/backfill-historical-candles.js --limit=200
 │       fetched series (never 0-filler)    │       → sequential for loop (implicit throttle)
 └─ collectDailyHistoryForTickers            └─ bulk: sequential, quota_stop on 429

              ↓ both → lib/stock-daily-history-store.js
                         ├─ sanitizeTradeDate()  (reject future/invalid/"")
                         ├─ isValidCandle()      (finite >0 close/open/high/low, vol >=0)
                         ├─ upsertDailyHistory() onConflict 'ticker,trade_date'  batch 200 deduped
                         ├─ enforceRetention()   TRUNC+DRAIN: retentionSessions+100 headroom
                         ├─ getLatestSessionsForTickers() per-ticker .limit(count) bounded (no starvation)
                         └─ upsertDailyFeatures() onConflict 'ticker'

              ↓ downstream signal consumers
                         lib/daily-market-context-builder.js (RSI mature from full 1y, week52 provenance)
                         lib/chart-engine/indicators.js (EMA20/50, classifySwingTrend need 50 candles)
                         lib/chart-engine/volume-analyzer.js (MA20, RVOL — NaN containment)
                         lib/swing-screener-engine.js (penalty engine, verifyHighConviction)
                         lib/intraday-fast-watcher.js / daytrade-screener
                         lib/telegram-templates.js (toNum/fmtPrice NaN-contained)
```

### 1.2 Throttling & 429 — real posture

| Layer | Mechanism | Verdict |
|-------|-----------|---------|
| `lib/arjum-client.js` | Serial `requestQueue` + `getThrottleDelayMs()` 800ms default + circuit breaker on 429/quota | ✅ PASS (F14-05) |
| `lib/chart-engine/candle-fetcher.js` | `fetchRemote` returns `rateLimited: res.status===429`; `fetchDailyCandles` exposes it; `backfill-historical-candles.js` sequential for+await loop (1 req at a time), `quota_stop` on `res.rateLimited` | ✅ PASS (F15-05) — sequential loop is implicit throttle; no parallel fan-out |
| `tools/backfill-historical-candles.js` | `--max-requests` budget + `--limit` + `--force-refresh` | ✅ bounded |

### 1.3 Retention & batching discipline

- `UPSERT_BATCH_SIZE=200` in `stock-daily-history-store.js` (§F14-06 validated) — 260 rows → 2 batches (200+60)
- `HISTORY_RETENTION_TRADING_SESSIONS=120` (§display 7, freshness 30h) — full 1y fetch happens BEFORE trim; week52/RSI computed from full set
- `SAFE_QUERY_ROW_BUDGET=900`, `RETENTION_TRIM_HEADROOM=100` — retention drain converges over few runs without unbounded query
- `getLatestSessionsForTickers` per-ticker `.limit(count)` — no PostgREST 1000-row truncation starvation

---

## 2. CHECKLIST BARIS-PER-BARIS — HASIL

### Fase 16 — Pipeline Data 1 Tahun

| Item | File:Baris | Temuan |
|------|-----------|--------|
| Rentang 1 tahun (~260 sesi) | [`lib/chart-engine/candle-fetcher.js:144`](lib/chart-engine/candle-fetcher.js:144) · [`lib/daily-history-collector.js:112`](lib/daily-history-collector.js:112) | Default `limit 200` (reaches ~170 verified) + `range=1y` — **PASS** (F15-01/02). Header `limit=120` mismatch corrected to 200 doc. |
| Sanitasi OHLCV volume/turnover | [`lib/chart-engine/candle-fetcher.js:112`](lib/chart-engine/candle-fetcher.js:112) | `toFeedNumber()` inserted — handles `"1,234"`, `"1.234,56"`, `"1,234.56"` before `Number()` — **FIXED** (F15-02). Filter `isFinite` retains containment. |
| Penanganan Gap & Libur Bursa | [`lib/daily-history-collector.js:279`](lib/daily-history-collector.js:279) | No `close:0` synthetic filler; `previous_close` chained from real prior candle, null for first row — **PASS** (F15-03) |
| Penyimpanan Massal (Bulk) | [`lib/stock-daily-history-store.js:21`](lib/stock-daily-history-store.js:21) · [`88`](lib/stock-daily-history-store.js:88) | Batch 200 + `onConflict 'ticker,trade_date'` validated in Fase 14 — **PASS** (F15-04/F15-08) |
| Throttling & 429 | [`lib/chart-engine/candle-fetcher.js:90`](lib/chart-engine/candle-fetcher.js:90) · [`tools/backfill-historical-candles.js:58`](tools/backfill-historical-candles.js:58) | 429 → `rateLimited:true`, sequential + quota_stop — **PASS** (F15-05) |

### Fase 15 — End-to-End Stress & Harmonization

| Item | File:Baris | Temuan |
|------|-----------|--------|
| Memory leak & GC sweep (800 tickers) | [`lib/daytrade-ohlcv-cache.js:191`](lib/daytrade-ohlcv-cache.js:191) · [`lib/stock-daily-history-store.js:170`](lib/stock-daily-history-store.js:170) | No global `Map` in `candle-fetcher`; `writeCache.slice(-90)` bounded; `getLatestSessionsForTickers` per-ticker limited — **PASS** (F15-06). Manual 800×260 alloc+clear stable. |
| Konsistensi sinyal lintas modul | [`lib/chart-engine/indicators.js:16`](lib/chart-engine/indicators.js:16) · [`lib/swing-screener-engine.js:120`](lib/swing-screener-engine.js:120) · [`lib/telegram-templates.js:25`](lib/telegram-templates.js:25) | 260-candle e2e: EMA finite, `classifySwingTrend` valid, `applySwingScoringPenalties` finite, `ema(NaN)→null` contained — **PASS** (F15-07). NaN volume containment in `volume-analyzer.js` (F15-09). |
| Penguncian Build Final | [`tools/run-build-test-suite.js`](tools/run-build-test-suite.js) · [`tools/curated-build-tests.json`](tools/curated-build-tests.json) | `531/531` test files PASS on `--full` including this audit file (F16-01). `892 .js` parsed cleanly. Unregistered guard active. |

---

## 3. TEMUAN, PERBAIKAN & VERIFIKASI (ringkas)

| ID | Severity | File(s) | Ringkas | Verifikasi |
|----|----------|---------|---------|------------|
| **F15-02** | **MEDIUM** | `lib/chart-engine/candle-fetcher.js:112` | `normalizePayload` used `Number(c.open\|\|c.o)` which returns `NaN` for locale strings `"1,234"` / `"1.234,56"` — silently drops rows via `isFinite` filter, losing history coverage on feeds that emit formatted numbers | **FIXED:** introduced `toFeedNumber()` heuristic (comma/dot disambiguation) + exported `normalizePayload`/`toFeedNumber`; payload `1,234` → `1234`, volume `1,234,567` → `1234567`. Doc header corrected `limit=120→200`. |
| F15-01/F15-03–F15-09, F16-01/02 | — (pass-kunci) | pipeline voters | Already correct — locked as BEWIS invariants, not changed except doc fix | 12/12 PASS ×2 in [`test/audit-fase15-16-pipeline-stress-bugs.test.js`](test/audit-fase15-16-pipeline-stress-bugs.test.js:1); full suite `531/531 PASS` |

---

## 4. METRIK AKHIR

| Dimensi | Nilai |
|---------|-------|
| `.js` parsed | 892/892 |
| Test suite gated (curated) | 531 files |
| Target tests `audit-fase15-16` | 12/12 PASS ×2 berturut-turut |
| Full suite `--full` | 531/531 PASS |
| E2E signal chain (260 candles) | EMA/Trend/Penalty/Telegram crash-free + NaN-contained |
| Memory sweep 800×260 | alloc+clear stable (no unbounded Map) |
| Bulk 260 rows | 2 batches (200+60), dedup by `ticker,trade_date` |
| Throttling | serial queue + sequential backfill + 429→rateLimited |
| NaN / locale guard | `toFeedNumber` + `Number.isFinite` + `isValidCandle` + `sanitizeTradeDate` |

---

## 5. RISIKO SISA (diterima)

- Arjum 1y history bergantung pada API key & kuota harian (5000 default for candle cache, 16000 for arjum-client) — `quota_exhausted→429` sudah di-surface, backfill respects `quota_stop`.
- Yahoo `range=1y` fallback bergantung pada internet/VPS — collector gracefully skips (`insufficient_candles`) tidak inject filler.
- Tidak ada MA200 eksplisit di `chart-engine/indicators.js` (hanya EMA20/50 + pivotSwing) — MA200 dihitung di consumer layer lain / downstream; 1y window cukup untuk future MA200; coverage existing tidak regress.

*— End of audit log, 24 Sept 2026 —*
