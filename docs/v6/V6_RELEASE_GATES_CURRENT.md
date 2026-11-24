# V6 Release Gates — Current Verdicts (V6 Super-Master final phase)

**Scope:** final verdict sweep — real-data proof, fresh VPS witness, 111-ID re-verify (69 legacy + 42 CHT), gates A–F.
**Observed at:** 2026-11-16 ~00:16–00:25 WIB (`TZ=Asia/Jakarta`). VPS **read-only**. **0** provider API requests. **0** production writes.
**Branch / HEAD:** `feat/v6-recovery` @ `ae5d18924955217c7e74d1d7909b3ef12f471d00` (unchanged — no commit/push/reset/clean/stash; no file deleted; no test weakened).
**Status vocabulary:** `PROVEN_LOCAL` / `E2E_PROVEN_STAGING` / `PROVEN_LOCAL_LOGIC` / `PARTIAL` / `FAIL` / `NOT_TESTED` / `BLOCKED_APPROVAL` / `BLOCKED_UPSTREAM` / `BLOCKED_DATA`.
**Production verification:** **NOT performed** → **zero** `PROVEN_PRODUCTION` anywhere.

**New evidence this pass:** `docs/v6/V6_VPS_REAL_DATA_PROOF.csv` / `.md` (180-row anti-mock proof) and `docs/v6/V6_ALL_111_REQUIREMENTS_VERDICTS.csv` (111 rows).

---

## Gate A — Data pipeline & parity (Yahoo → SQLite → consumers)

**Verdict: PARTIAL**

| Item | Verdict | Evidence |
|---|---|---|
| Broker-summary payloads are REAL provider data | **PROVEN_LOCAL** | `docs/v6/V6_VPS_REAL_DATA_PROOF.md`: 180/180 sampled keys `REAL_PROVIDER_DATA`, 180 distinct sha256, 55 real IDX broker codes, 7,728 broker entries with institutional IDR values; date-identity VALID 180/180 |
| Broker-summary (ALL/F/D) producer | PROVEN_LOCAL | VPS counts ALL 208,820 · F 200,376 · D 199,078; 2026-11-13 = ALL 834 / F 698 / D 679 |
| D dataset derived | PROVEN_LOCAL | 199,078 files re-verified on VPS (matches F5b) |
| November broker-summary coverage | PROVEN_LOCAL | 10 dates × 2 datasets complete against the candle-proven traded universe (F4d) |
| **SQLite history layer fresh** | **FAIL** | canonical `/home/ubuntu/auto-cuan-data/market.sqlite` KV `market_rows` (225,117 rows) — `stock_daily_history` max `updated_at` **2026-11-02**; stale tail |
| **Candle layer fresh** | **PARTIAL** | `daily-candles/*.json` (`source:yahoo`) last bar **2026-11-11** — 2 days staler than broker-summary (2026-11-13) |
| **7,931 UNKNOWN_CANDLE** | **PARTIAL** | P0-A residual; unresolved candle refs, not fabricated |
| **IHSG layer** | **FAIL** | `daily-candles/IHSG.json` has **0 candles** (keys `candles_120`, `simulated`); SQLite IHSG rows only to 2026-10-26; scale mismatch 7505.5 vs 5266.13 (W6); `run-ihsg-candle.sh` 664 → cron 126 |
| **2026-11-16 EOD** | **BLOCKED_DATA** | 0 files for 2026-11-16 in ALL/F/D — Monday 16 Nov is a trading day but its EOD is **not yet published** at 00:16 WIB (expected; not faked) |
| Rolling indexes (`latest.json` etc.) | NOT REFRESHED | bandarmologi-intel-indexes/latest.json mtime 2026-11-04 12:20 → approval #5 |
| `data/market.db` decoy | FAIL | size=0 (decoy) |

