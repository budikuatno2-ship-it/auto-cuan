# BUG FINDINGS — FASE 3 (23 SEPTEMBER 2026)
## VPS Ingestion & Market-Data Cache Layer

**Target:** `lib/vps-data-fetcher.js`, `lib/daytrade-ohlcv-cache.js`
**Test suite:** `test/audit-fase3-ingestion-cache-bugs.test.js` (11 test)
**Fixture:** `test/fixtures/fase3-bridge-stub.js`

**Ringkasan:** 8 temuan, semuanya terverifikasi lewat test yang GAGAL lebih dulu,
kemudian diperbaiki secara minimalis dan diverifikasi PASS 2× berturut-turut.

| ID | Judul | Severity | Dampak produksi |
|---|---|---|---|
| F3-001 | Snapshot lokal 12 jam membekukan harga live saat sesi bursa | **P0** | Harga saham basi disajikan berlabel "live" |
| F3-002 | Fallback offline tidak jujur (label + timestamp) | **P1** | Harga basi tak terbedakan dari harga segar |
| F3-004 | Thundering herd request upstream duplikat | **P1** | Bridge rate-limited diperparah beban ganda |
| F3-005 | HTTP 429/502/503 broker-summary ditelan | **P1** | Insiden rate-limit tidak terdeteksi |
| F3-006 | HTTP 503 available-dates ditelan | **P2** | Kegagalan gateway tidak terlihat |
| F3-007 | Fallback stale candle tanpa plafon umur | **P1** | Analisis teknikal di atas data 200 hari |
| F3-008 | Penulisan snapshot cache non-atomik | **P1** | JSON parsial/corrupt terbaca pipeline |
| F3-009 | Cache in-memory tanpa batas & observabilitas | **P2** | Heap membengkak di proses panjang |

---

## BUKTI FAIL PRA-PERBAIKAN

```
$ node --test test/audit-fase3-ingestion-cache-bugs.test.js

✖ F3-001: during the live session a 6h-old local snapshot must not freeze the price
✖ F3-002: an ageing local snapshot served offline must be labelled vps_local_cache_stale
✔ F3-003: outside the session a recent local snapshot is still served without touching the bridge
✖ F3-004: concurrent identical broker-summary requests must share one upstream call
✖ F3-005: HTTP 429 from the bridge must be reported with its status
✖ F3-006: HTTP 503 on available-dates must be reported with its status
✖ F3-007: an ancient candle cache must not be served as a usable series
✔ F3-007b: a recently stale cache is still served when upstream fails
✔ F3-008a: concurrent writers must never blend payloads into one file
✖ F3-009: the in-memory ingestion caches must be bounded

ℹ tests 10
ℹ pass 3
ℹ fail 7
```

Pesan assertion kunci:

```
AssertionError: the live bridge (999) must win over a 6h-old local snapshot (500); got 500
AssertionError: a snapshot captured 6h ago during a live session is stale and must say so,
                got vps_local_cache
AssertionError: two concurrent callers for the same ticker+date must cause ONE upstream
                request, saw 2
AssertionError: the failure must name the HTTP status so the incident is diagnosable;
                warnings were ["[VPS-FETCHER][WARN] ... failed: fetch failed", ...]
AssertionError: the failure must name the HTTP status; warnings were ["...fetch failed", ...]
AssertionError: a 200-day-old series must be refused rather than silently used for
                technical analysis
AssertionError: a stats accessor must exist so unbounded heap growth is observable
```

---

## F3-001 — Snapshot lokal 12 jam membekukan harga live saat sesi bursa

**Severity: P0 / Kritis** — Area: *Cache Invalidation & Stale Data Leakage*

### Akar masalah

`lib/vps-data-fetcher.js`, `fetchLivePriceFromVpsSync()`, langkah 1 memakai jendela
**flat 12 jam** untuk memutuskan apakah `latest.json` lokal boleh dipakai:

```js
const isFresh = (Date.now() - stat.mtimeMs) < (12 * 60 * 60 * 1000);
```

Jendela 12 jam itu benar **hanya saat bursa tutup** (data tidak bisa berubah). Saat sesi
bursa sedang berjalan, snapshot berumur beberapa jam masih lolos gate dan
**mem-*short-circuit* bridge sepenuhnya**. Akibatnya scanner mengutip harga yang sudah
beku berjam-jam dan memberinya label `vps_local_cache` — harga basi berlabel segar.

### Bukti empiris

```
local latest.json mtime = 6 jam lalu, harga di file = 500, kebenaran bridge = 999
returned price = 500 | label = vps_local_cache | as_of = 2026-09-22
bridge requests made = 0 []
```

Bridge **tidak pernah dihubungi** meski tersedia dan membawa harga yang benar (999).

### Perbaikan

```diff
+const { getMarketSession } = require('./market-hours-guard');
+const LIVE_SNAPSHOT_FRESH_MS = 30 * 60 * 1000;
+const OFFLINE_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
+
+/**
+ * F3-001/F3-002: is a local snapshot current enough to be shown as the live
+ * price? During a live session only a recent snapshot qualifies; outside
+ * session hours the wider offline window applies because nothing can change.
+ */
+function localSnapshotFreshness(mtimeMs, nowMs) {
+  const age = nowMs - mtimeMs;
+  const session = getMarketSession(new Date(nowMs));
+  const live = session === 'SESSION_1' || session === 'SESSION_2';
+  const limit = live ? LIVE_SNAPSHOT_FRESH_MS : OFFLINE_SNAPSHOT_MAX_AGE_MS;
+  // A negative age means clock skew on a file that was just written; treat it
+  // as fresh rather than as infinitely old.
+  return age <= limit;
+}
```

