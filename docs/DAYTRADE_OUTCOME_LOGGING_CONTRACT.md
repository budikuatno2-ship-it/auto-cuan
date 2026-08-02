# Day Trade outcome companion contract (Phase B0.4)

## Boundary and architecture audit

The B0.2/B0.3 `classification_initial` gzip records are finalized calculation-point evidence. The existing adapter captures the engine's initial status, gates, raw levels, code SHA, and configuration hash; the existing logger finalizes those records under `raw/` with companion manifests. Retention treats those finalized files as immutable. Production monitor and report outcome helpers operate on mutable delivery/monitor state and therefore are not safe evidence sources for this phase.

The safest design is a **separate append-only companion tree**, `outcomes/` plus `outcome-manifests/`. An outcome links to the SHA-256 digest of one canonical, validated initial record. It never opens, appends to, renames, or rewrites a B0.2/B0.3 gzip or manifest. This phase provides pure library plumbing only: no CLI, live sample, schedule, workflow, network call, database write, notification, or production wiring exists.

## Labels and deterministic rules

* `UNFILLED`: no ordered observation spans the snapped entry before the horizon. Its terminal touch label may be `EXPIRED`, but all return, R, cost, MFE, and MAE fields remain null. It is never a loss.
* `FILLED`: the first ordered OHLC observation whose low/high range spans the snapped entry. Fill time is that observation timestamp and fill price is the snapped entry.
* `UNRESOLVED`: evidence ends before the declared horizon and cannot establish the bounded entry state. `EVIDENCE_HORIZON_INCOMPLETE` records why.
* `TP1_FIRST` / `SL_FIRST`: after fill, the earliest ordered bar touches the snapped target or stop. If both occur in one bar and no finer ordering exists, the mandatory convention is `PESSIMISTIC_SL_FIRST`; both touches are retained at that bar timestamp.
* `EXPIRED`: the evidence boundary reaches the horizon without a TP1/SL touch. A filled expiration exits at the last supplied close at or before the horizon; an unfilled expiration has no synthetic exit or return.
* `UNRESOLVED`: the touch result is not final because the caller's evidence boundary is short of the horizon.

Bars must be strictly time-ordered, unique, for one ticker, no earlier than initial observation, and no later than the declared evidence boundary. Each bar carries bounded provenance and a source-as-of timestamp. The evaluator makes no request and reads no mutable production state.

MFE and MAE are the greatest post-fill bar high and least post-fill bar low relative to fill price, with the observation timestamps. Gross return uses the deterministic target, stop, or expiration close. Gross R divides gross return by snapped entry-to-stop risk. Caller-supplied fee, tax, spread, and slippage components are summed; net return is gross return minus that sum, and net R uses the same risk denominator.

## Explicit policy and provenance

The caller must supply a versioned policy containing currency; positive tick size; entry, stop, and target snap directions; and version, rate, fixed amount, and provenance for fees, taxes, spread, and slippage. There are deliberately no remembered BEI rules or defaults. Policy identity participates in the outcome identity, so changing any declared policy version creates a distinct evaluation contract rather than silently changing old evidence.

OHLC bars cannot prove within-bar event order. They also cannot prove a fill within the spread, queue priority, partial fill, capacity, or exchange rejection. Those facts require finer authoritative point-in-time evidence. This contract records the conservative ambiguity rather than inventing it.

## Storage safety

Every record is exact-key validated, cross-field checked, secret-scanned, byte-bounded, canonically serialized, and self-hashed before logger creation. Whole-tree preflight rejects symlinks, special or unexpected files, `.open`/temporary files, either quarantine tree, orphan gzip or manifest artifacts, checksum/count mismatches, path escape, missing initial linkage, non-one-to-one mappings, and duplicate outcome identity. A successful writer creates one gzip record atomically paired with a strict checksum manifest. Collection remains manual-only and unwired in B0.4.
