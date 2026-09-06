-- Migration: kv_store — generic key-value store for server-side snapshots.
-- ADDITIVE ONLY. Apply in Supabase SQL Editor before deploying landing-showcase-service.
-- Used by landing-showcase-service.js to cache the landing page snapshot.
BEGIN;

CREATE TABLE IF NOT EXISTS public.kv_store (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only service role can read/write. No public or anon access.
ALTER TABLE public.kv_store ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.kv_store FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.kv_store IS 'Generic server-side key-value store for caching snapshot data (e.g., landing_showcase_snapshot).';
COMMENT ON COLUMN public.kv_store.key IS 'Unique string key for the stored value.';
COMMENT ON COLUMN public.kv_store.value IS 'JSON-serialized value.';
COMMENT ON COLUMN public.kv_store.updated_at IS 'Timestamp of last upsert; used for stale detection.';

COMMIT;
