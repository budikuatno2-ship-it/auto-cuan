# Screener evaluation logging v2 — Phase A design

**Status:** design only; no migration has been created or applied. Logging remains
default-off. This document inventories the repository at commit `093eaf9` on
`feat/daytrade-screener-v1`; it is not an inventory of the live Supabase catalog.

## 1. Boundaries and repository inventory

Phase A changes documentation only. It does not change a scorer, gate, threshold,
schedule, rank, setup/status decision, trade-plan formula, Telegram route or text,
Fast Watcher decision, Top 5 choice, runtime configuration, production data, or
API. In particular, nothing under `data/intraday-*` is read or written by this
change.

### Existing persistence and producers

| Concern | Repository-declared storage and identity | Producer/publication path |
|---|---|---|
| Day Trade | `daytrade_screener_latest` (PK `ticker`, includes `run_id`), singleton `daytrade_screener_meta`, and `daytrade_screener_runs` (`bigserial` PK, non-unique `run_id`). The latest table is replaced/trimmed during a scan, so it is not history. | `handleDayTradeScreenerRun` / `finalizeDtScreener` in `api/sector-hot.js`, using `lib/daytrade-screener-engine.js`; publication and Telegram originate in `sendDayTradeTelegramNotification` in that same existing API route. A run ID is generated and carried through batches, and the run mode identifies broad session mode, but neither is a cross-scheduler logical-slot key. |
| Swing Konglo | `swing_screener_latest` (PK `ticker`) and singleton `swing_screener_meta`. Neither schema declares a run ID; latest is mutable cache state. Konglo membership comes from `sector_hot_group_members` (`group_code`/ticker mapping). | `handleScreenerRefresh` and `sendSwingKongloTelegramNotification` in `api/sector-hot.js`; the current calculated timestamp/date is provenance, not a stable run/setup ID. |
| Swing Non-Konglo | `swing_screener_non_konglo_latest`, singleton `_meta`, `_jobs`, and durable `_staging`. Jobs are unique on (`run_date`,`batch_index`); staging is unique on (`run_date`,`ticker`) and is cleared/rebuilt for the date. | `handleNkScreenerStart`, `handleNkScreenerBatch`, and `handleNkScreenerFinalize` in `api/sector-hot.js`, followed by `sendSwingNkTelegramNotification`. `run_date` plus batch index is reusable batch identity, but `run_date` alone cannot distinguish reruns or scheduler sources. |
| Telegram Top 5 and monitor | `telegram_daily_picks` has `bigserial id`, unique (`date`,`ticker`), `first_sent_at`, hit timestamps, final/status state, and `raw_payload`. The same table serves locked Top 5 and candidates registered by the three strategies. | Existing `telegram-daily-picks` handling, `registerCandidatesForMonitoring`, and `handleTelegramMonitorPicks` in `api/sector-hot.js`; `tools/run-top5-progress-monitor.js` is a second monitor runner. Registration currently suppresses a ticker already present on a date, while monitor display additionally deduplicates by source+ticker. Row `id` is stable and reusable as a legacy reference, but is not a signal/setup ID. |
| Fast Watcher | File state and event logs: `data/intraday-fast-watcher-state`, `-events`, guarded-live `-live-state`/`-live-events`, and `data/intraday-fast-watcher-published` ledgers. State has schema/rule versions and shortlist hash; transition `event_id` is deterministic. Confirmed candidates have deterministic `setup_id`. Published confirmed/radar ledgers prevent repeats. | `tools/run-intraday-fast-watcher*.js` → `lib/intraday-fast-watcher[-guarded-live].js`, pool/momentum modules, then confirmed/radar publishers. Current ledgers are local operational idempotency and must not be replaced in an observational rollout. |
| Existing delivery/idempotency | There is no general delivery-attempt table. Day Trade has a run ID; NK jobs/staging have composite uniqueness; Top 5 has date+ticker uniqueness and send/hit timestamps; Fast Watcher has event/setup IDs plus per-date ledgers. Telegram failures are isolated/best-effort in existing publisher paths. | Evaluation logging must observe these paths after their existing decisions, never become a precondition for sending, and never alter their retry/failure behavior. |

