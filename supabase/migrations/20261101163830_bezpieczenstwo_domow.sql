-- Bezpieczeństwo domów, część 1:
-- * skrót SHA-256 klucza domu (secret_hash) używany do rozpoznawania domu,
-- * funkcja rozpoznająca dom w schemacie private (nie jest wystawiona jako /rest/v1/rpc),
-- * polityki liczą dom raz na zapytanie,
-- * limity zakładania domów i zmiana klucza domu.

-- 1) skrót klucza
alter table public.households add column if not exists secret_hash text;
update public.households set secret_hash = encode(sha256(convert_to(secret, 'UTF8')), 'hex') where secret_hash is null;
alter table public.households alter column secret_hash set not null;
create unique index if not exists households_secret_hash_key on public.households (secret_hash);

-- 2) rozpoznawanie domu po nagłówku x-dom
create or replace function private.current_household() returns uuid
language sql stable security definer set search_path = '' as $$
  select h.id from public.households h
  where h.secret_hash = encode(sha256(convert_to(nullif(current_setting('request.headers', true)::json->>'x-dom', ''), 'UTF8')), 'hex')
$$;
revoke all on function private.current_household() from public;
grant execute on function private.current_household() to anon, authenticated, service_role;

-- 3) polityki i wartości domyślne korzystają z nowej funkcji
do $$
declare t text;
begin
  foreach t in array array['hh_recipes','reactions','list_items','freezer','hh_prices','receipts','receipt_items','hh_settings','recipe_requests'] loop
    execute format('alter policy dom on public.%I using (household_id = (select private.current_household())) with check (household_id = (select private.current_household()))', t);
    execute format('alter table public.%I alter column household_id set default private.current_household()', t);
  end loop;
end $$;

alter table public.households add constraint households_name_len check (char_length(name) between 1 and 60);

-- 4) funkcje dla aplikacji (nowe domy zapisują wyłącznie skrót klucza)
create or replace function public.create_household(p_name text) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  h public.households;
begin
  if (select count(*) from public.households where created_at > now() - interval '1 hour') >= 10
     or (select count(*) from public.households where created_at > now() - interval '1 day') >= 30 then
    raise exception 'Za dużo nowych domów w krótkim czasie. Spróbuj za godzinę.' using errcode = 'P0001';
  end if;
  insert into public.households (secret_hash, secret, name)
  values (encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), 'skrót:' || encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'),
          left(coalesce(nullif(btrim(p_name), ''), 'Mój dom'), 60))
  returning * into h;
  return json_build_object('id', h.id, 'name', h.name, 'secret', v_secret);
end $$;

create or replace function public.household_info() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('id', h.id, 'name', h.name) from public.households h where h.id = private.current_household()
$$;

create or replace function public.rename_household(p_name text) returns void
language sql volatile security definer set search_path = '' as $$
  update public.households set name = left(coalesce(nullif(btrim(p_name), ''), name), 60)
  where id = private.current_household()
$$;

-- nowy klucz domu: stare linki i telefony bez nowego linku tracą dostęp
create or replace function public.rotate_household_secret() returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := private.current_household();
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash text := encode(sha256(convert_to(v_secret, 'UTF8')), 'hex');
begin
  if v_id is null then raise exception 'Nie rozpoznano domu.' using errcode = '42501'; end if;
  update public.households set secret_hash = v_hash, secret = 'skrót:' || v_hash where id = v_id;
  return json_build_object('secret', v_secret);
end $$;

-- dawna funkcja publiczna: tylko przekierowanie, niedostępna z API
create or replace function public.current_household() returns uuid
language sql stable security definer set search_path = '' as $$ select private.current_household() $$;
revoke all on function public.current_household() from public, anon, authenticated;

revoke all on function public.create_household(text), public.household_info(), public.rename_household(text),
  public.rotate_household_secret() from public, anon, authenticated;
grant execute on function public.create_household(text), public.household_info(), public.rename_household(text),
  public.rotate_household_secret() to anon, authenticated;

comment on table public.households is 'Domy. Klucz domu jest rozpoznawany po skrócie SHA-256 (secret_hash). Brak polityk RLS jest celowy: dostęp wyłącznie przez funkcje.';
comment on table public.sync_state is 'Stan wycofanej funkcji sync. Brak polityk RLS jest celowy.';
