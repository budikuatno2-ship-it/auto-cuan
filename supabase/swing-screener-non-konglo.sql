-- ============================================================
-- Swing Screener Non-Konglo v1 — Supabase Migration
-- Run this manually in Supabase SQL Editor after review.
-- Safe to run multiple times (all IF NOT EXISTS / ON CONFLICT).
-- ============================================================

-- 1. swing_screener_non_konglo_latest: published Top 15 results
CREATE TABLE IF NOT EXISTS swing_screener_non_konglo_latest (
  ticker TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  board TEXT,
  -- Price data
  last_price NUMERIC,
  price_source TEXT,
  price_asof TIMESTAMPTZ,
  price_date DATE,
  change_pct NUMERIC,
  -- Liquidity & activity (required for audit)
  avg_volume_20d NUMERIC,
  avg_transaction_value_20d NUMERIC,  -- avg_volume_20d * last_price, must be >= 10B
  traded_days_20d INTEGER,            -- must be >= 15
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
  -- Canonical Trade Plan V2 snapshot (computed while full runtime structure exists)
  trade_plan_v2 JSONB,
  trade_plan_v2_structural JSONB,
  -- Scoring & classification
  score INTEGER DEFAULT 0,
  grade TEXT DEFAULT 'D',             -- 'A', 'B', 'C', 'D'
  status TEXT DEFAULT 'Watchlist',    -- 'Swing Ready', 'Watchlist', 'Speculative'
  status_reason TEXT,                 -- human-readable reason/catatan
  -- Metadata
  run_date TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticker)
);

CREATE INDEX IF NOT EXISTS idx_nk_screener_latest_rank ON swing_screener_non_konglo_latest (rank ASC);
CREATE INDEX IF NOT EXISTS idx_nk_screener_latest_score ON swing_screener_non_konglo_latest (score DESC);
CREATE INDEX IF NOT EXISTS idx_nk_screener_latest_board ON swing_screener_non_konglo_latest (board);

-- 2. swing_screener_non_konglo_meta: single-row scan state tracking
CREATE TABLE IF NOT EXISTS swing_screener_non_konglo_meta (
  id TEXT NOT NULL DEFAULT 'latest' PRIMARY KEY,
  status TEXT DEFAULT 'idle',         -- 'idle', 'scanning', 'finalizing', 'published', 'failed'
  run_date TEXT,
  calculated_at TIMESTAMPTZ,
  universe_count INTEGER DEFAULT 0,
  scanned_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  published_count INTEGER DEFAULT 0,
  message TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial meta row
INSERT INTO swing_screener_non_konglo_meta (id, status, message)
VALUES ('latest', 'idle', 'Awaiting first calculation.')
ON CONFLICT (id) DO NOTHING;

-- 3. swing_screener_non_konglo_jobs: batch tracking per run
CREATE TABLE IF NOT EXISTS swing_screener_non_konglo_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_date TEXT NOT NULL,
  batch_index INTEGER NOT NULL DEFAULT 0,
  tickers TEXT[] DEFAULT '{}',
  boards JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending',      -- 'pending', 'processing', 'done', 'failed'
  result_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nk_jobs_run_date ON swing_screener_non_konglo_jobs (run_date);
CREATE INDEX IF NOT EXISTS idx_nk_jobs_status ON swing_screener_non_konglo_jobs (status);
CREATE INDEX IF NOT EXISTS idx_nk_jobs_run_status ON swing_screener_non_konglo_jobs (run_date, status);

-- Unique constraint: prevent duplicate batches for same run
CREATE UNIQUE INDEX IF NOT EXISTS idx_nk_jobs_run_batch_unique
  ON swing_screener_non_konglo_jobs (run_date, batch_index);

-- 4. swing_screener_non_konglo_staging: scored candidates before publish
CREATE TABLE IF NOT EXISTS swing_screener_non_konglo_staging (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  board TEXT,
  run_date TEXT NOT NULL,
  -- Price data
  last_price NUMERIC,
  change_pct NUMERIC,
  -- Liquidity & activity (required for audit)
  avg_volume_20d NUMERIC,
  avg_transaction_value_20d NUMERIC,
  traded_days_20d INTEGER,
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
  -- Canonical Trade Plan V2 snapshot (survives batch -> staging -> finalize)
  trade_plan_v2 JSONB,
  trade_plan_v2_structural JSONB,
  -- Scoring
  score INTEGER DEFAULT 0,
  grade TEXT DEFAULT 'D',
  status TEXT DEFAULT 'Watchlist',
  status_reason TEXT,
  -- Metadata
  calculated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nk_staging_run_date ON swing_screener_non_konglo_staging (run_date);
CREATE INDEX IF NOT EXISTS idx_nk_staging_score ON swing_screener_non_konglo_staging (score DESC);
CREATE INDEX IF NOT EXISTS idx_nk_staging_run_score ON swing_screener_non_konglo_staging (run_date, score DESC);

-- Unique constraint: prevent duplicate ticker per run (idempotent upsert)
CREATE UNIQUE INDEX IF NOT EXISTS idx_nk_staging_run_ticker_unique
  ON swing_screener_non_konglo_staging (run_date, ticker);

-- ============================================================
-- RLS (Row Level Security) — DENY all direct client access
-- Only service_role (used by our API endpoint) can read/write.
-- ============================================================
ALTER TABLE swing_screener_non_konglo_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE swing_screener_non_konglo_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE swing_screener_non_konglo_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE swing_screener_non_konglo_staging ENABLE ROW LEVEL SECURITY;

-- No SELECT policy for anon or authenticated roles.
-- Only service_role bypasses RLS.
-- Our API endpoint enforces access control via X-User-Id + app_users check.
