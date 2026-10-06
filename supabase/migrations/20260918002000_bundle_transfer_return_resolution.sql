create or replace function public.create_bundle_transfer(
  source_branch_id_input text, destination_branch_id_input text, bundle_product_id_input text,
  bundle_qty numeric, transfer_notes text default ''
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare component record; component_transfer_id text; results jsonb := '[]'::jsonb;
begin
  if not public.has_permission('transfers') or not public.can_access_branch(source_branch_id_input) then raise exception 'Your account does not have access to this action.'; end if;
  if source_branch_id_input = destination_branch_id_input or bundle_qty is null or bundle_qty <= 0 then raise exception 'Enter a valid bundle transfer.'; end if;
  if not exists(select 1 from public.products where product_id = bundle_product_id_input and product_type = 'bundle') then raise exception 'Bundle product not found.'; end if;
  for component in select * from public.product_bundle_components where bundle_product_id = bundle_product_id_input loop
    select public.new_pos_id('TRF') into component_transfer_id;
    if coalesce((select qty from public.inventory where branch_id = source_branch_id_input and product_id = component.component_product_id), 0) < component.qty * bundle_qty then
      raise exception 'Insufficient component stock for this bundle transfer.';
    end if;
    insert into public.stock_transfers(transfer_id, source_branch_id, destination_branch_id, product_id, qty, notes, created_by)
    values(component_transfer_id, source_branch_id_input, destination_branch_id_input, component.component_product_id, component.qty * bundle_qty, 'Bundle ' || bundle_product_id_input || ': ' || coalesce(transfer_notes, ''), auth.uid());
    results := results || jsonb_build_array(jsonb_build_object('transferId', component_transfer_id, 'productId', component.component_product_id, 'qty', component.qty * bundle_qty));
  end loop;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Created bundle component transfers', bundle_product_id_input, bundle_qty::text);
  return jsonb_build_object('bundleProductId', bundle_product_id_input, 'qty', bundle_qty, 'componentTransfers', results);
end;
$$;

create or replace function public.resolve_sale_return_financially(target_return_id text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare r public.sale_returns; s public.sales; open_balance numeric;
begin
  select * into r from public.sale_returns where return_id = target_return_id for update;
  if not found then raise exception 'Return not found.'; end if;
  select * into s from public.sales where sale_id = r.original_sale_id for update;
  if not public.has_permission('pos') or not public.can_access_branch(r.branch_id) then raise exception 'Your account does not have access to this action.'; end if;
  if r.return_type <> 'refund' then raise exception 'This return is not a refund.'; end if;
  if r.refund_amount <= 0 or r.refund_amount > s.total then raise exception 'Enter a valid refund amount.'; end if;
  if s.payment_type = 'credit' then
    select greatest(s.total - coalesce(sum(amount), 0), 0) into open_balance from public.credit_payments where sale_id = s.sale_id;
    if r.refund_amount > open_balance then raise exception 'Refund exceeds the outstanding credit balance.'; end if;
    insert into public.credit_payments(payment_id, branch_id, sale_id, customer_id, amount, notes, created_by)
    values(public.new_pos_id('CPY'), r.branch_id, s.sale_id, s.customer_id, r.refund_amount, 'Refund adjustment: ' || r.return_id, auth.uid());
  end if;
  update public.sale_returns set status = 'Refunded', resolved_at = now() where return_id = r.return_id;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Resolved sale refund', r.return_id, r.refund_amount::text);
  return jsonb_build_object('returnId', r.return_id, 'status', 'Refunded', 'refundAmount', r.refund_amount);
end;
$$;

revoke all on function public.create_bundle_transfer(text, text, text, numeric, text) from public;
grant execute on function public.create_bundle_transfer(text, text, text, numeric, text) to authenticated;
revoke all on function public.resolve_sale_return_financially(text) from public;
grant execute on function public.resolve_sale_return_financially(text) to authenticated;
