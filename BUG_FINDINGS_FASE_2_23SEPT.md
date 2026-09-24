# BUG FINDINGS — FASE 2 (23 SEPT 2026)

**Mode:** FORENSIC CODE AUDIT & INDEPENDENT VERIFICATION (ZERO-TRUST)
**Repo:** `d:/auto-cuan-2` @ `5e934a56f3be6aeb5c50d663ce3c187e53c56bb8`
**Target:** `lib/corporate-action-price-scale-guard.js`
**Suite pembuktian:** `test/audit-fase2-ca-bugs.test.js`
**Bukti terminal:**
- FAIL (pra-fix): `scratch/fase2-fail-evidence.txt` — **5 FAIL / 3 PASS**
- PASS (pasca-fix, 2 run berturut-turut): `scratch/fase2-pass-evidence-run1.txt`, `scratch/fase2-pass-evidence-run2.txt` — **15 PASS / 0 FAIL** ×2
- Anti-regresi: `scratch/fase2-smoke-suite.txt` (68/68) + `scratch/fase2-full-suite.txt` (519/519)

**Metodologi:** setiap temuan melewati siklus wajib **FAIL → perbaikan minimalis → PASS ×2**. Tanpa siklus ini, temuan tidak diakui (lihat "Hipotesis Ditolak" di bagian akhir).

---

## RINGKASAN TEMUAN

| ID | File | Severity | Status |
|---|---|---|---|
| `BUG-FASE2-001` | `lib/corporate-action-price-scale-guard.js` | **HIGH** | ✅ FIXED & VERIFIED |
| `BUG-FASE2-002` | `lib/corporate-action-price-scale-guard.js` | **MEDIUM** | ✅ FIXED & VERIFIED |
| `H-REJECTED-01..06` | — | — | ❌ REJECTED HYPOTHESIS (dibuktikan bersih) |

---

## BUG-FASE2-001 — Verdict `BLOCKED` yang dipersistensi lintas-run mengunci baris yang sudah diperbaiki (stale-state poisoning)

**Severity:** HIGH
**File & baris:** `lib/corporate-action-price-scale-guard.js:93–124` (fungsi `applyCorporateActionPriceScaleGuard`, pra-fix tidak punya pembersihan verdict lama)
**Jalur terdampak:** `api/sector-hot.js:7513` → `:6050` → 13 call-site guard (termasuk `:4660/:4852/:5119/:5256/:12895/:13115/:14251`)

### Deskripsi masalah & analisis risiko

Guard menulis 12 field verdict saat memblokir (`status`, `final_status`, `display_status`, `data_quality_status`, `data_quality_needs_revalidation`, `is_stale`, `excluded_reason`, `action`, `signal_action`, `action_label`, `signal_action_label`, `telegram_action_label`) — tetapi **tidak pernah membersihkannya** ketika evaluasi berikutnya berbalik `PASSED`.

Masalah ini **bukan teoretis**, karena verdict tersebut round-trip melalui database:

```js
// api/sector-hot.js:7513 — seluruh objek candidate (termasuk verdict guard) disimpan
var row = { ..., raw_payload: candidate };

// api/sector-hot.js:6050 — raw_payload dibaca kembali apa adanya
function rowToDailyPickCandidate(row) {
  var raw = Object.assign({}, row.raw_payload || {});
  ...
  return raw;   // ← masih membawa status:'NEEDS_REVALIDATION', is_stale:true, dst.
}
```

Setelah split 1:5 (mis. 4000 → 800), plan diperbaiki menjadi skala 800. Namun baris yang dibaca dari `raw_payload` lama masih membawa `corporate_action_guard: 'BLOCKED'`, `status: 'NEEDS_REVALIDATION'`, `is_stale: true`, `display_status: 'STALE_LEVEL'`, `excluded_reason: 'price_scale_mismatch'`. Karena `status`/`is_stale` adalah **flag gate lintas subsistem**, baris tersebut tetap tersaring meskipun skala harga sudah benar:

- `api/sector-hot.js:4799` — `if (candidate.is_stale === true || ...) return false;`
- `api/sector-hot.js:5053` — diagnostik `freshness` menangkap `is_stale`
- `api/sector-hot.js:5168`, `:12925`, `:12958`, `:12976` — rangkaian hard-block
- `lib/ai-narration.js:46` — narasi AI menandai pick sebagai stale

**Dampak nyata:** kandidat yang sudah valid pasca perbaikan data **tetap tidak bisa lolos** ke Top 5 / Telegram sampai `raw_payload` ditimpa manual. Ini adalah kegagalan "fail-closed yang permanen" — aman terhadap sinyal buruk, tetapi memblokir sinyal baik secara senyap.

### Bukti uji (test code)

```js
// test/audit-fase2-ca-bugs.test.js — BUG-FASE2-001a
test('BUG-FASE2-001a: re-apply setelah level di-refresh tidak boleh menyisakan verdict BLOCKED lama', () => {
  const row = applyCorporateActionPriceScaleGuard(
    Object.assign(staleBlockedPayload(), refreshedLevels()), { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'PASSED');
  assert.equal(row.status, undefined);          // ← gagal pra-fix
  assert.equal(row.is_stale, undefined);        // ← gagal pra-fix
  assert.equal(row.excluded_reason, undefined); // ← gagal pra-fix
  assert.equal(row.display_status, undefined);
  assert.equal(row.corporate_action_reason, undefined);
  assert.equal(row.stale_level_sample, undefined);
});

// BUG-FASE2-001b — flip-flop BLOCKED → PASSED → BLOCKED
// BUG-FASE2-001c — presisi: is_stale milik subsistem LAIN harus dipertahankan
// BUG-FASE2-001e — rehidrasi raw_payload yang menyimpan verdict BLOCKED
```

### Output terminal FAIL (pra-fix — otentik)

```
✖ BUG-FASE2-001a: re-apply setelah level di-refresh tidak boleh menyisakan verdict BLOCKED lama (3.0715ms)
  AssertionError [ERR_ASSERTION]: status NEEDS_REVALIDATION lama tidak boleh tertinggal
  + actual - expected
  + 'NEEDS_REVALIDATION'
  - undefined

✖ BUG-FASE2-001b: flip-flop BLOCKED -> PASSED -> BLOCKED tetap konsisten (0.5184ms)
  AssertionError: Expected values to be strictly equal:
  + actual - expected
  + true
  - undefined

✖ BUG-FASE2-001e: rehidrasi raw_payload yang menyimpan verdict BLOCKED tidak boleh meracuni baris yang sudah diperbaiki (0.4658ms)
  AssertionError [ERR_ASSERTION]: field verdict lama masih meracuni baris: status
  + actual - expected
  + 'NEEDS_REVALIDATION'
  - undefined

ℹ tests 8
ℹ pass 3
ℹ fail 5
```

### Solusi perbaikan (diff)

