# BUG FINDINGS — FASE 1 (23 SEPT 2026)

**Mode:** FORENSIC CODE AUDIT & INDEPENDENT VERIFICATION (ZERO-TRUST)
**Repo:** `d:/auto-cuan-2` @ `5e934a56f3be6aeb5c50d663ce3c187e53c56bb8`
**Suite pembuktian:** `test/audit-fase1-price-bugs.test.js`
**Bukti terminal:**
- FAIL (pra-fix): `scratch/fase1-fail-evidence.txt` — **9 FAIL / 5 PASS**
- PASS (pasca-fix, 2 run berturut-turut): `scratch/fase1-pass-evidence.txt` — **14 PASS / 0 FAIL** ×2

**Metodologi:** setiap temuan melewati siklus wajib **FAIL → perbaikan → PASS**. Tanpa siklus ini, temuan tidak diakui (lihat "Hipotesis Ditolak" di bagian akhir).

---

## RINGKASAN TEMUAN

| ID | File | Severity | Status |
|---|---|---|---|
| `BUG-FASE1-001` | `lib/latest-price-resolver.js` | **HIGH** | ✅ FIXED & VERIFIED |
| `BUG-FASE1-002` | `lib/latest-price-resolver.js` | — | ❌ REJECTED HYPOTHESIS (kontrak dikunci test) |
| `BUG-FASE1-003` | `lib/idx-tick-normalization.js` | **MEDIUM** | ✅ FIXED & VERIFIED |
| `BUG-FASE1-004` | `lib/latest-price-resolver.js` | **MEDIUM** | ✅ FIXED & VERIFIED |

---

## BUG-FASE1-001 — Kolom `order` yang tidak ada pada skema tabel → query "latest" gagal senyap dan harga usang lolos ke screener

**Severity:** HIGH
**File & baris:**
- `lib/latest-price-resolver.js:12–17` (`SOURCES` — tidak mendeklarasikan kolom order per tabel)
- `lib/latest-price-resolver.js:77` (SDK: `source.order || 'calculated_at'`)
- `lib/latest-price-resolver.js:87` (REST: `source.order || 'calculated_at.desc,updated_at.desc'`)

### Deskripsi masalah & analisis risiko

Keempat tabel pada `SOURCES` di-query dengan klausa `order` default yang **tidak cocok dengan skema aslinya** (diverifikasi langsung ke `supabase/*.sql`):

| Tabel | Kolom timestamp yang benar | Kolom yang dipakai kode lama |
|---|---|---|
| `daytrade_screener_latest` | `calculated_at` | `calculated_at` ✔ |
| `swing_screener_latest` | `calculated_at` | `calculated_at` ✔ |
| `swing_screener_non_konglo_latest` | **`published_at`** (tidak punya `calculated_at`) | `calculated_at` ✖ |
| `foreign_watchlist_daily` | **`trade_date`** (tidak punya `calculated_at`/`updated_at`) | `calculated_at` ✖ |

Dampak berantai pada dua jalur:

1. **Jalur REST** (`lib/latest-price-resolver.js:87–94`): PostgREST membalas HTTP 400 untuk kolom tak dikenal. Kode lalu jatuh ke `fallbackUrl` **tanpa klausa order sama sekali** — PostgREST mengembalikan baris pertama dalam urutan fisik (bukan yang terbaru). Untuk `foreign_watchlist_daily` (multi-baris per ticker: satu baris per hari), ini berarti **harga hari lama bisa menang atas harga hari terbaru**, selama keduanya masih dalam jendela 72 jam. Ini persis kelas "stale price leak" ke screener/portfolio.
2. **Jalur SDK** (`lib/latest-price-resolver.js:77–82`): error `column does not exist` ditelan oleh `catch (_) {}` → baris **tidak pernah masuk** ke `rows` → sumber tersebut **hilang total** dari resolusi (bukan hanya tidak terurut).

