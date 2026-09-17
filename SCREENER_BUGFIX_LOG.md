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
- [x] **Batch 6** — Terapkan Filter R/R ke Klasifikasi Radar & Entry Zone
- [x] **Batch 7** — Kunci Revalidasi Sinyal & R/R Gate Jalur Swing (PR #673)
- [x] **Batch 8** — Deduplikasi & Stateful Alert Tracking (Anti-Duplikat) (PR #674)
- [x] **Batch 9** — Syarat Konfirmasi Volume Breakout untuk Revalidasi (PR #675)
- [x] **Batch 10** — Implementasi Alert Throttling & Rate Limiter Terpusat di Telegram Notifier
- [x] **Batch 11** — Syarat Konfirmasi Candle Close Sebelum Alert Entry Zone
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

### Batch 6: Terapkan Filter R/R ke Klasifikasi Radar & Entry Zone
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **Branch:** `fix/enforce-rr-status-classification`
- **File Dimodifikasi:**
  - [`lib/daytrade-screener-engine.js`](lib/daytrade-screener-engine.js): Import `MIN_RR_RATIO` & `passesRiskRewardFilter` dari [`lib/screener-config.js`](lib/screener-config.js), lalu memasang **Hard R/R Gate** di dalam `classifyStatus()`.
  - [`test/daytrade-screener-status-rr.test.js`](test/daytrade-screener-status-rr.test.js): Unit test regresi baru (5 test suites).
  - [`tools/curated-build-tests.json`](tools/curated-build-tests.json): Pendaftaran test baru.
- **Akar Masalah yang Ditutup:**
  - Sebelumnya pengecekan R/R di `classifyStatus()` hanya menandai `hasPoorRR` dan menambah `hardFails`, tetapi `hardFails` **hanya diperiksa oleh cabang tier tinggi**. Cabang fall-through `MOMENTUM_CONTINUATION` (`:1011`) dan `SPECULATIVE` (`:1023`) **mengabaikan `hardFails`**, sehingga kandidat R/R rendah (mis. SSMS 1.0x) dengan skor >= 60 tetap bisa masuk status momentum yang actionable.
- **Guard yang Terpasang:**
  - Tepat setelah deteksi `hasPoorRR`, `classifyStatus()` memanggil `passesRiskRewardFilter(levels, MIN_RR_RATIO)`. Jika R/R < 1.5x (atau tidak valid), kandidat **langsung dikembalikan sebagai `WAIT_PULLBACK`** dengan setup `Wait - Poor RR` dan catatan peringatan eksplisit berisi nilai R/R aktual vs minimum.
  - Status prioritas/entry (`A_PLUS_SETUP`, `TRADE_CANDIDATE`, `READY_BREAKOUT`, `PRE_SPIKE_WATCH`, `EARLY_RADAR`, `MOMENTUM_CONTINUATION`, `RECLAIM_CANDIDATE`) kini **tidak dapat dicapai** saat R/R < 1.5x.
  - Kandidat dengan R/R >= 1.5x tetap lolos normal bila kriteria teknikal lain terpenuhi.
- **Hasil Test:**
  - `node --check lib/daytrade-screener-engine.js` & `node --check test/daytrade-screener-status-rr.test.js`: VALID
  - `node --test test/daytrade-screener-status-rr.test.js`: 5/5 passed
    - Kasus SSMS (R/R 1.0x) terbukti DITOLAK dari status prioritas/entry.
    - Sub-threshold 1.2x & 1.49x ditolak; batas 1.5x lolos; ideal 2.5x mencapai `A_PLUS_SETUP`.
    - R/R tidak valid (undefined/null/0/negatif/NaN) diperlakukan gagal gate.
  - `npm test`: **381/381 test files passed (100% lolos, 0 fail, 0 skipped)**

### Batch 7: Kunci Revalidasi Sinyal & R/R Gate Jalur Swing
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **Branch:** `fix/swing-rr-gate-and-revalidation`
- **File Dimodifikasi:**
  - [`api/sector-hot.js`](api/sector-hot.js): Import `passesRiskRewardFilter` & `MIN_RR_RATIO` dari [`lib/screener-config.js`](lib/screener-config.js), lalu memasang **Hard R/R Gate** pada jalur fallback digest Swing Konglo & Swing Non-Konglo.
  - [`test/swing-screener-rr-gate.test.js`](test/swing-screener-rr-gate.test.js): Unit test regresi baru (9 test suites).
  - [`test/auto-swing-telegram-digest.test.js`](test/auto-swing-telegram-digest.test.js): Penyesuaian fixture `digestMonitorRow` (R/R 1.5x) & ekspektasi dua test Hindari agar konsisten dengan gate baru.
  - [`tools/curated-build-tests.json`](tools/curated-build-tests.json): Pendaftaran test baru.
- **Akar Masalah yang Ditutup (Temuan Batch 0):**
  - `sendSwingKongloTelegramNotification()` & `sendSwingNkTelegramNotification()` membangun `strictCandidates` (lolos `verifyHighConvictionTelegramSignal` → R/R >= 1.8x). Namun saat `strictCandidates` kosong, sistem fallback ke `digestCandidates`.
  - Gate digest [`candidatePassesTelegramCandidateDigestGate()`](api/sector-hot.js:5223) hanya menolak `rr <= 0` — **tidak** menegakkan ambang R/R minimum. Akibatnya emiten Tier 2 (R/R 1.3x) lolos ke broadcast tanpa filter R/R.
- **Guard yang Terpasang:**
  - Jalur `digestCandidates` (Konglo & Non-Konglo) kini difilter dengan `passesRiskRewardFilter(r, MIN_RR_RATIO)` (minimum 1.5x). Kandidat dengan R/R < 1.5x **di-drop** dan tidak pernah masuk `nonAvoid`/tier/finalList, sehingga tidak disiarkan sebagai sinyal beli.
  - Jalur `strictCandidates` tetap memakai hard gate high-conviction 1.8x via [`verifySwingHighConviction()`](lib/swing-screener-engine.js:230) — tidak diubah.
- **Hasil Test:**
  - `node --check api/sector-hot.js` & `node --check test/swing-screener-rr-gate.test.js`: VALID
  - `node --test test/swing-screener-rr-gate.test.js`: 9/9 passed
    - Kandidat swing fallback R/R 1.3x terbukti DITOLAK dari dispatch sinyal beli Telegram (Konglo & Non-Konglo).
    - Kandidat R/R >= 1.8x lolos `verifySwingHighConviction`; R/R >= 1.5x lolos gate digest.
    - R/R invalid/null/0 ditolak dengan aman tanpa throw.
  - `npm test`: **382/382 test files passed (100% lolos, 0 fail, 0 skipped)**

### Batch 8: Deduplikasi & Stateful Alert Tracking (Anti-Duplikat)
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **Branch:** `fix/alert-dedup-and-state-tracking`
- **Catatan Penomoran:** Checklist awal menempatkan "State Machine Alert (Anti-Duplikat)" di Batch 9 dan "Syarat Konfirmasi Volume Breakout" di Batch 8. Sesuai instruksi protokol lintas sesi, Batch 8 dikerjakan sebagai **Deduplikasi & Stateful Alert Tracking**; item "Volume Breakout Confirmation" digeser ke Batch 9.
- **File Dimodifikasi:**
  - [`lib/telegram-notifier.js`](lib/telegram-notifier.js): Menambahkan **stateful alert dedup / cooldown guard terpusat** pada pintu transport tunggal semua alert Telegram.
  - [`test/screener-alert-dedup.test.js`](test/screener-alert-dedup.test.js): Unit test regresi baru (8 test suites).
  - [`tools/curated-build-tests.json`](tools/curated-build-tests.json): Pendaftaran test baru.
- **Akar Masalah yang Ditutup (Akar Masalah #4):**
  - `lib/telegram-notifier.js` sebelumnya murni transport tanpa dedup/cooldown sama sekali — setiap pemanggil bisa menembak alert berulang (stateless pings).
  - Modul cooldown yang sudah ada ([`lib/webhook-alert-engine.js`](lib/webhook-alert-engine.js)) **tidak terhubung ke jalur produksi mana pun** (hanya dipakai test) — sehingga dedup tidak pernah aktif di runtime.
  - Jalur [`lib/intraday-fast-watcher-publisher.js`](lib/intraday-fast-watcher-publisher.js) hanya dedup terhadap baris DB yang sudah tersimpan, bukan terhadap pengiriman in-flight/recent.
- **Guard yang Terpasang:**
  - Cache in-memory `alertCooldownCache` (Map) dengan TTL sliding-window default **20 menit** (satu jendela sesi perdagangan).
  - Guard bersifat **opt-in** via `options.alert_key` (atau `options.ticker`); tanpa key, perilaku lama tidak berubah (backward-compatible).
  - Ticker yang sama dalam window cooldown **di-suppress otomatis** dengan logging `[ALERT_DEDUP_BLOCKED]` dan hasil `{ sent: false, skipped: true, reason: 'duplicate_suppressed' }`.
  - **Bypass perubahan status signifikan:** upgrade ke status confirmed-buy (`A_PLUS`/`READY`/`TRADE_CANDIDATE`/`CONFIRMED`) atau downgrade ke `AVOID`/`SL_HIT`/`INVALID` selalu menembus cooldown.
  - Cooldown hanya dicatat **setelah pengiriman sukses terkonfirmasi** (bukan saat gagal/timeout).
  - Primitif diekspor untuk pengujian: `checkAlertCooldown`, `recordAlertCooldown`, `clearAlertCooldownCache`, `getAlertCooldownStatus`, `isDrasticAlertStatusChange`, `DEFAULT_ALERT_COOLDOWN_MS`.
- **Hasil Test:**
  - `node --check lib/telegram-notifier.js` & `node --check test/screener-alert-dedup.test.js`: VALID
  - `node --test test/screener-alert-dedup.test.js`: 8/8 passed
    - Alert pertama lolos & tercatat; duplikat dalam cooldown diblokir otomatis (tanpa hit network).
    - Alert kembali diizinkan setelah window cooldown kedaluwarsa.
    - Upgrade (Watchlist → Confirmed Buy) & downgrade (Normal → SL_HIT) menembus cooldown.
    - Alert tanpa `alert_key`/`ticker` tidak pernah di-suppress (backward-compatible).
  - `npm test`: **383/383 test files passed (100% lolos, 0 fail, 0 skipped)**

### Batch 9: Syarat Konfirmasi Volume Breakout untuk Revalidasi
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **Branch:** `fix/volume-breakout-revalidation`
- **File Dimodifikasi:**
  - [`lib/screener-config.js`](lib/screener-config.js): Menambahkan konstanta `MIN_BREAKOUT_VOLUME_RATIO = 1.2`, helper `passesVolumeBreakoutConfirmation()`, dan `validateRevalidationSignal()`.
  - [`lib/idx-tick-normalization.js`](lib/idx-tick-normalization.js): `deriveBreakoutConfirmation()` kini memverifikasi volume ratio sebelum melabeli `BREAKOUT_CONFIRMED`.
  - [`api/sector-hot.js`](api/sector-hot.js): `candidatePassesPublicTelegramSafetyGate()` memblokir status `VOLUME_CONFIRMATION_NEEDED`.
  - [`test/volume-breakout-revalidation.test.js`](test/volume-breakout-revalidation.test.js): Unit test regresi baru (13 test suites).
  - [`tools/curated-build-tests.json`](tools/curated-build-tests.json): Pendaftaran test baru.
- **Akar Masalah yang Ditutup (Akar Masalah #3 & #4):**
  - `deriveBreakoutConfirmation()` sebelumnya melabeli `BREAKOUT_CONFIRMED` HANYA berdasarkan `close > resistance`, tanpa mempertimbangkan volume ratio. Kenaikan harga tipis tanpa volume (*low-volume drift* / *fakeout*) bisa lolos sebagai breakout terkonfirmasi.
  - Tidak ada helper sentral untuk memvalidasi konfirmasi volume breakout maupun sinyal revalidasi.
- **Guard yang Terpasang:**
  - `MIN_BREAKOUT_VOLUME_RATIO = 1.2` sebagai ambang volume breakout terpusat.
  - `passesVolumeBreakoutConfirmation(candidate, minRatio)` mengekstrak volume ratio dari varian `volume_ratio`, `volume_ratio_20d`, `volume_ratio_avg20`, `volumeRatio`, `vr`, `vol_ratio`; menolak nilai null/NaN/negatif.
  - `validateRevalidationSignal(candidate, options)` menolak sinyal stale, R/R < 1.5x, dan breakout tanpa konfirmasi volume (VR < 1.2x).
  - `deriveBreakoutConfirmation()` kini mengembalikan `VOLUME_CONFIRMATION_NEEDED` (label `Needs Volume Confirmation`) saat `close > resistance` tetapi VR < `min_breakout_volume_ratio` (default 1.0x). Tanpa data volume, perilaku lama (`BREAKOUT_CONFIRMED`) dipertahankan (backward-compatible).
  - `candidatePassesPublicTelegramSafetyGate()` men-drop kandidat berstatus `VOLUME_CONFIRMATION_NEEDED` dari broadcast publik.
- **Hasil Test:**
  - `node --check lib/screener-config.js lib/idx-tick-normalization.js api/sector-hot.js test/volume-breakout-revalidation.test.js`: VALID
  - `node --test test/volume-breakout-revalidation.test.js`: 13/13 passed
    - Breakout dengan VR 0.7x terbukti DITOLAK (`VOLUME_CONFIRMATION_NEEDED`); VR 1.5x lolos `BREAKOUT_CONFIRMED`.
    - Sinyal stale, R/R 1.0x, dan breakout tanpa volume terbukti ditolak oleh `validateRevalidationSignal`.
    - Tanpa data volume, perilaku lama tetap terjaga (backward-compatible).
  - `npm test`: **384/384 test files passed (100% lolos, 0 fail, 0 skipped)**

### Batch 10: Implementasi Alert Throttling & Rate Limiter Terpusat di Telegram Notifier
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **Branch:** `fix/telegram-alert-throttling`
- **File Dimodifikasi:**
  - [`lib/telegram-notifier.js`](lib/telegram-notifier.js): Menambahkan **throttle/queue terpusat** + **backoff 429** pada pintu transport tunggal semua alert Telegram.
  - [`test/telegram-notifier-throttling.test.js`](test/telegram-notifier-throttling.test.js): Unit test regresi baru (5 test suites).
  - [`tools/curated-build-tests.json`](tools/curated-build-tests.json): Pendaftaran test baru.
- **Akar Masalah yang Ditutup (Akar Masalah #4 — burst spam & HTTP 429):**
  - `lib/telegram-notifier.js` sebelumnya **tanpa rate limiting sama sekali**: chunk pesan dikirim back-to-back tanpa jeda, dan pemanggil paralel tidak pernah diserialisasi. Saat banyak emiten lolos filter bersamaan, N `fetch` ditembak serentak → Telegram membalas HTTP 429.
  - Penanganan 429 sebelumnya **pasif**: `retry_after` diekstrak dari body/header tetapi **tidak pernah dihormati** — tidak ada backoff, tidak ada jeda, tidak ada koordinasi antar pengiriman berikutnya.
- **Guard yang Terpasang:**
  - **Serialized throttle gate** (`acquireSendSlot`): setiap pengiriman melewati satu antrean berantai (promise chain) yang menjamin hanya satu pengiriman berjalan dan memberi jeda aman antar pesan.
  - **Interval aman default 3000ms** (`DEFAULT_SEND_INTERVAL_MS`, dapat di-override via `TELEGRAM_SEND_INTERVAL_MS`) — sesuai plafon broadcast Telegram ~20 pesan/menit per chat.
  - **Backoff 429 terpusat** (`applyRateLimitBackoff`): saat Telegram membalas 429, seluruh gate diparkir selama `retry_after` (fallback `DEFAULT_SEND_INTERVAL_MS` bila tidak ada), dengan logging peringatan terstruktur `[TELEGRAM_RATE_LIMITED] honoring retry_after=...s, backoff=...s` dan **tidak pernah melempar uncaught exception**.
  - Gate dipasang pada `sendTelegramMessage`, `sendTelegramDocument`, `sendTelegramPhoto`, dan `sendTelegramPhotoUrl`.
  - **Controllable clock untuk test:** opsi `min_interval_ms` + `sleep` yang dapat di-inject; di lingkungan test (`NODE_TEST_CONTEXT`/`--test`) throttle & backoff di-bypass otomatis sehingga suite tidak menunggu timer asli.
  - Primitif diekspor untuk pengujian: `acquireSendSlot`, `applyRateLimitBackoff`, `resetTelegramThrottle`, `getTelegramThrottleState`, `DEFAULT_SEND_INTERVAL_MS`.
- **Hasil Test:**
  - `node --check lib/telegram-notifier.js` & `node --check test/telegram-notifier-throttling.test.js`: VALID
  - `node --test test/telegram-notifier-throttling.test.js test/telegram-notifier-rate-limit.test.js`: 7/7 passed
    - Burst 5 alert terbukti dipacu (>=4 jeda) dan **tidak ada yang di-drop**.
    - Respons 429 mengekstrak `retry_after`, memarkir gate (`backoffActive === true`), mencatat warning, tanpa throw.
    - Backoff aktif dihormati pada pengiriman berikutnya; `resetTelegramThrottle` membersihkan gate.
  - `npm test`: **385/385 test files passed (100% lolos, 0 fail, 0 skipped)**

### Batch 11: Syarat Konfirmasi Candle Close Sebelum Alert Entry Zone
- **Status:** **SELESAI**
- **Tanggal:** 2026-09-17
- **Branch:** `fix/candle-close-confirmation-gate`
- **File Dimodifikasi:**
  - [`lib/screener-config.js`](lib/screener-config.js): Helper sentral baru `isCandleCloseConfirmed()`.
  - [`lib/idx-tick-normalization.js`](lib/idx-tick-normalization.js): `deriveBreakoutConfirmation()` menahan `BREAKOUT_CONFIRMED` saat bar belum close.
  - [`lib/daytrade-screener-engine.js`](lib/daytrade-screener-engine.js): Kedua jalur `deriveBreakoutConfirmation` (scoreDayTrade + runDayTradeBatch) kini meneruskan state close.
  - [`test/candle-close-confirmation.test.js`](test/candle-close-confirmation.test.js): Unit test regresi baru (8 test suites).
  - [`tools/curated-build-tests.json`](tools/curated-build-tests.json): Pendaftaran test baru.
- **Akar Masalah yang Ditutup (Akar Masalah #3 & #4):**
  - `classifyStatus()` menetapkan status ENTRY ZONE (`A_PLUS_SETUP`/`TRADE_CANDIDATE`/`READY_BREAKOUT`) murni dari skor + guard volume/RR/overheat — **tanpa dimensi candle close**.
  - `deriveBreakoutConfirmation()` membandingkan `close > resistance`, dan engine mengisinya dengan `close: data.last_price`. Pada alur live/intraday, `last_price` adalah tick bar yang **masih berjalan**, sehingga jarum (wick) yang menyentuh resistance dilabeli `BREAKOUT_CONFIRMED` — membuat blok downgrade breakout di engine tidak pernah terpicu. Tidak ada flag yang membedakan "bar closed" dari "bar masih terbentuk".
- **Guard yang Terpasang:**
  - `isCandleCloseConfirmed(candidate)` mengembalikan `false` bila `candle_closed === false`, `bar_closed === false`, `candle_forming === true`, `is_intraday_live === true`, atau `price_source` mengandung penanda live/intraday/realtime/tick.
  - **Backward-compatible:** tanpa sinyal eksplisit "masih terbentuk", mengembalikan `true` (alur daily-close lama tidak berubah; `yahoo_chart_1d_close` tidak dianggap live).
  - `deriveBreakoutConfirmation()` kini mengembalikan `NEEDS_CLOSE_CONFIRMATION` saat harga di atas resistance tetapi bar belum close — bukan `BREAKOUT_CONFIRMED`.
  - Blok downgrade engine (yang menurunkan ENTRY ZONE → `EARLY_RADAR`) kini terpicu otomatis karena status bukan lagi `BREAKOUT_CONFIRMED`.
  - Gate publik [`candidatePassesPublicTelegramSafetyGate()`](api/sector-hot.js:4704) sudah memblokir `NEEDS_CLOSE_CONFIRMATION` pada broadcast/potential radar.
- **Hasil Test:**
  - `node --check lib/screener-config.js lib/idx-tick-normalization.js lib/daytrade-screener-engine.js test/candle-close-confirmation.test.js`: VALID
  - `node --test test/candle-close-confirmation.test.js`: 8/8 passed
    - Emiten dengan harga live menembus resistance (bar belum close) → `NEEDS_CLOSE_CONFIRMATION` dan TIDAK mencapai ENTRY ZONE.
    - Emiten dengan close terkonfirmasi → `BREAKOUT_CONFIRMED` dan lolos ke ENTRY ZONE (`A_PLUS_SETUP`).
    - Kandidat daily-close lama tanpa flag tidak terpengaruh (backward-compatible).
  - `npm test`: **386/386 test files passed (100% lolos, 0 fail, 0 skipped)**