```diff
 const COMMON_FACTORS = [2, 3, 4, 5, 10, 20];
+// Verdict yang ditulis guard saat memblokir. Guard fields ikut tersimpan pada
+// raw_payload antar run, jadi saat guard berbalik PASSED verdict lama harus
+// dipulihkan — kalau tidak, baris yang sudah diperbaiki tetap terkunci.
+const GUARD_BLOCK_VERDICTS = [
+  ['status', 'NEEDS_REVALIDATION'], ['final_status', 'NEEDS_REVALIDATION'],
+  ['display_status', 'STALE_LEVEL'], ['data_quality_status', 'NEEDS_REVALIDATION'],
+  ['data_quality_needs_revalidation', true], ['is_stale', true],
+  ['excluded_reason', 'price_scale_mismatch'], ['action', 'NEEDS_REVALIDATION'],
+  ['signal_action', 'NEEDS_REVALIDATION'], ['action_label', 'NEEDS_REVALIDATION'],
+  ['signal_action_label', 'NEEDS_REVALIDATION'], ['telegram_action_label', 'NEEDS_REVALIDATION']
+];
+
+function hasGuardBlockEvidence(row) {
+  return row.corporate_action_guard === 'BLOCKED' ||
+    row.corporate_action_reason === 'price_scale_mismatch' ||
+    row.excluded_reason === 'price_scale_mismatch';
+}
+
+function clearPreviousBlockVerdict(row) {
+  if (!hasGuardBlockEvidence(row)) return;
+  for (const pair of GUARD_BLOCK_VERDICTS) {
+    if (row[pair[0]] === pair[1]) delete row[pair[0]];
+  }
+  delete row.corporate_action_reason;
+  delete row.stale_level_sample;
+}

 function applyCorporateActionPriceScaleGuard(candidate, context) {
   const row = candidate || {};
+  // Guard bisa dievaluasi ulang atas objek yang sama (mis. raw_payload yang
+  // menyimpan verdict BLOCKED dari run sebelumnya). Verdict lama dibersihkan
+  // lebih dulu agar hasil selalu mencerminkan evaluasi saat ini.
+  clearPreviousBlockVerdict(row);
   const latestPrice = typeof context === 'number' ? context : (...);
```

**Dua keputusan presisi yang penting:**

1. **Gerbang bukti (`hasGuardBlockEvidence`).** Pembersihan hanya dijalankan bila baris benar-benar membawa jejak blokir guard (`corporate_action_guard: 'BLOCKED'` / `corporate_action_reason: 'price_scale_mismatch'` / `excluded_reason: 'price_scale_mismatch'`). Tanpa gerbang ini, `is_stale: true` milik subsistem lain (freshness, trade-plan-v2) akan **ikut terhapus** — itu regresi baru. Test `BUG-FASE2-001c` mengunci perilaku ini.
2. **Penghapusan nilai, bukan penulisan `false`.** Field yang tidak cocok nilai blokir guard dibiarkan utuh; hanya nilai yang persis ditulis guard (`===` untuk string, `true` untuk boolean) yang dihapus. Ini mencegah guard menimpa sinyal subsistem lain dengan nilai netral palsu.

### Output terminal PASS (pasca-fix — 2 run berturut-turut)

```
✔ BUG-FASE2-001a: re-apply setelah level di-refresh tidak boleh menyisakan verdict BLOCKED lama (2.5757ms)
✔ BUG-FASE2-001b: flip-flop BLOCKED -> PASSED -> BLOCKED tetap konsisten (0.651ms)
✔ BUG-FASE2-001c: sinyal stale dari sumber LAIN tidak boleh dihapus (presisi pembersihan) (3.12ms)
✔ BUG-FASE2-001d: kontrak verdict BLOCKED tidak berubah (tanpa regresi) (0.8411ms)
✔ BUG-FASE2-001e: rehidrasi raw_payload yang menyimpan verdict BLOCKED tidak boleh meracuni baris yang sudah diperbaiki (0.489ms)
...
ℹ tests 15
ℹ pass 15
ℹ fail 0
```

---

## BUG-FASE2-002 — Koersi tipe `Number()` mengubah sampah (boolean/array) menjadi harga palsu

**Severity:** MEDIUM
**File & baris:** `lib/corporate-action-price-scale-guard.js:15` (pra-fix: `function positiveNumber(value) { const n = Number(value); ... }`)
**Dipakai oleh:** `resolveLatestPrice()` (`:21–29`) dan pemetaan `ACTIONABLE_PRICE_FIELDS` (`:36`)

### Deskripsi masalah & analisis risiko

`Number()` melakukan koersi yang tidak diinginkan pada dua tipe:

| Input | `Number(input)` | Efek pada guard |
|---|---|---|
| `true` | `1` | Field `entry: true` dianggap harga **1** → `ratio = 1/800 = 0.00125` → `criticalFar` → **BLOCKED palsu** |
| `[4000]` | `4000` | Field `entry: [4000]` dianggap harga **4000** → memicu blokir yang tidak berdasar |

