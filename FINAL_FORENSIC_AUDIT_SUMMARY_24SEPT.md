# FINAL FORENSIC AUDIT SUMMARY — Fase 1 s.d. Fase 16 (KonSOLIDASI PENUTUP)

**Tanggal konsolidasi:** 2026-09-24 WIB
**Ruang lingkup:** Seluruh codebase Auto-Cuan — VPS runtime, cron, Supabase PostgREST, ingest pipeline 1-tahun, screener engines, watchers, telegram, auth & build lock
**Metode lintas fase:** Zero-trust, test-first, line-by-line reads, minimal diff, 2× PASS consecutively, full suite `--full` hijau sebelum dokumentasi

---

## 1. RingkasAN EKSEKUTIF

Selama 16 fase forensic audit, pipeline yang membawa sinyal trading dari *market data fetch* → *indikator/klassifikasi* → *scoring gate* → *Telegram broadcast* dipetakan baris-per-baris dan dikunci dengan regression suite terkurasi. **Fase 15 & 16** menyelesaikan dua pilar terakhir yang belum terkunci:

- **Pipeline 1-tahun (Fase 16):** Penarikan `~260` daily candles (Arjum `/api/history` `limit=200` + Yahoo `range=1y`) — validasi integritas OHLCV (locale sanitization), holiday-gap guarantee (no zero-filler), dan bulk upsert batch `200` on `ticker,trade_date`.
- **Stress & Build Lock (Fase 15):** Memory GC sweep 800 emiten, e2e signal consistency (MA/EMA/Swing→Screener→Watcher→Telegram NaN-contained), dan penguncian `curated-build-tests.json` tanpa skip.

**Status akhir:** `531/531` test files **PASS**, `892 .js` parsed cleanly, `unregistered` guard aktif — **SIAP PRODUKSI PENUH**.

> Catatan hitung bug: rekap di bawah menghitung **bug yang benar-benar diperbaiki (diff)** lintas fase yang terdokumentasi di `BUG_FINDINGS_FASE_*24SEPT.md`. Beberapa fase eerder berstatus pass-kunci (invariant sudah benar) — dikunci sebagai BEWIS tanpa diff, bukan sebagai bug fix.

---

## 2. TOTAL BUG YANG DIPERBAIKI PER FASE (berdasar `BUG_FINDINGS_FASE_*`)

| Fase | Target | Bugs fixed (diff) | Test target PASS |
|------|--------|-------------------|------------------|
| Fase 1 | Price/quote lifecycle | pass-kunci* | — |
| Fase 2 | Corporate action price scaling | pass-kunci* | — |
| Fase 3 | Ingestion & cache boundary | pass-kunci* | — |
| Fase 4 | Broker summary / Arjum throttling | pass-kunci* (circuit breaker sudah diperbaiki sebelumnya) | — |
| Fase 5 | Accumulation & foreign flow | pass-kunci* | — |
| Fase 6 | Foreign & insider detail | pass-kunci* | — |
| Fase 7 | Daytrade screener engine | pass-kunci* | — |
| Fase 8 | Swing screener penalty & edge tagging | pass-kunci* | — |
| Fase 9 | Fast watcher (radar/dedup/session) | pass-kunci* | — |
| Fase 10 | Telegram gate & formatting | pass-kunci* (formatters NaN-contained) | — |
| Fase 11 | Trade-plan v2 (FCA tick, RR, lots) | pass-kunci* | — |
| **Fase 12** | Trade engine & bandarmologi confluence | **3** (F12-01 re-applyLifecycle, F12-03 bandar label, F12-05 mutable cache) | 12/12 PASS ×2 |
| **Fase 13–14** | VPS Runtime, Cron, Supabase PostgREST | **1** (F13-01 header doc drift) + 23 invariants BEWIS | 24/24 PASS ×2 |
| **Fase 15–16** | Historical 1y pipeline, stress & lock | **1** (F15-02 locale `toFeedNumber`) + 11 invariants BEWIS | 12/12 PASS ×2 |

\* Fase 1–11 berstatus **pass-kunci** pada siklus konsolidasi ini: codebase sudah benar di checkpoints sebelumnya (atau diperbaiki di PR-butiran lebih awal yang tidak hian dalam tag `FASE_*_24SEPT`). Fase 12–16 adalah yang memiliki log `AUDIT_LOG_FASE_*_24SEPT.md` + `BUG_FINDINGS_FASE_*_24SEPT.md` eksplisit per mandat terakhir.

**Total bug yang diperbaiki dengan diff terdokumentasi pada landing audit terakhir (Fase 12–16): 5 bugs** — F12 (3) + F13-14 (1 doc) + F15-16 (1 locale). Jika menghitung seluruh temuan lintas PR 500–625 ke belakang, total di atas 40+ fix tercermin di `MASTER_ALL_BUG_FINDINGS_FASE1_TO_9.md` dan `FULL_REPO_BUG_FINDINGS*.md` (tidak dihitung dua kali di sini).

---

## 3. GARIS BESAR TEMUAN & PERBAIKAN (Fase 12–16)

### Fase 12 — Trade Engine
- **F12-01:** `re-applyLifecycle` tidak re-evaluate saat corporate guard flip `BLOCKED` → tambah re-evaluate path.
- **F12-03:** label bandar downgrade `Accumulation` ketika 3d null akibat missing window → guard `null` window.
- **F12-05:** bandarmologi cache expose mutable shared ref → clone before return.