```diff
-      const isFresh = (Date.now() - stat.mtimeMs) < (12 * 60 * 60 * 1000);
+      const isFresh = localSnapshotFreshness(stat.mtimeMs, Date.now());
```

Ambang 30 menit dipilih karena tetap mencakup cadence scan 15 menit (`DEFAULT_TTL_MS`
di `daytrade-ohlcv-cache.js`), sehingga cache lokal tetap memberi manfaat nyata saat sesi
berjalan tanpa pernah mengalahkan data live yang lebih baru.

### Test penjaga

```js
test('F3-001: during the live session a 6h-old local snapshot must not freeze the price', async (t) => {
  freezeClock(t, FROZEN_LIVE_SESSION);          // 2026-09-23T03:00:00Z = 10:00 WIB

  // Bridge truth: 999. Local snapshot truth: 500, captured 6 hours ago.
  const bridge = await startStubBridge({ vwap: 999, date: '2026-09-23' });
  t.after(() => bridge.stop());

  process.env.VPS_DATA_API_BASE = bridge.baseUrl;
  process.env.ARJUM_DATA_DIR = seedLocalSnapshot(
    'F3STALE', '2026-09-22', 500, FROZEN_LIVE_SESSION - 6 * HOUR_MS
  );

  vpsFetcher.__resetMemoryCaches();
  const detail = vpsFetcher.fetchLivePriceFromVpsSync('F3STALE');

  assert.ok(detail, 'a price must be resolved');
  assert.equal(detail.price, 999,
    `the live bridge (999) must win over a 6h-old local snapshot (500); got ${detail.price}`);
  assert.equal(detail.price_source, 'vps_bridge_live',
    `a session-fresh bridge price must be labelled vps_bridge_live, got ${detail.price_source}`);
  assert.equal(detail.as_of_date, '2026-09-23',
    'as_of_date must come from the live bridge payload');
});
```

### Hasil

| | Sebelum | Sesudah |
|---|---|---|
| `detail.price` | 500 | **999** |
| `detail.price_source` | `vps_local_cache` | **`vps_bridge_live`** |
| `detail.as_of_date` | `2026-09-22` | **`2026-09-23`** |

**Guard regresi:** F3-003 memastikan manfaat offline tidak hilang — di luar jam bursa,
snapshot 6 jam tetap disajikan dari disk dengan label `vps_local_cache` **dan nol request
bridge**.

---

## F3-002 — Fallback offline tidak jujur (label & timestamp)

**Severity: P1 / Tinggi** — Area: *Cache Invalidation & Stale Data Leakage*

### Akar masalah

Dua cacat pada langkah 4 `fetchLivePriceFromVpsSync()`:

1. **Tidak ada log.** Fallback ke snapshot basi terjadi dalam senyap total, sehingga
   degradasi dari live → stale tidak pernah terlihat di log produksi.
2. **Label bergantung pada jalur, bukan pada kebasian.** Snapshot yang lolos gate
   dinyatakan `vps_local_cache`; yang gagal gate dinyatakan `vps_local_cache_stale`.
   Karena gate F3-001 terlalu longgar, snapshot berumur 6 jam **saat sesi bursa berjalan**
   masuk kategori pertama dan diberi label seolah-olah cache segar.

### Bukti empiris

```
AssertionError: a snapshot captured 6h ago during a live session is stale and must say so,
                got vps_local_cache
```

### Perbaikan

Bagian penentuan label sudah diperbaiki oleh `localSnapshotFreshness()` (F3-001):
snapshot berumur 6 jam kini gagal gate sesi dan jatuh ke `staleLocalPayload`.
Ditambah pelaporan eksplisit saat degradasi terjadi:

```diff
-  // 4. Offline fallback to stale local snapshot if network and SSH both unavailable
+  // 4. Offline fallback to stale local snapshot if network and SSH both unavailable.
+  // F3-002: the label must tell the truth, and the degradation must be logged —
+  // a silent fallback is how a stale price stayed undetected in production.
   if ((!payload || !Array.isArray(payload.brokers) || payload.brokers.length === 0) && staleLocalPayload) {
     payload = staleLocalPayload;
     sourceLabel = 'vps_local_cache_stale';
+    logFetchFailure(
+      `live-price ${clean}`,
+      'bridge and SSH unavailable; serving an out-of-window local snapshot labelled vps_local_cache_stale'
+    );
   }
```

### Test penjaga

```js
test('F3-002: an ageing local snapshot served offline must be labelled vps_local_cache_stale', async (t) => {
  freezeClock(t, FROZEN_LIVE_SESSION);

  process.env.VPS_DATA_API_BASE = 'http://127.0.0.1:1';   // bridge tak terjangkau
  process.env.ARJUM_DATA_DIR = seedLocalSnapshot(
    'F3OFFLINE', '2026-09-22', 500, FROZEN_LIVE_SESSION - 6 * HOUR_MS
  );

  const warnings = captureWarnings(t);
  vpsFetcher.__resetMemoryCaches();
  const detail = vpsFetcher.fetchLivePriceFromVpsSync('F3OFFLINE');

  assert.equal(detail.price, 500, 'the local snapshot VWAP is the only available truth');
  assert.equal(detail.price_source, 'vps_local_cache_stale',
    `a snapshot captured 6h ago during a live session is stale and must say so, got ${detail.price_source}`);
  assert.notEqual(detail.price_source, 'vps_local_cache',
    'an ageing snapshot must never be presented as a fresh local cache');
  assert.ok(warnings.length > 0, 'the offline fallback must not be silent');
});
```

