-- Nowy model danych wspólnych:
-- * oferty jako obserwacje (tylko dopisywanie), aktualny stan jako widoki zgodne z aplikacją (prices, offers),
-- * ceny regularne z pochodzeniem: szacunek z katalogu albo przekreślona cena z gazetek (ostatnie 60 dni),
-- * wersje zbiorów (aplikacja pobiera katalog i oferty tylko po zmianie),
-- * wycofywanie przepisów zamiast usuwania, walidacja katalogu w bazie,
-- * funkcje przyjmujące dane z GitHub Actions (tylko service_role, wywołuje je funkcja ingest),
-- * eksport i zamykanie próśb o przepisy bez dostępu zadania Claude do bazy.

create schema if not exists backup;
revoke all on schema backup from public, anon, authenticated;

-- 1) walidacja katalogu w bazie (ostatnia zapora przed niebezpieczną treścią)
create or replace function private.valid_ingredients(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(j) = 'array' and jsonb_array_length(j) <= 40 and not exists (
    select 1 from jsonb_array_elements(j) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e->>'unit', '') not in ('g', 'ml', 'kg', 'l', 'szt', 'pęczek', 'łyżka', 'łyżeczka', 'ząbek')
       or coalesce(e->>'pid', '') !~ '^[a-z0-9_]{1,60}$'
       or coalesce(case when jsonb_typeof(e->'amt') = 'number' then (e->>'amt')::numeric end, 0) not between 0.0001 and 100000)
