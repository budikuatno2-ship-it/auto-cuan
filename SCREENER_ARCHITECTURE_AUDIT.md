# SCREENER_ARCHITECTURE_AUDIT.md

**Batch 0/20 — Audit Arsitektur & Logika Penilaian Seluruh Screener**
**Branch kerja:** `feat/daytrade-screener-v1`
**HEAD commit baseline:** `240c0fc` (identik di lokal dan VPS Oracle Cloud `ubuntu@168.110.221.197`)
**Status:** **FINAL AUDIT**
**Tanggal:** 2026-09-17 (WIB)

> **Catatan Kepatuhan:** Dokumen ini MURNI audit & dokumentasi arsitektur berdasarkan pembacaan kode baris-per-baris dan verifikasi data produksi riil di VPS. Tidak ada perubahan logika produksi pada Batch 0.

---

## 0. RINGKASAN EKSEKUTIF TEMUAN AUDIT

Berdasarkan audit komprehensif terhadap seluruh file di `lib/`, `api/`, `tools/`, `deploy/`, serta investigasi langsung ke VPS Oracle (`ubuntu@168.110.221.197`) dan database Supabase produksi:

| ID | Kategori | Temuan Utama | Lokasi Kode / Bukti Riil | Dampak pada Sistem |
|---|---|---|---|---|
| **F1** | **Dead Market Gate** | Fungsi pengaman `isMarketSessionClosed` dan `getMarketSessionStatus` HANYA dipasang di `sendAlert` (`lib/webhook-alert-engine.js:507`). Namun, `sendAlert` **tidak pernah dipanggil** oleh jalur broadcast Telegram produksi mana pun (0 call-site aktif). | [`lib/webhook-alert-engine.js:553`](lib/webhook-alert-engine.js:553) vs [`lib/telegram-notifier.js:78`](lib/telegram-notifier.js:78) | Market session guard menjadi *dead code*; jalur broadcast nyata tidak terlindungi sama sekali. |
| **F2** | **Unprotected Real Broadcast** | Pengiriman Telegram sesungguhnya di produksi menggunakan `telegramNotifier.sendTelegramMessage` (`lib/telegram-notifier.js:78`) yang sama sekali **tidak memiliki validasi jam sesi bursa**. | [`lib/telegram-notifier.js:78-158`](lib/telegram-notifier.js:78) | Sinyal dapat ditembakkan pada jam berapa pun (termasuk tengah malam / akhir pekan / jam istirahat bursa). |
| **F3** | **VPS Cron & Runner Permissive Window (Akar Insiden 12:45 WIB)** | Script runner VPS `tools/run-telegram-monitor-local.js` memiliki fungsi `isMarketSessionWib` independen dengan jendela **09:05–16:05 WIB tanpa jeda istirahat siang** (12:00–13:30 WIB dianggap `active: true`). Cron crontab VPS `*/15 9-16 * * 1-5 telegram-monitor-local.sh --execute` mengeksekusi runner ini persis pada pukul 12:45 WIB. | [`tools/run-telegram-monitor-local.js:48-57`](tools/run-telegram-monitor-local.js:48), crontab live VPS | Pada pukul 12:45 WIB, runner menganggap bursa aktif dan langsung menyiarkan kandidat ke Telegram. |
| **F4** | **Cron Midday Evaluation di Jam Istirahat** | Crontab VPS memiliki jadwal `5 12 * * 1-5 swing-konglo.sh` (12:05 WIB) dan `20 12 * * 1-5 swing-nonkonglo.sh` (12:20 WIB) untuk mengevaluasi closing sesi 1. Hasil evaluasi langsung disimpan ke Supabase di jam istirahat. | Crontab live VPS, `swing-konglo-cron.log` | Data baru masuk tabel `swing_screener_latest` saat istirahat, lalu disambar cron 12:45 WIB. |
| **F5** | **Inkonsistensi Sumber Kebenaran Sesi Bursa** | Terdapat minimal 3 definisi jam kerja berbeda di repo: (1) `getMarketSessionStatus` (09:00–12:00 & 13:30–16:00, Jumat 11:30 & 14:00); (2) `isMarketSessionWib` (09:05–16:05 flat); (3) `getRunMode` (09:00–10:30, 10:30–13:30, 13:30–16:00). | [`lib/daytrade-screener-engine.js:120,150`](lib/daytrade-screener-engine.js:120), [`tools/run-telegram-monitor-local.js:48`](tools/run-telegram-monitor-local.js:48) | Celah bypass antar modul karena tidak ada satu modul acuan terpusat. |
| **F6** | **Pintasan Digest Fallback pada Swing Konglo / Non-Konglo** | Pada `sendSwingKongloTelegramNotification` (`api/sector-hot.js:14280`), jika `strictCandidates` kosong, sistem beralih ke `digestCandidates` yang melewati `verifyHighConvictionTelegramSignal`. Selain itu, Tier 2 mengizinkan R/R 1.3x dan fallback final mengizinkan kandidat apa pun yang lolos digest gate. | [`api/sector-hot.js:14283-14330`](api/sector-hot.js:14283) | Kandidat dengan R/R rendah (seperti SSMS R/R 1.0x atau IMJS R/R 1.27x) dapat lolos ke siaran Telegram publik. |
| **F7** | **Query Tabel Tanpa Filter Tanggal/Run** | `sendSwingKongloTelegramNotification` mengambil 40 baris teratas dengan `SELECT * FROM swing_screener_latest ORDER BY score DESC LIMIT 40` tanpa filter `run_date` atau status run saat ini. | [`api/sector-hot.js:14247`](api/sector-hot.js:14247) | Sinyal lama/stale yang belum ter-overwrite dapat tersiar kembali sebagai sinyal baru. |
| **F8** | **Kode Basi di RAM Proses Node VPS** | Proses `tools/ai-eval-once-supervisor.js` (PID 1801024) dan `tools/vps-api-server.js` (PID 1883477) aktif sejak 11 & 14 September 2026 tanpa pernah direstart pasca git pull. | `ps -eo pid,lstart,cmd` di VPS | Perbaikan file di disk tidak pernah dieksekusi di memori runtime sampai restart manual dilakukan. |

