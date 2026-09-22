-- Admin Device Approval Table Migration
CREATE TABLE IF NOT EXISTS admin_device_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_device_approvals_token ON admin_device_approvals(token);
CREATE INDEX IF NOT EXISTS idx_admin_device_approvals_status ON admin_device_approvals(status);

ALTER TABLE admin_device_approvals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON admin_device_approvals FROM PUBLIC, anon, authenticated;
GRANT ALL ON admin_device_approvals TO service_role;
