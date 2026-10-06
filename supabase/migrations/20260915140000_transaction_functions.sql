-- FR Merchandise POS: atomic stock, sale, credit, and transfer operations.

create or replace function public.new_pos_id(prefix text)
returns text
language sql
volatile
as $$
  select prefix || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$$;

create or replace function public.assert_active_branch(target_branch_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.branches
    where branch_id = target_branch_id and status = 'Active'
  ) then
    raise exception 'The selected branch is unavailable.';
  end if;
end;
$$;

create or replace function public.stock_in(
  target_branch_id text,
  target_product_id text,
  quantity numeric
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
  if not exists (
    select 1 from public.branch_products
    where branch_id = target_branch_id and product_id = target_product_id
  ) then
    raise exception 'Register this product in the selected branch before stocking it.';
  end if;

  insert into public.inventory (branch_id, product_id, qty)
  values (target_branch_id, target_product_id, quantity)
  on conflict (branch_id, product_id)
  do update set qty = public.inventory.qty + excluded.qty;

  insert into public.stock_ins (stock_in_id, branch_id, product_id, qty, created_by)
  values (stock_in_id_value, target_branch_id, target_product_id, quantity, auth.uid());
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Recorded stock in', stock_in_id_value, target_product_id || ': ' || quantity::text);

  return jsonb_build_object('stockInId', stock_in_id_value, 'productId', target_product_id, 'qty', quantity);
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
  line jsonb;
  product_id_value text;
  requested_qty numeric;
  requested_price numeric;
  available_qty numeric;
  effective_price numeric;
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
    select 1
    from jsonb_array_elements(sale_lines) as item(value)
    group by trim(item.value ->> 'productId')
    having count(*) > 1
  ) then
    raise exception 'Each product can appear only once in a sale.';
  end if;
  if customer_id_input is not null and not exists (
    select 1 from public.customers
    where customer_id = customer_id_input
      and branch_id = target_branch_id
      and status = 'Active'
  ) then
    raise exception 'Choose an active customer from the selected branch.';
  end if;
  if normalized_payment_type = 'credit' and customer_id_input is null then
    raise exception 'Select a customer for a credit sale.';
  end if;
  if discount_input is null or discount_input < 0 then
    raise exception 'Enter a valid discount.';
  end if;

  for line in
    select value from jsonb_array_elements(sale_lines) as item(value)
    order by trim(value ->> 'productId')
  loop
    product_id_value := trim(line ->> 'productId');
    requested_qty := nullif(trim(line ->> 'qty'), '')::numeric;
    requested_price := case when line ? 'price' then nullif(trim(line ->> 'price'), '')::numeric else null end;

    select inventory.qty, coalesce(branch_products.price_override, products.price)
    into available_qty, effective_price
    from public.inventory
    join public.branch_products
      on branch_products.branch_id = inventory.branch_id
      and branch_products.product_id = inventory.product_id
    join public.products on products.product_id = inventory.product_id
    where inventory.branch_id = target_branch_id
      and inventory.product_id = product_id_value
      and branch_products.status = 'Active'
      and products.status = 'Active'
    for update of inventory;

    if not found or requested_qty is null or requested_qty <= 0 or available_qty < requested_qty then
      raise exception 'Insufficient stock for one or more items.';
    end if;
    if requested_price is not null then
      if requested_price < 0 then
        raise exception 'Enter a valid selling price for every item.';
      end if;
      effective_price := requested_price;
    end if;

    subtotal_value := subtotal_value + (requested_qty * effective_price);
    confirmed_lines := confirmed_lines || jsonb_build_array(jsonb_build_object(
      'productId', product_id_value,
      'qty', requested_qty,
      'price', effective_price
    ));
    update public.inventory
    set qty = qty - requested_qty
    where branch_id = target_branch_id and product_id = product_id_value;
  end loop;

  if discount_input > subtotal_value then
    raise exception 'Enter a valid discount.';
  end if;
  total_value := subtotal_value - discount_input;
  if normalized_payment_type = 'cash' then
    if cash_tendered_input is null or cash_tendered_input < total_value then
      raise exception 'Cash tendered must cover the sale total.';
    end if;
    change_value := cash_tendered_input - total_value;
  else
    cash_tendered_input := 0;
  end if;

  insert into public.sales (
    sale_id, branch_id, customer_id, total, payment_type, discount, cash_tendered, change, created_by
  ) values (
    sale_id_value, target_branch_id, customer_id_input, total_value, normalized_payment_type,
    discount_input, cash_tendered_input, change_value, auth.uid()
  );

  for line in select value from jsonb_array_elements(confirmed_lines) as item(value) loop
    product_id_value := trim(line ->> 'productId');
    requested_qty := nullif(trim(line ->> 'qty'), '')::numeric;
    requested_price := nullif(trim(line ->> 'price'), '')::numeric;
    insert into public.sale_items (sale_id, product_id, qty, price)
    values (sale_id_value, product_id_value, requested_qty, requested_price);
  end loop;

  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Recorded sale', sale_id_value, total_value::text);

  return jsonb_build_object(
    'saleId', sale_id_value, 'subtotal', subtotal_value, 'total', total_value,
    'discount', discount_input, 'cashTendered', cash_tendered_input,
    'change', change_value, 'paymentType', normalized_payment_type, 'date', now()
  );