---

## 1. PENGECEKAN PRIOR ART (Commit `d82fbd1`)

Pemeriksaan commit `d82fbd1` (*feat: batch 5 production hardening, zombie purge, market gate, anti-spam throttling, vps daemon resilience*):

### 1.1 Status Fungsi `getMarketSessionStatus()`
- **Lokasi file:** [`lib/daytrade-screener-engine.js:150-168`](lib/daytrade-screener-engine.js:150)
- **Status di kode saat ini:** **MASIH ADA**.
- **Logika fungsi:** Mendukung jadwal IDX lengkap dan peka hari (day-of-week aware):
  - Senin–Kamis: Sesi 1 (09:00–12:00 / menit 540–720), Istirahat (12:00–13:30 / menit 720–810), Sesi 2 (13:30–16:00 / menit 810–960).
  - Jumat: Sesi 1 (09:00–11:30 / menit 540–690), Istirahat (11:30–14:00 / menit 690–840), Sesi 2 (14:00–16:00 / menit 840–960).
  - Akhir Pekan (Sabtu/Minggu): `session: 'CLOSED'`.
- **Kondisi pemanggilan:**
  1. Dipanggil di `lib/daytrade-screener-engine.js:1776` (`runDayTradeBatch`).
  2. Dipanggil di `lib/webhook-alert-engine.js:511` (`isMarketSessionClosed`).
  3. **TIDAK DIPANGGIL** di `lib/telegram-notifier.js`, `api/sector-hot.js` (jalur broadcast Telegram Swing Konglo/Non-Konglo), maupun `tools/run-telegram-monitor-local.js`.

### 1.2 Status Fungsi `candidatePassesPublicTelegramSafetyGate()`
- **Lokasi file:** [`api/sector-hot.js:4627-4835`](api/sector-hot.js:4627)
- **Status di kode saat ini:** **MASIH ADA & AKTIF DIPANGGIL**.
- **Titik pemanggilan aktif:**
  - `api/sector-hot.js:4540` (diagnostic mode)
  - `api/sector-hot.js:5309` (mode telegram)
  - `api/sector-hot.js:6388, 6416, 6421` (mode daily_top5)
  - `api/sector-hot.js:12772` (mode daytrade)
  - `api/sector-hot.js:14288` (mode swing_konglo)
  - `api/sector-hot.js:14490` (mode swing_non_konglo)