$$;
create or replace function private.valid_steps(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(j) = 'array' and jsonb_array_length(j) <= 30 and not exists (
    select 1 from jsonb_array_elements(j) s
    where jsonb_typeof(s) <> 'string' or char_length(s #>> '{}') > 1000 or (s #>> '{}') ~ '[<>]')
$$;
create or replace function private.valid_conv(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select j is null or (jsonb_typeof(j) = 'object' and not exists (
    select 1 from jsonb_each(j) c
    where c.key not in ('g', 'ml', 'kg', 'l', 'szt', 'pęczek', 'łyżka', 'łyżeczka', 'ząbek')
       or coalesce(case when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::numeric end, 0) <= 0))
$$;
create or replace function private.valid_keywords(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select j is null or (jsonb_typeof(j) = 'array' and jsonb_array_length(j) <= 20 and not exists (
    select 1 from jsonb_array_elements(j) k
    where jsonb_typeof(k) <> 'string' or char_length(k #>> '{}') not between 1 and 60 or (k #>> '{}') ~ '[<>]'))
$$;
revoke all on function private.valid_ingredients(jsonb), private.valid_steps(jsonb), private.valid_conv(jsonb), private.valid_keywords(jsonb) from public;
grant execute on function private.valid_ingredients(jsonb), private.valid_steps(jsonb), private.valid_conv(jsonb), private.valid_keywords(jsonb) to service_role;

alter table public.recipes add column if not exists retired_at timestamptz;
alter table public.recipes
  add constraint recipes_id_format check (id ~ '^[a-z0-9-]{1,120}$'),
  add constraint recipes_category check (category in ('drob', 'mielone', 'wieprzowina', 'wolowina', 'zupy', 'wege', 'makaron')),
  add constraint recipes_text check (char_length(name) between 2 and 200 and name !~ '[<>]'
    and char_length(coalesce(sides, '')) <= 300 and coalesce(sides, '') !~ '[<>]'
    and char_length(coalesce(thaw, '')) <= 800 and coalesce(thaw, '') !~ '[<>]'
    and char_length(coalesce(inspired_by, '')) <= 120 and coalesce(inspired_by, '') !~ '[<>]'
    and char_length(coalesce(source, '')) <= 20),
  add constraint recipes_source_url check (source_url is null or (source_url ~ '^https://[^\s"''<>]+$' and char_length(source_url) <= 500)),
  add constraint recipes_numbers check ((minutes is null or minutes between 1 and 1440)
    and (freeze_months is null or freeze_months between 0 and 24) and base between 1 and 20),
  add constraint recipes_ingredients check (private.valid_ingredients(ingredients)),
  add constraint recipes_steps check (private.valid_steps(steps));
alter policy czytanie on public.recipes using (retired_at is null);

alter table public.products
  add constraint products_id_format check (id ~ '^[a-z0-9_]{1,60}$'),
  add constraint products_unit check (unit in ('kg', 'l', 'szt', 'pęczek', 'łyżka')),
  add constraint products_text check (char_length(name) between 1 and 120 and name !~ '[<>]'
    and char_length(coalesce(cat, '')) <= 40 and coalesce(cat, '') !~ '[<>]'),
  add constraint products_pack check (pack > 0 and pack < 10000),
  add constraint products_conv check (private.valid_conv(conv)),
  add constraint products_kw check (private.valid_keywords(kw));

alter table public.scrape_runs add column if not exists run_id text;
alter table public.scrape_runs
  add constraint scrape_runs_values check (store in ('b', 'l', 'k') and status in ('ok', 'error', 'ostrzezenie')
    and char_length(coalesce(message, '')) <= 500);

-- 2) obserwacje ofert, szacowane ceny regularne, wersje zbiorów
create table public.offer_observations (
  id bigint generated always as identity primary key,
  run_id text not null check (run_id ~ '^[0-9A-Za-z_.-]{1,40}$'),
  store text not null check (store in ('b', 'l', 'k')),
  product_id text not null references public.products (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200 and name !~ '[<>]'),
  price numeric check (price is null or (price > 0 and price < 10000)),
  price_for_pack numeric not null check (price_for_pack > 0 and price_for_pack < 10000),
  regular numeric check (regular is null or (regular > 0 and regular < 10000)),
  unit_info text check (unit_info is null or (char_length(unit_info) <= 40 and unit_info !~ '[<>]')),
  valid_from date,
  valid_to date not null,
  note text check (note is null or (char_length(note) <= 200 and note !~ '[<>]')),
  source text not null check (source in ('gazetki.pl', 'json', 'www', 'pdf', 'ocr')),
  page text check (page is null or (char_length(page) <= 40 and page !~ '[<>]')),
  leaflet text check (leaflet is null or (leaflet ~ '^https://[^\s"''<>]+$' and char_length(leaflet) <= 500)),
  observed_at timestamptz not null default now(),
  superseded_at timestamptz,
  check (valid_from is null or valid_to >= valid_from)
);
create index offer_observations_current on public.offer_observations (product_id, store, valid_to) where superseded_at is null;
create index offer_observations_run on public.offer_observations (run_id, store);
create index offer_observations_store_time on public.offer_observations (store, observed_at desc);
alter table public.offer_observations enable row level security;
create policy czytanie on public.offer_observations for select to anon, authenticated using (true);

create table public.estimated_prices (
  product_id text not null references public.products (id) on delete cascade,
  store text not null check (store in ('b', 'l', 'k')),
  regular numeric not null check (regular > 0 and regular < 10000),
  updated_at timestamptz not null default now(),
  primary key (product_id, store)
);
alter table public.estimated_prices enable row level security;
create policy czytanie on public.estimated_prices for select to anon, authenticated using (true);

create table public.dataset_versions (
  key text primary key check (key in ('katalog', 'oferty')),
  version text not null check (char_length(version) <= 64),
  updated_at timestamptz not null default now()
);
alter table public.dataset_versions enable row level security;
create policy czytanie on public.dataset_versions for select to anon, authenticated using (true);
insert into public.dataset_versions (key, version) values ('katalog', 'start'), ('oferty', 'start');

revoke insert, update, delete, truncate, references, trigger on public.offer_observations, public.estimated_prices, public.dataset_versions from anon, authenticated;

-- 3) przeniesienie obecnych danych
insert into public.estimated_prices (product_id, store, regular, updated_at)
select product_id, store, regular, updated_at from public.prices
 where regular is not null and regular > 0 and regular < 10000;

insert into public.offer_observations (run_id, store, product_id, name, price, price_for_pack, regular, unit_info,
  valid_from, valid_to, note, source, page, leaflet, observed_at)
select 'migracja-2026-11-01', o.store, o.product_id, left(regexp_replace(o.name, '[<>]', ' ', 'g'), 200), o.price, o.price_for_pack, o.regular,
       left(regexp_replace(o.unit_info, '[<>]', ' ', 'g'), 40), o.valid_from, coalesce(o.valid_to, coalesce(o.valid_from, current_date) + 6),
       left(regexp_replace(o.note, '[<>]', ' ', 'g'), 200),
       case when o.page = 'gazetki.pl' then 'gazetki.pl' when o.page = 'json' then 'json' when o.page = 'www' then 'www'
            when o.note ilike '%OCR%' then 'ocr' else 'pdf' end,
       left(o.page, 40), case when o.leaflet ~ '^https://[^\s"''<>]+$' and char_length(o.leaflet) <= 500 then o.leaflet end,
       coalesce((select max(r.ran_at) from public.scrape_runs r where r.store = o.store), now())
  from public.offers o
 where o.product_id is not null and o.price_for_pack > 0 and o.price_for_pack < 10000 and o.store in ('b', 'l', 'k')
   and (o.price is null or (o.price > 0 and o.price < 10000)) and (o.regular is null or (o.regular > 0 and o.regular < 10000));

-- dawne tabele trafiają do schematu backup (niedostępnego z API); w ich miejsce widoki o tych samych kolumnach
alter table public.prices set schema backup;
alter table public.offers set schema backup;

-- 4) widoki aktualnego stanu
create view public.current_promos with (security_invoker = true) as
select distinct on (o.product_id, o.store, o.valid_from, o.valid_to)
       o.id, o.product_id, o.store, o.name, o.price, o.price_for_pack as promo, o.regular,
       case when o.regular is not null and o.price > 0 then round(o.regular * o.price_for_pack / o.price, 2) end as regular_for_pack,
       o.unit_info, o.valid_from, o.valid_to, o.note, o.source, o.page, o.leaflet, o.run_id, o.observed_at
  from public.offer_observations o
 where o.superseded_at is null and o.valid_to >= (now() at time zone 'Europe/Warsaw')::date
 order by o.product_id, o.store, o.valid_from, o.valid_to,
          array_position(array['gazetki.pl', 'json', 'www', 'pdf', 'ocr'], o.source), o.observed_at desc;

create view public.offers with (security_invoker = true) as
select id, store, product_id, name, price, promo as price_for_pack, regular, unit_info, valid_from, valid_to, note, page, leaflet, source
  from public.current_promos;

create view public.prices with (security_invoker = true) as
with today as (select (now() at time zone 'Europe/Warsaw')::date as d),
promo as (
  select distinct on (c.product_id, c.store) c.product_id, c.store, c.promo, c.valid_from, c.valid_to,
         left(concat_ws(' · ', c.name, c.note), 200) as promo_note, c.observed_at
    from public.current_promos c cross join today t
   order by c.product_id, c.store, (coalesce(c.valid_from, t.d) > t.d), c.valid_from, c.promo
),
observed as (
  select o.product_id, o.store,
         round((percentile_cont(0.5) within group (order by (o.regular * o.price_for_pack / o.price)::double precision))::numeric, 2) as regular
    from public.offer_observations o
   where o.superseded_at is null and o.regular is not null and o.price > 0 and o.observed_at > now() - interval '60 days'
   group by o.product_id, o.store
),
keys as (
  select product_id, store from public.estimated_prices
  union select product_id, store from observed
  union select product_id, store from promo
)
select k.product_id, k.store,
       case when ob.regular is not null and (e.regular is null or ob.regular between e.regular * 0.4 and e.regular * 2.5)
            then ob.regular else e.regular end as regular,
       case when ob.regular is not null and (e.regular is null or ob.regular between e.regular * 0.4 and e.regular * 2.5) then 'gazetka'
            when e.regular is not null then 'szacunek' end as regular_src,
       p.promo, p.valid_from as promo_from, p.valid_to as promo_to, p.promo_note,
       greatest(e.updated_at, p.observed_at) as updated_at
  from keys k
  left join public.estimated_prices e on e.product_id = k.product_id and e.store = k.store
  left join observed ob on ob.product_id = k.product_id and ob.store = k.store
  left join promo p on p.product_id = k.product_id and p.store = k.store;

create view public.pipeline_health with (security_invoker = true) as
select s.store,
       (select max(r.ran_at) from public.scrape_runs r where r.store = s.store and r.status = 'ok') as ostatni_udany,
       (select r.status from public.scrape_runs r where r.store = s.store order by r.ran_at desc limit 1) as ostatni_status,
       (select r.matched from public.scrape_runs r where r.store = s.store order by r.ran_at desc limit 1) as ostatnio_dopasowane,
       (select count(*) from public.current_promos c where c.store = s.store) as aktualne_promocje,
       (select v.updated_at from public.dataset_versions v where v.key = 'oferty') as oferty_z,
       (select v.updated_at from public.dataset_versions v where v.key = 'katalog') as katalog_z
  from (values ('b'), ('l'), ('k')) as s (store);

revoke all on public.current_promos, public.offers, public.prices, public.pipeline_health from anon, authenticated;
grant select on public.current_promos, public.offers, public.prices, public.pipeline_health to anon, authenticated;

-- 5) prośby o przepisy: eksport do repozytorium i zamykanie po wgraniu katalogu (wywołuje funkcja ingest)
create or replace function public.export_recipe_requests(p_limit int default 5) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare v jsonb;
begin
  -- prośby, które utknęły ponad 12 h: wracają do kolejki, a po dwóch próbach kończą się błędem
  update public.recipe_requests
     set status = case when attempts >= 2 then 'blad' else 'czeka' end,
         note = case when attempts >= 2 then 'Nie udało się znaleźć przepisów po dwóch próbach.' else note end,
         done_at = case when attempts >= 2 then now() else done_at end
   where status = 'w_trakcie' and (claimed_at is null or claimed_at < now() - interval '12 hours');
  update public.recipe_requests r
     set status = 'w_trakcie', attempts = r.attempts + 1, claimed_at = now()
   where r.id in (
     select q.id from public.recipe_requests q
      where q.status = 'czeka'
      order by q.created_at
      limit greatest(0, coalesce(p_limit, 5) - (select count(*) from public.recipe_requests w where w.status = 'w_trakcie'))
      for update skip locked);
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'query', query) order by created_at), '[]'::jsonb) into v
    from public.recipe_requests where status = 'w_trakcie';
  return v;
end $$;

create or replace function public.finish_recipe_requests(p_results jsonb) returns integer
language plpgsql volatile security invoker set search_path = '' as $$
declare n integer;
begin
  with res as (
    select (x->>'id')::uuid as id,
           x->>'status' as status,
           (select coalesce(jsonb_agg(e.v), '[]'::jsonb)
              from jsonb_array_elements_text(case when jsonb_typeof(x->'recipe_ids') = 'array' then x->'recipe_ids' else '[]'::jsonb end) as e (v)
             where exists (select 1 from public.recipes rr where rr.id = e.v and rr.retired_at is null)) as ids,
           left(regexp_replace(nullif(btrim(x->>'note'), ''), '[<>]', ' ', 'g'), 300) as note
      from jsonb_array_elements(case when jsonb_typeof(p_results) = 'array' then p_results else '[]'::jsonb end) x
     where jsonb_typeof(x) = 'object'
       and x->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and x->>'status' in ('gotowe', 'blad')
  )
  update public.recipe_requests r
     set status = case when res.status = 'gotowe' and jsonb_array_length(res.ids) = 0 then 'blad' else res.status end,
         recipe_ids = res.ids,
         note = case when res.status = 'gotowe' and jsonb_array_length(res.ids) = 0
                     then coalesce(res.note, 'Nie znaleziono nowych przepisów.') else res.note end,
         done_at = now()
    from res
   where r.id = res.id and r.status in ('czeka', 'w_trakcie');
  get diagnostics n = row_count;
  return n;
end $$;

-- 6) przyjmowanie danych z GitHub Actions (wywołuje funkcja ingest kluczem serwisowym)
create or replace function public.ingest_offers(p_data jsonb, p_run_id text) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Europe/Warsaw')::date;
  v_store text; v_new int; v_prev int; v_prev_run text; v_inserted int;
  v_anomalies jsonb := '[]'::jsonb;
