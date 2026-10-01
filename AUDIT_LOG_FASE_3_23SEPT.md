# AUDIT LOG — FASE 3 (23 SEPTEMBER 2026)
## Forensic Code Audit: VPS Ingestion & Market-Data Cache Layer

**Mode:** Zero-Trust / Test-First Verification
**Tanggal audit:** 2026-09-23 (WIB)
**Auditor:** Autonomous forensic audit run
**Target files:**
1. `lib/vps-data-fetcher.js` (1.048 baris)
2. `lib/daytrade-ohlcv-cache.js` (533 baris) — *substitusi untuk `lib/market-data-cache.js`*

**Artefak yang dihasilkan:**
- `test/audit-fase3-ingestion-cache-bugs.test.js` (11 test)
- `test/fixtures/fase3-bridge-stub.js` (stub bridge out-of-process)
- `BUG_FINDINGS_FASE_3_23SEPT.md`

---

## 1. RESOLUSI TARGET FILE (PENTING)

Task menyebut `lib/market-data-cache.js`. **File tersebut tidak ada di repositori.**

Pemetaan dependensi dilakukan secara empiris (`scratch/fase3-recon.js`, 12 pola pencarian
di seluruh repo) dan menghasilkan kesimpulan berikut:

| Yang dicari | Realita di repo |
|---|---|
| `lib/market-data-cache.js` | **Tidak ada.** |
| Cache data pasar on-disk | `lib/daytrade-ohlcv-cache.js` — dipakai 20 file (termasuk `vps-data-fetcher.js` sendiri) |
| Cache data pasar in-memory | `memoryBrokerSummaryCache` + `memoryDatesCache` di dalam `lib/vps-data-fetcher.js` |
| Konsumen yang di-import `vps-data-fetcher` | `lib/latest-price-resolver.js`, `lib/bandarmologi-service.js`, `lib/bandarmologi-intel-service.js`, `lib/broker-hunter-service.js` |

Karena `vps-data-fetcher.js` **meng-import** `lib/daytrade-ohlcv-cache.js` (via komentar
arsitektur + pemakaian bersama direktori `data/daytrade-ohlcv-cache`), file itulah yang
diaudit sebagai "file cache data pasar terkait". Ini sesuai klausa task
*"(atau file cache data pasar terkait yang di-import oleh vps-data-fetcher)"*.

### 1.1 Peta alur ingestion → cache

```
                       ┌─────────────────────────────────────────┐
   Daytrade Screener ──┤                                         │
   Swing Screener    ──┤  latest-price-resolver.js               │
   API /quote        ──┤    fetchFreshScreenerLatestPrice()      │
   API /sector-hot   ──┤                                         │
                       └──────────────┬──────────────────────────┘
                                      │ fallback bila Supabase kosong
                                      ▼
                       ┌─────────────────────────────────────────┐
                       │  lib/vps-data-fetcher.js                │
                       │    fetchLivePriceFromVpsSync()          │
                       │                                         │
                       │  1. local latest.json  (mtime gate)     │ ← F3-001/002
                       │  2. HTTP bridge (cooldown 60s)          │
                       │  3. SSH langsung ke VPS                 │
                       │  4. fallback snapshot lokal (stale)     │
                       └──────────────┬──────────────────────────┘
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        ▼                             ▼                              ▼
  memoryBrokerSummaryCache     memoryDatesCache              data/daytrade-ohlcv-cache
  (Map, tanpa batas)           (Map, tanpa batas)            (JSON per ticker)
       ← F3-009                     ← F3-009                       ← F3-007/008
```

---

## 2. HIPOTESIS YANG DIUJI

Semua status audit historis (Batch 1/2, AUDIT_HISTORIS_REGRESI, dsb.) diperlakukan sebagai
**hipotesis mentah**. Tidak ada temuan yang diterima tanpa reproduksi langsung terhadap
implementasi terkini.

| ID | Hipotesis | Area checklist |
|---|---|---|
| H1 | TTL lokal 12 jam yang *flat* membuat snapshot berumur 6 jam mengalahkan bridge live saat sesi bursa buka | 1. Cache Invalidation / Stale Data Leakage |
| H2 | Dua permintaan paralel untuk ticker+date yang sama menghasilkan dua request upstream (thundering herd) | 2. Concurrent Fetching / Race Condition |
| H3 | Respons non-200 (429) ditelan tanpa log status apa pun | 3. Error Handling / Upstream Resiliency |
| H4 | `memoryBrokerSummaryCache` & `memoryDatesCache` tumbuh tanpa batas, tanpa cara observasi | 4. Boundary & Memory Leaks |
| H5 | Fallback stale candle tidak punya plafon umur — seri 200 hari tetap disajikan | 1 & 3 |
| H6 | Non-200 pada endpoint `available-dates` juga ditelan tanpa jejak | 3 |
| H7 | Penulisan snapshot cache ke disk non-atomik → JSON parsial/corrupt saat ada pembaca paralel | 2. Race Condition / partial write |

