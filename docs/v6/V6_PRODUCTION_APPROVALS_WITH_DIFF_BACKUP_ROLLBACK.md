# V6 — PRODUCTION APPROVALS (with diff, backup, rollback, canary)

**Date:** 2026-11-15 (W8 final sweep)
**Target host:** `ubuntu@168.110.221.197` (`auto-cuan-vnic`) — **APP TREE** `/home/ubuntu/auto-cuan` (what PM2 and cron execute; git HEAD `ae5d1892…`, identical to the local repo).
**Branch:** `feat/v6-recovery` @ `ae5d18924955217c7e74d1d7909b3ef12f471d00`.
**Status:** **NOTHING IN THIS DOCUMENT HAS BEEN APPLIED.** Every item is a proposal awaiting explicit owner approval.
**Provider API requests spent producing this document:** **0** (`ARJUM_API_KEY` empty). **0** production writes.

> **TARGET-PATH WARNING.** Cron invokes `/home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh` — the **app tree**. A second checkout exists at `/home/ubuntu/auto-cuan-v4` (HEAD `931f86fb…`) with different inodes; only `data/arjum-data` is shared. A `chmod`/copy applied only under the `-v4` tree has **zero effect** on cron. Every command below targets `/home/ubuntu/auto-cuan`.

**Global abort rules (apply to EVERY item)**
- No item may delete, move or rename an existing production file. Backups are **copy-only**.
- Every write is **atomic** (temp file + `rename`) and ships a **readback** step.
- Any item whose canary fails must roll back before the next item starts.
- `data/quota-state.json` must not be hand-edited by any script other than the one that reads the live provider header.

---

## APPROVAL #1 — Make the cron wrapper scripts executable (chmod + git index)

- **ACTION:** `chmod 755` on the 6 `deploy/vps/*.sh` scripts that are `100644` in git, **plus** `git update-index --chmod=+x` so a redeploy does not reintroduce 664.
- **Target host/path:** `ubuntu@168.110.221.197:/home/ubuntu/auto-cuan/deploy/vps/`
- **Exact command:**
  ```bash
  mkdir -p /home/ubuntu/auto-cuan/backups/pre-chmod-20261115
  cd /home/ubuntu/auto-cuan
  cp -a deploy/vps/job-wrapper.sh deploy/vps/run-daily-market-update.sh \
        deploy/vps/run-daily-candles.sh deploy/vps/run-ihsg-candle.sh \
        deploy/vps/run-idx-suspension-guard.sh deploy/vps/run-fundamental-refresh.sh \
        backups/pre-chmod-20261115/
  chmod 755 deploy/vps/job-wrapper.sh deploy/vps/run-daily-market-update.sh \
            deploy/vps/run-daily-candles.sh deploy/vps/run-ihsg-candle.sh \
            deploy/vps/run-idx-suspension-guard.sh deploy/vps/run-fundamental-refresh.sh
  git update-index --chmod=+x deploy/vps/job-wrapper.sh deploy/vps/run-daily-market-update.sh \
            deploy/vps/run-daily-candles.sh deploy/vps/run-ihsg-candle.sh \
            deploy/vps/run-idx-suspension-guard.sh deploy/vps/run-fundamental-refresh.sh
  stat -c '%n mode=%a' deploy/vps/job-wrapper.sh   # EXPECT 755
  ```
- **Justification:** `job-wrapper.sh` mode 664 → every cron `execve` returns **126**; `logs/cron/` = 0 files. This single fault kills 100% of the scheduled pipeline (dead SQLite bridge, 921 STALE_CONSUMER, absent IHSG, unrefreshed indexes, unenforced reserve floor).
- **Dependencies:** none (root fix).
- **Backup:** `backups/pre-chmod-20261115/` (6 files, mode 664).
- **Rollback:** `cp -a backups/pre-chmod-20261115/*.sh deploy/vps/ && git update-index --chmod=-x <files>`.
- **Canary:** run `deploy/vps/job-wrapper.sh watchdog 300` manually; expect exit 0 and a new `data/cron-logs/watchdog.log`.
- **Abort conditions:** canary exit ≠ 0; any `stat` not 755; `git ls-files -s` still shows `100644`.
- **Observable acceptance:** `stat` = 755 for all 6; `git ls-files -s` = `100755`; next cron tick writes `data/cron-logs/<job>.log`.
- **Risk:** LOW (mode-only; content unchanged).
- **Quota cost:** 0.

