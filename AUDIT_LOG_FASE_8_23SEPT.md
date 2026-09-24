# AUDIT LOG — FASE 8 (23 SEPTEMBER)

**Subsystem:** Swing Screener Engine, Non-Konglo Filtering Logic, & Multi-Day Swing Watchlist
**Metodologi:** Zero-Trust Forensic Audit — dependency mapping riil via traversal kode, pembacaan baris-per-baris, pembuktian bug lewat reproduksi empiris, lalu verifikasi *test-first* (FAIL dulu → perbaiki → PASS 2×).
**Mode:** Autonomous run, tanpa jeda interaktif.
**Status akhir:** 8 temuan (7 bug + 1 sub-temuan), 29 test baru, **29/29 PASS** (2× berturut-turut), full repo suite **All 525 test files passed successfully!**

---

## 1. RINGKASAN EKSEKUTIF

Fase 8 mengaudit jalur **Swing Screener** (Konglo & Non-Konglo) beserta **multi-day swing watchlist**. Dua temuan bersifat **CRITICAL**: keduanya adalah **tautologi matematika** yang membuat kelas sinyal tertentu mustahil terpicu — pola yang sama dengan BUG-F7-01 (Fase 7), tetapi terjadi di jalur Swing, bukan Day Trade.

| ID | Severity | Judul ringkas | File utama |
|---|---|---|---|
| BUG-F8-01 | 🔴 CRITICAL | Tautologi `support` — `_belowSupport` tak pernah `true` (breakdown buta) | `api/sector-hot.js` |
| BUG-F8-02 | 🔴 CRITICAL | Tautologi `resistance` — `BREAKOUT_CONFIRMED` mustahil terpicu | `api/sector-hot.js` |
| BUG-F8-03 | 🟠 HIGH | Window NK 60 hari → MA50 selalu `null` → 100% gagal gate "Di bawah MA50" | `api/sector-hot.js` |
| BUG-F8-04 | 🟡 MEDIUM | `is_fca='false'` (string) dibaca sebagai FCA → +30 penalti risiko palsu | `lib/idx-tick-normalization.js` |
| BUG-F8-05 | 🟡 MEDIUM | `ticker`/`board` tidak diteruskan ke normalisasi tick → level off-tick untuk FCA | `api/sector-hot.js` |
| BUG-F8-06 | 🟠 HIGH | `select('calculated_at')` pada `swing_screener_non_konglo_latest` (kolom tak ada) | `api/sector-hot.js`, `lib/user-watchlist-service.js` |
| BUG-F8-07 | 🟠 HIGH | `select('run_date')` pada `swing_screener_meta` (kolom tak ada) | `api/sector-hot.js` |
| BUG-F8-08 | 🟡 MEDIUM | `select('last_staging_write_count')` — kolom tak ada di skema mana pun | `api/sector-hot.js` |

**Dampak bisnis terbesar:** sebelum perbaikan, dua kategori sinyal Swing **secara struktural tidak mungkin lolos**:
1. Semua saham yang benar-benar **breakout** (BUG-F8-02) → selalu jatuh ke `BREAKOUT_WATCH`.
2. Semua saham yang benar-benar **breakdown** (BUG-F8-01) → tidak pernah diberi penalti `-15` maupun diblokir dari "Swing Ready".

---

## 2. DEPENDENCY MAPPING RIIL (TRAVERSAL KODE)

Target file pada brief **tidak seluruhnya ada**. Pemetaan dilakukan via traversal `require()` + grep seluruh repo, bukan asumsi.

### 2.1 Yang ADA di repo