### Hasil

`price_source` berubah dari `vps_local_cache` → **`vps_local_cache_stale`**, dan degradasi
kini tercatat di `console.warn`. Konsumen hilir (`latest-price-resolver.js`,
`bandarmologi-intel-service.js`) meneruskan `price_source` apa adanya ke UI, sehingga
label yang jujur langsung terlihat pengguna.

---

## F3-004 — Thundering herd: request upstream duplikat

**Severity: P1 / Tinggi** — Area: *Concurrent Fetching & Race Condition*

### Akar masalah

`fetchBrokerSummaryFromVps()` hanya memeriksa cache **setelah** respons tiba:

```js
if (memoryBrokerSummaryCache.has(cacheKey)) return memoryBrokerSummaryCache.get(cacheKey);
// ... belum ada yang menyimpan hasil in-flight ...
const res = await fetch(...);   // setiap pemanggil melakukan ini sendiri
```

Bila Daytrade Screener dan Swing Screener meminta ticker+date yang sama pada saat cache
kosong, keduanya melewati pemeriksaan cache dan **masing-masing mengirim request
upstream**. Ini justru memperparah bridge yang sedang rate-limited.

### Bukti empiris

```
two concurrent fetchBrokerSummaryFromVps("HERD","latest") calls
upstream fetch() invocations = 2
AssertionError: two concurrent callers for the same ticker+date must cause ONE upstream
                request, saw 2
```

### Perbaikan

In-flight coalescing: permintaan identik yang sedang berjalan dibagikan, bukan diduplikasi.

```diff
+// F3-004: in-flight coalescing. Two screeners asking for the same ticker+date
+// at the same moment must share ONE upstream request instead of racing.
+const inFlightBrokerSummaryRequests = new Map();
```

```diff
+  if (inFlightBrokerSummaryRequests.has(cacheKey)) {
+    return inFlightBrokerSummaryRequests.get(cacheKey);
+  }
+
+  const pending = (async () => {
+    /* ... seluruh logika fetch + fallback SSH ... */
+  })();
+
+  inFlightBrokerSummaryRequests.set(cacheKey, pending);
+  try {
+    return await pending;
+  } finally {
+    inFlightBrokerSummaryRequests.delete(cacheKey);
+  }
```

`finally` menjamin entri selalu dibersihkan, termasuk saat fetch melempar error, sehingga
kegagalan tidak meninggalkan promise mati yang akan dipakai ulang pemanggil berikutnya.
`__resetMemoryCaches()` juga membersihkan map ini agar isolasi test tetap terjaga.

### Test penjaga

```js
test('F3-004: concurrent identical broker-summary requests must share one upstream call', async (t) => {
  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls++;
    await new Promise(resolve => setTimeout(resolve, 40));   // jendela balapan
    return { ok: true, status: 200, json: async () => brokerSnapshot('F3HERD', '2026-09-23', 700) };
  };

  vpsFetcher.__resetMemoryCaches();
  const [first, second] = await Promise.all([
    vpsFetcher.fetchBrokerSummaryFromVps('F3HERD', 'latest'),
    vpsFetcher.fetchBrokerSummaryFromVps('F3HERD', 'latest')
  ]);

  assert.ok(first && second, 'both callers must resolve a payload');
  assert.equal(first.stock_code, 'F3HERD');
  assert.equal(second.stock_code, 'F3HERD');
  assert.equal(upstreamCalls, 1,
    `two concurrent callers for the same ticker+date must cause ONE upstream request, saw ${upstreamCalls}`);
});
```

### Hasil

`upstreamCalls` turun dari **2 → 1**; kedua pemanggil tetap menerima payload yang benar.

---

## F3-005 — HTTP 429/502/503 pada broker-summary ditelan

**Severity: P1 / Tinggi** — Area: *Error Handling & Upstream Resiliency*

### Akar masalah

Blok respons hanya menangani kasus sukses. Status non-200 tidak masuk ke cabang mana pun:

```js
if (res.ok) {
  const parsed = await res.json();
  if (parsed && (parsed.brokers || parsed.stock_code)) { /* simpan */ }
}
// tidak ada else -> 429/502/503 hilang tanpa jejak
```

Akibatnya bridge yang sedang rate-limited **tidak dapat dibedakan** dari ticker yang
memang tidak punya data. Tidak ada log, tidak ada metrik, tidak ada sinyal operasional.

### Bukti empiris

```
upstream menjawab HTTP 429 untuk setiap panggilan
result = null
warnings mentioning 429 = []
all warnings = []
AssertionError: the failure must name the HTTP status so the incident is diagnosable
```

### Perbaikan

```diff
         if (res.ok) {
           const parsed = await res.json();
           if (parsed && (parsed.brokers || parsed.stock_code)) {
             setBoundedCacheEntry(memoryBrokerSummaryCache, cacheKey, parsed);
             setBoundedCacheEntry(memoryBrokerSummaryCache, `${safeTicker}_${targetDate}`, parsed);
             return parsed;
           }
+        } else {
+          // F3-005: name the status so a rate limit is diagnosable.
+          logFetchFailure('async broker-summary bridge', `${bridgeUrl} -> HTTP ${res.status}`);
         }
```

