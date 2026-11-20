-- One-click bot creation via Telegram Managed Bots (Bot API 9.6+).
-- The platform's manager bot asks Telegram to create a bot for the user; Telegram then
-- sends a `managed_bot` update and the server fetches the token with getManagedBotToken.

-- A "create my bot" click on the dashboard. Matched to the bot Telegram creates by the
-- suggested username or by the creator's Telegram account.
create table public.bot_creation_requests (
  id                 uuid primary key default gen_random_uuid(),
  consultant_id      uuid not null references public.consultants (id) on delete cascade,
  user_id            uuid not null references auth.users (id) on delete cascade,
  nonce              text not null unique,
  suggested_username text not null,
  suggested_name     text not null,
  telegram_user_id   bigint,
  status             text not null default 'pending'
                       check (status in ('pending', 'completed', 'failed', 'expired')),
  bot_id             bigint,
  bot_username       text,
  error              text,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index bot_creation_requests_consultant_idx on public.bot_creation_requests (consultant_id, created_at desc);
create index bot_creation_requests_user_id_idx on public.bot_creation_requests (user_id);
create index bot_creation_requests_username_idx
  on public.bot_creation_requests (lower(suggested_username)) where status = 'pending';
create index bot_creation_requests_tg_user_idx
  on public.bot_creation_requests (telegram_user_id) where status = 'pending';

create trigger bot_creation_requests_owner before insert or update of consultant_id, user_id
  on public.bot_creation_requests for each row execute function public.set_owner_from_consultant();

alter table public.bot_creation_requests enable row level security;
create policy "owners read their bot requests" on public.bot_creation_requests
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.bot_creation_requests from anon, authenticated;
revoke select on public.bot_creation_requests from anon;

-- Every bot created under the manager bot (server-only bookkeeping).
create table public.managed_bots (
  bot_id              bigint primary key,
  username            text,
  name                text,
  creator_telegram_id bigint not null,
  consultant_id       uuid references public.consultants (id) on delete set null,
  created_at          timestamptz not null default now(),
  claimed_at          timestamptz
);

create index managed_bots_creator_idx on public.managed_bots (creator_telegram_id, created_at desc);
create index managed_bots_consultant_idx on public.managed_bots (consultant_id);

alter table public.managed_bots enable row level security;
revoke all on public.managed_bots from anon, authenticated;
