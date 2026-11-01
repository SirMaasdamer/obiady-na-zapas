create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('obiady-sync', '17 * * * *', $$ select net.http_post(url := 'https://jnomchdxgmoegbpfjtii.supabase.co/functions/v1/sync', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000) $$);
