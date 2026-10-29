# Obiady na Zapas

Aplikacja na telefon dla domu, który gotuje obiady na kilka dni i mrozi porcje.

- **Przepisy w kategoriach:** ok. 35 dań na start. Przycisk „Wygeneruj nowe” dopisuje kolejne w wybranej kategorii.
- **Przelicznik porcji:** wpisujesz, ile porcji robisz, a składniki i koszt przeliczają się same.
- **Wspólna lista zakupów:** aplikacja liczy, czy taniej wyjdzie w jednym sklepie, czy w dwóch.
- **Ceny z gazetek:** Biedronka, Lidl i Kaufland, pobierane automatycznie w poniedziałki i czwartki rano.
- **Ulubione i „Zróbmy to”** dla każdego domownika.
- **Zamrażarka:** ile porcji zostało i co zjeść najpierw.

## Uruchomienie (ok. 20 minut, raz)

### 1. GitHub
1. Załóż konto na github.com.
2. Utwórz repozytorium `obiady-na-zapas` jako **Public**. Darmowe strony GitHub działają tylko dla publicznych repozytoriów. Twoje dane i tak są w bazie chronionej kodem domu, nie w kodzie.
3. Wgraj do niego ten kod. Może to zrobić Claude, jeśli połączysz GitHub w ustawieniach Claude → Connectors.

### 2. Supabase (baza)
1. Wejdź na supabase.com, zaloguj się przez GitHub i utwórz **New project** (region Frankfurt).
2. Skopiuj **identyfikator projektu**: Project Settings → General → **Project ID**, 20 znaków. Możesz też skopiować cały adres z paska przeglądarki.
3. Utwórz **token dostępu**: kliknij avatar → **Account preferences → Access Tokens → Generate new token**. Skopiuj go od razu, bo później nie będzie widoczny.

### 3. Anthropic (AI do gazetek i przepisów)
1. Wejdź na console.anthropic.com → **Billing** i doładuj 5 $.
2. W **Limits** ustaw limit miesięczny, np. 5 $. Dzięki temu nic Cię nie zaskoczy.
3. W **API Keys → Create Key** utwórz klucz i skopiuj go.

### 4. Sekrety w GitHub
W repozytorium wejdź w **Settings → Secrets and variables → Actions → New repository secret** i dodaj 4 sekrety:

| Nazwa | Wartość |
|---|---|
| `SUPABASE_PROJECT` | identyfikator projektu z kroku 2 |
| `SUPABASE_ACCESS_TOKEN` | token z kroku 2 |
| `ANTHROPIC_API_KEY` | klucz z kroku 3 (zaczyna się od `sk-ant-`) |
| `KOD_DOMU` | wymyślony kod dla domowników, co najmniej 6 znaków |

### 5. Strona aplikacji
W repozytorium wejdź w **Settings → Pages → Build and deployment → Source** i wybierz **GitHub Actions**.

### 6. Instalacja
1. W zakładce **Actions** zatwierdź uruchamianie workflowów, jeśli GitHub o to zapyta.
2. Wybierz **Instalacja i publikacja → Run workflow**.
3. Po ok. 3 minutach w podsumowaniu pojawi się adres aplikacji, np. `https://twoj-login.github.io/obiady-na-zapas/`.
4. Zaraz potem sam ruszy workflow **Ceny z gazetek**. Pierwsze pobranie trwa 10–20 minut.

### 7. Na iPhonie
1. Otwórz adres aplikacji w **Safari**.
2. Stuknij **Udostępnij → Do ekranu początkowego**.
3. Otwórz aplikację z ikony, wpisz kod domu i swoje imię. Domownicy robią to samo na swoich telefonach.

## Koszty
- GitHub i Supabase: 0 zł.
- Anthropic: płatność za użycie, szacunkowo 5–15 zł miesięcznie (odczyt gazetek dwa razy w tygodniu i generowanie przepisów). Limit ustawisz w konsoli Anthropic.

## Gdy coś nie działa
- **Czerwony krzyżyk w Actions:** otwórz przebieg i przeczytaj ostatni komunikat. Skrypty piszą po polsku, czego brakuje, np. „Brak sekretu KOD_DOMU”.
- **Brak cen ze sklepu:** w aplikacji (Ceny) zobaczysz „ostatnia próba: błąd”. Sklepy czasem zmieniają strony z gazetkami. Wklej log z GitHub Actions do Claude, a poprawi skrypt.
- **Nowy kod domu:** zmień sekret `KOD_DOMU` i uruchom ponownie „Instalacja i publikacja”.
- **Ponowny odczyt gazetek:** Actions → Ceny z gazetek → Run workflow → zaznacz „Odczytaj ponownie”.
- **Brak aktywności:** darmowa baza Supabase usypia się po tygodniu bez ruchu. Cotygodniowe pobieranie gazetek ją podtrzymuje.

## Dla programistów
- `web/`: aplikacja (PWA, czysty JS, supabase-js z CDN). Logika cen i planu zakupów jest w `web/logic.js`, testy w `npm test`.
- `supabase/migrations/001_init.sql`: schemat, RLS (tylko zalogowane konto domu), realtime.
- `supabase/functions/generate-recipes`: generator przepisów (Claude API).
- `scripts/scrape.mjs`: Playwright otwiera stronę sklepu, Claude wybiera aktualną gazetkę spożywczą. Pobierany jest PDF, jeśli jest dostępny, a jeśli nie, zrzuty stron. Claude odczytuje oferty i dopasowuje je do katalogu.
- Modele można zmienić zmiennymi `READ_MODEL`, `PICK_MODEL` (skrypt) i sekretem funkcji `RECIPE_MODEL`.
