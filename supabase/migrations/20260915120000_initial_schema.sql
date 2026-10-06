-- FR Merchandise POS: initial Supabase data model.
-- Apply through the Supabase SQL Editor before importing Google Sheets data.

create extension if not exists pgcrypto;

create table public.branches (
  branch_id text primary key,
  name text not null check (length(trim(name)) > 0),
  type text not null check (type in ('Main', 'Satellite')),
  address text not null default '',
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at timestamptz not null default now()
);

create unique index branches_one_main_branch
  on public.branches (type)
  where type = 'Main';

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) > 0),
  username text not null unique,
  role text not null check (role in ('admin', 'staff')),
  branch_id text references public.branches(branch_id),
  permissions text[] not null default '{}',
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  must_change_password boolean not null default false,
  last_login_at timestamptz,
  password_reset_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (role = 'admin' and branch_id is null)
    or (role = 'staff' and branch_id is not null)
  ),
  check (permissions <@ array['pos', 'products', 'inventory', 'transfers', 'customers', 'credits', 'sales', 'inventoryReports'])
);

create table public.account_audit (
  audit_id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(user_id) on delete set null,
  action text not null,
  target_id text not null,
  details text not null default '',
  created_at timestamptz not null default now()
);

create table public.products (
  product_id text primary key,
  name text not null check (length(trim(name)) > 0),
  unit text not null check (length(trim(unit)) > 0),
  price numeric(12, 2) not null check (price >= 0),
  category text not null check (length(trim(category)) > 0),
  sku text not null unique,
  low_stock_level numeric(12, 3) not null default 5 check (low_stock_level >= 0),
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.branch_products (
  branch_id text not null references public.branches(branch_id),
  product_id text not null references public.products(product_id),
  price_override numeric(12, 2) check (price_override is null or price_override >= 0),
  low_stock_level numeric(12, 3) check (low_stock_level is null or low_stock_level >= 0),
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (branch_id, product_id)
);

create table public.customers (
  customer_id text primary key,
  branch_id text not null references public.branches(branch_id),
  name text not null check (length(trim(name)) > 0),
  phone text not null default '',
  address text not null default '',
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index customers_branch_id_idx on public.customers (branch_id);

create table public.inventory (
  branch_id text not null references public.branches(branch_id),
  product_id text not null references public.products(product_id),
  qty numeric(12, 3) not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (branch_id, product_id)
);

create table public.stock_ins (
  stock_in_id text primary key,
  branch_id text not null references public.branches(branch_id),
  product_id text not null references public.products(product_id),
  qty numeric(12, 3) not null check (qty > 0),
  occurred_at timestamptz not null default now(),
  status text not null default 'Completed' check (status in ('Completed', 'Cancelled')),
  created_by uuid references public.profiles(user_id) on delete set null
);

create index stock_ins_branch_occurred_at_idx on public.stock_ins (branch_id, occurred_at desc);

create table public.stock_transfers (
  transfer_id text primary key,
  source_branch_id text not null references public.branches(branch_id),
  destination_branch_id text not null references public.branches(branch_id),
  product_id text not null references public.products(product_id),
  qty numeric(12, 3) not null check (qty > 0),
  status text not null default 'Draft' check (status in ('Draft', 'In Transit', 'Received', 'Cancelled')),
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  notes text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null,
  check (source_branch_id <> destination_branch_id)
);

create index stock_transfers_source_branch_idx on public.stock_transfers (source_branch_id, created_at desc);
create index stock_transfers_destination_branch_idx on public.stock_transfers (destination_branch_id, created_at desc);

create table public.sales (
  sale_id text primary key,
  branch_id text not null references public.branches(branch_id),
  occurred_at timestamptz not null default now(),
  customer_id text references public.customers(customer_id),
  total numeric(12, 2) not null check (total >= 0),
  payment_type text not null check (payment_type in ('cash', 'credit')),
  status text not null default 'completed' check (status in ('completed', 'cancelled')),
  discount numeric(12, 2) not null default 0 check (discount >= 0),
  cash_tendered numeric(12, 2) not null default 0 check (cash_tendered >= 0),
  change numeric(12, 2) not null default 0 check (change >= 0),
  created_by uuid references public.profiles(user_id) on delete set null,
  check ((payment_type = 'credit' and customer_id is not null) or payment_type = 'cash')
);

create index sales_branch_occurred_at_idx on public.sales (branch_id, occurred_at desc);

create table public.sale_items (
  sale_item_id uuid primary key default gen_random_uuid(),
  sale_id text not null references public.sales(sale_id) on delete restrict,
  product_id text not null references public.products(product_id),
  qty numeric(12, 3) not null check (qty > 0),
  price numeric(12, 2) not null check (price >= 0)
);

create index sale_items_sale_id_idx on public.sale_items (sale_id);
create index sale_items_product_id_idx on public.sale_items (product_id);

create table public.credit_payments (
  payment_id text primary key,
  branch_id text not null references public.branches(branch_id),
  sale_id text not null references public.sales(sale_id) on delete restrict,
  customer_id text not null references public.customers(customer_id),
  amount numeric(12, 2) not null check (amount > 0),
  occurred_at timestamptz not null default now(),
  notes text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null
);

create index credit_payments_sale_id_idx on public.credit_payments (sale_id);
create index credit_payments_branch_occurred_at_idx on public.credit_payments (branch_id, occurred_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger products_set_updated_at before update on public.products
for each row execute function public.set_updated_at();
create trigger branch_products_set_updated_at before update on public.branch_products
for each row execute function public.set_updated_at();
create trigger customers_set_updated_at before update on public.customers
for each row execute function public.set_updated_at();
create trigger inventory_set_updated_at before update on public.inventory
for each row execute function public.set_updated_at();

alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.account_audit enable row level security;
alter table public.products enable row level security;
alter table public.branch_products enable row level security;
alter table public.customers enable row level security;
alter table public.inventory enable row level security;
alter table public.stock_ins enable row level security;
alter table public.stock_transfers enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.credit_payments enable row level security;

-- RLS policies are added with the authenticated API functions in the next migration.
-- Until then, no client role can read or mutate these tables.
