# Auto-Cuan AI context and evaluation scope

## Analisis Saham

- Uses one ticker and the latest stored analysis snapshot.
- Covers entry, confirmation, invalidation, stop loss, targets, risk/reward, watchlist reason, scenarios, summaries, ambiguous follow-ups, typos, and missing real-time/news data.
- Facts and numbers must come from the stored snapshot. Claude may add clearly identified analysis or opinion.

## Asisten AI Portofolio

- Uses the latest stored portfolio snapshot for admin `budi` when available.
- Covers budget-to-stock, affordability, lot sizing, allocation, combined risk, priority, average down, cut loss, targets, alerts, journal review, discipline, snapshot changes, position comparison, what-if scenarios, missing prices, emotional decisions, ambiguous follow-ups, and typos.
- Portfolio feature scenarios may be simulated. Every assumption must be labelled `SIMULASI` and must not be represented as a real position or transaction.

## Data boundary

- `ai_context_snapshots` is private, service-role only, and protected by RLS.
- The one-time evaluation source is restricted to snapshots belonging to admin `budi`.
- User identity is removed from generated evaluation source rows.
- Questions and scenarios may vary. Source-backed facts and numbers may not be invented.
- Questions requiring current news, live prices, or external facts must state that the data is unavailable when it is not present in the supplied context.

## Quality boundary

- One million cases is an upper bound, not a forced target.
- Duplicate or low-quality variations are skipped.
- Generation stops when useful unique variations are exhausted.
- Deterministic validation and same-model judging remain enabled.
- Provider retries remain bounded by the global token budget and manual Stop.
