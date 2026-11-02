create or replace function private.header_hash() returns text
language sql stable set search_path = '' as $$
  select encode(sha256(convert_to(nullif(current_setting('request.headers', true)::json->>'x-dom', ''), 'UTF8')), 'hex')
$$;
revoke all on function private.header_hash() from public;
grant execute on function private.header_hash() to anon, authenticated, service_role;

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

create or replace function public.invite_info(p_code text) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('name', h.name, 'kind', c.kind, 'member_id',
    (select m.id from public.hh_members m where c.kind = 'domownik' and m.token_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')))
  from private.code_household(p_code) c join public.households h on h.id = c.household_id
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

create or replace function public.member_touch(p_name text, p_device text) returns void
language sql volatile security definer set search_path = '' as $$
  update public.hh_members set name = left(coalesce(nullif(btrim(p_name), ''), name), 40),
    device = left(nullif(btrim(p_device), ''), 40), last_seen = now()
  where id = private.current_member()
$$;

revoke all on function public.invite_info(text), public.join_household(text, text, text), public.member_touch(text, text) from public, anon, authenticated;
grant execute on function public.invite_info(text), public.join_household(text, text, text), public.member_touch(text, text) to anon, authenticated;
