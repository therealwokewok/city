-- A person may change their own name, nothing else about themselves. Email is where bills and sign-in codes go,
-- and "active" is the off switch; both belong to the people who manage users.
create function guard_user_self_update() returns trigger language plpgsql as $$
begin
  if not app_perm('users.manage') and (to_jsonb(new) - 'name' - 'last_login') is distinct from (to_jsonb(old) - 'name' - 'last_login') then
    raise exception 'you may only change your own name' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger users_self_guard before update on users for each row execute function guard_user_self_update();
