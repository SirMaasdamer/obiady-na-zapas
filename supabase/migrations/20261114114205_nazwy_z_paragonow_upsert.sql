-- zapis z aplikacji to upsert (ON CONFLICT DO UPDATE ustawia wszystkie wysłane kolumny), więc także household_id i raw; RLS pilnuje domu
grant update (household_id, raw) on public.hh_aliases to anon, authenticated;
