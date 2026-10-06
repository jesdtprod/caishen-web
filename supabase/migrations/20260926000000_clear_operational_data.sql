-- Reset operational POS records without changing branches, administrators, or staff accounts.
create or replace function public.clear_operational_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.';
  end if;

  truncate table
    public.credit_payments,
    public.customer_credit_accounts,
    public.sale_return_replacement_allocations,
    public.inventory_return_lots,
    public.sale_return_items,
    public.sale_returns,
    public.sale_bundle_component_allocations,
    public.sale_item_price_allocations,
    public.sale_item_cost_allocations,
    public.sale_items,
    public.sales,
    public.inventory_quarantine_items,
    public.inventory_quarantine_cases,
    public.transfer_batch_allocations,
    public.stock_transfers,
    public.stock_ins,
    public.inventory_cost_batches,
    public.inventory,
    public.product_bundle_components,
    public.branch_products,
    public.products,
    public.customers
  restart identity;

  insert into public.account_audit(actor_id, action, target_id, details)
    values(auth.uid(), 'Cleared operational data', '', 'Branches and account profiles were preserved.');

  return jsonb_build_object('cleared', true);
end;
$$;

revoke all on function public.clear_operational_data() from public;
grant execute on function public.clear_operational_data() to authenticated;
