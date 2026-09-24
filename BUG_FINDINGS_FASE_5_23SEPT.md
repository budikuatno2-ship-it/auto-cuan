# BUG FINDINGS — FASE 5 (23 SEPT 2026)

**Subsystem:** Akumulasi Broker Historis · Broker Hunter · Konsentrasi Multi-Day (Top 1 / Top 3 / Top 5)
**Metode:** Zero-trust forensic audit · test-first (FAIL → fix → PASS 2×)
**Hasil:** **7 temuan bug** dikonfirmasi, diperbaiki, dan diverifikasi

| ID | Judul | Modul | Severity |
|---|---|---|---|
| F5-01 | Agregasi multi-day dipalsukan dengan pengali sintetis (5/7, 14/7, ×2.0) | `bandarmologi-intel-service.js` | **KRITIS** |
| F5-01b | `target_dates` diganti jendela kalender sintetis | `bandarmologi-intel-service.js` | **TINGGI** |
| F5-02 | Tanggal duplikat diagregasi dua kali (*duplicate date aggregation*) | `bandarmologi-service.js` | **KRITIS** |
| F5-03 | Jendela "Riwayat Harian" 3D ditampilkan sebagai 24 hari | `bandarmologi-service.js` | **TINGGI** |
| F5-04 | Data tidak ada dilabeli `DISTRIBUTION` (verdict palsu) | `bandarmologi-service.js` | **TINGGI** |
| F5-05 | Feed string ribuan (`"1.500.000.000"`) merusak CR3/CR5 | `bandarmologi-intel-service.js` | **TINGGI** |
| F5-05b | CR5 tidak dapat "melihat" 5 broker (CR5 ≡ CR3) | `bandarmologi-intel-service.js` | **SEDANG** |
| F5-06 | Churning multi-day menghasilkan skor akumulasi semu | `bandarmologi-service.js` | **TINGGI** |
| F5-07 | Snapshot multi-day ditulis non-atomik (*torn read*) | `vps-data-fetcher.js` | **TINGGI** |

---

# F5-01 — Agregasi multi-day dipalsukan dengan pengali sintetis

## Severity: KRITIS

## Lokasi
`lib/bandarmologi-intel-service.js:163–191` (`getHunterTickerMap`)

## Bukti kode bermasalah

```js
let baseRange = '7d';
let scale = 1.0;
let targetDayCount = 7;
if (cleanRange === '1d') {
  baseRange = '1d'; scale = 1.0; targetDayCount = 1;
} else if (cleanRange === '5d') {
  baseRange = '7d';
  scale = 5 / 7;        // ← memalsukan agregat 5 hari
  targetDayCount = 5;
} else if (cleanRange === '7d') {
  baseRange = '7d'; scale = 1.0; targetDayCount = 7;
} else if (cleanRange === '14d') {
  baseRange = '7d';
  scale = 14 / 7;       // ← memalsukan agregat 14 hari
  targetDayCount = 14;
} else if (cleanRange === '30d') {
  baseRange = '30d'; scale = 1.0; targetDayCount = 30;
} else if (cleanRange === '60d') {
  baseRange = '30d';
  scale = 2.0;          // ← memalsukan agregat 60 hari
  targetDayCount = 60;
}
```

Nilai dipakai di 12 titik:

```js
const bVal = Math.round(Number(acc.buy_val || 0) * scale);
const sVal = Math.round(Number(acc.sell_val || 0) * scale);
const bVol = Math.round(Number(acc.buy_vol || 0) * scale);
const sVol = Math.round(Number(acc.sell_vol || 0) * scale);
const netVal = Math.round(Number(acc.net_val || 0) * scale);
const netVol = Math.round(Number(acc.net_vol || 0) * scale);
```

## Dampak riil
`getBrokersFromHunterIndexes()` adalah **sumber data konsentrasi** untuk `computeConcentrationRatios`, `detectPriceBelowBandarCost`, dan `detectRetailCutlossVsBandar`. Setiap permintaan range 5D/14D/60D menerima angka hasil perkalian satu jendela 7D/30D — bukan penjumlahan hari bursa nyata. Ini identik dengan kelas cacat "fabricated numbers" yang sudah diberantas di `applyMultiDayScaling` (Batch 1) tetapi lolos di modul ini.

## Bukti terukur (sebelum perbaikan)

```
=== H1: fabricated multi-day scaling in getHunterTickerMap ===
scale 5/7 present : true
scale 14/7 present: true
scale 2.0 present : true
7d top buyer val : 472500000000 dates: 7
5d top buyer val : 337500000000 ratio: 0.714286 (expect 5/7=0.714286 if fabricated)
14d top buyer val: 945000000000 ratio: 2.000000 (expect 2.0 if fabricated)
```

Rasio **0,714286** dan **2,000000** persis sama dengan pengali sumber. Bukan agregasi — melainkan rescale proporsional.

## Perbaikan (diff)

```diff
-  // Base range file to read from disk and proportionality scale factor
-  let baseRange = '7d';
-  let scale = 1.0;
-  let targetDayCount = 7;
-  if (cleanRange === '1d') {
-    baseRange = '1d';
-    scale = 1.0;
-    targetDayCount = 1;
-  } else if (cleanRange === '5d') {
-    baseRange = '7d';
-    scale = 5 / 7;
-    targetDayCount = 5;
-  } else if (cleanRange === '7d') {
-    baseRange = '7d';
-    scale = 1.0;
-    targetDayCount = 7;
-  } else if (cleanRange === '14d') {
-    baseRange = '7d';
-    scale = 14 / 7;
-    targetDayCount = 14;
-  } else if (cleanRange === '30d') {
-    baseRange = '30d';
-    scale = 1.0;
-    targetDayCount = 30;
-  } else if (cleanRange === '60d') {
-    baseRange = '30d';
-    scale = 2.0;
-    targetDayCount = 60;
-  }
+  // AUDIT-F5-01: which pre-aggregated index file backs each requested range.
+  //
+  // This used to borrow a WIDER file and multiply its figures by a synthetic
+  // constant (5/7 for 5D, 14/7 for 14D, 2.0 for 60D). That fabricated number
+  // was then presented as an "N-day aggregate": a 5D Top Broker list was
+  // literally 71.4% of the 7D list computed from the SAME target_dates, and a
+  // 60D figure was double the 30D figure — a proportional rescale, not an
+  // aggregate. Real multi-day totals come from summing real sessions
+  // (aggregateBrokerSummaries).
+  //
+  // Degradation when the requested range has no index of its own is now an
+  // honest one: read the nearest range that genuinely exists and report it
+  // verbatim (exposed via `data_range`), never a rescaled stand-in.
+  const RANGE_DAY_COUNT = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
+  const targetDayCount = RANGE_DAY_COUNT[cleanRange] || 7;
+
+  function indexFilesExist(rangeKey) {
+    try {
+      if (!fs.existsSync(BROKER_HUNTER_INDEX_DIR)) return false;
+      return fs.readdirSync(BROKER_HUNTER_INDEX_DIR).some(f => f.endsWith(`_${rangeKey}.json`));
+    } catch (_) {
+      return false;
+    }
+  }
+
+  let baseRange = cleanRange;
+  if (!indexFilesExist(baseRange)) {
+    // Prefer the closest available range, measured in days, so a 14D request
+    // lands on 7D rather than on an unrelated 30D window.
+    const available = Object.keys(RANGE_DAY_COUNT).filter(indexFilesExist);
+    if (available.length > 0) {
+      available.sort((a, b) => {
+        const da = Math.abs(RANGE_DAY_COUNT[a] - targetDayCount);
+        const db = Math.abs(RANGE_DAY_COUNT[b] - targetDayCount);
+        if (da !== db) return da - db;
+        return RANGE_DAY_COUNT[b] - RANGE_DAY_COUNT[a];
+      });
+      baseRange = available[0];
+    }
+  }
```

Seluruh 12 titik `* scale` diganti pembacaan verbatim dengan sanitasi numerik:

```diff
-          const bVal = Math.round(Number(acc.buy_val || 0) * scale);
-          const sVal = Math.round(Number(acc.sell_val || 0) * scale);
-          const bVol = Math.round(Number(acc.buy_vol || 0) * scale);
-          const sVol = Math.round(Number(acc.sell_vol || 0) * scale);
-          const netVal = Math.round(Number(acc.net_val || 0) * scale);
-          const netVol = Math.round(Number(acc.net_vol || 0) * scale);
-          const avgBuy = Number(acc.avg_buy_price || 0) || (bVal > 0 && bVol > 0 ? Math.round(bVal / (bVol * 100)) : 0);
+          // AUDIT-F5-01: values are read verbatim from this range's own index.
+          // No multiplier is ever applied — a rescaled window is not an aggregate.
+          const bVal = Math.round(toFeedNumber(acc.buy_val));
+          const sVal = Math.round(toFeedNumber(acc.sell_val));
+          const bVol = Math.round(toFeedNumber(acc.buy_vol));
+          const sVol = Math.round(toFeedNumber(acc.sell_vol));
+          const netVal = Math.round(toFeedNumber(acc.net_val));
+          const netVol = Math.round(toFeedNumber(acc.net_vol));
+          const avgBuy = toFeedNumber(acc.avg_buy_price) || (bVal > 0 && bVol > 0 ? Math.round(bVal / (bVol * 100)) : 0);
```

Transparansi range ditambahkan agar degradasi tidak tersamar:

```diff
+      // AUDIT-F5-01: the window these figures ACTUALLY came from. When the
+      // requested range had no index of its own the nearest real range backs
+      // the numbers, and consumers can tell the two apart instead of assuming
+      // a rescaled stand-in was the requested window.
+      data.data_range = baseRange;
```

```diff
   return {
     ticker: cleanTicker,
     range: cleanRange,
+    data_range: data.data_range || cleanRange,
+    range_is_exact: (data.data_range || cleanRange) === cleanRange,
     target_dates: data.target_dates || [],
```

## Test yang membuktikan

```js
test('F5-01: hunter index reader must not scale a base window by a fractional multiplier', () => {
  const source = fs.readFileSync(INTEL_SOURCE, 'utf8');

  assert.equal(/scale\s*=\s*5\s*\/\s*7/.test(source), false,
    'F5-01: getHunterTickerMap must not scale a 7d window by 5/7 to fake a 5d aggregate');
  assert.equal(/scale\s*=\s*14\s*\/\s*7/.test(source), false,
    'F5-01: getHunterTickerMap must not scale a 7d window by 14/7 to fake a 14d aggregate');
  assert.equal(/scale\s*=\s*2\.0/.test(source), false,
    'F5-01: getHunterTickerMap must not scale a 30d window by 2.0 to fake a 60d aggregate');

  const wide = intelService.getBrokersFromHunterIndexes('BBCA', '7d');
  const narrow = intelService.getBrokersFromHunterIndexes('BBCA', '5d');
  const wider = intelService.getBrokersFromHunterIndexes('BBCA', '14d');
  if (!wide || !Array.isArray(wide.top_buyers) || wide.top_buyers.length === 0) return;

  const wideVal = Number(wide.top_buyers[0].buy_val || 0);
  assert.ok(wideVal > 0, 'fixture sanity: 7d top buyer must carry a real value');

  for (const [label, data, forbiddenRatio] of [['5d', narrow, 5 / 7], ['14d', wider, 2.0]]) {
    if (!data || !Array.isArray(data.top_buyers) || data.top_buyers.length === 0) continue;
    const val = Number(data.top_buyers[0].buy_val || 0);
    if (!(val > 0)) continue;
    const ratio = val / wideVal;
    assert.equal(Math.abs(ratio - forbiddenRatio) > 0.001, true,
      `F5-01: ${label} value must not be the ${label} window fabricated as ${forbiddenRatio}x the 7d value (ratio=${ratio})`);
  }
});
```

## Output FAIL (sebelum perbaikan)

```
✖ F5-01: hunter index reader must not scale a base window by a fractional multiplier (5.1061ms)
  AssertionError [ERR_ASSERTION]: F5-01: getHunterTickerMap must not scale a 7d window by 5/7 to fake a 5d aggregate
  true !== false
      at TestContext.<anonymous> (d:\auto-cuan-2\test\audit-fase5-accumulation-bugs.test.js:77:10)
```

## Output PASS (setelah perbaikan)

```
✔ F5-01: hunter index reader must not scale a base window by a fractional multiplier (69.6288ms)
```

---

# F5-01b — `target_dates` diganti jendela kalender sintetis

## Severity: TINGGI

## Lokasi
`lib/bandarmologi-intel-service.js:283–285`

## Bukti kode bermasalah

```js
let finalDates = targetDates;
if (targetDates.length > targetDayCount) {
  finalDates = targetDates.slice(0, targetDayCount);
} else if (targetDates.length < targetDayCount && typeof bandarmologiService.getDynamicTradingDays === 'function') {
  finalDates = bandarmologiService.getDynamicTradingDays(targetDayCount);
}
```

## Dampak riil
Index yang hanya memuat 7 sesi namun diminta sebagai `14d` tetap mengiklankan `target_dates` berisi 14 tanggal hasil kalkulasi kalender — tanggal yang **tidak memiliki data** di baliknya. UI menampilkan rentang 14 hari padahal angka berasal dari 7 hari.

## Perbaikan (diff)

```diff
-    let finalDates = targetDates;
-    if (targetDates.length > targetDayCount) {
-      finalDates = targetDates.slice(0, targetDayCount);
-    } else if (targetDates.length < targetDayCount && typeof bandarmologiService.getDynamicTradingDays === 'function') {
-      finalDates = bandarmologiService.getDynamicTradingDays(targetDayCount);
-    }
+    // AUDIT-F5-01b: report only the sessions this range's own index covers.
+    // The old fallback swapped a short target_dates list for a synthetic
+    // N-day trading-calendar window, so a range whose index held 7 sessions
+    // advertised a 14- or 60-day window it had no data for.
+    let finalDates = targetDates;
+    if (targetDates.length > targetDayCount) {
+      finalDates = targetDates.slice(0, targetDayCount);
+    }
```

## Test yang membuktikan

```js
test('F5-01b: hunter index reader never invents a target_dates window it does not have', () => {
  const source = fs.readFileSync(INTEL_SOURCE, 'utf8');
  assert.equal(/targetDayCount\s*=\s*14/.test(source) && /scale\s*=\s*14\s*\/\s*7/.test(source), false,
    'F5-01b: a 14d window must be read from real 14d data, not relabelled from 7d');

  const wide = intelService.getBrokersFromHunterIndexes('BBCA', '14d');
  if (!wide) return;
  assert.ok(typeof wide.data_range === 'string' && wide.data_range,
    'F5-01b: the payload must expose which range actually backed the numbers');
  assert.equal(typeof wide.range_is_exact, 'boolean',
    'F5-01b: range_is_exact must tell the caller whether the request was honoured exactly');
  if (wide.data_range !== '14d') {
    assert.equal(wide.range_is_exact, false,
      'F5-01b: a degraded range must not claim to be exact');
  }
});

test('F5-01c: a degraded range reports real magnitudes, never a rescaled fraction', () => {
  const narrow = intelService.getBrokersFromHunterIndexes('BBCA', '5d');
  const wide = intelService.getBrokersFromHunterIndexes('BBCA', '7d');
  if (!narrow || !wide || !narrow.top_buyers || !narrow.top_buyers.length || !wide.top_buyers || !wide.top_buyers.length) return;

  if (narrow.data_range !== '5d') {
    assert.equal(narrow.top_buyers[0].buy_val, wide.top_buyers[0].buy_val,
      'F5-01c: a degraded range must return the backing range verbatim, not a proportional fraction');
  }
});
```

## Output FAIL (sebelum perbaikan)

```
✖ F5-01b: hunter index reader never invents a target_dates window it does not have (1.2263ms)
  AssertionError [ERR_ASSERTION]: F5-01b: a 14d window must be read from real 14d data, not relabelled from 7d
  true !== false
```

## Output PASS (setelah perbaikan)

```
✔ F5-01b: hunter index reader never invents a target_dates window it does not have (1.0606ms)
✔ F5-01c: a degraded range reports real magnitudes, never a rescaled fraction
```

---

# F5-02 — Tanggal duplikat diagregasi dua kali

## Severity: KRITIS

## Lokasi
`lib/bandarmologi-service.js:1494–1527` (`filterCalendarWindowDates`) dan `1529–1533` (`aggregateBrokerSummaries`)

## Bukti kode bermasalah

```js
function filterCalendarWindowDates(dates, numDays) {
  if (!Array.isArray(dates) || dates.length === 0) return [];
  const days = Number(numDays) || 7;
  const sorted = [...dates].filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)));
  // ← tidak ada de-duplikasi
```