Repository SQL files are manually run, flat files under `supabase/`, rather than a
timestamped migration framework. Existing screener SQL enables RLS but generally
relies on service-role bypass and does not explicitly revoke table/schema grants.
Phase B must therefore test both RLS and grants rather than assuming “no policy” is
a complete server-only contract. Live catalog drift (columns, policies, grants,
indexes, table sizes) remains unknown until a read-only catalog export is approved.

### Reusable identity versus missing identity

Reuse Day Trade `run_id`, NK (`run_date`,`batch_index`), Fast Watcher `event_id` and
`setup_id`, and `telegram_daily_picks.id` only as **source references**. New UUIDs
remain evaluation-owned. Swing rows and Top 5 rows lack a stable setup identity;
Phase B needs a deterministic setup-ID contract based on immutable source identity
and setup revision—not ticker/date alone. No existing identifier safely supplies
the required cross-scheduler scan identity.

### Naming and semantic collisions

* Generic proposal names such as `scan_runs`, `outcome`, or `delivery_logs` are
  collision-prone and unclear beside `daytrade_screener_runs`, application logs,
  and Telegram lifecycle state. Every new relation uses `evaluation_`.
* Existing `*_latest`, singleton `*_meta`, and NK staging are mutable operational
  caches. They cannot be treated as immutable point-in-time evaluation history.
* Existing `run_id`, `run_date`, and run `status` have different semantics across
  strategies. They must not be overloaded as `logical_run_key` or the proposed
  lifecycle enum.
* `telegram_daily_picks` unique (`date`,`ticker`) is intentionally coarser than a
  delivery message identity and can suppress same-ticker registrations. Evaluation
  delivery deduplication must not copy that key.
* `score`/`daytrade_score` are capped/display values. `score_raw` is a distinct
  observational field and must never feed current ranking/classification.
* Existing final OHLCV fields do not prove point-in-time knowledge. Evaluation
  fields explicitly use `*_sofar`, source/as-of timestamps, and bar completeness.

## 2. Corrected data model and ERD

All primary keys below are UUIDs (generated server-side), timestamps are
`timestamptz`, market dates are `date`, bounded codes are `text` with checks or
reference enums, prices use a deliberately sized fixed-point type after catalog
sampling, and hashes are 32-byte `bytea`. JSON has an explicit schema version and
byte-size check. No unrestricted diagnostic prose is accepted.

The proposal has **12 domain entities**. Two supporting entities are required:
`evaluation_configurations` stores deduplicated canonical configurations, while
`evaluation_experiments` records each use of a configuration in a period, fold, or
rerun. The corrected plan therefore has **14 relations**. Configuration and
experiment identity are deliberately separate: one canonical configuration can be
reused by many experiments, and every experiment remains countable.

