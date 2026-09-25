# Audit Diagnosa Screener Channel — 2026-09-25

Scope: why the automatic screener signals in the Telegram channel were silent
(Daytrade / FastWatcher / Swing), and what was changed to restore them.

## Evidence collected

- **VPS crontab** (`crontab -l` on `ubuntu@168.110.221.197`) and the versioned
  [`deploy/vps/final-schedule.cron`](../deploy/vps/final-schedule.cron) listed:
  backfill candles, lifecycle evaluator, daily broker update, afternoon recap,
  fetch daily candles, landing refresh. **No entry produced or dispatched the
  Daytrade / FastWatcher / Swing screener.**
- **PM2** ran four apps: `auto-cuan-ai-eval-supervisor`, `auto-cuan-local-app`
  (dev server, `tools/local-dev-server.js`), `auto-cuan-vps-api`,
  `autocuan-bot`. None of these is a screener producer on a schedule.
- **Bot log** (`pm2 logs autocuan-bot`) showed repeated
  `{"level":"error","msg":"poll_failed"}` pairs, i.e. transient Telegram
  long-poll failures (the runner self-recovers; not the channel cause).
- `docs/SCREENER_SCHEDULE_AUDIT.md` already documented that only Top 5 had a
  cron (`0 1 * * 1-5` UTC in `vercel.json`) and that Swing/daytrade were
  "manually/orchestrator-managed" — i.e. producer-less.

## Root causes

1. **No scheduled producer (primary).** Candidates for Daytrade/FastWatcher/
   Swing were never generated on a schedule, so there was nothing to send. The
   channel is silent regardless of sender health.
2. **Market guard silent skip (secondary).** [`sendTelegramMessage()`](../lib/telegram-notifier.js)
   returns `{ sent:false, skipped:true, reason:'market_closed' }` whenever the
   market is closed (after 15:45 WIB, weekend, or an exchange holiday) unless
   `skip_market_guard: true` is passed. An after-hours producer that omits the
   flag loses its message with no visible error.
3. **Calendar dependency (tertiary).** `isMarketOpen`/`getMarketSession`
   consult the exchange holiday seed/DB calendar. A wrong-day holiday entry or
   a naive (host-timezone) timestamp would classify a real trading day as
   `CLOSED`. The guard already fails closed and reads naive strings as WIB wall
   clock; the runner reports the guard's verdict explicitly so this is visible.

## Repairs

- Added [`tools/run-screener.js`](../tools/run-screener.js): a dry-run-by-default
  diagnostic + force-trigger CLI. It reports snapshot presence, candidate count,
  the market/calendar verdict, and the exact skip reasons, and only sends with
  `--send` (using `skip_market_guard: true` for the after-session recap card).
- Added [`deploy/vps/run-screeners.sh`](../deploy/vps/run-screeners.sh) (producer
  wrapper around `tools/run-all-screeners-vps.js`) and
  [`deploy/vps/run-screener-dispatch.sh`](../deploy/vps/run-screener-dispatch.sh)
  (diagnostics + dispatch wrapper).
- Added crontab entries (19:10 WIB produce, 19:45 WIB dispatch, weekdays) to the
  versioned schedule.

## Verification

Run on the VPS after deploy:

```sh
node tools/run-screener.js --mode=daytrade --dry-run
node tools/run-screener.js --mode=swing --dry-run
node tools/run-screener.js --mode=fastwatcher --dry-run
```

A healthy run prints `Diagnosa: sehat` plus the candidate card. A run that
reports `snapshot_missing` or `no_candidates` points back at the producer
(step 1), while `market_closed` points at the guard (step 2).
