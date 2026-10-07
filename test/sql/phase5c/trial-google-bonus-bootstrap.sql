CREATE TABLE public.app_users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL, is_blocked boolean DEFAULT false, is_approved boolean DEFAULT true);
CREATE TABLE public.telegram_subscription_links(user_id uuid, telegram_user_id bigint, link_state text);
CREATE TABLE public.user_entitlements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,source text,trial_kind text,status text,starts_at timestamptz,expires_at timestamptz,lifetime boolean,activation_idempotency_key text UNIQUE);
CREATE UNIQUE INDEX one_initial_per_user ON public.user_entitlements(user_id) WHERE source='trial' AND trial_kind IN ('legacy_initial','initial');
CREATE TABLE public.subscription_trial_telegram_users(telegram_user_id bigint PRIMARY KEY,entitlement_id uuid);
CREATE TABLE public.subscription_events(user_id uuid,entitlement_id uuid,event_type text,metadata jsonb);
