create table if not exists recipe_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household() references households(id) on delete cascade,
  query text not null check (length(trim(query)) between 2 and 200),
  member text,
  status text not null default 'czeka' check (status in ('czeka', 'w_toku', 'gotowe', 'nie_udalo')),
  note text,
  recipe_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists recipe_requests_hh on recipe_requests(household_id);
create index if not exists recipe_requests_status on recipe_requests(status) where status in ('czeka', 'w_toku');
alter table recipe_requests enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'recipe_requests' and policyname = 'dom') then
    create policy dom on recipe_requests for all to anon, authenticated
      using (household_id = public.current_household()) with check (household_id = public.current_household());
  end if;
end $$;
grant select, insert, delete on recipe_requests to anon, authenticated;
revoke update on recipe_requests from anon, authenticated;
