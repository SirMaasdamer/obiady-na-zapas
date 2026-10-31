-- Obiady na Zapas: baza dla wielu domów.
-- Wspólne dla wszystkich: katalog produktów, ceny z gazetek, przepisy (zapisuje je tylko funkcja „sync”).
-- Osobne dla każdego domu: lista zakupów, zamrażarka, ulubione, odblokowane przepisy, własne ceny.
-- Dom rozpoznajemy po tajnym kluczu wysyłanym przez aplikację w nagłówku „x-dom”.

-- ---------- domy ----------
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  secret text not null unique,
  name text not null default 'Mój dom',
  created_at timestamptz not null default now()
);
alter table households enable row level security; -- brak polityk: dostęp tylko przez funkcje poniżej

create or replace function public.current_household() returns uuid
language sql stable security definer set search_path = public as $$
  select id from households
  where secret = nullif(current_setting('request.headers', true)::json->>'x-dom', '')
$$;

create or replace function public.create_household(p_name text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare h households;
begin
  insert into households(secret, name)
  values (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), coalesce(nullif(trim(p_name), ''), 'Mój dom'))
  returning * into h;
  return json_build_object('id', h.id, 'name', h.name, 'secret', h.secret);
end $$;

create or replace function public.household_info() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('id', id, 'name', name) from households where id = public.current_household()
$$;

create or replace function public.rename_household(p_name text) returns void
language sql volatile security definer set search_path = public as $$
  update households set name = coalesce(nullif(trim(p_name), ''), name) where id = public.current_household()
$$;

revoke all on function public.current_household() from public;
grant execute on function public.current_household(), public.create_household(text), public.household_info(), public.rename_household(text) to anon, authenticated;

-- ---------- wspólne: katalog, ceny, oferty, przepisy ----------
create table if not exists products (
  id text primary key,
  name text not null,
  unit text not null,              -- kg | l | szt | pęczek | łyżka (spiżarnia)
  pack numeric not null default 1, -- rozmiar opakowania w jednostce unit
  loose boolean not null default false,
  cat text,
  pantry boolean not null default false,
  conv jsonb,                      -- np. {"ząbek":0.1}
  kw jsonb,                        -- słowa kluczowe do wyszukiwania w ofertach
  updated_at timestamptz not null default now()
);

create table if not exists prices (
  product_id text not null references products(id) on delete cascade,
  store text not null check (store in ('b','l','k')),
  regular numeric,                 -- orientacyjna cena regularna
  promo numeric,                   -- cena z aktualnej oferty / gazetki
  promo_from date,
  promo_to date,
  promo_note text,
  updated_at timestamptz not null default now(),
  primary key (product_id, store)
);

create table if not exists offers (
  id bigint generated always as identity primary key,
  store text not null,
  product_id text references products(id) on delete set null,
  name text not null,
  price numeric,
  price_for_pack numeric,
  regular numeric,
  unit_info text,
  valid_from date,
  valid_to date,
  note text,
  page text,
  leaflet text
);

create table if not exists scrape_runs (
  store text not null,
  ran_at timestamptz not null,
  status text,
  message text,
  valid_from date,
  valid_to date,
  matched int,
  primary key (store, ran_at)
);

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
  source text,                     -- seed | claude
  default_active boolean not null default true, -- false = czeka w banku przepisów
  added_on date,
  updated_at timestamptz not null default now()
);

create table if not exists sync_state (
  key text primary key,
  hash text,
  synced_at timestamptz not null default now()
);

-- ---------- osobne dla każdego domu ----------
create table if not exists hh_recipes (
  household_id uuid not null default public.current_household() references households(id) on delete cascade,
  recipe_id text not null references recipes(id) on delete cascade,
  active boolean not null default true,
  removed boolean not null default false,
  activated_at timestamptz default now(),
  primary key (household_id, recipe_id)
);

create table if not exists reactions (
  household_id uuid not null default public.current_household() references households(id) on delete cascade,
  recipe_id text not null references recipes(id) on delete cascade,
  member text not null,
  liked boolean not null default false,
  wanted boolean not null default false,
  primary key (household_id, recipe_id, member)
);

create table if not exists list_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household() references households(id) on delete cascade,
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
create index if not exists list_items_hh on list_items(household_id);

create table if not exists freezer (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household() references households(id) on delete cascade,
  recipe_id text,
  name text not null,
  portions int not null default 2,
  frozen_on date not null default current_date,
  member text
);
create index if not exists freezer_hh on freezer(household_id);

create table if not exists hh_prices (
  household_id uuid not null default public.current_household() references households(id) on delete cascade,
  product_id text not null references products(id) on delete cascade,
  store text not null check (store in ('b','l','k')),
  regular numeric not null,
  updated_at timestamptz not null default now(),
  primary key (household_id, product_id, store)
);

-- ---------- dostęp ----------
do $$
declare t text;
begin
  -- wspólne: każdy czyta, nikt nie zapisuje z aplikacji (tylko funkcja „sync” kluczem serwisowym)
  foreach t in array array['products','prices','offers','scrape_runs','recipes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists czytanie on %I', t);
    execute format('create policy czytanie on %I for select to anon, authenticated using (true)', t);
  end loop;
  alter table sync_state enable row level security;
  -- domowe: tylko dane własnego domu
  foreach t in array array['hh_recipes','reactions','list_items','freezer','hh_prices'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists dom on %I', t);
    execute format('create policy dom on %I for all to anon, authenticated using (household_id = public.current_household()) with check (household_id = public.current_household())', t);
  end loop;
end $$;
