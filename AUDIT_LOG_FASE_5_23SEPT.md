# AUDIT LOG — FASE 5 (23 SEPT 2026)

**Subsystem:** Akumulasi Broker Historis · Broker Hunter · Konsentrasi Multi-Day (Top 1 / Top 3 / Top 5)
**Mode:** Forensic zero-trust audit · test-first verification
**Status:** SELESAI — 7 temuan dikonfirmasi, diperbaiki, dan diverifikasi PASS 2× berturut-turut

---

## 1. TARGET RESOLUTION PROTOCOL — Dependency Traversal Riil

Keempat file kandidat diverifikasi keberadaannya lebih dulu. Satu kandidat ternyata **tidak ada** sebagai file terpisah:

| # | Kandidat di brief | Hasil resolusi riil | Baris |
|---|---|---|---|
| 1 | `lib/broker-accumulation-service.js` | **TIDAK ADA.** Penangan akumulasi historis hidup di `lib/bandarmologi-service.js` (`normalizeBrokerAccumulation`, `synthesizeAccumulationFromSummary`, `aggregateBrokerSummaries`) + `lib/bandarmologi-intel-service.js` (`computeConcentrationRatios`, `getHunterTickerMap`) | 2.650 / 2.330 |
| 2 | `lib/broker-hunter-service.js` | **ADA.** Hanya penulis/pembaca index pre-agregat — tidak ada kalkulasi agregasi di sini | 595 |
| 2b | `lib/broker-hunter-engine.js` | **TIDAK ADA.** Mesinnya adalah `getHunterTickerMap()` di `bandarmologi-intel-service.js` | — |
| 3 | `lib/arjum-client.js` | **ADA.** `fetchBrokerAccumulation()` → `/api/broker-accumulation/{code}` | 640 |
| 4 | `lib/vps-data-fetcher.js` | **ADA.** `fetchBrokerHunterFromVpsSync`, `fetchBrokerAccumulationFromVpsSync` | 1.049 |

### Peta dependency (alur data nyata)

```
Arjum API  /api/broker-accumulation/{code}
      │
      ▼
arjum-client.fetchBrokerAccumulation()          ← cache disk broker-accumulation/<T>/series.json
      │
      ▼
vps-data-fetcher.fetchBrokerAccumulationFromVpsSync()   ← bridge HTTP → SSH fallback
      │
      ▼
bandarmologi-service.normalizeBrokerAccumulation()      ← status + skor akumulasi
bandarmologi-service.synthesizeAccumulationFromSummary() ← fallback dari broker_summary
      │
      ├──────────────► aggregateBrokerSummaries()  ── filterCalendarWindowDates()  ← jendela multi-day
      │                        │
      │                        └─► date_headers  →  tabel "Riwayat Harian"
      │
      ▼
bandarmologi-intel-service.computeConcentrationRatios()  ← CR3 / CR5 (Top 1/3/5)
      ▲
      │
getHunterTickerMap(range) ── data/broker-hunter-indexes/<BROKER>_<range>.json
      ▲
      │
broker-hunter-service.getBrokerHunterData() ── fast path baca index (git-tracked → cache VPS)
                                    └─ fallback: fetchBrokerHunterFromVpsSync()
```

**Kesimpulan mapping:** permukaan serang konsentrasi multi-day ada di **dua** modul (`bandarmologi-service.js` untuk agregasi hari, `bandarmologi-intel-service.js` untuk rasio konsentrasi), bukan di `broker-hunter-service.js` yang hanya berperan sebagai penyimpan index.

---

## 2. HIPOTESIS AWAL & HASIL VERIFIKASI

Semua status lama dianggap HIPOTESIS MENTAH. Setiap hipotesis diuji lewat probe eksekusi nyata (`scratch/fase5-probe.js` … `fase5-probe6.js`) sebelum dijadikan temuan.

