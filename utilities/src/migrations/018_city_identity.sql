-- A city's name, state, time zone and web addresses can be changed from the Administration screens by someone with
-- the city.manage permission (city and site administrators), instead of only in the database.
grant update (name, state, timezone, hosts) on cities to utilities_app;

drop policy if exists c_upd on cities;
create policy c_upd on cities for update
  using (id = app_city() and (app_perm('settings.manage') or app_perm('city.manage')))
  with check (id = app_city());

-- Two cities on one server must never answer to the same address. Row security hides other cities, so this check
-- runs with the function owner's rights and tells only whether an address is taken, never whose it is.
create function hosts_taken(p_hosts text[]) returns text[] language sql security definer set search_path = public as
  $$ select coalesce(array_agg(h), '{}') from unnest(p_hosts) h where exists (select 1 from cities where id <> app_city() and h = any (hosts)) $$;
revoke all on function hosts_taken(text[]) from public;
grant execute on function hosts_taken(text[]) to utilities_app;

-- Every address is stored once and in lower case, so lookups never miss on a capital letter.
create or replace function cities_hosts_normalize() returns trigger language plpgsql as $$
begin
  new.hosts := (select coalesce(array_agg(distinct lower(trim(h))), '{}') from unnest(new.hosts) h where trim(h) <> '');
  if cardinality(new.hosts) = 0 then raise exception 'a city needs at least one web address' using errcode = '23514'; end if;
  return new;
end $$;
drop trigger if exists cities_hosts_normalize on cities;
create trigger cities_hosts_normalize before insert or update of hosts on cities for each row execute function cities_hosts_normalize();

-- The app may see which updates have been applied (the Database screen reports it); it still cannot change them.
grant select on schema_migrations to utilities_app;
