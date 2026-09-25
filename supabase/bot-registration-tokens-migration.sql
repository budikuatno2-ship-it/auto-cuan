-- One-time bot registration tokens.
-- Shared between the interactive bot (PM2) and the public web form
-- (api/bot-register.js) so a token issued by the bot can be verified and
-- burned by the web process. Service role only; RLS fully denies anon/auth.

BEGIN;

CREATE TABLE IF NOT EXISTS public.bot_registration_tokens (
  token text PRIMARY KEY,
  telegram_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bot_registration_tokens_telegram_id_idx
  ON public.bot_registration_tokens (telegram_id);

ALTER TABLE public.bot_registration_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bot_registration_tokens FROM PUBLIC, anon, authenticated;

COMMIT;