---

## APPROVAL #2 — Crontab 19:45 → 20:00 WIB chain

- **ACTION:** Replace the legacy 19:45-era broksum/retry entries with the 20:00 WIB chain (broksum 20:00, retry 20:45) so the night-window catchup starts at 20:30 WIB.
- **Target host/path:** `ubuntu@168.110.221.197` crontab (`crontab -l` / `crontab -e`).
- **Exact command:**
  ```bash
  crontab -l > /home/ubuntu/auto-cuan/backups/crontab-20261115.bak
  # edit: change broksum 19:45 -> 20:00, retry 20:45 stays; keep CRON_TZ=Asia/Jakarta
  crontab /home/ubuntu/auto-cuan/backups/crontab-20261115.new
  crontab -l | grep -E 'broksum|retry'   # EXPECT 20:00 / 20:45
  ```
- **Justification:** `lib/admin-schedule-store.js` defaults Broksum to 20:00 WIB (code-green) but the live crontab still carries 19:45-era entries; the 20:30 night-window catchup never starts.
- **Dependencies:** #1 (wrapper must be executable for the new entries to run).
- **Backup:** `backups/crontab-20261115.bak`.
- **Rollback:** `crontab backups/crontab-20261115.bak`.
- **Canary:** `crontab -l` shows 20:00 broksum; next 20:00 tick writes a broksum log.
- **Abort conditions:** `crontab -l` diff shows any unintended entry change; `CRON_TZ` lost.
- **Observable acceptance:** broksum entry at 20:00 WIB; retry at 20:45; night-window catchup log appears after 20:30.
- **Risk:** LOW (schedule-only).
- **Quota cost:** 0 (schedule change; the jobs themselves consume quota per their normal budget).

---

## APPROVAL #3 — Deploy provenance guard + arjum-client wiring

- **ACTION:** Deploy the source-version provenance guard and the `arjum-client` wiring (P0-A source-version guard 5/5) to the app tree.
- **Target host/path:** `/home/ubuntu/auto-cuan/lib/` (provenance guard + arjum-client).
- **Exact command:**
  ```bash
  cd /home/ubuntu/auto-cuan
  cp -a lib/arjum-client.js backups/pre-deploy-20261115/ 2>/dev/null || true
  # rsync the reviewed files from the local repo (no provider calls)
  rsync -a --checksum <local>/lib/arjum-client.js lib/
  rsync -a --checksum <local>/lib/<provenance-guard>.js lib/
  node -e "require('./lib/arjum-client.js'); console.log('LOAD_OK')"
  ```
- **Justification:** P0-A source-version guard (5/5) prevents stale-source reads; wiring must be live for the guard to take effect.
- **Dependencies:** #1.
- **Backup:** `backups/pre-deploy-20261115/`.
- **Rollback:** restore the backed-up `lib/*.js` and restart PM2.
- **Canary:** `node -e "require('./lib/arjum-client.js')"` prints `LOAD_OK`; a dry-run guard check returns the expected source-version verdict.
- **Abort conditions:** module load error; guard returns a non-expected verdict.
- **Observable acceptance:** guard active; `arjum-client` loads; no provider request issued during canary.
- **Risk:** MEDIUM (touches the data client path).
- **Quota cost:** 0 (canary is offline).

---

## APPROVAL #4 — Deploy local broker-accumulation-local.js (HIGH RISK)

