-- Multi-Device Migration (3 devices per user)
-- Run this in Supabase SQL Editor BEFORE testing the multi-device flow.
--
-- Strategy:
-- 1. Add `devices` JSONB column (nullable, no default yet) so existing rows get NULL.
-- 2. Backfill from existing `device_id` column:
--    - If device_id is not null and not empty and not a RESET_PENDING_ prefix → wrap in single-element array.
--    - Otherwise → set to empty array [].
-- 3. Set the column default to '[]'::jsonb for future inserts.
--
-- This ensures:
-- - All existing users keep their current device registered.
-- - No existing user is locked out.
-- - New users start with devices populated by register-user.js.
-- - The old `device_id` column is preserved but no longer used by the app logic.

-- Step 1: Add column without default (existing rows get NULL)
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS devices jsonb;

-- Step 2: Backfill existing device_id into devices array
UPDATE app_users
SET devices = CASE
    WHEN device_id IS NOT NULL
         AND device_id != ''
         AND device_id NOT LIKE 'RESET_PENDING_%'
    THEN jsonb_build_array(device_id)
    ELSE '[]'::jsonb
END
WHERE devices IS NULL;

-- Step 3: Set default for future inserts
ALTER TABLE app_users
ALTER COLUMN devices SET DEFAULT '[]'::jsonb;
