# Day Trade manual market-day sampling audit (B0.3)

## Decision

The existing evaluation contract already carries `observed_at`, `scheduled_slot`,
and `scheduler_source`, while the logger finalizes an immutable gzip plus a
checksum/count manifest below its caller-selected root. That is sufficient to
identify and reject a **later, serial** manual attempt for the same Jakarta
market date and fixed slot. No cursor, checkpoint, lock, database, or other
mutable state is needed.

This does not make concurrent execution safe: two processes could both inspect
the root before either finalizes. The protocol is therefore deliberately manual
and serial. The operator must never start a second invocation while one is in
progress. Solving concurrent exclusion would require a lock/state mechanism and
is a stop condition for this phase.

## Code-level audit

- `daytrade-screener-engine` captures `daytrade_evaluation_initial` only when its
  caller explicitly passes `captureEvaluationInitial: true`; ordinary callers
  retain the disabled/default behavior.
- `daytrade-evaluation-adapter` maps the initial snapshot into the strict shared
  record contract. The contract already supports the slot and scheduler source,
  so no schema or production-path change is necessary.
- `screener-evaluation-logger` is the sole writer. It creates a per-run gzip,
  renames it out of the `.open` state, and then atomically writes a manifest with
  relative path, compressed byte size, record count, and SHA-256.
- `screener-evaluation-retention` is audit-only and non-mutating. It demonstrates
  the existing path-containment and checksum model; this protocol does not call
  deletion or add retention behavior.
- Existing engine, adapter, contract, logger, retention, and B0.2 canary tests
  establish capture opt-in, strict mapping, all-or-nothing mapping before logger
  creation, caller-root writes, and gzip/manifest integrity.

## Finalized-evidence proof and fail-closed rules

Before provider access or logger creation, the manual tool walks the complete
`raw`, `manifests`, and `quarantine` protocol trees below the supplied root.
Protocol roots and intermediate components must be real directories, every
finalized gzip must have exactly one manifest, and every manifest must have
exactly one finalized gzip. Open gzip files, unresolved quarantine files,
symlinks, orphan evidence, and unexpected file types fail closed.

Each manifest must be a regular file in the exact logger-produced location. Its
relative raw path must remain in `raw/<date>/day-trade`. The gzip byte size,
SHA-256, record count, strict record contract, Jakarta record date, manifest run
ID and timestamps, and immutable record identity must all agree. Any parse,
gzip, validation, traversal, checksum, count, or identity ambiguity fails
closed. A second Jakarta-date check after calculation prevents a run from
finalizing across midnight WIB.

The finalized B0.2 one-shot evidence is recognized narrowly by its null slot and
`manual_vps_local_canary` source. It is verified but cannot collide with a B0.3
slot. B0.3 records use `manual_market_day_sample` and exactly one of `OPENING`,
`MID_SESSION`, or `CLOSING`. A matching finalized market-date/slot is rejected;
a different slot remains eligible.

## Manual protocol

1. Confirm the exchange is actually open; the tool intentionally has no holiday
   service or calendar. Confirm that no other invocation is running.
2. Use a clean tracked checkout at the reviewed commit.
3. Invoke the tool once with `--execute`, `--market-day-confirmed`, an absolute
   external `--evaluation-root`, a fixed `--sample-slot`, and one to five unique
   `TICKER:BOARD` pairs. Boards are limited to `UTAMA` and `PENGEMBANGAN`.
4. Treat any `CANARY_FAILED` result as no sample. Do not retry until its cause and
   the evaluation root have been inspected. Never delete evidence to bypass a
   duplicate result.
5. A success prints only bounded count/size/checksum/date/slot and field
   provenance. The gzip and manifest are the only protocol output files.

Example syntax (documentation only; do not run during implementation):

```sh
node tools/run-daytrade-evaluation-canary.js \
  --execute --market-day-confirmed --sample-slot OPENING \
  --evaluation-root /absolute/external/evaluation-root \
  --tickers BBCA:UTAMA
```

There is no cron, systemd, runner, workflow, environment activation, database,
notification, publication, ranking, monitoring registration, or automatic
deletion integration.
