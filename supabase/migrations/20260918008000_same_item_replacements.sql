-- A replacement is a like-for-like exchange, never a product swap.
create or replace function public.receive_sale_return(
  original_sale_id_input text, return_type_input text, return_lines jsonb,
  reason_input text default '', refund_amount_input numeric default 0
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare sale_row public.sales; line jsonb; sale_item_row public.sale_items; return_id_value text := public.new_pos_id('RET');
  qty_value numeric; returned_qty numeric; return_item_id_value uuid; allocation record; product_type_value text;
  action_value text; line_refund_amount numeric; refund_total numeric := 0; replacement_product_id_value text; replacement_qty_value numeric;
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
    replacement_product_id_value := null;
    replacement_qty_value := 0;
    if action_value = 'replacement' then
      replacement_product_id_value := nullif(line ->> 'replacementProductId', '');
      replacement_qty_value := coalesce(nullif(line ->> 'replacementQty', '')::numeric, 0);
      if replacement_product_id_value is distinct from sale_item_row.product_id or replacement_qty_value <> qty_value then
        raise exception 'A replacement must be the same sold item and quantity.';
      end if;
    end if;
    select coalesce(sum(qty), 0) into returned_qty from public.sale_return_items where original_sale_item_id = sale_item_row.sale_item_id;
    if returned_qty + qty_value > sale_item_row.qty then raise exception 'Returned quantity exceeds the original sale.'; end if;
    insert into public.sale_return_items(return_id, original_sale_item_id, product_id, qty, action_type, refund_amount, replacement_product_id, replacement_qty)
    values(return_id_value, sale_item_row.sale_item_id, sale_item_row.product_id, qty_value, action_value, line_refund_amount, replacement_product_id_value, replacement_qty_value)
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
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Received same-item sale return into quarantine', return_id_value, sale_row.sale_id);
  return jsonb_build_object('returnId', return_id_value, 'status', 'Received for Inspection', 'refundAmount', refund_total);
end;
$$;

revoke all on function public.receive_sale_return(text, text, jsonb, text, numeric) from public;
grant execute on function public.receive_sale_return(text, text, jsonb, text, numeric) to authenticated;
