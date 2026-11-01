-- Tabele wspólne i households: aplikacja tylko czyta (wspólne) albo korzysta z funkcji (households).
revoke all on public.households from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.products, public.recipes, public.scrape_runs, public.prices, public.offers from anon, authenticated;
revoke truncate, references, trigger on public.hh_recipes, public.reactions, public.list_items, public.freezer, public.hh_prices, public.receipts, public.receipt_items, public.hh_settings, public.recipe_requests from anon, authenticated;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from anon, authenticated;
