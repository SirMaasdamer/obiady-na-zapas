create table public.hh_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  device text check (device is null or char_length(device) <= 40),
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index hh_members_hh on public.hh_members (household_id);
alter table public.hh_members enable row level security;
create policy dom on public.hh_members for select to anon, authenticated using (household_id = (select private.current_household()));
revoke all on public.hh_members from anon, authenticated;
grant select (id, household_id, name, device, created_at, last_seen) on public.hh_members to anon, authenticated;
comment on table public.hh_members is 'Telefony domowników. Zapis tylko przez funkcje join_household, member_touch, remove_member, leave_household.';

create table public.hh_invites (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid references public.hh_members(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days'
);
create index hh_invites_hh on public.hh_invites (household_id);
create index hh_invites_by on public.hh_invites (created_by);
alter table public.hh_invites enable row level security;
revoke all on public.hh_invites from anon, authenticated;
comment on table public.hh_invites is 'Kody zaproszeń (skróty). Brak polityk RLS jest celowy: dostęp wyłącznie przez funkcje.';
