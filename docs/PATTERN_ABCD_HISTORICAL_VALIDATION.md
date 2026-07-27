# ABCD v1 historical validation

This offline tool measures detector frequency and subsequent daily-bar outcomes. It does **not** prove pattern geometry, profitability, executable fills, or future performance. Geometry remains exclusively owned by `lib/pattern-abcd.js`.

## Data audit and schema

The repository has no committed multi-year daily OHLCV dataset. Its existing daily provider/cache is Yahoo Finance via `lib/daytrade-ohlcv-cache.js`; generated cache data is gitignored. `data/daytrade-observe-tickers.txt` is the existing repository-owned observation universe.

The offline-only downloader:

- uses the unique normalized universe in lexicographic order;
- converts primitive finite Yahoo epoch seconds to `Asia/Jakarta` calendar dates using the same policy as `/api/candles`;
- rounds OHLC to two decimals to match the production chart path;
- requires explicit real `--from` and `--to` dates;
- rejects `--to` when it is the current or a future Jakarta date, preventing an incomplete daily candle from entering the dataset;
- uses bounded concurrency and three conservative attempts;
- reports bounded failure reasons without raw exception text;
- writes through a staging directory and replaces the dedicated output directory so stale JSON files from an earlier run cannot leak into validation;
- produces deterministic dataset and manifest hashes with no current-time field in the hashed manifest;
- is never imported by production code.

```sh
node tools/acquire-pattern-abcd-data.js --universe data/daytrade-observe-tickers.txt \
  --output data/abcd-validation --manifest data/reports/abcd-acquisition-manifest.json \
  --from 2023-01-01 --to 2026-07-24 --limit 60 --min-candles 700 --concurrency 3
```

Input to the validator may be one JSON file whose root is a ticker map (or `{ "tickers": { ... } }`):

```json
{"BBCA":[{"time":"2022-01-03","open":7300,"high":7400,"low":7250,"close":7375,"volume":1000}]}
```

Alternatively, pass a directory of sorted `*.json` files containing candle arrays; the filename supplies the sole ticker identity. Tickers are trimmed, uppercased, stripped of one trailing `.JK`, and must contain three to five letters. Aliases that normalize to the same ticker are all rejected as `duplicate_normalized_ticker`, so a ticker can never contribute twice. A directory payload must not repeat the filename identity in a `ticker` property. Dates must be real `YYYY-MM-DD` values in strictly increasing order with no duplicates. OHLC must be finite and positive with internally valid high/low bounds; volume is optional, finite, and nonnegative. The complete source array is validated before date filtering, so malformed out-of-range data cannot be hidden. File, schema, detector, renderer-contract, outcome, and other unexpected failures are bounded at ticker scope without exception messages or paths; valid tickers continue. Input is never silently sorted, repaired, or mutated.

## Run

```sh
node tools/validate-pattern-abcd-history.js \
  --input data/abcd-validation \
  --output data/reports/abcd-validation-2023-2026.json \
  --from 2023-01-01 \
  --to 2026-07-24 \
  --horizons 5,10,20 \
  --json
```

`--json` writes the identical report to stdout; omit it when only a file is wanted. `--from` and `--to` must be real calendar dates. Generated market data and reports belong under an ignored local directory, not Git. The report hashes the canonical ticker-keyed input, uses stable ticker/event/cohort ordering, and contains ticker-level failures rather than aborting valid tickers. Repeated runs over identical bytes and options are deterministic.

## Methodology and timing

For every completed candle, the scanner makes a new `slice(0, asOfIndex + 1)`, passes only that array to `detectAbcdPattern`, and sets `dataDate` to its last date. Thus later candles cannot affect an earlier pivot, ATR, status, or selection. Each renderer candidate is checked with the unchanged `PatternMap.validateCandidate` contract. Its stable detector ID is recorded only at its first observable date; later observations increment the deduplication count.

`firstSeenDate` is the usable observation date—not D and not confirmation evidence. Outcomes inspect only candles whose date is strictly later. For each requested horizon, bullish highs touch targets and lows touch invalidation; bearish lows touch targets and highs touch invalidation. Processing is chronological. A daily candle touching a target and invalidation has unknowable intraday order, so invalidation wins conservatively and `sameBarConflict` is retained.

Terminal outcomes are `tp2_before_invalidation`, `tp1_before_invalidation`, `invalidation_before_tp1`, `unresolved`, or `insufficient_future_data`. MFE, MAE, their percentages, bars-to-level, risk distance, and target reward/risk are diagnostic frequencies—not brokerage-adjusted P&L. Invalid/nonsensical levels are bounded and excluded from valid-event denominators.

Results are separated by bullish/bearish direction, candidate/confirmed first-seen status, and horizon. Aggregate outcome rows expose counts and explicit TP1-before-invalidation, TP2-before-invalidation, invalidation-first, unresolved, insufficient-future-data, and same-bar-conflict rates. No combined result is called “accuracy.”

`aggregateReasonDistribution` sums every scanned window by bounded reason; each `percentagePct` uses `totalWindows` as its denominator and is rounded to four decimal places. Its counts therefore sum exactly to `totalWindows`. The report also exposes `foundWindowCount`, `noPatternWindowCount`, `totalDeduplicatedObservations`, `directionDistribution`, `firstSeenStatusDistribution`, aggregate outcomes, candidate counts and rates per ticker-year, and deterministic samples of up to five bullish, bearish, and no-pattern observations. Audit samples prefer the newest observation date, then ticker, then stable candidate ID.

Performance aggregation requires strict levels. Bullish events must satisfy `invalidation < currentPriceAtFirstSeen < tp1 < tp2`; bearish events must satisfy `invalidation > currentPriceAtFirstSeen > tp1 > tp2`. All levels must be finite and positive with positive risk and finite reward/risk. Malformed events are not repaired and receive the bounded `invalid_event_levels` classification.

## Limitations

Daily OHLC cannot establish intraday ordering or fills. The production-compatible source is unadjusted Yahoo OHLCV, so split and corporate-action discontinuities require explicit audit. Survivorship and corporate-action quality depend on the supplied dataset, and no fees, liquidity, slippage, or portfolio rules are modeled. Historical outcome frequency is distinct from detector geometry correctness and from live trading performance. The validation library makes no network, database, AI, notification, production-cache, portfolio, or order calls. Pattern Preview remains unchanged and default-off.

## Issue #304 execution record (2026-07-27 UTC)

The acquisition command was genuinely attempted against 60 symbols, but the task environment's outbound proxy rejected Yahoo connectivity. The initial blocked run produced zero usable datasets, so no aggregate result or candidate sample is claimed and no market data is committed. The empty dataset SHA-256 was `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.

The real QuickChart test was also attempted with `RUN_QUICKCHART_INTEGRATION=1 node --test test/pattern-map-quickchart.integration.test.js`; the same outbound restriction blocked the request. Vercel build status can be checked independently, but a successful build does not prove browser-to-QuickChart completion.

**Rollout decision: remain default-off.** Preview requires `window.__AUTOCUAN_PATTERN_MAP_PREVIEW__ = true` or `?patternMapPreview=1`. Roll back by removing the query/flag or setting the window flag to `false`. AI Q&A remains disabled. Activation is blocked until real-data validation, manual candidate audit, real PNG proof, and hosted-browser proof succeed.
