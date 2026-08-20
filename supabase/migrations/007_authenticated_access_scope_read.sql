grant select on table public.user_access_scopes to authenticated;

revoke insert, update, delete on table public.user_access_scopes from authenticated;
revoke all on table public.user_access_scopes from anon;

alter table public.user_access_scopes enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_access_scopes'
      and policyname = 'users can read own access scopes'
  ) then
    create policy "users can read own access scopes"
    on public.user_access_scopes for select to authenticated
    using (auth.uid() = user_id);
  end if;
end $$;

comment on table public.user_access_scopes is
  'Authenticated users may read only their own access-scope rows through RLS. Backend service_role manages scope assignment.';
