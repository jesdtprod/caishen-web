-- The sales-return workflow needs the original FIFO values on quarantine lots.
-- This follow-up also repairs databases that received the initial workflow
-- migration before these two columns were included.
alter table public.inventory_return_lots
  add column if not exists unit_cost numeric(12,2),
  add column if not exists cost_total numeric(14,2);