- **Logika proteksi yang aktif:**
  - *Zombie Purge:* Menolak kandidat jika `last_price < stop_loss` (`api/sector-hot.js:4640`).
  - *Anomali Jarak Entry:* Menolak jika jarak harga terhadap batas atas entry > 10% (`api/sector-hot.js:4646`).
  - *Auto Reject / ARA-ARB Guard:* Menolak jika near ARA/ARB (`api/sector-hot.js:4686-4700`).
  - *Breakout Failure Guard:* Menolak jika false breakout risk (`api/sector-hot.js:4703-4731`).
  - *Corporate Action Guard & Data Quality Eligibility:* Menolak data quality berisiko (`api/sector-hot.js:4739`).

### 1.3 Kesimpulan Eksplisit Prior Art
Guard lama dari commit `d82fbd1` berada pada kategori **(c) ADA TETAPI LOGIKANYA BOCOR / TIDAK CUKUP**:
- `candidatePassesPublicTelegramSafetyGate` menjalankan tugas zombie purge dan filter ARA/ARB dengan baik, tetapi **tidak memverifikasi jam buka bursa** dan **tidak memeriksa rasio Risk/Reward minimal**.
- `getMarketSessionStatus` sudah memiliki logika jam bursa yang sangat presisi, tetapi **terisolasi di `daytrade-screener-engine.js` dan `webhook-alert-engine.js:sendAlert`** yang tidak dilalui oleh alur cron dan notifier Telegram aktual.
- **Kesimpulan untuk Batch 2–11:** Batch perbaikan berikutnya **tidak perlu membuat logika jam bursa dari nol**, melainkan mengkonsolidasikan dan **menyambungkan ulang (reconnect)** guard jam bursa terpusat ke seluruh titik broadcast Telegram serta menyaring rasio Risk/Reward di pintu gerbang klasifikasi.

---

## 2. AUDIT RINCI SETIAP SCREENER

### 2.1 DAY TRADE SCREENER & FAST WATCHER

#### a. Arsitektur Penilaian & Alur Data
1. **Data Ingestion:** [`lib/daytrade-screener-engine.js:189`](lib/daytrade-screener-engine.js:189) `fetchDayTradeCandles(ticker)` mengambil 90 daily candles dari Yahoo Finance (`.JK`).
2. **Feature Extraction:** [`lib/daytrade-screener-engine.js:234`](lib/daytrade-screener-engine.js:234) `analyzeDayTrade(candles, ticker)` mengekstrak indikator: MA20, MA50, RSI14, ATR14, Volume Ratio 20D, Support/Resistance, Swing Low 5D, Swing High 10D, Range Position, Distance to Breakout, Fade from High.
3. **Core Scoring Pipeline:** [`lib/daytrade-screener-engine.js:1174`](lib/daytrade-screener-engine.js:1174) `scoreDayTrade` mengevaluasi:
   - `scoreLiquidity(data)` (0–25 poin, hard fail jika value < 1M & avg7d < 500k)
   - `scorePreSpike(data)` (0–30 poin)
   - `scoreMomentum(data)` (0–25 poin)
   - `scoreRiskReward(data, levels)` (0–15 poin)
   - `scoreTrend(data)` (0–15 poin)
   - `calculatePenalty(data)` (-5 s/d -40 poin)
   - `calculateLevels(data)` (Entry Low/High, SL, TP1, TP2, R/R)
   - `refineLevelsWithRespectZones(levels, candles, lastPrice)`
4. **Classification Gate:** [`lib/daytrade-screener-engine.js:816`](lib/daytrade-screener-engine.js:816) `classifyStatus(...)` menghasilkan status: `A_PLUS_SETUP`, `TRADE_CANDIDATE`, `READY_BREAKOUT`, `PRE_SPIKE_WATCH`, `EARLY_RADAR`, `MOMENTUM_CONTINUATION`, `WAIT_PULLBACK`, `SPECULATIVE`, atau `AVOID`.
5. **Intraday Fast Watcher:** [`lib/intraday-fast-watcher.js`](lib/intraday-fast-watcher.js), [`lib/intraday-fast-watcher-radar-publisher.js`](lib/intraday-fast-watcher-radar-publisher.js) memonitor pergerakan intraday tick/volume untuk menaikkan label radar ke `RADAR PRIORITAS - 1/2 KONFIRMASI`.