Konteks nyata: `raw_payload` adalah kolom **JSONB** (`supabase/telegram-daily-picks-migration.sql`), dan guard juga berjalan atas objek hasil normalisasi pipeline (`api/sector-hot.js:5393–5428`). Nilai boolean/array pada field harga adalah **cacat data**, bukan harga. Dua akibat berbeda:

1. **False positive** (`entry: true`) → baris sehat diblokir permanen sebagai `STALE_LEVEL`; digabung dengan `BUG-FASE2-001`, blokir ini bahkan tidak bisa dipulihkan sendiri.
2. **False negative / diagnostik menyesatkan** → penyebabnya dilaporkan sebagai `price_scale_mismatch` (diduga split), padahal masalahnya adalah tipe data rusak. Operator akan mencari aksi korporasi yang tidak pernah ada.

### Bukti uji (test code)

```js
// test/audit-fase2-ca-bugs.test.js — BUG-FASE2-002a
test('BUG-FASE2-002a: boolean sampah tidak boleh diperlakukan sebagai harga 1', () => {
  const result = detectPriceScaleMismatch(
    { entry: true, stop_loss: 780, tp1: 880, support: 790, resistance: 900, latest_price: 800 }, 800);
  assert.equal(result.blocked, false, 'entry:true bukan harga 1 — tidak boleh memicu price_scale_mismatch');
});

// BUG-FASE2-002b — entry: [4000] bukan harga 4000
// BUG-FASE2-002c — string numerik '4000' HARUS tetap diterima (anti-over-fix)
```

### Output terminal FAIL (pra-fix — otentik)

```
✖ BUG-FASE2-002a: boolean sampah tidak boleh diperlakukan sebagai harga 1 (0.3004ms)
  AssertionError [ERR_ASSERTION]: entry:true bukan harga 1 — tidak boleh memicu price_scale_mismatch
  true !== false

✖ BUG-FASE2-002b: array satu elemen tidak boleh diperlakukan sebagai harga (0.2938ms)
  AssertionError [ERR_ASSERTION]: entry:[4000] bukan harga 4000
  true !== false
```

### Solusi perbaikan (diff)

```diff
-function positiveNumber(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }
+// Hanya nilai numerik/string numerik yang sah sebagai harga. Boolean dan array
+// adalah sampah tipe: Number(true) === 1 dan Number([4000]) === 4000 akan
+// menciptakan rasio palsu yang bisa memblokir/meloloskan baris secara keliru.
+function positiveNumber(value) {
+  if (typeof value === 'boolean' || Array.isArray(value)) return null;
+  const n = Number(value);
+  return Number.isFinite(n) && n > 0 ? n : null;
+}
```

**Mengapa hanya dua tipe ini?** `Number()` yang sah diperlukan untuk string numerik, karena kolom `NUMERIC` dari PostgREST dapat tiba sebagai string dan `raw_payload` JSONB menyimpan campuran angka/string. `null`, `undefined`, `NaN`, `Infinity`, dan `''` sudah ditangani oleh `Number.isFinite(n) && n > 0`. `Date`/objek lain tidak dipakai sebagai field harga di pipeline mana pun (diverifikasi via pemetaan 13 call-site). Test `BUG-FASE2-002c` mengunci bahwa `'4000'` **tetap** valid sehingga split 1:5 masih terdeteksi — mencegah perbaikan berlebihan.

### Output terminal PASS (pasca-fix)

```
✔ BUG-FASE2-002a: boolean sampah tidak boleh diperlakukan sebagai harga 1 (0.2536ms)
✔ BUG-FASE2-002b: array satu elemen tidak boleh diperlakukan sebagai harga (0.2504ms)
✔ BUG-FASE2-002c: string numerik tetap diterima sehingga split 1:5 tetap terdeteksi (0.2874ms)
```

