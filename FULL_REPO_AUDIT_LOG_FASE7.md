# AUTO-CUAN FULL REPO AUDIT LOG - FASE 7 (Frontend UI, Charts & Client Runtime)
Acuan: AUDIT_RULES.md | Branch: audit/aider-full-restart | Status: TUNTAS

| File | Status | Temuan Bug (ID) | Keterangan |
|---|---|---|---|
| public/position-sizing-calculator.js | TUNTAS | BUG-F7-001, BUG-F7-002 | Batch 1: Sanitasi titik desimal 3 digit & validasi tick IDX |
| public/portfolio-command-center-model.js | TUNTAS | BUG-F7-003, BUG-F7-004 | Batch 1: Validasi inverted stop loss & fallback totalRiskIdr |
| public/portfolio-position-scenarios.js | TUNTAS | BUG-F7-005 | Batch 1: Simulasi stop loss positif saat stop > entry |
| public/portfolio-planner-v1.js | TUNTAS | BUG-F7-006 | Batch 1: Validasi fraksi tick harga IDX pada kalkulasi planner |
| public/pattern-direction-safety.js | TUNTAS | BUG-F7-007, BUG-F7-008 | Batch 2: Klasifikasi bearish terbalik pada Inverted H&S & bypass validasi level direction unknown |
| public/pattern-screener-extension.js | TUNTAS | BUG-F7-009 | Batch 2: rowsFromPayload abaikan response array langsung |
| public/pattern-visual.js | TUNTAS | BUG-F7-010 | Batch 2: Deteksi false swing high/low pada candle doji/flat |
| public/pattern-stable-runtime.js | TUNTAS | BUG-F7-011 | Batch 2: Ketiadaan validasi panjang candle minimum pada scanner pipeline |
| lib/track-record-service.js | TUNTAS | BUG-F7-012, BUG-F7-013 | Batch 3: Desinkronisasi total_signals saat anomali gain & best_gain tercatat pada NEVER_ENTERED |
| lib/user-watchlist-service.js | TUNTAS | BUG-F7-014 | Batch 3: createAlert loloskan alert tanpa target_price untuk kondisi non-price |
| lib/portfolio-state-handler.js | TUNTAS | BUG-F7-015 | Batch 3: hasPortfolioData lempar unhandled 413 error pada state berukuran besar |
| public/portfolio-ai-runtime-v2.js | TUNTAS | BUG-F7-016 | Batch 3: syncPortfolioPrices terpotong cap 30 item sehingga posisi > 30 kelaparan update harga |
| public/track-record-runtime.js | TUNTAS | BERSIH | Batch 3: UI display runtime untuk tabel sinyal dan backtest |