Catatan penting: `api/quote.js` (baris 103–127) sudah memakai klausa order yang benar (`calculated_at.desc,updated_at.desc` + fallback) — tetapi komentar BUG-QUOTE-02 di sana mengonfirmasi masalah yang sama pernah terjadi dan diperbaiki di sana, **tidak** di modul bersama ini. Modul ini adalah jalur yang dipakai `api/sector-hot.js` (bandarmologi intel) dan `tools/run-top5-progress-monitor.js`.

### Bukti uji (test code)

```js
// test/audit-fase1-price-bugs.test.js — BUG-FASE1-001a
test('BUG-FASE1-001a: REST path must order foreign_watchlist_daily by trade_date so the NEWEST row wins', async () => {
  const originalFetch = global.fetch;
  global.fetch = fakePostgrestFetch(); // stub menolak kolom order yang tidak ada (HTTP 400), persis PostgREST
  try {
    const res = await resolver.fetchFreshScreenerLatestPrice('AUDITX', {
      supabaseUrl: 'https://fake-supabase.local',
      supabaseKey: 'service-role-key',
      now: '2026-09-23T02:00:00Z'
    });
    assert.equal(res.price, 5000, 'newest trade_date row must win, got ' + res.price);
    assert.equal(res.price_date, '2026-09-22');
  } finally {
    global.fetch = originalFetch;
  }
});

// BUG-FASE1-001b — SDK path
test('BUG-FASE1-001b: SDK path must read swing_screener_non_konglo_latest (no calculated_at column)', async () => {
  const sdk = fakeSupabaseClient({ /* non-konglo punya published_at, bukan calculated_at */ });
  const res = await resolver.fetchFreshScreenerLatestPrice('AUDITSDK', { supabase: sdk, now: '2026-09-23T02:00:00Z' });
  assert.equal(res.price, 1500, 'the non-konglo source must not be silently dropped by an invalid order column');
  assert.equal(res.price_source, 'swing_screener_non_konglo_latest');
});

// BUG-FASE1-001c — kontrak statis
test('BUG-FASE1-001c: every SOURCES entry must declare order columns that exist on its real table', () => {
  const expected = {
    daytrade_screener_latest: 'calculated_at',
    swing_screener_latest: 'calculated_at',
    swing_screener_non_konglo_latest: 'published_at',
    foreign_watchlist_daily: 'trade_date'
  };
  for (const source of resolver.SOURCES) {
    assert.equal(source.orderColumn, expected[source.table], 'orderColumn for ' + source.table);
    assert.equal(source.order, expected[source.table] + '.desc', 'REST order clause for ' + source.table);
  }
});
```

### Output terminal FAIL (pra-fix — otentik)

```
✖ BUG-FASE1-001a: REST path must order foreign_watchlist_daily by trade_date so the NEWEST row wins (33.6681ms)
  AssertionError [ERR_ASSERTION]: newest trade_date row must win, got 900
  900 !== 5000

✖ BUG-FASE1-001b: SDK path must read swing_screener_non_konglo_latest (no calculated_at column) (4.1324ms)
  AssertionError [ERR_ASSERTION]: the non-konglo source must not be silently dropped by an invalid order column
  null !== 1500

✖ BUG-FASE1-001c: every SOURCES entry must declare order columns that exist on its real table (0.9539ms)
  AssertionError [ERR_ASSERTION]: orderColumn for daytrade_screener_latest
  + actual - expected
  + undefined
  - 'calculated_at'

ℹ tests 14
ℹ pass 5
ℹ fail 9
```

`got 900` adalah baris **terlama** (trade_date 2026-09-21) yang menang — membuktikan query tanpa order mengembalikan baris sembarang, bukan yang terbaru.

### Solusi perbaikan (diff)

