-- ============================================================
-- Phase 13A: Create public.daily_ai_usage table
-- Tracks anonymous (and optionally logged-in) AI request counts per day.
-- Used to enforce 3 requests/day limit for anonymous users.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.daily_ai_usage (
    id bigserial PRIMARY KEY,
    usage_date date NOT NULL DEFAULT CURRENT_DATE,
    user_id uuid NULL,                   -- Supabase Auth user id (null for anonymous)
    anon_id text NULL,                   -- Client-generated anonymous ID (localStorage)
    ip_hash text NULL,                   -- SHA-256 hash of IP (never store raw IP)
    request_count int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Comment
COMMENT ON TABLE public.daily_ai_usage IS 'Daily AI usage tracking for rate limiting. Anonymous users limited to 3/day.';

-- Unique constraint: one row per anon_id per day (for anonymous users)
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_ai_usage_anon_date
    ON public.daily_ai_usage(usage_date, anon_id)
    WHERE anon_id IS NOT NULL AND user_id IS NULL;

-- Unique constraint: one row per user_id per day (for logged-in users)
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_ai_usage_user_date
    ON public.daily_ai_usage(usage_date, user_id)
    WHERE user_id IS NOT NULL;

-- Index for ip_hash lookups (fallback identification)
CREATE INDEX IF NOT EXISTS idx_daily_ai_usage_ip_date
    ON public.daily_ai_usage(usage_date, ip_hash)
    WHERE ip_hash IS NOT NULL;

-- Auto-cleanup: rows older than 30 days can be safely deleted (optional cron)
-- For now, no automatic deletion — can add pg_cron later if needed.

-- RLS: Disable RLS for this table (only accessed by service_role from backend)
-- Anonymous users cannot query this table directly.
ALTER TABLE public.daily_ai_usage ENABLE ROW LEVEL SECURITY;

-- Only service_role (backend) can read/write this table
-- No public policies — frontend cannot access this table directly
CREATE POLICY "Service role full access"
    ON public.daily_ai_usage
    FOR ALL
    USING (current_setting('request.jwt.claim.role', true) = 'service_role')
    WITH CHECK (current_setting('request.jwt.claim.role', true) = 'service_role');