| Target brief | Status | Path riil |
|---|---|---|
| `lib/swing-screener-engine.js` | ✅ ADA | `lib/swing-screener-engine.js` (303 baris) — penalty engine, R:R gate, edge tagging |
| `lib/swing-screener-service.js` | ❌ **TIDAK ADA** | — |
| `api/swing-screener.js` | ❌ **TIDAK ADA** | Logika swing tinggal di **monolit** `api/sector-hot.js` (15.128 baris) |
| `api/sector-hot.js` | ✅ ADA | Host seluruh endpoint swing |
| `lib/konglo-filter.js` | ❌ **TIDAK ADA** | Klasifikasi konglo berbasis **tabel Supabase**, bukan file konstanta |
| `lib/non-konglo-whitelist.js` | ❌ **TIDAK ADA** | Non-Konglo dihitung sebagai **komplemen** Konglo |
| `supabase/swing-screener-migration.sql` | ✅ ADA | Skema `swing_screener_latest` + `swing_screener_meta` |
| `supabase/swing-screener-non-konglo.sql` | ✅ ADA | Skema `_staging`, `_jobs`, `_latest`, `_meta` |

> **Temuan arsitektur:** tidak ada `lib/konglo-filter.js` maupun whitelist Non-Konglo. Pemetaan grup konglomerasi sepenuhnya **data-driven** dari tabel `sector_hot_groups` + `sector_hot_group_members` (seed di `supabase/patch-sector-hot-group-mapping-v2.sql`), dan klasifikasi Non-Konglo adalah **set difference**: `stock_boards` MINUS `sector_hot_group_members`.

### 2.2 Graf dependency riil (Swing)

```
api/sector-hot.js  (monolit, host endpoint)
├── lib/swing-screener-engine.js        ← penalty engine, R:R gate 1.8x, edge tagging
│   ├── lib/candle-pattern-engine.js
│   ├── lib/chart-engine/indicators.js  ← classifySwingTrend (EMA20/EMA50 + pivot)
│   ├── lib/market-regime.js            ← threshold adaptif
│   └── lib/bandarmologi-service.js     ← confluence gate
├── lib/swing-nk-rr-warning.js          ← warning R:R tinggi (Non-Konglo only)
├── lib/idx-tick-normalization.js       ← tick IDX, FCA, risk label, MTF context
│   └── lib/screener-config.js          ← MIN_RR 1.5, breakout vol 1.2x
├── lib/daytrade-screener-engine.js     ← refineLevelsWithRespectZones(), universe builder
├── lib/corporate-action-price-scale-guard.js  ← integrasi Fase 5
├── lib/user-watchlist-service.js       ← multi-day watchlist read path
├── lib/trade-plan-v2-integration.js
└── lib/fibonacci-confluence.js

Data layer (Supabase / PostgREST):
├── sector_hot_groups / sector_hot_group_members   ← definisi KONGLO (sumber kebenaran)
├── stock_boards (UTAMA, PENGEMBANGAN)             ← universe resmi BEI
├── foreign_watchlist_daily                        ← diagnostics-only (tidak masuk universe)
├── swing_screener_latest / _meta                  ← Konglo
└── swing_screener_non_konglo_latest/_staging/_jobs/_meta  ← Non-Konglo
```

### 2.3 Alur gating Swing (terverifikasi baris-per-baris)

**Konglo** (`handleScreenerRefresh` ≈ baris 653+):
1. Universe = `sector_hot_group_members WHERE is_active = true` (dedup per ticker, grup pertama menang).
2. Fetch candle Yahoo `range=90d` → **wajib ≥ 55 bar**, jika kurang → `HISTORY_INSUFFICIENT`, dibuang.
3. `calculateIndicators()` → MA20/MA50/RSI14/support/resistance/ATR14.
4. `dtEngine.refineLevelsWithRespectZones(..., 'konglo')` → R:R min **1.5**.
5. `idxTick.normalizeLevelsToIdxTicks()` → snap ke fraksi tick IDX.
6. `scoreAndClassify()` → base 50, bonus/penalti, gate "Swing Ready".
7. Upsert `swing_screener_latest` batch 50, `onConflict: 'ticker'`.

