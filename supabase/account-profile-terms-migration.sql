-- Account profile / terms acceptance foundation.
-- ADDITIVE ONLY. Apply deliberately in Supabase SQL Editor before enabling the UI.
BEGIN;

CREATE TABLE IF NOT EXISTS public.account_terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  terms_version text NOT NULL CHECK (terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-v[0-9]+$'),
  acceptance_source text NOT NULL DEFAULT 'registration'
    CHECK (acceptance_source IN ('registration','profile')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, terms_version)
);

CREATE INDEX IF NOT EXISTS idx_account_terms_user_accepted
  ON public.account_terms_acceptances(user_id, accepted_at DESC);

ALTER TABLE public.account_terms_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_terms_acceptances FROM PUBLIC, anon, authenticated;

-- The browser never calls this table directly. Registration/profile APIs use the
-- service role after signed/validated identity checks. No public policies exist.

COMMIT;
