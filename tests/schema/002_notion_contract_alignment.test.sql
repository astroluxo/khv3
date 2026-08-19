do $$
begin
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
    raise exception 'documents is missing Notion contract alignment columns';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.documents'::regclass
      and conname = 'documents_source_source_id_key'
  ) then
    raise exception 'documents is missing unique(source, source_id)';
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.documents'::regclass
      and conname = 'documents_source_id_key'
  ) then
    raise exception 'documents still has source_id-only uniqueness';
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
    raise exception 'sync_events is missing retry/idempotency columns';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sync_events'::regclass
      and conname = 'sync_events_idempotency_key_key'
  ) then
    raise exception 'sync_events is missing idempotency_key uniqueness';
  end if;
end $$;