| # | Hipotesis | Hasil probe | Verdict |
|---|---|---|---|
| H1 | `getHunterTickerMap` mengalikan jendela base dengan konstanta (5/7, 14/7, 2.0) | `scale = 5/7` ✅, `14/7` ✅, `2.0` ✅ ada di sumber. Terukur: 5d = **0,714286×** dari 7d; 14d = **2,000000×** dari 7d | **BUG — F5-01** |
| H1b | `target_dates` diganti jendela kalender sintetis saat lebih pendek | Fallback `getDynamicTradingDays(targetDayCount)` mengiklankan jendela yang datanya tidak ada | **BUG — F5-01b** |
| H2 | Tanggal duplikat diagregasi dua kali | `filterCalendarWindowDates(['09-22','09-22','09-19'],3)` → `["09-22","09-22","09-19"]`. `aggregateBrokerSummaries` net_flow **23 M** vs **13 M** yang benar | **BUG — F5-02** |
| H3 | `date_headers` ditimpa deret 24 hari | Dikonfirmasi di jalur produksi: label `"5 Hari Bursa"` dengan **24** `date_headers`. Guard `length < 24 → timpa` | **BUG — F5-03** |
| H4 | Payload tanpa series dilabeli DISTRIBUTION | `normalizeBrokerAccumulation({series:[]})` → `status = "DISTRIBUTION"`; payload `null` → `status` **undefined** | **BUG — F5-04** |
| H5 | Feed ribuan `"1.500.000.000"` merusak CR3/CR5 | `top_3_val = NaN`, `cr_basis = undefined`, `reason = TURNOVER_UNAVAILABLE` padahal feed lengkap | **BUG — F5-05** |
| H5b | CR5 tidak bisa "melihat" 5 broker | `buyers` diambil dari `top_buyers` (Top-3). CR5 ≡ CR3 secara matematis | **BUG — F5-05b** |
| H6 | Saham churning skor akumulasi semu | Churn net-0 5 hari → `status: ACCUMULATION`, `score: 40` | **BUG — F5-06** |
| H7 | Non-atomic write pada snapshot multi-day | `fetchBrokerHunterFromVpsSync` & `fetchBrokerAccumulationFromVpsSync` memakai `fs.writeFileSync` langsung ke path hidup | **BUG — F5-07** |

**Tidak ditemukan** (hipotesis gugur, dicatat sebagai bukti audit bersih):
- Tidak ada celah *off-by-one* pada `filterCalendarWindowDates` (slice `days` sudah benar sejak Batch 3).
- Tidak ada penumpukan ganda intraday vs EOD: `listDiskDates` memfilter `latest.json` keluar dari daftar tanggal, dan penulisan tanggal berformat `YYYY-MM-DD.json` bersifat idempoten.
- Data akhir pekan/hari libur sudah ditangani `idx-trading-calendar` (`isTradingDay`, `previousTradingDay`).

---

## 3. TEMUAN & PERBAIKAN (ringkas — detail diff di `BUG_FINDINGS_FASE_5_23SEPT.md`)

| ID | Modul | Baris sebelum | Perbaikan |
|---|---|---|---|
| **F5-01** | `bandarmologi-intel-service.js` | 163–191 | Hapus total `scale` (5/7, 14/7, 2.0). Baca tiap range dari index-nya sendiri; bila index range tidak ada, pakai range terdekat yang **nyata ada** (tanpa rescaling) dan ekspos `data_range` + `range_is_exact` |
| **F5-01b** | `bandarmologi-intel-service.js` | 283–285 | Hapus fallback `getDynamicTradingDays` yang mengganti `target_dates` pendek dengan jendela sintetis |
| **F5-02** | `bandarmologi-service.js` | 1494–1527, 1529–1533 | De-duplikasi tanggal (via `Set`) di `filterCalendarWindowDates` **dan** di cabang `isCustomRange` yang sebelumnya melewati filter |
| **F5-03** | `bandarmologi-service.js` | 2201–2208 | Guard `length < 24 → timpa` menjadi `length === 0 → fallback`, sehingga jendela pendek yang sah tidak ditimpa |
| **F5-04** | `bandarmologi-service.js` | 1178–1199, 1203, 1259–1271, 1334–1343 | Status diturunkan dari data nyata; `null`/kosong → `NO_DATA`; status per-hari diisi dari `net_val` |
| **F5-05** | `bandarmologi-intel-service.js` | 1211–1240 | Helper `toFeedNumber()` (mirror `toNumberLoose`) dipakai untuk **semua** magnitudo & denominator |
| **F5-05b** | `bandarmologi-intel-service.js` | 1204–1206 | Ranking Top-5 diperluas dari `gross_buyers`, **hanya** untuk broker dengan net > 0 (churn/net-seller dikecualikan — menjaga AUDIT-F4-13) |
| **F5-06** | `bandarmologi-service.js` | 1178–1199 | Deteksi churn (`absNetFlow < grossVal × 1%`) → skor `null`, status `NEUTRAL`, flag `is_churn` |
| **F5-07** | `vps-data-fetcher.js` | 198–239 + 7 titik tulis | Helper `atomicWriteJsonSync()` (temp file → `fsync` → `renameSync`) menggantikan seluruh `writeFileSync` pada jalur snapshot |

