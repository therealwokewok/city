-- Payment plans ("payment arrangements"). A resident or staff member asks; a different person at the city decides.
-- While an approved plan is on track, the account is kept off the shutoff list and its older bills get no late charge.
create table payment_arrangements (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  account_id uuid not null references accounts(id),
  requested_by uuid not null references users(id),
  by_staff boolean not null default false,
  reason text not null check (length(reason) between 1 and 1000),
  total_cents bigint not null check (total_cents > 0),
  installments int not null check (installments between 2 and 24),
  first_due date not null,
  status text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  created_at timestamptz not null default now(),
  check (decided_by is null or decided_by <> requested_by)
);
create unique index payment_arrangements_one_open on payment_arrangements (account_id) where status in ('pending','approved');
alter table payment_arrangements enable row level security;
alter table payment_arrangements force row level security;
create policy pa_sel on payment_arrangements for select using (city_id = app_city() and (app_perm('accounts.read')
  or exists (select 1 from account_links l where l.account_id = payment_arrangements.account_id and l.user_id = app_user())));
create policy pa_ins on payment_arrangements for insert with check (city_id = app_city() and requested_by = app_user()
  and status = 'pending' and decided_by is null and (app_perm('accounts.manage')
  or exists (select 1 from account_links l where l.account_id = payment_arrangements.account_id and l.user_id = app_user())));
-- Deciding needs arrangements.decide. Anyone else who can see the plan may only cancel it.
create policy pa_upd on payment_arrangements for update using (city_id = app_city() and (app_perm('arrangements.decide')
  or app_perm('accounts.manage')
  or exists (select 1 from account_links l where l.account_id = payment_arrangements.account_id and l.user_id = app_user())))
  with check (city_id = app_city() and (app_perm('arrangements.decide') or (status in ('pending','cancelled') and decided_by is null)));
grant select, insert on payment_arrangements to utilities_app;
grant update (status, installments, first_due, decided_by, decided_at, decision_note) on payment_arrangements to utilities_app;

-- Fixing a wrong meter reading. The money part goes through the normal approval; the reading itself is only
-- changed once that approval is given, so a declined fix leaves everything as it was.
create table reading_corrections (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  reading_id uuid not null references readings(id),
  old_value numeric not null,
  new_value numeric not null check (new_value >= 0),
  reason text not null check (length(reason) between 1 and 1000),
  amount_cents bigint not null default 0,
  approval_id uuid references approvals(id),
  status text not null default 'pending' check (status in ('pending','applied','rejected')),
  requested_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create unique index reading_corrections_one_open on reading_corrections (reading_id) where status = 'pending';
alter table reading_corrections enable row level security;
alter table reading_corrections force row level security;
create policy rc_sel on reading_corrections for select using (city_id = app_city() and app_perm('accounts.read'));
create policy rc_ins on reading_corrections for insert with check (city_id = app_city() and app_perm('runs.manage') and requested_by = app_user());
create policy rc_upd on reading_corrections for update using (city_id = app_city() and (app_perm('approvals.decide') or app_perm('runs.manage')))
  with check (city_id = app_city());
grant select, insert on reading_corrections to utilities_app;
grant update (status, applied_at) on reading_corrections to utilities_app;
grant update (value, usage, note) on readings to utilities_app;
