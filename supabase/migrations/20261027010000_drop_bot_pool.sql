-- The pool of pre-created Telegram bots is gone: it needed the platform owner to create bots by
-- hand. Customers now confirm their own bot in Telegram (one tap), so its objects are dropped.

drop function if exists public.claim_pool_bot(uuid);
drop table if exists public.bot_pool_links;
drop index if exists public.managed_bots_pool_free_idx;

alter table public.managed_bots
  drop column if exists pool,
  drop column if exists retired_at;
