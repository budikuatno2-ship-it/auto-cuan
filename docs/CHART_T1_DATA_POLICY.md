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
