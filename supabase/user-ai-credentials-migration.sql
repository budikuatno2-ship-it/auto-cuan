-- Migration: User AI Credentials & Chart Analysis Usage
-- Purpose: Secure BYOK credential storage with AES-256-GCM and daily WIB rate limiting.

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_ai_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'gemini',
  encrypted_api_key text NOT NULL,
  key_hint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_ai_credentials_user_provider
  ON public.user_ai_credentials(user_id, provider);

ALTER TABLE public.user_ai_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_ai_credentials FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.user_chart_analysis_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  analysis_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_user_chart_analysis_usage_date
  ON public.user_chart_analysis_usage(user_id, usage_date);

ALTER TABLE public.user_chart_analysis_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_chart_analysis_usage FROM PUBLIC, anon, authenticated;

COMMIT;
