-- WhatsApp channel: a consultant answers customers from a linked WhatsApp work number.
-- The server is a "linked device" of that number (like WhatsApp Web), paired with a QR code
-- or an 8-character code. The session keys are stored encrypted, server-side only.

-- Connection state shown on the dashboard.
alter table public.consultants
  add column whatsapp_status       text not null default 'disconnected'
                                     check (whatsapp_status in ('disconnected', 'pairing', 'connected', 'logged_out', 'error')),
  add column whatsapp_phone        text,
  add column whatsapp_name         text,
  add column whatsapp_connected_at timestamptz,
  -- the owner's own WhatsApp chat for alerts (linked with the same /connect code)
  add column owner_whatsapp_jid    text;

-- Conversations: a WhatsApp chat is identified by its JID ("79991234567@s.whatsapp.net" or
-- "…@lid"). external_chat_id keeps a stable numeric key derived from it for the unique index.
alter table public.conversations drop constraint conversations_channel_check;
alter table public.conversations
  add constraint conversations_channel_check check (channel in ('telegram', 'whatsapp', 'playground')),
  add column external_jid text;

-- Messages: WhatsApp message ids are strings; they make redelivery idempotent like Telegram updates.
alter table public.messages add column external_message_id text;
create unique index messages_consultant_external_id_key
  on public.messages (consultant_id, external_message_id) where external_message_id is not null;

-- Linked-device session (Signal keys and credentials), AES-256-GCM encrypted by the backend.
create table public.whatsapp_auth (
  consultant_id    uuid not null references public.consultants (id) on delete cascade,
  key              text not null,
  value_ciphertext text not null,
  updated_at       timestamptz not null default now(),
  primary key (consultant_id, key)
);

create trigger whatsapp_auth_updated_at before update on public.whatsapp_auth
  for each row execute function public.set_updated_at();

-- Server-only, like consultant_secrets: no policies, no client access.
alter table public.whatsapp_auth enable row level security;
revoke all on public.whatsapp_auth from anon, authenticated;

-- Analytics count every customer channel (WhatsApp as well as Telegram), never the test chat.
create or replace function public.consultant_daily_stats(
  p_consultant_id uuid,
  p_days          integer default 14,
  p_tz            text default 'UTC'
)
returns table (
  day               date,
  customer_messages bigint,
  ai_replies        bigint,
  fallbacks         bigint,
  operator_replies  bigint,
  conversations     bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select (now() at time zone p_tz)::date as today
  ),
  days as (
    select generate_series(b.today - (p_days - 1), b.today, interval '1 day')::date as day
    from bounds b
  ),
  msgs as (
    select (m.created_at at time zone p_tz)::date as day, m.role, m.status, m.conversation_id
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    cross join bounds b
    where m.consultant_id = p_consultant_id
      and c.channel <> 'playground'
      and m.created_at >= ((b.today - (p_days - 1))::timestamp at time zone p_tz)
  )
  select d.day,
         count(m.role) filter (where m.role = 'customer'),
         count(m.role) filter (where m.role = 'assistant' and m.status in ('ok', 'fallback', 'handoff')),
         count(m.role) filter (where m.role = 'assistant' and m.status in ('fallback', 'handoff', 'error')),
         count(m.role) filter (where m.role = 'operator'),
         count(distinct m.conversation_id)
  from days d
  left join msgs m on m.day = d.day
  group by d.day
  order by d.day;
$$;

create or replace function public.consultant_overview(
  p_consultant_id uuid,
  p_days          integer default 30
)
returns table (
  conversations        bigint,
  active_conversations bigint,
  customer_messages    bigint,
  ai_replies           bigint,
  fallbacks            bigint,
  handoffs             bigint,
  errors               bigint,
  operator_replies     bigint,
  avg_latency_ms       double precision,
  needs_attention      bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with recent as (
    select m.*
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    where m.consultant_id = p_consultant_id
      and c.channel <> 'playground'
      and m.created_at >= now() - make_interval(days => p_days)
  )
  select
    (select count(*) from public.conversations c
      where c.consultant_id = p_consultant_id and c.channel <> 'playground'),
    (select count(distinct r.conversation_id) from recent r),
    (select count(*) from recent r where r.role = 'customer'),
    (select count(*) from recent r where r.role = 'assistant' and r.status in ('ok', 'fallback', 'handoff')),
    (select count(*) from recent r where r.role = 'assistant' and r.status = 'fallback'),
    (select count(*) from recent r where r.role = 'assistant' and r.status = 'handoff'),
    (select count(*) from recent r where r.role = 'assistant' and r.status in ('error', 'failed')),
    (select count(*) from recent r where r.role = 'operator'),
    (select avg((r.meta ->> 'latency_ms')::double precision) from recent r
      where r.role = 'assistant' and r.meta ? 'latency_ms'),
    (select count(*) from public.conversations c
      where c.consultant_id = p_consultant_id and c.channel <> 'playground' and c.needs_attention);
$$;
