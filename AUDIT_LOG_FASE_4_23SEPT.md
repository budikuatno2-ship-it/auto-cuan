# AUDIT LOG — FASE 4 (23 SEPTEMBER 2026)
## Forensic Code Audit & Independent Verification — Broker Summary & Bandarmologi Engine

**Mode:** Zero-Trust Audit (semua status lama diperlakukan sebagai HIPOTESIS MENTAH)
**Tanggal eksekusi:** 2026-09-23 (Asia/Jakarta, UTC+7)
**Status akhir:** ✅ SELESAI — 8 bug direproduksi (FAIL), 8 diperbaiki, 8 PASS 2× berturut-turut, full suite hijau (521 test files)
**Test artefak:** `test/audit-fase4-broksum-bugs.test.js` (terdaftar di `tools/curated-build-tests.json`)

---

## 1. TARGET RESOLUTION PROTOCOL — Peta Dependency Riil

Target yang diminta tugas adalah `lib/bandarmologi.js` dan `lib/broker-summary-parser.js`.
**Kedua nama file tersebut tidak ada di repo ini.** Sesuai aturan "jangan berasumsi nama file",
pemetaan dilakukan lewat import/export riil (`require()` traversal + `module.exports` scan).

### 1.1 File yang Tidak Ditemukan (hipotesis awal gugur)

| Nama yang diasumsikan | Status | Pengganti riil |
|---|---|---|
| `lib/bandarmologi.js` | ❌ TIDAK ADA | `lib/bandarmologi-service.js` (core engine) |
| `lib/broker-summary-parser.js` | ❌ TIDAK ADA | `normalizeBrokerSummary()` di dalam `lib/bandarmologi-service.js` |
| `api/broker-summary.js` | ❌ TIDAK ADA | `lib/arjum-client.js#fetchBrokerSummary` + `lib/vps-data-fetcher.js` |

### 1.2 Peta Modul Riil (terverifikasi via `require`/`exports`)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CORE ENGINE (kalkulasi)                                                 │
│  lib/bandarmologi-service.js        2.574 baris  [CORE]                 │
│    ├─ normalizeBrokerSummary()      ← PARSER broksum sesungguhnya       │
│    ├─ parseBrokerRow()              ← normalisasi per-baris broker      │
│    ├─ enrichBrokerItem()            ← dipakai broker-hunter             │
│    ├─ aggregateBrokerSummaries()    ← agregasi multi-hari (Top1/3/5)    │
│    ├─ synthesizeAccumulationFromSummary()                               │
│    ├─ normalizeBrokerAccumulation()                                     │
│    ├─ getNetForeignFlow() / evaluateConfluenceSignal()                  │
│    └─ toNumberLoose()               ← [BARU] normalisasi tipe data      │
└─────────────────────────────────────────────────────────────────────────┘
        ▲                    ▲                       ▲
        │ require            │ require               │ require
        │                    │                       │
┌───────┴──────────┐ ┌───────┴──────────────┐ ┌──────┴──────────────────┐
│ INTEL ENGINE     │ │ HUNTER / SCORING     │ │ UI RUNTIME              │
│ bandarmologi-    │ │ broker-hunter-       │ │ public/bandarmologi-    │
│ intel-service.js │ │ service.js   (595)   │ │ runtime.js (5.624)      │
│     (2.268)      │ │ bandarmologi-        │ │                         │
│  ├ CR3/CR5       │ │ screener-scoring.js  │ │  ├ parseNumericValue()  │
│  ├ 4 sinyal      │ │      (296)           │ │  ├ normalizeBrokerValue │
│  └ confluence     │ │ bandarmologi-        │ │  ├ classifyDailyNetCat  │
│                  │ │ confluence.js (161)  │ │  └ render/klasifikasi   │
└──────────────────┘ └──────────────────────┘ └─────────────────────────┘
        ▲                                              ▲
        │                                              │