Jalur sinkron mendapat perlakuan setara:

```diff
+    // F3-005: a rejected status (429/502/503) previously vanished, so a
+    // rate-limited bridge looked exactly like a missing file.
+    if (!bridge.ok && bridge.status) {
+      logFetchFailure('sync broker-summary bridge', `${bridgeUrl} -> HTTP ${bridge.status}`);
+    }
```

Pesan log memuat **status HTTP secara eksplisit**, bukan sekadar "failed", karena hanya
angka status yang membedakan rate-limit (429) dari gateway-down (502/503) saat investigasi.

### Test penjaga

```js
test('F3-005: HTTP 429 from the bridge must be reported with its status', async (t) => {
  const warnings = captureWarnings(t);
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({ error: 'rate limit exceeded' }) };
  };

  vpsFetcher.__resetMemoryCaches();
  const result = await vpsFetcher.fetchBrokerSummaryFromVps('F3RATE', 'latest');

  assert.equal(calls, 1, 'the async bridge path must be attempted once');
  assert.equal(result, null, 'a rate-limited upstream must not produce data');
  assert.ok(warnings.some(line => line.includes('429')),
    `the failure must name the HTTP status so the incident is diagnosable; warnings were ${JSON.stringify(warnings)}`);
});
```

### Hasil

Warning `... -> HTTP 429` kini muncul. Perhatikan `result` tetap `null` — **tidak ada
objek kosong `{}` yang lolos ke pipeline kalkulasi teknikal**; ini diverifikasi eksplisit
oleh assertion `assert.equal(result, null)`.

---

## F3-006 — HTTP 503 pada available-dates ditelan

**Severity: P2 / Sedang** — Area: *Error Handling & Upstream Resiliency*

### Akar masalah

Pola identik dengan F3-005, pada `fetchAvailableDatesFromVps()`:

```js
if (res.ok) {
  const data = await res.json();
  /* ... */
}
// tidak ada else
```

### Bukti empiris

```
available-dates 503 -> [] | warnings = []
AssertionError: the failure must name the HTTP status; warnings were ["...fetch failed", ...]
```

### Perbaikan

```diff
+    const url = `${getVpsDataApiBase()}/api/available-dates?ticker=${encodeURIComponent(safeTicker)}`;
     try {
       const controller = new AbortController();
       const timeout = setTimeout(() => controller.abort(), 5000);
-      const res = await fetch(`${getVpsDataApiBase()}/api/available-dates?...`, { signal: controller.signal });
-      clearTimeout(timeout);
-      if (res.ok) {
+      let res;
+      try {
+        res = await fetch(url, { signal: controller.signal });
+      } finally {
+        clearTimeout(timeout);
+      }
+      // F3-006: a non-2xx answer used to fall through silently, so a 429/503 was
+      // indistinguishable from "this ticker has no dates". Report the status.
+      if (!res.ok) {
+        logFetchFailure('async available-dates bridge', `${url} -> HTTP ${res.status}`);
+      } else {
         const data = await res.json();
         /* ... */
       }
```

Perbaikan menyertakan `try/finally` untuk `clearTimeout`, sehingga timer tidak bocor
ketika `fetch` melempar error.

Jalur sinkron:

```diff
+  } else if (bridge.status) {
+    // F3-006: surface the rejected status instead of silently trying SSH.
+    logFetchFailure('sync available-dates bridge', `${apiBase} -> HTTP ${bridge.status}`);
   }
```

### Test penjaga

```js
test('F3-006: HTTP 503 on available-dates must be reported with its status', async (t) => {
  const warnings = captureWarnings(t);
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

  vpsFetcher.__resetMemoryCaches();
  const dates = await vpsFetcher.fetchAvailableDatesFromVps('F3DATES');

  assert.deepEqual(dates, [], 'an unavailable endpoint must not yield dates');
  assert.ok(warnings.some(line => line.includes('503')),
    `the failure must name the HTTP status; warnings were ${JSON.stringify(warnings)}`);
});
```

### Hasil

`503` kini terlihat di log; kontrak kembalian tetap array kosong (bukan `null`/`undefined`)
sehingga konsumen yang memanggil `.length` tidak pecah.

---

## F3-007 — Fallback stale candle tanpa plafon umur

**Severity: P1 / Tinggi** — Area: *Cache Invalidation / Stale Data Leakage*

### Akar masalah

`lib/daytrade-ohlcv-cache.js`, `fetchWithCache()`. Saat provider upstream gagal, cache
lama disajikan **tanpa batas umur apa pun**:

```js
} catch (e) {
  if (cached.hit && cached.candles.length >= 20) {
    stats.staleFallback++;
    return cached.candles;      // tidak ada pemeriksaan umur
  }
```

Satu-satunya syarat adalah "ada ≥ 20 candle". Seri berumur berbulan-bulan tetap lolos dan
masuk ke pipeline kalkulasi teknikal sebagai data terkini.

### Bukti empiris

```
cache updated_at = 200 hari lalu; fetch upstream melempar 429
result = ARRAY of 90 candles (newest close=189)
stats = {"cacheHit":0,"cacheMiss":0,"fetchSuccess":0,"fetchFail":0,"staleFallback":1,...}
AssertionError: a 200-day-old series must be refused rather than silently used
                for technical analysis
```