| Relation | Purpose and essential keys/constraints | Mutability / proposed stage |
|---|---|---|
| `evaluation_configurations` | `configuration_id`, canonical `config_json`, unique `config_hash`, config schema version and creation timestamp. It contains no evaluation period, result, fold, promotion, or experiment-specific state. | Append-only and reusable. **B1**. |
| `evaluation_experiments` | `experiment_id`, required configuration FK, optional parent experiment, created reason/code, evaluation start/end and fold/rerun metadata, `summary_ref`/result reference, promotion flag/time. Multiple rows may reference the same configuration. Every tested experiment—not only production promotions—gets a row. | Append-only; promotion metadata updated only by a designated review job. **B1**. |
| `evaluation_universe_snapshots` | One ticker in a point-in-time universe: (`universe_snapshot_id`,`ticker`) unique; strategy, `as_of_ts`, source/version, inclusion and bounded exclusion codes. | Append-only and **unpartitioned in B1** so the stated uniqueness is enforceable. Partitioning is a measured later migration. |
| `evaluation_konglo_mappings` | Dated membership with ticker/group, `valid_from`, nullable `valid_to`, source/as-of; exclusion prevents overlapping validity for the same mapping. | Version/supersede, never rewrite old validity. **B1**. |
| `evaluation_tick_size_references` | Dated price-band/tick rows, source/version, validity interval; non-overlapping bands and validity constraints. | Version/supersede. **B2**, after authoritative source is chosen. |
| `evaluation_auto_reject_references` | Dated board/price-band ARA/ARB rules with source/version and validity. | Version/supersede. **B2**. |
| `evaluation_cost_assumptions` | Versioned fees, tax, spread/slippage and capacity assumptions; currency, price unit, bar-volume unit, `shares_per_lot=100`, validity and source. | Append/version only. **B2**. |
| `evaluation_scan_runs` | FK experiment and configuration; strategy, deterministic `logical_run_key`, `scheduled_slot`, scheduler source, lifecycle status (`STARTED`, `COMPLETED`, `PARTIAL`, `FAILED`, `SKIPPED`), scheduled/started/finished timestamps, parent run, partial flag, bounded failure fields, immutable copies of canonical `config_json` and `config_hash`, code/rule versions and counts. Unique (`strategy`,`logical_run_key`) **without scheduler source**, so two schedulers cannot claim the same logical slot. The copies must match the configuration FK. Check terminal timestamps/status consistency. | Insert STARTED; only owner may transition lifecycle/count/error fields. No decision fields. **B1**. |
| `evaluation_candidate_snapshots` | FK run and universe; stable evaluation candidate ID, source candidate/setup refs, ticker, `feature_as_of_ts`, `last_bar_close_ts`, bar-complete flag, data source/as-of and lag; OHLC/volume-so-far; `rvol_raw`, nullable `rvol_seasonal` plus curve version; typed raw components, `score_raw`, capped/display score; raw and tick-normalized entry/SL/TP; classification/rank; bounded rejection-code array; versioned bounded `gate_trace`. Unique (`scan_run_id`,`ticker`,`candidate_revision`). Represents passed **and rejected** rows. | Append-only and **unpartitioned in B1**, preserving its UUID PK and stated uniqueness; initially one canary strategy only after Phase C approval. |
| `evaluation_fast_watcher_arms` | FK parent candidate, observation timestamp/setup/event refs, arm (`FULL_SCAN`,`FAST_WATCHER`), eligibility, `would_publish`, `did_publish`, rank/capacity rank and bounded guard/rejection codes. Unique (parent candidate, observation time, arm, rule version). Exactly two arms are expected and checked by contract query/deferred validation. | Append-only and initially unpartitioned. **B2**; no watcher behavior changes. |
| `evaluation_published_signals` | Stable `signal_id`, candidate/arm FK, stable `setup_id`, strategy/source, publication decision timestamp, rank, immutable plan snapshot and rule/version. Unique source publication identity. | Append-only; correction creates superseding signal. **B1 contract**, wiring later. |
| `evaluation_delivery_attempts` | Attempt ID, signal FK, channel, message type, `message_version`, deterministic `logical_message_key`, attempt number, timestamps/status, provider message ref, bounded error. Unique (`channel`,`logical_message_key`,`attempt_no`); a separate unique successful logical message prevents duplicate success while retaining failed attempts. Logical key derives from stable signal/setup + message type/version, never ticker/date. | Attempt/status fields written by delivery logger only. **B1 contract**, no rerouting/wiring. |
| `evaluation_price_paths` | Signal/candidate FK, bar interval, bar start/end, source/as-of, OHLCV and completeness. Unique (signal, interval, bar start, source version). Only bars genuinely captured point-in-time are allowed; no later daily-candle reconstruction. | Append-only and initially unpartitioned; **B3/later**, after source/retention approval. |
| `evaluation_outcomes` | `outcome_id`, signal FK, `label_version`, label/execution-contract version, horizon end, label interval, feature information interval, purge overlap, parameterized embargo, result and bounded evidence. Unique (`signal_id`,`label_version`). | Label rows append-only; corrections use a new label version/supersession. **B3/later**. |

```text
evaluation_configurations 1──* evaluation_experiments 1──* evaluation_scan_runs
              └──────────────* evaluation_scan_runs (immutable config copy/FK)
                                                    │
evaluation_universe_snapshots *─────────────────────┼──* evaluation_candidate_snapshots
                                                    │              ├──* evaluation_fast_watcher_arms
                                                    │              └──* evaluation_published_signals
evaluation_konglo_mappings (as-of lookup)           │                            │
evaluation_tick_size_references (as-of lookup)      │                            ├──* evaluation_delivery_attempts
evaluation_auto_reject_references (as-of lookup)    │                            ├──* evaluation_price_paths
evaluation_cost_assumptions (label-contract FK)     │                            └──* evaluation_outcomes
```

### Standard contracts

