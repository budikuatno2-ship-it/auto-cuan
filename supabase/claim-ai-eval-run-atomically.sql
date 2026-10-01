-- Prevent multiple AI-eval supervisor instances from spawning workers for the
-- same run. Fresh STARTING/RUNNING rows are leased implicitly by heartbeat;
-- stale rows may be reclaimed after two minutes.

create or replace function public.claim_ai_eval_run(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claimed_id uuid;
begin
  update public.ai_eval_runs
  set status = 'STARTING',
      started_at = coalesce(started_at, now()),
      last_error = null,
      last_heartbeat_at = now(),
      updated_at = now()
  where id = p_run_id
    and desired_state = 'RUNNING'
    and (
      status in ('CREATED','PAUSED','READY','PENDING')
      or (
        status in ('STARTING','RUNNING')
        and coalesce(last_heartbeat_at, updated_at, created_at) < now() - interval '2 minutes'
      )
    )
  returning id into claimed_id;

  return claimed_id is not null;
end
$$;

revoke all on function public.claim_ai_eval_run(uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_eval_run(uuid) to service_role;
