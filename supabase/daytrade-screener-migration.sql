-- ============================================================
-- Day Trade Screener v1 — Supabase Migration
-- Run this manually in Supabase SQL Editor after review.
-- Safe to run multiple times (all IF NOT EXISTS / ON CONFLICT).
-- ============================================================

-- 1. daytrade_screener_latest: published Day Trade screener results
CREATE TABLE IF NOT EXISTS daytrade_screener_latest (
  ticker TEXT NOT NULL,
  stock_name TEXT,
  board TEXT,
  -- Classification
  status TEXT DEFAULT 'AVOID',        -- READY_BREAKOUT, PRE_SPIKE_WATCH, WAIT_PULLBACK, RECLAIM_CANDIDATE, MOMENTUM_CONTINUATION, SPECULATIVE, AVOID
  setup TEXT,                         -- setup label (e.g. 'Pre-Breakout Accumulation', 'Volume Build-Up')
  -- Scoring
  daytrade_score INTEGER DEFAULT 0,   -- 0-100 composite score
  liquidity_score NUMERIC DEFAULT 0,  -- 0-25
  prespike_score NUMERIC DEFAULT 0,   -- 0-25
  momentum_score NUMERIC DEFAULT 0,   -- 0-20
  risk_reward_score NUMERIC DEFAULT 0,-- 0-15
  trend_score NUMERIC DEFAULT 0,      -- 0-10
  penalty_score NUMERIC DEFAULT 0,    -- negative penalty applied
  -- Price data
  last_price NUMERIC,
  change_pct NUMERIC,
  open_price NUMERIC,
  high_price NUMERIC,
  low_price NUMERIC,
  -- Volume/Liquidity
  volume_today BIGINT,
  value_today NUMERIC,                -- transaction value today (Rp)
  avg_volume_20d NUMERIC,
  avg_value_7d NUMERIC,
  volume_ratio_20d NUMERIC,
  -- Technical indicators
  rsi14 NUMERIC,
  ma20 NUMERIC,
  ma50 NUMERIC,
  -- Levels
  resistance NUMERIC,
  support NUMERIC,
  range_position NUMERIC,             -- 0-100, position within day range
  distance_to_breakout_pct NUMERIC,   -- % distance to resistance/breakout
  -- Entry/SL/TP
  entry_low NUMERIC,
  entry_high NUMERIC,
  stop_loss NUMERIC,
  tp1 NUMERIC,
  tp2 NUMERIC,
  risk_reward NUMERIC,
  invalidation TEXT,
  time_plan TEXT,
  notes TEXT,
  -- Run metadata
  run_mode TEXT,                       -- MORNING_SCOUT, MIDDAY_CHECK, AFTERNOON_EXIT, OUTSIDE_MARKET
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id TEXT,
  PRIMARY KEY (ticker)
);

CREATE INDEX IF NOT EXISTS idx_dt_screener_latest_score ON daytrade_screener_latest (daytrade_score DESC);
CREATE INDEX IF NOT EXISTS idx_dt_screener_latest_status ON daytrade_screener_latest (status);
CREATE INDEX IF NOT EXISTS idx_dt_screener_latest_run_id ON daytrade_screener_latest (run_id);

-- 2. daytrade_screener_meta: single-row scan state tracking
CREATE TABLE IF NOT EXISTS daytrade_screener_meta (
  id TEXT NOT NULL DEFAULT 'latest' PRIMARY KEY,
  status TEXT DEFAULT 'idle',         -- 'idle', 'scanning', 'published', 'failed'
  run_date TEXT,
  run_mode TEXT,
  calculated_at TIMESTAMPTZ,
  universe_count INTEGER DEFAULT 0,
  scanned_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  passed_count INTEGER DEFAULT 0,
  published_count INTEGER DEFAULT 0,
  top_count INTEGER DEFAULT 0,
  run_id TEXT,
  message TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial meta row
INSERT INTO daytrade_screener_meta (id, status, message)
VALUES ('latest', 'idle', 'Awaiting first calculation.')
ON CONFLICT (id) DO NOTHING;

-- 3. daytrade_screener_runs: run history for audit/diagnostics
CREATE TABLE IF NOT EXISTS daytrade_screener_runs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_date TEXT NOT NULL,
  run_mode TEXT,
  status TEXT DEFAULT 'running',      -- 'running', 'published', 'failed'
  universe_count INTEGER DEFAULT 0,
  scanned_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  passed_count INTEGER DEFAULT 0,
  published_count INTEGER DEFAULT 0,
  message TEXT,
  failed_tickers_sample JSONB,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dt_runs_run_id ON daytrade_screener_runs (run_id);
CREATE INDEX IF NOT EXISTS idx_dt_runs_run_date ON daytrade_screener_runs (run_date);

-- ============================================================
-- RLS (Row Level Security) — DENY all direct client access
-- Only service_role (used by our API endpoint) can read/write.
-- ============================================================
ALTER TABLE daytrade_screener_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE daytrade_screener_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE daytrade_screener_runs ENABLE ROW LEVEL SECURITY;

-- No SELECT policy for anon or authenticated roles.
-- Only service_role bypasses RLS.
-- Our API endpoint enforces access control via X-User-Id + app_users check.
