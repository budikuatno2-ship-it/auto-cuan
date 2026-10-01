-- Test-only isolated prerequisite schema; never loaded by application code.
-- Mirrors the real column shapes create_admin_access_request /
-- activate_admin_access_request / consume_admin_access_request actually
-- depend on (supabase/telegram-verification-v2-migration.sql), just trimmed
-- to only what this migration reads.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

CREATE TABLE public.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  is_blocked boolean NOT NULL DEFAULT false,
  is_approved boolean NOT NULL DEFAULT false
);

CREATE TABLE public.app_user_telegram_verifications (
  user_id uuid PRIMARY KEY REFERENCES public.app_users(id) ON DELETE CASCADE,
  telegram_user_id bigint,
  telegram_private_chat_id bigint,
  telegram_verified_at timestamptz
);

INSERT INTO public.app_users (username, is_approved) VALUES ('budi', true);
INSERT INTO public.app_user_telegram_verifications (user_id, telegram_user_id, telegram_private_chat_id, telegram_verified_at)
  SELECT id, 999999001, 999999001, now() FROM public.app_users WHERE username = 'budi';
