alter table public.stock_transfers add column if not exists transfer_batch_id text;
create index if not exists stock_transfers_batch_idx on public.stock_transfers(transfer_batch_id) where transfer_batch_id is not null;

create or replace function public.create_transfer_batch(
  source_branch_id_input text, destination_branch_id_input text, transfer_lines jsonb, transfer_notes text default ''
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare line jsonb; component record; product_row public.products; product_id_value text; qty_value numeric; required_qty numeric;
  required_components jsonb := '{}'::jsonb; batch_id_value text := public.new_pos_id('TRB'); transfer_id_value text; created_lines jsonb := '[]'::jsonb;
begin
  if not public.has_permission('transfers') or not public.can_access_branch(source_branch_id_input) then raise exception 'Your account does not have access to this action.'; end if;
  perform public.assert_active_branch(source_branch_id_input); perform public.assert_active_branch(destination_branch_id_input);
  if source_branch_id_input = destination_branch_id_input then raise exception 'Choose a different destination branch.'; end if;
  if jsonb_typeof(transfer_lines) <> 'array' or jsonb_array_length(transfer_lines) = 0 then raise exception 'Add at least one product to the transfer.'; end if;

  for line in select value from jsonb_array_elements(transfer_lines) loop
    product_id_value := trim(line ->> 'productId'); qty_value := nullif(line ->> 'qty', '')::numeric;
    if product_id_value = '' or qty_value is null or qty_value <= 0 then raise exception 'Enter valid transfer products and quantities.'; end if;
    select * into product_row from public.products where product_id = product_id_value and archived_at is null;
    if not found or not exists (select 1 from public.branch_products where branch_id = source_branch_id_input and product_id = product_id_value and status = 'Active') then raise exception 'Choose an active source-branch product.'; end if;
    if product_row.product_type = 'bundle' then
      if not exists (select 1 from public.product_bundle_components where bundle_product_id = product_id_value) then raise exception 'This bundle has no components.'; end if;
      for component in select * from public.product_bundle_components where bundle_product_id = product_id_value loop
        required_qty := coalesce((required_components ->> component.component_product_id)::numeric, 0) + component.qty * qty_value;
        required_components := jsonb_set(required_components, array[component.component_product_id], to_jsonb(required_qty));
      end loop;
      insert into public.branch_products(branch_id, product_id, price_override, low_stock_level, status)
      values(destination_branch_id_input, product_id_value, product_row.bundle_price, product_row.low_stock_level, 'Active')
      on conflict (branch_id, product_id) do update set status = 'Active';
    else
      required_qty := coalesce((required_components ->> product_id_value)::numeric, 0) + qty_value;
      required_components := jsonb_set(required_components, array[product_id_value], to_jsonb(required_qty));
    end if;
  end loop;

  for product_id_value in select key from jsonb_each(required_components) loop
    required_qty := (required_components ->> product_id_value)::numeric;
    if coalesce((select qty from public.inventory where branch_id = source_branch_id_input and product_id = product_id_value), 0) < required_qty then
      raise exception 'Insufficient source stock for one or more transfer lines.';
    end if;
  end loop;

  for line in select value from jsonb_array_elements(transfer_lines) loop
    product_id_value := trim(line ->> 'productId'); qty_value := (line ->> 'qty')::numeric;
    select * into product_row from public.products where product_id = product_id_value;
    if product_row.product_type = 'bundle' then
      for component in select * from public.product_bundle_components where bundle_product_id = product_id_value loop
        transfer_id_value := public.new_pos_id('TRF');
        insert into public.stock_transfers(transfer_id, transfer_batch_id, source_branch_id, destination_branch_id, product_id, qty, notes, created_by)
        values(transfer_id_value, batch_id_value, source_branch_id_input, destination_branch_id_input, component.component_product_id, component.qty * qty_value, 'Bundle: ' || product_row.name || coalesce(' - ' || nullif(transfer_notes, ''), ''), auth.uid());
        created_lines := created_lines || jsonb_build_array(jsonb_build_object('transferId', transfer_id_value, 'productId', component.component_product_id, 'qty', component.qty * qty_value));
      end loop;
    else
      transfer_id_value := public.new_pos_id('TRF');
      insert into public.stock_transfers(transfer_id, transfer_batch_id, source_branch_id, destination_branch_id, product_id, qty, notes, created_by)
      values(transfer_id_value, batch_id_value, source_branch_id_input, destination_branch_id_input, product_id_value, qty_value, coalesce(transfer_notes, ''), auth.uid());
      created_lines := created_lines || jsonb_build_array(jsonb_build_object('transferId', transfer_id_value, 'productId', product_id_value, 'qty', qty_value));
    end if;
  end loop;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), 'Created multi-line stock transfer', batch_id_value, transfer_lines::text);
  return jsonb_build_object('batchId', batch_id_value, 'transfers', created_lines);
end;
$$;

revoke all on function public.create_transfer_batch(text, text, jsonb, text) from public;
grant execute on function public.create_transfer_batch(text, text, jsonb, text) to authenticated;
