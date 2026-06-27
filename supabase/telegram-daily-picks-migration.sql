-- ============================================================
-- Telegram Daily Picks v1 — Supabase Migration
-- Stores the automatic 08:00 WIB Top 5 and intraday monitor state.
-- Safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS telegram_daily_picks (
  id BIGSERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  ticker TEXT NOT NULL,
  category TEXT,
  entry1 NUMERIC,
  entry2 NUMERIC,
  tp1 NUMERIC,
  tp2 NUMERIC,
  sl NUMERIC,
  status TEXT DEFAULT 'WAITING',
  first_sent_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  hit_entry_at TIMESTAMPTZ,
  hit_tp1_at TIMESTAMPTZ,
  hit_tp2_at TIMESTAMPTZ,
  hit_sl_at TIMESTAMPTZ,
  is_final BOOLEAN DEFAULT FALSE,
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT telegram_daily_picks_date_ticker_key UNIQUE (date, ticker)
);

ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS entry1 NUMERIC;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS entry2 NUMERIC;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS tp1 NUMERIC;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS tp2 NUMERIC;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS sl NUMERIC;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'WAITING';
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS first_sent_at TIMESTAMPTZ;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS hit_entry_at TIMESTAMPTZ;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS hit_tp1_at TIMESTAMPTZ;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS hit_tp2_at TIMESTAMPTZ;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS hit_sl_at TIMESTAMPTZ;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS is_final BOOLEAN DEFAULT FALSE;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS raw_payload JSONB;
ALTER TABLE telegram_daily_picks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_telegram_daily_picks_date ON telegram_daily_picks (date);
CREATE INDEX IF NOT EXISTS idx_telegram_daily_picks_date_status ON telegram_daily_picks (date, status);
CREATE INDEX IF NOT EXISTS idx_telegram_daily_picks_ticker ON telegram_daily_picks (ticker);

ALTER TABLE telegram_daily_picks ENABLE ROW LEVEL SECURITY;