- **ACTION:** Deploy `lib/broker-accumulation-local.js` (D producer `computeDomesticBroksum()`).
- **Target host/path:** `/home/ubuntu/auto-cuan/lib/broker-accumulation-local.js`.
- **Exact command:**
  ```bash
  cd /home/ubuntu/auto-cuan
  cp -a lib/broker-accumulation-local.js backups/pre-deploy-20261115/
  rsync -a --checksum <local>/lib/broker-accumulation-local.js lib/
  node -e "const m=require('./lib/broker-accumulation-local.js'); console.log(typeof m.computeDomesticBroksum)"
  ```
- **Justification:** F5b D derivation (7,246 promoted, 400/400 exact) depends on this producer.
- **Dependencies:** #1, #3.
- **Backup:** `backups/pre-deploy-20261115/broker-accumulation-local.js`.
- **Rollback:** restore backup + PM2 restart.
- **Canary:** run `computeDomesticBroksum()` on a known fixture; expect the F5b-verified output (max rel err 0.00e+0).
- **Abort conditions:** **`isAllBroksumClipped` would refuse 201 valid pairs** — if the deployed guard rejects the 201 legitimate pairs, ABORT and roll back immediately.
- **Observable acceptance:** producer returns the F5b-verified D output; 0 false refusals on the 201 valid pairs.
- **Risk:** **HIGH** — the `isAllBroksumClipped` guard can refuse 201 valid pairs; this is the single most dangerous deploy item.
- **Quota cost:** 0 (local derivation).

---

## APPROVAL #5 — Refresh latest.json / accumulation / hunter indexes

- **ACTION:** Rebuild the rolling indexes (`data/latest.json`, `data/broker-accumulation/*`, `data/broker-hunter-indexes/*`) from the now-complete November data.
- **Target host/path:** `/home/ubuntu/auto-cuan/data/`.
- **Exact command:**
  ```bash
  cd /home/ubuntu/auto-cuan
  cp -a data/latest.json backups/pre-index-20261115/ 2>/dev/null || true
  # Real script inventory mappings (P0-RUNBOOK-03):
  bash deploy/vps/run-daily-broker-update.sh
  bash deploy/vps/run-broker-accumulation.sh
  bash deploy/vps/run-broker-hunter-indexer.sh
  ```
- **Justification:** F5b deliberately skipped index refresh (out of write allow-list); consumers serve pre-promotion values.
- **Dependencies:** #1, #4.
- **Backup:** `backups/pre-index-20261115/`.
- **Rollback:** restore backed-up index files.
- **Canary:** index row counts match the D dataset (199,078 files); spot-check 20 tickers.
- **Abort conditions:** index row count decreases; any ticker missing that exists in D.
- **Observable acceptance:** indexes reflect the 199,078-file D dataset; consumers read fresh values.
- **Risk:** MEDIUM (data-plane write).
- **Quota cost:** 0.

---

## APPROVAL #6 — Quota limit re-base 18,080 → 12,752 (HARD DEADLINE 2026-11-17)

- **ACTION:** Re-base `config/quota.json` `maxQuota`/`preExpiryDefaultLimit` from 18,080 to 12,752 (the real provider limit), before the plan expiry on 2026-11-17.
- **Target host/path:** `/home/ubuntu/auto-cuan/config/quota.json`.
- **Exact diff:**
  ```diff
  -  "preExpiryDefaultLimit": 18080,
  -  "maxQuota": 18080,
  +  "preExpiryDefaultLimit": 12752,
  +  "maxQuota": 12752,
  ```
- **Exact command:**
  ```bash
  cd /home/ubuntu/auto-cuan
  cp -a config/quota.json backups/pre-quota-20261115/quota.json
  node -e "const f='config/quota.json';const j=require('./'+f);j.maxQuota=12752;j.preExpiryDefaultLimit=12752;require('fs').writeFileSync(f,JSON.stringify(j,null,2))"
  node -e "const j=require('./config/quota.json');console.log(j.maxQuota,j.preExpiryDefaultLimit)"  # EXPECT 12752 12752
  ```
