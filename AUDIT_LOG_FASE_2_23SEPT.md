# AUDIT LOG — FASE 2 (23 SEPT 2026)

**Mode:** FORENSIC CODE AUDIT & INDEPENDENT VERIFICATION (ZERO-TRUST)
**Repo:** `d:/auto-cuan-2` @ `5e934a56f3be6aeb5c50d663ce3c187e53c56bb8`
**Target:** `lib/corporate-action-price-scale-guard.js` (90 baris pra-fix → 127 baris pasca-fix; diff `+38 / −1`)
**Suite pembuktian:** `test/audit-fase2-ca-bugs.test.js`
**Status:** ✅ FASE 2 TUNTAS — 2 bug terkonfirmasi diperbaiki & diverifikasi

---

## 1. RINGKASAN EKSEKUTIF

| Metrik | Nilai |
|---|---|
| File target diaudit | 1 (`lib/corporate-action-price-scale-guard.js`) |
| Baris dibaca | 89 / 89 (100%) |
| Call-site produksi dipetakan | 13 pemanggilan `applyCorporateActionPriceScaleGuard()` di `api/sector-hot.js` + 8 pemeriksaan `corporate_action_guard === 'BLOCKED'` + 4 konsumen downstream |
| Hipotesis diuji | 11 |
| Bug terkonfirmasi (FAIL→PASS) | **2** (`BUG-FASE2-001`, `BUG-FASE2-002`) |
| Hipotesis ditolak (dibuktikan bersih) | 6 |
| Temuan risiko sisa (didokumentasikan) | 3 |
| Bukti FAIL pra-fix | `scratch/fase2-fail-evidence.txt` — **5 FAIL / 3 PASS** |
| Bukti PASS pasca-fix | `scratch/fase2-pass-evidence-run1.txt`, `scratch/fase2-pass-evidence-run2.txt` — **15 PASS / 0 FAIL** ×2 |
| Regresi smoke suite | `scratch/fase2-smoke-suite.txt` — **68/68 file PASS** |
| Regresi full suite | `scratch/fase2-full-suite.txt` — **519/519 file PASS** |
| Registrasi curated | `test/audit-fase2-ca-bugs.test.js` ✅ ditambahkan |

---

## 2. METODOLOGI (ZERO-TRUST)

1. **Baca utuh** file target baris-per-baris; tidak mengandalkan ringkasan historis.
2. **Petakan blast radius**: seluruh **13** call-site `applyCorporateActionPriceScaleGuard()` di `api/sector-hot.js` (dihitung via `scratch/fase2-counts.js`) diperiksa, plus 8 pemeriksaan flag `corporate_action_guard === 'BLOCKED'` di file yang sama dan 4 konsumen downstream (`lib/daytrade-screener-engine.js:1703`, `lib/reversal-breakout-lifecycle.js:98`, `lib/smart-setup-labels.js:48`, `lib/top5-progress-monitor.js:61`).
3. **Reproduksi empiris**: probe skrip (`scratch/fase2-ca-probe.js`, `scratch/fase2-hypothesis-check.js`) memindai 11 skenario (split 1:2…1:25, reverse split 2:1…25:1, ARB beruntun, dividen, garbage tipe, boundary rasio).
4. **Test-first**: setiap bug harus **FAIL dulu** di `test/audit-fase2-ca-bugs.test.js` terhadap kode pra-fix (dibuktikan via `git stash`), baru diperbaiki.
5. **Verifikasi berurutan**: PASS 2× berturut-turut wajib sebelum menutup temuan.
6. **Anti-regresi**: full curated suite 519 file dijalankan setelah perbaikan.

---

## 3. PETA ARSITEKTUR GUARD (Fakta Hasil Pembacaan)

**Alur data nyata:**

```
DB (swing_screener_latest / swing_screener_non_konglo_latest / daytrade_screener_latest)
  → normalizeCombinedCandidate()            [api/sector-hot.js:5393]
      ├─ idxTick.normalizeTradingPlanLevels() [:5406]
      └─ corporateActionGuard.applyCorporateActionPriceScaleGuard(r, {latestPrice}) [:5407]
  → candidatePassesTelegramCandidateDigestGate() / ...Top5Gate() / ...DayTradeFinalGate()
      └─ applyCorporateActionPriceScaleGuard(candidate) ulang  [:4660, :4852, :5119, :5256, :12895, :13115, :14251]
  → handleKongloScreener / handleNkScreener / handleDayTradePublicRead / monitor
      └─ applyCorporateActionPriceScaleGuard(r)            [:587, :2733, :2742, :10743, :12065]
  → dailyPickInsertRowFromCandidate()       [api/sector-hot.js:7513]
      └─ raw_payload: candidate   ← SELURUH objek, termasuk verdict guard, dipersistensi
  → rowToDailyPickCandidate()               [api/sector-hot.js:6050]
      └─ raw_payload dibaca kembali → guard dievaluasi ulang atas objek yang sama
```