**Non-Konglo** (`handleNkScreenerStart` / `Batch` / `Finalize`):
1. `excludedTickers` = semua `sector_hot_group_members.is_active = true`.
2. Universe = `stock_boards WHERE board IN (UTAMA, PENGEMBANGAN)` **MINUS** `excludedTickers`.
3. Batch 8/25/50 → `swing_screener_non_konglo_jobs`.
4. Per ticker: `fetchNkQuoteData()` → **≥ 20 bar**; `applyNkHardFilters()` (harga > 50, traded ≥ 15/20d, nilai transaksi ≥ Rp10 M, R:R ≥ 1.5, vol ratio ≥ 0.7).
5. `calculateNkSetupScore()` → base 50, gate "Swing Ready" skor ≥ 75.
6. Staging (`onConflict: 'run_date,ticker'`) → Finalize → `swing_screener_non_konglo_latest`.

---

## 3. ANALISIS GATING & MATEMATIKA SWING

### 3.1 Kriteria penentu Swing — temuan

| Aspek | Kondisi SEBELUM perbaikan | Verdict |
|---|---|---|
| MA20 / MA50 | Dihitung dari window Yahoo. Konglo `range=90d` (≈64 bar) → MA50 OK. **Non-Konglo `60 hari` (≈42 bar) → MA50 SELALU `null`** | 🔴 BUG-F8-03 |
| Swing High/Low | `support = min(low[-20:])` & `resistance = max(high[-20:])` — **memasukkan bar berjalan** | 🔴 BUG-F8-01/02 |
| Missing history | Konglo < 55 bar → dibuang dengan alasan `HISTORY_INSUFFICIENT` (benar). Non-Konglo < 20 bar → di-skip (benar). **Tidak ada unhandled rejection / NaN.** | ✅ Aman |
| IPO < 1 tahun | Masuk universe jika ada di `stock_boards`; di Konglo hanya jika punya mapping afiliasi aktif (tidak ditebak). | ✅ Sesuai desain |
| Suspensi panjang | Bar kosong dibuang oleh `parseNkValidDays`/`fetchScreenerCandles`; jika total < ambang → kandidat di-skip, bukan NaN. | ✅ Aman |

### 3.2 Evaluasi ambang Stop Loss

- **Konglo**: SL = `max(primarySupport × 0.985, entryMid × 0.95)`, lalu ATR-guard 1.5×ATR, lantai akhir `entryMid × 0.95` (maks 5% dari entry). → **Tidak terlalu sempit** untuk time frame harian, dan lantai 5% menjauhkannya dari noise tick.
- **Non-Konglo**: SL = `support × 0.96` (rebound) / `entryLow × 0.95` (pullback) / `resistance × 0.95` (breakout), lantai akhir `entryMid × 0.95`.
- **Fraksi tick BEI**: setelah `normalizeLevelsToIdxTicks`, semua level di-snap ke grid sah. **Namun** sebelum BUG-F8-05 diperbaiki, nama **FCA/Akselerasi** (tick Rp1) di-snap ke grid Rp5/Rp10 karena `ticker`/`board` tidak diteruskan → level **off-tick** yang bisa ditolak broker.

### 3.3 Aturan filter Konglo / Non-Konglo — evaluasi false-positive

Pemetaan grup diverifikasi dari `supabase/patch-sector-hot-group-mapping-v2.sql`:

| Grup | Anggota terverifikasi |
|---|---|
| BAKRIE_CORE | BNBR, BUMI, BRMS, ENRG, DEWA, ELTY, UNSP, VIVA, MDIA, BTEL, VKTR |
| BARITO_PRAJOGO_CORE | BRPT, BREN, TPIA, CUAN, PTRO, CDIA |
| SALIM_CORE | INDF, ICBP, SIMP, LSIP, IMAS, IMJS, DNET, BINA |
| MNC_HARY_TANOE_CORE | BHIT, BMTR, MNCN, MSIN, IPTV, MSKY, KPIG, BCAP, BABP, IATA |

**Temuan penting — risiko yang berhasil DIMITIGASI (bukan bug baru):**

