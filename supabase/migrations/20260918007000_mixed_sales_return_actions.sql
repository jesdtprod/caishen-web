-- A single customer visit may mix refund, replacement, and return-only lines.
alter table public.sale_return_items
  add column if not exists action_type text not null default 'return'
    check (action_type in ('return', 'refund', 'replacement')),
  add column if not exists refund_amount numeric(12,2) not null default 0
    check (refund_amount >= 0);

update public.sale_return_items item
set action_type = case when parent.return_type in ('refund', 'replacement') then parent.return_type else 'return' end
from public.sale_returns parent
where parent.return_id = item.return_id and item.action_type = 'return';

create or replace function public.receive_sale_return(
  original_sale_id_input text, return_type_input text, return_lines jsonb,
  reason_input text default '', refund_amount_input numeric default 0
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare sale_row public.sales; line jsonb; sale_item_row public.sale_items; return_id_value text := public.new_pos_id('RET');
  qty_value numeric; returned_qty numeric; return_item_id_value uuid; allocation record; product_type_value text;
  action_value text; line_refund_amount numeric; refund_total numeric := 0;
begin
  select * into sale_row from public.sales where sale_id = original_sale_id_input for update;
  if not found then raise exception 'Original sale not found.'; end if;
  if not public.has_permission('pos') or not public.can_access_branch(sale_row.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if jsonb_typeof(return_lines) <> 'array' or jsonb_array_length(return_lines) = 0 then raise exception 'Choose returned item quantities.'; end if;
  insert into public.sale_returns(return_id, original_sale_id, branch_id, customer_id, return_type, reason, refund_amount, created_by)
  values(return_id_value, sale_row.sale_id, sale_row.branch_id, sale_row.customer_id, 'return', coalesce(trim(reason_input), ''), 0, auth.uid());
  for line in select value from jsonb_array_elements(return_lines) loop
    qty_value := nullif(line ->> 'qty', '')::numeric;
    action_value := coalesce(nullif(line ->> 'actionType', ''), nullif(return_type_input, ''), 'return');
    line_refund_amount := coalesce(nullif(line ->> 'refundAmount', '')::numeric, 0);
    select * into sale_item_row from public.sale_items where sale_item_id = (line ->> 'saleItemId')::uuid and sale_id = sale_row.sale_id for update;
    if not found or qty_value is null or qty_value <= 0 then raise exception 'Enter valid returned quantities.'; end if;
    if action_value not in ('return', 'refund', 'replacement') then raise exception 'Choose Refund, Replace, or Return Only for every returned item.'; end if;
    if action_value = 'refund' and (line_refund_amount <= 0 or line_refund_amount > sale_item_row.price * qty_value) then raise exception 'Enter a valid refund amount for each refunded item.'; end if;
    if action_value <> 'refund' and line_refund_amount <> 0 then raise exception 'Only refunded items may have a refund amount.'; end if;
    if action_value = 'replacement' and (nullif(line ->> 'replacementProductId', '') is null or coalesce(nullif(line ->> 'replacementQty', '')::numeric, 0) <= 0) then raise exception 'Select a replacement product and quantity for every replacement item.'; end if;
    select coalesce(sum(qty), 0) into returned_qty from public.sale_return_items where original_sale_item_id = sale_item_row.sale_item_id;
    if returned_qty + qty_value > sale_item_row.qty then raise exception 'Returned quantity exceeds the original sale.'; end if;
    insert into public.sale_return_items(return_id, original_sale_item_id, product_id, qty, action_type, refund_amount, replacement_product_id, replacement_qty)
    values(return_id_value, sale_item_row.sale_item_id, sale_item_row.product_id, qty_value, action_value, line_refund_amount, nullif(line ->> 'replacementProductId',''), coalesce(nullif(line ->> 'replacementQty','')::numeric, 0))
    returning return_item_id into return_item_id_value;
    refund_total := refund_total + line_refund_amount;
    select product_type into product_type_value from public.products where product_id = sale_item_row.product_id;
    if product_type_value = 'bundle' then
      for allocation in select component_product_id as product_id, batch_id, qty * qty_value / sale_item_row.qty as qty, unit_cost, cost_total * qty_value / sale_item_row.qty as cost_total from public.sale_bundle_component_allocations where sale_item_id = sale_item_row.sale_item_id loop
        insert into public.inventory_return_lots(return_item_id, branch_id, product_id, qty, unit_cost, cost_total, selling_price, source_batch_id)
        values(return_item_id_value, sale_row.branch_id, allocation.product_id, allocation.qty, allocation.unit_cost, allocation.cost_total, null, allocation.batch_id);
      end loop;
    else
      for allocation in select batch_id, qty * qty_value / sale_item_row.qty as qty, unit_cost, cost_total * qty_value / sale_item_row.qty as cost_total from public.sale_item_cost_allocations where sale_item_id = sale_item_row.sale_item_id loop
        insert into public.inventory_return_lots(return_item_id, branch_id, product_id, qty, unit_cost, cost_total, selling_price, source_batch_id)
        values(return_item_id_value, sale_row.branch_id, sale_item_row.product_id, allocation.qty, allocation.unit_cost, allocation.cost_total, sale_item_row.price, allocation.batch_id);
      end loop;
      if not found then insert into public.inventory_return_lots(return_item_id, branch_id, product_id, qty, selling_price) values(return_item_id_value, sale_row.branch_id, sale_item_row.product_id, qty_value, sale_item_row.price); end if;
    end if;
  end loop;
  if refund_total > sale_row.total then raise exception 'Refund amount exceeds the original sale total.'; end if;
  update public.sale_returns set refund_amount = refund_total where return_id = return_id_value;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Received mixed sale return into quarantine', return_id_value, sale_row.sale_id);
  return jsonb_build_object('returnId', return_id_value, 'status', 'Received for Inspection', 'refundAmount', refund_total);
end;
$$;

create or replace function public.release_sale_replacement(target_return_id text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare case_row public.sale_returns; demand record; batch_row public.inventory_cost_batches; item record; available_qty numeric; remaining_qty numeric; allocated_qty numeric;
begin
  select * into case_row from public.sale_returns where return_id = target_return_id for update;
  if not found then raise exception 'Return not found.'; end if;
  if not public.has_permission('pos') or not public.can_access_branch(case_row.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if not exists(select 1 from public.sale_return_items where return_id = case_row.return_id and action_type = 'replacement') then raise exception 'This return has no replacement items.'; end if;
  if case_row.replacement_released_at is not null then raise exception 'Replacement has already been released.'; end if;
  for demand in select product_id, sum(qty) as qty from (
    select ri.replacement_product_id as product_id, ri.replacement_qty as qty from public.sale_return_items ri join public.products p on p.product_id = ri.replacement_product_id where ri.return_id = case_row.return_id and ri.action_type = 'replacement' and p.product_type = 'individual'
    union all
    select component.component_product_id, ri.replacement_qty * component.qty from public.sale_return_items ri join public.products p on p.product_id = ri.replacement_product_id join public.product_bundle_components component on component.bundle_product_id = ri.replacement_product_id where ri.return_id = case_row.return_id and ri.action_type = 'replacement' and p.product_type = 'bundle'
  ) demands group by product_id loop
    select coalesce(qty, 0) into available_qty from public.inventory where branch_id = case_row.branch_id and product_id = demand.product_id for update;
    if coalesce(available_qty, 0) < demand.qty then raise exception 'Insufficient stock for the replacement.'; end if;
  end loop;
  for item in select * from public.sale_return_items where return_id = case_row.return_id and action_type = 'replacement' loop
    for demand in select product_id, sum(qty) as qty from (
      select item.replacement_product_id as product_id, item.replacement_qty as qty from public.products p where p.product_id = item.replacement_product_id and p.product_type = 'individual'
      union all select component.component_product_id, item.replacement_qty * component.qty from public.products p join public.product_bundle_components component on component.bundle_product_id = item.replacement_product_id where p.product_id = item.replacement_product_id and p.product_type = 'bundle'
    ) demand_lines group by product_id loop
      remaining_qty := demand.qty;
      for batch_row in select * from public.inventory_cost_batches where branch_id = case_row.branch_id and product_id = demand.product_id and qty_remaining > 0 order by is_opening desc, received_at, batch_id for update loop
        allocated_qty := least(remaining_qty, batch_row.qty_remaining);
        update public.inventory_cost_batches set qty_remaining = qty_remaining - allocated_qty where batch_id = batch_row.batch_id;
        insert into public.sale_return_replacement_allocations(return_id, return_item_id, product_id, batch_id, qty, unit_cost, cost_total) values(case_row.return_id, item.return_item_id, demand.product_id, batch_row.batch_id, allocated_qty, batch_row.unit_cost, allocated_qty * batch_row.unit_cost);
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
declare r public.sale_returns; s public.sales; open_balance numeric; prior_refunds numeric;
begin
  select * into r from public.sale_returns where return_id = target_return_id for update;
  if not found then raise exception 'Return not found.'; end if;
  select * into s from public.sales where sale_id = r.original_sale_id for update;
  if not public.has_permission('pos') or not public.can_access_branch(r.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if not exists(select 1 from public.sale_return_items where return_id = r.return_id and action_type = 'refund') then raise exception 'This return has no refund items.'; end if;
  if r.refund_resolved_at is not null then raise exception 'Refund has already been completed.'; end if;
  select coalesce(sum(refund_amount), 0) into prior_refunds from public.sale_returns where original_sale_id = s.sale_id and refund_resolved_at is not null and return_id <> r.return_id;
  if r.refund_amount <= 0 or r.refund_amount > s.total - prior_refunds then raise exception 'Refund exceeds the remaining refundable amount.'; end if;
  if s.payment_type = 'credit' then
    select greatest(s.total - coalesce(sum(amount), 0), 0) into open_balance from public.credit_payments where sale_id = s.sale_id;
    if r.refund_amount > open_balance then raise exception 'Refund exceeds the outstanding credit balance.'; end if;
    insert into public.credit_payments(payment_id, branch_id, sale_id, customer_id, amount, notes, created_by) values(public.new_pos_id('CPY'), r.branch_id, s.sale_id, s.customer_id, r.refund_amount, 'Refund adjustment: ' || r.return_id, auth.uid());
  end if;
  update public.sale_returns set status = 'Refunded', refund_resolved_at = now(), resolved_at = now() where return_id = r.return_id;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Resolved sale refund', r.return_id, r.refund_amount::text);
  return jsonb_build_object('returnId', r.return_id, 'status', 'Refunded', 'refundAmount', r.refund_amount);
end;
$$;

revoke all on function public.receive_sale_return(text, text, jsonb, text, numeric) from public;
grant execute on function public.receive_sale_return(text, text, jsonb, text, numeric) to authenticated;
revoke all on function public.release_sale_replacement(text) from public;
grant execute on function public.release_sale_replacement(text) to authenticated;
revoke all on function public.resolve_sale_return_financially(text) from public;
grant execute on function public.resolve_sale_return_financially(text) to authenticated;