#### b. Logika & Formula Penilaian
Menggunakan kombinasi **Weighted Scoring + Real Transaction Meritocracy**:
- **Fase 3 Meritokrasi Transaksi Riil (`calculateDayTradeScore:2965`):**
  `Score = BASE_SCORE(25) + VolumeSurge + OrderFlowVelocity + TechnicalPoints`
  - VolumeSurge: VR >= 2.0 -> 30; VR >= 1.5 -> 20; VR >= 1.25 -> 10; lainnya 0.
  - OrderFlowVelocity: Delta Turnover 15m >= 1 Miliar -> 15; Bid Dominance > 58% -> 10; lainnya 0.
  - TechnicalPoints: change_pct (+3 s/d +8), rsi14 (+4 s/d +8), price_above_open (+4), distance_to_breakout (+5), range_position (+5).
  - **Volume Ceiling Lock (`:2997`):** Jika VR < 1.0 atau VolumeSurge = 0, skor maksimal dibatasi pada **64** (tidak dapat mencapai ambang tradeable >= 65).

#### c. Gerbang Penyaringan (Gates)
- **Hard Liquidity Gate (`:364, 828`):** `valToday < 1B && avgVal7d < 500M` ATAU `volume_ratio_20d < 0.3` -> `pass = false` -> Status otomatis `AVOID`.
- **Hard R/R Gate (`:840`):** `levels.risk_reward < 1.5` -> Memicu hard fail `RR < 1.5`, memblokir status `A_PLUS_SETUP`, `TRADE_CANDIDATE`, dan `READY_BREAKOUT`.
- **Overheat & Gap Guard (`:851`):** `change_pct > 8.5%` -> memblokir status Breakout, dialihkan ke `WAIT_PULLBACK`.
- **Distribution Guard (`:869`):** `price < open` dengan VR >= 1.5 -> terdeteksi distribusi intraday, memblokir status Breakout.
- **Afternoon Conservative Mode (`:874`):** Jika `runMode === 'AFTERNOON_EXIT'`, seluruh status `READY` diturunkan ke `MOMENTUM_CONTINUATION` atau `WAIT_PULLBACK`.

#### d. Indikator Teknikal yang Digunakan
1. RSI (14 period)
2. Simple Moving Average (MA20, MA50)
3. Average True Range (ATR14)
4. Volume Ratio (Volume Hari Ini vs Rata-rata 20 Hari)
5. Support & Resistance Struktural (Swing Low 5D, Swing High 10D)
6. Intraday Bid/Ask Dominance & 15m Turnover Velocity
7. Volume Profile Point of Control (POC)

#### e. Rumus Matematis Konkret
- **Risk/Reward Calculation (`calculateLevels:743-747`):**
  `EntryMid = (EntryLow + EntryHigh) / 2`
  `FinalRisk = EntryMid - StopLoss`
  `Reward1 = TP1 - EntryMid`
  `RiskReward = Reward1 / FinalRisk`
- **Entry Zone Calculation (`:660-665`):**
  `EntryAnchor = Math.max(SwingLow5 || low, Math.min(open, support))`
  `EntryLow = Math.max(EntryAnchor, last - 0.7 * ATR, last * 0.98)`
  `EntryHigh = Math.min(EntryLow + 0.5 * ATR, last * 1.005, high)`
- **Stop Loss Calculation (`:675-704`):**
  `SL_swing = SwingLow5 - 0.3 * ATR`
  `SL_pct = EntryMid * 0.97`
  `StopLoss = Math.max(SL_swing, SL_pct)`
  *Batas Penyesuaian ATR:* Jika SL_dist < 0.5 * ATR -> EntryMid - 0.7 * ATR; Jika SL_dist > 2.5 * ATR -> EntryMid - 2.0 * ATR.

---

### 2.2 SWING TRADE KONGLO

