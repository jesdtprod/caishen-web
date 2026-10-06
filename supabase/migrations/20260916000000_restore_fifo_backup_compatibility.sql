-- Restore current FIFO selling-price data while remaining compatible with
-- backups created before selling-price allocations were introduced.
create or replace function public.restore_pos_backup_fifo(backup jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if backup is null or backup ->> 'schemaVersion' <> '1' or jsonb_typeof(backup -> 'tables') <> 'object' then
    raise exception 'This is not a valid FR Merchandise POS backup file.';
  end if;

  -- Dependent FIFO data must be removed before stock-ins and sale items.
  delete from public.sale_item_price_allocations;
  delete from public.transfer_batch_allocations;
  delete from public.sale_item_cost_allocations;
  delete from public.inventory_cost_batches;

  perform public.restore_pos_backup(backup);

  update public.products as product
  set archived_at = source.archived_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'products', '[]'::jsonb))
    as source(product_id text, archived_at timestamptz)
  where product.product_id = source.product_id;

  update public.stock_ins as stock_in
  set unit_cost = source.unit_cost,
      selling_price = source.selling_price,
      supplier_reference = coalesce(source.supplier_reference, '')
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'stockIns', '[]'::jsonb))
    as source(stock_in_id text, unit_cost numeric, selling_price numeric, supplier_reference text)
  where stock_in.stock_in_id = source.stock_in_id;

  update public.sale_items as sale_item
  set cost_total = source.cost_total
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'saleItems', '[]'::jsonb))
    as source(sale_item_id uuid, cost_total numeric)
  where sale_item.sale_item_id = source.sale_item_id;

  if jsonb_typeof(backup -> 'tables' -> 'inventoryCostBatches') = 'array' then
    insert into public.inventory_cost_batches (batch_id, branch_id, product_id, stock_in_id, unit_cost, selling_price, qty_received, qty_remaining, received_at, is_opening, created_by)
    select batch_id, branch_id, product_id, stock_in_id, unit_cost, selling_price, qty_received, qty_remaining, received_at, is_opening, created_by
    from jsonb_to_recordset(backup -> 'tables' -> 'inventoryCostBatches')
      as row(batch_id uuid, branch_id text, product_id text, stock_in_id text, unit_cost numeric, selling_price numeric, qty_received numeric, qty_remaining numeric, received_at timestamptz, is_opening boolean, created_by uuid);
  else
    insert into public.inventory_cost_batches (branch_id, product_id, selling_price, qty_received, qty_remaining, received_at, is_opening)
    select inventory.branch_id, inventory.product_id, coalesce(stock_in.selling_price, branch_product.price_override, product.price), inventory.qty, inventory.qty, inventory.updated_at, true
    from public.inventory as inventory
    join public.products as product on product.product_id = inventory.product_id
    left join public.branch_products as branch_product on branch_product.branch_id = inventory.branch_id and branch_product.product_id = inventory.product_id
    left join lateral (
      select receipt.selling_price
      from public.stock_ins as receipt
      where receipt.branch_id = inventory.branch_id and receipt.product_id = inventory.product_id
      order by receipt.occurred_at, receipt.stock_in_id
      limit 1
    ) as stock_in on true
    where inventory.qty > 0;
  end if;

  if jsonb_typeof(backup -> 'tables' -> 'saleItemCostAllocations') = 'array' then
    insert into public.sale_item_cost_allocations (allocation_id, sale_item_id, batch_id, qty, unit_cost, cost_total)
    select allocation_id, sale_item_id, batch_id, qty, unit_cost, cost_total
    from jsonb_to_recordset(backup -> 'tables' -> 'saleItemCostAllocations')
      as row(allocation_id uuid, sale_item_id uuid, batch_id uuid, qty numeric, unit_cost numeric, cost_total numeric);
  end if;

  if jsonb_typeof(backup -> 'tables' -> 'saleItemPriceAllocations') = 'array' then
    insert into public.sale_item_price_allocations (allocation_id, sale_item_id, batch_id, qty, selling_price, line_total)
    select allocation_id, sale_item_id, batch_id, qty, selling_price, line_total
    from jsonb_to_recordset(backup -> 'tables' -> 'saleItemPriceAllocations')
      as row(allocation_id uuid, sale_item_id uuid, batch_id uuid, qty numeric, selling_price numeric, line_total numeric);
  end if;

  if jsonb_typeof(backup -> 'tables' -> 'transferBatchAllocations') = 'array' then
    insert into public.transfer_batch_allocations (allocation_id, transfer_id, source_batch_id, qty, unit_cost, selling_price, received_at, is_opening)
    select allocation_id, transfer_id, source_batch_id, qty, unit_cost, selling_price, received_at, is_opening
    from jsonb_to_recordset(backup -> 'tables' -> 'transferBatchAllocations')
      as row(allocation_id uuid, transfer_id text, source_batch_id uuid, qty numeric, unit_cost numeric, selling_price numeric, received_at timestamptz, is_opening boolean);
  end if;

  return jsonb_build_object('restoredAt', now());
end;
$$;

revoke all on function public.restore_pos_backup_fifo(jsonb) from public;
grant execute on function public.restore_pos_backup_fifo(jsonb) to authenticated;
