-- The city's logo. One small PNG or JPEG per city, public so the sign-in page can show it.
create table city_logo (
  city_id uuid primary key references cities(id),
  content_type text not null check (content_type in ('image/png','image/jpeg')),
  data bytea not null check (length(data) between 100 and 307200),
  updated_at timestamptz not null default now()
);
alter table city_logo enable row level security;
alter table city_logo force row level security;
create policy cl_sel on city_logo for select using (city_id = app_city());
create policy cl_ins on city_logo for insert with check (city_id = app_city() and app_perm('settings.manage'));
create policy cl_upd on city_logo for update using (city_id = app_city() and app_perm('settings.manage')) with check (city_id = app_city());
create policy cl_del on city_logo for delete using (city_id = app_city() and app_perm('settings.manage'));
grant select, insert, update, delete on city_logo to utilities_app;
