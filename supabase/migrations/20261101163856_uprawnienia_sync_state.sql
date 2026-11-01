-- sync_state: tylko dla funkcji serwisowych.
revoke all on public.sync_state from anon, authenticated;
