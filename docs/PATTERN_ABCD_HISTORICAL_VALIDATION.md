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
  --from 2023-01-01 --to 2026-07-27 --limit 60 --min-candles 700 --concurrency 3
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
  --to 2026-07-27 \
  --horizons 5,10,20 \
  --json
```

`--json` writes the identical report to stdout; omit it when only a file is wanted. `--from` and `--to` must be real calendar dates. Generated market data and reports belong under an ignored local directory, not Git. The report hashes the canonical ticker-keyed input, uses stable ticker/event/cohort ordering, and contains ticker-level failures rather than aborting valid tickers. Repeated runs over identical bytes and options are deterministic.

## Methodology and timing

For every completed candle, the scanner makes a new `slice(0, asOfIndex + 1)`, passes only that array to `detectAbcdPattern`, and sets `dataDate` to its last date. Thus later candles cannot affect an earlier pivot, ATR, status, or selection. Each renderer candidate is checked with the unchanged `PatternMap.validateCandidate` contract. Its stable detector ID is recorded only at its first observable date; later observations increment the deduplication count.

`firstSeenDate` is the usable observation date—not D and not confirmation evidence. A D pivot requires right-side confirmation candles, so the price can already have crossed TP1, TP2, or invalidation before the pattern first becomes observable. Those geometries are valid detector observations but are not eligible as new entries at `firstSeenDate`.

The report therefore separates:

- `eligible` candidates whose current price remains between invalidation and TP1 at first observation;
- `tp1_reached_before_first_seen`;
- `tp2_reached_before_first_seen`;
- `invalidation_reached_before_first_seen`;
- structurally malformed `invalid_event_levels`.

Only `eligible` candidates enter forward 5/10/20-bar TP and invalidation denominators. Ineligible first-seen candidates remain counted transparently in `firstSeenEligibilityDistribution` and `outcomeAggregate`; they are not mislabeled as malformed levels.

For eligible candidates, outcomes inspect only candles whose date is strictly later than `firstSeenDate`. Bullish highs touch targets and lows touch invalidation; bearish lows touch targets and highs touch invalidation. Processing is chronological. A daily candle touching a target and invalidation has unknowable intraday order, so invalidation wins conservatively and `sameBarConflict` is retained.

Terminal eligible outcomes are `tp2_before_invalidation`, `tp1_before_invalidation`, `invalidation_before_tp1`, `unresolved`, or `insufficient_future_data`. MFE, MAE, their percentages, bars-to-level, risk distance, and target reward/risk are diagnostic frequencies—not brokerage-adjusted P&L.

Results are separated by bullish/bearish direction, candidate/confirmed first-seen status, first-seen eligibility, and horizon. Aggregate outcome rows expose candidate count, eligible denominator, stale-at-first-seen counts and rates, malformed-event count, and explicit TP1-before-invalidation, TP2-before-invalidation, invalidation-first, unresolved, insufficient-future-data, and same-bar-conflict rates. No combined result is called “accuracy.”

`aggregateReasonDistribution` sums every scanned window by bounded reason; each `percentagePct` uses `totalWindows` as its denominator and is rounded to four decimal places. Its counts therefore sum exactly to `totalWindows`. The report also exposes `foundWindowCount`, `noPatternWindowCount`, `totalDeduplicatedObservations`, `directionDistribution`, `firstSeenStatusDistribution`, aggregate outcomes, candidate counts and rates per ticker-year, and deterministic samples of up to five bullish, bearish, and no-pattern observations. Audit samples prefer the newest observation date, then ticker, then stable candidate ID.

Static level structure remains strict: bullish requires `invalidation < tp1 < tp2`, bearish requires `invalidation > tp1 > tp2`, and all values must be finite and positive. Crossed targets at first observation are classified as timing eligibility, not repaired, reordered, or treated as a fresh entry.

## Limitations

Daily OHLC cannot establish intraday ordering or fills. The production-compatible source is unadjusted Yahoo OHLCV, so split and corporate-action discontinuities require explicit audit. Survivorship and corporate-action quality depend on the supplied dataset, and no fees, liquidity, slippage, or portfolio rules are modeled. Historical outcome frequency is distinct from detector geometry correctness and from live trading performance. The validation library makes no network, database, AI, notification, production-cache, portfolio, or order calls. Pattern Preview remains default-off.

## VPS execution record (2026-07-28 WIB)

The merged acquisition and validation tools were executed on the Auto-Cuan VPS against the deterministic first 60 normalized repository-universe symbols for `2023-01-01` through `2026-07-27`.

- 54 usable ticker datasets and 6 `insufficient_candles` failures;
- 45,579 completed daily candles and walk-forward windows;
- dataset SHA-256 `b319d8a1715783e8330be5e239275ea87842430981082cfcbf8ae8f6354e2519`;
- manifest SHA-256 `4dae2b9b82387a8782a4d1075357921fe889e6e311cc4817f3cda28161e4395e`;
- 54 unique candidates, 738 deduplicated later observations, and 792 found windows;
- 28 bullish and 26 bearish candidates;
- 32 first seen as candidate and 22 first seen as confirmed;
- 30 eligible forward-evaluation candidates and 24 candidates whose targets were already crossed before first observation.

The initial QuickChart integration request returned a valid PNG with HTTP 200, `image/png`, a valid PNG signature, and non-empty candlestick output. It measured `2400×1400` because QuickChart defaults `devicePixelRatio` to 2. The renderer now explicitly sends `devicePixelRatio: 1`, making the requested output exactly `1200×700` while preserving the same chart configuration.

**Rollout decision: remain default-off until the corrected report is rerun and the resulting candidate samples are reviewed.** Preview requires `window.__AUTOCUAN_PATTERN_MAP_PREVIEW__ = true` or `?patternMapPreview=1`. Roll back by removing the query/flag or setting the window flag to `false`. AI Q&A remains disabled.
