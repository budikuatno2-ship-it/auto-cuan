-- Isolated regression only. Bootstrap and both Money Management migrations first.
INSERT INTO public.user_personal_cashflow (user_id,month,income_salary,notes)
SELECT id,'2026-09',12500000,'legacy preserved' FROM public.app_users WHERE username='budi';
INSERT INTO public.user_trading_journal (user_id,ticker,entry_price,lots)
SELECT id,'BBCA',9000,10 FROM public.app_users WHERE username='budi';
DO $$
DECLARE uid uuid; changed integer; blocked boolean := false;
BEGIN
 SELECT id INTO uid FROM public.app_users WHERE username='budi';
 IF NOT EXISTS(SELECT 1 FROM public.user_personal_cashflow WHERE user_id=uid AND sheet_data IS NULL AND sheet_revision=0 AND income_salary=12500000) THEN RAISE EXCEPTION 'Legacy migration changed cashflow'; END IF;
 UPDATE public.user_personal_cashflow SET sheet_data='{"version":1,"rows":[]}',sheet_revision=1 WHERE user_id=uid AND month='2026-09' AND sheet_revision=0;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'Initial CAS did not update exactly one row'; END IF;
 UPDATE public.user_personal_cashflow SET sheet_revision=1 WHERE user_id=uid AND month='2026-09' AND sheet_revision=0;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>0 THEN RAISE EXCEPTION 'Stale CAS was not rejected'; END IF;
 BEGIN
  UPDATE public.user_personal_cashflow SET income_salary=0 WHERE user_id=uid AND month='2026-09';
 EXCEPTION WHEN raise_exception THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'Legacy client silently overwrote a worksheet'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_trading_journal WHERE user_id=uid AND ticker='BBCA') THEN RAISE EXCEPTION 'Journal was changed'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.user_personal_cashflow'::regclass) THEN RAISE EXCEPTION 'Cashflow RLS lost'; END IF;
 IF has_table_privilege('anon','public.user_personal_cashflow','SELECT') THEN RAISE EXCEPTION 'Cashflow exposed to anon'; END IF;
 IF has_table_privilege('authenticated','public.user_personal_cashflow','UPDATE') THEN RAISE EXCEPTION 'Direct client writes exposed'; END IF;
END $$;
