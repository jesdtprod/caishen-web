-- Bundles are virtual sellable products; only their component items carry stock.
alter table public.products add column if not exists product_type text not null default 'individual'
  check (product_type in ('individual', 'bundle'));
alter table public.products add column if not exists bundle_price numeric(12, 2)
  check (bundle_price is null or bundle_price >= 0);

create table if not exists public.product_bundle_components (
  bundle_product_id text not null references public.products(product_id) on delete cascade,
  component_product_id text not null references public.products(product_id) on delete restrict,
  qty numeric(12,3) not null check (qty > 0),
  primary key (bundle_product_id, component_product_id),
  check (bundle_product_id <> component_product_id)
);

create table if not exists public.sale_bundle_component_allocations (
  allocation_id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references public.sale_items(sale_item_id) on delete cascade,
  component_product_id text not null references public.products(product_id) on delete restrict,
  batch_id uuid not null references public.inventory_cost_batches(batch_id) on delete restrict,
  qty numeric(12,3) not null check (qty > 0),
  unit_cost numeric(12,2),
  cost_total numeric(14,2),
  created_at timestamptz not null default now()
);

create table if not exists public.sale_returns (
  return_id text primary key,
  original_sale_id text not null references public.sales(sale_id) on delete restrict,
  branch_id text not null references public.branches(branch_id),
  customer_id text references public.customers(customer_id),
  return_type text not null check (return_type in ('return', 'refund', 'replacement')),
  status text not null default 'Received for Inspection'
    check (status in ('Received for Inspection', 'Restocked', 'Refunded', 'Replaced', 'Supplier Return', 'Disposed')),
  reason text not null default '',
  refund_amount numeric(12,2) not null default 0 check (refund_amount >= 0),
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.sale_return_items (
  return_item_id uuid primary key default gen_random_uuid(),
  return_id text not null references public.sale_returns(return_id) on delete cascade,
  original_sale_item_id uuid not null references public.sale_items(sale_item_id) on delete restrict,
  product_id text not null references public.products(product_id),
  qty numeric(12,3) not null check (qty > 0),
  condition_state text not null default 'quarantine'
    check (condition_state in ('quarantine', 'restocked', 'supplier_return', 'disposed')),
  replacement_product_id text references public.products(product_id),
  replacement_qty numeric(12,3) not null default 0 check (replacement_qty >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_return_lots (
  return_lot_id uuid primary key default gen_random_uuid(),
  return_item_id uuid not null unique references public.sale_return_items(return_item_id) on delete cascade,
  branch_id text not null references public.branches(branch_id),
  product_id text not null references public.products(product_id),
  qty numeric(12,3) not null check (qty > 0),
  state text not null default 'quarantine'
    check (state in ('quarantine', 'restocked', 'supplier_return', 'disposed')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists sale_returns_branch_created_idx on public.sale_returns(branch_id, created_at desc);
create index if not exists inventory_return_lots_branch_state_idx on public.inventory_return_lots(branch_id, state, product_id);

alter table public.product_bundle_components enable row level security;
alter table public.sale_bundle_component_allocations enable row level security;
alter table public.sale_returns enable row level security;
alter table public.sale_return_items enable row level security;
alter table public.inventory_return_lots enable row level security;

drop policy if exists "read permitted bundle components" on public.product_bundle_components;
create policy "read permitted bundle components" on public.product_bundle_components for select to authenticated
using (exists (select 1 from public.products bundle where bundle.product_id = bundle_product_id and bundle.archived_at is null));
drop policy if exists "read permitted sale returns" on public.sale_returns;
create policy "read permitted sale returns" on public.sale_returns for select to authenticated
using (public.can_access_branch(branch_id));
drop policy if exists "read permitted sale return items" on public.sale_return_items;
create policy "read permitted sale return items" on public.sale_return_items for select to authenticated
using (exists (select 1 from public.sale_returns r where r.return_id = sale_return_items.return_id and public.can_access_branch(r.branch_id)));
drop policy if exists "read permitted return lots" on public.inventory_return_lots;
create policy "read permitted return lots" on public.inventory_return_lots for select to authenticated
using (public.can_access_branch(branch_id));
drop policy if exists "read permitted bundle allocations" on public.sale_bundle_component_allocations;
create policy "read permitted bundle allocations" on public.sale_bundle_component_allocations for select to authenticated
using (exists (select 1 from public.sale_items si join public.sales s on s.sale_id = si.sale_id where si.sale_item_id = sale_bundle_component_allocations.sale_item_id and public.can_access_branch(s.branch_id)));

create or replace function public.get_branch_bundle_availability(target_branch_id text)
returns table(product_id text, qty_available numeric)
language sql security definer set search_path = public
as $$
  select component.bundle_product_id,
    min(floor(coalesce(inventory.qty, 0) / component.qty))::numeric as qty_available
  from public.product_bundle_components component
  join public.products bundle on bundle.product_id = component.bundle_product_id and bundle.product_type = 'bundle'
  left join public.inventory inventory on inventory.branch_id = target_branch_id and inventory.product_id = component.component_product_id
  where public.can_access_branch(target_branch_id)
  group by component.bundle_product_id;
$$;

create or replace function public.save_bundle_components(target_bundle_product_id text, components jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare component jsonb; component_id text; component_qty numeric;
begin
  if not public.has_permission('products') then raise exception 'Your account does not have access to this action.'; end if;
  if not exists (select 1 from public.products where product_id = target_bundle_product_id and product_type = 'bundle' and archived_at is null) then raise exception 'Bundle product not found.'; end if;
  if jsonb_typeof(components) <> 'array' or jsonb_array_length(components) = 0 then raise exception 'A bundle needs at least one component.'; end if;
  delete from public.product_bundle_components where bundle_product_id = target_bundle_product_id;
  for component in select value from jsonb_array_elements(components) loop
    component_id := trim(component ->> 'productId'); component_qty := nullif(component ->> 'qty', '')::numeric;
    if component_id = target_bundle_product_id or component_qty is null or component_qty <= 0 then raise exception 'Enter valid bundle components.'; end if;
    if not exists (select 1 from public.products where product_id = component_id and product_type = 'individual' and archived_at is null) then raise exception 'Bundle components must be active individual products.'; end if;
    insert into public.product_bundle_components (bundle_product_id, component_product_id, qty)
    values (target_bundle_product_id, component_id, component_qty)
    on conflict (bundle_product_id, component_product_id) do update set qty = excluded.qty;
  end loop;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Saved bundle components', target_bundle_product_id, components::text);
  return jsonb_build_object('productId', target_bundle_product_id);
end;
$$;

-- Return intake always quarantines the physical item. Restock is a separate inspected action.
create or replace function public.receive_sale_return(
  original_sale_id_input text, return_type_input text, return_lines jsonb,
  reason_input text default '', refund_amount_input numeric default 0
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare sale_row public.sales; line jsonb; sale_item_row public.sale_items; return_id_value text := public.new_pos_id('RET'); qty_value numeric; returned_qty numeric; return_item_id_value uuid;
begin
  select * into sale_row from public.sales where sale_id = original_sale_id_input for update;
  if not found then raise exception 'Original sale not found.'; end if;
  if not public.has_permission('pos') or not public.can_access_branch(sale_row.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if return_type_input not in ('return', 'refund', 'replacement') then raise exception 'Choose a valid return resolution.'; end if;
  if jsonb_typeof(return_lines) <> 'array' or jsonb_array_length(return_lines) = 0 then raise exception 'Choose returned item quantities.'; end if;
  insert into public.sale_returns(return_id, original_sale_id, branch_id, customer_id, return_type, reason, refund_amount, created_by)
  values(return_id_value, sale_row.sale_id, sale_row.branch_id, sale_row.customer_id, return_type_input, coalesce(trim(reason_input), ''), coalesce(refund_amount_input, 0), auth.uid());
  for line in select value from jsonb_array_elements(return_lines) loop
    qty_value := nullif(line ->> 'qty', '')::numeric;
    select * into sale_item_row from public.sale_items where sale_item_id = (line ->> 'saleItemId')::uuid and sale_id = sale_row.sale_id for update;
    if not found or qty_value is null or qty_value <= 0 then raise exception 'Enter valid returned quantities.'; end if;
    select coalesce(sum(qty), 0) into returned_qty from public.sale_return_items where original_sale_item_id = sale_item_row.sale_item_id;
    if returned_qty + qty_value > sale_item_row.qty then raise exception 'Returned quantity exceeds the original sale.'; end if;
    insert into public.sale_return_items(return_id, original_sale_item_id, product_id, qty, replacement_product_id, replacement_qty)
    values(return_id_value, sale_item_row.sale_item_id, sale_item_row.product_id, qty_value, nullif(line ->> 'replacementProductId',''), coalesce(nullif(line ->> 'replacementQty','')::numeric, 0))
    returning return_item_id into return_item_id_value;
    insert into public.inventory_return_lots(return_item_id, branch_id, product_id, qty)
    values(return_item_id_value, sale_row.branch_id, sale_item_row.product_id, qty_value);
  end loop;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Received sale return into quarantine', return_id_value, sale_row.sale_id);
  return jsonb_build_object('returnId', return_id_value, 'status', 'Received for Inspection');
end;
$$;

create or replace function public.resolve_return_item(target_return_item_id uuid, resolution text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare item public.sale_return_items; case_row public.sale_returns; lot public.inventory_return_lots; price_value numeric;
begin
  select * into item from public.sale_return_items where return_item_id = target_return_item_id for update;
  if not found then raise exception 'Return item not found.'; end if;
  select * into case_row from public.sale_returns where return_id = item.return_id for update;
  select * into lot from public.inventory_return_lots where return_item_id = item.return_item_id for update;
  if not public.has_permission('inventory') or not public.can_access_branch(case_row.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if lot.state <> 'quarantine' then raise exception 'This return item has already been resolved.'; end if;
  if resolution not in ('restocked', 'supplier_return', 'disposed') then raise exception 'Choose a valid return resolution.'; end if;
  if resolution = 'restocked' then
    select coalesce(bp.price_override, p.price) into price_value from public.products p left join public.branch_products bp on bp.product_id = p.product_id and bp.branch_id = case_row.branch_id where p.product_id = item.product_id;
    insert into public.inventory(branch_id, product_id, qty) values(case_row.branch_id, item.product_id, item.qty)
      on conflict(branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
    insert into public.inventory_cost_batches(branch_id, product_id, selling_price, qty_received, qty_remaining, received_at, created_by)
      values(case_row.branch_id, item.product_id, price_value, item.qty, item.qty, now(), auth.uid());
  end if;
  update public.inventory_return_lots set state = resolution, resolved_at = now() where return_lot_id = lot.return_lot_id;
  update public.sale_return_items set condition_state = resolution where return_item_id = item.return_item_id;
  update public.sale_returns set status = case when resolution = 'restocked' then 'Restocked' when resolution = 'supplier_return' then 'Supplier Return' else 'Disposed' end, resolved_at = now() where return_id = case_row.return_id;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Resolved returned inventory', case_row.return_id, resolution || ': ' || item.product_id);
  return jsonb_build_object('returnId', case_row.return_id, 'resolution', resolution);
end;
$$;

create or replace function public.restore_pos_backup_bundles(backup jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Administrator access is required.'; end if;
  delete from public.inventory_return_lots;
  delete from public.sale_return_items;
  delete from public.sale_returns;
  delete from public.sale_bundle_component_allocations;
  delete from public.product_bundle_components;
  perform public.restore_pos_backup_fifo(backup);
  if jsonb_typeof(backup -> 'tables' -> 'products') = 'array' then
    update public.products product set product_type = source.product_type, bundle_price = source.bundle_price
    from jsonb_to_recordset(backup -> 'tables' -> 'products') as source(product_id text, product_type text, bundle_price numeric)
    where product.product_id = source.product_id and source.product_type in ('individual', 'bundle');
  end if;
  if jsonb_typeof(backup -> 'tables' -> 'bundleComponents') = 'array' then
    insert into public.product_bundle_components(bundle_product_id, component_product_id, qty)
    select bundle_product_id, component_product_id, qty from jsonb_to_recordset(backup -> 'tables' -> 'bundleComponents')
      as row(bundle_product_id text, component_product_id text, qty numeric);
  end if;
  if jsonb_typeof(backup -> 'tables' -> 'saleBundleComponentAllocations') = 'array' then
    insert into public.sale_bundle_component_allocations(allocation_id, sale_item_id, component_product_id, batch_id, qty, unit_cost, cost_total, created_at)
    select allocation_id, sale_item_id, component_product_id, batch_id, qty, unit_cost, cost_total, created_at from jsonb_to_recordset(backup -> 'tables' -> 'saleBundleComponentAllocations')
      as row(allocation_id uuid, sale_item_id uuid, component_product_id text, batch_id uuid, qty numeric, unit_cost numeric, cost_total numeric, created_at timestamptz);
  end if;
  if jsonb_typeof(backup -> 'tables' -> 'saleReturns') = 'array' then
    insert into public.sale_returns(return_id, original_sale_id, branch_id, customer_id, return_type, status, reason, refund_amount, created_by, created_at, resolved_at)
    select return_id, original_sale_id, branch_id, customer_id, return_type, status, reason, refund_amount, created_by, created_at, resolved_at from jsonb_to_recordset(backup -> 'tables' -> 'saleReturns')
      as row(return_id text, original_sale_id text, branch_id text, customer_id text, return_type text, status text, reason text, refund_amount numeric, created_by uuid, created_at timestamptz, resolved_at timestamptz);
  end if;
  if jsonb_typeof(backup -> 'tables' -> 'saleReturnItems') = 'array' then
    insert into public.sale_return_items(return_item_id, return_id, original_sale_item_id, product_id, qty, condition_state, replacement_product_id, replacement_qty, created_at)
    select return_item_id, return_id, original_sale_item_id, product_id, qty, condition_state, replacement_product_id, replacement_qty, created_at from jsonb_to_recordset(backup -> 'tables' -> 'saleReturnItems')
      as row(return_item_id uuid, return_id text, original_sale_item_id uuid, product_id text, qty numeric, condition_state text, replacement_product_id text, replacement_qty numeric, created_at timestamptz);
  end if;
  if jsonb_typeof(backup -> 'tables' -> 'inventoryReturnLots') = 'array' then
    insert into public.inventory_return_lots(return_lot_id, return_item_id, branch_id, product_id, qty, state, resolved_at, created_at)
    select return_lot_id, return_item_id, branch_id, product_id, qty, state, resolved_at, created_at from jsonb_to_recordset(backup -> 'tables' -> 'inventoryReturnLots')
      as row(return_lot_id uuid, return_item_id uuid, branch_id text, product_id text, qty numeric, state text, resolved_at timestamptz, created_at timestamptz);
  end if;
  return jsonb_build_object('restored', true, 'schemaVersion', '2');
end;
$$;

revoke all on function public.get_branch_bundle_availability(text) from public;
grant execute on function public.get_branch_bundle_availability(text) to authenticated;
revoke all on function public.save_bundle_components(text, jsonb) from public;
grant execute on function public.save_bundle_components(text, jsonb) to authenticated;
revoke all on function public.receive_sale_return(text, text, jsonb, text, numeric) from public;
grant execute on function public.receive_sale_return(text, text, jsonb, text, numeric) to authenticated;
revoke all on function public.resolve_return_item(uuid, text) from public;
grant execute on function public.resolve_return_item(uuid, text) to authenticated;
revoke all on function public.restore_pos_backup_bundles(jsonb) from public;
grant execute on function public.restore_pos_backup_bundles(jsonb) to authenticated;
