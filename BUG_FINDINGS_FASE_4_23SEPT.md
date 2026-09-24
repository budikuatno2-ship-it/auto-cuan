# BUG FINDINGS — FASE 4 (23 SEPTEMBER 2026)
## Broker Summary & Bandarmologi Engine — Forensic Findings & Verified Fixes

**Metode:** Test-First Verification (reproduksi GAGAL → patch presisi → PASS 2×)
**Test suite:** `test/audit-fase4-broksum-bugs.test.js`
**Total temuan:** 8 bug riil (8 direproduksi, 8 diperbaiki, 8 terverifikasi)
**Full suite:** ✅ `All 521 test files passed successfully!`

---

## RINGKASAN EKSEKUTIF

| ID | Severity | File | Judul | Status |
|---|---|---|---|---|
| AUDIT-F4-10 | 🔴 CRITICAL | `lib/bandarmologi-service.js` | String numerik ribuan memusnahkan nilai rupiah | ✅ FIXED |
| AUDIT-F4-11 | 🔴 CRITICAL | `lib/bandarmologi-service.js` | `enrichBrokerItem` kolaps ke 0 pada feed string | ✅ FIXED |
| AUDIT-F4-12 | 🟠 HIGH | `lib/bandarmologi-service.js` | Phantom net `-1` (penjual hantu) | ✅ FIXED |
| AUDIT-F4-13 | 🔴 CRITICAL | `lib/bandarmologi-service.js` | Cross trade → CR3 100% + AKUMULASI_MASIF palsu | ✅ FIXED |
| AUDIT-F4-14 | 🔴 CRITICAL | `public/bandarmologi-runtime.js` | `normalizeBrokerValue` membuang semua string numerik | ✅ FIXED |
| AUDIT-F4-15 | 🟠 HIGH | `public/bandarmologi-runtime.js` | Net 0/NaN salah diklasifikasi "Normal Dist" | ✅ FIXED |
| AUDIT-F4-16 | 🟡 MEDIUM | `lib/bandarmologi-screener-scoring.js` | Ambang CR3 tidak konsisten (off-by-one boundary) | ✅ FIXED |
| AUDIT-F4-17 | 🟡 MEDIUM | `lib/bandarmologi-intel-service.js` | `cr3: 0` menyesatkan untuk saham suspend/FCA | ✅ FIXED |

**Pola akar masalah yang dominan:** `Number()` mentah pada payload yang bisa berupa string
(F4-10, F4-11, F4-14) dan **fallback yang memfabrikasi magnitudo** alih-alih mengakui ketiadaan
data (F4-12, F4-13, F4-17).

---

## AUDIT-F4-10 — 🔴 CRITICAL
### String numerik ribuan memusnahkan seluruh nilai rupiah di Broker Summary

**File:** `lib/bandarmologi-service.js`
**Fungsi:** `normalizeBrokerSummary()` → `parseBrokerRow()` (baris 613–616 sebelum patch)

#### Akar Masalah

```js
// SEBELUM (parseBrokerRow, baris 613–616)
let bval = Number(b.bval != null ? b.bval : (...));
let sval = Number(b.sval != null ? b.sval : (...));
let bvol = Number(b.bvol != null ? b.bvol : (...));
let svol = Number(b.svol != null ? b.svol : (...));
```

`Number("1.500.000.000")` mengembalikan **`NaN`**, bukan `1500000000`. Feed broker summary
Arjum/VPS dapat mengirim nilai sebagai string berformat ribuan Indonesia, sehingga:

- `bval` menjadi `NaN` → broker **hilang dari `gross_buyers`** (filter `> 0` gagal pada `NaN`)
- `net_flow` jatuh ke nilai volume (lot) sebagai pengganti rupiah
- `net_status` menjadi `BIG_ACCUMULATION` berdasarkan **jumlah lot**, bukan rupiah

Ini bukan kegagalan yang terlihat: tidak ada error, tidak ada warning — hanya angka yang salah.

#### Bukti FAIL (empiris)

```
✖ AUDIT-F4-10: normalizeBrokerSummary mempertahankan nilai rupiah dari string numerik ribuan
  AssertionError: bval must be parsed as Rp 1.5 Miliar, not NaN
  + actual: NaN
  - expected: 1500000000
```

Probe terpisah (`scratch/fase4-probe.js`) menunjukkan dampak penuh:

```
H1 gross_buyers => [{"broker":"AK","bval":null,"bvol":15000000,...,
                     "nval":15000000,"net_val":15000000,"avg_price":1}]
H1 net_flow     => 15000000        ← ini JUMLAH LOT, bukan rupiah!
H1 net_status   => "BIG_ACCUMULATION"
H1 total_buy_val=> null
```

Nilai riil seharusnya: `bval = 1.500.000.000`, `net_flow = +1.500.000.000`.

#### Patch (minimal diff)

Helper baru `toNumberLoose()` ditambahkan di `lib/bandarmologi-service.js`:

```js
/**
 * AUDIT-F4-10/11/12: feed broker summary Arjum & VPS dapat mengirim angka
 * sebagai string — plain ("1500000000"), ribuan bertitik Indonesia
 * ("1.500.000.000"), ribuan berkoma ("1,500,000,000"), atau berdesimal koma
 * ("1500,25"). `Number()` mentah mengembalikan NaN untuk semuanya kecuali
 * bentuk plain, yang membuat nilai rupiah hilang (NaN) atau kolaps menjadi 0.
 */
function toNumberLoose(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return null;

  let s = value.trim();
  if (!s || s === '-' || s === '—' || s === '–') return null;

  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/^\(/, '').replace(/\)$/, '');
  s = s.replace(/[Rprp](?=[\s.\d,])/g, '').replace(/[%+\s]/g, '');
  if (!s) return null;

  const hasDot = s.indexOf('.') >= 0;
  const hasComma = s.indexOf(',') >= 0;
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (hasDot) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }

  s = s.replace(/[^\d.eE+-]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative && n > 0 ? -n : n;
}
```

Diterapkan di `parseBrokerRow`:

