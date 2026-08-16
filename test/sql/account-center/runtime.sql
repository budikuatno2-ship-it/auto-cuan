\set ON_ERROR_STOP on

DO $$
DECLARE
  v_rls boolean;
  v_uid uuid;
  v_count integer;
BEGIN
  IF to_regclass('public.account_terms_acceptances') IS NULL THEN
    RAISE EXCEPTION 'account_terms_acceptances missing';
  END IF;

  SELECT relrowsecurity INTO v_rls
  FROM pg_class
  WHERE oid = 'public.account_terms_acceptances'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RLS must be enabled';
  END IF;

  IF has_table_privilege('anon', 'public.account_terms_acceptances', 'SELECT')
     OR has_table_privilege('authenticated', 'public.account_terms_acceptances', 'SELECT') THEN
    RAISE EXCEPTION 'browser roles must not read terms audit';
  END IF;

  INSERT INTO public.app_users(username) VALUES ('legacy-user') RETURNING id INTO v_uid;
  SELECT count(*) INTO v_count FROM public.account_terms_acceptances WHERE user_id = v_uid;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'legacy account must not receive fabricated acceptance';
  END IF;

  INSERT INTO public.account_terms_acceptances(user_id, terms_version, acceptance_source)
  VALUES (v_uid, '2026-08-16-v1', 'registration');

  SELECT count(*) INTO v_count
  FROM public.account_terms_acceptances
  WHERE user_id = v_uid AND terms_version = '2026-08-16-v1';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'terms acceptance was not stored exactly once';
  END IF;

  BEGIN
    INSERT INTO public.account_terms_acceptances(user_id, terms_version, acceptance_source)
    VALUES (v_uid, '2026-08-16-v1', 'registration');
    RAISE EXCEPTION 'duplicate acceptance unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  DELETE FROM public.app_users WHERE id = v_uid;
  SELECT count(*) INTO v_count FROM public.account_terms_acceptances WHERE user_id = v_uid;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'terms audit must cascade with account deletion';
  END IF;
END $$;

SELECT 'account_center_terms_runtime=PASS' AS result;
