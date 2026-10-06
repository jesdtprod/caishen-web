-- Opening balances are migration receivables, never sales or inventory activity.
create table public.customer_credit_accounts (
  credit_account_id text primary key,
  branch_id text not null references public.branches(branch_id),
  customer_id text not null references public.customers(customer_id) on delete cascade,
  source_type text not null default 'opening_balance' check (source_type = 'opening_balance'),
  original_amount numeric(12, 2) not null check (original_amount > 0),
  migration_reference text not null check (length(trim(migration_reference)) > 0),
  occurred_at timestamptz not null default now(),
  created_by uuid references public.profiles(user_id) on delete set null
);
create index customer_credit_accounts_branch_idx on public.customer_credit_accounts (branch_id, occurred_at desc);
alter table public.customer_credit_accounts enable row level security;
create policy "users read branch opening credit accounts" on public.customer_credit_accounts for select to authenticated using (public.can_access_branch(branch_id));

alter table public.credit_payments alter column sale_id drop not null;
alter table public.credit_payments add column credit_account_id text references public.customer_credit_accounts(credit_account_id) on delete restrict;
alter table public.credit_payments add constraint credit_payments_one_credit_source check ((sale_id is null) <> (credit_account_id is null));
create index credit_payments_credit_account_id_idx on public.credit_payments (credit_account_id);