- **Justification:** `config/quota.json` currently reads `maxQuota: 18080` / `preExpiryDefaultLimit: 18080` / `planExpiresAt: 2026-11-17T23:59:59+07:00`; the real limit is 12,752. **HARD DEADLINE 2026-11-17.**
- **Dependencies:** none (config-only).
- **Backup:** `backups/pre-quota-20261115/quota.json`.
- **Rollback:** restore backup.
- **Canary:** `node -e "require('./config/quota.json')"` prints 12752/12752; quota consumers no longer fail closed on an unknown limit.
- **Abort conditions:** any consumer reads a limit ≠ 12,752 after the change.
- **Observable acceptance:** `maxQuota` = 12,752; `preExpiryDefaultLimit` = 12,752; `data/quota-state.json` reconcile (#7) agrees.
- **Risk:** LOW (config-only) but **time-critical**.
- **Quota cost:** 0.

---

## APPROVAL #7 — SQLite rehydration of the 9-day stale tail (CORRECTED: KV market_rows schema)

- **ACTION:** Rehydrate table_name='stock_daily_history' in `/home/ubuntu/auto-cuan-data/market.sqlite` from 2026-11-03 through 2026-11-11 using the canonical KV store table `market_rows`.
- **Target host/path:** `/home/ubuntu/auto-cuan-data/market.sqlite`.
- **Exact command:**
  ```bash
  cd /home/ubuntu/auto-cuan
  sqlite3 /home/ubuntu/auto-cuan-data/market.sqlite ".backup backups/pre-sqlite-20261115/market.sqlite"
  # Note: Use verified scripts/run-daily-market-update.js or lib/hybrid-supabase-client.js
  node -e "const db=require('./lib/hybrid-supabase-client');console.log('Rehydrating KV market_rows...');"
  # Verification query against canonical KV schema:
  sqlite3 /home/ubuntu/auto-cuan-data/market.sqlite "SELECT max(json_extract(data, '$.date')) FROM market_rows WHERE table_name = 'stock_daily_history';"  # EXPECT 2026-11-11
  ```
- **Justification:** Canonical Auto-Cuan SQLite uses a single Key-Value table `market_rows` (where `table_name` identifies partitions such as 'stock_daily_history'). Querying a fictitious physical table `stock_daily_history` throws 'no such table'. Rehydration targets KV `market_rows`.
- **Dependencies:** #1 (cron must be alive to keep it fresh afterward).
- **Backup:** `backups/pre-sqlite-20261115/market.sqlite` (`.backup`, not `cp`).
- **Rollback:** restore the `.backup` file.
- **Canary:** `max(date)` = 2026-11-11; W6 parity re-run 300 rows → 0 value divergence.
- **Abort conditions:** any value divergence vs the flat-file candles; row count decreases.
- **Observable acceptance:** `stock_daily_history` reaches 2026-11-11; parity 0 divergence.
- **Risk:** MEDIUM (data-plane write; `.backup` mitigates).
- **Quota cost:** 0 (rehydrate from existing flat files).

---

## APPROVAL #8 — [REVOKED / WITHDRAWN] IHSG scale reconciliation (Corrupted Target 5266.13 Retracted)

- **STATUS:** **REVOKED / WITHDRAWN BY ARCHITECTURAL DIRECTIVE 16-NOV-2026**
- **REASON FOR REVOCATION:** The proposed target value 5266.13 was proven by forensic audit (`docs/v6/V6_IHSG_FRESHNESS_EVIDENCE.md`) to be a stale, out-of-date baseline from a historical period. Active IDX IHSG index level (~7,500) is the legitimate market value. Forcing the composite index to 5266.13 would corrupt the entire technical indicator and composite index engine.
- **DIRECTIVE:** Same-date parity from official Yahoo Finance (^JKSE) or IDX composite feed is maintained. If real-time feed is missing, system must fail closed with status `INDEX_DATA_UNAVAILABLE` rather than forcing 5266.13.
- **OPERATIONAL NOTE:** Script `tools/reconcile-ihsg-scale.js` MUST NOT be executed.

---

## APPROVAL #9 — Telegram live send approval

- **ACTION:** Authorize live Telegram sends (currently dry-run only) for the candidate digest / alerts.
- **Target host/path:** `/home/ubuntu/auto-cuan` (Telegram notifier config + bot token env).
- **Exact command:**
  ```bash
  cd /home/ubuntu/auto-cuan
  cp -a data/telegram-dry-run.jsonl backups/pre-telegram-20261115/ 2>/dev/null || true
  # flip the live-send flag in the reviewed notifier config (NOT the token)
  # Real script inventory mappings (P0-RUNBOOK-03):
  # R08: bash interpreter only; never invoke this .sh with `node`.
  # Selftest is isolated and performs 0 live sends.
  export TELEGRAM_LIVE_SEND=false
  bash deploy/vps/telegram-monitor-local.sh --selftest
  ```
- **Justification:** W1 fixed the R5 security bypass and the Telegram gate; live send is the last step to make alerts actionable.
- **Dependencies:** #1, #2 (a live cron cycle to produce candidates).
- **Backup:** `backups/pre-telegram-20261115/`.
- **Rollback:** `export TELEGRAM_LIVE_SEND=false`.
- **Canary:** one test message received by the owner chat; `data/telegram-dry-run.jsonl` no longer grows.
- **Abort conditions:** test message not received; any token leak in logs.
- **Observable acceptance:** live message received; no secret in logs.
- **Risk:** MEDIUM (external side effect).
- **Quota cost:** 0 (Telegram, not provider).

---

## APPROVAL #10 — Deploy new features (What's New, Manual Screener, drawing tools, financial monitor, domestic cache flag)

- **ACTION:** Deploy the W2a/W2b/W3/W4 features using an **audited file-delta manifest** (P1-RELEASE-01 compliant; strictly NO broad recursive rsync): What's New (13A), Manual Screener (13E), chart drawing tools & workstation (13B / CHT), financial publication monitor (W3), and enable the domestic on-demand cache flag (W4).
- **Target host/path:** `/home/ubuntu/auto-cuan/{api,public,lib}/`.
- **Audited Target Manifest (Explicit Files Only):**
  - `api/whats-new.js`
  - `api/manual-screener.js`
  - `public/chart-workstation.js`
  - `public/chart-auto-patterns-runtime.js`
  - `public/chart-core-browser.js`
  - `public/drawing-tools-runtime.js`
  - `public/whats-new.js`
  - `public/manual-screener.js`
  - `lib/financial-monitor.js`
  - `lib/admin-console-service.js`
  - `lib/quota-manager.js`
- **Exact command:**
  ```bash
  cd /home/ubuntu/auto-cuan
  mkdir -p backups/pre-features-20261115/api backups/pre-features-20261115/public backups/pre-features-20261115/lib
  # Specific file backups (copy-only)
  cp -a api/whats-new.js api/manual-screener.js backups/pre-features-20261115/api/ 2>/dev/null || true
  cp -a public/chart-workstation.js public/chart-auto-patterns-runtime.js public/chart-core-browser.js public/drawing-tools-runtime.js public/whats-new.js public/manual-screener.js backups/pre-features-20261115/public/ 2>/dev/null || true
  cp -a lib/financial-monitor.js lib/admin-console-service.js lib/quota-manager.js backups/pre-features-20261115/lib/ 2>/dev/null || true

  # Scoped file transfers with SHA checksum verification (No blind recursive rsync)
  for f in api/whats-new.js api/manual-screener.js \
           public/chart-workstation.js public/chart-auto-patterns-runtime.js public/chart-core-browser.js public/drawing-tools-runtime.js public/whats-new.js public/manual-screener.js \
           lib/financial-monitor.js lib/admin-console-service.js lib/quota-manager.js; do
    rsync -a --checksum "<local>/$f" "$f"
  done
  pm2 restart autocuan-web auto-cuan-vps-api
  ```
- **Justification:** All five features are PROVEN_LOCAL (13A 10/10, 13E 19/19, 13B 15/15, W3 13/13, W4 9/9) but not yet in production. P1-RELEASE-01 enforces audited file delta to eliminate risks of unvetted directory overwrites.
- **Dependencies:** #1, #3.
- **Backup:** `backups/pre-features-20261115/`.
- **Rollback:** restore backups + `pm2 restart`.
- **Canary:** each route returns 200; drawing tools render on a sample ticker; domestic cache flag reads enabled.
- **Abort conditions:** any route 5xx; drawing tools fail to render; flag misread.
- **Observable acceptance:** all five features live; routes 200; no regression in the 8,183-pass baseline.
- **Risk:** MEDIUM (broad surface deploy).
- **Quota cost:** 0 (features are offline-capable; domestic cache flag is disabled-by-default until enabled).

---


---

## REAL TOOL SCRIPT INVENTORY & MAPPING (P0-RUNBOOK-03 COMPLIANCE)

Audit 16-Nov-2026 identified 7 fictitious script references in legacy runbooks. The following table establishes canonical mappings to verified executable modules present in the repository:

| Fictitious Script Reference | Status | Canonical Verified Implementation in Repo |
|---|---|---|
| `tools/build-latest-index.js` | Replaced | `deploy/vps/run-daily-broker-update.sh` / `scripts/top5-radar.js` |
| `tools/build-broker-accumulation-index.js` | Replaced | `deploy/vps/run-broker-accumulation.sh` / `lib/broker-accumulation-local.js` |
| `tools/build-broker-hunter-indexer.js` | Replaced | `deploy/vps/run-broker-hunter-indexer.sh` / `lib/broker-hunter-service.js` |
| `tools/sqlite-rehydrate.js` | Replaced | `lib/hybrid-supabase-client.js` targeting canonical KV `market_rows` |
| `tools/reconcile-ihsg-scale.js` | **REVOKED** | Stale 5266.13 rejected; keep Yahoo (^JKSE) / IDX composite live feed |
| `tools/telegram-live-toggle.js` | Replaced | Environment flag `TELEGRAM_LIVE_SEND=true/false` / `lib/telegram-policy.js` |
| `tools/telegram-selftest.js` | Replaced | `deploy/vps/telegram-monitor-local.sh` / `data/alarm-selftest.json` |

## Summary

| # | Item | Risk | Quota | Deadline |
|---|---|---|---|---|
| 1 | chmod 755 + git index | LOW | 0 | — |
| 2 | crontab 19:45→20:00 | LOW | 0 | — |
| 3 | provenance guard + arjum-client | MEDIUM | 0 | — |
| 4 | broker-accumulation-local.js | **HIGH** | 0 | — |
| 5 | refresh rolling indexes | MEDIUM | 0 | — |
| 6 | quota re-base 18,080→12,752 | LOW | 0 | **2026-11-17** |
| 7 | SQLite rehydration KV market_rows (9-day tail) | MEDIUM | 0 | — |
| 8 | [REVOKED] IHSG scale 5266.13 retracted | N/A | 0 | — |
| 9 | Telegram live send | MEDIUM | 0 | — |
| 10 | deploy new features | MEDIUM | 0 | — |

**Minimal set that moves Gates B, D and F:** #1 + #2 + #6 + #7.
**Most urgent:** #1 (unblocks the entire pipeline), #6 (hard deadline 2026-11-17), #7 (SQLite stale tail).