#### a. Arsitektur Penilaian & Alur Data
1. **Universe Ingestion:** 177 saham konglomerasi (`universe_count: 177`).
2. **Evaluasi & Simpan DB:** Dihitung oleh `tools/run-all-screeners-vps.js` / `swing-konglo.sh` -> Disimpan ke Supabase tabel `swing_screener_latest` (175 rows tersimpan).
3. **Telegram Dispatch Flow (`api/sector-hot.js:14244`):**
   - Query: `SELECT * FROM swing_screener_latest ORDER BY score DESC LIMIT 40` (F7: tanpa filter tanggal).
   - Verifikasi 1: `verifyTelegramSignal(r, 'swing')` (`api/sector-hot.js:13717`).
   - Verifikasi 2: `verifyHighConvictionTelegramSignal(r, 'swing')` (`api/sector-hot.js:13825`) -> Memanggil `swingEngine.verifySwingHighConviction(r)` (`lib/swing-screener-engine.js:230`).
   - Filter Strict: `strictCandidates` melewati `candidatePassesPriceFreshness`, `candidatePassesMinUpside`, dan `candidatePassesPublicTelegramSafetyGate(r, 'swing_konglo')`.
   - Filter Digest (Fallback): Jika `strictCandidates` kosong, beralih ke `digestCandidates` (`candidatePassesTelegramCandidateDigestGate`).
   - Tier Selection: Tier 1 (READY, Grade A/B, R/R >= 1.5) -> Tier 2 (non-speculative, Score >= 65, R/R >= 1.3) -> Digest Fill.
   - Dispatch: `telegramDelivery.prepareCandidatesForDelivery` -> `telegramNotifier.sendTelegramMessage`.

#### b. Logika Penilaian
- **Skor Dasar DB:** Dihitung dari momentum swing, tren MA20/MA50, dan akumulasi broker.
- **Penalty Engine (`lib/swing-screener-engine.js:118`):**
  - Trend 5D Bearish: Penalti **-25 poin**.
  - Candle 1D Merah (Close < Open): Penalti **-15 poin**.
  - Volume Kering (VR < 1.0): Plafon skor maksimal **70**.
  - Meritocracy Lock 90+: Skor >= 90 wajib memenuhi: Trend Uptrend, Candle Hijau, VR >= 1.2, dan R/R >= 1.8. Jika tidak terpenuhi, skor di-cap pada **89**.
- **Telegram Conviction Score (`api/sector-hot.js:13797`):**
  `Conviction = min(40, Score * 0.4) + Bonus_RR + Bonus_Grade + Bonus_Risk + Bonus_Value + Bonus_Vol + Bonus_TF`
  - Bonus_RR: >= 2.5 -> +16; >= 2.0 -> +12; >= 1.5 -> +8; >= 1.3 -> +4.
  - Bonus_Grade: A -> +12; B -> +8; C -> +2; AVOID -> -30.
  - Notes penalti: chase, late, failed, distribusi -> -25 poin.

#### c. Gerbang Penyaringan (Gates)
| Nama Gate | Syarat Lolos | Konsekuensi Gagal |
|---|---|---|
| `verifyTelegramSignal` | R/R >= 1.3, Status != AVOID/INVALID, Risk != VERY HIGH | Di-drop dari verifikasi |
| `verifyHighConvictionTelegramSignal` | R/R >= 1.8, Status != WAIT_PULLBACK, Conviction >= 75 | Di-drop dari antrean High Conviction |
| `candidatePassesPublicTelegramSafetyGate` | Tidak kena Zombie Purge (Last >= SL), Jarak Entry <= 10%, Tidak mentok ARA/ARB | Di-drop dari daftar broadcast publik |
| `Tier 1 Gate` | Status READY, Grade A/B, R/R >= 1.5 | Dialihkan ke Tier 2 |
| `Tier 2 Gate` | Non-speculative, Score >= 65, R/R >= 1.3 | Dialihkan ke Digest Fallback |

#### d. Indikator Teknikal yang Digunakan
1. Multi-Timeframe Context (1D, 3D, 5D, 20D context)
2. MA20 & MA50
3. RSI14
4. Volume Ratio 20D (`volume_ratio_avg20`)
5. Support & Resistance Struktural
6. Fibonacci Confluence Levels (nearest fib retracement/extension)
7. Candlestick Pattern Detection (`candle-pattern-engine`)

