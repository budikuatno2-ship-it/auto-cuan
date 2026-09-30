-- DeepScan verified financial-history store.
-- Additive only: the existing stock_fundamentals snapshot table remains the
-- PBV source for daily surfaces. DeepScan uses this table for multi-year
-- verified financial formulas.
CREATE TABLE IF NOT EXISTS stock_financial_history (
  ticker TEXT NOT NULL,
  period_end DATE NOT NULL,
  period_type TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'IDR',

  revenue NUMERIC,
  operating_income NUMERIC,
  net_income NUMERIC,
  operating_cash_flow NUMERIC,
  capital_expenditure NUMERIC,
  free_cash_flow NUMERIC,

  total_assets NUMERIC,
  total_liabilities NUMERIC,
  equity NUMERIC,
  shares_outstanding NUMERIC,
  eps NUMERIC,
  book_value_per_share NUMERIC,

  source TEXT NOT NULL,
  source_document TEXT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT stock_financial_history_ticker_upper_chk CHECK (ticker = UPPER(ticker)),
  CONSTRAINT stock_financial_history_period_type_chk
    CHECK (period_type IN ('FY','Q1','Q2','Q3','Q4','H1','9M','TTM')),
  CONSTRAINT stock_financial_history_fiscal_year_chk
    CHECK (fiscal_year BETWEEN 2000 AND 2100),
  CONSTRAINT stock_financial_history_key UNIQUE (ticker, period_end, period_type)
);

CREATE INDEX IF NOT EXISTS idx_stock_financial_history_ticker_year
  ON stock_financial_history (ticker, fiscal_year DESC, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_stock_financial_history_period_end
  ON stock_financial_history (period_end DESC);

ALTER TABLE stock_financial_history ENABLE ROW LEVEL SECURITY;
