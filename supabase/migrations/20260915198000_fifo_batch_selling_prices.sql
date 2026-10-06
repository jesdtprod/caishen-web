-- Selling prices belong to received FIFO batches. The old unit_cost column is
-- retained for historical compatibility but is no longer used to price sales.
alter table public.stock_ins add column if not exists selling_price numeric(12, 2);
alter table public.inventory_cost_batches add column if not exists selling_price numeric(12, 2);
alter table public.stock_ins drop constraint if exists stock_ins_selling_price_nonnegative;
alter table public.inventory_cost_batches drop constraint if exists inventory_cost_batches_selling_price_nonnegative;
alter table public.stock_ins add constraint stock_ins_selling_price_nonnegative check (selling_price is null or selling_price >= 0);
alter table public.inventory_cost_batches add constraint inventory_cost_batches_selling_price_nonnegative check (selling_price is null or selling_price >= 0);

create table if not exists public.sale_item_price_allocations (
  allocation_id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references public.sale_items(sale_item_id) on delete cascade,
  batch_id uuid not null references public.inventory_cost_batches(batch_id) on delete restrict,
  qty numeric(12, 3) not null check (qty > 0),
  selling_price numeric(12, 2) not null check (selling_price >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0)
);
create index if not exists sale_item_price_allocations_sale_item_idx on public.sale_item_price_allocations (sale_item_id);
alter table public.sale_item_price_allocations enable row level security;
drop policy if exists "users read permitted sale price allocations" on public.sale_item_price_allocations;
create policy "users read permitted sale price allocations" on public.sale_item_price_allocations for select to authenticated using (public.can_access_sale((select sale_id from public.sale_items where sale_item_id = sale_item_price_allocations.sale_item_id)));

-- Existing stock becomes an opening FIFO batch at the price currently visible
-- in its branch. Existing recorded receipt values are preserved as batch prices.
update public.stock_ins as receipt
set selling_price = coalesce(receipt.selling_price, receipt.unit_cost, branch_product.price_override, product.price)
from public.branch_products as branch_product
join public.products as product on product.product_id = branch_product.product_id
where branch_product.branch_id = receipt.branch_id and branch_product.product_id = receipt.product_id
  and receipt.selling_price is null;

update public.inventory_cost_batches as batch
set selling_price = coalesce(
  batch.selling_price,
  (select receipt.selling_price from public.stock_ins as receipt where receipt.stock_in_id = batch.stock_in_id),
  branch_product.price_override,
  product.price
)
from public.branch_products as branch_product
join public.products as product on product.product_id = branch_product.product_id
where branch_product.branch_id = batch.branch_id and branch_product.product_id = batch.product_id
  and batch.selling_price is null;

drop policy if exists "users read permitted selling price batches" on public.inventory_cost_batches;
create policy "users read permitted selling price batches" on public.inventory_cost_batches for select to authenticated using (public.can_access_branch(branch_id));

create or replace function public.get_branch_selling_price_batches(target_branch_id text)
returns table(product_id text, qty_remaining numeric, selling_price numeric, received_at timestamptz, batch_id uuid)
language sql stable security definer set search_path = public
as $$
  select batch.product_id, batch.qty_remaining, batch.selling_price, batch.received_at, batch.batch_id
  from public.inventory_cost_batches batch
  where public.can_access_branch(target_branch_id)
    and batch.branch_id = target_branch_id and batch.qty_remaining > 0
  order by batch.product_id, batch.is_opening desc, batch.received_at, batch.batch_id;
$$;