```diff
   function parseBrokerRow(b, isBuyerDefault) {
     if (!b) return null;
     const code = b.broker_code || b.broker || b.code || '';
     const name = b.broker_name || b.name || '';
-    let bval = Number(b.bval != null ? b.bval : (b.buy_val != null ? b.buy_val : (b.val != null && isBuyerDefault ? b.val : 0)));
-    let sval = Number(b.sval != null ? b.sval : (b.sell_val != null ? b.sell_val : (b.val != null && !isBuyerDefault ? b.val : 0)));
-    let bvol = Number(b.bvol != null ? b.bvol : (b.buy_vol != null ? b.buy_vol : (b.vol != null && isBuyerDefault ? b.vol : 0)));
-    let svol = Number(b.svol != null ? b.svol : (b.sell_vol != null ? b.sell_vol : (b.vol != null && !isBuyerDefault ? b.vol : 0)));
-    let nval = b.nval != null ? Number(b.nval) : (b.net_val != null ? Number(b.net_val) : null);
-    let nvol = b.nvol != null ? Number(b.nvol) : (b.net_vol != null ? Number(b.net_vol) : null);
+    const pick = (...candidates) => {
+      for (const c of candidates) {
+        const n = toNumberLoose(c);
+        if (n != null) return n;
+      }
+      return 0;
+    };
+    let bval = pick(b.bval, b.buy_val, isBuyerDefault ? b.val : null);
+    let sval = pick(b.sval, b.sell_val, !isBuyerDefault ? b.val : null);
+    let bvol = pick(b.bvol, b.buy_vol, isBuyerDefault ? b.vol : null);
+    let svol = pick(b.svol, b.sell_vol, !isBuyerDefault ? b.vol : null);
+    let nval = b.nval != null ? toNumberLoose(b.nval) : (b.net_val != null ? toNumberLoose(b.net_val) : null);
+    let nvol = b.nvol != null ? toNumberLoose(b.nvol) : (b.net_vol != null ? toNumberLoose(b.net_vol) : null);
```

Juga diterapkan di `getBrokerPrice` (avg price) dan field `bfrq`/`sfrq`/`avg_buy`/`avg_sell`.

#### Test Verifikasi

```js
test('AUDIT-F4-10: normalizeBrokerSummary mempertahankan nilai rupiah dari string numerik ribuan', () => {
  const norm = bandarmologiService.normalizeBrokerSummary({
    stock_code: 'STRINGFEED',
    date: '2026-09-22',
    gross_buyers: [{ broker: 'AK', bval: '1.500.000.000', bvol: '15000000' }],
    gross_sellers: [{ broker: 'XC', sval: '500.000.000', svol: '5000000' }]
  }, '2026-09-22', 'STRINGFEED');

  assert.ok(norm, 'normalized summary must exist');
  assert.equal(norm.gross_buyers.length, 1, 'AK must stay in gross_buyers');
  assert.equal(norm.gross_buyers[0].bval, 1500000000, 'bval must be parsed as Rp 1.5 Miliar, not NaN');
  assert.equal(norm.gross_buyers[0].sval, 0);
  assert.equal(norm.gross_sellers[0].sval, 500000000, 'sval must be parsed as Rp 500 Juta');
  assert.equal(norm.total_buy_val, 1500000000, 'total_buy_val must be the real rupiah figure');
  assert.equal(norm.net_flow, 1500000000, 'net_flow must be the real rupiah net, never the lot count');
  assert.equal(norm.net_status, 'BIG_ACCUMULATION');
  assert.equal(norm.foreign_buy, 1500000000, 'foreign_buy must not collapse to NaN');
});
```

**Status:** ✅ PASS (run 1: 8.6431ms, run 2: PASS)

---

## AUDIT-F4-11 — 🔴 CRITICAL
### `enrichBrokerItem` kolaps menjadi 0 pada feed string numerik

**File:** `lib/bandarmologi-service.js`
**Fungsi:** `enrichBrokerItem()` (baris 474–510 sebelum patch)
**Dipakai oleh:** `lib/broker-hunter-service.js`, `lib/bandarmologi-screener-scoring.js`

#### Akar Masalah

```js
// SEBELUM
const rawNet = item.nval != null ? Number(item.nval) : (...);
bval = Number(item.bval != null ? item.bval : (...)) || 0;
```

Perhatikan trailing `|| 0`. Ini **lebih buruk** daripada F4-10: alih-alih menghasilkan `NaN`
yang terlihat, `NaN || 0` menghasilkan **`0` yang terlihat sah**. Broker dengan transaksi
Rp 1,5 Miliar dirender sebagai Rp 0 tanpa peringatan apa pun.

#### Bukti FAIL (empiris)

```
✖ AUDIT-F4-11: enrichBrokerItem mempertahankan nilai dari string numerik ribuan
  AssertionError: bval must be parsed, not 0
  0 !== 1500000000
```

Probe (`scratch/fase4-probe.js`):
```
H2 enrich => {"broker":"AK","bval":0,"sval":0,"bvol":15000000,"svol":0,
              "nval":0,"avg_price":0,"avg_buy":0,"avg_sell":0}
```

Perhatikan `bvol: 15000000` berhasil (kebetulan plain string), tetapi `bval: 0` — inkonsistensi
internal yang membuat `avg_price` juga menjadi 0.

#### Patch

```diff
 function enrichBrokerItem(item, isBuyer, refPrice) {
   if (!item) return null;
-  const rawNet = item.nval != null ? Number(item.nval) : (item.net_val != null ? Number(item.net_val) : null);
+  // AUDIT-F4-11: seluruh pembacaan numerik memakai toNumberLoose() supaya feed
+  // string numerik (ribuan bertitik/koma) tidak berubah menjadi 0 / NaN.
+  const pick = (...candidates) => {
+    for (const c of candidates) {
+      const n = toNumberLoose(c);
+      if (n != null) return n;
+    }
+    return 0;
+  };
+  const rawNet = item.nval != null ? toNumberLoose(item.nval) : (item.net_val != null ? toNumberLoose(item.net_val) : null);
   let bval = 0;
   let sval = 0;
   if (isBuyer) {
-    bval = Number(item.bval != null ? item.bval : (item.buy_val != null ? item.buy_val : (item.val != null ? item.val : (item.value != null ? item.value : 0)))) || 0;
-    sval = Number(item.sval != null ? item.sval : (item.sell_val != null ? item.sell_val : 0)) || 0;
+    bval = pick(item.bval, item.buy_val, item.val, item.value);
+    sval = pick(item.sval, item.sell_val);
   } else {
-    sval = Number(item.sval != null ? item.sval : (item.sell_val != null ? item.sell_val : (item.val != null ? item.val : (item.value != null ? item.value : 0)))) || 0;
-    bval = Number(item.bval != null ? item.bval : (item.buy_val != null ? item.buy_val : 0)) || 0;
+    sval = pick(item.sval, item.sell_val, item.val, item.value);
+    bval = pick(item.bval, item.buy_val);
   }
   let bvol = 0;
   let svol = 0;
-  const rawNetVol = item.nvol != null ? Number(item.nvol) : (item.net_vol != null ? Number(item.net_vol) : null);
+  const rawNetVol = item.nvol != null ? toNumberLoose(item.nvol) : (item.net_vol != null ? toNumberLoose(item.net_vol) : null);
   if (isBuyer) {
-    bvol = Number(item.bvol != null ? item.bvol : (item.buy_vol != null ? item.buy_vol : (item.vol != null ? item.vol : (item.volume != null ? item.volume : 0)))) || 0;
-    svol = Number(item.svol != null ? item.svol : (item.sell_vol != null ? item.sell_vol : 0)) || 0;
+    bvol = pick(item.bvol, item.buy_vol, item.vol, item.volume);
+    svol = pick(item.svol, item.sell_vol);
   } else {
-    svol = Number(item.svol != null ? item.svol : (item.sell_vol != null ? item.sell_vol : (item.vol != null ? item.vol : (item.volume != null ? item.volume : 0)))) || 0;
-    bvol = Number(item.bvol != null ? item.bvol : (item.buy_vol != null ? item.buy_vol : 0)) || 0;
+    svol = pick(item.svol, item.sell_vol, item.vol, item.volume);
+    bvol = pick(item.bvol, item.buy_vol);
   }
-  const bfrq = Number(item.bfrq) || 0;
-  const sfrq = Number(item.sfrq) || 0;
+  const bfrq = pick(item.bfrq);
+  const sfrq = pick(item.sfrq);
```