`logical_run_key` is produced from a versioned canonical tuple such as
`strategy | exchange_timezone | market_date | scheduled_slot | run_kind`; it does
not contain scheduler source or actual start time. An ad-hoc rerun must declare a
new, explicit slot/attempt lineage and `parent_run_id`, rather than weakening the
unique key. A single date may therefore have many legitimate intraday slots.

Canonical JSON recursively sorts object keys, preserves array order, rejects
non-JSON/non-finite values, serializes UTF-8 without insignificant whitespace, and
is hashed with SHA-256 over those exact bytes. Both JSON and hash are stored and
checked by a pure Phase B helper/test fixture.

`gate_trace` is an object with `schema_version`, `rule_set_version`, and a bounded
`gates` object. Each allow-listed gate contains typed `value`, `threshold`, an
allow-listed operator, boolean `passed`, and bounded `rule_version`; keys/count,
string lengths, nesting, and serialized size (proposed 16 KiB maximum) are checked
before insert and in SQL where practical. Rejection codes are allow-listed,
deduplicated codes, not free text. Error summaries are proposed at 512 characters.

`rvol_seasonal` remains null until a validated curve exists. Its future provenance
must identify at least liquidity bucket and time bucket, with optional ticker and
day-of-week strata only when sample size supports them. It never changes the
current volume gate in this project.

An execution label references a versioned contract covering price and volume
units, 100 shares/lot, order type, tick-snap direction, gap handling (better fill
versus cancellation), spread/slippage, same-bar SL/TP ordering, capacity and volume
participation. Until appropriate intraday paths exist, outcomes must be marked
unfillable/unknown rather than represented as real fills.

Walk-forward rows record the feature information interval and label interval ending
at `horizon_end_ts`. Purging follows actual overlap; embargo is a parameter of the
label/validation contract and receives sensitivity tests. MA50 does not imply a
fixed 50-day embargo.

## 3. Volume, storage, indexes, and retention

These are **repository-only planning assumptions**, not observed production facts.
The repository describes run modes and runner paths but is not authoritative for
the active VPS cron cadence, duplicate/retry behavior, live universe sizes, row
width, or live table counts. In particular, an audited production operation may
run Day Trade about every 12 minutes through market hours—approximately 25–30 full
runs/session—so three slots is only the low sensitivity case, not the likely base.

All cases assume 250 IDX sessions/year, 800 evaluated candidates per Day Trade run,
one 150-row Konglo scan and one 800-row Non-Konglo scan/session. Candidate storage
uses 2.5–4.0 KiB/row including a planning allowance for TOAST and indexes.

| Sensitivity | Day Trade runs/session | Candidate rows/session | Candidate rows/year | Candidate storage/year |
|---|---:|---:|---:|---:|
| Low / limited cadence | 3 | 3,350 | 837,500 | 2.0–3.2 GiB |
| Base / audited high-frequency cadence | 25 | 20,950 | 5,237,500 | 12.5–20.0 GiB |
| High / full 12-minute cadence | 30 | 24,950 | 6,237,500 | 14.9–23.8 GiB |

Non-candidate planning remains 160,000 Fast Watcher arm rows/year (0.11–0.18 GiB),
437,500 reusable universe-membership rows/year (0.10–0.21 GiB), fewer than 25,000
run/signal/delivery/outcome/reference rows (<0.05 GiB), and an illustrative 75,000
bounded price-path rows (0.02–0.04 GiB). Thus the annual **total** planning range is
approximately **1.54M rows / 2.3–3.7 GiB** at low cadence, **5.94M rows /
12.8–20.5 GiB** at the 25-run base, and **6.94M rows / 15.2–24.3 GiB** at 30 runs.
These figures exclude WAL, backups, replicas, partition metadata and archive format
overhead, which must be budgeted separately. Unbounded full-universe minute paths
remain out of scope: 800 × 300 bars × 250 days would add 60M rows/year.

Final sizing and the Phase B physical design require a **read-only VPS scheduler
inventory and live Supabase catalog counts/sizes** (including actual runs/session,
evaluated rows/run, retry duplication, `pg_total_relation_size`, index sizes and
sample row widths). No migration should be finalized from repository estimates.

### Partition-key and uniqueness audit

PostgreSQL native partitioned-table primary/unique constraints generally must
include every partition-key column. B1 therefore deliberately creates its high-row
tables **unpartitioned** until the live PostgreSQL/Supabase version, cadence, sizes,
and query workload are confirmed. This makes every PK/unique constraint stated in
the ERD enforceable and avoids pretending that a globally unique UUID constraint
can be declared on a date-partitioned parent without the date.