### Prinsip perbaikan
Setiap perubahan bersifat **minimal diff** dan tidak melakukan refactoring liar. Tidak ada API publik yang dihapus; penambahan bersifat aditif (`data_range`, `range_is_exact`, `is_churn`, `__atomicWriteJsonSync`).

---

## 4. METRIK VERIFIKASI

### 4.1 Bukti GAGAL sebelum perbaikan (test-first)

```
✖ F5-01   hunter index reader must not scale a base window by a fractional multiplier
✖ F5-01b  hunter index reader never invents a target_dates window it does not have
✖ F5-02   filterCalendarWindowDates must return each session at most once
✖ F5-02b  aggregateBrokerSummaries must not double-count a repeated date
✖ F5-04   an accumulation payload without a series must not be labelled DISTRIBUTION
✖ F5-04b  a real distribution series is still labelled DISTRIBUTION
✖ F5-05   concentration ratios must sanitise thousand-separated feed values
✖ F5-05b  comma-decimal and plain-string feed forms parse identically
✖ F5-06   a pure churn book must be flagged instead of scoring as accumulation
✖ F5-07   broker hunter index writes must not be torn by a concurrent reader
✖ F5-07b  the accumulation series snapshot is also published atomically

ℹ tests 14   ℹ pass 3   ℹ fail 11
```

Bukti mentah: `scratch/fase5-fail-evidence.txt`

### 4.2 Bukti LULUS 2× berturut-turut (setelah perbaikan)

| Run | Perintah | Hasil |
|---|---|---|
| **Run 1** | `node --test test/audit-fase5-accumulation-bugs.test.js` | **15 pass / 0 fail** |
| **Run 2** | `node --test test/audit-fase5-accumulation-bugs.test.js` | **15 pass / 0 fail** |

Bukti mentah: `scratch/fase5-final-run1.txt`, `scratch/fase5-final-run2.txt`

### 4.3 Seluruh test suite repo tetap hijau

```
node tools/run-build-test-suite.js --full
→ All 522 test files passed successfully!
```

Bukti mentah: `scratch/fase5-full-suite.txt`

### 4.4 Regresi yang terdeteksi & diselesaikan selama siklus

Perbaikan awal sempat memecah 4 suite lama. Seluruhnya didiagnosis dan diselesaikan **tanpa melonggarkan kontrak** — perbaikannya adalah menyempurnakan logika, bukan menurunkan asersi:

| Suite | Penyebab | Penyelesaian |
|---|---|---|
| `audit-batch1-integrity.test.js` (T2b) | `catch (_) {}` kosong di helper atomik baru | Ganti dengan `logFetchFailure` eksplisit |
| `bandarmologi-intel.test.js` (S4MASSIVE) | Ranking Top-5 mengubah urutan Top-3 | Top-3 dipertahankan sesuai urutan feed; hanya rank 4–5 yang diisi |
| `audit-fase4-broksum-bugs.test.js` (CROSSTRD) | Broker churn net-0 ikut masuk ranking | Filter `rowNet > 0` wajib — churn dikecualikan |
| `bandarmologi-cr3-realistic-market-turnover.test.js` | Range 14d kehilangan sumber data | Degradasi jujur ke range terdekat (tanpa scaling) |

---

## 5. REGISTRASI TEST

`test/audit-fase5-accumulation-bugs.test.js` didaftarkan sebagai entri pertama di `tools/curated-build-tests.json`, sehingga ikut dalam build gate (`npm run build` / `npm test`).

---

## 6. CATATAN KONSISTENSI SKOR AKUMULASI (checklist #4)

Checklist meminta kepastian bahwa klasifikasi skor akumulasi multi-day **sinkron dengan screener swing/daytrade**.

Temuan F5-06 adalah inti dari poin ini: sebelumnya saham dengan perpindahan barang semu (*churning* multi-day) menghasilkan `status: ACCUMULATION` dan skor positif (terukur: **40** pada churn net-0 5 hari). Setelah perbaikan:

- `status` churn → `NEUTRAL`
- `accumulation_score` → `null` (tidak ada angka semu yang bisa dikonsumsi screener)
- flag eksplisit `is_churn: true` tersedia untuk konsumen downstream

