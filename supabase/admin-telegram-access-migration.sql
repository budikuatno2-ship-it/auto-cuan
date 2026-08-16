-- =========================================================================
-- Auto-Cuan admin Telegram access approval (additive only).
--
-- Purpose:
--   Replaces the maintenance-page username/password admin entry with a
--   Telegram-INITIATED, browser-bound, one-time challenge. Creating a
--   challenge from the public maintenance page (create_admin_access_request)
--   is always dormant and NEVER sends a Telegram message — it only writes a
--   row and returns an opaque requestRef for a deep link
--   (t.me/<bot>?start=<requestRef>). A message is sent to the admin's
--   Telegram ONLY when that admin's own already-verified Telegram account
--   opens the deep link and activate_admin_access_request confirms the
--   sender's telegram_user_id against the existing verified binding
--   (public.app_user_telegram_verifications, set up by the auth-recovery-v1
--   enrollment flow) — the ONLY identity check used anywhere in this flow.
--   Authorization is still only ever granted by the existing signed HttpOnly
--   ac_sess cookie issued server-side after this challenge is consumed —
--   this table never grants access itself.
--
-- Security:
--   - New table only. No existing table, column, or constraint is altered.
--   - Every RPC is SECURITY DEFINER, fixed-search-path, and service-role only.
--   - No raw challenge/browser-binding value is stored, only its SHA-256 hash.
--   - At most one active (pending/approved) request per admin user at a time.
--   - Activation (and therefore the one Telegram send it may cause) is
--     claimed under a row lock so two near-simultaneous /start updates for
--     the same requestRef can send at most one approval message.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.admin_access_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  request_ref           text NOT NULL UNIQUE,
  browser_binding_hash  text NOT NULL,
  state                 text NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending','approved','denied','consumed','expired')),
  telegram_user_id      bigint,
  telegram_chat_id      bigint,
  telegram_message_id   bigint,
  activation_claimed_at timestamptz,
  request_context       text,
  requester_ip_hash     text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  approved_at           timestamptz,
  denied_at             timestamptz,
  consumed_at           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Active-slot invariant applies ONLY to Telegram-ACTIVATED requests
-- (telegram_message_id IS NOT NULL, i.e. the bound admin's own Telegram
-- already confirmed and received the approval message). A dormant row
-- created by the public, unauthenticated maintenance page has
-- telegram_message_id NULL and therefore never occupies this slot and never
-- blocks anyone else's create/activate — this is what stops an anonymous
-- caller from griefing the real admin's login by permanently squatting the
-- one-active-admin-challenge invariant with challenges nobody ever
-- Telegram-activates.
DROP INDEX IF EXISTS uq_admin_access_active_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_access_active_user
  ON public.admin_access_requests (user_id)
  WHERE state IN ('pending','approved') AND telegram_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_access_expiry
  ON public.admin_access_requests (expires_at)
  WHERE state IN ('pending','approved');

