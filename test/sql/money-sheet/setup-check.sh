#!/bin/sh
# Isolated CI harness only. Refuse accidental use against a real deployment.
set -eu
case "${PGHOST:-}:${PGDATABASE:-}" in localhost:money_sheet_test|127.0.0.1:money_sheet_test) ;; *) echo 'Refusing non-test database environment' >&2; exit 2;; esac
createdb money_sheet_missing_test
if PGDATABASE=money_sheet_missing_test psql -v ON_ERROR_STOP=1 -f supabase/money-sheet-setup.sql > /tmp/money-sheet-preflight.txt 2>&1; then
  echo 'Missing account schema was accepted' >&2; exit 1
fi
grep -q 'STOP: public.app_users' /tmp/money-sheet-preflight.txt
PGDATABASE=money_sheet_missing_test psql -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF to_regclass('public.user_personal_cashflow') IS NOT NULL THEN RAISE EXCEPTION 'Failed preflight created a table'; END IF; END \$\$;"
createdb money_sheet_setup_test
export PGDATABASE=money_sheet_setup_test
psql -v ON_ERROR_STOP=1 -f test/sql/admin-access/bootstrap.sql
psql -v ON_ERROR_STOP=1 -f supabase/money-sheet-setup.sql
psql -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public.user_personal_cashflow(user_id,month,income_salary,sheet_data,sheet_revision)
SELECT id,'2026-09',15000000,'{"version":1,"rows":[]}',1 FROM public.app_users WHERE username='budi';
DO $$ BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.user_personal_cashflow'::regclass) THEN RAISE EXCEPTION 'RLS missing'; END IF;
 IF has_table_privilege('anon','public.user_personal_cashflow','SELECT') OR has_table_privilege('authenticated','public.user_personal_cashflow','UPDATE') THEN RAISE EXCEPTION 'Private financial table exposed'; END IF;
 IF to_regclass('public.user_trading_journal') IS NOT NULL THEN RAISE EXCEPTION 'Unexpected journal was created'; END IF;
END $$;
SQL
psql -v ON_ERROR_STOP=1 -f supabase/money-sheet-setup.sql
psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE blocked boolean:=false; BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.user_personal_cashflow WHERE income_salary=15000000 AND sheet_revision=1) THEN RAISE EXCEPTION 'Setup lost existing records'; END IF;
 BEGIN UPDATE public.user_personal_cashflow SET income_salary=0; EXCEPTION WHEN raise_exception THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Revision guard failed'; END IF;
END $$;
SQL