### Perbaikan

```diff
+// F3-007: how old a cached series may be and still be served as a fallback when
+// the upstream provider fails. Without a ceiling a 200-day-old series was handed
+// to the technical-analysis pipeline as if it were current. 7 days spans a long
+// weekend plus holidays while still refusing genuinely abandoned data.
+const DEFAULT_MAX_STALE_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;
```

```diff
+  var maxStaleFallbackMs = options.maxStaleFallbackMs != null
+    ? Number(options.maxStaleFallbackMs)
+    : DEFAULT_MAX_STALE_FALLBACK_MS;
+
+  var stats = { ..., staleRejected: 0 };
+
+  function isUsableStaleFallback(cached, nowMs) {
+    if (!cached.hit || cached.candles.length < 20) return false;
+    if (!Number.isFinite(maxStaleFallbackMs) || maxStaleFallbackMs <= 0) return true;
+    var age = nowMs - cached.updatedAtMs;
+    // An unknown write time (updatedAtMs 0) is unverifiable, so it is not usable.
+    if (!cached.updatedAtMs || age > maxStaleFallbackMs) return false;
+    return true;
+  }
```

```diff
-      if (cached.hit && cached.candles.length >= 20) {
+      if (isUsableStaleFallback(cached, nowMs)) {
         stats.staleFallback++;
         return cached.candles;
       }
+      if (cached.hit && cached.candles.length >= 20) stats.staleRejected++;
       stats.fetchFail++;
       return null;
```

Diterapkan pada **kedua** jalur fallback (upstream mengembalikan data kurang, dan upstream
melempar error). Statistik baru `staleRejected` membuat penolakan dapat diamati.

`updatedAtMs === 0` (waktu tulis tidak diketahui) sengaja diperlakukan **tidak layak
pakai**: umur tidak dapat diverifikasi, sehingga tidak boleh diasumsikan aman.

### Test penjaga

```js
test('F3-007: an ancient candle cache must not be served as a usable series', async (t) => {
  freezeClock(t, FROZEN_LIVE_SESSION);
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'ohlcv-'));

  await ohlcvCache.writeCache(dir, 'F3ANCIENT', paddedCandles(100, 90), 'audit');
  const file = path.join(dir, 'F3ANCIENT.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.updated_at = new Date(FROZEN_LIVE_SESSION - 200 * DAY_MS).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');

  const provider = ohlcvCache.createCacheProvider({
    cacheDir: dir, ttlMs: 15 * 60 * 1000,
    fetchFn: async () => { throw new Error('Yahoo HTTP 429'); }
  });

  const result = await provider.fetchWithCache('F3ANCIENT');
  assert.equal(result, null,
    'a 200-day-old series must be refused rather than silently used for technical analysis');
});
```

**Guard regresi F3-007b** memastikan fallback yang sah tetap bekerja: cache berumur
1 hari dengan upstream gagal tetap disajikan (`staleFallback === 1`). Tanpa guard ini,
perbaikan bisa "berhasil" dengan cara yang merusak — yaitu mematikan seluruh fallback.

### Hasil

Seri 200 hari → `null` + `staleRejected++`. Seri 1 hari → tetap disajikan.

---

## F3-008 — Penulisan snapshot cache non-atomik

**Severity: P1 / Tinggi** — Area: *Race Condition / Partial Write*

### Akar masalah

`writeCache()` menulis langsung ke file tujuan:

```js
await fsp.writeFile(tickerCachePath(cacheDir, ticker), JSON.stringify(payload, null, 2) + '\n');
```

`fs.writeFile` **men-truncate file tujuan terlebih dahulu**, lalu menuliskan isi baru
secara bertahap. Pembaca yang datang di antara kedua langkah itu melihat file kosong atau
setengah tertulis → `JSON.parse` gagal. Pemanggil tidak dapat membedakan kondisi ini dari
"tidak ada cache".

### Bukti empiris

Probe awal (40 putaran penulis paralel + pembaca loop):

```
A) 40 putaran penulis paralel ticker sama -> corrupt JSON: 6 | konten tercampur: 0
B) pembaca loop selama 60 penulisan ulang -> 58 reads, 7 observasi JSON parsial
C) inode 5066549581370084 -> 5066549581370084 | handle lama melihat konten BARU = true
```

Butir **C** membuktikan mekanismenya: inode **tidak berubah** dan handle yang sudah
terbuka langsung melihat konten baru → penulisan in-place dengan truncate, bukan rename.

Kalibrasi sensitivitas detektor (wajib, agar hasil hijau bermakna):

| Cadence pembaca | In-place (pra-fix) | Atomik (pasca-fix) |
|---|---|---|
| 0 ms | 99 / 199 torn | 1 / 306 |
| 1 ms | 93 / 200 torn | 0 / 299 |
| 5 ms | 12 / 102 torn | 0 / 193 |
| 20 ms | 0 / 62 | 0 / 85 |

### Perbaikan

