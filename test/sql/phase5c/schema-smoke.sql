\set ON_ERROR_STOP on
SELECT to_regclass('public.voucher_admin_sessions') AS voucher_admin_sessions;
SELECT to_regclass('public.voucher_batches') AS voucher_batches;
SELECT to_regclass('public.voucher_batch_chunks') AS voucher_batch_chunks;
SELECT to_regclass('public.voucher_batch_chunk_attempts') AS voucher_batch_chunk_attempts;
SELECT to_regclass('public.voucher_admin_webhook_updates') AS voucher_admin_webhook_updates;
SELECT to_regclass('public.voucher_batch_audit') AS voucher_batch_audit;
SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_vouchers' AND column_name IN ('voucher_type','voucher_reference','batch_id','chunk_index','attempt_id','item_index','delivery_pending') ORDER BY column_name;
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.proname='prepare_voucher_admin_batch_chunk' AND pg_get_function_identity_arguments(p.oid)='p_batch_reference text, p_chunk_index bigint, p_attempt_id uuid, p_claim_token uuid, p_items jsonb';
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='subscription_vouchers' AND indexname IN ('subscription_voucher_attempt_item_idx','subscription_voucher_chunk_item_idx');