#### e. Rumus Matematis Konkret
- **Risk/Reward Ratio:** `R/R = (TP1 - EntryHigh) / (EntryHigh - StopLoss)`
- **Fibonacci Confluence:** Menghitung jarak persentase harga terhadap level Fibonacci (0.382, 0.5, 0.618, 0.786).
- **Edge Classification (`lib/swing-screener-engine.js:175`):**
  - `BREAKOUT_RESISTANCE`: Setup breakout / harga >= 0.99 * Resistance dengan VR >= 1.2.
  - `PULLBACK_SUPPORT_MA20`: Harga dalam rentang 0.98 * MA20 s/d 1.05 * MA20 dengan RSI 45–68.
  - `BULLISH_REVERSAL`: Pola candle reversal pada support dengan RSI 30–45.

---

### 2.3 SWING TRADE NON-KONGLO

#### a. Arsitektur Penilaian & Alur Data
1. **Universe Ingestion:** Seluruh saham non-konglo IDX yang memenuhi kriteria likuiditas papan Utama & Pengembangan.
2. **Database Sinkronisasi:** Disimpan ke tabel Supabase `swing_screener_non_konglo_latest`.
3. **Telegram Dispatch Flow (`api/sector-hot.js:14467`):**
   - Menggunakan alur verifikasi yang identik dengan Swing Konglo (`sendSwingNkTelegramNotification`).
   - Filter: `verifyTelegramSignal(r, 'swing')` -> `verifyHighConvictionTelegramSignal(r, 'swing')` -> `candidatePassesPublicTelegramSafetyGate(r, 'swing_non_konglo')`.
   - Tier 1: R/R >= 1.5, Grade A/B, Score >= 75.
   - Tier 2: R/R >= 1.3, Non-speculative, Score >= 65.

---

### 2.4 TOP 5 NIGHTLY SCREENER

#### a. Arsitektur & Logika
1. **Runner:** [`tools/run-after-market-top5-lock.js`](tools/run-after-market-top5-lock.js), dipanggil oleh crontab VPS pada pukul 19:55, 20:15, 20:45, dan 21:15 WIB via `top5-night.sh`.
2. **Evaluasi:** Mengambil kandidat gabungan dari hasil EOD Day Trade, Swing Konglo, dan Swing Non-Konglo.
3. **Gate:** Melalui [`api/sector-hot.js:6388`](api/sector-hot.js:6388) `candidatePassesPublicTelegramSafetyGate(c, 'daily_top5')` dan `candidatePassesMinUpside(c)`.

---

## 3. AUDIT GERBANG TELEGRAM (TELEGRAM GATE & BROADCAST PATH)

### 3.1 Peta Jalur Eksekusi Broadcast Riil vs Dead Code

```
[KODE BASI / DEAD GATE]
webhook-alert-engine.js:sendAlert(candidate, options)
  ├── isMarketSessionClosed(options.now)  <-- HANYA AKTIF JIKA options.now DIISI
  └── checkCooldown(ticker)
  (FUNGSI INI TIDAK DIPANGGIL OLEH RUNNER PRODUKSI MANA PUN)

[JALUR NYATA PRODUKSI 1 - CRON TELEGRAM MONITOR]
deploy/vps/telegram-monitor-local.sh (*/15 9-16 * * 1-5)
  └── tools/run-telegram-monitor-local.js:main()
        ├── isMarketSessionWib()  <-- JENDELA LONGGAR: 09:05 - 16:05 WIB (NO BREAK CHECK!)
        └── sectorHot.handleTelegramMonitorPicks()
              └── telegramNotifier.sendTelegramMessage()  <-- TIDAK ADA MARKET HOURS GUARD

[JALUR NYATA PRODUKSI 2 - CRON SWING KONGLO / NON-KONGLO]
auto-cuan-runner/swing-konglo.sh (05 12 * * 1-5, 10 16 * * 1-5, 10 19 * * 1-5)
  └── run-sector-hot-local.js
        └── api/sector-hot.js:sendSwingKongloTelegramNotification()
              ├── verifyTelegramSignal()
              ├── verifyHighConvictionTelegramSignal()
              ├── candidatePassesPublicTelegramSafetyGate()
              └── telegramNotifier.sendTelegramMessage()  <-- TIDAK ADA MARKET HOURS GUARD
```

