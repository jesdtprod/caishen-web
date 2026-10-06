-- Bundle returns are quarantined as their physical component lots. Resolve
-- each component independently; individual-item returns retain resolve_return_item.
alter table public.sale_return_items
  drop constraint if exists sale_return_items_condition_state_check;
alter table public.sale_return_items
  add constraint sale_return_items_condition_state_check
  check (condition_state in ('quarantine', 'restocked', 'supplier_return', 'disposed', 'mixed_resolved'));

create or replace function public.resolve_bundle_return_component(
  target_return_item_id uuid,
  target_product_id text,
  resolution text
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare item public.sale_return_items; case_row public.sale_returns; lot public.inventory_return_lots;
  price_value numeric; final_state text;
begin
  select * into item from public.sale_return_items where return_item_id = target_return_item_id for update;
  if not found then raise exception 'Return item not found.'; end if;
  if not exists (select 1 from public.products where product_id = item.product_id and product_type = 'bundle') then
    raise exception 'Component resolution is available only for bundle returns.';
  end if;
  select * into case_row from public.sale_returns where return_id = item.return_id for update;
  if not public.has_permission('inventory') or not public.can_access_branch(case_row.branch_id) then
    raise exception 'Your account does not have access to this action.';
  end if;
  if resolution not in ('restocked', 'supplier_return', 'disposed') then raise exception 'Choose a valid return resolution.'; end if;
  if not exists (
    select 1 from public.inventory_return_lots
    where return_item_id = item.return_item_id and product_id = target_product_id and state = 'quarantine'
  ) then raise exception 'This returned component has already been resolved.'; end if;

  for lot in
    select * from public.inventory_return_lots
    where return_item_id = item.return_item_id and product_id = target_product_id and state = 'quarantine'
    for update
  loop
    if resolution = 'restocked' then
      select coalesce(lot.selling_price, bp.price_override, p.price) into price_value
      from public.products p left join public.branch_products bp on bp.product_id = p.product_id and bp.branch_id = case_row.branch_id
      where p.product_id = lot.product_id;
      insert into public.inventory(branch_id, product_id, qty) values(case_row.branch_id, lot.product_id, lot.qty)
        on conflict(branch_id, product_id) do update set qty = public.inventory.qty + excluded.qty;
      insert into public.inventory_cost_batches(branch_id, product_id, unit_cost, selling_price, qty_received, qty_remaining, received_at, created_by)
      values(case_row.branch_id, lot.product_id, lot.unit_cost, price_value, lot.qty, lot.qty, now(), auth.uid());
    end if;
    update public.inventory_return_lots set state = resolution, resolved_at = now() where return_lot_id = lot.return_lot_id;
  end loop;

  if exists (select 1 from public.inventory_return_lots where return_item_id = item.return_item_id and state = 'quarantine') then
    update public.sale_return_items set condition_state = 'quarantine' where return_item_id = item.return_item_id;
  else
    select case when count(distinct state) = 1 then min(state) else 'mixed_resolved' end into final_state
    from public.inventory_return_lots where return_item_id = item.return_item_id;
    update public.sale_return_items set condition_state = final_state where return_item_id = item.return_item_id;
  end if;
  insert into public.account_audit(actor_id, action, target_id, details)
  values(auth.uid(), 'Resolved returned bundle component', case_row.return_id, resolution || ': ' || target_product_id);
  return jsonb_build_object('returnId', case_row.return_id, 'productId', target_product_id, 'resolution', resolution);
end;
$$;

revoke all on function public.resolve_bundle_return_component(uuid, text, text) from public;
grant execute on function public.resolve_bundle_return_component(uuid, text, text) to authenticated;
