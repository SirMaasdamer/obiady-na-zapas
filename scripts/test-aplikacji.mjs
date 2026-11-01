// Testy aplikacji w Chromium: dwa „telefony”, atrapa Supabase (scripts/atrapa-supabase.mjs), polityka CSP,
// praca bez sieci, zaproszenia, zmiana klucza, eksport, paragony (pdf.js i OCR z web/vendor/).
//   npx playwright install chromium && npm run test:aplikacja
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer, handle, routeRealtime, M, SUPA, served, rowsOf, newHouse, wsLog } from './atrapa-supabase.mjs';

let fails = 0;
const ok = (c, m) => { if (c) console.log('✓', m); else { fails++; console.log('✗', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { } await sleep(step); } return null; }

const { server, app: APP } = await startServer();
const browser = await chromium.launch();
const problems = [];
async function phone(name) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', acceptDownloads: true });
  await ctx.route(SUPA + '/**', handle);
  await routeRealtime(ctx);
  await ctx.addInitScript(() => document.addEventListener('securitypolicyviolation', e => console.error('CSP-NARUSZENIE ' + e.violatedDirective + ' ' + e.blockedURI)));
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' || t.includes('CSP')) problems.push(`[${name}] ${m.type()}: ${t}`); });
  page.on('pageerror', e => problems.push(`[${name}] BŁĄD STRONY: ${e.message}`));
  return { ctx, page, name };
}
const toastText = page => page.locator('#toast').textContent();

