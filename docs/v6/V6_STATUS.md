# AUTO-CUAN V6: SYSTEM STATUS & MASTER VERIFICATION LEDGER

**Dokumen Identifikasi:** `docs/v6/V6_STATUS.md`
**Tahap:** Subtask F Selesai (Release Readiness & Final Master Ledger)
**Branch:** `feat/v6-recovery` @ `ae5d18924955217c7e74d1d7909b3ef12f471d00`
**Terakhir Diperbarui:** 2026-11-14 (F8b reporting-layer correction)
**Status Global:** **PARTIAL** — the current verdict ledger `docs/v6/V6_REQUIREMENTS_CURRENT_VERDICTS.csv` (54 rows) records **13 PROVEN / 35 PARTIAL / 5 BLOCKED / 1 FAIL / 0 NOT_TESTED**, and `docs/v6/V6_RELEASE_GATES_CURRENT.md` records **Gate E = PARTIAL**.
**Status vocabulary:** `PROVEN` / `PARTIAL` / `FAIL` / `NOT_TESTED` / `BLOCKED` / `CLAIM_ONLY`
**Supersedes:** the ZIP 19:33 snapshot (2026-11-10). The `100% Verified (42 / 42 Requirements Selesai)` line that this document carried previously was an **unqualified success claim** and is removed; the underlying 42-row list in §2 is retained as a **historical** Subtask-F ledger, not as a current verdict.
**Current regression state (2026-11-14, F8/F4d):** legacy7 **7/7**, `test/v6` **30/30**, curated **723/808** (79 pre-existing failures proven against a pristine `git archive HEAD` baseline + 6 recovery-induced regressions, all owned in `docs/v6/V6_RECOVERY_INDUCED_REGRESSIONS.md`), plus **25/25** new provenance-guard tests.
**Authoritative sources for every status claim in this file:** [`V6_REQUIREMENTS_CURRENT_VERDICTS.csv`](V6_REQUIREMENTS_CURRENT_VERDICTS.csv) (per-requirement verdicts) and [`V6_RELEASE_GATES_CURRENT.md`](V6_RELEASE_GATES_CURRENT.md) (gate verdicts). Where §2 below disagrees with those two files, **those two files win**.

---

## 1. COMPONENT STATUS DASHBOARD

| Subsystem | Baseline Awal | Status Terkini V6 | Keterangan Verifikasi |
|---|---|---|---|
| **Git Baseline** | Commit `ae5d1892` | `feat/v6-recovery` (PR Ready) | Current F8/F4d regression: legacy7 **7/7**, `test/v6` **30/30**, curated **723/808** (79 pre-existing + 6 recovery-induced). **Historical** (ZIP 19:33 snapshot, 2026-11-10): 33/33 in `node --test test/v6-*.test.js` — that figure describes the Subtask-F snapshot only and is **not** the current regression state. |
| **Branching Isolation** | `feat/v6-recovery` | Terisolasi dari `main` | Target PR: `feat/daytrade-screener-v1` |
| **Chart Engine** | Crash / Deviasi >25% | Overhauled & Anti-Clutter | 962 Pass, 1 Dorman, 0 NaN (Subtask D) |
| **Ownership & HSC** | Manual / Stale / Desync | Clean KSEI C-BEST Parser & UI | Rollback & Audit Chained (Subtask B) |
| **Short Swing Screener** | Gap Max Entry & Lifecycle | Lifecycle State Machine | Deterministic 5/5 & 20/20 (Subtask C) |
| **Quota & Scheduler** | Overlap Crontab | Konsolidasi N13 cron | Hard-Lock 5.000 Quota Floor (Subtask A & E) |
| **Cross-Page UI/UX** | 12 Visual & Logic Defect | Selesai & Terverifikasi | REQ-01 s.d. REQ-32 Selesai (Subtask F) |

---

## 2. INVENTARIS 42 AUDIT REQUIREMENTS — HISTORICAL SUBTASK-F LEDGER (SUPERSEDED BY `V6_REQUIREMENTS_CURRENT_VERDICTS.csv`)

