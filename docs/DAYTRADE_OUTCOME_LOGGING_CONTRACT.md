# Day Trade outcome companion contract (Phase B0.4)

## Boundary and architecture audit

B0.2/B0.3 `classification_initial` gzip records are finalized calculation-point evidence. The adapter captures the initial status, gates, raw levels, code SHA, and configuration hash; the existing logger finalizes them under `raw/` with manifests. Production monitor/report helpers rely on mutable delivery state and are not admissible evidence here.

B0.4 therefore uses a **separate append-only companion tree**, `outcomes/` plus `outcome-manifests/`. Each outcome links to the canonical SHA-256 digest of exactly one validated initial record. It never opens, appends to, renames, or rewrites initial evidence. This phase adds pure libraries only: no CLI, live sample, scheduler, workflow, network, database, notification, or production wiring.

## Coverage, fill, and labels

A boundary timestamp is not proof of observation. The caller supplies a versioned coverage declaration with exact interval duration, horizon start/end, completeness assertion, and provenance. The evaluator independently proves that non-overlapping bars are contiguous, each has the declared duration, the first begins at initial observation, and the last ends at the horizon. Zero bars, sparse evidence, internal gaps, a short final bar set, or a false declaration produce `UNRESOLVED` with `EVIDENCE_COVERAGE_INCOMPLETE`; they can never finalize `UNFILLED` or `EXPIRED`.

* `UNFILLED`: complete coverage contains no bar spanning the snapped entry. It terminates as `EXPIRED`, but return, R, costs, MFE, and MAE are null. It is never a loss.
* `FILLED`: the first complete bar spanning the snapped entry. Fill time is that bar's end timestamp, fill price is the snapped entry, and `source_as_of` is copied from that actual bar—not the final evidence boundary.
* `TP1_FIRST` / `SL_FIRST`: the first post-fill bar touches the snapped target or stop. If both occur in one bar, `PESSIMISTIC_SL_FIRST` applies.
* A fill bar whose high also reaches TP1 cannot prove that TP occurred after entry and is `UNRESOLVED` with `FILL_BAR_ORDER_UNPROVEN`. A fill bar containing SL is conservatively `SL_FIRST`. No fill-bar extrema are included in excursions.
* `EXPIRED`: proved complete coverage reaches the horizon without a TP/SL touch. A filled expiration exits at the final close; an unfilled expiration has no synthetic return.

MFE/MAE use only complete bars strictly after the fill bar and strictly before a TP/SL exit bar. Exit-bar extrema are excluded because they may occur after the first touch. If no such bars exist, excursions are explicitly `UNRESOLVED` with null values and `EXCURSION_ORDER_UNPROVEN` rather than invented from ambiguous OHLC ordering.

## Explicit execution policy and arithmetic

There are no remembered BEI defaults. The caller supplies one canonical versioned policy containing:

* a versioned `ENTRY_LOW` or `ENTRY_HIGH` reference rule and provenance;
* a versioned contiguous tier table with price bounds, tick sizes, and provenance; entry snaps up, stop down, and target up using the tier resolved at each raw level;
* positive quantity, price unit, and currency, defining entry and exit notionals;
* every fee, tax, spread, and slippage item with component, version, unit (`RETURN_FRACTION` or `CURRENCY`), side (`BUY` or `SELL`), basis (`ENTRY_NOTIONAL` or `EXIT_NOTIONAL`), value, and provenance.

Currency-fixed costs are divided by declared entry notional, never price alone. Fractional buy costs apply to entry notional and fractional sell costs to exit notional. The record retains each currency amount and normalized return fraction. Gross return is `(exit - fill) / fill`; gross R divides by snapped entry-to-stop risk; total cost is the exact component sum; net return is gross less cost; and net R uses the same risk. Validation recomputes every relationship.

The outcome identity binds initial digest, evaluator version, canonical full-policy hash, complete versioned horizon semantics (including evidence boundary), and the coverage model version plus interval. A materially changed policy, entry rule, tick tier, cost, execution size, horizon, or bar-coverage resolution cannot collide merely by reusing a version string. `market_date` is derived with the repository's Asia/Jakarta market-date function and is cross-checked against the verified initial manifest directory.

## Validation and storage safety

The v2 record uses exact keys, bounded arrays/strings/bytes, the existing canonical initial-record normalization, recursive secret/account/path rejection, canonical hashing, and an explicit state matrix. Fill, touch, excursion, and terminal-exit fields must be entirely populated or entirely null for their state. TP1 exits equal the snapped TP1, SL exits equal the snapped stop, and expiration exits identify the horizon-final close, timestamp, and source-as-of. Validation also recomputes snapping, conventions, coverage, evidence timestamps, completion, cost dimensions and arithmetic, return/R arithmetic, and the exact rejection-code set required by the observed ambiguity.

Whole-tree preflight rejects symlinks at every level, special/unexpected files, `.open` and temporary files, either quarantine tree, orphan raw or manifest artifacts, checksum/count failures, path escape, missing linkage, duplicate mappings, and duplicate outcome identities. It builds a digest-to-canonical-initial-metadata map and requires every `initial_link` field to match the exact selected record. It cross-validates every outcome-manifest identity field against its normalized record and reproduces the B0.3 shared run ID, code/config identity, run mode, scheduler source, scheduled slot, common observation time, unique ticker, date, and first/last timestamp invariants.

Outcome gzip bytes are first written to an exclusive `.open.jsonl.gz` file and atomically renamed to the final data path. The manifest is independently written through an exclusive temporary file and atomic rename. This guarantees atomic finalization of each artifact; it does **not** claim a transaction across both files. A crash between data and manifest leaves an orphan, which the next preflight rejects. Collection remains manual-only and unwired.

OHLC alone still cannot prove queue priority, partial fills, exchange rejection, or ordering within an ambiguous fill/exit bar. Those require finer authoritative point-in-time evidence; this contract records the limitation instead of manufacturing certainty.
