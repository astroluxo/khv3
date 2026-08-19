do $$
begin
  if not exists (
    select 1
    from pg_tables
    where schemaname = 'public'
      and tablename = 'sync_events'
      and rowsecurity is true
  ) then
    raise exception 'sync_events must have row level security enabled';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'sync_events'
      and permissive = 'PERMISSIVE'
      and (
        'authenticated' = any(roles)
        or 'public' = any(roles)
      )
  ) then
    raise exception 'sync_events must not have permissive authenticated-user policies';
  end if;

  if not exists (
    select 1
    from pg_extension
    where extname = 'vector'
  ) then
    raise exception 'pgvector extension is missing';
  end if;

  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name in (
        'documents',
        'chunks',
        'sync_events',
        'queries',
        'feedback',
        'user_access_scopes'
      )
    group by table_schema
    having count(*) = 6
  ) then
    raise exception 'base public tables from 001 are missing';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'hybrid_search'
  ) then
    raise exception 'hybrid_search function from 001 is missing';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'documents'
      and column_name in (
        'brand',
        'area',
        'published_ac',
        'traceability_metadata',
        'production_metadata',
        'editorial_metadata'
      )
    group by table_schema, table_name
    having count(*) = 6
  ) then
    raise exception 'documents schema from 002 is missing Notion alignment columns';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.documents'::regclass
      and conname = 'documents_source_source_id_key'
  ) then
    raise exception 'documents unique(source, source_id) from 002 is missing';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sync_events'
      and column_name in (
        'attempt_count',
        'last_attempt_at',
        'next_attempt_at',
        'locked_at',
        'locked_by',
        'idempotency_key'
      )
    group by table_schema, table_name
    having count(*) = 6
  ) then
    raise exception 'sync_events schema from 002 is missing retry/idempotency columns';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sync_events'::regclass
      and conname = 'sync_events_idempotency_key_key'
  ) then
    raise exception 'sync_events idempotency constraint from 002 is missing';
  end if;
end $$;
