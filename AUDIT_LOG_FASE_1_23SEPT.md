# AUDIT LOG — FASE 1 (23 SEPT 2026)

**Mode:** FORENSIC CODE AUDIT & INDEPENDENT VERIFICATION (ZERO-TRUST)
**Tanggal eksekusi:** 23 September 2026 (WIB)
**Repo:** `d:/auto-cuan-2` @ `5e934a56f3be6aeb5c50d663ce3c187e53c56bb8`
**File target:**
1. `lib/latest-price-resolver.js` (184 baris)
2. `lib/idx-tick-normalization.js` (1187 baris)

**Deliverable:**
- `AUDIT_LOG_FASE_1_23SEPT.md` (dokumen ini)
- `BUG_FINDINGS_FASE_1_23SEPT.md`
- `test/audit-fase1-price-bugs.test.js` (suite pembuktian, 14 test)

---

## 0. PRINSIP KERJA YANG DITERAPKAN

1. **Zero-trust terhadap audit historis.** Semua klaim lama (`FULL_REPO_AUDIT_LOG*.md`, `FULL_REPO_BUG_FINDINGS*.md`, `FULL_REPO_FIX_LOG.md`, `MASTER_ALL_BUG_FINDINGS_FASE1_TO_9.md`, `.agents/audit-checkpoint.md`) diperlakukan sebagai **hipotesis mentah**. Setiap lead diverifikasi ulang langsung ke implementasi kode terkini.
2. **Test-first verification.** Tidak ada temuan yang diakui tanpa siklus **FAIL → PASS** dengan output terminal otentik.
3. **Deterministik & otonom.** Tanpa network, tanpa kredensial produksi; seluruh stub bersifat lokal dan deterministik.

### Catatan zero-trust penting (klaim lama vs kenyataan)

| Klaim lama | Status verifikasi ulang |
|---|---|
| `FULL_REPO_FIX_LOG.md` F-053: "`isFresh` jendela 48 jam" | **STALE** — kode sekarang 72 jam (dengan komentar alasan weekend gap). Lead ini sudah kedaluwarsa. |
| `FULL_REPO_AUDIT_LOG.md:654`: "1 LOW: ARB flat -15%" (F-069) | **Terverifikasi ada di kode** (`getIdxAutoRejectBand`: ARB flat -15% vs ARA bertingkat 35/25/20). Namun tidak diangkat sebagai bug baru karena tanpa rujukan regulasi pembanding yang otoritatif di repo ini, dan tidak ada bukti FAIL yang bisa direproduksi dari kontrak yang ada. Dicatat sebagai observasi terbuka di bagian 4. |
| `AUDIT_CHECKPOINT` BUG-027 / BUG-021 | **Sudah diperbaiki** di kode saat ini (`cleanObservation` strip regex; alias entry). Tidak ada regresi. |
| `test/latest-price-resolver-bugs.test.js` (6 test) | **PASS 6/6** — baseline hijau. |
| `test/latest-price-resolver-wib-date-regression.test.js` | **PASS 3/3** — perbaikan WIB date sebelumnya valid. |

---

## 1. STATUS FILE

| # | File | Baris | Status audit | Temuan terbukti |
|---|---|---|---|---|
| 1 | `lib/latest-price-resolver.js` | 184 | **TUNTAS — 3 BUG diperbaiki & diverifikasi** | BUG-FASE1-001, BUG-FASE1-004 (2 sub-temuan) |
| 2 | `lib/idx-tick-normalization.js` | 1187 | **TUNTAS — 1 BUG diperbaiki & diverifikasi** | BUG-FASE1-003 |

Hipotesis yang **ditolak** setelah verifikasi silang: BUG-FASE1-002 (same-day freshness inversion) — lihat bagian 5.

---

## 2. FUNGSI YANG DIANALISIS

### 2.1 `lib/latest-price-resolver.js`

