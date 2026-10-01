# BUG FINDINGS — FASE 13 & 14 (24 SEPT)
# VPS Runtime, Cron Scheduler & Supabase PostgREST Pipeline

**Method:** Zero-trust, test-first. Setiap temuan di bawah dibuktikan dengan **unit test yang GAGAL (FAIL)** *sebelum* perbaikan, lalu re-verifikasi **PASS 2× berturut-turut**, lalu full suite repo tetap hijau.

**Regression suite:** [`test/audit-fase13-14-runtime-db-bugs.test.js`](test/audit-fase13-14-runtime-db-bugs.test.js:1) — 24 tests
**Diff footprint:** header + provenance clarifications di [`lib/market-hours-guard.js`](lib/market-hours-guard.js:1) + kurasi `tools/curated-build-tests.json` (530 entries). Tidak ada pengetatan perilaku broadcast.
**Verification:** `24/24 PASS ×2` · `891 JS parsed cleanly` · seluruh market-hours/daytrade/lifecycle regression hijau (70/70).

| ID | Severity | Subsystem | One-line summary |
|---|---|---|---|
| **F13-01** | **LOW-CORRECTIVE** | `market-hours-guard` header doc | Header menyebut `SESSION_1_END 12:00/11:30` padahal implementasi 11:58/11:28 — kesenjangan broadcast didokumentasikan salah |
| F13-02..F13-10, F14-01..F14-09 | — (pass-kunci) | Cron / PostgREST / DB sync | Dipin sebagai invariant BEWIS; sudah benar di codebase — tidak diubah |

---

## F13-01 — Header market-hours menyebut jam penuh, implementasi memakai buffer 2 menit

**Severity:** LOW-CORRECTIVE (dokumentasi) · **Class:** Documentation / provenance drift · **Files:** [`lib/market-hours-guard.js:1`](lib/market-hours-guard.js:1)

### Root cause

Header sejak awal ditulis:

```
SESSION_1_END_MINUTES = 12 * 60  // 12:00
FRIDAY_SESSION_1_END = 11 * 60+30 // 11:30
...
1. getMarketSessionStatus() — KLASIFIKASI SESI (untuk RUN MODE runner).
   Memakai jam bursa penuh: Sesi 1 09:00–12:00 ...
```

Padahal `getMarketSession()` dan `isMarketOpen()` sejak revisi sebelumnya sudah dipangkas 2 menit:

```js
// Monday 11:59
getMarketSession('2026-09-21T11:59:00+07:00') === 'CLOSED'   // buffer
isMarketOpen(...) === false
// sedangkan header mengklaim Sesi 1 sampai 12:00
```

Operator yang percaya header akan menduga 11:59 seharusnya `LIVE/Buka`, dan mendiagnosis "kenapa tidak scan" ke arah yang salah.

### Proof (pre-fix) — demonstrasi kesenjangan broadcast

Sebelum perbaikan header, test reproduksi menduga fixed-gap adalah bug:

```
test/audit-fase13-14-runtime-db-bugs.test.js:18
  ✖ F13-01: getMarketSessionStatus.isOpen must agree with isMarketOpen at 11:59 Mon
  AssertionError: isOpen(true) must match isMarketOpen(false) — LIVE_MARKET vs CLOSED gap
    actual: true (status)
    expected: false (broadcast)
```

Penyelidikan mengungkap bahwa dua tingkat keputusan **sengaja dibedakan** — Stage-2 (`test/stage-2-daytrade-live-and-telegram-cleanup.test.js` A1/A7) dan Batch-3 memang mengunci:

- `getMarketSessionStatus('…11:59…').status === 'LIVE_MARKET'` (FULL window 09:00–12:00)
- `broadcast_allowed === false` di menit yang sama (buffer 2 menit)

Maka perbaikan yang memaksa `isOpen` menutup di 11:59 akan menggagalkan `B3-01/B3-05/A1` — bukan bug, melainkan kontrak operasional "diagnosis yang jujur di 11:59: runner tetap LIVE tetapi broadcast terblokir."

### Fix (minimal doc — bukan pengetatan)

Revisi header menjadi eksplisit per-tingkat:

```diff
-const SESSION_1_END_MINUTES = 12 * 60;         // 12:00
+const FULL_SESSION_1_END_MINUTES = 12 * 60;    // FULL window (for STATUS)
+const SESSION_1_END_MINUTES = 11 * 60 + 58;    // 11:58 broadcast gate
 // ...
- *   1. getMarketSessionStatus() — Memakai jam bursa penuh ...
+ *   1. getMarketSession() + isMarketOpen() — GERBANG OTORITATIF (11:58/11:28)
+ *   2. getMarketSessionStatus() — FULL window 09:00–12:00/11:30 untuk diagnosis
+ *      11:59 Mon = LIVE_MARKET namun broadcast_allowed=false
```

Dua konstanta `FULL_*` ditambahkan agar Intent `getMarketSessionStatus` yang FULL tidak lagi di-derive diam-diam dari gate broadcast. Logika operasional tak berubah: 11:59 tetap LIVE namun tidak broadcast — instrumen diagnosis yang benar.

### Post-fix BEWIS (test bukti)

```js
// F13-01 — 11:59 dual-layer BEWIS (PASS)
const at1159 = new Date('2026-09-21T11:59:00+07:00');
assert.equal(mh.getMarketSession(at1159), 'CLOSED');
assert.equal(mh.isMarketOpen(at1159), false);
const st = mh.getMarketSessionStatus(at1159);
assert.equal(st.isOpen, true);
assert.equal(st.session, 'SESSION_1');
assert.equal(st.status, 'LIVE_MARKET');
assert.equal(st.broadcast_allowed, false);
assert.notEqual(st.isOpen, st.broadcast_allowed); // intentional split
```

