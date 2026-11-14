-- wyuczone nazwy pozycji z paragonów: skrót z paragonu (raw, znormalizowany w aplikacji) → nazwa i kategoria poprawione przez domownika
create table public.hh_aliases (
  household_id uuid not null default private.current_household() references public.households(id) on delete cascade,
  raw text not null check (char_length(raw) between 2 and 120),
  name text not null check (char_length(btrim(name)) between 1 and 120 and name !~ '[<>{}]'),
  category text check (category is null or char_length(category) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, raw)
);
alter table public.hh_aliases enable row level security;
create policy dom on public.hh_aliases for all to anon, authenticated
  using (household_id = (select private.current_household())) with check (household_id = (select private.current_household()));
revoke all on public.hh_aliases from anon, authenticated;
grant select, delete on public.hh_aliases to anon, authenticated;
grant insert (household_id, raw, name, category, updated_at), update (name, category, updated_at) on public.hh_aliases to anon, authenticated;
create trigger caps after insert on public.hh_aliases referencing new table as new_rows
  for each statement execute function private.enforce_caps('3000', '5000');
comment on table public.hh_aliases is 'Nazwy pozycji z paragonów poprawione przez domowników (skrót → nazwa, kategoria).';