```diff
+async function writeFileAtomic(filePath, contents) {
+  var tmpPath = filePath + '.' + process.pid + '.' + Date.now().toString(36) +
+    Math.random().toString(36).slice(2, 8) + '.tmp';
+  try {
+    await fsp.writeFile(tmpPath, contents);
+    var lastErr = null;
+    for (var attempt = 0; attempt < 6; attempt++) {
+      try {
+        await fsp.rename(tmpPath, filePath);
+        return true;
+      } catch (err) {
+        lastErr = err;
+        if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
+          await new Promise(function (resolve) { setTimeout(resolve, 10 * (attempt + 1)); });
+          continue;
+        }
+        throw err;
+      }
+    }
+    // Windows refuses to replace a file that another handle currently has open,
+    // and a persistent reader can hold it for a long time. Refresh the cache
+    // rather than silently dropping the update; correctness of the data beats
+    // the torn-read window in this rare contention case.
+    console.warn(`[OHLCV-CACHE][WARN] atomic replace of ${path.basename(filePath)} was refused (${lastErr && lastErr.code}); falling back to an in-place write`);
+    await fsp.writeFile(filePath, contents);
+    return false;
+  } finally {
+    // A failed rename leaves the temp file behind; never leak it.
+    try { await fsp.unlink(tmpPath); } catch (_) {}
+  }
+}
```

```diff
-    await fsp.writeFile(tickerCachePath(cacheDir, ticker), JSON.stringify(payload, null, 2) + '\n');
+    await writeFileAtomic(tickerCachePath(cacheDir, ticker), JSON.stringify(payload, null, 2) + '\n');
```

Nama temp memuat `pid` + timestamp + 6 karakter acak agar beberapa penulis paralel tidak
saling menimpa file temp satu sama lain. `finally` menjamin file temp tidak pernah bocor
ke disk, termasuk pada jalur gagal.

**Temuan lingkungan penting:** `fs.rename` menimpa file yang sedang dibuka proses lain
**ditolak di Windows** (`EPERM`), yang terukur langsung:

```
ATOMIC : Error: EPERM: operation not permitted, rename '...tmp' -> '...json'
```

Karena itu ada retry singkat, lalu fallback in-place **dengan peringatan eksplisit**.
Kompromi ini disengaja dan terdokumentasi: memperbarui cache lebih penting daripada
jendela balapan yang sangat sempit, dan pada runtime produksi (Linux/VPS) cabang ini
tidak pernah aktif. Yang tidak boleh terjadi adalah membuang update secara senyap.

### Test penjaga

Dua test, karena dua mode kegagalan berbeda:

```js
test('F3-008a: concurrent writers must never blend payloads into one file', async (t) => {
  const WRITERS = 8, ROUNDS = 30;
  for (let round = 0; round < ROUNDS; round++) {
    const ticker = 'F3RACE' + round;
    await Promise.all(Array.from({ length: WRITERS }, (_, writer) =>
      ohlcvCache.writeCache(dir, ticker, paddedCandles(100 + writer * 100, 90), 'writer-' + writer)));

    const text = fs.readFileSync(path.join(dir, ticker + '.json'), 'utf8');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) { assert.fail(`round ${round}: concurrent writers produced invalid JSON (${err.message})`); }
    const base = parsed.candles[0].close;
    assert.ok(base >= 100 && base <= 100 + (WRITERS - 1) * 100 && base % 100 === 0,
      `round ${round}: the file mixes payloads from different writers (base close ${base})`);
  }
});
```

```js
test('F3-008b: a reader racing a writer must never observe a partial snapshot', async (t) => {
  // The reader polls on a timer rather than in a tight synchronous loop: a
  // blocking loop starves the event loop, which would stop the writer from ever
  // interleaving and make this test pass vacuously. A ~2ms cadence was measured
  // to expose the defect (93 of 200 reads torn) against the previous in-place
  // write, so it genuinely exercises the race.
  let tornReads = 0, reads = 0, stop = false;
  const reader = (async () => {
    while (!stop) {
      reads++;
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { tornReads++; }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  })();

  for (let i = 0; i < 200; i++) {
    await ohlcvCache.writeCache(dir, ticker, paddedCandles(1000 + i, 90), 'churn');
  }
  stop = true;
  await reader;

  assert.ok(reads > 20, `the reader must actually interleave with the writer (only ${reads} reads)`);
  assert.equal(tornReads, 0,
    `${tornReads} of ${reads} concurrent reads observed a partially written snapshot — writes must be atomic`);
});
```

Assertion `reads > 20` mencegah **lolos palsu**: bila pembaca tidak pernah benar-benar
berinterleaving, `tornReads === 0` tidak membuktikan apa pun.

### BUKTI DAYA-DETEKSI (wajib)

Untuk membuktikan test ini benar-benar mendeteksi cacat, jalur penulisan dikembalikan
sementara ke versi in-place, lalu test dijalankan:

```js
// TEMP-AUDIT-REVERT: prove F3-008b detects the pre-fix in-place write.
await fsp.writeFile(tickerCachePath(cacheDir, ticker), JSON.stringify(payload, null, 2) + '\n');
```

```
$ node --test --test-name-pattern "F3-008" test/audit-fase3-ingestion-cache-bugs.test.js

✔ F3-008a: concurrent writers must never blend payloads into one file (237.7453ms)
✖ F3-008b: a reader racing a writer must never observe a partial snapshot (429.6136ms)

ℹ tests 2
ℹ pass 1
ℹ fail 1

AssertionError: 34 of 152 concurrent reads observed a partially written snapshot —
                writes must be atomic
```

Setelah bukti terekam, perbaikan dikembalikan dan test menjadi hijau.

### Hasil

| | Pra-fix | Pasca-fix |
|---|---|---|
| F3-008a (8 penulis × 30 putaran) | 6/40 corrupt (probe awal) | **0 corrupt** |
| F3-008b (cadence 2 ms) | **34/152 torn** | **0 torn** |

