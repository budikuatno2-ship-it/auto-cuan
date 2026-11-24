# V6 — VPS CHANGE APPROVALS REQUIRED (exact, with rollback and cost)

**Date:** Fri 2026-11-13, 22:50 WIB
**Target:** `ubuntu@168.110.221.197` (`auto-cuan-vnic`)
**Branch:** `feat/v6-recovery` @ `ae5d18924955217c7e74d1d7909b3ef12f471d00`
**Status:** **NOTHING IN THIS DOCUMENT HAS BEEN APPLIED.** Every item below is a proposal awaiting explicit owner approval.
**Provider API requests spent producing this document:** **0**.

**Read this first.** Approvals **#1** and **#2** are the only two that unblock the entire pipeline. Everything else is either a consequence of them (#5, #6, #7), a guard-hardening item (#3, #4), or a data-completion item that costs quota (#8).

> ### ⚠ UPDATED 2026-11-14 (F8d) — approval #8 is CLOSED
>
> Approval **#8** (residual fetch) **is CLOSED**: the F4d residual sweep ran on 2026-11-14 08:57–09:02 WIB, issued **29** requests (**23 saved / 6 NO_TRADE**), reconciled the provider header **36/36 EXACT** (quota **12,751 → 12,715** of 12,752), and closed the November requestable backlog. The authoritative residual split is now **1,509 total / 1,509 NO_TRADE-proven / 0 refetchable / 0 deferred**. **0 requestable pairs remain.** Approval #8 now describes an **idempotent re-derive that issues 0 requests** — it is no longer a fetch approval. The **2026-11-13 (F4c-window) figures** quoted in the dated superseded note inside #8 are the historical record only.

> ### ⚠ TARGET-PATH WARNING (added by F8 after a direct inode probe)
>
> The cron table invokes `/home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh` — the **app tree**.
> There is a **second** tree at `/home/ubuntu/auto-cuan/` (the repo checkout, git HEAD
> `931f86fb…`). They are **different directories with different inodes**; only
> `data/arjum-data` is shared (inode 1580522). The app tree is at git HEAD `ae5d1892…`,
> identical to the local repo.
>
> **Therefore:** a `chmod` or a file copy applied only under `/home/ubuntu/auto-cuan/` has
> **zero effect** on what cron runs. Every command below that touches `deploy/vps/` or
> `lib/` must be executed against **`/home/ubuntu/auto-cuan`**.
>
> Verified by F8:
> ```
> /home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh    inode=334901  mode=664 mtime=2026-11-09 20:23:37
> /home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh  inode=1066800 mode=664 mtime=2026-11-04 12:20:25
> ```

**Global abort rules that apply to EVERY item**
- `data/quota-state.json` must not be hand-edited by any script other than the one that reads the live provider header.
- No item may delete, move or rename an existing production file. Backups are **copy-only**.
- Every write is **atomic** (temp file + `rename`), and every item ships a **readback** step.
- Any item whose canary fails must roll back before the next item starts.
- **Approval #8 is CLOSED (F4d, 2026-11-14).** The 2026-11-13 instruction *"do not run approval #8 before 00:00 WIB (counter at 476/12,752)"* is **superseded**: the counter reset at 00:00 WIB on 2026-11-14 to 12,752, F4d then consumed **36** units (12,751 → 12,715), and the backlog is closed. The only re-runnable action is the **idempotent re-derive**, which issues **0** requests while `requests_to_issue = 0`.

---

## APPROVAL #1 — Make the cron wrapper scripts executable

**Why:** `deploy/vps/job-wrapper.sh` is mode **664**. Every cron entry calls it, `execve` returns **126 (permission denied)**, and **no** scheduled job has run since. `logs/cron/` is empty (0 files) — proof the wrapper never reaches its own logging line. This single fault is the root cause of: the dead SQLite bridge, the 921 `STALE_CONSUMER` class, the absent IHSG layer, the never-refreshed rolling indexes, and the unenforced 5,000 reserve floor.

**Exact commands (run as `ubuntu` on the VPS):**

```bash
# 0. BACKUP
mkdir -p /home/ubuntu/auto-cuan/backups/pre-chmod-20261113
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
cp -a deploy/vps/job-wrapper.sh \
      deploy/vps/run-daily-market-update.sh \
      deploy/vps/run-daily-candles.sh \
      deploy/vps/run-ihsg-candle.sh \
      deploy/vps/run-idx-suspension-guard.sh \
      deploy/vps/run-fundamental-refresh.sh \
      backups/pre-chmod-20261113/
ls -la backups/pre-chmod-20261113/
# EXPECT: 6 files, all mode 664

# 1. APPLY (filesystem)
chmod 755 deploy/vps/job-wrapper.sh
chmod 755 deploy/vps/run-daily-market-update.sh
chmod 755 deploy/vps/run-daily-candles.sh
chmod 755 deploy/vps/run-ihsg-candle.sh
chmod 755 deploy/vps/run-idx-suspension-guard.sh
chmod 755 deploy/vps/run-fundamental-refresh.sh
stat -c '%n mode=%a' deploy/vps/job-wrapper.sh deploy/vps/run-daily-market-update.sh \
      deploy/vps/run-daily-candles.sh deploy/vps/run-ihsg-candle.sh \
      deploy/vps/run-idx-suspension-guard.sh deploy/vps/run-fundamental-refresh.sh
# EXPECT: 755 for all six

# 2. APPLY (git index — so a redeploy does NOT reintroduce the fault)
git update-index --chmod=+x deploy/vps/job-wrapper.sh
git update-index --chmod=+x deploy/vps/run-daily-market-update.sh
git update-index --chmod=+x deploy/vps/run-daily-candles.sh
git update-index --chmod=+x deploy/vps/run-ihsg-candle.sh
git update-index --chmod=+x deploy/vps/run-idx-suspension-guard.sh
git update-index --chmod=+x deploy/vps/run-fundamental-refresh.sh
git ls-files -s deploy/vps/job-wrapper.sh deploy/vps/run-daily-market-update.sh \
      deploy/vps/run-daily-candles.sh deploy/vps/run-ihsg-candle.sh \
      deploy/vps/run-idx-suspension-guard.sh deploy/vps/run-fundamental-refresh.sh
# EXPECT: 100755 for all six   (previously 100644)

# 3. NOTE: commit the index change SEPARATELY, after review.
#    Do NOT push without a separate approval.
git status --porcelain deploy/vps/
```

