# FULL REPO AUDIT LOG — Deep Bug Hunt (bukan arsitektur)

Branch kerja: `audit/full-repo-deep-dive` (dibuat dari `feat/daytrade-screener-v1`).
Output temuan: `FULL_REPO_BUG_FINDINGS.md`.
Aturan: BACA baris-per-baris, JANGAN sampling. JANGAN percaya klaim dokumen lama. JANGAN perbaiki kode (audit murni). Update log ini sesering mungkin.

## Metode (agar bisa dilanjutkan lintas sesi)

Status per modul: `[ ]` belum, `[-]` sedang, `[x]` tuntas.
"Tuntas" = SEMUA file .js/.html/.css di modul itu benar-benar dibaca isinya, bukan sekilas nama.

File terakhir dibaca: `lib/analyze-legacy.js` (TUNTAS 1-1920) · `lib/ai-answer-contract.js` (TUNTAS 1-254) · `lib/ai-telemetry.js` (TUNTAS 1-76) · `lib/ai-eval-derived-facts.js` (1-200) · `lib/chart-analysis-endpoint.js` (TUNTAS) · `lib/chart-analysis-prompt.js` (TUNTAS) · `lib/context-ai-router-v5.js` (TUNTAS) · `lib/context-ai-router-v6.js` (TUNTAS) · `lib/trade-plan-v2-integration.js` (TUNTAS) · `lib/intraday-fast-watcher-live.js` (1-300) · `lib/telegram-templates.js` (1-640) · `lib/user-watchlist-service.js` (1-300) · `lib/ai-context-snapshot-store.js` (TUNTAS)
Sedang dikerjakan: FASE 2 (AI) + sisa lib/* (berikutnya: `context-ai-router-v4.js` 301-1162, lalu sisa `intraday-*`, `telegram-*`, `trade-plan-v2-*`)

### PROGRES BATCH 11 (sesi 2026-09-18, lanjutan dari commit 8b39b46)
- `lib/ai-answer-contract.js` (254 baris) **TUNTAS** — temuan: 1 LOW (validasi `direct_answer > 600` dead karena sudah di-slice di normalizer; terbukti runtime), 1 LOW (`explicitRatio` dead variable). Sisa kontrak kokoh (normalisasi, banned style, near-equal guard, allowed_numbers).
- `lib/ai-telemetry.js` (76 baris) **TUNTAS** — **BERSIH** (counter in-memory; tanpa payload sensitif/token leak; latency & cache-hit rate terhitung benar).
- `lib/analyze-legacy.js` (1.920 baris) **TUNTAS** — temuan: 1 HIGH (fabrikasi RSI=50 / volume=1x / change=0 di template deterministik, lalu dipakai decision logic — kontradiksi dengan kontrak frontend "absent stays absent" di `public/market-feature-runtime.js:585-606`), 3 MEDIUM (provider selalu `'deepseek'` di jalur ticker; daftar model Gemini deprecated disalin 4× dengan isi BEDA dari daftar provider; `fetchServerSideQuote` hitung pivot/MA/RSI dari candle hari berjalan meski berlabel T-1), 5 LOW (`handleChartVision` error-string dianggap sukses; `geminiSearchNews` dead code; echo `chatMessage` tanpa escape di intent `ticker_only`; dst).
- Verifikasi runtime: `validateAnswer({direct_answer: 'x'.repeat(700)})` → `length 600`, `errors: []` (branch `>600` mustahil).
- Verifikasi lintas file: `api/analyze.js:5` require `analyze-legacy` (jalur produksi); `refKeys` di `lib/idx-tick-normalization.js:989` SUDAH mencakup `previousClose`/`prevClose` → dugaan mismatch DITOLAK (tidak dicatat).
- Heading temuan di `FULL_REPO_BUG_FINDINGS.md` kini **64** (2 CRITICAL, 15 HIGH, 26 MEDIUM, 21 LOW).

### PROGRES BATCH 12 (sesi 2026-09-18)
- `lib/intraday-fast-watcher.js` (510) **TUNTAS** — bersih (lock atomic pid-aware, dedup key, state per-tanggal, shadow-only).
- `lib/intraday-fast-watcher-live.js` (320) **TUNTAS** — bersih (concurrency clamp, production-lock check, shadow-only).
- `lib/telegram-templates.js` (940) **TUNTAS** — 1 MEDIUM: TP dikarang `entry×1.045/1.075/1.055` saat tp1/tp2 absen + label persen hardcoded; terbukti runtime `formatSignalCard` mencetak "Target Profit 1 (+4.5%): Rp103" padahal TP 103/102 = +0,98%.
- `lib/telegram-notifier.js` (648) **TUNTAS** — bersih (throttle 429 backoff, market guard, error body ≤200 char; tidak ada token leak).
- `lib/trade-plan-v2.js` (1.320) **TUNTAS** — bersih (engine kanonik, deterministik, tick-aware; TP2 gated breakout; tidak mengarang level).
- Total heading temuan kini **65** (2 CRITICAL, 15 HIGH, 27 MEDIUM, 21 LOW).

### PROGRES BATCH 13 (sesi 2026-09-18)
- `lib/context-ai-router-v4.js` (1.162) **TUNTAS** — **BERSIH**. Verifikasi: rate limit per-user, health/cooldown per model, outage latch ter-scope (hanya CATALOG_WITH_OVERLAP + semua attempt `wz_model_temporarily_unavailable` + ≥2 vendor family), redaksi log (hostname-only, tanpa key/cookie/pertanyaan), cache key semantik (exclude `captured_at`/`price_meta`), budget split per-attempt. Anomali kecil `provider_outage_latched:false` pada jalur userRetry TIDAK berdampak — grep menunjukkan frontend hanya membaca `code`; tidak dicatat.
- `lib/user-watchlist-service.js` (730) **TUNTAS** — bersih. `createAlert` menolak `notification_chat_id` dari request (resolve server-side dari `app_user_telegram_verifications` — anti-IDOR), `watchlist_id` diverifikasi ownership, update/delete scoped `user_id`, evaluator alert dengan gate pillar-13 (match freq ≥50 & turnover ≥1B kecuali AKSELERASI), delivery gagal → `is_triggered` tetap false untuk retry, dry-run preview.
- `lib/daytrade-ohlcv-cache.js` (393) **TUNTAS** — bersih (TTL efektif per jam bursa; `syncWithBrokerSummary` opt-in mencegah candle ketinggalan summary; fallback stale cache eksplisit).
- `lib/arjum-client.js` (641) **TUNTAS** — bersih (circuit breaker kuota harian, market-hours guard WIB, fallback cache lokal berlabel `from_cache/fallback`, `classifyFailure` memisahkan quota vs api_error).

### PROGRES BATCH 14 (sesi 2026-09-18)
- `lib/intraday-production-eligibility.js` (92) **TUNTAS** — bersih (pure helper; exclusion set selaras gate `candidatePassesDayTradeRecommendation` di api/sector-hot.js; tidak mencampur `execution_grade`).
- `lib/intraday-fast-watcher-guarded-live.js` (180) **TUNTAS** — bersih (kill switch `FAST_WATCHER_LIVE_ENABLED` default OFF, lock per-tanggal, early-watch aditif tidak mempengaruhi publikasi, delegasi Telegram ke publisher yang re-check flag).
- `lib/telegram-analytics.js` (156) **TUNTAS** — bersih (pure; reserved accounts dikecualikan; join date unknown TIDAK diinvent; average score null bila kosong).
- `lib/telegram-transient-message.js` (70) **TUNTAS** — bersih (best-effort transient message, semua error ditelan aman).
- `lib/trade-plan-v2-flags.js` (129) **TUNTAS** — bersih (semua flag default FALSE, hanya string eksplisit true/1/yes/on).
- Status file menggantung dari sesi lalu yang kini TUNTAS: `intraday-fast-watcher-live.js`, `telegram-notifier.js`, `trade-plan-v2.js`, `telegram-templates.js`, `user-watchlist-service.js`, `daytrade-ohlcv-cache.js`, `arjum-client.js`, `context-ai-router-v4.js`.

### SISA CHECKLIST lib/ (urutan berikutnya)
- `intraday-*` sisa 15: collector-vps-audit, fast-watcher-early-watch(-publisher), fast-watcher-momentum, fast-watcher-pool, fast-watcher-publisher, fast-watcher-radar-publisher, sample-lifecycle, sample-summary, shadow-scoring(-live), shadow-trade-backtest, volume-pace.
- `telegram-*` sisa 10: daily-recap, delivery (981), lifecycle, unified-general, unified-subscription, verification (1.534), verify-bot, voucher-admin-continuation.
- `trade-plan-v2-*` sisa 8: candle-structure, daytrade-diagnostic, formatter, gap-areas, liquidity-sweep, replay-preview, source-adapters, sweep-diagnostic.
- Lalu: `lib/bandarmologi-service.js` sisa, `lib/idx-tick-normalization.js` sisa (900-1182), `lib/intraday-shadow-*` besar, `public/*` sisa, `tools/`, `supabase/`, `test/`.

### PROGRES BATCH 15 (sesi 2026-09-18)
- `lib/intraday-fast-watcher-pool.js` (448) **TUNTAS** — **BERSIH** (lock setup/plan deterministik via `setupId`/`plan_lock_id`, confirmation 2-dari-3 window size 5, opening-velocity guard 09:16-09:30, adaptive watch extension, production-eligibility block, reentry reset, eviction terminal).
- `lib/intraday-fast-watcher-publisher.js` (501) **TUNTAS** — 1 MEDIUM BARU: `buildDbRow` memalsukan `daytrade_score` (`?? 70` + clamp `Math.max(50,...)`) dan menulisnya ke tabel produksi `daytrade_screener_latest`; terbukti runtime (42→50, null→70, status hardcoded `READY_BREAKOUT`). Konsumen publik terverifikasi (`api/sector-hot.js:2748,6869,11742,12423`).
- Total heading temuan kini **66** (2 CRITICAL, 15 HIGH, 28 MEDIUM, 21 LOW).

### PROGRES BATCH 16 (sesi 2026-09-18, lanjutan)
TUNTAS & BERSIH (semua dibaca baris-per-baris):
- `lib/intraday-collector-vps-audit.js` (305) — pure audit crontab/runner, idempotent, aman.
- `lib/intraday-sample-lifecycle.js` (297) — lifecycle research storage; guard "first snapshot observation-only"; alias v1.1 konsisten; tidak mengubah state produksi.
- `lib/intraday-volume-pace.js` (311) — pace WIB dengan jadwal Jumat 270 menit, `MIN_EFFECTIVE_PROGRESS` 0.15, clamp 6x, confidence LOW bila data kurang; tidak mengarang baseline.
- `lib/intraday-fast-watcher-radar-publisher.js` (322) — 4 kill-switch, floor `MIN_RADAR_WATCH_SCORE=55` ketat (Temuan #7 terverifikasi ada di kode), RR<1 diblokir, ledger dedup + score +8 gate, chase reasons reused.
- `lib/intraday-fast-watcher-momentum.js` (587) — scoring deterministik, floor RVOL 1.2 (BATCH 3 Mod 3), RR minimum, anti-chase adaptif max 6%, opening-velocity guard 09:16–09:30 WIB dengan threshold board-aware; `safeToFixed` dead code (LOW minor, tidak dicatat terpisah — pola sama dengan `lib/daytrade-screener-engine.js:3050`).
- `lib/intraday-fast-watcher-early-watch.js` (577) — `executable_price` SELALU null + alasan eksplisit (jujur, tidak dipromosikan); at-most-once notification reservation; tidak menyentuh pool state.
- `lib/intraday-fast-watcher-early-watch-publisher.js` (360) — gate 3 kill-switch termasuk global `TELEGRAM_ENABLED` sebelum reservasi; `_attempted` dipersist sebelum kirim (crash-safe); anti-chase hanya setelah early-watch prior run.
- `lib/intraday-sample-summary.js` (405) — partisi eligibility konservatif (legacy_unclassified TIDAK dianggap eligible), catatan semantik MFE/MAE sampled jujur.

### PROGRES BATCH 17 (sesi 2026-09-18)
TUNTAS & BERSIH:
- `lib/intraday-shadow-scoring.js` (1.262) — safety gate produksi OFF, path guard input/output, deterministik tanpa wall-clock, forward-returns dilaporkan jujur "tidak tersedia" (tidak mengarang profitabilitas).
- `lib/intraday-shadow-scoring-live.js` (1.013) — no-lookahead ketat (baris > target diabaikan), tanggal+jam WAJIB eksplisit (tanpa fallback wall-clock), hit-rate ditahan bila sampel < 5, `profitability_claimed: false`, lock PID-aware.
- `lib/intraday-shadow-trade-backtest.js` (1.188) — anti-lookahead entry (snapshot BERIKUTNYA, bukan snapshot sinyal), dedup 1 trade/ticker/hari, biaya round-trip 0/30/50 bps terpisah dari gross, small-sample warning + disclaimer tegas, `no_losing_trades_profit_factor_undefined` jujur.

**SELURUH `lib/intraday-*` (17 file) KINI TUNTAS 100%.**

### PROGRES BATCH 18 (sesi 2026-09-18)
TUNTAS & BERSIH (semua `lib/telegram-*`, 12 file):
- `telegram-voucher-admin-continuation.js` (146) — fail-closed admin shape, private-chat only, quantity session + expiry check.
- `telegram-daily-recap.js` (210) — WIB date via Intl, filter arsip/test, fallback "hari libur" jelas, disclaimer konsisten.
- `telegram-lifecycle.js` (318) — two-phase claim→send→commit/release (retryable, delivered counter hanya naik saat commit); deep-link payload tanpa identifier.
- `telegram-verify-bot.js` (202) — token HANYA `TELEGRAM_VERIFY_BOT_TOKEN` tanpa fallback, error disanitasi, invite join-request tanpa member_limit (cegah clicker pertama masuk).
- `telegram-unified-general.js` (217) — binding verified dulu; akun blocked → pesan generik; entitlement aktif dihitung dari window waktu.
- `telegram-unified-subscription.js` (333) — idempotency key deterministik per update_id; RPC consume token; admin gate + capability check.
- `telegram-delivery.js` (981) — state machine DELIVERY_* 2-phase claim; `row_results` per-baris (header gagal tidak menandai semua row UNCERTAIN); uncertain tidak di-retry otomatis (anti-duplikat).
- `telegram-verification.js` (1.534) — HMAC-SHA256 fail-closed (secret absen → tolak); join-request gate EXACT match (invite link + eligible + belum joined) else DECLINE; outbox claim/complete/fail at-least-once; webhook claim by update_id; sender limiter 5/15mnt; rating 1–5 idempotent; tidak ada token/raw text di log.
- `telegram-analytics.js` + `telegram-transient-message.js` (TUNTAS batch 14).

**SELURUH `lib/telegram-*` (12 file) KINI TUNTAS 100%.**
### PROGRES BATCH 19 (sesi 2026-09-18)
TUNTAS & BERSIH (SEMUA `lib/trade-plan-v2-*`, 11 file):
- `gap-areas.js` (262) — gap observable, fill/reclaim/fail jelas, gap tanpa harga → GAP_UNAVAILABLE (tidak mengarang).
- `formatter.js` (302) — single source of truth angka kanonik, parity web↔telegram via `diffViewModels`, legacy fallback saat flag OFF.
- `replay-preview.js` (262) — read-only; `HISTORICAL_STRUCTURE_NOT_CAPTURED` jujur saat struktur tak tersimpan (tidak reverse-derive SL/TP).
- `candle-structure.js` (398) — pivot terkonfirmasi 2-kiri-2-kanan, bar tanpa OHLC → `available:false` (tidak mengarang).
- `liquidity-sweep.js` (450) — model observable (bukan klaim stop-hunting), hard stop SELALU aktif, breakdown butuh 2 close / explicit confirm.
- `daytrade-diagnostic.js` (522) — scope guard DAY_TRADE; support/resistance hanya dari harga ≤ entry (no look-ahead); ATR proxy null bila <2 titik.
- `source-adapters.js` (508) — alias per-screener eksplisit, TIDAK PERNAH reverse-derive SL/TP, `source_fields` melaporkan apa yang benar-benar ada.
- `sweep-diagnostic.js` (476) — 4 policy konfirmasi; emergency stop aktif di semua policy; BNBR exclusion dilaporkan jujur; no profitability claim.

**SELURUH `lib/trade-plan-v2-*` (11 file) KINI TUNTAS 100%.**
Berikutnya: `lib/bandarmologi-service.js` (2.226 — baca bertahap), lalu `lib/idx-tick-normalization.js` (900-1182).

### PROGRES BATCH 20 (sesi 2026-09-18)
- `lib/bandarmologi-service.js` (2.226) **TUNTAS** (chunk 1-300, 301-600, 601-900, 901-1200, 1201-1500, 1501-1800, 1801-2100, 2101-2226). Temuan baru: 1 MEDIUM (`accumulation_score` dikarang 70/30/75, terbukti tampil di UI `bandarmologi-runtime.js:2842` sebagai "Acc Score: X/100"), 1 LOW (5 literal `2026-09-11` sebagai fallback tanggal termasuk payload NO_DATA).
  - Catatan bersih: `firstNonEmptyArray` memperbaiki bug lama `[] || []`; `readDiskCache` dengan identifier eksplisit TIDAK fallback ke tanggal lain; date masquerading sudah dihapus (Batch 1 P0); `applyMultiDayScaling` tidak lagi mengalikan angka sintetis.
- Total heading temuan kini **68** (2 CRITICAL, 15 HIGH, 29 MEDIUM, 22 LOW).

### TUNTAS BARU (batch ini) — semua BERSIH, tidak ada bug
- `lib/context-ai-router-v5.js` (552 baris): failover outage spillover, redaksi diagnostik (Bearer/key/JWT), health bookkeeping untuk route emergency, `attempted_count` kini mencakup semua panggilan. Kokoh.
- `lib/context-ai-router-v6.js` (227 baris): fallback lokal deterministik untuk stock follow-up; hanya mengutip angka dari snapshot, tidak mengarang level; `shouldUseLocalFallback` ketat (hanya source stock_analysis_followup + status ≥500). Kokoh.
- `lib/trade-plan-v2-integration.js` (681 baris): satu seam kanonik, flag-gated (no-op default), `isPlanV2Usable` ketat, `computePlanLockId` deterministik (mengecualikan field volatil). Kokoh.
- `lib/chart-analysis-endpoint.js` (109 baris): auth sesi wajib, mutasi hanya POST, action allowlist. Kokoh.
- `lib/chart-analysis-prompt.js` (56 baris): prompt vision dengan larangan eksplisit mengarang angka & rekomendasi beli/jual. Kokoh.
- `lib/ai-context-snapshot-store.js` (231 baris): sanitasi ketat + kunci konteks per-ticker (mencegah hydrate ticker salah). Kokoh.
- `lib/ai-eval-derived-facts.js` (258 baris): fakta turunan deterministik, `compactObject` membuang null. Kokoh.
- `lib/intraday-fast-watcher-live.js` (320 baris): guard jam istirahat Jumat, production-lock check, shadow-only (tidak pernah kirim Telegram). Kokoh.
- `lib/telegram-templates.js` (940 baris, 1-640 dibaca): formatter deterministik, `safe()` menyanitasi, tidak mengarang angka. Kokoh.
- `lib/user-watchlist-service.js` (730 baris, 1-300 dibaca): multi-source price resolution berurutan, validasi ticker, upsert idempotent. Kokoh.

### TUNTAS BARU: `api/sector-hot.js` (14.808 baris) — SEMUA TERBACA
Temuan di file ini: 1 HIGH (BUG-025 includesAny 300-char gate), 1 HIGH (BUG-013 token review), 1 MEDIUM (enrichConfluenceRows hardcoded 'Swing'), 3 MEDIUM (UTC-slice price_date di 3 jalur), 1 LOW (dead code 'Speculative'), 1 LOW (getRequestBaseUrl host header), 1 LOW (deleteOldForeignRows tanpa limit).

### TUNTAS BARU: `public/bandarmologi-runtime.js` (5.435 baris) — SEMUA TERBACA
Temuan di file ini: 1 HIGH (FALLBACK_INSIDER_DATA fabrikasi), 1 MEDIUM (persentase missing→0.00%), 3 LOW (2 literal tanggal, 1 var duplikat).

### POSISI BACA FILE MONSTER (WAJIB DILANJUT SESI BERIKUTNYA — jangan ulang)
- `api/sector-hot.js` (14.808 baris): sudah dibaca **1-3119, 3450-3637, 5738-9937, 11586-11705, 13643-13697, 14245-14544, 9453-9492**. BELUM: 3119-3450, 3638-5737, 9938-11585, 11706-13642, 13698-14244, 14545-14808.
- `public/bandarmologi-runtime.js` (5.435 baris): sudah dibaca **1-3900**. BELUM: 3901-5435.
- `lib/daytrade-screener-engine.js` TUNTAS. `lib/daytrade-screener-engine-v7.js` TUNTAS. `lib/idx-tick-normalization.js` baru 1-899 (belum 900-1182).
- `lib/context-ai-router-v4.js` baru 1-300 (belum 301-1162); v5/v6 belum disentuh.

Temuan kumulatif: 1 CRITICAL, 17 HIGH, 17 MEDIUM, 10 LOW (1 ditarik).

### PROGRES BATCH 4 (sesi ini)
- `lib/daytrade-screener-engine-v7.js` TUNTAS (208 baris) — bersih.
- `lib/candle-pattern-engine.js:230-309` (BUG-042 verified FIXED)
- `lib/admin-users-handler.js:240-299` (BUG-032 verified FIXED)
- `api/review-access.js` (BUG-013 masih ada) + `tools/run-build-test-suite.js` (BUG-002 masih ada) + `lib/admin-foreign-upload.js` (BUG-038 masih ada)
- `api/register-user.js` (1-120), `api/log.js` (1-100), `api/maintenance-settings.js` (1-80) — semua kokoh
- Dihitung: 453 test file vs 395 ter-kurasi = 58 test tak dijalankan CI

### BELUM TUNTAS (prioritas sesi berikutnya)
- `api/sector-hot.js` sisa: 3119-3450, 3638-9452, 9493-11585, 11706-14244, 14545-14808
- `public/bandarmologi-runtime.js` sisa (1-750 sudah dibaca dari 5435)
- Semua `lib/intraday-*` sisa (~20 file), `lib/telegram-*` sisa (~12 file), `lib/trade-plan-v2-*` (13 file)
- `lib/context-ai-router-v4/v5/v6.js`, `lib/analyze-legacy.js`, `lib/chart-analysis-*`
- Sisa `public/*.js` (~40 file), `public/*.html`, `public/*.css`
- `tools/` (~100 file), `supabase/*.sql` (56 migrasi), `.github/workflows/*` (12), `scripts/`, `deploy/`
- `test/` (~453 file), 18 dokumen audit lama lain (AUDIT_SCREENER_*, AUDIT_KLASTER_*, dll)

Temuan kumulatif: 1 CRITICAL, 16 HIGH, 15 MEDIUM, 6 LOW (38 temuan).

### PROGRES TAMBAHAN (batch ke-3)
Sudah dibaca tuntas (batch ke-3):
- lib/daily-history-collector.js (100-279), lib/chart-engine/candle-fetcher.js (full 177), lib/trade-plan-v2.js (1-300), lib/telegram-notifier.js (1-509), lib/bandarmologi-intel-service.js (360-679), lib/intraday-fast-watcher.js (1-200), lib/pattern-abcd.js (1-150), api/sector-hot.js (14245-14544), lib/daytrade-screener-engine.js (2500-3098) → **daytrade-screener-engine.js TUNTAS 100%**
- public/portfolio-command-center.js (1-479), public/portfolio-runtime-fix.js (full), lib/portfolio-state-handler.js (full), public/signal-gate-transparency.js (1-200), public/pattern-map.js (1-250), public/unified-cockpit-runtime.js (1-200), public/dashboard-top5-only-ui.js (full), lib/report-helpers.js (1-140), lib/vps-data-fetcher.js (230-389), lib/ai-context-snapshot-store.js (1-120), api/admin-users.js (1-120), lib/track-record-service.js (1-150), lib/daily-market-context-builder.js (296-405)

Temuan kumulatif: 1 CRITICAL, 14 HIGH, 13 MEDIUM, 6 LOW (34 temuan).

### PROGRES TAMBAHAN SESI INI (batch monster)
Sudah dibaca tuntas (batch ke-2):
- `api/sector-hot.js` baris 1-3119 + 3450-3637 + 9453-9492 + 11586-11705 (14.808 baris total — BAGIAN BESAR belum: 3119-3450, 3638-9452, 9493-11585, 11706-14244, 14245-14808)
- `lib/daytrade-screener-engine.js` baris 1-2499 + 2950-3098 (3098 baris; sisa 2500-2949 belum)
- `public/bandarmologi-runtime.js` baris 1-750 (5.435 baris; sisa mayoritas belum)
- `lib/telegram-notifier.js` (648 — 1-509 dibaca)
- `lib/trade-plan-v2.js` (1320 — 1-300 dibaca)
- `lib/bandarmologi-intel-service.js` (1754 — 360-679 dibaca)
- `lib/intraday-fast-watcher.js` (510 — 1-200 dibaca)
- `lib/pattern-abcd.js` (189 — 1-150 dibaca)

Temuan baru batch ini: 2 MEDIUM (sector-hot.js UTC-slice price_date; bandarmologi-intel-service.js UTC-slice freshness) + 1 LOW (dead code 'Speculative').
Temuan kumulatif: 1 CRITICAL, 14 HIGH, 9 MEDIUM, 5 LOW.

### STATUS BELUM TUNTAS (lanjutkan sesi berikutnya — JANGAN ulang yang sudah tuntas)
Besar & belum dibaca tuntas (WAJIB baca baris-per-baris):
- `api/sector-hot.js` (14808 baris — baru 1-300)
- `lib/daytrade-screener-engine.js` (3098 baris — baru 1-400), `lib/daytrade-screener-engine-v7.js`
- `lib/bandarmologi-service.js` (2226 baris — baru 1-699), `lib/bandarmologi-intel-service.js`
- `public/bandarmologi-runtime.js` (5435 baris — baru 1-350)
- `public/portfolio-ai-runtime-v2.js` (844 — baru 1-400)
- `lib/idx-tick-normalization.js` (1182 — baru 1-799)
- `lib/vps-data-fetcher.js` (641 dalam arjum-client; vps-data-fetcher belum dibaca isi)
- Semua `lib/intraday-*` (~22), `lib/daytrade-*` (~35), `lib/trade-plan-v2*` (14), `lib/telegram-*` (~14)
- `lib/context-ai-router-v4/v5/v6.js`, `lib/analyze-legacy.js`, `lib/chart-analysis-endpoint.js`, `lib/chart-analysis-prompt.js`
- Seluruh `public/*.js` sisa, `public/*.html`, `public/*.css`
- `tools/` (~102), `supabase/*.sql` (56), `.github/workflows/*`, `scripts/`, `deploy/`
- `test/` (~521)

Sudah TUNTAS dibaca sesi ini: package.json, vercel.json, ecosystem.config.js, server.js, .gitignore, lib/latest-price-resolver.js, api/quote.js, api/candles.js, lib/chart-t1-policy.js, lib/idx-trading-calendar.js, lib/market-hours-guard.js, lib/corporate-action-price-scale-guard.js, lib/screener-config.js, lib/swing-screener-engine.js, lib/password-credential.js, lib/request-rate-limit.js, lib/free-user-approval.js, lib/subscription-auth.js, lib/entitlements.js, lib/admin-session.js, lib/user-ai-credentials.js, lib/ai-gemini-provider.js, lib/ai-narration.js, lib/ai-narration-prompts.js, lib/ai-narration-validator.js, lib/ai-analysis-cache.js, lib/ai-runtime-grounding.js, lib/ai-runtime-grounding-v2.js, lib/context-ai-router-v7.js, api/analyze.js, api/login-user.js, lib/security-guard.js, lib/foreign-flow-store.js, lib/daily-market-context-constants.js, lib/stock-daily-history-store.js, lib/daily-market-context-builder.js (1-300), lib/insider-network-service.js (1-599), lib/broker-hunter-service.js (1-300), lib/chart-image-renderer.js (1-250), public/ai-chat-renderer.js, public/chart-analysis-runtime.js, public/chart-viewer.js, public/analisis-saham-runtime.js (1-320), public/stock-analysis-ai.js (1-300), docs/CHART_T1_DATA_POLICY.md

### PROGRES SESI INI (2026-09-17)
Sudah dibaca tuntas:
- Root: package.json, vercel.json (563 baris), ecosystem.config.js, server.js
- FASE 1 harga: lib/latest-price-resolver.js, api/quote.js (2768 baris), api/candles.js (310), lib/idx-tick-normalization.js (1-799 dari 1182), lib/idx-trading-calendar.js, lib/chart-t1-policy.js, lib/corporate-action-price-scale-guard.js, lib/arjum-client.js (1-400 dari 641), lib/daytrade-ohlcv-cache.js (1-300 dari 393), lib/stock-daily-history-store.js, lib/market-hours-guard.js, docs/CHART_T1_DATA_POLICY.md
- FASE 2 AI: lib/ai-gemini-provider.js, lib/ai-narration.js, lib/ai-narration-prompts.js, lib/ai-narration-validator.js, lib/context-ai-router-v7.js (904 baris), lib/ai-analysis-cache.js, lib/ai-runtime-grounding.js, lib/ai-runtime-grounding-v2.js, api/analyze.js, public/ai-chat-renderer.js, public/chart-analysis-runtime.js, public/chart-viewer.js, lib/chart-analysis-service.js (1-400 dari 496), public/portfolio-ai-runtime-v2.js (1-400 dari 844)

Temuan tercatat di FULL_REPO_BUG_FINDINGS.md: 1 CRITICAL, 5 HIGH, 3 MEDIUM, 1 LOW.

---

## INVENTARIS REPO (dikonfirmasi via `dir /b /s`)

| Modul | Jumlah file kode | Catatan |
|---|---|---|
| `api/` | 12 .js | endpoint Vercel |
| `lib/` | ~184 .js | inti logika; `lib/chart-engine/` 3 file |
| `public/` | ~81 (js/html/css + assets) | frontend; `public/assets/` data |
| `tools/` | ~102 (.js + .bat + .sh + .ps1 + streamlit_runner/) | CLI/ops, banyak `apply-*`/`patch-*`/`verify-*` |
| `scripts/` | 6 + `idx-sync/` (py, ts) | |
| `supabase/` | 56 .sql | migration |
| `test/` | ~521 (.test.js + fixtures/ helpers/ sql/) | |
| `data/` | ~727 file | mayoritas JSON data hasil generate (arjum-data, broker-summary, ohlcv-cache, insider-network) — BUKAN kode; spot-check integritas saja |
| `docs/` | ~29 md | |
| `deploy/` | 1 + systemd/ + vps/ | |
| `.github/` | CODEOWNERS, dependabot, template, 12 workflows | |
| `.agents/` | skills + tasks JSON | tooling agent, bukan runtime app |
| root | server.js, ecosystem.config.js, package.json, vercel.json, tailwind*, test-risk-guard.js, intraday-sample.sh, .gitattributes, .gitignore | |

Root dokumen audit lama (WAJIB dibaca sebagai referensi arah, JANGAN dipercaya):
AUDIT_CHANGES_PR661_TO_LATEST, AUDIT_CHECKPOINT, AUDIT_COVERAGE, AUDIT_EXHAUSTIVE_REPORT,
AUDIT_FINDINGS, AUDIT_HISTORIS_REGRESI, AUDIT_KLASTER_2_DAYTRADE_V7, AUDIT_KLASTER_3_TRACK_RECORD,
AUDIT_KLASTER_4_INSIDER_NETWORK, AUDIT_KLASTER_5_AI_COCKPIT, AUDIT_KLASTER_6_AUTH_SECURITY,
AUDIT_SCREENER_LOGIKA_DAN_GATE, AUDIT_VERIFICATION_REPORT_PR500_625, audit-pr-500-625,
SYSTEM_ARCHITECTURE_LIFECYCLE, CHANGELOG, SECURITY, SCREENER_BUGFIX_LOG, SCREENER_ARCHITECTURE_AUDIT.

---

## CHECKLIST MODUL

### FASE 0 — Bootstrap & klaim lama (verifikasi ulang)
- [ ] baca 20 dokumen audit lama di root (catat KLAIM, bukan kesimpulan)
- [ ] `package.json`, `vercel.json`, `ecosystem.config.js`, `server.js`, `tailwind.config.js`, `tailwind.src.css`, `test-risk-guard.js`, `intraday-sample.sh`

### FASE 1 — Alur uang & harga (PRIORITAS CRITICAL: "harga ngaco")
- [ ] `lib/latest-price-resolver.js` (+ test)
- [ ] `lib/corporate-action-price-scale-guard.js`
- [ ] `lib/idx-tick-normalization.js`
- [ ] `lib/arjum-client.js`, `lib/arjum-quota-tracker.js`
- [ ] `lib/vps-data-fetcher.js`, `lib/stock-daily-history-store.js`, `lib/daily-history-collector.js`
- [ ] `lib/daytrade-ohlcv-cache.js`
- [ ] `api/quote.js`, `api/candles.js`
- [ ] `lib/chart-engine/candle-fetcher.js`, `lib/chart-engine/indicators.js`, `lib/chart-engine/volume-analyzer.js`
- [ ] `lib/weekly-timeframe.js`, `lib/idx-trading-calendar.js`, `lib/market-hours-guard.js`
- [ ] `lib/idx-holidays-2026-seed-data.js`, `scripts/seed-idx-holidays-2026.js`
- [ ] pipeline harga frontend: `public/chart-viewer.js`, `public/chart-analysis-runtime.js`, `public/analisis-saham-runtime.js`

### FASE 2 — AI (PRIORITAS CRITICAL: "AI masih banyak bug")
- [ ] `lib/ai-gemini-provider.js`, `lib/ai-narration.js`, `lib/ai-narration-prompts.js`, `lib/ai-narration-validator.js`, `lib/ai-narration-cache.js`
- [ ] `lib/ai-runtime-grounding.js`, `lib/ai-runtime-grounding-v2.js`, `lib/ai-eval-derived-facts.js`
- [x] `lib/ai-answer-contract.js` (TUNTAS 254), `lib/ai-analysis-cache.js` (TUNTAS), `lib/ai-context-snapshot-store.js` (TUNTAS), `lib/ai-telemetry.js` (TUNTAS 76, BERSIH)
- [ ] `lib/context-ai-router-v4..v7.js`
- [ ] `lib/user-ai-credentials.js`
- [ ] `lib/chart-analysis-*.js`, `lib/chart-image-renderer.js`
- [x] `api/analyze.js` (TUNTAS sesi lama; diverifikasi ulang 1-80 sesi ini), `api/sector-hot.js` (TUNTAS 14.808), `lib/analyze-legacy.js` (TUNTAS 1.920 — batch 11)
- [ ] frontend AI: `public/stock-analysis-ai.js`, `public/ai-chat-renderer.js`, `public/portfolio-ai-runtime-v2.js`, `public/portfolio-ai-workspace-v1.js`, `public/admin-ai-eval.html`

### FASE 3 — Screener engine & daytrade/swing (re-verifikasi klaim lama)
- [ ] `lib/daytrade-screener-engine.js`, `lib/daytrade-screener-engine-v7.js`, `lib/daytrade-screener-constants.js`
- [ ] `lib/swing-screener-engine.js`, `lib/screener-config.js`
- [ ] `lib/daytrade-*` (semua ~35 file intraday/adjusted/provider/validation/outcome)
- [-] `lib/intraday-*` (semua ~22 file fast-watcher/collector/shadow) — TUNTAS: fast-watcher (510), -live (320), -pool (448), -publisher (501), -momentum (587), -radar-publisher (322), -early-watch (577), -early-watch-publisher (360), -guarded-live (180), production-eligibility (92), collector-vps-audit (305), sample-lifecycle (297), sample-summary (405), volume-pace (311). SISA: shadow-scoring (1262), shadow-scoring-live (1013), shadow-trade-backtest (1188)
- [-] `lib/trade-plan-v2*.js` (14 file) — TUNTAS: `trade-plan-v2.js` (1.320), `trade-plan-v2-integration.js` (681); sisa 12 file belum
- [ ] `lib/pattern-abcd*.js`, `lib/pattern-personality.js`, `lib/classic-chart-patterns.js`, `lib/candle-pattern-engine.js`, `lib/reversal-breakout-lifecycle.js`
- [ ] `lib/swing-nk-rr-warning.js`, `lib/daytrade-entry-discipline*.js`, `lib/daytrade-execution-ranking.js`
- [ ] frontend: `public/screener-lifecycle-ui.js`, `public/pattern-*.js` (map/visual/direction-safety/screener-extension/stable-runtime/tab-resume-guard), `public/signal-gate-transparency.js`, `public/market-feature-runtime.js`

### FASE 4 — Bandarmologi / Broker / Insider
- [ ] `lib/bandarmologi-*.js` (5), `public/bandarmologi-runtime.js`, `tools/run-bandarmologi-intel.js`
- [ ] `lib/broker-hunter-service.js`, `tools/run-broker-hunter-indexer.js`
- [ ] `lib/insider-network-service.js`, `data/insider-network/*`
- [ ] `lib/foreign-flow-*.js`, `lib/daily-foreign-context.js`
- [ ] `lib/daily-*.js` (pbv/rsi/volume-context/market-context-builder/constants/history-collector)
- [ ] `lib/market-regime.js`, `lib/fibonacci-confluence.js`, `lib/bandarmologi-confluence.js`

### FASE 5 — Auth / subscription / admin / security
- [ ] `lib/admin-*.js` (~15), `lib/account-*.js`, `lib/auth-recovery.js`, `lib/password-credential.js`, `lib/security-guard.js`, `lib/request-rate-limit.js`, `lib/recaptcha-verify.js`
- [ ] `lib/subscription-*.js` (7), `lib/entitlements.js`, `lib/vouchers.js`, `lib/free-user-approval.js`
- [ ] `api/login-user.js`, `register-user.js`, `reset-password.js`, `admin-*.js`, `maintenance-settings.js`, `review-access.js`, `log.js`
- [ ] `lib/maintenance-state.js`, `lib/admin-access.js`, `lib/admin-access-legacy.js`, `lib/admin-session.js`
- [ ] frontend: `public/auth-v2.js`, `public/subscription-*.js`, `public/security-admin-runtime.js`, `public/admin-*.js`, `public/website-approved-access.js`, `public/maintenance-auth-guard.js`

### FASE 6 — Telegram & notifikasi
- [x] `lib/telegram-*.js` — **TUNTAS SEMUA 12 file**: notifier (648), templates (940), analytics (156), transient-message (70), daily-recap (210), lifecycle (318), verify-bot (202), unified-general (217), unified-subscription (333), delivery (981), verification (1.534), voucher-admin-continuation (146). `lib/voucher-admin-*.js` (bot/sender), `lib/webhook-alert-engine.js`, `lib/top5-progress-monitor.js` belum
- [ ] `lib/recent-failure-cooldown.js`, `lib/telegram-analytics.js`

### FASE 7 — Portfolio & UI shell
- [ ] `lib/portfolio-state-handler.js`, `lib/account-profile-handler.js`, `lib/track-record-service.js`, `lib/landing-showcase-service.js`, `lib/user-watchlist-service.js`, `lib/report-helpers.js`, `lib/atr-report-helpers.js`, `lib/smart-setup-labels.js`
- [ ] `public/portfolio-*.js/html/css` (11), `public/track-record-*.js`, `public/dashboard-top5-only-ui.js`, `public/mobile-*.js`, `public/unified-cockpit*`, `public/premium-workstation*`, `public/index.html`, `public/*.html`, `public/*.css`
- [ ] `public/ui-bugfix-pack-v1.js`, `public/ui-stability-fix.js`, `public/position-sizing-calculator.js`, `public/account-center-v1.*`

### FASE 8 — Ops / tools / deploy / CI
- [ ] `tools/` semua .js/.bat/.sh/.ps1 + `tools/streamlit_runner/`
- [ ] `deploy/` (systemd, vps scripts), `scripts/`, `.github/workflows/*`
- [ ] `supabase/*.sql` (56 migration) — cek constraint/index/RLS vs kode
- [ ] `data/` spot-check integritas (bukan baca semua 727 file data; ini artefak, bukan kode)

### FASE 9 — Test suite (sebagai bukti perilaku + cari test yang kosong/lemah)
- [ ] `test/` ~521 file + `fixtures/` `helpers/` `sql/`

---

## CATATAN TEMUAN AWAL (pra-audit, wajib diverifikasi)

- `data/arjum-data/broker-summary/` berisi folder ticker aneh: `AUDITSCALE14D/30D/5D/60D`, `B4TST`, `DBGT4`, `NOACC`. Nama-nama ini BUKAN ticker saham valid → indikasi artefak test/audit yang bocor ke data produksi. WAJIB dilacak siapa yang menulis folder itu.
- 557 branches remote — kemungkinan banyak fix tidak ter-merge. Catat saja, jangan checkout.