end;
$$;

create or replace function public.record_credit_payment(
  target_branch_id text,
  target_sale_id text,
  payment_amount numeric,
  payment_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_id_value text := public.new_pos_id('CPY');
  sale_total numeric(12, 2);
  sale_customer_id text;
  paid_total numeric(12, 2);
  balance_value numeric(12, 2);
begin
  if not public.has_permission('credits') or not public.can_access_branch(target_branch_id) then
    raise exception 'Your account does not have access to this action.';
  end if;
  perform public.assert_active_branch(target_branch_id);
  if payment_amount is null or payment_amount <= 0 then
    raise exception 'Enter a payment amount greater than zero.';
  end if;

  select total, customer_id into sale_total, sale_customer_id
  from public.sales
  where sale_id = target_sale_id
    and branch_id = target_branch_id
    and payment_type = 'credit'
  for update;
  if not found then
    raise exception 'Credit sale not found in the selected branch.';
  end if;

  select coalesce(sum(amount), 0) into paid_total
  from public.credit_payments where sale_id = target_sale_id;
  balance_value := sale_total - paid_total;
  if payment_amount > balance_value then
    raise exception 'Payment cannot exceed the outstanding balance.';
  end if;

  insert into public.credit_payments (payment_id, branch_id, sale_id, customer_id, amount, notes, created_by)
  values (payment_id_value, target_branch_id, target_sale_id, sale_customer_id, payment_amount, coalesce(payment_notes, ''), auth.uid());
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Recorded credit payment', payment_id_value, target_sale_id || ': ' || payment_amount::text);

  return jsonb_build_object('paymentId', payment_id_value, 'saleId', target_sale_id, 'balance', balance_value - payment_amount);
end;
$$;

create or replace function public.delete_credit_payment(target_branch_id text, target_payment_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sale_id_value text;
begin
  if not public.has_permission('credits') or not public.can_access_branch(target_branch_id) then
    raise exception 'Your account does not have access to this action.';
  end if;
  select sale_id into sale_id_value
  from public.credit_payments
  where payment_id = target_payment_id and branch_id = target_branch_id
  for update;
  if not found then
    raise exception 'Credit payment not found in the selected branch.';
  end if;
  perform 1 from public.sales where sale_id = sale_id_value for update;
  delete from public.credit_payments where payment_id = target_payment_id;
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Deleted credit payment', target_payment_id, sale_id_value);
  return jsonb_build_object('paymentId', target_payment_id);
end;
$$;

create or replace function public.create_transfer(
  source_branch_id_input text,
  destination_branch_id_input text,
  target_product_id text,
  transfer_qty numeric,
  transfer_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  transfer_id_value text := public.new_pos_id('TRF');
begin
  if not public.has_permission('transfers') or not public.can_access_branch(source_branch_id_input) then
    raise exception 'Your account does not have access to this action.';
  end if;
  perform public.assert_active_branch(source_branch_id_input);
  perform public.assert_active_branch(destination_branch_id_input);
  if source_branch_id_input = destination_branch_id_input then
    raise exception 'Choose a different destination branch.';
  end if;
  if transfer_qty is null or transfer_qty <= 0 then
    raise exception 'Transfer quantity must be greater than zero.';
  end if;
  if not exists (select 1 from public.branch_products where branch_id = source_branch_id_input and product_id = target_product_id)
    or not exists (select 1 from public.branch_products where branch_id = destination_branch_id_input and product_id = target_product_id) then
    raise exception 'Choose a product available in both source and destination branches.';
  end if;

  insert into public.stock_transfers (
    transfer_id, source_branch_id, destination_branch_id, product_id, qty, notes, created_by
  ) values (
    transfer_id_value, source_branch_id_input, destination_branch_id_input, target_product_id,
    transfer_qty, coalesce(transfer_notes, ''), auth.uid()
  );
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Created stock transfer', transfer_id_value, target_product_id || ': ' || transfer_qty::text);
  return jsonb_build_object('id', transfer_id_value, 'status', 'Draft');
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
  available_qty numeric;
begin
  select * into transfer_row from public.stock_transfers
  where transfer_id = target_transfer_id for update;
  if not found then raise exception 'Stock transfer not found.'; end if;
  if not public.has_permission('transfers') or not public.can_access_branch(transfer_row.source_branch_id) then
    raise exception 'Your account does not have access to this action.';
  end if;
  if transfer_row.status <> 'Draft' then raise exception 'Only draft transfers can be dispatched.'; end if;

  select qty into available_qty from public.inventory
  where branch_id = transfer_row.source_branch_id and product_id = transfer_row.product_id
  for update;
  if not found or available_qty < transfer_row.qty then
    raise exception 'Insufficient source branch stock for this transfer.';
  end if;
  update public.inventory set qty = qty - transfer_row.qty
  where branch_id = transfer_row.source_branch_id and product_id = transfer_row.product_id;
  update public.stock_transfers set status = 'In Transit', dispatched_at = now()
  where transfer_id = target_transfer_id;
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Dispatched stock transfer', target_transfer_id, transfer_row.product_id);
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
begin
  select * into transfer_row from public.stock_transfers
  where transfer_id = target_transfer_id for update;
  if not found then raise exception 'Stock transfer not found.'; end if;
  if not public.has_permission('transfers') or not public.can_access_branch(transfer_row.destination_branch_id) then
    raise exception 'Your account does not have access to this action.';
  end if;
  if transfer_row.status <> 'In Transit' then raise exception 'Only in-transit transfers can be received.'; end if;

  select * into product_row from public.products where product_id = transfer_row.product_id;
  insert into public.branch_products (branch_id, product_id, price_override, low_stock_level, status)
  values (transfer_row.destination_branch_id, product_row.product_id, product_row.price, product_row.low_stock_level, 'Inactive')
  on conflict (branch_id, product_id) do nothing;
  insert into public.inventory (branch_id, product_id, qty)
  values (transfer_row.destination_branch_id, transfer_row.product_id, transfer_row.qty)
  on conflict (branch_id, product_id)
  do update set qty = public.inventory.qty + excluded.qty;
  update public.stock_transfers set status = 'Received', received_at = now()
  where transfer_id = target_transfer_id;
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Received stock transfer', target_transfer_id, transfer_row.product_id);
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
begin
  select * into transfer_row from public.stock_transfers
  where transfer_id = target_transfer_id for update;
  if not found then raise exception 'Stock transfer not found.'; end if;
  if not public.has_permission('transfers') or not public.can_access_branch(transfer_row.source_branch_id) then
    raise exception 'Your account does not have access to this action.';
  end if;
  if transfer_row.status not in ('Draft', 'In Transit') then
    raise exception 'Only draft or in-transit transfers can be cancelled.';
  end if;
  if transfer_row.status = 'In Transit' then
    insert into public.inventory (branch_id, product_id, qty)
    values (transfer_row.source_branch_id, transfer_row.product_id, transfer_row.qty)
    on conflict (branch_id, product_id)
    do update set qty = public.inventory.qty + excluded.qty;
  end if;
  update public.stock_transfers set status = 'Cancelled', cancelled_at = now()
  where transfer_id = target_transfer_id;
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Cancelled stock transfer', target_transfer_id, transfer_row.product_id);
  return jsonb_build_object('id', target_transfer_id, 'status', 'Cancelled');
end;
$$;

revoke all on function public.stock_in(text, text, numeric) from public;
revoke all on function public.record_sale(text, jsonb, text, text, numeric, numeric) from public;
revoke all on function public.record_credit_payment(text, text, numeric, text) from public;
revoke all on function public.delete_credit_payment(text, text) from public;
revoke all on function public.create_transfer(text, text, text, numeric, text) from public;
revoke all on function public.dispatch_transfer(text) from public;
revoke all on function public.receive_transfer(text) from public;
revoke all on function public.cancel_transfer(text) from public;
grant execute on function public.stock_in(text, text, numeric) to authenticated;
grant execute on function public.record_sale(text, jsonb, text, text, numeric, numeric) to authenticated;
grant execute on function public.record_credit_payment(text, text, numeric, text) to authenticated;
grant execute on function public.delete_credit_payment(text, text) to authenticated;
grant execute on function public.create_transfer(text, text, text, numeric, text) to authenticated;
grant execute on function public.dispatch_transfer(text) to authenticated;
grant execute on function public.receive_transfer(text) to authenticated;
grant execute on function public.cancel_transfer(text) to authenticated;