**The six files (F8-verified against the APP tree's git index).** The app tree contains **15** shell scripts at `100644` and **23** at `100755`. The six below are the **cron-relevant** normalisation set from `docs/v6/V6_SCHEDULE_FIX_PROPOSAL.md` §2. Strictly speaking **only `job-wrapper.sh` is required** — every other payload script is invoked as `bash <script>.sh`, which does not need the execute bit:

| # | File | Needed for cron? | Mode today |
|---|---|---|---|
| 1 | `deploy/vps/job-wrapper.sh` | **YES — the single entry point of every cron job** | 664 |
| 2 | `deploy/vps/run-daily-market-update.sh` | no (`bash <script>`) | 664 |
| 3 | `deploy/vps/run-daily-candles.sh` | no | 664 |
| 4 | `deploy/vps/run-ihsg-candle.sh` | no | 664 |
| 5 | `deploy/vps/run-idx-suspension-guard.sh` | no | 664 |
| 6 | `deploy/vps/run-fundamental-refresh.sh` | no | 664 |

The remaining nine `100644` scripts in the app tree (`check-pm2-mem.sh`, `lib/load-env.sh`, `pull-financials.sh`, `run-backlog-age-alarm.sh`, `run-broker-hunter-indexer.sh`, `run-catchup-missing-dates.sh`, `run-cloudflared-webhook.sh`, `s1-harden.sh`, `smoke-4-pilar.sh`) are **not** in the cron critical path. `deploy/vps/lib/load-env.sh` is `source`d, not executed, so 664 is harmless there. Normalising all fifteen is an optional follow-up. The full list was captured by:

```bash
cd /home/ubuntu/auto-cuan && git ls-files -s 'deploy/vps/*.sh' | awk '$1=="100644"{print $4}'
# then: git update-index --chmod=+x <each path listed above>
```

**Rollback:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
cp -a backups/pre-chmod-20261113/*.sh deploy/vps/
chmod 664 deploy/vps/job-wrapper.sh \
         deploy/vps/run-daily-market-update.sh \
         deploy/vps/run-daily-candles.sh \
         deploy/vps/run-ihsg-candle.sh \
         deploy/vps/run-idx-suspension-guard.sh \
         deploy/vps/run-fundamental-refresh.sh
git update-index --chmod=-x deploy/vps/job-wrapper.sh \
                              deploy/vps/run-daily-market-update.sh \
                              deploy/vps/run-daily-candles.sh \
                              deploy/vps/run-ihsg-candle.sh \
                              deploy/vps/run-idx-suspension-guard.sh \
                              deploy/vps/run-fundamental-refresh.sh
git ls-files -s deploy/vps/job-wrapper.sh   # EXPECT: 100644 again
```

**Canary (do this before declaring success):**

```bash
# A single wrapper invocation with a zero-quota job, run by hand:
/home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh watchdog 60 node tools/watchdog.js
echo "wrapper exit=$?"                       # EXPECT: 0 (or the job's own exit code, NOT 126)
ls -la /home/ubuntu/auto-cuan/logs/cron/  # EXPECT: watchdog.log now EXISTS
tail -20 /home/ubuntu/auto-cuan/logs/cron/watchdog.log
```

**Abort conditions:**
- `wrapper exit=126` → the chmod did not take. **STOP.**
- `watchdog.log` still absent → the wrapper did not reach its logging line. **STOP** and re-check that you ran it from the **app tree** (`/home/ubuntu/auto-cuan`), not the repo tree — the F8 inode probe proved these are two different directories.
- The canary job writes to a production data path → **STOP**, run a zero-quota job only.

**Risk:** **LOW-MEDIUM**. The blast radius is "every scheduled job starts running for the first time since Nov 9". Several of those jobs are quota-consuming (`quota-burn-*`, `insider-tiered-2200`, `fundamental-refresh-2220`, `quota-burn-night-2245`). With the provider counter at 476 and the effective floor at 500, the quota jobs will exit 0 immediately (the floor guard is `exit 0`), so **no quota is burned** — but this must be confirmed by reading the first `logs/cron/quota-burn-*.log` before letting the night window open.

**Estimated quota cost:** **0** (the floor guard exits 0 at remaining ≤ 500). Worst case if the floor is mis-evaluated: up to **500** units.

**Owner:** VPS operator. **Priority: 1 of 8 — do this first.**

---

## APPROVAL #2 — Move the broker-summary chain from 19:45 to 20:00 WIB

**Why:** the live crontab still carries the 19:45-era chain. `lib/admin-schedule-store.js` / `lib/admin-schedule-engine.js` already default Broksum to **20:00 WIB** (NREQ-06 green), so the code and the cron table disagree.

**Exact diff (current → proposed):**

```diff
- 45 19 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh broksum-1945 1800 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --final --accum-source=api --insider-mode=daily
- 0 20 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh broksum-retry-2000 1800 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --final --accum-source=api --insider-mode=daily
+ 0 20 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh broksum-2000 1800 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --final --accum-source=api --insider-mode=daily
+ 15 20 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh broksum-retry-2015 1800 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --final --accum-source=api --insider-mode=daily
```

Downstream chain (unchanged times, but **they only become reachable once #1 lands**):

| Job | Current | Proposed | Note |
|---|---|---|---|
| `broksum` | 19:45 | **20:00** | primary broker-summary fetch |
| `broksum-retry` | 20:00 | **20:15** | idempotent retry/sweep of ALL+F |
| `domestic-compile` | 20:30 | **20:30** | D compile (unchanged) |
| `domestic-compile-final` | 21:10 | **21:10** | D final + accumulation (unchanged) |
| `top5-radar` | 21:35 | **21:35** | derived from the chain above (unchanged) |

**Exact commands:**

```bash
# 0. BACKUP the current crontab
crontab -l > /home/ubuntu/auto-cuan/backups/crontab-20261113-$(date +%H%M%S).txt

# 1. EDIT (use `crontab -e`, or rebuild deterministically):
crontab -l \
  | sed -e 's#^\(45 19 \* \* 1-5 .*job-wrapper\.sh broksum\) 1945 1800#\1 2000 1800#' \
        -e 's#^\(0 20 \* \* 1-5 .*job-wrapper\.sh broksum-retry\) 2000 1800#\1 2015 1800#' \
  | crontab -

# 2. VERIFY
crontab -l | grep -n 'broksum'
# EXPECT the two lines to show 20:00 and 20:15

# 3. STATIC VALIDATION (repo-owned, no production effect)
cd /home/ubuntu/auto-cuan && node tools/validate-schedule.js
echo "validate-schedule exit=$?"    # MUST be 0
```

**Rollback:**

```bash
crontab /home/ubuntu/auto-cuan/backups/crontab-20261113-<HHMMSS>.txt
crontab -l | grep -n 'broksum'
```

**Canary:**

```bash
# Run the primary job by hand, exactly as cron would, and watch the log:
/home/ubuntu/auto-cuan/deploy/vps/job-wrapper.sh broksum-canary 1800 \
  bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --final --accum-source=api --insider-mode=daily
echo "exit=$?"
tail -50 /home/ubuntu/auto-cuan/logs/cron/broksum-canary.log
```

**Abort conditions:**
- `node tools/validate-schedule.js` exits non-zero → **STOP**, do not install the crontab.
- The canary's exit code is not 0 → **STOP** and roll back.
- The canary's log shows the job starting inside the 23:50–00:10 forbidden window → **STOP**.

**Risk:** **MEDIUM** — a schedule change during live market hours can overlap two runs of the same job. The `flock -n /tmp/autocuan-<job>.lock` inside `job-wrapper.sh` prevents a concurrent duplicate, so a stale run is skipped rather than doubled.

**Estimated quota cost:** the `broksum` job is a **quota-consuming** job (`--accum-source=api`). Its cost is the full daily ALL+F sweep, i.e. **up to ~1,660 requests per weekday** at the current 972-ticker universe. **At the current provider balance (476 remaining) it cannot run** — it will exit 0 on the floor guard. It becomes affordable only **after the 00:00 WIB reset**.

**Owner:** VPS operator + product owner (the 20:00 target is a user requirement). **Priority: 2 of 8.**

---

## APPROVAL #3 — Deploy `lib/broksum-provenance.js` and wire it into `lib/arjum-client.js`

**Why:** the F5b provenance guard exists **only locally**. F8 confirmed on the VPS:

```bash
ls -la /home/ubuntu/auto-cuan/lib/broksum-provenance.js   # -> No such file
grep -c 'broksum-provenance' /home/ubuntu/auto-cuan/lib/arjum-client.js   # -> 0
```

So a stale, synthetic, unreleased or zero-row foreign file can still reach a signal in production.

**Exact deploy:**

```bash
# 0. BACKUP
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
mkdir -p backups/pre-provenance-20261113
cp -a lib/arjum-client.js backups/pre-provenance-20261113/arjum-client.js
sha256sum lib/arjum-client.js | tee backups/pre-provenance-20261113/arjum-client.js.sha256

# 1. STAGE + VERIFY (no live path touched yet)
mkdir -p /home/ubuntu/auto-cuan-runner/state/f8-stage
cp /home/ubuntu/auto-cuan-runner/state/live-v6/../../../../../dev/null /dev/null 2>/dev/null || true
# (transfer the two files from the local repo via scp into the staging dir)
#   lib/broksum-provenance.js
#   lib/arjum-client.js
node -e "require('/home/ubuntu/auto-cuan-runner/state/f8-stage/lib/broksum-provenance.js'); console.log('module loads OK')"

# 2. APPLY (atomic-ish: copy into place, then reload PM2)
cp /home/ubuntu/auto-cuan-runner/state/f8-stage/lib/broksum-provenance.js lib/broksum-provenance.js
cp /home/ubuntu/auto-cuan-runner/state/f8-stage/lib/arjum-client.js lib/arjum-client.js
pm2 reload auto-cuan-vps-api --update-env
pm2 list

# 3. READBACK
grep -c 'broksum-provenance' lib/arjum-client.js     # EXPECT >= 1
curl -s http://127.0.0.1:3000/api/version             # EXPECT HTTP 200
```

**Rollback:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
cp -a backups/pre-provenance-20261113/arjum-client.js lib/arjum-client.js
rm -f lib/broksum-provenance.js
pm2 reload auto-cuan-vps-api --update-env
sha256sum lib/arjum-client.js
diff <(sha256sum < backups/pre-provenance-20261113/arjum-client.js | cut -d' ' -f1) \
     <(sha256sum < lib/arjum-client.js | cut -d' ' -f1) && echo "RESTORED"
```

**Canary:**

```bash
# The guard must turn an untrustworthy F payload into a null cache-miss,
# NOT into an error and NOT into a fabricated zero.
node -e "
const p = require('/home/ubuntu/auto-cuan/lib/broksum-provenance.js');
console.log('exports:', Object.keys(p).join(','));
console.log('synthetic rejected:', p.isActionableBrokerDataset({brokers:[],computed_from:'broker_code_heuristic_from_all'}) === false);
"
# EXPECT: exports: isActionableBrokerDataset,...  synthetic rejected: true
```

**Abort conditions:**
- `require()` of the new module throws → **STOP**, roll back.
- `/api/version` returns non-200 after the PM2 reload → **STOP**, roll back.
- Any consumer now returns a **hard error** where it previously returned a payload → **STOP** (the guard must degrade to `null`, never to a throw).

**Risk:** **MEDIUM**. The guard turns "untrusted payload" into "cache miss". A cache miss can make a downstream feature return **no data** where it previously (wrongly) returned data. That is the intended fail-closed behaviour, but it will *look* like a regression to a surface that was silently consuming bad data. Only `readLocalBrokerSummary(ticker,date,'F')` is affected.

**Estimated quota cost:** **0**.

**Owner:** backend owner. **Priority: 3 of 8.**

---

## APPROVAL #4 — Route `api/sector-hot.js` and `lib/backtest-individual-964.js` through the guard

**Why:** F5b §7.3 deliberately left two direct readers of `broker-summary-F` unguarded:

| Consumer | Reads | Guarded? |
|---|---|---|
| `api/sector-hot.js` | ALL + F from disk, direct | **NO** |
| `lib/backtest-individual-964.js` | ALL + F from disk, direct | **NO** |
| `lib/arjum-client.js:161-208` | `readLocalBrokerSummary(...,'F')` | **YES** (approval #3) |

**Exact change:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
mkdir -p backups/pre-guard-wiring-20261113
cp -a api/sector-hot.js lib/backtest-individual-964.js backups/pre-guard-wiring-20261113/
# Edit each call site to route through the guard, then:
node -e "require('/home/ubuntu/auto-cuan/api/sector-hot.js'); console.log('sector-hot loads OK')"
pm2 reload auto-cuan-vps-api --update-env
```

**Rollback:** `cp -a backups/pre-guard-wiring-20261113/<file> <original-path>` + `pm2 reload auto-cuan-vps-api --update-env`.

**Canary:**

```bash
curl -s 'http://127.0.0.1:3000/api/sector-hot?limit=5' | head -c 400
echo
# EXPECT: a normal JSON payload — NOT a 500, and NOT an empty array where data should exist
```

**Abort conditions:**
- `/api/sector-hot` returns HTTP 500 → **STOP**, roll back.
- `/api/sector-hot` returns an **empty** result on a date that has known-good data → **STOP**, roll back (the guard is over-rejecting).

**Risk:** **MEDIUM-HIGH** for `sector-hot` (it is a user-visible ranking surface). `backtest-individual-964.js` is an offline research tool — **changing it alters research output reproducibility**, so it should be a separate approval if reproducibility matters.

**Estimated quota cost:** **0**.

**Owner:** backend owner + research owner. **Priority: 4 of 8.**

---

## APPROVAL #5 — Refresh `latest.json`, `data/broker-accumulation/`, `data/broker-hunter-indexes/`

**Why:** the F5b D promotion wrote 7,246 dated `broker-summary-D` files, but the **rolling** views were deliberately not refreshed. Consumers that read `latest.json` or the accumulation/hunter indexes will therefore serve **pre-promotion** values.

**Exact command:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
# 0. BACKUP (copy-only)
mkdir -p backups/pre-index-refresh-20261113
tar -czf backups/pre-index-refresh-20261113/rolling-indexes-$(date +%Y%m%dT%H%M%SZ).tar.gz \
    data/arjum-data/broker-accumulation data/arjum-data/broker-hunter-indexes
find data/arjum-data/broker-summary-D -name 'latest.json' -print0 \
  | tar --null -czf backups/pre-index-refresh-20261113/latest-json-$(date +%Y%m%dT%H%M%SZ).tar.gz --files-from=-
ls -la backups/pre-index-refresh-20261113/

# 1. DRY RUN FIRST (the producer has --apply; without it, it must not write)
node tools/build-domestic-broksum-and-accum.js --skip-hunter      # EXPECT: dry-run summary, no writes

# 2. APPLY
node tools/build-domestic-broksum-and-accum.js --apply --force
# (this also refreshes the accumulation index)

# 3. REFRESH THE HUNTER INDEX (the F5b run used --skip-hunter)
node tools/build-domestic-broksum-and-accum.js --apply --force --skip-hunter
```

**Rollback:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
tar -xzf backups/pre-index-refresh-20261113/rolling-indexes-*.tar.gz -C .
tar -xzf backups/pre-index-refresh-20261113/latest-json-*.tar.gz -C .
```

**Canary:**

```bash
# latest.json for one ticker must now match the dated D file for the latest date.
node -e "
const fs=require('fs');
const t='BBRI';
const l=JSON.parse(fs.readFileSync('data/arjum-data/broker-summary-D/'+t+'/latest.json','utf8'));
const d=JSON.parse(fs.readFileSync('data/arjum-data/broker-summary-D/'+t+'/2026-11-13.json','utf8'));
console.log('latest date   =', l.date);
console.log('dated  date   =', d.date);
console.log('rows equal    =', (l.brokers||[]).length === (d.brokers||[]).length);
console.log('buyers equal  =', l.total_buyers === d.total_buyers);
"
# EXPECT: dates equal, rows equal true, buyers equal true
```

**Abort conditions:**
- The dry run (step 1) writes anything → **STOP**, the dry-run flag is broken.
- `latest.json` date ≠ the newest dated D file → **STOP**.
- The file count of `broker-summary-D` **decreases** → **STOP** (the F5b invariant was "increase, never decrease"; a decrease means the producer deleted something).

**Risk:** **MEDIUM**. The producer rewrites **three** index trees in one pass. A partial failure can leave the indexes mutually inconsistent. This is why the backup is a tarball of all three, not just one.

**Estimated quota cost:** **0** (the D compile is local arithmetic on already-fetched ALL/F files).

**Owner:** data-platform owner. **Priority: 5 of 8.**

---

## APPROVAL #6 — Deploy the local `lib/broker-accumulation-local.js` (with `isAllBroksumClipped`)

**Why:** F8 confirmed the deployed copy **differs** from the local HEAD:

```bash
grep -c 'isAllBroksumClipped' /home/ubuntu/auto-cuan/lib/broker-accumulation-local.js   # -> 0
# deployed: sha256 dc6eb88e… 814 lines
# local   : sha256 2d540a02… 903 lines  (+89 lines, includes isAllBroksumClipped + the ARAH_UNKNOWN fix)
```

**This is the one approval that must NOT be done naively.** The F5b report §2.3 **DISPROVED** the 25-level clip heuristic on dated files: of 6,642 dated ALL files, **2,238 have more than 25 broker_levels** (up to 77), and the daily candle volume matches in 313/314 of the `>25` group. The local guard would therefore **wrongly refuse 201 valid pairs**.

**Exact command:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
mkdir -p backups/pre-bacc-deploy-20261113
cp -a lib/broker-accumulation-local.js backups/pre-bacc-deploy-20261113/
sha256sum lib/broker-accumulation-local.js | tee backups/pre-bacc-deploy-20261113/orig.sha256

# MUST BE DONE TOGETHER: the local file's isAllBroksumClipped is only safe
# because the local isAllBroksumClipped ALSO accepts the dated-file case.
# Verify the exact local semantics BEFORE deploying:
grep -n 'isAllBroksumClipped' -A 25 lib/broker-accumulation-local.js
grep -n 'ARAH_UNKNOWN' lib/broker-accumulation-local.js

cp <local>/lib/broker-accumulation-local.js lib/broker-accumulation-local.js
node -e "require('/home/ubuntu/auto-cuan/lib/broker-accumulation-local.js'); console.log('loads OK')"
pm2 reload auto-cuan-vps-api --update-env
```

**Rollback:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
cp -a backups/pre-bacc-deploy-20261113/broker-accumulation-local.js lib/broker-accumulation-local.js
pm2 reload auto-cuan-vps-api --update-env
sha256sum lib/broker-accumulation-local.js   # EXPECT: dc6eb88e…
```

**Canary:**

```bash
# The clip guard must NOT reject a dated ALL file that has >25 levels.
node -e "
const b=require('/home/ubuntu/auto-cuan/lib/broker-accumulation-local.js');
console.log('exports:', Object.keys(b).join(','));
"
# Then re-derive ONE known-good pair and compare against the promoted archive:
node tools/derive-domestic-v6.js --mode=verify   # EXPECT: 400/400 exact, max rel err 0.00e+0
```

**Abort conditions:**
- The local `isAllBroksumClipped` rejects any of the 201 known-valid pairs → **STOP**. The local guard and the F5b measurement disagree; the local guard must be fixed first.
- `derive-domestic-v6.js --mode=verify` is not 400/400 exact → **STOP**, roll back.
- The promoted D count drops below 199,078 → **STOP** (deletion invariant).

**Risk:** **HIGH** — this is the canonical D producer. A wrong deploy silently changes every D file. The mitigation is the 400/400 verification, which is already implemented and proven.

**Estimated quota cost:** **0**.

**Owner:** data-platform owner. **Priority: 6 of 8 — only after #3/#4, because #3 depends on the same generation of code.**

---

## APPROVAL #7 — Re-base the quota limit (18,080 → 12,752) and reconcile the `data/quota-state.json` drift

> **F8 CORRECTION.** The carried F0 note *"config/quota.json 18080 legacy vs provider
> x-ratelimit-limit 12752"* is **CONFIRMED** — but only when read from the **APP tree**
> (`/home/ubuntu/auto-cuan`), which is what cron and PM2 run. F8's first pass read the
> `-v4` **repo** tree, whose `config/quota.json` already reads 12,752, and briefly
> concluded the opposite. The legacy constants are live in production:

```
/home/ubuntu/auto-cuan/config/quota.json:6   "preExpiryDefaultLimit": 18080,
/home/ubuntu/auto-cuan/config/quota.json:7   "maxQuota": 18080,
/home/ubuntu/auto-cuan/config/quota.json:9   "weekendBackfillLimit": 18080,
/home/ubuntu/auto-cuan/lib/quota-manager.js:26   const TOTAL_QUOTA = 18080;
/home/ubuntu/auto-cuan/lib/quota-state.js:48      maxQuota: 18080,
/home/ubuntu/auto-cuan/lib/quota-state.js:50      weekendBackfillLimit: 18080,
/home/ubuntu/auto-cuan/lib/quota-drift.js:46      { maxQuota: 18080, reserveFloorWeekday: 5000, ... }
```

**The provider's real daily limit is 12,752.** Production therefore computes `remaining`
against a limit that is **5,328 units too high**, and its weekend backfill budget
(18,080) exceeds the real daily cap (12,752) by **42 %**. This is the split-brain the
master prompt asked to be reported, and it is **still open**.

**Additional hard deadline:** `planExpiresAt` = **2026-11-17**. After that date
`postExpiryDefaultLimit` (1000) takes over — on top of the already-wrong 18,080 base.
The owner must decide before **17 Nov 2026**.

**Why:** F8 measured the live file at 22:37 WIB:

```json
{ "date": "2026-11-13", "localUsedToday": 0, "usedToday": 0, "backfillUsedToday": 0,
  "hardStopLocked": false, "upstreamUsedToday": 7750, "upstreamDailyLimit": null,
  "effectiveDailyLimit": null, "drift": 7750, "driftDetected": true,
  "updatedAt": "2026-11-13T14:55:08.179Z" }
```

Against reality: the provider limit is **12,752** and the provider remaining was **476** at 21:13:35 WIB. So the state file says "7,750 used, limit unknown", while the truth is "12,276 used, limit 12,752". Any consumer reading `upstreamDailyLimit: null` must fail closed (which the F7 fix does), but the drift is **unreconciled** and the file was written at **21:55 WIB by an unidentified process** (see `docs/v6/V6_ROO_ANTIGRAVITY_POST_LIVE_RECONCILIATION.md` §3).

**Exact commands — READ FIRST, WRITE ONLY AFTER:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
# 0. BACKUP
mkdir -p backups/pre-quota-reconcile-20261113
cp -a data/quota-state.json backups/pre-quota-reconcile-20261113/quota-state.json.$(date +%Y%m%dT%H%M%SZ)

# 1. READ the live provider header (this costs 1 request — do it AFTER 00:00 WIB)
node -e "
require('dotenv').config({path:'/home/ubuntu/auto-cuan-runner/.env'});
const k=process.env.ARJUM_API_KEY||process.env.STOCK_ARJUM_API_KEY;
fetch('https://stock.arjum.com/api/broker-summary/BBRI?date=2026-11-13&all_data=true',
  {headers:{'X-API-Key':k}})
  .then(r=>{console.log('limit',r.headers.get('x-ratelimit-limit'),'remaining',r.headers.get('x-ratelimit-remaining'));});
"

# 2. RE-BASE THE LIMIT to the provider's real 12,752 (APP tree only)
#    Files: config/quota.json (maxQuota, preExpiryDefaultLimit, weekendBackfillLimit)
#           lib/quota-manager.js (TOTAL_QUOTA), lib/quota-state.js (defaults),
#           lib/quota-drift.js (fallback object)
#    BACKUP ALL FOUR FIRST, then edit, then re-read the provider header to confirm.
node -e "
const fs=require('fs');
const p='/home/ubuntu/auto-cuan/config/quota.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
console.log('BEFORE maxQuota=',j.maxQuota,'preExpiry=',j.preExpiryDefaultLimit,'weekend=',j.weekendBackfillLimit);
"

# 3. RECONCILE via the module that owns the file (do NOT hand-edit)
node -e "
const q=require('/home/ubuntu/auto-cuan/lib/quota-state.js');
const s=q.readState();
console.log('before', JSON.stringify(s));
"          # inspect the resolved state first

# 3. If and only if the resolved state is wrong, force a re-read from the provider:
#    (the exact entry point is the one that stamps upstreamUsedToday from the
#     response header — identify it with:
#     grep -n 'upstreamUsedToday' lib/quota-state.js lib/quota-manager.js)
```

**Rollback:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (what PM2 and cron run)
cp -a backups/pre-quota-reconcile-20261113/quota-state.json.<TS> data/quota-state.json
cat data/quota-state.json
```

**Canary:**

```bash
node -e "
const q=require('/home/ubuntu/auto-cuan/lib/quota-state.js');
const s=q.readState();
console.log('upstreamUsedToday =', s.upstreamUsedToday);
console.log('upstreamDailyLimit=', s.upstreamDailyLimit);
console.log('effectiveDailyLimit=', s.effectiveDailyLimit);
console.log('driftDetected =', s.driftDetected);
"
# EXPECT: upstreamDailyLimit = 12752, effectiveDailyLimit = 12752, driftDetected = false
#         (after the reset, upstreamUsedToday must be the real measured value, not 7750)
```

**Abort conditions:**
- The file cannot be reconciled from the provider header → **STOP**; leave the drift and record it (fail-closed behaviour is correct).
- Any hand-edit is proposed → **STOP**. The file must be written by its owning module, otherwise the audit trail (`data/quota-audit.log.jsonl`) breaks.
- `driftDetected` stays `true` after a successful reconcile → **STOP** and investigate the writer identified in approval #9.

**Risk:** **MEDIUM**. Editing the quota state by hand would make the enforcement floor lie. The audit trail (`data/quota-audit.log.jsonl`) is append-only and must record the reconciliation.

**Estimated quota cost:** **1** request (the header probe).

**Owner:** VPS operator + backend owner. **Priority: 7 of 8.**

---

## APPROVAL #8 — **CLOSED (F4d, 2026-11-14)**: idempotent re-derive only — 0 requests while the backlog is closed

**Verdict: CLOSED.** The F4d residual sweep **already ran** on 2026-11-14 (08:57:57 → 09:02:50 WIB) and **closed the November requestable backlog**. **0 requestable pairs remain.** This item is no longer a fetch approval — it is now an **optional, idempotent re-derivation** that issues **0 provider requests** while the backlog stays closed.

> ### ⚠ SUPERSEDED — 2026-11-14, superseded by F4d (`docs/v6/V6_F4D_RESIDUAL_RESUME_REPORT_20261114.md`)
>
> Everything quoted in this block is the **dated 2026-11-13 (F4c-window) record**. It is **NOT** the current instruction and **NOT** the current backlog. It is retained only as the historical record of what the F4c window left behind and of what approval #8 was proposed to do on 2026-11-13.
>
> | Superseded figure (2026-11-13, F4c window) | Authoritative figure (2026-11-14 09:02 WIB, F4d) | Why it was superseded |
> |---|---|---|
> | residual **586 pairs** | residual **1,509 pairs** | F4d re-derived the split from **disk** over the full November required universe (11 dates × 2 datasets) instead of F4c's narrower **8-cell** universe; the F4c figure under-counted the NO_TRADE-proven class. |
> | **537** NO_TRADE-proven | **1,509** NO_TRADE-proven (1,037 provider sidecar + 472 on-disk strict-identity `brokers: []`) | Same re-derivation over the wider universe, plus the provider sidecars F4d itself produced. |
> | **~49** genuinely refetchable | **0** refetchable | F4d re-requested every requestable pair; the provider returned `brokers: []` for all of them, so each became NO_TRADE-proven. |
> | **~175** requests (targeted run) | **0** requests | The backlog is closed — there is nothing left to request. |
> | **~586** requests (full sweep) | **0** requests | Same. |
>
> **Authoritative source:** `docs/v6/V6_F4D_RESIDUAL_RESUME_REPORT_20261114.md` §2 (split), §4 / §4.1 (quota), §8 (idempotent re-derive command).

**Why (current, 2026-11-14):** the F4d residual sweep **ran** and **closed the backlog**:

- **29** provider requests issued → **23 saved**, **6** provider NO_TRADE, **0** rejected, **0** failed, **0** HTTP errors, **0** timeouts.
- Provider quota **12,751 → 12,715** of the 12,752 daily limit — reconciled **36/36 EXACT** against the provider header (29 fetch + 7 probes).
- Authoritative residual split after the run: **1,509 total / 1,509 NO_TRADE-proven / 0 refetchable / 0 deferred**.
- `f4d_MISSING_IN_TRADED_UNIVERSE` = **0** in all **20** November cells; readback **40/40 PASS**; sha spot-check **200/200 UNCHANGED**; **43/43** consistency checks PASS; 15,646-file backup with `verify_fail 0`.

**Exact command (idempotent; re-derives the split and issues 0 requests while the backlog is closed):**

The re-derive pipeline runs, in order:

```bash
cd /home/ubuntu/auto-cuan-runner/state/live-v6

# (1) RE-DERIVE the authoritative split from disk — READ-ONLY, 0 provider requests.
node f4d-derive.js \
  --state=/home/ubuntu/auto-cuan-runner/state/live-v6 \
  --base-dir=/home/ubuntu/auto-cuan/data/arjum-data \
  --prod-candles=/home/ubuntu/auto-cuan/data/daily-candles \
  --out-dir=/home/ubuntu/auto-cuan-runner/state/live-v6

# (2) BUILD the ordered queues — empty while the backlog is closed.
node f4d-build-queues.js

# (3) FETCH — RUN ONLY IF (1) REPORTED requests_to_issue > 0.
#     While the backlog is closed, requests_to_issue = 0, so this block is
#     skipped entirely and the command issues 0 provider requests.
if [ "$(node -e "const d=require('/home/ubuntu/auto-cuan-runner/state/live-v6/v6-f4d-residual-split.json');process.stdout.write(String(d.requests_to_issue ?? 0))")" -gt 0 ]; then
  node f4d-backup.js \
    --dates=2026-11-02,2026-11-03,2026-11-04,2026-11-05,2026-11-06,2026-11-09,2026-11-10,2026-11-11,2026-11-12,2026-11-13 \
    --base-dir=/home/ubuntu/auto-cuan/data/arjum-data \
    --root=/home/ubuntu/auto-cuan-runner/state/live-v6
  bash f4d-run.sh
fi

# (4) RE-VERIFY — READ-ONLY.
node f4c-scan.js --base-dir=/home/ubuntu/auto-cuan/data/arjum-data \
  --dates=2026-09-11,2026-11-02,2026-11-03,2026-11-04,2026-11-05,2026-11-06,2026-11-09,2026-11-10,2026-11-11,2026-11-12,2026-11-13 \
  --out=/home/ubuntu/auto-cuan-runner/state/live-v6/v6-f4d-scan-post.json \
  --spotcheck=/home/ubuntu/auto-cuan-runner/state/live-v6/v6-f4d-scan-spotcheck.csv --spot-n=10
node verify-fetch-readback.js --base-dir=/home/ubuntu/auto-cuan/data/arjum-data \
  --dates=2026-11-03,2026-11-13 --datasets=ALL,F --sample=10
```

**The only re-runnable command for this item** is the idempotent re-derive pipeline above:
`/home/ubuntu/auto-cuan-runner/state/live-v6/f4d-derive.js` → `f4d-build-queues.js` → `f4d-run.sh`.
`f4d-run.sh` is idempotent and self-skipping: it executes only the queues that exist and are non-empty, and each queue has its own checkpoint, so **re-running it issues 0 requests while the backlog is closed**.

> **RUN RULE: run `f4d-run.sh` only if `f4d-derive.js` reports `requests_to_issue > 0`.**
> While the backlog is closed `requests_to_issue = 0` and the fetch block above is skipped, so the whole pipeline costs **0 provider requests**.

**Backup:** the F4d backup already exists at `/home/ubuntu/auto-cuan-runner/state/live-v6/backup-f4d-20261114T015855Z/` (**15,646 files**, sha256 manifest, `verify_fail = 0`). The executor additionally refuses to overwrite without an atomic write, and `--strict-date-identity` prevents a wrong-date payload from landing.

**Rollback:** the executor is **additive by design** — it only adds files and never deletes. To roll back a specific pair, restore it from `backup-f4d-20261114T015855Z/` by sha256. There is no bulk rollback needed because no existing file is removed.

**Canary:**

```bash
# After the re-derive:
node -e "
const fs=require('fs');
const s=JSON.parse(fs.readFileSync('/home/ubuntu/auto-cuan-runner/state/live-v6/v6-f8-scan-post.json','utf8'));
for (const k of Object.keys(s)) {
  const c=s[k];
  console.log(k, 'files='+(c.files??c.total??'?'), 'VALID='+(c.valid??'?'),
              'STALE='+(c.stale??'?'), 'INVALID='+(c.invalid??'?'), 'NO_TRADE_FILES='+(c.no_trade_files??'?'));
}
"
# EXPECT for every date x dataset cell: STALE=0, INVALID=0, NO_TRADE_FILES=0
```

**Abort conditions:**
- `f4d-derive.js` reports `requests_to_issue > 0` → **do not fetch silently.** Stop and get a fresh authorisation; the split must be re-derived and approved before any provider request is issued.
- Any cell reports `STALE > 0` or `INVALID > 0` after the re-verify → **STOP**; do not promote.
- The provider returns a **date-identity mismatch** → the executor rejects it (that is the F4b defect class). Do not disable `--strict-date-identity`.
- HTTP 429 appears → the executor honours `Retry-After`; if it persists, **STOP** and re-check the remaining budget.

**Risk:** **NONE** while the backlog is closed — steps (1), (2) and (4) are read-only and step (3) is skipped, so **0 provider requests** are issued and **no production file is written**. If `requests_to_issue > 0` is ever reported, the risk returns to **LOW** for the data plane (additive, verified, backed up, checkpointed) and **MEDIUM** for quota, and a fresh authorisation is required first.

**Estimated quota cost:** **0 requests** while the backlog is closed (the F4d sweep that closed it cost 29 requests, already spent and reconciled 36/36 EXACT). If and only if `f4d-derive.js` reports `requests_to_issue > 0` does the fetch block run, and it still honours `--min-remaining 500`.

**Owner:** data-platform owner. **Priority: 8 of 8 — no action required while the backlog is closed; the only re-runnable action is the idempotent re-derive above, and only after approvals #1/#2 are in place so the data does not go stale again.**

---

## APPROVAL #9 — Identify the writer of `data/quota-state.json` at 21:55 WIB

**Why:** the file's `updatedAt` is `2026-11-13T14:55:08.179Z` = **21:55:08 WIB**, strictly inside the F5b window (21:30–22:25) but *not* produced by any F5b script (the F5b report grep-verified that the string `quota-state.json` appears only in its two read-only audit scripts). A cron job cannot be the writer because every cron job exits 126.

**Exact command (read-only, no code change):**

```bash
# Run for ~10 minutes around the next expected write; harmless and read-only.
sudo inotifywait -m -e modify /home/ubuntu/auto-cuan/data/quota-state.json
# In parallel, in the next window:
sudo auditd -w /home/ubuntu/auto-cuan/data/quota-state.json -p wa -k quota_state
ausearch -k quota_state -i
```

**Fallback (no sudo / no auditd):**

```bash
# Poll the writer with lsof while the file changes:
while true; do
  ls -l --time-style=full-iso /home/ubuntu/auto-cuan/data/quota-state.json
  lsof /home/ubuntu/auto-cuan/data/quota-state.json 2>/dev/null
  sleep 5
done
```

**Rollback:** N/A — read-only observation.

**Canary:** the writer's PID/process name is captured in the audit log next to the file path.

**Abort conditions:**
- The observation requires restarting or modifying a production process → **STOP**, use the read-only `lsof` variant instead.

**Risk:** **NONE** (read-only). **Estimated quota cost:** **0**.

**Owner:** VPS operator. **Priority: 9 — diagnostic, can run in parallel with #1.**

---

## APPROVAL #10 — Re-base the quota limit constant from 18,080 to 12,752 (all 4 deployed files)

**Why (F8-confirmed, APP tree):** production hard-codes the **legacy 18,080** daily quota
in **four** deployed places, while the provider's `x-ratelimit-limit` header says
**12,752**. The gap is **5,328 units (42 %)**. Consequences:
- `remaining` is computed against a limit the provider does not honour → the
  "reserve floor 5,000" gate is effectively `used + 5,328 <= 12,752`, i.e. **8,328 units
  below the real cap**, so the system can overrun the real budget before the floor trips.
- `weekendBackfillLimit: 18080` exceeds the real daily cap by 42 %.
- `lib/quota-drift.js` computes the floor against 18,080, so the drift alarm is also wrong.

**Exact commands:**

```bash
cd /home/ubuntu/auto-cuan          # <-- APP TREE (production)
mkdir -p backups/pre-limit-rebase-20261113
cp -a config/quota.json lib/quota-manager.js lib/quota-state.js lib/quota-drift.js \
      backups/pre-limit-rebase-20261113/
sha256sum config/quota.json lib/quota-manager.js lib/quota-state.js lib/quota-drift.js \
      | tee backups/pre-limit-rebase-20261113/orig.sha256

# config/quota.json
#   "preExpiryDefaultLimit": 18080 -> 12752
#   "maxQuota":               18080 -> 12752
#   "weekendBackfillLimit":   18080 -> 12752
#   (leave weekdayBackfillLimit, reserveFloor* and hardStopWIB as they are)
#
# lib/quota-manager.js:26    const TOTAL_QUOTA = 18080;  ->  const TOTAL_QUOTA = 12752;
# lib/quota-state.js:48,50   maxQuota / weekendBackfillLimit: 18080 -> 12752
# lib/quota-drift.js:46       { maxQuota: 18080, ... }     ->  { maxQuota: 12752, ... }

node -e "
const j=require('/home/ubuntu/auto-cuan/config/quota.json');
console.log('maxQuota',j.maxQuota,'preExpiry',j.preExpiryDefaultLimit,'weekend',j.weekendBackfillLimit);
if(j.maxQuota!==12752||j.preExpiryDefaultLimit!==12752||j.weekendBackfillLimit!==12752){process.exit(1);}
console.log('LIMIT RE-BASED OK');
"
pm2 reload auto-cuan-vps-api --update-env
```

**Rollback:**

```bash
cd /home/ubuntu/auto-cuan
cp -a backups/pre-limit-rebase-20261113/quota.json config/quota.json
cp -a backups/pre-limit-rebase-20261113/quota-manager.js lib/quota-manager.js
cp -a backups/pre-limit-rebase-20261113/quota-state.js lib/quota-state.js
cp -a backups/pre-limit-rebase-20261113/quota-drift.js lib/quota-drift.js
pm2 reload auto-cuan-vps-api --update-env
sha256sum -c backups/pre-limit-rebase-20261113/orig.sha256
```

**Canary:**

```bash
node -e "
const q=require('/home/ubuntu/auto-cuan/lib/quota-state.js');
const s=q.readState();
console.log('effectiveDailyLimit =', s.effectiveDailyLimit);   // EXPECT 12752
console.log('upstreamDailyLimit  =', s.upstreamDailyLimit);    // EXPECT 12752 (not null)
"
# The provider header must agree:
curl -sI -H "X-API-Key: $ARJUM_API_KEY" \
  'https://stock.arjum.com/api/broker-summary/BBRI?date=2026-11-13&all_data=true' \
  | grep -i 'x-ratelimit'
# EXPECT: x-ratelimit-limit: 12752
```

**Abort conditions:**
- The provider header does **not** say 12,752 → **STOP**; do not re-base to a wrong number.
- `readState()` still returns `effectiveDailyLimit: null` → **STOP**, the override is not wired.
- Any consumer starts reporting a different reserve floor → **STOP** and roll back.

**Risk:** **MEDIUM-HIGH.** This changes the number every quota decision is computed from.
It is a **reduction** in the enforced budget, so it cannot cause an overrun; the risk is
that a workflow that was sized against 18,080 now hits the floor earlier. That is the
intended behaviour.

**Estimated quota cost:** **1** request (the header verification).

**Owner:** backend owner (quota). **Priority: 3 of 10 — do this together with #7.**

---

## CONSOLIDATED APPROVAL TABLE

| # | Change | Risk | Quota cost | Unblocks | Priority |
|---|---|---|---|---|---|
| 1 | `chmod 755` ×6 + `git update-index --chmod=+x` ×6 — **in the APP tree `/home/ubuntu/auto-cuan`** | LOW-MEDIUM | 0 (floor guard exits 0) | Gates B, D, F + the entire cron chain | **1** |
| 2 | Crontab 19:45→20:00 / 20:00→20:15 | MEDIUM | up to ~1,660/weekday (post-reset) | Schedule truthfulness (NREQ-06) | **2** |
| 3 | Deploy `lib/broksum-provenance.js` + `lib/arjum-client.js` wiring | MEDIUM | 0 | Provenance guard in production | **3** |
| 4 | Guard `api/sector-hot.js` + `lib/backtest-individual-964.js` | MEDIUM-HIGH | 0 | Full provenance coverage | **4** |
| 5 | Refresh `latest.json` / accumulation / hunter indexes | MEDIUM | 0 | Rolling-index freshness | **5** |
| 6 | Deploy local `lib/broker-accumulation-local.js` | HIGH | 0 | D-producer parity with local HEAD | **6** |
| 7 | Reconcile `data/quota-state.json` drift | MEDIUM | 1 | Quota truthfulness (Gate D) | **7** |
| 8 | **CLOSED (F4d, 2026-11-14)** — idempotent re-derive only (`f4d-derive.js` → `f4d-build-queues.js` → `f4d-run.sh`); run `f4d-run.sh` **only if `requests_to_issue > 0`** | NONE while closed | **0** | Residual **1,509 pairs, all NO_TRADE-proven, 0 refetchable** — backlog CLOSED 2026-11-14 09:02 WIB | **8** (closed) |
| 9 | Identify the 21:55 quota-state writer | NONE | 0 | Drift forensics | 9 (parallel) |
| 10 | Re-base the quota limit 18,080 → 12,752 in 4 deployed files (**APP tree**) | MEDIUM-HIGH | 1 | Correct quota authority (Gate D) | **3** |

**Minimal next approvals to unblock the release: #1, #2, #3, #7, #10.** With those five, Gates B, D and F move, the cron chain runs, the quota limit becomes the provider's real 12,752, the quota state becomes truthful, and the provenance guard is live. **#8 is CLOSED (F4d, 2026-11-14) — the data-completeness gap it targeted is already closed, so it is no longer part of the minimal set**; #5 refreshes the rolling indexes; #4 and #6 are hardening; #9 is diagnostic.

---

## PROVENANCE

- Every "current" value in this document was measured on the VPS by the F8 read-only probes (`tmp_f8/f8_vps_witness*.sh`) on 2026-11-13 at 22:37–22:40 WIB, or is quoted from a F4c/F5b/F7 artifact with its source named inline.
- The schedule diff in #2 is the **proposed** diff from `docs/v6/V6_SCHEDULE_FIX_PROPOSAL.md`, which was itself derived from the live `crontab -l` captured by F7 and re-read by F8.
- **No command in this document was executed.** Nothing in this document is a record of an applied change.