### 3.2 Analisis Evaluasi Gerbang Telegram
1. **Market Hours Guard:** Pada jalur nyata (`telegramNotifier.sendTelegramMessage`), pengecekan jam bursa bernilai **NOL** (F1, F2). Pengecekan jam bursa pada `run-telegram-monitor-local.js` bocor di jam 12:00–13:30 WIB (F3).
2. **Threshold Skor & R/R Minimal:**
   - Jalur Strict: R/R minimal 1.8x (Swing) atau 1.3x (Day Trade), Skor Conviction >= 75.
   - Jalur Digest Fallback: **Tidak ada batasan R/R 1.8x**, R/R 1.3x (Tier 2) atau tanpa R/R (top digest) dapat lolos jika strict kosong (F6).
3. **Anti-Duplikat & State Machine:**
   - Database `telegram_daily_picks` menyimpan riwayat sinyal, namun fungsi pengirim broadcast tidak memiliki state-machine memory in-memory / cache window yang menahan duplikasi alert seketika (stateless alert).

---

## 4. VERIFIKASI DATA RIIL PRODUKSI (VPS & SUPABASE)

Data diambil langsung melalui sesi SSH dan query database Supabase produksi pada tanggal 17 September 2026:

### 4.1 Sample Kandidat Nyata dari Database Produksi

#### Kasus 1: IMJS (Swing Konglo)
- **Data di `swing_screener_latest`:**
  - `status`: `Watchlist`
  - `score`: 76
  - `risk_reward`: **1.27**
  - `last_price`: 188
  - `entry_low` - `entry_high`: 182 - 186
  - `stop_loss`: 175 | `tp1`: 200
- **Penelusuran Logika:** Nilai R/R 1.27x berada di bawah hard gate 1.8x. Di tabel database tersimpan dengan skor 76. Jika jalur strict kosong, IMJS dapat terseret masuk melalui fallback digest/Tier 2 (1.27x ~ 1.3x).

#### Kasus 2: KAEF (Swing Konglo)
- **Data di `swing_screener_latest`:**
  - `status`: `Watchlist`
  - `score`: 72
  - `risk_reward`: **4.25**
  - `last_price`: 448
  - `entry_low` - `entry_high`: 442 - 448
  - `stop_loss`: 424 | `tp1`: 550
- **Penelusuran Logika:** Harga terakhir 448 persis menyentuh batas atas `entry_high` (448). Pada insiden 17 September jam 12:45 WIB, KAEF dievaluasi pada harga closing sesi 1 (446-448), masuk ke area entry, dan langsung ditembakkan sebagai `ENTRY ZONE` oleh cron 12:45 WIB karena sistem tidak memeriksa apakah bursa sedang tutup istirahat dan tidak memerlukan konfirmasi candle close.

#### Kasus 3: SSMS (Swing Non-Konglo)
- **Data di `swing_screener_non_konglo_latest` & `telegram_daily_picks`:**
  - `status`: `Wait Pullback`
  - `score`: 91
  - `risk_reward`: 2.25
  - `entry_low` - `entry_high`: 1140 - 1155
  - `last_price`: 1155 | `stop_loss`: 1095 | `tp1`: 1290
  - Tercatat di `telegram_daily_picks` pada `2026-09-17T09:27:43Z`.
- **Penelusuran Logika:** Pada data historis pagi hari (10:13 WIB), SSMS sempat berada pada harga 1080 (di atas area entry 1050-1075) dengan R/R hanya 1.0x namun tetap lolos radar prioritas karena skor teknikal dan volume tinggi tanpa filter R/R di level classifier.

#### Kasus 4: INKP & SMGR (Swing Konglo)
- **INKP:** Score 87, R/R 2.82, Last 8725, Entry 8550-8725, SL 8450, TP1 9500 -> Valid setup secara R/R, namun ditembakkan saat jam istirahat bursa (12:45 WIB) bersamaan dengan cron 12:45 WIB.
- **SMGR:** Score 80, R/R 3.67, Last 1620, Entry 1580-1620, SL 1560, TP1 1840 -> Kondisi serupa dengan INKP.

### 4.2 Status Proses & RAM VPS (Bukti Kode Basi)
Hasil eksekusi `ps -eo pid,lstart,cmd` di VPS:
- `PID 1801024`: Start `Fri Sep 11 15:27:47 2026` (`tools/ai-eval-once-supervisor.js`)
- `PID 1883477`: Start `Mon Sep 14 20:00:00 2026` (`tools/vps-api-server.js`)
- Git HEAD di disk: `240c0fc` (17 September 2026).
- **Fakta Terbukti:** Kode yang berjalan di RAM kedua proses di atas tertinggal 3 hingga 6 hari dibandingkan commit terbaru di disk.

