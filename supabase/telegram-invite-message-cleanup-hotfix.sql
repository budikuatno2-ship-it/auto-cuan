-- =========================================================================
-- Telegram verification v2 — INVITE MESSAGE CLEANUP HOTFIX (additive migration).
--
-- PURPOSE
--   A chat_join_request update does NOT carry the message_id of the earlier
--   private "Ajukan Bergabung" approval message. To let the webhook edit that
--   exact message (remove the used join button after a successful approval) we
--   persist its message_id on the bound verification row.
--
--   The chat reference is the EXISTING telegram_private_chat_id column, so no
--   additional chat-id column is introduced.
--
-- SAFETY / SCOPE
--   - Additive ONLY. It adds a single nullable column
--     (ADD COLUMN IF NOT EXISTS invite_message_id bigint) to the existing
--     public.app_user_telegram_verifications table and adds two functions.
--     It performs NO destructive ALTER/DROP on any table, column, or index.
--   - Both functions are SECURITY DEFINER with a fixed, non-hijackable
--     search_path (pg_catalog, public), fully schema-qualified, owned by
--     postgres, and granted EXECUTE to service_role only (revoked from
--     PUBLIC/anon/authenticated).
--   - RLS posture is unchanged: the underlying table stays service-role-only
--     (no anon/authenticated policies are added or altered here).
--   - No raw code, bot token, or full Telegram payload is stored. Only the
--     numeric Telegram message_id of the approval message.
--
-- This file is a migration DRAFT for review. Do NOT rely on it being applied by
-- the application; run it intentionally by an operator AFTER the base migration
-- (supabase/telegram-verification-v2-migration.sql) and the approval-gate hotfix
-- (supabase/telegram-verification-v2-approval-gate-hotfix.sql).
-- =========================================================================

-- -------------------------------------------------------------------------
-- Column: message_id of the private approval ("Ajukan Bergabung") message so a
-- later chat_join_request can edit that exact message and remove its keyboard.
-- -------------------------------------------------------------------------
ALTER TABLE public.app_user_telegram_verifications
  ADD COLUMN IF NOT EXISTS invite_message_id bigint;

-- -------------------------------------------------------------------------
-- RPCs (service-role only)
-- -------------------------------------------------------------------------

-- Persist the message_id of the approval message just delivered to the user.
CREATE OR REPLACE FUNCTION public.save_invite_message_id(
  p_user_id uuid, p_message_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.app_user_telegram_verifications
     SET invite_message_id = p_message_id,
         updated_at = now()
   WHERE user_id = p_user_id;
END $$;

-- Clear the stored approval message_id once its button has been removed (either
-- because the message was edited into the completed state, or it is gone).
CREATE OR REPLACE FUNCTION public.clear_invite_message_id(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.app_user_telegram_verifications
     SET invite_message_id = NULL,
         updated_at = now()
   WHERE user_id = p_user_id;
END $$;

-- =========================================================================
-- GRANTS: lock every new function to service_role only; owner postgres (DEFINER).
-- RLS on public.app_user_telegram_verifications is intentionally left unchanged.
-- =========================================================================
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
   'public.save_invite_message_id(uuid,bigint)',
   'public.clear_invite_message_id(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role;', fn);
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres;', fn);
  END LOOP;
END $$;

-- No table-level grants to anon/authenticated (RLS posture unchanged).
REVOKE ALL ON public.app_user_telegram_verifications FROM anon, authenticated;
