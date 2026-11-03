-- Service requests: a resident asks to start, stop, move or report a leak. Staff work them from a queue.
-- A request never changes money. Deposits and final charges go through the normal charge and approval screens.
create table service_requests (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  requested_by uuid not null references users(id),
  account_id uuid references accounts(id),
  kind text not null check (kind in ('start', 'stop', 'move_out', 'transfer', 'leak')),
  requested_date date,
  service_address text check (service_address is null or length(service_address) between 1 and 300),
  forwarding_address text check (forwarding_address is null or length(forwarding_address) between 1 and 300),
  contact_name text check (contact_name is null or length(contact_name) between 1 and 120),
  phone text check (phone is null or length(phone) between 1 and 40),
  note text check (note is null or length(note) <= 2000),
  status text not null default 'open' check (status in ('open', 'scheduled', 'done', 'declined')),
  resolution text check (resolution is null or length(resolution) <= 1000),
  handled_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- only a new-service request can come without an account
  constraint sr_account_needed check (kind = 'start' or account_id is not null),
  constraint sr_start_needs check (kind <> 'start' or (service_address is not null and contact_name is not null and requested_date is not null)),
  constraint sr_transfer_needs check (kind <> 'transfer' or (service_address is not null and requested_date is not null)),
  constraint sr_moveout_needs check (kind <> 'move_out' or (forwarding_address is not null and requested_date is not null)),
  constraint sr_stop_needs check (kind <> 'stop' or requested_date is not null),
  constraint sr_leak_needs check (kind <> 'leak' or (note is not null and length(note) > 0)),
  constraint sr_decline_needs_reason check (status <> 'declined' or (resolution is not null and length(resolution) > 0))
);
create index service_requests_city_status on service_requests (city_id, status, created_at);

alter table service_requests enable row level security;
alter table service_requests force row level security;
create policy sr_sel on service_requests for select
  using (city_id = app_city() and (app_perm('requests.review') or requested_by = app_user()));
create policy sr_ins on service_requests for insert
  with check (city_id = app_city() and requested_by = app_user() and status = 'open'
    and (account_id is null or exists (select 1 from account_links l where l.account_id = service_requests.account_id and l.user_id = app_user())));
create policy sr_upd on service_requests for update
  using (city_id = app_city() and app_perm('requests.review'))
  with check (city_id = app_city());

grant select, insert on service_requests to utilities_app;
grant update (status, resolution, handled_by, updated_at) on service_requests to utilities_app;
