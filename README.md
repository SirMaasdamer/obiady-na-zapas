# Obiady na Zapas

Aplikacja na telefon dla domów, które gotują obiady na kilka dni i mrożą porcje.

- **Przepisy w kategoriach** z przelicznikiem porcji. Nowe dania dobierasz z banku przepisów albo zamawiasz u Claude.
- **Wspólna lista zakupów** dla domowników, z wyborem najtańszego sklepu.
- **Ceny promocyjne** Biedronki, Lidla i Kauflandu, pobierane automatycznie w poniedziałki i czwartki rano.
- **Ulubione i „Zróbmy to”** dla każdego domownika.
- **Zamrażarka:** ile porcji zostało i co zjeść najpierw.

## Dla użytkowników
1. Otwórz adres aplikacji w Safari i stuknij **Udostępnij → Do ekranu początkowego**.
2. Otwórz aplikację z ikony, wpisz imię i **załóż dom**.
3. Domowników zapraszasz linkiem z ustawień domu (stuknij swoje imię u góry).

Każdy dom ma własną listę, zamrażarkę i ulubione. Przepisy i ceny z gazetek są wspólne dla wszystkich. Znajomemu wyślij zwykły adres aplikacji, a założy własny dom.

## Jak to działa
- `web/`: aplikacja (PWA), publikowana na GitHub Pages przez workflow **Publikacja aplikacji**.
- Baza Supabase:
  - wspólne tabele (produkty, ceny, oferty, przepisy) zapisuje tylko funkcja `sync`;
  - tabele domów chroni tajny klucz domu wysyłany w nagłówku `x-dom` (polityki RLS w `supabase/migrations/001_init.sql`).
- **Ceny z gazetek** (workflow, poniedziałki i czwartki):
  1. Playwright otwiera strony ofert i gazetki sklepów;
  2. tekst odczytuje pdftotext albo Tesseract (OCR);
  3. `scripts/extract.mjs` dopasowuje produkty z katalogu;
  4. wynik trafia do `dane/oferty.json`;
  5. funkcja `sync` wgrywa go do bazy.

  Nie ma tu żadnych sekretów ani płatnego AI.
- **Nowe przepisy:** Claude dopisuje paczkę do `przepisy/` (format w `PRZEPISY.md`). Workflow **Nowe przepisy** sprawdza ją, buduje `dane/katalog.json` i synchronizuje bazę.
- Funkcja `sync` uruchamia się też co godzinę (pg_cron).
- `npm test`: testy logiki cen, odczytu ofert i sprawdzania przepisów.