Dan cabang custom-range melewati filter sepenuhnya:

```js
const validDates = isCustomRange ? dates : filterCalendarWindowDates(dates, reqDays);
const diskDates = (validDates || []).filter(d => hasDiskCache('broker-summary', ticker, d));
```

## Dampak riil
Pemanggil yang menggabungkan daftar tanggal dari kalender bursa dengan daftar tanggal dari disk dapat mengirim sesi yang sama dua kali. `aggregateBrokerSummaries` kemudian menjumlahkan `net_flow`, `bval`, `bvol`, dan `date_headers` sesi itu **dua kali** — menggelembungkan net flow, gross value, dan basis konsentrasi CR3/CR5 sebesar satu sesi penuh.

## Bukti terukur (sebelum perbaikan)

```
=== H2: duplicate-date aggregation (no dedupe) ===
filterCalendarWindowDates(dup) => ["2026-09-22","2026-09-22","2026-09-19"] len= 3 unique= 2
clean net_flow: 15000000000 headers: 3
dup   net_flow: 23000000000 headers: 3 (doubled if 2026-09-22 summed twice)
```

Sesi 2026-09-22 (10 M) dijumlahkan dua kali: `10 + 10 + 3 = 23 M` alih-alih `10 + 3 = 13 M`.

## Perbaikan (diff)

```diff
 function filterCalendarWindowDates(dates, numDays) {
   if (!Array.isArray(dates) || dates.length === 0) return [];
   const days = Number(numDays) || 7;
-  const sorted = [...dates].filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)));
+  // AUDIT-F5-02: de-duplicate before windowing. A caller that merged a
+  // calendar-derived list with a disk-derived list could hand the same session
+  // in twice, and aggregateBrokerSummaries then summed that day's flow twice —
+  // inflating net flow, gross value and the broker totals by a full session.
+  const seen = new Set();
+  const sorted = [];
+  for (const d of dates) {
+    if (!d) continue;
+    const key = String(d);
+    if (seen.has(key)) continue;
+    seen.add(key);
+    sorted.push(key);
+  }
+  sorted.sort((a, b) => String(b).localeCompare(String(a)));
   if (sorted.length === 0) return [];
```

```diff
 function aggregateBrokerSummaries(ticker, dates, requestedDays, isCustomRange = false) {
   const reqDays = Number(requestedDays || (dates && dates.length) || 7);
-  const validDates = isCustomRange ? dates : filterCalendarWindowDates(dates, reqDays);
+  // AUDIT-F5-02: the custom-range branch bypassed filterCalendarWindowDates,
+  // so a duplicated date in an explicit window was summed twice. De-duplicate
+  // the custom window too, preserving the caller's ordering.
+  let customDates = dates;
+  if (isCustomRange && Array.isArray(dates)) {
+    const seenCustom = new Set();
+    customDates = dates.filter(d => {
+      if (!d) return false;
+      const key = String(d);
+      if (seenCustom.has(key)) return false;
+      seenCustom.add(key);
+      return true;
+    });
+  }
+  const validDates = isCustomRange ? customDates : filterCalendarWindowDates(dates, reqDays);
   const diskDates = (validDates || []).filter(d => hasDiskCache('broker-summary', ticker, d));
```

## Test yang membuktikan

```js
test('F5-02: filterCalendarWindowDates must return each session at most once', () => {
  const duplicated = ['2026-09-22', '2026-09-22', '2026-09-19', '2026-09-18'];
  const window = service.filterCalendarWindowDates(duplicated, 3);

  assert.equal(new Set(window).size, window.length,
    `F5-02: duplicated input dates must be de-duplicated, got ${JSON.stringify(window)}`);
});

test('F5-02b: aggregateBrokerSummaries must not double-count a repeated date', () => {
  withTempDataDir((dir) => {
    const ticker = 'AUDITDUP';
    writeSummary(dir, ticker, '2026-09-22', 10000000000);
    writeSummary(dir, ticker, '2026-09-19', 3000000000);
    writeSummary(dir, ticker, '2026-09-18', 2000000000);

    const clean = service.aggregateBrokerSummaries(
      ticker, ['2026-09-22', '2026-09-19', '2026-09-18'], 3);
    const repeated = service.aggregateBrokerSummaries(
      ticker, ['2026-09-22', '2026-09-22', '2026-09-19'], 3);

    assert.ok(clean && repeated, 'both aggregations must produce a result');

    // 2026-09-22 (10bn) + 2026-09-19 (3bn) = 13bn. A repeated date must not
    // push it to 23bn by summing the same session twice.
    assert.equal(repeated.net_flow, 13000000000,
      `F5-02b: repeated date must be counted once, got net_flow=${repeated.net_flow}`);

    const dates = repeated.date_headers.map(h => h.date);
    assert.equal(new Set(dates).size, dates.length,
      `F5-02b: date_headers must not contain the same session twice, got ${JSON.stringify(dates)}`);
  });
});
```

## Output FAIL (sebelum perbaikan)

```
✖ F5-02: filterCalendarWindowDates must return each session at most once (24.3987ms)
  AssertionError [ERR_ASSERTION]: F5-02: duplicated input dates must be de-duplicated, got ["2026-09-22","2026-09-22","2026-09-19"]
  2 !== 3

✖ F5-02b: aggregateBrokerSummaries must not double-count a repeated date (75.3986ms)
  AssertionError [ERR_ASSERTION]: F5-02b: repeated date must be counted once, got net_flow=23000000000
  + actual - expected
  + 23000000000
  - 13000000000
```

## Output PASS (setelah perbaikan)

```
✔ F5-02: filterCalendarWindowDates must return each session at most once (16.2706ms)
✔ F5-02b: aggregateBrokerSummaries must not double-count a repeated date (34.004ms)
```

---

# F5-03 — Jendela "Riwayat Harian" 3D ditampilkan sebagai 24 hari

## Severity: TINGGI

## Lokasi
`lib/bandarmologi-service.js:2200–2208` (`getBandarmologiData`)

## Bukti kode bermasalah

```js
const dailySeries = buildDailyHistorySeries(ticker, 24);
if (!normSummary.date_headers || normSummary.date_headers.length < 24) {
  normSummary.date_headers = dailySeries;
}
if (normAcc) {
  if (!normAcc.series || normAcc.series.length < 24) {
    normAcc.series = dailySeries;
    normAcc.daily_summary = dailySeries;
  }
}
```

## Dampak riil
Setiap jendela yang lebih pendek dari 24 sesi **ditimpa** oleh deret 24 hari. Tabel "Riwayat Harian" lalu menampilkan 24 sesi di bawah label `"5 Hari Bursa"` — termasuk sesi di luar rentang yang diminta pengguna, yang bisa menyesatkan pembacaan akumulasi/distribusi.

## Bukti terukur (sebelum perbaikan)

```
=== H3: 3-day aggregation date_headers vs 24-day series overwrite ===
aggregateBrokerSummaries(3d).date_headers.length = 3
aggregateBrokerSummaries(3d).range_label = 3 Hari Bursa (2026-09-20 s/d 2026-09-22)
buildDailyHistorySeries(ticker,24).length = 24
date_headers BEFORE guard: 3 => AFTER guard: 24 (3D window silently replaced by 24 days of unrelated sessions)
first header after guard: 2026-08-30 | last: 2026-09-22
```

Dan pada jalur produksi nyata (`getBandarmologiData`):

```
forceRefresh=false: range_days=5 headers=24 status=- label="5 Hari Bursa (2026-09-18 s/d 2026-09-22)"
```

Label **"5 Hari Bursa"** dengan **24** `date_headers`.

## Perbaikan (diff)

```diff
-    const dailySeries = buildDailyHistorySeries(ticker, 24);
-    if (!normSummary.date_headers || normSummary.date_headers.length < 24) {
-      normSummary.date_headers = dailySeries;
-    }
-    if (normAcc) {
-      if (!normAcc.series || normAcc.series.length < 24) {
-        normAcc.series = dailySeries;
-        normAcc.daily_summary = dailySeries;
-      }
-    }
+    // AUDIT-F5-03: the "Riwayat Harian" window must stay inside the range the
+    // caller asked for. This guard used to replace ANY window shorter than 24
+    // sessions with the full 24-day history series, so a 5D request rendered a
+    // "5 Hari Bursa" label above 24 sessions of unrelated flow. The 24-day
+    // series is a fallback for a MISSING window, never a replacement for a
+    // shorter-but-valid one.
+    const dailySeries = buildDailyHistorySeries(ticker, 24);
+    if (!normSummary.date_headers || normSummary.date_headers.length === 0) {
+      normSummary.date_headers = dailySeries;
+    }
+    if (normAcc) {
+      if (!normAcc.series || normAcc.series.length === 0) {
+        normAcc.series = dailySeries;
+        normAcc.daily_summary = dailySeries;
+      }
+    }
```

