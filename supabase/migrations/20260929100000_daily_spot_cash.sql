-- Branch-specific opening cash records with auditable soft deletion.
alter table public.profiles drop constraint if exists profiles_permissions_check;
alter table public.profiles add constraint profiles_permissions_check
  check (permissions <@ array['pos', 'products', 'inventory', 'transfers', 'customers', 'credits', 'sales', 'inventoryReports', 'dailySpotCash']);

create table public.daily_spot_cash (
  spot_cash_id uuid primary key default gen_random_uuid(),
  branch_id text not null references public.branches(branch_id),
  business_date date not null,
  opening_cash numeric(12,2) not null check (opening_cash >= 0),
  notes text not null default '',
  created_at timestamptz not null default now(), created_by uuid not null references public.profiles(user_id),
  updated_at timestamptz not null default now(), updated_by uuid not null references public.profiles(user_id),
  deleted_at timestamptz, deleted_by uuid references public.profiles(user_id)
);
create unique index daily_spot_cash_one_active_per_branch_day on public.daily_spot_cash(branch_id, business_date) where deleted_at is null;
alter table public.daily_spot_cash enable row level security;
create policy "daily spot cash users read permitted active rows" on public.daily_spot_cash for select to authenticated using (deleted_at is null and public.has_permission('dailySpotCash') and public.can_access_branch(branch_id));

create or replace function public.create_daily_spot_cash(target_branch_id text, target_business_date date, opening_cash_input numeric, notes_input text default '') returns public.daily_spot_cash language plpgsql security definer set search_path = public as $$
declare result public.daily_spot_cash;
begin
  if not public.has_permission('dailySpotCash') or not public.can_access_branch(target_branch_id) then raise exception 'Your account does not have access to Daily Spot Cash.'; end if;
  perform public.assert_active_branch(target_branch_id);
  if target_business_date is null or opening_cash_input is null or opening_cash_input < 0 then raise exception 'Enter a valid business date and non-negative opening cash.'; end if;
  insert into public.daily_spot_cash(branch_id,business_date,opening_cash,notes,created_by,updated_by) values(target_branch_id,target_business_date,opening_cash_input,coalesce(trim(notes_input),''),auth.uid(),auth.uid()) returning * into result;
  insert into public.account_audit(actor_id,action,target_id,details) values(auth.uid(),'Created daily spot cash',result.spot_cash_id::text,result.branch_id || ' / ' || result.business_date::text || ' / ' || result.opening_cash::text);
  return result;
end; $$;
create or replace function public.update_daily_spot_cash(target_spot_cash_id uuid, target_business_date date, opening_cash_input numeric, notes_input text default '') returns public.daily_spot_cash language plpgsql security definer set search_path = public as $$
declare result public.daily_spot_cash;
begin
  select * into result from public.daily_spot_cash where spot_cash_id=target_spot_cash_id and deleted_at is null for update;
  if not found then raise exception 'Daily Spot Cash record not found.'; end if;
  if not public.has_permission('dailySpotCash') or not public.can_access_branch(result.branch_id) then raise exception 'Your account does not have access to Daily Spot Cash.'; end if;
  if target_business_date is null or opening_cash_input is null or opening_cash_input < 0 then raise exception 'Enter a valid business date and non-negative opening cash.'; end if;
  update public.daily_spot_cash set business_date=target_business_date,opening_cash=opening_cash_input,notes=coalesce(trim(notes_input),''),updated_at=now(),updated_by=auth.uid() where spot_cash_id=target_spot_cash_id returning * into result;
  insert into public.account_audit(actor_id,action,target_id,details) values(auth.uid(),'Updated daily spot cash',result.spot_cash_id::text,result.branch_id || ' / ' || result.business_date::text || ' / ' || result.opening_cash::text);
  return result;
end; $$;
create or replace function public.delete_daily_spot_cash(target_spot_cash_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare result public.daily_spot_cash;
begin
  select * into result from public.daily_spot_cash where spot_cash_id=target_spot_cash_id and deleted_at is null for update;
  if not found then raise exception 'Daily Spot Cash record not found.'; end if;
  if not public.has_permission('dailySpotCash') or not public.can_access_branch(result.branch_id) then raise exception 'Your account does not have access to Daily Spot Cash.'; end if;
  update public.daily_spot_cash set deleted_at=now(),deleted_by=auth.uid(),updated_at=now(),updated_by=auth.uid() where spot_cash_id=target_spot_cash_id;
  insert into public.account_audit(actor_id,action,target_id,details) values(auth.uid(),'Deleted daily spot cash',result.spot_cash_id::text,result.branch_id || ' / ' || result.business_date::text || ' / ' || result.opening_cash::text);
end; $$;
revoke all on function public.create_daily_spot_cash(text,date,numeric,text) from public;
revoke all on function public.update_daily_spot_cash(uuid,date,numeric,text) from public;
revoke all on function public.delete_daily_spot_cash(uuid) from public;
grant execute on function public.create_daily_spot_cash(text,date,numeric,text) to authenticated;
grant execute on function public.update_daily_spot_cash(uuid,date,numeric,text) to authenticated;
grant execute on function public.delete_daily_spot_cash(uuid) to authenticated;
