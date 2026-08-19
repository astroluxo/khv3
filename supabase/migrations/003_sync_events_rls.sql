alter table public.sync_events enable row level security;

comment on table public.sync_events is
  'Operational sync infrastructure. Access should be limited to trusted backend/service-role paths.';
