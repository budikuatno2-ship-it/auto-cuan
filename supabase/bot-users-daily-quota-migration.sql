-- Daily quota fields for bot_users table
-- Enables daily limit control with weekend-aware limits (15 weekday, 20 weekend)

BEGIN;

ALTER TABLE public.bot_users 
ADD COLUMN IF NOT EXISTS daily_limit integer NOT NULL DEFAULT 15,
ADD COLUMN IF NOT EXISTS daily_usage integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_usage_date date;

-- Index for efficient quota lookups
CREATE INDEX IF NOT EXISTS idx_bot_users_quota ON public.bot_users(last_usage_date);

COMMIT;
