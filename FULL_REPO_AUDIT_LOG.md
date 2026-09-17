# FULL REPO AUDIT LOG — Deep Bug Hunt (bukan arsitektur)

Branch kerja: `audit/full-repo-deep-dive` (dibuat dari `feat/daytrade-screener-v1`).
Output temuan: `FULL_REPO_BUG_FINDINGS.md`.
Aturan: BACA baris-per-baris, JANGAN sampling. JANGAN percaya klaim dokumen lama. JANGAN perbaiki kode (audit murni). Update log ini sesering mungkin.

## Metode (agar bisa dilanjutkan lintas sesi)

Status per modul: `[ ]` belum, `[-]` sedang, `[x]` tuntas.
"Tuntas" = SEMUA file .js/.html/.css di modul itu benar-benar dibaca isinya, bukan sekilas nama.

File terakhir dibaca: `api/sector-hot.js` 9937 · `public/bandarmologi-runtime.js` 3900 · `lib/context-ai-router-v4.js` 1-300 · `lib/intraday-volume-pace.js` 1-250
Sedang dikerjakan: FASE 3 (monster files) + FASE 2 (AI router lama)

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
- [ ] `lib/ai-answer-contract.js`, `lib/ai-analysis-cache.js`, `lib/ai-context-snapshot-store.js`, `lib/ai-telemetry.js`
- [ ] `lib/context-ai-router-v4..v7.js`
- [ ] `lib/user-ai-credentials.js`
- [ ] `lib/chart-analysis-*.js`, `lib/chart-image-renderer.js`
- [ ] `api/analyze.js`, `api/sector-hot.js`, `lib/analyze-legacy.js`
- [ ] frontend AI: `public/stock-analysis-ai.js`, `public/ai-chat-renderer.js`, `public/portfolio-ai-runtime-v2.js`, `public/portfolio-ai-workspace-v1.js`, `public/admin-ai-eval.html`

### FASE 3 — Screener engine & daytrade/swing (re-verifikasi klaim lama)
- [ ] `lib/daytrade-screener-engine.js`, `lib/daytrade-screener-engine-v7.js`, `lib/daytrade-screener-constants.js`
- [ ] `lib/swing-screener-engine.js`, `lib/screener-config.js`
- [ ] `lib/daytrade-*` (semua ~35 file intraday/adjusted/provider/validation/outcome)
- [ ] `lib/intraday-*` (semua ~22 file fast-watcher/collector/shadow)
- [ ] `lib/trade-plan-v2*.js` (14 file)
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
- [ ] `lib/telegram-*.js` (~14), `lib/voucher-admin-*.js`, `lib/webhook-alert-engine.js`, `lib/top5-progress-monitor.js`
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