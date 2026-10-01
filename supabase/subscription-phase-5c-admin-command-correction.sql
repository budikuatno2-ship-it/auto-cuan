-- Phase 5C admin command correction. UNAPPLIED; apply after the lifecycle correction.
BEGIN;

CREATE OR REPLACE FUNCTION public.voucher_admin_schema_version()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT 'phase5c-lifecycle-v3'::text
$$;

CREATE OR REPLACE FUNCTION public.voucher_admin_command(p_command text, p_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  b public.voucher_batches%ROWTYPE;
  v public.subscription_vouchers%ROWTYPE;
  batch_id_value uuid;
  message_text text;
  active_lifetime_vouchers bigint;
  total_lifetime_vouchers bigint;
  redeemed_lifetime_vouchers bigint;
  active_lifetime_users bigint;
  affected integer;
BEGIN
  IF p_command = 'daftarvoucher' THEN
    SELECT string_agg(format('%s | %s | %s | %s/%s | %s', batch_reference, voucher_type, plan_code, finalized_quantity, requested_quantity, status), E'\n')
    INTO message_text
    FROM (
      SELECT batch_reference, voucher_type, plan_code, finalized_quantity, requested_quantity, status
      FROM public.voucher_batches
      ORDER BY created_at DESC, batch_reference DESC
      LIMIT 10
    ) recent;
    RETURN jsonb_build_object('message', CASE WHEN message_text IS NULL THEN 'Belum ada batch voucher.' ELSE '10 batch terbaru:' || E'\n' || message_text END);
  END IF;

  IF p_command = 'statistiklifetime' THEN
    SELECT count(*), count(*) FILTER (WHERE active AND revoked_at IS NULL), count(*) FILTER (WHERE redemption_count > 0)
    INTO total_lifetime_vouchers, active_lifetime_vouchers, redeemed_lifetime_vouchers
    FROM public.subscription_vouchers
    WHERE coalesce(voucher_type, CASE WHEN plan_code = 'LIFETIME' THEN 'LIFETIME' ELSE NULL END) = 'LIFETIME';
    SELECT count(DISTINCT user_id) INTO active_lifetime_users
    FROM public.user_entitlements
    WHERE lifetime = true AND status = 'active';
    message_text := 'Statistik Lifetime' || E'\n' ||
      'Voucher dibuat: ' || total_lifetime_vouchers || E'\n' ||
      'Voucher aktif: ' || active_lifetime_vouchers || E'\n' ||
      'Voucher pernah digunakan: ' || redeemed_lifetime_vouchers || E'\n' ||
      'Pengguna lifetime aktif: ' || active_lifetime_users || E'\n' ||
      'Kapasitas global: tidak dibatasi';
    RETURN jsonb_build_object('message', message_text);
  END IF;

  IF p_command NOT IN ('detailvoucher','nonaktifkanvoucher','auditvoucher') OR p_reference IS NULL OR p_reference !~ '^(VB|VV)-[A-F0-9]{12}$' THEN
    IF p_command IN ('detailvoucher','nonaktifkanvoucher','auditvoucher') THEN
      RETURN jsonb_build_object('message', 'Gunakan perintah dengan referensi VB- atau VV- yang valid.');
    END IF;
    RAISE EXCEPTION 'voucher unavailable';
  END IF;

  IF left(p_reference, 3) = 'VB-' THEN
    SELECT * INTO b FROM public.voucher_batches WHERE batch_reference = p_reference FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
    batch_id_value := b.id;
  ELSE
    SELECT * INTO v FROM public.subscription_vouchers WHERE voucher_reference = p_reference FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
    batch_id_value := v.batch_id;
  END IF;

  IF p_command = 'detailvoucher' THEN
    IF left(p_reference, 3) = 'VB-' THEN
      SELECT * INTO b FROM public.voucher_batches WHERE id = batch_id_value;
      message_text := format('Batch %s%sTipe: %s%sPaket: %s%sStatus: %s%sDibuat/diminta: %s/%s%sDikirim/final: %s/%s%sProgress: %s',
        b.batch_reference, E'\n', b.voucher_type, E'\n', b.plan_code, E'\n', b.status, E'\n', b.generated_quantity, b.requested_quantity, E'\n', b.delivered_quantity, b.finalized_quantity, E'\n', b.progress_cursor);
    ELSE
      message_text := format('Voucher %s%sHint: %s%sTipe: %s%sPaket: %s%sAktif: %s%sPending delivery: %s%sPemakaian: %s/%s',
        v.voucher_reference, E'\n', v.code_hint, E'\n', coalesce(v.voucher_type, CASE WHEN v.plan_code='LIFETIME' THEN 'LIFETIME' ELSE 'PERCENT_100' END), E'\n', v.plan_code, E'\n', v.active AND v.revoked_at IS NULL, E'\n', v.delivery_pending, E'\n', v.redemption_count, v.max_redemptions);
    END IF;
    RETURN jsonb_build_object('message', message_text);
  END IF;

  IF p_command = 'auditvoucher' THEN
    IF batch_id_value IS NULL THEN
      RETURN jsonb_build_object('message', 'Voucher ini tidak memiliki riwayat batch Phase 5C.');
    END IF;
    SELECT string_agg(format('attempt %s | chunk %s | %s | stored %s | delivered %s', attempt_number, chunk_index, status, stored_count, delivered_count), E'\n')
    INTO message_text
    FROM (
      SELECT attempt_number, chunk_index, status, stored_count, delivered_count
      FROM public.voucher_batch_chunk_attempts
      WHERE batch_id = batch_id_value
      ORDER BY chunk_index DESC, attempt_number DESC
      LIMIT 12
    ) history;
    RETURN jsonb_build_object('message', CASE WHEN message_text IS NULL THEN 'Belum ada riwayat attempt untuk referensi ini.' ELSE 'Audit ' || p_reference || ':' || E'\n' || message_text END);
  END IF;

  IF left(p_reference, 3) = 'VV-' THEN
    UPDATE public.subscription_vouchers
    SET active = false, delivery_pending = false, revoked_at = coalesce(revoked_at, now())
    WHERE id = v.id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
    INSERT INTO public.voucher_batch_audit(batch_id,event_type,metadata)
    VALUES(v.batch_id,'voucher_disabled',jsonb_build_object('voucher_reference',v.voucher_reference));
    RETURN jsonb_build_object('message', 'Voucher ' || v.voucher_reference || ' dinonaktifkan.', 'disabled', true);
  END IF;

  UPDATE public.voucher_batch_chunk_attempts
  SET status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), last_safe_result_code = 'admin_disabled'
  WHERE batch_id = b.id AND status NOT IN ('finalized','cancelled');

  UPDATE public.voucher_batch_chunks
  SET current_attempt_id = NULL,
      status = CASE WHEN finalized_count = expected_count THEN 'finalized' ELSE 'cancelled' END
  WHERE batch_id = b.id;

  UPDATE public.subscription_vouchers
  SET active = false, delivery_pending = false, revoked_at = coalesce(revoked_at, now())
  WHERE batch_id = b.id;

  UPDATE public.voucher_batches SET status = 'cancelled' WHERE id = b.id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  INSERT INTO public.voucher_batch_audit(batch_id,event_type,metadata)
  VALUES(b.id,'batch_disabled',jsonb_build_object('batch_reference',b.batch_reference));
  RETURN jsonb_build_object('message', 'Batch ' || b.batch_reference || ' dinonaktifkan.', 'disabled', true);
END $$;

REVOKE ALL ON FUNCTION public.voucher_admin_schema_version(), public.voucher_admin_command(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voucher_admin_schema_version(), public.voucher_admin_command(text,text) TO service_role;

COMMIT;