The affected relations and valid forms for a possible later monthly-partitioning
migration are:

| Relation | Candidate partition key | Constraints that must change to include it |
|---|---|---|
| `evaluation_universe_snapshots` | `as_of_date` derived/stored from `as_of_ts` | PK/unique identity becomes (`as_of_date`,`universe_snapshot_id`,`ticker`); all referencing FKs carry `as_of_date`. |
| `evaluation_candidate_snapshots` | `feature_date` derived/stored from `feature_as_of_ts` | PK becomes (`feature_date`,`candidate_id`); evaluation uniqueness becomes (`feature_date`,`scan_run_id`,`ticker`,`candidate_revision`); child FKs carry `feature_date`. |
| `evaluation_fast_watcher_arms` | `observation_date` | PK and arm uniqueness include `observation_date`; its candidate FK must also carry the candidate's `feature_date` if candidates are partitioned. |
| `evaluation_price_paths` | `bar_date` derived/stored from bar start | PK and (`signal_id`,`interval`,`bar_start`,`source_version`) uniqueness include `bar_date`; consumers cannot assume global uniqueness without it. |

`evaluation_scan_runs` stays unpartitioned so (`strategy`,`logical_run_key`) remains
globally enforceable across scheduler sources. Signals, delivery attempts, outcomes,
configurations and experiments also stay unpartitioned under this plan. A later
partition migration must prove the composite FK/unique forms on the confirmed
PostgreSQL version and backfill/validate dates before switching; application-level
deduplication is not an acceptable substitute for database constraints.

Start with narrow indexes: run logical identity; candidates
(`scan_run_id`,`ticker`) and BRIN feature time; signals (`setup_id`, published time);
delivery logical key/status; outcomes (signal,label version); BRIN path time plus
signal/bar uniqueness. Avoid indexing JSONB and low-selectivity booleans by default.
Prefer integer basis points/scaled integers or bounded `numeric(p,s)` after sampling
actual ranges; avoid unconstrained `numeric` and duplicate indexes.

Proposed retention after a later partitioning decision is 90 days hot for raw
candidate/watcher/path data; keep runs, published signals, delivery audit,
configuration and experiment registries, and outcomes hot for
at least two years. After 90 days, detach/export raw partitions to checksummed,
encrypted object storage (Parquet), verify manifest/count/min-max/hash, then drop
only under a reviewed retention job. Keep enough archived raw history to reproduce
all retained outcomes. Create next partitions ahead of time; monitor bloat/size and
failed inserts; `ANALYZE` new partitions after meaningful loads and rely on
autovacuum for append-heavy facts. No archive/delete occurs in Phase B.

## 4. RLS, privileges, and write ownership

Every evaluation table is server-only:

1. Create under the existing server schema convention (`public` unless a read-only
   live catalog review supports a private schema), enable **and force** RLS.
2. Revoke all table/sequence privileges from `PUBLIC`, `anon`, and `authenticated`;
   grant no browser role policy and expose no API endpoint.
3. Grant only required `SELECT/INSERT` and narrowly scoped lifecycle `UPDATE` to a
   dedicated evaluation writer role if Supabase deployment supports it. Otherwise,
   service role is the documented temporary writer, protected by server-only
   credentials; RLS bypass alone is not treated as least privilege.
4. Candidate/reference/signal facts are append-only. A security-definer function
   with fixed `search_path`, ownership checks and transition checks is preferred for
   scan lifecycle completion and delivery attempt status. Revoke its execute from
   public/browser roles.
5. A later labeler role may receive insert/select only on outcomes and selected
   inputs, not candidate mutation or delivery rights. Promotion metadata similarly
   belongs to a reviewer function/role. No browser mutation path exists.

Phase B SQL tests must inspect `relrowsecurity`, `relforcerowsecurity`, policies,
ACLs, default privileges, sequence ACLs and function execute grants, and must prove
`anon`/`authenticated` cannot select or mutate while the intended server writer can.

## 5. Staged rollout and rollback

