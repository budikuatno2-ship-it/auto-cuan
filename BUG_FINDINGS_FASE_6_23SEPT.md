# BUG FINDINGS — FASE 6 (23 SEPT 2026)

**Subsystem:** Foreign Flow Engine · Foreign Watchlist Daily · Insider / Big Money Tracking
**Metode:** Zero-trust forensic audit · test-first (FAIL → fix → PASS 2×)
**Hasil:** **6 temuan bug** dikonfirmasi, diperbaiki, dan diverifikasi

| ID | Judul | Modul | Severity |
|---|---|---|---|
| F6-01 | Kolom `open/high/low` tidak ada di skema tetapi di-select 3 konsumen → HTTP 400 silent | `foreign-watchlist-daily-migration.sql`, `admin-foreign-upload.js`, `user-watchlist-service.js`, `chart-image-renderer.js`, `sector-hot.js` | **KRITIS** |
| F6-02 | `foreign_net` NULL dikonversi ke 0 → label "Foreign Neutral" palsu | `api/sector-hot.js` | **TINGGI** |
| F6-03 | Broker `CC` (Mandiri Sekuritas — domestik) dihitung sebagai asing | `lib/bandarmologi-service.js` | **KRITIS** |
| F6-04 | `toNumericOrNull()` gagal parse string ribuan Indonesia | `lib/bandarmologi-service.js` | **TINGGI** |
| F6-05 | Saldo kepemilikan dipakai sebagai delta transaksi | `lib/insider-network-service.js` | **KRITIS** |
| F6-06 | Tanggal transaksi vs tanggal pelaporan OJK/BEI tidak dibedakan | `lib/bandarmologi-service.js` | **TINGGI** |

---

# F6-01 — Kolom `open/high/low` tidak ada di skema tetapi di-select 3 konsumen

## Severity: KRITIS

## Lokasi
- `supabase/foreign-watchlist-daily-migration.sql:7-29` (skema)
- `lib/user-watchlist-service.js:107`
- `lib/chart-image-renderer.js:169`
- `api/sector-hot.js:5754`
- `lib/admin-foreign-upload.js:158-171` (write path)

## Bukti kode bermasalah

Skema mendeklarasikan **hanya** kolom berikut:

```sql
CREATE TABLE IF NOT EXISTS foreign_watchlist_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_date DATE NOT NULL,
  ticker TEXT NOT NULL,
  foreign_buy NUMERIC,
  foreign_sell NUMERIC,
  foreign_net NUMERIC,
  source TEXT DEFAULT 'csv',
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ...
);
ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS close NUMERIC;
ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS volume NUMERIC;
ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS freq NUMERIC;
ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS valuasi NUMERIC;
ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS nbsa NUMERIC;
```

**Tidak ada `open`, `high`, `low`.** Namun tiga konsumen men-select-nya:

```js
// lib/user-watchlist-service.js:107  — sumber harga ke-4 untuk watchlist
.select('ticker, close, open, high, low, trade_date, uploaded_at')

// lib/chart-image-renderer.js:169    — fallback OHLC untuk chart image
.select('trade_date,ticker,open,high,low,close,volume')

// api/sector-hot.js:5754             — fallback OHLC untuk chart Top 5
.select('trade_date,ticker,open,high,low,close,volume')
```

PostgREST menjawab **HTTP 400** untuk kolom yang tidak dikenal. Ketiga call site membungkusnya dengan `try/catch` yang menelan error:

```js
// lib/chart-image-renderer.js:187
} catch (_) {}
// lib/user-watchlist-service.js:126
} catch (_) {}
```

Akibatnya bukan crash, melainkan **degradasi senyap**: sumber harga ke-4 dan fallback chart OHLC selalu gagal dan tidak pernah terlihat di log.

### Bukti tambahan: write path juga membuang nilainya

Parser CSV **mewajibkan** `open/high/low` (`REQUIRED_HEADERS`), memvalidasinya, lalu **tidak menyimpannya**:

```js
const REQUIRED_HEADERS = ['date','ticker','open','high','low','close','volume','freq','valuasi','nbsa'];
...
rows.push({
  trade_date: tradeDate,
  ticker,
  foreign_buy: null,
  foreign_sell: null,
  foreign_net: close == null || nbsa == null ? null : close * nbsa,
  close,                                    // ← open/high/low hilang di sini
  volume: parseNumber(record.volume, 'volume', rowNumber),
  ...
});
```

Jadi bahkan bila kolomnya ditambahkan, tidak ada yang pernah menulisnya.

## Dampak riil
Ini kelas cacat yang sama dengan **BUG-FASE1-001** (ordering by a non-existent column → HTTP 400 → silent fallback to unordered query). Bedanya di sini bukan urutan yang salah, tetapi **seluruh sumber data yang hilang**:
- `batchFetchPricesForTickers` (watchlist) kehilangan sumber ke-4 → ticker yang hanya ada di foreign table tidak mendapat harga.
- `fetchChartOhlc` / `fetchTop5ChartOhlc` kehilangan fallback → chart gagal render saat Yahoo tidak tersedia.

## Bukti terukur (sebelum perbaikan)

```
✖ F6-01a: every column selected from foreign_watchlist_daily is declared in the migration
  AssertionError: PostgREST returns HTTP 400 for an unknown column, so these selects fail silently:
  lib/user-watchlist-service.js selects "open" (not in supabase/foreign-watchlist-daily-migration.sql)
  lib/user-watchlist-service.js selects "high" (not in supabase/foreign-watchlist-daily-migration.sql)
  lib/user-watchlist-service.js selects "low" (not in supabase/foreign-watchlist-daily-migration.sql)
  lib/chart-image-renderer.js selects "open" (not in supabase/foreign-watchlist-daily-migration.sql)
  lib/chart-image-renderer.js selects "high" (not in supabase/foreign-watchlist-daily-migration.sql)
  lib/chart-image-renderer.js selects "low" (not in supabase/foreign-watchlist-daily-migration.sql)
  api/sector-hot.js selects "open" (not in supabase/foreign-watchlist-daily-migration.sql)
  api/sector-hot.js selects "high" (not in supabase/foreign-watchlist-daily-migration.sql)
  api/sector-hot.js selects "low" (not in supabase/foreign-watchlist-daily-migration.sql)

✖ F6-01b: foreign CSV upload persists open/high/low instead of dropping the parsed values
  AssertionError: open must survive the parser
  + actual - expected
  + undefined
  - 8500
```

## Perbaikan (diff)