-- Per-IP anti-spam window. Only ever populated from a hash (never the raw
-- IP as an identifier tied to the row's other purpose), and only used to
-- COUNT recent rows in a short window, not to look anyone up.
CREATE INDEX IF NOT EXISTS idx_admin_access_ip_window
  ON public.admin_access_requests (requester_ip_hash, created_at)
  WHERE requester_ip_hash IS NOT NULL;

-- Global creation-rate window (DB hygiene only, not identity/authorization).
-- Bounds worst-case row growth from many distinct/rotating IPs, independent
-- of the per-IP layer above.
CREATE INDEX IF NOT EXISTS idx_admin_access_created_at
  ON public.admin_access_requests (created_at);

ALTER TABLE public.admin_access_requests ENABLE ROW LEVEL SECURITY;

-- Create a new DORMANT admin-access challenge for the given (always 'budi')
-- account. This function NEVER sends or triggers a Telegram message — it
-- only ever writes a row. Fails closed with a distinct result_code when:
-- the account is not the eligible admin, it has no verified Telegram
-- binding, the caller's IP has made too many requests recently (database
-- hygiene only, see below), or a challenge is already live for this admin.
--
-- Layered anti-abuse (public, unauthenticated endpoint by design). Neither
-- layer exists to bound Telegram traffic — creation never causes Telegram
-- traffic at all — they exist to keep this publicly-writable table from
-- growing unbounded and to stop an anonymous caller from griefing a
-- legitimate in-flight admin approval:
--   1. per-IP window: at most MAX_PER_IP requests per IP-hash per 5 minutes,
--      checked BEFORE anything else so a rate-limited caller never touches
--      an existing live row.
--   2. no preemption: a live (pending/approved, unexpired) challenge for
--      this admin is NEVER expired/replaced by a new create call — an
--      unauthenticated caller must not be able to invalidate a legitimate
--      in-flight admin approval that just hasn't been consumed yet. The
--      admin's own browser keeps polling its own request_ref regardless;
--      anyone else (this endpoint has no caller identity) is simply told to
--      wait, bounded by the ~2 minute TTL — never a permanent lockout.
CREATE OR REPLACE FUNCTION public.create_admin_access_request(
  p_username text,
  p_request_ref text,
  p_browser_binding_hash text,
  p_expires_at timestamptz,
  p_context text,
  p_ip_hash text DEFAULT NULL
)
RETURNS TABLE (
  result_code text,
  request_id uuid,
  user_id uuid,
  telegram_user_id bigint,
  telegram_chat_id bigint,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
  v_request public.admin_access_requests%ROWTYPE;
  v_existing public.admin_access_requests%ROWTYPE;
  v_ip_count integer;
  v_global_count integer;
BEGIN
  SELECT au.* INTO v_user
    FROM public.app_users AS au
   WHERE lower(au.username) = lower(trim(p_username))
   FOR UPDATE;

  IF NOT FOUND OR lower(v_user.username) <> 'budi'
     OR v_user.is_blocked IS TRUE OR v_user.is_approved IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::uuid, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  -- Column names here (user_id, telegram_user_id) collide with this
  -- function's own RETURNS TABLE output columns. Inside PL/pgSQL, unqualified
  -- references are resolved against BOTH the table and the function's own
  -- output-parameter variables, which PostgreSQL can find genuinely
  -- ambiguous at runtime ("column reference ... is ambiguous") even though
  -- the query looks unambiguous by eye. Every reference below is qualified
  -- with an explicit table alias for exactly this reason — never rely on
  -- PL/pgSQL name-resolution coincidence.
  SELECT v.* INTO v_ver
    FROM public.app_user_telegram_verifications AS v
   WHERE v.user_id = v_user.id
     AND v.telegram_user_id IS NOT NULL
     AND v.telegram_private_chat_id IS NOT NULL
     AND v.telegram_verified_at IS NOT NULL;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_bound'::text, NULL::uuid, v_user.id, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_ip_hash IS NOT NULL THEN
    SELECT count(*) INTO v_ip_count
      FROM public.admin_access_requests AS aar
     WHERE aar.requester_ip_hash = p_ip_hash
       AND aar.created_at > now() - interval '5 minutes';

    IF v_ip_count >= 5 THEN
      RETURN QUERY SELECT 'ip_throttled'::text, NULL::uuid, v_user.id, NULL::bigint, NULL::bigint, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;

  -- Global creation-rate bound (DB hygiene only): caps worst-case row growth
  -- from many distinct/rotating IPs even though each dormant row never
  -- blocks anyone or sends a Telegram message on its own.
  SELECT count(*) INTO v_global_count
    FROM public.admin_access_requests AS aar
   WHERE aar.created_at > now() - interval '5 minutes';

  IF v_global_count >= 100 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, v_user.id, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  -- No-preemption check applies ONLY to a request that has actually been
  -- Telegram-ACTIVATED (telegram_message_id IS NOT NULL) — a dormant,
  -- never-activated challenge (created by any anonymous caller, including a
  -- flood of them) must NEVER be able to block the real admin's own next
  -- launch. This is the fix for the admin-slot-griefing gap: previously any
  -- dormant 'pending' row counted as "live" here, so an anonymous caller
  -- could squat the one-active-admin-challenge slot indefinitely by
  -- recreating a fresh dormant challenge every ~2 minutes without ever
  -- opening the Telegram deep link.
  SELECT aar.* INTO v_existing
    FROM public.admin_access_requests AS aar
   WHERE aar.user_id = v_user.id
     AND aar.state IN ('pending','approved')
     AND aar.telegram_message_id IS NOT NULL
     AND aar.expires_at > now()
   ORDER BY aar.created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN QUERY SELECT 'throttled'::text, NULL::uuid, v_user.id, NULL::bigint, NULL::bigint, v_existing.expires_at;
    RETURN;
  END IF;

  -- Lazy cleanup only: rows already past their TTL never block a new
  -- request (they are not "live"), so marking them expired here is
  -- housekeeping, not a preemption of anything still valid.
  UPDATE public.admin_access_requests AS aar
     SET state = 'expired', updated_at = now()
   WHERE aar.user_id = v_user.id
     AND aar.state IN ('pending','approved')
     AND aar.expires_at <= now();

  -- Bounded, opportunistic hygiene: drop this admin's own old terminal-state
  -- rows (already denied/consumed/expired for over a day) so the table does
  -- not grow without bound purely from routine day-to-day use. Scoped to
  -- this user_id only so the cost stays tied to a single index lookup.
  DELETE FROM public.admin_access_requests AS aar
   WHERE aar.user_id = v_user.id
     AND aar.state IN ('denied','consumed','expired')
     AND aar.updated_at < now() - interval '1 day';

  INSERT INTO public.admin_access_requests (
    user_id, request_ref, browser_binding_hash, state, expires_at, request_context, requester_ip_hash
  ) VALUES (
    v_user.id, p_request_ref, p_browser_binding_hash, 'pending', p_expires_at, left(coalesce(p_context, ''), 200), p_ip_hash
  ) RETURNING * INTO v_request;

  RETURN QUERY SELECT 'ok'::text, v_request.id, v_user.id,
                      v_ver.telegram_user_id, v_ver.telegram_private_chat_id,
                      v_request.expires_at;
END
$$;

-- Telegram-initiated activation CLAIM. Called when the admin's own Telegram
-- deep links into the bot with /start <requestRef>. This is the ONLY path
-- that may result in a Telegram message being sent for this challenge — the
-- public website (create_admin_access_request) never sends one. Only
-- succeeds when p_telegram_user_id is already the challenge admin's
-- verified Telegram binding.
--
-- True idempotency, not just replay-safety: a claim is a distinct state from
-- "sent" (telegram_message_id IS NOT NULL) so a second /start — the same
-- Telegram update replayed, a brand-new update re-typing the same ref, or
-- two updates racing — can be told to send NOTHING rather than resending the
-- approval message:
--   telegram_message_id already set  -> 'already_activated' (send nothing)
--   activation_claimed_at is recent  -> 'claim_in_progress'  (send nothing;
--                                        another concurrent /start is
--                                        already attempting delivery)
--   otherwise                        -> 'claimed' (caller must now attempt
--                                        exactly one bot.sendMessage)
-- The claim_in_progress window (20s) is comfortably above the bot client's
-- own HTTP timeout (5s, telegram-verify-bot.js), so a genuinely failed send
-- is never blocked from retry for more than ~20s even if
-- release_admin_access_activation is never reached (e.g. the process died
-- mid-send) — never a permanent lock, bounded well inside the ~2 minute TTL.
CREATE OR REPLACE FUNCTION public.activate_admin_access_request(
  p_request_ref text,
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint
)
RETURNS TABLE (
  result_code text,
  request_context text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.admin_access_requests%ROWTYPE;
BEGIN
  SELECT aar.* INTO v_request
    FROM public.admin_access_requests AS aar
   WHERE aar.request_ref = p_request_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() AND v_request.state IN ('pending','approved') THEN
    UPDATE public.admin_access_requests SET state = 'expired', updated_at = now() WHERE id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, NULL::text, v_request.expires_at;
    RETURN;
  END IF;

  IF v_request.state <> 'pending' THEN
    RETURN QUERY SELECT ('already_' || v_request.state)::text, NULL::text, v_request.expires_at;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.app_user_telegram_verifications v
     WHERE v.user_id = v_request.user_id
       AND v.telegram_user_id = p_telegram_user_id
       AND v.telegram_verified_at IS NOT NULL
  ) THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_request.telegram_message_id IS NOT NULL THEN
    RETURN QUERY SELECT 'already_activated'::text, NULL::text, v_request.expires_at;
    RETURN;
  END IF;

  IF v_request.activation_claimed_at IS NOT NULL AND v_request.activation_claimed_at > now() - interval '20 seconds' THEN
    RETURN QUERY SELECT 'claim_in_progress'::text, NULL::text, v_request.expires_at;
    RETURN;
  END IF;

  -- Serialize activation attempts per admin: locks out any concurrent
  -- create/activate touching this same admin's rows for the rest of this
  -- transaction, which is what makes the sibling-row check below race-free
  -- (no other transaction can flip a sibling dormant row's
  -- telegram_message_id from NULL to NOT NULL while this lock is held).
  PERFORM 1 FROM public.app_users AS au WHERE au.id = v_request.user_id FOR UPDATE;

  -- The verified admin may have multiple dormant challenges outstanding
  -- (several browser tabs, retries, etc). Only ever let ONE of them become
  -- truly Telegram-activated at a time — if a sibling challenge for the same
  -- admin is already activated and still live, tell the caller to use that
  -- one instead of sending a second approval message for a different ref.
  IF EXISTS (
    SELECT 1 FROM public.admin_access_requests AS aar2
     WHERE aar2.user_id = v_request.user_id
       AND aar2.request_ref <> v_request.request_ref
       AND aar2.state IN ('pending','approved')
       AND aar2.telegram_message_id IS NOT NULL
       AND aar2.expires_at > now()
  ) THEN
    RETURN QUERY SELECT 'already_active'::text, NULL::text, v_request.expires_at;
    RETURN;
  END IF;

  UPDATE public.admin_access_requests
     SET telegram_user_id = p_telegram_user_id,
         telegram_chat_id = p_telegram_chat_id,
         activation_claimed_at = now(),
         updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'claimed'::text, v_request.request_context, v_request.expires_at;
END
$$;

-- Releases a failed activation claim so the SAME verified admin identity can
-- retry within the original TTL, without waiting out the claim_in_progress
-- window. Requires the caller to be the exact identity that made the claim
-- (defense in depth — this RPC is service-role-only and only ever invoked
-- internally right after that identity's own failed bot.sendMessage, but an
-- anonymous/public caller could never reach it either way) and refuses once
-- a message has actually been sent (telegram_message_id IS NOT NULL), so a
-- stale/late release can never undo a successful send.
CREATE OR REPLACE FUNCTION public.release_admin_access_activation(
  p_request_ref text,
  p_telegram_user_id bigint
)
RETURNS TABLE (result_code text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH released AS (
    UPDATE public.admin_access_requests
       SET activation_claimed_at = NULL, updated_at = now()
     WHERE request_ref = p_request_ref
       AND telegram_user_id = p_telegram_user_id
       AND telegram_message_id IS NULL
    RETURNING 1
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM released) THEN 'ok' ELSE 'not_found' END;
$$;

-- Records the Telegram message identity right after it is sent, so it can
-- later be edited/deleted without a second round trip through the browser.
CREATE OR REPLACE FUNCTION public.record_admin_access_message(
  p_request_ref text,
  p_telegram_chat_id bigint,
  p_telegram_message_id bigint
)
RETURNS TABLE (result_code text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH updated AS (
    UPDATE public.admin_access_requests
       SET telegram_chat_id = p_telegram_chat_id,
           telegram_message_id = p_telegram_message_id,
           updated_at = now()
     WHERE request_ref = p_request_ref
       AND state = 'pending'
    RETURNING 1
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'ok' ELSE 'not_found' END;
$$;

-- Telegram callback: approve. Verifies the pressing Telegram user is the
-- SAME identity already bound to this admin account (never username alone).
CREATE OR REPLACE FUNCTION public.approve_admin_access_request(
  p_request_ref text,
  p_telegram_user_id bigint
)
RETURNS TABLE (
  result_code text,
  telegram_chat_id bigint,
  telegram_message_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.admin_access_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request
    FROM public.admin_access_requests
   WHERE request_ref = p_request_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() AND v_request.state IN ('pending','approved') THEN
    UPDATE public.admin_access_requests SET state = 'expired', updated_at = now() WHERE id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  IF v_request.state <> 'pending' THEN
    RETURN QUERY SELECT ('already_' || v_request.state)::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.app_user_telegram_verifications v
     WHERE v.user_id = v_request.user_id
       AND v.telegram_user_id = p_telegram_user_id
       AND v.telegram_verified_at IS NOT NULL
  ) THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  UPDATE public.admin_access_requests
     SET state = 'approved',
         telegram_user_id = p_telegram_user_id,
         approved_at = now(),
         updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
END
$$;

-- Telegram callback: deny. Same identity check as approve.
CREATE OR REPLACE FUNCTION public.deny_admin_access_request(
  p_request_ref text,
  p_telegram_user_id bigint
)
RETURNS TABLE (
  result_code text,
  telegram_chat_id bigint,
  telegram_message_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.admin_access_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request
    FROM public.admin_access_requests
   WHERE request_ref = p_request_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() AND v_request.state IN ('pending','approved') THEN
    UPDATE public.admin_access_requests SET state = 'expired', updated_at = now() WHERE id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  IF v_request.state <> 'pending' THEN
    RETURN QUERY SELECT ('already_' || v_request.state)::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.app_user_telegram_verifications v
     WHERE v.user_id = v_request.user_id
       AND v.telegram_user_id = p_telegram_user_id
       AND v.telegram_verified_at IS NOT NULL
  ) THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
    RETURN;
  END IF;

  UPDATE public.admin_access_requests
     SET state = 'denied',
         telegram_user_id = p_telegram_user_id,
         denied_at = now(),
         updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_request.telegram_chat_id, v_request.telegram_message_id;
END
$$;

-- Browser poll/consume. Atomic: only ever transitions 'approved' -> 'consumed'
-- exactly once (FOR UPDATE serializes concurrent pollers), and only for the
-- exact browser that created the request (browser_binding_hash match).
-- A binding mismatch is reported identically to not_found so a wrong browser
-- cannot distinguish "exists but not mine" from "does not exist".
CREATE OR REPLACE FUNCTION public.consume_admin_access_request(
  p_request_ref text,
  p_browser_binding_hash text
)
RETURNS TABLE (
  result_code text,
  user_id uuid,
  username text,
  telegram_chat_id bigint,
  telegram_message_id bigint,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.admin_access_requests%ROWTYPE;
  v_user public.app_users%ROWTYPE;
BEGIN
  SELECT * INTO v_request
    FROM public.admin_access_requests
   WHERE request_ref = p_request_ref
   FOR UPDATE;

  IF NOT FOUND OR v_request.browser_binding_hash <> p_browser_binding_hash THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() THEN
    IF v_request.state IN ('pending','approved') THEN
      UPDATE public.admin_access_requests SET state = 'expired', updated_at = now() WHERE id = v_request.id;
    END IF;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, v_request.expires_at;
    RETURN;
  END IF;

  IF v_request.state = 'denied' THEN
    RETURN QUERY SELECT 'denied'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, v_request.expires_at;
    RETURN;
  END IF;

  IF v_request.state = 'consumed' THEN
    RETURN QUERY SELECT 'already_consumed'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, v_request.expires_at;
    RETURN;
  END IF;

  IF v_request.state = 'pending' THEN
    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, v_request.expires_at;
    RETURN;
  END IF;

  -- state = 'approved'. Re-check the exact eligibility the rest of the
  -- product requires before ever issuing ac_sess (mirrors login/
  -- session-status: exists, not blocked, still approved) — the account can
  -- have changed in the up-to-~2-minutes between approval and consumption.
  SELECT * INTO v_user
    FROM public.app_users
   WHERE id = v_request.user_id
     AND is_blocked IS DISTINCT FROM TRUE
     AND is_approved IS TRUE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  -- The Telegram identity that approved this challenge must still be the
  -- verified binding for this account — it must not have been reassigned
  -- or revoked since approval.
  IF NOT EXISTS (
    SELECT 1 FROM public.app_user_telegram_verifications v
     WHERE v.user_id = v_request.user_id
       AND v.telegram_user_id = v_request.telegram_user_id
       AND v.telegram_verified_at IS NOT NULL
  ) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE public.admin_access_requests
     SET state = 'consumed', consumed_at = now(), updated_at = now()
   WHERE id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username, v_request.telegram_chat_id, v_request.telegram_message_id, v_request.expires_at;
END
$$;

REVOKE ALL ON public.admin_access_requests FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.create_admin_access_request(text,text,text,timestamptz,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_admin_access_request(text,bigint,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_admin_access_activation(text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_admin_access_message(text,bigint,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_admin_access_request(text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deny_admin_access_request(text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_admin_access_request(text,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_admin_access_request(text,text,text,timestamptz,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_admin_access_request(text,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_admin_access_activation(text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_admin_access_message(text,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_admin_access_request(text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.deny_admin_access_request(text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_admin_access_request(text,text) TO service_role;
