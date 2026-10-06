-- Pending staff password resets cannot access POS data or operations.

create or replace function public.profile_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid()
      and status = 'Active'
      and must_change_password = false
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid()
      and role = 'admin'
      and status = 'Active'
      and must_change_password = false
  );
$$;

create or replace function public.has_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.profiles
    where user_id = auth.uid()
      and role = 'staff'
      and status = 'Active'
      and must_change_password = false
      and required_permission = any(permissions)
  );
$$;

create or replace function public.can_access_branch(target_branch_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.profiles
    where user_id = auth.uid()
      and role = 'staff'
      and status = 'Active'
      and must_change_password = false
      and branch_id = target_branch_id
  );
$$;
