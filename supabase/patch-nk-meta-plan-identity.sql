-- BUG-NK-PLAN-RESUME (2026-10-09): persist the Non-Konglo batch plan identity
-- so a later orchestrator attempt resumes the SAME geometry instead of
-- re-planning the run with the batch_size=8 default (production evidence:
-- attempt #1 created 13 batches at 50, attempt #2 rebuilt 80 batches at 8 and
-- aborted the producer).
--
-- The VPS runtime uses the hybrid market store (lib/vps-market-store.js), which
-- persists whole JSON rows and therefore needs no schema change. This migration
-- only matters when the endpoint runs against Supabase/Postgres directly.
ALTER TABLE swing_screener_non_konglo_meta
  ADD COLUMN IF NOT EXISTS batch_size INTEGER,
  ADD COLUMN IF NOT EXISTS total_batches INTEGER;