```diff
--- a/lib/latest-price-resolver.js
+++ b/lib/latest-price-resolver.js
@@ -2,11 +2,18 @@
+// BUG-FASE1-001: each source MUST declare the timestamp column that actually
+// exists on its real table (verified against supabase/*.sql). The old default
+// 'calculated_at' (+ a non-existent 'updated_at') made EVERY PostgREST query
+// answer HTTP 400 and silently fall back to an unordered query, so "latest"
+// was really "arbitrary first row in physical order" — a stale-price leak.
+// NOTE: swing_screener_non_konglo_latest has published_at (not calculated_at);
+// foreign_watchlist_daily has trade_date (not calculated_at).
 const SOURCES = [
-  { table: 'daytrade_screener_latest', label: 'daytrade_screener_latest' },
-  { table: 'swing_screener_latest', label: 'swing_screener_latest' },
-  { table: 'swing_screener_non_konglo_latest', label: 'swing_screener_non_konglo_latest' },
-  { table: 'foreign_watchlist_daily', label: 'foreign_watchlist_daily' }
+  { table: 'daytrade_screener_latest', label: 'daytrade_screener_latest', orderColumn: 'calculated_at', order: 'calculated_at.desc' },
+  { table: 'swing_screener_latest', label: 'swing_screener_latest', orderColumn: 'calculated_at', order: 'calculated_at.desc' },
+  { table: 'swing_screener_non_konglo_latest', label: 'swing_screener_non_konglo_latest', orderColumn: 'published_at', order: 'published_at.desc' },
+  { table: 'foreign_watchlist_daily', label: 'foreign_watchlist_daily', orderColumn: 'trade_date', order: 'trade_date.desc' }
 ];

@@ -67,7 +74,7 @@ (SDK path)
-        const orderClause = source.order || 'calculated_at';
+        const orderClause = source.orderColumn || 'calculated_at';

@@ -77,7 +84,7 @@ (REST path)
-        const orderClause = source.order || 'calculated_at.desc,updated_at.desc';
+        const orderClause = source.order || 'calculated_at.desc';
```

### Verifikasi akhir (PASS 2×)

```
✔ BUG-FASE1-001a: REST path must order foreign_watchlist_daily by trade_date so the NEWEST row wins (35.4028ms)
✔ BUG-FASE1-001b: SDK path must read swing_screener_non_konglo_latest (no calculated_at column) (1.7071ms)
✔ BUG-FASE1-001c: every SOURCES entry must declare order columns that exist on its real table (0.3467ms)
ℹ tests 14 | ℹ pass 14 | ℹ fail 0        ← RUN #1
ℹ tests 14 | ℹ pass 14 | ℹ fail 0        ← RUN #2
```
Plus RUN #3 (di terminal, 14/14) dan anti-regresi: `test/bandarmologi-stage1-intel-live-price-and-range.test.js` (termasuk "STAGE1: resolveLatestPriceBulk returns a per-ticker price map in one pass") **PASS**.

---

## BUG-FASE1-002 — ❌ REJECTED HYPOTHESIS (same-day freshness inversion)

**Severity:** — (bukan bug)
**File & baris:** `lib/latest-price-resolver.js:49–52`

### Hipotesis awal

Pada hari WIB yang sama, baris dengan timestamp lebih baru (mis. `swing_screener_latest` 18:00 WIB) seharusnya mengalahkan baris `daytrade_screener_latest` 09:00 WIB. Perbandingan `dKey` (hanya tanggal) dianggap "kehilangan informasi jam".

### Mengapa DITOLAK

1. **Kontrak eksplisit di test lama:** `test/latest-price-resolver.test.js` — *"prefers fresh daytrade latest over stale manual/current price and lower-priority sources"* — mengunci bahwa prioritas `SOURCES` berlaku di dalam hari yang sama.
2. **Revert yang disengaja:** commit `030ce7e0` ("fix(ci): register fase-1 tests, remove non-fase-1 tests and fix test regressions") secara sengaja mengembalikan perbandingan `at` (timestamp) menjadi `dKey` (hari WIB) — bukan kecelakaan.
3. **Semantik yang benar untuk data harian:** baris-baris ini adalah snapshot harian screener (satu run per hari per sumber). Memilih berdasarkan jam run antar sumber akan membuat sumber yang kebetulan jalan lebih malam selalu menang, meskipun datanya bukan sumber otoritatif untuk harga hari itu.
4. **Test awal memang FAIL untuk hipotesis ini, tetapi setelah verifikasi silang, perilaku kode terbukti benar** — maka test diubah menjadi *lock test* (002a/002b/002c) agar kontrak tidak bergeser senyap.

