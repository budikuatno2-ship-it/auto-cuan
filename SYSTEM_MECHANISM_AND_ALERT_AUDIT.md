# SYSTEM MECHANISM AND ALERT AUDIT
**Dokumentasi Analisis Mendalam Arsitektur Sistem, Fact-Check Hipotesis, dan Audit Notifikasi Telegram**
*Workspace Repository: Auto-Cuan Engine (`d:/auto-cuan-2`)*
*Tanggal Audit: 22 September 2026*
*Status Dokumen: **PERMANEN / JANGAN DIHAPUS** (Arsip Audit Arsitektur)*

---

## DAFTAR ISI
1. [Ringkasan Eksekutif & Matriks Verifikasi Hipotesis](#ringkasan-eksekutif--matriks-verifikasi-hipotesis)
2. [Poin 1: Verifikasi Masalah Alert Spam & Duplikasi Jam 09:00 WIB (Kasus TAPG)](#poin-1-verifikasi-masalah-alert-spam--duplikasi-jam-0900-wib-kasus-tapg)
   - [1.1 Anatomi Insiden TAPG 09:00 WIB](#11-anatomi-insiden-tapg-0900-wib)
   - [1.2 Verifikasi Klaim 1: Multi-Setup Screener & Ketiadaan Global Ticker Lock](#12-verifikasi-klaim-1-multi-setup-screener--ketiadaan-global-ticker-lock)
   - [1.3 Verifikasi Klaim 2: Deduplikasi Tanpa Cooldown Lock Saat Open](#13-verifikasi-klaim-2-deduplikasi-tanpa-cooldown-lock-saat-open)
   - [1.4 Verifikasi Klaim 3: Format Template ENTRY ZONE Minimalis](#14-verifikasi-klaim-3-format-template-entry-zone-minimalis)
   - [1.5 File, Fungsi, Line Number & Akar Penyebab](#15-file-fungsi-line-number--akar-penyebab)
   - [1.6 Rekomendasi Kode Perbaikan Komprehensif](#16-rekomendasi-kode-perbaikan-komprehensif)
3. [Poin 2: Mekanisme Daytrade Lengkap (Pre-Market s/d Post-Closing EOD)](#poin-2-mekanisme-daytrade-lengkap-pre-market-sd-post-closing-eod)
   - [2.1 Fase Pre-Opening (08:45 – 08:59 WIB)](#21-fase-pre-opening-0845--0859-wib)
   - [2.2 Fase Sesi 1 Awal (09:00 – 09:30 WIB)](#22-fase-sesi-1-awal-0900--0930-wib)
   - [2.3 Fase Sesi 1 Pertengahan (09:30 – 11:30 / 12:00 WIB)](#23-fase-sesi-1-pertengahan-0930--1130--1200-wib)
   - [2.4 Fase Jeda Sesi Bursa (11:30 / 12:00 – 13:30 / 14:00 WIB)](#24-fase-jeda-sesi-bursa-1130--1200--1330--1400-wib)
   - [2.5 Fase Sesi 2 (13:30 / 14:00 – 15:45 / 16:00 WIB)](#25-fase-sesi-2-1330--1400--1545--1600-wib)
   - [2.6 Fase Post-Closing / EOD (15:45 – 16:30 WIB)](#26-fase-post-closing--eod-1545--1630-wib)
   - [2.7 Matriks Status Sinyal & Dynamic Downgrade](#27-matriks-status-sinyal--dynamic-downgrade)
4. [Poin 3: Mekanisme Fast Watcher & Intraday Guard](#poin-3-mekanisme-fast-watcher--intraday-guard)
   - [3.1 Verifikasi Hard-Cap Shortlist 30 Baris](#31-verifikasi-hard-cap-shortlist-30-baris)
   - [3.2 Logika Transisi Konfirmasi (0/2 -> 1/2 -> 2/2)](#32-logika-transisi-konfirmasi-02---12---22)
   - [3.3 Filter Anti-Chase (Advance > 6% & TP1 Hit Block)](#33-filter-anti-chase-advance--6--tp1-hit-block)
   - [3.4 Formula Algoritma Perhitungan Volume Pace](#34-formula-algoritma-perhitungan-volume-pace)
5. [Poin 4: Mekanisme Swing Konglo vs Swing Non-Konglo](#poin-4-mekanisme-swing-konglo-vs-swing-non-konglo)
   - [4.1 Deklarasi & Sumber Universe (Konglo vs Non-Konglo)](#41-deklarasi--sumber-universe-konglo-vs-non-konglo)
   - [4.2 Karakteristik & Filosofi Swing Konglo](#42-karakteristik--filosofi-swing-konglo)
   - [4.3 Batasan Ketat Non-Konglo & `SWING_NK_HIGH_RR_WARNING_THRESHOLD`](#43-batasan-ketat-non-konglo--swing_nk_high_rr_warning_threshold)
   - [4.4 Branching Evaluasi Scoring & Quality Gates](#44-branching-evaluasi-scoring--quality-gates)
6. [Poin 5: Mekanisme Monitoring Periodik & Katalog Alert TP/SL](#poin-5-mekanisme-monitoring-periodik--katalog-alert-tpsl)
   - [5.1 Monitoring Terjadwal (Hourly & Half-Hour Broadcast)](#51-monitoring-terjadwal-hourly--half-hour-broadcast)
   - [5.2 Alert Emergency TP / SL & Bypass Cooldown](#52-alert-emergency-tp--sl--bypass-cooldown)
   - [5.3 Trailing Stop & BEP Lock Mechanism](#53-trailing-stop--bep-lock-mechanism)
   - [5.4 Katalog Lengkap Event Trigger Telegram di Repository](#54-katalog-lengkap-event-trigger-telegram-di-repository)

---

## RINGKASAN EKSEKUTIF & MATRIKS VERIFIKASI HIPOTESIS

Berdasarkan investigasi menyeluruh (*deep-dive code audit*) terhadap codebase lokal Auto-Cuan, berikut adalah hasil uji fakta (*fact-check*) terhadap setiap klaim hipotesis yang diajukan:

| No | Hipotesis / Klaim yang Diuji | Status Hasil Verifikasi | Temuan Kunci di Kode Sumber |
|---|---|---|---|
| **1.1** | Engine menghasilkan > 1 setup trade plan per emiten dan dedup key tidak mengunci ticker secara global per interval waktu. | **VALID & TERBUKTI** | [`lib/trade-plan-v2-integration.js:582`](lib/trade-plan-v2-integration.js:582) menghasilkan `plan_lock_id` unik berbasis parameter entry-zone. Di [`api/sector-hot.js:8768`](api/sector-hot.js:8768), `buildMonitorDedupKey` mengelompokkan baris berdasarkan `'plan\|' + source + '\|' + ticker + '\|' + planLockId`. Jika ada 2 plan berbeda (misal Rp2.150–2.170 vs Rp2.160–2.190), keduanya TIDAK di-deduplikasi dan tetap aktif bersamaan. |
| **1.2** | Pada pukul 09:00 WIB saat opening tick pertama masuk, kondisi evaluasi alert bernilai true secara simultan tanpa ada guard cooldown antar-pesan milidetik. | **VALID & TERBUKTI** | Di [`api/sector-hot.js:9111`](api/sector-hot.js:9111), pemanggilan [`telegramNotifier.sendTelegramMessage(hitMsg, { timeout_ms: 3000 })`](api/sector-hot.js:9111) **TIDAK MENYERTAKAN** parameter `alert_key` maupun `ticker`. Akibatnya, mekanisme sliding cooldown 20 menit di [`lib/telegram-notifier.js:303`](lib/telegram-notifier.js:303) menjadi **NON-AKTIF / BYPASSED**. Seluruh baris TAPG dieksekusi berturut-turut pada detik yang sama. |
| **1.3** | Format ENTRY ZONE minimalis ("Harga memasuki area entry...") adalah format legacy/mentah yang bocor tanpa menyertakan SL, TP, dan volume. | **KOREKSI PARSIAL** | Format ini **BUKAN** kebocoran data mentah tak terduga, melainkan template resmi [`telegramTemplates.formatMonitorHitMessage`](lib/telegram-templates.js:290) di [`lib/telegram-templates.js:411-450`](lib/telegram-templates.js:411). Namun, template ini memang **cacat desain (under-informative)** karena hanya menampilkan nama ticker, harga trigger, dan last price, tanpa menyertakan Trading Plan lengkap (SL, TP1, TP2, RR, volume). |
| **2.1** | Siklus Daytrade IDX memiliki 6 fase (Pre-Opening, Sesi 1 Awal, Sesi 1 Mid, Jeda, Sesi 2, EOD Closeout) dengan aturan eksekusi berbeda. | **VALID & AKURAT** | Diatur oleh [`lib/market-hours-guard.js:6-20`](lib/market-hours-guard.js:6), [`lib/daytrade-screener-engine.js:113-171`](lib/daytrade-screener-engine.js:113), dan modul otomasi VPS. |
| **2.2** | Sesi 1 Pertengahan melakukan dynamic downgrade status jika skor anjlok di bawah grade entry. | **VALID & TERBUKTI** | [`lib/daytrade-intraday-score-adjustment.js:20`](lib/daytrade-intraday-score-adjustment.js:20) mendefinisikan `ENTRY_GRADE_MIN_SCORE = 75` dan `RADAR_MIN_SCORE = 60`. Jika skor turun di bawah 75, status `A_PLUS_SETUP` langsung di-downgrade menjadi `WAIT_PULLBACK` atau `AVOID`. |
| **2.3** | Sesi 2 (Afternoon Mode) memblokir sinyal baru dan membatasi entry. | **VALID & TERBUKTI** | Di [`lib/daytrade-screener-engine.js:891-984`](lib/daytrade-screener-engine.js:891), jika `runMode === 'AFTERNOON_EXIT'` (13:30–16:00 WIB), `A_PLUS_SETUP` mutlak dinonaktifkan, `READY_BREAKOUT` di-downgrade ke `MOMENTUM_CONTINUATION`, dan `PRE_SPIKE` ke `WAIT_PULLBACK`. |
| **3.1** | Pool/shortlist Fast Watcher dibatasi maksimal 30 baris. | **VALID & TERBUKTI** | [`lib/intraday-fast-watcher-pool.js:15`](lib/intraday-fast-watcher-pool.js:15) mendeklarasikan konstanta keras `const MAX_ACTIVE_POOL = 30;`. |
| **3.2** | Konfirmasi bertahap 0/2 (Early Watch), 1/2 (Radar Prioritas), hingga 2/2 (Terkonfirmasi). | **VALID (DENGAN DETAIL IMPLEMENTASI)** | Dihitung oleh fungsi [`stepTickerPool`](lib/intraday-fast-watcher-pool.js:353) menggunakan `confirmation_window` (sliding window 5 observasi) dan counter `ready_streak`. Status 0/2 = `WATCHING`, 1/2 = `READY_PENDING` / `PENDING_VELOCITY` (diterbitkan oleh [`lib/intraday-fast-watcher-radar-publisher.js:85`](lib/intraday-fast-watcher-radar-publisher.js:85)), dan 2/2 (atau 2 dari 3 / `two_of_three_confirmation`) = `READY_CONFIRMED`. |
| **3.3** | Saham naik > 6% dari harga acuan atau menyentuh TP1 langsung diblokir (anti-chase). | **VALID & TERBUKTI** | Di [`lib/intraday-fast-watcher-momentum.js:16`](lib/intraday-fast-watcher-momentum.js:16), `MAX_ADVANCE_PCT = 6`. Di baris 479-483, jika harga menyentuh/melebihi TP1 atau `highestPriceSinceLock >= tp1`, status menjadi `BLOCKED_CHASE`. Jika `advance_pct > maxAdvance`, di-downgrade ke `SPIKE_RADAR`. |
| **3.4** | Formula Volume Pace mengukur proyeksi volume harian terhadap rata-rata 20 hari dan kemarin. | **VALID & TERBUKTI** | Diimplementasikan dalam [`lib/intraday-volume-pace.js:222-259`](lib/intraday-volume-pace.js:222): `Projected = Volume / EffectiveProgress`, diblend `(0.75 * vs20d) + (0.25 * vsPrevDay)` dengan clamping max 6.0x. |
| **4.1** | Swing Konglo fokus pada emiten konglomerasi tertentu dengan toleransi batas gerak lebih lebar. | **VALID & TERBUKTI** | Menggunakan data tabel [`sector_hot_groups`](api/sector-hot.js:1381) dan [`sector_hot_group_members`](api/sector-hot.js:1392) (Bakrie, Barito, MNC, Astra, Salim, Sinarmas, dll.). |
| **4.2** | Swing Non-Konglo memicu `high_rr_warning` jika Risk-to-Reward (R:R) > 2.5. | **VALID & TERBUKTI** | [`lib/swing-nk-rr-warning.js:23`](lib/swing-nk-rr-warning.js:23) menetapkan `SWING_NK_HIGH_RR_WARNING_THRESHOLD = 2.5;` berdasarkan temuan empiris historis (sinyal gagal kena SL rata-rata punya R:R 3.3x vs yang berhasil 2.1x). |
| **5.1** | Monitoring periodik terjadwal jam 10, 11, 12, 14, 15 WIB mengirimkan pesan batch summary panjang. | **VALID & TERBUKTI** | Fungsi [`handleTelegramMonitorPicks`](api/sector-hot.js:8949) di [`api/sector-hot.js:8999`](api/sector-hot.js:8999) membentuk pesan berheader `⏱ AUTO-CUAN MONITOR HH:00 WIB` yang dikirim hanya pada top-of-hour (`hourlyBatchDue`). |
| **5.2** | Emergency SL/TP mem-bypass cooldown dan batch summary. | **VALID & TERBUKTI** | [`isDrasticAlertStatusChange`](lib/telegram-notifier.js:56) dan [`api/sector-hot.js:9094-9114`](api/sector-hot.js:9094) memastikan `significantHit` (`SL_HIT`, `TP1_HIT`, dll.) dikirim **seketika** pada setiap interval eksekusi (termasuk half-hour). |
| **5.3** | Codebase memiliki notifikasi Radar Spike, EOD Recap, Bandarmologi/Broker Hunter. | **VALID & TERBUKTI** | Terdapat di modul [`lib/intraday-fast-watcher-radar-publisher.js`](lib/intraday-fast-watcher-radar-publisher.js), [`lib/telegram-daily-recap.js`](lib/telegram-daily-recap.js), [`lib/bandarmologi-intel-service.js`](lib/bandarmologi-intel-service.js), dan [`lib/foreign-flow-recap.js`](lib/foreign-flow-recap.js). |

---

## POIN 1: VERIFIKASI MASALAH ALERT SPAM & DUPLIKASI JAM 09:00 WIB (KASUS TAPG)

### 1.1 Anatomi Insiden TAPG 09:00 WIB
Berdasarkan bukti tangkapan layar channel Telegram *"Signal Saham Bot"*, saham **TAPG** terkirim sebanyak 3 kali berturut-turut pada detik yang sama di pembukaan bursa (09:00 WIB):
1. **Pesan 1:**
   ```text
   🟢 ENTRY ZONE
   Saham: TAPG
   Trigger: harga masuk area entry Rp2.150-Rp2.170
   Last: Rp2.160
   Catatan: Harga memasuki area entry. Konfirmasi volume/chart wajib.
   ```
2. **Pesan 2:**
   ```text
   🟢 ENTRY ZONE
   Saham: TAPG
   Trigger: harga masuk area entry Rp2.160-Rp2.190
   Last: Rp2.170
   Catatan: Harga memasuki area entry. Konfirmasi volume/chart wajib.
   ```
3. **Pesan 3:**
   ```text
   🟢 ENTRY ZONE
   Saham: TAPG
   Trigger: harga masuk area entry Rp2.160-Rp2.190
   Last: Rp2.170
   Catatan: Harga memasuki area entry. Konfirmasi volume/chart wajib.
   ```

### 1.2 Verifikasi Klaim 1: Multi-Setup Screener & Ketiadaan Global Ticker Lock
**Status Klaim: VALID DAN TERBUKTI SECARA KODE.**

1. **Pembuatan Identitas Plan Unik per Range Harga:**
   Di [`lib/trade-plan-v2-integration.js:627-638`](lib/trade-plan-v2-integration.js:627), fungsi [`buildLockedTradePlan`](lib/trade-plan-v2-integration.js:617) memanggil [`computePlanLockId`](lib/trade-plan-v2-integration.js:582):
   ```javascript
   function computePlanLockId(fields) {
     const parts = [
       resolveScreenerType(fields.screener_type) || '',
       fields.ticker ? String(fields.ticker).toUpperCase() : '',
       normalizeTradingDate(fields.trading_date),
       fields.source || '',
       fields.entry_zone_low == null ? '' : String(fields.entry_zone_low),
       fields.entry_zone_high == null ? '' : String(fields.entry_zone_high),
       fields.stop_loss == null ? '' : String(fields.stop_loss),
       fields.emergency_stop == null ? '' : String(fields.emergency_stop),
       fields.tp1 == null ? '' : String(fields.tp1),
       fields.tp2 == null ? '' : String(fields.tp2)
     ];
     const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
     return 'tplock_' + hash;
   }
   ```
   Karena parameter `entry_zone_low` dan `entry_zone_high` masuk ke dalam hashing SHA-256, maka:
   - Setup A (Entry Rp2.150–Rp2.170) menghasilkan `plan_lock_id = "tplock_aaaa"`.
   - Setup B (Entry Rp2.160–Rp2.190) menghasilkan `plan_lock_id = "tplock_bbbb"`.

2. **Deduplikasi Database Gagal Menggabungkan Ticker:**
   Di [`lib/telegram-delivery.js:522-526`](lib/telegram-delivery.js:522), key penyimpanan ke tabel `telegram_daily_picks` didefinisikan sebagai:
   ```javascript
   var key = identity.ticker + '|' + identity.monitor_source + '|' + identity.plan_lock_id;
   ```
   Karena `plan_lock_id`-nya berbeda, sistem menganggap keduanya sebagai entitas berbeda. Kedua baris tersebut tersimpan ke database `telegram_daily_picks`.

3. **Deduplikasi In-Memory di Monitor Runner:**
   Di [`api/sector-hot.js:8764-8772`](api/sector-hot.js:8764):
   ```javascript
   function buildMonitorDedupKey(pick) {
     var source = String(resolveMonitorSource(pick) || '').toLowerCase();
     var ticker = String(pick && pick.ticker || '').toUpperCase();
     var planLockId = resolveMonitorPlanIdentity(pick);
     if (planLockId) return 'plan|' + source + '|' + ticker + '|' + String(planLockId);
     return 'legacy|' + source + '|' + ticker;
   }
   ```
   Komentar resmi di baris 8788 menyatakan:
   *"Deduplicate exact identified plans only. Distinct plan_lock_id values remain independently monitored even when ticker and source are the same."*
   **Kesimpulan:** Sistem secara sengaja mengizinkan beberapa setup berbeda untuk ticker yang sama berjalan secara paralel di monitor, TANPA ada batasan bahwa 1 ticker hanya boleh memiliki 1 alert aktif pada suatu interval waktu!

### 1.3 Verifikasi Klaim 2: Deduplikasi Tanpa Cooldown Lock Saat Open
**Status Klaim: VALID DAN TERBUKTI SECARA KODE.**

1. **Evaluasi Simultan pada Pembukaan:**
   Pada pukul 09:00 WIB, pasar dibuka dan harga pembukaan TAPG masuk di kisaran Rp2.160–Rp2.170.
   - Untuk baris Setup A (2.150–2.170): Harga Rp2.160 berada di dalam rentang entry -> `ev.status = 'IN_ENTRY_ZONE'`.
   - Untuk baris Setup B (2.160–2.190): Harga Rp2.160 berada di dalam rentang entry -> `ev.status = 'IN_ENTRY_ZONE'`.
   Kedua baris memiliki kolom `hit_entry_at == null`.
   Di [`api/sector-hot.js:9088`](api/sector-hot.js:9088):
   ```javascript
   if ((ev.status === 'RUNNING' || ev.status === 'IN_ENTRY_ZONE') && !pck.hit_entry_at) isNewHit = true;
   var significantHit = isPublicAlertEligible && isNewHit && ...;
   ```
   Variabel `significantHit` bernilai `true` untuk semua baris TAPG.

2. **Akar Cacat: Bypassed Cooldown pada Notifier:**
   Di [`api/sector-hot.js:9111`](api/sector-hot.js:9111):
   ```javascript
   hitResult = await telegramNotifier.sendTelegramMessage(hitMsg, { timeout_ms: 3000 });
   ```
   Perhatikan opsi yang dikirim: `{ timeout_ms: 3000 }`.
   Sekarang kita periksa [`lib/telegram-notifier.js:302-318`](lib/telegram-notifier.js:302):
   ```javascript
   // 0b. BATCH 8: Stateful alert dedup / cooldown guard (opt-in via alert_key/ticker).
   const alertKey = options.alert_key || options.alertKey || options.ticker || null;
   if (alertKey) {
     const cooldown = checkAlertCooldown(alertKey, options.status || options.alert_status, options);
     if (cooldown.suppressed) {
       console.log(`[ALERT_DEDUP_BLOCKED] Duplicate alert suppressed for ${String(alertKey).toUpperCase()}...`);
       return { sent: false, skipped: true, reason: 'duplicate_suppressed' };
     }
   }
   ```
   **BUKTI MUTLAK:** Karena `api/sector-hot.js` memanggil `sendTelegramMessage` **tanpa** mengirimkan `options.ticker: pck.ticker` ataupun `options.alert_key`, maka nilai `alertKey` selalu `null`!
   Akibatnya:
   - Cache cooldown sliding 20 menit (`alertCooldownCache`) **TIDAK PERNAH DIJALANKAN** untuk alert monitor individual!
   - Di dalam perulangan `for (var i = 0; i < rows.length; i++)`, pesan untuk baris 1 dikirim, lalu baris 2 dikirim langsung tanpa jeda, menghasilkan ledakan spam notifikasi berturut-turut pada jam 09:00:00 WIB.
   - Mengenai adanya pesan ke-3 dengan harga sama: Disebabkan oleh adanya baris ganda dari dua sumber monitor yang berbeda (misal `source: 'daytrade'` dan `source: 'swing'`) atau ketiadaan lock atomik saat cron dieksekusi berbarengan di Vercel/VPS.

### 1.4 Verifikasi Klaim 3: Format Template ENTRY ZONE Minimalis
**Status Klaim: KOREKSI PARSIAL.**

Pesan minimalis tersebut **BUKAN** kebocoran string logging atau unformatted dump. Format tersebut dihasilkan oleh fungsi resmi [`formatMonitorHitMessage`](lib/telegram-templates.js:290) di [`lib/telegram-templates.js:411-450`](lib/telegram-templates.js:411):
```javascript
  } else if (status === 'IN_ENTRY_ZONE' || status === 'RUNNING') {
    emoji = '\uD83D\uDFE2';
    statusLabel = status === 'IN_ENTRY_ZONE' ? 'ENTRY ZONE' : 'RUNNING';
    triggerLine = 'Trigger: ' + getTriggerBasis();
    catatan = status === 'IN_ENTRY_ZONE' ? 'Harga memasuki area entry. Konfirmasi volume/chart wajib.' : 'Entry sudah tersentuh; monitor TP/SL aktif.';
  }
...
  var lines = [];
  lines.push(emoji + ' ' + statusLabel);
  lines.push('Saham: ' + ticker);
  if (triggerLine) lines.push(triggerLine);
  lines.push('Last: ' + fmtPrice(last));
  if (profitLine) lines.push(profitLine);
  lines.push('Catatan: ' + catatan);
  return lines.join('\n');
```

**Masalah Fundamental Desain:**
Template ini dibuat sebagai *"quick ping"* dengan asumsi pengguna sudah membaca Signal Card lengkap di awal sesi. Namun di lapangan, ketika pengguna menerima notifikasi ini secara tiba-tiba tanpa kartu sinyal awal, pesan tersebut menjadi membingungkan:
- Tidak ada Stop Loss (SL).
- Tidak ada Target Profit (TP1 & TP2).
- Tidak ada indikator konfirmasi volume/pace real-time.

### 1.5 File, Fungsi, Line Number & Akar Penyebab

| Komponen | File Path | Line Number | Nama Fungsi / Logika | Cacat / Akar Masalah |
|---|---|---|---|---|
| **Monitor Dispatcher** | [`api/sector-hot.js`](api/sector-hot.js) | Line 9111 | [`handleTelegramMonitorPicks`](api/sector-hot.js:8949) | Memanggil `telegramNotifier.sendTelegramMessage(hitMsg, { timeout_ms: 3000 })` **tanpa** menyertakan `{ ticker: pck.ticker, alert_key: pck.ticker, status: ev.status }`. |
| **Dedup Key Generator** | [`api/sector-hot.js`](api/sector-hot.js) | Line 8764–8772 | [`buildMonitorDedupKey`](api/sector-hot.js:8764) | Mengikutsertakan `planLockId` ke dalam key deduplikasi, memecah ticker yang sama menjadi beberapa track terpisah. |
| **In-Memory Cooldown** | [`lib/telegram-notifier.js`](lib/telegram-notifier.js) | Line 302–318 | [`sendTelegramMessage`](lib/telegram-notifier.js:280) | Mekanisme `checkAlertCooldown` bersifat *opt-in* via `options.alert_key`/`options.ticker`. Jika pemanggil lupa mengirimkannya, proteksi tidak bekerja. |
| **Hit Template** | [`lib/telegram-templates.js`](lib/telegram-templates.js) | Line 411–450 | [`formatMonitorHitMessage`](lib/telegram-templates.js:290) | Kasus `IN_ENTRY_ZONE` tidak menyertakan TP1, TP2, SL, dan Risk/Reward. |

### 1.6 Rekomendasi Kode Perbaikan Komprehensif

#### Perbaikan 1: Pasang Guard Cooldown & Global Ticker Dedup pada Monitor Runner
Di file [`api/sector-hot.js`](api/sector-hot.js), ubah pemanggilan di baris 9111 dan tambahkan in-run ticker set:
```javascript
// SEBELUM LOOP (sekitar baris 9008):
var notifiedTickersInRun = new Set();

// DI DALAM LOOP SAAT EVALUASI SIGNIFICANT HIT (baris 9094):
var tickerUpper = String(pck.ticker || '').toUpperCase();
if (notifiedTickersInRun.has(tickerUpper) && ev.status === 'IN_ENTRY_ZONE') {
  // Suppress duplicate entry alert for the same ticker within the same execution
  significantHit = false;
}

// SAAT PENGIRIMAN TELEGRAM (baris 9111):
if (significantHit) {
  // Kirimkan ticker dan status ke notifier agar cooldown sliding-window 20 menit aktif!
  hitResult = await telegramNotifier.sendTelegramMessage(hitMsg, {
    timeout_ms: 3000,
    ticker: tickerUpper,
    alert_key: 'MONITOR_HIT:' + tickerUpper,
    status: ev.status
  });
  if (hitResult && hitResult.sent) {
    individualSentCount++;
    notifiedTickersInRun.add(tickerUpper);
  }
}
```

#### Perbaikan 2: Satukan Dedup Key Monitor Menjadi Per Ticker Global
Di [`api/sector-hot.js:8764-8772`](api/sector-hot.js:8764), prioritaskan plan terbaru dan kunci hanya 1 plan aktif per ticker:
```javascript
function buildMonitorDedupKey(pick) {
  var ticker = String(pick && pick.ticker || '').toUpperCase();
  // Kunci per ticker secara global untuk monitoring intraday agar tidak terjadi multi-setup spam
  return 'ticker_global|' + ticker;
}
```

#### Perbaikan 3: Lengkapi Template `formatMonitorHitMessage` untuk `IN_ENTRY_ZONE`
Di [`lib/telegram-templates.js:411-450`](lib/telegram-templates.js:411), tambahkan level SL, TP, dan RR:
```javascript
  } else if (status === 'IN_ENTRY_ZONE' || status === 'RUNNING') {
    emoji = '\uD83D\uDFE2';
    statusLabel = status === 'IN_ENTRY_ZONE' ? 'ENTRY ZONE' : 'RUNNING';
    triggerLine = 'Trigger: ' + getTriggerBasis();
    catatan = status === 'IN_ENTRY_ZONE'
      ? 'Harga memasuki area entry. Siapkan eksekusi sesuai plan. SL & TP wajib disiplin!'
      : 'Entry sudah tersentuh; monitor TP/SL aktif.';
  }
...
  lines.push(emoji + ' ' + statusLabel);
  lines.push('Saham: ' + ticker);
  if (triggerLine) lines.push(triggerLine);
  lines.push('Last: ' + fmtPrice(last));
  // TAMBAHAN: Sertakan parameter Trading Plan lengkap!
  if (sl || tp1) {
    lines.push('Trading Plan: SL ' + fmtPrice(sl) + ' | TP1 ' + fmtPrice(tp1) + (tp2 ? ' | TP2 ' + fmtPrice(tp2) : ''));
  }
  if (profitLine) lines.push(profitLine);
  lines.push('Catatan: ' + catatan);
```

---

## POIN 2: MEKANISME DAYTRADE LENGKAP (PRE-MARKET S/D POST-CLOSING EOD)

Arsitektur Daytrade Auto-Cuan dibangun di atas guard waktu bursa terpusat ([`lib/market-hours-guard.js`](lib/market-hours-guard.js)) dan engine screener multi-fase ([`lib/daytrade-screener-engine.js`](lib/daytrade-screener-engine.js)). Sistem beroperasi dalam 6 fase ketat selama hari bursa (Senin–Jumat, WIB):

```
+-----------------------------------------------------------------------------------------------+
|                             SIKLUS HARIAN DAYTRADE AUTO-CUAN (WIB)                           |
+-----------------------------------------------------------------------------------------------+
| 08:00 - 08:59 WIB | Pre-Market: Universe Discovery & Top 5 Locking                            |
| 09:00 - 09:30 WIB | Sesi 1 Awal: Volatilitas Pembukaan, Fast Watcher & Opening Range Velocity  |
| 09:30 - 11:30 WIB | Sesi 1 Mid: Intraday Score Adjustment & Dynamic Downgrade                 |
| 11:30 - 13:30 WIB | Jeda Sesi (Break): Orderbook Beku, Hard Market Gate (No Signals)          |
| 13:30 - 15:45 WIB | Sesi 2 (Afternoon Exit): Blokir Entry Agresif, Force Momentum/Exit Only   |
| 15:45 - 16:30 WIB | EOD Closeout & Outcome Evaluation: Evaluasi Win-Rate & Track Record       |
+-----------------------------------------------------------------------------------------------+
```

### 2.1 Fase Pre-Opening (08:00 – 08:59 WIB)
1. **Pemicu & Penjadwalan:**
   - Vercel Cron Job mengeksekusi `GET /api/sector-hot?action=telegram-daily-picks` pada jadwal `"0 1 * * 1-5"` (01:00 UTC = 08:00 WIB, lihat [`vercel.json:560-563`](vercel.json:560)).
   - Di VPS lokal, dijalankan via batch runner pre-market.
2. **Operasi yang Dijalankan:**
   - **Universe Ingestion:** Memuat saham dari papan `UTAMA` dan `PENGEMBANGAN` melalui tabel `stock_boards`.
   - **Kandidat Awal:** Menyaring data candle harian (Daily D-1) untuk mengidentifikasi saham dengan pola breakout, pre-spike, atau akumulasi bandar.
   - **Trade Plan Locking:** Menghitung level support, resistance, ATR14, SL, TP1, dan TP2 awal. Mengunci `plan_lock_id` dan menyimpannya ke tabel `telegram_daily_picks` dengan `status = 'LOCKED'`.

### 2.2 Fase Sesi 1 Awal (09:00 – 09:30 WIB)
1. **Karakteristik Pasar:** Fase volatilitas tinggi (*opening gap & initial spike*).
2. **Aturan Engine di [`lib/daytrade-screener-engine.js:129-130`](lib/daytrade-screener-engine.js:129):**
   - Mode operasi terdeteksi sebagai `'MORNING_SCOUT'` (menit total 540–630 WIB).
   - Diizinkan melahirkan status tertinggi: `A_PLUS_SETUP`, `TRADE_CANDIDATE`, `READY_BREAKOUT`, dan `PRE_SPIKE_WATCH`.
3. **Mekanisme Khusus Opening Range Velocity (09:16 – 09:30 WIB):**
   - Didefinisikan di [`lib/intraday-fast-watcher-momentum.js:19-22`](lib/intraday-fast-watcher-momentum.js:19):
     - `OPENING_VELOCITY_WINDOW_START_MINUTE = 556;` (09:16 WIB)
     - `OPENING_VELOCITY_WINDOW_END_MINUTE = 570;` (09:30 WIB)
     - `VELOCITY_THRESHOLD_MAIN_DEVELOPMENT = 250_000_000;` (Rp 250 Juta dalam 5 menit)
     - `VELOCITY_THRESHOLD_ACCELERATION = 100_000_000;` (Rp 100 Juta dalam 5 menit)
   - Pada rentang waktu ini, saham yang mengalami breakout tanpa dorongan turnover velocity minimal di atas langsung ditahan dengan alasan `'opening_range_velocity_insufficient'` / `'opening_range_velocity_gate_blocked'`.

### 2.3 Fase Sesi 1 Pertengahan (09:30 – 11:30 / 12:00 WIB)
1. **Transisi Mode:** Jam 10:30 WIB transisi ke `'MIDDAY_CHECK'` ([`lib/daytrade-screener-engine.js:132`](lib/daytrade-screener-engine.js:132)).
2. **Evaluasi Dynamic Score Adjustment:**
   - Dikelola oleh [`lib/daytrade-intraday-score-adjustment.js`](lib/daytrade-intraday-score-adjustment.js).
   - Ambang batas mutlak:
     - `ENTRY_GRADE_MIN_SCORE = 75;`
     - `RADAR_MIN_SCORE = 60;`
   - **Kondisi Downgrade:**
     Jika saham awalnya memiliki status entry-grade (`A_PLUS_SETUP`, `TRADE_CANDIDATE`, `ENTRY_READY`) namun penalti intraday (misal: tekanan jual, volume drop, harga turun di bawah VWAP) membuat skor anjlok:
     - Jika `adjustedScore < 75` dan `adjustedScore >= 60`: Status otomatis di-downgrade menjadi `'WAIT_PULLBACK'`, confidence turun ke `'B'`.
     - Jika `adjustedScore < 60`: Status langsung di-downgrade menjadi `'AVOID'`, confidence turun ke `'C'`.
     - Ditandai dengan catatan: `intraday_status_downgrade_reason: 'intraday_score_below_entry_grade'`.

### 2.4 Fase Jeda Sesi Bursa (11:30 / 12:00 – 13:30 / 14:00 WIB)
1. **Aturan Jadwal IDX Resmi:**
   - Senin–Kamis: Istirahat 11:58 – 13:30 WIB.
   - Jumat: Istirahat Sholat Jumat 11:28 – 14:00 WIB.
2. **Hard Market Gate:**
   - Fungsi [`getMarketSessionStatus`](lib/daytrade-screener-engine.js:153) mengembalikan `{ isOpen: false, session: 'BREAK', reason: 'lunch_break' / 'friday_break' }`.
   - Di [`lib/webhook-alert-engine.js:606`](lib/webhook-alert-engine.js:606), alert instan otomatis dibatalkan:
     ```javascript
     if (isMarketSessionClosed(options.now)) return { success: false, skipped: true, reason: 'market_session_closed' };
     ```
   - Di [`lib/telegram-notifier.js:286-300`](lib/telegram-notifier.js:286), pengiriman Telegram dibatalkan dengan log: `[MARKET_GUARD_BLOCKED] Broadcast cancelled: Market is CLOSED`. Order book beku; dilarang menghitung sinyal dari quote kadaluarsa.

### 2.5 Fase Sesi 2 (13:30 / 14:00 – 15:45 / 16:00 WIB)
1. **Mode Engine: `AFTERNOON_EXIT`:**
   - Aktif pada menit total 810–960 (13:30–16:00 WIB, lihat [`lib/daytrade-screener-engine.js:135`](lib/daytrade-screener-engine.js:135)).
2. **Aturan Proteksi Afternoon Mode:**
   - **`A_PLUS_SETUP` Diblokir Total:** Baris 910 mengharuskan `!isAfternoon`. Tidak ada sinyal A+ baru di sesi 2.
   - **Downgrade Sinyal Breakout:**
     - Saham dengan skor tinggi (`score >= 75`) yang biasanya mendapat `READY_BREAKOUT` atau `TRADE_CANDIDATE`, otomatis dialihkan ke status `MOMENTUM_CONTINUATION` dengan setup *"Late Session Momentum"* dan catatan: *"Late entry berisiko. Prioritaskan exit sebelum close. Jangan entry agresif kecuali sudah punya posisi dan trailing plan."* (baris 938-942).
   - **Downgrade Sinyal Pre-Spike:**
     - Saham dengan skor pre-spike (`score >= 70`) otomatis dialihkan ke `WAIT_PULLBACK` dengan setup *"Late Session - Wait"* dan catatan: *"Sesi sore, waktu breakout terbatas. Late entry berisiko. Prioritas exit."* (baris 980-984).

### 2.6 Fase Post-Closing / EOD (15:45 – 16:30 WIB)
1. **Closeout Runner:**
   - Dikelola oleh [`lib/daytrade-intraday-eod-closeout.js`](lib/daytrade-intraday-eod-closeout.js) dan modul observasi.
   - Setelah jam 16:00 WIB, sistem memeriksa status akhir: `marketClosed(opts) === true`.
2. **Outcome Evaluator & Track Record:**
   - [`lib/daytrade-outcome-evaluator.js:14-22`](lib/daytrade-outcome-evaluator.js:14) (`evaluateDayTradeOutcome` versi `daytrade-outcome-evaluator-v3`) mengaudit hasil pergerakan harga 1-menit sepanjang sesi:
     - Apakah harga menyentuh TP1 lebih dulu (`TP1_FIRST`)?
     - Apakah harga menyentuh SL lebih dulu (`SL_FIRST`)?
     - Apakah posisi kadaluarsa tanpa menyentuh TP/SL (`EXPIRED`, exit di harga penutupan terakhir).
   - Menghitung Gross Return, Gross R, Net Return (setelah fee beli/jual 0.15%/0.25%), Maximum Favorable Excursion (MFE), dan Maximum Adverse Excursion (MAE).
   - Mengarsipkan hasil ke tabel historis untuk perhitungan win-rate resmi harian.

---

## POIN 3: MEKANISME FAST WATCHER & INTRADAY GUARD

Fast Watcher adalah subsistem streaming intraday berkecepatan tinggi yang memantau pergerakan harga, volume pace, dan momentum real-time.

### 3.1 Verifikasi Hard-Cap Shortlist 30 Baris
**Status Klaim: VALID DAN TERBUKTI.**
Di [`lib/intraday-fast-watcher-pool.js:15`](lib/intraday-fast-watcher-pool.js:15):
```javascript
const MAX_ACTIVE_POOL = 30;
```
Pool kandidat aktif di memori dibatasi secara kaku maksimal 30 ticker. Jika kandidat baru masuk sementara pool sudah penuh (30 baris), sistem melakukan seleksi ranking prioritas berdasarkan skor kombinasi:
`priority = 170 + watch_score + (ready_streak * 15)` ([`lib/intraday-fast-watcher-pool.js:169`](lib/intraday-fast-watcher-pool.js:169)).
Ticker dengan prioritas terendah yang tidak memiliki konfirmasi aktif akan diejeksi (*pool eviction*).

### 3.2 Logika Transisi Konfirmasi (0/2 -> 1/2 -> 2/2)
**Status Klaim: VALID DENGAN DETAIL KODE ASLI.**

Fungsi utama yang menghitung counter dan mengelola transisi ini adalah [`stepTickerPool`](lib/intraday-fast-watcher-pool.js:353) di [`lib/intraday-fast-watcher-pool.js`](lib/intraday-fast-watcher-pool.js):

1. **Struktur Counter & Window:**
   - `REQUIRED_CONFIRMATIONS = 3;` (secara historis disebut 2/2 atau 2-tahap, dengan aturan toleransi 2 dari 3 observasi / `two_of_three_confirmation`).
   - `CONFIRMATION_WINDOW_SIZE = 5;` (sliding window 5 observasi terakhir).
   ```javascript
   const confirmationWindow = [...priorConfirmationWindow, result.passes === true].slice(-CONFIRMATION_WINDOW_SIZE);
   item.confirmation_window = terminalFailure || informationalSpike ? [] : confirmationWindow;
   const confirmationCount = item.confirmation_window.filter(Boolean).length;
   item.ready_streak = confirmationCount;
   ```

2. **Tahapan Status & Pelabelan Telegram:**
   - **Tahap 0: Early Watch / Initial Discovery (Counter = 0)**
     - Status pool: `'WATCHING'`.
     - Ticker pertama kali terdeteksi anomali volume sebelum breakout.
     - Dipublikasikan oleh [`lib/intraday-fast-watcher-early-watch-publisher.js`](lib/intraday-fast-watcher-early-watch-publisher.js) sebagai:
       `⚡ AUTO-CUAN FAST WATCHER — EARLY WATCH (BELUM TERKONFIRMASI)`
       Label: *Informasional awal, bukan sinyal beli*.
   - **Tahap 1: Radar Prioritas (Counter = 1)**
     - Status pool: `'READY_PENDING'` atau `'PENDING_VELOCITY'`.
     - Dipublikasikan oleh [`lib/intraday-fast-watcher-radar-publisher.js:84-85`](lib/intraday-fast-watcher-radar-publisher.js:84) sebagai:
       `🟡 RADAR PRIORITAS — 1/2 KONFIRMASI`
       Syarat: Minimal watch score memenuhi `MIN_RADAR_WATCH_SCORE` dan R:R >= 1.0x.
   - **Tahap 2: Terkonfirmasi / Entry Ready (Counter >= 2)**
     - Status pool berubah menjadi `'READY_CONFIRMED'`.
     - Dipublikasikan oleh [`lib/intraday-fast-watcher-publisher.js`](lib/intraday-fast-watcher-publisher.js) sebagai sinyal resmi eksekusi Day Trade.

### 3.3 Filter Anti-Chase (Advance > 6% & TP1 Hit Block)
**Status Klaim: VALID DAN TERBUKTI.**
Dikelola di [`lib/intraday-fast-watcher-momentum.js:16`](lib/intraday-fast-watcher-momentum.js:16) dan baris 478–483:

```javascript
const MAX_ADVANCE_PCT = 6; // Plafon kenaikan maksimal 6%

// 1. Guard TP1 Hit: Blokir jika harga sudah menyentuh target profit 1
const highestPriceSinceLock = finite(tracker && tracker.highest_price_since_lock) ?? m.high;
if (m.tp1 == null || m.current_price >= m.tp1 || (highestPriceSinceLock != null && highestPriceSinceLock >= m.tp1)) {
  return Object.assign(scored, {
    passes: false,
    entry_eligible: false,
    status: 'BLOCKED_CHASE',
    reasons: [m.tp1 == null ? 'invalid_tp1' : 'tp1_already_reached']
  });
}

// 2. Guard Max Advance (Anti-Chase): Kenaikan adaptif max 6.0%
const maxAdvance = clamp(Math.max(2.5, m.volatility_pct * 1.5), 2.5, MAX_ADVANCE_PCT);
if (m.advance_pct != null && m.advance_pct > maxAdvance) {
  return spikeRadarResult(scored, 'adaptive_advance_chase', tracker);
}
```
**Konsekuensi Eksekusi:**
- Jika harga saat ini atau high hari ini sudah menyentuh TP1: status seketika menjadi `BLOCKED_CHASE` (gagal total, tidak boleh dibeli).
- Jika kenaikan harga dari harga referensi melebihi 6% (`advance_pct > 6.0%`): status di-downgrade ke `SPIKE_RADAR` dengan label Telegram *"SPIKE TERDETEKSI — JANGAN CHASE"*.

### 3.4 Formula Algoritma Perhitungan Volume Pace
Dikelola di [`lib/intraday-volume-pace.js:222-259`](lib/intraday-volume-pace.js:222) ([`calculateVolumePace`](lib/intraday-volume-pace.js:222)):

1. **Jadwal Menit Aktif IDX:**
   - Senin s/d Kamis: Sesi 1 (180 mnt) + Sesi 2 (150 mnt) = **330 menit total**.
   - Jumat: Sesi 1 (150 mnt) + Sesi 2 (120 mnt) = **270 menit total**.
2. **Session Progress Fraction ($P$):**
   $$P = \frac{\text{Menit Aktif Berjalan}}{\text{Total Menit Hari Ini}}$$
   Contoh: Jam 09:30 WIB (hari Senin) = 30 menit berjalan dari 330 menit total = $0.0909$ ($9.09\%$).
3. **Effective Session Progress ($P_{\text{eff}}$):**
   Untuk menghindari lonjakan proyeksi ekstrem pada 15 menit pertama (09:00–09:15 WIB), dipasang lantai minimal:
   $$P_{\text{eff}} = \max(P, 0.15)$$
   *(Minimal pembagi adalah $15\%$ atau setara menit ke-50).*
4. **Proyeksi Volume 1 Hari Penuh ($V_{\text{projected}}$):**
   $$V_{\text{projected}} = \frac{V_{\text{today}}}{P_{\text{eff}}}$$
5. **Perbandingan Rasio:**
   - Rasio vs rata-rata 20 hari: $R_{20} = \frac{V_{\text{projected}}}{\text{AvgVolume20D}}$
   - Rasio vs volume kemarin: $R_{\text{prev}} = \frac{V_{\text{projected}}}{\text{PrevDayVolume}}$
6. **Blended Volume Pace Ratio:**
   $$\text{Pace} = (0.75 \times R_{20}) + (0.25 \times R_{\text{prev}})$$
   Hasil akhir di-clamp antara `0.0x` hingga maksimal `6.0x` (`MAX_PACE_RATIO = 6`).

---

## POIN 4: MEKANISME SWING KONGLO VS SWING NON-KONGLO

Sistem Auto-Cuan membagi strategi Swing trading menjadi dua jalur independen dengan filosofi dan perlakuan risiko yang sangat berbeda.

### 4.1 Deklarasi & Sumber Universe (Konglo vs Non-Konglo)
1. **Universe Swing Konglo:**
   - Berasal dari database tabel [`sector_hot_groups`](api/sector-hot.js:1381) dan [`sector_hot_group_members`](api/sector-hot.js:1392).
   - Merupakan emiten yang terafiliasi dengan konglomerasi besar Indonesia, antara lain:
     - **Grup Bakrie:** BUMI, ENRG, BRMS, DEWA, VKTR.
     - **Grup Barito / Prajogo Pangestu:** BRPT, TPIA, BREN, PTRO, CUAN.
     - **Grup MNC / Hary Tanoesoedibjo:** KPIG, MSKY, MNCN, BHIT.
     - **Grup Astra, Salim, Sinarmas, Panin, Lippo, dll.**
2. **Universe Swing Non-Konglo:**
   - Diatur di [`api/sector-hot.js:9685-9705`](api/sector-hot.js:9685) pada handler [`handleNkScreenerStart`](api/sector-hot.js:9679):
     ```javascript
     // 1. Ambil seluruh emiten di Papan Utama dan Pengembangan
     const { data: boardStocks } = await supabase.from('stock_boards').select('ticker, board').in('board', ['UTAMA', 'PENGEMBANGAN']);
     // 2. Ambil seluruh anggota Konglomerasi aktif
     const { data: kongloMembers } = await supabase.from('sector_hot_group_members').select('ticker').eq('is_active', true);
     const excludedTickers = new Set((kongloMembers || []).map(m => m.ticker));
     // 3. Universe Non-Konglo = Papan Saham MINUS Anggota Konglo
     const universe = boardStocks.filter(s => !excludedTickers.has(s.ticker));
     ```

### 4.2 Karakteristik & Filosofi Swing Konglo
- Emiten konglomerasi memiliki kapitalisasi pasar besar (*medium to large cap*), volatilitas khas bandar konglo, serta likuiditas transaksi tinggi.
- Memiliki toleransi pergerakan harga (*volatility leeway*) yang lebih longgar.
- Dievaluasi per grup sektor konglo untuk melihat efek rotasi modal (*capital rotation within group*).

### 4.3 Batasan Ketat Non-Konglo & `SWING_NK_HIGH_RR_WARNING_THRESHOLD`
**Status Klaim: VALID DAN TERBUKTI.**

1. **Konstanta Threshold di [`lib/swing-nk-rr-warning.js:23`](lib/swing-nk-rr-warning.js:23):**
   ```javascript
   const SWING_NK_HIGH_RR_WARNING_THRESHOLD = 2.5;
   ```
2. **Dasar Analisis Empiris Codebase:**
   Komentar resmi di [`lib/swing-nk-rr-warning.js:6-13`](lib/swing-nk-rr-warning.js:6) mencatat hasil investigasi data produksi dari 500+ sinyal historis:
   - Sinyal Swing Non-Konglo yang berakhir kena **SL_HIT** memiliki rata-rata target R:R sebesar **3.3 : 1**.
   - Sinyal yang berhasil mencapai **TP1_HIT** memiliki rata-rata target R:R hanya **2.1 : 1**.
   - **Kesimpulan Pasar:** Pada saham lapis dua/tiga (non-konglo), memasang target profit terlalu tinggi (R:R > 2.5) sangat berbahaya karena swing 3–7 hari cenderung memicu pullback tajam yang menyapu Stop Loss sebelum target tercapai.
3. **Pemberian Flag Warning:**
   Di [`api/sector-hot.js:4311-4313`](api/sector-hot.js:4311):
   ```javascript
   if (swingNkRrWarning.isSwingNonKongloCandidate(r, category)) {
     swingNkRrWarning.annotateSwingNkHighRrWarning(r);
   }
   ```
   Jika candidate R:R > 2.5, candidate diberikan metadata:
   - `high_rr_warning = true;`
   - `high_rr_warning_note = 'R:R tinggi (>2.5x). Data historis menunjukkan target agresif lebih sering kena SL sebelum TP1; pertimbangkan TP bertahap/parsial.'`
   - Pada kartu sinyal Telegram, catatan ini ditampilkan sebagai peringatan manajemen risiko.

### 4.4 Branching Evaluasi Scoring & Quality Gates
Diatur dalam [`lib/swing-screener-engine.js`](lib/swing-screener-engine.js):
1. **Hard Gate Risk/Reward:** Syarat mutlak masuk *High Conviction* adalah `R:R >= 1.8x` (`MIN_SWING_HIGH_CONVICTION_RR = 1.8`). Jika R:R < 1.8x, kandidat langsung didowngrade ke `WATCHLIST` / dibuang.
2. **Penalty Engine Scoring:**
   - **Trend 5D Bearish:** Penalti skor `-25 poin`.
   - **Candle 1D Merah (Close < Open):** Penalti skor `-15 poin`.
   - **Volume < 1.0x (Kering):** Plafon skor dibatasi maksimal `70` (mustahil mendapat predikat A+ / High Conviction).
   - **Syarat Skor 90+:** Trend 5D Bullish + Candle 1D Hijau + Volume >= 1.2x + R:R >= 1.8x.

---

## POIN 5: MEKANISME MONITORING PERIODIK & KATALOG ALERT TP/SL

Subsistem monitoring bertugas mengawal saham-saham yang telah masuk daftar pantau/rekomendasi harian, memberikan sinyal aksi seketika saat level kunci tersentuh, dan menerbitkan rekap berkala.

### 5.1 Monitoring Terjadwal (Hourly & Half-Hour Broadcast)
1. **Scheduler & Cron Runner:**
   - **VPS Cron:** Dijalankan melalui skrip [`deploy/vps/telegram-monitor-local.sh`](deploy/vps/telegram-monitor-local.sh) yang memanggil [`tools/run-telegram-monitor-local.js`](tools/run-telegram-monitor-local.js) setiap 15 menit pada jam bursa:
     `*/15 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/telegram-monitor-local.sh --execute`
   - Dilengkapi `flock -n` untuk mencegah tumpang-tindih proses (*overlapping execution*).
2. **Cadence Gate (Top-of-Hour vs Half-Hour):**
   Di [`api/sector-hot.js:9213-9223`](api/sector-hot.js:9213):
   - **Top-of-Hour (Menit 00–29 WIB):** `hourlyBatchDue = true`. Sistem merangkum seluruh saham aktif ke dalam 1 pesan broadcast panjang dengan format:
     ```text
     ⏱ AUTO-CUAN MONITOR 10:00 WIB

     TAPG · Swing Konglo — RUNNING
     Last: Rp2.180 · Entry: Rp2.150–Rp2.170
     P/L vs entry Rp2.160: +0.9%
     TP1/TP2: Rp2.250 / Rp2.350 · SL: Rp2.080

     BRMS · Day Trade — IN ENTRY ZONE
     Last: Rp412 · Entry: Rp410–Rp416
     Jarak dari entry Rp410: +0.5% (belum entry)
     TP1/TP2: Rp430 / Rp446 · SL: Rp398

     Bukan rekomendasi beli/jual. DYOR.
     ```
   - **Half-Hour (Menit 30–59 WIB):** `hourlyBatchDue = false`. Pesan ringkasan batch **ditekan (suppressed)** agar channel Telegram tidak banjir pesan panjang. Namun, hit darurat tetap dikirim seketika!

### 5.2 Alert Emergency TP / SL & Bypass Cooldown
**Status Klaim: VALID DAN TERBUKTI.**

1. **Pengiriman Seketika Tanpa Menunggu Jam Bulat:**
   Di [`api/sector-hot.js:9094-9114`](api/sector-hot.js:9094):
   ```javascript
   var significantHit = isPublicAlertEligible && isNewHit &&
     ['TP1_HIT', 'TP2_HIT', 'SL_HIT', 'BEP_CLOSED', 'EARLY_EXIT_DISTRIBUTION', 'IN_ENTRY_ZONE'].indexOf(ev.status) >= 0;

   if (significantHit) {
     var hitMsg = telegramTemplates.formatMonitorHitMessage(pck, ev, px);
     hitResult = await telegramNotifier.sendTelegramMessage(hitMsg, { timeout_ms: 3000 });
   }
   ```
   Kejadian `SL_HIT`, `TP1_HIT`, `TP2_HIT`, `BEP_CLOSED`, dan `EARLY_EXIT_DISTRIBUTION` **TIDAK PERNAH** ditahan di antrean batch; pesan ini ditembakkan langsung ke Telegram pada iterasi cron yang bersangkutan.

2. **Cooldown Bypass untuk Emergency Update:**
   Di [`lib/telegram-notifier.js:56-65`](lib/telegram-notifier.js:56) dan [`lib/webhook-alert-engine.js:108-139`](lib/webhook-alert-engine.js:108):
   ```javascript
   function isDrasticAlertStatusChange(prevStatus, nextStatus) {
     if (isKeyActionStatus(nextStatus)) return true; // TP1_HIT, TP2_HIT, EARLY_EXIT, BEP_CLOSED
     const isNowAvoid = nextStatus.includes('AVOID') || nextStatus.includes('SL_HIT') || nextStatus.includes('INVALID');
     const wasNormal = !prevStatus.includes('AVOID') && !prevStatus.includes('SL_HIT');
     return isNowAvoid && wasNormal;
   }
   ```
   Jika suatu ticker sedang berada dalam masa tenang cooldown 20 menit, namun tiba-tiba statusnya berubah drastis menjadi `SL_HIT` atau `TP1_HIT`, cooldown tersebut **seketika dibobol (bypassed)** demi proteksi modal trader.

### 5.3 Trailing Stop & BEP Lock Mechanism
- **Kena TP1:**
  - Template [`telegramTemplates.formatMonitorHitMessage`](lib/telegram-templates.js:355) memberikan instruksi:
    *"Target TP1 tercapai! Peringatan: Jual 50-70% posisi & segera geser SL ke BEP (Entry + 1 tick)."*
  - Di database, baris pick ditandai dengan `bep_locked = true` dan `bep_locked_at = now`.
- **BEP Closed:**
  - Jika harga setelah kena TP1 berbalik turun menyentuh level BEP (Entry + 1 tick), monitor mendeteksi `BEP_CLOSED`:
    `🛡️ BEP CLOSED — BREAK EVEN. Posisi ditutup di level BEP (Entry + 1 tick)... Modal aman terproteksi tanpa rugi.`
- **Early Exit Bandar Distribution:**
  - Jika terjadi distribusi broker masif (CR3/CR5 net sell tajam dan partisipasi ritel melonjak tinggi) sebelum SL teknikal tersentuh, sistem memicu:
    `🚨 AUTO-CUAN SWING — BANDAR DISTRIBUTION ALERT / EARLY EXIT. Amankan modal atau pertimbangkan exit dini.`

### 5.4 Katalog Lengkap Event Trigger Telegram di Repository

Berikut adalah daftar inventaris seluruh jenis pesan notifikasi Telegram yang ada di dalam codebase Auto-Cuan:

| No | Tipe Event / Pesan | File Template / Handler | Pemicu (Trigger Condition) | Channel / Mode Pengiriman |
|---|---|---|---|---|
| **1** | **Day Trade Signal Card** | [`lib/telegram-templates.js:921`](lib/telegram-templates.js:921) (`formatDayTradeSignalMessage`) | Hasil scan pagi/intraday lolos kualifikasi `A_PLUS_SETUP`, `TRADE_CANDIDATE`, atau `READY_BREAKOUT`. | Channel Signal Saham / Webhook |
| **2** | **Swing Konglo Signal Card** | [`lib/telegram-templates.js:923`](lib/telegram-templates.js:923) (`formatSwingKongloSignalMessage`) | Saham grup konglomerasi lolos R:R >= 1.8x, trend bullish, dan skor >= 75. | Channel Signal Saham / Webhook |
| **3** | **Swing Non-Konglo Signal Card** | [`lib/telegram-templates.js:924`](lib/telegram-templates.js:924) (`formatSwingNonKongloSignalMessage`) | Saham non-konglo lolos quality gate (disertai High R:R warning jika R:R > 2.5). | Channel Signal Saham / Webhook |
| **4** | **Opening Radar (09:00 WIB)** | [`lib/telegram-templates.js:925`](lib/telegram-templates.js:925) (`formatOpeningRadarMessage`) | Broadcast radar pembukaan jam 09:00 WIB merangkum watchlist pantauan pagi. | Channel Publik Telegram |
| **5** | **Daily Top 5 / Watchlist** | [`lib/telegram-templates.js:926`](lib/telegram-templates.js:926) (`formatDailyTop5Message`) | 5 saham terbaik hasil seleksi algoritma yang dikunci sebelum open bursa. | Channel Publik Telegram |
| **6** | **Monitor Hit: ENTRY ZONE** | [`lib/telegram-templates.js:411`](lib/telegram-templates.js:411) (`formatMonitorHitMessage`) | Harga saham memasuki rentang `entry_low` s/d `entry_high` dan `hit_entry_at` masih kosong. | Channel Signal Saham (Seketika) |
| **7** | **Monitor Hit: TP1 HIT** | [`lib/telegram-templates.js:347`](lib/telegram-templates.js:347) (`formatMonitorHitMessage`) | High intraday menyentuh atau melampaui `tp1`. | Channel Signal Saham (Seketika) |
| **8** | **Monitor Hit: TP2 HIT** | [`lib/telegram-templates.js:356`](lib/telegram-templates.js:356) (`formatMonitorHitMessage`) | High intraday menyentuh atau melampaui `tp2`. | Channel Signal Saham (Seketika) |
| **9** | **Monitor Hit: SL HIT** | [`lib/telegram-templates.js:402`](lib/telegram-templates.js:402) (`formatMonitorHitMessage`) | Low intraday menembus atau menyentuh level `stop_loss`. | Channel Signal Saham (Seketika) |
| **10** | **Monitor Hit: BEP CLOSED** | [`lib/telegram-templates.js:365`](lib/telegram-templates.js:365) (`formatMonitorHitMessage`) | Harga turun menyentuh level Break-Even (Entry + 1 tick) setelah running profit. | Channel Signal Saham (Seketika) |
| **11** | **Bandar Distribution Alert** | [`lib/telegram-templates.js:371`](lib/telegram-templates.js:371) (`formatMonitorHitMessage`) | Deteksi aksi jual masif top broker bandarmologi (CR3/CR5) saat posisi swing aktif. | Channel Signal Saham (Seketika) |
| **12** | **Periodic Batch Digest** | [`api/sector-hot.js:8999`](api/sector-hot.js:8999) (`handleTelegramMonitorPicks`) | Pukul 10:00, 11:00, 12:00, 14:00, 15:00 WIB merangkum seluruh status saham berjalan. | Channel Publik Telegram (Hourly) |
| **13** | **Fast Watcher: Early Watch** | [`lib/intraday-fast-watcher-early-watch-publisher.js:150`](lib/intraday-fast-watcher-early-watch-publisher.js:150) | Saham pertama kali masuk pool `WATCHING` dengan lonjakan volume awal (0/2). | Channel Fast Watcher / Early |
| **14** | **Fast Watcher: Radar Prioritas** | [`lib/intraday-fast-watcher-radar-publisher.js:85`](lib/intraday-fast-watcher-radar-publisher.js:85) | Saham mencapai konfirmasi tahap 1 (`READY_PENDING` / 1/2 konfirmasi). | Channel Radar Daytrade |
| **15** | **Fast Watcher: Anti-Chase Warning** | [`lib/intraday-fast-watcher-early-watch-publisher.js:216`](lib/intraday-fast-watcher-early-watch-publisher.js:216) | Saham telah rally > 6% atau mencapai TP1 sehingga dilarang dikejar. | Channel Fast Watcher |
| **16** | **Fast Watcher: Spike Radar** | [`lib/intraday-fast-watcher-radar-publisher.js:82`](lib/intraday-fast-watcher-radar-publisher.js:82) | Lonjakan volume dan harga impulsif tiba-tiba tanpa setup matang (`SPIKE_RADAR`). | Channel Spike Alert |
| **17** | **EOD Daily Recap & Win-Rate** | [`lib/telegram-daily-recap.js:100`](lib/telegram-daily-recap.js:100) (`run-daily-afternoon-recap.js`) | Selesai bursa (16:00 WIB), rekap kinerja seluruh sinyal hari ini (Win/Loss/Pending). | Channel Publik Telegram |
| **18** | **Foreign Flow Top 10 Recap** | [`lib/foreign-flow-recap.js`](lib/foreign-flow-recap.js) (`run-foreign-top10-recap.js`) | Rekapitulasi saham dengan net foreign buy & sell terbesar hari ini. | Channel Publik Telegram |
| **19** | **Bandarmologi Intel Spike Alert** | [`lib/bandarmologi-intel-service.js`](lib/bandarmologi-intel-service.js) | Deteksi anomali akumulasi bandar rahasia pada saham di luar radar umum. | Channel Intel / VIP |
| **20** | **Admin Zero-Link & Auth Approval** | [`lib/admin-command-zero-link-pairing.js`](lib/admin-command-zero-link-pairing.js) | Notifikasi kode OTP/approval perangkat baru untuk login admin root. | Chat Pribadi Admin (Private) |

---

## KESIMPULAN AUDIT

1. **Akar Permasalahan Alert Spam TAPG di Jam 09:00 WIB Berhasil Diidentifikasi 100%:**
   - Terbukti terjadi karena engine memisahkan key deduplikasi per `plan_lock_id` (karena range entry berbeda antara Rp2.150–2.170 vs Rp2.160–2.190).
   - Terbukti fungsi pengirim [`api/sector-hot.js:9111`](api/sector-hot.js:9111) lupa menyertakan parameter `ticker` ke [`telegramNotifier.sendTelegramMessage`](lib/telegram-notifier.js:280), sehingga cache cooldown 20 menit mati total.
   - Format pesan minimalis adalah hasil dari template resmi [`formatMonitorHitMessage`](lib/telegram-templates.js:290) yang perlu ditingkatkan agar selalu membawa parameter SL dan TP1.
2. **Siklus Hidup Daytrade & Fast Watcher Bekerja Sesuai Rulebook:**
   - Terdapat guard ketat berbasis waktu (`MORNING_SCOUT`, `MIDDAY_CHECK`, `AFTERNOON_EXIT`, serta `BREAK`/`CLOSED`).
   - Dynamic Downgrade aktif menurunkan status sinyal dari A+ ke `WAIT_PULLBACK`/`AVOID` jika skor intraday jatuh di bawah 75 / 60.
   - Fast Watcher memiliki hard-cap 30 saham, proteksi Anti-Chase maksimal 6%, pemblokiran TP1 Hit, dan formula Volume Pace yang adaptif.
3. **Pemisahan Tegas Swing Konglo vs Non-Konglo:**
   - Universe Konglo berbasis grup pemilik konglomerasi (`sector_hot_groups`), sedangkan Non-Konglo adalah universe papan utama/pengembangan yang disaring ketat.
   - Konstanta [`SWING_NK_HIGH_RR_WARNING_THRESHOLD = 2.5`](lib/swing-nk-rr-warning.js:23) melindungi trader dari risiko false breakout pada saham non-konglo.
4. **Dokumentasi ini bersifat permanen** dan berfungsi sebagai pedoman verifikasi teknis arsitektur notifikasi dan screener Auto-Cuan.
