# Intraday Fast Watcher — shadow only

`FAST_WATCHER_SHADOW_CONFIRM_2_ANTI_CHASE_V1` is a server-side observer for the latest shortlist produced by the existing **Day Trade full screener**. It is not a second screener: it never builds or scans the full IDX universe, never changes scoring/eligibility thresholds, never publishes recommendations, never creates an order, and has no Telegram send path.

## Intended flow

1. The normal Day Trade full screener produces a ranked shortlist.
2. Every three minutes, the live Fast Watcher reads at most 20 unique tickers from that file (hard maximum 50, default concurrency 4).
3. It re-runs the existing `daytrade-screener-engine` only for those tickers using the existing fresh-fetch/stale-cache research adapter.
4. The resulting engine-owned status is appended to a separate shadow observation file.
5. A ticker becomes `READY_CONFIRMED` only after two distinct consecutive observations have an existing engine status of `A_PLUS_SETUP`, `TRADE_CANDIDATE`, or `READY_BREAKOUT`, and both pass anti-chase checks.
6. Only state changes are appended to the event log. Re-running the same snapshot is idempotent.

The watcher does not infer readiness from score. `EARLY_RADAR`, `PRE_SPIKE_WATCH`, `WAIT_PULLBACK`, `MOMENTUM_CONTINUATION`, `RECLAIM_CANDIDATE`, `SPECULATIVE`, and `AVOID` remain non-ready. The watcher forces `DAYTRADE_INTRADAY_SCORE_ENABLED=0` inside its engine call, so it observes the existing deterministic result rather than activating the experimental score adjustment.

## Anti-chase and fail-closed checks

A ready observation is blocked when data is stale, the stop has been touched, the price is outside the stored entry zone, TP1 has already been reached, or the price has advanced more than 6% from the first valid observed price. Missing price, entry zone, TP1, time, or engine-owned status fails closed.

The live collector checks the existing production worker lock before fetching. When the full production worker is active, the Fast Watcher skips instead of competing with it.

## Generated files

- Raw watcher observations: `data/intraday-fast-watcher-observations/YYYY-MM-DD/candidates.jsonl`
- Collection runs: `data/intraday-fast-watcher-observations/YYYY-MM-DD/runs.jsonl`
- State snapshot: `data/intraday-fast-watcher-state/YYYY-MM-DD.json`
- Transition log: `data/intraday-fast-watcher-events/YYYY-MM-DD.jsonl`
- Locks: `data/intraday-fast-watcher-state/YYYY-MM-DD*.lock`

Removing a ticker from the latest full-screener shortlist records `DROPPED_FROM_SHORTLIST` once.

## Live manual dry run

```bash
node tools/run-intraday-fast-watcher.js \
  --live \
  --sample-date "$(TZ=Asia/Jakarta date +%F)" \
  --scheduled-time "$(TZ=Asia/Jakarta date +%H:%M)" \
  --shortlist-file /path/to/latest-daytrade-full-screener.json \
  --max-shortlist 20 \
  --concurrency 4 \
  --dry-run \
  --json
```

## Live shadow run

```bash
node tools/run-intraday-fast-watcher.js \
  --live \
  --sample-date "$(TZ=Asia/Jakarta date +%F)" \
  --scheduled-time "$(TZ=Asia/Jakarta date +%H:%M)" \
  --shortlist-file /path/to/latest-daytrade-full-screener.json \
  --max-shortlist 20 \
  --concurrency 4 \
  --shadow \
  --json
```

## Historical/replay audit

```bash
node tools/run-intraday-fast-watcher.js \
  --sample-date 2026-07-28 \
  --shortlist-file /path/to/latest-daytrade-full-screener.json \
  --observations-file /path/to/candidates.jsonl \
  --through-time 13:25 \
  --dry-run \
  --json
```

Scheduling is deliberately not installed by this change. After the exact VPS shortlist path is verified, the existing runner may invoke live shadow mode every three minutes inside supported engine windows. Telegram/admin notification remains a separate future gate after several complete trading days of shadow evidence.
