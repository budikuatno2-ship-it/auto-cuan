# Day Trade VPS-local evaluation canary audit (Issue #335)

## Existing-path findings

The existing paths are **not** safe canary entry points:

- `tools/run-all-screeners-vps.js` always constructs an authenticated Vercel
  client, requires `CRON_SECRET`, and makes status/API calls even in its dry-run
  mode. With `--execute`, it reaches database-backed run, publication, Top 5 and
  optional Telegram actions.
- `tools/daytrade-vps-worker-observe.js` does not call Supabase, Telegram or the
  production API, but “observe” is not non-mutating. It creates/removes a lock,
  refreshes `data/daytrade-ohlcv-cache`, appends `logs/daytrade-vps-worker/runs.jsonl`,
  and updates the process-global scan-comparison baseline. It may also read
  intraday reports. Consequently it cannot meet the caller-root-only boundary.
- `buildDayTradeUniverse` and `buildFastDayTradeUniverse` in the engine require a
  Supabase client and read database tables. The local canary must instead require
  an explicit bounded ticker list. It neither calls these helpers nor imports a
  Supabase client.
- `runDayTradeBatch` itself is a calculation path: with a caller-provided candle
  function it performs no database write, publication, ranking, Telegram,
  monitoring registration, or filesystem write. Its only evaluation behavior is
  the opt-in `captureEvaluationInitial === true` snapshot passed to
  `scoreDayTrade`; capture-disabled behavior remains unchanged by existing tests.
- The reusable cache provider is unsuitable because stale/missing reads trigger
  writes under its cache directory. Its exported direct Yahoo OHLCV fetcher is
  suitable: it supplies the same normalized 90-day daily input without a cache
  write. This provider request is not a Vercel or production API request.
- The evaluation adapter maps only the captured initial classification, rejects a
  missing/invalid code SHA during mapping, marks publication false/rank null, and
  validates the record contract. The existing logger is the sole allowed writer:
  it creates gzip members and a checksum manifest below the explicit root. Its
  retention dependency only audits; it never deletes.

## Isolated manual path

`tools/run-daytrade-evaluation-canary.js` is deliberately standalone and is not
imported by production/VPS orchestration. It requires `--execute`, an absolute
caller-supplied external `--evaluation-root`, and one to five explicit
`TICKER:BOARD` pairs. Boards are never inferred: this phase accepts the engine's
eligible `UTAMA` and `PENGEMBANGAN` boards. The code
SHA is read from the local Git checkout, not accepted as a CLI argument. It calls
the batch engine locally with `captureEvaluationInitial: true`, validates every
mapped record before logger construction, and writes only through the existing
gzip/manifest logger. It has no Supabase, API-action, Vercel, Telegram, monitor,
publication, ranking, cron, runtime-file, cache-write, automatic-deletion, or
`data/intraday-*` path.

Before the provider is called, the harness rejects filesystem root, the repository
and all repository descendants (including symlink resolutions), and requires both
the tracked worktree and index to match HEAD. Untracked runtime files do not block
execution. A provider failure or any result-count mismatch aborts before logger
creation, so partial and empty canaries cannot finalize successfully.

Example syntax (documentation only; no live canary was run):

```sh
node tools/run-daytrade-evaluation-canary.js --execute \
  --evaluation-root /home/ubuntu/auto-cuan-evaluation \
  --tickers BBCA:UTAMA,BBRI:UTAMA
```

Standard output is a single JSON object containing only record count, compressed
bytes, checksum, and omitted-field provenance. It contains no ticker results,
paths, credentials, account identifiers, email addresses, or chat identifiers.