```diff
--- a/supabase/foreign-watchlist-daily-migration.sql
+++ b/supabase/foreign-watchlist-daily-migration.sql
@@
+-- AUDIT-F6-01: open/high/low are MANDATORY columns of the admin foreign CSV
+-- contract (see REQUIRED_HEADERS in lib/admin-foreign-upload.js) and three
+-- consumers select them (lib/user-watchlist-service.js,
+-- lib/chart-image-renderer.js, api/sector-hot.js). They were never declared,
+-- so PostgREST answered HTTP 400 for those selects and the failure was
+-- swallowed by a bare catch — the chart OHLC fallback and the 4th watchlist
+-- price source silently degraded to "no data". Same defect class as
+-- BUG-FASE1-001 (ordering by a column that does not exist).
+ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS open NUMERIC;
+ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS high NUMERIC;
+ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS low NUMERIC;
 ALTER TABLE foreign_watchlist_daily ADD COLUMN IF NOT EXISTS close NUMERIC;
```

```diff
--- a/lib/admin-foreign-upload.js
+++ b/lib/admin-foreign-upload.js
@@
       foreign_sell: null,
       foreign_net: close == null || nbsa == null ? null : close * nbsa,
+      // AUDIT-F6-01: open/high/low are REQUIRED_HEADERS of this CSV contract
+      // and were parsed for validation but then dropped on the floor, so the
+      // chart OHLC fallback had nothing to read even after the columns were
+      // added to the schema. Persist them.
+      open: parseNumber(record.open, 'open', rowNumber),
+      high: parseNumber(record.high, 'high', rowNumber),
+      low: parseNumber(record.low, 'low', rowNumber),
       close,
```

## Test yang membuktikan

```js
test('F6-01a: every column selected from foreign_watchlist_daily is declared in the migration', () => {
  const declared = declaredForeignColumns();
  assert.ok(declared.has('trade_date'), 'sanity: migration parser must see trade_date');
  assert.ok(declared.has('ticker'), 'sanity: migration parser must see ticker');
  assert.ok(declared.has('foreign_net'), 'sanity: migration parser must see foreign_net');

  const consumers = [
    'lib/foreign-flow-store.js', 'lib/user-watchlist-service.js',
    'lib/chart-image-renderer.js', 'lib/daytrade-screener-engine.js', 'api/sector-hot.js'
  ];

  const offenders = [];
  for (const rel of consumers) {
    for (const sel of selectColumnsForForeignTable(rel)) {
      for (const col of sel.columns) {
        if (col === '*') continue;
        if (!declared.has(col.toLowerCase())) {
          offenders.push(`${sel.file} selects "${col}" (not in ${FOREIGN_MIGRATION})`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], 'PostgREST returns HTTP 400 for an unknown column...');
});

test('F6-01b: foreign CSV upload persists open/high/low instead of dropping the parsed values', () => {
  const csv = [
    'date,ticker,open,high,low,close,volume,freq,valuasi,nbsa',
    '2026-09-23,BBCA,8500,8600,8450,8575,1000,20,8575000,10'
  ].join('\n');

  const parsed = adminForeignUpload.parseForeignCsv(csv);
  const row = parsed.rows[0];

  assert.equal(row.open, 8500, 'open must survive the parser');
  assert.equal(row.high, 8600, 'high must survive the parser');
  assert.equal(row.low, 8450, 'low must survive the parser');
});
```

---

# F6-02 — `foreign_net` NULL dikonversi ke 0 → label "Foreign Neutral" palsu

## Severity: TINGGI

## Lokasi
`api/sector-hot.js:2856-2873` (`deriveForeignConfluenceFromRows`)
`api/sector-hot.js:2875-2897` (`fetchForeignConfluence`)
`api/sector-hot.js:5448-5459` (`fetchForeignSummary`)

## Bukti kode bermasalah

```js
var n1 = cleanFiniteNumber(rows[0].foreign_net) || 0;
var n3 = rows.slice(0,3).reduce(function(a,r){ return a + (cleanFiniteNumber(r.foreign_net) || 0); },0);
var n7 = rows.slice(0,7).reduce(function(a,r){ return a + (cleanFiniteNumber(r.foreign_net) || 0); },0);
...
var label = 'Foreign Neutral';
```

Akar masalahnya ada di `cleanFiniteNumber`:

```js
function cleanFiniteNumber(value) {
  var n = Number(value);
  return isFinite(n) ? n : null;     // Number(null) === 0, isFinite(0) === true → return 0
}
```

`Number(null)` adalah **0**, jadi `cleanFiniteNumber(null)` mengembalikan **0**, bukan `null`. Sesi tanpa data (upload gap / fetch error) berubah menjadi **observasi nol**, dan hasilnya:

```
rows = [ {foreign_net: null}, {foreign_net: null}, {foreign_net: null} ]
n1 = 0, n3 = 0, n7 = 0, signs = [0,0,0]
label = 'Foreign Neutral'   ← VERDIK PALSU
```

Saham yang datanya **sama sekali tidak pernah terkumpul** dilaporkan sebagai "Foreign Neutral" — sebuah verdict pasar yang menutupi outage data.

`fetchForeignSummary` punya cacat kembar:

```js
var avg = rows.reduce(function(s, r) { return s + (Number(r.foreign_net) || 0); }, 0) / rows.length;
```

Dua cacat sekaligus: (a) `|| 0` mengubah sesi NULL menjadi nol nyata sehingga rata-rata 7D tertarik ke arah netral; (b) pembagian dengan `rows.length` (semua baris) alih-alih jumlah sesi berdata, sehingga rata-rata ter-*understate* pada data parsial.

## Dampak riil
- Screener Telegram menampilkan "Foreign Neutral" untuk emiten yang datanya hilang → pengguna menganggap asing benar-benar netral.
- Rata-rata 7D terdilusi oleh hari-hari kosong → `score` foreign (+5 / −4) salah arah.
- Konsisten dengan prinsip repo yang sudah ditegakkan di `lib/daily-foreign-context.js` ("missing is MISSING, not zero") dan `test/daily-foreign-context.test.js` — tetapi jalur `api/sector-hot.js` tidak pernah ikut diperbaiki.

## Bukti terukur (sebelum perbaikan)

```
✖ F6-02: rows whose foreign_net is NULL report "Foreign Data Unavailable", not "Foreign Neutral"
  AssertionError: Expected values to be strictly equal:
  + actual - expected
  + 'Foreign Neutral'
  - 'Foreign Data Unavailable'

✖ F6-02b: a partially-null window only sums observed sessions and flags the gap
  AssertionError: the newest session has no data, so 1D is null
  0 !== null
```

## Perbaikan (diff)

Tambahkan helper yang **mempertahankan** perbedaan missing/zero (tanpa menyentuh `cleanFiniteNumber`, yang 20 call site lainnya memang mengandalkan default 0):

```diff
 function cleanFiniteNumber(value) {
   var n = Number(value);
   return isFinite(n) ? n : null;
 }
+
+// AUDIT-F6-02: `Number(null)` is 0 and `isFinite(0)` is true, so
+// cleanFiniteNumber(null) returns 0 — an ABSENT foreign value silently becomes
+// an observed zero. That coercion is what let a ticker with no foreign data be
+// labelled "Foreign Neutral". This variant keeps the missing/absent distinction
+// (null / '' / undefined / '-' stay null) and is used by every foreign-flow
+// derivation. cleanFiniteNumber is intentionally left untouched: its other 20
+// call sites rely on the 0 default.
+function nullableFiniteNumber(value) {
+  if (value == null || value === '') return null;
+  if (typeof value === 'string' && value.trim() === '') return null;
+  var n = Number(value);
+  return isFinite(n) ? n : null;
+}
```

