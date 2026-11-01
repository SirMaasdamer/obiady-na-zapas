-- Wersje danych domu: aplikacja pyta raz (app_state) i dociąga tylko tabele, które się zmieniły,
-- zamiast pobierać wszystkie tabele domu co minutę.
create table public.hh_versions (
  household_id uuid not null references public.households(id) on delete cascade,
  tbl text not null check (tbl in ('recipe_requests', 'hh_recipes', 'reactions', 'list_items', 'freezer', 'hh_prices', 'receipts', 'receipt_items', 'hh_settings')),
  changed_at timestamptz not null default now(),
  primary key (household_id, tbl)
);
alter table public.hh_versions enable row level security;
revoke all on public.hh_versions from anon, authenticated;
comment on table public.hh_versions is 'Kiedy ostatnio zmieniła się każda tabela domu. Bez polityk RLS celowo: odczyt tylko przez funkcję app_state().';

create function private.touch_hh_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare hh uuid;
begin
  if TG_OP = 'DELETE' then hh := old.household_id; else hh := new.household_id; end if;
  if hh is not null then
    insert into public.hh_versions (household_id, tbl, changed_at) values (hh, TG_TABLE_NAME, now())
    on conflict (household_id, tbl) do update set changed_at = excluded.changed_at;
  end if;
  return null;
end $$;
revoke execute on function private.touch_hh_version() from public;

create trigger hh_version after insert or update or delete on public.recipe_requests for each row execute function private.touch_hh_version();
create trigger hh_version after insert or update or delete on public.hh_recipes for each row execute function private.touch_hh_version();
create trigger hh_version after insert or update or delete on public.reactions for each row execute function private.touch_hh_version();
create trigger hh_version after insert or update or delete on public.list_items for each row execute function private.touch_hh_version();
create trigger hh_version after insert or update or delete on public.freezer for each row execute function private.touch_hh_version();
create trigger hh_version after insert or update or delete on public.hh_prices for each row execute function private.touch_hh_version();
create trigger hh_version after insert or update or delete on public.receipts for each row execute function private.touch_hh_version();
create trigger hh_version after insert or update or delete on public.receipt_items for each row execute function private.touch_hh_version();
create trigger hh_version after insert or update or delete on public.hh_settings for each row execute function private.touch_hh_version();

-- Jedno małe zapytanie przy starcie i powrocie do aplikacji: czy klucz domu działa, wersje zbiorów wspólnych
-- (katalog, oferty) i wersje tabel domu.
create function public.app_state() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'dom', (select json_build_object('id', h.id, 'name', h.name) from public.households h where h.id = private.current_household()),
    'zbiory', coalesce((select json_object_agg(d.key, d.version) from public.dataset_versions d), '{}'::json),
    'tabele', coalesce((select json_object_agg(v.tbl, v.changed_at) from public.hh_versions v where v.household_id = private.current_household()), '{}'::json)
  )
$$;
revoke execute on function public.app_state() from public;
grant execute on function public.app_state() to anon, authenticated;
comment on function public.app_state() is 'Stan dla aplikacji: dom z klucza x-dom (albo null), wersje zbiorów wspólnych i tabel domu.';
