-- Manual Approval Migration (safe for existing users)
-- Run this in Supabase SQL Editor BEFORE testing the approval flow.
--
-- Strategy:
-- 1. Add is_approved column as nullable (no default yet) so existing rows get NULL.
-- 2. Backfill ALL existing users as approved (NULL → true) so nobody is locked out.
-- 3. Set the column default to false so NEW registrations are pending by default.
--
-- This ensures:
-- - All existing users (including budi, review, and any normal users) remain approved.
-- - Only users registered AFTER this migration will start as pending (is_approved = false).
-- - No existing account is broken.

-- Step 1: Add column without default (existing rows get NULL)
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS is_approved boolean;

-- Step 2: Backfill all existing users as approved
UPDATE app_users
SET is_approved = true
WHERE is_approved IS NULL;

-- Step 3: Set default for future inserts
ALTER TABLE app_users
ALTER COLUMN is_approved SET DEFAULT false;