**Output saat hipotesis diuji (pra-verifikasi silang):**

```
✖ BUG-FASE1-002a: on the SAME day, the source with the freshest timestamp must win
  AssertionError: the freshest same-day price (18:00 WIB) must win over the stale 09:00 WIB price
  1000 !== 1500
```

**Keputusan:** hipotesis ditolak; tidak ada perubahan kode untuk perilaku ini. Perilaku kontrak dikunci dengan 3 lock test yang PASS.

---

## BUG-FASE1-003 — Harga positif di bawah Rp1 dibulatkan menjadi 0 (level non-positif bocor ke SL/TP)

**Severity:** MEDIUM
**File & baris:** `lib/idx-tick-normalization.js:45–56` (`roundToIdxTick`)

### Deskripsi masalah & analisis risiko

`roundToIdxTick` menerima harga positif kecil (< 1 tick, yaitu < Rp1), menghitung `Math.floor(0.9 / 1) * 1 = 0`, dan **mengembalikan 0**. Nilai 0 bukan level harga IDX yang sah (minimum Rp1), melainkan sentinel "tidak ada nilai".

Kontrak modul ini sendiri menolak 0 di fungsi tetangganya: `getIdxTickSize` mengembalikan `null` untuk `price <= 0`, dan `isValidIdxPriceLevel` mengembalikan `false` untuk `price <= 0`. Jadi `roundToIdxTick` mengembalikan nilai yang **tidak lolos validatornya sendiri** — inkonsistensi internal.

Dampak nyata: `normalizeTradingPlanLevels` memakai `roundToIdxTick` dengan mode `floor` untuk SL. SL bernilai kecil (mis. dari data split-adjusted atau unit saham berharga Rp0,5 seperti skenario pre-IPO/rights) menjadi `stop_loss: 0`. Downstream:
- `derivePlanQuality` menghitung `((entryRef - sl) / entryRef) * 100` → SL 0 membuat risiko tampak 100% (salah);
- gate publik/Telegram dapat memperlakukan SL 0 sebagai "valid" karena `firstNum` memfilter `n > 0`... justru melewatkan SL yang seharusnya ditolak.

Bug ini terdeteksi oleh sweep deterministik 60.009 nilai fraksional: satu-satunya anomali output non-positif berasal dari rentang sub-Rp1.

### Bukti uji (test code)

```js
// test/audit-fase1-price-bugs.test.js — BUG-FASE1-003a
test('BUG-FASE1-003a: roundToIdxTick must never emit a non-positive level for a positive price', () => {
  assert.equal(idx.roundToIdxTick(0.9, 'floor'), null, 'floor of a sub-Rp1 price must be null, not 0');
  assert.equal(idx.roundToIdxTick(0.9, 'down'), null, '"down" alias of floor must be null too');
  assert.equal(idx.roundToIdxTick(0.4, 'nearest'), null, 'nearest of a sub-Rp1 price must be null, not 0');
  assert.equal(idx.roundToIdxTick(0.5, 'ceil'), 1, 'ceil of a sub-Rp1 price stays the minimum Rp1 tick');
  assert.equal(idx.isValidIdxPriceLevel(0), false);
});

// BUG-FASE1-003b — kebocoran ke level plan
test('BUG-FASE1-003b: a sub-Rp1 stop loss must not leak 0 into normalized plan levels', () => {
  const levels = idx.normalizeLevelsToIdxTicks({
    entry_low: 1.5, entry_high: 2.5, stop_loss: 0.9, tp1: 3.5, tp2: 4.5
  });
  assert.notEqual(levels.stop_loss, 0, 'stop_loss 0 is not a tradable IDX level');
});
```

