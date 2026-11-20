-- =============================================================================
-- GetCons - initial schema
--
-- Security model ("read via RLS, write via server"):
--   * Every tenant-owned row carries user_id, derived by trigger from its consultant
--     (it can never be spoofed by the caller).
--   * The `authenticated` role may only SELECT its own rows (RLS). All writes go
--     through the backend, which verifies ownership and uses the service role.
--   * consultant_secrets (encrypted bot tokens, webhook secrets) is invisible to
--     every client role; only the service role can read it.
-- =============================================================================

create extension if not exists vector with schema extensions;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Derives user_id from the parent consultant so tenant ownership cannot be forged.
create or replace function public.set_owner_from_consultant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select c.user_id into v_owner from public.consultants c where c.id = new.consultant_id;
  if v_owner is null then
    raise exception 'consultant % not found', new.consultant_id using errcode = '23503';
  end if;
  new.user_id := v_owner;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Consultants
-- -----------------------------------------------------------------------------
create table public.consultants (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  name                  text not null check (char_length(name) between 1 and 80),
  status                text not null default 'draft'
                          check (status in ('draft', 'active', 'paused', 'error')),
  template              text not null default 'general',
  instructions          text not null default '' check (char_length(instructions) <= 12000),
  tone                  text not null default 'friendly',
  language              text not null default 'auto',
  use_emojis            boolean not null default true,
  strictness            text not null default 'balanced' check (strictness in ('strict', 'balanced')),
  business_info         jsonb not null default '{}'::jsonb,
  greeting_message      text not null default '' check (char_length(greeting_message) <= 2000),
  fallback_message      text not null default '' check (char_length(fallback_message) <= 2000),
  temperature           real not null default 0.4 check (temperature >= 0 and temperature <= 1.5),
  max_history_messages  integer not null default 20 check (max_history_messages between 2 and 60),
  handoff_enabled       boolean not null default true,
  telegram_bot_id       bigint,
  telegram_bot_username text,
  telegram_bot_name     text,
  telegram_connected_at timestamptz,
  owner_chat_id         bigint,
  owner_link_code       text,
  last_error            text,
  last_activity_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index consultants_user_id_idx on public.consultants (user_id);
-- A Telegram bot can only power one consultant at a time.
create unique index consultants_telegram_bot_id_key
  on public.consultants (telegram_bot_id) where telegram_bot_id is not null;

create trigger consultants_updated_at before update on public.consultants
  for each row execute function public.set_updated_at();

-- Server-only secrets. Bot tokens are AES-256-GCM encrypted by the backend.
create table public.consultant_secrets (
  consultant_id        uuid primary key references public.consultants (id) on delete cascade,
  bot_token_ciphertext text,
  webhook_secret       text,
  updated_at           timestamptz not null default now()
);

create trigger consultant_secrets_updated_at before update on public.consultant_secrets
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Knowledge base (RAG)
-- -----------------------------------------------------------------------------
create table public.knowledge_documents (
  id            uuid primary key default gen_random_uuid(),
  consultant_id uuid not null references public.consultants (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 200),
  source_type   text not null check (source_type in ('file', 'text', 'faq')),
  file_name     text,
  mime_type     text,
  size_bytes    integer,
  content       text not null,
  status        text not null default 'processing' check (status in ('processing', 'ready', 'error')),
  error         text,
  chunk_count   integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, consultant_id)
);

create index knowledge_documents_consultant_idx
  on public.knowledge_documents (consultant_id, created_at desc);

create trigger knowledge_documents_owner before insert or update of consultant_id, user_id
  on public.knowledge_documents for each row execute function public.set_owner_from_consultant();
create trigger knowledge_documents_updated_at before update on public.knowledge_documents
  for each row execute function public.set_updated_at();

create table public.knowledge_chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null,
  consultant_id uuid not null references public.consultants (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  chunk_index   integer not null,
  content       text not null,
  embedding     extensions.vector(768),
  fts           tsvector generated always as (to_tsvector('simple'::regconfig, content)) stored,
  created_at    timestamptz not null default now(),
  -- a chunk always belongs to a document of the same consultant
  foreign key (document_id, consultant_id)
    references public.knowledge_documents (id, consultant_id) on delete cascade
);