#### Test Verifikasi

```js
test('AUDIT-F4-11: enrichBrokerItem mempertahankan nilai dari string numerik ribuan', () => {
  const enriched = bandarmologiService.enrichBrokerItem({
    broker: 'AK',
    bval: '1.500.000.000',
    sval: '200.000.000',
    bvol: '15000000',
    svol: '2000000'
  }, true, 0);

  assert.ok(enriched, 'enriched row must exist');
  assert.equal(enriched.bval, 1500000000, 'bval must be parsed, not 0');
  assert.equal(enriched.sval, 200000000, 'sval must be parsed, not 0');
  assert.equal(enriched.bvol, 15000000);
  assert.equal(enriched.nval, 1300000000, 'nval must be the real net rupiah');
  assert.equal(enriched.net_val, 1300000000);
});
```

**Status:** ✅ PASS (run 1: 0.6927ms, run 2: PASS)

---

## AUDIT-F4-12 — 🟠 HIGH
### Phantom net `-1` — penjual hantu dari baris broker tanpa nilai

**File:** `lib/bandarmologi-service.js`
**Fungsi:** `parseBrokerRow()`, fallback `top_sellers`, dan `net_buyers`/`net_sellers`

#### Akar Masalah

Tiga lokasi `|| 1` memfabrikasi magnitudo:

```js
// SEBELUM — parseBrokerRow
if (nval == null) {
  if (bval > 0 || sval > 0) nval = bval - sval;
  else if (isBuyerDefault) nval = bval || bvol || 1;    // ← phantom +1
  else nval = -(sval || svol || 1);                      // ← phantom -1
}
```

```js
// SEBELUM — broker_levels shape
row.net_val = -Math.abs(row.sval || 1);                  // ← phantom -1
```

```js
// SEBELUM — separate lists fallback
row.net_val = -Math.abs(row.sval || row.svol || 1);      // ← phantom -1
```

```js
// SEBELUM — fallback terakhir
nval: -Math.abs(s.sval || s.net_val || 1),               // ← phantom -1
```

**Dampak:** payload dengan daftar broker tanpa magnitudo (feed parsial) membuat `net_flow = -1`,
sehingga `net_status` menjadi `BIG_DISTRIBUTION` untuk hari yang sebenarnya tidak punya data.

Tambahan: `net_buyers`/`net_sellers` hanyalah alias `top_buyers`/`top_sellers`, sehingga baris
net 0 bocor ke daftar "net seller".

#### Bukti FAIL (empiris)

```
✖ AUDIT-F4-12: baris broker tanpa nilai tidak boleh menghasilkan magnitudo -1 hantu
  AssertionError: a broker row with no value/lot must not fabricate a net seller
  1 !== 0
```

Probe (`scratch/fase4-probe.js`):
```
H4 top_sellers => [{"broker":"XC","bval":0,"sval":1,"svol":1,
                    "nval":-1,"net_val":-1,"avg_price":1,"avg_sell":1}]
```

Broker `XC` dirender sebagai penjual dengan `sval = 1` (Rp 1!) — nilai yang sepenuhnya dikarang.

#### Patch

```diff
     const pick = (...candidates) => { ... };
+    // AUDIT-F4-12: apakah baris ini membawa data angka sama sekali? Broker
+    // tanpa nilai apa pun tetap sah sebagai IDENTITAS (feed kadang hanya
+    // mengirim daftar kode), tetapi magnitudonya tidak boleh dikarang.
+    const hasValueData = [
+      b.bval, b.buy_val, b.sval, b.sell_val, b.val, b.value,
+      b.bvol, b.buy_vol, b.svol, b.sell_vol, b.vol, b.volume,
+      b.nval, b.net_val, b.nvol, b.net_vol
+    ].some(v => toNumberLoose(v) != null);
```

```diff
     if (nval == null) {
       if (bval > 0 || sval > 0) {
         nval = bval - sval;
+      } else if (!hasValueData) {
+        // AUDIT-F4-12: baris tanpa data angka sama sekali. `|| 1` dulu membuat
+        // hari kosong berubah menjadi net -1 (penjual hantu) sehingga status
+        // terbaca BIG_DISTRIBUTION. Net flow tetap 0, magnitudo tidak dikarang.
+        nval = 0;
       } else if (isBuyerDefault) {
-        nval = bval || bvol || 1;
+        nval = bval || bvol;
       } else {
-        nval = -(sval || svol || 1);
+        nval = -(sval || svol);
       }
     }
```

```diff
     top_sellers = gross_sellers.map(s => {
       const row = { ...s };
-      row.net_val = -Math.abs(row.sval || 1);
+      // AUDIT-F4-12: hapus phantom `|| 1`.
+      row.net_val = -Math.abs(row.sval);
       row.nval = row.net_val;
       return row;
     });
```

```diff
       if (top_sellers.length === 0) {
-        top_sellers = gross_sellers.map(s => ({
-          ...s,
-          nval: -Math.abs(s.sval || s.net_val || 1),
-          net_val: -Math.abs(s.sval || s.net_val || 1)
-        }));
+        top_sellers = gross_sellers.map(s => {
+          const absSval = Math.abs(toNumberLoose(s.sval != null ? s.sval : s.net_val) || 0);
+          return { ...s, nval: -absSval, net_val: -absSval };
+        }).filter(s => s.net_val < 0);
       }
```

```diff
     top_buyers,
     top_sellers,
-    net_buyers: top_buyers,
-    net_sellers: top_sellers,
+    // AUDIT-F4-12: net_buyers/net_sellers HARUS benar-benar bersih menurut tanda
+    // net. Sebelumnya keduanya hanya alias top_*, sehingga baris tanpa magnitudo
+    // (net 0) ikut bocor ke daftar "net seller" sebagai penjual hantu.
+    net_buyers: top_buyers.filter(b => Number(b.net_val || 0) > 0),
+    net_sellers: top_sellers.filter(b => Number(b.net_val || 0) < 0),
```

#### Keputusan Desain Penting

Kontrak yang dipilih: **identitas broker dipertahankan, magnitudo tidak dikarang.**

Feed nyata kadang hanya mengirim daftar kode broker tanpa nilai (dipakai sinyal berbasis broker
code seperti `detectRetailCutlossVsBandar`). Menghapus identitas akan merusak sinyal tersebut.
Namun `sval`, `svol`, `net_val` wajib `0` — bukan `1`.

#### Test Verifikasi

