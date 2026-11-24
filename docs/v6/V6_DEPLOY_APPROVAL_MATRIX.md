# V6 Deploy Approval Matrix

**Document:** `docs/v6/V6_DEPLOY_APPROVAL_MATRIX.md`
**Branch:** `feat/v6-recovery`
**Date:** 2026-11-12

Every production-facing stage of the V6 release requires explicit approval.
Stages are ordered; no stage may begin until its prerequisites are complete.

| # | Stage | Who requests | Who approves | Condition / evidence | Blocking? |
|---|---|---|---|---|---|
| 1 | Review ZIP artifact (source + fixtures + tests) | Engineer | Reviewer | Read-only review; no approval but prerequisite | no |
| 2 | Push branch / open PR → `feat/daytrade-screener-v1` | Engineer | Repo owner | `feat/v6-recovery` clean, secrets scan clean | yes |
| 3 | Integration review (gates + regression) | Engineer | Reviewer/owner | `test/v6-*` + `admin-session-auth` green | yes |
| 4 | Staging dry-run (non-trading window) | Engineer | Operator | after 20:30 WIB or weekend | yes |
| 5 | Production backup (`VACUUM INTO` + SHA-256 + integrity) | Operator | Owner | snapshot + hash recorded | yes |
| 6 | Production deploy (git cutover + `npm install`) | Operator | Owner | backup verified first | yes |
| 7 | Scoped PM2 reload (`auto-cuan-vps-api` + `autocuan-web`) | Operator | Owner | no `restart all` | yes |
| 8 | Post-deploy smoke + monitoring | Operator | (recorded) | HTTP 200, quota > floor, integrity ok | no |

---

## Operator-guarded production mutations (require separate sign-off)

| Item | Guard | Sign-off |
|---|---|---|
| Broksum hotfix `chmod` | file perms | owner |
| Quota policy bridge cutover | `lib/quota-policy-bridge.js` | owner |
| Scheduler cutover (Broksum 20:00 → compile 21:20) | `lib/admin-schedule-store.js` collision guard | owner, maintenance window |
| Daytrade FastWatcher cron→stream | `lib/intraday-fast-watcher.js` cutover | owner, market close |
| Hourly flag enablement | feature flag default OFF | owner |

---

## Oracle / OCI evidence still required

- Root/sudo to read `dmesg` OOM log (currently `Operation not permitted`).
- OCI/IMDS shape string (currently 403 for `ubuntu`) or OCI console 7-day
  monitoring — not reachable via read-only SSH ⇒ `OBSERVATION_REQUIRED`.
- See [`V6_ORACLE_MEASUREMENTS_READONLY.csv`](V6_ORACLE_MEASUREMENTS_READONLY.csv:1).

---

## Approval log

| Date | Stage | Approver | Result |
|---|---|---|---|
| — | all | — | PENDING |