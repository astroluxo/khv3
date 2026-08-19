alter table public.documents
  add column if not exists brand text,
  add column if not exists area text,
  add column if not exists published_ac boolean not null default false,
  add column if not exists traceability_metadata jsonb not null default '{}'::jsonb,
  add column if not exists production_metadata jsonb not null default '{}'::jsonb,
  add column if not exists editorial_metadata jsonb not null default '{}'::jsonb;

update public.documents
set published_ac = true
where status = 'published'
  and published_ac is false;

alter table public.sync_events
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists idempotency_key text;

update public.sync_events
set idempotency_key = provider || ':' || provider_event_id
where idempotency_key is null;

alter table public.sync_events
  alter column idempotency_key set not null;

alter table public.documents
  drop constraint if exists documents_source_id_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_source_source_id_key'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_source_source_id_key unique (source, source_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_traceability_metadata_object_chk'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_traceability_metadata_object_chk
      check (jsonb_typeof(traceability_metadata) = 'object');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_production_metadata_object_chk'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_production_metadata_object_chk
      check (jsonb_typeof(production_metadata) = 'object');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_editorial_metadata_object_chk'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_editorial_metadata_object_chk
      check (jsonb_typeof(editorial_metadata) = 'object');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sync_events_attempt_count_nonnegative_chk'
      and conrelid = 'public.sync_events'::regclass
  ) then
    alter table public.sync_events
      add constraint sync_events_attempt_count_nonnegative_chk
      check (attempt_count >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'sync_events_idempotency_key_key'
      and conrelid = 'public.sync_events'::regclass
  ) then
    alter table public.sync_events
      add constraint sync_events_idempotency_key_key unique (idempotency_key);
  end if;
end $$;

create index if not exists documents_brand_area_idx
  on public.documents (brand, area)
  where status = 'published' and published_ac is true;

create index if not exists documents_published_access_idx
  on public.documents (access_scope, status, published_ac);

create index if not exists sync_events_status_received_idx
  on public.sync_events (status, received_at);

create index if not exists sync_events_entity_idx
  on public.sync_events (provider, entity_id, received_at);

comment on column public.documents.brand is
  'Knowledge metadata from Notion Brand. May support retrieval filtering or boosting; not authorization.';

comment on column public.documents.area is
  'Knowledge metadata from Notion Área. Kept separate from department/access authorization metadata.';

comment on column public.documents.published_ac is
  'Source-of-truth Notion Publicado AC publication gate. False documents must not have retrievable active chunks.';

comment on column public.documents.access_scope is
  'Authorization metadata used for RLS and access filtering. Independent from Brand and Área.';

comment on column public.documents.traceability_metadata is
  'Non-evidence traceability metadata such as Versión and Rel_Actualizaciones relation identifiers.';

comment on column public.documents.production_metadata is
  'Non-evidence production metadata such as Formato Contenido, Audio, Guión, Video Base, Video Final, EstadoVid, and Quiz.';

comment on column public.documents.editorial_metadata is
  'Non-evidence editorial metadata such as Observaciones. Must not be included in answer context.';

comment on column public.sync_events.idempotency_key is
  'Stable deduplication key for provider webhook events, initially provider plus provider_event_id.';

comment on column public.sync_events.attempt_count is
  'Number of processing attempts for retry-safe incremental sync.';

comment on column public.sync_events.next_attempt_at is
  'Earliest time a failed or deferred event should be retried.';

comment on column public.sync_events.locked_at is
  'Timestamp used by a worker to claim an event during processing.';

comment on column public.sync_events.locked_by is
  'Opaque worker identifier for an event processing claim.';