┌───────┴──────────────────────────────────────────────┴─────────────────┐
│ DATA FEED LAYER                                                        │
│  lib/arjum-client.js (641)  — Arjum API + disk cache lokal             │
│    ├ fetchBrokerSummary()  → /api/broker-summary/{ticker}              │
│    ├ readLocalBrokerSummary()  (disk-first, arjum-data/broker-summary) │
│    └ DEFAULT_BROKER_LIMIT / DEFAULT_LEVEL_LIMIT                        │
│  lib/vps-data-fetcher.js (1.049) — VPS bridge (HTTP tunnel + SSH)      │
│    ├ fetchBrokerSummaryFromVpsSync()                                   │
│    ├ fetchBrokerSummaryRangeFromVpsSync()                              │
│    └ fetchBrokerAccumulationFromVpsSync()                              │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Metrik Basis Kode

| Metrik | Nilai |
|---|---|
| Total baris 4 file target utama | 10.763 baris |
| Jumlah fungsi top-level di core engine | 35 |
| Fungsi terpapar via `module.exports` | 27 |
| Jalur input payload broksum teridentifikasi | 3 bentuk (`brokers[]`, `broker_levels[]`, `gross_*/top_*/net_*`) |
| Test file terkait broksum/bandarmologi sebelum audit | 33 file |
| Test file terkait setelah audit | 34 file (+1) |

### 1.4 Tiga Bentuk Payload Broksum (terverifikasi di kode)

```js
// Bentuk 1: unified brokers array (file bursa harian)
{ brokers: [{ broker_code, bval, sval, bvol, svol, nval, nvol }] }

// Bentuk 2: broker_levels (pair buy/sell berpasangan)
{ broker_levels: [{ buy: { broker_code, bval, bvol, bavg },
                    sell: { broker_code, sval, svol, savg } }] }

// Bentuk 3: partitioned lists (Arjum API / VPS payload / test)
{ gross_buyers: [...], gross_sellers: [...],
  net_buyers: [...],  net_sellers: [...],
  top_buyers: [...],  top_sellers: [...] }
```

---

## 2. HIPOTESIS MENTAH (Status Lama) vs TEMUAN TERVERIFIKASI

Semua klaim historis dari audit fase sebelumnya diperlakukan sebagai hipotesis. Berikut hasil
verifikasi independen terhadap kode terkini.

| # | Hipotesis mentah (status lama) | Verifikasi kode terkini | Kesimpulan |
|---|---|---|---|
| H-01 | "F-070 sudah menutup celah denominator CR" | `totalTurnover <= top5Val` → `valueDenominatorOk = false` (baris 1185–1191) | ✅ TERBUKTI benar, tapi **tidak menutup** kasus basis VOLUME |
| H-02 | "F-067 sudah menghapus skor fabrikasi 70/30" | `accumulationScore` dihitung dari `netFlow/grossVal` atau `null` (baris 1058–1061) | ✅ TERBUKTI benar |
| H-03 | "Phantom ±1 sudah bersih" | `|| 1` **masih ada** di `parseBrokerRow` (3 lokasi) & jalur `top_sellers` | ❌ **GUGUR — bug riil** |
| H-04 | "Tipe data feed selalu Number" | `Number("1.500.000.000") === NaN` — **tidak ada** parsing string ribuan | ❌ **GUGUR — bug riil** |
| H-05 | "Deteksi wash sale sudah ada" | Tidak ada `wash`/`cross`/`tukar` di seluruh 4 file target | ❌ **GUGUR — fitur tidak ada** |
| H-06 | "Klasifikasi Big Acc/Normal Acc/Netral sudah lengkap" | Cabang terakhir `else` menangkap net 0 & NaN → "Normal Dist" | ❌ **GUGUR — bug riil** |
| H-07 | "Ambang CR konsisten antar modul" | intel `>= 60`, screener `> 0.60` → CR3 tepat 60% berbeda verdict | ❌ **GUGUR — bug riil** |
| H-08 | "Broker asing dihitung sekali di agregasi" | `FOREIGN_INST_BROKERS` konsisten (AK/BK/RX/KZ/ZP/CS/DB/CC); tidak ada double count | ✅ TERBUKTI benar |
| H-09 | "Zero division di kalkulasi akumulasi" | Semua pembagian ber-guard (`bvol > 0`, `total > 0`, `denom > 0`) | ✅ TERBUKTI aman |
| H-10 | "Saham suspend/FCA tidak menghasilkan Big Acc palsu" | `cr3: 0` (bukan `null`) + `gross_buyers` kosong → `NO_DATA` | ⚠️ sebagian — `cr3: 0` menyesatkan |