begin
  if p_run_id is null or p_run_id !~ '^[0-9A-Za-z_.-]{1,40}$' then
    raise exception 'Nieprawidłowy identyfikator przebiegu.';
  end if;
  if exists (select 1 from public.offer_observations where run_id = p_run_id) then
    return jsonb_build_object('inserted', 0, 'anomalies', '[]'::jsonb, 'duplicate', true);
  end if;

  insert into public.offer_observations (run_id, store, product_id, name, price, price_for_pack, regular, unit_info,
    valid_from, valid_to, note, source, page, leaflet)
  select p_run_id, x.store, x.product_id, x.name, x.price, x.price_for_pack, x.regular, x.unit_info,
         x.valid_from, coalesce(x.valid_to, coalesce(x.valid_from, v_today) + 6), x.note, x.source, x.page, x.leaflet
    from jsonb_to_recordset(coalesce(p_data->'offers', '[]'::jsonb)) as x (store text, product_id text, name text, price numeric,
         price_for_pack numeric, regular numeric, unit_info text, valid_from date, valid_to date, note text, source text, page text, leaflet text)
   where exists (select 1 from public.products pr where pr.id = x.product_id);
  get diagnostics v_inserted = row_count;

  -- przebieg, który ma mniej niż połowę dopasowań poprzedniego, nie zastępuje starszych obserwacji (anomalia)
  for v_store in
    select distinct r->>'store' from jsonb_array_elements(coalesce(p_data->'runs', '[]'::jsonb)) r
     where r->>'store' in ('b', 'l', 'k') and r->>'status' = 'ok'
  loop
    select count(*) into v_new from public.offer_observations where run_id = p_run_id and store = v_store;
    v_prev_run := null;
    select o.run_id into v_prev_run from public.offer_observations o
     where o.store = v_store and o.run_id <> p_run_id and o.superseded_at is null and o.valid_to >= v_today
     order by o.observed_at desc limit 1;
    select count(*) into v_prev from public.offer_observations
     where run_id = v_prev_run and store = v_store and superseded_at is null and valid_to >= v_today;
    if v_prev >= 6 and v_new < v_prev * 0.5 then
      v_anomalies := v_anomalies || jsonb_build_array(jsonb_build_object('store', v_store, 'nowe', v_new, 'poprzednio', v_prev));
    else
      update public.offer_observations o set superseded_at = now()
       where o.store = v_store and o.run_id <> p_run_id and o.superseded_at is null
         and exists (select 1 from public.offer_observations n
                      where n.run_id = p_run_id and n.store = v_store
                        and n.valid_from is not distinct from o.valid_from and n.valid_to = o.valid_to);
    end if;
  end loop;

  insert into public.scrape_runs (store, ran_at, status, message, valid_from, valid_to, matched, run_id)
  select r.store, r.ran_at,
         case when r.status = 'ok' and v_anomalies @> jsonb_build_array(jsonb_build_object('store', r.store)) then 'ostrzezenie' else r.status end,
         left(r.message, 500), r.valid_from, r.valid_to, r.matched, p_run_id
    from jsonb_to_recordset(coalesce(p_data->'runs', '[]'::jsonb)) as r (store text, ran_at timestamptz, status text, message text,
         valid_from date, valid_to date, matched int)
   where r.store in ('b', 'l', 'k') and r.status in ('ok', 'error') and r.ran_at > now() - interval '7 days'
  on conflict (store, ran_at) do nothing;

  insert into public.dataset_versions (key, version, updated_at) values ('oferty', p_run_id, now())
  on conflict (key) do update set version = excluded.version, updated_at = excluded.updated_at;

  return jsonb_build_object('inserted', v_inserted, 'anomalies', v_anomalies);