### 2.1 Metode pembuktian (test-first)

Probe empiris dijalankan **sebelum** menulis test atau fix, memakai implementasi nyata
(`scratch/fase3-hypothesis-probe.js`, `scratch/fase3-race-probe.js`,
`scratch/fase3-cadence.js`, `scratch/fase3-atomic-semantics.js`):

- Stub bridge HTTP berjalan **out-of-process** (`worker_threads` / `child_process`).
  Ini wajib: `vps-data-fetcher.js` melakukan panggilan bridge sinkron lewat
  `execFileSync`, yang memblokir event loop proses pemanggil — server in-process
  tidak akan pernah bisa menjawab.
- Tidak ada endpoint produksi, Telegram, Supabase, atau kredensial yang disentuh.
- SSH key diarahkan ke path yang tidak ada agar cabang fallback SSH tidak keluar jaringan.
- Jam dibekukan (`Date.now`) ke instan yang deterministik.

---

## 3. HASIL PROBE EMPIRIS

### 3.1 Fakta jam (dasar penentuan sesi)

```
2026-09-23 UTC day = 3 (Rabu)
2026-09-23T03:00:00Z = 10:00 WIB  -> SESSION_1 (bursa BUKA)
2026-09-23T13:00:00Z = 20:00 WIB  -> CLOSED (bursa TUTUP)
```

### 3.2 Ringkasan probe

```
=== H1: jendela lokal 12 jam membekukan harga "live" ===
local latest.json mtime = 6 jam lalu, harga di file = 500, kebenaran bridge = 999
returned price = 500 | label = vps_local_cache | as_of = 2026-09-22
bridge requests made = 0 []
>>> H1 CONFIRMED: snapshot lokal basi menang, bridge live tidak pernah dihubungi

=== H5: fallback candle stale tanpa plafon umur ===
cache updated_at = 200 hari lalu; fetch upstream melempar 429
result = ARRAY of 90 candles (newest close=189)
stats = {"cacheHit":0,"cacheMiss":0,"fetchSuccess":0,"fetchFail":0,"staleFallback":1,...}
>>> H5 CONFIRMED: candle berumur 200 hari disajikan sebagai seri yang bisa dipakai

=== H2: dua permintaan paralel identik ===
upstream fetch() invocations = 2
>>> H2 CONFIRMED: 2 request upstream duplikat untuk satu fetch logis

=== H3: non-200 ditelan ===
upstream menjawab HTTP 429 untuk setiap panggilan
result = null (bukan objek kosong) | warnings mentioning 429 = []
>>> H3 CONFIRMED: HTTP 429 hilang tanpa jejak — tidak ada warning yang membawa status

=== H4: batas memori ===
setelah 700 ticker berbeda melalui jalur bridge async:
__getMemoryCacheStats exists = undefined
>>> H4 CONFIRMED: tidak ada batas dan tidak ada cara mengamati pertumbuhan cache

=== H6: non-200 di jalur available-dates ===
available-dates 503 -> [] | warnings = []
>>> H6 CONFIRMED: 503 tidak terlihat sama sekali
```

### 3.3 Probe race penulisan disk

```
A) 40 putaran penulis paralel pada ticker sama -> corrupt JSON: 6 | konten tercampur: 0
B) pembaca loop selama 60 penulisan ulang -> 58 reads, 7 observasi JSON parsial
C) inode 5066549581370084 -> 5066549581370084 | handle lama melihat konten BARU = true
```

**Interpretasi C:** inode tidak berubah dan handle yang sudah terbuka langsung melihat
konten baru → penulisan dilakukan **in-place dengan truncate**, bukan rename atomik.
Inilah akar mekanisme torn read pada B.

### 3.4 Kalibrasi sensitivitas detektor (wajib sebelum mempercayai hasil hijau)

Detektor torn-read harus dibuktikan **mampu mendeteksi cacat**; jika tidak, hasil "0 torn"
tidak membuktikan apa pun.

| Cadence pembaca | In-place (pra-fix) | Atomik (pasca-fix) |
|---|---|---|
| 0 ms | 99 / 199 torn | 1 / 306 |
| 1 ms | 93 / 200 torn | 0 / 299 |
| 5 ms | 12 / 102 torn | 0 / 193 |
| 20 ms | 0 / 62 | 0 / 85 |

