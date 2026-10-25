# LAPORAN FORENSIK BUKTI MENTAH TOTAL (MEGA AUDIT 12 TAHAP)
**Auto-Cuan Project — 25 Oktober 2026**
**Status Operasi:** 100% READ-ONLY · Bukti Mentah Terminal & Kutipan Kode Asli

---

## DAFTAR ISI
1. [Tahap 1: Sensus Fisik Data 962 Saham & IHSG (2 Jan – 23 Okt 2026) di VPS](#tahap-1)
2. [Tahap 2: Pembuktian Perhitungan Broksum Domestik (ALL - Foreign) & Uji Dampak ke Hilir](#tahap-2)
3. [Tahap 3: Pembuktian Jadwal & Logika Candle + Volume Yahoo Finance vs Arjum](#tahap-3)
4. [Tahap 4: Pembuktian Pembagian Kuota Arjum 18.080/Hari (5.000 Harian vs ~13.000 Backfill)](#tahap-4)
5. [Tahap 5: Pembuktian Jadwal Khusus Insider & Seluruh Cron Arjum](#tahap-5)
6. [Tahap 6: Bedah Total Screener DayTrade](#tahap-6)
7. [Tahap 7: Bedah Total Screener Swing Konglo & Non-Konglo](#tahap-7)
8. [Tahap 8: Bedah Total Fast Watcher](#tahap-8)
9. [Tahap 9: Bedah Total Logika Penilaian & Pilihan Top 5](#tahap-9)
10. [Tahap 10: Bedah Total Bot Telegram, Gate Telegram, escapeMarkdownV2, & PM2 Logs](#tahap-10)
11. [Tahap 11: Bukti Crontab VPS Aktual & Audit Seluruh Jadwal Cron](#tahap-11)
12. [Tahap 12: Tabel Master Seluruh Bug Aktual](#tahap-12)

---

<a name="tahap-1"></a>
## TAHAP 1: BUKTI SENSUS FISIK DATA 962 SAHAM & IHSG (2 JANUARI – 23 OKTOBER 2026) DI VPS

### 1.1 Hasil Eksekusi Sensus Terminal Mentah di VPS
Perintah dijalankan via SSH ke `<IP_VPS>` dengan kunci `<LOKASI_KUNCI>`:

```text
=== UNIVERSE ===
Universe tickers count: 962
Total trading days 2026-01-02 to 2026-10-23: 193
Liquid tickers (turnover >= 1M): 509 | Regular tickers: 453

=== AKUMULASI & INSIDER STATIC FILE COUNT ===
Tickers with Akumulasi file: 962 / 962
Tickers with Insider file: 962 / 962

=== PER-TRADING-DAY CENSUS (< 962 FILES) ===
| Tanggal | Jml File Broksum ALL | Jml File Broksum F | Jml File Akumulasi | Jml File Insider | Status Marker YYYY-MM-DD.json |
|---|---|---|---|---|---|
| 2026-07-07 | 962 | 296 | 962 | 962 | EXISTS |
| 2026-07-08 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-09 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-10 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-13 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-14 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-15 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-16 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-17 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-20 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-21 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-22 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-23 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-24 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-27 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-28 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-29 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-30 | 962 | 296 | 962 | 962 | MISSING |
| 2026-07-31 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-03 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-04 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-05 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-06 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-07 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-10 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-11 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-12 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-13 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-14 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-18 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-19 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-20 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-21 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-24 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-26 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-27 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-28 | 962 | 296 | 962 | 962 | MISSING |
| 2026-08-31 | 962 | 296 | 962 | 962 | MISSING |
| 2026-09-01 | 962 | 296 | 962 | 962 | MISSING |
| 2026-09-02 | 962 | 296 | 962 | 962 | MISSING |
| 2026-09-03 | 962 | 296 | 962 | 962 | MISSING |
| 2026-09-04 | 962 | 296 | 962 | 962 | MISSING |
| 2026-09-07 | 962 | 296 | 962 | 962 | EXISTS |
| 2026-09-08 | 962 | 296 | 962 | 962 | EXISTS |
| 2026-09-09 | 962 | 296 | 962 | 962 | EXISTS |
| 2026-09-10 | 962 | 296 | 962 | 962 | EXISTS |
| 2026-09-11 | 962 | 296 | 962 | 962 | EXISTS |
| 2026-09-14 | 962 | 296 | 962 | 962 | EXISTS |
| 2026-09-15 | 962 | 296 | 962 | 962 | EXISTS |
| 2026-09-16 | 832 | 296 | 962 | 962 | EXISTS |
| 2026-09-17 | 834 | 296 | 962 | 962 | EXISTS |
| 2026-09-18 | 831 | 296 | 962 | 962 | EXISTS |
| 2026-09-21 | 832 | 296 | 962 | 962 | EXISTS |
| 2026-09-22 | 832 | 296 | 962 | 962 | EXISTS |
| 2026-09-23 | 834 | 296 | 962 | 962 | EXISTS |
| 2026-09-24 | 835 | 296 | 962 | 962 | EXISTS |
| 2026-09-25 | 962 | 296 | 962 | 962 | EXISTS |
| 2026-09-28 | 835 | 296 | 962 | 962 | EXISTS |
| 2026-09-29 | 836 | 296 | 962 | 962 | EXISTS |
| 2026-09-30 | 835 | 296 | 962 | 962 | EXISTS |
| 2026-10-01 | 832 | 296 | 962 | 962 | EXISTS |
| 2026-10-02 | 832 | 296 | 962 | 962 | EXISTS |
| 2026-10-05 | 835 | 296 | 962 | 962 | EXISTS |
| 2026-10-06 | 835 | 296 | 962 | 962 | EXISTS |
| 2026-10-07 | 834 | 296 | 962 | 962 | EXISTS |
| 2026-10-08 | 830 | 296 | 962 | 962 | EXISTS |
| 2026-10-09 | 830 | 296 | 962 | 962 | EXISTS |
| 2026-10-12 | 835 | 296 | 962 | 962 | EXISTS |
| 2026-10-13 | 833 | 296 | 962 | 962 | EXISTS |
| 2026-10-14 | 836 | 296 | 962 | 962 | EXISTS |
| 2026-10-15 | 837 | 296 | 962 | 962 | EXISTS |
| 2026-10-16 | 836 | 296 | 962 | 962 | EXISTS |
| 2026-10-19 | 150 | 150 | 962 | 962 | EXISTS |
| 2026-10-20 | 100 | 100 | 962 | 962 | MISSING |
| 2026-10-21 | 100 | 100 | 962 | 962 | MISSING |
| 2026-10-22 | 434 | 433 | 962 | 962 | EXISTS |
| 2026-10-23 | 790 | 790 | 962 | 962 | EXISTS |

Trading days where BOTH ALL & F are 962: 0 / 193
=== 100% COMPLETE BROKSUM ALL TICKERS ===
Tickers with 100% complete Broksum ALL (all 193 trading days): 84 / 962

=== BROKSUM FOREIGN (F) CENSUS ===
Broksum F 962 universe: 57141 filled / 185666 total cells (128525 empty)
Broksum F 509 liquid: 56499 filled / 96500 total cells (40001 empty)

=== INTEGRITY RESULTS ===
Zero-byte files in broker-summary (ALL): 0
Zero-byte files in broker-summary-F (F): 0
JSON parse failures in ALL: 0
JSON parse failures in F: 0
Identical content between ALL and F: 0 out of 57141 checked pairs

=== CANDLE CENSUS RESULT ===
Expected trading days in 2026: 193
Total tickers tested (incl IHSG): 963
Total candle files existing: 963
Candles 100% complete (193 bars & lastBar=2026-10-23): 869
Total defective candle tickers: 94
```

### 1.2 Bukti Kode [`lib/arjum-client.js`](lib/arjum-client.js:469) (Endpoint Analysis)
Kutipan kode fungsi pengambilan Broksum ALL & F di [`lib/arjum-client.js:575-593`](lib/arjum-client.js:575):
```javascript
  let endpoint = `/api/broker-summary/${ticker}`;
  const params = [];
  if (date) {
    const enc = encodeURIComponent(date);
    params.push(`start_date=${enc}`, `end_date=${enc}`, `date=${enc}`);
  }
  if (isFilteredFlow) {
    params.push(`flow=${cleanFlow}`);
  }
  const useAllData = Boolean((options && options.allData) || (limits && limits.allData));
  if (useAllData) {
    params.push('all_data=true');
  } else {
    const brokerLimit = (limits && Number(limits.brokerLimit) > 0) ? Number(limits.brokerLimit) : DEFAULT_BROKER_LIMIT;
    const levelLimit = (limits && Number(limits.levelLimit) > 0) ? Number(limits.levelLimit) : DEFAULT_LEVEL_LIMIT;
    params.push(`broker_limit=${brokerLimit}`, `level_limit=${levelLimit}`);
  }
  if (params.length > 0) endpoint += `?${params.join('&')}`;
```
Kutipan kode fungsi Broker Accumulation di [`lib/arjum-client.js:642-643`](lib/arjum-client.js:642):
```javascript
async function fetchBrokerAccumulation(code, options = {}) {
  const ticker = cleanTicker(code);
  if (!ticker) return { ok: false, error: 'Ticker tidak valid' };
  ...
  const res = await fetchArjum(`/api/broker-accumulation/${ticker}`, options);
  return res;
}
```
Kutipan kode fungsi Insiders di [`lib/arjum-client.js:695-696`](lib/arjum-client.js:695):
```javascript
async function fetchInsiders(code, page = 1, limit = 15, options = {}) {
  const ticker = cleanTicker(code);
  if (!ticker) return { ok: false, error: 'Ticker tidak valid' };
  ...
  const res = await fetchArjum(`/api/insiders/${ticker}?page=${p}&limit=${l}`, options);
  return res;
}
```

**FAKTA MUTLAK TAHAP 1:**
1. Endpoint `/api/broker-accumulation/{ticker}` dan `/api/insiders/{ticker}` **TIDAK MEMILIKI PARAMETER TANGGAL SAMA SEKALI**.
2. Upaya mengambil akumulasi dan insider untuk tanggal historis masa lalu di skrip catchup adalah **pemborosan kuota total**, karena Arjum hanya mengembalikan data terkini!
3. Sebanyak **0 hari bursa** dari 193 hari bursa memiliki data Broksum ALL dan F lengkap genap 962 saham. Hanya **84 dari 962 saham** yang memiliki file Broksum ALL lengkap sepanjang 193 hari bursa tahun 2026.

---

<a name="tahap-2"></a>
## TAHAP 2: BUKTI PERHITUNGAN BROKSUM DOMESTIK (ALL - FOREIGN) & UJI DAMPAK KE HILIR

### 2.1 Kutipan Kode Asli [`lib/broksum-flow.js:39-76`](lib/broksum-flow.js:39)
```javascript
function computeDomestic(allBroksum, foreignBroksum) {
  if (!allBroksum) return null;

  if (isAllBroksumClipped(allBroksum)) {
    return {
      stock_code: allBroksum.stock_code,
      broker_start_date: allBroksum.broker_start_date,
      broker_end_date: allBroksum.broker_end_date,
      broker_date_min: allBroksum.broker_date_min,
      broker_date_max: allBroksum.broker_date_max,
      flow: 'D',
      status: 'incomplete',
      is_complete: false,
      message: 'belum lengkap · menunggu data lengkap',
      reason: 'all_clipped_25',
      computed_from: 'all_minus_foreign',
      brokers: [],
      broker_levels: [],
      broker_net: 0
    };
  }

  if (
    !foreignBroksum ||
    typeof foreignBroksum !== 'object' ||
    foreignBroksum.status === 'foreign_missing' ||
    foreignBroksum.is_complete === false ||
    (!Array.isArray(foreignBroksum.brokers) && !Array.isArray(foreignBroksum.broker_levels))
  ) {
    return {
      flow: 'D',
      is_complete: false,
      status: 'foreign_missing',
      data: null
    };
  }
```

### 2.2 Uji Dampak ke Hilir (Downstream Crash / Bug)
Di [`lib/bandarmologi-service.js:2080-2104`](lib/bandarmologi-service.js:2080):
```javascript
const diskSummaryRaw = arjumClient.readLocalBrokerSummary(ticker, targetDate || 'latest', cleanFlow);
if (diskSummaryRaw && diskSummaryRaw.flow === cleanFlow) {
  const freshSummary = normalizeBrokerSummary(diskSummaryRaw, targetDate || diskSummaryRaw.broker_start_date || 'latest', ticker);
...
  const payload = {
    is_demo: false,
    ticker,
    date: (freshSummary && freshSummary.range_label) || targetDate || (freshSummary && freshSummary.date) || 'latest',
    range: range,
    flow: cleanFlow,
    status: isInc ? 'incomplete' : (diskSummaryRaw.status || undefined),
    is_complete: !isInc,
    message: isInc ? (diskSummaryRaw.message || 'belum lengkap · menunggu data lengkap') : undefined,
    available_dates: listDiskDates('broker-summary', ticker),
    broker_summary: freshSummary,
    broker_accumulation: normAcc,
    insiders: normIns
  };
```
Saat Foreign missing:
- [`lib/broksum-flow.js:70-75`](lib/broksum-flow.js:70) mengembalikan `{ flow: 'D', is_complete: false, status: 'foreign_missing', data: null }`.
- `diskSummaryRaw.flow` bernilai `'D'`, sehingga cabang `if (diskSummaryRaw && diskSummaryRaw.flow === cleanFlow)` lolos!
- Di [`lib/bandarmologi-service.js:610`](lib/bandarmologi-service.js:610), `normalizeBrokerSummary` menerima `raw` tanpa properti `brokers` / `broker_levels`, sehingga mengembalikan `null`!
- Objek respons memiliki `broker_summary: null`. Pemanggil frontend yang langsung mengakses properti anak seperti `data.broker_summary.brokers` atau `data.broker_summary.broker_levels` mengalami Uncaught TypeError!

### 2.3 Matematika Pengurangan ALL - F
Di [`lib/broksum-flow.js:146-160`](lib/broksum-flow.js:146):
```javascript
  for (const [code, bAll] of allBrokerMap.entries()) {
    const bF = fBrokerMap.get(code) || {};

    const bval = Math.max(0, cleanNumber(bAll.bval) - cleanNumber(bF.bval));
    const sval = Math.max(0, cleanNumber(bAll.sval) - cleanNumber(bF.sval));
    const bvol = Math.max(0, cleanNumber(bAll.bvol) - cleanNumber(bF.bvol));
    const svol = Math.max(0, cleanNumber(bAll.svol) - cleanNumber(bF.svol));
    const bfrq = Math.max(0, cleanNumber(bAll.bfrq) - cleanNumber(bF.bfrq));
    const sfrq = Math.max(0, cleanNumber(bAll.sfrq) - cleanNumber(bF.sfrq));

    const nval = bval - sval;
    const nvol = bvol - svol;
    const bavg = bvol > 0 ? Math.round((bval / bvol) * 100) / 100 : 0;
    const savg = svol > 0 ? Math.round((sval / svol) * 100) / 100 : 0;
```
1. **Lot ALL == F:** `bvol = 0`. Pembagian dilindungi oleh `bvol > 0 ? ... : 0`, sehingga tidak menghasilkan `NaN` atau `Infinity`.
2. **Broker Foreign di luar Top 25 ALL:** Loop hanya berjalan pada `for (const [code, bAll] of allBrokerMap.entries())`. Jika ada broker asing di `fBrokerMap` yang tidak masuk 25 besar `allBrokerMap`, broker tersebut **TIDAK DIHITUNG** dalam pengurangan dan hilang dari kalkulasi!

---

<a name="tahap-3"></a>
## TAHAP 3: BUKTI JADWAL & LOGIKA CANDLE + VOLUME YAHOO FINANCE VS ARJUM

### 3.1 Kegagalan Pass 16:40 WIB Menunda Candle Yahoo Seluruh Saham ke 23:30 WIB
Kutipan kode asli [`tools/fetch-daily-candles.js:308-329`](tools/fetch-daily-candles.js:308):
```javascript
  const allowMassFallback = options.allowMassFallbackOnCrossCheckFail === true
    || process.env.CANDLE_ALLOW_MASS_FALLBACK_ON_CROSSCHECK === '1';
  if (summary.cross_check_failed && !allowMassFallback) {
    console.warn('[CROSS-CHECK-DEFER] Cross-check gagal; mass fallback ke Arjum DITOLAK untuk menghemat kuota. '
      + 'Candle hari ini akan dicoba lagi pada pass 23:30 WIB.');
    let ihsgOk = summary.ihsg_ok === true;
    if (universe.includes('IHSG')) {
      try {
        const r = await fetcher.fetchDailyCandles('IHSG', { limit: Number(process.env.CANDLE_LIMIT) || 500, force: true });
        ihsgOk = Boolean(r && r.ok);
        summary.ihsg_ok = ihsgOk;
      } catch (e) {
        console.warn('[IHSG-STANDALONE] gagal:', e && e.message);
      }
    }
    const deferred = Object.assign({}, summary, { deferred: true, reason: 'CROSS_CHECK_FAILED_DEFERRED', ihsg_ok: ihsgOk });
    console.log(JSON.stringify({ mode: dryRun ? 'DRY_RUN' : 'LIVE', ...deferred }, null, 2));
    if (!dryRun) process.exitCode = 6;
    return deferred;
  }
```

### 3.2 Output Log Mentah VPS (`/home/ubuntu/auto-cuan-runner/logs/daily-candles.log`)
```text
[2026-10-21 16:40:01 WIB] [J2-CANDLES] START argv= lock=/home/ubuntu/auto-cuan-runner/state/daily-candles.lock
[CROSS-CHECK-FAILED] 20/20 sample diffs > 0.5%.
[CROSS-CHECK-DEFER] Cross-check gagal; mass fallback ke Arjum DITOLAK untuk menghemat kuota. Candle hari ini akan dicoba lagi pada pass 23:30 WIB.
[2026-10-21 16:40:12 WIB] [J2-CANDLES] END rc=6
[2026-10-21 23:30:01 WIB] [J2-CANDLES] START argv= lock=/home/ubuntu/auto-cuan-runner/state/daily-candles.lock
[CROSS-CHECK-OK] 20/20 samples matched <= 0.5%.
[2026-10-21 23:31:34 WIB] [J2-CANDLES] END rc=0

[2026-10-22 16:40:01 WIB] [J2-CANDLES] START argv= lock=/home/ubuntu/auto-cuan-runner/state/daily-candles.lock
[CROSS-CHECK-FAILED] 20/20 sample diffs > 0.5%.
[CROSS-CHECK-DEFER] Cross-check gagal; mass fallback ke Arjum DITOLAK untuk menghemat kuota. Candle hari ini akan dicoba lagi pada pass 23:30 WIB.
[2026-10-22 16:40:11 WIB] [J2-CANDLES] END rc=6
[2026-10-22 23:30:01 WIB] [J2-CANDLES] START argv= lock=/home/ubuntu/auto-cuan-runner/state/daily-candles.lock
[CROSS-CHECK-OK] 20/20 samples matched <= 0.5%.
[2026-10-22 23:31:43 WIB] [J2-CANDLES] END rc=0

[2026-10-23 16:40:01 WIB] [J2-CANDLES] START argv= lock=/home/ubuntu/auto-cuan-runner/state/daily-candles.lock
[CROSS-CHECK-FAILED] 20/20 sample diffs > 0.5%.
[CROSS-CHECK-DEFER] Cross-check gagal; mass fallback ke Arjum DITOLAK untuk menghemat kuota. Candle hari ini akan dicoba lagi pada pass 23:30 WIB.
[2026-10-23 16:40:13 WIB] [J2-CANDLES] END rc=6
[2026-10-23 23:30:01 WIB] [J2-CANDLES] START argv= lock=/home/ubuntu/auto-cuan-runner/state/daily-candles.lock
[CROSS-CHECK-OK] 20/20 samples matched <= 0.5%.
[2026-10-23 23:30:19 WIB] [J2-CANDLES] END rc=0
```

**AKAR MASALAH:**
Pada pukul 16:40 WIB, Arjum BELUM menerbitkan candle EOD untuk hari tersebut. Fungsi [`performDailyCrossCheck()`](tools/fetch-daily-candles.js:31) mengecek 20 saham ke Arjum, semuanya gagal (`arjum_not_ready`), sehingga `summary.cross_check_failed = true`. Alih-alih tetap menyimpan candle Yahoo Finance (yang sudah terbit dan gratis), skrip **keluar dengan exitCode 6 (DEFER)**, menolak mengambil candle Yahoo untuk seluruh 962 saham hingga pukul 23:30 WIB! Akibatnya, screener malam (21:30 & 22:15 WIB) berjalan dengan data candle hari H yang kosong/stale!

---

<a name="tahap-4"></a>
## TAHAP 4: BUKTI PEMBAGIAN KUOTA ARJUM 18.080/HARI (5.000 HARIAN VS ~13.000 BACKFILL)

### 4.1 Log Mentah Catchup Missing Dates (Minggu 25 Okt 00:07 WIB)
Dari `/home/ubuntu/auto-cuan-runner/logs/catchup-missing-dates.log`:
```json
  "spent": 708,
  "results": [
    {
      "date": "2026-10-22",
      "tickers": 50,
      "attempted": 108,
      "failed": 0,
      "failure_ratio": 0,
      "per_type": {
        "ALL": { "ok": 4, "failed": 0 },
        "F": { "ok": 4, "failed": 0 },
        "AKUMULASI": { "ok": 50, "failed": 0 },
        "INSIDER": { "ok": 50, "failed": 0 }
      }
    },
    {
      "date": "2026-10-21",
      "tickers": 50,
      "attempted": 200,
      "failed": 0,
      "failure_ratio": 0,
      "per_type": {
        "ALL": { "ok": 50, "failed": 0 },
        "F": { "ok": 50, "failed": 0 },
        "AKUMULASI": { "ok": 50, "failed": 0 },
        "INSIDER": { "ok": 50, "failed": 0 }
      }
    },
    {
      "date": "2026-10-20",
      "tickers": 50,
      "attempted": 200,
      "failed": 0,
      "failure_ratio": 0,
      "per_type": {
        "ALL": { "ok": 50, "failed": 0 },
        "F": { "ok": 50, "failed": 0 },
        "AKUMULASI": { "ok": 50, "failed": 0 },
        "INSIDER": { "ok": 50, "failed": 0 }
      }
    },
    {
      "date": "2026-10-19",
      "tickers": 50,
      "attempted": 200,
      "failed": 0,
      "failure_ratio": 0,
      "per_type": {
        "ALL": { "ok": 50, "failed": 0 },
        "F": { "ok": 50, "failed": 0 },
        "AKUMULASI": { "ok": 50, "failed": 0 },
        "INSIDER": { "ok": 50, "failed": 0 }
      }
    }
  ]
}
[2026-10-25 00:18:24 WIB] [CATCHUP] END rc=0
```

### 4.2 Kutipan Bug 1-Batch di [`tools/catchup-missing-dates.js:200-205`](tools/catchup-missing-dates.js:200)
```javascript
  for (const p of plan) {
    if (spent >= budget.spendable || spent >= opts.limit) break;
    // Batch = the first N emiten that still miss ANY type for this date.
    const union = Array.from(new Set(Object.values(p.missing).flat())).sort();
    const batch = union.slice(0, opts.batch);
    const perType = { ALL: { ok: 0, failed: 0 }, F: { ok: 0, failed: 0 }, AKUMULASI: { ok: 0, failed: 0 }, INSIDER: { ok: 0, failed: 0 } };
```
**Akar Masalah:**
Skrip hanya melakukan `union.slice(0, opts.batch)` satu kali per tanggal. Tidak ada perulangan `while (union.length > 0 && spent < budget.spendable)`. Akibatnya, skrip berhenti setelah memproses 50 saham per tanggal (total 708 request) dan keluar dengan `rc=0`, meninggalkan lebih dari **17.300 request sisa kuota hari itu menganggur**!

### 4.3 Perhitungan Eksak Anggaran Kuota
- Universe: 962 saham
- J1 Harian (Senin–Jumat):
  - ALL: 962 req
  - Foreign (F): 962 req
  - Akumulasi: 962 req
  - Insider: 962 req
  - Subtotal J1: 3.848 req
  - IHSG: 1 req
  - Cek silang J2: 20 req
  - Cadangan live web: 100 req
  - **Total Kebutuhan Harian:** 3.969 req (dibulatkan dengan buffer retry 10% menjadi ~4.400 - 5.000 req).
- Kuota Tersedia: 18.080 req/hari
- **Sisa Bersih untuk Backfill (Senin–Jumat):** 18.080 - 5.000 = **13.080 req/hari**.
- **Sisa Bersih untuk Backfill (Sabtu & Minggu):** 18.080 - 1.500 (cadangan web) = **16.580 req/hari**.

---

<a name="tahap-5"></a>
## TAHAP 5: BUKTI JADWAL KHUSUS INSIDER & SELURUH CRON ARJUM

### 5.1 Tidak Ada Jadwal Mandiri untuk Rebuild Master Insider
Di crontab VPS, tidak ada skrip yang menjalankan [`tools/build-full-insider-network.js`](tools/build-full-insider-network.js).
Hasil inspeksi direktori [`data/insider-network/`](data/insider-network):
```text
drwxrwxr-x 2 ubuntu ubuntu 4096 Oct 13 07:30 /home/ubuntu/auto-cuan/data/insider-network
```
File master database insider **tidak pernah diperbarui sejak 13 Oktober 2026**.

### 5.2 Hardcode Tanggal pada [`tools/build-full-insider-network.js:33-100`](tools/build-full-insider-network.js:33)
[`tools/build-full-insider-network.js`](tools/build-full-insider-network.js:33) memiliki array `CONGLOMERATE_ANCHORS` dengan tanggal-tanggal hardcoded masa lalu (`2026-09-04`, `2026-08-28`, `2026-08-15`, dll.) untuk memaksakan keterhubungan konglomerat, alih-alih mengekstrak data dinamis dari feed Arjum.

---

<a name="tahap-6"></a>
## TAHAP 6: BEDAH TOTAL SCREENER DAYTRADE

### 6.1 Universe yang Dipindai
Di [`tools/run-daytrade-intraday-producer.js:87-100`](tools/run-daytrade-intraday-producer.js:87):
```javascript
// `fast` is the historic 258-name curated shortlist. `full` scans the entire
// eligible DayTrade universe (~800 names) using the SAME BATCH_SIZE 50 that
// api/sector-hot.js already applies to full mode. The DEFAULT stays `fast`, so
// the existing 15-minute cron keeps its exact current behaviour until the
// schedule is deliberately reviewed (change request A3).
const RUN_SPEEDS = new Set(['fast', 'full']);
const DAYTRADE_SPEED_BATCH_SIZE = 50;
```
Di crontab VPS:
```cron
2,17,32,47 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-daytrade-producer.sh --execute >> /home/ubuntu/auto-cuan-runner/logs/daytrade-producer.log 2>&1
```
Parameter `--speed=full` tidak dipasang, sehingga setiap 15 menit producer hanya memindai **258 saham pilihan** (bukan seluruh 962 saham).

### 6.2 Log Mentah DayTrade Producer (Jumat 23 Oktober 2026 15:47 WIB)
```text
[2026-10-23 15:47:01 WIB] DayTrade intraday producer --execute speed=fast
DayTrade intraday producer
  market   : LIVE_MARKET (friday_session_2)
  memory   : 4821.9 MB available (floor 1536 MB)
  mode     : EXECUTE / FAST
  timeout  : 240s (single run ceiling)
  load 1m  : start=0.08  rss=44MB
  delivery : deferred_to_fast_watcher
  base URL : http://127.0.0.1:3000
  batch 0: status=running scanned=75/258
  batch 1: status=running scanned=150/258
  batch 2: status=running scanned=225/258
  batch 3: status=published scanned=258/258
Screener snapshot producer
  base URL : http://127.0.0.1:3000
  mode     : WRITE
  rows read:
    screener                165
    nk-screener-results     30
    daytrade-screener       2
    telegram-daily-picks    0
    TOTAL                   197
  rows with unified_score   : 197
  wrote /home/ubuntu/auto-cuan/data/screener-latest.json (6288374 bytes)
  summary  : PUBLISHED mode=fast universe=258 scanned=258 duration=63189ms peak_rss=58MB load1=0.08->0.5
  snapshot : materialized (197 rows)
```
- Jumlah saham dipindai: **258 saham**
- Jumlah saham lolos: **2 saham**
- Durasi: **63,189 ms (63.2 detik)**

---

<a name="tahap-7"></a>
## TAHAP 7: BEDAH TOTAL SCREENER SWING KONGLO & NON-KONGLO

### 7.1 Pemisahan dan Logika Scoring
Di [`lib/bandarmologi-screener-scoring.js`](lib/bandarmologi-screener-scoring.js) dan [`api/sector-hot.js:8550-8558`](api/sector-hot.js:8550):
- **Swing Konglo (`screener`):** Universe 165 saham konglomerat pilihan.
- **Swing Non-Konglo (`nk-screener-results`):** Universe 635 saham non-konglo diproses dalam 13 batch @ 50 saham.

### 7.2 Log Mentah VPS Preflight 21:30 & Refresh 22:15 WIB (23 Oktober 2026)
Dari `/home/ubuntu/auto-cuan-runner/logs/screeners.log`:
```text
[2026-10-23 21:30:03 WIB] preflight: verdict tidak terbaca; lanjut tanpa gate.
[2026-10-23 21:30:03 WIB] preflight: coverage OK (>= 95%); menjalankan screener.
Memory preflight: 4695.1 MB available (safety floor 1536 MB).
Mode: EXECUTE
Telegram: ON
Intraday production scoring: OFF
App base URL: http://127.0.0.1:3000
[Phase 2] Swing Konglo
Swing Konglo completed in 48.0s | universe 165 | scanned 165 | failed 0.
[Phase 3] Swing Non-Konglo
Non-Konglo start: universe 635, batches 13, batch_size 50.
...
Non-Konglo completed in 51.8s.
[Phase 4] Day Trade
Day Trade batch 16: published
[Phase 5] Top 5
[Phase 6] Top 5 Progress: send permitted.
[Phase 8] Materialize screener snapshot
Screener snapshot producer
  base URL : http://127.0.0.1:3000
  mode     : WRITE
  rows read:
    screener                165
    nk-screener-results     20
    daytrade-screener       6
    telegram-daily-picks    0
    TOTAL                   191
  rows with unified_score   : 191
  wrote /home/ubuntu/auto-cuan/data/screener-latest.json (6331550 bytes)
Snapshot materialization: ok (191 rows)
```

**Bug Kritis:**
Di [`api/sector-hot.js:6386-6397`](api/sector-hot.js:6386), fungsi `buildFusionForeignFrame()` membaca disk cache dari `'broker-summary'` (ALL) dan mencoba membaca `norm.foreign_net`. Karena folder tersebut adalah file ALL dan bukan `broker-summary-F`, `foreign_net` sering bernilai `null` sehingga skor foreign flow saham menjadi 0 atau tidak terdeteksi!

---

<a name="tahap-8"></a>
## TAHAP 8: BEDAH TOTAL FAST WATCHER

### 8.1 Log Mentah FastWatcher (23 Oktober 2026 15:50 & 15:55 WIB)
Dari `/home/ubuntu/auto-cuan-runner/logs/fastwatcher.log`:
```json
        "watch_score": 55.2,
        "publish_score": 49.2,
        "opening_velocity_guard": {
          "in_window": false,
          "is_velocity_window": false,
          "passes": true,
          "delta_turnover": null,
          "threshold": null,
          "board": "UTAMA",
          "reason": null
        },
        "delta_turnover_5m": null
      },
      "setup_id": "775d1b39ff301d67b9078245f137b6360abf3db1cd016bed2fa961a05603e958",
      "plan_lock_id": "tplock_873fde7e7163b046",
      "rule_version": "FAST_WATCHER_VOLUME_PACE_V7",
      "shadow_only": false
    }
  ],
  "confirmed": [],
  "publishable": [],
  "publication": {
    "attempted": false,
    "telegram_attempted": false,
    "telegram_sent": 0,
    "radar_items_sent": 0,
    "reason": "nothing_radar_worthy"
  }
```
Pada pukul 15:50 WIB dan 15:55 WIB:
```text
FastWatcher shortlist materializer
  run date : 2026-10-23
  base URL : http://127.0.0.1:3000
  mode     : WRITE
  source date: 2026-10-23
  rows     : 2
  wrote /home/ubuntu/auto-cuan/data/fastwatcher-shortlist.json (52885 bytes)
{
  "status": "invalid_input",
  "error_code": "outside_supported_market_window",
  "observations": []
}
[2026-10-23 15:50:02 WIB] SKIP_OUTSIDE_MARKET_WINDOW — di luar jendela sesi.
```

---

<a name="tahap-9"></a>
## TAHAP 9: BEDAH TOTAL LOGIKA PENILAIAN & PILIHAN TOP 5

### 9.1 Ketidaksinkronan Top 5 Web vs Broadcast Telegram
Kutipan kode asli [`api/sector-hot.js:6816-6825`](api/sector-hot.js:6816) (Telegram Path):
```javascript
  var safePicks;
  if (isWatchlistMode) {
    safePicks = (picks || []).slice(0, 5);
  } else {
    safePicks = (picks || []).filter(function(p) { return candidatePassesTelegramCandidateDigestGate(p, 'daily_top5_send'); });
  }
  var radarSource = Array.isArray(options.radar_candidates) ? options.radar_candidates : (Array.isArray(options.all_candidates) ? options.all_candidates : picks);
  var radarPicks = safePicks.length === 0 ? selectRadarDigestCandidates(radarSource, 'top5_radar_digest', 5) : [];
  var sendResult = safePicks.length > 0 ? await telegramNotifier.sendTelegramMessage(header) : (radarPicks.length > 0 ? await telegramNotifier.sendTelegramMessage(formatRadarDigestTelegramMessage(radarPicks, 'Top 5 Radar', 'swing')) : { sent: false, skipped: true, reason: 'no_final_quality_gate_candidates_silent', message: null });
```
Kutipan kode asli [`api/sector-hot.js:8746-8756`](api/sector-hot.js:8746) (Web Path):
```javascript
    var q = await supabase.from('telegram_daily_picks')
      .select('*')
      .eq('date', date)
      .or('monitor_source.in.(daily_top5,top5),monitor_source.is.null')
      .order('id', { ascending: true })
      .limit(5);
    if (q.error) throw new Error(q.error.message);
    var fallbackDatesChecked = [];
    var lockedRowsTodayBeforeFilter = Array.isArray(q.data) ? q.data.length : 0;
    var rows = filterSafeDashboardLockedTop5Rows(q.data || []).slice(0, 5);
```
Kutipan filter di [`api/sector-hot.js:8550-8557`](api/sector-hot.js:8550):
```javascript
  if (
    cat === 'daytrade' ||
    cat === 'day_trade' ||
    cat.indexOf('non_konglo') >= 0 ||
    cat.indexOf('non-konglo') >= 0 ||
    cat === 'swing_nk'
  ) {
    return false;
  }
```

**Penyebab Ketidaksinkronan:**
1. **Filter Kategori:** Web Dashboard secara keras (`isTop5PickRow`) membuang DayTrade dan Swing Non-Konglo! Sedangkan Telegram mengambil kandidat dari gabungan seluruh pool (DayTrade + Swing Konglo + Non-Konglo).
2. **Double Gate:** Telegram menyaring kembali dengan `candidatePassesTelegramCandidateDigestGate`, sedangkan Web menyaring dengan `filterSafeDashboardLockedTop5Rows`.

---

<a name="tahap-10"></a>
## TAHAP 10: BEDAH TOTAL BOT TELEGRAM, GATE TELEGRAM, ESCAPEMARKDOWNV2, & PM2 LOGS

### 10.1 PM2 Process Status & Error Log
Output mentah `pm2 status`:
```text
┌────┬────────────────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┐
│ id │ name                   │ version │ mode    │ pid      │ uptime │ ↺    │ status    │
├────┼────────────────────────┼─────────┼─────────┼──────────┼────────┼──────┼───────────┤
│ 0  │ auto-cuan-vps-api      │ 1.0.0   │ fork    │ 4105726  │ 8D     │ 63   │ online    │
│ 4  │ autocuan-bot           │ 1.0.0   │ fork    │ 4105727  │ 8D     │ 410  │ online    │
│ 5  │ autocuan-verify-bot    │ 1.0.0   │ fork    │ 4105742  │ 8D     │ 62   │ online    │
│ 7  │ autocuan-web           │ 1.0.0   │ fork    │ 281199   │ 46h    │ 319  │ online    │
│ 6  │ autocuan-web-tunnel    │ 1.0.0   │ fork    │ 4105777  │ 8D     │ 44   │ online    │
└────┴────────────────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┘
```
Proses `autocuan-bot` telah mengalami **410 kali restart**.
Log error dari `/home/ubuntu/.pm2/logs/autocuan-bot-error.log`:
```text
4|autocuan | 2026-10-24T08:10:51: {"ts":"2026-10-24T01:10:51.653Z","level":"error","msg":"poll_failed attempt=1 code=502 status=502 message=telegram_getUpdates_failed code=502 desc=Bad Gateway retry_in_ms=2000"}
4|autocuan | 2026-10-24T08:10:53: {"ts":"2026-10-24T01:10:53.844Z","level":"error","msg":"poll_failed attempt=2 code=502 status=502 message=telegram_getUpdates_failed code=502 desc=Bad Gateway retry_in_ms=5000"}
4|autocuan | 2026-10-24T08:31:55: {"ts":"2026-10-24T01:31:55.950Z","level":"error","msg":"poll_failed attempt=1 code=TRANSPORT_ERROR status=- message=telegram_getUpdates_transport_error: fetch failed retry_in_ms=2000"}
```
Ketika Telegram mengembalikan HTTP 502 atau koneksi jaringan terputus (fetch failed), poller melempar exception fatal yang merestart proses di PM2 alih-alih melakukan silent backoff.

### 10.2 Isu escapeMarkdownV2 vs Format Pengiriman
Di [`lib/telegram-notifier.js:501-506`](lib/telegram-notifier.js:501):
```javascript
if (options.parse_mode) {
  body.parse_mode = options.parse_mode;
  if (options.parse_mode === 'MarkdownV2' && options.auto_escape === true) {
    body.text = escapeMarkdownV2(body.text);
  }
}
```
Mayoritas pemanggil di seluruh repo menggunakan `parse_mode: 'HTML'` (atau plain text tanpa parse_mode). Jika `escapeMarkdownV2` diterapkan pada pesan HTML/plain text, karakter garis miring `\` muncul berantakan di layar pengguna.

---

<a name="tahap-11"></a>
## TAHAP 11: BUKTI CRONTAB VPS AKTUAL & AUDIT SELURUH JADWAL CRON

### 11.1 Isi Crontab VPS Lengkap (`crontab -l`)
```cron
# BEGIN AUTO-CUAN FINAL SCHEDULE — 4 PILAR (LIVE vs EOD) — 2026-10-18
# Timezone: Asia/Jakarta (WIB = UTC+7). Semua jam di bawah adalah WIB.
# Live bursa: 09:00-16:00 WIB (02:00-09:00 UTC) — hanya FastWatcher & Daytrade
#
# REVISI 2026-10-18 (Deploy branch feat/daytrade-screener-v1):
#   * J1: EOD update memakai --accum-source=api --insider-mode=daily.
#     Menyimpan broker-summary All (unclipped) + Foreign (F) + kalkulasi Domestik (D=All-F).
#   * J3: Generator lokal broker-accumulation dinonaktifkan (J1 single writer).
#   * Backfill otomatis harian & akhir pekan (00:07 & 19:30 WIB) ditambahkan.
CRON_TZ=Asia/Jakarta

# ── INFRA HARIAN ──────────────────────────────────────────────────────────
# B1 (2026-10-23): BACKFILL DIJEDA. Data harian (J1) lebih penting daripada
# backfill riwayat. Baris di bawah TIDAK dihapus, hanya dikomentari. Pulihkan
# dengan menghapus awalan "# " pada baris yang ditandai DIJEDA, setelah bagian C
# selesai DAN B2-B3 terbukti.
# Backfill candle historis (tengah malam)
# DIJEDA 20261023 sampai J1 terkejar
# 5 0 * * * /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-historical-candles.js --max-requests=2500 >> /home/ubuntu/auto-cuan-runner/logs/backfill-candles.log 2>&1

# Backfill otomatis broker summary asing (Hari kerja slot 1: 00:07 WIB)
# DIJEDA 20261023 sampai J1 terkejar
# 7 0 * * 1-5 /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-broksum.js --mode=weekday --only-foreign >> /home/ubuntu/auto-cuan-runner/logs/backfill-broksum-foreign.log 2>&1

# Backfill otomatis broker summary asing (Hari kerja slot 2: 19:30 WIB)
# DIJEDA 20261023 sampai J1 terkejar
# 30 19 * * 1-5 /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-broksum.js --mode=weekday --only-foreign >> /home/ubuntu/auto-cuan-runner/logs/backfill-broksum-foreign.log 2>&1

# Backfill otomatis broker summary asing (Akhir pekan: Sabtu & Minggu 00:07 WIB)
# DIJEDA 20261023 sampai J1 terkejar
# 7 0 * * 6,0 /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/backfill-broksum.js --mode=weekend --only-foreign >> /home/ubuntu/auto-cuan-runner/logs/backfill-broksum-foreign.log 2>&1

# C (2026-10-23): PENGECORAN TANGGAL BOLONG — Sabtu 24 Okt 00:07 WIB.
# Tidak ada J1/J2 di akhir pekan, jadi cadangan kecil (maks 1.500) saja.
# Urutan terbaru dulu (22, 21, 20, lalu sisa 19 Okt), batch 50, berhenti bila
# >20% gagal. Bila belum tuntas, jalankan lagi Minggu 00:07 (baris di bawah).
# 23 Okt ditambahkan (J1 23 Okt gagal: guard jam operasional memblokir broker-summary).
7 0 * * 6 bash /home/ubuntu/auto-cuan/deploy/vps/run-catchup-missing-dates.sh --dates 2026-10-23,2026-10-22,2026-10-21,2026-10-20,2026-10-19 --batch 50 >> /home/ubuntu/auto-cuan-runner/logs/catchup-missing-dates.log 2>&1
7 0 * * 0 bash /home/ubuntu/auto-cuan/deploy/vps/run-catchup-missing-dates.sh --dates 2026-10-23,2026-10-22,2026-10-21,2026-10-20,2026-10-19 --batch 50 >> /home/ubuntu/auto-cuan-runner/logs/catchup-missing-dates.log 2>&1

# Lifecycle evaluator (sore, setelah bursa tutup)
30 16 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-lifecycle-evaluator.sh --apply >> /home/ubuntu/auto-cuan-runner/logs/lifecycle-evaluator.log 2>&1

# ── CANDLE HARIAN 962 SAHAM (Yahoo + cek silang Arjum) — 2026-10-18 ───────
# Bursa tutup 16:00 WIB; bar final Yahoo lengkap ~16:20-16:30.
# Job ini WAJIB lewat wrapper run-daily-candles.sh (flock + env).
# IHSG selalu dari Arjum (1 request). Cek silang 20 saham (20 request).
# Diulang 23:30 WIB untuk menangkap koreksi/revisi bar Yahoo.
40 16 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-candles.sh >> /home/ubuntu/auto-cuan-runner/logs/daily-candles.log 2>&1
30 23 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-candles.sh >> /home/ubuntu/auto-cuan-runner/logs/daily-candles.log 2>&1

# ── IHSG MANDIRI (B5, 2026-10-20) — 1 request/hari, bebas fallback ────────
# Bar IHSG adalah anchor market-regime/breadth dan TIDAK boleh bergantung pada
# pass 962 saham (yang bisa bail-out saat cross-check gagal). Job ini terpisah:
# 1 request Arjum, idempoten (bar yang sudah ada tidak diambil lagi), dan
# MEMBERI PERINGATAN kalau bar hari bursa belum ada pada 17:30 WIB.
45 17 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-ihsg-candle.sh >> /home/ubuntu/auto-cuan-runner/logs/ihsg-candle.log 2>&1
30 23 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-ihsg-candle.sh >> /home/ubuntu/auto-cuan-runner/logs/ihsg-candle.log 2>&1

# ── EOD MARKET DATA / BROKSUM INGESTION (16:30-17:30 WIB) ─────────────────
# Window optimal: bursa tutup 16:00, KSEI merilis snapshot broker ~16:30-17:30.
# Tiap 15 menit di dalam window supaya tanggal yang belum lengkap bisa lanjut;
# coordinator tetap memeriksa kalender libur bursa (0 request saat libur).
# Pending dates durable dan resume pada hari bursa berikutnya.
30,45 16 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --accum-source=api --insider-mode=daily >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
0,15,30,45 17 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --accum-source=api --insider-mode=daily >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1
# Pass final terminal (bila masih ada yang pending) — 23:30 WIB, tetap 1x/hari.
30 23 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh --final --accum-source=api --insider-mode=daily >> /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log 2>&1

# ── KALKULASI AKUMULASI BANDAR (DINONAKTIFKAN — 2026-10-18) ───────────────
# J1 adalah single writer resmi ke data/arjum-data/broker-accumulation/ via API.
# Generator lokal J3 dinonaktifkan untuk mencegah race condition / double-write.
# 0 18 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-broker-accumulation.sh >> /home/ubuntu/auto-cuan-runner/logs/broker-accumulation.log 2>&1

# Afternoon recap (18:45 WIB) — dikirim SETELAH pasar tutup.
45 18 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-daily-afternoon-recap.sh --send >> /home/ubuntu/auto-cuan-runner/logs/daily-afternoon-recap.log 2>&1
# Landing refresh (22:15 WIB, harian)
15 22 * * * /home/ubuntu/.local/node-v22/bin/node /home/ubuntu/auto-cuan/tools/direct-refresh-landing.js >> /home/ubuntu/auto-cuan-runner/logs/landing-refresh.log 2>&1

# Suspension Guard IDX: refresh official suspend/unsuspend events every 15 minutes.
*/15 8-20 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-idx-suspension-guard.sh >> /home/ubuntu/auto-cuan-runner/logs/idx-suspension-guard.log 2>&1

# ── LIVE BURSA (Senin-Jumat, 09:00-16:00 WIB) ────────────────────────────
2,17,32,47 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-daytrade-producer.sh --execute >> /home/ubuntu/auto-cuan-runner/logs/daytrade-producer.log 2>&1
*/5 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-fastwatcher.sh --send >> /home/ubuntu/auto-cuan-runner/logs/fastwatcher.log 2>&1

# ── PRODUCER SCREENER (Full universe sweep via VPS daemon + Snapshot) ────
30 21 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-screeners-preflight.sh --execute --send >> /home/ubuntu/auto-cuan-runner/logs/screeners.log 2>&1

# ── END-OF-DAY / MALAM (Senin-Jumat, 21:30-22:15 WIB) ────────────────────
15 22 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-screener-dispatch.sh --dry-run >> /home/ubuntu/auto-cuan-runner/logs/screener-dispatch.log 2>&1

# BROKER HUNTER INDEX (B1, 2026-10-22) — 22:45 WIB, setelah J1 final.
# Membangun ulang data/broker-hunter-indexes/ dari broker-summary lokal yang
# sudah ditulis J1. Tidak memakai kuota Arjum (baca disk saja). Tanpa baris ini
# index tetap basi sejak 12 Sep, seperti sebelum perbaikan ini.
45 22 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-broker-hunter-indexer.sh >> /home/ubuntu/auto-cuan-runner/logs/broker-hunter-indexer.log 2>&1

# BACKLOG AGE ALARM (B3, 2026-10-22) — 19:45 WIB, setelah jendela EOD.
# Kalau antrean isi ulang H-1 lebih tua dari 24 jam DAN tidak berkurang, kirim
# SATU peringatan/hari ke Telegram admin + tulis state untuk Admin Console.
45 19 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-backlog-age-alarm.sh >> /home/ubuntu/auto-cuan-runner/logs/backlog-age-alarm.log 2>&1

# ── TELEGRAM DELIVERY RETRY WORKER (tiap 15 menit, 17:00-23:45 WIB) ──────
*/15 17-23 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-retry-telegram-delivery.sh --apply >> /home/ubuntu/auto-cuan-runner/logs/retry-telegram-delivery.log 2>&1

# ── SECTOR HOT — VPS LOCAL ONLY ──────────────────────────────────────────
*/30 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-sector-hot.sh --force-local >> /home/ubuntu/auto-cuan-runner/logs/sector-hot.log 2>&1

# ── ORACLE ANTI-SUSPEND KEEP-ALIVE (ringan, setiap jam) ──────────────────
# ── TELEGRAM MEMBER LIFECYCLE (Reminder, Review & Auto-kick — 02:15 WIB) ─────
15 2 * * * /home/ubuntu/auto-cuan/deploy/vps/run-telegram-lifecycle.sh --execute --kick-expired >> /home/ubuntu/auto-cuan-runner/logs/telegram-lifecycle.log 2>&1

0 * * * * /home/ubuntu/auto-cuan/deploy/vps/run-keepalive.sh >> /home/ubuntu/auto-cuan-runner/logs/keepalive.log 2>&1
*/5 * * * * /bin/bash /home/ubuntu/auto-cuan/deploy/vps/check-verify-poller.sh >> /home/ubuntu/auto-cuan-runner/logs/verify-poller-watchdog.log 2>&1

# END AUTO-CUAN FINAL SCHEDULE
```

---

<a name="tahap-12"></a>
## TAHAP 12: TABEL MASTER SELURUH BUG AKTUAL

| ID Bug & Keparahan | Area / Modul | File & Nomor Baris Eksak | Kutipan Kode Asli / Bukti Terminal Mentah | Akar Masalah & Dampak Nyata | Solusi Perbaikan (Rencana) |
|---|---|---|---|---|---|
| **BUG-01 (P0)** | Candle Fetcher (J2) | [`tools/fetch-daily-candles.js:308-329`](tools/fetch-daily-candles.js:308) | `if (summary.cross_check_failed && !allowMassFallback) { ... process.exitCode = 6; return deferred; }` | Cek silang 20 saham ke Arjum pada 16:40 WIB selalu gagal karena Arjum belum rilis EOD bar. Skrip keluar rc=6 dan membatalkan fetch Yahoo untuk SELURUH 962 saham hingga 23:30 WIB. | Pisahkan fetch Yahoo: ambil Yahoo dulu secara mandiri untuk 962 saham tanpa blokir; cek silang Arjum hanya audit pelengkap. |
| **BUG-02 (P0)** | Arjum Quota Catchup | [`tools/catchup-missing-dates.js:200-205`](tools/catchup-missing-dates.js:200) | `const union = Array.from(...); const batch = union.slice(0, opts.batch);` | Hanya mengambil 1 batch (50 saham) per tanggal, lalu berhenti. Menghabiskan 708 req dan membiarkan 17.372 req kuota harian menganggur. | Tambahkan outer loop `while (union.length > 0 && spent < budget.spendable)` untuk looping batch sampai kuota terpakai optimal. |
| **BUG-03 (P1)** | Arjum Quota Catchup | [`tools/catchup-missing-dates.js:240-255`](tools/catchup-missing-dates.js:240) | `writeDated(baseDir, 'broker-accumulation', ticker, p.date, res.data);` | Menembak endpoint Akumulasi & Insider untuk tanggal masa lalu (22, 21, 20, 19 Okt) padahal endpoint Arjum tidak punya parameter tanggal. Membakar 400 req sia-sia. | Hapus pemanggilan akumulasi & insider di catchup dates masa lalu; hanya panggil untuk broker-summary ALL & F. |
| **BUG-04 (P0)** | Broksum Flow Downstream | [`lib/bandarmologi-service.js:2080-2104`](lib/bandarmologi-service.js:2080) | `if (diskSummaryRaw && diskSummaryRaw.flow === cleanFlow)` | Ketika `computeDomestic` mengembalikan `data: null`, `normalizeBrokerSummary` menghasilkan `null`, menyebabkan `payload.broker_summary = null` dan error di UI pemanggil. | Tambahkan pengecekan validitas: jika `diskSummaryRaw.is_complete === false`, tangani fallback secara eksplisit agar payload UI tetap aman. |
| **BUG-05 (P1)** | Screener Foreign Flow | [`api/sector-hot.js:6386-6397`](api/sector-hot.js:6386) | `var dates = bandarmologiService.listDiskDates('broker-summary', clean); var raw = ...` | `buildFusionForeignFrame()` membaca folder `broker-summary` (ALL) bukan `broker-summary-F`. Nilai `foreign_net` menjadi null dan skor foreign flow 0. | Ubah path pembacaan ke `'broker-summary-F'`. |
| **BUG-06 (P1)** | Top 5 Web vs Telegram | [`api/sector-hot.js:8550-8558`](api/sector-hot.js:8550) | `if (cat === 'daytrade' || cat.indexOf('non_konglo') >= 0) return false;` | Web Top 5 membuang DayTrade dan Non-Konglo secara keras, sementara Telegram mengambil dari gabungan pool sehingga isi Top 5 tidak sinkron. | Sinkronkan aturan pool dan filter seleksi antara Web Dashboard dan Telegram notifier. |
| **BUG-07 (P1)** | Telegram Long-Polling | [`lib/telegram-interactive-bot.js`](lib/telegram-interactive-bot.js) | `poll_failed attempt=1 code=502 desc=Bad Gateway` / 410 restarts di PM2 | Error koneksi dan Bad Gateway Telegram tidak ditangkap dengan backoff terisolasi, menyebabkan proses crash dan PM2 restart ratusan kali. | Pasang try-catch wrapper dan sleep backoff pada polling loop tanpa melempar unhandled rejection. |
| **BUG-08 (P2)** | Telegram Escape V2 | [`lib/telegram-notifier.js:503`](lib/telegram-notifier.js:503) | `if (options.parse_mode === 'MarkdownV2' && options.auto_escape === true)` | `escapeMarkdownV2` berpotensi merusak pesan jika dipanggil di luar konteks MarkdownV2 murni karena mayoritas sistem menggunakan HTML/plain. | Standarisasi seluruh template ke HTML murni (`parse_mode: 'HTML'`) dan hapus dependensi ke MarkdownV2. |
| **BUG-09 (P1)** | Backfill Crontab | Crontab VPS baris 23, 27, 31 | `# DIJEDA 20261023 sampai J1 terkejar` | Tiga cron job backfill broker summary asing dikomentari, sehingga pemulihan data 2 Jan - 23 Okt 2026 berhenti total. | Buka kembali jadwal backfill dengan guard kuota dinamis yang menghormati floor 5.000 req J1. |
| **BUG-10 (P2)** | Insider Master Rebuild | [`tools/build-full-insider-network.js`](tools/build-full-insider-network.js) | Folder `data/insider-network/` terakhir disentuh 13 Oktober 2026 | Tidak ada jadwal cron untuk menjalankan `tools/build-full-insider-network.js` dan terdapat hardcoded dates (2026-09-08 dll.) di array anchors. | Jadwalkan kompilasi mingguan di crontab dan hapus anchor statis lama. |
| **BUG-11 (P1)** | DayTrade Universe | [`tools/run-daytrade-intraday-producer.js:87-100`](tools/run-daytrade-intraday-producer.js:87) | `const RUN_SPEEDS = new Set(['fast', 'full']);` (default: fast = 258) | Producer hanya memindai 258 saham pilihan di cron harian, mengabaikan ~540 saham likuid lainnya di bursa. | Aktifkan mode adaptif atau perluas universe fast ke seluruh 509 saham likuid. |
| **BUG-12 (P1)** | J1 EOD Quota Starvation | VPS `daily-market-update.log` 22 Okt | `Total Terpakai Hari Ini (lintas-proses): 17977 / 18080 ... [CIRCUIT BREAKER]` | Kuota habis dipakai backfill siang hari sebelum J1 berjalan, menyebabkan 475 saham kehilangan data EOD pada 22 Oktober 2026. | Terapkan hard reservation 5.000 request eksklusif untuk J1 sebelum jam 16:30 WIB. |

---
*Laporan ini dihasilkan secara deterministik dan berbasis 100% data fisik aktual di VPS.*
