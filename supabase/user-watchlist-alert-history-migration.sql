-- =========================================================================
-- Migration: Personal Watchlist Alert Change History
-- Table: public.app_user_alert_history
--
-- Records every create/update/delete/trigger event on a user's own custom
-- price alerts (public.app_user_alerts), so a user can see what changed to
-- their own alerts over time. Visible to the end user themselves (Bagian
-- 6.8), not admin-only. `alert_id` has no FK/ON DELETE CASCADE on purpose:
-- history rows must survive the alert row being deleted, so the user can
-- still see "you deleted alert X on <date>" after the fact.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.app_user_alert_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  alert_id       uuid,
  ticker         text NOT NULL,
  action         text NOT NULL
                   CHECK (action IN ('created', 'updated', 'deleted', 'triggered')),
  condition_type text,
  target_price   numeric,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_user_alert_history_user
  ON public.app_user_alert_history (user_id, created_at DESC);

ALTER TABLE public.app_user_alert_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.app_user_alert_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.app_user_alert_history TO service_role;
