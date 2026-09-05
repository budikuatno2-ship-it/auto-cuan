-- Admin Device Approval Table Migration
CREATE TABLE IF NOT EXISTS admin_device_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  user_id UUID NOT NULL,
  username TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_device_approvals_token ON admin_device_approvals(token);
CREATE INDEX IF NOT EXISTS idx_admin_device_approvals_status ON admin_device_approvals(status);
