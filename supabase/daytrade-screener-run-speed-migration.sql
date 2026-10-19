-- ============================================================
-- DayTrade screener run-speed meta (2026-10-20)
-- ============================================================
-- Purpose: let the nightly runner distinguish an intraday FAST publish
-- (258/258 curated shortlist) from a genuine FULL ~800-name scan.
--
-- Before this, `runDayTrade` (tools/run-all-screeners-vps.js) and the
-- api/sector-hot.js `already_done` guard treated ANY same-day publish with
-- scanned_count >= universe_count as "done", so the 15-minute FAST producer
-- satisfied the night gate and the full DayTrade scan silently stopped running
-- (frozen since 30 Sep 2026).
--
-- These columns are additive and nullable; legacy rows keep NULL run_speed,
-- which the runner treats as 'fast' so the night scan still executes.
--
-- Safe to re-run (IF NOT EXISTS).

ALTER TABLE daytrade_screener_meta
  ADD COLUMN IF NOT EXISTS run_speed TEXT,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

COMMENT ON COLUMN daytrade_screener_meta.run_speed IS 'fast | full — scan speed that produced the current publish';
COMMENT ON COLUMN daytrade_screener_meta.duration_ms IS 'producer-measured duration (ms) of the run that produced the current publish';
