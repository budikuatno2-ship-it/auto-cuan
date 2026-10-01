-- Auto-Cuan: setup for an EXISTING Auto-Cuan Supabase project.
-- Read-only preflight: SELECT to_regclass('public.app_users'), to_regclass('public.user_personal_cashflow');
-- Back up and test in staging. Does not create users, delete data, or change Portfolio.
-- Run this complete file instead of money-sheet-v1 when the cashflow table is absent.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
BEGIN
  IF to_regclass('public.app_users') IS NULL THEN
    RAISE EXCEPTION 'STOP: public.app_users belum ada. Periksa proyek Supabase Auto-Cuan dan migrasi akun terlebih dahulu. Tidak ada tabel yang dibuat.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_users' AND column_name='id' AND udt_name='uuid') THEN
    RAISE EXCEPTION 'STOP: skema akun tidak cocok; app_users.id harus UUID. Jangan mengganti tabel akun atau menonaktifkan keamanan.';
  END IF;
END;
$$;
CREATE TABLE IF NOT EXISTS public.user_personal_cashflow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  month text NOT NULL, -- Format YYYY-MM
  income_salary numeric NOT NULL DEFAULT 0,
  income_side numeric NOT NULL DEFAULT 0,
  income_other numeric NOT NULL DEFAULT 0,
  expense_necessities numeric NOT NULL DEFAULT 0, -- Makan, Kos, Listrik, Internet
  expense_wants numeric NOT NULL DEFAULT 0,       -- Nongkrong, Hiburan, Lifestyle
  savings_emergency numeric NOT NULL DEFAULT 0,   -- Dana Darurat / Tabungan
  trading_capital_allocation numeric NOT NULL DEFAULT 0, -- Pos Modal Trading (Dana dingin bursa)
  notes text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_personal_cashflow_user_month_uniq UNIQUE (user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_user_personal_cashflow_user_month
  ON public.user_personal_cashflow (user_id, month);

ALTER TABLE public.user_personal_cashflow ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_personal_cashflow FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_personal_cashflow TO service_role;

-- Additive migration: no journal/portfolio records are deleted or rewritten.
-- Apply to the same database as money-management-migration.sql before deployment.
ALTER TABLE public.user_personal_cashflow
  ADD COLUMN IF NOT EXISTS sheet_data jsonb,
  ADD COLUMN IF NOT EXISTS sheet_revision integer NOT NULL DEFAULT 0;
-- Legacy seven-column values are converted lazily on read, not overwritten.
-- Existing RLS and service_role-only privileges remain unchanged.
COMMENT ON COLUMN public.user_personal_cashflow.sheet_data IS
  'Versioned editable cashflow rows (v1 plain values, v2 formulas). NULL uses legacy columns.';
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

CREATE OR REPLACE FUNCTION public.touch_money_management_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_personal_cashflow_touch_updated_at ON public.user_personal_cashflow;
CREATE TRIGGER user_personal_cashflow_touch_updated_at
BEFORE UPDATE ON public.user_personal_cashflow
FOR EACH ROW EXECUTE FUNCTION public.touch_money_management_updated_at();
NOTIFY pgrst, 'reload schema';
COMMIT;