```js
test('AUDIT-F4-12: baris broker tanpa nilai tidak boleh menghasilkan magnitudo -1 hantu', () => {
  const norm = bandarmologiService.normalizeBrokerSummary({
    stock_code: 'NOVALUE',
    date: '2026-09-22',
    gross_sellers: [{ broker: 'XC', broker_name: 'Ajaib Sekuritas Asia' }]
  }, '2026-09-22', 'NOVALUE');

  assert.ok(norm, 'normalized summary must exist');
  assert.equal(norm.top_sellers.length, 1, 'the seller identity may survive for broker-code signals');
  assert.equal(norm.top_sellers[0].broker, 'XC');
  assert.equal(norm.top_sellers[0].net_val, 0, 'net_val must be 0, never a phantom -1');
  assert.equal(norm.top_sellers[0].sval, 0, 'sval must be 0, never a phantom 1');
  assert.equal(norm.top_sellers[0].svol, 0, 'svol must be 0, never a phantom 1');
  assert.equal(norm.net_flow, 0, 'net_flow must be 0, never a phantom -1');
  assert.equal(norm.net_status, 'NEUTRAL', 'an empty day must read NEUTRAL, not BIG_DISTRIBUTION');
  assert.equal(norm.net_sellers.length, 0, 'net_sellers must not contain phantom rows');
  assert.equal(norm.has_cross_trade, false);
});
```

**Status:** ✅ PASS

---

## AUDIT-F4-13 — 🔴 CRITICAL
### Cross Trading (tukar barang) → CR3 100% + AKUMULASI_MASIF palsu

**File:** `lib/bandarmologi-service.js`
**Fungsi:** `normalizeBrokerSummary()` (fallback `top_buyers`) + `computeConcentrationRatios()`
**Kategori:** Wash sale / cross trading sederhana — **fitur tidak ada sama sekali sebelum audit**

#### Akar Masalah

```js
// SEBELUM — cabang "separate lists"
if (top_buyers.length === 0 && gross_buyers.length > 0) {
  top_buyers = gross_buyers.filter(b => b.net_val > 0);
  if (top_buyers.length === 0) top_buyers = gross_buyers.slice();  // ← AKAR MASALAH
}
```

Pada bentuk payload "separate lists", `gross_buyers` **tidak mengenal sisi jual** — `sval` selalu `0`
untuk setiap baris. Akibatnya:

- Broker `AK` membeli 100 Miliar dan menjual 100 Miliar (cross trade / tukar barang)
- Di `gross_buyers`, `AK` tampak sebagai `bval = 100e9, sval = 0` → **net buyer 100 Miliar**
- `AK` masuk ke `top_buyers` sebagai pembeli terbesar
- CR3 = 100%, status `AKUMULASI_MASIF`, `triggered: true`

Padahal **tidak ada akumulasi riil sama sekali** — hanya barang berpindah tangan antar rekanan.

Selain itu, tidak ada deteksi wash sale di seluruh 4 file target (pencarian kata kunci `wash`,
`cross`, `tukar`, `churn` → nol hasil).

#### Bukti FAIL (empiris)

```
✖ AUDIT-F4-13: cross trade broker yang sama (lot identik) tidak boleh jadi AKUMULASI_MASIF palsu
  AssertionError: cross_trade_brokers must be surfaced as an array
  false == true
```

Probe terfokus (`scratch/fase4-probe2.js`) — dua broker, `AK` cross trade 100 Miliar:

```
net_flow = 1000000000              ← hanya BK yang net
net_status = BIG_ACCUMULATION
top_buyers = [ ['AK', 100000000000, 100000000000, 0],     ← net 0, tapi ada di top_buyers!
               ['BK',   1000000000,           0, 1000000000] ]
net_buyers = [ ['AK', 0], ['BK', 1000000000] ]            ← AK net 0 bocor ke net_buyers
net_sellers = [ ['AK', -100000000000], ['XC', -1000000000] ]  ← AK muncul di DUA sisi
CR = {"cr3":100,"cr5":100,"status":"AKUMULASI_MASIF",
      "triggered":true,"basis":"VOLUME","top_accumulators":["BK"]}
```

**Anomali ganda yang terlihat jelas:**
1. `AK` (net 0) muncul di **kedua** `top_buyers` dan `top_sellers`
2. CR3 = 100% padahal hanya ada satu akumulator riil (`BK`, 1 Miliar)
3. `status: AKUMULASI_MASIF` — verdict yang sepenuhnya salah

#### Patch — Bagian 1: pindahkan fallback setelah merge

```diff
     if (rawNetBuyers.length > 0) { ... }
-    if (top_buyers.length === 0 && gross_buyers.length > 0) {
-      top_buyers = gross_buyers.filter(b => b.net_val > 0);
-      if (top_buyers.length === 0) top_buyers = gross_buyers.slice();
-    }
+    // AUDIT-F4-13: fallback top_buyers TIDAK dihitung di sini. `gross_buyers`
+    // belum mengenal sisi jual (sval selalu 0 pada daftar pembeli terpisah),
+    // sehingga broker cross-trade tampak sebagai net buyer besar dan
+    // menggelembungkan CR3 sampai 100%. Fallback dihitung setelah merge
+    // buy+sell di bawah, memakai net (bval - sval) yang sebenarnya.
```

```diff
     brokers = Array.from(bMap.values());
+
+    // AUDIT-F4-13: fallback top_buyers dihitung dari broker list yang SUDAH
+    // di-merge (bval & sval lengkap), bukan dari gross_buyers yang buta sisi
+    // jual. Broker cross trade / churn (net 0) tidak lagi masuk sebagai top
+    // buyer, sehingga CR3 mencerminkan akumulasi bersih riil. Urutan feed
+    // dipertahankan (kontrak lama) supaya peringkat yang sudah disiapkan
+    // upstream tidak berubah.
+    //
+    // AUDIT-F4-12: bila TIDAK ADA satu pun broker dengan informasi net, seluruh
+    // daftar identitas dipertahankan (kontrak lama) supaya sinyal berbasis
+    // broker code tetap bekerja — tanpa mengarang magnitudo apa pun.
+    if (top_buyers.length === 0) {
+      const netBuyers = brokers.filter(b => Number(b.net_val || 0) > 0);
+      top_buyers = netBuyers.length > 0 ? netBuyers : gross_buyers.slice();
+    }
+    if (top_sellers.length === 0) {
+      const netSellers = brokers.filter(b => Number(b.net_val || 0) < 0);
+      top_sellers = netSellers.length > 0 ? netSellers : gross_sellers.slice();
+    }
   }
```

#### Patch — Bagian 2: deteksi wash sale / cross trading