1. **Ticker case-sensitivity** — `handleNkScreenerStart` membangun `excludedTickers` dari `sector_hot_group_members.ticker` **tanpa** `.toUpperCase()`, lalu membandingkan dengan `stock_boards.ticker` yang di-uppercase oleh `tools/sync-stock-boards-from-bei-xlsx.py` (`value.strip().upper()`). **Audit menyimpulkan ini AMAN** karena seed SQL dan writer `sector_hot_group_members` konsisten menyimpan uppercase; tidak ditemukan jalur penulisan lowercase. Dicatat sebagai *latent risk* (bukan bug terbukti) — akan menjadi bug jika ada writer baru yang menyimpan lowercase.
2. **Ticker lintas-grup** (mis. `BUMI` di `BAKRIE_CORE` **dan** `SALIM_AFFILIATE_INVESTEE`) — **tidak** menimbulkan false-positive Non-Konglo karena himpunan dibangun sebagai `Set` dari **semua** baris aktif; duplikasi tidak berpengaruh.
3. **Grup tanpa anggota aktif** (mis. hanya emiten delisted seperti FREN) — kode menghapus baris stale dari `sector_hot_latest`/`sector_hot_members_latest` dan `continue`. Benar.
4. **`buildBoardValidatedIpoDiagnostics`** — dinormalisasi via `normalizeForeignTicker` (uppercase + strip `.JK` + regex `^[A-Z0-9]{2,12}$`) dan **diagnostics-only**; tidak pernah menebak afiliasi. Benar.

**Kesimpulan:** tidak ditemukan false-positive "saham non-konglo terblokir" maupun false-negative "emiten konglo lolos" yang disebabkan perbedaan penulisan kode/nama. Yang ditemukan adalah **tiga** masalah integritas skema/data (BUG-F8-06/07/08) dan **dua** tautologi matematika (BUG-F8-01/02).

---

## 4. SINKRONISASI SKEMA DB (TEMUAN BUG-FASE1-001)

Diterapkan ulang pola BUG-FASE1-001: setiap `select()` PostgREST dicocokkan dengan kolom nyata di `supabase/*.sql`. Hasil cross-check otomatis (`tmp_investigasi/f8-schema-crosscheck.js`):

| Tabel | Kolom di-`select()` | Ada di SQL? | Verdict |
|---|---|---|---|
| `swing_screener_non_konglo_latest` | `calculated_at` | ❌ **TIDAK** (hanya `published_at`, `run_date`) | 🔴 BUG-F8-06 |
| `swing_screener_meta` | `run_date` | ❌ **TIDAK** | 🔴 BUG-F8-07 |
| `swing_screener_non_konglo_meta` | `last_staging_write_count` | ❌ **TIDAK** (di mana pun) | 🔴 BUG-F8-08 |
| `stock_boards` | `ticker, board` | ⚠️ tidak ada di `supabase/` — **pre-existing table** | ✅ Bukan bug |

> **Catatan penting soal kolom `order`:** brief menyebut `order` (`published_at` vs `calculated_at`). Audit menemukan bahwa `swing_screener_non_konglo_latest` **memang** memakai `published_at` sebagai kolom recency (benar), sedangkan kode **salah** men-`select` `calculated_at`. Untuk `swing_screener_meta`, kolom recency sah adalah `calculated_at`/`updated_at` — **bukan** `run_date`.

**Efek sebelum perbaikan:** PostgREST menolak **seluruh** query dengan error `column ... does not exist`. Karena pemanggil membungkusnya dalam `try/catch` atau memakai `maybeSingle()`, kegagalan **tersenyum** (silent) — data harga Non-Konglo untuk watchlist tidak pernah terisi, dan meta Swing Konglo selalu jatuh ke fallback sintetis.

---

## 5. INTEGRASI TEMUAN FASE SEBELUMNYA

