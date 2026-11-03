-- Passkeys: sign in with a fingerprint, face or device PIN. We keep only the public half of the key.
create table passkeys (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  user_id uuid not null references users(id),
  credential_id text not null,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  name text not null default 'This device' check (length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  last_used timestamptz,
  unique (city_id, credential_id)
);
alter table passkeys enable row level security;
alter table passkeys force row level security;
create policy pk_sel on passkeys for select using (city_id = app_city() and user_id = app_user());
create policy pk_ins on passkeys for insert with check (city_id = app_city() and user_id = app_user());
create policy pk_del on passkeys for delete using (city_id = app_city() and user_id = app_user());
grant select, insert, delete on passkeys to utilities_app;

-- One-time challenges. Created and used through functions so nobody has to be signed in to start a ceremony.
create table passkey_challenges (
  challenge text primary key,
  city_id uuid not null references cities(id),
  purpose text not null check (purpose in ('register','login')),
  user_id uuid,
  expires_at timestamptz not null
);
alter table passkey_challenges enable row level security;
alter table passkey_challenges force row level security;
create policy pc_none on passkey_challenges for select using (false);

create function passkey_challenge_new(p_challenge text, p_purpose text, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from passkey_challenges where expires_at < now();
  insert into passkey_challenges (challenge, city_id, purpose, user_id, expires_at)
  values (p_challenge, app_city(), p_purpose, p_user, now() + interval '5 minutes');
end $$;

-- Returns true once, for the right purpose and city, and removes the challenge.
create function passkey_challenge_take(p_challenge text, p_purpose text, p_user uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from passkey_challenges
   where challenge = p_challenge and purpose = p_purpose and city_id = app_city() and expires_at > now()
     and user_id is not distinct from p_user;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create function passkey_find(p_credential text) returns table (id uuid, user_id uuid, public_key bytea, counter bigint, transports text[])
language sql security definer set search_path = public as $$
  select k.id, k.user_id, k.public_key, k.counter, k.transports from passkeys k join users u on u.id = k.user_id
  where k.city_id = app_city() and k.credential_id = p_credential and u.active;
$$;

create function passkey_used(p_id uuid, p_counter bigint) returns void
language sql security definer set search_path = public as $$
  update passkeys set counter = greatest(counter, p_counter), last_used = now() where id = p_id and city_id = app_city();
$$;
revoke all on function passkey_challenge_new(text, text, uuid), passkey_challenge_take(text, text, uuid), passkey_find(text), passkey_used(uuid, bigint) from public;
grant execute on function passkey_challenge_new(text, text, uuid), passkey_challenge_take(text, text, uuid), passkey_find(text), passkey_used(uuid, bigint) to utilities_app;
