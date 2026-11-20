-- Plans and payments. Clients may read their own rows; only the server (service role) writes.
-- Limits live in server/src/core/plans.ts; the consultant cap is also enforced here so that
-- concurrent requests cannot slip past it.

create table public.subscriptions (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  plan               text not null default 'free' check (plan in ('free', 'start', 'business', 'pro')),
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

alter table public.subscriptions enable row level security;
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  plan                text not null check (plan in ('start', 'business', 'pro')),
  amount              numeric(12, 2) not null check (amount > 0),
  currency            text not null check (currency in ('USD', 'KZT', 'EUR')),
  provider            text not null default 'freedompay',
  provider_payment_id text,
  status              text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);

create index payments_user_created_idx on public.payments (user_id, created_at desc);
alter table public.payments enable row level security;
create policy payments_select_own on public.payments
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;

-- Monthly AI reply quota: a counter per account and month. It is not derived from messages,
-- so deleting conversations or consultants cannot reset it.
create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  month   date not null,
  replies integer not null default 0 check (replies >= 0),
  primary key (user_id, month)
);

alter table public.ai_usage enable row level security;
create policy ai_usage_select_own on public.ai_usage
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;

create or replace function public.record_ai_reply(p_user_id uuid)
returns integer
language sql
volatile
security invoker
set search_path = public
as $$
  insert into public.ai_usage as u (user_id, month, replies)
  values (p_user_id, date_trunc('month', now() at time zone 'utc')::date, 1)
  on conflict (user_id, month) do update set replies = u.replies + 1
  returning replies;
$$;

revoke execute on function public.record_ai_reply(uuid) from public, anon, authenticated;

-- Plan in force for a user (a paid plan only until its period ends).
create or replace function public.effective_plan(p_user_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select s.plan from public.subscriptions s
      where s.user_id = p_user_id and s.plan <> 'free' and s.current_period_end > now()),
    'free');
$$;

revoke execute on function public.effective_plan(uuid) from public, anon, authenticated;

create or replace function public.enforce_consultant_limit()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_max integer;
  v_count integer;
begin
  -- Serialize creations per user so two parallel requests cannot both pass the check.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  v_max := case public.effective_plan(new.user_id)
             when 'pro' then 10
             when 'business' then 3
             else 1
           end;
  select count(*) into v_count from public.consultants where user_id = new.user_id;
  if v_count >= v_max then
    raise exception 'consultant limit reached for this plan' using errcode = 'P0001', hint = 'limit_reached';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_consultant_limit() from public, anon, authenticated;

create trigger consultants_plan_limit
  before insert on public.consultants
  for each row execute function public.enforce_consultant_limit();

-- Marks a payment paid and extends the plan, exactly once (provider callbacks are retried).
create or replace function public.activate_payment(p_payment_id uuid, p_provider_payment_id text)
returns public.subscriptions
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_payment public.payments;
  v_sub public.subscriptions;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment not found';
  end if;
  if v_payment.status = 'paid' then
    select * into v_sub from public.subscriptions where user_id = v_payment.user_id;
    return v_sub;
  end if;

  update public.payments
     set status = 'paid', paid_at = now(), provider_payment_id = p_provider_payment_id
   where id = p_payment_id;

  insert into public.subscriptions as s (user_id, plan, current_period_end, updated_at)
  values (v_payment.user_id, v_payment.plan, now() + interval '30 days', now())
  on conflict (user_id) do update
    set plan = excluded.plan,
        -- Paying again for the plan in force adds 30 days; a different plan starts today.
        current_period_end =
          (case when s.plan = excluded.plan and s.current_period_end > now() then s.current_period_end else now() end)
          + interval '30 days',
        updated_at = now()
  returning * into v_sub;
  return v_sub;
end;
$$;

revoke execute on function public.activate_payment(uuid, text) from public, anon, authenticated;