**Flip condition to PROVEN_LOCAL:** SQLite rehydration (approval #7); IHSG scale + candle build (approval #8); rolling-index refresh (approval #5); candle layer advanced to 2026-11-13; 2026-11-16 EOD published after Monday close.

---

## Gate B — Scheduler / cron truthfulness

**Verdict: PARTIAL** (code PROVEN_LOCAL; runtime BLOCKED_CRON_126)

| Item | Verdict | Evidence |
|---|---|---|
| Crontab present and complete | PROVEN_LOCAL | `crontab -l` full V5 schedule; `CRON_TZ=Asia/Jakarta`; every entry calls `job-wrapper.sh` |
| Wrapper executable | **FAIL (runtime)** | `job-wrapper.sh` / `run-daily-market-update.sh` / `run-ihsg-candle.sh` all mode **664**, mtime 2026-11-09 20:23:36–37 +0700; `logs/cron/` = **0 files** (dir mtime Oct 30 20:33) |
| Git tracking of the exec bit | **FAIL (root cause)** | `git ls-files -s` = **100644** for all three; plus 12 more `100644` `.sh` under `deploy/vps/` (`run-daily-candles.sh`, `run-fundamental-refresh.sh`, `run-idx-suspension-guard.sh`, `run-backlog-age-alarm.sh`, `run-catchup-missing-dates.sh`, `run-cloudflared-webhook.sh`, `run-broker-hunter-indexer.sh`, `pull-financials.sh`, `check-pm2-mem.sh`, `s1-harden.sh`, `smoke-4-pilar.sh`, `lib/load-env.sh`) → a redeploy reproduces 664 |
| Cron activity since 15 Nov | **NONE** | no new cron log/heartbeat; `logs/cron/` empty; `job-heartbeat` latest entries pre-date 2026-11-11 |
| Schedule times vs 20:00 WIB target | PARTIAL | live crontab still 19:45/20:45 era → approval #2 |
| **Screener/short-swing output freshness** | **NOT_READY (AS_OF_STALE)** | no live cron cycle |
| PM2 process health | PROVEN_LOCAL | `pm2 jlist`: `auto-cuan-vps-api` pid 3349642 `status: online` (fork_mode, cwd `/home/ubuntu/auto-cuan`) |

**Flip condition to PROVEN_LOCAL:** approval #1 (chmod + `git update-index --chmod=+x`) + approval #2 (crontab 19:45→20:00) + one green production cron cycle.

---

## Gate C — Product surfaces (chart / UI)

**Verdict: PARTIAL** — the 42 CHT are now **42/42 covered locally**, but production deploy is **not approved**, so Gate C does **not** rise to PROVEN_LOCAL.

| Item | Verdict | Evidence |
|---|---|---|
| Chart render universe | PROVEN_LOCAL | `V6_ALL_IDX_CHART_BROWSER_MATRIX.csv`: 962 BROWSER_RENDER_PASS + 1 EXPECTED_NO_DATA |
| **CHT chart-feature contract (42)** | **PROVEN_LOCAL (local coverage)** | `V6_ALL_111_REQUIREMENTS_VERDICTS.csv`: **29 PROVEN_LOCAL + 10 E2E_PROVEN_STAGING + 3 PROVEN_LOCAL_LOGIC = 42/42** |
| Chart test suite (F1/F2/F3) | PROVEN_LOCAL | `node --test test/v6/chart-*.test.js` → **176 tests / 175 pass / 1 fail**; the single failure is `chart-browser-e2e-f3.test.js:169` (browser E2E) under concurrent multi-file load — it **passes 5/5 standalone** (flaky under load, not a hard defect) |
| Drawing tools (13B) | PROVEN_LOCAL | `test/v6/chart-drawing-tools.test.js` |
| What's New (13A) / Manual Screener (13E) / Insider filters (13D) / HSC as_of (13C) | PROVEN_LOCAL | W2a/W2b suites |
| Video bug retest | PARTIAL | `V6_23_VIDEO_BUGS_RETEST.csv`: 21 PASS_VERIFIED + 2 PASS_UNIT_ONLY |
| Short Swing Top5 == Top20[0..4] | PROVEN_LOCAL (artifact) / BLOCKED (content) | every row NOT_READY (AS_OF_STALE) |

**Why Gate C stays PARTIAL (not PROVEN_LOCAL):** (1) production deploy is not approved (approval #10) so no `PROVEN_PRODUCTION`; (2) the browser E2E is flaky under concurrent load (1 observed failure); (3) Short Swing content remains NOT_READY (AS_OF_STALE) pending the cron cycle.

**Flip condition to PROVEN_LOCAL (actionable):** deploy the new features (approval #10) + a live cron cycle (approval #1) so the screener/short-swing consumer produces non-AS_OF_STALE content.

---

## Gate D — Quota authority & the `STALE_CONSUMER` class

**Verdict: FAIL (runtime) / PROVEN_LOCAL (code)**

| Item | Verdict | Evidence |
|---|---|---|
| Quota authority code | PROVEN_LOCAL | `test/v5/quota-admin-console.test.js` 13/13; `test/v6-pipeline-quota-audit.test.js` PASS |
| **Quota runtime enforcement** | **FAIL (BLOCKED_CRON_126)** | reserve floor (5,000) + 23:50 hard stop live in the cron path; `job-wrapper.sh` 664 → never executes |
| Provider budget state | FAIL | `data/quota-state.json`: `date 2026-11-13`, `upstreamUsedToday 7750`, `upstreamDailyLimit null`, `effectiveDailyLimit null`, `drift 7750`, `driftDetected true`, `hardStopLocked false` |
| Last quota-consuming run | FACT | `data/quota-burn-state.json`: started/finished **2026-11-09 06:00–06:09 WIB**, `spent 559`, `usedBefore 7193`, `usedNow 7752`, `limit 12752`, `floor 5000`, `stopped BUDGET_REACHED` |
| Plan config | FACT | `config/quota.json`: `planName "Supporter"`, `planExpiresAt 2026-11-17T23:59:59+07:00`, `maxQuota 18080`, `preExpiryDefaultLimit 18080`, `reserveFloorWeekday 5000`, `hardStopWIB "23:50"` |
| Floor-policy split | FAIL (unreconciled) | deployed manager releases weekday floor at 20:30 vs repo bridge keeps 5,000 all day |
| Quota cost discipline | PROVEN_LOCAL | 0 provider requests this pass |

**Flip condition to PROVEN_LOCAL:** approval #1 (chmod) → enforcement runs; approval #7 (reconcile quota-state); approval #6 (re-base 18,080→12,752; **HARD DEADLINE 2026-11-17** = plan expiry).

---

## Gate E — Requirements traceability (111 IDs)

**Verdict: PARTIAL**

- `docs/v6/V6_ALL_111_REQUIREMENTS_VERDICTS.csv` — **111 rows** = 42 REQ + 12 NREQ + 15 XREQ + 42 CHT; validated `rows=111`, `dupes=0`, `bad_vocab=0`, `empty_cells=0`, `PROVEN_PRODUCTION=0`.
- Inputs: `V6_REQUIREMENTS_CURRENT_VERDICTS.csv` (54) + `V6_XREQ_01_15_VERDICTS.csv` (15) = 69 legacy; `V6_CHART_FEATURE_CONTRACT.csv` (42) CHT.

**Distribution (this pass): 53 PROVEN_LOCAL · 10 E2E_PROVEN_STAGING · 3 PROVEN_LOCAL_LOGIC · 38 PARTIAL · 5 BLOCKED_APPROVAL · 1 FAIL · 1 BLOCKED_UPSTREAM · 0 PROVEN_PRODUCTION.**

| Namespace | Count | PROVEN_LOCAL | E2E_STAGING | LOCAL_LOGIC | PARTIAL | BLOCKED_APPROVAL | FAIL | BLOCKED_UPSTREAM |
|---|---|---|---|---|---|---|---|---|
| REQ | 42 | 12 | 0 | 0 | 24 | 5 | 1 | 0 |
| NREQ | 12 | 0 | 0 | 0 | 9 | 3 | 0 | 0 |
| XREQ | 15 | 12 | 0 | 0 | 2 | 0 | 0 | 1 |
| CHT | 42 | 29 | 10 | 3 | 0 | 0 | 0 | 0 |

**Changes vs previous (W8):** REQ-36 (chart universe) remains PROVEN_LOCAL with the F1/F2/F3 chart suite added; XREQ-02 (Manual Screener) evidence upgraded (19/19 + full-universe OR tests); XREQ-09 (Financial publication monitor) **downgraded** to `BLOCKED_UPSTREAM`. The 42 CHT are newly enumerated. No legacy ID was promoted to `PROVEN_PRODUCTION`.

**Flip condition to PROVEN_PRODUCTION:** a verified production run (green cron cycle + live browser E2E) per row — out of scope (read-only, no writes, no provider requests).

---

## Gate F — Release / approval

**Verdict: BLOCKED_APPROVAL**

| Item | Verdict | Evidence |
|---|---|---|
| Code fixes | PROVEN_LOCAL | W1–W7 fixes; legacy 7/7 PASS |
| No test weakening | PROVEN_LOCAL | no test deleted; assertions strengthened |
| Final regression | PARTIAL | 8,511 tests / 8,183 pass / 307 fail / 74 files; **all 74 PRE_EXISTING** (pristine-HEAD), NEW=0 |
| Worktree preservation | PROVEN_LOCAL | HEAD unchanged `ae5d1892…`; no commit/push/reset/clean/stash; no deletion |
| VPS production state | unchanged | 0 production writes; 0 provider requests |
| **Release approval** | **BLOCKED_APPROVAL** | approvals #1/#2 (chmod + crontab), #5 (rolling-index), #6 (quota re-base by 2026-11-17), #7 (quota-state), #8 (IHSG), #9 (Telegram), #10 (feature deploy) |

**Flip condition to PROVEN_LOCAL:** execute the scoped approvals in `docs/v6/V6_PRODUCTION_APPROVALS_WITH_DIFF_BACKUP_ROLLBACK.md` and re-run gates against a green production cycle.

---

## Gate summary

| Gate | Verdict | Blocking item |
|---|---|---|
| **A** — Data pipeline & parity | **PARTIAL** | SQLite stale to 11-02; candle layer to 11-11; IHSG 0 candles/scale; 2026-11-16 EOD not yet published |
| **B** — Scheduler | **PARTIAL** | `job-wrapper.sh` 664 → cron 126; no cron activity since 15 Nov |
| **C** — Product surfaces | **PARTIAL** (CHT 42/42 local) | production deploy not approved; browser E2E flaky under load; Short Swing AS_OF_STALE |
| **D** — Quota authority | **FAIL (runtime) / PROVEN_LOCAL (code)** | runtime BLOCKED_CRON_126; ledger drift 7750; floor-policy split |
| **E** — Requirements | **PARTIAL** | 53 PROVEN_LOCAL, 38 PARTIAL, 5 BLOCKED_APPROVAL, 1 FAIL, 1 BLOCKED_UPSTREAM, 0 PROVEN_PRODUCTION |
| **F** — Release | **BLOCKED_APPROVAL** | 10 documented approvals; #1 + #2 + #6 + #7 minimal set |

**Single highest-leverage action:** approval #1 — `chmod 755` on `job-wrapper.sh`, `run-daily-market-update.sh`, `run-ihsg-candle.sh` **plus** `git update-index --chmod=+x` on those and the remaining `100644` scripts in `deploy/vps/`. Unblocks Gates B, D, F and re-proves A on the next cycle.
**Second, independent, zero-quota action:** approval #7 — reconcile `data/quota-state.json`.
**Hard deadline:** approval #6 — quota re-base 18,080 → 12,752 by **2026-11-17** (plan expiry).

---

## PROVENANCE

| Gate | Source |
|---|---|
| Real-data proof | `docs/v6/V6_VPS_REAL_DATA_PROOF.csv/.md`, `tmp_vps_forensic/proof_task_a_out.txt` |
| Fresh witness | VPS read-only batches: `tmp_vps_forensic/witness_batch1..11.txt` |
| Gate A | `daily-candles/*.json`, `market.sqlite (market_rows)`, F4d/F5b reports |
| Gate B | `crontab -l`, `stat deploy/vps/*.sh`, `git ls-files -s`, `logs/cron/`, `pm2 jlist` |
| Gate C | `V6_ALL_111_REQUIREMENTS_VERDICTS.csv`, `tmp_vps_forensic/chart_tests.txt`, `browser_e2e.txt` |
| Gate D | `config/quota.json`, `data/quota-state.json`, `data/quota-burn-state.json` |
| Gate E | `V6_ALL_111_REQUIREMENTS_VERDICTS.csv` |
| Gate F | `tmp_w8/regression-classification.json`, `V6_PRODUCTION_APPROVALS_WITH_DIFF_BACKUP_ROLLBACK.md` |
