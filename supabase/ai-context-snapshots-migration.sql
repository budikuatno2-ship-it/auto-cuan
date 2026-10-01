create extension if not exists pgcrypto;

create table if not exists public.ai_context_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  source text not null
    check (source in ('stock_analysis_followup', 'portfolio_chat')),
  context_key text not null,
  payload jsonb not null,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, context_key)
);

create index if not exists ai_context_snapshots_latest_idx
  on public.ai_context_snapshots (source, updated_at desc);

create index if not exists ai_context_snapshots_user_latest_idx
  on public.ai_context_snapshots (user_id, source, updated_at desc);

alter table public.ai_context_snapshots enable row level security;
revoke all on public.ai_context_snapshots from anon, authenticated;

create or replace function public.touch_ai_context_snapshot_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ai_context_snapshots_touch_updated_at
  on public.ai_context_snapshots;

create trigger ai_context_snapshots_touch_updated_at
before update on public.ai_context_snapshots
for each row
execute function public.touch_ai_context_snapshot_updated_at();

select
  to_regclass('public.ai_context_snapshots') as ai_context_snapshots,
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.ai_context_snapshots'::regclass
  ) as rls_enabled;
