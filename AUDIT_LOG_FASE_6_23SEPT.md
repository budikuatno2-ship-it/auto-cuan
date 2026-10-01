# AUDIT LOG — FASE 6 (23 SEPT 2026)

**Subsystem:** Foreign Flow Engine · Foreign Watchlist Daily · Insider / Big Money Tracking
**Metode:** Zero-trust forensic audit · dependency traversal riil · test-first (FAIL → fix → PASS 2×)
**Baseline:** `feat/daytrade-screener-v1` @ `5e934a56`
**Hasil:** **6 temuan bug** dikonfirmasi lewat reproduksi, diperbaiki, dan diverifikasi

---

## 1. TARGET RESOLUTION PROTOCOL

### 1.1 Koreksi terhadap daftar file hipotesis

Daftar file di brief adalah **hipotesis mentah**. Dependency traversal riil menemukan bahwa tiga dari empat nama file tidak ada di repo ini:

| Disebut di brief | Status riil | Modul riil yang ditemukan |
|---|---|---|
| `lib/foreign-flow-service.js` | **TIDAK ADA** | `lib/foreign-flow-store.js`, `lib/foreign-flow-recap.js`, `lib/daily-foreign-context.js` |
| `lib/foreign-watchlist-service.js` | **TIDAK ADA** | `lib/user-watchlist-service.js` (konsumen ke-4 `foreign_watchlist_daily`) |
| `api/foreign-watchlist-daily.js` | **TIDAK ADA** | `api/sector-hot.js` (endpoint monolit, 15.001 baris) |
| `lib/insider-service.js` | **TIDAK ADA** | `lib/insider-network-service.js` + `normalizeInsiders()` di `lib/bandarmologi-service.js` |
| `lib/insider-tracking.js` | **TIDAK ADA** | `tools/collect-insider-data.js`, `tools/process-insider-roster.js` |
| `supabase/foreign-watchlist-daily-migration.sql` | **ADA** | idem (37 baris) |

### 1.2 Dependency graph riil

