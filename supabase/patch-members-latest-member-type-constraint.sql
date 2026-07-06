-- =============================================
-- OPTIONAL: Relax member_type CHECK constraint on sector_hot_members_latest
-- This allows CORE/AFFILIATE/RADAR values directly (matching v2 mapping).
-- Currently handled by code-level normalization (CORE→ANCHOR, else→Member).
-- Run this only if you want the DB to store original v2 member_type values.
-- Safe to run. Idempotent.
-- =============================================

-- Drop the old restrictive constraint
ALTER TABLE sector_hot_members_latest DROP CONSTRAINT IF EXISTS sector_hot_members_latest_member_type_check;

-- Add a new permissive constraint (or leave unconstrained)
ALTER TABLE sector_hot_members_latest ADD CONSTRAINT sector_hot_members_latest_member_type_check
  CHECK (member_type IN ('ANCHOR', 'Member', 'CORE', 'AFFILIATE', 'RADAR'));
