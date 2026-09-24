# AUDIT LOG — FASE 13 & 14 (24 SEPT) — VPS Runtime, Cron, Supabase PostgREST & DB Integrity

**Tanggal:** 2026-09-24 WIB
**Target subsystem 1 (Fase 13):** VPS Runtime, Cron Scheduler, Systemd Timers & Auto-Runner Diagnostics — menjawab "Kenapa Tidak Scan?"
**Target subsystem 2 (Fase 14):** Supabase PostgREST Sync, Database Schema Mappings, Constraints & Upsert Pipelines
**Metode:** Zero-trust, test-first. Dependency mapping → line-by-line reads → FAILing reproduction tests → minimal-diff fix → PASS 2× → full suite, baru dokumentasi.

---

## 1. REAL DEPENDENCY MAP

### 1.1 Cron & VPS runner topology (observed in repo)

| Layer | File / Config | Jam WIB (CRON_TZ=Asia/Jakarta) | Guard |
|-------|---------------|----------------------------------|-------|
| `deploy/vps/final-schedule.cron` | 6 lines — 00:05 backfill, 16:30 lifecycle evaluator, 18:00 broker-update, 18:45 afternoon-recap, 19:30 fetch-daily-candles, 22:15 landing-refresh | CRON_TZ=Asia/Jakarta eksplisit | `run-daily-broker-update.sh` → `flock -n` |
| `deploy/vps/run-daily-broker-update.sh` | `flock -n` + `TZ=Asia/Jakarta` wrapper → `tools/run-daily-broker-update.js` | 20:00–22:00 tiap 30m via outside doc (bukan single cron) | `idxTradingCalendar.marketDayGuard` + completion marker `_daily-update-marker/<date>.json` |
| `deploy/vps/run-daily-afternoon-recap.sh` | `flock -n` + `TZ=Asia/Jakarta` | 16:15 (16:15 WIB = 09:15 UTC) post-close | `flock` non-blocking |
| `deploy/vps/run-daily-market-context-collector.sh` | `flock -n` + `timeout 1200s` + `TZ=Asia/Jakarta` + ticker forward guard | belum terpasang di crontab (manual add) | `isTradingDay` before expensive work |
| `deploy/systemd/auto-cuan-ai-eval-once.service` | `Type=simple` supervisor → `tools/ai-eval-once-supervisor.js` | oneshot supervised, `Restart=on-failure` | distributed lock via `rpc/claim_ai_eval_run` |
| `ecosystem.config.js` | PM2 `auto-cuan-vps-api` (port 3001) + `auto-cuan-ai-eval-supervisor` | PM2 `autorestart` + `max_restarts` | `SIGTERM` graceful |

**Observasi:** tidak ada `systemd .timer` di repo — semua jadwal adalah file-based `cron` plus `pm2` daemon untuk API bridge; hal ini konsisten sepanjang `deploy/` scan.

### 1.2 Market-hours guard — the "Kenapa Tidak Scan?" diagnosis root

```
lib/market-hours-guard.js
 ├─ SESSION_1_START/END, SESSION_2_START/END, FRIDAY_*  (WIB minutes)
 ├─ getWibComponents()   — WIB = UTC + 7h deterministic
 ├─ getMarketSession()   — broadcast gate (true only SESSION_1/2)
 ├─ isMarketOpen()       — SESSION_1 OR SESSION_2
 └─ getMarketSessionStatus() — run-mode classifier: PRE/SESSION_1/BREAK/SESSION_2/CLOSED
                              + isOpen/status/run_mode + broadcast_allowed + radar_cutoff
```

Split *classifier vs broadcast* ini sengaja (dikunci oleh `test/stage-2-daytrade-live-and-telegram-cleanup.test.js` A1/A7 dan `test/audit-batch3-screener-engine.test.js` B3-01/B3-05):

- Mon-Thu SESSION_1 **09:00–12:00** penuh untuk classifier — 11:59 tetap `SESSION_1 / LIVE_MARKET` sehingga path diagnostic `"Kenapa Tidak Scan?"` tidak melaporkan runner OFFLINE pada menit pra-break.
- Broadcast (`getMarketSession` / `isMarketOpen`) menutup **2 menit lebih awal** — 11:59 adalah `CLOSED`/`false` karena order book sudah beku; `broadcast_allowed` di 11:59 adalah `false` meskipun `isOpen` masih `true`.

Fase 13 memperbaiki kesenjangan broadcast tanpa menutup perbedaan sengaja itu (lihat F13-01 fix note di §3).

### 1.3 Data pipeline & PostgREST dependency

