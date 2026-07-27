# Deterministic ABCD Pattern Map v1

ABCD v1 is the only supported pattern family. It is a deterministic geometry
producer, not a profitability guarantee. Future pattern families must use their
own separately versioned rules.

The server uses only the completed daily candles remaining after the Jakarta
T-1 filter. It never uses intraday/current-day data, AI output, labels, user
levels, or network calls. Pattern Preview remains default-off and QuickChart is
requested only after a user explicitly enables and opens the existing preview.

## Fixed `abcd-t1-v1` rules

- Confirmed swing highs/lows use a strict three-candle window on both sides.
  Equal highs or lows in that window are not pivots. Consecutive pivots of one
  type retain the more extreme; an equal extreme retains the earlier pivot. An
  outside bar qualifying as both a strict high and strict low is ambiguous and
  emits neither pivot. Candidate indexes and dates must both be unique, strictly
  increasing, and reference five different source candles.
- Consecutive alternating `X/A/B/C/D` groups are tested. `BC/AB` must be
  `0.618..0.786`, `CD/AB` must be `0.90..1.10`, and D may be at most 25 bars old.
- The permitted CD/AB range directly defines the PRZ. No tolerance is widened.
- ATR14 uses standard daily true range through D. Bullish confirmation is D's
  high and bearish confirmation is D's low. The first later daily close beyond
  that level confirms. A later low/high reaching the ATR-based invalidation
  removes the active pattern, whether before or after confirmation.
- Invalidation is one-half ATR beyond D. Targets are 0.382 and 0.618 of CD from
  D in the reversal direction.
- Multiple active candidates rank by newest D, CD/AB closest to 1, BC/AB closest
  to the configured midpoint, then lexicographic pivot-date sequence.
- Stable identity contains ticker, direction, `abcd-t1-v1`, and all five pivot
  dates; it contains no clock, random, request, or database-derived value.

No pattern is a normal result. Examples include insufficient candles, pivots or
ATR; invalid OHLC; ratios outside fixed limits; a stale D; or invalidation. The
API reports one bounded machine-readable reason and never forces geometry.
