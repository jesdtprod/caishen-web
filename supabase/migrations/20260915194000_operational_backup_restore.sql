-- Transactional restore of operational data. Authentication accounts, profiles,
-- and audit history intentionally remain outside the backup payload.

create or replace function public.restore_pos_backup(backup jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if backup is null or backup ->> 'schemaVersion' <> '1' or jsonb_typeof(backup -> 'tables') <> 'object' then
    raise exception 'This is not a valid FR Merchandise POS backup file.';
  end if;

  delete from public.credit_payments;
  delete from public.sale_items;
  delete from public.sales;
  delete from public.stock_transfers;
  delete from public.stock_ins;
  delete from public.inventory;
  delete from public.customers;
  delete from public.branch_products;
  delete from public.products;

  insert into public.branches (branch_id, name, type, address, status, created_at)
  select branch_id, name, type, address, status, created_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'branches', '[]'::jsonb))
    as row(branch_id text, name text, type text, address text, status text, created_at timestamptz)
  on conflict (branch_id) do update
  set name = excluded.name, type = excluded.type, address = excluded.address, status = excluded.status;

  insert into public.products (product_id, name, unit, price, category, sku, low_stock_level, status, created_at, updated_at)
  select product_id, name, unit, price, category, sku, low_stock_level, status, created_at, updated_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'products', '[]'::jsonb))
    as row(product_id text, name text, unit text, price numeric, category text, sku text, low_stock_level numeric, status text, created_at timestamptz, updated_at timestamptz);

  insert into public.branch_products (branch_id, product_id, price_override, low_stock_level, status, created_at, updated_at)
  select branch_id, product_id, price_override, low_stock_level, status, created_at, updated_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'branchProducts', '[]'::jsonb))
    as row(branch_id text, product_id text, price_override numeric, low_stock_level numeric, status text, created_at timestamptz, updated_at timestamptz);

  insert into public.customers (customer_id, branch_id, name, phone, address, status, created_at, updated_at)
  select customer_id, branch_id, name, phone, address, status, created_at, updated_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'customers', '[]'::jsonb))
    as row(customer_id text, branch_id text, name text, phone text, address text, status text, created_at timestamptz, updated_at timestamptz);

  insert into public.inventory (branch_id, product_id, qty, updated_at)
  select branch_id, product_id, qty, updated_at
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'inventory', '[]'::jsonb))
    as row(branch_id text, product_id text, qty numeric, updated_at timestamptz);

  insert into public.stock_ins (stock_in_id, branch_id, product_id, qty, occurred_at, status, created_by)
  select stock_in_id, branch_id, product_id, qty, occurred_at, status, created_by
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'stockIns', '[]'::jsonb))
    as row(stock_in_id text, branch_id text, product_id text, qty numeric, occurred_at timestamptz, status text, created_by uuid);

  insert into public.stock_transfers (transfer_id, source_branch_id, destination_branch_id, product_id, qty, status, created_at, dispatched_at, received_at, cancelled_at, notes, created_by)
  select transfer_id, source_branch_id, destination_branch_id, product_id, qty, status, created_at, dispatched_at, received_at, cancelled_at, notes, created_by
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'stockTransfers', '[]'::jsonb))
    as row(transfer_id text, source_branch_id text, destination_branch_id text, product_id text, qty numeric, status text, created_at timestamptz, dispatched_at timestamptz, received_at timestamptz, cancelled_at timestamptz, notes text, created_by uuid);

  insert into public.sales (sale_id, branch_id, occurred_at, customer_id, total, payment_type, status, discount, cash_tendered, change, created_by)
  select sale_id, branch_id, occurred_at, customer_id, total, payment_type, status, discount, cash_tendered, change, created_by
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'sales', '[]'::jsonb))
    as row(sale_id text, branch_id text, occurred_at timestamptz, customer_id text, total numeric, payment_type text, status text, discount numeric, cash_tendered numeric, change numeric, created_by uuid);

  insert into public.sale_items (sale_item_id, sale_id, product_id, qty, price)
  select sale_item_id, sale_id, product_id, qty, price
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'saleItems', '[]'::jsonb))
    as row(sale_item_id uuid, sale_id text, product_id text, qty numeric, price numeric);

  insert into public.credit_payments (payment_id, branch_id, sale_id, customer_id, amount, occurred_at, notes, created_by)
  select payment_id, branch_id, sale_id, customer_id, amount, occurred_at, notes, created_by
  from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'creditPayments', '[]'::jsonb))
    as row(payment_id text, branch_id text, sale_id text, customer_id text, amount numeric, occurred_at timestamptz, notes text, created_by uuid);

  return jsonb_build_object('restoredAt', now());
end;
$$;

revoke all on function public.restore_pos_backup(jsonb) from public;
