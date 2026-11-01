# Biblioteki aplikacji

Aplikacja nie ładuje kodu z obcych serwerów (CDN). Wszystko, czego potrzebuje, leży tutaj,
a polityka bezpieczeństwa strony (CSP w `index.html`) pozwala uruchamiać tylko pliki z tej strony.

| Folder | Co to jest | Skąd |
|---|---|---|
| `supabase/` | klient bazy Supabase (`@supabase/supabase-js`) w jednym pliku | npm, łączone przez esbuild |
| `pdfjs/` | odczyt paragonów w PDF (`pdfjs-dist`, wersja „legacy” dla starszych iPhone'ów) | npm |
| `tesseract/` | rozpoznawanie tekstu ze zdjęć paragonów (`tesseract.js`, rdzeń WebAssembly, dane języka polskiego) | npm |
| `fonts/` | font Plus Jakarta Sans (licencja OFL, `fonts/OFL.txt`) | github.com/tokotype/PlusJakartaSans |

Foldery `supabase/`, `pdfjs/` i `tesseract/` tworzy skrypt `scripts/vendor.mjs` z wersji przypiętych
w `package.json` i `package-lock.json`. Sumy SHA-256 wszystkich plików są w `WERSJE.json`.
Test w CI (`npm run biblioteki:sprawdz`) sprawdza, że pliki tutaj są dokładnie takie, jak w pakietach npm.

## Aktualizacja

1. Zmień wersję w `package.json` (albo poczekaj na pull request od Dependabota).
2. Uruchom workflow **Biblioteki przeglądarki** (Actions → Run workflow). Wynik trafi na nową gałąź `biblioteki-…`.
3. Przejrzyj zmiany, scal i podbij wersję pamięci podręcznej w `web/sw.js` (`CACHE`).

Fontu nie aktualizuje skrypt: to plik `fonts/webfonts/PlusJakartaSans[wght].woff2` z repozytorium autora.
