-- Sales returns retain the original sale and FIFO trail.  Returned stock is
-- quarantined first; refund/replacement and inventory disposition are separate.

alter table public.sale_returns
  add column if not exists refund_resolved_at timestamptz,
  add column if not exists replacement_released_at timestamptz;

alter table public.inventory_return_lots
  drop constraint if exists inventory_return_lots_return_item_id_key;
alter table public.inventory_return_lots
  add column if not exists unit_cost numeric(12,2),
  add column if not exists cost_total numeric(14,2),
  add column if not exists selling_price numeric(12,2),
  add column if not exists source_batch_id uuid references public.inventory_cost_batches(batch_id) on delete set null;

create table if not exists public.sale_return_replacement_allocations (
  allocation_id uuid primary key default gen_random_uuid(),
  return_id text not null references public.sale_returns(return_id) on delete cascade,
  return_item_id uuid not null references public.sale_return_items(return_item_id) on delete cascade,
  product_id text not null references public.products(product_id),
  batch_id uuid references public.inventory_cost_batches(batch_id) on delete restrict,
  qty numeric(12,3) not null check (qty > 0),
  unit_cost numeric(12,2),
  cost_total numeric(12,2),
  created_at timestamptz not null default now()
);
create index if not exists sale_return_replacement_allocations_return_idx
  on public.sale_return_replacement_allocations(return_id);
alter table public.sale_return_replacement_allocations enable row level security;
drop policy if exists "read permitted replacement allocations" on public.sale_return_replacement_allocations;
create policy "read permitted replacement allocations" on public.sale_return_replacement_allocations for select to authenticated
using (exists (select 1 from public.sale_returns r where r.return_id = sale_return_replacement_allocations.return_id and public.can_access_branch(r.branch_id)));