**Temuan kunci dari pemetaan ini:** verdict guard **round-trip melalui DB**. Baris `7513` menyimpan `raw_payload: candidate` (objek penuh), dan baris `6050` membacanya kembali dengan `Object.assign({}, row.raw_payload || {})`. Artinya `status: 'NEEDS_REVALIDATION'`, `is_stale: true`, `display_status: 'STALE_LEVEL'`, `excluded_reason: 'price_scale_mismatch'` **persisten lintas run**, dan guard akan dievaluasi ulang di atas objek yang sudah membawa verdict run sebelumnya. Ini yang menjadikan `BUG-FASE2-001` nyata, bukan teoretis.

**Kontrak guard yang terverifikasi (tidak berubah):**
- Input: `candidate` (objek) + `context` (number | `{latestPrice|latest_price}`).
- Output: mutasi objek + `corporate_action_guard ∈ {BLOCKED, NOT_EVALUATED, PASSED}`.
- Ambang: `farMedian = ratio > 1.8 || ratio < 0.55`; blokir jika `(≥2 level && farMedian && (commonScale || ratio > 2.2 || ratio < 0.45))` ATAU ada field kritis jauh (`criticalFar`).

---

## 4. HIPOTESIS YANG DIUJI

| # | Hipotesis | Metode | Hasil |
|---|---|---|---|
| H1 | Guard punya logika tanggal/timezone (cum-date vs ex-date, off-by-one WIB/UTC) | Analisis token + grep `Date/toISOString/getTime/timezone/jakarta/cum/ex_date/WIB/UTC` | ❌ **BERSIH** — 0 logika waktu. Guard murni rasio harga. |
| H2 | Volume tidak disesuaikan terbalik terhadap harga | Analisis sumber | ❌ **BERSIH** — guard tidak menyentuh volume (0 kemunculan `volume`). Guard hanya *memblokir*, tidak meng-adjust. |
| H3 | Hasil adjustment tidak di-tick-normalize ke fraksi IDX | Analisis sumber | ❌ **BERSIH** — guard tidak mengubah level; normalisasi tick dilakukan upstream (`lib/idx-tick-normalization.js`, dipanggil di `:5406` sebelum guard). |
| H4 | Presisi float merusak deteksi split | Uji 1:3 (3000→1000), 1:8, 1:25, 25:1 | ❌ **BERSIH** — semua terblokir benar; `suspected_price_scale_ratio` eksak. |
| H5 | Rasio 0 / negatif / null / NaN / Infinity crash atau salah blokir | Uji 6 nilai `latestPrice` | ❌ **BERSIH** — semua → `latest_price_missing`, tanpa crash. |
| H6 | Split/reverse-split di luar `COMMON_FACTORS` lolos deteksi | Uji 1:8, 1:25, 25:1 | ❌ **BERSIH** — terblokir via cabang `ratio > 2.2` / `ratio < 0.45`. |
| H7 | Crash wajar / ARB beruntun salah dituduh stock split | Uji penurunan −30%…−60% | ⚠️ **RISIKO SISA R-01** (bukan bug — lihat §6) |
| H8 | Median rasio menutupi level kritis yang stale | Uji campuran ratio 4 + ratio 1 | ❌ **BERSIH** — `criticalFar` menangkap entry stale meski median normal. |
| H9 | Verdict BLOCKED persisten menghalangi baris yang sudah diperbaiki (stale state) | Uji re-apply + rehidrasi `raw_payload` | ✅ **BUG TERKONFIRMASI — `BUG-FASE2-001`** |
| H10 | `Number()` mengubah sampah tipe (boolean/array) menjadi harga palsu | Uji `entry: true`, `entry: [4000]` | ✅ **BUG TERKONFIRMASI — `BUG-FASE2-002`** |
| H11 | Single actionable level (hanya `entry`/`sl`) melewati guard | Uji `{entry:4000}`, `{stop_loss:3800}` | ❌ **BERSIH** — `criticalFar` memblokir tanpa syarat `enoughEvidence`. |

---

## 5. TIMELINE EKSEKUSI

