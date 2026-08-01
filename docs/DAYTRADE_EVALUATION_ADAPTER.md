# Day Trade evaluation integration inventory (Phase B0.1 correction)

## Execution and response topology

The trusted VPS runner calls the existing Vercel `GET /api/sector-hot?action=daytrade-screener-run` route with `Authorization: Bearer CRON_SECRET`. Vercel calculates 50 tickers per full-mode batch (75 in fast mode). It cannot write the VPS evaluation directory. Successfully calculated candidates exist in `batchResult.results` before the production `score >= 50` persistence filter. Fetch/no-history/analysis failures are held separately in `batchResult.failed`; they have no engine classification or scored candidate and must not be turned into invented evaluation records.

A non-final response is a progress object with run/mode/date, zero-based batch index, batch/universe/scanned/failed/passed counts, next batch, universe/lock diagnostics, save error, and at most ten failed tickers. A final response is the existing publication and delivery diagnostic object. Neither response currently contains calculated candidates.

At calculation time the engine has current/so-far OHLCV, raw volume ratio, raw components, uncapped pre-cap score, capped/current display score, exact classification, classification gate inputs, and final normalized levels. Provider/source timestamp, seasonal RVOL, source lag, and pre-normalization levels after refinements are not available. The pure adapter preserves null plus provenance for these fields and never consults a later final daily candle.

## Safety conclusion: transport intentionally not wired

The only trusted request action that calculates a real Day Trade batch is mutating: it updates scan metadata, clears/inserts latest rows, finalizes/ranks publication state, and may enter delivery flows. It has no genuine read-only or observational batch mode. Flags that merely defer Telegram do not make it non-mutating. Therefore this correction removes the response wiring and removes the network one-shot harness. It does not expose a secret through CLI arguments, add an endpoint, or claim a safe canary exists. A future separately reviewed change must first provide a genuinely non-mutating trusted calculation mode before any VPS canary can request records.

The retained pure adapter is inactive and unreachable from the API. It is testable with synthetic calculation-point candidates only. Its canonical configuration hash is computed from the engine-provided configuration, including run/fast mode, batch size, real thresholds, score cap, optional intraday setting, and SHA-256 fingerprints of the actual scoring, classification, level, ATR, and optional intraday-adjustment implementations. Its gate trace uses exact classification inputs captured by the engine rather than reconstructing them from the shortlist.

## Measured synthetic bounds

Using the real schema and synthetic repeated records in `test/daytrade-evaluation-adapter.test.js`:

| Records | Final serialized bytes | gzip bytes |
| ---: | ---: | ---: |
| 50 | 145,804 | 2,203 |
| 75 | 218,504 | 2,710 |

These are measured fixture sizes, not production estimates. The envelope limit is 75 records and 524,288 bytes. The byte check is performed after the final `serialized_bytes` value has stabilized, against exactly the serialized string returned by the builder. Production compression must be measured only after a safe non-mutating transport is approved.

No logging flag is enabled. No deployment, VPS sync, cron, database, publication, ranking, Telegram, Fast Watcher, Top 5, authentication, subscription, or `data/intraday-*` change is included.
