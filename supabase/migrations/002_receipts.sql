-- Paragony i wydatki (osobne dla każdego domu).

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household() references households(id) on delete cascade,
  store text not null,              -- b | l | k | inny kod
  store_name text not null,
  bought_on date not null,
  total numeric not null,
  source text,                      -- pdf | zdjęcie | ręcznie
  member text,
  created_at timestamptz not null default now()
);
create index if not exists receipts_hh on receipts(household_id, bought_on);

create table if not exists receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references receipts(id) on delete cascade,
  household_id uuid not null default public.current_household() references households(id) on delete cascade,
  name text not null,
  qty numeric not null default 1,
  weighed boolean not null default false, -- ilość w kg
  unit_price numeric,
  total numeric not null,           -- po rabatach
  discount numeric not null default 0,
  product_id text references products(id) on delete set null,
  category text
);
create index if not exists receipt_items_hh on receipt_items(household_id, product_id);

create table if not exists hh_settings (
  household_id uuid primary key default public.current_household() references households(id) on delete cascade,
  budget numeric
);

alter table hh_prices add column if not exists src text;      -- ręcznie | paragon
alter table hh_prices add column if not exists seen_on date;

do $$
declare t text;
begin
  foreach t in array array['receipts','receipt_items','hh_settings'] loop
    execute format('alter table %I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'dom') then
      execute format('create policy dom on %I for all to anon, authenticated using (household_id = public.current_household()) with check (household_id = public.current_household())', t);
    end if;
  end loop;
end $$;
