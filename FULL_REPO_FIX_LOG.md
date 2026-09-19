# FULL_REPO_FIX_LOG.md - Log Fase Perbaikan (Batch 0-16)

Acuan utama: `FULL_REPO_BUG_FINDINGS.md` (97 heading temuan) dan `FULL_REPO_AUDIT_LOG.md` (fase audit).
Plan batch: instruksi fase perbaikan Batch 0-16 (dari pesan user; lihat catatan ketidaksesuaian sumber di bawah).

Branch kerja: `feat/daytrade-screener-v1` (DILARANG menyentuh `main`/`master`).
Aturan: satu temuan hanya dikerjakan pada batch scope-nya, wajib test regresi, `node --check` + `npm test` 100% hijau sebelum commit, update log ini setiap batch.

Status kode: `[ ]` BELUM - `[-]` BERJALAN - `[x]` SELESAI - `[~]` DITARIK

---

## 0. Catatan Ketidaksesuaian Sumber (WAJIB DIBACA)

1. `PLAN_PERBAIKAN_BUG.md` **tidak ada** di workspace maupun di `origin/feat/daytrade-screener-v1`. Acuan yang dipakai = plan Batch 0-16 yang dilampirkan user di pesan, bukan file repo.
2. Jumlah heading aktual di `FULL_REPO_BUG_FINDINGS.md` = **97**, tetapi sebarannya **2 CRITICAL / 16 HIGH / 40 MEDIUM / 39 LOW**, bukan 39 MEDIUM / 40 LOW seperti rekap di `FULL_REPO_AUDIT_LOG.md`. Hitungan langsung di file findings dipakai sebagai kebenaran (keputusan user).
3. Sebagian heading bukan bug aktif: ada yang berjudul "SUDAH DIPERBAIKI/diverifikasi", "TUNTAS, tidak ditemukan bug", dan 1 temuan berstatus DITARIK di narasi findings. Semua tetap dicantumkan sebagai baris checklist (tidak dihapus) agar 97 heading terjaga, dengan catatan status.
4. Pemetaan batch otomatis mengikuti teks heading + baris `Lokasi`. Beberapa temuan lintas-batch (mis. WeizeRouter, refresh harga Portfolio, `direct_answer` dead validation) belum punya batch eksplisit di plan; sementara dipetakan ke batch terdekat dan ditandai `(PERLU KONFIRMASI PEMETAAN)`.
5. Branch audit `audit/full-repo-deep-dive` sudah di-merge ke `feat/daytrade-screener-v1` (merge commit `027ea0e`, hanya 2 file dokumentasi audit; 0 kode produksi).

---

## 1. Baseline Fase Perbaikan

Dijalankan pada salinan repo terisolasi `D:\auto-cuan-2-baseline` (kode identik, `node_modules` via junction) agar skrip patch pre-build milik runner tidak menyentuh working tree produksi.

