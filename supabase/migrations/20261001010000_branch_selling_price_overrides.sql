-- Persistent catalog override for future sales in one branch.
-- Existing sales retain their recorded sale_items.price values unchanged.
alter table public.branch_products
  add column if not exists selling_price_override numeric(12,2)
  check (selling_price_override is null or selling_price_override >= 0);

comment on column public.branch_products.selling_price_override is
  'Optional branch product selling-price override. FIFO stock allocation remains unchanged.';
