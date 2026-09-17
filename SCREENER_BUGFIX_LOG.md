# Log Perbaikan Bug Screener Auto-Cuan (Batch 0–20)

Dokumen ini adalah pencatatan status riil, audit trail, dan log eksekusi setiap batch perbaikan bug screener di branch `feat/daytrade-screener-v1`.

---

## Ringkasan 4 Akar Masalah (Insiden 17 September 2026)

1. **Kode Basi di RAM VPS:** Proses Node berjalan manual (nohup/background) tanpa process manager (PM2). `git pull` di VPS hanya mengubah file di disk, sedangkan proses di RAM tetap mengeksekusi kode lama sampai direstart manual (`tools/ai-eval-once-supervisor.js` aktif sejak 11 Sep, `tools/vps-api-server.js` aktif sejak 14 Sep).
2. **Tidak Ada Market Hours Guard Terhubung:** Sinyal Telegram tertembak jam 12:45 WIB (jam istirahat bursa). Sinyal berasal dari cron evaluasi harga closing sesi 1 Swing Konglo / Telegram monitor runner (`tools/run-telegram-monitor-local.js`) yang memiliki jendela longgar 09:05–16:05 WIB tanpa jeda istirahat 12:00–13:30 WIB. Fungsi guard sesi `getMarketSessionStatus` ada di repo tetapi terisolasi pada dead code (`sendAlert`) dan tidak dipanggil oleh `telegramNotifier.sendTelegramMessage`.
3. **Kriteria Trigger Kelonggaran:** Status radar prioritas/entry zone hanya bersandar pada lonjakan volume tanpa filter Risk/Reward ratio minimum dan tanpa pengecekan jarak harga ke batas atas entry zone. Jalur digest fallback pada Swing mengizinkan bypass hard gate R/R 1.8x.
4. **Tidak Ada State Machine / Anti-Duplikat Alert:** Bot menembak alert berbasis kondisi sesaat (*stateless*), tanpa memeriksa apakah sinyal identik sudah pernah dikirim dalam window waktu atau butuh konfirmasi candle closing resmi.

---

## Progres Batch

- [x] **Batch 0** — Audit Arsitektur & Logika Penilaian Seluruh Screener (PR #665, commit `fd2a809`)
- [x] **Batch 1** — Sinkronisasi Baseline & Setup Log (PR #666, commit `a562ca4`)
- [ ] **Batch 2** — Modul Market Hours Guard Terpusat
- [ ] **Batch 3** — Integrasi Market Hours Guard ke Broadcast Notifier
- [ ] **Batch 4** — Audit & Perbaikan Crontab / Schedule VPS
- [ ] **Batch 5** — Filter Minimum Risk/Reward Ratio Sentral
- [ ] **Batch 6** — Terapkan Filter R/R ke Klasifikasi Radar & Entry Zone
- [ ] **Batch 7** — Kunci Transisi Status Revalidasi (NEEDS_REVALIDATION)
- [ ] **Batch 8** — Syarat Konfirmasi Volume Breakout untuk Revalidasi
- [ ] **Batch 9** — Desain & Modul State Machine Alert (Anti-Duplikat)
- [ ] **Batch 10** — Implementasi Alert Throttling di Telegram Notifier
- [ ] **Batch 11** — Syarat Konfirmasi Candle Close Sebelum Alert Entry Zone
- [ ] **Batch 12** — Setup Ecosystem Process Manager (PM2)
- [ ] **Batch 13** — Skrip Deploy Otomatis & Atomik (Git Pull + PM2 Restart)
- [ ] **Batch 14** — Test Integrasi Seluruh Guard
- [ ] **Batch 15** — Regression Test Data Historis Nyata (SSMS, KAEF, SMGR, IMJS, INKP)
- [ ] **Batch 16** — Audit Ketikan Nyasar & Integritas Kode
- [ ] **Batch 17** — Validasi Penuh Sintaks & Full Regression Test Suite
- [ ] **Batch 18** — Deploy Penuh ke VPS dengan PM2
- [ ] **Batch 19** — Pemantauan Sesi Bursa Langsung (Live Monitoring)
- [ ] **Batch 20** — Laporan Akhir Konsolidasi & Cleanup

---

## Log Eksekusi per Batch

### Batch 0: Audit Arsitektur & Logika Penilaian Seluruh Screener
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **PR:** #665 (`fd2a809`)
- **Dokumen Audit Utama:** [`SCREENER_ARCHITECTURE_AUDIT.md`](SCREENER_ARCHITECTURE_AUDIT.md)
- **Ringkasan Temuan Utama:**
  1. *Prior Art (d82fbd1):* `getMarketSessionStatus` dan `candidatePassesPublicTelegramSafetyGate` masih ada. `candidatePassesPublicTelegramSafetyGate` aktif dipanggil untuk zombie purge & filter ARA/ARB. Namun `getMarketSessionStatus` terisolasi di fungsi `sendAlert` yang dead code.
  2. *Broadcast Path Nyata:* Menggunakan `telegramNotifier.sendTelegramMessage` yang sama sekali tidak memiliki pengecekan jam bursa.
  3. *Akar Insiden 12:45 WIB:* Cron VPS `*/15 9-16 * * 1-5 telegram-monitor-local.sh` mengeksekusi `tools/run-telegram-monitor-local.js` yang memiliki fungsi `isMarketSessionWib` 09:05–16:05 WIB (menganggap jam istirahat 12:00–13:30 aktif). Cron 12:05 WIB (`swing-konglo.sh`) menyimpan data closing sesi 1 ke Supabase, lalu tersiar pada pukul 12:45 WIB.
  4. *Celah Filter R/R Swing:* Jalur `strictCandidates` memiliki hard gate R/R 1.8x, namun jika kosong, sistem fallback ke `digestCandidates` yang melewati hard gate R/R dan mengizinkan R/R 1.3x (Tier 2) atau tanpa filter R/R.
  5. *Status RAM VPS:* Terbukti proses `tools/ai-eval-once-supervisor.js` (PID 1801024 sejak 11 Sep) dan `tools/vps-api-server.js` (PID 1883477 sejak 14 Sep) menjalankan kode lama di memori.
- **Hasil Sintaks Check:** `node --check` valid pada seluruh file audit.

### Batch 1: Sinkronisasi Baseline & Setup Log
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **PR:** #666 (`a562ca4`)
- **Baseline Sintaks JS:**
  - Total File `.js` Diperiksa: **788 file** (seluruh repo di luar `node_modules` dan `.git`)
  - Status `node --check`: **100% VALID** (0 syntax error)
- **Baseline Test Suite (`npm test` / `tools/run-build-test-suite.js --full`):**
  - Total Test Files: **377 test files** (dari `tools/curated-build-tests.json`)
  - Status Eksekusi: **377/377 test files PASSED (100% Lolos)**
  - Total Subtests: **317 subtests passed, 0 fail, 0 skipped, 0 cancelled**
  - Pre-Build Tooling Validations: 6/6 passed (`apply-production-hotfixes`, `apply-desktop-header-center`, `apply-ui-bugfix-pack-v1`, `apply-screener-lifecycle-ui`, `validate-auth-recovery-v2`, `validate-ai-eval-once`)
