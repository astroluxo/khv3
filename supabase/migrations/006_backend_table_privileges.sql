grant usage on schema public to anon, authenticated, service_role;

revoke all on table
  public.documents,
  public.chunks,
  public.sync_events,
  public.queries,
  public.feedback,
  public.user_access_scopes
from anon;

grant select on table public.documents to authenticated;
grant select on table public.chunks to authenticated;
grant select, insert on table public.queries to authenticated;
grant insert on table public.feedback to authenticated;

grant select, insert, update on table public.documents to service_role;
grant select, insert, update, delete on table public.chunks to service_role;
grant select, insert, update on table public.sync_events to service_role;
grant select, insert on table public.queries to service_role;
grant select, insert, update, delete on table public.feedback to service_role;
grant select, insert, update, delete on table public.user_access_scopes to service_role;

comment on table public.documents is
  'Backend service_role may upsert Notion document metadata. Authenticated reads remain constrained by RLS.';

comment on table public.chunks is
  'Backend service_role may reconcile chunks. Authenticated reads remain constrained by document RLS.';

comment on table public.sync_events is
  'Operational sync infrastructure. Access should be limited to trusted backend/service-role paths.';
