\set ON_ERROR_STOP on

DO $$
DECLARE
  actor uuid;
  ref text := 'VB-AF0000000001';
  claim jsonb;
  attempt uuid;
  token uuid;
  items jsonb;
  result jsonb;
  voucher_ref text;
  test_hash text := md5('command-a') || md5('command-a');
BEGIN
  IF public.voucher_admin_schema_version() <> 'phase5c-lifecycle-v3' THEN
    RAISE EXCEPTION 'voucher admin command schema marker mismatch';
  END IF;
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key)
  VALUES(ref,actor,'LIFETIME','LIFETIME',1,gen_random_uuid());
  claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
  items:=jsonb_build_array(jsonb_build_object('code_hash',test_hash,'code_hint','AF01'));
  PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
  PERFORM public.record_voucher_admin_chunk_delivery(ref,0,attempt,token,'message',801,1);
  PERFORM public.finalize_voucher_admin_batch_chunk(ref,0,attempt,token);
  SELECT voucher_reference INTO voucher_ref FROM public.subscription_vouchers WHERE attempt_id=attempt;

  result:=public.voucher_admin_command('daftarvoucher',NULL);
  IF position(ref in result->>'message')=0 OR position(test_hash in result->>'message')>0 THEN RAISE EXCEPTION 'voucher list output unsafe or incomplete'; END IF;
  result:=public.voucher_admin_command('detailvoucher',ref);
  IF position('Status: complete' in result->>'message')=0 OR position(test_hash in result->>'message')>0 THEN RAISE EXCEPTION 'batch detail output failed'; END IF;
  result:=public.voucher_admin_command('detailvoucher',voucher_ref);
  IF position(voucher_ref in result->>'message')=0 OR position('AF01' in result->>'message')=0 OR position(test_hash in result->>'message')>0 THEN RAISE EXCEPTION 'voucher detail output failed'; END IF;
  result:=public.voucher_admin_command('auditvoucher',ref);
  IF position('attempt 1' in result->>'message')=0 OR position('finalized' in result->>'message')=0 THEN RAISE EXCEPTION 'voucher audit output failed'; END IF;
  result:=public.voucher_admin_command('statistiklifetime',NULL);
  IF position('Kapasitas global: tidak dibatasi' in result->>'message')=0 THEN RAISE EXCEPTION 'lifetime statistics capacity contract failed'; END IF;
  result:=public.voucher_admin_command('nonaktifkanvoucher',voucher_ref);
  IF result->>'disabled'<>'true' OR (SELECT active FROM public.subscription_vouchers WHERE voucher_reference=voucher_ref)<>false OR (SELECT revoked_at FROM public.subscription_vouchers WHERE voucher_reference=voucher_ref) IS NULL THEN RAISE EXCEPTION 'single voucher disable failed'; END IF;
END $$;

DO $$
DECLARE
  actor uuid;
  ref text := 'VB-AF0000000002';
  claim jsonb;
  attempt uuid;
  token uuid;
  items jsonb;
  result jsonb;
BEGIN
  SELECT id INTO actor FROM public.app_users WHERE username='budi';
  INSERT INTO public.voucher_batches(batch_reference,actor_user_id,voucher_type,plan_code,requested_quantity,confirmation_key)
  VALUES(ref,actor,'PERCENT_100','PREMIUM_1_MONTH',2,gen_random_uuid());
  claim:=public.claim_voucher_admin_batch_chunk(ref); attempt:=(claim->>'attempt_id')::uuid; token:=(claim->>'claim_token')::uuid;
  items:=jsonb_build_array(
    jsonb_build_object('code_hash',md5('command-b')||md5('command-b'),'code_hint','AF02'),
    jsonb_build_object('code_hash',md5('command-c')||md5('command-c'),'code_hint','AF03'));
  PERFORM public.prepare_voucher_admin_batch_chunk(ref,0,attempt,token,items);
  result:=public.voucher_admin_command('nonaktifkanvoucher',ref);
  IF result->>'disabled'<>'true'
     OR (SELECT status FROM public.voucher_batches WHERE batch_reference=ref)<>'cancelled'
     OR (SELECT status FROM public.voucher_batch_chunk_attempts WHERE id=attempt)<>'cancelled'
     OR (SELECT current_attempt_id FROM public.voucher_batch_chunks WHERE batch_id=(SELECT id FROM public.voucher_batches WHERE batch_reference=ref) AND chunk_index=0) IS NOT NULL
     OR EXISTS(SELECT 1 FROM public.subscription_vouchers WHERE attempt_id=attempt AND (active=true OR delivery_pending=true OR revoked_at IS NULL))
  THEN RAISE EXCEPTION 'batch disable recovery failed'; END IF;
END $$;
