-- Phase 5C lifecycle correction. UNAPPLIED; service role only.
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_voucher_admin_batch_chunk(p_batch_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  b public.voucher_batches%ROWTYPE;
  c public.voucher_batch_chunks%ROWTYPE;
  a public.voucher_batch_chunk_attempts%ROWTYPE;
  next_attempt integer;
  next_chunk bigint;
  remaining bigint;
BEGIN
  SELECT * INTO b FROM public.voucher_batches WHERE batch_reference = p_batch_reference FOR UPDATE;
  IF NOT FOUND OR b.status = 'cancelled' THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  IF b.finalized_quantity = b.requested_quantity THEN
    RETURN jsonb_build_object('done', true, 'complete', true, 'progress_cursor', b.progress_cursor);
  END IF;
  IF b.progress_cursor < 0 OR b.progress_cursor >= b.requested_quantity OR b.finalized_quantity <> b.progress_cursor THEN
    RAISE EXCEPTION 'voucher unavailable';
  END IF;

  next_chunk := b.progress_cursor / 100;
  remaining := b.requested_quantity - b.progress_cursor;
  INSERT INTO public.voucher_batch_chunks(batch_id, chunk_index, expected_count, status)
  VALUES (b.id, next_chunk, least(100, remaining)::integer, 'pending')
  ON CONFLICT (batch_id, chunk_index) DO NOTHING;

  SELECT * INTO c FROM public.voucher_batch_chunks WHERE batch_id = b.id AND chunk_index = next_chunk FOR UPDATE;
  IF NOT FOUND OR c.expected_count <> least(100, remaining)::integer OR c.current_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION 'voucher unavailable';
  END IF;

  SELECT coalesce(max(attempt_number), 0) + 1 INTO next_attempt
  FROM public.voucher_batch_chunk_attempts
  WHERE batch_id = b.id AND chunk_index = c.chunk_index;

  INSERT INTO public.voucher_batch_chunk_attempts(batch_id, chunk_index, attempt_number, claim_token, expected_count, status, lease_expires_at)
  VALUES (b.id, c.chunk_index, next_attempt, gen_random_uuid(), c.expected_count, 'claimed', now() + interval '5 minutes')
  RETURNING * INTO a;

  UPDATE public.voucher_batch_chunks
  SET current_attempt_id = a.id, status = 'claimed', generated_count = 0, delivered_count = 0, finalized_count = 0
  WHERE batch_id = b.id AND chunk_index = c.chunk_index AND current_attempt_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  RETURN jsonb_build_object('done', false, 'chunk_index', c.chunk_index, 'attempt_id', a.id, 'claim_token', a.claim_token, 'expected_count', a.expected_count, 'lease_expires_at', a.lease_expires_at, 'attempt_number', a.attempt_number, 'mode', 'prepare');
END $$;

CREATE OR REPLACE FUNCTION public.record_voucher_admin_chunk_delivery(p_batch_reference text, p_chunk_index bigint, p_attempt_id uuid, p_claim_token uuid, p_delivery_method text, p_telegram_message_id bigint, p_delivered_count integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  b public.voucher_batches%ROWTYPE;
  c public.voucher_batch_chunks%ROWTYPE;
  a public.voucher_batch_chunk_attempts%ROWTYPE;
  durable_count integer;
  affected integer;
BEGIN
  IF p_delivery_method IS NULL OR p_delivery_method NOT IN ('message','document') OR p_telegram_message_id IS NULL OR p_telegram_message_id <= 0 OR p_delivered_count IS NULL OR p_delivered_count <= 0 THEN
    RAISE EXCEPTION 'voucher unavailable';
  END IF;
  SELECT * INTO b FROM public.voucher_batches WHERE batch_reference = p_batch_reference FOR UPDATE;
  IF NOT FOUND OR b.status = 'cancelled' THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  SELECT * INTO c FROM public.voucher_batch_chunks WHERE batch_id = b.id AND chunk_index = p_chunk_index FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  SELECT * INTO a FROM public.voucher_batch_chunk_attempts WHERE id = p_attempt_id AND batch_id = b.id AND chunk_index = p_chunk_index FOR UPDATE;
  IF NOT FOUND OR a.claim_token IS DISTINCT FROM p_claim_token THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  IF a.status = 'delivered' THEN
    IF a.delivery_method IS DISTINCT FROM p_delivery_method OR a.telegram_message_id IS DISTINCT FROM p_telegram_message_id OR a.delivered_count IS DISTINCT FROM p_delivered_count THEN
      RAISE EXCEPTION 'voucher unavailable';
    END IF;
    RETURN jsonb_build_object('recorded', true, 'already_recorded', true, 'delivered_count', a.delivered_count, 'safe_result_code', 'already_delivered');
  END IF;

  IF c.current_attempt_id IS DISTINCT FROM a.id OR a.status <> 'prepared' OR a.stored_count <> a.expected_count OR p_delivered_count <> a.expected_count THEN
    RAISE EXCEPTION 'voucher unavailable';
  END IF;
  SELECT count(*) INTO durable_count
  FROM public.subscription_vouchers
  WHERE attempt_id = a.id AND active = false AND delivery_pending = true;
  IF durable_count <> a.expected_count THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  UPDATE public.voucher_batches
  SET delivered_quantity = delivered_quantity + p_delivered_count
  WHERE id = b.id AND delivered_quantity + p_delivered_count <= generated_quantity;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  UPDATE public.voucher_batch_chunk_attempts
  SET delivered_count = p_delivered_count, status = 'delivered', delivery_method = p_delivery_method,
      telegram_message_id = p_telegram_message_id, delivered_at = now(), last_safe_result_code = 'delivered'
  WHERE id = a.id AND status = 'prepared';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  UPDATE public.voucher_batch_chunks
  SET delivered_count = p_delivered_count, status = 'delivered'
  WHERE batch_id = b.id AND chunk_index = p_chunk_index AND current_attempt_id = a.id AND status = 'prepared';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  RETURN jsonb_build_object('recorded', true, 'already_recorded', false, 'delivered_count', p_delivered_count, 'safe_result_code', 'delivered');
END $$;

CREATE OR REPLACE FUNCTION public.mark_voucher_admin_chunk_delivery_uncertain(p_batch_reference text, p_chunk_index bigint, p_attempt_id uuid, p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  b public.voucher_batches%ROWTYPE;
  c public.voucher_batch_chunks%ROWTYPE;
  a public.voucher_batch_chunk_attempts%ROWTYPE;
BEGIN
  SELECT * INTO b FROM public.voucher_batches WHERE batch_reference = p_batch_reference FOR UPDATE;
  IF NOT FOUND OR b.status = 'cancelled' THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  SELECT * INTO c FROM public.voucher_batch_chunks WHERE batch_id = b.id AND chunk_index = p_chunk_index FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  SELECT * INTO a FROM public.voucher_batch_chunk_attempts WHERE id = p_attempt_id AND batch_id = b.id AND chunk_index = p_chunk_index FOR UPDATE;
  IF NOT FOUND OR a.claim_token IS DISTINCT FROM p_claim_token OR c.current_attempt_id IS DISTINCT FROM a.id THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  IF a.status = 'delivery_uncertain' THEN
    RETURN jsonb_build_object('uncertain', true, 'already_uncertain', true, 'safe_result_code', 'already_uncertain');
  END IF;
  IF a.status NOT IN ('prepared','delivered') THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  UPDATE public.voucher_batch_chunk_attempts
  SET status = 'delivery_uncertain', uncertain_at = coalesce(uncertain_at, now()), last_safe_result_code = 'delivery_uncertain'
  WHERE id = a.id AND status IN ('prepared','delivered');
  IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  UPDATE public.voucher_batch_chunks SET status = 'delivery_uncertain'
  WHERE batch_id = b.id AND chunk_index = p_chunk_index AND current_attempt_id = a.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  RETURN jsonb_build_object('uncertain', true, 'already_uncertain', false, 'safe_result_code', 'delivery_uncertain');
END $$;

CREATE OR REPLACE FUNCTION public.finalize_voucher_admin_batch_chunk(p_batch_reference text, p_chunk_index bigint, p_attempt_id uuid, p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  b public.voucher_batches%ROWTYPE;
  c public.voucher_batch_chunks%ROWTYPE;
  a public.voucher_batch_chunk_attempts%ROWTYPE;
  durable_count integer;
  affected integer;
  new_progress bigint;
  is_complete boolean;
BEGIN
  SELECT * INTO b FROM public.voucher_batches WHERE batch_reference = p_batch_reference FOR UPDATE;
  IF NOT FOUND OR b.status = 'cancelled' THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  SELECT * INTO c FROM public.voucher_batch_chunks WHERE batch_id = b.id AND chunk_index = p_chunk_index FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  SELECT * INTO a FROM public.voucher_batch_chunk_attempts WHERE id = p_attempt_id AND batch_id = b.id AND chunk_index = p_chunk_index FOR UPDATE;
  IF NOT FOUND OR a.claim_token IS DISTINCT FROM p_claim_token THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  IF a.status = 'finalized' THEN
    is_complete := b.finalized_quantity = b.requested_quantity;
    RETURN jsonb_build_object('finalized', true, 'already_finalized', true, 'complete', is_complete, 'progress_cursor', b.progress_cursor, 'safe_result_code', 'already_finalized');
  END IF;

  IF c.current_attempt_id IS DISTINCT FROM a.id OR a.status NOT IN ('delivered','delivery_uncertain') OR a.stored_count <> a.expected_count OR a.delivered_count <> a.expected_count OR a.delivery_method NOT IN ('message','document') OR a.telegram_message_id IS NULL THEN
    RAISE EXCEPTION 'voucher unavailable';
  END IF;
  SELECT count(*) INTO durable_count
  FROM public.subscription_vouchers
  WHERE attempt_id = a.id AND active = false AND delivery_pending = true;
  IF durable_count <> a.expected_count THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  UPDATE public.subscription_vouchers SET active = true, delivery_pending = false WHERE attempt_id = a.id AND active = false AND delivery_pending = true;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> a.expected_count THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  new_progress := b.progress_cursor + a.expected_count;
  UPDATE public.voucher_batches
  SET finalized_quantity = finalized_quantity + a.expected_count,
      progress_cursor = new_progress,
      status = CASE WHEN finalized_quantity + a.expected_count = requested_quantity THEN 'complete' ELSE 'pending_delivery' END
  WHERE id = b.id
    AND finalized_quantity + a.expected_count <= delivered_quantity
    AND new_progress <= requested_quantity;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  UPDATE public.voucher_batch_chunk_attempts
  SET status = 'finalized', finalized_at = now(), last_safe_result_code = 'finalized'
  WHERE id = a.id AND status IN ('delivered','delivery_uncertain');
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  UPDATE public.voucher_batch_chunks
  SET finalized_count = a.expected_count, status = 'finalized', current_attempt_id = NULL
  WHERE batch_id = b.id AND chunk_index = p_chunk_index AND current_attempt_id = a.id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  is_complete := new_progress = b.requested_quantity;
  RETURN jsonb_build_object('finalized', true, 'already_finalized', false, 'complete', is_complete, 'progress_cursor', new_progress, 'safe_result_code', 'finalized');
END $$;

CREATE OR REPLACE FUNCTION public.cancel_voucher_admin_batch_chunk(p_batch_reference text, p_chunk_index bigint, p_attempt_id uuid, p_claim_token uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  b public.voucher_batches%ROWTYPE;
  c public.voucher_batch_chunks%ROWTYPE;
  a public.voucher_batch_chunk_attempts%ROWTYPE;
  removed integer := 0;
  affected integer;
BEGIN
  SELECT * INTO b FROM public.voucher_batches WHERE batch_reference = p_batch_reference FOR UPDATE;
  IF NOT FOUND OR b.status = 'cancelled' THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  SELECT * INTO c FROM public.voucher_batch_chunks WHERE batch_id = b.id AND chunk_index = p_chunk_index FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  SELECT * INTO a FROM public.voucher_batch_chunk_attempts WHERE id = p_attempt_id AND batch_id = b.id AND chunk_index = p_chunk_index FOR UPDATE;
  IF NOT FOUND OR a.claim_token IS DISTINCT FROM p_claim_token THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  IF a.status = 'cancelled' THEN
    RETURN jsonb_build_object('cancelled', true, 'already_cancelled', true, 'safe_result_code', 'already_cancelled');
  END IF;
  IF c.current_attempt_id IS DISTINCT FROM a.id OR a.status NOT IN ('claimed','prepared') THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  IF a.status = 'prepared' THEN
    DELETE FROM public.subscription_vouchers
    WHERE attempt_id = a.id AND active = false AND delivery_pending = true;
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed <> a.stored_count OR removed <> a.expected_count THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

    UPDATE public.voucher_batches
    SET generated_quantity = generated_quantity - removed, status = 'pending_delivery'
    WHERE id = b.id AND generated_quantity >= removed AND finalized_quantity <= generated_quantity - removed;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;
  END IF;

  UPDATE public.voucher_batch_chunk_attempts
  SET status = 'cancelled', cancelled_at = now(), last_safe_result_code = 'cancelled'
  WHERE id = a.id AND status IN ('claimed','prepared');
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  UPDATE public.voucher_batch_chunks
  SET current_attempt_id = NULL, status = 'pending', generated_count = 0, delivered_count = 0, finalized_count = 0
  WHERE batch_id = b.id AND chunk_index = p_chunk_index AND current_attempt_id = a.id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'voucher unavailable'; END IF;

  RETURN jsonb_build_object('cancelled', true, 'already_cancelled', false, 'removed_count', removed, 'safe_result_code', 'cancelled');
END $$;

REVOKE ALL ON FUNCTION public.claim_voucher_admin_batch_chunk(text), public.record_voucher_admin_chunk_delivery(text,bigint,uuid,uuid,text,bigint,integer), public.mark_voucher_admin_chunk_delivery_uncertain(text,bigint,uuid,uuid), public.finalize_voucher_admin_batch_chunk(text,bigint,uuid,uuid), public.cancel_voucher_admin_batch_chunk(text,bigint,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_voucher_admin_batch_chunk(text), public.record_voucher_admin_chunk_delivery(text,bigint,uuid,uuid,text,bigint,integer), public.mark_voucher_admin_chunk_delivery_uncertain(text,bigint,uuid,uuid), public.finalize_voucher_admin_batch_chunk(text,bigint,uuid,uuid), public.cancel_voucher_admin_batch_chunk(text,bigint,uuid,uuid,text) TO service_role;

COMMIT;
