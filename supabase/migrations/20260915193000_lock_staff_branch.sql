-- A staff member's first assigned branch is permanent so records and access
-- remain associated with the branch where the account was created.

create or replace function public.prevent_staff_branch_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.role = 'staff' and new.branch_id is distinct from old.branch_id then
    raise exception 'A staff account cannot be moved to another branch.';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_staff_branch_change on public.profiles;
create trigger profiles_prevent_staff_branch_change
before update on public.profiles
for each row execute function public.prevent_staff_branch_change();
