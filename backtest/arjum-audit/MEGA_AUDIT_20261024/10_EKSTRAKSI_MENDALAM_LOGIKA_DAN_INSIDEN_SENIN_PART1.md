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