### Output terminal FAIL (pra-fix — otentik)

```
✖ BUG-FASE1-003a: roundToIdxTick must never emit a non-positive level for a positive price (0.8112ms)
  AssertionError [ERR_ASSERTION]: floor of a sub-Rp1 price must be null, not 0
  0 !== null

✖ BUG-FASE1-003b: a sub-Rp1 stop loss must not leak 0 into normalized plan levels (2.3726ms)
  AssertionError [ERR_ASSERTION]: stop_loss 0 is not a tradable IDX level
  actual: 0, expected: 0, operator: 'notStrictEqual'
```

### Solusi perbaikan (diff)

```diff
--- a/lib/idx-tick-normalization.js
+++ b/lib/idx-tick-normalization.js
@@ -50,9 +50,14 @@ function roundToIdxTick(price, mode, board, isFca, ticker) {
   if (mode === 'down') mode = 'floor';
   var tick = getIdxTickSize(price, board, isFca, ticker);
   if (!tick) return null;
-  if (mode === 'ceil') return Math.ceil(price / tick) * tick;
-  if (mode === 'floor') return Math.floor(price / tick) * tick;
-  return Math.round(price / tick) * tick;
+  var rounded;
+  if (mode === 'ceil') rounded = Math.ceil(price / tick) * tick;
+  else if (mode === 'floor') rounded = Math.floor(price / tick) * tick;
+  else rounded = Math.round(price / tick) * tick;
+  // BUG-FASE1-003: a positive price below one Rp1 tick floors/rounds to 0,
+  // which is NOT a valid IDX price level (IDX minimum is Rp1). Return null so
+  // callers fall back instead of carrying a zero level into SL/TP math.
+  return rounded > 0 ? rounded : null;
 }
```

Catatan presisi: perbaikan ini **tidak mengubah** hasil untuk semua harga ≥ Rp1 (sweep 1..30000 × 3 mode: 0 perubahan); hanya menolak output 0 dari input positif sub-Rp1.

### Verifikasi akhir (PASS 2×)

```
✔ BUG-FASE1-003a: roundToIdxTick must never emit a non-positive level for a positive price (0.5358ms)
✔ BUG-FASE1-003b: a sub-Rp1 stop loss must not leak 0 into normalized plan levels (1.3673ms)
ℹ tests 14 | ℹ pass 14 | ℹ fail 0        ← RUN #1
ℹ tests 14 | ℹ pass 14 | ℹ fail 0        ← RUN #2
```
Plus `test/idx-tick-normalization.test.js` (8 test, termasuk boundary 199/200/503/2003/5013) **PASS** dan `test/trade-plan-v2.test.js` **PASS**.

---

## BUG-FASE1-004 — `resolveLatestPriceBulk` melanggar kontrak JSDoc-nya sendiri (key `.JK` & input pre-resolved)

**Severity:** MEDIUM
**File & baris:** `lib/latest-price-resolver.js:140–162`

### Deskripsi masalah & analisis risiko

Dokumentasi fungsi (JSDoc di baris 127–139) menjanjikan dua bentuk input:
1. `{ TICKER: { table: row } }` — baris sumber per tabel; **dan**
2. *"a pre-resolved price map"* — entri `{ price, price_source, price_date }` yang sudah jadi.

Implementasi lama hanya menangani bentuk (1), dengan dua cacat:

- **004a — kanonikalisasi key tidak konsisten dengan jalur single-ticker.** `fetchFreshScreenerLatestPrice` melakukan `.replace(/\.JK$/i, '')` lebih dulu (baris 63), tetapi bulk hanya melakukan `.replace(/[^A-Z0-9]/g, '')`. Akibatnya input `'BBCA.JK'` keluar sebagai key `'BBCAJK'` — **caller yang mencari `map['BBCA']` mendapat `undefined`** (harga hilang senyap), padahal jalur single-ticker untuk ticker yang sama berhasil.
- **004b — input pre-resolved dibuang.** Entri `{ price: 5000, price_source: 'manual_portfolio' }` tidak memiliki `rowsBySource['daytrade_screener_latest']` dsb., sehingga `resolveLatestPrice` mengembalikan `stale: true` dan entri di-`continue` tanpa output. Kontrak yang didokumentasikan tidak dipenuhi.