create or replace function public.receive_sale_return(
  original_sale_id_input text, return_type_input text, return_lines jsonb,
  reason_input text default '', refund_amount_input numeric default 0
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare sale_row public.sales; line jsonb; sale_item_row public.sale_items; return_id_value text := public.new_pos_id('RET');
  qty_value numeric; returned_qty numeric; return_item_id_value uuid; allocation record; product_type_value text;
begin
  select * into sale_row from public.sales where sale_id = original_sale_id_input for update;
  if not found then raise exception 'Original sale not found.'; end if;
  if not public.has_permission('pos') or not public.can_access_branch(sale_row.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if return_type_input not in ('refund', 'replacement') then raise exception 'Choose Refund or Replacement.'; end if;
  if jsonb_typeof(return_lines) <> 'array' or jsonb_array_length(return_lines) = 0 then raise exception 'Choose returned item quantities.'; end if;
  if coalesce(refund_amount_input, 0) < 0 or (return_type_input = 'refund' and coalesce(refund_amount_input, 0) <= 0) then raise exception 'Enter a valid refund amount.'; end if;
  insert into public.sale_returns(return_id, original_sale_id, branch_id, customer_id, return_type, reason, refund_amount, created_by)
  values(return_id_value, sale_row.sale_id, sale_row.branch_id, sale_row.customer_id, return_type_input, coalesce(trim(reason_input), ''), coalesce(refund_amount_input, 0), auth.uid());
  for line in select value from jsonb_array_elements(return_lines) loop
    qty_value := nullif(line ->> 'qty', '')::numeric;
    select * into sale_item_row from public.sale_items where sale_item_id = (line ->> 'saleItemId')::uuid and sale_id = sale_row.sale_id for update;
    if not found or qty_value is null or qty_value <= 0 then raise exception 'Enter valid returned quantities.'; end if;
    select coalesce(sum(qty), 0) into returned_qty from public.sale_return_items where original_sale_item_id = sale_item_row.sale_item_id;
    if returned_qty + qty_value > sale_item_row.qty then raise exception 'Returned quantity exceeds the original sale.'; end if;
    if return_type_input = 'replacement' and (nullif(line ->> 'replacementProductId', '') is null or coalesce(nullif(line ->> 'replacementQty', '')::numeric, 0) <= 0) then
      raise exception 'Select a replacement product and quantity for every returned item.';
    end if;
    insert into public.sale_return_items(return_id, original_sale_item_id, product_id, qty, replacement_product_id, replacement_qty)
    values(return_id_value, sale_item_row.sale_item_id, sale_item_row.product_id, qty_value, nullif(line ->> 'replacementProductId',''), coalesce(nullif(line ->> 'replacementQty','')::numeric, 0))
    returning return_item_id into return_item_id_value;
    select product_type into product_type_value from public.products where product_id = sale_item_row.product_id;
    if product_type_value = 'bundle' then
      for allocation in
        select component_product_id as product_id, batch_id, qty * qty_value / sale_item_row.qty as qty, unit_cost, cost_total * qty_value / sale_item_row.qty as cost_total
        from public.sale_bundle_component_allocations where sale_item_id = sale_item_row.sale_item_id
      loop
        insert into public.inventory_return_lots(return_item_id, branch_id, product_id, qty, unit_cost, cost_total, selling_price, source_batch_id)
        values(return_item_id_value, sale_row.branch_id, allocation.product_id, allocation.qty, allocation.unit_cost, allocation.cost_total, null, allocation.batch_id);
      end loop;
    else
      for allocation in
        select batch_id, qty * qty_value / sale_item_row.qty as qty, unit_cost, cost_total * qty_value / sale_item_row.qty as cost_total
        from public.sale_item_cost_allocations where sale_item_id = sale_item_row.sale_item_id
      loop
        insert into public.inventory_return_lots(return_item_id, branch_id, product_id, qty, unit_cost, cost_total, selling_price, source_batch_id)
        values(return_item_id_value, sale_row.branch_id, sale_item_row.product_id, allocation.qty, allocation.unit_cost, allocation.cost_total, sale_item_row.price, allocation.batch_id);
      end loop;
      if not found then
        insert into public.inventory_return_lots(return_item_id, branch_id, product_id, qty, selling_price)
        values(return_item_id_value, sale_row.branch_id, sale_item_row.product_id, qty_value, sale_item_row.price);
      end if;
    end if;
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
  if not public.has_permission('inventory') or not public.can_access_branch(case_row.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if resolution not in ('restocked', 'supplier_return', 'disposed') then raise exception 'Choose a valid return resolution.'; end if;
  if not exists (select 1 from public.inventory_return_lots where return_item_id = item.return_item_id and state = 'quarantine') then raise exception 'This return item has already been resolved.'; end if;
  for lot in select * from public.inventory_return_lots where return_item_id = item.return_item_id and state = 'quarantine' for update loop
    if resolution = 'restocked' then
      select coalesce(lot.selling_price, bp.price_override, p.price) into price_value
      from public.products p left join public.branch_products bp on bp.product_id = p.product_id and bp.branch_id = case_row.branch_id
      where p.product_id = lot.product_id;
      insert into public.inventory(branch_id, product_id, qty) values(case_row.branch_id, lot.product_id, lot.qty)
        on conflict(branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
      insert into public.inventory_cost_batches(branch_id, product_id, unit_cost, selling_price, qty_received, qty_remaining, received_at, created_by)
      values(case_row.branch_id, lot.product_id, lot.unit_cost, price_value, lot.qty, lot.qty, now(), auth.uid());
    end if;
    update public.inventory_return_lots set state = resolution, resolved_at = now() where return_lot_id = lot.return_lot_id;
  end loop;
  update public.sale_return_items set condition_state = resolution where return_item_id = item.return_item_id;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Resolved returned inventory', case_row.return_id, resolution || ': ' || item.product_id);
  return jsonb_build_object('returnId', case_row.return_id, 'resolution', resolution);
end;
$$;

create or replace function public.release_sale_replacement(target_return_id text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare case_row public.sale_returns; demand record; batch_row public.inventory_cost_batches; item record;
  available_qty numeric; remaining_qty numeric; allocated_qty numeric;
begin
  select * into case_row from public.sale_returns where return_id = target_return_id for update;
  if not found then raise exception 'Return not found.'; end if;
  if not public.has_permission('pos') or not public.can_access_branch(case_row.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if case_row.return_type <> 'replacement' then raise exception 'This return is not a replacement.'; end if;
  if case_row.replacement_released_at is not null then raise exception 'Replacement has already been released.'; end if;
  for demand in
    select product_id, sum(qty) as qty from (
      select ri.replacement_product_id as product_id, ri.replacement_qty as qty
      from public.sale_return_items ri join public.products p on p.product_id = ri.replacement_product_id
      where ri.return_id = case_row.return_id and p.product_type = 'individual'
      union all
      select component.component_product_id, ri.replacement_qty * component.qty
      from public.sale_return_items ri join public.products p on p.product_id = ri.replacement_product_id
      join public.product_bundle_components component on component.bundle_product_id = ri.replacement_product_id
      where ri.return_id = case_row.return_id and p.product_type = 'bundle'
    ) demands group by product_id
  loop
    select coalesce(qty, 0) into available_qty from public.inventory where branch_id = case_row.branch_id and product_id = demand.product_id for update;
    if coalesce(available_qty, 0) < demand.qty then raise exception 'Insufficient stock for the replacement.'; end if;
  end loop;
  for item in select * from public.sale_return_items where return_id = case_row.return_id loop
    for demand in
      select product_id, sum(qty) as qty from (
        select item.replacement_product_id as product_id, item.replacement_qty as qty
        from public.products p where p.product_id = item.replacement_product_id and p.product_type = 'individual'
        union all
        select component.component_product_id, item.replacement_qty * component.qty
        from public.products p join public.product_bundle_components component on component.bundle_product_id = item.replacement_product_id
        where p.product_id = item.replacement_product_id and p.product_type = 'bundle'
      ) demand_lines group by product_id
    loop
      remaining_qty := demand.qty;
      for batch_row in select * from public.inventory_cost_batches where branch_id = case_row.branch_id and product_id = demand.product_id and qty_remaining > 0 order by is_opening desc, received_at, batch_id for update loop
        allocated_qty := least(remaining_qty, batch_row.qty_remaining);
        update public.inventory_cost_batches set qty_remaining = qty_remaining - allocated_qty where batch_id = batch_row.batch_id;
        insert into public.sale_return_replacement_allocations(return_id, return_item_id, product_id, batch_id, qty, unit_cost, cost_total)
        values(case_row.return_id, item.return_item_id, demand.product_id, batch_row.batch_id, allocated_qty, batch_row.unit_cost, allocated_qty * batch_row.unit_cost);
        remaining_qty := remaining_qty - allocated_qty; exit when remaining_qty <= 0;
      end loop;
      if remaining_qty > 0 then raise exception 'Replacement FIFO batches are incomplete.'; end if;
      update public.inventory set qty = qty - demand.qty where branch_id = case_row.branch_id and product_id = demand.product_id;
    end loop;
  end loop;
  update public.sale_returns set status = 'Replaced', replacement_released_at = now(), resolved_at = now() where return_id = case_row.return_id;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Released replacement stock', case_row.return_id, 'Replacement released');
  return jsonb_build_object('returnId', case_row.return_id, 'status', 'Replaced');
end;
$$;

create or replace function public.resolve_sale_return_financially(target_return_id text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare r public.sale_returns; s public.sales; open_balance numeric;
begin
  select * into r from public.sale_returns where return_id = target_return_id for update;
  if not found then raise exception 'Return not found.'; end if;
  select * into s from public.sales where sale_id = r.original_sale_id for update;
  if not public.has_permission('pos') or not public.can_access_branch(r.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if r.return_type <> 'refund' then raise exception 'This return is not a refund.'; end if;
  if r.refund_resolved_at is not null then raise exception 'Refund has already been completed.'; end if;
  if r.refund_amount <= 0 or r.refund_amount > s.total then raise exception 'Enter a valid refund amount.'; end if;
  if s.payment_type = 'credit' then
    select greatest(s.total - coalesce(sum(amount), 0), 0) into open_balance from public.credit_payments where sale_id = s.sale_id;
    if r.refund_amount > open_balance then raise exception 'Refund exceeds the outstanding credit balance.'; end if;
    insert into public.credit_payments(payment_id, branch_id, sale_id, customer_id, amount, notes, created_by)
    values(public.new_pos_id('CPY'), r.branch_id, s.sale_id, s.customer_id, r.refund_amount, 'Refund adjustment: ' || r.return_id, auth.uid());
  end if;
  update public.sale_returns set status = 'Refunded', refund_resolved_at = now(), resolved_at = now() where return_id = r.return_id;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Resolved sale refund', r.return_id, r.refund_amount::text);
  return jsonb_build_object('returnId', r.return_id, 'status', 'Refunded', 'refundAmount', r.refund_amount);
end;
$$;

revoke all on function public.receive_sale_return(text, text, jsonb, text, numeric) from public;
grant execute on function public.receive_sale_return(text, text, jsonb, text, numeric) to authenticated;
revoke all on function public.resolve_return_item(uuid, text) from public;
grant execute on function public.resolve_return_item(uuid, text) to authenticated;
revoke all on function public.release_sale_replacement(text) from public;
grant execute on function public.release_sale_replacement(text) to authenticated;
revoke all on function public.resolve_sale_return_financially(text) from public;
grant execute on function public.resolve_sale_return_financially(text) to authenticated;