Konsumen skor (`public/bandarmologi-runtime.js`, `lib/bandarmologi-screener-scoring.js`) membaca `accumulation_score` secara defensif; nilai `null` sudah ditangani sebagai "tidak tersedia" alih-alih angka rendah. Tidak ada perubahan kontrak yang diperlukan di sisi konsumen.

**Rekomendasi lanjutan (di luar scope perbaikan ini):** pertimbangkan menyalurkan flag `is_churn` ke gate screener swing/daytrade sebagai penalti eksplisit, bukan sekadar `null` pada skor. Ini memerlukan keputusan produk karena mengubah ambang seleksi.

---

## 7. RINGKASAN ARTEFAK

| Artefak | Isi |
|---|---|
| `test/audit-fase5-accumulation-bugs.test.js` | 15 test (7 temuan + kontrak positif) |
| `tools/curated-build-tests.json` | Registrasi test baru |
| `lib/bandarmologi-intel-service.js` | Perbaikan F5-01, F5-01b, F5-05, F5-05b |
| `lib/bandarmologi-service.js` | Perbaikan F5-02, F5-03, F5-04, F5-06 |
| `lib/vps-data-fetcher.js` | Perbaikan F5-07 |
| `scratch/fase5-*.txt` | Bukti mentah FAIL / PASS / full suite / diff |
| `BUG_FINDINGS_FASE_5_23SEPT.md` | Detail diff, kode test, output FAIL & PASS |


---

# ADDENDUM — BATCH 3 (FASE 5: POSITION SIZING CALCULATOR)

**Branch:** `fix/batch-3-money-mgmt-cache-fase4-5-6`
**Target file:** `public/position-sizing-calculator.js`
**Suite:** `test/audit-fase5-position-sizing-bugs.test.js` (6 test)

> **Scope note.** The body of this document above audits historical broker
> accumulation / broker hunter / multi-day concentration. Batch 3 re-audits the
> **Position Sizing Calculator** because the task brief named
> `public/position-sizing-calculator.js`.

## Temuan Batch 3

| ID | Severity | Defect | Evidence |
|---|---|---|---|
| F5-B3-01 | HIGH | `sanitizeNumber("-Rp 10.000")` returned **-10**, not -10000 | prefix regex excluded "-", so the thousand-group heuristic failed |
| F5-B3-02 | MEDIUM | `sanitizeNumber("1e400")` returned **1400** | "e" deleted instead of rejected; overflow became plausible |
| F5-B3-03 | MEDIUM | `calculate()` accepted `riskPct: 500` verbatim | `saveSettings` clamps to 0.1–10%, `calculate` did not |
| F5-B3-04 | HIGH | `capital: 1e308` produced `lots: 2e302` and `profitTp1Idr: Infinity` while `isValid: true` | unbounded capital overflowed the arithmetic |

## Perbaikan (minimal diff)

1. **Prefix strip before the separator heuristic.** The sign/currency prefix is
   now removed first and the sign reapplied at the end, so a negative
   thousand-separated amount keeps its magnitude.
2. **Exponential notation is rejected.** `1e400` / `1e3` fall back instead of
   being re-read as digit strings.
3. **One risk band.** `MIN_RISK_PCT = 0.1` / `MAX_RISK_PCT = 10` are now
   enforced in `calculate()` exactly as `saveSettings()` already did.
4. **Bounded capital.** `MIN_CAPITAL_IDR = 100000` / `MAX_CAPITAL_IDR = 1e15`
   are clamped in `calculate()`, so no output field can reach Infinity.
   Both bounds are exported for callers and tests.

## Verifikasi

| Tahap | Hasil |
|---|---|
| FAIL pra-perbaikan | 4 test GAGAL (F5-B3-01..04) |
| PASS pasca-perbaikan | **6/6 PASS** |
| Regresi terkait | **111/111 PASS** (position sizing, F7 frontend, F11) |

## Kontrak yang dikunci

* 1 lot = **100 lembar**; lot dibulatkan ke bawah (`floor`), tidak pernah ke atas,
  sehingga risiko aktual tidak pernah melampaui budget.
* Setiap field numerik hasil yang valid wajib **finite** — diuji lewat sweep
  input bermusuhan (1e308, Infinity, NaN, negatif, notasi ilmiah, string lokal).
* `actualRiskIdr <= capital x riskPct/100` dan `positionValue <= capital`
  ditegakkan sebagai assertion.
