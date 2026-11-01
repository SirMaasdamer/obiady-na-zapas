-- Wersje tabel domu nie są zapisywane dla domu, który właśnie jest usuwany (kaskada z households):
-- inaczej wstawienie do hh_versions naruszałoby klucz obcy i blokowało usunięcie domu.
create or replace function private.touch_hh_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare hh uuid;
begin
  if TG_OP = 'DELETE' then hh := old.household_id; else hh := new.household_id; end if;
  if hh is not null and exists (select 1 from public.households h where h.id = hh) then
    insert into public.hh_versions (household_id, tbl, changed_at) values (hh, TG_TABLE_NAME, now())
    on conflict (household_id, tbl) do update set changed_at = excluded.changed_at;
  end if;
  return null;
end $$;
revoke execute on function private.touch_hh_version() from public;
