-- Preserve the exact cost of every received batch. Sales consume the oldest
-- available batch first; transfers carry their allocated batches to the
-- destination branch. Existing stock is retained as an opening balance with
-- an unknown historical cost rather than an invented cost.

alter table public.stock_ins
  add column if not exists unit_cost numeric(12, 2),
  add column if not exists supplier_reference text not null default '';

alter table public.stock_ins
  drop constraint if exists stock_ins_unit_cost_nonnegative;
alter table public.stock_ins
  add constraint stock_ins_unit_cost_nonnegative check (unit_cost is null or unit_cost >= 0);

alter table public.sale_items
  add column if not exists cost_total numeric(12, 2);

create table if not exists public.inventory_cost_batches (
  batch_id uuid primary key default gen_random_uuid(),
  branch_id text not null references public.branches(branch_id) on delete cascade,
  product_id text not null references public.products(product_id) on delete cascade,
  stock_in_id text references public.stock_ins(stock_in_id) on delete set null,
  unit_cost numeric(12, 2) check (unit_cost is null or unit_cost >= 0),
  qty_received numeric(12, 3) not null check (qty_received > 0),
  qty_remaining numeric(12, 3) not null check (qty_remaining >= 0 and qty_remaining <= qty_received),
  received_at timestamptz not null default now(),
  is_opening boolean not null default false,
  created_by uuid references public.profiles(user_id) on delete set null
);

create index if not exists inventory_cost_batches_fifo_idx
  on public.inventory_cost_batches (branch_id, product_id, is_opening desc, received_at, batch_id)
  where qty_remaining > 0;

create table if not exists public.sale_item_cost_allocations (
  allocation_id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references public.sale_items(sale_item_id) on delete cascade,
  batch_id uuid references public.inventory_cost_batches(batch_id) on delete restrict,
  qty numeric(12, 3) not null check (qty > 0),
  unit_cost numeric(12, 2),
  cost_total numeric(12, 2)
);

create index if not exists sale_item_cost_allocations_sale_item_idx
  on public.sale_item_cost_allocations (sale_item_id);

create table if not exists public.transfer_batch_allocations (
  allocation_id uuid primary key default gen_random_uuid(),
  transfer_id text not null references public.stock_transfers(transfer_id) on delete cascade,
  source_batch_id uuid references public.inventory_cost_batches(batch_id) on delete restrict,
  qty numeric(12, 3) not null check (qty > 0),
  unit_cost numeric(12, 2),
  received_at timestamptz not null,
  is_opening boolean not null default false
);

create index if not exists transfer_batch_allocations_transfer_idx
  on public.transfer_batch_allocations (transfer_id);

alter table public.inventory_cost_batches enable row level security;
alter table public.sale_item_cost_allocations enable row level security;
alter table public.transfer_batch_allocations enable row level security;

-- The pre-FIFO quantity is real stock, but its original purchase cost is not
-- available. Mark it explicitly so future reporting never guesses a cost.
insert into public.inventory_cost_batches (
  branch_id, product_id, unit_cost, qty_received, qty_remaining, received_at, is_opening
)
select branch_id, product_id, null, qty, qty, updated_at, true
from public.inventory
where qty > 0;

