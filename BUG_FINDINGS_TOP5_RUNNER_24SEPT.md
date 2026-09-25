# Bug Findings — Top 5 Runner (Oracle VPS) — 2026-09-24

Investigation of the Top 5 runner failure on `ubuntu@168.110.221.197` (`/home/ubuntu/auto-cuan`).

## 1. Exact errors observed

### A. `tools/run-after-market-top5-lock.js` (default invocation)

```
$ node tools/run-after-market-top5-lock.js --dry-run
Unknown option: --dry-run

$ node tools/run-after-market-top5-lock.js          # default
HTTP 402 from https://auto-cuan.vercel.app/api/sector-hot?action=telegram-daily-picks&lock_only=1&dry_run=1
EXIT:1
```

Vercel body: `{"error":{"code":"402","message":"Payment required"}}`

### B. `tools/run-after-market-top5-lock.js --base-url http://127.0.0.1:3000`

```
Dry-run: success=false reason=none would_lock=false would_insert_count=0
Dry-run response was not read-only/safe; refusing to continue.
EXIT:2
```

Daemon body: `{"success":false,"error":"Database belum dikonfigurasi."}`

### C. The real Top 5 blocker — `telegram-daily-picks` readiness

```
reason=screeners_not_ready   ready=false   snapshot=not_ready
day_trade: ready=false, latest_date=2026-09-23, status="stalled",
           not_ready_reason="running_lock_timeout", running_lock_age_minutes=1801
swing_konglo:    ready=false, latest_date=2026-09-22
swing_non_konglo: ready=false, latest_date=2026-09-22
```

Top 5 never reached candidate selection; it aborted at the readiness gate.

## 2. Root cause

`lib/daytrade-screener-engine.js` `fetchDayTradeCandles()` (was lines 278–317) used a
bare `fetch()` to Yahoo **with no timeout and no local-cache fallback**:

```js
var response = await fetch(url, { headers: {...} });   // no AbortController
```

`api/sector-hot.js` `fetchNkQuoteData()` (was lines 11110–11143) had a 5s timeout but
returned `null` on timeout — no fallback — silently emptying the Non-Konglo screener.

Consequences on the 1-vCPU VPS:

1. A single unresponsive Yahoo socket hung the whole Day Trade batch. The scan stopped at
   `daytrade_screener_meta.message = "Batch 3/16 done. Scanned 150/772"` with
   `status='scanning'` and `calculated_at='2026-09-23T07:58:44.361+00:00'`.
2. Meta is only persisted between batches, so the stalled run could never advance. That
   lock aged past `DAYTRADE_FULL_SCAN_STALE_LOCK_MS` (30 min), making
   `getDayTradeRunningLockDiagnostics()` report `stalled` / `running_lock_timeout`
   (api/sector-hot.js:12258-12263) and `getScreenerReadiness()` force
   `day_trade.ready = false` (api/sector-hot.js:3843-3851).
3. Top 5 returned `screeners_not_ready` on every run — permanently, until the lock was cleared.
4. The backfilled `data/daily-candles/` cache (957 files, 200 bars each, current through
   2026-09-24) was never consulted by any screener candle path, so it could not absorb the outage.

Secondary defects:

- `tools/run-after-market-top5-lock.js:4` still defaulted to `https://auto-cuan.vercel.app`,
  which now answers HTTP 402, and it rejected `--dry-run` (`Unknown option`).
- `tools/local-dev-server.js:36-38` never loaded `.env.intraday-runtime`, so the VPS daemon
  on port 3000 (the Batch 8 target for heavy scans) had no Supabase credentials and answered
  `Database belum dikonfigurasi.`
- The installed crontab no longer schedules `run-all-screeners-once.sh` / `top5-night.sh`
  (`deploy/vps/final-schedule.cron` contains no screener/Top 5 entries), so the stalled lock
  had no scheduled path back to a healthy state.

## 3. Files and lines fixed

