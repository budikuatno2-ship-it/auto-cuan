# Pattern Radar

Pattern Radar is the admin-only discovery view for deterministic `abcd-t1-v1` candidates.

## Product behavior

- Chart remains a manual Technical Chart page.
- The legacy Pattern tab and Pattern panel inside Chart are hidden.
- A separate `Pattern` navigation item is exposed only after the current signed admin session is verified as `budi` by the existing Pattern access gate.
- Pattern Radar does not accept a manual ticker search.
- It builds a bounded scan universe from the latest Konglo, Non-Konglo, and Day Trade screener result payloads. A bounded fallback set prevents a nearly empty screener cache from making discovery unusable.
- At most 60 tickers are scanned with concurrency 4 through the existing `/api/candles` endpoint.
- Only responses containing a candidate that passes `PatternMap.validateCandidate` are displayed.
- No-pattern, invalid, unavailable, and failed ticker responses are omitted from the result cards.

## Rendering and safety

- The scan itself never calls QuickChart.
- QuickChart remains lazy and is called only after the admin presses `Lihat Peta` on an accepted result.
- Blob URLs and active render requests are revoked or cancelled when the radar is refreshed or access is removed.
- The `Technical Chart` button transfers the selected result ticker to the existing Chart page.
- Guest, non-admin, expired, and tampered sessions cannot see the Pattern navigation item or receive Pattern geometry from `/api/candles`.

## Responsive header

The status-chip cluster is removed from the primary header because it duplicated safety copy already available in the product and caused horizontal crowding. Between 1024px and 1279px the app uses the existing horizontally scrollable navigation row. Larger intermediate widths use compact primary navigation spacing.

## Scope boundaries

This feature does not change:

- ABCD detector constants, pivot rules, ratios, ATR, lifecycle, or ranking;
- Technical Chart calculations or candle data;
- screeners, trading logic, Telegram, subscriptions, payments, database migrations, cron, or broker/order behavior;
- the Vercel API endpoint count.