---

## 5. SILANG PENGECEKAN (CROSS-CHECK) DENGAN 4 AKAR MASALAH

| Akar Masalah Awal | Status Verifikasi | Temuan Baru dari Audit Batch 0 |
|---|---|---|
| **1. Kode Basi di RAM VPS** | **TERBUKTI 100%** | Proses daemon Node hidup berhari-hari tanpa PM2 atau auto-reload. `git pull` di VPS terbukti tidak me-restart proses background. Solusi: Batch 12 (PM2 setup) & Batch 13 (deploy script atomic). |
| **2. Tidak ada Market Hours Guard** | **TERBUKTI 100% & DIPERJELAS** | Fungsi `getMarketSessionStatus` sebenarnya **sudah ada** di repo sejak Batch 5 (`d82fbd1`), namun **terisolasi di fungsi dead-code** (`sendAlert`). Jalur nyata (`telegramNotifier` & cron 12:45 `run-telegram-monitor-local`) tidak menggunakannya dan memiliki jendela jam yang salah (09:05–16:05 tanpa istirahat). Solusi: Batch 2, 3, 4 (Standardisasi `market-hours-guard.js` dan reconnect ke seluruh jalur). |
| **3. Kriteria Trigger Kelonggaran** | **TERBUKTI 100% & DIPERJELAS** | Di Day Trade, `calculateDayTradeScore` hanya mengunci batas volume (VR < 1.0), bukan R/R. Di Swing, jalur digest fallback dan Tier 2 mengizinkan kandidat dengan R/R rendah (< 1.5x / 1.3x) untuk disiarkan saat jalur strict kosong. Solusi: Batch 5 & 6 (Filter sentral `MIN_RR_RATIO` 1.5x / 1.8x). |
| **4. Tidak Ada State Machine / Anti-Duplikat Alert** | **TERBUKTI 100%** | Bot Telegram bersifat *stateless* pada level memory dispatcher: setiap eksekusi cron yang menemukan harga di area entry langsung menembakkan alert tanpa mengecek apakah sinyal yang sama sudah disiarkan atau candle sudah closing. Solusi: Batch 7, 8, 9, 10, 11 (Lock revalidasi, Alert state store, Candle close confirmation). |

---

## 6. REKOMENDASI UNTUK BATCH 1–20

1. **Batch 1 (Baseline Sync):** Catat hasil `node --check` dan baseline `npm test` ke `SCREENER_BUGFIX_LOG.md`.
2. **Batch 2 (Market Hours Guard):** Buat `lib/market-hours-guard.js` dengan mengadopsi logika day-of-week aware dari `lib/daytrade-screener-engine.js:150`, ekspor `isMarketOpen()` dan `getMarketSession()`.
3. **Batch 3 (Integrasi Guard ke Broadcast):** Pasang `isMarketOpen()` di `lib/telegram-notifier.js:sendTelegramMessage` dan titik broadcast di `api/sector-hot.js`.
4. **Batch 4 (Audit Crontab VPS):** Perbaiki jendela waktu di `tools/run-telegram-monitor-local.js` agar mematuhi jam istirahat bursa, serta sinkronkan file cron repo dengan crontab live VPS.
5. **Batch 5 & 6 (Filter R/R Sentral):** Tempatkan `MIN_RR_RATIO = 1.5` di `lib/screener-config.js` dan terapkan ke seluruh filter (termasuk memblokir bypass pada digest fallback).
6. **Batch 7 & 8 (Kunci Revalidasi):** Cegah transisi otomatis `NEEDS_REVALIDATION` -> `ENTRY ZONE` tanpa konfirmasi volume breakout riil saat market buka.
7. **Batch 9 & 10 (Alert State Store & Throttling):** Pasang penyimpanan status alert per ticker untuk mencegah duplikasi sinyal dalam window waktu.
8. **Batch 11 (Konfirmasi Candle Close):** Pastikan sinyal `ENTRY ZONE` hanya terpicu dari candle yang sudah resmi *close*.
9. **Batch 12 & 13 (PM2 & Atomic Deploy):** Konfigurasikan `ecosystem.config.js` dan `deploy.sh` untuk mengeliminasi kode basi di RAM VPS selamanya.