| Fase | Temuan | Status integrasi di jalur Swing |
|---|---|---|
| **Fase 5** | Scaling sintetis / corporate action | ✅ `corporateActionGuard.applyCorporateActionPriceScaleGuard()` dipanggil di **13 titik**, termasuk `swing_screener_latest` (baris 2733) dan `swing_screener_non_konglo_latest` (baris 2742). Regression test PASS. |
| **Fase 4** | Wash-sale / R:R tinggi | ✅ `lib/swing-nk-rr-warning.js` — threshold 2.5x, **informational only**, tidak memfilter. Regression test PASS. |
| **Fase 7** | BUG-F7-04 — `is_fca` string | ⚠️ Diperbaiki untuk **tick sizing** (`isAkselerasiOrFca`), tetapi **BELUM** untuk `calculateRiskLabel` yang masih memakai truthiness mentah → **BUG-F8-04** (perbaikan Fase 8). |
| **Fase 1** | BUG-FASE1-001 — mismatch kolom PostgREST | ⚠️ Diterapkan ulang; ditemukan **3 mismatch baru** (BUG-F8-06/07/08). |

### 5.1 Handling status FCA — boolean vs string `'true'`

Audit menemukan **inkonsistensi** yang persis diprediksi brief:

| Lokasi | Sebelum | Sesudah |
|---|---|---|
| `getIdxTickSize()` via `isAkselerasiOrFca()` | ✅ sudah pakai `isExplicitTrueFlag` | ✅ tetap |
| `calculateRiskLabel()` baris 787 | ❌ `p.is_fca` (truthiness mentah) | ✅ `isExplicitTrueFlag(p.is_fca)` |
| `normalizeLevelsToIdxTicks()` | ❌ tanpa `ticker`/`board` | ✅ menerima `ticker` + `board` |

Bukti empiris sebelum perbaikan:
```
is_fca='false' -> notes: ["FCA/Pemantauan Khusus"] score 30   ← SALAH
is_fca='true'  -> notes: ["FCA/Pemantauan Khusus"] score 30
is_fca=false   -> notes: ["Tidak ada faktor risiko signifikan"] score 0
```

---

## 6. METRIK VERIFIKASI

### 6.1 Bukti tautologi (reproduksi empiris, 20.000 trial acak)

```
################ D. PROOF: support <= lastClose ALWAYS ################
random OHLC trials    = 20000
cases close < support = 0        ← tautologi TERBUKTI (breakdown tak terdeteksi)

################ C. PROOF: close > resistance ################
trials = 20000 | cases close > resistance = 0
=> TAUTOLOGY CONFIRMED: BREAKOUT_CONFIRMED unreachable for Swing Konglo.

# Setelah resistance mengecualikan bar berjalan:
resistance (excl today) = 1000 | close > res ? true
deriveBreakoutConfirmation => BREAKOUT_CONFIRMED | Breakout Confirmed   ← terpicu
```

### 6.2 Bukti BUG-F8-03 (MA50 Non-Konglo)

```
60 calendar days -> ~42 trading bars (before IDX holidays)
90 calendar days -> ~64 trading bars
nkCalcMA(42 bars, 50) = null
hard-filter expression : !(q.ma50 && q.lastPrice >= q.ma50)
  evaluated            = true
  => hard fail "Di bawah MA50" fires for EVERY candidate? true
```

### 6.3 Bukti BUG-F8-05 (tick FCA)

```
normalizeLevelsToIdxTicks WITHOUT ticker -> entry_low = 302   ← off-tick untuk LUCK (FCA, tick Rp1)
normalizeLevelsToIdxTicks WITH ticker    -> entry_low = 301   ← benar
```

### 6.4 Hasil test

| Tahap | Hasil |
|---|---|
| Baseline (sebelum fix) | **17 FAIL / 12 PASS** dari 29 test |
| PASS run #1 | **29 / 29 PASS**, 0 fail |
| PASS run #2 (berturut-turut) | **29 / 29 PASS**, 0 fail |
| Regresi swing terarah (12 file) | **151 / 151 PASS**, 0 fail |
| Full repo suite (`--full`, 525 file) | **All 525 test files passed successfully!** |

### 6.5 Registrasi test

