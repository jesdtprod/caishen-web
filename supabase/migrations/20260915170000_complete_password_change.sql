-- Clear the staff first-login password requirement after a successful Auth password update.

create or replace function public.complete_own_password_change()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in is required.';
  end if;

  update public.profiles
  set must_change_password = false
  where user_id = auth.uid() and status = 'Active';

  if not found then
    raise exception 'Your account is unavailable.';
  end if;

  insert into public.account_audit (actor_id, action, target_id, details)
  values (auth.uid(), 'Changed own password', auth.uid()::text, '');
end;
$$;

revoke all on function public.complete_own_password_change() from public;
grant execute on function public.complete_own_password_change() to authenticated;