```diff
   gross_buyers.sort((a, b) => Number(b.bval || b.buy_val || 0) - Number(a.bval || a.buy_val || 0));
   gross_sellers.sort((a, b) => Number(b.sval || s.sell_val || 0) - Number(a.sval || a.sell_val || 0));
+
+  // AUDIT-F4-13: deteksi wash sale / cross trading sederhana — broker yang sama
+  // tampil sebagai pembeli SEKALIGUS penjual dengan lot (atau nilai) identik.
+  // Pola "tukar barang" ini bukan akumulasi; tanpa flag eksplisit ia menyamar
+  // sebagai netral lalu mencemari basis konsentrasi CR3/CR5.
+  const crossTradeBrokers = [];
+  for (const b of brokers) {
+    const bval = Number(b.bval || b.buy_val || 0);
+    const sval = Number(b.sval || b.sell_val || 0);
+    const bvol = Number(b.bvol || b.buy_vol || 0);
+    const svol = Number(b.svol || b.sell_vol || 0);
+    if (!(bval > 0 && sval > 0)) continue;
+    const valueIdentical = Math.abs(bval - sval) <= Math.max(1, Math.max(bval, sval) * 1e-9);
+    const lotsIdentical = bvol > 0 && svol > 0 && Math.abs(bvol - svol) <= Math.max(1, Math.max(bvol, svol) * 1e-9);
+    if (valueIdentical || lotsIdentical) crossTradeBrokers.push(b.broker);
+  }
+  const hasCrossTrade = crossTradeBrokers.length > 0;
```

```diff
     net_buyers: top_buyers.filter(b => Number(b.net_val || 0) > 0),
     net_sellers: top_sellers.filter(b => Number(b.net_val || 0) < 0),
+    // AUDIT-F4-13: sinyal wash sale / cross trading eksplisit untuk UI & skoring.
+    cross_trade_brokers: crossTradeBrokers,
+    has_cross_trade: hasCrossTrade,
```

**Dua kriteria independen** (salah satu terpenuhi → cross trade):
1. **Nilai identik**: `|bval - sval| ≈ 0` — tukar barang dengan nilai sama
2. **Lot identik**: `|bvol - svol| ≈ 0` — tukar barang dengan jumlah lot sama

Toleransi relatif `1e-9` mencegah false positive floating point, dengan lantai `1` unit agar
nilai kecil tidak menghasilkan toleransi nol.

#### Test Verifikasi

```js
test('AUDIT-F4-13: cross trade broker yang sama (lot identik) tidak boleh jadi AKUMULASI_MASIF palsu', () => {
  const raw = {
    stock_code: 'CROSSTRD',
    date: '2026-09-22',
    gross_buyers: [
      { broker: 'AK', bval: 100e9, bvol: 100e6 },
      { broker: 'BK', bval: 1e9, bvol: 1e6 }
    ],
    gross_sellers: [
      { broker: 'AK', sval: 100e9, svol: 100e6 },
      { broker: 'XC', sval: 1e9, svol: 1e6 }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(raw, '2026-09-22', 'CROSSTRD');
  assert.ok(norm, 'normalized summary must exist');

  assert.ok(Array.isArray(norm.cross_trade_brokers), 'cross_trade_brokers must be surfaced as an array');
  assert.ok(norm.cross_trade_brokers.includes('AK'), 'AK is a cross-trade broker (identical buy/sell lots)');
  assert.equal(norm.has_cross_trade, true);

  const topBuyerCodes = norm.top_buyers.map(b => b.broker);
  assert.ok(!topBuyerCodes.includes('AK'), 'a net-zero churning broker must not be listed as a top buyer');
  assert.deepEqual(topBuyerCodes, ['BK']);

  const cr = bandarmologiIntelService.computeConcentrationRatios('CROSSTRD', {
    brokerSummary: norm, range: '1d', days: 1
  });
  assert.ok(cr.cr3 < 5, `CR3 must reflect the real (tiny) net accumulation, got ${cr.cr3}`);
  assert.notEqual(cr.status, 'AKUMULASI_MASIF', 'churn must never be labelled massive accumulation');
  assert.equal(cr.triggered, false, 'churn must not trigger the accumulation signal');
  assert.deepEqual(cr.top_3_brokers, ['BK'], 'only the genuine net accumulator may lead the CR list');
});
```

**Hasil sesudah patch:**
```
net_buyers  = [ ['BK', 1000000000] ]        ← AK (net 0) tidak lagi bocor
cross_trade_brokers = ['AK']
has_cross_trade = true
CR3 < 5, status ≠ AKUMULASI_MASIF, triggered = false
top_3_brokers = ['BK']
```

**Status:** ✅ PASS (run 1: 4.7398ms, run 2: PASS)

---

## AUDIT-F4-14 — 🔴 CRITICAL
### `normalizeBrokerValue` membuang SEMUA string numerik menjadi 0

**File:** `public/bandarmologi-runtime.js`
**Fungsi:** `normalizeBrokerValue()` (baris 429–437 sebelum patch)
**Dipakai di:** 8 lokasi render (tabel broker summary, bubble, chart, riwayat harian)

#### Akar Masalah

```js
// SEBELUM
function normalizeBrokerValue(val, vol, avgPrice) {
  if (!val || isNaN(val)) return 0;
  var num = Number(val);
  ...
}
```

`isNaN("1.500.000.000")` mengembalikan **`true`** — karena `isNaN()` melakukan koersi `Number()`
internal. Jadi **setiap string numerik** langsung dibuang menjadi `0`, termasuk `"1500000000"`
yang sebenarnya bisa diparse `Number()`.

Runtime ini sudah punya `parseNumericValue()` yang lengkap (menangani ribuan bertitik, ribuan
berkoma, suffix T/M/Jt/Rb, prefix Rp) — tetapi **tidak dipakai** di `normalizeBrokerValue`.

#### Bukti FAIL (empiris)

```
✖ AUDIT-F4-14: runtime normalizeBrokerValue membaca string numerik, bukan membuangnya
  AssertionError: thousand-dotted string must parse
  0 !== 1500000000
```

Probe (`scratch/fase4-probe.js`):
```
H7 normalizeBrokerValue("1.500.000.000") => 0        ← SALAH
H7 parseNumericValue("1.500.000.000")    => 1500000000  ← benar, tapi tidak dipakai
H7 normalizeBrokerValue(NaN)             => 0
```

#### Patch

```diff
   function normalizeBrokerValue(val, vol, avgPrice) {
-    if (!val || isNaN(val)) return 0;
-    var num = Number(val);
+    if (val == null || val === '') return 0;
+    // AUDIT-F4-14: feed dapat mengirim string numerik ("1500000000",
+    // "1.500.000.000"). `isNaN(val)` menandai SEMUA string sebagai NaN sehingga
+    // nilai riil dibuang menjadi 0. Gunakan parseNumericValue yang sudah
+    // menangani format ribuan Indonesia sebelum fallback Number().
+    var num = (typeof val === 'number') ? val : parseNumericValue(val);
+    if (num == null || !isFinite(num)) return 0;
     // Absolute sanity guard: Any broker value >= 500 Miliar (5e11) is a 100x multiplier artifact in IDX data
     if (Math.abs(num) >= 5e11) {
       return Math.round(num / 100);
     }
     return num;
   }
```

#### Test Verifikasi

