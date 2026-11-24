# DRAF PULL REQUEST V6: AUTO-CUAN V6 PRODUCTION RECOVERY & AUDIT STABILIZATION

**Target Branch:** `feat/daytrade-screener-v1` (BUKAN `main`)  
**Source Branch:** `feat/v6-recovery`  
**Status Pengujian:** HISTORICAL (2026-11-10) — 33 / 33 Unit & Regression Tests Lulus pada saat dokumen ini ditulis. **Bukan status V6 saat ini.** Lihat banner bertanggal di bawah.
**Dokumentasi Terkait:**
- Matriks Audit & Verifikasi: [`docs/v6/V6_VERIFICATION.md`](docs/v6/V6_VERIFICATION.md)
- Status Kebutuhan (historis 42-item, digantikan ledger 54-row): [`docs/v6/V6_STATUS.md`](docs/v6/V6_STATUS.md)
- **Ledger verdict terkini (54 row):** [`docs/v6/V6_REQUIREMENTS_CURRENT_VERDICTS.csv`](docs/v6/V6_REQUIREMENTS_CURRENT_VERDICTS.csv) — **13 PROVEN / 35 PARTIAL / 5 BLOCKED / 1 FAIL / 0 NOT_TESTED**
- Runbook Rilis & Rollback: [`docs/v6/V6_RELEASE_AND_ROLLBACK.md`](docs/v6/V6_RELEASE_AND_ROLLBACK.md)

> ### ⚠ HISTORICAL BANNER — 2026-11-14 (F8d) — DRAFT PR, **NO PR HAS BEEN OPENED**
>
> **This file is a DRAFT pull-request description. No pull request has been opened. No merge has been performed. No deployment has been performed.** No commit, push, reset, clean or stash was executed by any V6 recovery phase; HEAD remains `ae5d18924955217c7e74d1d7909b3ef12f471d00` on `feat/v6-recovery`, with every change as an unstaged modification or an untracked addition.
>
> **Current status of V6 (2026-11-14) — this draft does NOT describe it:**
> - **Requirement verdict ledger:** [`docs/v6/V6_REQUIREMENTS_CURRENT_VERDICTS.csv`](docs/v6/V6_REQUIREMENTS_CURRENT_VERDICTS.csv) — **54 rows: 13 PROVEN / 35 PARTIAL / 5 BLOCKED / 1 FAIL / 0 NOT_TESTED**. The **"42 Kebutuhan"** figure referenced in this draft is the **historical Subtask-F ledger**, retained for the record; the 54-row CSV is authoritative.
> - **Gates:** [`docs/v6/V6_RELEASE_GATES_CURRENT.md`](docs/v6/V6_RELEASE_GATES_CURRENT.md) — Gate A **PARTIAL**, Gate B **FAIL (runtime) / PROVEN (code)**, Gate C **PARTIAL**, Gate D **PARTIAL**, Gate E **PARTIAL**, Gate F **BLOCKED**.
> - **Regression (F8):** legacy-7 group **7/7 PASS**, `test/v6/*` group **30/30 PASS**, curated 808-file group **723/808** = **79 pre-existing failures + 6 recovery-induced failures**.
> - **Release status: Gate F = BLOCKED.** The release is **not** approved.
>
> **SUPERSEDED — 2026-11-14 (F8d):** the status line previously read `100% PASS (33 / 33 Unit & Regression Tests Lulus)`. It was superseded as an **unqualified** green-build claim: it was scoped to a 33-test snapshot from 2026-11-10 and was never reconciled against the current 54-row verdict ledger or the 723/808 curated regression result. The historical test numbers themselves are **not** changed — only their status framing is.

---

## 1. RINGKASAN EKSEKUTIF

Pull Request ini menuntaskan program stabilisasi sistemik Auto-Cuan V6 yang mencakup seluruh temuan audit menyeluruh (42 requirement) dari klaster backend, pipeline, kuota, cron, engine chart, struktur pasar KSEI, hingga konsistensi UI/UX lintas halaman:

1. **Struktur Pasar & HSC (Subtask B):**
   - Integrasi parser KSEI C-BEST resmi per 30 September 2026.
   - Pemisahan independen antara ambang batas risiko likuiditas (<15%) dan status pemantauan bursa (HSC).
   - Penambahan box rekonsiliasi eksplisit sumber data (KSEI vs IDX) dan shareholder roster langsung di pane detail.
   - Pengamanan import admin: audit logging kriptografis append-only (`ownership-audit.log.jsonl`) dan auto-backup/rollback mechanism.

