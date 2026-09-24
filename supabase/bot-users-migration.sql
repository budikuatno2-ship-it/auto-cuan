-- Interactive Telegram bot users. Service role only.
-- BYOK secrets stay in user_ai_credentials; this table stores approval state.

BEGIN;

CREATE TABLE IF NOT EXISTS public.bot_users (
  telegram_id text PRIMARY KEY,
  username text,
  gmail text,
  provider text NOT NULL DEFAULT 'gemini',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bot_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bot_users FROM PUBLIC, anon, authenticated;

COMMIT;
