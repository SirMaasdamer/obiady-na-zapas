#!/usr/bin/env bash
# Prosi funkcję „sync” w Supabase o wczytanie danych z bieżącego commitu (adres bazy bierze z web/config.js).
url=$(grep -oE 'https://[a-z0-9]{20}\.supabase\.co' web/config.js | head -1)
[ -z "$url" ] && { echo "Brak adresu bazy w web/config.js — pomijam synchronizację."; exit 0; }
sha=$(git rev-parse HEAD)
curl -sS -m 120 -X POST "$url/functions/v1/sync" -H 'Content-Type: application/json' -d "{\"sha\":\"$sha\"}"; echo