-- Retrieval is always scoped to one consultant and is exact within that tenant
-- (see match_knowledge_chunks), so a btree on consultant_id is the right index.
-- A global HNSW index would rank across all tenants first and then filter,
-- which silently loses recall for small tenants.
create index knowledge_chunks_consultant_idx on public.knowledge_chunks (consultant_id, document_id);
create index knowledge_chunks_fts_idx on public.knowledge_chunks using gin (fts);

create trigger knowledge_chunks_owner before insert or update of consultant_id, user_id
  on public.knowledge_chunks for each row execute function public.set_owner_from_consultant();

-- -----------------------------------------------------------------------------
-- Training examples (dynamic few-shot)
-- -----------------------------------------------------------------------------
create table public.training_examples (
  id               uuid primary key default gen_random_uuid(),
  consultant_id    uuid not null references public.consultants (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  customer_message text not null check (char_length(customer_message) between 1 and 4000),
  ideal_reply      text not null check (char_length(ideal_reply) between 1 and 4000),
  notes            text check (char_length(notes) <= 1000),
  is_pinned        boolean not null default false,
  source           text not null default 'manual'
                     check (source in ('manual', 'import', 'conversation', 'gap')),
  embedding        extensions.vector(768),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index training_examples_consultant_idx
  on public.training_examples (consultant_id, created_at desc);

create trigger training_examples_owner before insert or update of consultant_id, user_id
  on public.training_examples for each row execute function public.set_owner_from_consultant();
create trigger training_examples_updated_at before update on public.training_examples
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Conversations & messages (memory + dashboard)
-- -----------------------------------------------------------------------------
create table public.conversations (
  id                   uuid primary key default gen_random_uuid(),
  consultant_id        uuid not null references public.consultants (id) on delete cascade,
  user_id              uuid not null references auth.users (id) on delete cascade,
  channel              text not null default 'telegram' check (channel in ('telegram', 'playground')),
  external_chat_id     bigint not null,
  customer_name        text,
  customer_username    text,
  customer_language    text,
  summary              text,
  summarized_until     timestamptz,
  memory_reset_at      timestamptz,
  ai_enabled           boolean not null default true,
  needs_attention      boolean not null default false,
  attention_reason     text,
  message_count        integer not null default 0,
  last_message_at      timestamptz,
  last_message_preview text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (consultant_id, channel, external_chat_id),
  unique (id, consultant_id)
);

create index conversations_consultant_recent_idx
  on public.conversations (consultant_id, last_message_at desc nulls last);

create trigger conversations_owner before insert or update of consultant_id, user_id
  on public.conversations for each row execute function public.set_owner_from_consultant();
create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.messages (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null,
  consultant_id       uuid not null references public.consultants (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete cascade,
  role                text not null check (role in ('customer', 'assistant', 'operator', 'system')),
  content             text not null default '',
  status              text not null default 'ok'
                        check (status in ('ok', 'fallback', 'handoff', 'error', 'failed', 'skipped')),
  telegram_message_id bigint,
  telegram_update_id  bigint,
  meta                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  foreign key (conversation_id, consultant_id)
    references public.conversations (id, consultant_id) on delete cascade,
  -- Telegram may redeliver an update; this makes processing idempotent.
  unique (consultant_id, telegram_update_id)
);

create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index messages_consultant_created_idx on public.messages (consultant_id, created_at);

create trigger messages_owner before insert or update of consultant_id, user_id
  on public.messages for each row execute function public.set_owner_from_consultant();

-- -----------------------------------------------------------------------------
-- Activity log
-- -----------------------------------------------------------------------------
create table public.activity_events (
  id            uuid primary key default gen_random_uuid(),
  consultant_id uuid not null references public.consultants (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  type          text not null,
  level         text not null default 'info' check (level in ('info', 'warning', 'error')),
  message       text not null,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index activity_events_consultant_idx on public.activity_events (consultant_id, created_at desc);

create trigger activity_events_owner before insert or update of consultant_id, user_id
  on public.activity_events for each row execute function public.set_owner_from_consultant();

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.consultants         enable row level security;
alter table public.consultant_secrets  enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks    enable row level security;
alter table public.training_examples   enable row level security;
alter table public.conversations       enable row level security;
alter table public.messages            enable row level security;
alter table public.activity_events     enable row level security;

create policy "owners read their consultants" on public.consultants
  for select to authenticated using (user_id = (select auth.uid()));
create policy "owners read their documents" on public.knowledge_documents
  for select to authenticated using (user_id = (select auth.uid()));
create policy "owners read their chunks" on public.knowledge_chunks
  for select to authenticated using (user_id = (select auth.uid()));
create policy "owners read their examples" on public.training_examples
  for select to authenticated using (user_id = (select auth.uid()));
create policy "owners read their conversations" on public.conversations
  for select to authenticated using (user_id = (select auth.uid()));
create policy "owners read their messages" on public.messages
  for select to authenticated using (user_id = (select auth.uid()));
create policy "owners read their activity" on public.activity_events
  for select to authenticated using (user_id = (select auth.uid()));
-- consultant_secrets intentionally has no policies: deny-all for client roles.

revoke all on public.consultant_secrets from anon, authenticated;
revoke insert, update, delete, truncate on
  public.consultants, public.knowledge_documents, public.knowledge_chunks,
  public.training_examples, public.conversations, public.messages, public.activity_events
  from anon, authenticated;
revoke select on
  public.consultants, public.knowledge_documents, public.knowledge_chunks,
  public.training_examples, public.conversations, public.messages, public.activity_events
  from anon;

-- -----------------------------------------------------------------------------
-- Retrieval functions (security invoker => RLS applies to client roles)
-- -----------------------------------------------------------------------------

-- Hybrid search: exact cosine similarity + full-text, fused with Reciprocal Rank Fusion.
create or replace function public.match_knowledge_chunks(
  p_consultant_id uuid,
  p_embedding     extensions.vector(768),
  p_query         text,
  p_match_count   integer default 6
)
returns table (
  id             uuid,
  document_id    uuid,
  document_title text,
  content        text,
  similarity     double precision,
  keyword_rank   double precision,
  score          double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with scoped as materialized (
    select c.id, c.document_id, c.content, c.embedding, c.fts
    from public.knowledge_chunks c
    where c.consultant_id = p_consultant_id
  ),
  semantic as (
    select s.id,
           1 - (s.embedding <=> p_embedding) as similarity,
           row_number() over (order by s.embedding <=> p_embedding) as rnk
    from scoped s
    where p_embedding is not null and s.embedding is not null
    order by s.embedding <=> p_embedding
    limit greatest(p_match_count * 4, 20)
  ),
  keyword as (
    select s.id,
           ts_rank_cd(s.fts, q.query) as krank,
           row_number() over (order by ts_rank_cd(s.fts, q.query) desc) as rnk
    from scoped s,
         (select websearch_to_tsquery('simple'::regconfig, coalesce(p_query, '')) as query) q
    where s.fts @@ q.query
    order by krank desc
    limit greatest(p_match_count * 4, 20)
  ),
  fused as (
    select coalesce(se.id, kw.id) as id,
           coalesce(se.similarity, 0)::double precision as similarity,
           coalesce(kw.krank, 0)::double precision as keyword_rank,
           (coalesce(1.0 / (60 + se.rnk), 0) + coalesce(1.0 / (60 + kw.rnk), 0))::double precision as score
    from semantic se
    full outer join keyword kw on kw.id = se.id
  )
  select f.id, s.document_id, d.title, s.content, f.similarity, f.keyword_rank, f.score
  from fused f
  join scoped s on s.id = f.id
  join public.knowledge_documents d on d.id = s.document_id
  order by f.score desc, f.similarity desc
  limit p_match_count;
$$;

create or replace function public.match_training_examples(
  p_consultant_id uuid,
  p_embedding     extensions.vector(768),
  p_match_count   integer default 4
)
returns table (
  id               uuid,
  customer_message text,
  ideal_reply      text,
  notes            text,
  is_pinned        boolean,
  similarity       double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select e.id, e.customer_message, e.ideal_reply, e.notes, e.is_pinned,
         (1 - (e.embedding <=> p_embedding))::double precision as similarity
  from public.training_examples e
  where e.consultant_id = p_consultant_id
    and e.embedding is not null
    and p_embedding is not null
  order by e.embedding <=> p_embedding
  limit p_match_count;
$$;

-- -----------------------------------------------------------------------------
-- Analytics (Telegram traffic only; playground is excluded)
-- -----------------------------------------------------------------------------
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
      and c.channel = 'telegram'
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
      and c.channel = 'telegram'
      and m.created_at >= now() - make_interval(days => p_days)
  )
  select
    (select count(*) from public.conversations c
      where c.consultant_id = p_consultant_id and c.channel = 'telegram'),
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
      where c.consultant_id = p_consultant_id and c.channel = 'telegram' and c.needs_attention);
$$;
