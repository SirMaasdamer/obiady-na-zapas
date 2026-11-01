# Nowe przepisy od Claude

Nowe przepisy układa Claude w rozmowie, np. „dodaj 4 przepisy z mielonego, coś azjatyckiego”, i zapisuje je jako plik JSON w folderze `przepisy/`. Po wgraniu pliku workflow **Nowe przepisy** sprawdza go i dodaje dania do bazy. W aplikacji pojawiają się po kilku minutach z etykietą „Nowe”.

## Instrukcja dla Claude

1. Przeczytaj `seed/products.json` (katalog produktów) i wszystkie pliki w `przepisy/`. Korzystaj z istniejących `id` produktów i nie powtarzaj nazw dań, które już są w `seed/recipes.json` i `przepisy/`.
2. Przeczytaj pole `promos` w `dane/oferty.json` (aktualne promocje z Biedronki, Lidla i Kauflandu). Preferuj składniki, które są teraz w promocji.
3. Zasady dań: obiady gotowane na zapas dla 2 osób. Główny element dania, który dobrze znosi mrożenie i odgrzewanie, a dodatki robi się na świeżo. Kuchnia domowa, składniki z polskich dyskontów.
4. Zapisz jeden plik na zamówienie: `przepisy/RRRR-MM-DD-krotki-opis.json`.
5. Sprawdź i zbuduj katalog: `node scripts/import-recipes.mjs` (nie potrzebuje bazy ani bibliotek). Popraw wszystkie błędy, dopiero wtedy wgraj plik razem z `dane/katalog.json` do gałęzi `main`.

## Format pliku

```json
{
  "opis": "4 przepisy z mielonego, kuchnia azjatycka",
  "products": [
    { "id": "sos_hoisin", "name": "Sos hoisin", "unit": "łyżka", "pantry": true },
    { "id": "kapusta_pekinska", "name": "Kapusta pekińska", "unit": "kg", "pack": 1, "loose": true,
      "cat": "warzywa", "kw": ["kapusta pekinska"], "regular": { "b": 4.99, "l": 4.49, "k": 4.79 } }
  ],
  "recipes": [
    {
      "id": "mielone-hoisin",
      "category": "mielone",
      "name": "Mielone w sosie hoisin z kapustą pekińską",
      "minutes": 30,
      "freeze_months": 3,
      "sides": "ryż, makaron ryżowy",
      "thaw": "Odgrzewaj na patelni, mieszając.",
      "ingredients": [
        { "pid": "mielone_wp", "amt": 300, "unit": "g" },
        { "pid": "kapusta_pekinska", "amt": 200, "unit": "g" },
        { "pid": "sos_hoisin", "amt": 2, "unit": "łyżka" }
      ],
      "steps": ["Podsmaż mięso.", "Dodaj kapustę i sos, duś 10 minut."]
    }
  ]
}
```

**Przepisy:**
- `category`: `drob`, `mielone`, `wieprzowina`, `wolowina`, `zupy`, `wege` albo `makaron`.
- Ilości zawsze na **2 porcje**. Aplikacja sama przelicza je na wybraną liczbę porcji.
- Jednostki:
  - produkt w `kg` podawaj w `g`, a produkt w `l` w `ml`;
  - `szt` i `pęczek` bez zmian;
  - czosnek w `ząbek`;
  - przyprawy i inne produkty ze spiżarni w `łyżka`, `łyżeczka` albo `szt`.
- `id` przepisu: małe litery, cyfry i `-`, bez polskich znaków, unikalne.
- Opcjonalnie `inspired_by` (np. „Ewa Wachowicz”) i `source_url` (link do oryginału) przy daniach inspirowanych cudzym przepisem. Kroki zawsze pisz własnymi słowami, a ilości dostosuj do 2 porcji.

**Nowe produkty** (tylko gdy w katalogu nie ma odpowiednika):
- `id`: małe litery, cyfry i `_`.
- `unit`: `kg`, `l`, `szt`, `pęczek`, a dla spiżarni `łyżka` z `"pantry": true`.
- `pack`: typowe opakowanie w tej jednostce, np. 0.4 dla puszki 400 g.
- `loose`: `true` dla produktów na wagę.
- `kw`: słowa, po których produkt znajdzie się w ofertach sklepów. Małe litery, bez polskich znaków.
- `regular`: orientacyjne ceny regularne za opakowanie (`b` Biedronka, `l` Lidl, `k` Kaufland).
- Produkty ze spiżarni (`pantry`) nie potrzebują `pack`, `kw` ani `regular`.

## Prośby z aplikacji („Brakuje przepisu?”)

Domownicy wpisują w aplikacji danie, którego brakuje. Prośby trafiają do tabeli `recipe_requests` w Supabase (projekt `jnomchdxgmoegbpfjtii`). Zaplanowane zadanie Claude realizuje je kilka razy dziennie:

1. Pobierz prośby: `select id, query from recipe_requests where status = 'czeka' order by created_at limit 5;`. Jeśli nie ma żadnej, zakończ pracę.
2. Oznacz je jako realizowane: `update recipe_requests set status = 'w_toku' where id in (...);`.
3. Dla każdej prośby:
   - Poszukaj w internecie 2–3 sprawdzonych przepisów na to danie, najlepiej z polskich stron. Dodaj `inspired_by` i `source_url` tylko wtedy, gdy masz prawdziwy link do strony z przepisem.
   - Ułóż z nich 2–3 przepisy w formacie opisanym wyżej, z krokami pisanymi własnymi słowami. Jeśli danie słabo znosi mrożenie, dodaj `"freezer": false`. Możesz też zamrozić tylko jego główną część, np. farsz do burrito, a resztę robić na świeżo.
   - Sprawdź, czy podobne danie nie jest już w bazie. Jeśli jest, dodaj inne wersje.
   - Jeśli prośba nie jest daniem obiadowym albo jest niezrozumiała, ustaw jej status `nie_udalo` z krótkim wyjaśnieniem w kolumnie `note`.
4. Zapisz wszystko w jednym pliku `przepisy/RRRR-MM-DD-prosby-GGMM.json`, uruchom `node scripts/import-recipes.mjs` i popraw błędy.
5. Wgraj zmiany do `main`. Workflow **Nowe przepisy** zbuduje katalog i zsynchronizuje bazę. Poczekaj, aż przepisy pojawią się w bazie: `select id from recipes where id = any(array[...]);`.
6. Zamknij każdą prośbę: `update recipe_requests set status = 'gotowe', recipe_ids = array[...], note = null, done_at = now() where id = '...';`.
