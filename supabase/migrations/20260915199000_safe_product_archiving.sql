-- Preserve receipt, sale, and transfer history when a used product is removed
-- from the active catalog.
alter table public.products add column if not exists archived_at timestamptz;

create or replace function public.delete_product(target_product_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare has_history boolean;
begin
  if not public.is_admin() then raise exception 'Administrator access is required.'; end if;
  if not exists (select 1 from public.products where product_id = target_product_id and archived_at is null) then raise exception 'Product not found.'; end if;

  select exists (
    select 1 from public.stock_ins where product_id = target_product_id
    union all select 1 from public.sale_items where product_id = target_product_id
    union all select 1 from public.stock_transfers where product_id = target_product_id
  ) into has_history;

  if has_history then
    update public.products set status = 'Inactive', archived_at = now() where product_id = target_product_id;
    update public.branch_products set status = 'Inactive' where product_id = target_product_id;
    insert into public.account_audit (actor_id, action, target_id, details)
    values (auth.uid(), 'Archived product', target_product_id, 'Historical inventory or sale records retained');
    return jsonb_build_object('productId', target_product_id, 'archived', true);
  end if;

  delete from public.inventory where product_id = target_product_id;
  delete from public.branch_products where product_id = target_product_id;
  delete from public.products where product_id = target_product_id;
  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Deleted product', target_product_id, 'No transaction history');
  return jsonb_build_object('productId', target_product_id, 'archived', false);
end;
$$;

revoke all on function public.delete_product(text) from public;
grant execute on function public.delete_product(text) to authenticated;