## Test yang membuktikan

```js
test('F5-03b: getBandarmologiData must keep the requested window for date_headers', async () => {
  const ticker = 'AUDITWIN2';
  await withTempDataDirAsync(async (dir) => {
    const dates = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.UTC(2026, 8, 22));
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    for (let i = 0; i < dates.length; i++) {
      writeSummary(dir, ticker, dates[i], 1000000000 * (i + 1));
    }

    const res = await service.getBandarmologiData(ticker, { range: '5d', days: 5 });
    const bs = res && res.broker_summary;
    assert.ok(bs, 'a broker_summary must be produced');
    assert.equal(bs.range_days, 5, 'a 5D request over 30 on-disk sessions must aggregate exactly 5');
    assert.ok(Array.isArray(bs.date_headers), 'date_headers must be present for a multi-day window');
    assert.equal(bs.date_headers.length, 5,
      `F5-03b: date_headers must cover the requested 5 sessions, got ${bs.date_headers.length}`);
  });
});
```

## Output PASS (setelah perbaikan)

```
✔ F5-03: a short requested window must not be replaced by a 24-day history series (205.6785ms)
✔ F5-03b: getBandarmologiData must keep the requested window for date_headers (1848.253ms)
```

---

# F5-04 — Data tidak ada dilabeli `DISTRIBUTION`

## Severity: TINGGI

## Lokasi
`lib/bandarmologi-service.js:1337` (`normalizeBrokerAccumulation`) dan `1192` (`synthesizeAccumulationFromSummary`)

## Bukti kode bermasalah

```js
return {
  ticker: raw.code || ticker,
  accumulation_score: raw.accumulation_score != null ? raw.accumulation_score : null,
  status: dailySeries.length > 0 && dailySeries[dailySeries.length - 1].net_val >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
  ...
```

Ketika `dailySeries.length === 0`, kondisi pertama bernilai `false` sehingga status jatuh ke `'DISTRIBUTION'`. Payload `null` bahkan lebih buruk:

```js
if (!raw) return { ticker, series: [], daily_summary: [], top_buyers: [], top_sellers: [], net_buyers: [], net_sellers: [] };
// ← tidak ada properti `status` sama sekali
```

## Dampak riil
Saham tanpa data akumulasi (suspend, FCA, hari libur) dilaporkan sebagai **DISTRIBUTION** — verdikt palsu dari ketiadaan data. Ini kelas cacat yang sama dengan F-070 (fabricated CR denominator) yang sudah diperbaiki di modul konsentrasi tetapi lolos di modul akumulasi.

## Bukti terukur (sebelum perbaikan)

```
=== H4: empty accumulation series labelled DISTRIBUTION ===
series len: 0 => status: DISTRIBUTION (fabricated DISTRIBUTION if no data)
null payload => status: undefined
```

## Perbaikan (diff)

```diff
 function normalizeBrokerAccumulation(raw, ticker) {
-  if (!raw) return { ticker, series: [], daily_summary: [], top_buyers: [], top_sellers: [], net_buyers: [], net_sellers: [] };
+  // AUDIT-F5-04: a null payload is NO_DATA, not DISTRIBUTION — the empty
+  // structure must still carry the honest status for downstream consumers.
+  if (!raw) return {
+    ticker,
+    status: 'NO_DATA',
+    accumulation_score: null,
+    series: [],
+    daily_summary: [],
+    top_buyers: [],
+    top_sellers: [],
+    net_buyers: [],
+    net_sellers: []
+  };
```

```diff
-  return {
-    ticker: raw.code || ticker,
-    accumulation_score: raw.accumulation_score != null ? raw.accumulation_score : null,
-    status: dailySeries.length > 0 && dailySeries[dailySeries.length - 1].net_val >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
-    series: dailySeries.slice(-24),
-    top_buyers: topBuyers,
-    top_sellers: topSellers,
-    net_buyers: topBuyers,
-    net_sellers: topSellers
-  };
+  // AUDIT-F5-04: absent data must never become a verdict. A payload with no
+  // usable series previously reported DISTRIBUTION purely because
+  // dailySeries.length === 0 made the condition false — a status invented from
+  // missing input. NO_DATA is the honest answer; a real series still resolves
+  // from its latest session's net flow.
+  let accStatus;
+  if (dailySeries.length === 0) accStatus = 'NO_DATA';
+  else {
+    const latestNet = dailySeries[dailySeries.length - 1].net_val || 0;
+    accStatus = latestNet > 0 ? 'ACCUMULATION' : (latestNet < 0 ? 'DISTRIBUTION' : 'NEUTRAL');
+  }
+
+  return {
+    ticker: raw.code || ticker,
+    accumulation_score: raw.accumulation_score != null ? raw.accumulation_score : null,
+    status: accStatus,
+    series: dailySeries.slice(-24),
+    top_buyers: topBuyers,
+    top_sellers: topSellers,
+    net_buyers: topBuyers,
+    net_sellers: topSellers
+  };
 }
```

Status per-hari juga diisi dari magnitudo nyata:

```diff
     const cleanSeries = (raw.series || []).map(s => {
       const copy = Object.assign({}, s);
       if (copy.net_val != null && Math.abs(copy.net_val) >= 5e11) {
         copy.net_val = Math.round(copy.net_val / 100);
       }
+      // AUDIT-F5-04: each session carries its own verdict. The upstream payload
+      // supplies only net_val here, so derive the per-day status from that real
+      // magnitude instead of leaving it undefined in the history table.
+      if (!copy.status) {
+        const net = Number(copy.net_val || 0);
+        copy.status = net > 0 ? 'ACC' : (net < 0 ? 'DIST' : 'NEUTRAL');
+      }
       return copy;
     });
```

## Test yang membuktikan

```js
test('F5-04: an accumulation payload without a series must not be labelled DISTRIBUTION', () => {
  const empty = service.normalizeBrokerAccumulation({ series: [], top_buyers: [], top_sellers: [] }, 'AUDITNOACC');

  assert.equal(empty.status, 'NO_DATA',
    `F5-04: no series => no verdict, got status=${empty.status}`);
  assert.equal(empty.accumulation_score, null,
    'F5-04: an unverifiable payload must not carry a numeric score');

  const nullPayload = service.normalizeBrokerAccumulation(null, 'AUDITNOACC');
  assert.equal(nullPayload.status, 'NO_DATA',
    `F5-04: null payload => NO_DATA, got status=${nullPayload.status}`);
});

test('F5-04b: a real distribution series is still labelled DISTRIBUTION', () => {
  const raw = {
    series: [
      { date: '2026-09-22', net_val: -42000000000 },
      { date: '2026-09-19', net_val: -11000000000 }
    ],
    net_buyers: [{ broker: 'YP', nval: 1000000000, bval: 5000000000, sval: 4000000000 }],
    net_sellers: [{ broker: 'XC', nval: -53000000000, bval: 1000000000, sval: 54000000000 }]
  };
  const norm = service.normalizeBrokerAccumulation(raw, 'AUDITDIST');
  assert.equal(norm.status, 'DISTRIBUTION', 'a genuinely negative series must still read DISTRIBUTION');
  assert.equal(norm.series[norm.series.length - 1].status, 'DIST');
});
```

## Output FAIL (sebelum perbaikan)

```
✖ F5-04: an accumulation payload without a series must not be labelled DISTRIBUTION (1.5821ms)
  AssertionError [ERR_ASSERTION]: F5-04: no series => no verdict, got status=DISTRIBUTION
  actual: 'DISTRIBUTION', expected: 'NO_DATA'

✖ F5-04b: a real distribution series is still labelled DISTRIBUTION (0.7744ms)
  AssertionError [ERR_ASSERTION]: a genuinely negative series must still read DISTRIBUTION
  actual: undefined, expected: 'DISTRIBUTION'
```

## Output PASS (setelah perbaikan)

```
✔ F5-04: an accumulation payload without a series must not be labelled DISTRIBUTION (0.8881ms)
✔ F5-04b: a real distribution series is still labelled DISTRIBUTION (0.4567ms)
```

