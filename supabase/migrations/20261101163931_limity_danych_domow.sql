-- Limity, które chronią bazę przed zasypaniem danymi przez anonimowego klienta:
-- długości tekstów, zakresy liczb, limity wierszy na dom i dzienne limity zapisów.

-- 1) jawne klucze w starej kolumnie secret zastępuje znacznik ze skrótem
update public.households set secret = 'skrót:' || secret_hash where secret !~ '^skrót:';
alter table public.households add constraint households_no_plain_secret check (secret ~ '^skrót:[0-9a-f]{64}$');

-- 2) długości tekstów i zakresy liczb
alter table public.list_items
  add constraint list_items_text_len check (char_length(coalesce(name, '')) <= 200 and char_length(coalesce(recipe_name, '')) <= 200
    and char_length(coalesce(batch, '')) <= 120 and char_length(coalesce(member, '')) <= 40 and char_length(coalesce(recipe_id, '')) <= 120),
  add constraint list_items_numbers check ((qty is null or (qty >= 0 and qty < 100000)) and (servings is null or servings between 1 and 100));
alter table public.freezer
  add constraint freezer_text_len check (char_length(name) between 1 and 200 and char_length(coalesce(member, '')) <= 40 and char_length(coalesce(recipe_id, '')) <= 120),
  add constraint freezer_portions check (portions between 0 and 200);
alter table public.reactions add constraint reactions_member_len check (char_length(member) between 1 and 40);
alter table public.receipts
  add constraint receipts_text_len check (char_length(store) <= 10 and char_length(store_name) <= 60
    and char_length(coalesce(source, '')) <= 20 and char_length(coalesce(member, '')) <= 40),
  add constraint receipts_total check (total >= 0 and total < 100000);
alter table public.receipt_items
  add constraint receipt_items_text_len check (char_length(name) between 1 and 200 and char_length(coalesce(category, '')) <= 40),
  add constraint receipt_items_numbers check (qty > 0 and qty < 10000 and total >= 0 and total < 100000 and discount >= 0 and discount < 100000);
alter table public.hh_prices add constraint hh_prices_values check (regular > 0 and regular < 10000 and char_length(coalesce(src, '')) <= 20);
alter table public.hh_settings add constraint hh_settings_budget check (budget is null or (budget >= 0 and budget < 1000000));

-- 3) prośby o przepisy: krótka nazwa dania bez znaków sterujących, krótkie imię i notatka
alter table public.recipe_requests
  add constraint recipe_requests_query_short check (char_length(btrim(query)) between 2 and 80 and query !~ '[<>{}\r\n\t]'),
  add constraint recipe_requests_member_len check (member is null or char_length(member) <= 40),
  add constraint recipe_requests_note_len check (note is null or char_length(note) <= 300);
alter table public.recipe_requests add column if not exists attempts int not null default 0;
alter table public.recipe_requests add column if not exists claimed_at timestamptz;
revoke insert on public.recipe_requests from anon, authenticated;
grant insert (query, member) on public.recipe_requests to anon, authenticated;

-- 4) daty dodania (potrzebne do dziennych limitów) i indeksy
alter table public.freezer add column if not exists created_at timestamptz not null default now();
alter table public.reactions add column if not exists created_at timestamptz not null default now();
alter table public.receipt_items add column if not exists created_at timestamptz not null default now();
create index if not exists list_items_created on public.list_items (created_at);
create index if not exists receipt_items_created on public.receipt_items (created_at);
create index if not exists receipts_created on public.receipts (created_at);
create index if not exists recipe_requests_created on public.recipe_requests (created_at);

-- 5) limity wierszy: na dom i dziennie dla całej bazy (sprawdzane raz na polecenie)
create or replace function private.enforce_caps() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  per_household int := TG_ARGV[0]::int;
  per_day int := TG_ARGV[1]::int;
  hh uuid;
  n bigint;
begin
  for hh in select distinct household_id from new_rows loop
    execute format('select count(*) from public.%I where household_id = $1', TG_TABLE_NAME) into n using hh;
    if n > per_household then
      raise exception 'Osiągnięto limit danych dla domu (%).', TG_TABLE_NAME using errcode = 'P0001';
    end if;
  end loop;
  execute format('select count(*) from public.%I where created_at > now() - interval ''1 day''', TG_TABLE_NAME) into n;
  if n > per_day then
    raise exception 'Osiągnięto dzienny limit zapisów (%). Spróbuj jutro.', TG_TABLE_NAME using errcode = 'P0001';
  end if;
  return null;
end $$;
revoke all on function private.enforce_caps() from public, anon, authenticated;

create trigger caps after insert on public.list_items referencing new table as new_rows
  for each statement execute function private.enforce_caps('400', '3000');
create trigger caps after insert on public.freezer referencing new table as new_rows
  for each statement execute function private.enforce_caps('300', '1000');
create trigger caps after insert on public.reactions referencing new table as new_rows
  for each statement execute function private.enforce_caps('3000', '3000');
create trigger caps after insert on public.receipts referencing new table as new_rows
  for each statement execute function private.enforce_caps('3000', '200');
create trigger caps after insert on public.receipt_items referencing new table as new_rows
  for each statement execute function private.enforce_caps('60000', '5000');

create or replace function private.limit_recipe_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
declare hh uuid; n bigint;
begin
  for hh in select distinct household_id from new_rows loop
    select count(*) into n from public.recipe_requests where household_id = hh and status in ('czeka', 'w_trakcie');
    if n > 3 then raise exception 'Możecie mieć najwyżej 3 oczekujące prośby.' using errcode = 'P0001'; end if;
    select count(*) into n from public.recipe_requests where household_id = hh;
    if n > 300 then raise exception 'Osiągnięto limit próśb dla domu.' using errcode = 'P0001'; end if;
  end loop;
  select count(*) into n from public.recipe_requests where created_at > now() - interval '1 day';
  if n > 20 then raise exception 'Dzienny limit próśb został wyczerpany. Spróbuj jutro.' using errcode = 'P0001'; end if;
  return null;
end $$;
revoke all on function private.limit_recipe_requests() from public, anon, authenticated;
create trigger limits after insert on public.recipe_requests referencing new table as new_rows
  for each statement execute function private.limit_recipe_requests();

-- 6) pozycja paragonu musi należeć do paragonu tego samego domu
alter table public.receipts add constraint receipts_id_household_key unique (id, household_id);
alter table public.receipt_items add constraint receipt_items_receipt_household_fkey
  foreign key (receipt_id, household_id) references public.receipts (id, household_id) on delete cascade;

-- 7) indeksy pod klucze obce (doradca Supabase)
create index if not exists receipt_items_receipt on public.receipt_items (receipt_id, household_id);
create index if not exists receipt_items_product on public.receipt_items (product_id);
create index if not exists hh_prices_product on public.hh_prices (product_id);
create index if not exists hh_recipes_recipe on public.hh_recipes (recipe_id);
create index if not exists list_items_product on public.list_items (product_id);
create index if not exists reactions_recipe on public.reactions (recipe_id);
