# Changelog

All notable changes to the Auto Cuan Daytrade Screener & AI Reliability Upgrade suite are documented in this file.

## [v1.0.0] - 2026-09-03

### Daytrade Screener & AI Reliability Upgrade Suite (PR 1 - PR 9)

#### PR 1: Desktop Screener UI Overhaul & Sticky Headers
- Redesigned screener grid layout with modern visual hierarchy, responsive multi-column layouts, and high-contrast typography.
- Implemented persistent sticky headers for scrolling across dense financial datasets.
- Standardized badge styling for breakout, momentum, and volume spike indicators.

#### PR 2: Mobile Touch Ergonomics & Swipe Action Sheet
- Optimized touch targets and spacing conforming to mobile accessibility standards (min 44px touch targets).
- Added bottom swipe action sheet for quick trade execution, watchlisting, and stock detail inspection.
- Enhanced responsive drawer navigation with smooth CSS transitions.

#### PR 3: Keyboard Hotkeys Navigation
- Added global keyboard listener for high-speed desktop navigation:
  - `J` / `K`: Move focus between screener rows (up/down).
  - `Enter` / `Space`: Open stock details and trade plan overlay for selected ticker.
  - `Escape`: Dismiss active overlays, modals, and detail drawers.
- Added visual focus indicators that adapt to system color themes.

#### PR 4: Telemetry Deduplication & Alert Signal Hardening
- Implemented client-side alert deduplication window to prevent duplicate webhook notifications during market spikes.
- Added strict rate-limiting and signature verification for signal ingestion.
- Hardened logging pipeline against circular references and sensitive payload leaks.

#### PR 5: Virtualized Table Scrolling & DOM Optimization
- Integrated DOM virtualization for large stock lists to ensure steady 60 FPS rendering.
- Reduced memory overhead by recycling DOM row nodes during rapid scrolling.
- Batched layout updates and reduced unnecessary reflows on high-frequency quote updates.

#### PR 6: Direct Google Gemini 2.5 Provider Integration & DB Response Cache
- Replaced legacy intermediary routing with direct Google Gemini 2.5 Flash API provider (`lib/ai-gemini-provider.js`).
- Created `ai_analysis_cache` table migration in Supabase (`supabase/ai-analysis-cache-migration.sql`) with SHA-256 cache keys.
- Added dual-layer caching (in-memory LRU + Supabase persistent storage) to prevent redundant token consumption and rate limits.
- Added graceful local deterministic fallback when Gemini service is degraded or offline.

#### PR 7: Market Session-Aware Cache Invalidation & Telemetry Diagnostics
- Added market session-aware invalidation helpers (`purgeExpiredAnalysisCache`, `invalidateAnalysisCacheByTicker`).
- Added in-memory telemetry module (`lib/ai-telemetry.js`) tracking total requests, cache hits, token savings, Gemini calls, and latency.
- Integrated telemetry diagnostic action into `api/maintenance-settings.js` (`action: "ai-telemetry"`) protected by admin auth.

#### PR 8: Server-Sent Events (SSE) AI Streaming Response & Real-Time Indicators
- Added SSE streaming to Gemini provider (`streamGeminiAnalysis`) via `:streamGenerateContent?alt=sse`.
- Integrated SSE streaming in router (`lib/context-ai-router-v7.js`) returning real-time chunks with fallback support.
- Implemented UI streaming receiver in `public/index.html` using `ReadableStreamDefaultReader` and `TextDecoder`.
- Added dynamic real-time status indicators (*"Menganalisis teknikal real-time..."*, *"Menulis ringkasan & level kunci..."*) and progressive DOM rendering.

#### PR 9: Release Readiness, Invariant Verification, & End-to-End Release Gate
- Verified absolute repository invariants (exactly 12 API files, zero secret leaks, zero live network calls in tests).
- Added comprehensive release gate end-to-end test suite (`test/daytrade-screener-v1-release-gate.test.js`).
- Registered all 316 tests in `tools/curated-build-tests.json` with 100% pass rate.