---

## HIPOTESIS DITOLAK (DIBUKTIKAN BERSIH — TIDAK DIPERBAIKI)

Sesuai prinsip ZERO-TRUST, hipotesis yang **tidak lolos siklus FAIL** tidak diakui sebagai bug. Berikut hipotesis yang saya uji dan **tolak dengan bukti** — penting dicatat agar tidak diaudit ulang tanpa alasan:

### H-REJECTED-01 — Timezone / off-by-one cum-date vs ex-date

**Klaim:** guard rentan perbedaan UTC vs Asia/Jakarta pada tanggal efektif.
**Bukti penolakan:** pencarian token `Date`, `toISOString`, `getTime`, `timezone`, `jakarta`, `cum`, `ex_date`, `ex-date`, `WIB`, `UTC` pada sumber → **0 kemunculan** (satu-satunya match `Date` berasal dari substring kata `candidate`). Guard bekerja **murni** pada rasio harga vs `latestPrice`; tidak ada konsep tanggal sama sekali. Tanggal efektif ditangani subsistem lain (`api/sector-hot.js:3520–3566`, `attachPriceFreshness`), di luar file target.

### H-REJECTED-02 — Volume tidak disesuaikan terbalik (Price × Ratio, Volume / Ratio)

**Klaim:** volume tidak dikoreksi saat split.
**Bukti penolakan:** `grep volume` pada sumber → **0 kemunculan**. Guard adalah **gerbang penolakan**, bukan mesin adjustment harga. Ia tidak mengubah harga maupun volume; ia hanya menandai baris `NEEDS_REVALIDATION` agar plan di-refresh manual. Tidak ada ketidakkonsistenan nilai transaksi yang bisa ditimbulkan oleh file ini. (Perlu dicatat: tidak ada modul auto-adjust split di repo — diverifikasi via pemindaian `lib/` dan `api/`.)

### H-REJECTED-03 — Hasil adjustment tidak di-tick-normalize ke fraksi IDX

**Klaim:** presisi harga keluar dari fraksi tick IDX yang sah.
**Bukti penolakan:** `grep tick|fraction` pada sumber → **0 kemunculan**. Guard tidak pernah menghasilkan harga baru. Normalisasi tick dilakukan **upstream** oleh `lib/idx-tick-normalization.js` (`normalizeTradingPlanLevels`) yang dipanggil di `api/sector-hot.js:5406` — **sebelum** guard di `:5407`. Karena guard tidak menulis level, tidak ada jalur yang bisa melewati normalisasi tick.

### H-REJECTED-04 — Presisi floating point / rasio batas anomali

**Klaim:** split 1:2, 1:3, 1:4, 1:5, 1:10, 1:20, atau reverse split gagal terdeteksi karena presisi float atau ambang rasio.
**Bukti penolakan:** uji empiris 15 kombinasi — split 1:2/1:3/1:4/1:5/1:8/1:10/1:20/1:25 dan reverse split 2:1/3:1/4:1/5:1/10:1/20:1/25:1 — **semuanya `blocked: true`**, termasuk 1:8 dan 1:25 yang di luar `COMMON_FACTORS` (tertangkap cabang `ratio > 2.2` / `ratio < 0.45`). `suspected_price_scale_ratio` eksak (3, 5, 10, 20, 0.2, 0.05, …). Tidak ada anomali batas.

### H-REJECTED-05 — Pembagian dengan rasio 0 / undefined / null

**Klaim:** `latestPrice` 0/negatif/null/NaN/Infinity menyebabkan crash atau blokir salah.
**Bukti penolakan:** keenam nilai menghasilkan `latest_price_missing` dengan `blocked: false` — fail-open yang benar (tidak ada harga referensi = tidak ada dasar memblokir), tanpa exception.

### H-REJECTED-06 — Median menutupi level kritis stale; single level lolos guard

