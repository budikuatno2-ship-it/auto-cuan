-- =========================================================================
-- Auto-Cuan Money Management Module (Life Cashflow & Trading Journal)
-- Migration: Isolated per User ID, strict RLS & 100% confidential
-- =========================================================================

-- 1. Table: user_personal_cashflow (Sub-tab Arus Kas Pribadi)
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

-- 2. Table: user_trading_journal (Sub-tab Jurnal Portofolio Trading)
CREATE TABLE IF NOT EXISTS public.user_trading_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  trade_date date NOT NULL DEFAULT current_date,
  ticker varchar(12) NOT NULL,
  position_type varchar(10) NOT NULL DEFAULT 'BUY', -- BUY / SELL
  entry_price numeric NOT NULL DEFAULT 0,
  lots integer NOT NULL DEFAULT 1,
  capital_used numeric NOT NULL DEFAULT 0, -- entry_price * lots * 100
  exit_price numeric DEFAULT NULL,
  realized_pl_rp numeric DEFAULT 0,
  realized_pl_pct numeric DEFAULT 0,
  notes text DEFAULT '',
  status varchar(20) NOT NULL DEFAULT 'CLOSED', -- OPEN / CLOSED
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_trading_journal_user_date
  ON public.user_trading_journal (user_id, trade_date DESC);

ALTER TABLE public.user_trading_journal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_trading_journal FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_trading_journal TO service_role;

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.touch_money_management_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_personal_cashflow_touch_updated_at ON public.user_personal_cashflow;
CREATE TRIGGER user_personal_cashflow_touch_updated_at
BEFORE UPDATE ON public.user_personal_cashflow
FOR EACH ROW EXECUTE FUNCTION public.touch_money_management_updated_at();

DROP TRIGGER IF EXISTS user_trading_journal_touch_updated_at ON public.user_trading_journal;
CREATE TRIGGER user_trading_journal_touch_updated_at
BEFORE UPDATE ON public.user_trading_journal
FOR EACH ROW EXECUTE FUNCTION public.touch_money_management_updated_at();