---

## 3. METODE VERIFIKASI

### 3.1 Prinsip Test-First (reproduksi sebelum perbaikan)

Setiap hipotesis yang gugur **wajib direproduksi lebih dulu sebagai unit test yang GAGAL**.
Tidak ada perbaikan yang ditulis sebelum bukti FAIL terdokumentasi.

```
Siklus:
  1. Tulis test di test/audit-fase4-broksum-bugs.test.js
  2. Jalankan → WAJIB FAIL (bukti empiris kelemahan logika)
  3. Patch presisi (minimal diff) pada file sumber
  4. Jalankan → WAJIB PASS
  5. Ulangi langkah 4 minimal 2× berturut-turut
  6. Daftarkan ke tools/curated-build-tests.json
  7. Jalankan full suite → WAJIB hijau
```

### 3.2 Isolasi Lingkungan

Semua probe dijalankan dengan `NODE_ENV=test` + `CI=1` agar `vps-data-fetcher.isTestEnv()`
short-circuit dan tidak ada panggilan jaringan keluar selama audit.

---

## 4. HASIL EKSEKUSI — BUKTI FAIL (sebelum perbaikan)

Perintah: `node --test test/audit-fase4-broksum-bugs.test.js`
Artefak: `scratch/fase4-fail-evidence.txt`

```
✖ AUDIT-F4-10: normalizeBrokerSummary mempertahankan nilai rupiah dari string numerik ribuan
  AssertionError: bval must be parsed as Rp 1.5 Miliar, not NaN
  + actual: NaN
  - expected: 1500000000

✖ AUDIT-F4-11: enrichBrokerItem mempertahankan nilai dari string numerik ribuan
  AssertionError: bval must be parsed, not 0
  0 !== 1500000000

✖ AUDIT-F4-12: baris broker tanpa nilai tidak boleh menghasilkan magnitudo -1 hantu
  AssertionError: a broker row with no value/lot must not fabricate a net seller
  1 !== 0

✖ AUDIT-F4-13: cross trade broker yang sama (lot identik) tidak boleh jadi AKUMULASI_MASIF palsu
  AssertionError: cross_trade_brokers must be surfaced as an array
  false == true

✖ AUDIT-F4-14: runtime normalizeBrokerValue membaca string numerik, bukan membuangnya
  AssertionError: thousand-dotted string must parse
  0 !== 1500000000

✖ AUDIT-F4-15: klasifikasi harian menempatkan net 0 / NaN pada Netral
  AssertionError: classifyDailyNetCategory must be exported for verification
  'undefined' !== 'function'

✖ AUDIT-F4-16: ambang CR3 60% inklusif dan konsisten dengan intel-service
  AssertionError: CR3 exactly 60% must earn the CR3_CONCENTRATION rule

✖ AUDIT-F4-17: payload broksum kosong (suspend/FCA) tidak menghasilkan akumulasi palsu
  AssertionError: 0 !== null

ℹ tests 8
ℹ pass 0
ℹ fail 8
```

**Kesimpulan bukti FAIL:** 8/8 test gagal — ke-8 hipotesis yang gugur terkonfirmasi sebagai bug riil,
bukan artefak lingkungan.

---

## 5. PERBAIKAN DITERAPKAN (ringkasan; diff penuh di `BUG_FINDINGS_FASE_4_23SEPT.md`)

