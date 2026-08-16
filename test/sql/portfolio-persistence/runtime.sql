\set ON_ERROR_STOP on

-- Table and RLS must exist.
DO $$
BEGIN
  IF to_regclass('public.app_user_portfolio_state') IS NULL THEN
    RAISE EXCEPTION 'app_user_portfolio_state missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.app_user_portfolio_state'::regclass
      AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS is not enabled';
  END IF;
END
$$;

-- Browser-facing roles must have no direct table privileges.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.table_privileges
     WHERE table_schema = 'public'
       AND table_name = 'app_user_portfolio_state'
       AND lower(grantee) IN ('anon','authenticated','public')
  ) THEN
    RAISE EXCEPTION 'browser-facing role has portfolio table privileges';
  END IF;
END
$$;

-- service_role must have the CRUD privileges used by the server-side handler.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(DISTINCT privilege_type)::integer INTO v_count
    FROM information_schema.table_privileges
   WHERE table_schema = 'public'
     AND table_name = 'app_user_portfolio_state'
     AND grantee = 'service_role'
     AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE');

  IF v_count <> 4 THEN
    RAISE EXCEPTION 'service_role privilege count expected 4, got %', v_count;
  END IF;
END
$$;

-- Non-empty state survives normal insert/update and retains JSON object shape.
INSERT INTO public.app_user_portfolio_state (user_id, state)
SELECT id,
       jsonb_build_object(
         'version', 1,
         'plans', jsonb_build_array(jsonb_build_object('id','owned_1','ticker','BBCA','lots',2)),
         'prices', jsonb_build_object('BBCA', 9100),
         'price_meta', '{}'::jsonb,
         'journal', jsonb_build_array(jsonb_build_object('id','journal_1','ticker','BBCA')),
         'snapshot', jsonb_build_object('kind','baseline'),
         'changes', '[]'::jsonb,
         'price_updated_at', 1786870000000
       )
  FROM public.app_users
 WHERE username = 'budi'
ON CONFLICT (user_id) DO UPDATE
      SET state = EXCLUDED.state,
          updated_at = now();

DO $$
DECLARE
  v_state jsonb;
BEGIN
  SELECT ps.state INTO v_state
    FROM public.app_user_portfolio_state AS ps
    JOIN public.app_users AS au ON au.id = ps.user_id
   WHERE au.username = 'budi';

  IF jsonb_typeof(v_state) <> 'object' THEN
    RAISE EXCEPTION 'portfolio state is not an object';
  END IF;
  IF jsonb_array_length(v_state->'plans') <> 1 THEN
    RAISE EXCEPTION 'portfolio plans did not persist';
  END IF;
  IF v_state #>> '{plans,0,ticker}' <> 'BBCA' THEN
    RAISE EXCEPTION 'portfolio ticker did not persist';
  END IF;
  IF (v_state #>> '{prices,BBCA}')::integer <> 9100 THEN
    RAISE EXCEPTION 'portfolio price did not persist';
  END IF;
END
$$;

UPDATE public.app_user_portfolio_state AS ps
   SET state = jsonb_set(ps.state, '{prices,BBCA}', '9200'::jsonb),
       updated_at = now()
  FROM public.app_users AS au
 WHERE ps.user_id = au.id
   AND au.username = 'budi';

DO $$
DECLARE
  v_price integer;
BEGIN
  SELECT (ps.state #>> '{prices,BBCA}')::integer INTO v_price
    FROM public.app_user_portfolio_state AS ps
    JOIN public.app_users AS au ON au.id = ps.user_id
   WHERE au.username = 'budi';
  IF v_price <> 9200 THEN
    RAISE EXCEPTION 'portfolio update failed';
  END IF;
END
$$;

-- The FK must clean portfolio state when an account is actually deleted.
INSERT INTO public.app_users (username, is_approved)
VALUES ('portfolio_cascade_test', true)
ON CONFLICT (username) DO UPDATE SET is_approved = true;

INSERT INTO public.app_user_portfolio_state (user_id, state)
SELECT id, '{"version":1,"plans":[{"ticker":"TEST"}]}'::jsonb
  FROM public.app_users
 WHERE username = 'portfolio_cascade_test'
ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state;

DELETE FROM public.app_users WHERE username = 'portfolio_cascade_test';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.app_user_portfolio_state AS ps
      LEFT JOIN public.app_users AS au ON au.id = ps.user_id
     WHERE au.id IS NULL
  ) THEN
    RAISE EXCEPTION 'portfolio FK cascade left orphan rows';
  END IF;
END
$$;

SELECT 'PORTFOLIO_PERSISTENCE_RUNTIME_OK' AS result;
