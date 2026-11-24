# AUTO-CUAN V6: VERIFIKASI DAN BUKTI PENGUJIAN REGRESI LENGKAP

**Dokumen Identifikasi:** `docs/v6/V6_VERIFICATION.md`
**Branch:** `feat/v6-recovery` @ `ae5d18924955217c7e74d1d7909b3ef12f471d00`
**Status:** **PARTIAL** — the current requirement ledger `docs/v6/V6_REQUIREMENTS_CURRENT_VERDICTS.csv` (54 rows) records **13 PROVEN / 35 PARTIAL / 5 BLOCKED / 1 FAIL / 0 NOT_TESTED**, and `docs/v6/V6_RELEASE_GATES_CURRENT.md` records **Gate E = PARTIAL**. The previous `100% PASS (Zero Failure, Zero Regresi, Zero Data Sintetik)` line was an **unqualified success claim** and is removed.
**Status vocabulary:** `PROVEN` / `PARTIAL` / `FAIL` / `NOT_TESTED` / `BLOCKED` / `CLAIM_ONLY`
**Supersedes:** the ZIP 19:33 snapshot (2026-11-10). The 33-test run reproduced in §1 is **historical**: it is the Subtask-F snapshot only.
**Tanggal Pengujian (current):** 2026-11-13 (F8 regression) + 2026-11-14 (F4d verification)
**Current regression state (2026-11-14):** legacy7 **7/7**, `test/v6` **30/30**, curated **723/808** — **79 pre-existing failures** (proven by re-running every failing file against a pristine `git archive HEAD` checkout) + **6 recovery-induced regressions** (owned in `docs/v6/V6_RECOVERY_INDUCED_REGRESSIONS.md`) — plus **25/25** new provenance-guard tests.
**Authoritative sources:** [`V6_REQUIREMENTS_CURRENT_VERDICTS.csv`](V6_REQUIREMENTS_CURRENT_VERDICTS.csv) for per-requirement verdicts and [`V6_RELEASE_GATES_CURRENT.md`](V6_RELEASE_GATES_CURRENT.md) for gate verdicts. Where the matrix in §2 below disagrees with the CSV, **the CSV wins**.

---

## 1. RINGKASAN HASIL REGRESI SUITE V6

> **HISTORICAL SNAPSHOT — ZIP 19:33 (2026-11-10).** The 33-test output below is the Subtask-F snapshot `node --test test/v6-*.test.js`. It is preserved verbatim for traceability and is **not** the current regression state. **Current (2026-11-14, F8/F4d):** legacy7 **7/7**, `test/v6` **30/30**, curated **723/808** (79 pre-existing + 6 recovery-induced), 25/25 provenance-guard tests. See `docs/v6/V6_FINAL_CONSOLIDATED_REPORT_20261113.md` §6 and `docs/v6/V6_RECOVERY_INDUCED_REGRESSIONS.md`.

Pengujian otomatis dijalankan secara mandiri pada environment lokal node runtime `v24.19.0` mencakup seluruh klaster perbaikan Subtask A hingga Subtask F:

```bash
node --test test/v6-*.test.js
```

### Hasil Eksekusi Test Suite:
```text
✔ Chart Engine: REQ-13 - Validasi Matematis Percentile p10-p90 vs Target Harga (35.7ms)
✔ Chart Engine: REQ-11 & REQ-12 - Proteksi Plan Usang / Deviasi Entry vs Quote Aktif (0.7ms)
✔ Chart Engine: REQ-14 - Clean Presentation & Anti-Clutter Contract (1.7ms)
✔ REQ-01: Kalkulator Landing entry matches lot & modal calculation (9.8ms)
✔ REQ-03: Auth UI sync hides login buttons when logged in (8.8ms)
✔ REQ-07 & REQ-08: Table thead alignment for Konglo and Non-Konglo screeners (10.4ms)
✔ REQ-10: Sektor Hot transient blank prevention (8.0ms)
✔ REQ-15: Bandarmologi Intel adaptive timeout (4.6ms)
✔ REQ-16: Insider Network adaptive radius for collision avoidance (3.3ms)
✔ REQ-17: Ranking sorting by transaction value (2.5ms)
✔ REQ-18 & REQ-19: Financial overview real statements & badge (2.0ms)
✔ REQ-23 & REQ-24: Smooth scroll on Portfolio navigation (10.3ms)
✔ REQ-25: Quote freshness confirmation text in portfolio (2.4ms)
✔ REQ-27: Subscription lifetime active recognition (9.6ms)
✔ REQ-32: Security panel fallback to real forensic events (2.3ms)
✔ V6-OWNERSHIP-1: Indonesian number parsing handles various formats cleanly (2.4ms)
✔ V6-OWNERSHIP-2: HSC boolean parsing is fail-closed (unknown returns null, not false) (0.6ms)
✔ V6-OWNERSHIP-3: Ownership CSV parser validates headers and produces structured records (4.2ms)
✔ V6-OWNERSHIP-4: Ownership JSON parser catches invalid percentages and duplicate tickers (1.2ms)
✔ V6-OWNERSHIP-5: HSC list parser supports reconciliation fields and null status (2.1ms)
✔ V6-OWNERSHIP-6: api/struktur-pasar returns accurate roster, reconciliation and neutral HSC (174.7ms)
✔ V6-OWNERSHIP-7: Low free float < 15% does not automatically set HSC=true (0.6ms)
✔ V6-OWNERSHIP-8: Backup, Rollback, and Audit logging mechanism operates safely (531.8ms)
✔ V6 Candle Normalization: Missing/null volume must NOT be coerced to 0 (30.7ms)
✔ V6 Quota Engine: Field discipline and unknown limit handling (42.4ms)
✔ V6 Broker Ledger: Independent Foreign Retry Logic (0.3ms)
✔ Subtask C: 1. Risk/Reward calculation on max_entry (7.5ms)
✔ Subtask C: 2. Actionable Short Swing Candidate when RR >= 1.5 on max_entry (0.6ms)
✔ Subtask C: 3. Dynamic Universe & Real Variable Metrics (No Uniform Dummy) (2.5ms)
✔ Subtask C: 4. Top 20 & Top 5 Determinism and Pure Subset (No Padding) (6.2ms)
✔ Subtask C: 5. Short Swing Lifecycle State Machine Transitions (1.5ms)
✔ Subtask C: 6. Date Normalization (YYYY-MM-DD) (0.4ms)
✔ Subtask C: 7. Resilient Track Record & Backtest Reader (56.0ms)

ℹ tests 33
ℹ suites 0
ℹ pass 33
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 948.3ms
```