drop function if exists public.stock_in(text, text, numeric, numeric, text);
create function public.stock_in(
  target_branch_id text, target_product_id text, quantity numeric,
  selling_price_input numeric, supplier_reference_input text default ''
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare stock_in_id_value text := public.new_pos_id('STK');
begin
  if not public.has_permission('inventory') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if quantity is null or quantity <= 0 then raise exception 'Quantity must be greater than zero.'; end if;
  if selling_price_input is null or selling_price_input < 0 then raise exception 'Enter a valid selling price.'; end if;
  if not exists (select 1 from public.branch_products where branch_id = target_branch_id and product_id = target_product_id and status = 'Active') then raise exception 'Register an active product in the selected branch before stocking it.'; end if;
  insert into public.inventory (branch_id, product_id, qty) values (target_branch_id, target_product_id, quantity)
  on conflict (branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
  insert into public.stock_ins (stock_in_id, branch_id, product_id, qty, selling_price, supplier_reference, created_by)
  values (stock_in_id_value, target_branch_id, target_product_id, quantity, selling_price_input, coalesce(trim(supplier_reference_input), ''), auth.uid());
  insert into public.inventory_cost_batches (branch_id, product_id, stock_in_id, selling_price, qty_received, qty_remaining, created_by)
  values (target_branch_id, target_product_id, stock_in_id_value, selling_price_input, quantity, quantity, auth.uid());
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Recorded stock in selling price', stock_in_id_value, target_product_id || ': ' || quantity::text || ' at ' || selling_price_input::text);
  return jsonb_build_object('stockInId', stock_in_id_value, 'productId', target_product_id, 'qty', quantity, 'sellingPrice', selling_price_input);
end;
$$;

create or replace function public.record_sale(
  target_branch_id text, sale_lines jsonb, payment_type_input text,
  customer_id_input text default null, discount_input numeric default 0, cash_tendered_input numeric default 0
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare sale_id_value text := public.new_pos_id('SAL'); sale_item_id_value uuid; line jsonb; batch_row public.inventory_cost_batches;
  product_id_value text; requested_qty numeric; available_qty numeric; remaining_qty numeric; allocated_qty numeric;
  line_total numeric(12,2); subtotal_value numeric(12,2) := 0; total_value numeric(12,2); change_value numeric(12,2) := 0; normalized_payment_type text := lower(trim(payment_type_input));
begin
  if not public.has_permission('pos') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if jsonb_typeof(sale_lines) <> 'array' or jsonb_array_length(sale_lines) = 0 then raise exception 'The sale has no items.'; end if;
  if normalized_payment_type not in ('cash', 'credit') then raise exception 'Choose Cash or Credit payment.'; end if;
  if customer_id_input is not null and not exists (select 1 from public.customers where customer_id = customer_id_input and branch_id = target_branch_id and status = 'Active') then raise exception 'Choose an active customer from the selected branch.'; end if;
  if normalized_payment_type = 'credit' and customer_id_input is null then raise exception 'Select a customer for a credit sale.'; end if;
  if discount_input is null or discount_input < 0 then raise exception 'Enter a valid discount.'; end if;
  insert into public.sales (sale_id, branch_id, customer_id, total, payment_type, discount, cash_tendered, change, created_by)
  values (sale_id_value, target_branch_id, customer_id_input, 0, normalized_payment_type, discount_input, 0, 0, auth.uid());
  for line in select value from jsonb_array_elements(sale_lines) as item(value) loop
    product_id_value := trim(line ->> 'productId'); requested_qty := nullif(trim(line ->> 'qty'), '')::numeric;
    select qty into available_qty from public.inventory where branch_id = target_branch_id and product_id = product_id_value for update;
    if not found or requested_qty is null or requested_qty <= 0 or available_qty < requested_qty then raise exception 'Insufficient stock for one or more items.'; end if;
    remaining_qty := requested_qty; line_total := 0;
    insert into public.sale_items (sale_id, product_id, qty, price) values (sale_id_value, product_id_value, requested_qty, 0) returning sale_item_id into sale_item_id_value;
    for batch_row in select * from public.inventory_cost_batches where branch_id = target_branch_id and product_id = product_id_value and qty_remaining > 0 order by is_opening desc, received_at, batch_id for update loop
      if batch_row.selling_price is null then raise exception 'A selling price is missing from an available stock batch.'; end if;
      allocated_qty := least(remaining_qty, batch_row.qty_remaining);
      update public.inventory_cost_batches set qty_remaining = qty_remaining - allocated_qty where batch_id = batch_row.batch_id;
      insert into public.sale_item_price_allocations (sale_item_id, batch_id, qty, selling_price, line_total) values (sale_item_id_value, batch_row.batch_id, allocated_qty, batch_row.selling_price, allocated_qty * batch_row.selling_price);
      line_total := line_total + allocated_qty * batch_row.selling_price; remaining_qty := remaining_qty - allocated_qty; exit when remaining_qty <= 0;
    end loop;
    if remaining_qty > 0 then raise exception 'Selling-price batches are incomplete for this product.'; end if;
    update public.sale_items set price = line_total / requested_qty where sale_item_id = sale_item_id_value;
    update public.inventory set qty = qty - requested_qty where branch_id = target_branch_id and product_id = product_id_value;
    subtotal_value := subtotal_value + line_total;
  end loop;
  if discount_input > subtotal_value then raise exception 'Enter a valid discount.'; end if;
  total_value := subtotal_value - discount_input;
  if normalized_payment_type = 'cash' then if cash_tendered_input is null or cash_tendered_input < total_value then raise exception 'Cash tendered must cover the sale total.'; end if; change_value := cash_tendered_input - total_value; else cash_tendered_input := 0; end if;
  update public.sales set total = total_value, cash_tendered = cash_tendered_input, change = change_value where sale_id = sale_id_value;
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Recorded FIFO batch-price sale', sale_id_value, total_value::text);
  return jsonb_build_object('saleId', sale_id_value, 'subtotal', subtotal_value, 'total', total_value, 'discount', discount_input, 'cashTendered', cash_tendered_input, 'change', change_value, 'paymentType', normalized_payment_type, 'date', now());
end;
$$;

revoke all on function public.get_branch_selling_price_batches(text) from public;
grant execute on function public.get_branch_selling_price_batches(text) to authenticated;
revoke all on function public.stock_in(text, text, numeric, numeric, text) from public;
grant execute on function public.stock_in(text, text, numeric, numeric, text) to authenticated;
revoke all on function public.record_sale(text, jsonb, text, text, numeric, numeric) from public;
grant execute on function public.record_sale(text, jsonb, text, text, numeric, numeric) to authenticated;
