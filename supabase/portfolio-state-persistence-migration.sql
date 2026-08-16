-- =========================================================================
-- Auto-Cuan portfolio persistence (Supabase-backed, per app user)
--
-- Browser code never talks to this table directly. The existing server-side
-- Vercel function authenticates the signed Auto-Cuan session and uses the
-- service role. localStorage remains a cache/fallback only.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.app_user_portfolio_state (
  user_id      uuid PRIMARY KEY REFERENCES public.app_users(id) ON DELETE CASCADE,
  state        jsonb NOT NULL DEFAULT '{"version":1,"plans":[],"prices":{},"price_meta":{},"journal":[],"snapshot":null,"changes":[],"price_updated_at":null}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_portfolio_state_object CHECK (jsonb_typeof(state) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_app_user_portfolio_state_updated_at
  ON public.app_user_portfolio_state (updated_at DESC);

ALTER TABLE public.app_user_portfolio_state ENABLE ROW LEVEL SECURITY;

-- Fail closed for browser-facing database roles. Access is only through the
-- authenticated server-side endpoint using SUPABASE_SERVICE_ROLE_KEY.
REVOKE ALL ON public.app_user_portfolio_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_user_portfolio_state TO service_role;
