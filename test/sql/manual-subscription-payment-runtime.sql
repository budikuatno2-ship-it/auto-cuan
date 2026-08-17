\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  uid uuid;
  created jsonb;
  submitted jsonb;
  approved jsonb;
  payment_ref text;
  entitlement_count integer;
  approved_state boolean;
BEGIN
  SELECT id INTO uid FROM public.app_users WHERE username='phase5c_test_user';
  IF uid IS NULL THEN RAISE EXCEPTION 'manual subscription test user missing'; END IF;

  created := public.create_manual_subscription_payment(
    uid,
    'PREMIUM_1_MONTH',
    NULL,
    '11111111-1111-4111-8111-111111111111'::uuid
  );
  IF created->>'status' <> 'awaiting_transfer' THEN RAISE EXCEPTION 'manual payment create state mismatch'; END IF;
  IF (created->>'amount_due_idr')::bigint <= 0 THEN RAISE EXCEPTION 'manual payment amount invalid'; END IF;
  payment_ref := created->>'payment_reference';
  IF payment_ref !~ '^PAY-[A-F0-9]{12}$' THEN RAISE EXCEPTION 'manual payment reference invalid'; END IF;

  -- Same idempotency key must converge on the existing request.
  IF (public.create_manual_subscription_payment(uid,'PREMIUM_1_MONTH',NULL,'11111111-1111-4111-8111-111111111111'::uuid)->>'payment_reference') <> payment_ref THEN
    RAISE EXCEPTION 'manual payment create not idempotent';
  END IF;

  submitted := public.submit_manual_subscription_payment(uid,payment_ref,'Budi Test','CI transfer test');
  IF submitted->>'status' <> 'submitted' THEN RAISE EXCEPTION 'manual payment submit state mismatch'; END IF;

  approved := public.review_manual_subscription_payment(payment_ref,6396446903,'approve');
  IF approved->>'status' <> 'approved' OR approved->>'plan_code' <> 'PREMIUM_1_MONTH' THEN
    RAISE EXCEPTION 'manual payment approval mismatch';
  END IF;

  SELECT count(*) INTO entitlement_count
  FROM public.user_entitlements
  WHERE user_id=uid AND source='payment' AND status='active' AND plan_code='PREMIUM_1_MONTH';
  IF entitlement_count <> 1 THEN RAISE EXCEPTION 'manual payment entitlement not created exactly once'; END IF;

  SELECT is_approved INTO approved_state FROM public.app_users WHERE id=uid;
  IF approved_state IS DISTINCT FROM true THEN RAISE EXCEPTION 'manual payment approval did not approve account'; END IF;

  -- Review is idempotent after the first terminal decision.
  approved := public.review_manual_subscription_payment(payment_ref,6396446903,'approve');
  IF coalesce((approved->>'already_reviewed')::boolean,false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'manual payment review not idempotent';
  END IF;
END
$$;

INSERT INTO public.telegram_transient_messages(chat_id,scope,message_id)
VALUES(6396446903,'voucher_admin',12345)
ON CONFLICT(chat_id,scope) DO UPDATE SET message_id=EXCLUDED.message_id,updated_at=now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.telegram_transient_messages
    WHERE chat_id=6396446903 AND scope='voucher_admin' AND message_id=12345
  ) THEN RAISE EXCEPTION 'transient message persistence mismatch'; END IF;
END
$$;

ROLLBACK;