end $$;

create or replace function public.ingest_catalog(p_data jsonb, p_version text) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare v_products int; v_prices int; v_recipes int; v_retired int; v_requests int; v_count int;
begin
  if p_version is null or p_version !~ '^[0-9A-Za-z_.-]{1,64}$' then
    raise exception 'Nieprawidłowa wersja katalogu.';
  end if;
  v_count := jsonb_array_length(coalesce(p_data->'recipes', '[]'::jsonb));
  if v_count < 50 then
    raise exception 'Podejrzanie mały katalog (% przepisów). Przerwano, żeby nie wycofać przepisów.', v_count;
  end if;

  insert into public.products as t (id, name, unit, pack, loose, cat, pantry, conv, kw, updated_at)
  select x.id, x.name, x.unit, coalesce(x.pack, 1), coalesce(x.loose, false), x.cat, coalesce(x.pantry, false), x.conv, x.kw, now()
    from jsonb_to_recordset(coalesce(p_data->'products', '[]'::jsonb)) as x (id text, name text, unit text, pack numeric,
         loose boolean, cat text, pantry boolean, conv jsonb, kw jsonb)
  on conflict (id) do update set name = excluded.name, unit = excluded.unit, pack = excluded.pack, loose = excluded.loose,
    cat = excluded.cat, pantry = excluded.pantry, conv = excluded.conv, kw = excluded.kw, updated_at = now()
  where (t.name, t.unit, t.pack, t.loose, t.cat, t.pantry, t.conv, t.kw)
        is distinct from (excluded.name, excluded.unit, excluded.pack, excluded.loose, excluded.cat, excluded.pantry, excluded.conv, excluded.kw);
  get diagnostics v_products = row_count;

  insert into public.estimated_prices as t (product_id, store, regular, updated_at)
  select x->>'id', kv.key, kv.value::numeric, now()
    from jsonb_array_elements(coalesce(p_data->'products', '[]'::jsonb)) x
   cross join lateral jsonb_each_text(case when jsonb_typeof(x->'regular') = 'object' then x->'regular' else '{}'::jsonb end) kv
   where kv.key in ('b', 'l', 'k') and kv.value ~ '^[0-9]{1,4}(\.[0-9]{1,2})?$' and kv.value::numeric > 0
  on conflict (product_id, store) do update set regular = excluded.regular, updated_at = now()
  where t.regular is distinct from excluded.regular;
  get diagnostics v_prices = row_count;

  insert into public.recipes as t (id, name, category, base, minutes, freeze_months, sides, thaw, ingredients, steps, source,
    default_active, added_on, inspired_by, source_url, freezer, retired_at, updated_at)
  select x.id, x.name, x.category, coalesce(x.base, 2), x.minutes, coalesce(x.freeze_months, 3), coalesce(x.sides, ''), coalesce(x.thaw, ''),
         coalesce(x.ingredients, '[]'::jsonb), coalesce(x.steps, '[]'::jsonb), coalesce(x.source, 'seed'), coalesce(x.default_active, true),
         x.added_on, x.inspired_by, x.source_url, coalesce(x.freezer, true), null, now()
    from jsonb_to_recordset(coalesce(p_data->'recipes', '[]'::jsonb)) as x (id text, name text, category text, base int, minutes int,
         freeze_months int, sides text, thaw text, ingredients jsonb, steps jsonb, source text, default_active boolean, added_on date,
         inspired_by text, source_url text, freezer boolean)
  on conflict (id) do update set name = excluded.name, category = excluded.category, base = excluded.base, minutes = excluded.minutes,
    freeze_months = excluded.freeze_months, sides = excluded.sides, thaw = excluded.thaw, ingredients = excluded.ingredients,
    steps = excluded.steps, source = excluded.source, default_active = excluded.default_active, added_on = excluded.added_on,
    inspired_by = excluded.inspired_by, source_url = excluded.source_url, freezer = excluded.freezer, retired_at = null, updated_at = now()
  where (t.name, t.category, t.base, t.minutes, t.freeze_months, t.sides, t.thaw, t.ingredients, t.steps, t.source, t.default_active,
         t.added_on, t.inspired_by, t.source_url, t.freezer, t.retired_at)
        is distinct from (excluded.name, excluded.category, excluded.base, excluded.minutes, excluded.freeze_months, excluded.sides,
         excluded.thaw, excluded.ingredients, excluded.steps, excluded.source, excluded.default_active, excluded.added_on,
         excluded.inspired_by, excluded.source_url, excluded.freezer, null::timestamptz);
  get diagnostics v_recipes = row_count;

  update public.recipes r set retired_at = now(), updated_at = now()
   where r.retired_at is null
     and not exists (select 1 from jsonb_array_elements(coalesce(p_data->'recipes', '[]'::jsonb)) x where x->>'id' = r.id);
  get diagnostics v_retired = row_count;

  v_requests := public.finish_recipe_requests(p_data->'prosby');

  insert into public.dataset_versions (key, version, updated_at) values ('katalog', p_version, now())
  on conflict (key) do update set version = excluded.version, updated_at = excluded.updated_at;

  return jsonb_build_object('products', v_products, 'prices', v_prices, 'recipes', v_recipes, 'retired', v_retired, 'requests', v_requests);
end $$;

revoke all on function public.ingest_offers(jsonb, text), public.ingest_catalog(jsonb, text),
  public.export_recipe_requests(int), public.finish_recipe_requests(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_offers(jsonb, text), public.ingest_catalog(jsonb, text),
  public.export_recipe_requests(int), public.finish_recipe_requests(jsonb) to service_role;