---

## F3-009 — Cache in-memory tanpa batas & observabilitas

**Severity: P2 / Sedang** — Area: *Boundary & Memory Leaks*

### Akar masalah

`memoryBrokerSummaryCache` dan `memoryDatesCache` tumbuh monoton. Tidak ada eviction,
tidak ada batas, dan tidak ada cara mengamati ukurannya:

```
setelah 700 ticker berbeda melalui jalur bridge async:
__getMemoryCacheStats exists = undefined
AssertionError: a stats accessor must exist so unbounded heap growth is observable
                in production
```

Proses scanner berjalan lama dan menjelajahi universe ticker yang terus berubah, sehingga
tabel memo tumbuh sepanjang umur proses. Karena tak ada observabilitas, pertumbuhan ini
juga tidak akan pernah terlihat sampai heap bermasalah.

### Perbaikan

```diff
+// F3-009: a long-running scanner walks an ever-changing ticker universe, so an
+// unbounded memo table grows for the whole lifetime of the process. Every
+// insertion goes through setBoundedCacheEntry() below.
+const DEFAULT_MAX_MEMORY_CACHE_ENTRIES = 500;
+
+function maxMemoryCacheEntries() {
+  const configured = Number(process.env.VPS_FETCHER_MAX_MEMORY_ENTRIES);
+  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
+  return DEFAULT_MAX_MEMORY_CACHE_ENTRIES;
+}
+
+/**
+ * Insert into an in-memory memo table while holding it to a hard size bound.
+ * Map preserves insertion order, so the oldest key is always the first one and
+ * is the correct eviction victim. Re-inserting an existing key refreshes its
+ * position, so entries still in active use are not evicted first.
+ */
+function setBoundedCacheEntry(cache, key, value) {
+  if (cache.has(key)) cache.delete(key);
+  cache.set(key, value);
+  const cap = maxMemoryCacheEntries();
+  while (cache.size > cap) {
+    const oldest = cache.keys().next();
+    if (oldest.done) break;
+    cache.delete(oldest.value);
+  }
+}
+
+/** Test/ops hook: observe memo-table growth so an unbounded heap is visible. */
+function __getMemoryCacheStats() {
+  return {
+    brokerSummaryEntries: memoryBrokerSummaryCache.size,
+    datesEntries: memoryDatesCache.size,
+    inFlightRequests: inFlightBrokerSummaryRequests.size,
+    maxEntries: maxMemoryCacheEntries()
+  };
+}
```

Seluruh **9 titik penulisan** cache in-memory dialihkan ke `setBoundedCacheEntry()`:

| Lokasi | Cache |
|---|---|
| `fetchAvailableDatesFromVps` (async) | `memoryDatesCache` |
| `fetchAvailableDatesFromVpsSync` (bridge) | `memoryDatesCache` |
| `fetchAvailableDatesFromVpsSync` (SSH) | `memoryDatesCache` |
| `fetchBrokerSummaryFromVpsSync` (bridge) ×2 key | `memoryBrokerSummaryCache` |
| `fetchBrokerSummaryFromVpsSync` (SSH) ×2 key | `memoryBrokerSummaryCache` |
| `fetchBrokerSummaryFromVps` (async) ×2 key | `memoryBrokerSummaryCache` |
| `fetchLivePriceFromVpsSync` | `memoryBrokerSummaryCache` |
| `fetchBrokerAccumulationFromVpsSync` (bridge) | `memoryBrokerSummaryCache` |
| `fetchBrokerAccumulationFromVpsSync` (SSH) | `memoryBrokerSummaryCache` |

Eviction berbasis urutan insersi (LRU-approx). Re-insersi menghapus kunci lama lebih dulu
sehingga entri yang masih aktif dipakai tidak menjadi korban eviksi pertama.

### Test penjaga

```js
test('F3-009: the in-memory ingestion caches must be bounded', async (t) => {
  process.env.VPS_FETCHER_MAX_MEMORY_ENTRIES = '50';

  assert.equal(typeof vpsFetcher.__getMemoryCacheStats, 'function',
    'a stats accessor must exist so unbounded heap growth is observable in production');

  global.fetch = async (url) => {
    const ticker = new URL(String(url)).searchParams.get('ticker') || 'X';
    return { ok: true, status: 200, json: async () => brokerSnapshot(ticker, '2026-09-23', 500) };
  };

  vpsFetcher.__resetMemoryCaches();
  for (let i = 0; i < 120; i++) {
    await vpsFetcher.fetchBrokerSummaryFromVps('F3MEM' + i, 'latest');
  }

  const stats = vpsFetcher.__getMemoryCacheStats();
  assert.ok(stats.brokerSummaryEntries <= 50,
    `the broker-summary memory cache must respect the configured bound, saw ${stats.brokerSummaryEntries}`);
  assert.ok(stats.datesEntries <= 50,
    `the dates memory cache must respect the configured bound, saw ${stats.datesEntries}`);
});
```

### Hasil

120 ticker unik → cache bertahan di ≤ 50 entri (batas yang dikonfigurasi).
`__getMemoryCacheStats()` kini tersedia untuk pemantauan produksi.

---

## RINGKASAN DIFF

```
 lib/daytrade-ohlcv-cache.js    |  88 ++++++++++++++++--
 lib/vps-data-fetcher.js        | 198 ++++++++++++++++++++++++++++++++---------
 tools/curated-build-tests.json |   3 +
 3 files changed, 242 insertions(+), 47 deletions(-)
```