```js
test('AUDIT-F4-14: runtime normalizeBrokerValue membaca string numerik, bukan membuangnya', () => {
  assert.equal(bandarmologiRuntime.normalizeBrokerValue('1.500.000.000'), 1500000000, 'thousand-dotted string must parse');
  assert.equal(bandarmologiRuntime.normalizeBrokerValue('1500000000'), 1500000000, 'plain numeric string must parse');
  assert.equal(bandarmologiRuntime.normalizeBrokerValue('5000000000000'), 50000000000, '5 T string must parse then normalise to Miliar scale');
  assert.equal(bandarmologiRuntime.normalizeBrokerValue(null), 0);
  assert.equal(bandarmologiRuntime.normalizeBrokerValue('—'), 0);
});
```

Perhatikan test ke-3: `"5000000000000"` (5 Triliun) harus diparse **lalu** dinormalisasi ke
skala Miliar (÷100) oleh sanity guard — memastikan kedua lapisan bekerja berurutan.

**Status:** ✅ PASS (run 1: 1.4416ms, run 2: PASS)

---

## AUDIT-F4-15 — 🟠 HIGH
### Net 0 / NaN salah diklasifikasi sebagai "Normal Dist"

**File:** `public/bandarmologi-runtime.js`
**Fungsi:** Tabel Riwayat Harian — kolom "Kategori" (baris 3025–3035 sebelum patch)

#### Akar Masalah

```js
// SEBELUM
var catBadge = '';
if (rowNet >= 5e9) {          // Big Acc
} else if (rowNet > 0) {      // Normal Acc
} else if (rowNet <= -5e9) {  // Big Dist
} else {                       // ← Normal Dist (menangkap 0 dan NaN!)
}
```

Rantai `if/else` ini tidak punya cabang eksplisit untuk `net === 0` atau `NaN`. Semua nilai yang
tidak memenuhi tiga kondisi pertama — termasuk **net 0, -0, dan NaN** — jatuh ke cabang terakhir
dan dirender sebagai **"🔴 Normal Dist"**.

**Dampak:** Hari tanpa net flow apa pun (mis. data parsial, akhir pekan tersisip, error upstream)
tampil sebagai distribusi merah di tabel konsistensi, mendistorsi penilaian tren bandar.

#### Bukti FAIL (empiris)

```
✖ AUDIT-F4-15: klasifikasi harian menempatkan net 0 / NaN pada Netral
  AssertionError: classifyDailyNetCategory must be exported for verification
  'undefined' !== 'function'
```

Probe (`scratch/fase4-probe.js`), mereplikasi logika lama secara literal:
```
H8 net=0    => "Normal Dist"   ← SALAH, seharusnya "Netral"
H8 net=NaN  => "Normal Dist"   ← SALAH, seharusnya "Netral"
H8 net=-0   => "Normal Dist"   ← SALAH, seharusnya "Netral"
H8 net=5e9  => "Big Acc"       ← benar
H8 net=-5e9 => "Big Dist"      ← benar
```

#### Patch

Fungsi tunggal `classifyDailyNetCategory()` diekstraksi agar **dapat diuji** dan dipakai
konsisten:

```diff
+  /**
+   * AUDIT-F4-15: klasifikasi harian tunggal untuk kolom "Kategori"
+   * (Big Acc / Normal Acc / Netral / Normal Dist / Big Dist).
+   * Sebelumnya cabang terakhir menangkap net 0, -0, dan NaN sehingga hari tanpa
+   * net flow apa pun tampil sebagai "Normal Dist" dan mendistorsi tabel
+   * konsistensi. Ambang dipertahankan 5 Miliar (|net| >= 5e9 => Big).
+   */
+  function classifyDailyNetCategory(rawNet) {
+    var net = (typeof rawNet === 'number') ? rawNet : parseNumericValue(rawNet);
+    if (net == null || !isFinite(net)) return 'Netral';
+    if (net >= 5e9) return 'Big Acc';
+    if (net > 0) return 'Normal Acc';
+    if (net === 0) return 'Netral';
+    if (net <= -5e9) return 'Big Dist';
+    return 'Normal Dist';
+  }
```

```diff
-        // Kategori: Big Acc / Normal Acc / Dist / Big Dist
+        // Kategori: Big Acc / Normal Acc / Netral / Normal Dist / Big Dist
+        // AUDIT-F4-15: net 0 / NaN tidak lagi jatuh ke "Normal Dist".
         var catBadge = '';
-        if (rowNet >= 5e9) {
+        var dailyCategory = classifyDailyNetCategory(rowNet);
+        if (dailyCategory === 'Big Acc') {
           catBadge = '...Big Acc...';
-        } else if (rowNet > 0) {
+        } else if (dailyCategory === 'Normal Acc') {
           catBadge = '...Normal Acc...';
-        } else if (rowNet <= -5e9) {
+        } else if (dailyCategory === 'Netral') {
+          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-500/10 text-gray-300 border border-gray-500/30">⚪ Netral</span>';
+        } else if (dailyCategory === 'Big Dist') {
           catBadge = '...Big Dist...';
         } else {
           catBadge = '...Normal Dist...';
         }
```

Fungsi diekspor di kedua blok `module.exports` / `root.BandarmologiRuntime`.

#### Test Verifikasi

```js
test('AUDIT-F4-15: klasifikasi harian menempatkan net 0 / NaN pada Netral', () => {
  const classify = bandarmologiRuntime.classifyDailyNetCategory;
  assert.equal(typeof classify, 'function', 'classifyDailyNetCategory must be exported for verification');

  assert.equal(classify(0), 'Netral');
  assert.equal(classify(-0), 'Netral');
  assert.equal(classify(NaN), 'Netral');
  assert.equal(classify(null), 'Netral');
  assert.equal(classify(undefined), 'Netral');
  assert.equal(classify(5e9), 'Big Acc');
  assert.equal(classify(4.99e9), 'Normal Acc');
  assert.equal(classify(-5e9), 'Big Dist');
  assert.equal(classify(-4.99e9), 'Normal Dist');
});
```

Perhatikan uji batas: `4.99e9` → Normal Acc dan `5e9` → Big Acc — membuktikan **tidak ada
off-by-one** dan ambang inklusif.

**Status:** ✅ PASS (run 1: 0.6225ms, run 2: PASS)

---

## AUDIT-F4-16 — 🟡 MEDIUM
### Ambang CR3 tidak konsisten antar modul (off-by-one boundary)

**File:** `lib/bandarmologi-screener-scoring.js`
**Fungsi:** `calculateBandarmologiScore()` (baris 110–119 sebelum patch)

#### Akar Masalah

Dua modul memakai ambang berbeda untuk metrik yang sama:

| Modul | Kondisi | CR3 = 60,00% tepat |
|---|---|---|
| `lib/bandarmologi-intel-service.js` | `cr3 >= 60.0` | ✅ `AKUMULASI_MASIF` |
| `lib/bandarmologi-screener-scoring.js` | `cr3 > 0.60` | ❌ tidak dapat poin |

