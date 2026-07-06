# Day Trade VPS Observe Worker

`tools/daytrade-vps-worker-observe.js` is a safe first VPS worker for Day Trade processing. It fetches Yahoo daily OHLCV directly, keeps a local 90D per-ticker disk cache, runs the existing deterministic Day Trade engine, and writes local observe logs.

## Observe-only guarantee

This worker is intentionally observe-only. It does **not**:

- write Supabase;
- send Telegram;
- call the public Telegram notifier;
- mutate production tables;
- replace or disable the existing Vercel cron/API flow.

The script only imports the Day Trade screener engine and uses an in-memory candle provider. It does not import Supabase clients or Telegram modules.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DAYTRADE_CACHE_DIR` | `./data/daytrade-ohlcv-cache` | Local JSON cache directory. |
| `DAYTRADE_LOG_DIR` | `./logs/daytrade-vps-worker` | JSONL run log directory. |
| `DAYTRADE_LOCK_FILE` | `./tmp/daytrade-vps-worker-observe.lock` | Single-instance lock file. |
| `DAYTRADE_WORKER_CONCURRENCY` | `4` | Yahoo fetch concurrency, capped at 5. |
| `DAYTRADE_YAHOO_TIMEOUT_MS` | `12000` | Per-request timeout. |
| `DAYTRADE_CACHE_MAX_AGE_MS` | `43200000` | Cache freshness window before full revalidation. |
| `DAYTRADE_CACHE_TTL_MS` | `900000` | Short TTL during market hours (15 min). Cache module uses this for repeated scan freshness. |
| `DAYTRADE_LOOP_INTERVAL_MS` | `900000` | VPS loop default interval (15 min). Override to `720000` for 12-min live schedule. |

Do not set `DAYTRADE_WORKER_ALLOW_MUTATION=true`; the worker rejects that setting.

## Manual VPS runs

```bash
node tools/daytrade-vps-worker-observe.js --mode observe
node tools/daytrade-vps-worker-observe.js --tickers BBCA,BBRI,TLKM --mode observe
node tools/daytrade-vps-worker-observe.js --mode observe --limit 20
```

## Suggested observe-only cron

Default code interval is 15 minutes. To run at 12-minute intervals (recommended for Day Trade), override via environment or cron:

### 12-minute cron (recommended for live Day Trade):

```cron
*/12 * * * * cd /home/ubuntu/auto-cuan-runner && DAYTRADE_LOOP_INTERVAL_MS=720000 /usr/bin/node tools/daytrade-vps-worker-observe.js --mode observe --limit 20 >> logs/daytrade-vps-worker/cron.log 2>&1
```

### 15-minute cron (default/fallback):

```cron
*/15 * * * * cd /path/to/auto-cuan && /usr/bin/node tools/daytrade-vps-worker-observe.js --mode observe --limit 20 >> logs/daytrade-vps-worker/cron.log 2>&1
```

### Loop mode with 12-minute interval (alternative to cron):

```bash
DAYTRADE_LOOP_INTERVAL_MS=720000 node tools/daytrade-vps-worker-observe.js --mode observe --loop --limit 20
```

This cron is for comparison/observation only and does not replace Vercel yet.

### Exact VPS crontab change for 12-minute live schedule:

Replace the existing 15-minute cron line:
```
# OLD (15-min):
*/15 9-15 * * 1-5 cd /home/ubuntu/auto-cuan-runner && /usr/bin/node tools/daytrade-vps-worker-observe.js --mode observe --limit 20 >> logs/daytrade-vps-worker/cron.log 2>&1

# NEW (12-min):
*/12 9-15 * * 1-5 cd /home/ubuntu/auto-cuan-runner && DAYTRADE_LOOP_INTERVAL_MS=720000 /usr/bin/node tools/daytrade-vps-worker-observe.js --mode observe --limit 20 >> logs/daytrade-vps-worker/cron.log 2>&1
```

**Important:** Only change Day Trade cron to 12 minutes. Do NOT change Swing Konglo or Swing Non-Konglo schedules (they stay at 2-3x/day).

Break guards are built-in to the worker code (detectMarketBreak):
- Mon-Thu 12:00-13:00 WIB: only one heartbeat scan, then sleep
- Friday 11:30-14:00 WIB: only one heartbeat scan, then sleep

## Cache format and location

Each ticker is cached as one JSON file, for example `data/daytrade-ohlcv-cache/BBCA.json`:

```json
{
  "version": 1,
  "ticker": "BBCA",
  "source": "yahoo",
  "range": "90d",
  "interval": "1d",
  "updated_at": "2026-07-04T00:00:00.000Z",
  "candles": [{ "time": 1783123200, "date": "2026-07-04", "open": 0, "high": 0, "low": 0, "close": 0, "volume": 0 }]
}
```

Cold/stale cache fetches 90D. Normal observe runs fetch a short recent Yahoo window and merge only the latest daily candle into the cached 90D array.

## Logs

Run summaries append to `logs/daytrade-vps-worker/runs.jsonl`. Each JSONL record includes timestamps, duration, mode, scanned count, fetch/cache counts, stale/revalidation count, timeout/429 count, candidate count, top candidate summary, rejected reason summary, and worker version.

## Stop / rollback

Remove the VPS cron entry or disable the process supervisor entry. Existing Vercel Day Trade cron/API remains unchanged and remains the active producer.

## Disk usage estimate

A 90D daily OHLCV JSON cache file is usually a few KB per ticker. A 200 ticker cache should be roughly under 2 MB, plus JSONL logs depending on retention.
