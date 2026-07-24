-- Test-only isolated prerequisite schema; never loaded by application code.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  is_blocked boolean NOT NULL DEFAULT false,
  is_approved boolean NOT NULL DEFAULT false
);
CREATE TABLE public.app_user_telegram_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  telegram_user_id bigint,
  verification_state text NOT NULL DEFAULT 'pending'
);
INSERT INTO public.app_users(username,is_approved) VALUES ('budi',true),('phase5c_test_user',false);