try {
  /* 1. Telefon A: nowy dom */
  const A = await phone('A');
  await A.page.goto(APP);
  await A.page.locator('#welcome').waitFor();
  ok(await A.page.locator('#w-known').isHidden(), 'A: bez znanych domów lista jest ukryta');
  await A.page.fill('#w-member', 'Ania');
  await A.page.fill('#w-house', 'Dom testowy');
  await A.page.click('#c-btn');
  await A.page.locator('#app').waitFor();
  const keyA = await until(() => new URL(A.page.url()).searchParams.get('dom'));
  ok(/^[0-9a-f]{64}$/.test(keyA || ''), 'A: klucz domu w adresie (?dom=)');
  ok(await until(() => A.page.locator('.card[data-act="open"]').count().then(n => n >= 24)), 'A: przepisy wczytane z bazy (pierwsza partia)');
  await A.page.locator('#rmore').scrollIntoViewIfNeeded();
  ok(await until(() => A.page.locator('.card[data-act="open"]').count().then(n => n > 24)), 'A: kolejne przepisy dochodzą przy przewijaniu');
  await A.page.evaluate(() => window.scrollTo(0, 0));
  ok(await A.page.locator('.deal').count() >= 1, 'A: baner promocji');
  const fam = await A.page.evaluate(() => getComputedStyle(document.body).fontFamily);
  ok(fam.includes('Plus Jakarta Sans'), 'A: font z vendor/ ustawiony');
  ok(await A.page.evaluate(() => document.fonts.check('16px "Plus Jakarta Sans"')), 'A: font wczytany z vendor/');

  /* 2. Lista zakupów */
  await A.page.locator('.card[data-act="open"]').first().click();
  await A.page.locator('[data-act="to-list"]').click();
  ok(await until(() => rowsOf('list_items', keyA).length > 0), 'A: składniki trafiły do bazy');
  const li = rowsOf('list_items', keyA);
  ok(li.every(r => /^[0-9a-f-]{36}$/.test(r.id)), 'A: wiersze listy mają identyfikatory z telefonu');
  const ins = M.log.find(l => l.method === 'POST' && l.path.endsWith('/list_items'));
  ok(/ignore-duplicates/.test(ins?.prefer || ''), 'A: wstawianie bez dublowania (ignore-duplicates)');
  ok(await until(() => A.page.locator('#lbadge').isVisible()), 'A: licznik na zakładce Lista');
  await A.page.click('button.tab[data-tab="lista"]');
  await A.page.locator('#llist .item').first().waitFor();

  /* 3. Telefon B dołącza z zaproszenia (#dom=) */
  const B = await phone('B');
  await B.page.goto(APP + '#dom=' + keyA);
  await B.page.locator('#f-join').waitFor({ state: 'visible' });
  ok((await B.page.locator('#j-title').textContent()).includes('Dom testowy'), 'B: zaproszenie pokazuje nazwę domu');
  await B.page.fill('#w-member', 'Bartek');
  await B.page.click('#j-btn');
  await B.page.locator('#app').waitFor();
  ok(!B.page.url().includes('#dom='), 'B: zaproszenie usunięte z adresu po wejściu');
  await B.page.click('button.tab[data-tab="lista"]');
  ok(await until(() => B.page.locator('#llist .item').count().then(n => n > 0)), 'B: widzi listę domu');

  /* 4. Synchronizacja przez kanał domu: B odhacza, A widzi */
  const pid = await B.page.locator('#llist [data-act="tick"]').first().getAttribute('data-pid');
  await B.page.locator(`#llist [data-act="tick"][data-pid="${pid}"]`).click();
  ok(await until(() => rowsOf('list_items', keyA).filter(r => r.product_id === pid).every(r => r.done)), 'B: odhaczenie zapisane w bazie');
  ok(await until(() => wsLog.some(m => m.event === 'zmiana' && (m.payload?.t || []).includes('list_items'))), 'B: sygnał na kanale domu z nazwą tabeli');
  ok(await until(() => A.page.locator(`#llist [data-act="tick"][data-pid="${pid}"].on`).count().then(n => n > 0), 6000), 'A: widzi odhaczenie bez odświeżania');

  /* 5. Bez sieci: zapis czeka w telefonie, po powrocie sieci trafia do bazy */
  const pid2 = await B.page.locator('#llist [data-act="tick"]:not(.on)').first().getAttribute('data-pid');
  M.down = true; await B.ctx.setOffline(true);
  await B.page.locator(`#llist [data-act="tick"][data-pid="${pid2}"]`).click();
  ok(await B.page.locator(`#llist [data-act="tick"][data-pid="${pid2}"].on`).count() > 0, 'B (offline): odhaczenie widać od razu');
  ok(await until(() => B.page.locator('#offline').isVisible()), 'B (offline): baner braku połączenia');
  ok(await until(async () => (await B.page.locator('#offline').textContent()).includes('zapiszę')), 'B (offline): baner mówi o zmianach czekających w telefonie');
  await B.page.reload(); // aplikacja z pamięci (service worker + IndexedDB)
  await B.page.locator('#app').waitFor();
  await B.page.click('button.tab[data-tab="lista"]');
  ok(await until(() => B.page.locator(`#llist [data-act="tick"][data-pid="${pid2}"].on`).count().then(n => n > 0)), 'B (offline, po ponownym otwarciu): zmiana nadal widoczna');
  ok(!rowsOf('list_items', keyA).filter(r => r.product_id === pid2).every(r => r.done), 'B (offline): baza jeszcze bez zmiany');
  M.down = false; await B.ctx.setOffline(false);
  ok(await until(() => rowsOf('list_items', keyA).filter(r => r.product_id === pid2).every(r => r.done)), 'B (po powrocie sieci): zmiana wysłana do bazy');
  ok(await until(() => B.page.locator('#offline').isHidden()), 'B: baner zniknął');

  /* 6. Service worker: klucz domu nie trafia do serwera strony */
  const before = served.length;
  await A.page.reload(); await A.page.locator('#app').waitFor();
  const after = served.slice(before);
  ok(after.length > 0 && !after.some(u => u.includes('dom=')), `A: po instalacji service workera serwer nie widzi ?dom= (${after.filter(u => u.endsWith('/')).join(', ')})`);

  /* 7. Link do innego domu: pytanie zamiast cichego przełączenia */
  const other = newHouse('Obcy dom');
  await A.page.goto(APP + '#dom=' + other.key);
  await A.page.locator('#w-switch').waitFor({ state: 'visible' });
  ok((await A.page.locator('#w-switch').textContent()).includes('Obcy dom'), 'A: pytanie o przełączenie na inny dom');
  await A.page.click('[data-act="stay-house"]');
  await A.page.locator('#app').waitFor();
  ok(new URL(A.page.url()).searchParams.get('dom') === keyA, 'A: „Zostań” – dalej własny dom');
  await A.page.goto(APP + '#dom=' + other.key);
  await A.page.click('[data-act="switch-house"]');
  await until(() => new URL(A.page.url()).searchParams.get('dom') === other.key);
  await A.page.locator('#app').waitFor();
  await A.page.click('#who');
  ok(await A.page.locator('[data-act="open-known"]').count() === 1, 'A: poprzedni dom na liście znanych domów');
  await A.page.click('[data-act="open-known"]');
  await until(() => new URL(A.page.url()).searchParams.get('dom') === keyA);
  await A.page.locator('#app').waitFor();
  ok(new URL(A.page.url()).searchParams.get('dom') === keyA, 'A: powrót do własnego domu jednym stuknięciem');

  /* 8. Prośby o przepisy: statusy i limit z bazy */
  await A.page.click('button.tab[data-tab="przepisy"]');
  await A.page.click('#v-przepisy [data-act="ask"]');
  for (const q of ['burrito', 'tikka masala', 'leczo', 'bigos']) {
    await A.page.fill('#ask-q', q); await A.page.click('#f-ask button[type="submit"]');
    await sleep(900);
  }
  ok(rowsOf('recipe_requests', keyA).length === 3, 'A: 3 prośby zapisane, 4. odrzucona przez limit');
  ok((await toastText(A.page)).includes('najwyżej 3'), 'A: komunikat limitu z bazy (P0001) pokazany');
  const reqIns = M.log.filter(l => l.path.endsWith('/recipe_requests') && l.method === 'POST');
  ok(reqIns.every(l => Object.keys(Array.isArray(l.body) ? l.body[0] : l.body).every(k => ['query', 'member'].includes(k))), 'A: prośba wysyła tylko query i member');
  M.rows.recipe_requests.find(r => r.query === 'burrito').status = 'w_trakcie';
  M.rows.recipe_requests.find(r => r.query === 'leczo').status = 'blad';
  M.rows.recipe_requests.find(r => r.query === 'leczo').note = 'Nie znalazłem sprawdzonego przepisu.';
  M.hhv.set(M.houses.get(keyA).id + '|recipe_requests', new Date().toISOString());
  await A.page.click('[data-act="close"]').catch(() => { });
  await A.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(800);
  await A.page.click('#v-przepisy [data-act="ask"]');
  const sheet = await A.page.locator('#sheet-in').textContent();
  ok(sheet.includes('Claude szuka') && sheet.includes('nie udało się') && sheet.includes('Nie znalazłem'), 'A: statusy w_trakcie/blad i powód pokazane');
  await A.page.click('[data-act="close"]');

  /* 9. Eksport danych domu */
  await A.page.click('#who');
  const [dl] = await Promise.all([A.page.waitForEvent('download'), A.page.click('[data-act="export"]')]);
  const data = JSON.parse(await readFile(await dl.path(), 'utf8'));
  ok(data.dom === 'Dom testowy' && data.tabele.list_items.length === rowsOf('list_items', keyA).length && data.tabele.recipe_requests.length === 3, 'A: eksport JSON z danymi domu');

  /* 10. Usunięcie domu, gdy funkcji jeszcze nie ma w bazie */
  await A.page.click('[data-act="ask-delete"]');
  await A.page.click('[data-act="delete-house"]');
  ok(await until(async () => (await toastText(A.page)).includes('nie jest jeszcze włączone')), 'A: łagodny komunikat bez funkcji delete_household');
  ok(new URL(A.page.url()).searchParams.get('dom') === keyA, 'A: dom nie został opuszczony');

  /* 11. Zmiana klucza: B traci dostęp i widzi komunikat */
  await A.page.click('[data-act="ask-rotate"]');
  await A.page.click('[data-act="rotate"]');
  const newKey = await until(() => { const k = new URL(A.page.url()).searchParams.get('dom'); return k && k !== keyA ? k : null; });
  ok(!!newKey && M.houses.has(newKey) && !M.houses.has(keyA), 'A: nowy klucz domu');
  await A.page.locator('#sheet-in').waitFor();
  ok((await A.page.locator('#sheet-in').textContent()).includes('Klucz zmieniony'), 'A: po zmianie klucza prośba o wysłanie nowego linku');
  ok(await until(() => B.page.locator('#lost').isVisible(), 8000), 'B: komunikat o utracie dostępu (sygnał ze starego kanału)');

  /* 12. Paragony: PDF z tekstem, PDF z obrazkiem (OCR) – biblioteki z vendor/ pod CSP */
  const gen = await browser.newPage();
  const receiptHtml = `<pre style="font:30px/1.5 'DejaVu Sans Mono',monospace;padding:30px;margin:0;color:#000;background:#fff">BIEDRONKA
JERONIMO MARTINS POLSKA
PARAGON FISKALNY
2026-10-30
Mleko UHT 1L       2 x3,49   6,98C
Ser gouda          1 x8,99   8,99C
Banany luz     0,756 x4,99   3,77C
SUMA PLN                    19,74</pre>`;
  await gen.setContent(receiptHtml);
  const textPdf = await gen.pdf({ width: '600px', height: '700px' });
  const png = await gen.locator('pre').screenshot();
  await gen.setContent(`<img src="data:image/png;base64,${png.toString('base64')}" style="width:100%">`);
  const imgPdf = await gen.pdf({ width: '800px', height: '900px' });
  await gen.close();
  await A.page.click('[data-act="close"]');
  await A.page.click('button.tab[data-tab="wydatki"]');
  await A.page.setInputFiles('#rfile', { name: 'paragon.pdf', mimeType: 'application/pdf', buffer: textPdf });
  ok(await until(() => A.page.locator('[data-act="save-receipt"]').isVisible(), 20000), 'A: PDF z tekstem odczytany (pdf.js z vendor/)');
  const items1 = await A.page.locator('#sheet-in .ri').count();
  ok(items1 >= 3, `A: pozycje z PDF (${items1})`);
  await A.page.click('[data-act="save-receipt"]');
  const keyNow = new URL(A.page.url()).searchParams.get('dom');
  ok(await until(() => rowsOf('receipts', keyNow).length === 1 && rowsOf('receipt_items', keyNow).length >= 3), 'A: paragon i pozycje zapisane (z identyfikatorami z telefonu)');
  await A.page.setInputFiles('#rfile', { name: 'skan.pdf', mimeType: 'application/pdf', buffer: imgPdf });
  ok(await until(() => A.page.locator('[data-act="save-receipt"]').isVisible(), 120000, 500), 'A: PDF z obrazkiem odczytany przez OCR (tesseract z vendor/)');
  const ocrText = await A.page.locator('#sheet-in pre').textContent();
  ok(/mleko/i.test(ocrText) && /19[,.]74/.test(ocrText), `A: OCR rozpoznał tekst (${ocrText.replace(/\s+/g, ' ').slice(0, 80)}…)`);
  await A.page.click('[data-act="close"]');
  await A.page.setInputFiles('#rfile', { name: 'zrzut.png', mimeType: 'image/png', buffer: png });
  ok(await until(() => A.page.locator('[data-act="save-receipt"]').isVisible(), 60000, 500), 'A: zrzut ekranu odczytany przez OCR');
  await A.page.click('[data-act="close"]');

  /* 13. Ceny: pochodzenie ceny regularnej, ostrzeżenie o przebiegu, HTML z nazwy oferty nie jest wykonywany */
  await A.page.click('button.tab[data-tab="ceny"]');
  ok((await A.page.locator('#pstores').textContent()).includes('mniej ofert niż zwykle'), 'A: ostrzeżenie o słabym przebiegu scrapera');
  ok(await A.page.locator('#plist b').count() === 0 && (await A.page.locator('#plist').textContent()).includes('<b>testowa</b>'), 'A: HTML z nazwy oferty pokazany jako tekst');
  await A.page.click('#pm-table');
  ok((await A.page.locator('#plist').textContent()).includes('szac.'), 'A: ceny „szac.” w tabeli');

  /* 15. Aktualizacja ze starej wersji (localStorage) i stary format zaproszenia (?dom=) */
  const U = await phone('U');
  const old = newHouse('Stary dom');
  await U.page.goto(APP + 'manifest.webmanifest');
  await U.page.evaluate(({ k }) => {
    localStorage.setItem('onz_house', JSON.stringify({ key: k, name: 'Stary dom' }));
    localStorage.setItem('onz_member', JSON.stringify('Celina z bardzo długim imieniem, które przekracza czterdzieści znaków'));
    localStorage.setItem('onz_cache_recipes', JSON.stringify([{ id: 'stary-przepis', name: 'Przepis z pamięci', category: 'zupy', ingredients: [], steps: [] }]));
  }, { k: old.key });
  M.down = true;
  await U.page.goto(APP);
  await U.page.locator('#app').waitFor();
  ok(await until(() => U.page.locator('.card[data-act="open"]').count().then(n => n === 1)), 'U: bez sieci dane ze starej pamięci (localStorage) widoczne');
  M.down = false;
  await U.page.evaluate(() => window.dispatchEvent(new Event('online')));
  ok(await until(() => U.page.locator('.card[data-act="open"]').count().then(n => n >= 24)), 'U: po połączeniu katalog z bazy');
  ok(await U.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('onz_cache_')).length) === 0, 'U: stara pamięć w localStorage usunięta');
  await U.page.click('.card[data-act="open"] [data-act="like"]');
  ok(await until(() => rowsOf('reactions', old.key).length === 1 && rowsOf('reactions', old.key)[0].member.length <= 40), 'U: zbyt długie imię skrócone do limitu bazy');
  const V = await phone('V');
  await V.page.goto(APP + '?dom=' + old.key);
  await V.page.locator('#f-join').waitFor({ state: 'visible' });
  ok((await V.page.locator('#j-title').textContent()).includes('Stary dom'), 'V: stary link ?dom= nadal działa (z potwierdzeniem)');

  /* 14. Ramka: aplikacja nie daje się osadzić */
  const F = await phone('F');
  await F.page.setContent(`<iframe src="${APP}" style="width:400px;height:600px"></iframe>`);
  await sleep(1500);
  const frame = F.page.frames().find(f => f.url().startsWith(APP));
  ok(frame && await frame.evaluate(() => getComputedStyle(document.documentElement).display === 'none'), 'Ramka: aplikacja ukryta w cudzej stronie');
} catch (e) { fails++; console.log('✗ WYJĄTEK', e); }

const csp = problems.filter(p => p.includes('CSP'));
ok(csp.length === 0, 'Brak naruszeń CSP' + (csp.length ? ': ' + csp.slice(0, 5).join(' | ') : ''));
const errs = problems.filter(p => !p.includes('CSP') && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR|FetchError|Failed to fetch|NetworkError/.test(p));
ok(errs.length === 0, 'Brak błędów w konsoli' + (errs.length ? ':\n  ' + errs.slice(0, 12).join('\n  ') : ''));
await browser.close(); server.close();
console.log(fails ? `\n${fails} niepowodzeń` : '\nWszystkie testy przeglądarki przeszły.');
process.exit(fails ? 1 : 0);