---

# F5-05 — Feed string ribuan merusak CR3/CR5

## Severity: TINGGI

## Lokasi
`lib/bandarmologi-intel-service.js:1149–1182` (`computeConcentrationRatios`)

## Bukti kode bermasalah

```js
for (let i = 0; i < Math.min(3, buyers.length); i++) {
  top3Val += Number(buyers[i].bval || buyers[i].buy_val || buyers[i].val || 0);
  top3Vol += Number(buyers[i].bvol || buyers[i].buy_vol || buyers[i].vol || 0);
}
...
let totalBuyVol = buyers.reduce((sum, b) => sum + Number(b.bvol || b.buy_vol || b.vol || 0), 0);
...
let totalTurnover = allBrokers.reduce((acc, b) => acc + Number(b.bval || b.buy_val || 0), 0);
```

`Number("1.500.000.000")` → **NaN**. Seluruh rantai konsentrasi kolaps: `top3Val = NaN` → `top3Val > 0` bernilai `false` → CR tidak pernah dihitung → `cr_basis` `undefined` dan `reason: 'TURNOVER_UNAVAILABLE'`, meskipun feed membawa angka lengkap.

Ini persis kelas cacat yang sudah dibereskan di Fase 4 (`AUDIT-F4-10/11/12`, helper `toNumberLoose`) tetapi **tidak pernah diterapkan** pada modul konsentrasi.

## Bukti terukur (sebelum perbaikan)

```
=== H5: intel CR3 raw Number() vs thousand-separated feed ===
cr3: null cr5: null basis: undefined reason: TURNOVER_UNAVAILABLE
top_3_val: NaN total_turnover: null (NaN => real data silently discarded)
raw Number("1.500.000.000.000") = NaN
typeof svc.toNumberLoose = undefined
```

## Perbaikan (diff)

Helper baru (mirror `toNumberLoose` dari `bandarmologi-service.js`, sehingga kedua belahan pipeline menerima tata bahasa input yang identik):

```diff
+/**
+ * AUDIT-F5-05: the Arjum/VPS broker feed may deliver a magnitude as a plain
+ * number, a plain string ("1500000000"), an Indonesian thousand-separated
+ * string ("1.500.000.000"), a comma-thousands string ("1,500,000,000") or an
+ * Indonesian comma-decimal ("1500,25"). A raw Number() returns NaN for every
+ * localised form, which silently destroyed real turnover data: top_3_val
+ * became NaN and the whole CR3/CR5 signal degraded to TURNOVER_UNAVAILABLE
+ * even though the feed carried complete figures.
+ *
+ * Mirrors bandarmologi-service.toNumberLoose so both halves of the
+ * bandarmologi pipeline accept exactly the same input grammar. Returns 0 for
+ * anything genuinely unparseable so callers can keep their arithmetic total
+ * (never NaN).
+ */
+function toFeedNumber(value) {
+  if (value == null || value === '') return 0;
+  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
+  if (typeof value === 'boolean') return value ? 1 : 0;
+  if (typeof value !== 'string') return 0;
+
+  let s = value.trim();
+  if (!s || s === '-' || s === '—' || s === '–') return 0;
+
+  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
+  s = s.replace(/^\(/, '').replace(/\)$/, '');
+  s = s.replace(/[Rprp](?=[\s.\d,])/g, '').replace(/[%+\s]/g, '');
+  if (!s) return 0;
+
+  const hasDot = s.indexOf('.') >= 0;
+  const hasComma = s.indexOf(',') >= 0;
+  if (hasDot && hasComma) {
+    // The last separator encountered is the decimal separator.
+    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
+      s = s.replace(/\./g, '').replace(',', '.');
+    } else {
+      s = s.replace(/,/g, '');
+    }
+  } else if (hasComma) {
+    // "1,500,000" => thousands; "1500,25" => Indonesian decimal comma.
+    if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
+    else s = s.replace(',', '.');
+  } else if (hasDot) {
+    // "1.500.000" => Indonesian thousands; "1500.25" => decimal point.
+    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
+  }
+
+  s = s.replace(/[^\d.eE+-]/g, '');
+  if (!s) return 0;
+  const n = Number(s);
+  if (!Number.isFinite(n)) return 0;
+  return negative && n > 0 ? -n : n;
+}
```

Diterapkan pada seluruh pembacaan magnitudo:

```diff
-  let top3Val = 0;
-  let top3Vol = 0;
-  for (let i = 0; i < Math.min(3, buyers.length); i++) {
-    top3Val += Number(buyers[i].bval || buyers[i].buy_val || buyers[i].val || 0);
-    top3Vol += Number(buyers[i].bvol || buyers[i].buy_vol || buyers[i].vol || 0);
-  }
-
-  let top5Val = 0;
-  let top5Vol = 0;
-  for (let i = 0; i < Math.min(5, buyers.length); i++) {
-    top5Val += Number(buyers[i].bval || buyers[i].buy_val || buyers[i].val || 0);
-    top5Vol += Number(buyers[i].bvol || buyers[i].buy_vol || buyers[i].vol || 0);
-  }
-
-  let totalBuyVol = buyers.reduce((sum, b) => sum + Number(b.bvol || b.buy_vol || b.vol || 0), 0);
-  if (norm.total_volume && Number(norm.total_volume) > totalBuyVol) {
-    totalBuyVol = Number(norm.total_volume);
-  }
+  // AUDIT-F5-05: every magnitude goes through toFeedNumber() so a localised
+  // ("1.500.000.000") or plain-string feed yields the same CR as a numeric one
+  // instead of collapsing the whole signal to NaN.
+  let top3Val = 0;
+  let top3Vol = 0;
+  for (let i = 0; i < Math.min(3, buyers.length); i++) {
+    top3Val += toFeedNumber(buyers[i].bval != null ? buyers[i].bval : (buyers[i].buy_val != null ? buyers[i].buy_val : buyers[i].val));
+    top3Vol += toFeedNumber(buyers[i].bvol != null ? buyers[i].bvol : (buyers[i].buy_vol != null ? buyers[i].buy_vol : buyers[i].vol));
+  }
+
+  let top5Val = 0;
+  let top5Vol = 0;
+  for (let i = 0; i < Math.min(5, buyers.length); i++) {
+    top5Val += toFeedNumber(buyers[i].bval != null ? buyers[i].bval : (buyers[i].buy_val != null ? buyers[i].buy_val : buyers[i].val));
+    top5Vol += toFeedNumber(buyers[i].bvol != null ? buyers[i].bvol : (buyers[i].buy_vol != null ? buyers[i].buy_vol : buyers[i].vol));
+  }
+
+  let totalBuyVol = buyers.reduce((sum, b) => sum + toFeedNumber(b.bvol != null ? b.bvol : (b.buy_vol != null ? b.buy_vol : b.vol)), 0);
+  const normTotalVolume = toFeedNumber(norm.total_volume);
+  if (normTotalVolume > totalBuyVol) {
+    totalBuyVol = normTotalVolume;
+  }
```

```diff
-  let totalTurnover = allBrokers.reduce((acc, b) => acc + Number(b.bval || b.buy_val || 0), 0);
-  if (totalTurnover <= 0) {
-    totalTurnover = Number(norm.total_turnover || norm.turnover || norm.total_buy_val || norm.total_value || 0);
-  } else if (norm.total_turnover && Number(norm.total_turnover) > totalTurnover) {
-    totalTurnover = Number(norm.total_turnover);
-  }
+  let totalTurnover = allBrokers.reduce(
+    (acc, b) => acc + toFeedNumber(b.bval != null ? b.bval : b.buy_val), 0);
+  if (totalTurnover <= 0) {
+    totalTurnover = toFeedNumber(norm.total_turnover != null ? norm.total_turnover
+      : (norm.turnover != null ? norm.turnover
+        : (norm.total_buy_val != null ? norm.total_buy_val : norm.total_value)));
+  } else {
+    const declaredTurnover = toFeedNumber(norm.total_turnover);
+    if (declaredTurnover > totalTurnover) totalTurnover = declaredTurnover;
+  }
```

## Test yang membuktikan

