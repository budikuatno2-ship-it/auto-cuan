-- Residual audit hardening: close two live data-integrity gaps without
-- rewriting already-applied historical migrations.
--
-- 1) telegram_daily_picks: make plan identity unique even when nullable
--    identity columns contain NULL (PostgreSQL 15+ NULLS NOT DISTINCT).
-- 2) sector-hot: make the revised *_CORE/*_AFFILIATE/*_RADAR taxonomy the
--    final authority by deactivating legacy v3/plain group codes.

begin;

-- Refuse to hide pre-existing duplicate identities. Production was checked
-- before this migration was authored, but this keeps fresh/other environments
-- fail-closed instead of silently deleting data.
do $$
begin
  if exists (
    select 1
    from public.telegram_daily_picks
    group by date, ticker, monitor_source, plan_lock_id
    having count(*) > 1
  ) then
    raise exception 'telegram_daily_picks contains duplicate plan identities; resolve explicitly before applying uniqueness hardening';
  end if;
end
$$;

-- Build the replacement before dropping the legacy partial index so there is
-- never a committed state without uniqueness protection for the covered rows.
drop index if exists public.idx_telegram_daily_picks_plan_identity_unique_all_rows;
create unique index idx_telegram_daily_picks_plan_identity_unique_all_rows
  on public.telegram_daily_picks (date, ticker, monitor_source, plan_lock_id)
  nulls not distinct;

drop index if exists public.idx_telegram_daily_picks_plan_identity_unique;
alter index public.idx_telegram_daily_picks_plan_identity_unique_all_rows
  rename to idx_telegram_daily_picks_plan_identity_unique;

-- `sector-hot-members-patch.sql` introduced an older/plain taxonomy that can
-- conflict with the revised canonical mapping in
-- `patch-sector-hot-group-mapping-v2.sql`. Historical migrations remain
-- immutable; this corrective migration establishes the revised taxonomy as the
-- final live authority by keeping the legacy codes inactive.
with legacy(group_code) as (
  values
    ('BUMN_TAMBANG'), ('BUMN_BANK'), ('BUMN_TELCO'), ('BUMN_KARYA'),
    ('ASTRA'), ('SALIM'), ('SINARMAS'), ('DJARUM'), ('LIPPO'), ('BARITO'),
    ('ADARO'), ('SARATOGA'), ('CT_CORP'), ('EMTEK'), ('MNC'), ('MAYAPADA'),
    ('WILMAR'), ('TOBA'), ('TRIPUTRA'), ('PODOMORO'), ('PANIN'), ('KALBE'),
    ('CHAROEN_POKPHAND'), ('CIPUTRA'), ('SUMMARECON'), ('MAYORA'),
    ('BAKRIE'), ('GAJAH_TUNGGAL'), ('PJAYA'), ('JAPFA')
)
update public.sector_hot_group_members m
set is_active = false
from legacy l
where m.group_code = l.group_code
  and m.is_active is distinct from false;

with legacy(group_code) as (
  values
    ('BUMN_TAMBANG'), ('BUMN_BANK'), ('BUMN_TELCO'), ('BUMN_KARYA'),
    ('ASTRA'), ('SALIM'), ('SINARMAS'), ('DJARUM'), ('LIPPO'), ('BARITO'),
    ('ADARO'), ('SARATOGA'), ('CT_CORP'), ('EMTEK'), ('MNC'), ('MAYAPADA'),
    ('WILMAR'), ('TOBA'), ('TRIPUTRA'), ('PODOMORO'), ('PANIN'), ('KALBE'),
    ('CHAROEN_POKPHAND'), ('CIPUTRA'), ('SUMMARECON'), ('MAYORA'),
    ('BAKRIE'), ('GAJAH_TUNGGAL'), ('PJAYA'), ('JAPFA')
)
update public.sector_hot_groups g
set is_active = false,
    updated_at = now()
from legacy l
where g.group_code = l.group_code
  and g.is_active is distinct from false;

-- Fail if an environment has no active revised taxonomy at all; that usually
-- means the canonical v2 mapping was never applied and should be fixed rather
-- than accepting an empty sector-hot universe.
do $$
begin
  if not exists (
    select 1
    from public.sector_hot_groups
    where is_active = true
      and (
        group_code like '%\_CORE' escape '\'
        or group_code like '%\_AFFILIATE%' escape '\'
        or group_code like '%\_RADAR%' escape '\'
        or group_code in ('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'TELCO_NON_BUMN', 'ASTRA_EX')
      )
  ) then
    raise exception 'canonical sector-hot v2 taxonomy is missing; apply patch-sector-hot-group-mapping-v2.sql first';
  end if;
end
$$;

commit;
