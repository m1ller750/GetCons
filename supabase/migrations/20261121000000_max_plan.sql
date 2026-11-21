-- The Max plan: everything in Pro, without a monthly reply limit (the limit lives in server/src/core/plans.ts).

alter table public.subscriptions drop constraint subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check
  check (plan in ('free', 'start', 'business', 'pro', 'max'));

alter table public.payments drop constraint payments_plan_check;
alter table public.payments add constraint payments_plan_check
  check (plan in ('start', 'business', 'pro', 'max'));

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
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  v_max := case public.effective_plan(new.user_id)
    when 'max' then 10
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
