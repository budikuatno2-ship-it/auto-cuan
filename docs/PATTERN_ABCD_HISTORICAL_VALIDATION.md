# ABCD v1 historical validation

This offline tool measures detector frequency and subsequent daily-bar outcomes. It does **not** prove pattern geometry, profitability, executable fills, or future performance. Geometry remains exclusively owned by `lib/pattern-abcd.js`.

## Data audit and schema

The repository has no committed multi-year daily OHLCV dataset. Its existing daily provider/cache is Yahoo Finance via `lib/daytrade-ohlcv-cache.js`; generated cache data is gitignored. `data/daytrade-observe-tickers.txt` is the existing repository-owned observation universe. No downloader is added here: acquire data explicitly, outside production, and retain its provenance.

Input may be one JSON file whose root is a ticker map (or `{ "tickers": { ... } }`):

```json
{"BBCA":[{"time":"2022-01-03","open":7300,"high":7400,"low":7250,"close":7375,"volume":1000}]}
```

Alternatively, pass a directory of sorted `*.json` files. Each file is either a candle array, or `{ "ticker":"BBCA", "candles":[...] }`; otherwise its filename supplies the ticker. Tickers normalize to uppercase without `.JK`. Dates must be real `YYYY-MM-DD` values in strictly increasing order with no duplicates. OHLC must be finite and positive with internally valid high/low bounds; volume is optional, finite, and nonnegative. Invalid ticker data is rejected and isolated. Input is never silently sorted or mutated.

## Run

```sh
node tools/validate-pattern-abcd-history.js \
  --input /tmp/idx-daily-json \
  --output /tmp/abcd-validation.json \
  --from 2022-01-01 \
  --to 2026-07-27 \
  --horizons 5,10,20 \
  --json
```

`--json` writes the identical report to stdout; omit it when only a file is wanted. Generated market data and reports belong under `/tmp` (or another ignored local directory), not Git. The report hashes the canonical ticker-keyed input, uses stable ticker/event/cohort ordering, and contains ticker-level failures rather than aborting valid tickers. Repeated runs over identical bytes and options are deterministic (there is no current timestamp).

## Methodology and timing

For every completed candle, the scanner makes a new `slice(0, asOfIndex + 1)`, passes only that array to `detectAbcdPattern`, and sets `dataDate` to its last date. Thus later candles cannot affect an earlier pivot, ATR, status, or selection. Each renderer candidate is checked with the unchanged `PatternMap.validateCandidate` contract. Its stable detector ID is recorded only at its first observable date; later observations increment the deduplication count.

`firstSeenDate` is the usable observation date—not D and not confirmation evidence. Outcomes inspect only candles whose date is strictly later. For each requested horizon, bullish highs touch targets and lows touch invalidation; bearish lows touch targets and highs touch invalidation. Processing is chronological. A daily candle touching a target and invalidation has unknowable intraday order, so invalidation wins conservatively and `sameBarConflict` is retained.

Terminal outcomes are `tp2_before_invalidation`, `tp1_before_invalidation`, `invalidation_before_tp1`, `unresolved`, or `insufficient_future_data`. MFE, MAE, their percentages, bars-to-level, risk distance, and target reward/risk are diagnostic frequencies—not brokerage-adjusted P&L. Invalid/nonsensical levels are bounded and excluded from cohorts.

Results are separated by bullish/bearish direction, candidate/confirmed first-seen status, and horizon. Rates have explicit TP1-before-invalidation, TP2-before-invalidation, invalidation-first, unresolved, and same-bar-conflict names; no combined result is called “accuracy.”

## Limitations

Daily OHLC cannot establish intraday ordering or fills, survivorship/corporate-action quality depends on the supplied dataset, and no fees, liquidity, slippage, or portfolio rules are modeled. Historical outcome frequency is distinct from detector geometry correctness and from live trading performance. The library makes no network, database, AI, notification, cache, portfolio, or order calls. Pattern Preview remains unchanged and default-off.