* **B1—foundation draft, still unapplied/default-off:** separate configuration and
  experiment registries, universe, runs, candidates, signals and delivery-attempt
  contract; SQL contract tests; canonical config/gate normalizers; a no-op adapter
  whose disabled path performs no client creation/write and returns the existing
  value unchanged. High-row B1 tables remain unpartitioned so all proposed unique
  constraints are valid. Do not wire producers.
* **B2—reference/counterfactual draft:** dated mapping/market-rule/cost tables and
  paired watcher arms, only after authoritative source and paired-arm invariants are
  approved. Still default-off.
* **B3—label/path draft:** bounded point-in-time path ingestion and immutable
  versioned labels after source, execution contract, retention and labeler role are
  approved.
* **Phase C (separate approval/review):** apply reviewed DDL outside this PR, enable
  one bounded observational producer, compare original outputs byte-for-byte,
  measure latency/failure/volume, then expand deliberately. Evaluation failure is
  fail-open and cannot block a current decision or send.

Rollback before application is deleting/reverting draft files. After a separately
approved application, first disable the evaluation flag (writer becomes no-op),
preserve evidence, and revoke writer grants. Roll back application code independently.
Drop only new `evaluation_*` objects in reverse FK order using a separately reviewed
script after export/verification; never touch existing screener, Telegram, watcher,
or production-data objects. Additive writer failure must not trigger rollback of
current operational transactions.

## 6. Unresolved decisions / approval gates

1. Read-only live catalog dump: actual schema drift, row counts/sizes, RLS/policies,
   grants/default privileges, extensions, Postgres version and partition support.
2. Exact scheduler names, exchange slots, ad-hoc rerun semantics and canonical
   logical-run-key version; ownership of terminal lifecycle transitions.
3. Stable setup-ID derivation for Swing and Top 5, and mapping rules for legacy
   Day Trade/Fast Watcher/Telegram IDs.
4. Complete allow-lists and type/range limits for component scores, rejection codes,
   gate names/operators, levels and JSON size; whether normalized component/gate
   child tables outperform bounded JSON at measured volume.
5. Authoritative dated universe, Konglo, tick-size and auto-reject sources; timezone,
   corrections and overlapping-validity policy.
6. Whether a dedicated DB writer/labeler role can be provisioned in Supabase or the
   server service role must be the temporary convention.
7. Valid volume-seasonality source and minimum sample sizes; it remains nullable.
8. Execution contract decisions (order/gap/tick/slippage/ambiguity/capacity), price
   path vendor/licensing, capture interval and missing/stale-bar policy.
9. Measured row width/load latency, hot/archive duration, object-store destination,
   encryption/restore drill, deletion authority and budget ceiling.
10. Label versions, horizon definitions, purge/embargo sensitivity grid, outcome
    job ownership and experiment promotion workflow.
11. Whether Phase B is one unapplied draft covering B1 only or separate draft files
    for B1/B2/B3. This design recommends B1 only first.

## 7. Proposed Phase B file list (not created)

Subject to explicit approval, B1 should add only:

* `supabase/screener-evaluation-logging-v2-foundation-draft.sql` — unapplied,
  additive foundation DDL and explicit grants/RLS.
* `supabase/screener-evaluation-logging-v2-foundation-rollback-draft.sql` — new
  objects only, reverse dependency order, never automatically run.
* `lib/screener-evaluation-contract.js` — pure canonical JSON/hash and bounded gate
  normalization.
* `lib/screener-evaluation-logger.js` — default-off/no-op adapter; no producer
  wiring and no new endpoint.
* `test/screener-evaluation-contract.test.js` — canonicalization, hash, gate schema,
  rejected candidate and raw-versus-capped score fixtures.
* `test/screener-evaluation-logger.test.js` — disabled means no client/write and
  unchanged returned production value.
* `test/sql/screener-evaluation-logging-v2.contract.sql` — keys, cross-scheduler
  logical uniqueness, lifecycle, versioned outcomes contract, RLS/grants and
  rollback-scope assertions, separate reusable configuration/experiment identity,
  and verification that B1 does not declare invalid partitioned uniqueness
  (outcome/path tables may be skeletal or deferred per the approved B1 boundary).
* `tools/validate-screener-evaluation-v2.js` — static SQL/contract checks usable
  without a production connection.

No Phase B file should modify `api/sector-hot.js`, any scorer/watcher/publisher,
Vercel configuration, schedule, or `data/intraday-*`. API function count must stay
exactly 12.
