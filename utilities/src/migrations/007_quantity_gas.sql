-- More than one of the same flat service on an account (two security lights), and extra services cities often offer.
alter table account_services add column quantity integer not null default 1 check (quantity between 1 and 99);

-- Ready-made services for existing cities. They start switched off; a city turns on what it actually bills.
insert into services (city_id, code, name, kind, enabled)
select c.id, v.code, v.name, v.kind, false
from cities c cross join (values
  ('G', 'Natural gas', 'metered'), ('P', 'Propane', 'metered'), ('ST', 'Stormwater fee', 'flat'),
  ('RC', 'Recycling', 'flat'), ('YW', 'Yard waste pickup', 'flat'), ('EMS', 'Ambulance subscription', 'flat'),
  ('BB', 'Internet service', 'flat'), ('IR', 'Irrigation water', 'metered'), ('STL', 'Street light fee', 'flat')
) as v(code, name, kind)
on conflict do nothing;
