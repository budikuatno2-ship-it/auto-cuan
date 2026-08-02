-- Auto-Cuan one-time cloud AI evaluation control plane.
-- PREPARE ONLY. Do not apply automatically to production.
-- Raw prompts and answers are stored as compressed JSONL objects; Postgres stores
-- compact status, counters, hashes, scores, and object locations.

create extension if not exists pgcrypto;

create table if not exists public.ai_eval_runs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  desired_state text not null default 'PAUSED'
    check (desired_state in ('RUNNING','PAUSED','STOPPED')),
  status text not null default 'CREATED'
    check (status in ('CREATED','STARTING','RUNNING','PAUSED','STOPPING','STOPPED','COMPLETED','BLOCKED','FAILED')),
  provider_kind text not null default 'openai_compatible',
  model text not null,
  dataset_manifest_path text not null,
  cases_target integer not null default 1000000 check (cases_target between 1 and 1000000),
  max_rpm integer not null default 30 check (max_rpm between 1 and 600),
  concurrency integer not null default 4 check (concurrency between 1 and 32),
  token_budget bigint not null default 50000000 check (token_budget between 1000 and 1000000000),
  tokens_used bigint not null default 0 check (tokens_used >= 0),
  cases_attempted bigint not null default 0 check (cases_attempted >= 0),
  cases_completed bigint not null default 0 check (cases_completed >= 0),
  cases_passed bigint not null default 0 check (cases_passed >= 0),
  cases_failed_eval bigint not null default 0 check (cases_failed_eval >= 0),
  provider_failures bigint not null default 0 check (provider_failures >= 0),
  retries bigint not null default 0 check (retries >= 0),
  current_shard integer not null default 0 check (current_shard >= 0),
  current_case_index integer not null default 0 check (current_case_index >= 0),
  config jsonb not null default '{}'::jsonb,
  last_error text,
  last_heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ai_eval_runs_name_uidx
  on public.ai_eval_runs (name);

create table if not exists public.ai_eval_chunks (
  id bigserial primary key,
  run_id uuid not null references public.ai_eval_runs(id) on delete cascade,
  shard_index integer not null,
  chunk_index integer not null,
  object_path text not null,
  sha256 text not null check (length(sha256) = 64),
  compression text not null default 'gzip' check (compression in ('gzip','zstd')),
  row_count integer not null check (row_count > 0),
  bytes_compressed bigint not null check (bytes_compressed >= 0),
  prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  passed_count integer not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (run_id, shard_index, chunk_index),
  unique (run_id, object_path)
);

create table if not exists public.ai_eval_case_index (
  run_id uuid not null references public.ai_eval_runs(id) on delete cascade,
  case_id text not null,
  task text not null check (task in ('stock_analysis_followup','portfolio_chat')),
  intent text not null,
  question_hash text not null check (length(question_hash) = 64),
  object_path text not null,
  row_number integer not null check (row_number >= 0),
  provider_attempts integer not null default 1 check (provider_attempts >= 1),
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  eval_pass boolean not null,
  eval_score smallint not null check (eval_score between 0 and 100),
  error_codes text[] not null default '{}',
  model text not null,
  completed_at timestamptz not null default now(),
  primary key (run_id, case_id)
);

create index if not exists ai_eval_runs_status_idx
  on public.ai_eval_runs (status, desired_state, updated_at desc);
create index if not exists ai_eval_case_index_score_idx
  on public.ai_eval_case_index (run_id, eval_pass, eval_score);
create index if not exists ai_eval_case_index_task_idx
  on public.ai_eval_case_index (run_id, task, intent);

alter table public.ai_eval_runs enable row level security;
alter table public.ai_eval_chunks enable row level security;
alter table public.ai_eval_case_index enable row level security;

revoke all on public.ai_eval_runs from anon, authenticated;
revoke all on public.ai_eval_chunks from anon, authenticated;
revoke all on public.ai_eval_case_index from anon, authenticated;
revoke all on sequence public.ai_eval_chunks_id_seq from anon, authenticated;

-- Private object storage for compressed shards. Only the service role accesses it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ai-eval-private', 'ai-eval-private', false, 52428800, array['application/gzip'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The VPS worker uses SUPABASE_SERVICE_ROLE_KEY and therefore bypasses RLS.
-- Phone controls go through the signed-admin server endpoint. Never expose the
-- service-role key or provider API key to the browser, database, or repository.

create or replace function public.touch_ai_eval_run_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ai_eval_runs_touch_updated_at on public.ai_eval_runs;
create trigger ai_eval_runs_touch_updated_at
before update on public.ai_eval_runs
for each row execute function public.touch_ai_eval_run_updated_at();