```js
test('F5-05: concentration ratios must sanitise thousand-separated feed values', () => {
  const feed = {
    top_buyers: [
      { broker: 'YP', bval: '1.500.000.000.000', bvol: '10.000.000', net_val: '1.500.000.000.000' },
      { broker: 'CC', bval: '1.000.000.000.000', bvol: '7.000.000', net_val: '1.000.000.000.000' },
      { broker: 'BK', bval: '500.000.000.000', bvol: '3.000.000', net_val: '500.000.000.000' }
    ],
    gross_buyers: [ /* + XC 1.0e12, NI 1.0e12 */ ],
    total_turnover: '6.000.000.000.000',
    total_volume: '32.000.000'
  };

  const res = intelService.computeConcentrationRatios('AUDITSTRFEED', { brokerSummary: feed, range: '7d' });

  assert.equal(Number.isFinite(res.top_3_val), true,
    `F5-05: top_3_val must be a finite number, got ${res.top_3_val}`);
  assert.equal(res.top_3_val, 3000000000000, ...);
  assert.equal(res.top_5_val, 5000000000000, ...);
  assert.notEqual(res.cr5, res.cr3, 'F5-05: a 5-broker feed must not collapse CR5 onto the CR3 figure');
  assert.equal(res.cr_basis, 'VALUE', ...);
  assert.equal(res.cr3, 50, `F5-05: 3.0e12 / 6e12 = 50%, got ${res.cr3}`);
  assert.equal(res.cr5, 83.33, `F5-05: 5e12 / 6e12 = 83.33%, got ${res.cr5}`);
  assert.equal(res.total_turnover, 6000000000000, ...);
  assert.equal(res.triggered, true, 'F5-05: CR3 50% must trigger the concentration signal');
});

test('F5-05b: comma-decimal and plain-string feed forms parse identically', () => {
  // ... plain "1500000000000" vs id-ID toLocaleString "1.500.000.000.000"
  assert.equal(dotForm.cr3, commaForm.cr3,
    `F5-05b: "1.500.000.000.000" and "1500000000000" must yield the same CR3 (${dotForm.cr3} vs ${commaForm.cr3})`);
  assert.equal(dotForm.cr_basis, 'VALUE', 'F5-05b: the localised form must still resolve to a VALUE basis');
});
```

## Output FAIL (sebelum perbaikan)

```
✖ F5-05: concentration ratios must sanitise thousand-separated feed values (1.5073ms)
  AssertionError [ERR_ASSERTION]: F5-05: top_3_val must be a finite number, got NaN
  false !== true

✖ F5-05b: comma-decimal and plain-string feed forms parse identically (12.7723ms)
  AssertionError [ERR_ASSERTION]: F5-05b: "1.500.000.000.000" and "1500000000000" must yield the same CR3 (null vs 50)
  null !== 50
```

## Output PASS (setelah perbaikan)

```
✔ F5-05: concentration ratios must sanitise thousand-separated feed values (1.695ms)
✔ F5-05b: comma-decimal and plain-string feed forms parse identically (11.5781ms)
```

---

# F5-05b — CR5 tidak dapat "melihat" 5 broker (CR5 ≡ CR3)

## Severity: SEDANG

## Lokasi
`lib/bandarmologi-intel-service.js:1145–1147`

## Bukti kode bermasalah

```js
const buyers = (Array.isArray(norm.top_buyers) && norm.top_buyers.length > 0)
  ? norm.top_buyers
  : (norm.gross_buyers || []);
```

`norm.top_buyers` adalah daftar **Top-3 net buyer**. Ketika feed hanya membawa tiga net buyer (kasus umum), `Math.min(5, buyers.length)` = 3 sehingga `top5Val === top3Val` dan **CR5 identik dengan CR3**. Konsentrasi "Top 5" kehilangan makna sepenuhnya.

## Perbaikan (diff)

```diff
-  const buyers = (Array.isArray(norm.top_buyers) && norm.top_buyers.length > 0)
-    ? norm.top_buyers
-    : (norm.gross_buyers || []);
+  // AUDIT-F5-05b: the Top-5 concentration must be able to SEE five brokers.
+  //
+  // `top_buyers` is a Top-3 net-buyer list, so ranking CR5 off it alone capped
+  // CR5 at CR3 — a "Top 5" figure mathematically identical to the Top 3 figure
+  // even when the feed carried five genuine net accumulators.
+  //
+  // The Top-3 ranking is left EXACTLY as the upstream feed ordered it (the
+  // long-standing contract, and what keeps cross-trade/churn brokers excluded
+  // per AUDIT-F4-13). Ranks 4-5 are filled from gross_buyers, but only with
+  // brokers that carry a genuinely positive net — so a churning broker that
+  // nets to zero can never inflate the CR5 basis.
+  const buyers = (Array.isArray(norm.top_buyers) && norm.top_buyers.length > 0)
+    ? norm.top_buyers.slice()
+    : (Array.isArray(norm.gross_buyers) ? norm.gross_buyers.slice() : []);
+  if (buyers.length > 0 && buyers.length < 5 && Array.isArray(norm.gross_buyers)) {
+    const seenBuyerCodes = new Set(buyers.map(b => String((b && (b.broker || b.broker_code)) || '').trim().toUpperCase()));
+    for (const row of norm.gross_buyers) {
+      if (buyers.length >= 5) break;
+      const code = String((row && (row.broker || row.broker_code)) || '').trim().toUpperCase();
+      if (!code || seenBuyerCodes.has(code)) continue;
+      const rowNet = toFeedNumber(row.net_val != null ? row.net_val
+        : (row.nval != null ? row.nval
+          : (toFeedNumber(row.bval != null ? row.bval : row.buy_val)
+            - toFeedNumber(row.sval != null ? row.sval : row.sell_val))));
+      if (rowNet <= 0) continue; // churn / net seller never joins the buyer ranking
+      seenBuyerCodes.add(code);
+      buyers.push(row);
+    }
+  }
```

**Catatan regresi:** versi pertama perbaikan ini mengurutkan ulang seluruh daftar berdasarkan `buy_val`, yang memecah kontrak Top-3 (`bandarmologi-intel.test.js` S4MASSIVE mengharapkan CR3 = 70, bukan 80) dan membuat broker churn net-0 masuk ranking (`audit-fase4-broksum-bugs.test.js` CROSSTRD). Versi final mempertahankan urutan Top-3 dari feed dan hanya **menambahkan** rank 4–5 dengan filter `rowNet > 0`.

## Output PASS (setelah perbaikan)

```
✔ F5-05: concentration ratios must sanitise thousand-separated feed values (1.695ms)
```

Terverifikasi: `cr3 = 50`, `cr5 = 83.33` — CR5 kini mencerminkan lima broker nyata, bukan salinan CR3.

---

# F5-06 — Churning multi-day menghasilkan skor akumulasi semu

## Severity: TINGGI

## Lokasi
`lib/bandarmologi-service.js:1178–1199` (`synthesizeAccumulationFromSummary`)

## Bukti kode bermasalah

```js
const grossVal = finalBuyers.reduce((s, b) => s + Math.abs(Number(b.bval || b.buy_val || 0)), 0)
  + finalSellers.reduce((s, b) => s + Math.abs(Number(b.sval || b.sell_val || 0)), 0);
const accDays = series.filter(d => (d.net_val || 0) > 0).length;
const accumulationScore = (grossVal > 0 && series.length > 0)
  ? Math.round(Math.min(100, Math.max(0,
      50 + (netFlow / grossVal) * 50 + ((accDays / series.length) - 0.5) * 20)))
  : null;

return {
  ...
  status: netFlow >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
```

Perhatikan `status: netFlow >= 0 ? 'ACCUMULATION'`. Ketika `netFlow === 0` (churn sempurna), kondisi `>= 0` bernilai **true** → dilabeli `ACCUMULATION`. Ini persis kasus "perpindahan barang semu (churning multi-day)" yang disebut checklist.

Skor juga ikut tercemar: `(accDays / series.length) - 0.5) * 20` memberi bonus ketika hari-hari net-0 dihitung sebagai `ACC` (karena `(d.net_val || 0) > 0` bernilai `false` untuk 0, tetapi `netFlow/grossVal = 0` menyisakan basis 50, dan `accDays` bisa > 0 dari hari positif minor).

## Bukti terukur (sebelum perbaikan)

```
=== H6: accumulation score / status consistency ===
churn-only summary => status: ACCUMULATION score: null net_buyers: 2 net_sellers: 2
multi-day churn (net 0, 5 days) => status: ACCUMULATION score: 40 series len: 5
```

Churn net-0 selama 5 hari bursa menghasilkan **status `ACCUMULATION`** dan **skor 40**.

## Perbaikan (diff)

