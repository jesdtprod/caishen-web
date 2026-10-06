-- Damaged or questionable stock is recorded at receiving time. It never
-- becomes sellable inventory until it passes inspection and is restocked.

create table if not exists public.inventory_quarantine_cases (
  case_id text primary key,
  branch_id text not null references public.branches(branch_id) on delete cascade,
  source_type text not null check (source_type in ('stock_in', 'transfer')),
  source_reference text not null,
  source_branch_id text references public.branches(branch_id) on delete set null,
  supplier_reference text not null default '',
  reason text not null default '',
  status text not null default 'Awaiting Inspection'
    check (status in ('Awaiting Inspection', 'Partially Resolved', 'Resolved')),
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.inventory_quarantine_items (
  quarantine_item_id uuid primary key default gen_random_uuid(),
  case_id text not null references public.inventory_quarantine_cases(case_id) on delete cascade,
  product_id text not null references public.products(product_id) on delete restrict,
  qty numeric(12,3) not null check (qty > 0),
  unit_cost numeric(12,2) check (unit_cost is null or unit_cost >= 0),
  selling_price numeric(12,2) check (selling_price is null or selling_price >= 0),
  source_batch_id uuid references public.inventory_cost_batches(batch_id) on delete set null,
  resolution text not null default 'quarantine'
    check (resolution in ('quarantine', 'restocked', 'supplier_return', 'return_to_source', 'disposed')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists inventory_quarantine_cases_branch_created_idx
  on public.inventory_quarantine_cases(branch_id, created_at desc);
create index if not exists inventory_quarantine_items_case_resolution_idx
  on public.inventory_quarantine_items(case_id, resolution, product_id);

alter table public.inventory_quarantine_cases enable row level security;
alter table public.inventory_quarantine_items enable row level security;

drop policy if exists "read permitted quarantine cases" on public.inventory_quarantine_cases;
create policy "read permitted quarantine cases" on public.inventory_quarantine_cases for select to authenticated
  using (public.can_access_branch(branch_id));
drop policy if exists "read permitted quarantine items" on public.inventory_quarantine_items;
create policy "read permitted quarantine items" on public.inventory_quarantine_items for select to authenticated
  using (exists (select 1 from public.inventory_quarantine_cases c where c.case_id = inventory_quarantine_items.case_id and public.can_access_branch(c.branch_id)));

create or replace function public.refresh_inventory_quarantine_case_status(target_case_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.inventory_quarantine_cases c
  set status = case
      when not exists (select 1 from public.inventory_quarantine_items i where i.case_id = c.case_id and i.resolution = 'quarantine') then 'Resolved'
      when exists (select 1 from public.inventory_quarantine_items i where i.case_id = c.case_id and i.resolution <> 'quarantine') then 'Partially Resolved'
      else 'Awaiting Inspection'
    end,
    resolved_at = case when not exists (select 1 from public.inventory_quarantine_items i where i.case_id = c.case_id and i.resolution = 'quarantine') then now() else null end
  where c.case_id = target_case_id;
end;
$$;

create or replace function public.receive_stock_in_with_quarantine(
  target_branch_id text, target_product_id text, received_qty numeric,
  quarantine_qty numeric, selling_price_input numeric,
  supplier_reference_input text default '', reason_input text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare stock_in_id_value text := public.new_pos_id('STK'); case_id_value text; accepted_qty numeric := received_qty - coalesce(quarantine_qty, 0);
begin
  if not public.has_permission('inventory') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if received_qty is null or received_qty <= 0 or quarantine_qty is null or quarantine_qty < 0 or quarantine_qty > received_qty then raise exception 'Enter valid received and quarantine quantities.'; end if;
  if selling_price_input is null or selling_price_input < 0 then raise exception 'Enter a valid selling price.'; end if;
  if not exists (select 1 from public.branch_products where branch_id = target_branch_id and product_id = target_product_id and status = 'Active') then raise exception 'Register an active product in the selected branch before stocking it.'; end if;
  insert into public.stock_ins(stock_in_id, branch_id, product_id, qty, selling_price, supplier_reference, created_by)
  values(stock_in_id_value, target_branch_id, target_product_id, received_qty, selling_price_input, coalesce(trim(supplier_reference_input), ''), auth.uid());
  if accepted_qty > 0 then
    insert into public.inventory(branch_id, product_id, qty) values(target_branch_id, target_product_id, accepted_qty)
      on conflict(branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
    insert into public.inventory_cost_batches(branch_id, product_id, stock_in_id, selling_price, qty_received, qty_remaining, created_by)
      values(target_branch_id, target_product_id, stock_in_id_value, selling_price_input, accepted_qty, accepted_qty, auth.uid());
  end if;
  if quarantine_qty > 0 then
    case_id_value := public.new_pos_id('QTN');
    insert into public.inventory_quarantine_cases(case_id, branch_id, source_type, source_reference, supplier_reference, reason, created_by)
      values(case_id_value, target_branch_id, 'stock_in', stock_in_id_value, coalesce(trim(supplier_reference_input), ''), coalesce(trim(reason_input), ''), auth.uid());
    insert into public.inventory_quarantine_items(case_id, product_id, qty, selling_price)
      values(case_id_value, target_product_id, quarantine_qty, selling_price_input);
  end if;
  insert into public.account_audit(actor_id, action, target_id, details)
    values(auth.uid(), 'Received stock in', stock_in_id_value, target_product_id || ': accepted ' || accepted_qty::text || ', quarantined ' || quarantine_qty::text);
  return jsonb_build_object('stockInId', stock_in_id_value, 'productId', target_product_id, 'qty', accepted_qty, 'quarantineQty', quarantine_qty, 'quarantineCaseId', case_id_value);
end;
$$;

create or replace function public.receive_transfer_with_quarantine(
  target_transfer_id text, accepted_qty_input numeric, quarantine_qty_input numeric, reason_input text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare transfer_row public.stock_transfers; allocation_row public.transfer_batch_allocations; accepted_remaining numeric := accepted_qty_input; quarantine_remaining numeric := quarantine_qty_input; allocation_accepted numeric; allocation_quarantine numeric; case_id_value text;
begin
  select * into transfer_row from public.stock_transfers where transfer_id = target_transfer_id for update;
  if not found then raise exception 'Stock transfer not found.'; end if;
  if not public.has_permission('transfers') or not public.can_access_branch(transfer_row.destination_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if transfer_row.status <> 'In Transit' then raise exception 'Only in-transit transfers can be received.'; end if;
  if accepted_qty_input is null or quarantine_qty_input is null or accepted_qty_input < 0 or quarantine_qty_input < 0 or accepted_qty_input + quarantine_qty_input <> transfer_row.qty then raise exception 'Accepted and quarantine quantities must equal the transfer quantity.'; end if;
  insert into public.branch_products(branch_id, product_id, price_override, low_stock_level, status)
    select transfer_row.destination_branch_id, p.product_id, p.price, p.low_stock_level, 'Active' from public.products p where p.product_id = transfer_row.product_id
    on conflict(branch_id, product_id) do update set status = 'Active';
  if quarantine_qty_input > 0 then
    case_id_value := public.new_pos_id('QTN');
    insert into public.inventory_quarantine_cases(case_id, branch_id, source_type, source_reference, source_branch_id, reason, created_by)
      values(case_id_value, transfer_row.destination_branch_id, 'transfer', transfer_row.transfer_id, transfer_row.source_branch_id, coalesce(trim(reason_input), ''), auth.uid());
  end if;
  for allocation_row in select * from public.transfer_batch_allocations where transfer_id = target_transfer_id order by received_at, allocation_id loop
    allocation_accepted := least(accepted_remaining, allocation_row.qty);
    accepted_remaining := accepted_remaining - allocation_accepted;
    allocation_quarantine := allocation_row.qty - allocation_accepted;
    if allocation_accepted > 0 then
      insert into public.inventory(branch_id, product_id, qty) values(transfer_row.destination_branch_id, transfer_row.product_id, allocation_accepted)
        on conflict(branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
      insert into public.inventory_cost_batches(branch_id, product_id, unit_cost, selling_price, qty_received, qty_remaining, received_at, is_opening, created_by)
        values(transfer_row.destination_branch_id, transfer_row.product_id, allocation_row.unit_cost, allocation_row.selling_price, allocation_accepted, allocation_accepted, allocation_row.received_at, allocation_row.is_opening, auth.uid());
    end if;
    if allocation_quarantine > 0 then
      insert into public.inventory_quarantine_items(case_id, product_id, qty, unit_cost, selling_price, source_batch_id)
        values(case_id_value, transfer_row.product_id, allocation_quarantine, allocation_row.unit_cost, allocation_row.selling_price, allocation_row.source_batch_id);
    end if;
  end loop;
  if not exists (select 1 from public.transfer_batch_allocations where transfer_id = target_transfer_id) then
    if accepted_qty_input > 0 then
      insert into public.inventory(branch_id, product_id, qty) values(transfer_row.destination_branch_id, transfer_row.product_id, accepted_qty_input) on conflict(branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
      insert into public.inventory_cost_batches(branch_id, product_id, selling_price, qty_received, qty_remaining, created_by)
        select transfer_row.destination_branch_id, transfer_row.product_id, coalesce(bp.price_override, p.price), accepted_qty_input, accepted_qty_input, auth.uid() from public.products p left join public.branch_products bp on bp.branch_id = transfer_row.source_branch_id and bp.product_id = p.product_id where p.product_id = transfer_row.product_id;
    end if;
    if quarantine_qty_input > 0 then
      insert into public.inventory_quarantine_items(case_id, product_id, qty, selling_price)
        select case_id_value, transfer_row.product_id, quarantine_qty_input, coalesce(bp.price_override, p.price) from public.products p left join public.branch_products bp on bp.branch_id = transfer_row.source_branch_id and bp.product_id = p.product_id where p.product_id = transfer_row.product_id;
    end if;
  end if;
  update public.stock_transfers set status = 'Received', received_at = now() where transfer_id = target_transfer_id;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Received transfer with inspection', target_transfer_id, 'accepted ' || accepted_qty_input::text || ', quarantined ' || quarantine_qty_input::text);
  return jsonb_build_object('id', target_transfer_id, 'status', 'Received', 'quarantineCaseId', case_id_value);
end;
$$;

create or replace function public.receive_transfer_batch_with_quarantine(target_batch_id text, receipt_lines jsonb, reason_input text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare line jsonb; count_value integer := 0;
begin
  if jsonb_typeof(receipt_lines) <> 'array' or jsonb_array_length(receipt_lines) = 0 then raise exception 'Enter receipt quantities.'; end if;
  for line in select value from jsonb_array_elements(receipt_lines) loop
    perform public.receive_transfer_with_quarantine(line ->> 'transferId', (line ->> 'acceptedQty')::numeric, (line ->> 'quarantineQty')::numeric, reason_input);
    count_value := count_value + 1;
  end loop;
  return jsonb_build_object('batchId', target_batch_id, 'lineCount', count_value);
end;
$$;

create or replace function public.resolve_inventory_quarantine_item(target_quarantine_item_id uuid, resolution_input text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare item public.inventory_quarantine_items; case_row public.inventory_quarantine_cases; return_transfer_id text;
begin
  select * into item from public.inventory_quarantine_items where quarantine_item_id = target_quarantine_item_id for update;
  if not found then raise exception 'Quarantined item not found.'; end if;
  select * into case_row from public.inventory_quarantine_cases where case_id = item.case_id for update;
  if not public.has_permission('inventory') or not public.can_access_branch(case_row.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if item.resolution <> 'quarantine' then raise exception 'This quarantined item has already been resolved.'; end if;
  if (case_row.source_type = 'stock_in' and resolution_input not in ('restocked', 'supplier_return', 'disposed')) or (case_row.source_type = 'transfer' and resolution_input not in ('restocked', 'return_to_source', 'disposed')) then raise exception 'Choose a valid disposition for this source.'; end if;
  if resolution_input = 'restocked' then
    insert into public.inventory(branch_id, product_id, qty) values(case_row.branch_id, item.product_id, item.qty) on conflict(branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
    insert into public.inventory_cost_batches(branch_id, product_id, unit_cost, selling_price, qty_received, qty_remaining, created_by)
      values(case_row.branch_id, item.product_id, item.unit_cost, item.selling_price, item.qty, item.qty, auth.uid());
  elsif resolution_input = 'return_to_source' then
    return_transfer_id := public.new_pos_id('TRF');
    insert into public.stock_transfers(transfer_id, source_branch_id, destination_branch_id, product_id, qty, status, dispatched_at, notes, created_by)
      values(return_transfer_id, case_row.branch_id, case_row.source_branch_id, item.product_id, item.qty, 'In Transit', now(), 'Quarantine return for ' || case_row.source_reference, auth.uid());
    insert into public.transfer_batch_allocations(transfer_id, source_batch_id, qty, unit_cost, selling_price, received_at, is_opening)
      values(return_transfer_id, null, item.qty, item.unit_cost, item.selling_price, now(), false);
  end if;
  update public.inventory_quarantine_items set resolution = resolution_input, resolved_at = now() where quarantine_item_id = item.quarantine_item_id;
  perform public.refresh_inventory_quarantine_case_status(case_row.case_id);
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Resolved quarantined inventory', case_row.case_id, resolution_input || ': ' || item.product_id || case when return_transfer_id is null then '' else '; ' || return_transfer_id end);
  return jsonb_build_object('caseId', case_row.case_id, 'resolution', resolution_input, 'returnTransferId', return_transfer_id);
end;
$$;

revoke all on function public.receive_stock_in_with_quarantine(text, text, numeric, numeric, numeric, text, text) from public;
grant execute on function public.receive_stock_in_with_quarantine(text, text, numeric, numeric, numeric, text, text) to authenticated;
revoke all on function public.receive_transfer_with_quarantine(text, numeric, numeric, text) from public;
grant execute on function public.receive_transfer_with_quarantine(text, numeric, numeric, text) to authenticated;
revoke all on function public.receive_transfer_batch_with_quarantine(text, jsonb, text) from public;
grant execute on function public.receive_transfer_batch_with_quarantine(text, jsonb, text) to authenticated;
revoke all on function public.resolve_inventory_quarantine_item(uuid, text) from public;
grant execute on function public.resolve_inventory_quarantine_item(uuid, text) to authenticated;