| Pemeriksaan | Perintah | Hasil |
|---|---|---|
| Sintaks seluruh repo | `node tools/validate-full-syntax.js` | **809 file .js parsed, 0 syntax error**; curated list 395 entri, 0 file hilang |
| Test suite penuh | `npm test` (`run-build-test-suite.js --full`) | **395/395 file lolos, exit 0** |
| Subtest agregat | parse TAP log | **4352 subtest, 0 fail, 0 skipped, 0 cancelled, 0 todo** |
| Cakupan CI | hitung `test/*.test.js` vs `curated-build-tests.json` | 453 file test, 395 ter-kurasi, **58 di luar CI** (konfirmasi temuan #95) |

**Perbandingan baseline audit terakhir** (`SCREENER_BUGFIX_LOG.md`, Batch 20): 395/395 file lolos. Baseline fase perbaikan juga 395/395 -> **tidak ada regresi** antara selesainya audit dan dimulainya fase perbaikan.

Runtime: Node v24.19.0, npm 11.17.0. Repo private; tidak ada kredensial/token yang ditulis ke file ini.

---

## 2. Ringkasan Temuan & Pemetaan Batch

| Severity | Jumlah |
|---|---:|
| CRITICAL | 2 |
| HIGH | 16 |
| MEDIUM | 40 |
| LOW | 39 |
| **TOTAL** | **97** |

| Batch | Judul | Jumlah temuan | Status |
|---|---|---:|---|
| 1 | CRITICAL: Satukan Definisi Harga Terakhir (api/quote.js vs api/candles.js) | 2 | [x] SELESAI |
| 2 | CRITICAL: Satu Sumber Kebenaran Nama Model Gemini | 9 | [-] SEBAGIAN (5/9) |
| 3 | HIGH Keamanan: Token Hardcoded, Backdoor Kredensial, Kunci Enkripsi Fallback | 5 | [x] SELESAI |
| 4 | HIGH: Integritas Gerbang Keselamatan Telegram (BUG-025 & Pemotongan Teks) | 1 | [x] SELESAI |
| 5 | HIGH: Hapus Data Fabrikasi Jejaring Insider | 2 | [x] SELESAI |
| 6 | HIGH: Hapus Semua Tanggal Fallback Hardcoded | 12 | [x] SELESAI |
| 7 | HIGH: Stored XSS Admin Logs + Validasi Charset Username | 1 | [x] SELESAI |
| 8 | HIGH: analyze-legacy.js Berhenti Mengarang RSI/Volume/Change | 3 | [x] SELESAI (F-056) |
| 9 | MEDIUM: Cluster Fabrikasi Angka di Bandarmologi & Publisher | 6 | [x] SELESAI (5/6; F-081 frontend menunggu instruksi) |
| 10 | MEDIUM: Cluster Fabrikasi di Telegram Templates & Track Record Backtest | 2 | [x] SELESAI |
| 11 | MEDIUM: Satukan Konversi Tanggal UTC ke WIB | 6 | [x] SELESAI |
| 12 | MEDIUM: Panel "Kenapa Sinyal Ini Lolos Gate?" (Ambang + Missing != Pass) | 3 | [x] SELESAI |
| 13 | MEDIUM: CI Gate & Kalender Libur (Coverage Gap + 3 Salinan Kalender + RLS REVOKE) | 5 | [x] SELESAI |
| 14 | LOW: Sapuan Pembersihan (Dead Code, Escaping, Komentar Salah) | 40 | [-] SEBAGIAN (14A: 9 temuan + 1 ditolak) |

Progres keseluruhan: **59/97 SELESAI, 1 DITOLAK (F-029), 37 BELUM** (per Batch 14A).

### Batch 1 - SELESAI (PR #689, merge `076d6a0`)

Branch `fix/unify-latest-price-policy` -> base `feat/daytrade-screener-v1`. Scope: F-050 (CRITICAL) + F-051 (HIGH) saja.

- **Verifikasi runtime SEBELUM ubah kode** (mock Yahoo, tanpa jaringan): `quote.last=505` (bar hari berjalan) vs `candles.latest.last=100` (T-1); `pivotSourceDate=hari ini`. Divergen terkonfirmasi.
- **Perbaikan** di `api/quote.js`: impor `lib/chart-t1-policy.js`; label candle pakai `formatJakartaDate` (field `date` -> `time`, selaras `/api/candles`); `retainCompletedCandles` dijalankan sebelum `latest`/pivot/MA/RSI/fibonacci; tambah `actual_data_date`/`jakarta_today`/`t1_status`/`t1_verified`.
- **Setelah perbaikan**: `quote.last=100 == candles.latest.last=100`, `pivotSourceDate=T-1`, `DIVERGENT=false`.
- **Test regresi baru**: `test/quote-candles-latest-price-consistency.test.js` (3 subtest) + didaftarkan di `tools/curated-build-tests.json` agar ter-gate `npm test`.
- **Gate**: `node --check api/quote.js` bersih; `npm test` = **396/396 file lolos, exit 0** (baseline 395 + 1 test baru). CI PR #689 hijau (build-and-focused-tests, security-gate, CodeQL, Analyze JavaScript, portfolio-persistence, command-login).
- **Diff**: `api/quote.js` +18/-4, `tools/curated-build-tests.json` +1, test baru 132 baris. Tidak menyentuh scope Batch 2+.

### Batch 2 - SELESAI (PR #691, merge `ce8403a`) - hanya item model Gemini yang diminta

Branch `fix/unify-gemini-model-source` -> base `feat/daytrade-screener-v1`. Scope batch ini sesuai instruksi user = 5 temuan: F-046 (CRITICAL), F-044 (HIGH), F-045 (HIGH), F-047 (HIGH), F-058 (MEDIUM). F-006/F-057/F-062/F-063 (sisa 4 temuan ber-batch 2) TIDAK diminta dan SENGAJA tidak disentuh.

- **Single source of truth**: [`lib/ai-gemini-provider.js`](lib/ai-gemini-provider.js) kini mengekspor `SAFETY_NET_GEMINI_MODEL` (default ikut `DEFAULT_GEMINI_MODEL`, override via `GEMINI_SAFETY_NET_MODEL`) dan `getGeminiApiKey()` yang membaca berurutan `GEMINI_API_KEY_PRIMARY` -> `API_KEY_ANALISA_SAHAM_PORTOFOLIO` -> `GEMINI_API_KEY`.
- **F-046 CRITICAL**: [`lib/ai-narration.js`](lib/ai-narration.js:53) tidak lagi default ke `'gemini-3-flash'` (deprecated/404); `getModel()` memakai `sanitizeGeminiModel(GEMINI_MODEL, DEFAULT_GEMINI_MODEL)`. Model deprecated otomatis diganti default valid.
- **F-044 HIGH**: [`public/chart-analysis-runtime.js`](public/chart-analysis-runtime.js:269) tidak lagi fallback ke `'Gemini 2.5 Flash'`; bila `analysisData.model` kosong ditampilkan `'tidak dilaporkan'`.
- **F-045 HIGH**: [`lib/context-ai-router-v7.js`](lib/context-ai-router-v7.js:600) safety-net literal `'gemini-3.6-flash'` (2 lokasi) diganti `SAFETY_NET_GEMINI_MODEL`.
- **F-058 MEDIUM**: 4 salinan daftar model deprecated di [`lib/analyze-legacy.js`](lib/analyze-legacy.js:457) dan 1 salinan di [`api/quote.js`](api/quote.js:1192) diganti `sanitizeGeminiModel`/`DEFAULT_GEMINI_MODEL` (3 nama vs 7 nama di otoritatif).
- **F-047 HIGH**: narasi gagal senyap bila kunci hanya `GEMINI_API_KEY` — kini pakai rantai `getGeminiApiKey()` yang mencakup semua nama kunci.
- **Test regresi baru**: `test/ai-gemini-model-single-source.test.js` (6 subtest) + didaftarkan di `tools/curated-build-tests.json`; [`test/ai-narration.test.js`](test/ai-narration.test.js:254) diperbarui (test lama mengunci default deprecated = bug yang diperbaiki).
- **Gate**: `node --check` bersih pada 7 file; `npm test` = **397/397 file lolos, exit 0** (baseline 396 setelah Batch 1 + 1 test baru). CI PR #691 hijau (build-and-focused-tests, security-gate, CodeQL, Analyze JavaScript, portfolio-persistence, command-login).
- **Diff**: 8 file kode/test + `curated-build-tests.json`, +168/-29. Tidak menyentuh scope Batch 3+.
- **Sisa Batch 2**: F-006 (katalog WeizeRouter v4), F-057 (label provider ticker-mode), F-062 (pesan error `handleChartVision` sebagai HTML), F-063 (`geminiSearchNews` dead code) — **DITUNTASKAN di Batch 14A (PR #715)**.

### Batch 3 - SELESAI (PR #693, merge `0091baa`)

Branch `fix/security-hardening-tokens-credentials` -> base `feat/daytrade-screener-v1`. Scope = 5 temuan keamanan: F-019 (HIGH), F-037 (HIGH), F-038 (MEDIUM), F-039 (MEDIUM), F-094 (MEDIUM). Tidak menyentuh scope Batch 4+.

- **F-019/F-094 (token hardcoded)**: [`api/review-access.js`](api/review-access.js:42) tidak lagi punya `fallbackBuildToken` literal untuk lingkungan Vercel; `EXPECTED_TOKEN` murni dari `process.env.REVIEW_ACCESS_TOKEN` dan fail-closed bila kosong. [`tools/run-build-test-suite.js`](tools/run-build-test-suite.js:9) tidak lagi menanam literal token bersama; runner membuat token sekali-pakai via `crypto.randomBytes(24)` bila env tidak diset.
- **F-037 (backdoor budi)**: [`api/login-user.js`](api/login-user.js:198) menghapus `LEGACY_BUDI_PASSWORD_HASH`, `matchesLegacyBudiPassword`, dan `isRegisteredDevice`; jalur login budi kini mengikuti verifikasi database standar (`passwordCredential.verifyStoredCredential`) tanpa cabang kompatibilitas. Import `getSessionSecret` yang tak lagi dipakai ikut dibersihkan.
- **F-038 (kunci BYOK fallback)**: [`lib/user-ai-credentials.js`](lib/user-ai-credentials.js:14) fail-closed — `getMasterKey()` melempar `CredentialConfigError` (`AI_CREDENTIAL_KEY_UNCONFIGURED`) bila `APP_SECRET`/`ENCRYPTION_SECRET`/`SUPABASE_SERVICE_ROLE_KEY` kosong; `saveUserApiKey` mengembalikan 503 dan `getUserApiKey` mengembalikan `KEY_UNCONFIGURED` alih-alih memakai string statis.
- **F-039 (bypass device binding)**: [`api/login-user.js`](api/login-user.js:22) `isVercelPreviewRequest` hanya memakai `req.headers.host` dan membandingkannya dengan domain resmi (`autocuan.web.id`, `www.autocuan.web.id`); header `Origin` dari klien tidak lagi dipercaya.
- **Test regresi baru**: `test/security-hardening-batch3.test.js` (8 subtest) + didaftarkan di `tools/curated-build-tests.json`. Test lama yang mengunci perilaku backdoor diperbarui: [`test/budi-admin-compatibility.test.js`](test/budi-admin-compatibility.test.js) (matriks legacy diganti asersi backdoor hilang), [`test/security-phase1.test.js`](test/security-phase1.test.js), dan 3 test BYOK diberi `APP_SECRET` uji.
- **Gate**: `node --check` bersih pada 4 file sumber; `npm test` = **398/398 file lolos, exit 0** (baseline 397 setelah Batch 2 + 1 test baru). CI PR #693 hijau (build-and-focused-tests, security-gate, CodeQL, Analyze JavaScript, portfolio-persistence, command-login, migrations).
- **Diff**: 4 file sumber + 6 file test + `curated-build-tests.json`, +302/-255. Tidak menyentuh scope Batch 4+.

### Batch 4 - SELESAI (PR #695, merge `23b5bda`)

Branch `fix/telegram-safety-gate-text-limit` -> base `feat/daytrade-screener-v1`. Scope = 1 temuan: F-017 (HIGH, BUG-025). Tidak menyentuh scope Batch 5+.

- **F-017 (BUG-025)**: [`api/sector-hot.js`](api/sector-hot.js:13623) `includesAny` tidak lagi memotong teks ke 300 karakter (`safeTelegramText(text, Infinity, '')`) dan [`joinTelegramTexts`](api/sector-hot.js:13634) tidak lagi memotong setiap bagian ke 120 karakter. Kata pemicu gate (`stale`, `invalid plan`, `weak liquidity`, dll.) di ujung `status_reason`/`plan_quality_note` kini terbaca utuh → gate memblokir (fail-CLOSED), bukan lolos (fail-OPEN).
- **Blok diagnostik dihapus**: `includesAnyDiagnostics`, `getIncludesAnyDiagnostics`, `resetIncludesAnyDiagnostics`, dan seluruh blok "does NOT alter gate behavior" dihapus dari `api/sector-hot.js`. `safeTelegramText` kini mendukung `maxLen = Infinity` untuk jalur gate (jalur tampilan tetap memotong normal).
- **Test regresi baru**: `test/telegram-safety-gate-text-limit.test.js` (4 subtest) membuktikan kata pemicu di atas indeks 300 (`plan_quality_note`, `stale_notes`) memblokir broadcast via `candidatePassesPublicTelegramSafetyGate`, plus kasus kontrol (trigger pendek tetap blokir, kandidat bersih tetap lolos). `test/includes-any-length-diagnostic.test.js` ditulis ulang (2 subtest) untuk mengunci perilaku tanpa pemotongan.
- **Gate**: `node --check api/sector-hot.js` bersih; `npm test` = **399/399 file lolos, exit 0** (baseline 398 setelah Batch 3 + 1 test baru). CI PR #695 hijau (build-and-focused-tests, security-gate, CodeQL, Analyze JavaScript, portfolio-persistence, command-login, Vercel).
- **Diff**: `api/sector-hot.js` +13/-65, 2 file test (1 ditulis ulang, 1 baru), `curated-build-tests.json` +1. Tidak menyentuh scope Batch 5+.

### Batch 5 - SELESAI (PR #697, merge `a78dd89`)

Branch `fix/remove-insider-data-fabrication` -> base `feat/daytrade-screener-v1`. Scope = 2 temuan: F-007 (HIGH) + F-041 (HIGH). Tidak menyentuh scope Batch 6+.

- **F-041 ([`lib/insider-network-service.js`](lib/insider-network-service.js))**: 340-baris `SAMPLE_INSIDER_UNIVERSE` (Belvin Tannadi, Prajogo Pangestu, Lo Kheng Hong, Anthoni Salim, Haji Isam, Garibaldi Thohir, BlackRock) dihapus. `getEffectiveUniverse` kini mengembalikan `[]` ketika tidak ada `recordsOverride`/`customUniverse`/`insiders-db.json`. Pembantu baru `getEffectiveUniverseStatus()` mengembalikan `OK | OVERRIDE | CUSTOM | NO_DATA`. `SAMPLE_INSIDER_UNIVERSE` tidak lagi di-export, sehingga tidak ada fallback ke data karangan. Cache `clearInsiderServiceMemoryCache()` tetap membatalkan semua turunan (`dedicated/aggregated/searchIndex`) jika state berubah.
- **F-007 ([`public/bandarmologi-runtime.js`](public/bandarmologi-runtime.js))**: kamus `FALLBACK_INSIDER_DATA` (~110 baris, 8 tokoh karangan) dihapus. `getEffectiveInsiderGraph(name)` sekarang: 1) berhenti di service, 2) bila tidak ada node -> kembalikan graf eksplisit `status: NO_DATA`, `no_data: true`, `message: 'Belum ada data relasi'`. Dilarang mengembalikan profil tokoh apa pun untuk nama tak dikenal. Pembantu baru `getEffectiveInsiderGraphStatus()`. `getEffectiveSearchInsiders()` selalu `[]` saat service tidak menghasilkan data (sebelumnya membaca `FALLBACK_INSIDER_DATA`). Default `activeInsiderNetworkEntity` diubah dari `'Belvin Tannadi'` ke `''`, dengan label panduan `Belum dipilih` di header kanvas (`activeEntityLabel`). Pesan kosong SVG diubah ke “Belum ada data relasi untuk tokoh ini. Silakan pilih tokoh lain atau masukkan nama pemegang saham lain.” Placeholder input disesuaikan ke “Ketik nama insider/tokoh untuk melihat relasi...”. Cache overwrite `FALLBACK_INSIDER_DATA[...] = data` di kedua jalur `fetchRemoteInsiderGraph` (VPS + fallback lokal) ikut dihapus.
- **Bundling serverless ([`vercel.json`](vercel.json))**: `api/sector-hot.js` -> `includeFiles: data/insider-network/**`, sehingga `data/insider-network/insiders-db.json`/`network.json`/`roster.json` ikut ke bundle fungsi serverless di Vercel (sebelumnya tidak ada `includeFiles`, sehingga fallback `SAMPLE_INSIDER_UNIVERSE` berisiko aktif di produksi).
- **Test regresi baru**: [`test/insider-data-fabrication-removal.test.js`](test/insider-data-fabrication-removal.test.js) (6 subtest) -- (a) source-level: tidak ada lagi `SAMPLE_INSIDER_UNIVERSE` atau ekspornya, tidak ada lagi `FALLBACK_INSIDER_DATA` atau default `Belvin Tannadi`; (b) behavior: `getEffectiveUniverseStatus()` -> `NO_DATA` dan `getEffectiveUniverse()` -> `[]` ketika `fs.existsSync` memalsukan file DB tidak ada, `searchInsiders('Belvin Tannadi')` -> `[]`, `getInsiderProfile(unknown)` -> `null`; (c) runtime: `getEffectiveInsiderGraph(unknown)` -> `{nodes: [], status: 'NO_DATA', no_data: true}`, tidak pernah meleak Belvin Tannadi, `getEffectiveSearchInsiders(unknown)` -> `[]`; (d) bundling: `vercel.json.functions['api/sector-hot.js'].includeFiles` mengandung `data/insider-network`. Test lama [`test/insider-network-ui.test.js`](test/insider-network-ui.test.js) disesuaikan (placeholder search bar +1/-1 baris).
- **Gate**: `node --check` bersih pada `lib/insider-network-service.js`, `public/bandarmologi-runtime.js`, dan `test/insider-data-fabrication-removal.test.js`; `npm test` = **400/400 file tests lolos, exit 0** (baseline 399 setelah Batch 4 + 1 test regresi baru). CI PR #697 hijau (build-and-focused-tests, security-gate, Analyze JavaScript, CodeQL, command-login, portfolio-persistence, Vercel + admin-hardening).
- **Diff**: 6 file, +166/-490. Tidak menyentuh scope Batch 6+.

