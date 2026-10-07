-- Executes the real RPC in a throwaway PostgreSQL schema, not a Supabase project.
DO $$
DECLARE
  u uuid; key uuid; activated jsonb; replay jsonb; initial_row public.user_entitlements%ROWTYPE;
  t timestamptz := now(); expected_start timestamptz; scenario integer;
BEGIN
  FOR scenario IN 1..4 LOOP
    u:=gen_random_uuid(); key:=gen_random_uuid();
    INSERT INTO public.app_users(id,username) VALUES(u,'trial_fixture_'||scenario);
    INSERT INTO public.telegram_subscription_links VALUES(u,900000+scenario,'linked');
    expected_start:=t;
    IF scenario<4 THEN
      INSERT INTO public.user_entitlements(user_id,source,trial_kind,status,starts_at,expires_at,lifetime)
        VALUES(u,'trial','google_link_bonus',CASE WHEN scenario=3 THEN 'revoked' ELSE 'active' END,
          CASE WHEN scenario=2 THEN t-interval '8 days' ELSE t END,
          CASE WHEN scenario=2 THEN t-interval '1 day' ELSE t+interval '7 days' END,false);
      IF scenario=1 THEN expected_start:=t+interval '7 days'; END IF;
    END IF;
    activated:=public.activate_subscription_trial(u,key,t);
    SELECT * INTO STRICT initial_row FROM public.user_entitlements WHERE user_id=u AND trial_kind='initial';
    IF initial_row.starts_at<>expected_start OR initial_row.expires_at<>expected_start+interval '14 days' THEN
      RAISE EXCEPTION 'trial must preserve bonus then grant fourteen full days (scenario %)',scenario;
    END IF;
    IF (activated->>'duration_days')::integer<>14 OR (activated->>'active')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'activation response incorrect'; END IF;
    replay:=public.activate_subscription_trial(u,key,t);
    IF replay IS DISTINCT FROM activated THEN RAISE EXCEPTION 'idempotency replay changed result'; END IF;
    IF (SELECT count(*) FROM public.user_entitlements WHERE user_id=u AND trial_kind='initial')<>1 THEN RAISE EXCEPTION 'duplicate initial entitlement'; END IF;
    BEGIN
      PERFORM public.activate_subscription_trial(u,gen_random_uuid(),t);
      RAISE EXCEPTION 'second initial activation unexpectedly accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM<>'trial consumed' THEN RAISE; END IF;
    END;
  END LOOP;
END $$;
