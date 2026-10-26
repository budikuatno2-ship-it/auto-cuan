# MEGA AUDIT FORENSIK 2026-10-26 — EKSTRAKSI MENDALAM LOGIKA & INSIDEN SENIN PAGI

> **Audit:** 2026-10-26, 09:45–10:00 WIB
> **VPS:** Oracle Cloud Ubuntu, `<IP_VPS>`
> **Mode:** 100% READ-ONLY · 0 perubahan kode · 0 request API Arjum

---

## AREA 1: BONGKAR TUNTAS INSIDEN DARURAT — DayTrade Snapshot Basi (3567 menit)

### 1.1 Log Mentah VPS — DayTrade Producer Pagi Ini

**09:02 WIB** — Cron `2 9 * * 1-5`:
```text
[2026-10-26 09:02:01 WIB] DayTrade intraday producer --execute speed=full
  market   : LIVE_MARKET (session_1)
  memory   : 5133.8 MB available (floor 1536 MB)
  mode     : EXECUTE / FULL
  timeout  : 360s (single run ceiling)
  load 1m  : start=0.08  rss=42MB
  delivery : deferred_to_fast_watcher
  base URL : http://127.0.0.1:3000
  batch 0: status=running scanned=50/800
  batch 1: status=running scanned=100/800
  ...
  batch 15: status=published scanned=800/800
Screener snapshot producer
  base URL : http://127.0.0.1:3000
  mode     : WRITE
  ! screener failed: The operation was aborted due to timeout
  rows read:
    screener                0
    nk-screener-results     20
    daytrade-screener       4          <-- 4 saham DayTrade lolos
    telegram-daily-picks    0
    TOTAL                   24
  rows with unified_score   : 24
  wrote /home/ubuntu/auto-cuan/data/screener-latest.json (1209456 bytes)
  summary  : PUBLISHED mode=full universe=800 scanned=800 duration=220552ms peak_rss=77MB load1=0.08->1.56
  snapshot : materialized (24 rows)
```

**09:17 WIB** — Cron `17 9 * * 1-5`:
```text
[2026-10-26 09:17:01 WIB] DayTrade intraday producer --execute speed=full
  ...
  ! screener failed: The operation was aborted due to timeout
  rows read:
    screener                0
    nk-screener-results     20
    daytrade-screener       3          <-- menurun ke 3 saham
    telegram-daily-picks    0
    TOTAL                   23
  wrote /home/ubuntu/auto-cuan/data/screener-latest.json (1182495 bytes)
  summary  : PUBLISHED mode=full universe=800 scanned=800 duration=221816ms peak_rss=69MB load1=0.06->1.35
  snapshot : materialized (23 rows)
```

**09:32 WIB** — Cron `32 9 * * 1-5`:
```text
[2026-10-26 09:32:01 WIB] DayTrade intraday producer --execute speed=full
  ...
  daytrade-screener       4              <-- naik lagi ke 4
  TOTAL                   24
```

**09:47 WIB** — Cron `47 9 * * 1-5`:
```text
[2026-10-26 09:47:01 WIB] DayTrade intraday producer --execute speed=full
  ...
  batch 14: status=running scanned=750/800
  (output terpotong, scan mungkin belum selesai saat log dibaca)
```

### 1.2 File State Snapshot di VPS

[`data/screener-latest.json`](data/screener-latest.json) (key fields):
```json
{
  "updated_at": "2026-10-26T02:35:43.433Z",
  "generated_by": "tools/build-screener-snapshot.js",
  "source_dates": {
    "swing-konglo": null,
    "swing-non-konglo": "2026-10-23",
    "daytrade": "2026-10-26",
    "top5": null
  }
}
```

[`data/daytrade-snapshot-alarm.json`](data/daytrade-snapshot-alarm.json):
```json
{
  "last_alert_at": null,
  "last_reason": null,
  "rearmed_at": "2026-10-26T02:17:01.066Z"
}
```

- `last_alert_at: null` — Alert TIDAK PERNAH tercatat sebagai terkirim.
- `rearmed_at: 09:17 WIB` — Alarm di-rearm setelah run 09:17 selesai.

### 1.3 Identifikasi Akar Masalah

#### ⚠️ Kemungkinan A: Mismatch Lokasi File — **BUKAN PENYEBAB**

- Producer menulis ke `/home/ubuntu/auto-cuan/data/screener-latest.json` — TERBUKTI dari log `wrote ... screener-latest.json`
- Watchdog (`lib/daytrade-snapshot-alarm.js`) membaca `screener-latest.json` melalui `snapshotBuilder.snapshotPath(rootDir)` — file SAMA
- **Tidak ada mismatch.**