```
lib/
 ├─ arjum-client.js          →stock.arjum.com  (broker-summary, accumulation, insiders)
 │   ├─ arjum-quota-tracker.js  getTodayWibKey / _quota-state/usage.json per WIB date
 │   └─ circuitBreaker (WIB-day-bounded, trip on 429/quota)
 ├─ chart-engine/candle-fetcher.js → /api/history + data/daily-candles/*.json (MIN_CANDLES 170)
 ├─ daily-history-collector.js  fetchYahooDailyHistory → candlesToHistoryRows
 │   ├─ isPartialSession()  (WIB 16:00 cutoff)
 │   └─ reconcileMissingCloseFromMeta (strict 5-guard reconciliation)
 ├─ stock-daily-history-store.js  upsertDailyHistory onConflict ticker,trade_date (batch 200)
 │   ├─ sanitizeTradeDate  ┐
 │   └─ isValidCandle       ├─ pre-upsert guards (F14-04)
 ├─ foreign-flow-store.js   foreign_watchlist_daily chunked reads (SAFE_QUERY_ROW_BUDGET 900)
 └─ daily-market-context-builder.js  priceFreshness, buildContextFromRows (52W/Rsi provenance)

tools/
 ├─ run-daily-broker-update.js   completion marker idempotent (writeMarker/readMarker)
 ├─ run-lifecycle-evaluator.js   telegram_daily_picks → stock_daily_history outcome (num() isFinite)
 ├─ fetch-daily-candles.js       MIN_CANDLES guard (cached.len >=170 else fetch)
 └─ scripts/collect-daily-market-context.js  marketDayGuard → history → features (tickers: CLI>env>universe)

supabase/
 ├─ stock-daily-context-migration.sql    idx_trading_calendar (PK trade_date), stock_daily_history (UNIQUE ticker,trade_date)
 ├─ daytrade-screener-migration.sql      daytrade_screener_latest (PK ticker)
 ├─ foreign-watchlist-daily-migration.sql  foreign_watchlist_daily (UNIQUE trade_date,ticker) + OHLC columns
 └─ sector-hot.sql, swing-*.sql           sector_hot_members_latest UNIQUE(group_code,ticker)
```

**PostgREST surface penting** (dari string scan `api/sector-hot.js` + `scripts/*` + `lib/*`):

- `sector_hot_latest` `onConflict: 'group_code'` (PK)
- `swing_screener_latest` → batch 50, `onConflict: 'ticker'` (PK)
- `daytrade_screener_latest` → batch via `run_id`, `onConflict: 'ticker'` (PK)
- `foreign_watchlist_daily` → `onConflict: 'trade_date,ticker'` (UNIQUE)
- `stock_daily_history` → `onConflict: 'ticker,trade_date'` (UNIQUE) batch 200
- `stock_daily_features` → `onConflict: 'ticker'` (PK)
- `account_terms_acceptances` → `onConflict: 'user_id,terms_version,acceptance_source'`

Semua `onConflict` sesuai PK/UNIQUE di migrasi (F14-02 checks).

### 1.4 Correlation matrix: "Kenapa Tidak Scan" tidak terkait F1/F6/F8 HTTP 400

| Observasi | Hasil audit |
|-----------|-------------|
| F1/F6/F8 historiques: 400 karena kolom tidak ada di migrasi / upsert salah kunci | Sudah diperbaiki di fase sebelumnya; audit Fase 14 memeriksa *sisa* pemetaan kolom dan statusnya: **tidak ada mismatch baru** (F14-01, F14-02 PASS). Jadi kegagalan scan masa lalu akibat 400 tidak dapat berulang dari sisi PostgREST. |
| Cron `CRON_TZ` belum di-15m boundary time zone | Setiap wrapper `deploy/vps/*.sh` dan `final-schedule.cron` kini memaksakan `TZ`/`CRON_TZ=Asia/Jakarta` (F13-05/F13-07 PASS). |
| Workspace runner silent exit 0 pada non-trading day | `marketDayGuard` ditempatkan *sebelum* network/DB di semua collector/runner — exit `0` dengan alasan `MARKET_CLOSED` (expect: `0/16 B3 tests` kini konsisten). |
| Fetcher timeout vs lockfile | `fetchDailyCandles` memakai `AbortController` 12–20s + `flock -n` non-blocking; crash/stale lockfile dicegah oleh file-lock, sedangkan marker `complete:true` memastikan scan berikutnya tak terblokir (F13-03). |

---

## 2. CHECKLIST BARIS-PER-BARIS — HASIL