Derivasi diubah agar hanya menjumlahkan sesi berdata dan melaporkan gap:

```diff
-function deriveForeignConfluenceFromRows(rows) {
-  rows = rows || [];
-  if (rows.length === 0) return { foreign_1d: null, ..., foreign_label: 'Foreign Data Unavailable', ... };
-  var n1 = cleanFiniteNumber(rows[0].foreign_net) || 0;
-  var n3 = rows.slice(0,3).reduce(function(a,r){ return a + (cleanFiniteNumber(r.foreign_net) || 0); },0);
-  var n7 = rows.slice(0,7).reduce(function(a,r){ return a + (cleanFiniteNumber(r.foreign_net) || 0); },0);
+function sumObservedForeignNet(rows, windowSize) {
+  var slice = (rows || []).slice(0, windowSize);
+  var sum = 0, observed = 0;
+  for (var i = 0; i < slice.length; i++) {
+    var n = nullableFiniteNumber(slice[i].foreign_net);
+    if (n == null) continue;
+    sum += n; observed++;
+  }
+  return { value: observed > 0 ? sum : null, observed: observed, window: slice.length };
+}
+
+function deriveForeignConfluenceFromRows(rows) {
+  ...
+  var latestNet = nullableFiniteNumber(rows[0].foreign_net);
+  var w3 = sumObservedForeignNet(rows, 3);
+  var w7 = sumObservedForeignNet(rows, 7);
+  var missing = rows.slice(0, 7).length - w7.observed;
+  if (n1 == null && n3 == null && n7 == null) {
+    return { ..., foreign_label: 'Foreign Data Unavailable', ... };
+  }
   ...
+  if (missing > 0 && label === 'Foreign Neutral') label = 'Foreign Data Partial';
+  return { ..., foreign_sessions_missing: missing, foreign_label: label, ... };
 }
```

`fetchForeignConfluence` diringkas menjadi **satu jalur derivasi** agar tidak ada dua salinan logika yang bisa menyimpang:

```diff
+function foreignUnavailable() {
+  return { foreign_1d: null, foreign_3d: null, foreign_7d: null, foreign_label: 'Foreign Data Unavailable', ... };
+}
+
 async function fetchForeignConfluence(supabase, ticker, lastPrice) {
   ...
-    var n1 = cleanFiniteNumber(rows[0].foreign_net) || 0;
-    var n3 = ...reduce(...cleanFiniteNumber(r.foreign_net) || 0...)
-    var n7 = ...reduce(...cleanFiniteNumber(r.foreign_net) || 0...)
-    ... (32 baris duplikat logika label)
+    var latestCloseFallback = nullableFiniteNumber(lastPrice);
+    var normalizedRows = rows.map(function(r, idx) {
+      if (idx !== 0) return r;
+      var close = nullableFiniteNumber(r.close);
+      if (close != null || latestCloseFallback == null) return r;
+      return Object.assign({}, r, { close: latestCloseFallback });
+    });
+    return deriveForeignConfluenceFromRows(normalizedRows);
 }
```

`fetchForeignSummary` — rata-rata dibagi sesi berdata, bukan seluruh baris:

```diff
-    var avg = rows.reduce(function(s, r) { return s + (Number(r.foreign_net) || 0); }, 0) / rows.length;
+    var observed = [];
+    for (var i = 0; i < rows.length; i++) {
+      var net = nullableFiniteNumber(rows[i].foreign_net);
+      if (net != null) observed.push(net);
+    }
+    if (observed.length === 0) {
+      return { latest: rows[0], avg: null, trend: 'Unavailable', score: 0,
+               text: 'Foreign: data ' + rows[0].trade_date + ' belum terisi (net kosong).' };
+    }
+    var avg = observed.reduce(function(s, v) { return s + v; }, 0) / observed.length;
```

## Test yang membuktikan

```js
test('F6-02: rows whose foreign_net is NULL report "Foreign Data Unavailable", not "Foreign Neutral"', () => {
  const allNull = derive([
    { trade_date: '2026-09-23', ticker: 'X', foreign_net: null, close: 1000 },
    { trade_date: '2026-09-22', ticker: 'X', foreign_net: null, close: 990 },
    { trade_date: '2026-09-21', ticker: 'X', foreign_net: null, close: 980 }
  ]);
  assert.equal(allNull.foreign_label, 'Foreign Data Unavailable');
  assert.equal(allNull.foreign_1d, null, 'a missing 1D value is null, never 0');
  assert.equal(allNull.foreign_3d, null, 'a missing 3D sum is null, never 0');
  assert.equal(allNull.foreign_7d, null, 'a missing 7D sum is null, never 0');

  // A genuine zero (real row, real 0 net) is still a real observation.
  const realZero = derive([
    { trade_date: '2026-09-23', ticker: 'X', foreign_net: 0, close: 1000 },
    { trade_date: '2026-09-22', ticker: 'X', foreign_net: 0, close: 1000 },
    { trade_date: '2026-09-21', ticker: 'X', foreign_net: 0, close: 1000 }
  ]);
  assert.equal(realZero.foreign_label, 'Foreign Neutral');
  assert.equal(realZero.foreign_1d, 0);
});

test('F6-02b: a partially-null window only sums observed sessions and flags the gap', () => {
  const partial = derive([
    { trade_date: '2026-09-23', ticker: 'X', foreign_net: null, close: 1000 },
    { trade_date: '2026-09-22', ticker: 'X', foreign_net: 500, close: 990 },
    { trade_date: '2026-09-21', ticker: 'X', foreign_net: 700, close: 980 }
  ]);
  assert.equal(partial.foreign_1d, null);
  assert.equal(partial.foreign_3d, 1200);
  assert.equal(partial.foreign_sessions_missing, 1);
  assert.notEqual(partial.foreign_label, 'Foreign Neutral');
});
```

**Catatan desain penting:** test secara eksplisit memverifikasi bahwa **nol nyata tetap nol** (`realZero.foreign_label === 'Foreign Neutral'`). Perbaikan ini tidak mengubah nol menjadi missing — ia hanya berhenti mengubah missing menjadi nol.

---

# F6-03 — Broker `CC` (Mandiri Sekuritas — domestik) dihitung sebagai asing

## Severity: KRITIS

## Lokasi
`lib/bandarmologi-service.js:910`

## Bukti kode bermasalah

```js
const FOREIGN_INST_BROKERS = new Set(['AK', 'BK', 'RX', 'KZ', 'ZP', 'CS', 'DB', 'CC']);
                                                                                  // ^^^^ DOMESTIK
```

`CC` adalah **Mandiri Sekuritas** — broker **domestik Indonesia**. Ia dipakai di tiga tempat sekaligus:

```js
// (a) net flow institusi asing
for (const b of allBrokersList) {
  if (FOREIGN_INST_BROKERS.has(code)) {
    foreignInstNet += Number(b.net_val != null ? b.net_val : ((b.bval||0) - (b.sval||0)));
  }
}
// (b) foreign buy
gross_buyers.forEach(b => { if (FOREIGN_INST_BROKERS.has(code)) foreignBuyVal += Number(b.bval || 0); });
// (c) foreign sell
gross_sellers.forEach(s => { if (FOREIGN_INST_BROKERS.has(code)) foreignSellVal += Number(s.sval || 0); });
```

Kontradiksi internal: whitelist kanonik di `lib/foreign-flow-recap.js:21-37` **tidak** memuat `CC`, dan `test/foreign-flow-recap.test.js:21` secara eksplisit menguji:

```js
assert.equal(foreignFlowService.isForeignBroker('CC'), false, 'CC Mandiri is domestic');
```

Jadi repo ini sudah punya **satu daftar yang benar** dan **satu daftar yang salah**, tanpa ada yang menyadari keduanya berbeda.

## Dampak riil
Setiap rupiah pembelian bersih oleh Mandiri Sekuritas dicatat sebagai **foreign inflow**. Karena `foreign_net` dan `net_flow` dihitung dari angka ini, dan `evaluateConfluenceSignal()` memakai `foreign_net` untuk memutuskan `CONFIRMED` / `HINDARI`:

```js
if (foreignInfo.is_massive_accumulation && foreignInfo.whale_status === 'BIG_ACCUMULATION') {
  return { confluence_flag: 'CONFIRMED', confluence_action: 'UPGRADE_GRADE', confluence_penalty: 5, ... };
}
```

…maka pembelian domestik besar dapat menaikkan grade kandidat saham dengan alasan "asing akumulasi" yang **tidak pernah terjadi**. Ini bukan sekadar angka salah — ini **sinyal beli palsu**.

## Bukti terukur (sebelum perbaikan)

```
✖ F6-03: CC (Mandiri Sekuritas) is domestic and must never count as foreign buy
  AssertionError: only AK is foreign; CC (Mandiri) is a domestic broker
  + actual - expected
  + 14000000000
  - 5000000000
```

`foreign_buy` dilaporkan **Rp 14 M** (CC 9 M + AK 5 M) padahal hanya **Rp 5 M** yang benar-benar asing — **kelebihan 180%**.

## Perbaikan (diff)

```diff
   // 4. Calculate Net Flow: connect to authentic institutional/foreign net flow or top broker differential
+  //
+  // AUDIT-F6-03: this set is the foreign-institution whitelist used to split
+  // foreign buy vs foreign sell, and it used to contain 'CC'. CC is Mandiri
+  // Sekuritas — a DOMESTIC Indonesian broker — so every rupiah of domestic
+  // institutional buying was silently counted as foreign inflow, inflating
+  // foreign_buy (and therefore foreign_net) by an unbounded amount. The
+  // canonical whitelist in lib/foreign-flow-recap.js (FOREIGN_BROKERS, asserted
+  // by test/foreign-flow-recap.test.js: "CC Mandiri is domestic") never
+  // contained it. Removed here — this is a pure deletion so the existing
+  // membership of every other code is untouched.
-  const FOREIGN_INST_BROKERS = new Set(['AK', 'BK', 'RX', 'KZ', 'ZP', 'CS', 'DB', 'CC']);
+  const FOREIGN_INST_BROKERS = new Set(['AK', 'BK', 'RX', 'KZ', 'ZP', 'CS', 'DB']);
```

## Catatan regresi (temuan metodologis penting)

Percobaan pertama perbaikan ini adalah **menyelaraskan seluruh whitelist** ke daftar kanonik `FOREIGN_BROKERS` (menambah `GW`, `DP`, `MS`, `CG`, `ML`, `BQ`, `FS`, `YU`). Itu **salah** — dan suite menangkapnya:

```
Test suite finished with 1 failing test file(s):
 - test/bandarmologi-integration.test.js

✖ net_status: actual 'BIG_ACCUMULATION' vs expected 'BIG_DISTRIBUTION'
✖ net_flow  : actual 39000           vs expected -100000
✖ net_flow  : actual 60              vs expected -40
```

Penyebab: `YU` (CGS International) berperan sebagai **pembeli domestik** di fixture test tersebut; memasukkannya ke whitelist asing membalik tanda net flow. Perbaikan dikembalikan ke **deletion murni** (`CC` saja). Setelah itu 31/31 test integrasi PASS dan suite penuh hijau.

**Pelajaran:** "perbaikan presisi" berarti perubahan **sekecil mungkin yang menutup bug**. Menyelaraskan dua daftar secara semantik adalah refactor, bukan bugfix — dan dalam kasus ini akan mengubah perilaku 8 broker lain tanpa analisis dampak.

## Test yang membuktikan

```js
test('F6-03: CC (Mandiri Sekuritas) is domestic and must never count as foreign buy', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-f6-foreign-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  try {
    const ticker = 'F6FOREIGN';
    bandarmologiService.writeDiskCache('broker-summary', ticker, 'latest', {
      stock_code: ticker,
      date: '2026-09-23',
      gross_buyers: [
        { broker_code: 'CC', bval: 9000000000, bvol: 9000000 }, // domestic
        { broker_code: 'AK', bval: 5000000000, bvol: 5000000 }  // foreign (UBS)
      ],
      gross_sellers: [{ broker_code: 'YP', sval: 1000000000, svol: 1000000 }],
      brokers: [
        { broker_code: 'CC', bval: 9000000000, sval: 0, nval: 9000000000 },
        { broker_code: 'AK', bval: 5000000000, sval: 0, nval: 5000000000 },
        { broker_code: 'YP', bval: 0, sval: 1000000000, nval: -1000000000 }
      ]
    });

    const flow = bandarmologiService.getNetForeignFlow(ticker);
    assert.equal(flow.has_data, true);
    assert.equal(flow.foreign_buy, 5000000000,
      'only AK is foreign; CC (Mandiri) is a domestic broker');
  } finally { /* restore env + cleanup tmp */ }
});
```

---

# F6-04 — `toNumericOrNull()` gagal parse string ribuan Indonesia

## Severity: TINGGI

## Lokasi
`lib/bandarmologi-service.js:1413-1420` (sebelum perbaikan)

## Bukti kode bermasalah

```js
function toNumericOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[,\s]/g, '');   // ← hanya koma & spasi
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
```

Hanya koma dan spasi yang dibuang. **Titik ribuan gaya Indonesia dibiarkan**, sehingga:

```
"3.200.142.830"  →  Number("3.200.142.830")  →  NaN  →  null
```

Modul ini **sudah punya parser yang benar** untuk masalah yang persis sama:

