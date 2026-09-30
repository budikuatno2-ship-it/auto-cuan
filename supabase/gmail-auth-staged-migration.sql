-- Gmail identity rollout for web auth.
-- ADDITIVE / IDEMPOTENT ONLY.
-- IMPORTANT: email intentionally remains NULLABLE for legacy accounts.
-- New-registration Gmail enforcement is performed by api/register-user.js.

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS email text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_email_unique_lower
  ON public.app_users (LOWER(TRIM(email)))
  WHERE email IS NOT NULL AND TRIM(email) <> '';

COMMENT ON COLUMN public.app_users.email IS
  'Primary web login email for newer accounts. Nullable for legacy accounts; do not convert to NOT NULL during staged rollout.';