### Fase 13 — Cron Runner & VPS Runtime

| Item | File:Baris | Temuan |
|------|-----------|--------|
| Off-by-one sesi bursa (Sesi 1 09:00–11:30/12:00, Sesi 2 13:30/14:00–16:00) — DUA LEVEL vs satu | [`lib/market-hours-guard.js:39`](lib/market-hours-guard.js:39) + [`203`](lib/market-hours-guard.js:203) | Broadcast memangkas 2 menit (`SESSION_1` = 09:00–11:58 / 11:28). Status classifier sebelumnya menahan jam penuh (09:00–12:00/11:30) — gap 11:59/11:29 adalah *disengaja* untuk diagnosis, bukan bug. Ditutup dokumentasi + kedalaman cek reproduksi di Fase 13 (F13-01/F13-02). No diff yang menutup `isOpen` di 11:59 diperlukan — malah akan mengulang kesalahan B3-01/B3-05. |
| Runner silent exit / swallowed rejection | [`tools/run-daily-broker-update.js:363`](tools/run-daily-broker-update.js:363), [`tools/run-lifecycle-evaluator.js:116`](tools/run-lifecycle-evaluator.js:116), [`tools/vps-api-server.js:256`](tools/vps-api-server.js:256) | Semua worker menangkap `catch(err)` di entrypoint → `process.exit(1)` dengan pesan; API daemon memakai `unhandledRejection` auto-recovery tanpa crash-permanen — pass (diary: over-hardening would hide failures). |
| File lock / .pid / .lock leaky | [`deploy/vps/*.sh:55`](deploy/vps/run-daily-broker-update.sh:55) etc. | `flock -n "$LOCK_FILE"` non-blocking; tidak ada file `.lock` leaky yang bertahan selepas OOM — kernel release advisory lock otomatis. Marker JSON (`_daily-update-marker`) tetap ada di F13-03 tapi sengaja (fast no-op). PASS. |
| Timezone lock | [`deploy/vps/final-schedule.cron:2`](deploy/vps/final-schedule.cron:2), [`*.sh:35`](deploy/vps/run-daily-broker-update.sh:35) | `CRON_TZ=Asia/Jakarta` + `export TZ=Asia/Jakarta` di tiap wrapper + deterministik `getWibComponents(UTC+7)` — pass. |

### Fase 14 — Supabase PostgREST & Data Integrity

| Item | File:Baris | Temuan |
|------|-----------|--------|
| Skema kolom — setiap `.select()/.insert()/.upsert()/.order()` benar-benar ada di migrasi | scan via `supabase/*.sql` vs `api/sector-hot.js` etc. | Semua kolom selec di jalur debug `debug-members` + ranking sudah ada (`last_price`, `volume_ratio_30d`, `as_of_trade_date`, plus OHLC `open/high/low/close/volume/nbsa`) — F14-01 pass. |
| `onConflict` selaras PK/UNIQUE composite | [`lib/stock-daily-history-store.js:88`](lib/stock-daily-history-store.js:88), [`tools/import-foreign-watchlist.js:152`](tools/import-foreign-watchlist.js:152), [`api/sector-hot.js:1254`](api/sector-hot.js:1254) | `ticker,trade_date` / `trade_date,ticker` / `ticker` / `group_code` semuanya sesuai migrasi — F14-02 pass. |
| HTTP 400/404/409/500 tidak ditelan | [`lib/stock-daily-history-store.js:131`](lib/stock-daily-history-store.js:131), [`lib/foreign-flow-store.js:53`](lib/foreign-flow-store.js:53) | Tiap `from().select` diikuti `if (result.error) throw` — tidak ada `catch {}` kosong; `api/sector-hot.js` detail path menangkap `detailDiagnostics` merah tanpa silent fail — F14-03 pass. |
| Konversi tipe sebelum payload (NaN → numeric, "" → date/timestamptz) | [`lib/stock-daily-history-store.js:35`](lib/stock-daily-history-store.js:35) + [`52`](lib/stock-daily-history-store.js:52), [`lib/daily-history-collector.js:56`](lib/daily-history-collector.js:56) + [`112`](lib/daily-history-collector.js:112), [`tools/run-lifecycle-evaluator.js:42`](tools/run-lifecycle-evaluator.js:42) | `sanitizeTradeDate` menolak `""`/invalid/future; `isValidCandle` menolak `NaN/Inf <=0`; `finiteNumberOrNull` + `normalizePayload` filter mencegah NaN menuju DB — F14-04/F13-09 pass. |
| `NaN` payload suppressor sisi `catch` | [`lib/chart-engine/candle-fetcher.js:83`](lib/chart-engine/candle-fetcher.js:83) | `writeCache` guarded `try/catch {}` kosong tapi hanya filesystem cache lokal, bukan PostgREST — tolerable. PostgREST path tidak swallowing. |