→ Cadence ~2 ms dipilih untuk test karena terbukti punya daya deteksi tinggi.

### 3.5 Temuan lingkungan: rename-over-open-file di Windows

```
IN-PLACE  : inode sama, handle lama melihat konten baru = true
ATOMIC    : Error: EPERM: operation not permitted, rename '...tmp' -> '...json'
```

`fs.rename` menimpa file yang sedang dibuka proses lain **ditolak di Windows**
(`EPERM`). Ini konsekuensi desain yang harus ditangani, bukan diabaikan.

---

## 4. RINGKASAN TEMUAN

| ID | Judul | Severity | Status |
|---|---|---|---|
| F3-001 | Jendela snapshot lokal 12 jam yang flat membekukan harga live saat sesi bursa | **P0 / Kritis** | FIXED |
| F3-002 | Fallback offline tidak jujur — label & timestamp tidak mencerminkan kebasian | **P1 / Tinggi** | FIXED |
| F3-004 | Thundering herd: request upstream duplikat untuk ticker+date identik | **P1 / Tinggi** | FIXED |
| F3-005 | HTTP 429/502/503 pada broker-summary ditelan tanpa status | **P1 / Tinggi** | FIXED |
| F3-006 | HTTP 503 pada available-dates ditelan tanpa status | **P2 / Sedang** | FIXED |
| F3-007 | Fallback stale candle tanpa plafon umur (200 hari tetap disajikan) | **P1 / Tinggi** | FIXED |
| F3-008 | Penulisan snapshot cache non-atomik → JSON parsial/torn read | **P1 / Tinggi** | FIXED |
| F3-009 | Cache in-memory tanpa batas & tanpa observabilitas | **P2 / Sedang** | FIXED |

Detail lengkap (diff, kode test, bukti FAIL/PASS) ada di `BUG_FINDINGS_FASE_3_23SEPT.md`.

---

## 5. TIMELINE EKSEKUSI

| Waktu (UTC) | Aktivitas |
|---|---|
| 13:01 | Mulai. Recon target file; deteksi `lib/market-data-cache.js` tidak ada |
| 13:02–13:03 | Pemetaan graf dependensi (12 pola, seluruh repo) |
| 13:04–13:06 | Probe hipotesis H1–H7 terhadap implementasi nyata |
| 13:06 | Probe race disk + kalibrasi sensitivitas detektor |
| 13:08–13:11 | Verifikasi konstrain regresi pada 20+ test terkait |
| 13:12 | Menulis `test/fixtures/fase3-bridge-stub.js` |
| 13:14 | Menulis `test/audit-fase3-ingestion-cache-bugs.test.js` |
| 13:14 | **Bukti FAIL #1:** 7 dari 10 test gagal |
| 13:24–13:29 | Implementasi perbaikan minimalis pada 2 file lib |
| 13:29 | Perbaikan detektor F3-008 (sync loop → cadence timer) |
| 13:30 | **Bukti FAIL #2:** revert sementara penulisan atomik → 34/152 torn read |
| 13:30–13:31 | **PASS run 1** (11/11) dan **PASS run 2** (11/11) |
| 13:31 | Registrasi ke `tools/curated-build-tests.json` (520 entri) |
| 13:31 | Validasi sintaks: 881 file `.js` bersih |
| 13:32–13:33 | **Full suite hijau: 520/520 file test lolos** |

---

## 6. METRIK VERIFIKASI

| Metrik | Nilai |
|---|---|
| Test baru | 11 |
| Test gagal pra-perbaikan | **7 / 10** |
| Bukti daya-deteksi F3-008b | **34 dari 152** pembacaan paralel rusak |
| PASS run 1 | 11 / 11 (0 fail) |
| PASS run 2 | 11 / 11 (0 fail) |
| Full suite | **520 / 520 file test lolos** |
| Batch gagal di full suite | 0 |
| Total kegagalan dilaporkan | 0 |
| Validasi sintaks | 881 file `.js` parsed bersih, 520 entri curated valid |
| Suite yang terpengaruh langsung | 67 test / 8 file — semua lolos |
| Baris berubah | +242 / −47 (3 file) |

### 6.1 Suite regresi yang diverifikasi langsung

`vps-data-fetcher-bugs`, `vps-api-bridge-tunnel`, `daytrade-ohlcv-cache`,
`daytrade-ohlcv-cache-bugs`, `daytrade-ohlcv-cache-offhours-ttl`,
`audit-regresi-batch3-guards`, `audit-batch2-live-pricing`, `audit-batch1-integrity`
→ **67 test, 0 gagal.**