create or replace function public.create_customer_with_opening_balance(
  target_branch_id text, customer_name_input text, customer_phone_input text default '', customer_address_input text default '',
  customer_status_input text default 'Active', opening_balance_input numeric default 0, migration_reference_input text default ''
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare customer_id_value text := public.new_pos_id('CUS'); credit_account_id_value text; opening_balance numeric := coalesce(opening_balance_input, 0);
begin
  if not public.has_permission('customers') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if length(trim(coalesce(customer_name_input, ''))) = 0 then raise exception 'Customer name is required.'; end if;
  if opening_balance < 0 then raise exception 'Enter a valid opening credit balance.'; end if;
  if opening_balance > 0 and not public.has_permission('credits') then raise exception 'Your account does not have access to record opening credit.'; end if;
  if opening_balance > 0 and length(trim(coalesce(migration_reference_input, ''))) = 0 then raise exception 'Enter a migration reference for the opening credit balance.'; end if;
  insert into public.customers (customer_id, branch_id, name, phone, address, status)
  values (customer_id_value, target_branch_id, trim(customer_name_input), coalesce(trim(customer_phone_input), ''), coalesce(trim(customer_address_input), ''), case when customer_status_input = 'Inactive' then 'Inactive' else 'Active' end);
  if opening_balance > 0 then
    credit_account_id_value := public.new_pos_id('OBA');
    insert into public.customer_credit_accounts (credit_account_id, branch_id, customer_id, original_amount, migration_reference, created_by)
    values (credit_account_id_value, target_branch_id, customer_id_value, opening_balance, trim(migration_reference_input), auth.uid());
    insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Recorded customer opening credit balance', credit_account_id_value, customer_id_value || ': ' || opening_balance::text || ' - ' || trim(migration_reference_input));
  else
    insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Created customer', customer_id_value, '');
  end if;
  return jsonb_build_object('customerId', customer_id_value, 'openingBalance', opening_balance, 'creditAccountId', credit_account_id_value);
end;
$$;

create or replace function public.record_credit_payment(target_branch_id text, target_sale_id text, payment_amount numeric, payment_notes text default '')
returns jsonb language plpgsql security definer set search_path = public
as $$
declare payment_id_value text := public.new_pos_id('CPY'); credit_total numeric(12,2); credit_customer_id text; paid_total numeric(12,2); balance_value numeric(12,2); is_opening_balance boolean := false;
begin
  if not public.has_permission('credits') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if payment_amount is null or payment_amount <= 0 then raise exception 'Enter a payment amount greater than zero.'; end if;
  select original_amount, customer_id into credit_total, credit_customer_id from public.customer_credit_accounts where credit_account_id = target_sale_id and branch_id = target_branch_id for update;
  is_opening_balance := found;
  if not is_opening_balance then
    select total, customer_id into credit_total, credit_customer_id from public.sales where sale_id = target_sale_id and branch_id = target_branch_id and payment_type = 'credit' for update;
    if not found then raise exception 'Credit account not found in the selected branch.'; end if;
  end if;
  select coalesce(sum(amount), 0) into paid_total from public.credit_payments where (is_opening_balance and credit_account_id = target_sale_id) or (not is_opening_balance and sale_id = target_sale_id);
  balance_value := credit_total - paid_total;
  if payment_amount > balance_value then raise exception 'Payment cannot exceed the outstanding balance.'; end if;
  if is_opening_balance then
    insert into public.credit_payments (payment_id, branch_id, credit_account_id, customer_id, amount, notes, created_by) values (payment_id_value, target_branch_id, target_sale_id, credit_customer_id, payment_amount, coalesce(payment_notes, ''), auth.uid());
  else
    insert into public.credit_payments (payment_id, branch_id, sale_id, customer_id, amount, notes, created_by) values (payment_id_value, target_branch_id, target_sale_id, credit_customer_id, payment_amount, coalesce(payment_notes, ''), auth.uid());
  end if;
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Recorded credit payment', payment_id_value, target_sale_id || ': ' || payment_amount::text);
  return jsonb_build_object('paymentId', payment_id_value, 'creditId', target_sale_id, 'balance', balance_value - payment_amount);
end;
$$;

create or replace function public.delete_credit_payment(target_branch_id text, target_payment_id text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare credit_id_value text;
begin
  if not public.has_permission('credits') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  select coalesce(credit_account_id, sale_id) into credit_id_value from public.credit_payments where payment_id = target_payment_id and branch_id = target_branch_id for update;
  if not found then raise exception 'Credit payment not found in the selected branch.'; end if;
  delete from public.credit_payments where payment_id = target_payment_id;
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Deleted credit payment', target_payment_id, credit_id_value);
  return jsonb_build_object('paymentId', target_payment_id);
end;
$$;

revoke all on function public.create_customer_with_opening_balance(text, text, text, text, text, numeric, text) from public;
grant execute on function public.create_customer_with_opening_balance(text, text, text, text, text, numeric, text) to authenticated;

-- Keep opening receivables in the operational backup without treating them as sales.
create or replace function public.restore_pos_backup(backup jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  if backup is null or backup ->> 'schemaVersion' <> '1' or jsonb_typeof(backup -> 'tables') <> 'object' then raise exception 'This is not a valid FR Merchandise POS backup file.'; end if;
  delete from public.credit_payments where true;
  delete from public.sale_items where true;
  delete from public.sales where true;
  delete from public.stock_transfers where true;
  delete from public.stock_ins where true;
  delete from public.inventory where true;
  delete from public.customers where true;
  delete from public.branch_products where true;
  delete from public.products where true;
  insert into public.branches (branch_id, name, type, address, status, created_at)
  select branch_id, name, type, address, status, created_at from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'branches', '[]'::jsonb)) as row(branch_id text, name text, type text, address text, status text, created_at timestamptz)
  on conflict (branch_id) do update set name = excluded.name, type = excluded.type, address = excluded.address, status = excluded.status;
  insert into public.products (product_id, name, unit, price, category, sku, low_stock_level, status, created_at, updated_at)
  select product_id, name, unit, price, category, sku, low_stock_level, status, created_at, updated_at from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'products', '[]'::jsonb)) as row(product_id text, name text, unit text, price numeric, category text, sku text, low_stock_level numeric, status text, created_at timestamptz, updated_at timestamptz);
  insert into public.branch_products (branch_id, product_id, price_override, low_stock_level, status, created_at, updated_at)
  select branch_id, product_id, price_override, low_stock_level, status, created_at, updated_at from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'branchProducts', '[]'::jsonb)) as row(branch_id text, product_id text, price_override numeric, low_stock_level numeric, status text, created_at timestamptz, updated_at timestamptz);
  insert into public.customers (customer_id, branch_id, name, phone, address, status, created_at, updated_at)
  select customer_id, branch_id, name, phone, address, status, created_at, updated_at from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'customers', '[]'::jsonb)) as row(customer_id text, branch_id text, name text, phone text, address text, status text, created_at timestamptz, updated_at timestamptz);
  insert into public.inventory (branch_id, product_id, qty, updated_at)
  select branch_id, product_id, qty, updated_at from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'inventory', '[]'::jsonb)) as row(branch_id text, product_id text, qty numeric, updated_at timestamptz);
  insert into public.stock_ins (stock_in_id, branch_id, product_id, qty, occurred_at, status, created_by)
  select stock_in_id, branch_id, product_id, qty, occurred_at, status, created_by from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'stockIns', '[]'::jsonb)) as row(stock_in_id text, branch_id text, product_id text, qty numeric, occurred_at timestamptz, status text, created_by uuid);
  insert into public.stock_transfers (transfer_id, source_branch_id, destination_branch_id, product_id, qty, status, created_at, dispatched_at, received_at, cancelled_at, notes, created_by)
  select transfer_id, source_branch_id, destination_branch_id, product_id, qty, status, created_at, dispatched_at, received_at, cancelled_at, notes, created_by from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'stockTransfers', '[]'::jsonb)) as row(transfer_id text, source_branch_id text, destination_branch_id text, product_id text, qty numeric, status text, created_at timestamptz, dispatched_at timestamptz, received_at timestamptz, cancelled_at timestamptz, notes text, created_by uuid);
  insert into public.sales (sale_id, branch_id, occurred_at, customer_id, total, payment_type, status, discount, cash_tendered, change, created_by)
  select sale_id, branch_id, occurred_at, customer_id, total, payment_type, status, discount, cash_tendered, change, created_by from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'sales', '[]'::jsonb)) as row(sale_id text, branch_id text, occurred_at timestamptz, customer_id text, total numeric, payment_type text, status text, discount numeric, cash_tendered numeric, change numeric, created_by uuid);
  insert into public.sale_items (sale_item_id, sale_id, product_id, qty, price)
  select sale_item_id, sale_id, product_id, qty, price from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'saleItems', '[]'::jsonb)) as row(sale_item_id uuid, sale_id text, product_id text, qty numeric, price numeric);
  if jsonb_typeof(backup -> 'tables' -> 'customerCreditAccounts') = 'array' then
    insert into public.customer_credit_accounts (credit_account_id, branch_id, customer_id, source_type, original_amount, migration_reference, occurred_at, created_by)
    select credit_account_id, branch_id, customer_id, coalesce(source_type, 'opening_balance'), original_amount, migration_reference, occurred_at, created_by from jsonb_to_recordset(backup -> 'tables' -> 'customerCreditAccounts') as row(credit_account_id text, branch_id text, customer_id text, source_type text, original_amount numeric, migration_reference text, occurred_at timestamptz, created_by uuid);
  end if;
  insert into public.credit_payments (payment_id, branch_id, sale_id, credit_account_id, customer_id, amount, occurred_at, notes, created_by)
  select payment_id, branch_id, sale_id, credit_account_id, customer_id, amount, occurred_at, notes, created_by from jsonb_to_recordset(coalesce(backup -> 'tables' -> 'creditPayments', '[]'::jsonb)) as row(payment_id text, branch_id text, sale_id text, credit_account_id text, customer_id text, amount numeric, occurred_at timestamptz, notes text, created_by uuid);
  return jsonb_build_object('restoredAt', now());
end;
$$;