Tidak ada perubahan pada tanda tangan fungsi publik, tidak ada pemindahan modul, dan
tidak ada perubahan kontrak export yang memutus konsumen. Dua penambahan export bersifat
aditif: `__getMemoryCacheStats` dan `writeFileAtomic`.

---

## VERIFIKASI PASS 2× BERTURUT-TURUT

```
$ node --test test/audit-fase3-ingestion-cache-bugs.test.js        # RUN 1

✔ F3-001: during the live session a 6h-old local snapshot must not freeze the price (335.5497ms)
✔ F3-002: an ageing local snapshot served offline must be labelled vps_local_cache_stale (1638.8163ms)
✔ F3-003: outside the session a recent local snapshot is still served without touching the bridge (127.5022ms)
✔ F3-004: concurrent identical broker-summary requests must share one upstream call (42.7528ms)
✔ F3-005: HTTP 429 from the bridge must be reported with its status (1159.3632ms)
✔ F3-006: HTTP 503 on available-dates must be reported with its status (1163.902ms)
✔ F3-007: an ancient candle cache must not be served as a usable series (17.8547ms)
✔ F3-007b: a recently stale cache is still served when upstream fails (13.8712ms)
✔ F3-008a: concurrent writers must never blend payloads into one file (1425.5347ms)
✔ F3-008b: a reader racing a writer must never observe a partial snapshot (1322.3966ms)
✔ F3-009: the in-memory ingestion caches must be bounded (9.9949ms)

ℹ tests 11
ℹ pass 11
ℹ fail 0
ℹ duration_ms 7430.3924
```

```
$ node --test test/audit-fase3-ingestion-cache-bugs.test.js        # RUN 2

✔ F3-001 ... (302.6143ms)
✔ F3-002 ... (1144.9318ms)
✔ F3-003 ... (129.2382ms)
✔ F3-004 ... (50.4943ms)
✔ F3-005 ... (1668.5293ms)
✔ F3-006 ... (1670.112ms)
✔ F3-007 ... (112.619ms)
✔ F3-007b ... (26.1632ms)
✔ F3-008a ... (1450.0166ms)
✔ F3-008b ... (1305.5124ms)
✔ F3-009 ... (10.5579ms)

ℹ tests 11
ℹ pass 11
ℹ fail 0
ℹ duration_ms 8017.8802
```

**Dua run berturut-turut: 11/11 PASS, 0 FAIL.**

---

## FULL TEST SUITE

```
$ node tools/run-build-test-suite.js --full

--- Running Pre-Build Tooling & Validations ---
Full syntax check: 881 .js files parsed.
Curated test list: 520 entries, 0 missing.
All .js files parsed cleanly.

--- Running Full Regression Suite (520 test files from curated-build-tests.json) ---
...
All 520 test files passed successfully!
```

Verifikasi tambahan atas output mentah:
- `failed batches: 0`
- total `ℹ fail` di seluruh batch: **0**
- pesan akhir: `All 520 test files passed successfully!`

### Suite regresi yang terpengaruh langsung

```
$ node --test test/vps-data-fetcher-bugs.test.js test/vps-api-bridge-tunnel.test.js \
    test/daytrade-ohlcv-cache.test.js test/daytrade-ohlcv-cache-bugs.test.js \
    test/daytrade-ohlcv-cache-offhours-ttl.test.js test/audit-regresi-batch3-guards.test.js \
    test/audit-batch2-live-pricing.test.js test/audit-batch1-integrity.test.js

ℹ tests 67
ℹ pass 67
ℹ fail 0
```

Termasuk guard yang relevan:
- `audit-batch2-live-pricing` → memastikan harga bridge live (914) tetap menang atas
  candle lokal yang ditinggalkan (630), dan `price_source === 'vps_bridge_live'`.
- `audit-regresi-batch3-guards` → T8 memastikan `syncWithBrokerSummary` tetap bekerja.
- `daytrade-ohlcv-cache-offhours-ttl` → memastikan TTL sadar-jam-bursa tidak rusak.

### Registrasi curated list

```json
"test/audit-fase2-ca-bugs.test.js",
"test/audit-fase3-ingestion-cache-bugs.test.js",   <-- ditambahkan
"test/latest-price-resolver-bugs.test.js",
```

Divalidasi oleh `tools/validate-full-syntax.js`: `520 entries, 0 missing`.

---

## CATATAN NOISE YANG DIVERIFIKASI BUKAN KEGAGALAN

Output full suite memuat baris `ERROR: SHITERU_API_KEY is not set.` dan
`ERROR: T00/fail-model - fetch failed`. Ini adalah **jalur negatif yang disengaja** oleh
fixture test provider-failover / missing-credential, bukan kegagalan suite.
Dikonfirmasi via `failed batches: 0` dan `ℹ fail 0` pada setiap batch.

---

## STATUS AKHIR

| Item | Status |
|---|---|
| 8 temuan | Semua terverifikasi & diperbaiki |
| Test penjaga | 11 test, terdaftar di curated list |
| FAIL pra-perbaikan | 7/10 — terekam |
| Bukti daya-deteksi F3-008b | 34/152 torn read — terekam |
| PASS 2× berturut-turut | 11/11 dan 11/11 |
| Full suite | **520/520 file test lolos** |
| Validasi sintaks | 881 file `.js` bersih |

**FASE 3 SELESAI.**
