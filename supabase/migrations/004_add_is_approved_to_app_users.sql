-- ============================================================
-- Phase 13A.2: Add is_approved column to app_users table
-- This enables the existing username/password login to support
-- manual admin approval before allowing AI usage.
-- ============================================================

-- Add is_approved column (default false for new users)
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS is_approved boolean NOT NULL DEFAULT false;

-- Add updated_at column if not exists
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Set existing admin user (budi) as approved
UPDATE public.app_users SET is_approved = true WHERE username = 'budi';

-- Set existing review user as approved
UPDATE public.app_users SET is_approved = true WHERE username = 'review';

-- Index for quick approval status lookups
CREATE INDEX IF NOT EXISTS idx_app_users_is_approved ON public.app_users(is_approved);