| Fungsi | Baris | Hasil |
|---|---|---|
| `n(value)` | 20 | **BERSIH** — boolean ditolak eksplisit, NaN/Infinity/≤0 → null. Terverifikasi probe (B4). |
| `date(value)` | 21 | **BERSIH** — date-only string diberi offset WIB +07:00; invalid → null. |
| `dateOnly(value)` | 41 | **BERSIH** — memakai `toDateKey` (Asia/Jakarta aware), sesuai komentar anti-UTC-slice. |
| `rowPrice(row)` | 42 | **BERSIH** — fallback berurutan lintas 7 field; nilai non-positif dilewati. |
| `rowDate(row)` | 43 | **BERSIH** — 10 field tanggal, urutan prioritas wajar. |
| `isFresh(row, options)` | 45 | **BERSIH** — 72 jam + toleransi masa depan 1 jam; `maxAgeHours=0/-5` jatuh ke default 72 (dicatat sebagai observasi, bukan bug: tidak ada pemanggil yang mengirim 0/negatif). |
| `resolveLatestPrice(rowsBySource, options)` | 46–60 | **BERSIH setelah audit** — perbandingan `dKey` per hari bursa WIB; tie-break memakai prioritas `SOURCES` (kontrak terkunci test lama). Tanpa pembagian → tidak ada risiko ZeroDivision. |
| `fetchFreshScreenerLatestPrice(ticker, options)` | 62–125 | **2 BUG** (BUG-FASE1-001a/001b) — kolom `order` yang tidak ada membuat query gagal senyap. Diperbaiki. |
| `resolveLatestPriceBulk(rowsByTicker, options)` | 140–172 | **2 BUG** (BUG-FASE1-004a/004b) — kontrak JSDoc dilanggar. Diperbaiki. |

**Pemeriksaan khusus sesuai checklist:**

- **Data availability (null/undefined/NaN/payload tidak lengkap):** semua jalur diuji — hasil `{price:null, stale:true}` konsisten; tidak ada `throw`. ✔
- **Fallback timestamp (risiko menyajikan harga penutupan kemarin saat market live):** jendela 72 jam + `dKey` per hari bursa; baris hari berjalan selalu menang lintas hari. Namun **jalur query** yang rusak (BUG-FASE1-001) berpotensi mengambil baris sembarang dari hari lama dalam jendela — inilah vektor stale price yang ditemukan dan diperbaiki. ✔ (temuan)
- **Race condition & caching:** modul ini **tidak memiliki cache in-memory sendiri**; `Promise.all` mengumpulkan hasil deterministik per tabel (tidak ada last-writer-wins antar sumber). Cache 60 detik hanya ada di `lib/vps-data-fetcher.js` (fallback VPS) dan tidak mencampur status stale/fresh. Tidak ditemukan race yang dapat direproduksi. ✔
- **Zero/negative:** `n()` menolak ≤0; `price > 0` di semua gerbang; tidak ada operasi pembagian dengan harga di modul ini. ✔

### 2.2 `lib/idx-tick-normalization.js`

| Fungsi | Baris | Hasil |
|---|---|---|
| `toNum` / `round2` | 10–20 | **BERSIH** — guard null/'' /non-finite. |
| `isAkselerasiOrFca` | 24–32 | **BERSIH** — `isFca === true` ketat; board/ticker/window FCA didukung. Observasi: `is_fca: "true"` (string) tidak dikenali sebagai FCA (lihat bagian 4). |
| `getIdxTickSize` | 34–43 | **SESUAI REGULASI BEI** — diverifikasi terhadap 5 tier resmi (Rp1/2/5/10/25). |
| `roundToIdxTick` | 45–61 | **1 BUG** (BUG-FASE1-003) — harga positif < Rp1 menghasilkan 0 (bukan level sah). Diperbaiki. |
| `isValidIdxPriceLevel` | 67–72 | **BERSIH** — modulo tick dengan epsilon 1e-9; menolak ≤0. |
| `normalizeTradingPlanLevels` | 458–535 | **BERSIH arah pembulatan** — SL `floor`, TP `ceil`, resistance `ceil`, support `floor` (konservatif). Terkunci test LOCK. |
| `validateTradingPlanSanity` | 227–263 | **BERSIH** — gate struktural + gate tick. |
| `deriveIdxAutoRejectLevels` / `deriveCandlePotentialRange` | 992–1123 | **BERSIH secara aritmetika** — sweep BigInt 1..30000 untuk ARA `floor(ref*1.25)` & ARB `ceil(ref*0.85)`: **0 anomali floating point**. |
| `deriveSignalVerdict`, `deriveRiskLabelV2`, dll. | 801–964 | **BERSIH** — fuzz 18 fungsi × 10 payload rusak: **0 throw**. |

**Pemeriksaan khusus sesuai checklist:**

