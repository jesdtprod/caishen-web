-- A supplier delivery can contain many individual products while preserving
-- a single receipt reference for history and quarantine grouping.
alter table public.stock_ins add column if not exists stock_in_batch_id text;
create index if not exists stock_ins_batch_idx on public.stock_ins(stock_in_batch_id);

create or replace function public.receive_stock_in_batch_with_quarantine(
  target_branch_id text, receipt_lines jsonb, supplier_reference_input text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare line jsonb; stock_in_id_value text; batch_id_value text := public.new_pos_id('STK'); case_id_value text;
  product_id_value text; received_qty numeric; quarantine_qty numeric; accepted_qty numeric; selling_price_value numeric; reason_value text; count_value integer := 0;
begin
  if not public.has_permission('inventory') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if jsonb_typeof(receipt_lines) <> 'array' or jsonb_array_length(receipt_lines) = 0 then raise exception 'Add at least one stock-in item.'; end if;
  for line in select value from jsonb_array_elements(receipt_lines) loop
    product_id_value := trim(line ->> 'productId'); received_qty := nullif(line ->> 'qty', '')::numeric; quarantine_qty := coalesce(nullif(line ->> 'quarantineQty', '')::numeric, 0); selling_price_value := nullif(line ->> 'sellingPrice', '')::numeric; reason_value := coalesce(trim(line ->> 'quarantineReason'), ''); accepted_qty := received_qty - quarantine_qty; stock_in_id_value := public.new_pos_id('STK');
    if product_id_value = '' or received_qty is null or received_qty <= 0 or quarantine_qty < 0 or quarantine_qty > received_qty or selling_price_value is null or selling_price_value < 0 then raise exception 'Enter valid quantities and selling price for every stock-in item.'; end if;
    if quarantine_qty > 0 and reason_value = '' then raise exception 'Enter a quarantine reason for every quarantined item.'; end if;
    if not exists (select 1 from public.branch_products where branch_id = target_branch_id and product_id = product_id_value and status = 'Active') then raise exception 'Every stock-in item must be active in this branch.'; end if;
    insert into public.stock_ins(stock_in_id, stock_in_batch_id, branch_id, product_id, qty, selling_price, supplier_reference, created_by) values(stock_in_id_value, batch_id_value, target_branch_id, product_id_value, received_qty, selling_price_value, coalesce(trim(supplier_reference_input), ''), auth.uid());
    if accepted_qty > 0 then
      insert into public.inventory(branch_id, product_id, qty) values(target_branch_id, product_id_value, accepted_qty) on conflict(branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
      insert into public.inventory_cost_batches(branch_id, product_id, stock_in_id, selling_price, qty_received, qty_remaining, created_by) values(target_branch_id, product_id_value, stock_in_id_value, selling_price_value, accepted_qty, accepted_qty, auth.uid());
    end if;
    if quarantine_qty > 0 then
      case_id_value := public.new_pos_id('QTN');
      insert into public.inventory_quarantine_cases(case_id, branch_id, source_type, source_reference, supplier_reference, reason, created_by) values(case_id_value, target_branch_id, 'stock_in', batch_id_value, coalesce(trim(supplier_reference_input), ''), reason_value, auth.uid());
      insert into public.inventory_quarantine_items(case_id, product_id, qty, selling_price) values(case_id_value, product_id_value, quarantine_qty, selling_price_value);
    end if;
    count_value := count_value + 1;
  end loop;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Received multi-item stock in', batch_id_value, count_value::text || ' item lines');
  return jsonb_build_object('stockInBatchId', batch_id_value, 'lineCount', count_value);
end;
$$;
revoke all on function public.receive_stock_in_batch_with_quarantine(text, jsonb, text) from public;
grant execute on function public.receive_stock_in_batch_with_quarantine(text, jsonb, text) to authenticated;
