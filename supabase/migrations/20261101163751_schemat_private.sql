-- Schemat na funkcje pomocnicze, niewystawiony w API.
create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;
