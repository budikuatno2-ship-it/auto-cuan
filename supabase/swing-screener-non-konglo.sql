-- =============================================
-- SWING SCREENER NON-KONGLO v1 — SCHEMA
-- Run this in Supabase SQL Editor manually.
-- Do NOT run automatically.
-- Separate tables to avoid mixing with Konglo Screener.
-- =============================================

-- Table 1: Latest results cache (Top 15 published after full scan)
CREATE TABLE IF NOT EXISTS public.swing_screener_non_konglo_latest (
  id bigserial PRIMARY KEY,
  ticker text NOT NULL,
  stock_name text,
  board text, -- UTAMA or PENGEMBANGAN
  last_price numeric,
  change_pct numeric,
  avg_volume_20d numeric,
  avg_transaction_value_20d numeric, -- avg_volume_20d * last_price
  volume_ratio_avg20 numeric,
  traded_days_20d int,
  rsi14 numeric,
  ma20 numeric,
  ma50 numeric,
  risk_reward numeric,
  setup_score numeric NOT NULL DEFAULT 0, -- 0-100
  setup_grade text, -- A/B/C/D/E
  status text, -- 'valid', 'filtered', etc.
  reason text, -- human-readable explanation
  rank_position int, -- 1-15
  calculated_at timestamptz NOT NULL,
  UNIQUE(ticker)
);

-- Table 2: Scan metadata (single row, tracks overall scan state)
CREATE TABLE IF NOT EXISTS public.swing_screener_non_konglo_meta (
  id text PRIMARY KEY DEFAULT 'latest',
  scan_date date, -- the trading date this scan is for
  status text NOT NULL DEFAULT 'idle', -- idle, scanning, completed, failed
  total_universe int DEFAULT 0,
  processed_count int DEFAULT 0,
  passed_hard_filter int DEFAULT 0,
  current_batch int DEFAULT 0,
  total_batches int DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  message text,
  updated_at timestamptz DEFAULT now()
);

-- Table 3: Batch job tracking (one row per batch, for resume/idempotency)
CREATE TABLE IF NOT EXISTS public.swing_screener_non_konglo_jobs (
  id bigserial PRIMARY KEY,
  scan_date date NOT NULL,
  batch_number int NOT NULL,
  tickers text[] NOT NULL, -- array of tickers in this batch
  status text NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
  results jsonb, -- scored results for this batch
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(scan_date, batch_number)
);

-- Table 4: Staging table for scored candidates before publish
CREATE TABLE IF NOT EXISTS public.swing_screener_non_konglo_staging (
  id bigserial PRIMARY KEY,
  scan_date date NOT NULL,
  ticker text NOT NULL,
  stock_name text,
  board text,
  last_price numeric,
  change_pct numeric,
  avg_volume_20d numeric,
  avg_transaction_value_20d numeric,
  volume_ratio_avg20 numeric,
  traded_days_20d int,
  rsi14 numeric,
  ma20 numeric,
  ma50 numeric,
  risk_reward numeric,
  setup_score numeric NOT NULL DEFAULT 0,
  setup_grade text,
  status text,
  reason text,
  calculated_at timestamptz NOT NULL,
  UNIQUE(scan_date, ticker)
);

-- RLS: Enable on all tables, access via service role only (same pattern as Konglo)
ALTER TABLE public.swing_screener_non_konglo_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swing_screener_non_konglo_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swing_screener_non_konglo_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swing_screener_non_konglo_staging ENABLE ROW LEVEL SECURITY;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_ssnkl_score ON public.swing_screener_non_konglo_latest(setup_score DESC);
CREATE INDEX IF NOT EXISTS idx_ssnkl_rank ON public.swing_screener_non_konglo_latest(rank_position ASC);
CREATE INDEX IF NOT EXISTS idx_ssnkj_scan ON public.swing_screener_non_konglo_jobs(scan_date, batch_number);
CREATE INDEX IF NOT EXISTS idx_ssnks_scan ON public.swing_screener_non_konglo_staging(scan_date, setup_score DESC);

-- Initialize meta row
INSERT INTO public.swing_screener_non_konglo_meta (id, status, message)
VALUES ('latest', 'idle', 'Awaiting first scan.')
ON CONFLICT (id) DO NOTHING;
