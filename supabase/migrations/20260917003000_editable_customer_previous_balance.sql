-- A previous balance is optional customer data from before this POS went live.
alter table public.customer_credit_accounts drop constraint if exists customer_credit_accounts_source_type_check;
alter table public.customer_credit_accounts add constraint customer_credit_accounts_source_type_check check (source_type in ('opening_balance', 'previous_balance'));
update public.customer_credit_accounts set source_type = 'previous_balance' where source_type = 'opening_balance';
alter table public.customer_credit_accounts add constraint customer_credit_accounts_one_source_per_customer unique (customer_id, source_type);

create or replace function public.create_customer_with_previous_balance(
  target_branch_id text, customer_name_input text, customer_phone_input text default '', customer_address_input text default '',
  customer_status_input text default 'Active', previous_balance_input numeric default 0
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare customer_id_value text := public.new_pos_id('CUS'); credit_account_id_value text; previous_balance numeric := coalesce(previous_balance_input, 0);
begin
  if not public.has_permission('customers') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if length(trim(coalesce(customer_name_input, ''))) = 0 then raise exception 'Customer name is required.'; end if;
  if previous_balance < 0 then raise exception 'Enter a valid previous balance.'; end if;
  if previous_balance > 0 and not public.has_permission('credits') then raise exception 'Your account does not have access to record a previous balance.'; end if;
  insert into public.customers (customer_id, branch_id, name, phone, address, status)
  values (customer_id_value, target_branch_id, trim(customer_name_input), coalesce(trim(customer_phone_input), ''), coalesce(trim(customer_address_input), ''), case when customer_status_input = 'Inactive' then 'Inactive' else 'Active' end);
  if previous_balance > 0 then
    credit_account_id_value := public.new_pos_id('PBA');
    insert into public.customer_credit_accounts (credit_account_id, branch_id, customer_id, source_type, original_amount, migration_reference, created_by)
    values (credit_account_id_value, target_branch_id, customer_id_value, 'previous_balance', previous_balance, 'Previous balance at POS start', auth.uid());
    insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Recorded customer previous balance', credit_account_id_value, customer_id_value || ': ' || previous_balance::text);
  else
    insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Created customer', customer_id_value, '');
  end if;
  return jsonb_build_object('customerId', customer_id_value, 'previousBalance', previous_balance, 'creditAccountId', credit_account_id_value);
end;
$$;

create or replace function public.update_customer_with_previous_balance(
  target_branch_id text, target_customer_id text, customer_name_input text, customer_phone_input text default '', customer_address_input text default '',
  customer_status_input text default 'Active', previous_balance_input numeric default 0
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare account_row public.customer_credit_accounts; account_id_value text; paid_total numeric := 0; previous_balance numeric := coalesce(previous_balance_input, 0); has_previous_account boolean := false;
begin
  if not public.has_permission('customers') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if length(trim(coalesce(customer_name_input, ''))) = 0 then raise exception 'Customer name is required.'; end if;
  if previous_balance < 0 then raise exception 'Enter a valid previous balance.'; end if;
  if not exists (select 1 from public.customers where customer_id = target_customer_id and branch_id = target_branch_id) then raise exception 'Customer not found in the selected branch.'; end if;
  select * into account_row from public.customer_credit_accounts where customer_id = target_customer_id and branch_id = target_branch_id and source_type = 'previous_balance' for update;
  has_previous_account := found;
  if has_previous_account then
    account_id_value := account_row.credit_account_id;
    select coalesce(sum(amount), 0) into paid_total from public.credit_payments where credit_account_id = account_id_value;
  end if;
  if (previous_balance > 0 or has_previous_account) and not public.has_permission('credits') then raise exception 'Your account does not have access to edit a previous balance.'; end if;
  if previous_balance < paid_total then raise exception 'Previous balance cannot be less than payments already recorded.'; end if;
  update public.customers set name = trim(customer_name_input), phone = coalesce(trim(customer_phone_input), ''), address = coalesce(trim(customer_address_input), ''), status = case when customer_status_input = 'Inactive' then 'Inactive' else 'Active' end where customer_id = target_customer_id and branch_id = target_branch_id;
  if has_previous_account then
    if previous_balance = 0 then
      delete from public.customer_credit_accounts where credit_account_id = account_id_value;
    else
      update public.customer_credit_accounts set original_amount = previous_balance, migration_reference = 'Previous balance updated' where credit_account_id = account_id_value;
    end if;
  elsif previous_balance > 0 then
    account_id_value := public.new_pos_id('PBA');
    insert into public.customer_credit_accounts (credit_account_id, branch_id, customer_id, source_type, original_amount, migration_reference, created_by)
    values (account_id_value, target_branch_id, target_customer_id, 'previous_balance', previous_balance, 'Previous balance added after customer creation', auth.uid());
  end if;
  insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Updated customer previous balance', target_customer_id, previous_balance::text);
  return jsonb_build_object('customerId', target_customer_id, 'previousBalance', previous_balance, 'creditAccountId', account_id_value);
end;
$$;

revoke all on function public.create_customer_with_previous_balance(text, text, text, text, text, numeric) from public;
grant execute on function public.create_customer_with_previous_balance(text, text, text, text, text, numeric) to authenticated;
revoke all on function public.update_customer_with_previous_balance(text, text, text, text, text, text, numeric) from public;
grant execute on function public.update_customer_with_previous_balance(text, text, text, text, text, text, numeric) to authenticated;
