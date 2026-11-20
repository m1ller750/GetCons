-- Defense in depth: the browser never talks to PostgREST as anon, and clients never need
-- TRIGGER/REFERENCES. Every function stays callable by the server (service role).

revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke execute on functions from anon;

revoke trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke trigger, references on tables from anon, authenticated;
