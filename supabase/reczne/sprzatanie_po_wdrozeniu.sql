-- Obiady na Zapas: sprzątanie po wdrożeniu nowego pipeline'u (przygotowane 1.11.2026).
-- Usuwa obiekty, więc wymaga Twojej decyzji: uruchom całość w Supabase → SQL Editor (projekt jnomchdxgmoegbpfjtii).
-- Działa w jednej transakcji: jeśli cokolwiek się nie uda, nic się nie zmieni.
--
-- Co robi:
--   1) włącza „Usuń dom i wszystkie jego dane” w ustawieniach domu (funkcja delete_household),
--   2) usuwa starą kolumnę households.secret (baza trzyma już tylko skrót klucza, secret_hash),
--   3) usuwa dawną funkcję public.current_household (nic z niej nie korzysta),
--   4) usuwa stary klucz obcy pozycji paragonu (zostaje złożony klucz (receipt_id, household_id)),
--   5) wyłącza resztki funkcji sync: zadanie pg_cron co godzinę, tabelę sync_state i pg_net w schemacie public.
-- Po uruchomieniu usuń też funkcję brzegową „sync”: Edge Functions → sync → Delete.

begin;

-- 1) usuwanie domu (tabele domu mają ON DELETE CASCADE)
create function public.delete_household() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid := private.current_household();
begin
  if v_id is null then raise exception 'Nie rozpoznano domu.' using errcode = '42501'; end if;
  delete from public.households where id = v_id;
end $$;
revoke all on function public.delete_household() from public, anon, authenticated;
grant execute on function public.delete_household() to anon, authenticated;
comment on function public.delete_household() is 'Usuwa dom wskazany kluczem x-dom razem ze wszystkimi jego danymi.';

-- 2) tylko skrót klucza: funkcje przestają zapisywać starą kolumnę, potem kolumna znika
create or replace function public.create_household(p_name text) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid; v_name text;
begin
  if (select count(*) from public.households where created_at > now() - interval '1 hour') >= 10
     or (select count(*) from public.households where created_at > now() - interval '1 day') >= 30 then
    raise exception 'Za dużo nowych domów w krótkim czasie. Spróbuj za godzinę.' using errcode = 'P0001';
  end if;
  insert into public.households (secret_hash, name)
  values (encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), left(coalesce(nullif(btrim(p_name), ''), 'Mój dom'), 60))
  returning id, name into v_id, v_name;
  return json_build_object('id', v_id, 'name', v_name, 'secret', v_secret);
end $$;

create or replace function public.rotate_household_secret() returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := private.current_household();
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if v_id is null then raise exception 'Nie rozpoznano domu.' using errcode = '42501'; end if;
  update public.households set secret_hash = encode(sha256(convert_to(v_secret, 'UTF8')), 'hex') where id = v_id;
  return json_build_object('secret', v_secret);
end $$;

alter table public.households drop column secret;

-- 3) dawna funkcja publiczna
drop function public.current_household();

-- 4) stary klucz obcy pozycji paragonu
alter table public.receipt_items drop constraint receipt_items_receipt_id_fkey;

-- 5) resztki funkcji sync i pg_net poza schematem public (ostrzeżenie doradcy „Extension in Public”)
select cron.unschedule('obiady-sync');
drop table public.sync_state;
drop extension pg_net;
create extension pg_net with schema extensions;

commit;

-- Za około tydzień, gdy nowe oferty będą działały bez zastrzeżeń, usuń kopię starych tabel prices i offers
-- sprzed migracji (285 i 26 wierszy). Zdejmij komentarz z linii poniżej i uruchom ją osobno:
-- drop schema backup cascade;
