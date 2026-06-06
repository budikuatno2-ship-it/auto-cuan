-- ============================================================
-- Phase 13A: Auto-create profile row after Supabase Auth signup
-- Trigger fires on INSERT to auth.users → creates public.profiles row
-- Default: is_approved = false, role = 'user'
-- ============================================================

-- Function to handle new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, is_approved, role, created_at, updated_at)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
        false,           -- NEVER auto-approve
        'user',          -- default role
        now(),
        now()
    )
    ON CONFLICT (id) DO NOTHING;  -- safe: skip if profile already exists
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing trigger if any (idempotent)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Create trigger on auth.users INSERT
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();