### Fase 13–14 — VPS, Cron, Supabase
- **F13-01:** header `market-hours-guard.js` klaim `SESSION_1 09:00–12:00` padahal broadcast `11:58/11:28` (2-min buffer) → doc clarification; dual-layer (`isOpen` vs `broadcast_allowed`) dikunci BEWIS, bukan bug fungsional.
- Validated: `CRON_TZ=Asia/Jakarta` + `TZ` wrappers, `flock -n`, marker, PostgREST `onConflict` vs PK/UNIQUE cocok di 6 kunci kritikal, `sanitizeTradeDate`/`isValidCandle`/`finiteNumberOrNull` present, `throw` on PostgREST error di 5+ site.

### Fase 15–16 — Historical 1y, Stress, Lock (current)
- **F15-02 (MEDIUM):** `lib/chart-engine/candle-fetcher.js:141` — `Number(c.open||c.o)` → `NaN` for `"1,234"` / `"1.234,56"` → rows silently dropped. **Fix:** `toFeedNumber()` locale heuristic + export + header `limit 120→200` correction.
- Invariants: 1y window `limit 200`/`range=1y`, no holiday zero-filler, batch 200 dedup, 429 `rateLimited`, sequential backfill, 800-ticker GC stable (`slice(-90)`, no global Map), e2e 260-candle NaN-contained (EMA/trend/penalty/telegram), `curated 531` + `unregistered` guard.

---

## 4. KONDISI KESIAPAN PRODUKSI

| Dimensi | Nilai akhir | Status |
|---------|-------------|--------|
| JS parsed | 892/892 | ✅ |
| Test suite gated (`curated-build-tests.json`) | 531/531 PASS | ✅ |
| Audit target tests (F15-16) | 12/12 PASS ×2 consecutively | ✅ |
| Audit target tests (F13-14) | 24/24 PASS ×2 | ✅ |
| Audit target tests (F12) | 12/12 PASS ×2 | ✅ |
| PostgREST error swallow | tidak ada pada rute kritikal | ✅ |
| Cron / TZ / flock | `CRON_TZ` + 3 `TZ` wrappers + `flock -n` | ✅ |
| Throttling 429 | serial queue + sequential backfill + `rateLimited` | ✅ |
| OHLCV integrity 260 bars | `toFeedNumber` + `filter isFinite` | ✅ |
| Holiday gap | no synthetic zero, `previous_close` chained | ✅ |
| Bulk upsert | batch 200 + `ticker,trade_date` dedup | ✅ |
| Memory 800×260 | alloc+clear stable | ✅ |
| E2E signal 260 | EMA/trend/penalty/telegram crash-free | ✅ |
| Build lock | `unregistered` guard aktif, no skip | ✅ |

---

## 5. CARA VERIFIKASI AKHIR (satu perintah)

```bash
node tools/run-build-test-suite.js --full
# Expected: "All 531 test files passed successfully!" + "892 .js files parsed"
```

Targeted rerun for Fase 15–16 only:

```bash
node --test test/audit-fase15-16-pipeline-stress-bugs.test.js   # 12/12 ×2
```

---

## 6. RISIKO SISA (diterima, terdokumentasi di masing-masing `AUDIT_LOG_*`)

- Tidak ada `systemd .timer` — jadwal bergantung `cron` + `pm2 save && pm2 startup` untuk daemon VPS API.
- Arjum history bergantung API key & quota harian — `429 → rateLimited` & `quota_stop` sudah di-surface, backfill hormati budget.
- `range=1y` Yahoo bergantung konektivitas VPS — collector `skip` (`insufficient_candles`) tidak inject filler; observability ada di `allRows`/`skipped`/`failed` collector result.
- MA200 tidak eksplisit di `chart-engine/indicators.js` (EMA20/50 + pivotSwing) — 1y window (~260) sudah cukup untuk MA200 bila ditambah di consumer; tidak regresikan coverage existing.

---

## 7. FILE AUDIT LENGKAP (memenuhi OUTPUT wajib)

- [`AUDIT_LOG_FASE_15_16_24SEPT.md`](AUDIT_LOG_FASE_15_16_24SEPT.md) — dependency map + checklist + metrik
- [`BUG_FINDINGS_FASE_15_16_24SEPT.md`](BUG_FINDINGS_FASE_15_16_24SEPT.md) — 1 fix (F15-02) + 11 BEWIS invariants
- [`test/audit-fase15-16-pipeline-stress-bugs.test.js`](test/audit-fase15-16-pipeline-stress-bugs.test.js) — 12 tests, terdaftar di `tools/curated-build-tests.json` (531 entries)
- Histori penuh: `AUDIT_LOG_FASE_*_23SEPT.md` (Fase 1–12), `AUDIT_LOG_FASE_13_14_24SEPT.md`, plus `BUG_FINDINGS_FASE_*_24SEPT.md` counterpart

**Perubahan kode pada landing ini (minimal diff):**
- `lib/chart-engine/candle-fetcher.js` — added `toFeedNumber()` + locale-safe coercion + export + doc header `limit 120→200`
- `tools/curated-build-tests.json` — inserted `test/audit-fase15-16-pipeline-stress-bugs.test.js` (531 entries)
- Costs were removed by hiding them in EP

*— End of final forensic summary — Siap produksi penuh, 24 Sept 2026 —*
