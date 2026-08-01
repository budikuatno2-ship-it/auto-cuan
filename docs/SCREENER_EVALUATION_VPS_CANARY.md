# VPS-first screener evaluation canary (Phase B0)

This phase adds an **inactive, local-file foundation** for Issue #330. It does not
activate a canary, change a cron/runtime setting, add an endpoint or database
migration, or alter any screener or delivery decision. Day Trade is the only
accepted record strategy. Fast Watcher is not wired.

## Day Trade integration inventory and point-in-time policy

The existing producer is `handleDayTradeScreenerRun`/`finalizeDtScreener` in
`api/sector-hot.js`; calculation remains in `lib/daytrade-screener-engine.js` and
the VPS orchestration path is `tools/run-all-screeners-vps.js`. The Phase B0.1 inventory confirms the existing run action is mutating and has no safe
observational mode. No response transport or network canary is wired; a future change
must first add and review a genuinely non-mutating trusted calculation path.

Records accept scan identity/time, run mode and scheduler slot/source, code SHA,
canonical configuration hash, candidate revision, source/as-of/lag, so-far OHLCV,
raw and seasonal RVOL, raw components, uncapped and display score, result and
rejection codes, gate trace, levels and publication/rank. If the current engine did
not genuinely expose a value at scan time, it must be `null` with provenance such
as `unavailable_from_current_engine`; a later final daily candle must never be used
to reconstruct it.

Synthetic example (abridged):

```json
{"schema_version":1,"strategy":"DAY_TRADE","run_id":"synthetic-run","run_mode":"MORNING_SCOUT","batch_index":0,"scheduled_slot":null,"scheduler_source":null,"code_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ticker":"TEST","candidate_revision":1,"observed_at":"2026-07-31T03:00:00.000Z","feature_as_of_ts":null,"feature_as_of_provenance":"unavailable_from_current_engine","data_source":"synthetic_fixture","data_lag_ms":null,"ohlcv_sofar":{"open":null,"high":null,"low":null,"close":null,"volume":null,"provenance":"unavailable_from_current_engine"},"rvol_raw":1.2,"rvol_seasonal":null,"rvol_seasonal_provenance":"unavailable_no_validated_curve","score_components_raw":{"momentum":10},"score_components_provenance":"synthetic_all_available","score_raw":88,"score_display":88,"status":"EARLY_RADAR","passed":true,"rejection_codes":[],"gate_trace":{"schema_version":1,"rule_set_version":"daytrade-v1","gates":{}},"levels":{"raw":null,"normalized":null,"provenance":"unavailable_from_current_engine"},"publication":{"published":false,"rank":null}}
```

## Write and integrity contract

`EVALUATION_LOGGING_ENABLED` must equal `true`; absent/false means no directory or
client is created. The optional `EVALUATION_LOG_ROOT` defaults to
`/home/ubuntu/auto-cuan-evaluation`, but tests/builds never assume it exists. Each
invocation owns a random, mode-0600 `.open.jsonl.gz` file. Each append is a complete
gzip member containing one bounded JSON line; concatenated gzip members remain a
stream, while per-run ownership avoids unsafe cross-process appends. Finalization
atomically renames the file closed and atomically writes a manifest containing its
relative path, bytes, record count, first/last timestamp and SHA-256 checksum.
All records are validated before file creation. An I/O or finalization failure
atomically moves its file from `raw` to `quarantine` with a bounded invalid-status
sidecar, so a protected `.open` file is not leaked. Validation rejects unknown or
missing contract fields, non-JSON values, oversized records, unsupported gate
versions/operators, and secret/account patterns in both keys and string values. All logger
errors are swallowed by `observeEvaluation` after optional local error reporting,
and the exact production value is returned.

At approximately 27.2 eligible Day Trade invocations per trading day, the upper
invocation rate is about 6,800/year (250 sessions). Actual completed writes may be
lower because existing locks and already-done behavior can suppress work. Storage
depends on evaluated rows and compression and must be measured during a separately
approved canary; at 800 records/invocation this ceiling is about 21,760 records/day
or 5.44 million/year before retention.

## Retention and disk audit

Run `node tools/audit-screener-evaluation-retention.js --root <path>`. It is always
dry-run: it lists, but never removes, closed raw files older than 60 days that have
a correctly located finalization manifest whose size and SHA-256 match the closed
file, oldest first. Absolute, traversal, and out-of-root paths are invalid.
Current-market-day protection is derived explicitly in `Asia/Jakarta`, and `.open` files are
always protected. Manifests, aggregates, outcomes, published summaries and config
provenance are never candidates. Closed technical files older than 14 days are
reported separately; current-day and open technical files remain protected. The report flags that writers should stop when
root usage exceeds 20 GiB or free space falls below 20 GiB. Debug retention is
reported as 14 days. The tool itself never deletes anything. No cleanup cron or
active runtime configuration is included.
