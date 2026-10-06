-- A bundle is a receipt line with its own price, but consumes component FIFO stock.
create or replace function public.record_sale(
  target_branch_id text, sale_lines jsonb, payment_type_input text,
  customer_id_input text default null, discount_input numeric default 0, cash_tendered_input numeric default 0
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare sale_id_value text := public.new_pos_id('SAL'); sale_item_id_value uuid; line jsonb; batch_row public.inventory_cost_batches; component_row record;
  product_id_value text; requested_qty numeric; available_qty numeric; remaining_qty numeric; allocated_qty numeric;
  line_total numeric(12,2); subtotal_value numeric(12,2) := 0; total_value numeric(12,2); change_value numeric(12,2) := 0; normalized_payment_type text := lower(trim(payment_type_input));
  product_type_value text; bundle_price_value numeric; component_qty numeric;
begin
  if not public.has_permission('pos') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if jsonb_typeof(sale_lines) <> 'array' or jsonb_array_length(sale_lines) = 0 then raise exception 'The sale has no items.'; end if;
  if normalized_payment_type not in ('cash', 'credit') then raise exception 'Choose Cash or Credit payment.'; end if;
  if normalized_payment_type = 'credit' and customer_id_input is null then raise exception 'Select a customer for a credit sale.'; end if;
  if customer_id_input is not null and not exists (select 1 from public.customers where customer_id = customer_id_input and branch_id = target_branch_id and status = 'Active') then raise exception 'Choose an active customer from the selected branch.'; end if;
  if discount_input is null or discount_input < 0 then raise exception 'Enter a valid discount.'; end if;
  insert into public.sales(sale_id, branch_id, customer_id, total, payment_type, discount, cash_tendered, change, created_by)
  values(sale_id_value, target_branch_id, customer_id_input, 0, normalized_payment_type, discount_input, 0, 0, auth.uid());
  for line in select value from jsonb_array_elements(sale_lines) loop
    product_id_value := trim(line ->> 'productId'); requested_qty := nullif(trim(line ->> 'qty'), '')::numeric;
    select product_type, bundle_price into product_type_value, bundle_price_value from public.products where product_id = product_id_value and archived_at is null;
    if not found or requested_qty is null or requested_qty <= 0 then raise exception 'Enter valid sale quantities.'; end if;
    insert into public.sale_items(sale_id, product_id, qty, price) values(sale_id_value, product_id_value, requested_qty, 0) returning sale_item_id into sale_item_id_value;
    if product_type_value = 'bundle' then
      if bundle_price_value is null or not exists(select 1 from public.product_bundle_components where bundle_product_id = product_id_value) then raise exception 'This bundle needs a price and at least one component.'; end if;
      for component_row in select * from public.product_bundle_components where bundle_product_id = product_id_value loop
        component_qty := component_row.qty * requested_qty;
        select qty into available_qty from public.inventory where branch_id = target_branch_id and product_id = component_row.component_product_id for update;
        if not found or available_qty < component_qty then raise exception 'Insufficient component stock for bundle %.', product_id_value; end if;
        remaining_qty := component_qty;
        for batch_row in select * from public.inventory_cost_batches where branch_id = target_branch_id and product_id = component_row.component_product_id and qty_remaining > 0 order by is_opening desc, received_at, batch_id for update loop
          allocated_qty := least(remaining_qty, batch_row.qty_remaining);
          update public.inventory_cost_batches set qty_remaining = qty_remaining - allocated_qty where batch_id = batch_row.batch_id;
          insert into public.sale_bundle_component_allocations(sale_item_id, component_product_id, batch_id, qty, unit_cost, cost_total)
          values(sale_item_id_value, component_row.component_product_id, batch_row.batch_id, allocated_qty, batch_row.unit_cost, case when batch_row.unit_cost is null then null else allocated_qty * batch_row.unit_cost end);
          remaining_qty := remaining_qty - allocated_qty; exit when remaining_qty <= 0;
        end loop;
        if remaining_qty > 0 then raise exception 'FIFO batches are incomplete for a bundle component.'; end if;
        update public.inventory set qty = qty - component_qty where branch_id = target_branch_id and product_id = component_row.component_product_id;
      end loop;
      line_total := requested_qty * bundle_price_value;
      update public.sale_items set price = bundle_price_value where sale_item_id = sale_item_id_value;
    else
      select qty into available_qty from public.inventory where branch_id = target_branch_id and product_id = product_id_value for update;
      if not found or available_qty < requested_qty then raise exception 'Insufficient stock for one or more items.'; end if;
      remaining_qty := requested_qty; line_total := 0;
      for batch_row in select * from public.inventory_cost_batches where branch_id = target_branch_id and product_id = product_id_value and qty_remaining > 0 order by is_opening desc, received_at, batch_id for update loop
        if batch_row.selling_price is null then raise exception 'A selling price is missing from an available stock batch.'; end if;
        allocated_qty := least(remaining_qty, batch_row.qty_remaining);
        update public.inventory_cost_batches set qty_remaining = qty_remaining - allocated_qty where batch_id = batch_row.batch_id;
        insert into public.sale_item_price_allocations(sale_item_id, batch_id, qty, selling_price, line_total) values(sale_item_id_value, batch_row.batch_id, allocated_qty, batch_row.selling_price, allocated_qty * batch_row.selling_price);
        line_total := line_total + allocated_qty * batch_row.selling_price; remaining_qty := remaining_qty - allocated_qty; exit when remaining_qty <= 0;
      end loop;
      if remaining_qty > 0 then raise exception 'Selling-price batches are incomplete for this product.'; end if;
      update public.sale_items set price = line_total / requested_qty where sale_item_id = sale_item_id_value;
      update public.inventory set qty = qty - requested_qty where branch_id = target_branch_id and product_id = product_id_value;
    end if;
    subtotal_value := subtotal_value + line_total;
  end loop;
  if discount_input > subtotal_value then raise exception 'Enter a valid discount.'; end if;
  total_value := subtotal_value - discount_input;
  if normalized_payment_type = 'cash' then
    if cash_tendered_input is null or cash_tendered_input < total_value then raise exception 'Cash tendered must cover the sale total.'; end if;
    change_value := cash_tendered_input - total_value;
  else cash_tendered_input := 0; end if;
  update public.sales set total = total_value, cash_tendered = cash_tendered_input, change = change_value where sale_id = sale_id_value;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Recorded bundle-aware FIFO sale', sale_id_value, total_value::text);
  return jsonb_build_object('saleId', sale_id_value, 'subtotal', subtotal_value, 'total', total_value, 'discount', discount_input, 'cashTendered', cash_tendered_input, 'change', change_value, 'paymentType', normalized_payment_type, 'date', now());
end;
$$;

revoke all on function public.record_sale(text, jsonb, text, text, numeric, numeric) from public;
grant execute on function public.record_sale(text, jsonb, text, text, numeric, numeric) to authenticated;