```diff
   const grossVal = finalBuyers.reduce((s, b) => s + Math.abs(Number(b.bval || b.buy_val || 0)), 0)
     + finalSellers.reduce((s, b) => s + Math.abs(Number(b.sval || b.sell_val || 0)), 0);
   const accDays = series.filter(d => (d.net_val || 0) > 0).length;
-  const accumulationScore = (grossVal > 0 && series.length > 0)
+  // AUDIT-F5-06: a churning book must never score as accumulation. When the
+  // same brokers trade the same size both ways across the window, net flow
+  // collapses to ~0 while gross value stays huge — that is "tukar barang",
+  // not accumulation. Detect it from the real net/gross ratio so the score
+  // is withheld (null) instead of rewarded.
+  const absNetFlow = Math.abs(netFlow);
+  const isChurn = grossVal > 0 && absNetFlow < grossVal * 0.01;
+  const accumulationScore = (grossVal > 0 && series.length > 0 && !isChurn)
     ? Math.round(Math.min(100, Math.max(0,
         50 + (netFlow / grossVal) * 50 + ((accDays / series.length) - 0.5) * 20)))
     : null;

+  // AUDIT-F5-06: status must describe the data that exists. A book with real
+  // broker rows whose net cancels out is NEUTRAL; only a payload with neither a
+  // series nor any broker rows is genuinely NO_DATA.
+  const hasBrokerRows = finalBuyers.length > 0 || finalSellers.length > 0;
+  let status;
+  if (series.length === 0 && !hasBrokerRows) status = 'NO_DATA';
+  else if (isChurn || netFlow === 0) status = 'NEUTRAL';
+  else status = netFlow > 0 ? 'ACCUMULATION' : 'DISTRIBUTION';
+
   return {
     ticker: ticker,
     accumulation_score: accumulationScore,
-    status: netFlow >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
+    status,
+    is_churn: isChurn,
     series,
```

## Test yang membuktikan

```js
test('F5-06: a pure churn book must be flagged instead of scoring as accumulation', () => {
  // Broker trades the same size both ways for five sessions: gross is huge,
  // net is zero. This is "tukar barang", not accumulation.
  const churn = {
    date: '2026-09-22',
    net_flow: 0,
    gross_buyers: [
      { broker: 'YP', bval: 100000000000, sval: 100000000000, nval: 0 },
      { broker: 'CC', bval: 90000000000, sval: 90000000000, nval: 0 }
    ],
    gross_sellers: [
      { broker: 'YP', bval: 100000000000, sval: 100000000000, nval: 0 },
      { broker: 'CC', bval: 90000000000, sval: 90000000000, nval: 0 }
    ],
    net_buyers: [],
    net_sellers: []
  };

  const res = service.synthesizeAccumulationFromSummary(churn, 'AUDITCHURN');

  assert.notEqual(res.status, 'ACCUMULATION',
    'F5-06: a zero-net churn book must never be reported as ACCUMULATION');
  assert.equal(res.status, 'NEUTRAL',
    `F5-06: a zero-net book is NEUTRAL, got ${res.status}`);

  const score = res.accumulation_score;
  assert.equal(score, null,
    `F5-06: a zero-net churn book must not earn a numeric accumulation score, got ${score}`);
});

test('F5-06b: genuine net accumulation still scores above neutral', () => {
  const acc = {
    date: '2026-09-22',
    net_flow: 40000000000,
    gross_buyers: [
      { broker: 'YP', bval: 60000000000, sval: 10000000000, nval: 50000000000 },
      { broker: 'CC', bval: 30000000000, sval: 20000000000, nval: 10000000000 }
    ],
    gross_sellers: [
      { broker: 'XC', bval: 5000000000, sval: 25000000000, nval: -20000000000 }
    ],
    net_buyers: [{ broker: 'YP', bval: 60000000000, sval: 10000000000, nval: 50000000000 }],
    net_sellers: [{ broker: 'XC', bval: 5000000000, sval: 25000000000, nval: -20000000000 }]
  };

  const res = service.synthesizeAccumulationFromSummary(acc, 'AUDITACC');
  assert.equal(res.status, 'ACCUMULATION', 'a genuinely positive net book reads ACCUMULATION');
  assert.ok(res.accumulation_score != null && res.accumulation_score > 50,
    `F5-06b: real net accumulation must score above the 50 midpoint, got ${res.accumulation_score}`);
});
```

## Output FAIL (sebelum perbaikan)

```
✖ F5-06: a pure churn book must be flagged instead of scoring as accumulation (0.8887ms)
  AssertionError [ERR_ASSERTION]: F5-06: a zero-net churn book must never be reported as ACCUMULATION
  actual: 'ACCUMULATION', expected: 'ACCUMULATION', operator: 'notStrictEqual'
```

## Output PASS (setelah perbaikan)

```
✔ F5-06: a pure churn book must be flagged instead of scoring as accumulation (0.6204ms)
✔ F5-06b: genuine net accumulation still scores above neutral (0.3416ms)
```

---

# F5-07 — Snapshot multi-day ditulis non-atomik (*torn read*)

## Severity: TINGGI

## Lokasi
`lib/vps-data-fetcher.js` — 7 titik tulis pada jalur snapshot

## Bukti kode bermasalah

```js
// fetchBrokerHunterFromVpsSync — index hunter
const localPath = path.join(localIndexDir, `${safeBroker}_${safeRange}.json`);
fs.writeFileSync(localPath, JSON.stringify(parsed, null, 2), 'utf8');

// fetchBrokerAccumulationFromVpsSync — series akumulasi
fs.writeFileSync(path.join(localAccDir, 'series.json'), JSON.stringify(parsed, null, 2), 'utf8');
```

`fs.writeFileSync` **memotong (truncate)** file target sebelum menulis. Pembaca konkuren — fast path `getBrokerHunterData()` (`fs.readFileSync` + `JSON.parse`) atau `readLocalBrokerAccumulation()` — dapat membuka file di tengah penulisan dan mengamati dokumen JSON yang terpotong. `JSON.parse()` melempar, `catch` menelannya, dan snapshot yang sebenarnya terisi menurun menjadi "tidak ada data".

Ini adalah kelanjutan temuan non-atomic write Fase 3 yang belum diperbaiki pada jalur snapshot multi-day.

## Perbaikan (diff)

Helper atomik baru:

```diff
+/**
+ * AUDIT-F5-07: publish a JSON snapshot atomically.
+ *
+ * Every on-demand sync path used a bare fs.writeFileSync() straight over the
+ * live cache path. fs.writeFileSync truncates the target before writing, so a
+ * concurrent reader (the hunter fast path in broker-hunter-service, or
+ * readLocalBrokerAccumulation) could open the file mid-write and observe a
+ * truncated/partial document — a torn read that JSON.parse() rejects, silently
+ * degrading a populated snapshot into "no data".
+ *
+ * Write to a unique temp file in the SAME directory (so rename stays on one
+ * filesystem and is therefore atomic), fsync it, then rename over the target.
+ * A reader sees either the previous complete document or the new one, never a
+ * partial one. Failures are reported through logFetchFailure, never swallowed.
+ */
+function atomicWriteJsonSync(filePath, data) {
+  const dir = path.dirname(filePath);
+  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
+  let fd = null;
+  try {
+    fd = fs.openSync(tmpPath, 'w');
+    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
+    fs.fsyncSync(fd);
+    fs.closeSync(fd);
+    fd = null;
+    fs.renameSync(tmpPath, filePath);
+    return true;
+  } catch (err) {
+    if (fd != null) {
+      try { fs.closeSync(fd); } catch (closeErr) {
+        logFetchFailure(`atomic write close ${path.basename(filePath)}`, closeErr);
+      }
+    }
+    try {
+      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
+    } catch (unlinkErr) {
+      logFetchFailure(`atomic write cleanup ${path.basename(filePath)}`, unlinkErr);
+    }
+    logFetchFailure(`atomic write ${path.basename(filePath)}`, err);
+    return false;
+  }
+}
```

Diterapkan pada seluruh 7 titik tulis:

```diff
           const localPath = path.join(localIndexDir, `${safeBroker}_${safeRange}.json`);
-          fs.writeFileSync(localPath, JSON.stringify(parsed, null, 2), 'utf8');
+          atomicWriteJsonSync(localPath, parsed);
```

```diff
-        fs.writeFileSync(localFilePath, JSON.stringify(parsed, null, 2), 'utf8');
+        atomicWriteJsonSync(localFilePath, parsed);
```

