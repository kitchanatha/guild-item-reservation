-- Shared 3-second page timer and authoritative claim gate.
-- Run this file once in Supabase Dashboard -> SQL Editor.

-- Records who started each page's timer, so it can be looked up later in the
-- Table Editor (or via a `select * from page_timer_log order by started_at desc`)
-- instead of guessing from the shared, login-less admin trigger.
create table if not exists public.page_timer_log (
  id bigint generated always as identity primary key,
  page integer not null,
  started_by text,
  started_at timestamptz not null default now()
);

-- Allowlist of IGNs permitted to start a page timer. Managed from the hidden
-- admin menu (the same 10-click logo trigger that reveals Reset/Export/etc),
-- and enforced server-side in start_page_timer below so the check can't be
-- bypassed by editing the page. Note this is still only as strong as the IGN
-- someone types in — there's no login on this site — so treat it as a soft
-- gate against casual misuse, not real authentication.
create table if not exists public.timer_admins (
  id bigint generated always as identity primary key,
  ign text not null unique,
  added_at timestamptz not null default now(),
  added_by text
);

alter table public.timer_admins enable row level security;
-- No policies -> anon/authenticated get zero direct table access; all reads
-- and writes go through the security definer functions below.

create or replace function public.list_timer_admins()
returns table(ign text, added_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select ign, added_at from public.timer_admins order by added_at asc;
$$;

create or replace function public.add_timer_admin(p_ign text, p_added_by text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_ign is null or btrim(p_ign) = '' then
    raise exception 'IGN is required';
  end if;
  insert into public.timer_admins (ign, added_by)
  values (btrim(p_ign), nullif(btrim(p_added_by), ''))
  on conflict (ign) do nothing;
end;
$$;

create or replace function public.remove_timer_admin(p_ign text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.timer_admins where ign = btrim(p_ign);
end;
$$;

create or replace function public.rename_timer_admin(p_old_ign text, p_new_ign text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_new_ign is null or btrim(p_new_ign) = '' then
    raise exception 'New IGN is required';
  end if;
  update public.timer_admins set ign = btrim(p_new_ign) where ign = btrim(p_old_ign);
end;
$$;

create or replace function public.server_time_ms()
returns bigint
language sql
volatile
security definer
set search_path = public
as $$
  select floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

-- Overload cleanup: drop the old one-argument signature so PostgREST doesn't
-- see two start_page_timer candidates and refuse to pick one.
drop function if exists public.start_page_timer(integer);

create or replace function public.start_page_timer(p_page integer, p_started_by text default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id integer;
  v_start_ms bigint;
  v_existing text;
  v_won integer;
begin
  if p_page is null or p_page < 1 then
    raise exception 'Invalid page number';
  end if;

  if p_started_by is null or btrim(p_started_by) = '' or not exists (
    select 1 from public.timer_admins where ign = btrim(p_started_by)
  ) then
    raise exception 'Only designated timer admins can start the timer.';
  end if;

  v_item_id := 10000 + p_page;

  -- If this page already has a timer in the current round, return the exact
  -- same database-created timestamp instead of starting a second timer.
  select ign into v_existing
  from public.reservations
  where item_id = v_item_id;

  if v_existing is not null then
    begin
      return v_existing::bigint;
    exception when invalid_text_representation then
      delete from public.reservations where item_id = v_item_id;
    end;
  end if;

  v_start_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;

  insert into public.reservations (item_id, ign)
  values (v_item_id, v_start_ms::text)
  on conflict (item_id) do nothing;

  -- Handles two admins clicking at nearly the same instant: both callers
  -- receive the timestamp belonging to the single winning timer row, but only
  -- the caller whose insert actually won the race gets logged as the starter.
  get diagnostics v_won = row_count;
  if v_won > 0 then
    insert into public.page_timer_log (page, started_by)
    values (p_page, nullif(btrim(p_started_by), ''));
  end if;

  select ign::bigint into v_start_ms
  from public.reservations
  where item_id = v_item_id;

  return v_start_ms;
end;
$$;

create or replace function public.claim_item_after_timer(p_item_id integer, p_ign text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items_per_page integer := 4;
  v_page integer;
  v_timer_ms bigint;
  v_now_ms bigint;
  v_rows integer;
  v_config text;
begin
  if p_item_id is null or p_item_id < 1 or p_item_id >= 10000 then
    return 'invalid_item';
  end if;

  if p_ign is null or btrim(p_ign) = '' then
    return 'invalid_ign';
  end if;

  -- Read the shared configuration so the database, not the browser, decides
  -- which page owns this item.
  select ign into v_config
  from public.reservations
  where item_id = 0;

  if v_config is not null then
    begin
      v_items_per_page := greatest(1, coalesce((v_config::jsonb ->> 'itemsPerPage')::integer, 4));
    exception when others then
      v_items_per_page := 4;
    end;
  end if;

  v_page := ceil(p_item_id::numeric / v_items_per_page)::integer;

  begin
    select ign::bigint into v_timer_ms
    from public.reservations
    where item_id = 10000 + v_page;
  exception when invalid_text_representation then
    return 'timer_not_started';
  end;

  if v_timer_ms is null then
    return 'timer_not_started';
  end if;

  v_now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  if v_now_ms < v_timer_ms + 3000 then
    return 'too_early';
  end if;

  insert into public.reservations (item_id, ign)
  values (p_item_id, btrim(p_ign))
  on conflict (item_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'already_claimed';
  end if;

  return 'claimed';
end;
$$;

grant execute on function public.server_time_ms() to anon, authenticated;
grant execute on function public.start_page_timer(integer, text) to anon, authenticated;
grant execute on function public.claim_item_after_timer(integer, text) to anon, authenticated;
grant execute on function public.list_timer_admins() to anon, authenticated;
grant execute on function public.add_timer_admin(text, text) to anon, authenticated;
grant execute on function public.remove_timer_admin(text) to anon, authenticated;
grant execute on function public.rename_timer_admin(text, text) to anon, authenticated;