`test/audit-fase8-swing-screener-bugs.test.js` didaftarkan di `tools/curated-build-tests.json` (index 0; total 525 entri). Gate integritas Batch 17 (`validate-full-syntax.js`) memverifikasi tidak ada test tak-terdaftar.

---

## 7. DIFF RINGKAS (MINIMAL, TANPA REFACTORING LIAR)

| # | File | Baris | Perubahan |
|---|---|---|---|
| 1 | `api/sector-hot.js` | ~1590 | `support`/`resistance` memakai window **sebelum** bar berjalan (`slice(-21, -1)`) |
| 2 | `api/sector-hot.js` | ~10993 | NK `support`/`resistance` memakai `srWindow` (prior bars) |
| 3 | `api/sector-hot.js` | ~10931 | Window NK `60 → 120 hari` |
| 4 | `api/sector-hot.js` | ~11588 | Gate MA50 fail-closed hanya bila MA50 **diketahui** & harga di bawahnya |
| 5 | `api/sector-hot.js` | ~744 | Teruskan `ticker` + `board` ke normalisasi tick (Konglo) |
| 6 | `api/sector-hot.js` | ~10236 | Teruskan `ticker` + `board` ke normalisasi tick (Non-Konglo) |
| 7 | `api/sector-hot.js` | ~6991 / ~7003 | `calculated_at` → `published_at` (2 lokasi) |
| 8 | `api/sector-hot.js` | ~14562 | Hapus `run_date` dari `select` `swing_screener_meta` |
| 9 | `api/sector-hot.js` | ~9890 | Turunkan `last_staging_write_count` dari job counters |
| 10 | `api/sector-hot.js` | ~14969 | Ekspor `calculateIndicators`, `nkCalcMA`, `applyNkHardFilters` untuk testability |
| 11 | `lib/idx-tick-normalization.js` | ~787 | `isExplicitTrueFlag(p.is_fca)` di `calculateRiskLabel` |
| 12 | `lib/idx-tick-normalization.js` | ~1176 | Ekspor `isExplicitTrueFlag` |
| 13 | `lib/user-watchlist-service.js` | ~81 | `calculated_at` → `published_at` |

Tidak ada perubahan pada: skema SQL, threshold skor, logika R:R, struktur tabel, atau perilaku publik endpoint.

---

## 8. REKOMENDASI LANJUTAN (NON-BLOCKING)

1. **Latent risk — normalisasi ticker.** `handleNkScreenerStart` sebaiknya meng-uppercase `m.ticker` saat membangun `excludedTickers` agar tahan terhadap writer baru yang menyimpan lowercase. Belum diperbaiki karena belum ada jalur penulisan yang melanggar; mengubahnya kini adalah *hardening*, bukan perbaikan bug.
2. **Konsolidasi skema.** `last_staging_write_count` masih dikembalikan di payload API sebagai diagnostics tetapi kini dihitung in-memory. Jika nilainya ingin dipersistensikan lintas-run, perlu migrasi `ALTER TABLE` eksplisit.
3. **Uji tautologi sebagai kelas.** Pola "window memuat bar berjalan" muncul di Fase 7 (Day Trade) **dan** Fase 8 (Swing). Disarankan menambahkan lint test generik yang menandai setiap `slice(-N)` yang dipakai untuk menghitung level resistance/support.

---

## 9. ADDENDUM BATCH 4 (24 SEPTEMBER 2026) — RESIDUAL DEFECT CLASS

> **Mengapa addendum ini ada.** Batch 4 mengaudit ulang jalur Sector Hot & Reversal Breakout
> Lifecycle setelah Fase 8 dinyatakan selesai. Fase 8 menyasar tautologi *window indikator*
> (`support`/`resistance`), window data Non-Konglo, parsing FCA, dan mismatch kolom PostgREST.
> Audit ulang menemukan kelas cacat **berbeda** yang tidak tersentuh: **state machine
> lifecycle** dan **integritas agregasi/payload**.

### 9.1 Nama berkas test — ketidaksesuaian dokumen