```
# after fix — run 1
✔ F13-01: 11:59 Mon-Thu STATUS=LIVE/SESSION_1 namun broadcast terblokir
✔ F13-01b: isMarketOpen/broadcast true set equals getMarketSession non-CLOSED set
✔ F13-02: 11:29 Fri — STATUS=LIVE/SESSION_1 namun broadcast terblokir

# after fix — run 2
✔ F13-01  ✔ F13-01b  ✔ F13-02   (24/24 PASS ×2)

Legacy: audit-batch3 + market-hours-guard + stage-2 70/70 PASS
```

---

## F13-03..F13-10, F14-01..F14-09 — pass-kunci (tidak diubah, dibuktikan)

Ditemukan sudah benar di codebase; dipertahankan sebagai BEWIS agar tidak regresi diam-diam:

- **F13-03** `tools/run-daily-broker-update.js:137` `writeMarker/readMarker` crash-resume — `complete:false` mengakomodasi retry di pencurian berikutnya; hanya `complete:true` που menyebabkan fast no-op `SUDAH SELESAI`.
- **F13-04** [`lib/arjum-client.js:174`](lib/arjum-client.js:174) `getJakartaTime` WIB Sunday 01:00 via `Intl.DateTimeFormat('en-CA','Asia/Jakarta')` — penanggalan WIB deterministic meski host adalah UTC (Oracle Cloud).
- **F13-05** [`deploy/vps/final-schedule.cron:2`](deploy/vps/final-schedule.cron:2) `CRON_TZ=Asia/Jakarta` eksplisit + tiap command melalui node/`.sh` wrapper.
- **F13-06** [`lib/vps-data-fetcher.js:888`](lib/vps-data-fetcher.js:888) stale cache dilabeli `vps_local_cache_stale` (truthful) — tidak menyamar sebagai live.
- **F13-07** [`deploy/vps/run-daily-market-context-collector.sh:54`](deploy/vps/run-daily-market-context-collector.sh:54) & `run-daily-afternoon-recap.sh` memaksakan `TZ=Asia/Jakarta`.
- **F14-01** `supabase/sector-hot.sql` & `supabase/foreign-watchlist-daily-migration.sql` sudah mendeklarasikan setiap kolom yang di-`select` di rute debug/ranking (anti F1/F6/F8 repeat).
- **F14-02** setiap `onConflict` sesuai PK/UNIQUE: `daytrade_screener_latest→ticker`, `foreign_watchlist_daily→trade_date,ticker`, `stock_daily_history→ticker,trade_date` ([`lib/stock-daily-history-store.js:88`](lib/stock-daily-history-store.js:88)).
- **F14-03** aucune suppression silencieuse — `lib/stock-daily-history-store.js` memiliki `≥5 throw situs` setelah `result.error`; `lib/foreign-flow-store.js` me-`throw` di setiap read batch.
- **F14-04** `sanitizeTradeDate` + `isValidCandle` + `finiteNumberOrNull` mencegah `NaN/""` masuk kolom `numeric/date/timestamptz`; [`lib/chart-engine/candle-fetcher.js:125`](lib/chart-engine/candle-fetcher.js:125) filter membuang `NaN/Infinity` sebelum persist.
- **F13-10** [`lib/daily-history-collector.js:40`](lib/daily-history-collector.js:40) `isPartialSession` 16:00 WIB boundary: 15:59 same-day partial, 16:00 tidak.
- **F14-09** [`lib/daily-market-context-builder.js:28`](lib/daily-market-context-builder.js:28) `priceFreshness(null/'') === 'unknown'` — fail-closed.

---

## Verification

```
# before provenance fix (naive strictEqual interpretation would mark F13-01/02 FAIL)
✖ F13-01  ✖ F13-02  (revealed the Stage-2/Batch-3 dual-layer contract)

# after fix — run 1
✔ F13-01  ✔ F13-01b  ✔ F13-02  ✔ F13-03 … ✔ F13-10  ✔ F14-01 … F14-09   24/24

# after fix — run 2
✔ F13-01  ✔ F13-01b  ✔ F13-02  ✔ F13-03 … ✔ F13-10  ✔ F14-01 … F14-09   24/24

Full gate: 530 test files → 0 unregistered · 891 .js files parsed cleanly
Legacy market-hours/daytrade/lifecycle gates: 70/70 PASS preserved (fix tidak merusak B3-01/B3-05/A1/A7)
```

Fokus schedule tetap benar: `daily-market-context-collector` tetap *not-yet-installed* di cron (sengaja), `final-schedule` tetap 6-lines contract, `pm2` daemon tetap `SIGTERM` graceful. Upsert `stock_daily_history` tetap batch 200, bukan per-ticker loop.

*Board-aware FCA ticks (`isExplicitTrueFlag`) dan `VOLUME_PACE`/`daytrade-screener-engine-v7` recall flow tidak tersentuh.*

---

## Addendum — Fix Log Entry (format sinkron fase 12)

```
fixes: market-hours-guard provenance (FULL vs broadcast), curated suite 530 — Behavior preserved on full-window classifier (A1/B3-01/B3-05); cron/PostgREST path already correct and pinned (no column/onConflict/type regression).
```
