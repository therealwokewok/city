-- utilities: initial schema. Every table carries city_id and is protected by row-level security.
-- The application connects as role utilities_app, which cannot bypass RLS and cannot edit history.

do $$ begin
  if not exists (select from pg_roles where rolname = 'utilities_app') then
    create role utilities_app nologin;
  end if;
end $$;

-- ---------- request context helpers (set per transaction by the app) ----------
create function app_city() returns uuid language sql stable as
  $$ select nullif(current_setting('app.city_id', true), '')::uuid $$;
create function app_user() returns uuid language sql stable as
  $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create function app_perm(p text) returns boolean language sql stable as
  $$ select position(',' || p || ',' in ',' || coalesce(current_setting('app.perms', true), '') || ',') > 0 $$;

-- ---------- core ----------
create table cities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  state text not null,
  timezone text not null default 'America/Chicago',
  hosts text[] not null,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  email text not null,
  name text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login timestamptz
);
create unique index users_email on users (city_id, lower(email));

create table user_roles (
  user_id uuid not null references users(id),
  city_id uuid not null references cities(id),
  role text not null check (role in ('site_admin','city_admin','billing_clerk','cashier','meter_reader','approver','auditor','customer_service','resident')),
  granted_by uuid references users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table services (
  city_id uuid not null references cities(id),
  code text not null,
  name text not null,
  kind text not null check (kind in ('metered','flat')),
  enabled boolean not null default true,
  primary key (city_id, code)
);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  account_number text not null,
  name text not null,
  service_address text not null,
  mailing_address text,
  status text not null default 'active' check (status in ('active','closed','pending')),
  link_code_hash text,
  paperless boolean not null default false,
  created_at timestamptz not null default now(),
  unique (city_id, account_number)
);

create table account_links (
  user_id uuid not null references users(id),
  account_id uuid not null references accounts(id),
  city_id uuid not null references cities(id),
  linked_at timestamptz not null default now(),
  primary key (user_id, account_id)
);

create table link_attempts (
  id bigserial primary key,
  city_id uuid not null references cities(id),
  user_id uuid not null,
  success boolean not null,
  at timestamptz not null default now()
);

create table account_services (
  account_id uuid not null references accounts(id),
  city_id uuid not null references cities(id),
  service_code text not null,
  enabled boolean not null default true,
  primary key (account_id, service_code)
);

create table meters (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  account_id uuid not null references accounts(id),
  service_code text not null,
  serial text not null,
  location text not null default '',
  multiplier numeric not null default 1 check (multiplier > 0),
  last_value numeric,
  active boolean not null default true,
  unique (city_id, serial)
);

create table bill_runs (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  period_start date not null,
  period_end date not null,
  due_date date not null,
  status text not null default 'draft' check (status in ('draft','calculated','posted','void')),
  created_by uuid not null references users(id),
  calculated_at timestamptz,
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  check (approved_by is null or approved_by <> created_by),
  unique (city_id, period_start, period_end)
);

create table readings (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  meter_id uuid not null references meters(id),
  client_id text not null,
  value numeric not null check (value >= 0),
  usage numeric,
  read_at timestamptz not null,
  submitted_by uuid not null references users(id),
  status text not null default 'pending' check (status in ('pending','flagged','accepted','rejected')),
  note text,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  billed_run_id uuid references bill_runs(id),
  created_at timestamptz not null default now(),
  unique (city_id, client_id),
  check (reviewed_by is null or reviewed_by <> submitted_by)
);

create table rates (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  service_code text not null,
  effective_from date not null,
  config jsonb not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (city_id, service_code, effective_from)
);

create table bills (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  run_id uuid not null references bill_runs(id),
  account_id uuid not null references accounts(id),
  lines jsonb not null,
  total_cents bigint not null,
  due_date date not null,
  status text not null default 'draft' check (status in ('draft','posted','void')),
  posted_at timestamptz,
  penalized_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, account_id)
);

