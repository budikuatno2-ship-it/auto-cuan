# Chart completed daily-candle (T-1) policy

`/api/candles` returns only Yahoo daily candles whose **Asia/Jakarta market
date is strictly earlier than the current Asia/Jakarta date**. The cutoff is
applied before `latest`, candle count, moving averages, RSI, and volume metrics
are calculated, and only the filtered response is placed in the in-memory
cache.

This is a minimum completed-candle guarantee, not a complete IDX calendar. The
repository has weekday/weekend helpers but no authoritative, maintained IDX
public-holiday calendar. `expected_t1_date` is therefore a weekday-only
candidate and must not be treated as exchange-calendar verification.

## Response metadata

- `data_policy`: `completed_daily_candles_before_jakarta_today`.
- `jakarta_today`: current date in Asia/Jakarta.
- `expected_t1_date`: previous weekday candidate, or `null`.
- `actual_data_date`: last retained candle date, or `null`.
- `t1_status`:
  - `verified`: reserved for a future authoritative IDX-calendar match; it is
    not emitted by the current weekday-only implementation.
  - `calendar_unverified`: the cutoff is satisfied and the last candle is not
    older than the weekday candidate, but holiday verification is unavailable.
  - `stale`: the last candle predates the weekday candidate.
  - `missing`: no completed candle remains.
- `t1_verified`: always `false` until an authoritative calendar is integrated.
- `t1_reason`: stable machine-readable explanation of the status.

Pattern Map remains blocked: it must consume this policy and may not represent
`calendar_unverified` data as verified T-1.

## Pattern Map preview status

The runtime currently has **no trusted deterministic producer** for the full
Pattern Map contract (stable candidate/rule identity, ordered X/A/B/C/D candle
references, PRZ, confirmation, invalidation, TP1/TP2, and provenance).
`/api/candles` intentionally does not claim or fabricate that geometry. The
Pattern tab is therefore a default-off renderer preview, enabled only with the
explicit `window.__AUTOCUAN_PATTERN_MAP_PREVIEW__ = true` switch or the
`?patternMapPreview=1` preview query parameter. This is renderer infrastructure,
not an operational production Pattern Map.

Activation also remains blocked until the hosted QuickChart Chart.js v4 runtime
is proven to register the financial candlestick controller and its date adapter,
and a browser-origin POST from the Vercel preview is proven CORS-safe. A Node.js
or mocked-fetch result alone is not sufficient evidence for either condition.