> **READ THIS FIRST (2026-11-14, F8b).** This section is the **historical Subtask-F ledger as it stood on 2026-11-10**. Its `[PASS]` markers are the Subtask-F assertions of that date, **not** the current verdicts. The current, authoritative, per-requirement verdicts (54 rows, including the 12 `NREQ-*` requirements) live in [`V6_REQUIREMENTS_CURRENT_VERDICTS.csv`](V6_REQUIREMENTS_CURRENT_VERDICTS.csv) and are distributed **13 PROVEN / 35 PARTIAL / 5 BLOCKED / 1 FAIL**. A requirement listed as `[PASS]` below may today be `PARTIAL`, `BLOCKED` or `FAIL`; the CSV is the authority, this list is history.

1. **REQ-01 (Kalkulator Landing):** Entry sinkron 1.210 dengan lot 133 / modal 100jt (`[PASS]`).
2. **REQ-02 (Top 5 Rendering):** Single renderer deterministik anti double mount (`[PASS]`).
3. **REQ-03 (Auth UI Sync):** Tombol masuk/login/daftar disembunyikan saat teridentifikasi login (`[PASS]`).
4. **REQ-04 (Fast Watcher Deduplikasi):** Poller dedup & R/R validation tersinkronisasi (`[PASS]`).
5. **REQ-05 (Candle Normalization):** Volume hilang/null tidak disamarkan menjadi 0 (`[PASS]`).
6. **REQ-06 (Saham Potensial Lifecycle):** Transisi status short swing otomatis tanpa rekayasa (`[PASS]`).
7. **REQ-07 (Screener Konglo Header):** Kolom tabel rata sempurna (Ticker, Grup, Tier, Conf, Skor, Harga...) (`[PASS]`).
8. **REQ-08 (Screener Non-Konglo Header):** Kolom thead selaras tanpa pergeseran (#, Ticker, Board, Tier, Conf, Skor, Harga...) (`[PASS]`).
9. **REQ-09 (Day Trade Screener):** Checkbox raw universe tunggal tanpa duplikasi (`[PASS]`).
10. **REQ-10 (Sektor Hot Blank Guard):** Cache-first retain rows mencegah transient blank 5 hari (`[PASS]`).
11. **REQ-11 (Quote vs Plan Deviasi):** Tolak plan screener jika deviasi harga >25% (`[PASS]`).
12. **REQ-12 (Fallback ATR-14 Segar):** Beralih deterministik ke kalkulasi teknikal segar jika plan ditolak (`[PASS]`).
13. **REQ-13 (Percentile p10-p90 Target):** Logika dua sisi (< p10 atau > p90) akurat (`[PASS]`).
14. **REQ-14 (Anti-Clutter Price Axis):** Mode simpel sembunyikan label harga S/R yang bertumpuk (`[PASS]`).
15. **REQ-15 (Bandarmologi Intel Timeout):** Timeout adaptif 60s/25s dengan graceful error feedback (`[PASS]`).
16. **REQ-16 (Insider Network Overlap):** Radius adaptif mencegah tabrakan node/label/edge (`[PASS]`).
17. **REQ-17 (Ranking Sorting Nilai Transaksi):** Mengurutkan berdasarkan (harga x volume) riil (`[PASS]`).
18. **REQ-18 (Financial Race Condition):** Sinkronisasi nama emiten dan state ticker bersih (`[PASS]`).
19. **REQ-19 (Financial Badge Transparency):** Hapus label "Data contoh" pada emiten dengan laporan lengkap (`[PASS]`).
20. **REQ-20 (Free Float KSEI vs IDX):** Box rekonsiliasi eksplisit di panel detail (`[PASS]`).
21. **REQ-21 (HSC Status Independen):** Low free float <15% tidak otomatis mengubah status HSC bursa (`[PASS]`).
22. **REQ-22 (Shareholder Roster):** Roster pemegang saham langsung aktif di pane detail (`[PASS]`).
23. **REQ-23 (Portfolio Smooth Scroll):** Viewport bergeser mulus saat tab portfolio diklik (`[PASS]`).
24. **REQ-24 (Portfolio Focus Container):** Target container portofolio langsung terfokus (`[PASS]`).
25. **REQ-26 (Track Record Resilience):** Reader fleksibel menangani ragam struktur arsip (`[PASS]`).
26. **REQ-27 (Subscription Lifetime State):** Status paket lifetime terdeteksi dan diakui di kartu katalog (`[PASS]`).
27. **REQ-28 (Admin Ownership Import):** Parser CSV dan JSON tervalidasi ketat (`[PASS]`).
28. **REQ-29 (Fail-Closed HSC):** Status null/unknown tidak otomatis disimpulkan false (`[PASS]`).
29. **REQ-30 (Overrides Backup & Rollback):** Backup otomatis sebelum overwrite file overrides (`[PASS]`).
30. **REQ-31 (Ownership Audit Logging):** Log append-only kriptografis terekam di JSONL (`[PASS]`).
31. **REQ-32 (Keamanan & Audit Panel):** Fallback log telemetri riil dari `data/security/vps-audit.json` (`[PASS]`).
32. **REQ-33 (Zero-Leak Guard):** Diff bersih dari secret/token (`[PASS]`).
33. **REQ-34 (Quota Floor 5.000):** Penguncian kuota otomatis pada hari kerja sebelum 20:30 WIB (`[PASS]`).
34. **REQ-35 (Quota Night Catchup):** Jendela malam 20:30-23:50 WIB untuk backfill aman (`[PASS]`).
35. **REQ-36 (Chart Universe Matrix):** 962 dari 963 emiten valid (1 emiten dorman terdeteksi) (`[PASS]`).
36. **REQ-37 (Memory Leak Prevention):** Chart disposal bersih tanpa orphan canvas (`[PASS]`).
37. **REQ-38 (KSEI C-BEST Integrasi):** Data kepemilikan terintegrasi kustodian sentral (`[PASS]`).
38. **REQ-39 (Cron Inventory Konsolidasi):** Seluruh job terjadwal dibungkus `job-wrapper.sh` (`[PASS]`).
39. **REQ-40 (Oracle Keepalive Compliance):** Memory stabil (< 35%) dan CPU duty cycle aman (`[PASS]`).
40. **REQ-41 (Zero Synthetic Data):** Penghapusan seluruh angka buatan yang disamarkan (`[PASS]`).
41. **REQ-42 (PR V6 Package):** Dokumen verifikasi, rollback, dan draf PR lengkap (`[PASS]`).

---

## 3. ARTIFAK DAN DOKUMENTASI TERSEDIA

- [`docs/v6/V6_RUNTIME_AUDIT.md`](V6_RUNTIME_AUDIT.md) — Hasil audit runtime VPS & keepalive.
- [`docs/v6/V6_SCHEDULE_INVENTORY.csv`](V6_SCHEDULE_INVENTORY.csv) — Inventaris crontab & kuota.
- [`docs/v6/V6_OWNERSHIP_HSC.md`](V6_OWNERSHIP_HSC.md) — Spesifikasi struktur pasar & HSC.
- [`docs/v6/V6_VISUAL_REVIEW.md`](V6_VISUAL_REVIEW.md) — Review visual chart & matriks 963 ticker.
- [`docs/v6/V6_CHART_RESULTS.csv`](V6_CHART_RESULTS.csv) — Hasil audit 963 chart emiten BEI.
- [`docs/v6/V6_VERIFICATION.md`](V6_VERIFICATION.md) — Bukti eksekusi regression test suite.
- [`docs/v6/V6_RELEASE_AND_ROLLBACK.md`](V6_RELEASE_AND_ROLLBACK.md) — Runbook rilis VPS & rollback darurat.
