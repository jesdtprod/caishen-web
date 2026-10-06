-- Opening balances represent a customer's prior unpaid balance when this POS starts.
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
  if opening_balance > 0 and length(trim(coalesce(migration_reference_input, ''))) = 0 then raise exception 'Enter a previous balance reference.'; end if;
  insert into public.customers (customer_id, branch_id, name, phone, address, status)
  values (customer_id_value, target_branch_id, trim(customer_name_input), coalesce(trim(customer_phone_input), ''), coalesce(trim(customer_address_input), ''), case when customer_status_input = 'Inactive' then 'Inactive' else 'Active' end);
  if opening_balance > 0 then
    credit_account_id_value := public.new_pos_id('OBA');
    insert into public.customer_credit_accounts (credit_account_id, branch_id, customer_id, original_amount, migration_reference, created_by)
    values (credit_account_id_value, target_branch_id, customer_id_value, opening_balance, trim(migration_reference_input), auth.uid());
    insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Recorded customer opening balance', credit_account_id_value, customer_id_value || ': ' || opening_balance::text || ' - ' || trim(migration_reference_input));
  else
    insert into public.account_audit (actor_id, action, target_id, details) values (auth.uid(), 'Created customer', customer_id_value, '');
  end if;
  return jsonb_build_object('customerId', customer_id_value, 'openingBalance', opening_balance, 'creditAccountId', credit_account_id_value);
end;
$$;