```
                        ┌──────────────────────────────────────┐
                        │  supabase/foreign-watchlist-daily-   │
                        │  migration.sql   (SKEMA KANONIK)     │
                        └──────────────┬───────────────────────┘
                                       │ tabel foreign_watchlist_daily
              ┌────────────────────────┼─────────────────────────────┐
              │                        │                             │
     ┌────────▼────────┐     ┌─────────▼──────────┐      ┌───────────▼──────────┐
     │ WRITE PATH      │     │ READ PATH (flow)   │      │ READ PATH (price)    │
     ├─────────────────┤     ├────────────────────┤      ├──────────────────────┤
     │ admin-foreign-  │     │ foreign-flow-      │      │ user-watchlist-      │
     │ upload.js       │     │ store.js           │      │ service.js (sumber-4)│
     │ (CSV admin web) │     │   ↓                │      │                      │
     │                 │     │ daily-foreign-     │      │ chart-image-         │
     │ tools/import-   │     │ context.js         │      │ renderer.js (chart)  │
     │ foreign-        │     │   ↓                │      │                      │
     │ watchlist.js    │     │ daily-market-      │      │ api/sector-hot.js    │
     │ (CSV CLI)       │     │ context-builder.js │      │ (:5754 OHLC)         │
     └─────────────────┘     └────────────────────┘      │ latest-price-        │
                                                          │ resolver.js          │
                                                          └──────────────────────┘

     ┌───────────────────────── FOREIGN FLOW ENGINE (sisi broker) ─────────────────────┐
     │ data/arjum-data/broker-summary/<TICKER>/<DATE>.json                              │
     │   ↓ bandarmologi-service.js :: normalizeBrokerSummary()                          │
     │       → FOREIGN_INST_BROKERS (whitelist asing)  ← AUDIT-F6-03                    │
     │       → getNetForeignFlow() / evaluateConfluenceSignal()                         │
     │   ↓ vps-data-fetcher.js (bridge/SSH)                                             │
     │ foreign-flow-recap.js :: FOREIGN_BROKERS (whitelist kanonik)                     │
     └──────────────────────────────────────────────────────────────────────────────────┘

     ┌────────────────────────── INSIDER / BIG MONEY TRACKING ─────────────────────────┐
     │ tools/collect-insider-data.js   → data/arjum-data/insiders/<TICKER>/p1.json      │
     │ data/insider-network/insiders-db.json  (11.219 record, 14 kolom)                 │
     │   ↓ bandarmologi-service.js :: normalizeInsiders()   ← AUDIT-F6-04, F6-06        │
     │   ↓ insider-network-service.js :: aggregateInsiderHoldings()  ← AUDIT-F6-05      │
     │ tools/process-insider-roster.js → data/insider-network/roster.json + network.json│
     └──────────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Verifikasi status aktif vs stub (brief §1)

| Pertanyaan brief | Jawaban terverifikasi |
|---|---|
| Apakah modul insider terhubung ke database? | **TIDAK ke Supabase.** Modul insider aktif **berbasis file JSON di disk** (`data/insider-network/insiders-db.json` = 11.219 record nyata, `roster.json`, `network.json`). Tidak ada tabel Supabase untuk insider; tidak ada migration SQL insider di `supabase/`. |
| Apakah berupa stub/mock? | **BUKAN stub.** Data nyata, tetapi *sumbernya* adalah scraper (`tools/collect-insider-data.js`) + pipeline (`tools/process-insider-roster.js`). |
| Foreign flow: DB atau disk? | **DUA jalur terpisah.** `foreign_watchlist_daily` (Supabase, via CSV admin) untuk konteks harian; `data/arjum-data/broker-summary/` (disk, via Arjum/VPS) untuk foreign flow sisi broker. Keduanya punya whitelist broker asing **sendiri-sendiri** — sumber AUDIT-F6-03. |

---

## 2. METRIK AUDIT

| Metrik | Nilai |
|---|---|
| File sumber dibaca penuh | 12 |
| Baris kode ditelusuri | ± 21.400 (sector-hot 15.001 + bandarmologi-service 2.701 + sisanya) |
| Tabel/kolom Supabase diverifikasi terhadap migration | 1 tabel, 14 kolom |
| Konsumen `foreign_watchlist_daily` dipetakan | 10 call site di 5 file |
| Hipotesis bug diuji | 9 |
| Bug terkonfirmasi (reproduksi FAIL) | **6** |
| Hipotesis gugur (kode sudah benar) | 3 |
| Unit test baru | 10 (`test/audit-fase6-foreign-insider-bugs.test.js`) |
| Test suite repo pasca-perbaikan | **523 file, 0 fail** |

### 2.1 Hipotesis yang GUGUR (tidak terbukti bug)

Zero-trust juga berarti **tidak memaksakan temuan**. Tiga hipotesis brief diuji dan ditolak dengan bukti:

| Hipotesis brief | Hasil verifikasi | Bukti |
|---|---|---|
| §1: "Kalkulasi tidak memisahkan pasar REGULER (RG) / NEGOSIASI (NG) / TUNAI (TN)" | **GUGUR** — tidak ada pemisahan board sama sekali di seluruh repo, jadi ini bukan cacat pemisahan melainkan **keterbatasan cakupan sumber data** yang sudah didokumentasikan eksplisit di header modul (`lib/foreign-flow-store.js:2-11`: "`foreign_buy` and `foreign_sell` are always null in that table today — there is no verified buy/sell-split source in this repository, so this module never fabricates a split"). | Grep `negosiasi\|REGULER\|board_type\|NG_\|TN_` → 0 modul foreign yang memakainya. |
| §2: "Query PostgREST foreign watchlist memakai field order tidak eksis (HTTP 400 silent, kelas BUG-FASE1-001)" | **GUGUR untuk ORDER, TERBUKTI untuk SELECT.** `order()` memang sudah memakai `trade_date`/`uploaded_at` yang eksis (komentar di `lib/latest-price-resolver.js:5-11` sudah menutup jalur ini). Namun `select()` masih menyebut 3 kolom tidak eksis → menjadi **AUDIT-F6-01**. | Bandingkan daftar `.select()` dengan `declaredForeignColumns()` pada test F6-01a. |
| §1: "Pembagian dengan nol / NaN jika foreign buy & sell = 0" | **GUGUR** — guard `foreignSell > 0` / `foreignBuy > 0` sudah ada di `getNetForeignFlow()`. Diperkuat dengan komentar eksplisit + penanganan `foreign_net` non-finite agar tidak bergantung pada perbandingan `NaN` yang menyamar sebagai `false`. | `lib/bandarmologi-service.js:2594-2601`. |

---

## 3. TEMUAN (ringkasan — detail lengkap di `BUG_FINDINGS_FASE_6_23SEPT.md`)

| ID | Judul | Modul | Severity | Dampak riil |
|---|---|---|---|---|
| **F6-01** | `foreign_watchlist_daily` tidak punya kolom `open/high/low`, tetapi 3 konsumen men-select-nya → HTTP 400 silent | `supabase/foreign-watchlist-daily-migration.sql`, `lib/admin-foreign-upload.js`, `lib/user-watchlist-service.js`, `lib/chart-image-renderer.js`, `api/sector-hot.js` | **KRITIS** | Sumber harga ke-4 watchlist & fallback chart OHLC **selalu gagal diam-diam** |
| **F6-02** | `foreign_net` NULL dikonversi menjadi 0 → "Foreign Neutral" palsu | `api/sector-hot.js` (`deriveForeignConfluenceFromRows`, `fetchForeignSummary`) | **TINGGI** | Saham tanpa data terklasifikasi netral; rata-rata 7D terdilusi ke nol |
| **F6-03** | `CC` (Mandiri Sekuritas — **domestik**) dihitung sebagai broker asing | `lib/bandarmologi-service.js` (`FOREIGN_INST_BROKERS`) | **KRITIS** | Setiap pembelian institusi domestik menggelembungkan `foreign_buy` |
| **F6-04** | `toNumericOrNull()` gagal parse string ribuan Indonesia (`"3.200.142.830"`) | `lib/bandarmologi-service.js` | **TINGGI** | Saldo kepemilikan pemegang >5% hilang menjadi `null` |
| **F6-05** | `aggregateInsiderHoldings()` memakai **saldo** sebagai **delta** transaksi | `lib/insider-network-service.js` | **KRITIS** | Akumulasi palsu hingga miliaran lembar |
| **F6-06** | Tanggal transaksi & tanggal pelaporan OJK/BEI tidak dibedakan | `lib/bandarmologi-service.js` (`normalizeInsiders`) | **TINGGI** | Time-leak / look-ahead: sinyal dianggap diketahui pada hari transaksi |

---

## 4. CATATAN METODOLOGI

### 4.1 Mengapa bukti harus berupa test yang GAGAL

Klaim audit historis diperlakukan sebagai hipotesis mentah. Sebuah temuan baru sah bila:
1. Ada **kode produksi** yang dapat dieksekusi ulang (bukan hanya pembacaan mata).
2. Test menuliskan **kontrak yang benar** (bukan sekadar menyalin perilaku saat ini).
3. Test tersebut **FAIL** pada kode sebelum perbaikan — dibuktikan dengan eksekusi nyata.
4. Setelah perbaikan minimal, test **PASS 2× berturut-turut**.
5. Suite repo tetap **hijau** (tidak ada regresi tersembunyi).

### 4.2 Satu regresi ditemukan dan diperbaiki selama audit

Perbaikan F6-03 awalnya dilakukan dengan **menyelaraskan seluruh whitelist** ke daftar kanonik `FOREIGN_BROKERS` (menambah `GW`, `DP`, `MS`, `CG`, `ML`, `BQ`, `FS`, `YU`). Ini **menyebabkan 3 regresi** di `test/bandarmologi-integration.test.js`:

```
✖ net_status: actual 'BIG_ACCUMULATION' vs expected 'BIG_DISTRIBUTION'
✖ net_flow  : actual 39000           vs expected -100000
✖ net_flow  : actual 60              vs expected -40
```

Penyebab: `YU` (CGS International) berperan sebagai pembeli domestik pada fixture test tersebut. Perbaikan dikembalikan ke **deletion murni** — hanya `CC` yang dihapus — sehingga seluruh anggota whitelist lain tidak tersentuh. Setelah itu 48/48 test terkait PASS dan suite penuh hijau.

**Pelajaran:** perbaikan presisi berarti **perubahan sekecil mungkin yang menutup bug**, bukan penyelarasan semantik yang lebih luas. Regresi ini terdeteksi justru karena suite dijalankan penuh, bukan hanya test baru.

### 4.3 Regresi lain yang dicek dan aman

| Test | Jumlah | Status |
|---|---|---|
| `test/audit-fase6-foreign-insider-bugs.test.js` (baru) | 10 | PASS 2× |
| `test/bandarmologi-integration.test.js` | 31 | PASS |
| `test/regime-adaptive-and-foreign-confluence.test.js` | — | PASS |
| `test/daily-foreign-context.test.js` | 7 | PASS |
| `test/foreign-flow-recap.test.js` | 4 | PASS |
| `test/admin-foreign-upload.test.js` | — | PASS |
| `test/insider-network-integrity.test.js` | — | PASS |
| `test/insider-roster-table.test.js` | — | PASS |
| `test/insider-transaction-table.test.js` | — | PASS |
| `test/insider-data-fabrication-removal.test.js` | — | PASS |
| `test/user-watchlist-multisource-prices.test.js` | — | PASS |
| `test/remove-hardcoded-date-fallbacks.test.js` | — | PASS |
| **Suite penuh repo** | **523 file** | **0 fail** |

---

## 5. FILE YANG DIUBAH

| File | Perubahan | Temuan |
|---|---|---|
| `supabase/foreign-watchlist-daily-migration.sql` | +3 kolom `open/high/low` | F6-01 |
| `lib/admin-foreign-upload.js` | Persist `open/high/low` yang sudah di-parse | F6-01 |
| `lib/bandarmologi-service.js` | Hapus `CC` dari whitelist; `toNumericOrNull` delegasi ke `toNumberLoose`; +`filing_date`/`signal_available_date`; `NO_DATA` status; guard rasio | F6-03, F6-04, F6-06 |
| `lib/insider-network-service.js` | Delta hanya dari `shares_change`/`changes_value` | F6-05 |
| `api/sector-hot.js` | `nullableFiniteNumber`; `sumObservedForeignNet`; derivasi tunggal; `fetchForeignSummary` rata-rata berbasis sesi berdata; ekspos `__test` | F6-02 |
| `test/audit-fase6-foreign-insider-bugs.test.js` | **BARU** — 10 test reproduksi | — |
| `tools/curated-build-tests.json` | Daftarkan test baru | — |
| `scratch/fase6-pass-evidence.txt` | Bukti eksekusi PASS 2× | — |

---

## 6. REKOMENDASI LANJUTAN (di luar cakupan perbaikan minimal)

1. **Pemisahan board RG/NG/TN** — memerlukan sumber data baru (saat ini tidak ada). Sebelum tersedia, setiap label foreign harus tetap membawa `unit: 'IDR_VALUE'` dan `foreign_buy/sell: null` seperti sekarang; jangan mengarang split.
2. **Migrasi insider ke Supabase** — saat ini 11.219 record insider hanya hidup sebagai file JSON di disk, sehingga tidak ada RLS, tidak ada retention policy, dan tidak ada audit trail. Ini risiko operasional jangka panjang, bukan bug.
3. **`fetchForeignUniverseTickers`** (`lib/daytrade-screener-engine.js:1754`) mengambil `limit(5000)` lintas-universe lalu mendeduplikasi di memori. Bila volume upload tumbuh melampaui 5.000 baris, sebagian emiten akan terpotong tanpa peringatan. Perlu `SAFE_QUERY_ROW_BUDGET`-style chunking seperti di `lib/foreign-flow-store.js`.
4. **`ORDER BY uploaded_at` pada `foreign_watchlist_daily`** sudah aman (kolom eksis), tetapi `trade_date` sudah cukup unik per ticker berkat constraint `UNIQUE (trade_date, ticker)` — tie-breaker ini tidak berbahaya, hanya tidak perlu.


---

# ADDENDUM — BATCH 3 (FASE 6: DAY-TRADE OHLCV CACHE)

**Branch:** `fix/batch-3-money-mgmt-cache-fase4-5-6`
**Target file:** `lib/daytrade-ohlcv-cache.js`
**Suite:** `test/audit-fase6-ohlcv-cache-bugs.test.js` (10 test)

> **Scope note.** The body of this document above audits the Foreign Flow
> engine, foreign watchlist daily and insider tracking. Batch 3 re-audits the
> **Day-Trade OHLCV cache** because the task brief named
> `lib/daytrade-ohlcv-cache.js`.

## Temuan Batch 3

| ID | Severity | Defect | Evidence |
|---|---|---|---|
| F6-B3-01 | HIGH | corrupt cache indistinguishable from a cold start | both returned `{ hit: false }` with no `corrupt` flag |
| F6-B3-02 | MEDIUM | a transient Windows sharing violation (EPERM/EACCES/EBUSY) was reported as "no cache" | one failed `readFile` and the good cache was abandoned |
| F6-B3-03 | HIGH | `writeFileAtomic` fell back to an **in-place** write | over a directory this threw EISDIR with a stray temp file |
| F6-B3-05 | HIGH | the in-place fallback re-opened the torn-read window | 6 concurrent writers produced unparseable files |

## Perbaikan (minimal diff)

1. **`corrupt` is now a first-class result flag.** `readCache` distinguishes
   "file exists but is unreadable data" from "no file yet", and a corrupt file
   is never served as an upstream-failure fallback.
2. **Bounded retry on transient read codes.** `readFileWithRetry` retries
   EPERM/EACCES/EBUSY/EMFILE/ENFILE with backoff (4 attempts) and still fails
   closed on a persistent error.
3. **No in-place fallback, ever.** The destination shape is validated up front
   (EISDIR/EINVAL before any side effect), the rename is retried 15 times with
   growing backoff, and a persistent refusal now throws instead of clobbering
   the previous snapshot. A stale-but-complete cache is strictly better than a
   corrupt one.
4. **Observability.** `staleRejected` counts refusals of over-age fallbacks
   alongside the existing `staleFallback` counter.

## Verifikasi

| Tahap | Hasil |
|---|---|
| FAIL pra-perbaikan | 4 test GAGAL (F6-B3-01, 02, 02b, 05) |
| PASS pasca-perbaikan | **10/10 PASS** |
| Regresi terkait | **51/51 PASS** (`daytrade-ohlcv-cache*`, `daytrade-vps-worker-observe`, `audit-regresi-batch3-guards`) |

## Kontrak yang dikunci

* **TTL honesty.** Selama jam bursa IDX TTL yang dikonfigurasi berlaku; di luar
  jam bursa jendela melebar ke 12 jam karena data tidak dapat berubah.
* **Age ceiling.** Fallback hanya boleh disajikan bila `updated_at` dapat
  diverifikasi dan umurnya di bawah plafon (default 7 hari, dapat dikonfigurasi
  via `maxStaleFallbackMs`). Waktu tulis yang tidak diketahui = fail closed.
* **Atomicity.** Penulis tidak pernah menulis di tempat (in-place); pembaca
  tidak pernah melihat snapshot terpotong, bahkan di bawah 6 penulis bersamaan.
