# V5 CLAIM SCOPE — Fabrication Remediation (Honest Boundaries)

**Commit:** `fix(v5): review remediation — quota settle locking, ranking fabrication removal, degraded-mode guard, claim scope`
**Branch:** `feat/v5-recovery` (parent: `5e81950b`)
**Date:** 2026-11-06
**Status:** SUPersedes the repo-wide "synthetic data eliminated" claim made in the recovery commit message of `5e81950b` (commit messages are immutable — this document states the true, precise scope).

---

## 1. Purpose

The `5e81950b` commit message claims "eliminate synthetic market data" repo-wide. The independent review (`audit-evidence/v5/V5_INDEPENDENT_REVIEW.md`, findings R2/R3) proved the claim was overstated: literal fabricated values survived in `api/ranking.js` and duplicated themselves in `tools/local-dev-server.js`. This document states precisely what was and was not fixed, after this remediation commit.

## 2. Fabrication removed — files fixed in this remediation

| File | Fabrication removed |
|---|---|
| `api/ranking.js` | Indexed fallback arrays (RSI / 52w-distance / volume-ratio); foreign-flow invention `p*v*0.18`, `×2.5`, `×4.2`; hardcoded GRPM block (`144776632` / `376419243` / `851286596`); hardcoded `as_of` `2026-10-30`; invented company names (`TICKER Tbk`), change%, streak, free-float default `35.0`. Now: real source `data/foreign-flow-multi-day.json` only; unknown ⇒ `null` + `data_status`; response shape backward compatible. |
| `tools/local-dev-server.js` (daily-market-context-list mock) | Same duplicated fabrication suite (fallback arrays, `p*v*0.18` derivation, GRPM block, sanity caps `15e9/35e9/60e9`, invented change%/streak/`as_of`). Now mirrors `api/ranking.js` real-source-only behavior. |
| `public/analisis-saham-runtime.js` | GRPM-special-cased invented display caps (`0.35` / `0.85` ≈ the fabricated GRPM numbers ÷ 1e9) and generic clamped replacements (`min(|f|/1000, 15)` / `35`); invented base score `50` when all score inputs unknown; `Number(null).toFixed(1)` rendering `0.0` for unknown RSI. Now: corrupt (≥ Rp 1,000 T) ⇒ `null` rendered `'—'`; score `null` when no known input; null ⇒ `'—'`. |
| `public/unified-cockpit-runtime.js` | (R4, not fabrication but related honesty fix) degraded-mode unguarded `root._chartPageData` write — now skipped entirely with `data_status: 'GUARD_UNAVAILABLE'` on the render state. |

## 3. Verification

- New test: `test/v5/ranking-integrity.test.js` (10/10 passed) — GRPM block gone, no `p*v*0.18`-style derivation in the output path, null-fields honored (unknown ⇒ null, real 0 survives), every non-null row value traced to the real source record.
- Extended test: `test/v5/quota-reservation.test.js` (16/16 passed) — R1 settle locking proof + N=50 mixed-operation consistency stress.
- Gate: `node test/v5/run.js --no-write` → **25 PASSED / 0 DETECTED / 0 BROKEN**.

## 4. Fabrication-signature grep (worktree-wide) and classification

Signatures: `144776632`, `376419243`, `851286596`, `0.18` (as derivation), `1550`, `1420`, `380` (as assigned literals), `GRPM` special-casing. Exclusions: `data/` artifacts (real source records), fixtures/mocks that are legitimate test data.

| Hit | Classification | Note |
|---|---|---|
| `data/foreign-flow-multi-day.json:3926-3931` (GRPM values) | REAL SOURCE RECORD | The producer's snapshot; consumed verbatim, never overridden. |
| `test/v5/negative.test.js:644,718` | FIXTURE (gate control) | Detection patterns for the fabricated constants — legitimate. |
| `test/v5/ranking-integrity.test.js` | FIXTURE (new test) | Asserts the constants are GONE — legitimate. |
| `tools/gates/gate-V4-F06.js` | FIXTURE (gate) | Regression gate asserting GRPM is sane — legitimate. |
| `tools/gates/gate-V4-F15.js:213` | FIXTURE (gate comment) | References the historical bug name — legitimate. |
| `api/quote.js:536` | FIXTURE (comment) | Historical note that the GRPM hardcode was removed — legitimate. |
| `scripts/inspect-live-video-flow-v4.js:627-641` | FIXTURE (bug detector) | Detects the '83.20 T' bug in live video QA — legitimate. |
| `scripts/foreign-compile.js:14,90,419` | UNRELATED / FIXTURE | Compile comments + ticker universe list; no fabricated value emitted. |
| `public/assets/idx-tickers.js:364` | UNRELATED | Official IDX company name directory. |
| `bukti-verifikasi-final/gates-v4/F06.json` | FIXTURE (historical evidence) | Recorded gate output; archival. |
| `api/pattern-radar.js:138,141` | UNRELATED | `0.18` is a Fibonacci-ratio tolerance (harmonic pattern math), not a flow derivation. |
| `api/sector-hot.js:3199` | UNRELATED | `0.18` is a range-tightness (VCP) threshold, not a flow derivation. |
| `api/admin-users.js:788` | UNRELATED | SVG path data (`shape: 'M2 22 …'`), not a price. |
| `api/admin-users.js:784` | UNRELATED | `target: 1550` is an admin pagination/config target, not a price literal. |
| `api/intel.js:11`, `api/screener.js:12` | FIXTURE (comments) | Documentation of the previously-removed fabricated constants — legitimate. |

**Residual fabricated-constant sites in live code paths after this commit: NONE known.**

## 5. Honest residual-risk list (updated, shorter than the review's)

1. **`lib/market-data-contract.js` consumer coverage is not exhaustive.** Other API surfaces may still emit fields without `data_status` provenance. They were scanned for the *known* signatures above and found clean, but a field with no real source and no literal signature could still emit `undefined`/`0` ambiguously. (Mitigation: N8 control.)
2. **Ranking rows have many null fields by design.** `rsi_14`, `week52_high_dist_pct`, `volume_ratio_vs_7d_avg`, `change_pct`, `company_name`, `free_float_pct`, `foreign_net_streak` have no verified real source wired to this endpoint; they are honestly `null` / `'—'`. Wiring real sources (e.g., daily candles for RSI/52w) is future work, not fabrication.
3. **`data/foreign-flow-multi-day.json` freshness depends on its producer** (`scripts/foreign-compile.js`). If the producer stops, the endpoint correctly degrades to `SOURCE_UNAVAILABLE`/`NOT_PUBLISHED` — this is by design.
4. **Quota settle lock-busy** now preserves the reservation and records a pending-settle JSONL trace (`data/quota-settle-pending.jsonl`); no automatic re-drive of pending settles exists yet (operator retries). The reservation is never lost; the settle may be delayed.
5. **`bukti-verifikasi-final/gates-v4/F06.json`** contains the historical GRPM numbers as recorded gate evidence. It is archival and inert, but it is NOT rewritten (append-only evidence policy).

## 6. What this commit does NOT claim

- It does NOT claim every API in the repo emits full contract provenance (`data_status`) — only `api/ranking.js` was rewritten in this remediation.
- It does NOT claim the frontend renders `'—'` for every possible null field repo-wide — only the ranking-table surfaces that consume the rewritten endpoint were audited and fixed.
- It does NOT amend or rewrite history; `5e81950b`'s message stands, and this document is the authoritative correction of its claim scope.
