-- Additive migration: no journal/portfolio records are deleted or rewritten.
-- Apply to the same database as money-management-migration.sql before deployment.
BEGIN;
ALTER TABLE public.user_personal_cashflow
  ADD COLUMN IF NOT EXISTS sheet_data jsonb,
  ADD COLUMN IF NOT EXISTS sheet_revision integer NOT NULL DEFAULT 0;
-- Legacy seven-column values are converted lazily on read, not overwritten.
-- Existing RLS and service_role-only privileges remain unchanged.
COMMENT ON COLUMN public.user_personal_cashflow.sheet_data IS
  'Version 1 editable cashflow rows. NULL means use legacy financial columns.';
COMMENT ON COLUMN public.user_personal_cashflow.sheet_revision IS
  'Optimistic concurrency counter for worksheet writes.';
CREATE OR REPLACE FUNCTION public.guard_money_sheet_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.sheet_data IS NOT NULL AND NEW.sheet_revision <= OLD.sheet_revision THEN
    RAISE EXCEPTION 'Worksheet revision required. Reload the updated Finance view.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_personal_cashflow_sheet_revision ON public.user_personal_cashflow;
CREATE TRIGGER user_personal_cashflow_sheet_revision
BEFORE UPDATE ON public.user_personal_cashflow
FOR EACH ROW EXECUTE FUNCTION public.guard_money_sheet_revision();
COMMIT;