drop function if exists public.stock_in(text, text, numeric);
create or replace function public.stock_in(
  target_branch_id text,
  target_product_id text,
  quantity numeric,
  unit_cost_input numeric,
  supplier_reference_input text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  stock_in_id_value text := public.new_pos_id('STK');
begin
  if not public.has_permission('inventory') or not public.can_access_branch(target_branch_id) then
    raise exception 'Your account does not have access to this action.';
  end if;
  perform public.assert_active_branch(target_branch_id);
  if quantity is null or quantity <= 0 then
    raise exception 'Quantity must be greater than zero.';
  end if;
  if unit_cost_input is null or unit_cost_input < 0 then
    raise exception 'Enter a valid unit cost.';
  end if;
  if not exists (
    select 1 from public.branch_products
    where branch_id = target_branch_id and product_id = target_product_id and status = 'Active'
  ) then
    raise exception 'Register an active product in the selected branch before stocking it.';
  end if;

  insert into public.inventory (branch_id, product_id, qty)
  values (target_branch_id, target_product_id, quantity)
  on conflict (branch_id, product_id)
  do update set qty = public.inventory.qty + excluded.qty;

  insert into public.stock_ins (stock_in_id, branch_id, product_id, qty, unit_cost, supplier_reference, created_by)
  values (stock_in_id_value, target_branch_id, target_product_id, quantity, unit_cost_input, coalesce(trim(supplier_reference_input), ''), auth.uid());
  insert into public.inventory_cost_batches (branch_id, product_id, stock_in_id, unit_cost, qty_received, qty_remaining, created_by)
  values (target_branch_id, target_product_id, stock_in_id_value, unit_cost_input, quantity, quantity, auth.uid());
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Recorded stock in', stock_in_id_value, target_product_id || ': ' || quantity::text || ' at ' || unit_cost_input::text);

  return jsonb_build_object('stockInId', stock_in_id_value, 'productId', target_product_id, 'qty', quantity, 'unitCost', unit_cost_input);
end;
$$;

create or replace function public.record_sale(
  target_branch_id text,
  sale_lines jsonb,
  payment_type_input text,
  customer_id_input text default null,
  discount_input numeric default 0,
  cash_tendered_input numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sale_id_value text := public.new_pos_id('SAL');
  sale_item_id_value uuid;
  line jsonb;
  batch_row public.inventory_cost_batches;
  product_id_value text;
  requested_qty numeric;
  requested_price numeric;
  available_qty numeric;
  effective_price numeric;
  remaining_qty numeric;
  allocated_qty numeric;
  item_cost_total numeric(12, 2);
  item_cost_known boolean;
  confirmed_lines jsonb := '[]'::jsonb;
  subtotal_value numeric(12, 2) := 0;
  total_value numeric(12, 2);
  change_value numeric(12, 2) := 0;
  normalized_payment_type text := lower(trim(payment_type_input));
begin
  if not public.has_permission('pos') or not public.can_access_branch(target_branch_id) then
    raise exception 'Your account does not have access to this action.';
  end if;
  perform public.assert_active_branch(target_branch_id);
  if jsonb_typeof(sale_lines) <> 'array' or jsonb_array_length(sale_lines) = 0 then
    raise exception 'The sale has no items.';
  end if;
  if normalized_payment_type not in ('cash', 'credit') then
    raise exception 'Choose Cash or Credit payment.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(sale_lines) as item(value)
    group by trim(item.value ->> 'productId')
    having count(*) > 1
  ) then
    raise exception 'Each product can appear only once in a sale.';
  end if;
  if customer_id_input is not null and not exists (
    select 1 from public.customers
    where customer_id = customer_id_input and branch_id = target_branch_id and status = 'Active'
  ) then
    raise exception 'Choose an active customer from the selected branch.';
  end if;
  if normalized_payment_type = 'credit' and customer_id_input is null then
    raise exception 'Select a customer for a credit sale.';
  end if;
  if discount_input is null or discount_input < 0 then
    raise exception 'Enter a valid discount.';
  end if;

  for line in select value from jsonb_array_elements(sale_lines) as item(value) order by trim(value ->> 'productId') loop
    product_id_value := trim(line ->> 'productId');
    requested_qty := nullif(trim(line ->> 'qty'), '')::numeric;
    requested_price := case when line ? 'price' then nullif(trim(line ->> 'price'), '')::numeric else null end;
    select inventory.qty, coalesce(branch_products.price_override, products.price)
    into available_qty, effective_price
    from public.inventory
    join public.branch_products on branch_products.branch_id = inventory.branch_id and branch_products.product_id = inventory.product_id
    join public.products on products.product_id = inventory.product_id
    where inventory.branch_id = target_branch_id and inventory.product_id = product_id_value
      and branch_products.status = 'Active' and products.status = 'Active'
    for update of inventory;
    if not found or requested_qty is null or requested_qty <= 0 or available_qty < requested_qty then
      raise exception 'Insufficient stock for one or more items.';
    end if;
    if requested_price is not null then
      if requested_price < 0 then raise exception 'Enter a valid selling price for every item.'; end if;
      effective_price := requested_price;
    end if;
    subtotal_value := subtotal_value + (requested_qty * effective_price);
    confirmed_lines := confirmed_lines || jsonb_build_array(jsonb_build_object('productId', product_id_value, 'qty', requested_qty, 'price', effective_price));
    update public.inventory set qty = qty - requested_qty where branch_id = target_branch_id and product_id = product_id_value;
  end loop;

  if discount_input > subtotal_value then raise exception 'Enter a valid discount.'; end if;
  total_value := subtotal_value - discount_input;
  if normalized_payment_type = 'cash' then
    if cash_tendered_input is null or cash_tendered_input < total_value then raise exception 'Cash tendered must cover the sale total.'; end if;
    change_value := cash_tendered_input - total_value;
  else
    cash_tendered_input := 0;
  end if;

  insert into public.sales (sale_id, branch_id, customer_id, total, payment_type, discount, cash_tendered, change, created_by)
  values (sale_id_value, target_branch_id, customer_id_input, total_value, normalized_payment_type, discount_input, cash_tendered_input, change_value, auth.uid());

  for line in select value from jsonb_array_elements(confirmed_lines) as item(value) loop
    product_id_value := trim(line ->> 'productId');
    requested_qty := nullif(trim(line ->> 'qty'), '')::numeric;
    requested_price := nullif(trim(line ->> 'price'), '')::numeric;
    insert into public.sale_items (sale_id, product_id, qty, price) values (sale_id_value, product_id_value, requested_qty, requested_price)
    returning sale_item_id into sale_item_id_value;
    remaining_qty := requested_qty;
    item_cost_total := 0;
    item_cost_known := true;
    for batch_row in
      select * from public.inventory_cost_batches
      where branch_id = target_branch_id and product_id = product_id_value and qty_remaining > 0
      order by is_opening desc, received_at, batch_id
      for update
    loop
      allocated_qty := least(remaining_qty, batch_row.qty_remaining);
      update public.inventory_cost_batches set qty_remaining = qty_remaining - allocated_qty where batch_id = batch_row.batch_id;
      insert into public.sale_item_cost_allocations (sale_item_id, batch_id, qty, unit_cost, cost_total)
      values (sale_item_id_value, batch_row.batch_id, allocated_qty, batch_row.unit_cost,
        case when batch_row.unit_cost is null then null else allocated_qty * batch_row.unit_cost end);
      if batch_row.unit_cost is null then item_cost_known := false; else item_cost_total := item_cost_total + (allocated_qty * batch_row.unit_cost); end if;
      remaining_qty := remaining_qty - allocated_qty;
      exit when remaining_qty <= 0;
    end loop;
    if remaining_qty > 0 then raise exception 'Inventory cost batches are incomplete for this product. Reconcile stock before recording a sale.'; end if;
    update public.sale_items set cost_total = case when item_cost_known then item_cost_total else null end where sale_item_id = sale_item_id_value;
  end loop;

  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Recorded sale', sale_id_value, total_value::text);
  return jsonb_build_object('saleId', sale_id_value, 'subtotal', subtotal_value, 'total', total_value, 'discount', discount_input,
    'cashTendered', cash_tendered_input, 'change', change_value, 'paymentType', normalized_payment_type, 'date', now());
end;
$$;

create or replace function public.dispatch_transfer(target_transfer_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  transfer_row public.stock_transfers;
  batch_row public.inventory_cost_batches;
  available_qty numeric;
  remaining_qty numeric;
  allocated_qty numeric;
begin
  select * into transfer_row from public.stock_transfers where transfer_id = target_transfer_id for update;
  if not found then raise exception 'Stock transfer not found.'; end if;
  if not public.has_permission('transfers') or not public.can_access_branch(transfer_row.source_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if transfer_row.status <> 'Draft' then raise exception 'Only draft transfers can be dispatched.'; end if;
  select qty into available_qty from public.inventory where branch_id = transfer_row.source_branch_id and product_id = transfer_row.product_id for update;
  if not found or available_qty < transfer_row.qty then raise exception 'Insufficient source branch stock for this transfer.'; end if;
  remaining_qty := transfer_row.qty;
  for batch_row in
    select * from public.inventory_cost_batches
    where branch_id = transfer_row.source_branch_id and product_id = transfer_row.product_id and qty_remaining > 0
    order by is_opening desc, received_at, batch_id
    for update
  loop
    allocated_qty := least(remaining_qty, batch_row.qty_remaining);
    update public.inventory_cost_batches set qty_remaining = qty_remaining - allocated_qty where batch_id = batch_row.batch_id;
    insert into public.transfer_batch_allocations (transfer_id, source_batch_id, qty, unit_cost, received_at, is_opening)
    values (target_transfer_id, batch_row.batch_id, allocated_qty, batch_row.unit_cost, batch_row.received_at, batch_row.is_opening);
    remaining_qty := remaining_qty - allocated_qty;
    exit when remaining_qty <= 0;
  end loop;
  if remaining_qty > 0 then raise exception 'Inventory cost batches are incomplete for this product. Reconcile stock before dispatching.'; end if;
  update public.inventory set qty = qty - transfer_row.qty where branch_id = transfer_row.source_branch_id and product_id = transfer_row.product_id;
  update public.stock_transfers set status = 'In Transit', dispatched_at = now() where transfer_id = target_transfer_id;
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Dispatched stock transfer', target_transfer_id, transfer_row.product_id);
  return jsonb_build_object('id', target_transfer_id, 'status', 'In Transit');
end;
$$;

create or replace function public.receive_transfer(target_transfer_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  transfer_row public.stock_transfers;
  product_row public.products;
  allocation_row public.transfer_batch_allocations;
begin
  select * into transfer_row from public.stock_transfers where transfer_id = target_transfer_id for update;
  if not found then raise exception 'Stock transfer not found.'; end if;
  if not public.has_permission('transfers') or not public.can_access_branch(transfer_row.destination_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if transfer_row.status <> 'In Transit' then raise exception 'Only in-transit transfers can be received.'; end if;
  select * into product_row from public.products where product_id = transfer_row.product_id;
  insert into public.branch_products (branch_id, product_id, price_override, low_stock_level, status)
  values (transfer_row.destination_branch_id, product_row.product_id, product_row.price, product_row.low_stock_level, 'Active')
  on conflict (branch_id, product_id) do update set status = 'Active';
  insert into public.inventory (branch_id, product_id, qty)
  values (transfer_row.destination_branch_id, transfer_row.product_id, transfer_row.qty)
  on conflict (branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
  if exists (select 1 from public.transfer_batch_allocations where transfer_id = target_transfer_id) then
    for allocation_row in select * from public.transfer_batch_allocations where transfer_id = target_transfer_id loop
      insert into public.inventory_cost_batches (branch_id, product_id, unit_cost, qty_received, qty_remaining, received_at, is_opening, created_by)
      values (transfer_row.destination_branch_id, transfer_row.product_id, allocation_row.unit_cost, allocation_row.qty, allocation_row.qty,
        allocation_row.received_at, allocation_row.is_opening, auth.uid());
    end loop;
  else
    insert into public.inventory_cost_batches (branch_id, product_id, unit_cost, qty_received, qty_remaining, received_at, created_by)
    values (transfer_row.destination_branch_id, transfer_row.product_id, null, transfer_row.qty, transfer_row.qty, now(), auth.uid());
  end if;
  update public.stock_transfers set status = 'Received', received_at = now() where transfer_id = target_transfer_id;
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Received stock transfer', target_transfer_id, transfer_row.product_id);
  return jsonb_build_object('id', target_transfer_id, 'status', 'Received');
end;
$$;

create or replace function public.cancel_transfer(target_transfer_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  transfer_row public.stock_transfers;
  allocation_row public.transfer_batch_allocations;
begin
  select * into transfer_row from public.stock_transfers where transfer_id = target_transfer_id for update;
  if not found then raise exception 'Stock transfer not found.'; end if;
  if not public.has_permission('transfers') or not public.can_access_branch(transfer_row.source_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if transfer_row.status not in ('Draft', 'In Transit') then raise exception 'Only draft or in-transit transfers can be cancelled.'; end if;
  if transfer_row.status = 'In Transit' then
    insert into public.inventory (branch_id, product_id, qty) values (transfer_row.source_branch_id, transfer_row.product_id, transfer_row.qty)
    on conflict (branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
    if exists (select 1 from public.transfer_batch_allocations where transfer_id = target_transfer_id) then
      for allocation_row in select * from public.transfer_batch_allocations where transfer_id = target_transfer_id loop
        update public.inventory_cost_batches set qty_remaining = qty_remaining + allocation_row.qty where batch_id = allocation_row.source_batch_id;
      end loop;
    else
      insert into public.inventory_cost_batches (branch_id, product_id, unit_cost, qty_received, qty_remaining, received_at, created_by)
      values (transfer_row.source_branch_id, transfer_row.product_id, null, transfer_row.qty, transfer_row.qty, now(), auth.uid());
    end if;
  end if;
  update public.stock_transfers set status = 'Cancelled', cancelled_at = now() where transfer_id = target_transfer_id;
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Cancelled stock transfer', target_transfer_id, transfer_row.product_id);
  return jsonb_build_object('id', target_transfer_id, 'status', 'Cancelled');
end;
$$;

create or replace function public.restore_pos_backup_fifo(backup jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.restore_pos_backup(backup);

  update public.stock_ins as stock_in
  set unit_cost = source.unit_cost, supplier_reference = coalesce(source.supplier_reference, '')
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'stockIns', '[]'::jsonb))
    as source(stock_in_id text, unit_cost numeric, supplier_reference text)
  where stock_in.stock_in_id = source.stock_in_id;

  update public.sale_items as sale_item
  set cost_total = source.cost_total
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'saleItems', '[]'::jsonb))
    as source(sale_item_id uuid, cost_total numeric)
  where sale_item.sale_item_id = source.sale_item_id;

  delete from public.transfer_batch_allocations;
  delete from public.sale_item_cost_allocations;
  delete from public.inventory_cost_batches;

  if jsonb_typeof(backup -> 'tables' -> 'inventoryCostBatches') = 'array' then
    insert into public.inventory_cost_batches (batch_id, branch_id, product_id, stock_in_id, unit_cost, qty_received, qty_remaining, received_at, is_opening, created_by)
    select batch_id, branch_id, product_id, stock_in_id, unit_cost, qty_received, qty_remaining, received_at, is_opening, created_by
    from jsonb_to_recordset(backup -> 'tables' -> 'inventoryCostBatches')
      as row(batch_id uuid, branch_id text, product_id text, stock_in_id text, unit_cost numeric, qty_received numeric, qty_remaining numeric, received_at timestamptz, is_opening boolean, created_by uuid);
  else
    insert into public.inventory_cost_batches (branch_id, product_id, unit_cost, qty_received, qty_remaining, received_at, is_opening)
    select branch_id, product_id, null, qty, qty, updated_at, true from public.inventory where qty > 0;
  end if;

  if jsonb_typeof(backup -> 'tables' -> 'saleItemCostAllocations') = 'array' then
    insert into public.sale_item_cost_allocations (allocation_id, sale_item_id, batch_id, qty, unit_cost, cost_total)
    select allocation_id, sale_item_id, batch_id, qty, unit_cost, cost_total
    from jsonb_to_recordset(backup -> 'tables' -> 'saleItemCostAllocations')
      as row(allocation_id uuid, sale_item_id uuid, batch_id uuid, qty numeric, unit_cost numeric, cost_total numeric);
  end if;
  if jsonb_typeof(backup -> 'tables' -> 'transferBatchAllocations') = 'array' then
    insert into public.transfer_batch_allocations (allocation_id, transfer_id, source_batch_id, qty, unit_cost, received_at, is_opening)
    select allocation_id, transfer_id, source_batch_id, qty, unit_cost, received_at, is_opening
    from jsonb_to_recordset(backup -> 'tables' -> 'transferBatchAllocations')
      as row(allocation_id uuid, transfer_id text, source_batch_id uuid, qty numeric, unit_cost numeric, received_at timestamptz, is_opening boolean);
  end if;
  return jsonb_build_object('restoredAt', now());
end;
$$;

revoke all on function public.stock_in(text, text, numeric, numeric, text) from public;
grant execute on function public.stock_in(text, text, numeric, numeric, text) to authenticated;
revoke all on function public.restore_pos_backup_fifo(jsonb) from public;