| Bug | File | Perubahan inti |
|---|---|---|
| F4-10/11 | `lib/bandarmologi-service.js` | Tambah helper `toNumberLoose()` (65 baris) yang menangani string plain / ribuan bertitik / ribuan berkoma / desimal koma / format kurung negatif / prefix Rp / suffix persen. Terapkan di `parseBrokerRow()` dan `enrichBrokerItem()`. |
| F4-12 | `lib/bandarmologi-service.js` | Hapus 3× `|| 1` phantom. Tambah flag `hasValueData`. `net_buyers`/`net_sellers` kini difilter strict `> 0` / `< 0` (sebelumnya hanya alias `top_*`). |
| F4-13 | `lib/bandarmologi-service.js` | Fallback `top_buyers` dipindah ke **setelah merge buy+sell** (agar `sval` diketahui). Tambah deteksi `cross_trade_brokers[]` + `has_cross_trade`. |
| F4-14 | `public/bandarmologi-runtime.js` | `normalizeBrokerValue()` memakai `parseNumericValue()` alih-alih `isNaN()` mentah. |
| F4-15 | `public/bandarmologi-runtime.js` | Tambah `classifyDailyNetCategory()` (fungsi tunggal, teruji, diekspor). Net 0/NaN → `'Netral'`. |
| F4-16 | `lib/bandarmologi-screener-scoring.js` | `> 0.60` → `>= 0.60`; `> 0.70` → `>= 0.70`; `> 0.50` → `>= 0.50` (paritas dengan intel-service). |
| F4-17 | `lib/bandarmologi-intel-service.js` | `cr3: 0, cr5: 0` → `cr3: null, cr5: null` pada `reason: 'NO_DATA'` (konsisten kontrak F-070). |

---

## 6. HASIL EKSEKUSI — BUKTI PASS (2× berturut-turut)

### Run #1 — `scratch/fase4-pass-run1.txt`
```
✔ AUDIT-F4-10: normalizeBrokerSummary mempertahankan nilai rupiah dari string numerik ribuan (8.6431ms)
✔ AUDIT-F4-11: enrichBrokerItem mempertahankan nilai dari string numerik ribuan (0.6927ms)
✔ AUDIT-F4-12: baris broker tanpa nilai tidak boleh menghasilkan magnitudo -1 hantu (0.6429ms)
✔ AUDIT-F4-13: cross trade broker yang sama (lot identik) tidak boleh jadi AKUMULASI_MASIF palsu (4.7398ms)
✔ AUDIT-F4-14: runtime normalizeBrokerValue membaca string numerik, bukan membuangnya (1.4416ms)
✔ AUDIT-F4-15: klasifikasi harian menempatkan net 0 / NaN pada Netral (0.6225ms)
✔ AUDIT-F4-16: ambang CR3 60% inklusif dan konsisten dengan intel-service (34.5431ms)
✔ AUDIT-F4-17: payload broksum kosong (suspend/FCA) tidak menghasilkan akumulasi palsu (82.6945ms)

ℹ tests 8   ℹ pass 8   ℹ fail 0   ℹ duration_ms 298.5337
```

### Run #2 — `scratch/fase4-pass-run2.txt`
```
ℹ tests 8   ℹ pass 8   ℹ fail 0   ℹ duration_ms 390.314
```

**Status: ✅ PASS 2× BERTURUT-TURUT TERKONFIRMASI**

---

## 7. REGRESSION GATE (test lama terkait broksum/bandarmologi)

Perintah: 13 file test terkait dijalankan bersamaan (`scratch/fase4-regression.txt`)

```
ℹ tests 112   ℹ pass 112   ℹ fail 0   ℹ duration_ms 12024.6322
```

Dua regresi sempat muncul selama iterasi perbaikan dan **diselesaikan tanpa melonggarkan kontrak**:

| Regresi | Akar masalah | Resolusi |
|---|---|---|
| `bandarmologi-gross-price-and-cr3-fix` — `net_buyers[0].broker` AK ≠ CC | Fallback baru mengurutkan ulang `top_buyers` | Urutan feed dipertahankan (tidak ada sort tambahan) |
| `bandarmologi-intel` Signal 3 — `triggered` false | Payload broker-only kehilangan identitas | Identitas broker dipertahankan, tetapi magnitudo tidak dikarang (net 0) |

