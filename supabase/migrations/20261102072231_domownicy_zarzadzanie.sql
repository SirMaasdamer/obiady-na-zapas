-- usunięcie domownika i zaproszeń jako oznaczenie (revoked_at), bez kasowania wierszy: zostaje ślad, kto i kiedy stracił dostęp
alter table public.hh_members add column revoked_at timestamptz;
alter table public.hh_invites add column revoked_at timestamptz;
alter policy dom on public.hh_members using (household_id = (select private.current_household()) and revoked_at is null);

create or replace function private.current_household() returns uuid
language sql stable security definer set search_path = '' as $$
  with k as (select private.header_hash() as h)
  select coalesce(
    (select m.household_id from public.hh_members m, k where m.token_hash = k.h and m.revoked_at is null),
    (select h.id from public.households h, k where h.secret_hash = k.h))
$$;

create or replace function private.current_member() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.hh_members m where m.token_hash = private.header_hash() and m.revoked_at is null
$$;

create or replace function private.code_household(p_code text, out household_id uuid, out kind text)
language sql stable security definer set search_path = '' as $$
  with k as (select encode(sha256(convert_to(coalesce(p_code, ''), 'UTF8')), 'hex') as h)
  select * from (
    select m.household_id, 'domownik' from public.hh_members m, k where m.token_hash = k.h and m.revoked_at is null
    union all select i.household_id, 'zaproszenie' from public.hh_invites i, k where i.token_hash = k.h and i.expires_at > now() and i.revoked_at is null
    union all select h.id, 'klucz' from public.households h, k where h.secret_hash = k.h
  ) x limit 1
$$;

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
  if (select count(*) from public.hh_members where household_id = c.household_id and revoked_at is null) >= 30 then
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

create or replace function public.create_invite() returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m uuid := private.current_member();
  v_hh uuid := private.current_household();
  v_code text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if v_m is null then raise exception 'Nie rozpoznano telefonu domownika.' using errcode = '42501'; end if;
  if (select count(*) from public.hh_invites where household_id = v_hh and revoked_at is null and expires_at > now()) >= 20 then
    raise exception 'Za dużo aktywnych zaproszeń. Spróbuj później.' using errcode = 'P0001';
  end if;
  insert into public.hh_invites (token_hash, household_id, created_by) values (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), v_hh, v_m);
  return json_build_object('code', v_code);
end $$;

create or replace function public.remove_member(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_m uuid := private.current_member(); v_hh uuid := private.current_household(); v_hash text;
begin
  if v_m is null then raise exception 'Nie rozpoznano telefonu domownika.' using errcode = '42501'; end if;
  if p_id = v_m then raise exception 'Siebie odłączasz opcją „Odłącz ten telefon”.' using errcode = 'P0001'; end if;
  update public.hh_members set revoked_at = now() where id = p_id and household_id = v_hh and revoked_at is null;
  if not found then raise exception 'Nie ma takiego domownika.' using errcode = 'P0001'; end if;
  update public.hh_invites set revoked_at = now() where household_id = v_hh and revoked_at is null;
  v_hash := encode(sha256(extensions.gen_random_bytes(32)), 'hex');
  update public.households set secret_hash = v_hash, secret = 'skrót:' || v_hash where id = v_hh;
end $$;

create or replace function public.leave_household() returns void
language sql volatile security definer set search_path = '' as $$
  update public.hh_members set revoked_at = now() where id = private.current_member()
$$;

revoke all on function public.create_invite(), public.remove_member(uuid), public.leave_household() from public, anon, authenticated;
grant execute on function public.create_invite(), public.remove_member(uuid), public.leave_household() to anon, authenticated;
