-- prośba może mieć link do strony z przepisem (https, do 500 znaków, bez spacji i znaków < > " { })
alter table public.recipe_requests add column if not exists url text
  constraint recipe_requests_url_ok check (url is null or (char_length(url) <= 500 and url ~ '^https://[^[:space:]<>"{}]+$'));
grant insert (url) on public.recipe_requests to anon, authenticated;

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
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', id, 'query', query, 'url', url)) order by created_at), '[]'::jsonb) into v
    from public.recipe_requests where status = 'w_trakcie';
  return v;
end $$;