| File | Change |
|------|--------|
| `lib/chart-engine/candle-fetcher.js` | New bounded shared candle source: `fetchYahooScreenerCandles()` (AbortController + `SCREENER_YAHOO_TIMEOUT_MS`, default 8s), `readScreenerCandles()` (reads `data/daily-candles`), `fetchScreenerCandles()` (Yahoo → cache), and a consecutive-failure circuit breaker (`SCREENER_REMOTE_FAILURE_THRESHOLD`, default 3). `cacheDir()` is now resolved lazily so tests and `chdir()` behave. |
| `lib/daytrade-screener-engine.js:278-290` | `fetchDayTradeCandles()` delegates to `candleFetcher.fetchScreenerCandles()` instead of the unbounded bare fetch. |
| `api/sector-hot.js:2558-2598` | `fetchScreenerCandles()` (Konglo) now tries Yahoo through `fetchWithTimeout(url, …, YAHOO_FETCH_TIMEOUT_MS)` and falls back to the cached series; the bounded wrapper and its timeout bound are preserved. |
| `api/sector-hot.js:11109-11135` | `fetchNkQuoteData()` uses the shared bounded source with the same 120-day lookback (≈85 bars, keeps MA50 computable) and degrades to cache instead of `null`. |
| `tools/run-after-market-top5-lock.js` | Default base URL is now `http://127.0.0.1:3000`; loads `.env.local`/`.env.intraday-runtime`/`.env`; accepts `--dry-run`; refuses `--execute-lock` against a `*.vercel.app` host. |
| `tools/local-dev-server.js:36-43` | Loads `.env.intraday-runtime` first so the VPS daemon has Supabase credentials. |

## 4. Regression coverage

- `test/daytrade-universe-recovery.test.js` — cache fallback when Yahoo fails, abort at the
  deadline instead of hanging, circuit breaker skipping the remote after repeated failures,
  healthy Yahoo still winning over cache, plus the existing stale-lock diagnosis tests.
- `test/canonical-domain-redirect.test.js:171-192` — updated to pin the corrected contract:
  both orchestration runners are VPS-local and neither may default to Vercel.

## 5. Verification

Local: `node --test` on the touched suites → **63/63 pass**; full curated gate
(`node tools/run-build-test-suite.js --full`) → **exit 0, fail 0** in every batch.

VPS after deploying the patched files and restarting the daemon:

```
A) tools/run-after-market-top5-lock.js --dry-run --json
   dry_run_success=true, reason=top5_gate_blocked, base_url=http://127.0.0.1:3000

B) --base-url https://auto-cuan.vercel.app --execute-lock --yes
   refused (exit 2) before any mutation

C) tools/run-top5-progress-monitor.js --dry-run
   checked=658 events=83 dry_run=true  (exit 0)

D) telegram-daily-picks dry_run=1
   reason=dry_run  ready=True  snapshot=same_day
   day_trade=published 2026-09-24 | konglo=2026-09-24 | non_konglo=2026-09-24
   pool=68  before_gate=5  after_gate=0
```

Recovery proof: the stalled Day Trade scan resumed from its durable `scanned_count=150`
(`daytrade.sh` → `handleDayTradeScreenerRun` stale-lock recovery at api/sector-hot.js:12457-12464)
and completed 772/772 with `status=published`, 7 published. Konglo refreshed 177/177 saved,
0 failed. Non-Konglo finalized `PUBLISHED` with 23 published.

## 6. Remaining observation (not a runner fault)

Top 5 currently selects **0 tickers**: `pool=68`, only 5 reach the strict-signal stage, and all
5 are rejected (`final_quality_gate: 42`, `breakout_confirmation: 15`, `status_verdict_reject: 3`).
That is the intended strict-safety behaviour of `candidatePassesPublicTelegramSafetyGate` /
`candidatePassesMinUpside` on today's candidates, not a failure of the runner. It is a separate
tuning question (safety-gate strictness vs. hit rate) and was left untouched.
