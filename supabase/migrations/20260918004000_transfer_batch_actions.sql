create or replace function public.process_transfer_batch(target_batch_id text, batch_action text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare transfer_row public.stock_transfers; action_value text := lower(trim(batch_action)); line_count integer := 0;
begin
  if action_value not in ('dispatch', 'receive', 'cancel') then raise exception 'Choose a valid transfer action.'; end if;
  if not exists(select 1 from public.stock_transfers where transfer_batch_id = target_batch_id) then raise exception 'Transfer batch not found.'; end if;
  for transfer_row in select * from public.stock_transfers where transfer_batch_id = target_batch_id order by transfer_id for update loop
    if action_value = 'dispatch' then perform public.dispatch_transfer(transfer_row.transfer_id);
    elsif action_value = 'receive' then perform public.receive_transfer(transfer_row.transfer_id);
    else perform public.cancel_transfer(transfer_row.transfer_id);
    end if;
    line_count := line_count + 1;
  end loop;
  insert into public.account_audit(actor_id, action, target_id, details) values(auth.uid(), initcap(action_value) || ' transfer batch', target_batch_id, line_count::text || ' component lines');
  return jsonb_build_object('batchId', target_batch_id, 'action', action_value, 'lineCount', line_count);
end;
$$;

revoke all on function public.process_transfer_batch(text, text) from public;
grant execute on function public.process_transfer_batch(text, text) to authenticated;