#### ⚠️ Kemungkinan B: Skip Write Saat 0 Kandidat — **TIDAK TERJADI PAGI INI**

- Run 09:02 menghasilkan **4 daytrade-screener rows**
- Run 09:17 menghasilkan **3 daytrade-screener rows**
- Run 09:32 menghasilkan **4 daytrade-screener rows**
- `daytrade-screener` table TIDAK kosong — snapshot SELALU ditulis
- **Bukan penyebab insiden ini.**

#### ✅ Kemungkinan C: Timeout / Crash — **TERKONFIRMASI**

- **Setiap run** mengalami `! screener failed: The operation was aborted due to timeout`
- Durasi scan: 220552ms (~3.7 menit) — di bawah batas 360s timeout per-batch
- Tapi **snapshot query** (`screener` table = 0 rows) gagal dengan timeout
- Ini adalah timeout pada QUERY ke `http://127.0.0.1:3000` (API lokal), BUKAN timeout scan ticker
- **`screener` table SELALU 0 rows** di setiap run — query `/api/sector-hot?action=scan` untuk screener penuh (Swing) gagal/timeout

#### 🔴 Kemungkinan D: Bug Snapshot Age Calculation — **TERKONFIRMASI — INI AKAR MASALAH UTAMA**

**Kode Watchdog:** [`lib/daytrade-snapshot-alarm.js`](lib/daytrade-snapshot-alarm.js:39-72)

```js
function evaluate(input) {
  const opts = input || {};
  const ageMs = (() => {
    const m = toMs(opts.snapshotMtime);   // ← mtime FILE screener-latest.json
    const n = toMs(opts.now);
    if (m == null || n == null) return null;
    return n - m;
  })();
  const ageMinutes = ageMs == null ? null : Math.max(0, Math.round(ageMs / 60000));
  ...
  if (ageMs == null) {
    return { shouldAlert: true, reason: 'snapshot_missing', ageMinutes: null };
  }
  if (ageMinutes < staleMinutes) {        // staleMinutes = 120
    return { shouldAlert: false, reason: 'fresh', ageMinutes };
  }
  ...
}
```

**Kode Pemanggil:** [`tools/run-daytrade-intraday-producer.js`](tools/run-daytrade-intraday-producer.js:163-195)