Risiko: scanner bulk (`api/sector-hot.js` bandarmologi intel) memetakan ticker ke harga lewat helper ini; mismatch key membuat sebagian ticker kehilangan harga tanpa error yang terlihat.

### Bukti uji (test code)

```js
// test/audit-fase1-price-bugs.test.js — BUG-FASE1-004a
test('BUG-FASE1-004a: bulk resolver must key results by the clean ticker, matching the single-ticker path', () => {
  const bulk = resolver.resolveLatestPriceBulk({
    'BBCA.JK': { daytrade_screener_latest: { last_price: 5000, calculated_at: '2026-08-11T11:00:00Z' } }
  }, { now: '2026-08-11T12:00:00Z' });
  assert.ok(bulk.BBCA, 'BBCA.JK must resolve under the clean key BBCA (keys: ' + Object.keys(bulk).join(',') + ')');
  assert.equal(bulk.BBCA.price, 5000);
});

// BUG-FASE1-004b
test('BUG-FASE1-004b: documented pre-resolved price map input must be honored, not silently dropped', () => {
  const bulk = resolver.resolveLatestPriceBulk({
    BBCA: { price: 5000, price_source: 'manual_portfolio', price_date: '2026-08-11' }
  }, { now: '2026-08-11T12:00:00Z' });
  assert.ok(bulk.BBCA, 'pre-resolved {price, price_source, price_date} entries must pass through');
  assert.equal(bulk.BBCA.price, 5000);
  assert.equal(bulk.BBCA.price_source, 'manual_portfolio');
  assert.equal(bulk.BBCA.price_date, '2026-08-11');
});
```

### Output terminal FAIL (pra-fix — otentik)

```
✖ BUG-FASE1-004a: bulk resolver must key results by the clean ticker, matching the single-ticker path (1.2318ms)
  AssertionError [ERR_ASSERTION]: BBCA.JK must resolve under the clean key BBCA (keys: BBCAJK)

✖ BUG-FASE1-004b: documented pre-resolved price map input must be honored, not silently dropped (0.6007ms)
  AssertionError [ERR_ASSERTION]: pre-resolved {price, price_source, price_date} entries must pass through
```

### Solusi perbaikan (diff)

```diff
--- a/lib/latest-price-resolver.js
+++ b/lib/latest-price-resolver.js
@@ -134,9 +141,26 @@ function resolveLatestPriceBulk(rowsByTicker, options) {
   const out = {};
   if (!rowsByTicker || typeof rowsByTicker !== 'object') return out;
   for (const key of Object.keys(rowsByTicker)) {
-    const clean = String(key || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
+    // BUG-FASE1-004a: same key canonicalisation as the single-ticker path —
+    // drop a Yahoo-style ".JK" suffix BEFORE stripping separators, so
+    // 'BBCA.JK' resolves under 'BBCA' on both entry points.
+    const clean = String(key || '').trim().toUpperCase().replace(/\.JK$/i, '').replace(/[^A-Z0-9]/g, '');
     if (!clean) continue;
-    const resolved = resolveLatestPrice(rowsByTicker[key], options);
+    const entry = rowsByTicker[key];
+    // BUG-FASE1-004b: the JSDoc above documents a second input form — a
+    // pre-resolved { price, price_source, price_date } map entry. Only treat
+    // an entry as pre-resolved when it carries no source-table payload, so a
+    // raw screener row (which also has a `price` field) is never misread.
+    const hasSourceRows = SOURCES.some(function (source) { return entry && entry[source.table]; });
+    if (!hasSourceRows && entry && n(entry.price)) {
+      out[clean] = {
+        price: n(entry.price),
+        price_source: entry.price_source || 'pre_resolved',
+        price_date: entry.price_date || null
+      };
+      continue;
+    }
+    const resolved = resolveLatestPrice(entry, options);
```

