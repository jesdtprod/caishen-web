-- Repair branch registrations from existing inventory and transfer history.
-- A transfer can only be drafted for a product active in both branches.

insert into public.branch_products (branch_id, product_id, price_override, low_stock_level, status)
select distinct source.branch_id, source.product_id, product.price, product.low_stock_level, 'Active'
from (
  select branch_id, product_id from public.inventory
  union
  select source_branch_id, product_id from public.stock_transfers
  union
  select destination_branch_id, product_id from public.stock_transfers
) as source
join public.products as product on product.product_id = source.product_id
on conflict (branch_id, product_id) do update
set status = 'Active';

create or replace function public.create_transfer(
  source_branch_id_input text,
  destination_branch_id_input text,
  target_product_id text,
  transfer_qty numeric,
  transfer_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  transfer_id_value text := public.new_pos_id('TRF');
begin
  if not public.has_permission('transfers') or not public.can_access_branch(source_branch_id_input) then
    raise exception 'Your account does not have access to this action.';
  end if;
  perform public.assert_active_branch(source_branch_id_input);
  perform public.assert_active_branch(destination_branch_id_input);
  if source_branch_id_input = destination_branch_id_input then
    raise exception 'Choose a different destination branch.';
  end if;
  if transfer_qty is null or transfer_qty <= 0 then
    raise exception 'Transfer quantity must be greater than zero.';
  end if;
  if not exists (
    select 1
    from public.branch_products as source_product
    join public.branch_products as destination_product
      on destination_product.product_id = source_product.product_id
    where source_product.branch_id = source_branch_id_input
      and destination_product.branch_id = destination_branch_id_input
      and source_product.product_id = target_product_id
      and source_product.status = 'Active'
      and destination_product.status = 'Active'
  ) then
    raise exception 'Choose an active product registered in both branches.';
  end if;

  insert into public.stock_transfers (
    transfer_id, source_branch_id, destination_branch_id, product_id, qty, notes, created_by
  ) values (
    transfer_id_value, source_branch_id_input, destination_branch_id_input, target_product_id,
    transfer_qty, coalesce(transfer_notes, ''), auth.uid()
  );
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Created stock transfer', transfer_id_value, target_product_id || ': ' || transfer_qty::text);
  return jsonb_build_object('id', transfer_id_value, 'status', 'Draft');
end;
$$;