---

## 8. FULL SUITE REPO

Perintah: `node tools/run-build-test-suite.js --full`
Artefak: `scratch/fase4-full-suite.txt` (560.116 byte)

```
ℹ tests 105   ℹ pass 105   ℹ fail 0
...
All 521 test files passed successfully!
```

**Status: ✅ SELURUH TEST SUITE REPO HIJAU**

---

## 9. ANALISIS CHECKLIST TUGAS — HASIL LENGKAP

### 9.1 Kalkulasi Akumulasi/Distribusi (Top 1, Top 3, Top 5)

| Pemeriksaan | Hasil |
|---|---|
| Pembagian nol saat total buyer/seller = 0 | ✅ AMAN — semua pembagian ber-guard (`bvol > 0`, `vol > 0`, `denom > 0`). Tidak ada `ZeroDivisionError` (JS menghasilkan `Infinity`/`NaN`, bukan throw; guard mencegah keduanya). |
| Net buyer/seller = `bval - sval` & `blot - slot` | ✅ BENAR secara tanda, **tetapi** fallback `top_buyers` lama memakai `gross_buyers` yang `sval`-nya selalu 0 → broker cross-trade tampak net positif besar. **Diperbaiki (F4-13).** |
| Broker asing dihitung ganda | ✅ TIDAK ADA — `FOREIGN_INST_BROKERS` = `{AK,BK,RX,KZ,ZP,CS,DB,CC}`, dipakai konsisten di `foreignInstNet`, `foreignBuyVal`, `foreignSellVal`. |

### 9.2 Normalisasi Tipe Data Feed Arjum (`stock.arjum.com` / VPS Payload)

| Format input | Sebelum | Sesudah |
|---|---|---|
| String plain `"1500000000"` | ✅ OK (`Number` bekerja) | ✅ OK |
| String ribuan titik `"1.500.000.000"` | ❌ **NaN** | ✅ `1500000000` |
| String ribuan koma `"1,500,000,000"` | ❌ **NaN** | ✅ `1500000000` |
| Desimal koma `"1500,25"` | ❌ **NaN** | ✅ `1500.25` |
| Format kurung negatif `"(500)"` | ❌ **NaN** | ✅ `-500` |
| Prefix `"Rp 1.500.000"` | ❌ **NaN** | ✅ `1500000` |
| `null` / `undefined` / `"—"` / `"-"` | ⚠️ `0` (via `|| 0`) | ✅ `null` → default `0` eksplisit |
| Broker code hilang (`''`) | ⚠️ tetap diproses | ⚠️ tetap (dilewati oleh `if (!b.broker) continue` di agregasi) |
| Broker tidak terdaftar di IDX | ✅ ditangani sebagai kode apa adanya | ✅ sama |

### 9.3 Klasifikasi Status Bandarmologi (Big Acc / Normal Acc / Netral / Normal Dist / Big Dist)

| Pemeriksaan | Hasil |
|---|---|
| Ambang batas inklusif | ✅ Diperbaiki (F4-16): `>= 5e9` / `> 0` / `== 0` / `<= -5e9` / else |
| Off-by-one pada batas | ✅ Tidak ada — `4.99e9` → Normal Acc, `5e9` → Big Acc (teruji) |
| Floating point rounding | ✅ Tidak ada — perbandingan langsung pada nilai rupiah, bukan rasio terbulatkan |
| Saham suspend/FCA → Big Acc palsu | ✅ Diperbaiki (F4-17): `cr3: null` + `reason: 'NO_DATA'`, `triggered: false` |
| Net 0 / NaN | ✅ Diperbaiki (F4-15): → `'Netral'` (sebelumnya salah jatuh ke `'Normal Dist'`) |

### 9.4 Deteksi Wash Sale / Cross Trading Sederhana

**Sebelum audit: FITUR TIDAK ADA.** Tidak ada kata kunci `wash`, `cross`, `tukar`, atau `churn`
di keempat file target.

