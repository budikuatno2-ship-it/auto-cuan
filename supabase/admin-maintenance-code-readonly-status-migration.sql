-- Keep the high-frequency maintenance-code watch path read-only.
--
-- Expired/locked pending rows are deliberately not rewritten by status checks.
-- They are ignored here, then normalized by the next issue/consume operation.
-- This prevents every browser poll during maintenance from turning into a DB
-- write while preserving the exact active/idle contract used by the web UI.

CREATE OR REPLACE FUNCTION public.get_admin_maintenance_code_status()
RETURNS TABLE (
  result_code text,
  active boolean,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id uuid;
  v_expires_at timestamptz;
BEGIN
  SELECT au.id INTO v_user_id
    FROM public.app_users AS au
   WHERE lower(au.username) = 'budi'
     AND au.is_blocked IS DISTINCT FROM TRUE
     AND au.is_approved IS TRUE
   LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT 'not_eligible'::text, false, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT g.expires_at INTO v_expires_at
    FROM public.admin_command_login_grants AS g
   WHERE g.user_id = v_user_id
     AND g.target = 'direct'
     AND g.grant_purpose = 'maintenance_code'
     AND g.state = 'pending'
     AND g.expires_at > now()
     AND g.code_attempts < 5
   ORDER BY g.created_at DESC
   LIMIT 1;

  IF v_expires_at IS NULL THEN
    RETURN QUERY SELECT 'idle'::text, false, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'active'::text, true, v_expires_at;
END
$$;

REVOKE ALL ON FUNCTION public.get_admin_maintenance_code_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_maintenance_code_status() TO service_role;
