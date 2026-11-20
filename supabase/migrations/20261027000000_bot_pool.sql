-- Instant Telegram bots: a pool of ready bots created in advance by the platform owner through the
-- manager bot (Managed Bots). A customer's click claims one immediately: the bot is renamed after
-- their business and connected, with no detour through Telegram.

alter table public.managed_bots
  add column pool       boolean not null default false,
  -- a pool bot that served a consultant is never handed to another business
  add column retired_at timestamptz;

create index managed_bots_pool_free_idx
  on public.managed_bots (created_at) where pool and consultant_id is null and retired_at is null;

-- Links the platform owner opens to add bots to the pool (server-only).
create table public.bot_pool_links (
  nonce              text primary key,
  suggested_username text not null,
  telegram_user_id   bigint,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null
);

create index bot_pool_links_username_idx on public.bot_pool_links (lower(suggested_username));

alter table public.bot_pool_links enable row level security;
revoke all on public.bot_pool_links from anon, authenticated;

-- Takes the oldest free pool bot for a consultant, safely under concurrent clicks.
create or replace function public.claim_pool_bot(p_consultant_id uuid)
returns setof public.managed_bots
language sql
volatile
security invoker
set search_path = public
as $$
  update public.managed_bots m
     set consultant_id = p_consultant_id, claimed_at = now()
   where m.bot_id = (
     select f.bot_id from public.managed_bots f
      where f.pool and f.consultant_id is null and f.retired_at is null
      order by f.created_at
      limit 1
      for update skip locked
   )
  returning m.*;
$$;

revoke execute on function public.claim_pool_bot(uuid) from public, anon, authenticated;
