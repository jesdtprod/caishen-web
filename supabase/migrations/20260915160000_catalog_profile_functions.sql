-- Secure operations not available through direct table policies.

create or replace function public.delete_product(target_product_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.';
  end if;
  if exists (select 1 from public.sale_items where product_id = target_product_id) then
    raise exception 'Products with recorded sales cannot be deleted.';
  end if;
  delete from public.inventory where product_id = target_product_id;
  delete from public.branch_products where product_id = target_product_id;
  delete from public.products where product_id = target_product_id;
  if not found then
    raise exception 'Product not found.';
  end if;
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Deleted product', target_product_id, '');
  return jsonb_build_object('productId', target_product_id);
end;
$$;

create or replace function public.update_own_profile(full_name_input text, username_input text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_profile public.profiles;
  normalized_username text := lower(trim(username_input));
begin
  if auth.uid() is null then raise exception 'Sign in is required.'; end if;
  if length(trim(full_name_input)) = 0 or length(normalized_username) = 0 then
    raise exception 'Full name and username are required.';
  end if;
  if exists (select 1 from public.profiles where username = normalized_username and user_id <> auth.uid()) then
    raise exception 'That username is already in use.';
  end if;
  update public.profiles
  set full_name = trim(full_name_input), username = normalized_username
  where user_id = auth.uid()
  returning * into updated_profile;
  return updated_profile;
end;
$$;

revoke all on function public.delete_product(text) from public;
revoke all on function public.update_own_profile(text, text) from public;
grant execute on function public.delete_product(text) to authenticated;
grant execute on function public.update_own_profile(text, text) to authenticated;
