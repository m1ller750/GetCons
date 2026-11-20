-- Pro plan AI agent and the website channel.
--   * Website channel: a chat widget for the business's site and a shareable chat link.
--   * Agent: the consultant connects to the business's store (Shopify, WooCommerce or any site
--     through its own API) and, with the owner's permission, places orders, cancels them,
--     processes returns and tells customers when their order changes.

-- -----------------------------------------------------------------------------
-- Website channel
-- -----------------------------------------------------------------------------
alter table public.consultants
  add column web_enabled boolean not null default false,
  -- Public id in the widget code and the chat link (not a secret; rotating it breaks old links).
  add column web_key text check (web_key is null or web_key ~ '^[A-Za-z0-9_-]{10,40}$'),
  -- Agent settings: { enabled, permissions: {...}, refundAutoLimit } (validated by the server).
  add column agent jsonb not null default '{}'::jsonb;

create unique index consultants_web_key_key on public.consultants (web_key) where web_key is not null;

alter table public.conversations drop constraint conversations_channel_check;
alter table public.conversations
  add constraint conversations_channel_check check (channel in ('telegram', 'whatsapp', 'web', 'playground'));

-- -----------------------------------------------------------------------------
-- Store connection: credentials are encrypted by the server; clients never read this table.
-- -----------------------------------------------------------------------------
create table public.store_connections (
  id                     uuid primary key default gen_random_uuid(),
  consultant_id          uuid not null unique references public.consultants (id) on delete cascade,
  user_id                uuid not null references auth.users (id) on delete cascade,
  platform               text not null check (platform in ('shopify', 'woocommerce', 'custom')),
  store_url              text not null check (char_length(store_url) between 8 and 500),
  store_name             text check (char_length(store_name) <= 200),
  currency               text check (char_length(currency) <= 8),
  credentials_ciphertext text not null,
  status                 text not null default 'connected' check (status in ('connected', 'error')),
  last_error             text check (char_length(last_error) <= 1000),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger store_connections_owner before insert or update of consultant_id, user_id
  on public.store_connections for each row execute function public.set_owner_from_consultant();
create trigger store_connections_updated_at before update on public.store_connections
  for each row execute function public.set_updated_at();

alter table public.store_connections enable row level security;
-- No policies: deny-all for client roles (like consultant_secrets).
revoke all on public.store_connections from anon, authenticated;

-- -----------------------------------------------------------------------------
-- What the agent did or wants to do: the owner's audit log and approval queue.
-- -----------------------------------------------------------------------------
create table public.agent_actions (
  id              uuid primary key default gen_random_uuid(),
  consultant_id   uuid not null references public.consultants (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid,
  kind            text not null check (kind in ('create_order', 'cancel_order', 'refund', 'notify')),
  status          text not null
                    check (status in ('awaiting_customer', 'awaiting_owner', 'done', 'failed', 'rejected', 'expired', 'simulated')),
  summary         text not null default '' check (char_length(summary) <= 4000),
  params          jsonb not null default '{}'::jsonb,
  result          jsonb,
  amount          numeric(14, 2),
  currency        text check (char_length(currency) <= 8),
  external_ref    text check (char_length(external_ref) <= 200),
  confirm_code    text check (char_length(confirm_code) <= 20),
  error           text check (char_length(error) <= 1000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  executed_at     timestamptz,
  foreign key (conversation_id, consultant_id)
    references public.conversations (id, consultant_id) on delete cascade
);

create index agent_actions_consultant_idx on public.agent_actions (consultant_id, created_at desc);
create index agent_actions_conversation_idx on public.agent_actions (conversation_id, created_at desc);

create trigger agent_actions_owner before insert or update of consultant_id, user_id
  on public.agent_actions for each row execute function public.set_owner_from_consultant();
create trigger agent_actions_updated_at before update on public.agent_actions
  for each row execute function public.set_updated_at();

alter table public.agent_actions enable row level security;
create policy "owners read their agent actions" on public.agent_actions
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.agent_actions from anon, authenticated;
grant select on public.agent_actions to authenticated;

-- -----------------------------------------------------------------------------
-- Orders the agent follows for a customer chat, so it can tell the customer when they change.
-- -----------------------------------------------------------------------------
create table public.agent_orders (
  id              uuid primary key default gen_random_uuid(),
  consultant_id   uuid not null references public.consultants (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null,
  external_id     text not null check (char_length(external_id) between 1 and 200),
  number          text not null check (char_length(number) between 1 and 100),
  status          text check (char_length(status) <= 100),
  notified_status text check (char_length(notified_status) <= 100),
  closed          boolean not null default false,
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (consultant_id, external_id),
  foreign key (conversation_id, consultant_id)
    references public.conversations (id, consultant_id) on delete cascade
);

create index agent_orders_open_idx on public.agent_orders (closed, last_checked_at nulls first);

create trigger agent_orders_owner before insert or update of consultant_id, user_id
  on public.agent_orders for each row execute function public.set_owner_from_consultant();
create trigger agent_orders_updated_at before update on public.agent_orders
  for each row execute function public.set_updated_at();

alter table public.agent_orders enable row level security;
create policy "owners read their agent orders" on public.agent_orders
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.agent_orders from anon, authenticated;
grant select on public.agent_orders to authenticated;