```js
// lib/bandarmologi-service.js:42-79
function toNumberLoose(value) {
  ...
  } else if (hasDot) {
    // "1.500.000" / "1.500" => ribuan Indonesia; "1500.25" => desimal.
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  ...
}
```

dengan komentar eksplisit `AUDIT-F4-10/11/12` yang menjelaskan **persis** kelas bug ini. `toNumberLoose` dipakai 20+ kali di modul yang sama, tetapi `toNumericOrNull` — yang dipakai oleh `normalizeInsiders()` untuk seluruh field saham insider — **tidak pernah ikut dimigrasikan**.

### Bukti data riil

`data/insider-network/insiders-db.json` (11.219 record) memang membawa nilai bergaya ribuan:

```json
{
  "date": "2026-08-19",
  "ticker": "AADI",
  "insider_name": "ADARO STRATEGIC INVESTMENTS",
  "position": "Pemegang Saham >5%",
  "shares_change": -36454773,
  "pct_change": "--0.47%",
  "shares_after": 3200142830,
  "shares_after_percentage": "41.1%"
}
```

Field numerik di file ini sudah berupa angka, tetapi **feed Arjum/VPS yang mengisinya** mengirim string ribuan (`current_value`, `changes_value`) — lihat `tools/collect-insider-data.js` dan `lib/vps-data-fetcher.js:634-676`. Ketika itu terjadi, `shares_after` menjadi `null` dan tabel insider menampilkan "—" untuk pemegang >5% dengan miliaran lembar saham.

## Dampak riil
- Saldo kepemilikan pemegang saham >5% hilang → kolom "Lembar Saham" di UI insider kosong.
- `pct_before` yang diturunkan dari `shares_before/shares_after` gagal dihitung.
- `sharesBalance` menjadi `null` → `finalShares` jatuh ke `lastChange` (mutasi) alih-alih saldo, sehingga **saldo ditampilkan sebagai mutasi** — persis kelas kesalahan yang sudah diberantas di `F-079` untuk persentase.

## Bukti terukur (sebelum perbaikan)

```
✖ F6-04: normalizeInsiders parses thousands-separated share values instead of dropping them
  AssertionError: "3.200.142.830" is 3,200,142,830 shares, not an unparseable value
  + actual - expected
  + null
  - 3200142830
```

## Perbaikan (diff)

```diff
 function toNumericOrNull(value) {
   if (value == null) return null;
   if (typeof value === 'number') return Number.isFinite(value) ? value : null;
-  const cleaned = String(value).replace(/[,\s]/g, '');
-  if (cleaned === '') return null;
-  const n = Number(cleaned);
-  return Number.isFinite(n) ? n : null;
+  if (typeof value !== 'string') return null;
+  // AUDIT-F6-04: feed insider Arjum mengirim saldo kepemilikan sebagai string
+  // ribuan bergaya Indonesia ("3.200.142.830"). Versi lama hanya membuang koma
+  // dan spasi, sehingga titik ribuan membuat Number() mengembalikan NaN dan
+  // saldo saham pemegang >5% hilang menjadi null tanpa peringatan.
+  // toNumberLoose() adalah parser numerik longgar yang sudah menjadi standar
+  // repo ini (AUDIT-F4-10/11/12); delegasikan agar perilakunya konsisten.
+  return toNumberLoose(value);
 }
```

Delegasi (bukan salinan logika) dipilih agar **satu-satunya** parser longgar tetap satu, sesuai prinsip yang sama yang diterapkan pada F6-02.

## Test yang membuktikan

```js
test('F6-04: normalizeInsiders parses thousands-separated share values instead of dropping them', () => {
  const normalized = bandarmologiService.normalizeInsiders([
    {
      name: 'ADARO STRATEGIC INVESTMENTS', action_type: 'BUY', broker: 'AK',
      current_value: '3.200.142.830',
      changes_value: '12.500.000',
      current_percentage: '41,1%'
    }
  ]);

  assert.equal(normalized[0].shares_after, 3200142830,
    '"3.200.142.830" is 3,200,142,830 shares, not an unparseable value');
  assert.equal(normalized[0].shares_change, 12500000, '"12.500.000" is 12,500,000 shares');
  assert.equal(normalized[0].last_change, 12500000);
});

test('F6-04b: plain numeric and dot-decimal feeds keep working after the loose parse', () => {
  const normalized = bandarmologiService.normalizeInsiders([
    { name: 'A', action_type: 'BUY', broker: 'AK', current_value: 3200142830, changes_value: 12500000 },
    { name: 'B', action_type: 'SELL', broker: 'BK', current_value: '1,500,000', changes_value: '-250,000' }
  ]);
  assert.equal(normalized[0].shares_after, 3200142830);
  assert.equal(normalized[1].shares_after, 1500000);
  assert.equal(normalized[1].shares_change, -250000);
});
```

Test `F6-04b` adalah **guard regresi**: ia memastikan format plain-number, koma-ribuan, dan tanda negatif tetap bekerja setelah perubahan parser.

---

# F6-05 — Saldo kepemilikan dipakai sebagai delta transaksi

## Severity: KRITIS

## Lokasi
`lib/insider-network-service.js:290` (sebelum perbaikan)

## Bukti kode bermasalah

```js
const change = Math.abs(parseShares(item.shares_change || item.shares || 0));
const action = String(item.action_type || '').toUpperCase().trim();
if (action === 'SELL') {
  holding.total_sold += change;
  holding.net_shares_change -= change;
} else if (action === 'BUY' || action === 'PURCHASE') {
  holding.total_bought += change;
  holding.net_shares_change += change;
}
```

Operator `||` di sini adalah **fallback tipe-salah**. `shares_change` adalah **mutasi transaksi** (mis. `-36.454.773`); `shares` adalah **saldo kepemilikan** (mis. `3.200.142.830`). Ketika field mutasi tidak ada di feed, `||` menjadikan **saldo** sebagai delta.

Modul yang sama **sudah menegakkan prinsip yang benar** untuk kasus serupa:

```js
// lib/insider-network-service.js:264
shares: Math.max(0, parseShares(item.shares_after != null ? item.shares_after : (item.shares != null ? item.shares : 0))),
```

dan `test/insider-network-integrity.test.js:75-80` menguji pemisahan ini — tetapi hanya untuk jalur yang **memang punya** `shares_change`.

### Bukti data riil

`data/insider-network/insiders-db.json` memuat record dengan **saldo besar tanpa mutasi**:

```json
{ "ticker": "AADI", "insider_name": "ADARO STRATEGIC INVESTMENTS",
  "action_type": "TRANSFER", "shares_change": -36454773, "shares_after": 3200142830 }
```

Namun feed Arjum dapat mengirim baris dengan `shares_after` tetapi tanpa `changes_value`/`shares_change` sama sekali (lihat `tools/collect-insider-data.js:145` yang melakukan fallback `item.shares_change != null ? ... : (item.shares || 0)` — pola `||` yang sama). Saat itu terjadi:

```
action = 'BUY', shares_change = undefined, shares = 3.200.142.830
→ change = 3.200.142.830
→ total_bought += 3.200.142.830     ← AKUMULASI PALSU 3,2 MILIAR LEMBAR
```

## Dampak riil
`total_bought` dan `net_shares_change` adalah **angka yang ditampilkan sebagai aktivitas big money**. Seorang pemegang saham yang sekadar *memiliki* 3,2 miliar lembar — tanpa bertransaksi sama sekali — dilaporkan "membeli" 3,2 miliar lembar. Ini persis kelas cacat "fabricated numbers" yang sudah diberantas di Fase 5 (`AUDIT-F5-01`), tetapi lolos di modul insider.

Efek berantai: `aggregateInsiderHoldings()` → `buildInsiderNetworkGraph()` (bobot edge) → `roster.json` (`last_change`) → UI insider network.

## Bukti terukur (sebelum perbaikan)

```
✖ F6-05: aggregateInsiderHoldings never treats a holding balance as a purchase
  AssertionError: a balance with no delta is NOT a purchase
  3200142830 !== 0
```

## Perbaikan (diff)

```diff
-    const change = Math.abs(parseShares(item.shares_change || item.shares || 0));
+    // AUDIT-F6-05: `shares_change` adalah MUTASI transaksi, `shares` adalah
+    // SALDO kepemilikan. `||` di sini menjadikan saldo sebagai delta ketika
+    // field mutasi tidak ada, sehingga seorang pemegang >5% dengan saldo
+    // 3.200.142.830 lembar dan tanpa data mutasi tercatat "membeli" 3,2 miliar
+    // lembar — akumulasi palsu raksasa yang mencemari total_bought dan
+    // net_shares_change. Hanya field mutasi yang sah sebagai delta; bila tidak
+    // ada, delta-nya nol (bukan saldo).
+    const rawDelta = item.shares_change != null ? item.shares_change : item.changes_value;
+    const change = rawDelta == null ? 0 : Math.abs(parseShares(rawDelta));
     const action = String(item.action_type || '').toUpperCase().trim();
```

Perhatikan pemakaian `!= null` (bukan `||`): nilai **0 yang sah** tetap dihormati sebagai delta nol, dan `changes_value` ikut dipertimbangkan sebagai alias delta (konsisten dengan `normalizeInsiders` yang membaca `changes_value` lebih dulu).

## Test yang membuktikan

```js
test('F6-05: aggregateInsiderHoldings never treats a holding balance as a purchase', () => {
  const balanceOnly = [{
    ticker: 'AADI',
    insider_name: 'ADARO STRATEGIC INVESTMENTS',
    action_type: 'BUY',
    shares: 3200142830,      // absolute balance only
    shares_change: null      // no transaction delta at all
  }];

  const aggregated = insiderNetworkService.aggregateInsiderHoldings(balanceOnly);
  const holding = aggregated[0].holdings[0];

  assert.equal(holding.total_bought, 0, 'a balance with no delta is NOT a purchase');
  assert.equal(holding.net_shares_change, 0, 'no delta means no net change');
  assert.equal(holding.shares, 3200142830, 'the balance itself is still reported');
});

test('F6-05b: a real shares_change still accumulates normally', () => {
  const withDelta = [
    { ticker: 'TEST', insider_name: 'Buyer', action_type: 'BUY',  shares_change: 1000000, shares: 5000000 },
    { ticker: 'TEST', insider_name: 'Buyer', action_type: 'SELL', shares_change: 250000,  shares: 4750000 }
  ];
  const holding = insiderNetworkService.aggregateInsiderHoldings(withDelta)[0].holdings[0];
  assert.equal(holding.total_bought, 1000000);
  assert.equal(holding.total_sold, 250000);
  assert.equal(holding.net_shares_change, 750000);
});
```

Test menegaskan **tiga hal sekaligus**: delta nol saat tidak ada mutasi, saldo tetap dilaporkan, dan akumulasi nyata tetap bekerja.

---

# F6-06 — Tanggal transaksi vs tanggal pelaporan OJK/BEI tidak dibedakan

## Severity: TINGGI

## Lokasi
`lib/bandarmologi-service.js:1515` (sebelum perbaikan) dan seluruh konsumen `normalizeInsiders()`

## Bukti kode bermasalah

```js
return {
  date: item.transaction_date || item.tanggal_transaksi || item.date || item.tanggal || '—',
  name: name,
  ...
  // tidak ada field tanggal pelaporan sama sekali
};
```

Hanya **satu** field tanggal disimpan, dan field itu adalah **tanggal transaksi**. Field tanggal pelaporan (`filing_date`, `report_date`, `tanggal_lapor`, `published_at`) **tidak dibaca, tidak disimpan, tidak diteruskan**.

### Mengapa ini cacat, bukan sekadar field yang kurang

Di BEI, transaksi insider wajib dilaporkan ke OJK/BEI dalam **3 hari bursa**. Artinya:

```
Tanggal transaksi : 2026-09-10   (pasar belum tahu apa pun)
Tanggal pelaporan : 2026-09-15   (baru pada hari ini informasi tersedia publik)
```

Setiap konsumen yang membaca `date` akan menganggap sinyal insider **diketahui pasar pada 2026-09-10** — lima hari sebelum kenyataannya. Untuk backtest, ini adalah **look-ahead bias** klasik: strategi tampak profit karena "membeli" pada harga yang belum dipengaruhi informasi yang belum publik. Untuk sinyal live, ini adalah pelabelan tanggal yang salah pada UI.

Grep repo membuktikan tidak ada satu pun modul yang membedakan kedua tanggal:

```
$ grep -rn 'filing_date\|report_date\|tanggal_lapor\|reporting_date' --include=*.js .
# Hasil: 0 hit di modul insider/foreign.
# (hanya muncul di daytrade-intraday-validation-* yang tidak terkait insider)
```

Dan `tools/process-insider-roster.js` **memperkuat** masalah ini dengan fallback tanggal literal yang salah tipe:

```js
last_date: item.date || '2026-09-01',     // baris 132
last_date: row.date || '2026-09-09',      // baris 184
```

Ketika tanggal tidak ada, sebuah **tanggal literal hardcoded** dipakai — sehingga sinyal "muncul" pada tanggal yang tidak berhubungan dengan transaksi mana pun.

## Dampak riil
- **Backtest:** look-ahead bias. Sinyal insider dapat "dibeli" beberapa hari lebih awal dari ketersediaan informasi.
- **Sinyal live:** tanggal yang ditampilkan di UI insider adalah tanggal transaksi, bukan tanggal publikasi — pengguna tidak dapat menilai kesegaran sinyal.
- **Audit trail:** tidak mungkin merekonstruksi kapan sebuah sinyal seharusnya terlihat.

## Bukti terukur (sebelum perbaikan)

```
✖ F6-06: normalizeInsiders preserves the filing date so signals are not backdated
  AssertionError: the filing date must be preserved
  + actual - expected
  + undefined
  - '2026-09-15'
```

