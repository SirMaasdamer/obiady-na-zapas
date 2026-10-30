# Obiady na Zapas

Aplikacja na telefon dla domu, który gotuje obiady na kilka dni i mrozi porcje.

- **Przepisy w kategoriach:** 34 dania na start i ok. 50 w banku. Przycisk „Nowe przepisy” dodaje kolejne z banku, najpierw te ze składnikami w promocji. Zupełnie nowe dania zamawiasz u Claude (patrz niżej).
- **Przelicznik porcji:** wpisujesz, ile porcji robisz, a składniki i koszt przeliczają się same.
- **Wspólna lista zakupów:** aplikacja liczy, czy taniej wyjdzie w jednym sklepie, czy w dwóch.
- **Ceny promocyjne:** Biedronka, Lidl i Kaufland, pobierane automatycznie w poniedziałki i czwartki rano. Całość jest darmowa, bez płatnego AI.
- **Ulubione i „Zróbmy to”** dla każdego domownika.
- **Zamrażarka:** ile porcji zostało i co zjeść najpierw.

## Uruchomienie (ok. 15 minut, raz)

### 1. GitHub
1. Załóż konto na github.com.
2. Utwórz repozytorium `obiady-na-zapas` jako **Public**. Darmowe strony GitHub działają tylko dla publicznych repozytoriów. Twoje dane i tak są w bazie chronionej kodem domu, nie w kodzie.
3. Wgraj do niego ten kod. Może to zrobić Claude, jeśli połączysz GitHub w ustawieniach Claude → Connectors.

### 2. Supabase (baza)
1. Wejdź na supabase.com, zaloguj się przez GitHub i utwórz **New project** (region Frankfurt).
2. Skopiuj **identyfikator projektu**: Project Settings → General → **Project ID**, 20 znaków. Możesz też skopiować cały adres z paska przeglądarki.
3. Utwórz **token dostępu**: kliknij avatar → **Account preferences → Access Tokens → Generate new token**. Skopiuj go od razu, bo później nie będzie widoczny.

### 3. Sekrety w GitHub
W repozytorium wejdź w **Settings → Secrets and variables → Actions → New repository secret** i dodaj 3 sekrety:

| Nazwa | Wartość |
|---|---|
| `SUPABASE_PROJECT` | identyfikator projektu z kroku 2 |
| `SUPABASE_ACCESS_TOKEN` | token z kroku 2 |
| `KOD_DOMU` | wymyślony kod dla domowników, co najmniej 6 znaków |

### 4. Strona aplikacji
W repozytorium wejdź w **Settings → Pages → Build and deployment → Source** i wybierz **GitHub Actions**.

### 5. Instalacja
1. W zakładce **Actions** zatwierdź uruchamianie workflowów, jeśli GitHub o to zapyta.
2. Wybierz **Instalacja i publikacja → Run workflow**.
3. Po ok. 3 minutach w podsumowaniu pojawi się adres aplikacji, np. `https://twoj-login.github.io/obiady-na-zapas/`.
4. Zaraz potem sam ruszy workflow **Ceny z gazetek**. Pierwsze pobranie trwa 5–15 minut.

### 6. Na iPhonie
1. Otwórz adres aplikacji w **Safari**.
2. Stuknij **Udostępnij → Do ekranu początkowego**.
3. Otwórz aplikację z ikony, wpisz kod domu i swoje imię. Domownicy robią to samo na swoich telefonach.

## Nowe przepisy od Claude
Napisz do Claude, np. „dodaj 4 przepisy z drobiu pod aktualne promocje”. Claude:
1. czyta katalog produktów i plik `dane/promocje.json`, który aktualizuje się przy każdym pobraniu cen;
2. układa przepisy i zapisuje je w folderze `przepisy/`.

Workflow **Nowe przepisy** sprawdza plik i wgrywa dania do bazy. W aplikacji pojawiają się po kilku minutach z etykietą „Nowe”. Format pliku i zasady opisuje `PRZEPISY.md`. Korzysta to z Twojej subskrypcji Claude, więc nic nie kosztuje dodatkowo.

## Koszty
Wszystko jest darmowe: GitHub (strona i automatyczne pobieranie cen) oraz Supabase (baza).

## Skąd są ceny
1. **Strony „oferta tygodnia” sklepów.** Ceny są tam zwykłym tekstem, więc odczyt jest najdokładniejszy.
2. **Gazetka w PDF z tekstem**, odczytywana programem pdftotext.
3. **Gazetka jako obrazki**, odczytywana darmowym OCR (Tesseract). Ceny w kolorowych „dymkach” OCR czyta słabo, dlatego takie wyniki przyjmuję tylko wtedy, gdy są blisko ceny regularnej. Oznaczam je jako „odczyt OCR, sprawdź w sklepie”.

Każda cena jest porównywana z ceną regularną produktu. Wartości wyraźnie od niej odbiegające są odrzucane.

## Gdy coś nie działa
- **Czerwony krzyżyk w Actions:** otwórz przebieg i przeczytaj ostatni komunikat. Skrypty piszą po polsku, czego brakuje, np. „Brak sekretu KOD_DOMU”.
- **Brak cen ze sklepu:** w aplikacji (Ceny) zobaczysz „ostatnia próba: błąd”. Sklepy czasem zmieniają swoje strony. Wklej log z GitHub Actions do Claude, a poprawi skrypt.
- **Produkt nie łapie się na promocję:** dopisz słowo kluczowe w `seed/products.json` (pole `kw`) i uruchom instalację ponownie.
- **Nowy kod domu:** zmień sekret `KOD_DOMU` i uruchom ponownie „Instalacja i publikacja”.
- **Ręczne odświeżenie cen:** Actions → Ceny z gazetek → Run workflow.
- **Brak aktywności:** darmowa baza Supabase usypia się po tygodniu bez ruchu. Cotygodniowe pobieranie gazetek ją podtrzymuje.

## Dla programistów
- `web/`: aplikacja (PWA, czysty JS, supabase-js z CDN). Logika cen i planu zakupów jest w `web/logic.js`.
- `supabase/migrations/001_init.sql`: schemat, RLS (tylko zalogowane konto domu), realtime.
- `scripts/scrape.mjs`: Playwright, pdftotext i Tesseract. `scripts/extract.mjs`: dopasowanie produktów i cen bez AI.
- `npm test`: testy logiki i odczytu ofert na przykładowych tekstach.