```js
// SEBELUM — screener-scoring
if (cr3 > 0.60 && netFlow > 0) {          // ← eksklusif
  score += 25;
} else if (cr5 > 0.70 && netFlow > 0) {  // ← eksklusif
  score += 15;
} else if (cr3 > 0.50 && netFlow > 0) {  // ← eksklusif
  score += 10;
}
```

**Dampak:** Saham dengan CR3 tepat 60% mendapat label "Akumulasi Sangat Masif" di tab Intel
tetapi **tidak mendapat satu poin pun** di screener scoring — dua verdict yang saling bertentangan
untuk saham dan tanggal yang sama. Ini juga menyimpang dari simetri `cr3 >= 40` di intel.

#### Bukti FAIL (empiris)

```
✖ AUDIT-F4-16: ambang CR3 60% inklusif dan konsisten dengan intel-service
  AssertionError: CR3 exactly 60% must earn the CR3_CONCENTRATION rule
```

#### Patch

```diff
   // 1. KONSENTRASI BANDAR (CR3 / CR5)
-  if (cr3 > 0.60 && netFlow > 0) {
+  // AUDIT-F4-16: ambang wajib INKLUSIF dan konsisten dengan
+  // lib/bandarmologi-intel-service.js (cr3 >= 60 => AKUMULASI_MASIF). Sebelumnya
+  // `> 0.60` membuat CR3 tepat 60,00% tidak mendapat poin di screener padahal
+  // tab intel sudah melabelinya akumulasi masif — dua modul memberi verdict
+  // berbeda untuk saham & tanggal yang sama.
+  if (cr3 >= 0.60 && netFlow > 0) {
     score += 25;
     breakdown.push({ rule: 'CR3_CONCENTRATION', points: 25, label: `CR3 ${(cr3 * 100).toFixed(0)}% (+25)` });
-  } else if (cr5 > 0.70 && netFlow > 0) {
+  } else if (cr5 >= 0.70 && netFlow > 0) {
     score += 15;
     breakdown.push({ rule: 'CR5_CONCENTRATION', points: 15, label: `CR5 ${(cr5 * 100).toFixed(0)}% (+15)` });
-  } else if (cr3 > 0.50 && netFlow > 0) {
+  } else if (cr3 >= 0.50 && netFlow > 0) {
     score += 10;
     breakdown.push({ rule: 'CR3_MODERATE', points: 10, label: `CR3 ${(cr3 * 100).toFixed(0)}% (+10)` });
   }
```

#### Test Verifikasi

```js
test('AUDIT-F4-16: ambang CR3 60% inklusif dan konsisten dengan intel-service', () => {
  const screenerScoring = require('../lib/bandarmologi-screener-scoring');

  // 5 broker dengan nilai beli identik: CR3 = 60/100 = 0.60 persis, CR5 = 100%.
  const brokerData = [20, 20, 20, 20, 20].map((v, i) => ({
    broker_code: 'B' + i, bval: v, sval: 0, bvol: v * 100, nval: v
  }));

  const scored = screenerScoring.calculateBandarmologiScore(brokerData, { mode: 'swing' });
  assert.equal(scored.metrics.cr3, 0.6, 'CR3 must be exactly 0.60 in this fixture');
  const cr3Rule = scored.breakdown.find(b => b.rule === 'CR3_CONCENTRATION');
  assert.ok(cr3Rule, 'CR3 exactly 60% must earn the CR3_CONCENTRATION rule, not fall through to CR5');
  assert.equal(cr3Rule.points, 25);

  // Threshold parity: the intel service already treats 60% as massive.
  const intel = bandarmologiIntelService.computeConcentrationRatios('CRBOUNDARY', {
    brokerSummary: {
      top_buyers: brokerData.map(b => ({ broker: b.broker_code, bval: b.bval, bvol: b.bvol })),
      gross_buyers: brokerData.map(b => ({ broker: b.broker_code, bval: b.bval, bvol: b.bvol })),
      brokers: brokerData.map(b => ({ broker: b.broker_code, bval: b.bval, bvol: b.bvol, sval: 0 })),
      total_turnover: 100
    },
    range: '1d', days: 1
  });
  assert.equal(intel.cr3, 60, 'intel CR3 must be exactly 60');
  assert.equal(intel.status, 'AKUMULASI_MASIF', 'intel service treats 60% as massive — the screener must agree');
});
```

Test ini menguji **kedua modul sekaligus** pada fixture yang sama, memastikan paritas terjaga.

**Status:** ✅ PASS (run 1: 34.5431ms, run 2: PASS)

---

## AUDIT-F4-17 — 🟡 MEDIUM
### `cr3: 0` menyesatkan untuk saham suspend / FCA

**File:** `lib/bandarmologi-intel-service.js`
**Fungsi:** `computeConcentrationRatios()` (baris 1131–1140 sebelum patch)

#### Akar Masalah

```js
// SEBELUM
if (!norm || !Array.isArray(norm.gross_buyers) || norm.gross_buyers.length === 0) {
  return {
    signal_key: 'CONCENTRATION_RATIO',
    triggered: false,
    reason: 'NO_DATA',
    cr3: 0,    // ← "0%" menyiratkan data ada dan tersebar merata
    cr5: 0
  };
}
```

Saham suspend / FCA (Full Call Auction) tanpa transaksi broker sama sekali akan melaporkan
`cr3: 0%`. Ini berbeda secara semantik dari "tidak ada data":

- `cr3: 0%` → "ada data, konsentrasi nol" (artinya pembelian tersebar merata)
- `cr3: null` → "tidak ada data untuk dihitung"

UI sudah menangani `null` dengan benar (`var cr3Val = s4.cr3 != null ? s4.cr3 : 0;` di baris 4909),
dan kontrak F-070 sudah menetapkan `cr3: null` untuk kasus denominator tidak tersedia — sehingga
`cr3: 0` di sini **inkonsisten dengan kontrak yang sudah ada**.

#### Bukti FAIL (empiris)

```
✖ AUDIT-F4-17: payload broksum kosong (suspend/FCA) tidak menghasilkan akumulasi palsu
  AssertionError: 0 !== null
```

#### Patch

```diff
   if (!norm || !Array.isArray(norm.gross_buyers) || norm.gross_buyers.length === 0) {
+    // AUDIT-F4-17: saham suspend / FCA tanpa transaksi broker tidak boleh
+    // melaporkan CR 0% seolah-olah ada data tersebar merata. Konsisten dengan
+    // kontrak F-070 (tidak ada denominator => cr3/cr5 null + reason eksplisit).
     return {
       signal_key: 'CONCENTRATION_RATIO',
       signal_name: 'Concentration Ratio (CR3 & CR5)',
       triggered: false,
       reason: 'NO_DATA',
-      cr3: 0,
-      cr5: 0
+      cr3: null,
+      cr5: null
     };
   }
```

#### Test Verifikasi

