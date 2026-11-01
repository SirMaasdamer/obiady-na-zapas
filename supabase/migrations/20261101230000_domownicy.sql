-- Domownicy: każdy telefon podłączony do domu zapisuje się z imieniem i datą ostatniego otwarcia aplikacji.
-- To lista „kto ma dostęp”, nie uprawnienia: dostęp daje klucz domu. Usunięcie z listy nie odbiera dostępu,
-- do tego służy zmiana klucza (rotate_household_secret).
create table public.hh_members (
  id uuid primary key,
  household_id uuid not null default private.current_household() references public.households(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  device text check (device is null or char_length(device) <= 40),
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index hh_members_hh on public.hh_members (household_id);

alter table public.hh_members enable row level security;
create policy dom on public.hh_members for all to anon, authenticated
  using (household_id = (select private.current_household())) with check (household_id = (select private.current_household()));
revoke all on public.hh_members from anon, authenticated;
grant select, delete on public.hh_members to anon, authenticated;
grant insert (id, name, device, last_seen), update (id, name, device, last_seen) on public.hh_members to anon, authenticated;

-- najwyżej 30 telefonów na dom i 500 nowych wpisów dziennie w całej bazie
create trigger caps after insert on public.hh_members referencing new table as new_rows
  for each statement execute function private.enforce_caps('30', '500');

-- wersje danych domu: aplikacja dociąga listę, gdy ktoś dołączy albo zmieni imię
alter table public.hh_versions drop constraint if exists hh_versions_tbl_check;
alter table public.hh_versions add constraint hh_versions_tbl_check check (tbl in ('recipe_requests', 'hh_recipes', 'reactions', 'list_items', 'freezer', 'hh_prices', 'receipts', 'receipt_items', 'hh_settings', 'hh_members'));
create trigger hh_version after insert or update or delete on public.hh_members for each row execute function private.touch_hh_version();
