-- Phase 5C (UNAPPLIED): dedicated voucher-admin bot persistence. Do not run automatically.
BEGIN;
CREATE TABLE IF NOT EXISTS public.voucher_admin_sessions (
 telegram_user_id bigint PRIMARY KEY CHECK (telegram_user_id=6396446903), step text NOT NULL, voucher_type text, plan_code text,
 requested_quantity bigint, starts_at timestamptz, ends_at timestamptz, max_redemptions integer, per_user_limit integer,
 confirmation_key uuid, batch_reference text, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.voucher_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_reference text NOT NULL UNIQUE CHECK (batch_reference ~ '^VB-[A-F0-9]{12}$'),
 actor_user_id uuid NOT NULL REFERENCES public.app_users(id), voucher_type text NOT NULL CHECK (voucher_type IN ('PERCENT_30','PERCENT_50','PERCENT_100','LIFETIME')),
 plan_code text NOT NULL, requested_quantity bigint NOT NULL CHECK (requested_quantity>0), generated_quantity bigint NOT NULL DEFAULT 0,
 failed_quantity bigint NOT NULL DEFAULT 0, starts_at timestamptz, ends_at timestamptz, max_redemptions integer NOT NULL DEFAULT 1, per_user_limit integer NOT NULL DEFAULT 1,
 confirmation_key uuid NOT NULL UNIQUE, status text NOT NULL CHECK (status IN ('pending_delivery','delivered','finalized','cancelled')), delivery_message_parts integer NOT NULL DEFAULT 0, delivered_at timestamptz, finalized_at timestamptz, cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.subscription_vouchers ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES public.voucher_batches(id), ADD COLUMN IF NOT EXISTS delivery_pending boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS public.voucher_admin_webhook_updates (update_id bigint PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now(), outcome text NOT NULL DEFAULT 'received');
CREATE TABLE IF NOT EXISTS public.voucher_batch_audit (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,batch_id uuid NOT NULL REFERENCES public.voucher_batches(id),event_type text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS voucher_batches_created_idx ON public.voucher_batches(created_at DESC); CREATE INDEX IF NOT EXISTS subscription_vouchers_batch_idx ON public.subscription_vouchers(batch_id); CREATE INDEX IF NOT EXISTS voucher_admin_sessions_expiry_idx ON public.voucher_admin_sessions(expires_at);
ALTER TABLE public.voucher_admin_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE public.voucher_batches ENABLE ROW LEVEL SECURITY; ALTER TABLE public.voucher_admin_webhook_updates ENABLE ROW LEVEL SECURITY; ALTER TABLE public.voucher_batch_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voucher_admin_sessions,public.voucher_batches,public.voucher_admin_webhook_updates,public.voucher_batch_audit FROM PUBLIC,anon,authenticated;
-- RPC implementations are SECURITY DEFINER, SET search_path=public, and service_role-only. They resolve protected budi server-side, accept only hash/hint item data, keep delivery-pending rows disabled, and finalize only after delivery.
-- Required RPC names: claim_voucher_admin_webhook_update, start_voucher_admin_session, advance_voucher_admin_session, set_voucher_admin_quantity, clear_voucher_admin_session, create_voucher_admin_batch, insert_voucher_admin_batch_items, finalize_voucher_admin_batch, cancel_voucher_admin_batch, voucher_admin_command.
COMMIT;
