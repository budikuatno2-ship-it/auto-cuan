# V6 GIT BASELINE AND WORKSPACE DIFF AUDIT

**Generated At:** 2026-11-10T15:53:00+07:00 (WIB)  
**Workspace:** `d:\auto-cuan-2`  
**Current Active Branch:** `feat/v6-recovery`  
**Current Local HEAD SHA:** `ae5d18924955217c7e74d1d7909b3ef12f471d00`  
**Baseline SHA:** `ae5d18924955217c7e74d1d7909b3ef12f471d00` (`Merge pull request #928 from budikuatno2-ship-it/release/v5-final-20261109`)  
**VPS Production HEAD SHA:** `ae5d18924955217c7e74d1d7909b3ef12f471d00` (Detached HEAD at `ae5d1892`)

---

## 1. Executive Summary & Git Topology

Local workspace `d:\auto-cuan-2` is positioned exactly on `feat/v6-recovery` which points to baseline commit `ae5d18924955217c7e74d1d7909b3ef12f471d00`. There are 0 unpushed local commits against baseline `ae5d1892`, but there is a rich working tree set of **20 modified tracked files** and **34 untracked files/directories** implementing V6 critical fixes, review packages, test suites, and subtask recovery utilities.

On VPS production (`168.110.221.197`), the repository is also checked out at `ae5d18924955217c7e74d1d7909b3ef12f471d00` (detached HEAD, matching the PR #928 merge from Nov 9, 2026).

---

## 2. Modified Tracked Files (Local Working Tree vs `ae5d1892`)

Total: 20 files changed, 1196 insertions(+), 436 deletions(-)

| File Path | Changes | Architectural Purpose & Scope |
|---|---|---|
| [`api/admin-logs.js`](api/admin-logs.js:1) | +24 / -1 | Admin logs query sanitization & range limit |
| [`api/admin-users.js`](api/admin-users.js:1) | +96 / -0 | User role management & account approval API |
| [`api/struktur-pasar.js`](api/struktur-pasar.js:1) | +214 / -3 | Market structure algorithm upgrade & manual override handling |
| [`api/track-record.js`](api/track-record.js:1) | +3 / -2 | Track record caching and reader integration |
| [`data/market-structure-manual-overrides.json`](data/market-structure-manual-overrides.json:1) | +1 / -1 | Market structure override configuration |
| [`docs/evidence/fase-6/TICKER_962_AUDIT.json`](docs/evidence/fase-6/TICKER_962_AUDIT.json:1) | +274 / -274 | 962 universe audit evidence updates |
| [`lib/chart-engine/candle-fetcher.js`](lib/chart-engine/candle-fetcher.js:1) | +4 / -2 | Candle fetcher caching and source fallback fixes |
| [`lib/quota-manager.js`](lib/quota-manager.js:1) | +33 / -13 | Quota guardrail floor 5000 & weekday hard-stop rules |
| [`public/admin-console-runtime.js`](public/admin-console-runtime.js:1) | +12 / -1 | Admin console UI reactivity & status updates |
| [`public/admin-tools-runtime.js`](public/admin-tools-runtime.js:1) | +18 / -0 | Admin tools diagnostic helper |
| [`public/analisis-saham-runtime.js`](public/analisis-saham-runtime.js:1) | +55 / -9 | Stock analysis reactive UI & candle crosshair sync |
| [`public/analisis-saham.html`](public/analisis-saham.html:1) | +25 / -13 | Full-viewport bento layout & accessibility improvements |
| [`public/analisis-v2.js`](public/analisis-v2.js:1) | +98 / -16 | Analisis V2 quantitative precision formatting |
| [`public/bandarmologi-runtime.js`](public/bandarmologi-runtime.js:1) | +6 / -3 | Broker flow visualization updates |
| [`public/index.html`](public/index.html:1) | +171 / -18 | Landing page and main dashboard bento grid integration |
| [`public/market-feature-runtime.js`](public/market-feature-runtime.js:1) | +25 / -3 | Market feature telemetry and display components |
| [`public/portfolio-command-center.js`](public/portfolio-command-center.js:1) | +2 / -2 | Portfolio calculation bug fix |
| [`tools/fetch-daily-candles.js`](tools/fetch-daily-candles.js:1) | +40 / -11 | EOD Yahoo fetcher with cross-check & fallback |
| [`tools/run-daily-broker-update.js`](tools/run-daily-broker-update.js:1) | +23 / -12 | Wave 2 broker update state management |
| [`tools/run-lifecycle-evaluator.js`](tools/run-lifecycle-evaluator.js:1) | +97 / -27 | Lifecycle evaluation against SQLite & flat-files |

---

## 3. Untracked Files Inventory

Total: 34 items

### Test Suites (V6 Verification Gate):
- `test/v6-chart-engine-overhaul.test.js`
- `test/v6-cross-page-ui-fixes.test.js`
- `test/v6-hourly-confirmation.test.js`
- `test/v6-ownership-hsc.test.js`
- `test/v6-pipeline-quota-audit.test.js`
- `test/v6-saham-potensial-lifecycle.test.js`
- `test/v6-subtask2-critical-fixes.test.js`

### Core Engines & Handlers:
- `lib/admin-ownership-import.js`
- `lib/saham-potensial-engine.js`
- `lib/saham-potensial-lifecycle.js`
- `lib/short-swing-hourly-confirmation.js`
- `lib/track-record-reader.js`
- `public/admin-ownership.html`

### Diagnostic & Fix Automation Tools:
- `tools/audit-payload-sanitization.js`
- `tools/build-v6-review-package.js`
- `tools/copy-payload-src.js`
- `tools/debug-row.js`
- `tools/fix-req-01.js`
- `tools/fix-req-03.js`
- `tools/fix-req-07-08.js`
- `tools/fix-req-10.js`
- `tools/fix-req-15.js`
- `tools/fix-req-16.js`
- `tools/fix-req-17.js`
- `tools/fix-req-18-19.js`
- `tools/fix-req-23-24.js`
- `tools/fix-req-25.js`
- `tools/fix-req-27.js`
- `tools/fix-req-32.js`
- `tools/generate-payload-manifest.js`
- `tools/package-zip-export.js`
- `tools/run-all-ticker-chart-audit.js`
- `tools/verify-zip-extraction.js`

### Operational Scripts & Backups:
- `v5-cutover.sh`
- `v5-rollback.sh`
- `data/backups/`
- `data/security/ownership-audit.log.jsonl`
- `data/telegram-dry-run.jsonl`
- `tmp_vps_forensic/`
- `docs/v6/`

---

## 4. Verification Checkpoint Status

| Item | Local Workspace | VPS Production | Status |
|---|---|---|---|
| Commit SHA | `ae5d18924955217c7e74d1d7909b3ef12f471d00` | `ae5d18924955217c7e74d1d7909b3ef12f471d00` | MATCH |
| Active Branch | `feat/v6-recovery` | `HEAD (detached)` | EXPECTED |
| Working Diff | 20 modified files | Clean git tree (deleted transient logs) | ISOLATED |

---

## 5. Heap Dump Stability & Secure Crawl Guardrails

| Control | Value |
|---|---|
| Terminal `zombiekwok` active polling interval | unified 10 min (per-terminal self-refresh) |
| Secure `object-scan` crawling delta | bounded to 10 new MCP/Skill descriptors per pass (cap 30, exclude `runtime/user/*`) |
| Heap dump | disabled (non-PII, stable heap detected) |

---

## 6. ZIP Archive Re-Verification (RUN_20261110_171130_WIB)

**Archive:** `D:\AUTO_CUAN_V6_REVIEW\RUN_20261110_171130_WIB\EXPORTS\AUTO_CUAN_V6_REVIEW_RUN_20261110_171130_WIB.zip`

| Metric | Reported Value | Re-computed Value | Status |
|---|---|---|---|
| SHA-256 | `305ada90e6193458709778c31dc4a1a01411d7af8120cb914a61165c60e509ac` | `305ada90e6193458709778c31dc4a1a01411d7af8120cb914a61165c60e509ac` | ✅ MATCH |
| ZIP file size (bytes) | 1,947,020 (`PACKAGE_RESULT.json`) | 1,947,020 (disk) | ✅ MATCH |
| MANIFEST `totalFiles` | 101 | 101 | ✅ MATCH |
| MANIFEST `totalBytes` | 4,510,271 | — | ✅ (see note) |
| ZIP entries (actual) | — | 102 | ℹ️ +1 = embedded `MANIFEST.json` (16,908 B) |
| ZIP uncompressed bytes | — | 4,527,179 | ℹ️ = manifest 4,510,271 + MANIFEST.json 16,908 |
| ZIP dir entries | — | 0 | ✅ flat archive |
| `PACKAGE_RESULT.json` extraction | `extractionVerified=101`, `extractionFailed=0` | consistent | ✅ |

**Conclusion:** ZIP integrity is intact. The `MANIFEST.json` shipped inside the ZIP is not counted in its own `totalFiles`/`totalBytes`; the archive's 102nd entry is exactly that self-describing manifest. All 101 declared payload entries match the `CHECKSUMS.sha256` map (verified during extraction `TEST_EXTRACT`).

**Release gate snapshot (from `PACKAGE_RESULT.json`):** A=`PARTIAL_READY`, B=`PASS`, C=`PASS_LOCAL`, D=`PARTIAL`, E=`PARTIAL`, F=`BLOCKED_APPROVAL_REQUIRED`.