| Waktu (UTC) | Aksi | Hasil |
|---|---|---|
| 10:42 | Baca utuh `lib/corporate-action-price-scale-guard.js` (89 baris konten / 90 baris file) | Selesai |
| 10:43 | Jalankan test lama `test/corporate-action-price-scale-guard.test.js` | 7/7 PASS (baseline hijau) |
| 10:43–10:58 | Pemetaan 13 call-site + 8 pemeriksaan BLOCKED + 4 konsumen downstream + skema DB (`supabase/*.sql`) | Selesai |
| 10:46 | Probe empiris 11 skenario (`scratch/fase2-ca-probe.js`) | 2 anomali teridentifikasi |
| 11:01 | Tulis `test/audit-fase2-ca-bugs.test.js` (8 test) | Dibuat |
| 11:01 | **Run FAIL pra-fix** → `scratch/fase2-fail-evidence.txt` | **5 FAIL / 3 PASS** ✅ bukti |
| 11:02 | Perbaikan minimalis `lib/corporate-action-price-scale-guard.js` (`+38 / −1` baris, 90 → 127) | Selesai |
| 11:03 | **Run PASS #1** → `scratch/fase2-pass-evidence-run1.txt` | **15 PASS / 0 FAIL** |
| 11:03 | **Run PASS #2** → `scratch/fase2-pass-evidence-run2.txt` | **15 PASS / 0 FAIL** |
| 11:03 | Registrasi `test/audit-fase2-ca-bugs.test.js` ke `tools/curated-build-tests.json` | Selesai |
| 11:04 | Smoke suite (`tools/run-build-test-suite.js`) | **68/68 file PASS** |
| 11:06 | Full suite (`--full`, 519 file) | **519/519 file PASS** |

---

## 6. RISIKO SISA (DIDOKUMENTASIKAN, TIDAK DIPERBAIKI — BUKAN BUG)

**R-01 — False positive ARB beruntun.** Harga jatuh wajar >40% (mis. 1000→600) dengan level plan lama yang belum di-refresh akan menghasilkan `ratio = 1.667` → **BLOCKED**. Secara desain ini **fail-safe** (lebih baik menahan sinyal daripada mengeksekusi level usang), dan pesan `NEEDS_REVALIDATION` memang instruksi yang tepat. Namun operasional perlu tahu: crash tajam berturut-turut akan menandai baris sebagai `STALE_LEVEL` sampai plan di-refresh. Batas −30% (`ratio 1.429`) masih lolos. Tidak diubah karena mengubah ambang = mengubah perilaku gate produksi (di luar mandat perbaikan minimalis).

**R-02 — `NOT_EVALUATED` untuk `insufficient_actionable_levels`.** Baris tanpa level plan sama sekali menghasilkan `corporate_action_guard = 'NOT_EVALUATED'`. Ini perilaku pra-existing yang benar secara semantik (tidak ada yang dievaluasi) dan tidak menyentuh gate mana pun; dicatat sebagai observasi, bukan bug.

**R-03 — Prioritas `LATEST_PRICE_FIELDS` vs context.** `resolveLatestPrice` mendahulukan `context.latestPrice` eksplisit, lalu `latest_price` → `current_price` → `last_price` → `price` → `close_price` → `close`. Skema DB (`swing_screener_latest`, `daytrade_screener_latest`, `swing_screener_non_konglo_latest`) hanya menyediakan `last_price`; alias lain praktis tidak muncul dari screener, dan `context.latestPrice` menang di jalur `:5407`. Urutan ini **tidak menimbulkan bug terukur**; dicatat untuk transparansi kontrak.

---

## 7. DELIVERABLE

| Artefak | Status |
|---|---|
| `test/audit-fase2-ca-bugs.test.js` (8 test) | ✅ dibuat, terdaftar di curated list |
| `lib/corporate-action-price-scale-guard.js` (`+38 / −1`, 0 penghapusan logika) | ✅ diperbaiki |
| `tools/curated-build-tests.json` | ✅ diperbarui (baris 39) |
| `scratch/fase2-fail-evidence.txt` | ✅ bukti FAIL pra-fix |
| `scratch/fase2-pass-evidence-run1.txt`, `run2.txt` | ✅ bukti PASS ×2 |
| `scratch/fase2-smoke-suite.txt`, `scratch/fase2-full-suite.txt` | ✅ bukti anti-regresi |
| `BUG_FINDINGS_FASE_2_23SEPT.md` | ✅ laporan temuan |

**Kesimpulan:** dari 11 hipotesis, 2 terkonfirmasi sebagai bug nyata dengan siklus FAIL→PASS lengkap (`+38 / −1` baris); 6 hipotesis ditolak dengan bukti; 3 risiko sisa didokumentasikan tanpa mengubah perilaku gate produksi. Tidak ada regresi pada 519 file test.
