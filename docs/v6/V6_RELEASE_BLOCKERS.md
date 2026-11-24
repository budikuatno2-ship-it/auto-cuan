# V6 Release Blockers & Production Approval Checklist

**Date:** 2026-11-10T14:28:00+07:00 (Asia/Jakarta)
**Author:** Auto-Cuan Review & Engineering Team
**Review Target:** Auto-Cuan V6 Release
**Status:** ALL LOCAL FIXES VERIFIED — PRODUCTION ACTIONS REQUIRE EXPLICIT APPROVAL

---

## 1. Executive Summary

This document formalizes the operational gates, production safety constraints, and required approvals before running deployment scripts or modifying production configurations on the Auto-Cuan VPS infrastructure.

All code regressions, UI fixes, algorithm discrepancies, and chart rendering issues (covering 42 requirements) have been solved, unit tested, and regression-verified locally (`54/54 PASS`).

However, per institutional engineering guidelines and Addendum specifications, any actions that alter:
- Cron daemon or systemd timer configurations on VPS,
- PM2 runtime process definitions (`ecosystem.config.js`),
- Database migrations or production SQLite files on VPS,
- Feature flags enabling external quote requests (e.g., Short Swing Hourly Confirmation),
**MUST NOT be run autonomously on VPS without explicit user sign-off.**

---

## 2. Release Blockers Status Matrix

| ID | Category | Item | Local Status | VPS Production Status | Blocker Level | Action Required / Approval |
|---|---|---|---|---|---|---|
| **BLK-01** | Short Swing Hourly Confirmation | Feature flag default state | Verified `OFF` (`FEATURE_SHORT_SWING_HOURLY=false`) | Flag is absent / disabled | **SAFE (NO BLOCKER)** | Remains disabled until market hours testing is scheduled. |
| **BLK-02** | Daytrade FastWatcher Cutover | Legacy cron disablement & fastwatcher cutover | Cutover plan documented (`V6_DAYTRADE_FASTWATCHER_CUTOVER.md`) & tested locally | Old cron jobs currently active on VPS | **ACTION BLOCKED (Awaiting Sign-off)** | User must approve executing cutover script during market close (weekend/night). |
| **BLK-03** | Stock Arjum Quota Cap | 18,080 daily quota protection & 5,000 floor | Verified in `lib/quota-manager.js` and pipeline tests | Operational on VPS | **SAFE (NO BLOCKER)** | Hard-lock invariant enforced. |
| **BLK-04** | Ownership HSC Fail-Closed | HSC reconciliation null state handling | Verified in `lib/admin-ownership-import.js` and tests | Ready for deployment | **SAFE (NO BLOCKER)** | Backward compatible. |
| **BLK-05** | Chart Engine Dual Feed | Yahoo Stooq fallback & P0 deviasi plan rejection | Verified in `lib/chart-engine/candle-fetcher.js` and tests | Ready for deployment | **SAFE (NO BLOCKER)** | Non-breaking patch. |
| **BLK-06** | VPS Crontab Overhaul | VPS schedule deconfliction (14 active jobs) | New non-overlapping schedule drafted (`V6_SCHEDULE_ACTUAL_VS_PROPOSED.csv`) | Current cron intact | **ACTION BLOCKED (Awaiting Sign-off)** | Requires cron update on VPS via staged maintenance window. |

---

## 3. Production Deployment Sign-Off Checklist

Before promoting V6 candidate HEAD to production:

- [x] Full local test suite passes (`54/54 PASS`).
- [x] Zero credential leaks in codebase and payload.
- [x] Complete review package generated with verified SHA-256 manifest.
- [ ] Explicit user approval obtained for VPS cron modification.
- [ ] Explicit user approval obtained for PM2 process cutover.
- [ ] Staging dry-run executed on non-trading window (after 20:30 WIB or weekend).
- [ ] Emergency rollback procedure reviewed and verified (`v5-rollback.sh`).

---

## 4. Conclusion
There are **zero code-level blockers**. All operational changes impacting VPS scheduling and process execution are gated behind documented runbooks awaiting human operational sign-off.