### Batch 6 - SELESAI (PR #699, merge `44abc80`)

Branch `fix/remove-hardcoded-date-fallbacks` -> base `feat/daytrade-screener-v1`. Scope = 12 temuan: F-005, F-008, F-030, F-031, F-032, F-040, F-042, F-043, F-068, F-072, F-078, F-080. Tidak menyentuh scope Batch 7+.

- **Aturan penggantian**: setiap literal tanggal statis (`2026-09-07`/`2026-09-08`/`2026-09-11`/`2026-08-01`/`2026-09-01`) dihapus dari jalur kode. Bila butuh hari bursa aktif/terakhir -> `getEffectiveTradingDate()` / `idxTradingCalendar.previousTradingDay()`; bila data tanggal memang tidak ada -> `null` / `[]` / `'—'` (status eksplisit DATE_UNRESOLVED). Tidak ada lagi fallback ke string tanggal statis.
- **F-042/F-068 ([`lib/bandarmologi-service.js`](lib/bandarmologi-service.js:210))**: 3 literal `'2026-09-11'` di `getEffectiveTradingDate` -> `null`; `getDynamicTradingDays` tidak lagi mengembalikan deret tanggal mati -> `[]`; 2 literal tambahan di `normalizeBrokerSummary` (`:808`) dan `getCombinedBandarmologiData` (`:1984`) -> `null`.
- **F-043 ([`lib/bandarmologi-service.js`](lib/bandarmologi-service.js:299))**: gerbang kesegaran `getReferencePrice` tidak lagi memakai batas literal `'2026-08-01'`; ambang kini dihitung dari `idxTradingCalendar.previousTradingDay(refKey, undefined, { maxLookback: 60 })` (fallback `addDaysToKey(refKey, -7)` bila kalender tak tersedia).
- **F-072 ([`lib/bandarmologi-intel-service.js`](lib/bandarmologi-intel-service.js:1269))**: 3 literal `'2026-09-11'` (`effective_date`/`evaluated_at` di safe-fallback, `getEffectiveTradingDate(...) || ...`, `marketDate`) -> `null`; 1 literal `'2026-09-08'` di jalur fetch VPS -> `'latest'`.
- **F-030 ([`lib/vps-data-fetcher.js`](lib/vps-data-fetcher.js:243))**: 7 literal `'2026-09-08'` (default param + `String(date || ...)` di `fetchBrokerSummaryFromVpsSync`, `fetchBrokerSummaryFromVps`, `ensureBrokerSummary`) -> `'latest'`.
- **F-031/F-078 ([`lib/broker-hunter-service.js`](lib/broker-hunter-service.js:368))**: `targetDates = ['2026-09-07']` -> `[]` (memicu cabang "no data" yang jujur); `date_range_label` fallback `'2026-09-07'` -> `'—'`.
- **F-080 ([`lib/insider-network-service.js`](lib/insider-network-service.js:776))**: `last_date: r.date || '2026-09-01'` -> `r.date || null`.
- **F-005/F-008/F-040 ([`public/bandarmologi-runtime.js`](public/bandarmologi-runtime.js:134))**: 7 literal `'2026-09-11'` dihapus — `selectedDate` fallback (2 lokasi) -> `null`; header `Tanggal:` (`:2244`), `formatDateDisplay` default (`:4055`), label `Evaluasi:` (`:4435`), `activeMarketDate` (`:4702`) -> `'—'` via cabang input-kosong `formatDateDisplay`.
- **Test regresi baru**: [`test/remove-hardcoded-date-fallbacks.test.js`](test/remove-hardcoded-date-fallbacks.test.js) (13 subtest) — (a) source-level: 6 modul tidak memuat literal tanggal terlarang di jalur kode (komentar ditoleransi); (b) behavior: `getEffectiveTradingDate` -> `null` saat tak ada hari bursa sebelumnya, `getDynamicTradingDays` -> `[]`, `safeEvaluateBandarmologiIntelForTicker` tidak pernah mengembalikan literal basi (sama dengan hasil dinamis), VPS fetcher default `'latest'`, broker-hunter `date_range_label` bukan literal, insider `last_date` -> `null`, `formatDateDisplay('')` -> `'—'`. Didaftarkan di [`tools/curated-build-tests.json`](tools/curated-build-tests.json:386).
- **Gate**: `node --check` bersih pada 6 file sumber + test; `npm test` = **401/401 file lolos, exit 0** (baseline 400 setelah Batch 5 + 1 test baru). CI PR #699 hijau (build-and-focused-tests, security-gate, Analyze JavaScript, CodeQL, command-login, portfolio-persistence, Vercel + admin-hardening).
- **Diff**: 6 file sumber + 1 test baru + `curated-build-tests.json`, +306/-31. Tidak menyentuh scope Batch 7+.

### Batch 7 - SELESAI (PR #701, merge `239734c`)

Branch `fix/admin-logs-stored-xss` -> base `feat/daytrade-screener-v1`. Scope = 1 temuan: F-087. Tidak menyentuh scope Batch 8+.

