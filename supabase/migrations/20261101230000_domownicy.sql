-- Domownicy: każdy telefon ma własny klucz (hh_members.token_hash), a zaproszenia to osobne, wygasające kody.
-- Usunięcie domownika od razu odbiera dostęp jego telefonowi i unieważnia wszystkie zaproszenia oraz dawny
-- wspólny klucz domu, więc nie trzeba niczego ręcznie zmieniać ani rozsyłać pozostałym domownikom.

create table public.hh_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  device text check (device is null or char_length(device) <= 40),
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index hh_members_hh on public.hh_members (household_id);
alter table public.hh_members enable row level security;
create policy dom on public.hh_members for select to anon, authenticated using (household_id = (select private.current_household()));
revoke all on public.hh_members from anon, authenticated;
grant select (id, household_id, name, device, created_at, last_seen) on public.hh_members to anon, authenticated;
comment on table public.hh_members is 'Telefony domowników. Zapis tylko przez funkcje join_household, member_touch, remove_member, leave_household.';

create table public.hh_invites (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid references public.hh_members(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days'
);
create index hh_invites_hh on public.hh_invites (household_id);
alter table public.hh_invites enable row level security;
revoke all on public.hh_invites from anon, authenticated;
comment on table public.hh_invites is 'Kody zaproszeń (skróty). Brak polityk RLS jest celowy: dostęp wyłącznie przez funkcje.';

-- skrót wartości z nagłówka x-dom
create or replace function private.header_hash() returns text
language sql stable set search_path = '' as $$
  select encode(sha256(convert_to(nullif(current_setting('request.headers', true)::json->>'x-dom', ''), 'UTF8')), 'hex')
$$;
revoke all on function private.header_hash() from public;
grant execute on function private.header_hash() to anon, authenticated, service_role;

-- dom rozpoznajemy po kluczu telefonu domownika albo (dla telefonów sprzed zmiany) po dawnym kluczu domu
create or replace function private.current_household() returns uuid
language sql stable security definer set search_path = '' as $$
  with k as (select private.header_hash() as h)
  select coalesce(
    (select m.household_id from public.hh_members m, k where m.token_hash = k.h),
    (select h.id from public.households h, k where h.secret_hash = k.h))
$$;

create or replace function private.current_member() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.hh_members m where m.token_hash = private.header_hash()
$$;
revoke all on function private.current_member() from public;
grant execute on function private.current_member() to anon, authenticated, service_role;

-- co kryje się pod kodem z linku: zaproszenie, dawny klucz domu albo klucz telefonu domownika
create or replace function private.code_household(p_code text, out household_id uuid, out kind text)
language sql stable security definer set search_path = '' as $$
  with k as (select encode(sha256(convert_to(coalesce(p_code, ''), 'UTF8')), 'hex') as h)
  select * from (
    select m.household_id, 'domownik' from public.hh_members m, k where m.token_hash = k.h
    union all select i.household_id, 'zaproszenie' from public.hh_invites i, k where i.token_hash = k.h and i.expires_at > now()
    union all select h.id, 'klucz' from public.households h, k where h.secret_hash = k.h
  ) x limit 1
$$;
revoke all on function private.code_household(text) from public, anon, authenticated;

-- ekran powitalny: nazwa domu z linku (bez dostępu do danych)
create or replace function public.invite_info(p_code text) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('name', h.name, 'kind', c.kind, 'member_id',
    (select m.id from public.hh_members m where c.kind = 'domownik' and m.token_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')))
  from private.code_household(p_code) c join public.households h on h.id = c.household_id
$$;

-- dołączenie telefonu: kod zaproszenia albo dawny klucz domu → nowy, osobny klucz tego telefonu
create or replace function public.join_household(p_code text, p_name text, p_device text) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  c record;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
  v_name text;
begin
  select * into c from private.code_household(p_code);
  if c.household_id is null or c.kind = 'domownik' then
    raise exception 'Ten link zaproszenia jest nieaktualny.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.hh_members where household_id = c.household_id) >= 30 then
    raise exception 'Dom ma już 30 telefonów. Usuń nieużywane w ustawieniach.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.hh_members where created_at > now() - interval '1 day') >= 500 then
    raise exception 'Dzienny limit dołączeń został wyczerpany. Spróbuj jutro.' using errcode = 'P0001';
  end if;
  insert into public.hh_members (household_id, token_hash, name, device)
  values (c.household_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
          left(coalesce(nullif(btrim(p_name), ''), 'Domownik'), 40), left(nullif(btrim(p_device), ''), 40))
  returning id into v_id;
  select name into v_name from public.households where id = c.household_id;
  return json_build_object('token', v_token, 'member_id', v_id, 'household_id', c.household_id, 'name', v_name);
end $$;

-- nowe zaproszenie (tylko telefon domownika); ważne 14 dni
create or replace function public.create_invite() returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m uuid := private.current_member();
  v_hh uuid := private.current_household();
  v_code text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if v_m is null then raise exception 'Nie rozpoznano telefonu domownika.' using errcode = '42501'; end if;
  delete from public.hh_invites where household_id = v_hh and expires_at < now();
  if (select count(*) from public.hh_invites where household_id = v_hh) >= 20 then
    raise exception 'Za dużo aktywnych zaproszeń. Spróbuj później.' using errcode = 'P0001';
  end if;
  insert into public.hh_invites (token_hash, household_id, created_by) values (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), v_hh, v_m);
  return json_build_object('code', v_code);
end $$;

-- imię, rodzaj telefonu i ostatnie otwarcie aplikacji
create or replace function public.member_touch(p_name text, p_device text) returns void
language sql volatile security definer set search_path = '' as $$
  update public.hh_members set name = left(coalesce(nullif(btrim(p_name), ''), name), 40),
    device = left(nullif(btrim(p_device), ''), 40), last_seen = now()
  where id = private.current_member()
$$;

-- usunięcie domownika: jego telefon traci dostęp, zaproszenia i dawny klucz domu przestają działać
create or replace function public.remove_member(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_m uuid := private.current_member(); v_hh uuid := private.current_household(); v_hash text;
begin
  if v_m is null then raise exception 'Nie rozpoznano telefonu domownika.' using errcode = '42501'; end if;
  if p_id = v_m then raise exception 'Siebie odłączasz opcją „Odłącz ten telefon”.' using errcode = 'P0001'; end if;
  delete from public.hh_members where id = p_id and household_id = v_hh;
  if not found then raise exception 'Nie ma takiego domownika.' using errcode = 'P0001'; end if;
  delete from public.hh_invites where household_id = v_hh;
  v_hash := encode(sha256(extensions.gen_random_bytes(32)), 'hex');
  update public.households set secret_hash = v_hash, secret = 'skrót:' || v_hash where id = v_hh;
end $$;

-- odłączenie własnego telefonu
create or replace function public.leave_household() returns void
language sql volatile security definer set search_path = '' as $$
  delete from public.hh_members where id = private.current_member()
$$;

revoke all on function public.invite_info(text), public.join_household(text, text, text), public.create_invite(),
  public.member_touch(text, text), public.remove_member(uuid), public.leave_household() from public, anon, authenticated;
grant execute on function public.invite_info(text), public.join_household(text, text, text), public.create_invite(),
  public.member_touch(text, text), public.remove_member(uuid), public.leave_household() to anon, authenticated;

-- wersje danych domu: lista domowników też się odświeża u wszystkich
alter table public.hh_versions drop constraint if exists hh_versions_tbl_check;
alter table public.hh_versions add constraint hh_versions_tbl_check check (tbl in ('recipe_requests', 'hh_recipes', 'reactions', 'list_items', 'freezer', 'hh_prices', 'receipts', 'receipt_items', 'hh_settings', 'hh_members'));
create trigger hh_version after insert or update or delete on public.hh_members for each row execute function private.touch_hh_version();
