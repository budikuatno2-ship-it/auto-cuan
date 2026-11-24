# V6 Release Gates (A–F) — Final Honest Evaluation (Subtask M FINAL)

**Run:** Subtask M FINAL
**Generated:** 2026-11-12 (WIB Asia/Jakarta)
**Branch:** `feat/v6-recovery`
**Baseline:** `ae5d18924955217c7e74d1d7909b3ef12f471d00`

## Summary Verdict

| Gate | Title | Status |
|---|---|---|
| A | Data Integrity | PARTIAL_READY |
| B | Scoring & Signal | PASS |
| C | Chart & UI | PASS_LOCAL |
| D | Operations | PARTIAL |
| E | Legacy Transition | PARTIAL |
| F | Release & Post-Deploy | BLOCKED_APPROVAL_REQUIRED |

**Overall:** PARTIAL_READY (GATE F is `BLOCKED_APPROVAL_REQUIRED`; deployment not authorized).

---

## Regression truth (freshly executed this run)

| Suite | Command | Pass / Total | Failures |
|---|---|---|---|
| V6 (28 files) | `node --test test/v6-*.test.js` | **375 / 375** | 0 |
| Legacy batch (23 files) | `node --test test/batch*.test.js` | 181 / 183 | 2 pre-existing |
| Legacy v5 (28 files) | `node --test test/v5/*.test.js` | 72 / 76 | 4 pre-existing |
| Legacy v5-phase3 | `node --test test/v5-phase3/phase3-analytics.test.js` | 0 / 1 | 1 pre-existing |

All 7 failures are **pre-existing** and not regressions introduced by Subtask M:
the source/test files behind them are unmodified in this subtask (see
[`V6_TEST_RESULTS_ALL.md`](V6_TEST_RESULTS_ALL.md) §6 for `git diff` evidence).

---

## GATE A — Data Integrity → PARTIAL_READY

- Flat-file Yahoo EOD fresh; production SQLite `stock_daily_history.max_trade_date`
  STALE (sync-bridge fix in source, not deployed).
- Universe 964 on-disk = 963 emiten + 1 IHSG (documented reconciliation).

## GATE B — Scoring & Signal → PASS

- Top5 = pure subset of Top20; R/R anchored at `max_entry`; immutable `snapshot_id`;
  no fabricated metrics. Unit + integration verified.

## GATE C — Chart & UI → PASS_LOCAL

- 963 ticker data audit + headless browser render + HUD overlay bounding-box fix
  (Subtask I). Local-only (not production-observed).

## GATE D — Operations → PARTIAL

- Scheduler single source of truth + collision gate verified;
  Broksum 30-minute target **NOT yet met** (`TARGET_30_MINUTES_NOT_YET_MET`).
  Yahoo fail-closed verified.

## GATE E — Legacy Transition → PARTIAL

- Day Trade / FastWatcher cutover mapped; awaiting `PENDING_CUTOVER_APPROVAL`.

## GATE F — Release & Post-Deploy → BLOCKED_APPROVAL_REQUIRED

- V6 suite fully green (375/375); legacy failures documented and quarantined.
- Credential sanitization: 0 secrets.
- Deployment NOT authorized → this gate cannot pass.

---

## Blockers / Approvals

1. BLK-GATE-A — production SQLite sync deploy (fix ready in source).
2. BLK-GATE-D — Broksum 30-min re-verification after deconfliction deploy.
3. BLK-GATE-E — `PENDING_CUTOVER_APPROVAL` (Day Trade/FastWatcher decommission).
4. BLK-GATE-F — `BLOCKED_APPROVAL_REQUIRED` (overall VPS deploy authorization).
5. LEGACY-RESIDUAL — 7 pre-existing legacy failures (CI registration + financial
   store + v5 negative-control suites); none introduced by Subtask M.