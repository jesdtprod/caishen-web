-- Return products that are active and registered in both selected branches.

create or replace function public.get_shared_transfer_products(
  source_branch_id_input text,
  destination_branch_id_input text
)
returns table(product_id text, name text, unit text, qty numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('transfers') or not public.can_access_branch(source_branch_id_input) then
    raise exception 'Your account does not have access to this action.';
  end if;
  if source_branch_id_input = destination_branch_id_input then
    raise exception 'Choose a different destination branch.';
  end if;

  return query
  select product.product_id, product.name, product.unit, coalesce(inventory.qty, 0)
  from public.branch_products as source_product
  join public.branch_products as destination_product
    on destination_product.product_id = source_product.product_id
  join public.products as product on product.product_id = source_product.product_id
  left join public.inventory as inventory
    on inventory.branch_id = source_product.branch_id
    and inventory.product_id = source_product.product_id
  where source_product.branch_id = source_branch_id_input
    and destination_product.branch_id = destination_branch_id_input
    and source_product.status = 'Active'
    and destination_product.status = 'Active'
    and product.status = 'Active'
  order by product.name;
end;
$$;

revoke all on function public.get_shared_transfer_products(text, text) from public;
grant execute on function public.get_shared_transfer_products(text, text) to authenticated;