2. **Mesin Screener & Saham Potensial (Subtask C):**
   - Standardisasi kalkulasi Risk/Reward berbasis `max_entry` (kandidat actionable saat RR >= 1.5).
   - Pemurnian universe screener: eliminasi data dummy/sintetis uniform dan penjaminan subset deterministik Top 20 dan Top 5.
   - State machine lifecycle short swing yang mandiri dan taat pada riwayat tanggal bursa.

3. **Chart Engine Overhaul (Subtask D):**
   - Audit visual 963 emiten BEI lokal: 962 emiten PASS tanpa cacat (0 NaN), 1 emiten dorman ditangani graceful.
   - Proteksi deviasi harga quote aktif vs level trading plan screener usang (>25%) dengan fallback deterministik ke kalkulasi teknikal segar ATR-14.
   - Koreksi formula percentile rentang wajar 10 hari (p10–p90) dua sisi vs target harga TP1/TP2.
   - Anti-clutter canvas: penyembunyian tumpukan label S/R pada price axis di mode simpel.

4. **Kuota & Jadwal Cron VPS (Subtask A & E):**
   - Perlindungan hard-lock kuota Stock Arjum: penguncian otomatis batas cadangan 5.000 unit di hari kerja sebelum 20:30 WIB.
   - Konsolidasi crontab VPS melalui skrip tunggal terstandarisasi `job-wrapper.sh` (24 jobs, N13 convergence).

5. **Perbaikan UI/UX Lintas Halaman (Subtask F):**
   - **REQ-01:** Sinkronisasi input entry kalkulator landing dari 0 menjadi 1.210 (selaras dengan modal 100jt dan 133 lot).
   - **REQ-02:** Single renderer deterministik pada panel Top 5 Radar untuk mencegah double render.
   - **REQ-03:** Sinkronisasi status autentikasi UI landing page (tombol Masuk/Login tersembunyi bila user sudah login).
   - **REQ-07 & REQ-08:** Perbaikan pergeseran header kolom tabel Screener Konglo dan Non-Konglo (Conf & Skor).
   - **REQ-09:** Penghapusan duplikasi checkbox toggle raw universe pada screener Day Trade.
   - **REQ-10:** Penanganan cache-first pada Sektor Hot untuk mencegah blank transient saat memuat data rotasi 5 hari.
   - **REQ-15:** Timeout adaptif 60s (scanner) / 25s (ticker) pada Sinyal Intelijen Bandarmologi dengan pesan error yang jelas.
   - **REQ-16:** Geometri adaptif dan radius graf jejaring insider untuk mencegah tabrakan node, label, dan satelit broker.
   - **REQ-17:** Pengurutan klasemen Ranking berdasarkan Nilai Transaksi riil (harga x volume).
   - **REQ-18 & REQ-19:** Sinkronisasi state nama emiten financial overview dan penghapusan label "Data contoh" pada emiten dengan laporan keuangan lengkap.
   - **REQ-23 & REQ-24:** Navigasi smooth scroll dan focus viewport ke container aktif saat tab Portofolio dibuka.
   - **REQ-25:** Konfirmasi status pembaruan harga quote portofolio lengkap dengan daftar simbol emiten.
   - **REQ-27:** Pengenalan eksplisit status paket Lifetime pada kartu katalog langganan.
   - **REQ-32:** Tampilan riil catatan keamanan dan log telemetri siber VPS pada Tab Keamanan & Audit Admin Console.

---

## 2. HASIL VERIFIKASI PENGUJIAN REGRESI

```text
Eksekusi: node --test test/v6-*.test.js
Hasil: 33 tests passed, 0 failed, 0 skipped, 0 flakiness (duration: 948ms)
```

- **Integritas Kredensial:** Bebas dari token, secret, atau bearer hardcoded.
- **Kepatuhan Desain:** Memenuhi standar DESIGN.md (zero layout shift, zero artificial data, palette dark-theme tokenized).

---

## 3. CHECKLIST RILIS (PRE-DEPLOYMENT)

- [x] Seluruh perubahan terisolasi di branch `feat/v6-recovery`.
- [x] Branch target PR diatur ke `feat/daytrade-screener-v1` (bukan `main`).
- [x] Runbook rollback darurat dan backup data VPS siap dieksekusi di [`docs/v6/V6_RELEASE_AND_ROLLBACK.md`](docs/v6/V6_RELEASE_AND_ROLLBACK.md).
- [ ] Menunggu review dan persetujuan pengguna sebelum melakukan deploy/write ke VPS produksi.