| Sumber | Nama berkas |
|---|---|
| Brief Batch 4 | `test/audit-fase8-sector-breakout-bugs.test.js` |
| Dokumen Fase 8 (asli) | `test/audit-fase8-swing-screener-bugs.test.js` |

**Keduanya valid dan keduanya dipertahankan.** Suite Fase 8 asli (29 test) tetap menjaga
blocker awal. Suite Batch 4 (24 test) adalah **lapisan tambahan** untuk kelas cacat di bawah.

### 9.2 Temuan residual & perbaikannya

| ID | Severity | Judul | File | Bukti FAIL-first |
|---|---|---|---|---|
| BATCH4-F8-01 | 🔴 CRITICAL | **Transisi lifecycle beku** — `lifecycle_version` membuat fase write-once; INVALIDATED permanen | `lib/reversal-breakout-lifecycle.js` | 4 test |
| BATCH4-F8-02 | 🔴 CRITICAL | **Drift skor lifecycle** — adjustment lama menumpuk di atas skor yang sudah disesuaikan | `lib/reversal-breakout-lifecycle.js` | 4 test |
| BATCH4-F8-03 | 🟠 HIGH | **Agregasi rotasi sektor** menghitung quote null/NaN sebagai observasi `0.00` | `api/sector-hot.js` | 5 test |
| BATCH4-F8-04 | 🟠 HIGH | **Payload JSONB** menulis string JSON / array / function ke kolom plan | `api/sector-hot.js` | 8 test |

**BATCH4-F8-01 — transisi lifecycle beku (CRITICAL).** `applyLifecycle()` melakukan early
return begitu `row.lifecycle_version === VERSION`. Efeknya lifecycle menjadi **write-once**:
baris yang tersimpan pagi hari sebagai `PRE_BREAKOUT` **tidak pernah bisa naik** ke
`BREAKOUT_CONFIRMED` meskipun sahamnya benar-benar breakout dan dievaluasi ulang — fase,
confidence, dan adjustment-nya basi. Guard yang sama membuat `INVALIDATED` **permanen**:
baris yang diblokir karena flag data-quality transien tidak pernah kembali aktif setelah flag
itu bersih. Perbaikan: sidik jari bukti (`evidenceFingerprint`) yang hanya mencakup field
input `derivePhase()`; baris yang version-current, tidak diblokir, dan **bukti-identik**
tetap short-circuit (idempoten), sedangkan bukti yang berubah **wajib** di-derivasi ulang.

**BATCH4-F8-02 — drift skor (CRITICAL).** `row.daytrade_score_before_lifecycle` menyimpan
skor ASLI, tetapi evaluasi berikutnya membaca `row.daytrade_score` — yang **sudah** berisi
adjustment sebelumnya — sebagai basis. Saat fase berubah, adjustment lama **menumpuk** alih-alih
diganti: baris mempertahankan bonus lama dan skor terbitan tidak lagi berkorespondensi dengan
fase mana pun yang pernah di-derivasi engine. Terbukti empiris: basis 70 → PRE_BREAKOUT 72 →
naik ke BREAKOUT_CONFIRMED seharusnya 73, hasilnya tetap **72** (bonus 2 tersangkut, bonus 3
tidak pernah diterapkan). Perbaikan: pulihkan basis terekam lebih dulu bila
`lifecycle_score_applied === true`, lalu terapkan adjustment fase BARU.

**BATCH4-F8-03 — presisi agregasi rotasi sektor (HIGH).** Handler refresh mengakumulasi
`totalChangePct += q.changePct` untuk setiap anggota yang **objek quote-nya ada**, sambil
menghitung anggota yang sama di `validCount`. Quote yang ada tetapi angka-nya `null`/`NaN`
(feed gap / gagal parse) menyumbang `0.00` diam-diam dan **menarik rata-rata grup ke nol** —
membalik peringkat rotasi yang membacanya. Terbukti: `{2.5, null, -1.2}` menghasilkan
`avg_change_pct = 0.43` (memasukkan nol palsu) alih-alih `0.65`. Perbaikan: helper
`sumObservedSectorMemberQuotes()` yang hanya mengagregasi **pengukuran yang benar-benar
teramati**, men-coerce string numerik berformat, dan menerbitkan `null` (bukan `0`) untuk grup
tanpa anggota terukur sehingga UI merender "-".

