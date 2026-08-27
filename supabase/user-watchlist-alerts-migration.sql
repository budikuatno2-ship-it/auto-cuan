-- =========================================================================
-- Migration: Personal Watchlist and Custom Price Alerts
-- Tables: public.app_user_watchlists, public.app_user_alerts
-- =========================================================================

-- 1. Personal Watchlist Table
CREATE TABLE IF NOT EXISTS public.app_user_watchlists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  ticker       text NOT NULL,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_app_user_watchlist_ticker UNIQUE (user_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_app_user_watchlists_user
  ON public.app_user_watchlists (user_id, created_at DESC);

-- 2. Custom User Alerts Table
CREATE TABLE IF NOT EXISTS public.app_user_alerts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  watchlist_id         uuid REFERENCES public.app_user_watchlists(id) ON DELETE CASCADE,
  ticker               text NOT NULL,
  condition_type       text NOT NULL
                         CHECK (condition_type IN ('PRICE_ABOVE', 'PRICE_BELOW', 'ENTRY_ZONE', 'TP_HIT', 'SL_HIT')),
  target_price         numeric,
  is_active            boolean NOT NULL DEFAULT true,
  is_triggered         boolean NOT NULL DEFAULT false,
  triggered_at         timestamptz,
  last_notified_at     timestamptz,
  notification_chat_id bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Partial index for high-performance active alert evaluations during monitor cron runs
CREATE INDEX IF NOT EXISTS idx_app_user_alerts_active_eval
  ON public.app_user_alerts (ticker)
  WHERE is_active = true AND is_triggered = false;

CREATE INDEX IF NOT EXISTS idx_app_user_alerts_user
  ON public.app_user_alerts (user_id, is_active);

-- Row Level Security (RLS)
ALTER TABLE public.app_user_watchlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_user_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.app_user_watchlists FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_user_watchlists TO service_role;

REVOKE ALL ON public.app_user_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_user_alerts TO service_role;