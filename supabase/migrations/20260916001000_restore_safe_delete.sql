-- Supabase safe-update protection requires an explicit predicate for the
-- controlled table clears performed by a full operational restore.
create or replace function public.restore_pos_backup(backup jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if backup is null or backup ->> 'schemaVersion' <> '1' or jsonb_typeof(backup -> 'tables') <> 'object' then
    raise exception 'This is not a valid FR Merchandise POS backup file.';
  end if;

  delete from public.credit_payments where true;
  delete from public.sale_items where true;
  delete from public.sales where true;
  delete from public.stock_transfers where true;
  delete from public.stock_ins where true;
  delete from public.inventory where true;
  delete from public.customers where true;
  delete from public.branch_products where true;
  delete from public.products where true;

  insert into public.branches (branch_id, name, type, address, status, created_at)
  select branch_id, name, type, address, status, created_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'branches', '[]'::jsonb))
    as row(branch_id text, name text, type text, address text, status text, created_at timestamptz)
  on conflict (branch_id) do update
  set name = excluded.name, type = excluded.type, address = excluded.address, status = excluded.status;

  insert into public.products (product_id, name, unit, price, category, sku, low_stock_level, status, created_at, updated_at)
  select product_id, name, unit, price, category, sku, low_stock_level, status, created_at, updated_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'products', '[]'::jsonb))
    as row(product_id text, name text, unit text, price numeric, category text, sku text, low_stock_level numeric, status text, created_at timestamptz, updated_at timestamptz);

  insert into public.branch_products (branch_id, product_id, price_override, low_stock_level, status, created_at, updated_at)
  select branch_id, product_id, price_override, low_stock_level, status, created_at, updated_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'branchProducts', '[]'::jsonb))
    as row(branch_id text, product_id text, price_override numeric, low_stock_level numeric, status text, created_at timestamptz, updated_at timestamptz);

  insert into public.customers (customer_id, branch_id, name, phone, address, status, created_at, updated_at)
  select customer_id, branch_id, name, phone, address, status, created_at, updated_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'customers', '[]'::jsonb))
    as row(customer_id text, branch_id text, name text, phone text, address text, status text, created_at timestamptz, updated_at timestamptz);

  insert into public.inventory (branch_id, product_id, qty, updated_at)
  select branch_id, product_id, qty, updated_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'inventory', '[]'::jsonb))
    as row(branch_id text, product_id text, qty numeric, updated_at timestamptz);

  insert into public.stock_ins (stock_in_id, branch_id, product_id, qty, occurred_at, status, created_by)
  select stock_in_id, branch_id, product_id, qty, occurred_at, status, created_by
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'stockIns', '[]'::jsonb))
    as row(stock_in_id text, branch_id text, product_id text, qty numeric, occurred_at timestamptz, status text, created_by uuid);

  insert into public.stock_transfers (transfer_id, source_branch_id, destination_branch_id, product_id, qty, status, created_at, dispatched_at, received_at, cancelled_at, notes, created_by)
  select transfer_id, source_branch_id, destination_branch_id, product_id, qty, status, created_at, dispatched_at, received_at, cancelled_at, notes, created_by
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'stockTransfers', '[]'::jsonb))
    as row(transfer_id text, source_branch_id text, destination_branch_id text, product_id text, qty numeric, status text, created_at timestamptz, dispatched_at timestamptz, received_at timestamptz, cancelled_at timestamptz, notes text, created_by uuid);

  insert into public.sales (sale_id, branch_id, occurred_at, customer_id, total, payment_type, status, discount, cash_tendered, change, created_by)
  select sale_id, branch_id, occurred_at, customer_id, total, payment_type, status, discount, cash_tendered, change, created_by
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'sales', '[]'::jsonb))
    as row(sale_id text, branch_id text, occurred_at timestamptz, customer_id text, total numeric, payment_type text, status text, discount numeric, cash_tendered numeric, change numeric, created_by uuid);

  insert into public.sale_items (sale_item_id, sale_id, product_id, qty, price)
  select sale_item_id, sale_id, product_id, qty, price
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'saleItems', '[]'::jsonb))
    as row(sale_item_id uuid, sale_id text, product_id text, qty numeric, price numeric);

  insert into public.credit_payments (payment_id, branch_id, sale_id, customer_id, amount, occurred_at, notes, created_by)
  select payment_id, branch_id, sale_id, customer_id, amount, occurred_at, notes, created_by
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'creditPayments', '[]'::jsonb))
    as row(payment_id text, branch_id text, sale_id text, customer_id text, amount numeric, occurred_at timestamptz, notes text, created_by uuid);

  return jsonb_build_object('restoredAt', now());
end;
$$;

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

  delete from public.sale_item_price_allocations where true;
  delete from public.transfer_batch_allocations where true;
  delete from public.sale_item_cost_allocations where true;
  delete from public.inventory_cost_batches where true;

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
