-- ============================================================
-- Phase 13A: Create public.profiles table for Supabase Auth users
-- This table stores approval status for premium/approved-only features.
-- References auth.users(id) — requires Supabase Auth to be active.
-- ============================================================

-- Create profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text,
    full_name text,
    is_approved boolean NOT NULL DEFAULT false,
    role text NOT NULL DEFAULT 'user',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Add comment
COMMENT ON TABLE public.profiles IS 'User profiles for Auto-Cuan approved-user features. Linked to Supabase Auth.';

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own profile
CREATE POLICY "Users can read own profile"
    ON public.profiles
    FOR SELECT
    USING (auth.uid() = id);

-- Policy: Users can update only safe fields (full_name) — NOT is_approved or role
CREATE POLICY "Users can update own safe fields"
    ON public.profiles
    FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- Note: is_approved and role changes are restricted at application level.
-- The UPDATE policy allows row-level update but the backend/trigger should
-- prevent non-admin from changing is_approved/role.
-- For extra safety, you can use a trigger to revert unauthorized changes:

CREATE OR REPLACE FUNCTION public.protect_approval_fields()
RETURNS TRIGGER AS $$
BEGIN
    -- If the update is not coming from service_role (i.e., it's a normal user),
    -- revert is_approved and role to their old values
    IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
        NEW.is_approved := OLD.is_approved;
        NEW.role := OLD.role;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER protect_profiles_approval
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_approval_fields();

-- Policy: Service role can read all profiles (for backend API gating)
-- Note: service_role bypasses RLS by default in Supabase, so no explicit policy needed.
-- But we add one for clarity in case RLS is forced:
CREATE POLICY "Service role can read all profiles"
    ON public.profiles
    FOR SELECT
    USING (current_setting('request.jwt.claim.role', true) = 'service_role');

-- Index for quick email lookups
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);

-- Index for approval status queries
CREATE INDEX IF NOT EXISTS idx_profiles_is_approved ON public.profiles(is_approved);
