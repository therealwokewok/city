-- Emailed bills: one row per bill that was emailed, so a bill is never sent twice.
create table bill_emails (
  bill_id uuid primary key references bills(id),
  city_id uuid not null references cities(id),
  sent_to integer not null check (sent_to > 0),
  sent_at timestamptz not null default now()
);
alter table bill_emails enable row level security;
alter table bill_emails force row level security;
create policy be_sel on bill_emails for select using (city_id = app_city() and app_perm('runs.read'));
create policy be_ins on bill_emails for insert with check (city_id = app_city() and app_perm('runs.manage'));
grant select, insert on bill_emails to utilities_app;

-- Who gets the bill by email: signed-in people linked to a paperless account. Staff never see the addresses.
create function bill_email_targets(p_run uuid) returns table (bill_id uuid, email text, account_number text, name text, total_cents bigint, lines jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if not app_perm('runs.manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select b.id, u.email, a.account_number, a.name, b.total_cents::bigint, b.lines
    from bills b
    join accounts a on a.id = b.account_id and a.city_id = b.city_id
    join account_links l on l.account_id = a.id
    join users u on u.id = l.user_id and u.active
    where b.run_id = p_run and b.city_id = app_city() and b.status = 'posted' and a.paperless
      and not exists (select 1 from bill_emails e where e.bill_id = b.id)
    order by a.account_number;
end $$;
revoke all on function bill_email_targets(uuid) from public;
grant execute on function bill_email_targets(uuid) to utilities_app;

-- Shutoff and reconnect work orders. Field staff see the address and the note, never names or balances.
create table work_orders (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  account_id uuid not null references accounts(id),
  kind text not null check (kind in ('shutoff','reconnect')),
  status text not null default 'open' check (status in ('open','done','cancelled')),
  address text not null,
  note text not null default '' check (length(note) <= 500),
  created_by uuid not null references users(id),
  completed_by uuid references users(id),
  completion_note text not null default '' check (length(completion_note) <= 500),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index work_orders_one_open on work_orders (account_id, kind) where status = 'open';
alter table work_orders enable row level security;
alter table work_orders force row level security;
create policy wo_sel on work_orders for select using (city_id = app_city() and (app_perm('accounts.read') or app_perm('workorders.field')));
create policy wo_ins on work_orders for insert with check (city_id = app_city() and app_perm('runs.manage') and created_by = app_user());
create policy wo_upd on work_orders for update using (city_id = app_city() and (app_perm('runs.manage') or app_perm('workorders.field')))
  with check (city_id = app_city());
grant select, insert on work_orders to utilities_app;
grant update (status, completed_by, completion_note, completed_at) on work_orders to utilities_app;

-- Only a field worker can mark an order done, and must record themselves; the office can only cancel.
create function guard_work_order() returns trigger language plpgsql as $$
begin
  if new.status = 'done' and old.status = 'open' then
    if not app_perm('workorders.field') or new.completed_by is distinct from app_user() then
      raise exception 'only field staff can complete a work order' using errcode = '42501';
    end if;
  end if;
  if old.status <> 'open' then raise exception 'that order is already closed' using errcode = '42501'; end if;
  return new;
end $$;
create trigger work_orders_guard before update on work_orders for each row execute function guard_work_order();
