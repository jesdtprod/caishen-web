-- Transfers preserve every FIFO selling-price portion from source to destination.
alter table public.transfer_batch_allocations add column if not exists selling_price numeric(12, 2);
alter table public.transfer_batch_allocations drop constraint if exists transfer_batch_allocations_selling_price_nonnegative;
alter table public.transfer_batch_allocations add constraint transfer_batch_allocations_selling_price_nonnegative check (selling_price is null or selling_price >= 0);

update public.transfer_batch_allocations allocation
set selling_price = batch.selling_price
from public.inventory_cost_batches batch
where batch.batch_id = allocation.source_batch_id and allocation.selling_price is null;

create or replace function public.dispatch_transfer(target_transfer_id text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare transfer_row public.stock_transfers; batch_row public.inventory_cost_batches; available_qty numeric; remaining_qty numeric; allocated_qty numeric;
begin
  select * into transfer_row from public.stock_transfers where transfer_id = target_transfer_id for update;
  if not found then raise exception 'Stock transfer not found.'; end if;
  if not public.has_permission('transfers') or not public.can_access_branch(transfer_row.source_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if transfer_row.status <> 'Draft' then raise exception 'Only draft transfers can be dispatched.'; end if;
  select qty into available_qty from public.inventory where branch_id = transfer_row.source_branch_id and product_id = transfer_row.product_id for update;
  if not found or available_qty < transfer_row.qty then raise exception 'Insufficient source branch stock for this transfer.'; end if;
  remaining_qty := transfer_row.qty;
  for batch_row in select * from public.inventory_cost_batches where branch_id = transfer_row.source_branch_id and product_id = transfer_row.product_id and qty_remaining > 0 order by is_opening desc, received_at, batch_id for update loop
    if batch_row.selling_price is null then raise exception 'A selling price is missing from a source stock batch.'; end if;
    allocated_qty := least(remaining_qty, batch_row.qty_remaining);
    update public.inventory_cost_batches set qty_remaining = qty_remaining - allocated_qty where batch_id = batch_row.batch_id;
    insert into public.transfer_batch_allocations (transfer_id, source_batch_id, qty, unit_cost, selling_price, received_at, is_opening)
    values (target_transfer_id, batch_row.batch_id, allocated_qty, batch_row.unit_cost, batch_row.selling_price, batch_row.received_at, batch_row.is_opening);
    remaining_qty := remaining_qty - allocated_qty; exit when remaining_qty <= 0;
  end loop;
  if remaining_qty > 0 then raise exception 'Selling-price batches are incomplete for this product. Reconcile stock before dispatching.'; end if;
  update public.inventory set qty = qty - transfer_row.qty where branch_id = transfer_row.source_branch_id and product_id = transfer_row.product_id;
  update public.stock_transfers set status = 'In Transit', dispatched_at = now() where transfer_id = target_transfer_id;
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Dispatched FIFO selling-price transfer', target_transfer_id, transfer_row.product_id);
  return jsonb_build_object('id', target_transfer_id, 'status', 'In Transit');
end;
$$;

create or replace function public.receive_transfer(target_transfer_id text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare transfer_row public.stock_transfers; product_row public.products; allocation_row public.transfer_batch_allocations; fallback_selling_price numeric;
begin
  select * into transfer_row from public.stock_transfers where transfer_id = target_transfer_id for update;
  if not found then raise exception 'Stock transfer not found.'; end if;
  if not public.has_permission('transfers') or not public.can_access_branch(transfer_row.destination_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if transfer_row.status <> 'In Transit' then raise exception 'Only in-transit transfers can be received.'; end if;
  select * into product_row from public.products where product_id = transfer_row.product_id;
  select coalesce(branch_product.price_override, product_row.price) into fallback_selling_price from public.branch_products branch_product where branch_product.branch_id = transfer_row.source_branch_id and branch_product.product_id = transfer_row.product_id;
  insert into public.branch_products (branch_id, product_id, price_override, low_stock_level, status) values (transfer_row.destination_branch_id, product_row.product_id, product_row.price, product_row.low_stock_level, 'Active') on conflict (branch_id, product_id) do update set status = 'Active';
  insert into public.inventory (branch_id, product_id, qty) values (transfer_row.destination_branch_id, transfer_row.product_id, transfer_row.qty) on conflict (branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
  if exists (select 1 from public.transfer_batch_allocations where transfer_id = target_transfer_id) then
    for allocation_row in select * from public.transfer_batch_allocations where transfer_id = target_transfer_id loop
      if allocation_row.selling_price is null then raise exception 'A selling price is missing from a transferred stock batch.'; end if;
      insert into public.inventory_cost_batches (branch_id, product_id, unit_cost, selling_price, qty_received, qty_remaining, received_at, is_opening, created_by)
      values (transfer_row.destination_branch_id, transfer_row.product_id, allocation_row.unit_cost, allocation_row.selling_price, allocation_row.qty, allocation_row.qty, allocation_row.received_at, allocation_row.is_opening, auth.uid());
    end loop;
  else
    insert into public.inventory_cost_batches (branch_id, product_id, selling_price, qty_received, qty_remaining, received_at, created_by)
    values (transfer_row.destination_branch_id, transfer_row.product_id, coalesce(fallback_selling_price, product_row.price), transfer_row.qty, transfer_row.qty, now(), auth.uid());
  end if;
  update public.stock_transfers set status = 'Received', received_at = now() where transfer_id = target_transfer_id;
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Received FIFO selling-price transfer', target_transfer_id, transfer_row.product_id);
  return jsonb_build_object('id', target_transfer_id, 'status', 'Received');
end;
$$;

revoke all on function public.dispatch_transfer(text) from public;
grant execute on function public.dispatch_transfer(text) to authenticated;
revoke all on function public.receive_transfer(text) from public;
grant execute on function public.receive_transfer(text) to authenticated;
