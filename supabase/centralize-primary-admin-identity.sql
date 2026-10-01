-- Residual audit hardening: centralize the primary admin identity in the
-- existing app_settings store and remove duplicated literals from live
-- SECURITY DEFINER functions.

begin;

insert into public.app_settings(key,value,updated_at)
values (
  'primary_admin_identity',
  jsonb_build_object('username','budi','telegram_user_id','6396446903'),
  now()
)
on conflict (key) do nothing;

create or replace function public.admin_primary_username()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select nullif(lower(btrim(value->>'username')), '')
  from public.app_settings
  where key = 'primary_admin_identity'
$$;

create or replace function public.admin_primary_telegram_user_id()
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  raw_id text;
begin
  select nullif(btrim(value->>'telegram_user_id'), '')
  into raw_id
  from public.app_settings
  where key = 'primary_admin_identity';

  if raw_id is null or raw_id !~ '^[0-9]{1,19}$' then
    raise exception 'primary admin identity unavailable';
  end if;

  return raw_id::bigint;
end
$$;

revoke all on function public.admin_primary_username() from public, anon, authenticated;
revoke all on function public.admin_primary_telegram_user_id() from public, anon, authenticated;
grant execute on function public.admin_primary_username() to service_role;
grant execute on function public.admin_primary_telegram_user_id() to service_role;

do $$
declare
  sig regprocedure;
  def text;
  rewritten text;
  targets regprocedure[] := array[
    'public.advance_voucher_admin_session(bigint,text,text,text)'::regprocedure,
    'public.clear_voucher_admin_session(bigint)'::regprocedure,
    'public.create_voucher_admin_batch(bigint,uuid)'::regprocedure,
    'public.record_voucher_admin_telegram_command(bigint,bigint,text)'::regprocedure,
    'public.review_manual_subscription_payment(text,bigint,text)'::regprocedure,
    'public.set_voucher_admin_quantity(bigint,bigint,uuid)'::regprocedure,
    'public.start_voucher_admin_session(bigint,timestamp with time zone)'::regprocedure
  ];
begin
  foreach sig in array targets loop
    select pg_get_functiondef(sig::oid) into def;
    if position('6396446903' in def) = 0 then
      raise exception 'expected admin Telegram literal missing from %', sig;
    end if;

    rewritten := replace(def, '6396446903', 'public.admin_primary_telegram_user_id()');
    if sig = 'public.review_manual_subscription_payment(text,bigint,text)'::regprocedure then
      if position('lower(username) = ''budi''' in rewritten) = 0 then
        raise exception 'expected admin username literal missing from %', sig;
      end if;
      rewritten := replace(rewritten, 'lower(username) = ''budi''', 'lower(username) = public.admin_primary_username()');
    end if;

    execute rewritten;
  end loop;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.oid::regprocedure = any(array[
        'public.advance_voucher_admin_session(bigint,text,text,text)'::regprocedure,
        'public.clear_voucher_admin_session(bigint)'::regprocedure,
        'public.create_voucher_admin_batch(bigint,uuid)'::regprocedure,
        'public.record_voucher_admin_telegram_command(bigint,bigint,text)'::regprocedure,
        'public.review_manual_subscription_payment(text,bigint,text)'::regprocedure,
        'public.set_voucher_admin_quantity(bigint,bigint,uuid)'::regprocedure,
        'public.start_voucher_admin_session(bigint,timestamp with time zone)'::regprocedure
      ])
      and (p.prosrc like '%6396446903%' or p.prosrc like '%lower(username) = ''budi''%')
  ) then
    raise exception 'admin identity literal remains in targeted functions';
  end if;
end
$$;

commit;