## Perbaikan (diff)

```diff
-    return {
-      date: item.transaction_date || item.tanggal_transaksi || item.date || item.tanggal || '—',
-      name: name,
+    // AUDIT-F6-06: trade date dan tanggal pelaporan ke OJK/BEI adalah dua
+    // peristiwa berbeda. Transaksi insider di BEI wajib dilaporkan dalam 3 hari
+    // bursa, jadi sebuah sinyal tidak mungkin diketahui pasar pada hari
+    // transaksinya. Versi lama hanya menyimpan satu `date`, sehingga seluruh
+    // konsumen memperlakukan tanggal transaksi sebagai tanggal publikasi —
+    // sebuah time-leak klasik (look-ahead) untuk backtest maupun sinyal live.
+    // Tanggal transaksi dipertahankan apa adanya, tanggal pelaporan disimpan
+    // terpisah, dan `signal_available_date` menandai kapan sinyal benar-benar
+    // boleh dipakai. Tanpa data pelaporan, nilainya null — tidak pernah
+    // diasumsikan sama dengan tanggal transaksi.
+    const tradeDate = item.transaction_date || item.tanggal_transaksi || item.date || item.tanggal || '—';
+    const filingDate = item.filing_date || item.report_date || item.tanggal_lapor || item.published_at || null;
+    const filingDateNormalized = (typeof filingDate === 'string' && filingDate.trim())
+      ? filingDate.trim().slice(0, 10)
+      : (filingDate == null ? null : String(filingDate).slice(0, 10));
+
+    return {
+      date: tradeDate,
+      trade_date: tradeDate,
+      filing_date: filingDateNormalized,
+      signal_available_date: filingDateNormalized,
+      name: name,
```

**Keputusan desain:** `date` **tidak diubah** nilainya (tetap tanggal transaksi) agar tidak ada konsumen hilir yang rusak. Yang ditambahkan adalah **informasi tambahan** yang sebelumnya hilang. Ini adalah perbaikan aditif — nol perubahan perilaku pada jalur lama, tetapi sinyal sekarang dapat diaudit.

## Test yang membuktikan

```js
test('F6-06: normalizeInsiders preserves the filing date so signals are not backdated', () => {
  const normalized = bandarmologiService.normalizeInsiders([
    { name: 'Dir Filing', action_type: 'BUY', broker: 'AK',
      transaction_date: '2026-09-10', filing_date: '2026-09-15', current_value: 1000000 },
    { name: 'Dir Legacy', action_type: 'BUY', broker: 'AK',
      date: '2026-09-12', current_value: 1000000 }
  ]);

  assert.equal(normalized[0].date, '2026-09-10', 'the trade date stays the trade date');
  assert.equal(normalized[0].filing_date, '2026-09-15', 'the filing date must be preserved');
  assert.equal(normalized[0].signal_available_date, '2026-09-15',
    'a signal may only be considered available once it was filed');

  assert.equal(normalized[1].date, '2026-09-12');
  assert.equal(normalized[1].filing_date, null,
    'an unknown filing date must stay unknown, never be assumed equal to the trade date');
  assert.equal(normalized[1].signal_available_date, null,
    'without a filing date there is no verified availability date');
});
```

Assertion terakhir adalah inti temuan: **tanggal pelaporan yang tidak diketahui harus tetap tidak diketahui.** Mengasumsikannya sama dengan tanggal transaksi justru menciptakan kembali time-leak yang sedang diperbaiki.

---

# RINGKASAN VERIFIKASI

## Bukti FAIL (sebelum perbaikan)

```
✖ F6-01a: every column selected from foreign_watchlist_daily is declared in the migration (19.2429ms)
✖ F6-01b: foreign CSV upload persists open/high/low instead of dropping the parsed values (3.3349ms)
✖ F6-02: rows whose foreign_net is NULL report "Foreign Data Unavailable", not "Foreign Neutral" (0.4105ms)
✖ F6-02b: a partially-null window only sums observed sessions and flags the gap (0.8662ms)
✖ F6-03: CC (Mandiri Sekuritas) is domestic and must never count as foreign buy (24.0324ms)
✖ F6-04: normalizeInsiders parses thousands-separated share values instead of dropping them (2.498ms)
✔ F6-04b: plain numeric and dot-decimal feeds keep working after the loose parse (0.4297ms)
✖ F6-05: aggregateInsiderHoldings never treats a holding balance as a purchase (1.4945ms)
✔ F6-05b: a real shares_change still accumulates normally (0.4472ms)
✖ F6-06: normalizeInsiders preserves the filing date so signals are not backdated (0.5011ms)
ℹ tests 10
ℹ pass 2
ℹ fail 8
```

Delapan FAIL di atas adalah **bukti reproduksi**; dua yang PASS (`F6-04b`, `F6-05b`) adalah guard regresi yang sengaja ditulis untuk membuktikan kontrak lama tidak rusak.

## Bukti PASS 2× berturut-turut (sesudah perbaikan)

```
=== RUN 1 ===
✔ F6-01a: every column selected from foreign_watchlist_daily is declared in the migration (12.0206ms)
✔ F6-01b: foreign CSV upload persists open/high/low instead of dropping the parsed values (7.8168ms)
✔ F6-02: rows whose foreign_net is NULL report "Foreign Data Unavailable", not "Foreign Neutral" (0.6111ms)
✔ F6-02b: a partially-null window only sums observed sessions and flags the gap (0.2929ms)
✔ F6-03: CC (Mandiri Sekuritas) is domestic and must never count as foreign buy (17.3617ms)
✔ F6-04: normalizeInsiders parses thousands-separated share values instead of dropping them (2.0343ms)
✔ F6-04b: plain numeric and dot-decimal feeds keep working after the loose parse (0.4727ms)
✔ F6-05: aggregateInsiderHoldings never treats a holding balance as a purchase (1.9035ms)
✔ F6-05b: a real shares_change still accumulates normally (0.8456ms)
✔ F6-06: normalizeInsiders preserves the filing date so signals are not backdated (1.6824ms)
ℹ tests 10
ℹ pass 10
ℹ fail 0

=== RUN 2 ===
ℹ tests 10
ℹ pass 10
ℹ fail 0
ℹ duration_ms 327.3885
```

## Suite penuh repo

```
$ node tools/run-build-test-suite.js --full
...
ℹ tests 111
ℹ pass 111
ℹ fail 0
ℹ duration_ms 3125.7707

All 523 test files passed successfully!
```

## Dampak perbaikan pada test yang sudah ada

