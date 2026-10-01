\set ON_ERROR_STOP on

DO $$
DECLARE
  actor uuid;
  ref text := 'VB-AE0000000001';
  first_claim jsonb;
  second_claim jsonb;
  first_attempt uuid;
  first_token uuid;
  second_attempt uuid;
  second_token uuid;
  items jsonb;
  rejected boolean := false;
BEGIN
  IF public.voucher_admin_schema_version() <> 'phase5c-complete-v4' THEN
    RAISE EXCEPTION 'voucher admin schema marker mismatch';
  END IF;

  SELECT id INTO actor FROM public.app_users WHERE username = 'budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key)
  VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());

  first_claim := public.claim_voucher_admin_batch_chunk(ref);
  first_attempt := (first_claim->>'attempt_id')::uuid;
  first_token := (first_claim->>'claim_token')::uuid;
  UPDATE public.voucher_batch_chunk_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = first_attempt;

  second_claim := public.claim_voucher_admin_batch_chunk(ref);
  second_attempt := (second_claim->>'attempt_id')::uuid;
  second_token := (second_claim->>'claim_token')::uuid;

  IF second_attempt = first_attempt OR (second_claim->>'attempt_number')::integer <> 2
     OR (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id = first_attempt) <> 'cancelled'
     OR (SELECT last_safe_result_code FROM public.voucher_batch_chunk_attempts WHERE id = first_attempt) <> 'lease_expired'
     OR (SELECT current_attempt_id FROM public.voucher_batch_chunks WHERE batch_id = (SELECT id FROM public.voucher_batches WHERE batch_reference = ref) AND chunk_index = 0) <> second_attempt
     OR (SELECT status FROM public.voucher_batch_chunks WHERE current_attempt_id = second_attempt) <> 'claimed'
     OR (SELECT generated_quantity FROM public.voucher_batches WHERE batch_reference = ref) <> 0
  THEN RAISE EXCEPTION 'expired lease recovery failed'; END IF;

  items := jsonb_build_array(
    jsonb_build_object('code_hash',md5('audit-a')||md5('audit-a'),'code_hint','AE01'),
    jsonb_build_object('code_hash',md5('audit-b')||md5('audit-b'),'code_hint','AE02'));
  BEGIN
    PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,first_attempt,first_token,items);
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'voucher unavailable' THEN RAISE; END IF;
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'expired attempt remained authoritative'; END IF;

  rejected := false;
  BEGIN
    PERFORM public.claim_voucher_admin_batch_chunk(ref);
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'voucher unavailable' THEN RAISE; END IF;
    rejected := true;
  END;
  IF NOT rejected OR (SELECT count(*) FROM public.voucher_batch_chunk_attempts WHERE batch_id = (SELECT id FROM public.voucher_batches WHERE batch_reference = ref)) <> 2 THEN
    RAISE EXCEPTION 'live lease duplicate claim accepted';
  END IF;

  PERFORM public.cancel_voucher_admin_batch_chunk(ref,0,second_attempt,second_token,'audit-cleanup');
END $$;