Guard `hasSourceRows` penting: tanpa itu, baris screener mentah yang kebetulan punya field `price` akan salah dibaca sebagai map pre-resolved. `n()` tetap memfilter boolean/NaN/≤0.

### Verifikasi akhir (PASS 2×)

```
✔ BUG-FASE1-004a: bulk resolver must key results by the clean ticker, matching the single-ticker path (1.0944ms)
✔ BUG-FASE1-004b: documented pre-resolved price map input must be honored, not silently dropped (0.5651ms)
ℹ tests 14 | ℹ pass 14 | ℹ fail 0        ← RUN #1
ℹ tests 14 | ℹ pass 14 | ℹ fail 0        ← RUN #2
```
Plus `test/bandarmologi-stage1-intel-live-price-and-range.test.js` (termasuk test bulk resolver yang sudah ada) **PASS** — kontrak lama tidak rusak.

---

## OBSERVASI TANPA SIKLUS FAIL (TIDAK DIAKUI SEBAGAI BUG)

Sesuai aturan mutlak "tanpa siklus FAIL → PASS, temuan tidak diakui", item berikut tidak dihitung sebagai bug:

| # | Observasi | Alasan tidak diakui |
|---|---|---|
| OBS-1 | `is_fca: "true"` (string) tidak dikenali sebagai FCA — `getIdxTickSize` hanya menerima `=== true` | Audit seluruh repo (`findstr is_fca` di `lib/`, `api/`, `tools/`): tidak ada produsen yang mengirim string. Tidak reproducible dari alur produksi. |
| OBS-2 | `isFresh` dengan `maxAgeHours: 0` / negatif jatuh ke default 72 jam (`n(0) → null → || 72`) | Tidak ada pemanggil di repo yang mengirim nilai tersebut. Tidak ada kontrak yang dilanggar. |
| OBS-3 | ARB flat -15% untuk semua tier harga (`getIdxAutoRejectBand:1043`), sementara ARA bertingkat 35/25/20%. Lead lama `FULL_REPO_FIX_LOG.md` F-069. | Tidak ada rujukan regulasi pembanding di repo dan tidak ada kontrak internal yang dilanggar. Dicatat sebagai pertanyaan terbuka untuk Fase berikutnya (perlu verifikasi aturan BEI/IDX terbaru). |
| OBS-4 | `fetchFreshScreenerLatestPrice` fallback VPS mengembalikan `price_age_hours: 0` meskipun `as_of_date` bridge bisa beda hari | Perilaku disengaja (harga live VWAP hari berjalan dari `fetchLivePriceFromVpsSync`); tidak ada kontrak yang dilanggar. |
| OBS-5 | `isStaleCandidate` hanya mendeteksi kata "stale" pada teks label, bukan pada flag numerik | Desain yang disengaja dan konsisten di seluruh modul; tidak ada test yang gagal. |

---

## REKAP BUKTI

| Artefak | Lokasi | Isi |
|---|---|---|
| Test suite | `test/audit-fase1-price-bugs.test.js` | 14 test (10 pembuktian + 4 lock) |
| Output FAIL pra-fix | `scratch/fase1-fail-evidence.txt` | 9 FAIL / 5 PASS |
| Output PASS pasca-fix | `scratch/fase1-pass-evidence.txt` | 14 PASS / 0 FAIL × 2 run |
| Perbaikan resolver | `lib/latest-price-resolver.js` | +40/−11 baris (3 blok) |
| Perbaikan tick | `lib/idx-tick-normalization.js` | +11/−3 baris (1 blok) |
| Registrasi build | `tools/curated-build-tests.json:38` | test baru terdaftar |

**Total: 3 bug diperbaiki, 1 hipotesis ditolak dengan alasan terdokumentasi, 5 observasi tanpa bukti fail, 208 assertion PASS / 0 FAIL lintas 3 run suite baru + 3 batch anti-regresi.**
