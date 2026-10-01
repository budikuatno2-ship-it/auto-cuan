# Manual Day Trade outcome collector (Phase B0.5)

This phase connects finalized B0.3 `classification_initial` evidence to the B0.4 outcome evaluator and append-only logger. It remains manual-only and evaluation-only.

The CLI requires explicit execution, market-day, and continuous-segment acknowledgements; an external evaluation root; an exact market date and sample slot; one to five unique tickers; an explicit UTC horizon; a supported intraday interval; and an external caller-supplied policy file. No exchange tick, fee, tax, spread, slippage, board, or session policy is bundled in the repository.

Before provider access, the collector validates the request, clean tracked checkout, external non-symlink paths, the policy contract, and the complete initial/outcome evidence tree. Initial records are selected exactly by Jakarta market date, scheduled slot, and ticker, and must share immutable B0.3 run identity.

The default provider is a thin direct Yahoo chart intraday fetcher. It has no cache, production API, Vercel route, Supabase, Telegram, Fast Watcher, Top 5, Swing, publication, or ranking dependency. Tests replace it through dependency injection and perform no network access.

Every provider response is bounded to the immutable initial observation and caller horizon. Out-of-range, mixed-ticker, duplicate, overlapping, malformed, or future-as-of evidence fails before writes. Sparse, truncated, gapped, or interval-mismatched evidence is passed to B0.4 and remains `UNRESOLVED`; the collector does not manufacture lunch-break or no-trade bars.

The full batch is fetched, evaluated, normalized, and checked for duplicate `finalization_key` values before the first outcome write. B0.4 artifacts are individually atomic, not transactional as a batch. A crash during sequential finalization may leave a valid subset finalized; the failure summary lists finalized and non-finalized tickers without exposing paths or raw records. There is no deletion or overwrite recovery.

The collector prints one bounded JSON summary. It never prints policy/evidence paths, provider URLs, raw provider payloads, credentials, account identifiers, or full evidence records.

There is no cron, systemd, GitHub Actions, deployment, live sample, production integration, database write, or runtime activation in this phase.
