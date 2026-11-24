# V6 BROKSUM HOTFIX RELEASE CANDIDATE

**Document Identification:** `docs/v6/V6_BROKSUM_HOTFIX_RELEASE_CANDIDATE.md`  
**Classification:** OPERATIONAL INTEGRITY & RESILIENCE DIRECTIVE  
**Target Subsystems:** Cron Wrapper Execution, Daily Broker Runner Logic, Quota Preflight Guard, Multi-Day Historical Gap Catchup.  
**Release Readiness:** Candidate Ready for Review & Deployment (PR V6 Scope).

---

## 1. DEFECT MANIFEST & ROOT CAUSES ADDRESSED

Based on real forensic evidence collected from the VPS environment (`168.110.221.197`):

| Defect ID | Severity | Root Cause Discovered | Hotfix Remediation |
|---|---|---|---|
| **BUG-V6-BS-001** | **CRITICAL** | `deploy/vps/job-wrapper.sh` and `run-daily-market-update.sh` tracked in git with `100644` (non-executable), causing `/bin/sh: Permission denied` on cron invocation. | Update git filemode to `100755` (`git update-index --chmod=+x`), and ensure `install-cron-entries.sh` explicitly calls `chmod +x` on all scripts in `deploy/vps/`. |
| **BUG-V6-BS-002** | **HIGH** | `pendingDates()` in `tools/run-daily-market-update.js` strictly limits automatic historical lookback to `H-1`. If >1 day is missed due to server downtime or permissions, standard cron never heals the gap. | Introduce bounded gap backfill in `pendingDates()` (up to 5 recent trading days if quota allows) or ensure `tools/catchup-missing-dates.js` is wired cleanly to recover multi-day gaps. |
| **BUG-V6-BS-003** | **HIGH** | Rescue/Catchup scripts burned 18,125 requests in 4.18s on 3 Nov, tripping upstream HTTP 429 rate limit. | Enforce atomic quota reservation and throttle delay in batch runners (`arjumClient` minimum delay >= 250ms per ticker, maximum concurrent batch <= 5). |
| **BUG-V6-BS-004** | **MEDIUM** | In `run-daily-broker-update.js`, when ALL is cached but Foreign (flow=F) is missing, retry logic was previously coupled. | Retain independent Foreign retry logic without invalidating or overwriting existing valid ALL broker summaries. |

---

## 2. LOCAL CODE HOTFIX CANDIDATES

### Hotfix 1: Git Executable Permissions Enforcement (`deploy/vps/install-cron-entries.sh`)
Ensure that the installer and deployment script enforce executable permissions locally in git and upon installation:

```bash
# In deploy/vps/install-cron-entries.sh
chmod +x "$REPO_DIR/deploy/vps/"*.sh || true
chmod +x "$REPO_DIR/deploy/vps/job-wrapper.sh" || true
```

And in git index:
```bash
git update-index --chmod=+x deploy/vps/job-wrapper.sh
git update-index --chmod=+x deploy/vps/run-daily-market-update.sh
git update-index --chmod=+x deploy/vps/run-daily-candles.sh
git update-index --chmod=+x deploy/vps/run-idx-suspension-guard.sh
git update-index --chmod=+x deploy/vps/run-fundamental-refresh.sh
```

---

### Hotfix 2: Bounded Multi-Day Gap Healing in `tools/run-daily-market-update.js`

Enhance `pendingDates()` to safely inspect up to 5 trading days if prior sessions are incomplete and within quota budget:

```javascript
// Enhancement in tools/run-daily-market-update.js
function pendingDates(now = new Date(), options = {}) {
  // ... existing options and rollover logic ...

  const explicitDate = resolveExplicitDate(options);
  if (explicitDate) return [explicitDate];

  const evalTime = (options && options.startTime) || now || new Date();
  const { dateKey, hour } = broker.getJakartaTimeInfo(evalTime);
  const holidays = calendar.getSeedHolidaySet();

  // EOD work allowed only from 18:00 WIB on trading days
  if (hour < 18 || !calendar.isTradingDay(dateKey, holidays)) return [];

  const dates = [dateKey];

  // Safely check up to maxLookback trading days (default: 3 days on regular evening, 5 on --final)
  const isFinal = Boolean(options && (options.final || (options.argv && options.argv.includes('--final'))));
  const maxLookback = isFinal ? 5 : 2;
  
  let current = dateKey;
  for (let i = 0; i < maxLookback; i++) {
    const prev = calendar.previousTradingDay(current, holidays);
    if (!prev) break;
    if (previousDateNeedsWork(prev)) {
      dates.push(prev);
    }
    current = prev;
  }

  return dates;
}
```

---

### Hotfix 3: Safe Controlled Catchup Runner (`tools/catchup-missing-dates.js`)

Ensure that the catchup runner respects quota floors and does not flood the upstream API:

```javascript
// Guardrail in tools/catchup-missing-dates.js
const MIN_REQUEST_DELAY_MS = 350; // Respect vendor rate limits
const MAX_CATCHUP_TICKERS_PER_PASS = 100; // Chunk into safe passes
```

---

## 3. VERIFICATION & VALIDATION PROTOCOL

Before promoting this candidate to production VPS:
1. **Verification of Git Modes:**
   Execute `git ls-tree HEAD deploy/vps/` and verify mode is `100755` for all shell runners.
2. **Local Simulation Test:**
   Execute `node tools/run-daily-market-update.js --dry-run` and verify `pendingDates()` properly detects incomplete dates.
3. **Rollback Plan:**
   If any regression is detected in automated gates, revert to baseline `ae5d1892` and restore original wrapper invocations.

---

**Ratified by:** Auto-Cuan V6 Architecture & Debug Directorate  
**Date:** 2026-11-11
