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
  - Biblioteki (supabase-js, pdf.js, tesseract.js) i font leżą w `web/vendor/`, a polityka CSP w `index.html` pozwala uruchamiać tylko kod z tej strony. Opis i aktualizacja: `web/vendor/README.md`.
  - Dane działają też bez zasięgu: kopia w telefonie (IndexedDB) i kolejka zapisów wysyłana po powrocie internetu. Aplikacja pyta bazę o wersje danych (`app_state`) i pobiera tylko to, co się zmieniło.
  - Zaproszenie to link z kluczem domu po `#`. Klucz można zmienić w ustawieniach domu (stare linki przestają działać), a dane domu pobrać jako plik JSON.
- Baza Supabase (schemat i historia zmian: `supabase/migrations/`, dokładna kopia migracji z bazy):
  - dom rozpoznaje skrót SHA-256 klucza z nagłówka `x-dom` (funkcja `private.current_household()`, polityki RLS); baza nie przechowuje samych kluczy;
  - limity: długości tekstów, liczba wierszy na dom, dzienne limity zapisów, najwyżej 3 oczekujące prośby o przepisy na dom;
  - dane wspólne (produkty, przepisy, oferty) zapisuje tylko funkcja **`ingest`**, wywoływana przez workflowy GitHub z tokenem OIDC: tylko z gałęzi `main` tego repozytorium i tylko z właściwego workflowu. Nie ma żadnych sekretów do pilnowania.
- **Ceny z gazetek** (workflow, poniedziałki i czwartki):
  1. Playwright otwiera strony ofert i gazetki sklepów (tylko produkty z przepisów, z przerwami między stronami);
  2. tekst odczytuje pdftotext albo Tesseract (OCR), a `scripts/extract.mjs` dopasowuje produkty z katalogu;
  3. osobny job wysyła wynik do funkcji `ingest`: baza zapisuje obserwacje cen, a przebieg z podejrzanie małą liczbą ofert nie zastępuje poprzednich (workflow kończy się wtedy błędem, więc GitHub wysyła maila);
  4. podgląd aktualnych promocji trafia do `dane/oferty.json` (dla Claude), a zrzuty i logi do artefaktu workflowu na 7 dni.
- **Nowe przepisy:** Claude dopisuje paczkę do `przepisy/` (format w `PRZEPISY.md`). Workflow **Nowe przepisy** sprawdza ją, buduje katalog i wysyła go do bazy.
- **Prośby o przepisy:** workflow **Prośby o przepisy** co godzinę zapisuje prośby z aplikacji w `dane/prosby.json`. Zadanie Claude „Przepisy na życzenie” realizuje je według `PRZEPISY.md` i nie potrzebuje dostępu do bazy.
- Testy (workflow **Testy**):
  - `npm test`: logika cen, odczyt ofert, walidacja przepisów, zabezpieczenia (escapowanie, token OIDC);
  - `npm run test:aplikacja`: aplikacja w Chromium z atrapą Supabase (CSP, praca bez sieci, zaproszenia, klucz domu, paragony);
  - `npm run biblioteki:sprawdz`: pliki w `web/vendor/` zgodne z przypiętymi pakietami npm.