### 6.2 Catatan noise yang diverifikasi bukan kegagalan

Output full suite memuat baris `ERROR: SHITERU_API_KEY is not set.` dan
`ERROR: T00/fail-model - fetch failed`. Ini adalah **jalur negatif yang disengaja**
fixture test (provider failover / missing-credential). Dikonfirmasi:
`failed batches: 0`, `ℹ fail 0` di setiap batch, dan pesan akhir
`All 520 test files passed successfully!`.

---

## 7. PRINSIP PERBAIKAN YANG DIPATUHI

1. **Minimalis, tanpa refactoring liar.** Tidak ada perubahan pada tanda tangan fungsi
   publik, tidak ada pemindahan modul, tidak ada perubahan kontrak export yang memutus
   konsumen. Satu export baru ditambahkan (`__getMemoryCacheStats`), satu helper
   diekspor (`writeFileAtomic`), keduanya aditif.
2. **Perbaikan tidak mematahkan perilaku yang sah.** H1 diperbaiki tanpa mematikan
   manfaat offline (dijaga oleh test F3-003); F3-007 diperbaiki tanpa mematikan
   fallback operasional (dijaga oleh test F3-007b).
3. **Setiap perbaikan punya test yang gagal tanpanya.** F3-008b diverifikasi dengan
   mengembalikan sementara kode lama dan mengamati kegagalan nyata.
4. **Tidak ada kegagalan yang disembunyikan.** Justru sebaliknya: tiga perbaikan
   (F3-002, F3-005, F3-006) adalah tentang *menghadirkan* kegagalan yang tadinya senyap.

---

## 8. RISIKO SISA & REKOMENDASI LANJUTAN

| # | Item | Catatan |
|---|---|---|
| R1 | Ambang `LIVE_SNAPSHOT_FRESH_MS = 30 menit` | Dipilih agar tetap mencakup cadence scan 15 menit. Bila cadence berubah, ambang ini perlu ditinjau. |
| R2 | Ambang `DEFAULT_MAX_STALE_FALLBACK_MS = 7 hari` | Cukup untuk long weekend + libur, namun tidak untuk penghentian panjang. Bisa di-override per provider. |
| R3 | Jendela torn-read Windows | Bila rename ditolak (pembaca terus-menerus memegang file), implementasi turun ke penulisan in-place dengan peringatan eksplisit. Ini kompromi sadar: memperbarui cache lebih penting daripada jendela balapan yang sangat sempit. Di Linux/VPS tidak terjadi. |
| R4 | `fetchOhlcvFromVpsSync` menulis tanpa atomik | Di luar cakupan perbaikan minimalis Fase 3 (jalur berbeda, ditulis sekali saat backfill). Layak dijadikan kandidat Fase berikutnya. |
| R5 | `fetchBrokerHunterFromVpsSync` juga menulis tanpa atomik | Idem R4. |
| R6 | Cooldown bridge 60 detik bersifat global | Sebuah kegagalan pada satu ticker menunda seluruh ticker selama 1 menit. Perilaku ini sengaja dipertahankan (melindungi bridge yang sedang rate-limited), namun kini terlihat di `__getMemoryCacheStats`. |

---

## 9. CARA MEREPRODUKSI

```bash
# 1. Bukti FAIL pra-perbaikan (dengan kode lama)
git stash                    # atau checkout versi sebelum perbaikan
node --test test/audit-fase3-ingestion-cache-bugs.test.js
#    -> fail 7 / pass 3

# 2. Terapkan perbaikan, lalu verifikasi PASS 2x
node --test test/audit-fase3-ingestion-cache-bugs.test.js   # run 1 -> 11/11
node --test test/audit-fase3-ingestion-cache-bugs.test.js   # run 2 -> 11/11

# 3. Full suite
node tools/run-build-test-suite.js --full
#    -> All 520 test files passed successfully!

# 4. Validasi sintaks + integritas curated list
node tools/validate-full-syntax.js
#    -> 881 .js files parsed; 520 curated entries, 0 missing
```

Log mentah tersimpan di `scratch/`:
`fase3-fail-evidence.txt`, `fase3-008-fail-proof.txt`,
`fase3-pass-run1.txt`, `fase3-pass-run2.txt`, `fase3-full-suite.txt`.

---

**Status akhir: SELESAI — 8 temuan terverifikasi dan diperbaiki, 11 test penjaga terdaftar, full suite hijau (520/520).**