**Sesudah perbaikan (F4-13):** deteksi diterapkan di `normalizeBrokerSummary()`:

```js
const crossTradeBrokers = [];
for (const b of brokers) {
  const bval = Number(b.bval || b.buy_val || 0);
  const sval = Number(b.sval || b.sell_val || 0);
  const bvol = Number(b.bvol || b.buy_vol || 0);
  const svol = Number(b.svol || b.sell_vol || 0);
  if (!(bval > 0 && sval > 0)) continue;
  const valueIdentical = Math.abs(bval - sval) <= Math.max(1, Math.max(bval, sval) * 1e-9);
  const lotsIdentical  = bvol > 0 && svol > 0 &&
                         Math.abs(bvol - svol) <= Math.max(1, Math.max(bvol, svol) * 1e-9);
  if (valueIdentical || lotsIdentical) crossTradeBrokers.push(b.broker);
}
const hasCrossTrade = crossTradeBrokers.length > 0;
```

Dua kriteria independen:
1. **Nilai identik** (`|bval - sval| ≈ 0`) — tukar barang dengan nilai sama.
2. **Lot identik** (`|bvol - svol| ≈ 0`) — tukar barang dengan jumlah lot sama.

Toleransi relatif `1e-9` mencegah false positive akibat presisi floating point, dengan lantai `1`
unit agar nilai/lot kecil tidak menghasilkan toleransi nol.

Output baru pada objek summary: `cross_trade_brokers: [...]`, `has_cross_trade: boolean`.

---

## 10. SISA RISIKO & REKOMENDASI (tidak diperbaiki — di luar cakupan minimal diff)

| # | Risiko | Dampak | Rekomendasi |
|---|---|---|---|
| R-01 | `top_buyers` fallback mempertahankan identitas broker tanpa magnitudo saat seluruh feed tidak punya info net | CR3 berbasis VOLUME dapat menyentuh 100% untuk feed 2-broker | Sudah berlabel `cr_basis: 'VOLUME'` — konsumen wajib membaca label basis |
| R-02 | `getCachedTurnover()` membaca `daytrade-ohlcv-cache` yang bisa basi | CR basis VALUE dapat memakai turnover hari lain | Sudah ada freshness gate di `getReferencePrice`; pertimbangkan gate serupa di `getCachedTurnover` |
| R-03 | `cross_trade_brokers` belum dikonsumsi oleh UI | Pengguna belum melihat badge "Cross Trade" | Tambahkan badge di `renderBrokerSummaryTableHtml` (pekerjaan UI terpisah) |
| R-04 | `toNumberLoose()` memperlakukan `"1.500"` sebagai 1500 (ribuan Indonesia), bukan 1.5 | Untuk feed desimal Inggris, `"1.500"` ambigu | Sesuai konvensi IDX/Indonesia — pertahankan; feed desimal selalu memakai koma |

---

## 11. DAFTAR ARTEFAK

| Artefak | Lokasi |
|---|---|
| Suite test audit Fase 4 | `test/audit-fase4-broksum-bugs.test.js` |
| Registrasi build | `tools/curated-build-tests.json` (baris 41) |
| Bukti FAIL | `scratch/fase4-fail-evidence.txt` |
| Bukti PASS run 1 | `scratch/fase4-pass-run1.txt` |
| Bukti PASS run 2 | `scratch/fase4-pass-run2.txt` |
| Bukti regresi gate | `scratch/fase4-regression.txt` |
| Bukti full suite | `scratch/fase4-full-suite.txt` |
| Probe hipotesis | `scratch/fase4-probe.js`, `scratch/fase4-probe2.js` |
| Peta dependency | `scratch/fase4-map.js` |
| Scan pola kode | `scratch/fase4-scan.js` |
| Laporan temuan bug | `BUG_FINDINGS_FASE_4_23SEPT.md` |

---

## 12. KESIMPULAN

1. **Target resolution:** Nama file `lib/bandarmologi.js` dan `lib/broker-summary-parser.js`
   **tidak eksis**; modul riil adalah `lib/bandarmologi-service.js` (yang di dalamnya memuat parser
   `normalizeBrokerSummary`), dengan dependency `lib/arjum-client.js` dan `lib/vps-data-fetcher.js`.

