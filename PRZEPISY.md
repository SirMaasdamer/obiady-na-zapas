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
