-- =========================================================================
-- Auto-Cuan administrator discoverable WebAuthn credential storage.
--
-- Purpose:
--   Preserve a cryptographic laptop identity outside browser cookies so the
--   administrator can recover access with Windows Hello after clearing browser
--   data. Only PUBLIC key material is stored; private keys remain in the
--   platform authenticator.
--
-- Access model:
--   - server uses SUPABASE_SERVICE_ROLE_KEY;
--   - anon/authenticated/public receive no table privileges;
--   - RLS is enabled as defense in depth;
--   - application authorization still depends on the signed ac_sess cookie.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.admin_webauthn_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  credential_id   text NOT NULL UNIQUE,
  public_key_jwk  jsonb NOT NULL,
  sign_count      bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports      text[] NOT NULL DEFAULT ARRAY[]::text[],
  device_label    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  CONSTRAINT admin_webauthn_credential_id_shape
    CHECK (credential_id ~ '^[A-Za-z0-9_-]{16,1400}$'),
  CONSTRAINT admin_webauthn_device_label_size
    CHECK (device_label IS NULL OR char_length(device_label) <= 80)
);

CREATE INDEX IF NOT EXISTS idx_admin_webauthn_user_active
  ON public.admin_webauthn_credentials (user_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.admin_webauthn_credentials ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_webauthn_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_webauthn_credentials TO service_role;

COMMENT ON TABLE public.admin_webauthn_credentials IS
  'Public WebAuthn credential material for the verified Auto-Cuan administrator; private keys never leave the authenticator.';
COMMENT ON COLUMN public.admin_webauthn_credentials.public_key_jwk IS
  'ES256 P-256 public key only. Never store a WebAuthn private key or raw Windows Hello secret.';