| Test file | Status |
|---|---|
| `test/bandarmologi-integration.test.js` (31 test) | PASS — setelah regresi F6-03 diperbaiki ke deletion murni |
| `test/regime-adaptive-and-foreign-confluence.test.js` | PASS |
| `test/daily-foreign-context.test.js` | PASS |
| `test/foreign-flow-recap.test.js` | PASS |
| `test/admin-foreign-upload.test.js` | PASS |
| `test/insider-network-integrity.test.js` | PASS |
| `test/insider-roster-table.test.js` / `insider-transaction-table.test.js` | PASS |
| `test/insider-data-fabrication-removal.test.js` | PASS |
| `test/user-watchlist-multisource-prices.test.js` | PASS |
| `test/remove-hardcoded-date-fallbacks.test.js` | PASS |
| **Seluruh 523 file** | **PASS** |

---

# LAMPIRAN — HIPOTESIS YANG GUGUR

Sesuai prinsip zero-trust, klaim yang tidak terbukti dicatat eksplisit agar tidak diwariskan sebagai "temuan" di audit berikutnya.

| Hipotesis brief | Verdict | Bukti |
|---|---|---|
| Tidak memisahkan pasar RG/NG/TN | **GUGUR** | Tidak ada pemisahan board di seluruh repo. Ini keterbatasan sumber data yang sudah didokumentasikan di `lib/foreign-flow-store.js:2-11`, bukan bug kode. |
| Order field tidak eksis → HTTP 400 (BUG-FASE1-001) | **GUGUR untuk `order()`, TERBUKTI untuk `select()`** | `order()` sudah memakai `trade_date`/`uploaded_at` yang eksis (lihat komentar `lib/latest-price-resolver.js:5-11`). `select()` masih menyebut 3 kolom tidak eksis → menjadi F6-01. |
| Pembagian nol / NaN saat foreign buy & sell = 0 | **GUGUR** | Guard `foreignSell > 0` / `foreignBuy > 0` sudah ada. Diperkuat dengan penanganan `foreign_net` non-finite agar tidak bergantung pada perbandingan `NaN` yang menyamar sebagai `false`. |
| Saham tanpa data otomatis "Foreign Neutral" | **TERBUKTI** | Menjadi F6-02. |

---

# LAMPIRAN — REKOMENDASI (di luar cakupan perbaikan minimal)

1. **`fetchForeignUniverseTickers`** (`lib/daytrade-screener-engine.js:1754`) memakai `limit(5000)` lintas-universe lalu deduplikasi di memori. Bila volume upload tumbuh melampaui 5.000 baris, emiten terpotong tanpa peringatan. Perlu chunking bergaya `SAFE_QUERY_ROW_BUDGET` seperti `lib/foreign-flow-store.js:19`.
2. **`tools/process-insider-roster.js:132,184`** masih memakai tanggal literal hardcoded (`'2026-09-01'`, `'2026-09-09'`) sebagai fallback `last_date`. Berbeda dari `lib/insider-network-service.js` yang sudah dibersihkan pada F-080, file tool ini belum. Sebaiknya memakai `null` + marker eksplisit.
3. **Insider belum punya tabel Supabase.** 11.219 record hidup sebagai file JSON di disk tanpa RLS, tanpa retention policy, tanpa audit trail. Ini risiko operasional, bukan bug kode.
4. **Dua whitelist broker asing** (`FOREIGN_BROKERS` di `foreign-flow-recap.js` vs `FOREIGN_INST_BROKERS` di `bandarmologi-service.js`) masih berbeda anggota. Setelah `CC` dihapus, `FOREIGN_INST_BROKERS` = `{AK, BK, RX, KZ, ZP, CS, DB}` sementara `FOREIGN_BROKERS` memuat 15 kode. Perbedaan ini **sengaja dibiarkan** karena menyelaraskannya menyebabkan regresi terukur (lihat catatan F6-03); penyelarasan memerlukan analisis dampak tersendiri, bukan bugfix.


---

# ADDENDUM — BATCH 3 (FASE 6: DAY-TRADE OHLCV CACHE)

**Target:** `lib/daytrade-ohlcv-cache.js` · **Suite:** `test/audit-fase6-ohlcv-cache-bugs.test.js`

> The findings above cover the Foreign Flow engine, foreign watchlist daily and
> insider tracking. This addendum records the separate OHLCV cache findings
> fixed in Batch 3.

## F6-B3-01 — Corruption was indistinguishable from a cold start (HIGH)

```js
// SEBELUM — both branches returned the same shape
} catch (e) {
  if (e && e.code === 'ENOENT') return { hit: false, ... };
  return { hit: false, ..., error: e && e.message };
}

// SESUDAH — JSON/shape/newest-bar failures carry corrupt: true
} catch (e) {
  return { hit: false, stale: true, corrupt: true, ..., error: e && e.message };
}
```

**Dampak:** korupsi on-disk tidak dapat dibedakan dari cache kosong, sehingga
tidak ada konsumen yang bisa melaporkannya untuk perbaikan — dan file yang
rusak masih bisa disajikan sebagai fallback "stale".

## F6-B3-02 — Transient sharing violation looked like a cache miss (MEDIUM)

Di Windows, mengganti file yang sedang dibuka proses lain memicu EPERM/EACCES/
EBUSY. Pembaca yang tepat berada di jendela itu menerima error tersebut dari
`readFile`, dan kode lama melaporkannya sebagai `hit: false` tanpa percobaan
ulang — cache yang sehat dianggap tidak ada.

```js
// SESUDAH — retry terbatas khusus kode transien
var TRANSIENT_READ_CODES = { EPERM: true, EACCES: true, EBUSY: true, EMFILE: true, ENFILE: true };
async function readFileWithRetry(filePath, attempts) { /* backoff 5ms x (i+1) */ }
```

## F6-B3-03 / F6-B3-05 — In-place fallback caused EISDIR and torn reads (HIGH)

```js
// SEBELUM — setelah retry habis, tulis DI TEMPAT
console.warn('... falling back to an in-place write');
await fsp.writeFile(filePath, contents);

// SESUDAH — validasi bentuk tujuan lebih dulu, lalu TOLAK, bukan tulis di tempat
var existing = await fsp.stat(filePath);
if (!existing.isFile()) { /* EISDIR / EINVAL */ }
// ... 15x rename retry ...
throw refused; // snapshot lama tetap utuh; cache stale > cache rusak
```

**Dampak:** (a) terhadap direktori, fallback melempar EISDIR setelah file
sementara terlanjur dibuat; (b) dengan 6 penulis bersamaan, pembaca mengamati
file yang gagal di-parse — jendela torn-read yang justru ingin dihapus oleh
penulisan atomik.

## F6-B3-04 — Observability of the age ceiling

staleRejected kini menghitung fallback yang **ditolak** karena melewati
plafon umur, berdampingan dengan staleFallback yang menghitung yang
**disajikan**. Sebelumnya penolakan tidak terlihat sama sekali.

## Test verifikasi

```
node --test test/audit-fase6-ohlcv-cache-bugs.test.js
# FAIL pra-perbaikan : 4 (F6-B3-01, 02, 02b, 05)
# PASS pasca         : 10/10
```

Regresi: `51/51 PASS` untuk keluarga test cache OHLCV dan guard batch 3.