```diff
       for (const [filename, content] of Object.entries(data)) {
         const localFilePath = path.join(localTickerDir, filename);
-        fs.writeFileSync(localFilePath, JSON.stringify(content, null, 2), 'utf8');
+        atomicWriteJsonSync(localFilePath, content);
         datesSaved.push(filename.replace('.json', ''));
       }
```

```diff
-            fs.writeFileSync(localLatestPath, JSON.stringify(parsed, null, 2), 'utf8');
+            atomicWriteJsonSync(localLatestPath, parsed);
```

```diff
-            fs.writeFileSync(path.join(localAccDir, 'series.json'), JSON.stringify(parsed, null, 2), 'utf8');
+            atomicWriteJsonSync(path.join(localAccDir, 'series.json'), parsed);
```

## Test yang membuktikan

```js
test('F5-07: broker hunter index writes must not be torn by a concurrent reader', () => {
  const fetcherPath = path.join(__dirname, '..', 'lib', 'vps-data-fetcher.js');
  const source = fs.readFileSync(fetcherPath, 'utf8');

  const hunterFn = /function fetchBrokerHunterFromVpsSync[\s\S]*?\n}\n/.exec(source);
  assert.ok(hunterFn, 'fetchBrokerHunterFromVpsSync must exist');

  assert.ok(/atomicWriteJsonSync\(/.test(hunterFn[0]),
    'F5-07: fetchBrokerHunterFromVpsSync must publish via atomicWriteJsonSync, not an in-place writeFileSync');
  assert.equal(/fs\.writeFileSync\(/.test(hunterFn[0]), false,
    'F5-07: no bare writeFileSync may remain in the hunter sync path');

  const helperFn = /function atomicWriteJsonSync[\s\S]*?\n}\n/.exec(source);
  assert.ok(helperFn, 'atomicWriteJsonSync must exist');
  assert.ok(/renameSync\(/.test(helperFn[0]),
    'F5-07: atomicWriteJsonSync must publish via renameSync');

  // Prove it behaviourally: a published file is always complete JSON.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-f5-atomic-'));
  try {
    const target = path.join(tmp, 'AK_1d.json');
    fs.writeFileSync(target, JSON.stringify({ broker: 'AK', top_accumulated: [{ ticker: 'OLD' }] }), 'utf8');
    const fetcher = require('../lib/vps-data-fetcher');
    assert.equal(typeof fetcher.__atomicWriteJsonSync, 'function',
      'the atomic writer must be exposed for verification');
    fetcher.__atomicWriteJsonSync(target, { broker: 'AK', top_accumulated: [{ ticker: 'NEW' }] });

    const published = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(published.top_accumulated[0].ticker, 'NEW', 'the new snapshot must be fully visible');

    const leftovers = fs.readdirSync(tmp).filter(f => f.includes('.tmp'));
    assert.equal(leftovers.length, 0, `no temp files may remain, found ${JSON.stringify(leftovers)}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

test('F5-07b: the accumulation series snapshot is also published atomically', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vps-data-fetcher.js'), 'utf8');
  const accFn = /function fetchBrokerAccumulationFromVpsSync[\s\S]*?\n}\n/.exec(source);
  assert.ok(accFn, 'fetchBrokerAccumulationFromVpsSync must exist');
  assert.ok(/atomicWriteJsonSync\(/.test(accFn[0]),
    'F5-07b: fetchBrokerAccumulationFromVpsSync must publish series.json via atomicWriteJsonSync');
  assert.equal(/fs\.writeFileSync\(/.test(accFn[0]), false,
    'F5-07b: no bare writeFileSync may remain in the accumulation sync path');
});
```

## Output FAIL (sebelum perbaikan)

```
✖ F5-07: broker hunter index writes must not be torn by a concurrent reader (3.5825ms)
  AssertionError [ERR_ASSERTION]: F5-07: fetchBrokerHunterFromVpsSync must publish via renameSync (atomic), not an in-place writeFileSync
  actual: false, expected: true

✖ F5-07b: the accumulation series snapshot is also published atomically (0.7385ms)
  AssertionError [ERR_ASSERTION]: F5-07b: fetchBrokerAccumulationFromVpsSync must publish series.json via renameSync (atomic)
  actual: false, expected: true
```

## Output PASS (setelah perbaikan)

```
✔ F5-07: broker hunter index writes must not be torn by a concurrent reader (8.8125ms)
✔ F5-07b: the accumulation series snapshot is also published atomically (0.6902ms)
```

---

# RINGKASAN VERIFIKASI

## Bukti GAGAL (sebelum perbaikan)

```
ℹ tests 14   ℹ pass 3   ℹ fail 11
```

Artefak: `scratch/fase5-fail-evidence.txt`

## Bukti LULUS 2× BERTURUT-TURUT (setelah perbaikan)

| Run | Hasil |
|---|---|
| Run 1 | **15 pass / 0 fail** |
| Run 2 | **15 pass / 0 fail** |

Artefak: `scratch/fase5-final-run1.txt`, `scratch/fase5-final-run2.txt`

## Seluruh test suite repo

```
node tools/run-build-test-suite.js --full
→ All 522 test files passed successfully!
```

Artefak: `scratch/fase5-full-suite.txt`

## Registrasi

`test/audit-fase5-accumulation-bugs.test.js` terdaftar sebagai entri pertama di `tools/curated-build-tests.json`.


---

# ADDENDUM — BATCH 3 (FASE 5: POSITION SIZING CALCULATOR)

**Target:** `public/position-sizing-calculator.js` · **Suite:** `test/audit-fase5-position-sizing-bugs.test.js`

> The findings above cover historical broker accumulation / concentration.
> This addendum records the separate Position Sizing findings fixed in Batch 3.

## F5-B3-01 — Minus sign destroyed the thousand separator (HIGH)

```js
// SEBELUM
var numericPrefixStripped = s.replace(/^[^0-9-]+/, '');
// "-Rp 10.000" -> "-Rp 10.000" (the "-" prevented the strip)
// groups = ["-Rp 10", "000"] -> /^\d{1,3}$/ fails -> dot kept -> Number("-Rp 10.000") -> -10

// SESUDAH — strip everything before the first digit, reapply the sign at the end
var firstDigit = s.search(/[0-9]/);
var isNegative = s.slice(0, firstDigit).indexOf('-') >= 0;
var body = s.slice(firstDigit);
```

**Dampak:** kesalahan magnitudo **1000x** pada setiap angka negatif berformat
lokal. `-Rp 10.000` dibaca sebagai -10.

## F5-B3-02 — Exponential notation re-read as a digit string (MEDIUM)

```js
// SEBELUM
s = s.replace(/,/g, '.').replace(/[^0-9.-]/g, ''); // "1e400" -> "1400"

// SESUDAH
if (/\d\s*[eE]\s*[+-]?\s*\d/.test(s)) return fallback;
```

**Dampak:** `1e400` (overflow IEEE-754) menjadi **1400** — angka yang terlihat
sah. Notasi ilmiah bukan bagian dari kontrak input kalkulator ini.

## F5-B3-03 — Risk percentage unbounded in `calculate` (MEDIUM)

`saveSettings` sudah meng-clamp ke 0.1–10%, tetapi `calculate` meneruskan nilai
mentah, sehingga pemanggil dapat mengukur posisi pada risiko **500%** —
konfigurasi yang tidak akan pernah bisa disimpan lewat UI.

```js
// SESUDAH
riskPct = Math.max(MIN_RISK_PCT, Math.min(MAX_RISK_PCT, riskPct));
```

## F5-B3-04 — Unbounded capital overflowed every downstream figure (HIGH)

```
capital 1e308, riskPct 1, entry 1000, sl 950
  -> lots = 2e302
  -> profitTp1Idr = Infinity
  -> isValid = true          <-- "Rp Infinity" disajikan sebagai saran posisi
```

```js
// SESUDAH
capital = Math.max(MIN_CAPITAL_IDR, Math.min(MAX_CAPITAL_IDR, capital));
```

## Test verifikasi

```
node --test test/audit-fase5-position-sizing-bugs.test.js
# FAIL pra-perbaikan : 4 (F5-B3-01..04)
# PASS pasca         : 6/6
```

Termasuk sweep input bermusuhan (1e308, Infinity, NaN, negatif, notasi
ilmiah, string lokal) yang menuntut setiap field numerik hasil valid tetap
**finite**.
