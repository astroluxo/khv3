do $$
declare
  required_tables constant text[] := array[
    'documents',
    'chunks',
    'sync_events',
    'queries',
    'feedback',
    'user_access_scopes'
  ];
  table_name text;
  hybrid_oid oid;
begin
  foreach table_name in array required_tables loop
    if not has_schema_privilege('service_role', 'public', 'usage') then
      raise exception 'service_role is missing usage on public schema';
    end if;

    if not exists (
      select 1
      from pg_tables
      where schemaname = 'public'
        and tablename = table_name
        and rowsecurity is true
    ) then
      raise exception 'RLS is not enabled on public.%', table_name;
    end if;

    if has_table_privilege('anon', format('public.%I', table_name), 'insert')
       or has_table_privilege('anon', format('public.%I', table_name), 'update')
       or has_table_privilege('anon', format('public.%I', table_name), 'delete') then
      raise exception 'anon has write privileges on public.%', table_name;
    end if;
  end loop;

  if not (
    has_table_privilege('service_role', 'public.documents', 'select')
    and has_table_privilege('service_role', 'public.documents', 'insert')
    and has_table_privilege('service_role', 'public.documents', 'update')
    and not has_table_privilege('service_role', 'public.documents', 'delete')
  ) then
    raise exception 'service_role document privileges are incorrect';
  end if;

  if not (
    has_table_privilege('service_role', 'public.chunks', 'select')
    and has_table_privilege('service_role', 'public.chunks', 'insert')
    and has_table_privilege('service_role', 'public.chunks', 'update')
    and has_table_privilege('service_role', 'public.chunks', 'delete')
  ) then
    raise exception 'service_role chunk privileges are incorrect';
  end if;

  if not (
    has_table_privilege('service_role', 'public.sync_events', 'select')
    and has_table_privilege('service_role', 'public.sync_events', 'insert')
    and has_table_privilege('service_role', 'public.sync_events', 'update')
    and not has_table_privilege('service_role', 'public.sync_events', 'delete')
  ) then
    raise exception 'service_role sync_events privileges are incorrect';
  end if;

  if not (
    has_table_privilege('service_role', 'public.queries', 'select')
    and has_table_privilege('service_role', 'public.queries', 'insert')
    and not has_table_privilege('service_role', 'public.queries', 'update')
    and not has_table_privilege('service_role', 'public.queries', 'delete')
  ) then
    raise exception 'service_role queries privileges are incorrect';
  end if;

  if not (
    has_table_privilege('service_role', 'public.feedback', 'select')
    and has_table_privilege('service_role', 'public.feedback', 'insert')
    and has_table_privilege('service_role', 'public.feedback', 'update')
    and has_table_privilege('service_role', 'public.feedback', 'delete')
  ) then
    raise exception 'service_role feedback privileges are incorrect';
  end if;

  if not (
    has_table_privilege('service_role', 'public.user_access_scopes', 'select')
    and has_table_privilege('service_role', 'public.user_access_scopes', 'insert')
    and has_table_privilege('service_role', 'public.user_access_scopes', 'update')
    and has_table_privilege('service_role', 'public.user_access_scopes', 'delete')
  ) then
    raise exception 'service_role user_access_scopes privileges are incorrect';
  end if;

  if not (
    has_table_privilege('authenticated', 'public.documents', 'select')
    and has_table_privilege('authenticated', 'public.chunks', 'select')
    and has_table_privilege('authenticated', 'public.queries', 'select')
    and has_table_privilege('authenticated', 'public.queries', 'insert')
    and has_table_privilege('authenticated', 'public.feedback', 'insert')
  ) then
    raise exception 'authenticated intended privileges are missing';
  end if;

  if has_table_privilege('authenticated', 'public.documents', 'insert')
     or has_table_privilege('authenticated', 'public.documents', 'update')
     or has_table_privilege('authenticated', 'public.documents', 'delete')
     or has_table_privilege('authenticated', 'public.chunks', 'insert')
     or has_table_privilege('authenticated', 'public.chunks', 'update')
     or has_table_privilege('authenticated', 'public.chunks', 'delete')
     or has_table_privilege('authenticated', 'public.sync_events', 'insert')
     or has_table_privilege('authenticated', 'public.sync_events', 'update')
     or has_table_privilege('authenticated', 'public.sync_events', 'delete')
     or has_table_privilege('authenticated', 'public.feedback', 'update')
     or has_table_privilege('authenticated', 'public.feedback', 'delete')
     or has_table_privilege('authenticated', 'public.user_access_scopes', 'insert')
     or has_table_privilege('authenticated', 'public.user_access_scopes', 'update')
     or has_table_privilege('authenticated', 'public.user_access_scopes', 'delete') then
    raise exception 'authenticated has unintended table mutation privileges';
  end if;

  select p.oid into hybrid_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'hybrid_search';

  if hybrid_oid is null then
    raise exception 'hybrid_search function is missing';
  end if;

  if has_function_privilege('anon', hybrid_oid, 'execute')
     or not has_function_privilege('authenticated', hybrid_oid, 'execute')
     or not has_function_privilege('service_role', hybrid_oid, 'execute') then
    raise exception 'hybrid_search execute privileges changed unexpectedly';
  end if;

  if exists (
    select 1
    from information_schema.sequences s
    where s.sequence_schema = 'public'
      and not has_sequence_privilege(
        'service_role',
        format('%I.%I', s.sequence_schema, s.sequence_name),
        'usage'
      )
  ) then
    raise exception 'service_role is missing required public sequence privileges';
  end if;
end $$;
