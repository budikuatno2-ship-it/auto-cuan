# Chart completed daily-candle (T-1) policy

`/api/candles` returns only Yahoo daily candles whose **Asia/Jakarta market
date is strictly earlier than the current Asia/Jakarta date**. The cutoff is
applied before `latest`, candle count, moving averages, RSI, volume metrics,
and deterministic Pattern detection are calculated. Only the filtered result
is placed in the in-memory cache.

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

Pattern Map must consume this policy and may not represent
`calendar_unverified` data as verified T-1.

## Pattern Map authorization

Pattern Map is **admin-only**. The browser asks the existing
`/api/admin-users` endpoint for `pattern_map_access`; access is granted only
when the request carries a current, valid HMAC-signed `ac_sess` HttpOnly cookie
whose server-owned admin claim belongs to `budi`. Guest, approved non-admin,
tampered, missing, and expired sessions are denied.

The legacy `?patternMapPreview=1` query parameter and
`window.__AUTOCUAN_PATTERN_MAP_PREVIEW__` browser flag are not authorization
inputs and cannot expose or render Pattern Map.

`/api/candles` keeps one internal T-1 result cache, but applies authorization to
every response. `patternMap` and `pattern_map_meta` are removed for guest and
non-admin requests, including cache hits. Responses are marked `private,
no-store` and vary by `Cookie` so a shared HTTP cache cannot leak Pattern
geometry. Technical Chart fields remain unchanged.

The browser gate starts hidden, rechecks the signed session before rendering,
and revalidates on focus/visibility changes. Logout or session expiry restores
Technical Chart, cancels active Pattern rendering, and revokes the current
object URL through the existing reset path.

QuickChart remains lazy: the initial page and Technical Chart load make no
QuickChart request. A request is made only after an authorized admin selects
Pattern Map and a trusted deterministic candidate passes the renderer
contract. Pattern Q&A remains disabled and no AI detects, draws, ranks, or
changes Pattern geometry.
