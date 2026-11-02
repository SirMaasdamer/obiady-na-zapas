create or replace function public.remove_member(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_m uuid := private.current_member(); v_hh uuid := private.current_household();
begin
  if v_m is null then raise exception 'Nie rozpoznano telefonu domownika.' using errcode = '42501'; end if;
  if p_id = v_m then raise exception 'Siebie odłączasz opcją „Odłącz ten telefon”.' using errcode = 'P0001'; end if;
  update public.hh_members set revoked_at = now() where id = p_id and household_id = v_hh and revoked_at is null;
  if not found then raise exception 'Nie ma takiego domownika.' using errcode = 'P0001'; end if;
  update public.hh_invites set revoked_at = now() where household_id = v_hh and revoked_at is null;
  -- dawny wspólny klucz domu przestaje działać (nikt nie zna nowego skrótu)
  update public.households set secret_hash = encode(sha256(extensions.gen_random_bytes(32)), 'hex') where id = v_hh;
end $$;