**BATCH4-F8-04 — sanitasi payload JSONB (HIGH).** `trade_plan_v2` dan
`trade_plan_v2_structural` adalah kolom JSONB, tetapi mapper menerbitkan `value || null` yang
hanya menjaga `null`/`undefined`: string JSON sisa round-trip cache, array telanjang, atau
function ikut tertulis apa adanya. Postgres lalu menyimpan scalar/array di tempat yang oleh
setiap pembaca diasumsikan objek, dan resolver plan diam-diam mengembalikan plan tak terpakai.
Perbaikan: `sanitizeJsonbPayload()` (revive string JSON valid → objek; selain itu `null`) +
`sanitizeTradePlanSourceRows()` yang menormalisasi **baris sumber** di batas setiap penulis
(Swing Konglo, Day Trade, Non-Konglo). Pendekatan boundary ini sengaja dipilih agar bentuk
mapper historis `value || null` tetap utuh — dipin oleh
`test/daytrade-swing-konglo-trade-plan-v2-persistence.test.js`.

### 9.3 Metrik verifikasi

| Tahap | Hasil |
|---|---|
| Baseline (sebelum fix) | **7 PASS / 16 FAIL** dari 23 test |
| PASS run #1 | **24 / 24 PASS**, 0 fail |
| PASS run #2 (berturut-turut) | **24 / 24 PASS**, 0 fail |
| Regresi terarah (9 suite) | **140 / 140 PASS**, 0 fail |

### 9.4 Perlindungan regression yang dipertahankan

| Perilaku | Test penjaga | Status |
|---|---|---|
| Blok corporate action tetap `INVALIDATED` & tanpa tambahan skor | `reversal-breakout-lifecycle.test.js`, `audit-fase12-trade-engine-bugs.test.js` | PASS |
| Status terminal (`AVOID`, `TP1_HIT`, `INVALID_BELOW_SL`) tetap invalid | `reversal-breakout-lifecycle.test.js`, `audit-fase8-sector-breakout-bugs.test.js` | PASS |
| `applyScore: false` tetap tidak mengubah skor terpersistensi | `reversal-breakout-lifecycle.test.js` | PASS |
| `trade_plan_v2` tetap terpetakan di ketiga penulis | `daytrade-swing-konglo-trade-plan-v2-persistence.test.js`, `swing-nk-trade-plan-v2-persistence.test.js` | PASS |
| Tautologi support/resistance Fase 8 tetap diperbaiki | `audit-fase8-swing-screener-bugs.test.js` | PASS |

### 9.5 Catatan konsistensi lintas fase

Guard `lifecycle_version` semula ditambahkan sebagai perbaikan **Fase 12** (`F12-01`) untuk
kasus corporate-action. Batch 4 menemukan guard itu **terlalu lebar**: ia juga membekukan
transisi fase yang sah. Perbaikannya memperluas cakupan re-evaluasi ke *semua* perubahan bukti
sambil **tetap** memenuhi kontrak F12-01 — baris dengan guard `BLOCKED` selalu di-derivasi
ulang dan selalu `INVALIDATED`, karena baris yang diblokir tidak pernah short-circuit.

---

## 10. ARTEFAK

- Test Fase 8 asli: `test/audit-fase8-swing-screener-bugs.test.js` (29 test)
- Test Batch 4: `test/audit-fase8-sector-breakout-bugs.test.js` (24 test)
- Temuan detail: `BUG_FINDINGS_FASE_8_23SEPT.md`
- Registrasi: `tools/curated-build-tests.json` (525 entri)
- Skrip forensik (sementara, read-only): `tmp_investigasi/f8-*.js`, `scratch/batch4-probe*.js`