---

## 2. AUDIT MATRIKS REKONSILIASI KEBUTUHAN (42 REQUIREMENTS AUDIT) — HISTORICAL SUBTASK-F MATRIX

> **READ THIS FIRST (2026-11-14, F8b).** The `PASS` markers in this matrix are the Subtask-F assertions of **2026-11-10**, **not** the current verdicts. The current authoritative verdicts for all 54 requirements (REQ-01..42 plus NREQ-01..12) are in [`V6_REQUIREMENTS_CURRENT_VERDICTS.csv`](V6_REQUIREMENTS_CURRENT_VERDICTS.csv): **13 PROVEN / 35 PARTIAL / 5 BLOCKED / 1 FAIL**. Requirements marked `PASS` below that today read `PARTIAL`, `BLOCKED` or `FAIL` in the CSV include REQ-19, REQ-22, REQ-23, REQ-24, REQ-25, REQ-27, REQ-32, NREQ-01..03, NREQ-05..11 (all `PARTIAL`), NREQ-04 and NREQ-12 (both `BLOCKED`), and one requirement at `FAIL`. The CSV is the authority; this matrix is history.

| Req ID | Deskripsi Singkat | Status Verifikasi | File / Test Bukti |
|---|---|---|---|
| **REQ-01** | Kalkulator Landing Entry sinkron 1.210 vs 133 lot | **PASS** | `public/index.html`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-02** | Single renderer Top 5 deterministik | **PASS** | `public/index.html:renderDashboardTop5MonitorData` |
| **REQ-03** | Auth UI sync (tombol login sembunyi bila sudah login) | **PASS** | `public/index.html:updateLandingCtas`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-04** | Fast Watcher deduplikasi & validasi RR | **PASS** | `test/batch1-fastwatcher-rr-status-closure.test.js` |
| **REQ-05** | Fallback volume 0 tidak disamarkan di chart candle | **PASS** | `lib/chart-engine/candle-fetcher.js`, `test/v6-pipeline-quota-audit.test.js` |
| **REQ-06** | Screener short swing lifecycle | **PASS** | `lib/saham-potensial-lifecycle.js`, `test/v6-saham-potensial-lifecycle.test.js` |
| **REQ-07** | Thead Konglo alignment | **PASS** | `public/index.html`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-08** | Thead Non-Konglo alignment | **PASS** | `public/index.html`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-09** | Day Trade checkbox raw universe dedup | **PASS** | `public/index.html:v3f04ShowRawDaytrade` |
| **REQ-10** | Sektor Hot pencegahan blank transient | **PASS** | `public/index.html:loadSektorHot`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-11** | Proteksi deviasi entry quote aktif vs plan usang (>25%) | **PASS** | `public/analisis-v2.js:levelsOf`, `test/v6-chart-engine-overhaul.test.js` |
| **REQ-12** | Fallback otomatis ke kalkulasi teknikal segar ATR-14 | **PASS** | `public/analisis-v2.js`, `test/v6-chart-engine-overhaul.test.js` |
| **REQ-13** | Koreksi logika dua sisi percentile p10-p90 vs Target | **PASS** | `public/analisis-v2.js:rangeCheck`, `test/v6-chart-engine-overhaul.test.js` |
| **REQ-14** | Anti-clutter price axis & mode simpel S/R filtering | **PASS** | `public/market-feature-runtime.js`, `test/v6-chart-engine-overhaul.test.js` |
| **REQ-15** | Bandarmologi Intel adaptive timeout & graceful error | **PASS** | `public/bandarmologi-runtime.js`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-16** | Insider network adaptive radius & zero overlap | **PASS** | `public/bandarmologi-runtime.js`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-17** | Ranking sorting 'Nilai Transaksi' (p * v) | **PASS** | `public/analisis-saham-runtime.js`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-18** | Financial overview ticker name synchronization | **PASS** | `public/analisis-saham-runtime.js`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-19** | Financial overview badge hapus 'Data contoh' | **PASS** | `public/analisis-saham-runtime.js`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-20** | Rekonsiliasi Free Float KSEI vs IDX | **PASS** | `public/index.html:msDetailReconciliationBox`, `test/v6-ownership-hsc.test.js` |
| **REQ-21** | HSC status independen dari ambang <15% | **PASS** | `api/struktur-pasar.js`, `test/v6-ownership-hsc.test.js` |
| **REQ-22** | Shareholder roster langsung aktif di pane detail | **PASS** | `public/index.html:marketStructureRosterTbody`, `test/v6-ownership-hsc.test.js` |
| **REQ-23** | Portfolio smooth scroll navigation | **PASS** | `public/index.html:navigateTo`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-24** | Portfolio viewport focus container | **PASS** | `public/index.html`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-25** | Quote GPRA freshness feedback text | **PASS** | `public/portfolio-command-center.js`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-26** | Track record reader ketahanan format | **PASS** | `lib/track-record-reader.js`, `test/v6-saham-potensial-lifecycle.test.js` |
| **REQ-27** | Subscription Lifetime active state recognition | **PASS** | `public/index.html`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-28** | Admin Ownership Import CSV/JSON parser | **PASS** | `lib/admin-ownership-import.js`, `test/v6-ownership-hsc.test.js` |
| **REQ-29** | Fail-closed HSC parsing & null state support | **PASS** | `lib/admin-ownership-import.js`, `test/v6-ownership-hsc.test.js` |
| **REQ-30** | Backup & rollback otomatis file overrides | **PASS** | `lib/admin-ownership-import.js`, `test/v6-ownership-hsc.test.js` |
| **REQ-31** | Append-only audit logging kepemilikan | **PASS** | `data/security/ownership-audit.log.jsonl`, `test/v6-ownership-hsc.test.js` |
| **REQ-32** | Tab Keamanan & Audit fallback log telemetri riil | **PASS** | `api/admin-logs.js`, `test/v6-cross-page-ui-fixes.test.js` |
| **REQ-33** | Zero-leak credential guard pada log & UI | **PASS** | Verifikasi diff git bersih dari secret/token |
| **REQ-34** | Quota manager reserve floor 5.000 lock | **PASS** | `lib/quota-manager.js`, `test/v6-pipeline-quota-audit.test.js` |
| **REQ-35** | Quota night window catchup 20:30 WIB | **PASS** | `lib/quota-manager.js`, `test/v6-pipeline-quota-audit.test.js` |
| **REQ-36** | Chart universe audit 963 emiten (962 pass) | **PASS** | `docs/v6/V6_CHART_RESULTS.csv`, `docs/v6/V6_VISUAL_REVIEW.md` |
| **REQ-37** | Penghapusan duplikasi render & listener leak | **PASS** | `public/analisis-v2.js:disposeChart` |
| **REQ-38** | Roster KSEI C-BEST 30 Sep 2026 integration | **PASS** | `public/index.html`, `api/struktur-pasar.js` |
| **REQ-39** | Cron inventory konsolidasi & wrapper | **PASS** | `docs/v6/V6_SCHEDULE_INVENTORY.csv`, `docs/v6/V6_SCHEDULE_PLAN.md` |
| **REQ-40** | Oracle VM keepalive compliance | **PASS** | `docs/v6/V6_RUNTIME_AUDIT.md` |
| **REQ-41** | Zero synthetic default / 0 fallback | **PASS** | `test/v6-pipeline-quota-audit.test.js` |
| **REQ-42** | PR V6 release & rollback checklist | **PASS** | `docs/v6/V6_RELEASE_AND_ROLLBACK.md` |

---

## 3. HASIL AUDIT KEAMANAN & INTEGRITAS (INDEPENDENT REVIEW)

- **Hardcoded Secret / Token Audit:**
  - Tidak ditemukan token Telegram, service role key Supabase, atau credential Stock Arjum pada working tree.
- **Data Integrity & Fallback Guard:**
  - Tidak ada fallback fiktif atau data buatan yang disamarkan sebagai nilai riil bursa.
  - Sesuai prinsip produk: *Nilai kosong bukan nol, dan data bursa riil disajikan dengan atribusi transparan.*
