do $$
declare
  user_a uuid := '00000000-0000-4000-8000-000000000701';
  user_b uuid := '00000000-0000-4000-8000-000000000702';
  own_count integer;
  cross_count integer;
  hybrid_oid oid;
begin
  if not has_table_privilege('authenticated', 'public.user_access_scopes', 'select') then
    raise exception 'authenticated is missing SELECT on public.user_access_scopes';
  end if;

  if has_table_privilege('authenticated', 'public.user_access_scopes', 'insert')
     or has_table_privilege('authenticated', 'public.user_access_scopes', 'update')
     or has_table_privilege('authenticated', 'public.user_access_scopes', 'delete') then
    raise exception 'authenticated has unintended mutation privileges on public.user_access_scopes';
  end if;

  if has_table_privilege('anon', 'public.user_access_scopes', 'select')
     or has_table_privilege('anon', 'public.user_access_scopes', 'insert')
     or has_table_privilege('anon', 'public.user_access_scopes', 'update')
     or has_table_privilege('anon', 'public.user_access_scopes', 'delete') then
    raise exception 'anon has privileges on public.user_access_scopes';
  end if;

  if not exists (
    select 1
    from pg_tables
    where schemaname = 'public'
      and tablename = 'user_access_scopes'
      and rowsecurity is true
  ) then
    raise exception 'RLS is not enabled on public.user_access_scopes';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_access_scopes'
      and policyname = 'users can read own access scopes'
      and 'authenticated' = any(roles)
      and cmd = 'SELECT'
      and qual = '(auth.uid() = user_id)'
  ) then
    raise exception 'own-row SELECT policy is missing or incorrect on public.user_access_scopes';
  end if;

  if not (
    has_table_privilege('service_role', 'public.user_access_scopes', 'select')
    and has_table_privilege('service_role', 'public.user_access_scopes', 'insert')
    and has_table_privilege('service_role', 'public.user_access_scopes', 'update')
    and has_table_privilege('service_role', 'public.user_access_scopes', 'delete')
  ) then
    raise exception 'service_role behavior changed for public.user_access_scopes';
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

  delete from public.user_access_scopes where user_id in (user_a, user_b);
  delete from auth.users where id in (user_a, user_b);

  insert into auth.users (
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    created_at,
    updated_at,
    raw_app_meta_data,
    raw_user_meta_data
  )
  values
    (
      user_a,
      'authenticated',
      'authenticated',
      'schema-007-user-a@example.local',
      'synthetic',
      now(),
      now(),
      now(),
      '{}'::jsonb,
      '{}'::jsonb
    ),
    (
      user_b,
      'authenticated',
      'authenticated',
      'schema-007-user-b@example.local',
      'synthetic',
      now(),
      now(),
      now(),
      '{}'::jsonb,
      '{}'::jsonb
    );

  insert into public.user_access_scopes (user_id, access_scope)
  values
    (user_a, 'default'),
    (user_b, 'restricted-b');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', user_a::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select count(*) into own_count
  from public.user_access_scopes
  where user_id = user_a
    and access_scope = 'default';

  select count(*) into cross_count
  from public.user_access_scopes
  where user_id = user_b;

  reset role;

  if own_count <> 1 then
    raise exception 'authenticated user cannot read own access-scope row';
  end if;

  if cross_count <> 0 then
    raise exception 'authenticated user can read another user access-scope row';
  end if;

  delete from public.user_access_scopes where user_id in (user_a, user_b);
  delete from auth.users where id in (user_a, user_b);
end $$;
