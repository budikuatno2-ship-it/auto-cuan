-- Auto-Cuan Security Phase 1
-- Additive and safe to re-run. Apply manually in Supabase SQL Editor before
-- enabling SECURITY_GUARD_MODE. No existing table is altered.

begin;

create table if not exists public.security_login_limits (
  key_type text not null check (key_type in ('ip', 'account', 'pair')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default now(),
  failure_count integer not null default 0 check (failure_count >= 0),
  blocked_until timestamptz,
  last_alerted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (key_type, key_hash)
);

create table if not exists public.security_events (
  id bigint generated always as identity primary key,
  request_id text not null unique check (request_id ~ '^sec_[A-Za-z0-9_-]{16,100}$'),
  event_type text not null check (event_type in (
    'login_failed',
    'admin_login_failed',
    'login_rate_limited',
    'admin_login_success',
    'admin_access_denied'
  )),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  outcome text not null check (outcome in ('success', 'failed', 'blocked', 'would_block', 'denied')),
  route text not null default '/api/login-user',
  method text not null default 'POST',
  ip_address inet,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  account_hash text not null check (account_hash ~ '^[0-9a-f]{64}$'),
  pair_hash text not null check (pair_hash ~ '^[0-9a-f]{64}$'),
  username_masked text not null,
  user_agent text not null default 'unknown',
  user_agent_hash text not null check (user_agent_hash ~ '^[0-9a-f]{64}$'),
  status_code integer,
  failure_reason text,
  blocked_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists security_events_created_at_idx
  on public.security_events (created_at desc);
create index if not exists security_events_ip_recent_idx
  on public.security_events (ip_hash, created_at desc);
create index if not exists security_events_account_recent_idx
  on public.security_events (account_hash, created_at desc);
create index if not exists security_events_severity_recent_idx
  on public.security_events (severity, created_at desc);
create index if not exists security_login_limits_blocked_idx
  on public.security_login_limits (blocked_until)
  where blocked_until is not null;

alter table public.security_login_limits enable row level security;
alter table public.security_events enable row level security;

revoke all on table public.security_login_limits from public, anon, authenticated;
revoke all on table public.security_events from public, anon, authenticated;
revoke all on sequence public.security_events_id_seq from public, anon, authenticated;

grant select, insert, update, delete on table public.security_login_limits to service_role;
grant select, insert, update, delete on table public.security_events to service_role;
grant usage, select on sequence public.security_events_id_seq to service_role;

create or replace function public.security_login_precheck(
  p_ip_hash text,
  p_account_hash text,
  p_pair_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_blocked_until timestamptz;
  v_reason text;
begin
  if p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_account_hash !~ '^[0-9a-f]{64}$'
     or p_pair_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid security key' using errcode = '22023';
  end if;

  select max(blocked_until), string_agg(key_type, ', ' order by key_type)
    into v_blocked_until, v_reason
  from public.security_login_limits
  where blocked_until > v_now
    and ((key_type = 'ip' and key_hash = p_ip_hash)
      or (key_type = 'pair' and key_hash = p_pair_hash));

  return jsonb_build_object(
    'blocked', v_blocked_until is not null,
    'blocked_until', v_blocked_until,
    'reason', coalesce(v_reason, 'none')
  );
end;
$$;

create or replace function public.security_login_record_failure(
  p_request_id text,
  p_ip_address inet,
  p_ip_hash text,
  p_account_hash text,
  p_pair_hash text,
  p_username_masked text,
  p_user_agent text,
  p_user_agent_hash text,
  p_is_admin_target boolean,
  p_route text,
  p_failure_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window interval := interval '15 minutes';
  v_ip_count integer := 0;
  v_account_count integer := 0;
  v_pair_count integer := 0;
  v_distinct_accounts integer := 0;
  v_pair_threshold integer := case when coalesce(p_is_admin_target, false) then 3 else 6 end;
  v_ip_threshold integer := 12;
  v_pair_block_until timestamptz;
  v_ip_block_until timestamptz;
  v_blocked_until timestamptz;
  v_pair_blocked boolean := false;
  v_ip_blocked boolean := false;
  v_should_alert boolean := false;
  v_rows integer := 0;
  v_severity text := 'medium';
  v_outcome text := 'failed';
  v_reason text := left(coalesce(nullif(p_failure_reason, ''), 'login_failed'), 80);
begin
  if p_request_id !~ '^sec_[A-Za-z0-9_-]{16,100}$'
     or p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_account_hash !~ '^[0-9a-f]{64}$'
     or p_pair_hash !~ '^[0-9a-f]{64}$'
     or p_user_agent_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid security input' using errcode = '22023';
  end if;

  insert into public.security_login_limits (
    key_type, key_hash, window_started_at, failure_count, blocked_until, updated_at
  ) values ('ip', p_ip_hash, v_now, 1, null, v_now)
  on conflict (key_type, key_hash) do update set
    failure_count = case
      when security_login_limits.window_started_at <= v_now - v_window then 1
      else security_login_limits.failure_count + 1
    end,
    window_started_at = case
      when security_login_limits.window_started_at <= v_now - v_window then v_now
      else security_login_limits.window_started_at
    end,
    blocked_until = case
      when security_login_limits.blocked_until is not null
       and security_login_limits.blocked_until <= v_now then null
      else security_login_limits.blocked_until
    end,
    updated_at = v_now
  returning failure_count into v_ip_count;

  insert into public.security_login_limits (
    key_type, key_hash, window_started_at, failure_count, blocked_until, updated_at
  ) values ('account', p_account_hash, v_now, 1, null, v_now)
  on conflict (key_type, key_hash) do update set
    failure_count = case
      when security_login_limits.window_started_at <= v_now - v_window then 1
      else security_login_limits.failure_count + 1
    end,
    window_started_at = case
      when security_login_limits.window_started_at <= v_now - v_window then v_now
      else security_login_limits.window_started_at
    end,
    blocked_until = null,
    updated_at = v_now
  returning failure_count into v_account_count;

  insert into public.security_login_limits (
    key_type, key_hash, window_started_at, failure_count, blocked_until, updated_at
  ) values ('pair', p_pair_hash, v_now, 1, null, v_now)
  on conflict (key_type, key_hash) do update set
    failure_count = case
      when security_login_limits.window_started_at <= v_now - v_window then 1
      else security_login_limits.failure_count + 1
    end,
    window_started_at = case
      when security_login_limits.window_started_at <= v_now - v_window then v_now
      else security_login_limits.window_started_at
    end,
    blocked_until = case
      when security_login_limits.blocked_until is not null
       and security_login_limits.blocked_until <= v_now then null
      else security_login_limits.blocked_until
    end,
    updated_at = v_now
  returning failure_count into v_pair_count;

  select count(*) into v_distinct_accounts
  from (
    select distinct account_hash
    from public.security_events
    where ip_hash = p_ip_hash
      and created_at >= v_now - v_window
      and event_type in ('login_failed', 'admin_login_failed')
    union
    select p_account_hash
  ) recent_accounts;

  if v_pair_count >= v_pair_threshold then
    v_pair_blocked := true;
    v_pair_block_until := v_now + case
      when coalesce(p_is_admin_target, false) then interval '2 hours'
      else interval '30 minutes'
    end;
    update public.security_login_limits
       set blocked_until = greatest(coalesce(blocked_until, v_pair_block_until), v_pair_block_until),
           updated_at = v_now
     where key_type = 'pair' and key_hash = p_pair_hash;
  end if;

  if v_ip_count >= v_ip_threshold or v_distinct_accounts >= 5 then
    v_ip_blocked := true;
    v_ip_block_until := v_now + case
      when v_distinct_accounts >= 5 then interval '2 hours'
      else interval '1 hour'
    end;
    update public.security_login_limits
       set blocked_until = greatest(coalesce(blocked_until, v_ip_block_until), v_ip_block_until),
           updated_at = v_now
     where key_type = 'ip' and key_hash = p_ip_hash;
  end if;

  v_blocked_until := greatest(v_pair_block_until, v_ip_block_until);

  if coalesce(p_is_admin_target, false) and v_account_count = 1 then
    update public.security_login_limits
       set last_alerted_at = v_now
     where key_type = 'account'
       and key_hash = p_account_hash
       and (last_alerted_at is null or last_alerted_at <= v_now - interval '15 minutes');
    get diagnostics v_rows = row_count;
    v_should_alert := v_should_alert or v_rows > 0;
  end if;

  if (coalesce(p_is_admin_target, false) and v_account_count >= 5)
     or (not coalesce(p_is_admin_target, false) and v_account_count >= 12) then
    update public.security_login_limits
       set last_alerted_at = v_now
     where key_type = 'account'
       and key_hash = p_account_hash
       and (last_alerted_at is null or last_alerted_at <= v_now - interval '15 minutes');
    get diagnostics v_rows = row_count;
    v_should_alert := v_should_alert or v_rows > 0;
  end if;

  if v_pair_blocked then
    update public.security_login_limits
       set last_alerted_at = v_now
     where key_type = 'pair'
       and key_hash = p_pair_hash
       and (last_alerted_at is null or last_alerted_at <= v_now - interval '15 minutes');
    get diagnostics v_rows = row_count;
    v_should_alert := v_should_alert or v_rows > 0;
  end if;

  if v_ip_blocked then
    update public.security_login_limits
       set last_alerted_at = v_now
     where key_type = 'ip'
       and key_hash = p_ip_hash
       and (last_alerted_at is null or last_alerted_at <= v_now - interval '15 minutes');
    get diagnostics v_rows = row_count;
    v_should_alert := v_should_alert or v_rows > 0;
  end if;

  if v_ip_blocked or v_pair_blocked then
    v_outcome := 'blocked';
    v_severity := case
      when coalesce(p_is_admin_target, false) or v_distinct_accounts >= 5 then 'critical'
      else 'high'
    end;
  elsif coalesce(p_is_admin_target, false) or v_account_count >= 12 then
    v_severity := 'high';
  end if;

  insert into public.security_events (
    request_id, event_type, severity, outcome, route, method,
    ip_address, ip_hash, account_hash, pair_hash, username_masked,
    user_agent, user_agent_hash, status_code, failure_reason,
    blocked_until, metadata, created_at
  ) values (
    p_request_id,
    case when coalesce(p_is_admin_target, false) then 'admin_login_failed' else 'login_failed' end,
    v_severity,
    v_outcome,
    left(coalesce(nullif(p_route, ''), '/api/login-user'), 160),
    'POST',
    p_ip_address,
    p_ip_hash,
    p_account_hash,
    p_pair_hash,
    left(coalesce(nullif(p_username_masked, ''), 'unknown'), 80),
    left(coalesce(nullif(p_user_agent, ''), 'unknown'), 240),
    p_user_agent_hash,
    case when v_outcome = 'blocked' then 429 else 400 end,
    v_reason,
    v_blocked_until,
    jsonb_build_object(
      'admin_target', coalesce(p_is_admin_target, false),
      'ip_failures', v_ip_count,
      'account_failures', v_account_count,
      'pair_failures', v_pair_count,
      'distinct_accounts_from_ip', v_distinct_accounts,
      'pair_threshold', v_pair_threshold,
      'ip_threshold', v_ip_threshold
    ),
    v_now
  );

  return jsonb_build_object(
    'blocked', v_outcome = 'blocked',
    'blocked_until', v_blocked_until,
    'severity', v_severity,
    'failure_reason', v_reason,
    'should_alert', v_should_alert,
    'counts', jsonb_build_object(
      'ip', v_ip_count,
      'account', v_account_count,
      'pair', v_pair_count,
      'distinct_accounts', v_distinct_accounts
    )
  );
end;
$$;

create or replace function public.security_login_record_blocked(
  p_request_id text,
  p_ip_address inet,
  p_ip_hash text,
  p_account_hash text,
  p_pair_hash text,
  p_username_masked text,
  p_user_agent text,
  p_user_agent_hash text,
  p_is_admin_target boolean,
  p_route text,
  p_blocked_until timestamptz,
  p_block_reason text,
  p_shadow_only boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_request_id !~ '^sec_[A-Za-z0-9_-]{16,100}$'
     or p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_account_hash !~ '^[0-9a-f]{64}$'
     or p_pair_hash !~ '^[0-9a-f]{64}$'
     or p_user_agent_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid security input' using errcode = '22023';
  end if;

  insert into public.security_events (
    request_id, event_type, severity, outcome, route, method,
    ip_address, ip_hash, account_hash, pair_hash, username_masked,
    user_agent, user_agent_hash, status_code, failure_reason,
    blocked_until, metadata
  ) values (
    p_request_id,
    'login_rate_limited',
    case when coalesce(p_is_admin_target, false) then 'critical' else 'high' end,
    case when coalesce(p_shadow_only, false) then 'would_block' else 'blocked' end,
    left(coalesce(nullif(p_route, ''), '/api/login-user'), 160),
    'POST',
    p_ip_address,
    p_ip_hash,
    p_account_hash,
    p_pair_hash,
    left(coalesce(nullif(p_username_masked, ''), 'unknown'), 80),
    left(coalesce(nullif(p_user_agent, ''), 'unknown'), 240),
    p_user_agent_hash,
    429,
    left(coalesce(nullif(p_block_reason, ''), 'active_rate_limit'), 80),
    p_blocked_until,
    jsonb_build_object(
      'admin_target', coalesce(p_is_admin_target, false),
      'shadow_only', coalesce(p_shadow_only, false)
    )
  ) on conflict (request_id) do nothing;

  return jsonb_build_object('recorded', true);
end;
$$;

create or replace function public.security_login_record_success(
  p_request_id text,
  p_ip_address inet,
  p_ip_hash text,
  p_account_hash text,
  p_pair_hash text,
  p_username_masked text,
  p_user_agent text,
  p_user_agent_hash text,
  p_is_admin_target boolean,
  p_route text,
  p_outcome text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_request_id !~ '^sec_[A-Za-z0-9_-]{16,100}$'
     or p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_account_hash !~ '^[0-9a-f]{64}$'
     or p_pair_hash !~ '^[0-9a-f]{64}$'
     or p_user_agent_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid security input' using errcode = '22023';
  end if;

  delete from public.security_login_limits
   where (key_type = 'account' and key_hash = p_account_hash)
      or (key_type = 'pair' and key_hash = p_pair_hash);

  if coalesce(p_is_admin_target, false) then
    insert into public.security_events (
      request_id, event_type, severity, outcome, route, method,
      ip_address, ip_hash, account_hash, pair_hash, username_masked,
      user_agent, user_agent_hash, status_code, failure_reason, metadata
    ) values (
      p_request_id,
      'admin_login_success',
      'low',
      'success',
      left(coalesce(nullif(p_route, ''), '/api/login-user'), 160),
      'POST',
      p_ip_address,
      p_ip_hash,
      p_account_hash,
      p_pair_hash,
      left(coalesce(nullif(p_username_masked, ''), 'unknown'), 80),
      left(coalesce(nullif(p_user_agent, ''), 'unknown'), 240),
      p_user_agent_hash,
      200,
      left(coalesce(nullif(p_outcome, ''), 'login_success'), 80),
      jsonb_build_object('admin_target', true)
    ) on conflict (request_id) do nothing;
  end if;

  return jsonb_build_object('recorded', true);
end;
$$;

revoke all on function public.security_login_precheck(text, text, text) from public, anon, authenticated;
revoke all on function public.security_login_record_failure(text, inet, text, text, text, text, text, text, boolean, text, text) from public, anon, authenticated;
revoke all on function public.security_login_record_blocked(text, inet, text, text, text, text, text, text, boolean, text, timestamptz, text, boolean) from public, anon, authenticated;
revoke all on function public.security_login_record_success(text, inet, text, text, text, text, text, text, boolean, text, text) from public, anon, authenticated;

grant execute on function public.security_login_precheck(text, text, text) to service_role;
grant execute on function public.security_login_record_failure(text, inet, text, text, text, text, text, text, boolean, text, text) to service_role;
grant execute on function public.security_login_record_blocked(text, inet, text, text, text, text, text, text, boolean, text, timestamptz, text, boolean) to service_role;
grant execute on function public.security_login_record_success(text, inet, text, text, text, text, text, text, boolean, text, text) to service_role;

commit;