```js
async function maybeAlertStaleSnapshot(ctx) {
  const snapshotPath = snapshotBuilder.snapshotPath
    ? snapshotBuilder.snapshotPath(rootDir)
    : path.join(rootDir, 'data', 'screener-latest.json');

  let snapshotMtime = null;
  try {
    if (fsInstance.existsSync(snapshotPath)) snapshotMtime = fsInstance.statSync(snapshotPath).mtime;
  } catch (_

---

## AREA 2: LOGIKA & BUG 4 MESIN SCREENER

### 2A. DAYTRADE
**File:** lib/daytrade-screener-engine.js:1338

Scoring: Liquidity(25) + PreSpike(30) + Momentum(25) + RiskReward(15) + Trend(15) + Penalty(-40) + Candle(-8/+6). Composite capped 0-100.

**Hard Gates (lib/daytrade-screener-engine.js:950):**
1. Liquidity FAIL => AVOID (value < 1B AND avg7d < 500M)
2. Volume Ratio < 0.3 (known, non-null) => AVOID
3. RR < MIN_RR_RATIO => WAIT_PULLBACK
4. Papan Akselerasi => SPECULATIVE max
5. change_pct > 8.5% => hard fail overheat
6. 14:30+ WIB => no new radar

**BUG 02-A: Volume Ratio 09:02 WIB uses JUMAT candle data**
lib/daytrade-screener-engine.js:337 — volume_today = last.volume (Yahoo daily). At 09:02 Monday, Yahoo has no Monday candle yet. All volume_ratio_20d, change_pct, value_today use FRIDAY 2026-10-23 data. Live intraday prices handled by FastWatcher only.

### 2B. SWING KONGLO
**File:** lib/bandarmologi-screener-scoring.js:40

Scoring rules:
- CR3 >= 60% & NetFlow > 0: +25
- CR5 >= 70% & NetFlow > 0: +15
- CR3 >= 50% & NetFlow > 0: +10
- Inst >= 70%: +20 | Inst >= 50%: +10
- Retail Dump + Bandar Accum: +15
- Retail Chase Distribution: -20
- Insider Buy 30D: +20 | Insider >= 50%: +5
- Multi-Day Accum (Swing mode): +10
- Quant LPM + CMF: +5 / -10
- Vol Rotation Surge: +5
- Foreign Inflow: +5

Max: +105, Min: -30

**BUKTI broker-summary-F JSON (NOT A BUG)**
VPS file: data/arjum-data/broker-summary-F/BBCA/2026-10-23.json
Structure: { "stock_code":"BBCA", "brokers":[ {"broker_code":"YU","bval":831957657500,"sval":146574900000,"nval":685382757500}, ... ] }

NO root-level foreign_net field. foreign_net is COMPUTED by normalizeBrokerSummary() via foreignBuyVal - foreignSellVal using FOREIGN_INST_BROKERS whitelist (AK,BK,RX,KZ,ZP,CS,DB). Folder rename to broker-summary-F is correct.

### 2C. SWING NON-KONGLO
Filter: turnover >= 10B IDR 15/20 hari, not FCA/Akselerasi, score threshold. buildFusionForeignFrame() at api/sector-hot.js:6382 already uses broker-summary-F.

### 2D. FASTWATCHER
Cron: */5 9-15 * * 1-5 (every 5 min). Log: fastwatcher.log (24MB). FastWatcher data shows 2026-09-25 (historical test data). Three pools: Observation -> Confirmation -> Publishing.

---

## AREA 3: TOP 5 & isTop5PickRow()

### BUG 03-A: isTop5PickRow() blocks swing_konglo
**File:** api/sector-hot.js:8543

if (source === 'daytrade' || ... || source === 'swing_konglo') return false;

swing_konglo requires is_locked/first_sent_at. If nightly lock cron fails, ALL Konglo picks rejected. Evidence: screener-latest.json source_dates.swing-konglo = null.

### BUG 03-B: telegram-daily-picks ALWAYS 0 rows
Every run: telegram-daily-picks = 0. Table should be populated by screener-dispatch (22:15) or screener-preflight (21:30). Last screener-dispatch.log: 2026-10-23.

---

## AREA 4: TIMEZONE & DATE BUGS

### BUG 04-A: toISOString().slice(0,10) without WIB offset (55 files)
On VPS (UTC), returns UTC date. On laptop WIB, shifts 7 hours.
Key files: lib/daytrade-screener-engine.js:273, lib/idx-trading-calendar.js:79, lib/chart-t1-policy.js:29, lib/daytrade-intraday-policy.js:54.

### BUG 04-B: Monday morning seeks 2026-10-26, latest EOD is 2026-10-23
lib/bandarmologi-service.js:253 getEffectiveTradingDate() correctly falls back to T-1 before 18:00 WIB. But modules using raw new Date().toISOString().slice(0,10) will look for non-existent 2026-10-26.json.

---

## AREA 5: CRON SCHEDULES vs WATCHDOG

Cron DayTrade: 2,17,32,47 9-15 * * 1-5 (every 15 min)
Gap 10:02 -> 13:02 = 180 minutes.
Watchdog DEFAULT_STALE_MINUTES = 120 minutes.
**EVERY Mon-Thu at 12:03 WIB, watchdog WILL scream DARURAT.**

Other cron logs:
- 02:15 telegram-lifecycle: 54 bytes (OK)
- 08:55-09:45 fastwatcher.log: 24MB
- 09:30 sector-hot.log: every 30 min
- screener-dispatch.log: last run 2026-10-23

---

## AREA 6: TELEGRAM BOT LOGS
PM2 logs not captured via SSH (output empty). FastWatcher SCP: 17MB log file, shows data from 2026-09-25.

## AREA 7: MASTER BUG TABLE

| ID | Category | File:Line | Description | Evidence |
|----|----------|-----------|-------------|----------|
| BUG-01-A | Watchdog | tools/run-daytrade-intraday-producer.js:196 | last_alert_at never saved | daytrade-snapshot-alarm.json: last_alert_at=null |
| BUG-01-B | Cron | crontab line 188 | 180min gap triggers false alarm daily at 12:03 | cron 10:02->13:02 vs watchdog 120min |
| BUG-01-C | API Timeout | tools/run-daytrade-intraday-producer.js:27 | screener table always 0 (Swing Konglo query timeout) | log: screener=0 every run |
| BUG-02-A | DayTrade | lib/daytrade-screener-engine.js:337 | volume_ratio uses Friday candle at 09:02 Monday | Yahoo daily candle delay |
| BUG-03-A | Top5 | api/sector-hot.js:8543 | swing_konglo blocked without is_locked | source_dates.swing-konglo=null |
| BUG-03-B | Top5 | api/sector-hot.js:6835 | telegram-daily-picks always 0 | log: telegram-daily-picks=0 every run |
| BUG-04-A | Timezone | 55 JS files | toISOString().slice(0,10) = UTC, not WIB | grep result |
| BUG-04-B | Date | lib/chart-t1-policy.js:29 etc | seeks today-date file on Monday morning | no 2026-10-26 EOD data before 16:30 |
