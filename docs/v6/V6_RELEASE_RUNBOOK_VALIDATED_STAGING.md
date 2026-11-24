# V6 Release Runbook — Validated in Staging

**Document:** `docs/v6/V6_RELEASE_RUNBOOK_VALIDATED_STAGING.md`
**Branch:** `feat/v6-recovery`
**Date:** 2026-11-12

This document records the **command-level** validation of the release/rollback
runbook against the actual source contracts, executed in a non-production
staging context. It proves that every runbook command references methods/exports
that really exist, that the rollback fixture works end-to-end, that no read-only
`wal_checkpoint` remains, and that PM2 is always scoped (never `restart all`).

---

## 1. Export/method name reconciliation (runbook vs source)

| Runbook reference | Source contract | Result |
|---|---|---|
| `require('./lib/quota-manager').getQuotaStatus()` | [`lib/quota-manager.js`](../../lib/quota-manager.js:138) exports `getQuotaStatus` + alias `calculateQuotaState` | **MATCH** |
| `getStatus()` (old runbook) | **does not exist** in `lib/quota-manager.js` (`typeof m.getStatus === 'undefined'`) | **FIXED → getQuotaStatus** |
| `lib/sqlite-rollback-safety.consistentSnapshot` | exported | **MATCH** |
| `lib/sqlite-rollback-safety.integrityCheck` / `sha256File` / `buildScopedRestartPlan` | exported | **MATCH** |
| `tools/v6-rollback-fixture.js` CLI | exits `0` on PASS | **MATCH** |

Verification evidence (local):

```text
node -e "const m=require('./lib/quota-manager'); console.log(typeof m.getQuotaStatus, typeof m.getStatus)"
=> getQuotaStatus: function   getStatus: undefined
```

---

## 2. WAL-safe rollback — no read-only checkpoint

- Old runbook carried `sqlite3 -readonly $DB "PRAGMA wal_checkpoint(TRUNCATE);"`.
  `PRAGMA wal_checkpoint` is a **write** operation and is invalid on a read-only
  connection. The revised runbook removes that line entirely; `VACUUM INTO`
  already reads a transactionally consistent snapshot (including WAL), so no
  manual checkpoint is needed.
- `PRAGMA wal_checkpoint` remains only inside the Node primitive
  [`lib/sqlite-rollback-safety.js#checkpointWal`](../../lib/sqlite-rollback-safety.js:12),
  which operates on a **read-write** `DatabaseSync` connection
  (never `-readonly`), and is only a pre-step before `VACUUM INTO`.

Verified by: [`test/v6-rollback-sqlite-safety.test.js`](test/v6-rollback-sqlite-safety.test.js:1)
(10/10 PASS) and the fixture CLI.

---

## 3. PM2 scoped reload / restart (never `restart all`)

- `buildScopedRestartPlan` flags tokens containing `pm2 restart all` as
  `dangerous:true`, and permits only `auto-cuan-vps-api` / `autocuan-web`.
- Revised runbook Langkah 4 uses `pm2 reload auto-cuan-vps-api` +
  `pm2 reload autocuan-web`; rollback Langkah 2 uses scoped `pm2 restart`.

Verified by: [`test/v6-rollback-sqlite-safety.test.js`](test/v6-rollback-sqlite-safety.test.js:138)
"scoped PM2 restart plan never emits restart all".

---

## 4. Staging command execution (real commands, no production write)

Executed locally/staging (throwaway SQLite in `os.tmpdir()`):

```text
node tools/v6-rollback-fixture.js --json
=> { ok:true, stages:{ seed:{rows:5}, snapshot:{ok:true,stage:"SNAPSHOT"},
     backupHash:"f4fc38ac2f9b24715bbde74997b6a69061cb414f702350717ec40addf33a6966",
     afterBadMigration:{rows:1}, restoreIntegrityOk:true, restoredRows:5,
     restoredFirstValues:["pre-1".."pre-5"], validation:{ok:true,reason:"VALID"} } }
```

This proves the real sequence seed → snapshot (VACUUM INTO) → mutate → restore →
hash + integrity all work against the actual primitives. It does NOT touch
`/home/ubuntu/auto-cuan-data/market.sqlite`, PM2, cron, or any production path.

---

## 5. Release sequence requiring approval

1. Review ZIP artifact (source + fixtures + tests) — no approval needed (read-only review).
2. Push branch `feat/v6-recovery` / open PR → `feat/daytrade-screener-v1` — **APPROVAL**.
3. Integration review (gates + regression suites) — **APPROVAL**.
4. Deploy to staging / dry-run (prefer non-trading window) — **APPROVAL**.
5. Production backup (`VACUUM INTO` + SHA-256 + integrity) — **APPROVAL**.
6. Production deploy (git cutover + `npm install`) — **APPROVAL**.
7. Scoped PM2 reload — **APPROVAL**.
8. Post-deploy smoke + monitoring — monitored (no extra approval, but recorded).

See [`V6_DEPLOY_APPROVAL_MATRIX.md`](V6_DEPLOY_APPROVAL_MATRIX.md:1) for the
role/owner/condition matrix.

---

## 6. Residual production blockers (not executable here)

- Cron deconfliction (Broksum 20:00 → domestic-compile 21:20) needs maintenance window sign-off.
- Daytrade FastWatcher cron→stream cutover needs market-close sign-off.
- Root/OCI access to close Oracle shape + OOM telemetry gaps (see
  [`V6_ORACLE_MEASUREMENTS_READONLY.csv`](V6_ORACLE_MEASUREMENTS_READONLY.csv:1)).
- `chmod` Broksum hotfix, quota bridge, scheduler cutover, and hourly flag are
  production mutations gated behind approval.