- **Batas fraksi harga:** `199→1, 200→2, 498→2, 500→5, 1995→5, 2000→10, 4990→10, 5000→25, 5025→25` — **100% sesuai regulasi BEI**. ✔
- **Boundary & floating point:** sweep integer 1..30000 × 3 mode = **0 anomali**; sweep fraksional 60009 nilai — satu-satunya anomali adalah hasil 0 untuk harga < Rp1 (BUG-FASE1-003). Tidak ada `0.1+0.2`-class drift pada pembulatan tick (operasi rasional ×tick eksak untuk integer). ✔
- **Arah normalisasi:** SL `floor` (tidak memperlebar risiko), TP/trigger/resistance `ceil` (tidak mengecilkan target) — arah konservatif benar, terkunci test. ✔

---

## 3. UNIT TEST YANG DIEKSEKUSI

### 3.1 Suite baru (bukti utama)

| Perintah | Hasil |
|---|---|
| `node --test test/audit-fase1-price-bugs.test.js` (SEBELUM fix) | **9 FAIL / 5 PASS** — output disimpan: `scratch/fase1-fail-evidence.txt` |
| `node --test test/audit-fase1-price-bugs.test.js` (SESUDAH fix, run #1) | **14 PASS / 0 FAIL** |
| `node --test test/audit-fase1-price-bugs.test.js` (run #2) | **14 PASS / 0 FAIL** |
| `node --test test/audit-fase1-price-bugs.test.js` (run #3) | **14 PASS / 0 FAIL** — output disimpan: `scratch/fase1-pass-evidence.txt` |

Daftar 14 test:

| # | Test | Status pra-fix | Status pasca-fix |
|---|---|---|---|
| 1 | BUG-FASE1-001a (REST order foreign_watchlist_daily) | ✖ FAIL | ✔ PASS |
| 2 | BUG-FASE1-001b (SDK order non-konglo) | ✖ FAIL | ✔ PASS |
| 3 | BUG-FASE1-001c (kontrak orderColumn SOURCES) | ✖ FAIL | ✔ PASS |
| 4 | BUG-FASE1-002a (lock prioritas same-day) | ✔ (lock) | ✔ PASS |
| 5 | BUG-FASE1-002b (lock lintas hari) | ✔ (lock) | ✔ PASS |
| 6 | BUG-FASE1-002c (lock tie-break SOURCES) | ✔ PASS | ✔ PASS |
| 7 | BUG-FASE1-003a (sub-Rp1 tidak boleh 0) | ✖ FAIL | ✔ PASS |
| 8 | BUG-FASE1-003b (SL sub-Rp1 tidak bocor 0) | ✖ FAIL | ✔ PASS |
| 9 | BUG-FASE1-004a (key `.JK` bulk) | ✖ FAIL | ✔ PASS |
| 10 | BUG-FASE1-004b (pre-resolved map) | ✖ FAIL | ✔ PASS |
| 11 | LOCK fraksi BEI boundaries | ✔ PASS | ✔ PASS |
| 12 | LOCK arah floor SL / ceil TP | ✔ PASS | ✔ PASS |
| 13 | LOCK jendela 72 jam | ✔ PASS | ✔ PASS |
| 14 | LOCK lintas hari mengalahkan prioritas | ✔ PASS | ✔ PASS |

### 3.2 Anti-regresi (suite terkait, pasca-fix)

| Perintah | Hasil |
|---|---|
| `node --test test/audit-fase1-price-bugs.test.js test/idx-tick-normalization.test.js test/latest-price-resolver.test.js test/latest-price-resolver-bugs.test.js test/latest-price-resolver-wib-date-regression.test.js test/ara-arb-execution-reality.test.js test/trade-plan-v2.test.js test/candle-close-confirmation.test.js` | **95 PASS / 0 FAIL** |
| `node --test test/bandarmologi-stage1-intel-live-price-and-range.test.js test/user-watchlist-multisource-prices.test.js test/quote-candles-latest-price-consistency.test.js test/latent-aliases-radar-dead-code-cleanup.test.js` | **29 PASS / 0 FAIL** |
| `node --test test/trade-plan-v2-source-adapters.test.js test/trade-plan-v2-liquidity-sweep.test.js test/volume-breakout-revalidation.test.js` | **70 PASS / 0 FAIL** |
| `node --check` pada 2 file target + test baru | **SYNTAX OK** |

**Total verifikasi:** 14 + 95 + 29 + 70 = **208 assertion PASS, 0 FAIL**.

### 3.3 Registrasi build suite

Test baru didaftarkan di `tools/curated-build-tests.json` (baris 38), mengikuti konvensi commit `030ce7e0` ("register fase-1 tests").

---

## 4. OBSERVASI TANPA BUKTI FAIL (TIDAK DIAKUI SEBAGAI BUG)

Sesuai aturan "tanpa siklus FAIL → PASS, temuan tidak diakui", item berikut **tidak** diangkat sebagai bug, tetapi dicatat untuk transparansi:

1. **`is_fca` string `"true"` tidak dikenali sebagai FCA** (`getIdxTickSize` hanya menerima `=== true`). Tidak ada produsen di repo yang mengirim string (audit `findstr is_fca` seluruh `lib/`, `api/`, `tools/`: hanya boolean/nilai dari DB). Tidak dapat direproduksi dari alur produksi → observasi.
2. **`isFresh` dengan `maxAgeHours: 0` atau negatif jatuh ke default 72 jam.** Tidak ada pemanggil yang mengirim nilai tersebut (audit seluruh repo: hanya `test` dan `tools/run-top5-progress-monitor.js` yang tidak mengirim override). → observasi.
3. **ARB flat -15% untuk semua tier harga** (`getIdxAutoRejectBand`), sementara ARA bertingkat 35/25/20%. Lead lama F-069. Tanpa rujukan regulasi pembanding yang tersedia di repo dan tanpa kontrak internal yang dilanggar → observasi terbuka, bukan bug yang diakui.
4. **`resolveLatestPriceBulk` dengan baris mentah yang memiliki field `price`** (mis. baris DB ber-`price`): heuristik `hasSourceRows` memastikan baris DB tidak salah dibaca sebagai map pre-resolved. Perilaku diuji via BUG-FASE1-004b.
5. **`fetchFreshScreenerLatestPrice` fallback VPS mengembalikan `price_age_hours: 0`** meskipun `as_of_date` dari bridge bisa beda hari. Ini disengaja (harga live VWAP hari berjalan); tidak ada kontrak yang dilanggar → observasi.

---

## 5. HIPOTESIS YANG DITOLAK: BUG-FASE1-002

**Hipotesis awal:** pada hari WIB yang sama, baris dengan timestamp lebih baru (mis. swing 18:00 WIB) harus mengalahkan baris daytrade yang lebih lama (09:00 WIB) — dianggap "freshness inversion".

**Verifikasi silang (mengapa ditolak):**
- `test/latest-price-resolver.test.js` (test komitmen lama) mengunci eksplisit: *"prefers fresh daytrade latest over ... lower-priority sources"* untuk baris hari yang sama.
- Commit `030ce7e0` **sengaja** mengembalikan perbandingan timestamp (`at`) menjadi perbandingan hari-kalender WIB (`dKey`) — revert yang disengaja, bukan kecelakaan.
- Kesimpulan kontrak: **prioritas sumber dulu di dalam hari yang sama; tanggal dulu antar hari.** Test yang tadinya FAIL untuk hipotesis ini diubah menjadi *lock test* (002a/002b) agar kontrak tidak bergeser senyap.

**Status:** REJECTED HYPOTHESIS — tidak dihitung sebagai bug.

---

## 6. RINGKASAN AKHIR

| Metrik | Nilai |
|---|---|
| File diaudit | 2 |
| Baris dibaca penuh | 1371 |
| Fungsi dianalisis | 30+ |
| Lead historis diverifikasi | 6 (4 dikonfirmasi sudah benar/stale, 2 diperiksa ulang) |
| Hipotesis diuji via probe | 12 |
| **BUG terbukti (FAIL→PASS)** | **3** (dengan 5 sub-test) |
| Hipotesis ditolak | 1 |
| Observasi tanpa bukti fail | 5 |
| Test suite baru | 14 test, terdaftar di curated build |
| Total run verifikasi pasca-fix | 3× suite baru + 3× anti-regresi = **208 PASS / 0 FAIL** |

Semua temuan beserta bukti lengkap (test code, output FAIL otentik, diff perbaikan, output PASS 2×) terdokumentasi di `BUG_FINDINGS_FASE_1_23SEPT.md`.
