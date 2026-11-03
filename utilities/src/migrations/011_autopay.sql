-- Autopay. We keep only the processor's opaque references (customer and payment method ids) and a short label such as
-- "Visa ending 4242". Card and bank numbers never reach this server or this database.
create table autopay_enrollments (
  account_id uuid primary key references accounts(id),
  city_id uuid not null references cities(id),
  customer_ref text not null,
  method_ref text not null,
  label text not null default 'Saved payment method' check (length(label) <= 80),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table autopay_attempts (
  bill_id uuid primary key references bills(id),
  city_id uuid not null references cities(id),
  payment_id uuid not null references payments(id),
  created_at timestamptz not null default now()
);
alter table autopay_enrollments enable row level security;
alter table autopay_enrollments force row level security;
alter table autopay_attempts enable row level security;
alter table autopay_attempts force row level security;
create policy ae_sel on autopay_enrollments for select using (city_id = app_city() and (app_perm('accounts.read')
  or exists (select 1 from account_links l where l.account_id = autopay_enrollments.account_id and l.user_id = app_user())));
create policy ae_ins on autopay_enrollments for insert with check (city_id = app_city() and app_perm('payments.settle'));
create policy ae_upd on autopay_enrollments for update using (city_id = app_city() and (app_perm('payments.settle')
  or exists (select 1 from account_links l where l.account_id = autopay_enrollments.account_id and l.user_id = app_user())))
  with check (city_id = app_city());
create policy aa_sel on autopay_attempts for select using (city_id = app_city() and app_perm('accounts.read'));
create policy aa_ins on autopay_attempts for insert with check (city_id = app_city() and app_perm('payments.settle'));
grant select, insert on autopay_enrollments, autopay_attempts to utilities_app;
grant update (active, customer_ref, method_ref, label) on autopay_enrollments to utilities_app;
