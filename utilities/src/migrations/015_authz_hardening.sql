-- Tightening found in an authorization review. The app already behaved; these make the database refuse the same
-- things, so a future bug in a route cannot open them.

-- 1. A row may only point at an account or user in its own city.
alter table accounts add constraint accounts_id_city unique (id, city_id);
alter table users add constraint users_id_city unique (id, city_id);
delete from meters m where not exists (select 1 from accounts a where a.id = m.account_id and a.city_id = m.city_id)
  and not exists (select 1 from readings r where r.meter_id = m.id);
delete from account_services s where not exists (select 1 from accounts a where a.id = s.account_id and a.city_id = s.city_id);
delete from user_roles r where not exists (select 1 from users u where u.id = r.user_id and u.city_id = r.city_id);
alter table meters add constraint meters_account_same_city foreign key (account_id, city_id) references accounts (id, city_id);
alter table account_services add constraint account_services_same_city foreign key (account_id, city_id) references accounts (id, city_id);
alter table user_roles add constraint user_roles_same_city foreign key (user_id, city_id) references users (id, city_id);

-- 2. A resident may start a payment, but only as a plain pending one. Settling it is the system's job.
drop policy p_ins on payments;
create policy p_ins on payments for insert with check (city_id = app_city() and (app_perm('payments.record')
  or (exists (select 1 from account_links l where l.account_id = payments.account_id and l.user_id = app_user())
      and status = 'pending' and fee_cents = 0 and provider_ref is null and ledger_entry_id is null)));

-- 3. What a resident may change on rows they can see. Row security cannot compare old and new values, so triggers do.
create function guard_resident_account_update() returns trigger language plpgsql as $$
begin
  if not app_perm('accounts.manage') and (to_jsonb(new) - 'paperless') is distinct from (to_jsonb(old) - 'paperless') then
    raise exception 'residents may only change paper bills' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger accounts_resident_guard before update on accounts for each row execute function guard_resident_account_update();

create function guard_resident_autopay_update() returns trigger language plpgsql as $$
begin
  -- a resident may only turn autopay off; saving a card or bank account goes through the processor and the system
  if not app_perm('payments.settle') and ((to_jsonb(new) - 'active') is distinct from (to_jsonb(old) - 'active') or new.active) then
    raise exception 'residents may only turn autopay off' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger autopay_resident_guard before update on autopay_enrollments for each row execute function guard_resident_autopay_update();

create function guard_arrangement_update() returns trigger language plpgsql as $$
begin
  if app_perm('arrangements.decide') then return new; end if;
  -- everyone else may only cancel: staff a waiting or approved plan, a resident only one still waiting
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') or new.status <> 'cancelled'
     or old.status not in ('pending', 'approved') or (old.status = 'approved' and not app_perm('accounts.manage')) then
    raise exception 'only cancelling is allowed here' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger arrangements_guard before update on payment_arrangements for each row execute function guard_arrangement_update();
drop policy pa_upd on payment_arrangements;
create policy pa_upd on payment_arrangements for update using (city_id = app_city() and (app_perm('arrangements.decide')
  or app_perm('accounts.manage')
  or exists (select 1 from account_links l where l.account_id = payment_arrangements.account_id and l.user_id = app_user())))
  with check (city_id = app_city());