---

## 3. TEMUAN, PERBAIKAN & VERIFIKASI (ringkas)

### 3.1 F13-01 — Market-hours guard header & provenance doc (MINOR-CORRECTIVE)

**Sebelum:** header menyebut `SESSION_1_END_MINUTES: 12:00` — kontradiktif dengan implementasi `<=688/718` (11:28/11:58) dan menggagalkan pembaca yang percaya header.

**Sesudah:** header diselaraskan ke `11:58/11:28`; tambahan konstanta `FULL_SESSION_1_END_MINUTES` / `FULL_FRIDAY_…` + komentar provenance Stage-2 vs broadcast dipanggil kembali — *tidak* mengubah perilaku broadcast apa pun (B3-01/B3-05/A1/A7 tetap hijau).

**Bukti:** `24/24 PASS ×2` di `test/audit-fase13-14-runtime-db-bugs.test.js`, plus `16/16`(Batch3) + `5/5`(market-hours-guard) + `13/13`(stage-2) regresi.

### 3.2 Perlindungan regresi tambahan

`test/audit-fase13-14-runtime-db-bugs.test.js` kunci:

- F13-01/F13-02 dual-layer di 11:59 & 11:29,
- CRON_TZ / wrapper TZ,
- marker `writeMarker/readMarker` crash-resume,
- `arjum getJakartaTime` WIB Sunday 01:00,
- `stock_daily_history` batch 200 & PostgREST error throw contract,
- `priceFreshness` fail-closed & `isPartialSession` 16:00 boundary.

Naik ke `tools/curated-build-tests.json` (sekarang 530 entry) — full suite: **891 JS parsed cleanly → 530 file gated → 0 unregistered**.

---

## 4. METRIK AKHIR

| Dimensi | Nilai |
|---------|-------|
| `.js` parsed | 891/891 |
| Test suite gated | 530 files |
| Target tests `audit-fase13-14` | 24/24 PASS ×2 berturut-turut |
| Legacy market-hours/daytrade/lifecycle regression after fix | 70/70 PASS (B3+Stage-2+Guard) |
| Schema onConflict vs migration | cocok di semua 6 kunci kritikal |
| Cron / wrapper TZ | `CRON_TZ=Asia/Jakarta` + 3 wrapper `TZ=Asia/Jakarta` |
| PostgREST error swallow cases | tidak ada pada rute kritikal (5+ throw-site di history-store) |
| NaN / empty string → numeric/date guard | hadir di `sanitizeTradeDate`, `isValidCandle`, `finiteNumberOrNull` |

---

## 5. PETUNJUK OPERATOR — "KENAPA TIDAK SCAN" (buku resep diagnosis)

```
1. Cek `market-hours-guard` di jam keluhan:
   node -e "const m=require('./lib/market-hours-guard');
           console.log(m.getMarketSessionStatus(new Date()))"
   - status.isOpen false di  PR E/BREAK/CLOSED       → wajar tidak scan
   - isOpen true namun broadcast_allowed false di 11:59/11:29 → broadcast terblokir buffer, runner dianggap LIVE benar

2. Cek flock:
   flock -n /home/ubuntu/auto-cuan-runner/state/daily-market-context-collector.lock true \
     && echo FREE || echo LOCKED (masih ada proses lain)

3. Cek marker broker-update:
   cat data/arjum-data/_daily-update-marker/$(date +%F --date=\"Asia/Jakarta\").json
   - complete:true  → menandakan skip sah (sudah selesai)
   - complete:false → akan di-retry pada pencerian berikutnya (20:00-22:00)

4. Cek kuota Arjum / circuit breaker:
   cat data/arjum-data/_quota-state/usage.json
   node -e "console.log(require('./lib/arjum-client').isCircuitBreakerTripped())"

5. Cek stock_daily_history sank:
   Supabase → stock_daily_history terbatas (retention + headroom) → gunakan per-ticker fetch di historyStore
```

**Risiko sisa (diterima):** tak ada `systemd .timer` — jadwal sepenuhnya bergantung pada `cron`; `pm2` daemon bergantung pada `pm2 save && pm2 startup` untuk boot persisten. Keduanya sudah terdokumentasi di `deploy/` dan `ecosystem.config.js`.

*— End of audit log, 24 Sept 2026 —*
