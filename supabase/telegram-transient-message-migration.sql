-- Tracks only disposable bot reply message IDs so status/menu chatter can be
-- replaced on the next interaction. Voucher-code delivery messages are never
-- registered here and remain persistent until their voucher chunk is consumed.
BEGIN;

CREATE TABLE IF NOT EXISTS public.telegram_transient_messages (
  chat_id bigint NOT NULL,
  scope text NOT NULL CHECK (scope IN ('voucher_admin','subscription_user','general_user')),
  message_id bigint NOT NULL CHECK (message_id > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, scope)
);

ALTER TABLE public.telegram_transient_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_transient_messages FROM PUBLIC, anon, authenticated;

COMMIT;
