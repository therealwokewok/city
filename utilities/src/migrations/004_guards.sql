-- Defense in depth: the database itself refuses money moves that the caller's permissions do not cover,
-- even if application code is wrong or an attacker finds a way to run a query.

create function guard_post() returns trigger language plpgsql as $$
begin
  if new.status = 'posted' and old.status is distinct from 'posted' then
    if not app_perm('runs.approve') then
      raise exception 'only an approver can post' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger bills_guard_post before update on bills for each row execute function guard_post();

create function guard_run_post() returns trigger language plpgsql as $$
begin
  if new.status = 'posted' and old.status is distinct from 'posted' then
    if not app_perm('runs.approve') or new.approved_by is distinct from app_user() then
      raise exception 'only an approver can post a run, and must record themselves' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger runs_guard_post before update on bill_runs for each row execute function guard_run_post();

-- Each kind of ledger entry needs the permission for that kind of work, on top of ledger.post.
create function guard_ledger_kind() returns trigger language plpgsql as $$
declare need text;
begin
  need := case new.kind
    when 'bill' then 'runs.approve'
    when 'payment' then case when app_perm('payments.settle') then 'payments.settle' else 'payments.record' end
    when 'penalty' then 'runs.manage'
    else 'approvals.decide' end;   -- adjustment, reversal, charge, refund
  if not app_perm(need) then
    raise exception 'not allowed to post a % entry', new.kind using errcode = '42501';
  end if;
  return new;
end $$;
create trigger ledger_guard_kind before insert on ledger_entries for each row execute function guard_ledger_kind();
