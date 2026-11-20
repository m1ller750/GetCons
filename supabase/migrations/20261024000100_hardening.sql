-- Follow-up from the Supabase database advisors.

-- Trigger-only functions must not be callable through PostgREST (/rest/v1/rpc/...).
-- Triggers keep working: EXECUTE is not checked when a trigger fires.
revoke execute on function public.set_owner_from_consultant() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- Cover foreign keys: speeds up RLS (user_id = auth.uid()) and cascading deletes.
create index if not exists knowledge_documents_user_id_idx on public.knowledge_documents (user_id);
create index if not exists knowledge_chunks_user_id_idx on public.knowledge_chunks (user_id);
create index if not exists knowledge_chunks_document_idx on public.knowledge_chunks (document_id, consultant_id);
create index if not exists training_examples_user_id_idx on public.training_examples (user_id);
create index if not exists conversations_user_id_idx on public.conversations (user_id);
create index if not exists messages_user_id_idx on public.messages (user_id);
create index if not exists messages_conversation_consultant_idx on public.messages (conversation_id, consultant_id);
create index if not exists activity_events_user_id_idx on public.activity_events (user_id);