-- Append-only money ledger. Positive = the customer owes more; negative = the customer owes less.
create table ledger_entries (
  id bigserial primary key,
  city_id uuid not null references cities(id),
  account_id uuid not null references accounts(id),
  kind text not null check (kind in ('bill','payment','adjustment','penalty','reversal','charge','refund')),
  amount_cents bigint not null check (amount_cents <> 0),
  ref_type text,
  ref_id text,
  memo text,
  created_by uuid,
  created_at timestamptz not null default now(),
  reverses_id bigint unique references ledger_entries(id)
);
create index ledger_account on ledger_entries (account_id);

create function ledger_no_edit() returns trigger language plpgsql as
  $$ begin raise exception 'ledger entries cannot be changed or deleted; post a reversal instead'; end $$;
create trigger ledger_no_update before update or delete on ledger_entries
  for each row execute function ledger_no_edit();
create trigger ledger_no_truncate before truncate on ledger_entries
  for each statement execute function ledger_no_edit();

create table approvals (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  kind text not null check (kind in ('adjustment','charge')),
  account_id uuid not null references accounts(id),
  amount_cents bigint not null check (amount_cents <> 0),
  code text,
  reason text not null check (length(reason) > 0),
  requested_by uuid not null references users(id),
  approved_by uuid references users(id),
  second_approved_by uuid references users(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (approved_by is null or approved_by <> requested_by),
  check (second_approved_by is null or (second_approved_by <> requested_by and second_approved_by <> approved_by))
);

create table extra_charges (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  account_id uuid not null references accounts(id),
  code text not null,
  description text not null,
  amount_cents bigint not null check (amount_cents <> 0),
  recurring boolean not null default false,
  active boolean not null default true,
  billed_run_id uuid references bill_runs(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  account_id uuid not null references accounts(id),
  amount_cents bigint not null check (amount_cents > 0),
  method text not null check (method in ('card','ach','cash','check')),
  provider text not null,
  provider_ref text,
  status text not null default 'pending' check (status in ('pending','succeeded','failed','refunded')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  ledger_entry_id bigint references ledger_entries(id)
);
create unique index payments_ref on payments (city_id, provider, provider_ref) where provider_ref is not null;

create table webhook_events (
  city_id uuid not null references cities(id),
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (city_id, provider, event_id)
);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  bill_id uuid not null references bills(id),
  account_id uuid not null references accounts(id),
  opened_by uuid not null references users(id),
  reason text not null check (length(reason) between 1 and 2000),
  status text not null default 'open' check (status in ('open','resolved','rejected')),
  resolution text,
  resolved_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table print_profiles (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  kind text not null check (kind in ('bill','envelope')),
  name text not null,
  config jsonb not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (city_id, kind, name)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  user_id uuid not null references users(id),
  token_hash text not null unique,
  csrf text not null,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null,
  stepup_until timestamptz,
  revoked boolean not null default false
);

create table login_codes (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  email text not null,
  purpose text not null check (purpose in ('login','stepup')),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- tamper-evident audit trail (hash chain) ----------
create table audit_log (
  seq bigserial primary key,
  city_id uuid not null references cities(id),
  actor_id uuid,
  action text not null,
  detail jsonb not null default '{}',
  at timestamptz not null default clock_timestamp(),
  prev_hash text not null,
  hash text not null
);

create function audit_hash(prev text, city uuid, actor uuid, act text, det jsonb, at_ timestamptz)
returns text language sql immutable as $$
  select encode(sha256(convert_to(
    prev || '|' || city::text || '|' || coalesce(actor::text, '') || '|' || act || '|' || det::text || '|' ||
    to_char(at_ at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex') $$;

create function audit_append(p_actor uuid, p_action text, p_detail jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare c uuid := app_city(); prev text; t timestamptz := clock_timestamp(); s bigint;
begin
  if c is null then raise exception 'no city context'; end if;
  perform pg_advisory_xact_lock(hashtextextended(c::text, 0));
  select hash into prev from audit_log where city_id = c order by seq desc limit 1;
  prev := coalesce(prev, repeat('0', 64));
  insert into audit_log (city_id, actor_id, action, detail, at, prev_hash, hash)
  values (c, p_actor, p_action, coalesce(p_detail, '{}'), t, prev,
          audit_hash(prev, c, p_actor, p_action, coalesce(p_detail, '{}'), t))
  returning seq into s;
  return s;
end $$;

-- Returns the first broken sequence number, or null when the chain is intact.
create function audit_verify() returns bigint language plpgsql security definer set search_path = public as $$
declare c uuid := app_city(); r record; prev text := repeat('0', 64);
begin
  if c is null then raise exception 'no city context'; end if;
  for r in select * from audit_log where city_id = c order by seq loop
    if r.prev_hash <> prev or r.hash <> audit_hash(r.prev_hash, r.city_id, r.actor_id, r.action, r.detail, r.at) then
      return r.seq;
    end if;
    prev := r.hash;
  end loop;
  return null;
end $$;

-- ---------- bootstrap functions that run before a user is known ----------
create function city_by_host(p_host text) returns uuid language sql security definer set search_path = public as
  $$ select id from cities where lower(p_host) = any (hosts) limit 1 $$;

create function auth_find_or_create_user(p_email text, p_create boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare c uuid := app_city(); u uuid;
begin
  if c is null then raise exception 'no city context'; end if;
  select id into u from users where city_id = c and lower(email) = lower(p_email) and active;
  if u is null and p_create and not exists (select 1 from users where city_id = c and lower(email) = lower(p_email)) then
    insert into users (city_id, email) values (c, lower(p_email)) returning id into u;
    insert into user_roles (user_id, city_id, role) values (u, c, 'resident');
  end if;
  return u;
end $$;

-- Links the signed-in resident to an account when number and printed code both match.
-- Returns null on any mismatch (same answer whether the account exists or not).
create function link_account(p_number text, p_code_hash text) returns uuid
language plpgsql security definer set search_path = public as $$
declare c uuid := app_city(); u uuid := app_user(); a uuid; fails int;
begin
  if c is null or u is null then raise exception 'no context'; end if;
  select count(*) into fails from link_attempts
    where city_id = c and user_id = u and not success and at > now() - interval '1 hour';
  if fails >= 5 then raise exception 'too many attempts' using errcode = 'P0429'; end if;
  select id into a from accounts
    where city_id = c and account_number = p_number and status = 'active' and link_code_hash = p_code_hash;
  insert into link_attempts (city_id, user_id, success) values (c, u, a is not null);
  if a is not null then
    insert into account_links (user_id, account_id, city_id) values (u, a, c) on conflict do nothing;
  end if;
  return a;
end $$;

-- ---------- row-level security ----------
do $$
declare t text;
begin
  foreach t in array array['cities','users','user_roles','services','accounts','account_links','link_attempts',
    'account_services','meters','bill_runs','readings','rates','bills','ledger_entries','approvals','extra_charges',
    'payments','webhook_events','disputes','print_profiles','sessions','login_codes','audit_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- cities
create policy c_sel on cities for select using (id = app_city());
create policy c_upd on cities for update using (id = app_city() and app_perm('settings.manage'))
  with check (id = app_city() and app_perm('settings.manage'));

-- users and roles
create policy u_sel on users for select using (city_id = app_city() and (id = app_user() or app_perm('users.read')));
create policy u_ins on users for insert with check (city_id = app_city() and app_perm('users.manage'));
create policy u_upd on users for update using (city_id = app_city() and (app_perm('users.manage') or id = app_user()))
  with check (city_id = app_city() and (app_perm('users.manage') or id = app_user()));
create policy ur_sel on user_roles for select using (city_id = app_city() and (user_id = app_user() or app_perm('users.read')));
create policy ur_ins on user_roles for insert with check (city_id = app_city() and app_perm('users.manage'));
create policy ur_del on user_roles for delete using (city_id = app_city() and app_perm('users.manage'));

-- reference data
create policy s_sel on services for select using (city_id = app_city());
create policy s_mod on services for update using (city_id = app_city() and app_perm('services.toggle'))
  with check (city_id = app_city() and app_perm('services.toggle'));
create policy s_ins on services for insert with check (city_id = app_city() and app_perm('services.toggle'));
create policy r_sel on rates for select using (city_id = app_city());
create policy r_ins on rates for insert with check (city_id = app_city() and app_perm('rates.manage'));

-- accounts: staff with accounts.read, or the linked resident
create policy a_sel on accounts for select using (city_id = app_city() and (app_perm('accounts.read')
  or exists (select 1 from account_links l where l.account_id = accounts.id and l.user_id = app_user())));
create policy a_ins on accounts for insert with check (city_id = app_city() and app_perm('accounts.manage'));
create policy a_upd on accounts for update using (city_id = app_city() and (app_perm('accounts.manage')
  or exists (select 1 from account_links l where l.account_id = accounts.id and l.user_id = app_user())))
  with check (city_id = app_city());
create policy al_sel on account_links for select using (city_id = app_city() and (user_id = app_user() or app_perm('accounts.read')));
create policy al_del on account_links for delete using (city_id = app_city() and (user_id = app_user() or app_perm('accounts.manage')));
create policy la_none on link_attempts for select using (false);

create policy as_sel on account_services for select using (city_id = app_city() and (app_perm('accounts.read')
  or exists (select 1 from account_links l where l.account_id = account_services.account_id and l.user_id = app_user())));
create policy as_mod on account_services for all using (city_id = app_city() and app_perm('accounts.manage'))
  with check (city_id = app_city() and app_perm('accounts.manage'));

-- meters and readings: field staff never see accounts, only meters
create policy m_sel on meters for select using (city_id = app_city() and app_perm('meters.read'));
create policy m_mod on meters for all using (city_id = app_city() and app_perm('accounts.manage'))
  with check (city_id = app_city() and app_perm('accounts.manage'));
create policy rd_sel on readings for select using (city_id = app_city() and app_perm('meters.read'));
create policy rd_ins on readings for insert with check (city_id = app_city() and app_perm('readings.submit') and submitted_by = app_user());
create policy rd_upd on readings for update using (city_id = app_city() and (app_perm('readings.review') or app_perm('runs.manage')))
  with check (city_id = app_city());

-- billing
create policy br_sel on bill_runs for select using (city_id = app_city() and app_perm('runs.read'));
create policy br_ins on bill_runs for insert with check (city_id = app_city() and app_perm('runs.manage'));
create policy br_upd on bill_runs for update using (city_id = app_city() and (app_perm('runs.manage') or app_perm('runs.approve')))
  with check (city_id = app_city());
create policy b_sel on bills for select using (city_id = app_city() and (app_perm('runs.read')
  or (status = 'posted' and exists (select 1 from account_links l where l.account_id = bills.account_id and l.user_id = app_user()))));
create policy b_ins on bills for insert with check (city_id = app_city() and app_perm('runs.manage'));
create policy b_upd on bills for update using (city_id = app_city() and (app_perm('runs.manage') or app_perm('runs.approve') or app_perm('ledger.post')))
  with check (city_id = app_city());
create policy b_del on bills for delete using (city_id = app_city() and app_perm('runs.manage') and status = 'draft');

-- money
create policy l_sel on ledger_entries for select using (city_id = app_city() and (app_perm('accounts.read')
  or exists (select 1 from account_links l where l.account_id = ledger_entries.account_id and l.user_id = app_user())));
create policy l_ins on ledger_entries for insert with check (city_id = app_city() and app_perm('ledger.post'));

create policy ap_sel on approvals for select using (city_id = app_city() and (app_perm('approvals.read') or requested_by = app_user()));
create policy ap_ins on approvals for insert with check (city_id = app_city() and app_perm('adjustments.request') and requested_by = app_user());
create policy ap_upd on approvals for update using (city_id = app_city() and app_perm('approvals.decide'))
  with check (city_id = app_city());

create policy ec_sel on extra_charges for select using (city_id = app_city() and app_perm('accounts.read'));
create policy ec_ins on extra_charges for insert with check (city_id = app_city() and (app_perm('charges.create') or app_perm('ledger.post')));
create policy ec_upd on extra_charges for update using (city_id = app_city() and (app_perm('charges.create') or app_perm('runs.manage')))
  with check (city_id = app_city());

create policy p_sel on payments for select using (city_id = app_city() and (app_perm('accounts.read')
  or exists (select 1 from account_links l where l.account_id = payments.account_id and l.user_id = app_user())));
create policy p_ins on payments for insert with check (city_id = app_city() and (app_perm('payments.record')
  or exists (select 1 from account_links l where l.account_id = payments.account_id and l.user_id = app_user())));
create policy p_upd on payments for update using (city_id = app_city() and (app_perm('payments.settle') or app_perm('payments.record')))
  with check (city_id = app_city());
create policy wh_ins on webhook_events for insert with check (city_id = app_city() and app_perm('payments.settle'));
create policy wh_sel on webhook_events for select using (city_id = app_city() and app_perm('payments.settle'));

create policy d_sel on disputes for select using (city_id = app_city() and (app_perm('disputes.review') or opened_by = app_user()));
create policy d_ins on disputes for insert with check (city_id = app_city() and opened_by = app_user()
  and exists (select 1 from account_links l where l.account_id = disputes.account_id and l.user_id = app_user()));
create policy d_upd on disputes for update using (city_id = app_city() and app_perm('disputes.review'))
  with check (city_id = app_city());

create policy pp_sel on print_profiles for select using (city_id = app_city() and app_perm('print.read'));
create policy pp_mod on print_profiles for all using (city_id = app_city() and app_perm('print.manage'))
  with check (city_id = app_city() and app_perm('print.manage'));

-- auth bookkeeping: scoped by city only; holds hashes, never plain codes or tokens
create policy se_all on sessions for all using (city_id = app_city()) with check (city_id = app_city());
create policy lc_all on login_codes for all using (city_id = app_city()) with check (city_id = app_city());

create policy au_sel on audit_log for select using (city_id = app_city() and app_perm('audit.read'));

-- ---------- privileges ----------
revoke all on all tables in schema public from public;
grant usage on schema public to utilities_app;
grant usage, select on all sequences in schema public to utilities_app;

grant select on cities, services, rates, user_roles, account_links, account_services, meters, bill_runs, bills,
  ledger_entries, approvals, extra_charges, payments, webhook_events, disputes, print_profiles, audit_log to utilities_app;
grant select (id, city_id, email, name, active, created_at, last_login) on users to utilities_app;
grant select (id, city_id, account_number, name, service_address, mailing_address, status, paperless, created_at) on accounts to utilities_app;

grant update (settings) on cities to utilities_app;
grant insert, update (email, name, active, last_login) on users to utilities_app;
grant insert, delete on user_roles to utilities_app;
grant insert, update on services to utilities_app;
grant insert on rates to utilities_app;
grant insert on accounts to utilities_app;
grant update (name, service_address, mailing_address, status, paperless, link_code_hash) on accounts to utilities_app;
grant delete on account_links to utilities_app;
grant insert, update, delete on account_services, meters to utilities_app;
grant insert on bill_runs to utilities_app;
grant update (status, calculated_at, approved_by, approved_at) on bill_runs to utilities_app;
grant insert, delete on bills to utilities_app;
grant update (lines, total_cents, status, posted_at, penalized_at) on bills to utilities_app;
grant insert, update (status, usage, note, reviewed_by, reviewed_at, billed_run_id) on readings to utilities_app;
grant update (last_value) on meters to utilities_app;
grant insert on ledger_entries to utilities_app;
grant insert on approvals to utilities_app;
grant update (approved_by, second_approved_by, status, decided_at) on approvals to utilities_app;
grant insert on extra_charges to utilities_app;
grant update (active, billed_run_id) on extra_charges to utilities_app;
grant insert on payments to utilities_app;
grant update (provider_ref, status, completed_at, ledger_entry_id) on payments to utilities_app;
grant insert on webhook_events to utilities_app;
grant insert on disputes to utilities_app;
grant update (status, resolution, resolved_by) on disputes to utilities_app;
grant insert, update, delete on print_profiles to utilities_app;
grant select, insert, update, delete on sessions, login_codes to utilities_app;

revoke all on function audit_append(uuid, text, jsonb), audit_verify(), city_by_host(text),
  auth_find_or_create_user(text, boolean), link_account(text, text) from public;
grant execute on function audit_append(uuid, text, jsonb), audit_verify(), city_by_host(text),
  auth_find_or_create_user(text, boolean), link_account(text, text), app_city(), app_user(), app_perm(text),
  audit_hash(text, uuid, uuid, text, jsonb, timestamptz) to utilities_app;