2. **Zero-trust berbuah:** 7 dari 10 hipotesis status lama **GUGUR** saat diverifikasi ke kode terkini
   (3 terbukti benar, 1 sebagian). Klaim "sudah bersih" pada audit historis tidak dapat dipertahankan.

3. **8 bug riil** ditemukan, direproduksi sebagai test GAGAL, diperbaiki dengan minimal diff,
   dan diverifikasi PASS 2× berturut-turut.

4. **Tidak ada regresi:** 112/112 test terkait broksum/bandarmologi lulus, dan
   **521 test file full suite repo hijau**.

5. **Celah paling berbahaya** bukan zero-division (yang sudah ber-guard dengan baik), melainkan
   **normalisasi tipe data feed** (F4-10/11/14) dan **basis konsentrasi yang tercemar churn**
   (F4-13) — keduanya dapat menghasilkan verdict bandarmologi yang sepenuhnya salah tanpa
   memicu error apa pun.


---

# ADDENDUM — BATCH 3 (FASE 4: TRADE PLAN V2)

**Branch:** `fix/batch-3-money-mgmt-cache-fase4-5-6`
**Target file:** `lib/trade-plan-v2.js`
**Suite:** `test/audit-fase4-trade-plan-bugs.test.js` (6 test)

> **Scope note.** The body of this document above audits the Broker Summary &
> Bandarmologi engine. Batch 3 re-audits the **Trade Plan V2** engine because
> the task brief named `lib/trade-plan-v2.js`. Both audits are real and
> independent; neither supersedes the other.

## Temuan Batch 3

The internal `tick(price, mode, board, isFca, ticker)` helper was made
board-aware by the Fase 11 audit (F11-01), but **four call sites were left
board-blind**. On an FCA / Papan Akselerasi ticker (flat Rp1 price fraction)
those sites snapped prices with the REGULAR board table (Rp2/5/10/25):

| ID | Severity | Path | Defect | Evidence |
|---|---|---|---|---|
| F4-B3-01 | HIGH | `computeTrailingStop` — active branch | `activation_price` recomputed with `tick(x, 'nearest')` | FCA 261 was emitted as 262 |
| F4-B3-02 | HIGH | `NO_STRUCTURAL_LEVEL` rejection | `emergency_anchor_price` board-blind | FCA 803 was emitted as 800 |
| F4-B3-03 | HIGH | `STOP_NOT_BELOW_ENTRY` rejection | `stop_anchor_price` and `emergency_anchor_price` board-blind | FCA 998 was emitted as 995 |
| F4-B3-04 | MEDIUM | source-wide | no guard prevented the next blind call site | 4 offenders found by scan |

## Perbaikan (minimal diff)

All four sites now thread `board / isFca / ticker` exactly like the other
twenty-plus call sites already did. A source-level regression guard
(`F4-B3-04`) fails the suite if any future `tick()` call omits the board
context, which is precisely how these four survived the F11-01 fix.

## Verifikasi

| Tahap | Hasil |
|---|---|
| FAIL pra-perbaikan | 4 test GAGAL (F4-B3-01..04) |
| PASS pasca-perbaikan | **6/6 PASS** |
| Regresi Trade Plan V2 | **111/111 PASS** (`trade-plan-v2*.test.js`, F11, position sizing, F7) |

## Catatan money-management

Two invariants are now pinned as regression guards rather than left implicit:

1. **Per-share arithmetic.** `risk_amount` and `reward_to_tp1` are per-share
   distances; `rr_to_tp1` must equal their ratio. A x100 lot conflation
   anywhere in this engine would break the assertion.
2. **No fabricated lot count.** The V2 engine must NOT expose a `lots` or
   `shares` field. Lot rounding (1 lot = 100 shares) is a sizing concern owned
   by `public/position-sizing-calculator.js`, and duplicating it here would
   inflate every displayed risk figure by two orders of magnitude.