```js
test('AUDIT-F4-17: payload broksum kosong (suspend/FCA) tidak menghasilkan akumulasi palsu', () => {
  const empty = bandarmologiService.normalizeBrokerSummary({
    stock_code: 'SUSPEND',
    date: '2026-09-22',
    brokers: []
  }, '2026-09-22', 'SUSPEND');

  assert.ok(empty, 'an explicitly empty payload must still normalise to an empty summary');
  assert.equal(empty.net_flow, 0);
  assert.equal(empty.net_status, 'NEUTRAL');
  assert.equal(empty.top_buyers.length, 0);
  assert.equal(empty.top_sellers.length, 0);
  assert.equal(empty.has_cross_trade, false, 'no trades means no cross trade');
  assert.deepEqual(empty.cross_trade_brokers, []);

  const cr = bandarmologiIntelService.computeConcentrationRatios('SUSPEND', {
    brokerSummary: empty, range: '1d', days: 1
  });
  assert.equal(cr.triggered, false, 'a suspended ticker must never trigger accumulation');
  assert.equal(cr.cr3, null);
  assert.equal(cr.reason, 'NO_DATA');
});
```

**Status:** ✅ PASS (run 1: 82.6945ms, run 2: PASS)

---

## VERIFIKASI FINAL

### FAIL → PASS (bukti test-first)

| Run | Tests | Pass | Fail | Artefak |
|---|---|---|---|---|
| SEBELUM perbaikan | 8 | **0** | **8** | `scratch/fase4-fail-evidence.txt` |
| SESUDAH — run 1 | 8 | **8** | **0** | `scratch/fase4-pass-run1.txt` |
| SESUDAH — run 2 | 8 | **8** | **0** | `scratch/fase4-pass-run2.txt` |

### Regression Gate (13 file test terkait broksum/bandarmologi)

```
ℹ tests 112   ℹ pass 112   ℹ fail 0
```
Artefak: `scratch/fase4-regression.txt`

### Full Suite Repo

```
ℹ tests 105   ℹ pass 105   ℹ fail 0
All 521 test files passed successfully!
```
Artefak: `scratch/fase4-full-suite.txt`

### Registrasi Build

`tools/curated-build-tests.json` baris 41:
```json
"test/audit-fase3-ingestion-cache-bugs.test.js",
"test/audit-fase4-broksum-bugs.test.js",
```

### Ringkasan Diff

```
lib/bandarmologi-intel-service.js    |   7 +-
lib/bandarmologi-screener-scoring.js |  11 +-
lib/bandarmologi-service.js          | 218 +++++++++++++++++++++++++++--------
public/bandarmologi-runtime.js       |  40 ++++++-
tools/curated-build-tests.json       |   4 +
5 files changed, 223 insertions(+), 57 deletions(-)
```

---

## PELAJARAN & POLA YANG BERULANG

### Pola 1 — `Number()` pada payload yang tidak dijamin numerik
**Terjadi di:** F4-10, F4-11, F4-14 (3 dari 8 bug)

`Number("1.500.000.000")` → `NaN`. Kombinasi dengan `|| 0` menyembunyikan masalah
(NaN → 0 yang terlihat sah). Solusi: **satu helper parsing longgar** (`toNumberLoose()` di server,
`parseNumericValue()` yang sudah ada di runtime) yang dipakai **konsisten di semua jalur**.

### Pola 2 — Fallback yang memfabrikasi magnitudo
**Terjadi di:** F4-12 (`|| 1`), F4-13 (`gross_buyers.slice()`), F4-17 (`cr3: 0`)

Ketika data tidak tersedia, kode cenderung mengisi nilai default yang **terlihat sah** daripada
mengakui ketiadaan data. Ini menghasilkan verdict yang salah tanpa error. Solusi: **`null` +
`reason` eksplisit**, atau **0 dengan flag `hasValueData`** — jangan pernah `|| 1`.

### Pola 3 — Logika duplikat antar modul menyimpang
**Terjadi di:** F4-15 (klasifikasi harian), F4-16 (ambang CR3)

Dua tempat menghitung hal yang sama dengan ambang/urutan berbeda. Solusi: **ekstraksi fungsi
tunggal yang diekspor** (`classifyDailyNetCategory`, `computeConcentrationRatioMetrics`) sehingga
dapat diuji dan dipakai bersama.

### Pola 4 — Bug tersembunyi di fallback yang jarang dieksekusi
**Terjadi di:** F4-13 (fallback `top_buyers` di cabang "separate lists")

Jalur fallback hanya aktif ketika field utama kosong — sehingga lolos dari test happy-path.
Solusi: **test harus menyasar jalur fallback secara eksplisit** (seperti yang dilakukan
8 test di suite ini).


---

# ADDENDUM — BATCH 3 (FASE 4: TRADE PLAN V2)

**Target:** `lib/trade-plan-v2.js` · **Suite:** `test/audit-fase4-trade-plan-bugs.test.js`

> The findings above cover Broker Summary & Bandarmologi. This addendum records
> the separate Trade Plan V2 findings fixed in Batch 3.

## F4-B3-01 — Trailing activation price ignored the ticker board (HIGH)

`computeTrailingStop()` built the activation price board-aware, but the
`active: true` return object recomputed it with a board-blind
`tick(activationPrice, 'nearest')`.

```js
// SEBELUM (baris 496)
activation_price: tick(activationPrice, 'nearest'),

// SESUDAH
activation_price: tick(activationPrice, 'nearest', p.board,
  p.is_fca != null ? p.is_fca : p.isFca, p.ticker),
```

**Dampak:** pada ticker FCA/Akselerasi (fraksi mutlak Rp1), harga aktivasi 261
ditampilkan sebagai **262** — level yang tidak eksis di papan tersebut.

## F4-B3-02 — Emergency anchor of a rejected plan ignored the board (HIGH)

```js
// SEBELUM (baris 965)
emergency_anchor_price: emergencyDiagnosticCandidate ? tick(emergencyDiagnosticCandidate.value, 'floor') : null

// SESUDAH — board/isFca/ticker diteruskan
```

**Dampak:** pada rencana `NO_STRUCTURAL_LEVEL`, satu-satunya struktur yang
dilihat operator adalah harga yang tidak dapat ditransaksikan (FCA 803 → 800).

## F4-B3-03 — STOP_NOT_BELOW_ENTRY anchors ignored the board (HIGH)

```js
// SEBELUM (baris 1015, 1017)
stop_anchor_price: tick(stopAnchor, 'floor'),
emergency_anchor_price: tick(emergencyAnchorPrice, 'floor'),

// SESUDAH — kedua anchor menerima board/isFca/ticker
```

**Dampak:** FCA 998 dilaporkan sebagai 995 pada dua field sekaligus.

## F4-B3-04 — Source-level lock (MEDIUM)

Scan sumber membuktikan 4 situs board-blind; guard baru menolak setiap
`tick()` berikutnya yang lupa membawa konteks papan.

## Test verifikasi

```
node --test test/audit-fase4-trade-plan-bugs.test.js
# FAIL pra-perbaikan : 4 (F4-B3-01..04)
# PASS pasca         : 6/6
```

Regresi: `111/111 PASS` untuk seluruh keluarga test Trade Plan V2.
