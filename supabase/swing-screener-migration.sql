-- ============================================================
-- Swing Screener Konglo 3-7D — Supabase Migration
-- Run this manually in Supabase SQL Editor after review.
-- ============================================================

-- 1. swing_screener_latest: cached per-ticker screening results
CREATE TABLE IF NOT EXISTS swing_screener_latest (
  ticker TEXT NOT NULL,
  group_code TEXT NOT NULL,
  stock_name TEXT,
  -- Price data
  last_price NUMERIC,
  price_source TEXT,
  price_asof TIMESTAMPTZ,
  price_date DATE,
  change_pct NUMERIC,
  -- Technical indicators
  ma20 NUMERIC,
  ma50 NUMERIC,
  rsi14 NUMERIC,
  volume_ratio_avg20 NUMERIC,
  -- Levels
  support NUMERIC,
  resistance NUMERIC,
  entry_low NUMERIC,
  entry_high NUMERIC,
  stop_loss NUMERIC,
  tp1 NUMERIC,
  tp2 NUMERIC,
  risk_reward NUMERIC,
  -- Scoring & classification
  score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Invalid',  -- 'Swing Ready', 'Watchlist', 'Rebound Speculative', 'Invalid'
  invalidation TEXT,              -- e.g. "Close < 1850"
  status_reason TEXT,             -- e.g. "Tunggu: Volume belum cukup"
  -- AI confirmation (nullable until AI runs)
  ai_status TEXT,                 -- 'CONFIRMED', 'CAUTION', 'REJECT', NULL
  ai_reason TEXT,
  ai_red_flags TEXT[],
  final_status TEXT,              -- after AI may downgrade
  -- Metadata
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticker)
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_swing_screener_status ON swing_screener_latest (final_status);
CREATE INDEX IF NOT EXISTS idx_swing_screener_score ON swing_screener_latest (score DESC);
CREATE INDEX IF NOT EXISTS idx_swing_screener_group ON swing_screener_latest (group_code);

-- 2. swing_screener_meta: single-row metadata for last refresh
CREATE TABLE IF NOT EXISTS swing_screener_meta (
  id TEXT NOT NULL DEFAULT 'latest' PRIMARY KEY,
  calculated_at TIMESTAMPTZ,
  universe_count INTEGER DEFAULT 0,
  scanned_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  ai_called_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',       -- 'ok', 'failed', 'pending'
  message TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial meta row
INSERT INTO swing_screener_meta (id, status, message)
VALUES ('latest', 'pending', 'Awaiting first calculation.')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- RLS (Row Level Security) — DENY all direct client access
-- Only service_role (used by our API endpoint) can read/write.
-- This prevents anonymous or authenticated Supabase clients
-- from querying screener data directly via PostgREST.
-- ============================================================
ALTER TABLE swing_screener_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE swing_screener_meta ENABLE ROW LEVEL SECURITY;

-- No SELECT policy for anon or authenticated roles.
-- This means: anon = denied, authenticated = denied.
-- Only service_role bypasses RLS and can read/write.
-- Our API endpoint (sector-hot.js) uses service_role key
-- and enforces its own access control via X-User-Id + app_users check.

-- If you ever need authenticated Supabase users to read directly
-- (not via our API), you can add a policy later. For now, locked down.



-- ============================================================
-- PATCH: Add status_reason column if table already exists
-- Safe to re-run (IF NOT EXISTS equivalent via DO block)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'swing_screener_latest' AND column_name = 'status_reason'
  ) THEN
    ALTER TABLE swing_screener_latest ADD COLUMN status_reason TEXT;
  END IF;
END $$;
