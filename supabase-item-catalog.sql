-- Item catalog: lets an admin upload an image + name for any auction item once, from either
-- the website's admin panel or the Discord bot's /upload_item_image command, so both surfaces
-- share one picture library instead of each maintaining its own.
-- Run this file once in Supabase Dashboard -> SQL Editor (safe to re-run — everything here is
-- idempotent).
--
-- Design: the ONLY way to write to item_catalog or the item-images bucket is through the
-- queue-bridge Edge Function's new "upload_item_image" / "delete_item_image" actions, which run
-- with the service-role key and bypass RLS entirely. Browsers and the bot never get direct
-- write access — the website's admin IGN check and the bot's Discord role check are both
-- enforced again server-side in the Edge Function (see queue-bridge/index.ts), the same pattern
-- already used for "dequeue" and "capture_guild_stats". That also means item_catalog needs no
-- INSERT/UPDATE/DELETE policies at all: the public read policy below is the only one.

insert into storage.buckets (id, name, public)
values ('item-images', 'item-images', true)
on conflict (id) do nothing;

drop policy if exists "Public read item images" on storage.objects;
create policy "Public read item images" on storage.objects
  for select using (bucket_id = 'item-images');

create table if not exists public.item_catalog (
  item_key text primary key,
  display_name text not null,
  image_path text not null,
  image_url text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.item_catalog enable row level security;

drop policy if exists "Public read item catalog" on public.item_catalog;
create policy "Public read item catalog" on public.item_catalog
  for select using (true);