- **F-087 ([`public/index.html`](public/index.html:7387))**: seluruh nilai dinamis di `loadAdminLogs` kini dibungkus `escapeAdminHtml` — pesan error (`data.error`), kartu ringkasan (`totalLogins`/`totalSearches`/`totalAIAnalyses`/`mostSearchedTicker`), kartu analysis (`row.ticker`/`row.username`/`row.mode`/`row.created_at`), sel tabel generik (`val`), dan header kolom dinamis (`k`). Sebelumnya `username`/`ticker` disisipkan mentah ke `innerHTML`.
- **F-087 ([`api/register-user.js`](api/register-user.js:31))**: allowlist charset `USERNAME_RE = /^[a-z0-9._-]{2,30}$/i` ditambahkan dan ditegakkan sebelum penulisan apa pun; username berisi tag HTML/script, spasi, atau metakarakter lain ditolak dengan error validasi 400. `USERNAME_RE` di-export via `__test`.
- **Test regresi baru**: [`test/admin-logs-stored-xss.test.js`](test/admin-logs-stored-xss.test.js) (7 subtest) — (a) API: `USERNAME_RE` menerima username normal dan menolak `<img src=x onerror=alert(1)>`/`<script>`/spasi/`&`/kutip/`/`/`\`/`;`/`(`/NUL/panjang>30; registrasi dengan username HTML ditolak 400 tanpa RPC; registrasi username valid tetap sukses; (b) UI: `loadAdminLogs` diekstrak ke sandbox `node:vm` headless dengan DOM + `fetch` palsu, membuktikan teks ter-escape (`<img...>`) yang mencapai `innerHTML`, bukan HTML mentah, untuk kartu analysis, tabel generik (termasuk header dinamis), dan pesan error. Didaftarkan di [`tools/curated-build-tests.json`](tools/curated-build-tests.json:403).
- **Gate**: `node --check` bersih pada `api/register-user.js` + test; `npm test` = **402/402 file lolos, exit 0** (baseline 401 setelah Batch 6 + 1 test baru). CI PR #701 hijau (build-and-focused-tests, security-gate, Analyze JavaScript, CodeQL, command-login, portfolio-persistence, account-center, Vercel + admin-hardening).
- **Diff**: `api/register-user.js` +14/-1, `public/index.html` +11/-11, test baru 243 baris, `curated-build-tests.json` +1. Tidak menyentuh scope Batch 8+.

### Batch 8 - SELESAI (PR #703, merge `650d53c`) - Hentikan Angka Fabrikasi di analyze-legacy.js

Branch `fix/analyze-legacy-no-fabricated-defaults` -> base `feat/daytrade-screener-v1`. Scope = F-056 (HIGH). F-059 (MEDIUM) dan F-064 (LOW) tetap menunggu jadwal batch selanjutnya.

- **F-056 ([`lib/analyze-legacy.js`](lib/analyze-legacy.js:1074))**:
  - Hapus substitusi default fiktif di `buildIHSGFixedTemplate` dan `buildStockFixedTemplate`: `changePct` tidak lagi fallback ke `0`, `volRatio` tidak lagi fallback ke `1`, `rsi14` tidak lagi fallback ke `50`.
  - Kontrak diselaraskan dengan [`public/market-feature-runtime.js`](public/market-feature-runtime.js:585) (field absen tetap absen); parsing pesan di `parseMarketDataFromMessage` tidak lagi memalsukan `volume || 0`.
  - Metrik teknikal yang absen dirender sebagai tanda strip `\u2014` ("—") atau keterangan status `"data tidak tersedia"`, bukan angka karangan.
  - Perbaiki decision logic (`status`, `bias`, `confidence`, `action`): bila data teknikal tidak lengkap (`isDataIncomplete`), kartu menandai `status = 'Data Belum Lengkap'`, `confidence = 'Low'`, dan action panduan live alih-alih memicu sinyal Breakout/Avoid/Rebound palsu dari data rekaan. Pengujian kondisi teknikal (`ma20`, `ma50`, dll.) mensyaratkan `!= null`.
  - Ekspor fungsi `buildStockFixedTemplate` dan `buildIHSGFixedTemplate` via `module.exports.__test` untuk memfasilitasi pengujian deterministik.
- **Test regresi baru**: [`test/analyze-legacy-no-fabricated-defaults.test.js`](test/analyze-legacy-no-fabricated-defaults.test.js) (6 subtest) — (a) Stock template merender strip "—" untuk metrik RSI/volume/change yang absen dan tidak menampilkan angka 50, 1x, atau 0,00%; (b) Stock template menandai `Data Belum Lengkap` dengan confidence `Low` dan menolak rekomendasi beli/breakout fiktif; (c) Stock template tetap menghitung setup real ketika data lengkap; (d) IHSG template merender "—" untuk data absen; (e) IHSG template menandai `Data Belum Lengkap` dengan confidence `Low` saat data tidak tersedia; (f) IHSG template tetap menghitung kesimpulan real ketika data lengkap. Didaftarkan di [`tools/curated-build-tests.json`](tools/curated-build-tests.json:404).
- **Gate**: `node --check` bersih pada `lib/analyze-legacy.js` + test; `npm test` = **403/403 file lolos, exit 0** (baseline 402 setelah Batch 7 + 1 test baru). CI PR #703 hijau (build-and-focused-tests, security-gate, Analyze JavaScript, CodeQL, command-login, portfolio-persistence, Vercel + admin-hardening).
- **Diff**: `lib/analyze-legacy.js` +182/-59, test baru 131 baris, `curated-build-tests.json` +1. Tidak menyentuh scope Batch 9+.

---

---

## 3. Checklist Master 97 Temuan

Format: `[status] F-<no> | <severity> | batch <n> | <lokasi utama>` lalu judul.

### Batch 1 - CRITICAL: Satukan Definisi Harga Terakhir (api/quote.js vs api/candles.js) (2 temuan)

- [x] F-050 | CRITICAL | batch 1 | api/quote.js:543, api/candles.js:155 - `api/quote.js` dan `api/candles.js` memakai definisi "harga terakhir" yang BERBEDA — sumber utama "harga ngaco"
- [x] F-051 | HIGH | batch 1 | api/quote.js:620 - `api/quote.js` memakai pivot dari candle yang belum close → level support/resistance & trading plan bergeser

### Batch 2 - CRITICAL: Satu Sumber Kebenaran Nama Model Gemini (9 temuan)

- [x] F-006 | MEDIUM | batch 2 | lib/context-ai-router-v4.js:99 - Katalog model WeizeRouter di-hardcode sebagai daftar fallback, mencampur model yang belum tentu ada dengan daftar CATALOG _(DIPERBAIKI Batch 14A: katalog dari `catalogFromEnv()`, override via env `WEIZEROUTER_CATALOG` + satu default `DEFAULT_CATALOG`)_
- [x] F-044 | HIGH | batch 2 | public/chart-analysis-runtime.js:269 - Label model di kartu "Analisis Chart (AI)" di-hardcode `'Gemini 2.5 Flash'` — menyesatkan user bila model riil berbeda
- [x] F-045 | HIGH | batch 2 | lib/context-ai-router-v7.js:600, lib/context-ai-router-v7.js:750 - Rantai fallback model di `context-ai-router-v7.js` memakai literal hardcode `'gemini-3.6-flash'` yang tidak dikelola konstanta provider
- [x] F-046 | CRITICAL | batch 2 | lib/ai-gemini-provider.js:8, lib/ai-narration.js:52 - Nama model Gemini saling bertentangan antar modul — narasi AI Telegram & news memakai model yang sudah dideprecate/404
- [x] F-047 | HIGH | batch 2 | lib/ai-narration.js:112 - Narasi AI gagal total (fallback diam) bila kunci hanya `GEMINI_API_KEY`, karena `ai-narration.js` hanya membaca `GEMINI_API_KEY_PRIMARY`
- [x] F-057 | MEDIUM | batch 2 | lib/analyze-legacy.js:416 - `provider` di respons ticker-mode selalu dilaporkan `'deepseek'` walau jawaban berasal dari Gemini _(DIPERBAIKI Batch 14A: `tProvider` melacak provider yang benar-benar menjawab)_
- [x] F-058 | MEDIUM | batch 2 | lib/analyze-legacy.js:457, lib/analyze-legacy.js:631 - Daftar model Gemini deprecated disalin ulang 4× di `analyze-legacy.js` dengan isi BERBEDA dari daftar otoritatif provider (3 nama vs 7 nama)
- [x] F-062 | LOW | batch 2 | lib/analyze-legacy.js:637 - `handleChartVision` mengembalikan string pesan-error sebagai HTML → pemanggil menandai `provider: 'gemini-vision'` sebagai sukses _(DIPERBAIKI Batch 14A: kini `return null` pada semua cabang gagal)_
- [x] F-063 | LOW | batch 2 | lib/analyze-legacy.js:542 - `geminiSearchNews` adalah dead code (didefinisikan, tidak pernah dipanggil) _(DIPERBAIKI Batch 14A: fungsi dihapus)_

### Batch 3 - HIGH Keamanan: Token Hardcoded, Backdoor Kredensial, Kunci Enkripsi Fallback (5 temuan)

- [x] F-019 | HIGH | batch 3 | api/review-access.js:42 - BUG-013 lama MASIH BELUM DIPERBAIKI — token review masih punya default yang tertulis di source untuk lingkungan Vercel
- [x] F-037 | HIGH | batch 3 | api/login-user.js:198, api/login-user.js:469 - Kredensial legacy `budi` di-hardcode di sumber (`LEGACY_BUDI_PASSWORD_HASH`) — hash yang diterima diketahui publik
- [x] F-038 | MEDIUM | batch 3 | lib/user-ai-credentials.js:14 - Enkripsi BYOK memakai kunci master fallback hardcoded `'autocuan-chart-ai-key-secret-seed'`
- [x] F-039 | MEDIUM | batch 3 | api/login-user.js:22, api/login-user.js:586 - `Origin` yang dikendalikan klien bisa memicu bypass device-binding (`isVercelPreviewRequest`)
- [x] F-094 | MEDIUM | batch 3 | api/review-access.js:42, tools/run-build-test-suite.js:9 - Token gate review produksi (`REVIEW_ACCESS_TOKEN`) DITANAM HARDCODED sebagai fallback di sumber publik `api/review-access.js` — kontradiksi langsung dengan komentar fail-closed di file yang sama

### Batch 4 - HIGH: Integritas Gerbang Keselamatan Telegram (BUG-025 & Pemotongan Teks) (1 temuan)

- [x] F-017 | HIGH | batch 4 | api/sector-hot.js:13623 - BUG-025 lama MASIH BELUM DIPERBAIKI — hanya dipasangi "diagnostik", pemotongan 300 karakter tetap aktif → DIPERBAIKI: `includesAny`/`joinTelegramTexts` tanpa pemotongan, diagnostik dihapus

### Batch 5 - HIGH: Hapus Data Fabrikasi Jejaring Insider (2 temuan)

- [x] F-007 | HIGH | batch 5 | public/bandarmologi-runtime.js:3041 - Data insider FABRIKASI diduplikasi di sisi klien (`FALLBACK_INSIDER_DATA`) — semua nama tak dikenal jatuh ke Belvin Tannadi _(DIPERBAIKI: hapus `FALLBACK_INSIDER_DATA`, default `activeInsiderNetworkEntity=''`, `getEffectiveInsiderGraph` -> `NO_DATA`)_
- [x] F-041 | HIGH | batch 5 | lib/insider-network-service.js:17, lib/insider-network-service.js:511 - Fallback ke data insider FABRIKASI (`SAMPLE_INSIDER_UNIVERSE`) bila file DB tidak terbaca — berisiko tampil sebagai data nyata di serverless _(DIPERBAIKI: hapus `SAMPLE_INSIDER_UNIVERSE`, `getEffectiveUniverse` -> `[]` + `getEffectiveUniverseStatus`, `vercel.json` includeFiles)_

### Batch 6 - HIGH: Hapus Semua Tanggal Fallback Hardcoded (12 temuan)

- [x] F-005 | LOW | batch 6 | public/bandarmologi-runtime.js:4162 - `formatDateDisplay` di UI Bandarmologi mengembalikan tanggal literal `'2026-09-11'` sebagai default _(DIPERBAIKI: default -> `'—'`)_
- [x] F-008 | LOW | batch 6 | public/bandarmologi-runtime.js:2244 - Tanggal literal `'2026-09-11'` juga muncul di header UI Bandarmologi _(DIPERBAIKI: hapus fallback literal)_
- [x] F-030 | HIGH | batch 6 | lib/vps-data-fetcher.js:243 - `lib/vps-data-fetcher.js` memakai default tanggal literal `'2026-09-08'` di 7 tempat _(DIPERBAIKI: default -> `'latest'`)_
- [x] F-031 | HIGH | batch 6 | lib/broker-hunter-service.js:368 - `lib/broker-hunter-service.js` memakai daftar tanggal literal `['2026-09-07']` _(DIPERBAIKI: `[]` + cabang "no data")_
- [x] F-032 | MEDIUM | batch 6 | lib/bandarmologi-service.js:808 - Dua literal `'2026-09-11'` tambahan di `lib/bandarmologi-service.js` _(DIPERBAIKI: -> `null`)_
- [x] F-040 | MEDIUM | batch 6 | public/bandarmologi-runtime.js:134, public/bandarmologi-runtime.js:169 - `public/bandarmologi-runtime.js` juga memakai fallback tanggal literal `'2026-09-11'` untuk pemilih tanggal _(DIPERBAIKI: -> `null`)_
- [x] F-042 | HIGH | batch 6 | lib/bandarmologi-service.js:213, lib/bandarmologi-service.js:220 - Tanggal bursa fallback di-hardcode `'2026-09-11'` di 3 tempat _(DIPERBAIKI: -> `null`; `getDynamicTradingDays` -> `[]`)_
- [x] F-043 | HIGH | batch 6 | lib/bandarmologi-service.js:299 - Gerbang kesegaran `getReferencePrice` memakai batas tanggal literal `'2026-08-01'` _(DIPERBAIKI: -> `idxTradingCalendar.previousTradingDay()`)_
- [x] F-068 | LOW | batch 6 | lib/bandarmologi-service.js:213 - Literal tanggal `2026-09-11` sebagai default/fallback tanggal data di 4 jalur _(DIPERBAIKI: -> `null`)_
- [x] F-072 | LOW | batch 6 | lib/bandarmologi-intel-service.js:1303 - Literal tanggal `2026-09-08` default fetch VPS + `2026-09-11` default `effective_date` (3 lokasi) _(DIPERBAIKI: `'latest'` / `null`)_
- [x] F-078 | LOW | batch 6 | lib/broker-hunter-service.js:368 - Literal tanggal `'2026-09-07'` sebagai fallback `targetDates`/`date_range_label` _(DIPERBAIKI: `[]` / `'—'`)_
- [x] F-080 | LOW | batch 6 | lib/insider-network-service.js:1102 - Literal tanggal `'2026-09-01'` sebagai fallback `last_date` di roster insider _(DIPERBAIKI: -> `null`)_

### Batch 7 - HIGH: Stored XSS Admin Logs + Validasi Charset Username (1 temuan)

- [x] F-087 | HIGH | batch 7 | public/index.html:7404, api/log.js:109 - Stored XSS di viewer log admin: `loadAdminLogs` menyisipkan `username`/`ticker` mentah ke `innerHTML`, padahal username tidak dibatasi charset _(DIPERBAIKI: escape `escapeAdminHtml` di semua nilai dinamis `loadAdminLogs` + allowlist charset `USERNAME_RE` di `api/register-user.js`)_

### Batch 8 - HIGH: analyze-legacy.js Berhenti Mengarang RSI/Volume/Change (3 temuan)

- [x] F-056 | HIGH | batch 8 | lib/analyze-legacy.js:1074, lib/analyze-legacy.js:1231 - Template deterministik "data-driven" mengarang RSI14=50, volume=1x, dan perubahan harga=0 saat data absen — lalu angka karangan itu dipakai menghitung Status/Bias/Confidence _(DIPERBAIKI: hapus default || 50, || 1, || 0, render "—", status 'Data Belum Lengkap', confidence 'Low')_
- [ ] F-059 | MEDIUM | batch 8 | lib/analyze-legacy.js:1494 - `fetchServerSideQuote` menghitung pivot/MA/RSI dari candle TERAKHIR (termasuk bar hari berjalan) padahal seluruh label menyebut "Data Historis T-1"
- [ ] F-064 | LOW | batch 8 | lib/analyze-legacy.js:285 - Echo `chatMessage` tanpa escape ke HTML pada intent `ticker_only` — refleksi HTML mentah (self-XSS) via trik blok `[Info:]`

### Batch 9 - SELESAI (PR #705, merge `671d1ac`) - 5 temuan sesuai instruksi user

Branch `fix/remove-fabricated-scores-bandarmologi` -> base `feat/daytrade-screener-v1`. Scope = 5 temuan fabrikasi angka yang diminta user. F-081 (LOW, frontend `public/bandarmologi-runtime.js`) TIDAK diminta dan SENGAJA tidak disentuh.

- [x] F-002 | MEDIUM | batch 9 | api/sector-hot.js:2995 - `enrichConfluenceRows` menghitung ulang confidence memakai kategori hardcoded `'Swing'` _(DIPERBAIKI: teruskan `r.category || r.mode || 'swing'` ke `deriveConfidenceTier`)_
- [x] F-066 | MEDIUM | batch 9 | lib/intraday-fast-watcher-publisher.js:49 - `buildDbRow` MEMALSUKAN `daytrade_score` _(DIPERBAIKI: hapus default 70 & clamp `Math.max(50,...)` di `buildDbRow` DAN situs kedua di `registerConfirmedPicksForMonitoring`; item tanpa skor riil difilter dari `publishConfirmed` sehingga tidak masuk tabel publik `daytrade_screener_latest`)_
- [x] F-067 | MEDIUM | batch 9 | lib/bandarmologi-service.js:986, lib/bandarmologi-service.js:1131 - `accumulation_score` DIKARANG 70/30/75 _(DIPERBAIKI: skor dihitung dari net-flow share gross value + konsistensi multi-hari, atau `null` bila data tidak memadai; fallback konstanta 75 dihapus)_
- [x] F-070 | MEDIUM | batch 9 | lib/bandarmologi-intel-service.js:1184 - Denominator CR DIKARANG `top5Val × 1.75` _(DIPERBAIKI: bila turnover & volume sama-sama absen -> `cr3/cr5 = null` + `reason: 'TURNOVER_UNAVAILABLE'`; basis CR dilabeli eksplisit `cr_basis: VALUE|VOLUME`)_
- [x] F-071 | MEDIUM | batch 9 | lib/bandarmologi-intel-service.js:791 - Fallback hunter MEMFABRIKASI "Silent Foreign Accumulation" _(DIPERBAIKI: `triggered: false` + `reason: 'DAILY_SERIES_UNAVAILABLE'`; `price_change_pct: 0.8`, `is_sideways: true`, dan `daily_breakdown` rata-bagi dihapus)_
- [ ] F-081 | LOW | batch 9 | public/bandarmologi-runtime.js:4860 - Catatan scanner "Silent Foreign Accumulation" memfabrikasi "3 hari berturut-turut" saat `consecutive_days` absen _(di luar instruksi batch 9 ini; BELUM)_

- **Test regresi baru**: `test/batch9-fabricated-scores-regression.test.js` (13 subtest) + didaftarkan di `tools/curated-build-tests.json`.
- **Gate**: `node --check` bersih pada 4 file kode; `npm test` = **404/404 file lolos, exit 0** (baseline 403 setelah Batch 8 + 1 test baru). CI PR #705 hijau (build-and-focused-tests, security-gate, CodeQL, Analyze JavaScript, portfolio-persistence, command-login, fast-watcher-regression).
- **Diff**: 4 file kode +43/-27, test baru 142 baris, `curated-build-tests.json` +1. Tidak menyentuh scope Batch 10+.

### Batch 10 - SELESAI (PR #707, merge `71fcb0d`)

Branch `fix/remove-fabricated-tp-and-backtest-demo-label` -> base `feat/daytrade-screener-v1`. Scope = 2 temuan: F-065 (MEDIUM) + F-085 (MEDIUM). Tidak menyentuh scope Batch 11+.

- **F-065 ([`lib/telegram-templates.js`](lib/telegram-templates.js:615))**: fallback perkalian TP karangan (`e1 * 1.045`, `e1 * 1.075`, `refEntry * 1.055`) dihapus. Bila `tp1`/`tp2` null/undefined, kartu menampilkan strip `—` (daytrade) atau omit baris TP2 (swing). Label persentase statis `+4.5%`/`+7.5%`/`+5% s/d +6%` diganti kalkulasi dinamis `Math.round(((tp / entryRef) - 1) * 1000) / 10` sehingga cocok dengan TP riil.
- **F-085 ([`public/track-record-backtest.js`](public/track-record-backtest.js:55))**: array `BENCHMARK_SIGNALS` (8 sinyal hardcoded) dihapus. `runBacktestSimulation` kini mengembalikan `status: 'NO_SIGNALS'` + `message: 'Belum ada sinyal untuk disimulasikan'` saat input kosong, alih-alih menyuntikkan benchmark sebagai track record nyata.
- **Test regresi baru**: [`test/batch10-fabricated-tp-and-backtest-demo.test.js`](test/batch10-fabricated-tp-and-backtest-demo.test.js) (6 subtest) — (a) payload tanpa TP1/TP2 tidak memuat angka rekaan 1045/1075/1055; (b) label persentase dihitung dinamis dari selisih entry; (c) backtest sinyal kosong mengembalikan status eksplisit tanpa metrik benchmark palsu. Test lama yang mengunci perilaku fabrikasi diperbarui: [`test/telegram-templates.test.js`](test/telegram-templates.test.js:168) (label dinamis), [`test/swing-screener-and-telegram-integrity.test.js`](test/swing-screener-and-telegram-integrity.test.js:159) (label dinamis), [`test/track-record-backtest.test.js`](test/track-record-backtest.test.js:173) (status eksplisit).
- **Gate**: `node --check` bersih pada 6 file; `npm test` = **405/405 file lolos, exit 0** (baseline 404 setelah Batch 9 + 1 test baru). CI PR #707 hijau (build-and-focused-tests, security-gate, CodeQL, Analyze JavaScript, portfolio-persistence, command-login).
- **Diff**: 2 file kode + 4 file test + `curated-build-tests.json`, +130/-24. Tidak menyentuh scope Batch 11+.

### Batch 11 - SELESAI (PR #709, merge `d79937e`)

Branch `fix/utc-naive-date-formatting` -> base `feat/daytrade-screener-v1`. Scope = 6 temuan cluster UTC naif (F-004, F-010, F-026, F-027, F-028, F-033). Tidak menyentuh scope Batch 12+.

- **Aturan penggantian**: setiap `new Date(ts * 1000).toISOString().slice(0, 10)` pada timestamp candle/bar (UTC-naif) diganti helper resmi Jakarta: `formatJakartaDate` (lib/chart-t1-policy.js, `Intl` timeZone `Asia/Jakarta`), `toDateKey` (lib/idx-trading-calendar.js), atau `getJakartaDateFromTimestamp` (api/sector-hot.js, offset +07:00). Bar dengan timestamp >= 17:00 UTC (00:00 WIB keesokan hari) tidak lagi mundur ke hari sebelumnya.
- **F-028 ([`api/sector-hot.js`](api/sector-hot.js:1885))**: `price_date` candle Yahoo Konglo -> `getJakartaDateFromTimestamp(new Date(candles[lastIdx].time * 1000))`.
- **F-004 ([`api/sector-hot.js`](api/sector-hot.js:11060))**: `price_date` jalur Non-Konglo (`fetchNkQuoteData`) -> helper WIB yang sama.
- **F-010 ([`api/sector-hot.js`](api/sector-hot.js:5707))**: tanggal OHLC chart Telegram/Pattern -> `getJakartaDateFromTimestamp(...)`, kini konsisten dengan `/api/candles` (`formatJakartaDate`). Termasuk `price_date` jalur Top 5 ([`:2548`](api/sector-hot.js:2548)).
- **F-026 ([`lib/daily-history-collector.js`](lib/daily-history-collector.js:136))**: `trade_date` yang dipersist ke `stock_daily_history` (`metaDate` + `rowDate`) -> `toDateKey(...)`.
- **F-027 ([`lib/bandarmologi-intel-service.js`](lib/bandarmologi-intel-service.js:389))**: `candleDate` gerbang anti-stale (PR4) di 2 lokasi (`:389`, `:628`) -> `formatJakartaDate(...)`.
- **F-033 (lintas modul)**: label tanggal/cache-key UTC-naif di [`lib/chart-image-renderer.js`](lib/chart-image-renderer.js:150), [`lib/context-ai-router-v7.js`](lib/context-ai-router-v7.js:428), [`lib/bandarmologi-screener-scoring.js`](lib/bandarmologi-screener-scoring.js:151), [`lib/ai-analysis-cache.js`](lib/ai-analysis-cache.js:27) -> `formatJakartaDate(new Date())` / `formatJakartaDate(new Date(ts * 1000))`.
- **SENGAJA TIDAK disentuh** (sudah benar / bukan UTC-naif): `sector-hot.js:2589/2658/3117/3356/3589/3603/3614/7550/8715/9488` (sudah offset WIB +7 jam atau aritmetika date-key UTC-midnight) dan `lib/bandarmologi-service.js:1335` (aritmetika hari pada date-key `T00:00:00Z`).
- **Test regresi baru**: [`test/batch11-utc-naive-date-formatting.test.js`](test/batch11-utc-naive-date-formatting.test.js) (11 subtest) — (a) perilaku: `formatJakartaDate` 01:00 UTC (08:00 WIB) = 18 Sep, 22:00 UTC (05:00 WIB besok) = 19 Sep (potongan UTC naif salah = 18 Sep), `toDateKey` konsisten, `getJakartaDateFromTimestamp` kontrak +07:00; (b) source-level: 7 file produksi tidak lagi memuat pola terlarang dan memakai helper WIB resmi. Didaftarkan di [`tools/curated-build-tests.json`](tools/curated-build-tests.json:2).
- **Gate**: `node --check` bersih pada 7 file sumber + test; `npm test` = **406/406 file lolos, exit 0** (baseline 405 setelah Batch 10 + 1 test baru). CI PR #709 hijau (build-and-focused-tests, security-gate, CodeQL, Analyze JavaScript, portfolio-persistence, command-login, Vercel + admin-hardening).
- **Diff**: 7 file sumber + 1 test baru + `curated-build-tests.json`, +142/-12. Tidak menyentuh scope Batch 12+.

#### Checklist temuan Batch 11 (DIPERBAIKI)

- [x] F-004 | MEDIUM | batch 11 | api/sector-hot.js:11060 - `api/sector-hot.js` Non-Konglo juga menyimpan `price_date` dari potongan UTC naif _(DIPERBAIKI: `getJakartaDateFromTimestamp`)_
- [x] F-010 | MEDIUM | batch 11 | api/sector-hot.js:5707 - Date OHLC chart Telegram/Pattern memakai potongan UTC naif (kembali) _(DIPERBAIKI: `getJakartaDateFromTimestamp`)_
- [x] F-026 | MEDIUM | batch 11 | lib/daily-history-collector.js:149, lib/daily-history-collector.js:136 - `trade_date` yang DIPERSIST ke `stock_daily_history` dihitung dari potongan UTC naif _(DIPERBAIKI: `toDateKey`)_
- [x] F-027 | MEDIUM | batch 11 | lib/bandarmologi-intel-service.js:389, lib/bandarmologi-intel-service.js:628 - Perbandingan kesegaran candle di `bandarmologi-intel-service.js` memakai tanggal UTC-naif → candle segar bisa ditolak sebagai stale _(DIPERBAIKI: `formatJakartaDate`)_
- [x] F-028 | MEDIUM | batch 11 | api/sector-hot.js:1885 - `api/sector-hot.js` menyimpan `price_date` dari potongan UTC naif pada candle Yahoo _(DIPERBAIKI: `getJakartaDateFromTimestamp`)_
- [x] F-033 | MEDIUM | batch 11 | (tanpa lokasi eksplisit) - Label tanggal candle memakai potongan UTC (`toISOString().slice(0,10)`) di banyak modul data _(DIPERBAIKI: 4 modul `chart-image-renderer`/`context-ai-router-v7`/`bandarmologi-screener-scoring`/`ai-analysis-cache` -> `formatJakartaDate`)_

### Batch 12 - SELESAI (PR #711, merge `f8bda0a`) - Panel "Kenapa Sinyal Ini Lolos Gate?" (Ambang + Missing != Pass)

- [x] F-023 | MEDIUM | batch 12 | public/signal-gate-transparency.js:57 - Ambang batas di panel "Kenapa Sinyal Ini Lolos Gate?" TIDAK cocok dengan gate server — menyesatkan user _(DIPERBAIKI: likuiditas DT 3e9 -> 1e9, RSI 35-78 -> 45-70, teks ambang = kode)_
- [x] F-024 | LOW | batch 12 | public/signal-gate-transparency.js:57 - Komentar satuan salah pada ambang likuiditas (`10e9` dilabeli "10M") _(DIPERBAIKI: komentar -> "10 miliar / 1 miliar / 5 miliar")_
- [x] F-084 | MEDIUM | batch 12 | public/signal-gate-transparency.js:87, public/signal-gate-transparency.js:65 - Panel "Kenapa Sinyal Ini Lolos Gate?" menandai gate PASS saat data absen & ambang RSI berbeda dari gate backend _(DIPERBAIKI: tri-state passed true/false/null, data absen -> netral "Data belum tersedia" + unverified, bukan centang hijau)_

Branch `fix/signal-gate-transparency-ui-parity` -> base `feat/daytrade-screener-v1`. Scope = 3 temuan cluster transparansi gate sinyal: F-023 (MEDIUM), F-024 (LOW), F-084 (MEDIUM). Tidak menyentuh scope Batch 13+.

- **F-023 ([`public/signal-gate-transparency.js`](public/signal-gate-transparency.js:65))**: ambang panel "Kenapa Sinyal Ini Lolos Gate?" diselaraskan dengan gate server, bukan nilai indikatif terpisah. Likuiditas Day Trade `3e9` -> `1e9` (sesuai `MIN_VALUE_TODAY` di [`lib/daytrade-screener-engine.js`](lib/daytrade-screener-engine.js:379)); likuiditas tidak lagi lolos dari `liquidity_score >= 12` (proxy frontend tanpa padanan server) — kini murni perbandingan nilai.
- **F-023/F-084 (RSI)**: ambang `rsi <= 78 && rsi >= 35` (teks lama "35 - 75") diganti `rsi >= 45 && rsi <= 70`, persis hard filter [`api/sector-hot.js`](api/sector-hot.js:2135). Teks ambang kini "45 - 70 (Zona Gate Server)" sehingga sama dengan kode. Sinyal RSI 40/72 yang gagal filter backend tidak lagi tampil hijau di panel.
- **F-084 (missing != pass)**: setiap gate sekarang tri-state (`passed: true | false | null`). Metrik `null`/`undefined` -> `passed: null`, teks aktual "Data belum tersedia", status `unverified: true`, dan dirender baris netral `➖` (bukan ✅ hijau). `passedCount` hanya menghitung gate terverifikasi lulus; `allPassed` tidak pernah true bila ada data absen. Fallback menyesatkan dihapus: `'Terkonfirmasi'` (volume), `'Dalam rentang aman'` (RSI), `'Terkalkulasi'` (R/R), `'Memenuhi Universe'` (likuiditas), dan `ma20Passed = true` saat hanya `last_price` tersedia.
- **F-024 (satuan)**: komentar `// 10M Non-Konglo, 3M DT, 5M Konglo` diperbaiki menjadi "10 miliar Non-Konglo, 1 miliar DT, 5 miliar Konglo". `fmtRpCompact(null)` mengembalikan `—`, bukan `-`.
- **Test regresi baru**: [`test/batch12-signal-gate-transparency-parity.test.js`](test/batch12-signal-gate-transparency-parity.test.js) (8 subtest) — (a) data lengkap sesuai ambang lolos semua gate; (b) data di bawah ambang ditolak (`passed:false`); (c) RSI 72 gagal; (d) data kosong -> 0 centang hijau, 5 gate `unverified`, HTML tanpa ✅; (e) sebagian data absen -> hitungan terverifikasi vs netral; (f) paritas ambang likuiditas/volume/RR DT vs swing vs Non-Konglo; (g) source-level komentar satuan + teks RSI; (h) source-level fallback menyesatkan sudah hilang. Didaftarkan di [`tools/curated-build-tests.json`](tools/curated-build-tests.json:2).
- **Gate**: `node --check` bersih pada file sumber + test; `npm test` = **407/407 file lolos, exit 0** (baseline 406 setelah Batch 11 + 1 test baru). CI PR #711 hijau (build-and-focused-tests, security-gate, Analyze JavaScript, CodeQL, command-login, portfolio-persistence, Vercel).
- **Diff**: `public/signal-gate-transparency.js` +56/-39, test baru 141 baris, `curated-build-tests.json` +1. Tidak menyentuh scope Batch 13+.

### Batch 13 - SELESAI (PR #713, merge `6b5cab5`) - CI Gate & Kalender Libur (Coverage Gap + 3 Salinan Kalender + RLS REVOKE)

- [x] F-012 | MEDIUM | batch 13 | tools/run-build-test-suite.js:69 - BUG-002 lama MASIH BELUM DIPERBAIKI — 58 file test tidak pernah dijalankan CI _(DIPERBAIKI: guard `unregistered` di runner + 58 file didaftarkan)_
- [x] F-054 | LOW | batch 13 | lib/idx-trading-calendar.js:9, docs/CHART_T1_DATA_POLICY.md:9 - `lib/idx-trading-calendar.js` mendokumentasikan tabel `idx_trading_calendar` sebagai sumber, tetapi `docs/CHART_T1_DATA_POLICY.md` menyatakan tidak ada kalender libur otoritatif — dua sumber kontradiktif _(DIPERBAIKI: doc menyebut kalender terpelihara 2026 + status belum diverifikasi BEI)_
- [x] F-092 | LOW | batch 13 | supabase/stock-daily-context-migration.sql:154 - Migrasi `stock-daily-context` (dan 7 lain) menyatakan "Deny direct client access" tetapi TIDAK ADA `REVOKE` apa pun — hanya `ENABLE ROW LEVEL SECURITY`; komentar merujuk "konvensi" yang juga tidak melakukannya _(DIPERBAIKI: `REVOKE ALL FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` di 8 migrasi)_
- [x] F-093 | MEDIUM | batch 13 | lib/idx-holidays-2026-seed-data.js:30, tools/backfill-engine.js:46 - Tiga salinan kalender libur IDX 2026 yang saling melenceng dari "single source of truth" — backfill menarik API pada hari libur & melewatkan hari bursa nyata _(DIPERBAIKI: `getSeedHolidaySet()` tunggal; set inline 17-tanggal & 1-tanggal dihapus)_
- [x] F-095 | MEDIUM | batch 13 | tools/run-build-test-suite.js:54 - 58 file `test/*.test.js` tidak ada di daftar CI ter-kurasi → regresi modul berisiko TIDAK ter-gate _(DIPERBAIKI: 58 file direkonsiliasi + didaftarkan; `npm test` 466/466)_

Branch `fix/ci-pipeline-calendar-db-hardening` -> base `feat/daytrade-screener-v1`. Scope = 5 temuan cluster infrastruktur (F-012, F-054, F-092, F-093, F-095). Tidak menyentuh scope Batch 14+.

- **F-012/F-095 (coverage gap CI)**: audit 58 `test/*.test.js` di luar `tools/curated-build-tests.json`. 42 sudah valid & lolos apa adanya; **16 diperbaiki** (assertion yang mengunci perilaku yang sengaja diubah Batch 1-12 + 2 sandbox `vm` kurang `style`); 0 file scratch dihapus (semua menguji modul nyata). Perbaikan utama: `generateDemoData` fabrikasi (Batch 9), literal `+4.5%`/`10150`/`2026-09-11` (Batch 6/10), CR3 denominator `top5×1.75` (F-070), `net_status` prioritas net asing, `verifyStoredCredential`, `slice(0,20)`, label `(Terbaru)`, dan mock-DOM. 5 orphan yang bergantung data gitignored (`data/arjum-data`) dibuat CI-safe (opt-in `VPS_FETCHER_ALLOW_IN_TESTS`, temp `ARJUM_DATA_DIR`, atau skip eksplisit bila data absen).
- **F-012/F-095 (gate)**: [`tools/run-build-test-suite.js`](tools/run-build-test-suite.js:77) gagal (exit 1) pada full suite bila ada `test/*.test.js` tak terdaftar — mencegah regresi "test ditambah tapi tak pernah jalan" berulang. 58 file + 1 test baru didaftarkan ke [`tools/curated-build-tests.json`](tools/curated-build-tests.json:1).
- **F-093 (kalender bursa 2026)**: [`lib/idx-trading-calendar.js`](lib/idx-trading-calendar.js:26) mengekspor `getSeedHolidaySet()` dari `lib/idx-holidays-2026-seed-data.js` (kanonik, 22 tanggal). [`tools/backfill-engine.js`](tools/backfill-engine.js:43) menghapus set inline 17-tanggal yang melenceng (termasuk hantu `2026-05-25`, `2026-03-21`); [`tools/backfill-arjum-data.js`](tools/backfill-arjum-data.js:44) menghapus set inline 1-tanggal (`{08-17}`). Keduanya kini melewati libur nyata (Pancasila `06-01`, 1 Muharam `06-17`) alih-alih membuang request Arjum; loop juga beralih ke UTC agar bebas DST.
- **F-054 (doc)**: [`docs/CHART_T1_DATA_POLICY.md`](docs/CHART_T1_DATA_POLICY.md:9) tidak lagi menyatakan "tidak ada kalender libur otoritatif"; menyebut daftar terpelihara 2026 dengan `verified_at=null` sampai dikonfirmasi ke pengumuman resmi BEI.
- **F-092 (pengerasan migrasi DB)**: 8 migrasi `ENABLE ROW LEVEL SECURITY` tanpa `REVOKE` (stock-daily-context, sector-hot, daytrade-screener, swing-screener, swing-screener-non-konglo, foreign-watchlist-daily, ai-analysis-cache, telegram-daily-picks) diberi `REVOKE ALL ON <tabel> FROM PUBLIC, anon, authenticated;` + `GRANT ALL ON <tabel> TO service_role;` sebagai lapisan kedua (RLS-tanpa-policy tetap dipertahankan).
- **Test regresi baru**: [`test/batch13-ci-calendar-db-hardening.test.js`](test/batch13-ci-calendar-db-hardening.test.js:1) (8 subtest) — (a) setiap `test/*.test.js` terdaftar di curated list & runner punya guard `unregistered`; (b) `getSeedHolidaySet()` == seed kanonik, backfill tools tidak lagi memuat literal melenceng, dan `getTradingDates` melewati `06-01`/`06-17`; (c) setiap migrasi RLS punya `REVOKE` + grant service_role; (d) doc T-1 tidak lagi menyatakan tak ada kalender.
- **Gate**: `node --check` bersih pada semua file tersentuh; `npm test` = **466/466 file lolos, exit 0** (408 -> 466: +58 orphan ter-gate + 1 test baru). CI PR #713 hijau (build-and-focused-tests, security-gate, CodeQL, Analyze JavaScript, command-login, portfolio-persistence, Vercel).
- **Diff**: 8 migrasi + 3 kode (calendar/backfill×2) + 1 doc + 19 file test + `curated-build-tests.json` + `run-build-test-suite.js` + 1 test baru, +471/-152. Tidak menyentuh scope Batch 14+.

### Batch 14A - Pembersihan Dead Code & Fungsi Menggantung [x] SELESAI

Branch `fix/batch-14a-dead-code-cleanup` -> base `feat/daytrade-screener-v1` (PR **#715 merged**; merge `16d1fcb`). Scope = temuan LOW dead code + sisa Batch 2 (F-006/F-057/F-062/F-063) + fungsi menggantung. **Tidak menyentuh** Batch 14B (UI sanitasi/render) maupun 14C (file cleanup non-ticker).

- **F-063 (dead function)**: [`lib/analyze-legacy.js`](lib/analyze-legacy.js:539) - fungsi `geminiSearchNews` (selalu `return null`, tanpa pemanggil) dihapus.
- **F-062 (pesan error sebagai HTML)**: [`lib/analyze-legacy.js`](lib/analyze-legacy.js:636) - `handleChartVision` kini `return null` pada semua cabang gagal (bukan string HTML error), meniru `handleChartDeepSeek`, sehingga pemanggil tidak menandai `provider: 'gemini-vision'` sebagai sukses saat analisis gagal.
- **F-057 (label provider salah)**: [`lib/analyze-legacy.js`](lib/analyze-legacy.js:410) - jalur ticker-mode melacak `tProvider` (`'deepseek'`/`'gemini'`) yang benar-benar menjawab; ternary lama `tHtml ? 'deepseek' : 'gemini-fallback'` selalu bernilai `'deepseek'` (cabang `!tHtml` sudah return lebih dulu).
- **F-077 (fungsi menggantung)**: [`lib/foreign-flow-recap.js`](lib/foreign-flow-recap.js:270) - `sendForeignFlowRecap` memanggil `telegramNotifier.sendTelegramMessage` (ekspor nyata), bukan `sendMessage` yang tidak ada (TypeError laten); `parse_mode: 'HTML'` tetap didukung.
- **F-061 (dead variable)**: [`lib/ai-answer-contract.js`](lib/ai-answer-contract.js:101) - variabel `explicitRatio` yang tidak dipakai di `parseMatchedNumber` dihapus.
- **F-011 (deklarasi ganda)**: [`public/bandarmologi-runtime.js`](public/bandarmologi-runtime.js:807) - `var items` ganda di `buildBrokerBubbleItems` dikurangi jadi 1 deklarasi.
- **F-074/F-075 (ReferenceError + null-guard)**: [`public/stock-analysis-ai.js`](public/stock-analysis-ai.js:393) - referensi `nodeToMove` tak terdeklarasi (ReferenceError yang mematikan enhance Ranking Harian) dihapus; penulisan `card.style.*` dipindah ke dalam guard `if (card)`.
- **F-006 (katalog hardcoded)**: [`lib/context-ai-router-v4.js`](lib/context-ai-router-v4.js:99) - katalog WeizeRouter kini dari `catalogFromEnv()`: override via env `WEIZEROUTER_CATALOG` (comma-separated) dengan satu sumber default `DEFAULT_CATALOG`. Mengubah model yang dilayani provider tidak lagi menuntut edit kode + deploy.
- **F-029 (DITOLAK - false positive)**: [`api/sector-hot.js`](api/sector-hot.js:11644) - klaim "cabang `status === 'Speculative'` dead code" SALAH. Classifier non-konglo ([`:11423`](api/sector-hot.js:11423)/[`:11430`](api/sector-hot.js:11430)) memang meng-emit `status = 'Speculative'`, jadi cabang reachable; menghapusnya akan mengubah perilaku (baris score<30 Speculative flip ke AVOID). **Tidak diubah**; komentar koreksi ditambahkan.
- **Test regresi baru**: [`test/batch14a-dead-code-cleanup.test.js`](test/batch14a-dead-code-cleanup.test.js:1) (9 subtest) mengunci status pasca-fix (F-006/F-011/F-057/F-061/F-062/F-063/F-074/F-075/F-077) + didaftarkan di [`curated-build-tests.json`](tools/curated-build-tests.json:2).
- **Gate**: `node --check` bersih pada semua file tersentuh; `npm test` = **467/467 file lolos** (466 + 1 test baru). CI PR #715 hijau (build-and-focused-tests, security-gate, CodeQL, Analyze JavaScript, ai-eval-regression, command-login, portfolio-persistence, Vercel).
- **Diff**: 6 kode + 1 test baru + `curated-build-tests.json`, +169/-24.

### Batch 14 - LOW: Sapuan Pembersihan (Dead Code, Escaping, Komentar Salah) (40 temuan)

- [ ] F-001 | LOW | batch 14 | api/sector-hot.js:3185 - `deleteOldForeignRows` membaca SEMUA tanggal per ticker tanpa `.limit()`
- [ ] F-003 | MEDIUM | batch 14 | public/bandarmologi-runtime.js:3728 - Tabel "Daftar Pemegang Saham & Insider": persentase yang HILANG dirender "0.00%" (missing disajikan sebagai nol)
- [ ] F-009 | LOW | batch 14 | api/sector-hot.js:5859 - `getRequestBaseUrl` mempercayai `x-forwarded-host`/`host` klien saat membangun URL chart Telegram
- [x] F-011 | LOW | batch 14 | public/bandarmologi-runtime.js:803, public/bandarmologi-runtime.js:874 - Deklarasi `var items` ganda di `buildBrokerBubbleItems` _(DIPERBAIKI Batch 14A: 1 deklarasi)_
- [ ] F-013 | HIGH | batch 14 | tools/run-build-test-suite.js:9 - BUG-013 diperkuat — token review literal yang sama juga di-hardcode di runner build
- [ ] F-014 | LOW | batch 14 | lib/candle-pattern-engine.js:248 - BUG-042 lama SUDAH DIPERBAIKI — Hammer vs Hanging Man kini context-aware _(catatan audit: sudah diperbaiki/bukan bug - verifikasi ulang saat batch)_
- [ ] F-015 | LOW | batch 14 | lib/admin-users-handler.js:261 - BUG-032 lama SUDAH DIPERBAIKI — reset password admin menyimpan kredensial terproteksi _(catatan audit: sudah diperbaiki/bukan bug - verifikasi ulang saat batch)_
- [ ] F-016 | LOW | batch 14 | (tanpa lokasi eksplisit) - `lib/daytrade-screener-engine-v7.js` — TUNTAS, tidak ditemukan bug _(catatan audit: sudah diperbaiki/bukan bug - verifikasi ulang saat batch)_
- [ ] F-018 | LOW | batch 14 | api/quote.js:1484, api/candles.js:294 - BUG-015 lama SUDAH DIPERBAIKI — RSI 0/0 kini dinetralkan ke 50, bukan overbought _(catatan audit: sudah diperbaiki/bukan bug - verifikasi ulang saat batch)_
- [ ] F-020 | MEDIUM | batch 14 | lib/admin-foreign-upload.js:217 - BUG-038 lama MASIH BELUM DIPERBAIKI — retensi foreign flow masih tanpa `.limit()`
- [ ] F-021 | LOW | batch 14 | lib/idx-tick-normalization.js:886 - BUG-027 lama SUDAH DIPERBAIKI — diverifikasi, jangan diulang di batch berikutnya _(catatan audit: sudah diperbaiki/bukan bug - verifikasi ulang saat batch)_
- [ ] F-022 | LOW | batch 14 | api/sector-hot.js:1885 - BUG-022 lama SUDAH DIPERBAIKI — diverifikasi _(catatan audit: sudah diperbaiki/bukan bug - verifikasi ulang saat batch)_
- [ ] F-025 | MEDIUM | batch 14 | public/portfolio-command-center.js:392, public/portfolio-ai-runtime-v2.js:79 - Refresh harga Portfolio tidak menulis metadata kesegaran → AI Portfolio menilai harga dengan umur yang salah
- [~] F-029 | LOW | batch 14 | api/sector-hot.js:11644 - Cabang `status === 'Speculative'` di `deriveSwingLabels` adalah dead code _(DITOLAK Batch 14A: FALSE POSITIVE - classifier non-konglo :11423/:11430 memang meng-emit 'Speculative'; cabang reachable, tidak diubah)_
- [ ] F-034 | MEDIUM | batch 14 | lib/intraday-shadow-scoring.js:51, lib/intraday-collector-vps-audit.js:35 - `lib/intraday-shadow-scoring.js` dan `lib/intraday-collector-vps-audit.js` menyimpan tanggal contoh ter-hardcode
- [ ] F-035 | LOW | batch 14 | public/tmp-measure.html, public/tmp-measure2.html - Aset scratch ter-commit di `public/`: `tmp-measure.html`, `tmp-measure2.html`, `tmp-ci-touch-batch1.js`
- [ ] F-036 | LOW | batch 14 | (tanpa lokasi eksplisit) - `data/arjum-data/broker-summary/` berisi folder ticker non-saham (`AUDITSCALE5D/14D/30D/60D`, `B4TST`, `DBGT4`, `NOACC`)
- [ ] F-048 | MEDIUM | batch 14 | lib/ai-narration-validator.js:164 - Validator anti-angka-rekaan AI melemahkan dirinya sendiri dengan mengecualikan SEMUA angka 0–31 dan 2020–2030
- [ ] F-049 | MEDIUM | batch 14 | api/analyze.js:172 - `api/analyze.js` memanggil `checkUnifiedAiQuota(db, …)` dengan `db` yang bisa `null`
- [ ] F-052 | MEDIUM | batch 14 | lib/corporate-action-price-scale-guard.js:42 - `lib/corporate-action-price-scale-guard.js` memakai median 5-field untuk blokir — bisa false-positive di saham berita
- [ ] F-053 | MEDIUM | batch 14 | lib/latest-price-resolver.js:37 - `isFresh` default jendela 48 jam memungkinkan harga "fresh" sampai 2 hari & tidak membedakan hari bursa
- [ ] F-055 | MEDIUM | batch 14 | (tanpa lokasi eksplisit) - Folder ticker non-saham di data produksi: `data/arjum-data/broker-summary/{AUDITSCALE14D,AUDITSCALE30D,AUDITSCALE5D,AUDITSCALE60D,B4TST,DBGT4,NOACC}`
- [ ] F-060 | LOW | batch 14 | lib/ai-answer-contract.js:187, lib/ai-answer-contract.js:51 - Validasi `direct_answer terlalu panjang` tidak pernah bisa terpicu (dead validation) — terbukti runtime
- [x] F-061 | LOW | batch 14 | lib/ai-answer-contract.js:101 - Variabel `explicitRatio` dihitung tetapi tidak pernah dipakai (dead variable) _(DIPERBAIKI Batch 14A)_
- [ ] F-069 | LOW | batch 14 | lib/idx-tick-normalization.js:981 - Band ARB di-hardcode flat -15% (multiplier 0.85) untuk SEMUA tier harga, sementara ARA bertingkat (35/25/20%); tidak ada test yang mengunci dan tidak ada rujukan aturan di kode
- [ ] F-073 | LOW | batch 14 | public/daytrade-runtime.js:75, api/sector-hot.js:11927 - Statistik "Universe"/"Scanned" memakai fallback hardcoded 760/720 saat meta kosong — angka karangan yang tampil sebagai fakta
- [x] F-074 | MEDIUM | batch 14 | public/stock-analysis-ai.js:400 - `mountRankingCardOnOwnPage()` mereferensikan identifier tak terdeklarasi `nodeToMove` → ReferenceError yang mematikan seluruh enhance Ranking Harian (termasuk banner sesi mixed-date) _(DIPERBAIKI Batch 14A)_
- [x] F-075 | LOW | batch 14 | public/stock-analysis-ai.js:393 - `mountRankingCardOnOwnPage()` menulis `card.style.*` tanpa null-guard meski `card` dijaga `if (card)` beberapa baris sebelumnya _(DIPERBAIKI Batch 14A)_
- [ ] F-076 | MEDIUM | batch 14 | public/market-feature-runtime.js:718, public/market-feature-runtime.js:734 - Blok prompt `[Auto-Cuan Score]` memakai DUA skala berbeda untuk field berlabel sama — server `/25` vs fallback frontend `/30`
- [x] F-077 | LOW | batch 14 | lib/foreign-flow-recap.js:270 - `sendForeignFlowRecap` memanggil `telegramNotifier.sendMessage` yang TIDAK ADA (ekspor hanya `sendTelegramMessage`) — TypeError laten di fungsi tanpa pemanggil _(DIPERBAIKI Batch 14A)_
- [ ] F-079 | LOW | batch 14 | lib/insider-network-service.js:1098 - `getRosterForTicker` merender persentase yang HILANG sebagai "0.00%" (missing disajikan sebagai nol)
- [ ] F-082 | LOW | batch 14 | public/track-record-runtime.js:58 - `track-record-runtime.js` menulis teks error ke `innerHTML` tanpa escaping (dua lokasi)
- [ ] F-083 | LOW | batch 14 | public/portfolio-supabase-sync.js:259 - `pagehideSave` memakai `keepalive:true` dengan seluruh state portofolio (batas ~64KB browser)
- [ ] F-086 | MEDIUM | batch 14 | public/analisis-saham-runtime.js:888, public/index.html:4447 - `analisis-saham-runtime.js` menyuntik HTML jawaban AI ke `innerHTML` TANPA `sanitizeAIHtml` (satu-satunya sink AI yang tidak disanitasi)
- [ ] F-088 | LOW | batch 14 | public/index.html:2410, public/index.html:7214 - `getRelativeDate` masih memakai rumus WIB double-shift yang sudah diperbaiki di `getWIBDateString` _(catatan audit: sudah diperbaiki/bukan bug - verifikasi ulang saat batch)_
- [ ] F-089 | LOW | batch 14 | public/index.html:3531, public/index.html:3766 - `doLogin` mereferensikan `regEmailVal` yang tak terdeklarasi di scope-nya (latent ReferenceError; tertutupi oleh override `auth-v2.js`)
- [ ] F-090 | MEDIUM | batch 14 | public/index.html:3767 - `doRegister` memakai `errorEl` sebelum di-assign → jalur email tidak valid melempar TypeError, bukan pesan validasi
- [ ] F-091 | LOW | batch 14 | public/index.html:4878, public/index.html:4915 - `openNewsFromAnalisis` menyisipkan judul/ringkasan berita mentah ke `innerHTML`, inkonsisten dengan `loadStockNewsPage` yang meng-escape
- [ ] F-096 | LOW | batch 14 | test/intraday-sample-collector.test.js:488 - Satu test vacuous `assert.ok(true)` (placeholder B15) — tidak memverifikasi apa pun
- [ ] F-097 | LOW | batch 14 | security-gate.yml:3, codeql-security.yml:3 - Gate keamanan & regresi di-scope hanya ke branch `feat/daytrade-screener-v1` → PR ke branch lain tidak melewati gate

### Temuan DITARIK (di luar 97 heading)

- [~] Recall volume pace v7 vs level yang dipublikasikan - DITARIK setelah verifikasi ulang = BUKAN bug (lihat `FULL_REPO_BUG_FINDINGS.md`, bagian "DITARIK"). Tidak dihitung dalam 97 heading.

---

## 4. Riwayat Batch

| Batch | Branch | PR | Commit | Status | Catatan |
|---|---|---|---|---|---|
| 0 | `fix/fix-phase-baseline-log` | #687 (merged) | `973c1f6`, `f713d58`, `5b44fab`; merge `4d640ba` | [x] SELESAI | Baseline + log 97 temuan; merge audit `027ea0e` |
| 1 | `fix/unify-latest-price-policy` | #689 (merged) | `076d6a0` | [x] SELESAI | F-050 + F-051; test baru 396/396 |
| 2 | `fix/unify-gemini-model-source` | #691 (merged) | `ce8403a` | [x] SELESAI | 5 temuan model Gemini; test baru 397/397 |
| 3 | `fix/security-hardening-tokens-credentials` | #693 (merged) | `29be320`; merge `0091baa` | [x] SELESAI | F-019/F-037/F-038/F-039/F-094; test baru 398/398 |
| 4 | `fix/telegram-safety-gate-text-limit` | #695 (merged) | `23b5bda` | [x] SELESAI | F-017 (BUG-025); test baru 399/399 |
| 5 | `fix/remove-insider-data-fabrication` | #697 (merged) | `a78dd89` | [x] SELESAI | F-007 + F-041; test baru 400/400 |
| 6 | `fix/remove-hardcoded-date-fallbacks` | #699 (merged) | `fc00dbc`; merge `44abc80` | [x] SELESAI | 12 temuan tanggal literal; test baru 401/401 |
| 7 | `fix/admin-logs-stored-xss` | #701 (merged) | `ee3ce49`; merge `239734c` | [x] SELESAI | F-087; test baru 402/402 |
| 8 | `fix/analyze-legacy-no-fabricated-defaults` | #703 (merged) | `67ee4fb`; merge `650d53c` | [x] SELESAI | F-056; test baru 403/403 |
| 9 | `fix/remove-fabricated-scores-bandarmologi` | #705 (merged) | `cc5199f`; merge `671d1ac` | [x] SELESAI | F-002/F-066/F-067/F-070/F-071; test baru 404/404 |
| 10 | `fix/remove-fabricated-tp-and-backtest-demo-label` | #707 (merged) | `7d25f4c`; merge `71fcb0d` | [x] SELESAI | F-065 + F-085; test baru 405/405 |
| 11 | `fix/utc-naive-date-formatting` | #709 (merged) | `773d945`; merge `d79937e` | [x] SELESAI | 6 temuan UTC naif; test baru 406/406 |
| 12 | `fix/signal-gate-transparency-ui-parity` | #711 (merged) | `c7e57e7`; merge `f8bda0a` | [x] SELESAI | F-023/F-024/F-084; test baru 407/407 |
| 13 | `fix/ci-pipeline-calendar-db-hardening` | #713 (merged) | `a40d955`; merge `6b5cab5` | [x] SELESAI | F-012/F-054/F-092/F-093/F-095; 58 orphan ter-gate; test 466/466 |
| 14A | `fix/batch-14a-dead-code-cleanup` | #715 (merged) | `6878dc9`; merge `16d1fcb` | [x] SELESAI | F-006/F-011/F-057/F-061/F-062/F-063/F-074/F-075/F-077; F-029 DITOLAK (false positive); test 467/467 |

Catatan Batch 0 (di luar temuan, diperlukan agar PR dokumentasi bisa lolos gate):
- [`web-hardening-regression.yml`](.github/workflows/web-hardening-regression.yml:3) ditambah path trigger `**/*.md`. Sebelumnya PR dokumentasi-murni tidak memicu check wajib `build-and-focused-tests`, sehingga ruleset memblokir merge (selalu "expected"). Ini berkaitan dengan temuan LOW #97 (gate ter-scope path/branch) dan **tidak menutup** #97 - #97 tetap dikerjakan di Batch 14.

---

## 5. Protokol Lintas Sesi

1. Baca file ini utuh: batch mana SELESAI, mana BERJALAN, temuan mana sudah/belum ditangani.
2. Baca ulang heading temuan relevan di `FULL_REPO_BUG_FINDINGS.md` sebelum mengerjakan batch.
3. Lanjutkan PERSIS dari titik terakhir; jangan ulang batch yang SELESAI.
4. Kalau context terpotong sebelum log di-update, cek `git log`/`git status`/PR remote untuk memastikan status riil.
