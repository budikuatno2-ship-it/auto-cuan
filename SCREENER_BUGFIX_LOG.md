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
- [x] **Batch 2** — Modul Market Hours Guard Terpusat (PR #668)
- [x] **Batch 3** — Integrasi Market Hours Guard ke Broadcast Notifier (PR #669)
- [x] **Batch 4** — Audit & Perbaikan Crontab / Schedule VPS (PR #670)
- [x] **Batch 5** — Filter Minimum Risk/Reward Ratio Sentral (PR #671)
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
- **PR:** #666 (`a562ca4`) & #667 (`d011c47`)
- **Baseline Sintaks JS:**
  - Total File `.js` Diperiksa: **788 file** (seluruh repo di luar `node_modules` dan `.git`)
  - Status `node --check`: **100% VALID** (0 syntax error)
- **Baseline Test Suite (`npm test` / `tools/run-build-test-suite.js --full`):**
  - Total Test Files: **377 test files** (dari `tools/curated-build-tests.json`)
  - Status Eksekusi: **377/377 test files PASSED (100% Lolos)**
  - Total Subtests: **317 subtests passed, 0 fail, 0 skipped, 0 cancelled**
  - Pre-Build Tooling Validations: 6/6 passed (`apply-production-hotfixes`, `apply-desktop-header-center`, `apply-ui-bugfix-pack-v1`, `apply-screener-lifecycle-ui`, `validate-auth-recovery-v2`, `validate-ai-eval-once`)

### Batch 2: Modul Market Hours Guard Terpusat
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **PR:** #668
- **Modul Baru:** [`lib/market-hours-guard.js`](lib/market-hours-guard.js)
- **Unit Test Baru:** [`test/market-hours-guard.test.js`](test/market-hours-guard.test.js) (5 test suites, 100% pass)
- **Jadwal Resmi IDX (WIB) yang Diimplementasikan:**
  - *Senin s/d Kamis:*
    - Sesi 1: 09:00 s/d 11:58 WIB (`SESSION_1`, `isMarketOpen === true`)
    - Istirahat: 11:58 s/d 13:30 WIB (`CLOSED`, `isMarketOpen === false` — kasus 12:45 WIB terblokir mutlak)
    - Sesi 2: 13:30 s/d 15:45 WIB (`SESSION_2`, `isMarketOpen === true`)
    - Di luar jam tersebut: `CLOSED` (`isMarketOpen === false`)
  - *Khusus Hari Jumat:*
    - Sesi 1: 09:00 s/d 11:28 WIB (`SESSION_1`, `isMarketOpen === true`)
    - Istirahat Sholat Jumat: 11:28 s/d 14:00 WIB (`CLOSED`, `isMarketOpen === false`)
    - Sesi 2: 14:00 s/d 15:45 WIB (`SESSION_2`, `isMarketOpen === true`)
    - Di luar jam tersebut: `CLOSED` (`isMarketOpen === false`)
  - *Akhir Pekan (Sabtu/Minggu) & Libur:* Mutlak `CLOSED` (`isMarketOpen === false`).
- **Verifikasi Test Suite:**
  - `node --test test/market-hours-guard.test.js`: 5/5 pass
  - `npm test`: 378/378 test files PASSED (100% lolos)

### Batch 3: Integrasi Market Hours Guard ke Broadcast Notifier
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **PR:** #669
- **File Dimodifikasi:**
  - [`lib/telegram-notifier.js`](lib/telegram-notifier.js): Memasang verifikasi `isMarketOpen()` pada `sendTelegramMessage`, `sendTelegramDocument`, `sendTelegramPhoto`, dan `sendTelegramPhotoUrl`.
  - [`test/broadcast-market-guard.test.js`](test/broadcast-market-guard.test.js): Unit test integrasi pengujian blokir broadcast di luar jam bursa.
  - [`test/telegram-notifier-rate-limit.test.js`](test/telegram-notifier-rate-limit.test.js): Penyesuaian test mock rate-limit dengan flag bypass.
  - [`tools/curated-build-tests.json`](tools/curated-build-tests.json): Pendaftaran test baru.
- **Ringkasan Guard yang Terpasang:**
  - Pintu gerbang utama pengiriman Telegram publik kini memverifikasi sesi bursa sebelum payload dikirim.
  - Menolak dan membatalkan pengiriman saat `isMarketOpen() === false` dengan logging eksplisit: `[MARKET_GUARD_BLOCKED] Broadcast cancelled: Market is CLOSED (Session: <session>, Time: <time_wib>)` dan mengembalikan payload standar `{ sent: false, skipped: true, reason: 'market_closed', session, time_wib }`.
  - Kasus insiden 12:45 WIB terbukti diblokir 100% secara otomatis pada pintu terluar notifier.
  - Sesi Sholat Jumat (11:28–14:00 WIB) dan akhir pekan terbukti diblokir 100%.
  - Opsi explicit bypass `options.skip_market_guard === true` disediakan untuk keperluan test/debugging terisolasi.
- **Hasil Test:**
  - `node --test test/broadcast-market-guard.test.js`: 5/5 passed
  - `npm test`: **379/379 test files passed (100% lolos, 0 fail, 0 skipped)**

### Batch 4: Audit & Perbaikan Crontab / Schedule VPS
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **PR:** #670
- **File Dimodifikasi:**
  - [`tools/run-telegram-monitor-local.js`](tools/run-telegram-monitor-local.js): Menggantikan logika `isMarketSessionWib()` statis (09:05–16:05 WIB) dengan integrasi langsung ke [`lib/market-hours-guard.js`](lib/market-hours-guard.js). Runner kini membedakan status break (`market_break`), luar jam bursa (`outside_trading_hours`), dan akhir pekan (`weekend`), serta membaca sesi resmi (`SESSION_1`, `SESSION_2`, `CLOSED`).
  - [`deploy/vps/telegram-monitor-local.sh`](deploy/vps/telegram-monitor-local.sh): Pembaruan dokumentasi crontab schedule dan penjelasan market guard otomatis.
  - [`test/vps-monitor-local-runner.test.js`](test/vps-monitor-local-runner.test.js): Pembaruan unit test runner untuk memvalidasi penolakan runner di jam istirahat siang (12:45 WIB), sholat Jumat (12:30 WIB), pre-market, dan weekend, serta keberhasilan saat sesi aktif 1 & 2.
- **Audit Temuan Jadwal Cron:**
  - `deploy/vps/final-schedule.cron` diaudit bersih (hanya berisi tugas EOD/malam: 00:05 backfill, 16:30 lifecycle, 18:00 broker update, 18:45 afternoon recap, 19:30 candle fetch, 22:15 landing refresh). Tidak ada cron broadcast intraday yang berjalan liar di jam istirahat.
  - `telegram-monitor-local.sh` diproteksi guard berlapis: (1) Runner skipping pada `tools/run-telegram-monitor-local.js` via `isMarketOpen()`, (2) Broadcast notifier blocking pada `lib/telegram-notifier.js`.
- **Hasil Test:**
  - `node --test test/vps-monitor-local-runner.test.js test/telegram-monitor-local-runner.test.js`: 10/10 passed (100%)
  - `npm test`: **379/379 test files passed (100% lolos, 0 fail, 0 skipped)**

### Batch 5: Filter Minimum Risk/Reward Ratio Sentral
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **PR:** #671
- **Modul Baru:** [`lib/screener-config.js`](lib/screener-config.js)
- **Konstanta Terpusat:**
  - `MIN_RR_RATIO = 1.5` — ambang batas minimal R/R yang bisa ditoleransi.
  - `IDEAL_RR_RATIO = 2.0` — rasio target ideal.
- **Fungsi Filter:** `passesRiskRewardFilter(candidate, minRatio = MIN_RR_RATIO)`
  - Mengekstrak R/R dari berbagai varian properti: `rr`, `rr_ratio`, `rrRatio`, `risk_reward`, `riskReward`, serta nested `levels.*`.
  - Menangani nilai falsy/null/undefined/0/string/NaN/Infinity/negatif secara aman (return `false` tanpa throw).
  - Mengembalikan `true` HANYA jika R/R numerik valid >= `minRatio`.
- **Unit Test Baru:** [`test/risk-reward-filter.test.js`](test/risk-reward-filter.test.js) (7 test suites, 100% pass)
  - Kasus insiden SSMS (R/R 1.0x) terbukti ditolak.
  - Sub-threshold 1.2x & 1.49x ditolak; batas tepat 1.5x lolos; ideal 2.0x/2.5x/3.0x lolos.
  - Edge case null/undefined/0/negatif/string invalid/NaN/Infinity aman tanpa throw.
- **Hasil Test:**
  - `node --test test/risk-reward-filter.test.js`: 7/7 passed
  - `npm test`: **380/380 test files passed (100% lolos, 0 fail, 0 skipped)**