**Klaim (a):** campuran level (sebagian skala lama, sebagian skala benar) meloloskan median.
**Bukti penolakan (a):** `criticalFar` (`:45`) memeriksa **setiap** field kritis secara individual dengan ambang lebih longgar (`≥1.8` / `≤0.55` / `nearSplitFactor`), independen dari median. Uji `entry` ratio 4 + `tp1` ratio 1 → **`blocked: true`** meski median = 1.06.
**Klaim (b):** hanya satu level actionable (mis. hanya `entry`) → `enoughEvidence` gagal → lolos.
**Bukti penolakan (b):** `criticalFar` tidak memerlukan `enoughEvidence`. Uji `{entry: 4000}` @ latest 800 → **`blocked: true`**; `{stop_loss: 3800}` → **`blocked: true`**.

---

## CATATAN RISIKO SISA (BUKAN BUG — TIDAK DIUBAH)

**R-01 — Crash wajar/ARB beruntun >40% dapat memicu `BLOCKED`.** Harga turun wajar (mis. 1000 → 600, ratio 1.667) dengan level plan lama → `BLOCKED`. Ini **fail-safe by design** (lebih baik menahan daripada mengeksekusi level usang), dan pesan `NEEDS_REVALIDATION` adalah instruksi yang tepat. Ambang tidak diubah karena menyentuh ambang = mengubah perilaku gate produksi (di luar mandat perbaikan minimalis). Dengan `BUG-FASE2-001` diperbaiki, baris ini sekarang **bisa pulih otomatis** begitu plan di-refresh — sebelumnya terkunci permanen.

**R-02 — `NOT_EVALUATED` untuk `insufficient_actionable_levels`.** Baris tanpa level plan sama sekali menghasilkan `NOT_EVALUATED`. Benar secara semantik; tidak menyentuh gate mana pun.

**R-03 — Urutan `LATEST_PRICE_FIELDS`.** `context.latestPrice` eksplisit menang, lalu `latest_price` → `current_price` → `last_price` → `price` → `close_price` → `close`. Skema DB hanya menyediakan `last_price` untuk ketiga tabel screener (diverifikasi di `supabase/swing-screener-migration.sql`, `supabase/daytrade-screener-migration.sql`, `supabase/swing-screener-non-konglo.sql`), sehingga urutan ini tidak menimbulkan bug terukur.

---

## VERIFIKASI ANTI-REGRESI

| Suite | Perintah | Hasil |
|---|---|---|
| Test target + test lama guard | `node --test test/audit-fase2-ca-bugs.test.js test/corporate-action-price-scale-guard.test.js` | **15/15 PASS** ×2 berturut-turut |
| Konsumen guard downstream | `node --test test/top5-progress-monitor.test.js test/smart-setup-labels.test.js test/reversal-breakout-lifecycle.test.js test/daytrade-screener-v1-release-gate.test.js test/audit-fase1-price-bugs.test.js` | **49/49 PASS** |
| Gate & kualitas data | `node --test test/audit-regresi-batch3-guards.test.js test/batch12-signal-gate-transparency-parity.test.js test/data-quality-hygiene.test.js` | **25/25 PASS** |
| Smoke build suite | `node tools/run-build-test-suite.js` | **68/68 file PASS** |
| Full curated suite | `node tools/run-build-test-suite.js --full` | **519/519 file PASS** |
| Integritas curated list | Semua `test/*.test.js` di disk vs `tools/curated-build-tests.json` | **519 terdaftar, 0 unregistered** |
| Syntax check | `node --check lib/corporate-action-price-scale-guard.js` | ✅ bersih |

**Kesimpulan:** 2 bug terkonfirmasi (HIGH + MEDIUM) diperbaiki dengan total `+38 / −1` baris (90 → 127) tanpa penghapusan logika; 6 hipotesis ditolak dengan bukti empiris; 3 risiko sisa didokumentasikan tanpa mengubah perilaku gate produksi. Tidak ada regresi pada 519 file test.
