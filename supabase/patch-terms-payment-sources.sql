-- Migration: Support payment and voucher acceptance sources for terms of service
-- ADDITIVE & IDEMPOTENT. Apply in Supabase SQL Editor.
BEGIN;

-- Expand check constraint on acceptance_source
ALTER TABLE public.account_terms_acceptances
  DROP CONSTRAINT IF EXISTS account_terms_acceptances_acceptance_source_check;

ALTER TABLE public.account_terms_acceptances
  ADD CONSTRAINT account_terms_acceptances_acceptance_source_check
  CHECK (acceptance_source IN ('registration', 'profile', 'payment', 'voucher'));

-- Adjust unique constraint to allow recording acceptance from multiple sources per terms_version
ALTER TABLE public.account_terms_acceptances
  DROP CONSTRAINT IF EXISTS account_terms_acceptances_user_id_terms_version_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_terms_user_version_source
  ON public.account_terms_acceptances (user_id, terms_version, acceptance_source);

COMMIT;
