-- Obiady na Zapas: schemat bazy (idempotentny, można uruchamiać wielokrotnie)

create table if not exists products (
  id text primary key,
  name text not null,
  unit text not null,              -- kg | l | szt | pęczek | łyżka (spiżarnia)
  pack numeric not null default 1, -- rozmiar opakowania w jednostce unit
  loose boolean not null default false, -- na wagę
  cat text,
  pantry boolean not null default false,
  conv jsonb,                      -- np. {"ząbek":0.1}
  kw jsonb,                        -- słowa kluczowe do wyszukiwania w gazetkach
  created_at timestamptz not null default now()
);

-- jedna cena na produkt i sklep: cena regularna + ewentualna promocja z gazetki
create table if not exists prices (
  product_id text not null references products(id) on delete cascade,
  store text not null check (store in ('b','l','k')),
  regular numeric,
  regular_src text,                -- szac | gazetka | sklep
  promo numeric,
  promo_from date,
  promo_to date,
  promo_note text,
  promo_leaflet text,
  updated_at timestamptz not null default now(),
  primary key (product_id, store)
);

-- wszystkie oferty spożywcze odczytane z gazetek
create table if not exists offers (
  id bigint generated always as identity primary key,
  store text not null,
  name text not null,
  price numeric,
  price_for_pack numeric,          -- cena przeliczona na opakowanie z katalogu
  unit_info text,
  regular numeric,
  valid_from date,
  valid_to date,
  note text,
  product_id text references products(id) on delete set null,
  leaflet text,
  page int,
  created_at timestamptz not null default now()
);
create index if not exists offers_store_idx on offers(store, valid_to);

create table if not exists recipes (
  id text primary key,
  name text not null,
  category text not null,
  base int not null default 2,
  minutes int,
  freeze_months int default 3,
  sides text,
  thaw text,
  ingredients jsonb not null default '[]',
  steps jsonb not null default '[]',
  source text,
  active boolean not null default true,  -- false = czeka w banku przepisów
  activated_at timestamptz,
  removed boolean not null default false, -- usunięty w aplikacji (nie wraca przy imporcie)
  created_at timestamptz not null default now()
);

create table if not exists reactions (
  recipe_id text not null references recipes(id) on delete cascade,
  member text not null,
  liked boolean not null default false,
  wanted boolean not null default false,
  primary key (recipe_id, member)
);

create table if not exists list_items (
  id uuid primary key default gen_random_uuid(),
  product_id text references products(id) on delete set null,
  qty numeric,
  name text,
  manual boolean not null default false,
  pantry boolean not null default false,
  done boolean not null default false,
  recipe_id text,
  recipe_name text,
  servings int,
  batch text,
  member text,
  created_at timestamptz not null default now()
);

create table if not exists freezer (
  id uuid primary key default gen_random_uuid(),
  recipe_id text,
  name text not null,
  portions int not null default 2,
  frozen_on date not null default current_date,
  member text
);

create table if not exists scrape_runs (
  id bigint generated always as identity primary key,
  store text not null,
  leaflet text,
  valid_from date,
  valid_to date,
  pages int,
  offers int,
  matched int,
  status text,
  message text,
  ran_at timestamptz not null default now()
);

alter table products add column if not exists kw jsonb;
alter table recipes add column if not exists active boolean not null default true;
alter table recipes add column if not exists activated_at timestamptz;
alter table recipes add column if not exists removed boolean not null default false;

-- dostęp: tylko zalogowane konto domu
do $$
declare t text;
begin
  foreach t in array array['products','prices','offers','recipes','reactions','list_items','freezer','scrape_runs'] loop
    execute format('alter table %I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'dom') then
      execute format('create policy dom on %I for all to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end $$;

-- zmiany na żywo dla domowników
do $$
declare t text;
begin
  foreach t in array array['prices','recipes','reactions','list_items','freezer'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;
