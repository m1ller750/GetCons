-- Postgres lets PUBLIC (and so anon) execute every new function. Our functions are called by
-- signed-in users (explicit grants) or by the server only, so PUBLIC loses execute.

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    execute format('revoke execute on function %s from public', f.sig);
  end loop;
end;
$$;

alter default privileges in schema public revoke execute on functions from public;

-- What the dashboard (signed-in users, under RLS) still needs.
grant execute on function public.consultant_daily_stats(uuid, integer, text) to authenticated, service_role;
grant execute on function public.consultant_overview(uuid, integer) to authenticated, service_role;
grant execute on function public.match_knowledge_chunks(uuid, extensions.vector, text, integer) to authenticated, service_role;
grant execute on function public.match_training_examples(uuid, extensions.vector, integer) to authenticated, service_role;
