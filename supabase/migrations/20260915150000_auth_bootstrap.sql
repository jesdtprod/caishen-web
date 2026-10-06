-- Allow the browser login screen to determine whether the first profile exists.
-- This exposes only a boolean; all profile data remains protected by RLS.

create or replace function public.needs_initial_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (select 1 from public.profiles);
$$;

revoke all on function public.needs_initial_admin() from public;
grant execute on function public.needs_initial_admin() to anon, authenticated;
