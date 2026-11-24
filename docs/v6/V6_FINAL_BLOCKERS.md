# V6 Final Blockers & Production Approval Checklist

**Date:** 2026-11-12T18:24:00+07:00 (Asia/Jakarta)
**Author:** Auto-Cuan Remediasi V6 (Subtask L)
**Branch:** `feat/v6-recovery`
**Status:** LOCAL REMEDIATION + STAGING VALIDATION VERIFIED — PRODUCTION ACTIONS REQUIRE EXPLICIT APPROVAL

---

## 1. Executive Summary

Subtask L consolidates Ops & Release Safety: Oracle Always Free read-only
measurements, security/auth audit, staging-validated runbook + rollback, and a
deploy approval matrix. The previous runbook's wrong `getStatus()` method and
unsafe read-only `wal_checkpoint` are corrected and proven against the real
source contracts.

Local suites (24 rollback+scheduler tests, 26 auth/security tests) pass.

Remaining blockers are **operational only** (production cron/PM2/database
changes, Broksum chmod, quota bridge, scheduler cutover, hourly flag) plus
Oracle telemetry gaps requiring root/OCI access.

---

## 2. Scheduler Reconciliation Result

- **Single source of truth:** `lib/admin-schedule-store.js` (`JOB_CATALOG`) and
  [`docs/v6/V6_SCHEDULER_ACTIVE_INVENTORY.csv`](V6_SCHEDULER_ACTIVE_INVENTORY.csv:1).
- **Broksum default locked at `20:00` WIB**; **`domestic-compile` at `21:20` WIB**
  (NOT 20:25), enforced by collision guard. A `20:25` save is rejected with `COLLISION`.
- Prior CSV disagreement resolved.

---

## 3. Rollback / Data-Safety Fix (Subtask L correction)

The old [`V6_RELEASE_AND_ROLLBACK.md`](V6_RELEASE_AND_ROLLBACK.md:1) used three
defects now verified and fixed:

| Old defect | Correction (validated) |
|---|---|
| `cp -r data` + `cp market.sqlite` | `VACUUM INTO` consistent snapshot (reads WAL) |
| `PRAGMA wal_checkpoint(TRUNCATE)` on `-readonly` connection | Removed — checkpoint is a write op, invalid on read-only; `VACUUM INTO` suffices |
| `quota-manager.getStatus()` | `getQuotaStatus()` (verified export; `getStatus` is `undefined`) |
| `pm2 restart all` | scoped `pm2 reload`/`restart` only `auto-cuan-vps-api` + `autocuan-web` |

Evidence: [`V6_RELEASE_RUNBOOK_VALIDATED_STAGING.md`](V6_RELEASE_RUNBOOK_VALIDATED_STAGING.md:1),
[`V6_ROLLBACK_FIXTURE_RESULTS.md`](V6_ROLLBACK_FIXTURE_RESULTS.md:1).

---

## 4. Security / Auth (Subtask L consolidation)

Signed admin session (HMAC, fail-closed), CSRF same-origin, authorization role
check, append-only tamper/audit JSONL, and non-admin forbidden tests are all
covered. Admin security panel is fail-closed ("UNAVAILABLE"/dated), never a
hardcoded "Aman/0 insiden".

Evidence: [`V6_SECURITY_AUTH_AUDIT.md`](V6_SECURITY_AUTH_AUDIT.md:1),
[`V6_ADMIN_SECURITY_AUTH_E2E.md`](V6_ADMIN_SECURITY_AUTH_E2E.md:1).

---

## 5. Test Evidence

| Suite | Tests | Result |
|---|---|---|
| `test/v6-scheduler-collision-regression.test.js` | 14 | **14/14 PASS** |
| `test/v6-rollback-sqlite-safety.test.js` | 10 | **10/10 PASS** |
| `test/admin-session-auth.test.js` + `test/v6-admin-security.test.js` | 26 | **26/26 PASS** |
| `test/v6-release-runbook-validation.test.js` | new | PASS (see below) |

---

## 6. Release Blockers Matrix

| ID | Category | Item | Local Status | Production Status | Blocker Level | Action / Approval |
|---|---|---|---|---|---|---|
| BLK-01 | Short Swing Hourly | feature flag default `OFF` | Verified | Disabled | SAFE | Remain OFF; hourly flag enable needs sign-off |
| BLK-02 | Daytrade FastWatcher | cutover cron→stream | Planned | Old cron active | ACTION BLOCKED | Sign-off during market close |
| BLK-03 | Arjum Quota | 5,000 floor hard-lock + policy bridge | Verified | Operational | SAFE | Invariant enforced |
| BLK-06 | VPS Crontab Overhaul | Broksum 20:00 → compile 21:20 | New non-overlap | VPS cron legacy (19:45/20:25) | ACTION BLOCKED | Maintenance window |
| BLK-07 | SQLite Rollback | `VACUUM INTO` + scoped (no readonly checkpoint) | FIXED + validated | Legacy runbook | SAFE (code) | Apply new runbook on next deploy |
| BLK-08 | Oracle Resource | shape/OOM telemetry gaps | Read-only measured | Root/OCI missing | BLOCKED (evidence) | Root/OCI audit |
| BLK-09 | Broksum hotfix `chmod` | file perms | Planned | Not applied | ACTION BLOCKED | Owner sign-off |
| BLK-10 | Quota bridge cutover | `lib/quota-policy-bridge.js` | Verified | Not cut over | ACTION BLOCKED | Owner sign-off |
| BLK-11 | Hourly flag | feature flag | Verified | Not enabled | ACTION BLOCKED | Owner sign-off |

---

## 7. Oracle / Production Blocker Detail

- IMDS shape string unreadable (`403`) → shape inferred 1 OCPU / 6 GB from
  `nproc=1` + `MemTotal 6045356 kB`.
- `dmesg` OOM log inaccessible (`Operation not permitted`); `journalctl -k` is
  readable and contains **no OOM/o** lines; kernel `oom_kill` counter = `0`.
- 7-day `sar` CPU/MEM history available; steady 48–51% mem, mostly idle CPU.
- OCI 7-day monitoring not reachable via SSH ⇒ `OBSERVATION_REQUIRED`.
- No `/home/ubuntu/backups` structured dir; ad-hoc `.bak`/`.pre-v5deploy` only.
- Synthetic keepalive busy-loop present — flagged, not executed.

Full data: [`V6_ORACLE_MEASUREMENTS_READONLY.csv`](V6_ORACLE_MEASUREMENTS_READONLY.csv:1).

---

## 8. Required Approvals Before Production

- [ ] PR/push to `feat/daytrade-screener-v1` (repo owner).
- [ ] Integration review + staging dry-run (non-trading window).
- [ ] Production backup (VACUUM INTO + SHA-256 + integrity).
- [ ] Production deploy + scoped PM2 reload (`auto-cuan-vps-api` + `autocuan-web`).
- [ ] Broksum chmod, quota bridge, scheduler cutover, hourly flag sign-offs.
- [ ] Root/OCI access to close shape + OOM telemetry gaps.

Matrix: [`V6_DEPLOY_APPROVAL_MATRIX.md`](V6_DEPLOY_APPROVAL_MATRIX.md:1).

---

## 9. Conclusion

No code-level blockers remain locally. Runbook method names are reconciled to
source, rollback is WAL-safe and staged, security/auth is audited, Oracle
read-only metrics are recorded with explicit UNKNOWN/OBSERVATION_REQUIRED flags.
Remaining work is operational approval + Oracle telemetry closure.