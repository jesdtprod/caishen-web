create or replace function public.restore_pos_backup_daily_operations(backup jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Administrator access is required.'; end if;
  perform public.restore_pos_backup_bundles(backup);

  if jsonb_typeof(backup -> 'tables' -> 'dailySpotCash') = 'array' then
    delete from public.daily_spot_cash;
    insert into public.daily_spot_cash(spot_cash_id, branch_id, business_date, opening_cash, notes, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by)
    select spot_cash_id, branch_id, business_date, opening_cash, notes, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by
    from jsonb_to_recordset(backup -> 'tables' -> 'dailySpotCash') as row(spot_cash_id uuid, branch_id text, business_date date, opening_cash numeric, notes text, created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid, deleted_at timestamptz, deleted_by uuid);
  end if;

  if jsonb_typeof(backup -> 'tables' -> 'dailyExpenses') = 'array' then
    delete from public.daily_expenses;
    insert into public.daily_expenses(expense_id, branch_id, business_date, category, description, amount, receipt_reference, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by)
    select expense_id, branch_id, business_date, category, description, amount, receipt_reference, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by
    from jsonb_to_recordset(backup -> 'tables' -> 'dailyExpenses') as row(expense_id uuid, branch_id text, business_date date, category text, description text, amount numeric, receipt_reference text, created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid, deleted_at timestamptz, deleted_by uuid);
  end if;

  return jsonb_build_object('restored', true, 'schemaVersion', '2');
end;
$$;

revoke all on function public.restore_pos_backup_daily_operations(jsonb) from public;
grant execute on function public.restore_pos_backup_daily_operations(jsonb) to authenticated;
