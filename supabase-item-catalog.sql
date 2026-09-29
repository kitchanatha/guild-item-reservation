-- Item catalog: lets an admin upload a full auction-page screenshot (like the game's own
-- Guild Auction list, up to 4 items per page) from either the website's admin panel or the
-- Discord bot's /upload_auction_page command, and have the item name + icon for every row on
-- that page added automatically — no manual typing or per-item cropping. Both surfaces write
-- to the same catalog.
-- Run this file once in Supabase Dashboard -> SQL Editor (safe to re-run — everything here is
-- idempotent).
--
-- Design: the ONLY way to write to item_catalog or the item-images bucket is through the
-- queue-bridge Edge Function's "upload_auction_page" / "delete_item_image" actions, which run
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

-- crop_x/crop_y/crop_size: when set, image_url points at a FULL auction-page screenshot
-- (uploaded once, shared by up to 4 catalog rows — one per item shown on that page) rather
-- than a picture of just this one item, and the frontend crops that square region out of it
-- at display time (see js/app.js renderCatalogThumb). Null for a directly-uploaded single-item
-- icon, where image_url already IS the icon and needs no cropping.
alter table public.item_catalog add column if not exists crop_x integer;
alter table public.item_catalog add column if not exists crop_y integer;
alter table public.item_catalog add column if not exists crop_size integer;

alter table public.item_catalog enable row level security;

drop policy if exists "Public read item catalog" on public.item_catalog;
create policy "Public read item catalog" on public.item_catalog
  for select using (true);
