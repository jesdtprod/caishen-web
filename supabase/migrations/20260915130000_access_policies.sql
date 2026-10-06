-- FR Merchandise POS: authenticated access and two-branch RLS rules.

create or replace function public.profile_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and status = 'Active'
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
    where user_id = auth.uid() and role = 'admin' and status = 'Active'
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
      and branch_id = target_branch_id
  );
$$;

create or replace function public.can_access_sale(target_sale_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sales
    where sale_id = target_sale_id
      and public.can_access_branch(branch_id)
  );
$$;

create or replace function public.claim_initial_admin(full_name_input text, username_input text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  created_profile public.profiles;
  normalized_username text := lower(trim(username_input));
begin
  if auth.uid() is null then
    raise exception 'Sign in is required.';
  end if;
  if length(trim(full_name_input)) = 0 or length(normalized_username) = 0 then
    raise exception 'Full name and username are required.';
  end if;

  perform pg_advisory_xact_lock(hashtext('fr-pos-initial-admin'));
  if exists (select 1 from public.profiles) then
    raise exception 'An administrator already exists.';
  end if;

  insert into public.profiles (user_id, full_name, username, role, permissions)
  values (
    auth.uid(), trim(full_name_input), normalized_username, 'admin',
    array['pos', 'products', 'inventory', 'transfers', 'customers', 'credits', 'sales', 'inventoryReports']
  )
  returning * into created_profile;

  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Created initial administrator account', auth.uid()::text, created_profile.full_name);

  return created_profile;
end;
$$;

create or replace function public.record_login()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set last_login_at = now()
  where user_id = auth.uid() and status = 'Active';
end;
$$;

revoke all on function public.claim_initial_admin(text, text) from public;
revoke all on function public.record_login() from public;
grant execute on function public.claim_initial_admin(text, text) to authenticated;
grant execute on function public.record_login() to authenticated;

create policy "active users can read branches"
on public.branches for select to authenticated
using (public.profile_is_active());

create policy "admins manage branches"
on public.branches for all to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "users read their own profile"
on public.profiles for select to authenticated
using (user_id = auth.uid());

create policy "admins read all profiles"
on public.profiles for select to authenticated
using (public.is_admin());

create policy "admins read account audit"
on public.account_audit for select to authenticated
using (public.is_admin());

create policy "active users read products"
on public.products for select to authenticated
using (public.profile_is_active());

create policy "product users create products"
on public.products for insert to authenticated
with check (public.has_permission('products'));

create policy "product users update products"
on public.products for update to authenticated
using (public.has_permission('products'))
with check (public.has_permission('products'));

create policy "admins delete products"
on public.products for delete to authenticated
using (public.is_admin());

create policy "users read permitted branch products"
on public.branch_products for select to authenticated
using (public.can_access_branch(branch_id));

create policy "product users manage assigned branch products"
on public.branch_products for all to authenticated
using (public.has_permission('products') and public.can_access_branch(branch_id))
with check (public.has_permission('products') and public.can_access_branch(branch_id));

create policy "users read customers in their branch"
on public.customers for select to authenticated
using (public.can_access_branch(branch_id));

create policy "customer users create customers in their branch"
on public.customers for insert to authenticated
with check (public.has_permission('customers') and public.can_access_branch(branch_id));

create policy "customer users update customers in their branch"
on public.customers for update to authenticated
using (public.has_permission('customers') and public.can_access_branch(branch_id))
with check (public.has_permission('customers') and public.can_access_branch(branch_id));

create policy "users read inventory in their branch"
on public.inventory for select to authenticated
using (public.can_access_branch(branch_id));

create policy "users read stock ins in their branch"
on public.stock_ins for select to authenticated
using (public.can_access_branch(branch_id));

create policy "users read transfers at their branch"
on public.stock_transfers for select to authenticated
using (
  public.can_access_branch(source_branch_id)
  or public.can_access_branch(destination_branch_id)
);

create policy "users read sales in their branch"
on public.sales for select to authenticated
using (public.can_access_branch(branch_id));

create policy "users read sale items in their branch"
on public.sale_items for select to authenticated
using (public.can_access_sale(sale_id));

create policy "users read credit payments in their branch"
on public.credit_payments for select to authenticated
using (public.can_access_branch(branch_id));

-- Inventory and financial mutations intentionally have no direct table policy.
-- The next migration exposes audited, transactional RPC functions for those actions.
