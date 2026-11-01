// Szybkie testy logiki cen i planu zakupów na danych startowych.
import { readFileSync } from 'node:fs';
import * as L from '../web/logic.js';
import { parseJson } from './lib.mjs';
import { matchOffers, findValidity, scoreLink, norm } from './extract.mjs';
const products = JSON.parse(readFileSync(new URL('../seed/products.json', import.meta.url)));
const recipes = JSON.parse(readFileSync(new URL('../seed/recipes.json', import.meta.url)));
L.setTable('products', products.map(({ regular, ...p }) => p));
L.setTable('recipes', recipes);
const prices = products.flatMap(p => Object.entries(p.regular || {}).map(([store, regular]) => ({ product_id: p.id, store, regular })));
prices.find(p => p.product_id === 'kurczak_filet' && p.store === 'l').promo = 14.99;
prices.find(p => p.product_id === 'kurczak_filet' && p.store === 'l').promo_to = '2099-01-01';
prices.push({ product_id: 'mascarpone', store: 'b', regular: 6.99, promo: 3.99, promo_to: '2000-01-01' }); // wygasła
L.setTable('prices', prices.filter((p, i, a) => a.findIndex(x => x.product_id === p.product_id && x.store === p.store) === i || p.promo_to === '2000-01-01').reverse().filter((p, i, a) => a.findIndex(x => x.product_id === p.product_id && x.store === p.store) === i));
let fails = 0; const eq = (a, b, m) => { if (a !== b) { fails++; console.log('✗', m, a, '!==', b); } else console.log('✓', m); };
eq(L.priceOf('kurczak_filet', 'l').p, 14.99, 'aktywna promocja');
eq(L.priceOf('mascarpone', 'b').p, 6.99, 'wygasła promocja → cena regularna');
const r = L.S.recipes['kurczak-mascarpone'], c = L.recipeCost(r, 8);
eq(c.promos.some(x => x.pid === 'kurczak_filet' && x.s === 'l'), true, 'promocja widoczna w koszcie');
eq(Object.values(c.miss).every(v => v === 0), true, 'wszystkie składniki mają ceny');
for (const rr of recipes) for (const i of rr.ingredients) { const p = L.S.products[i.pid]; if (!p.pantry && L.factor(i.unit, p) == null) { fails++; console.log('✗ jednostka', rr.id, i.pid, i.unit); } }
console.log('✓ jednostki składników zgodne z produktami');
L.S.list_items = r.ingredients.map((i, k) => ({ id: 'x' + k, product_id: i.pid, qty: L.needOf(i, 4, L.S.products[i.pid]) }));
const { rows, pantry } = L.aggList(); const ps = L.plans(rows); const { rec } = L.pickPlan(ps, 8);
console.log('  plany:', ps.map(p => p.key + '=' + p.total.toFixed(2)).join(' '), '→ polecany', rec.key);
eq(rec.key, 'l', 'polecany sklep Lidl (promocja na kurczaka)');
eq(pantry.length > 0, true, 'przyprawy w „Sprawdź w domu”');
eq(L.buyText(L.S.products.mascarpone, 0.4), '2 × 250 g', 'opakowania mascarpone');
eq(parseJson('Oto wynik:\n```json\n{"a":{"b":"}"},"c":[1]}\n```').c[0], 1, 'parsowanie JSON z odpowiedzi');

// --- darmowy odczyt gazetek ---
const cat = products.filter(p => !p.pantry).map(p => ({ ...p, ref: Object.values(p.regular).reduce((a, b) => a + b) / 3 }));
const leaflet = [
  { page: 1, text: `OFERTA WAŻNA OD 30.10 DO 02.11\nFILET Z PIERSI KURCZAKA\nkrajowy, pakowany\n24,99\n14,99 zł/kg\n\nMascarpone Galbani 250 g\n5,49 zł\ncena za szt.\n` },
  { page: 2, text: `Mięso mielone wieprzowe 500 g\n8 99 zł\nKoncentrat pomidorowy 30% 200 g  2,79\nCebula żółta luz  1,99 /kg\nKalendarz 2027  19,99\nPapryka czerwona 1 kg 7,99 zł oferta 30.10–02.11` },
];
const offs = Object.fromEntries(matchOffers(leaflet, cat).map(o => [o.product_id, o]));
eq(offs.kurczak_filet?.price_for_pack, 14.99, 'kurczak: cena za kg z gazetki, nie przekreślona');
eq(offs.kurczak_filet?.regular, 24.99, 'kurczak: cena przed obniżką');
eq(offs.mascarpone?.price_for_pack, 5.49, 'mascarpone 250 g');
eq(offs.mielone_wp?.price_for_pack, 17.98, 'mielone 500 g za 8,99 (OCR „8 99 zł”) → 17,98 zł/kg');
eq(offs.koncentrat?.price_for_pack, 2.79, 'koncentrat');
eq(offs.cebula?.price_for_pack, 1.99, 'cebula za kg');
eq(offs.papryka?.price_for_pack, 7.99, 'papryka: data nie udaje ceny');
eq(Object.keys(offs).includes('kalafior'), false, 'brak fałszywych dopasowań');
const tiles = [{ page: 'www', src: 'www', text: `Oferta ważna od 30.10.2026 do 02.11.2026\nPolski kurczak\nFilet z piersi kurczaka\nopak. ok. 1 kg\n-40%\n24,99 zł\n14,99 zł/kg\nDo koszyka\nGalbani\nSer mascarpone\n250 g\n7,49\n5,99 zł\n23,96 zł/kg\nDo koszyka\nPassata pomidorowa\n500 g\n3,49 zł\n6,98 zł/l\n` }];
const t2 = Object.fromEntries(matchOffers(tiles, cat).map(o => [o.product_id, o]));
eq(t2.kurczak_filet?.price_for_pack, 14.99, 'kafelki: kurczak 14,99 zł/kg');
eq(t2.mascarpone?.price_for_pack, 5.99, 'kafelki: mascarpone 5,99 (nie 23,96 zł/kg)');
eq(t2.passata?.price_for_pack, 3.49, 'kafelki: passata 500 g');
const v = findValidity(leaflet.map(p => p.text).join('\n'), '2026-10-30');
eq(v?.valid_from + '|' + v?.valid_to, '2026-10-30|2026-11-02', 'okres ważności gazetki');
eq(scoreLink({ href: 'https://leaflets.kaufland.com/pl-PL/PL_pl_KDZ_1060_PL44-LFT/ar/1060', text: 'Gazetka tygodnia 29.10 – 04.11' }) > scoreLink({ href: 'https://leaflets.kaufland.com/pl-PL/PL_pl_leaflet5_0_PL44/ar/0', text: 'Katalog znicze' }), true, 'gazetka tygodnia wygrywa z katalogiem zniczy');
eq(norm('Łopatka ŻÓŁTA').length, 'Łopatka ŻÓŁTA'.length, 'normalizacja zachowuje pozycje');

// --- paczki przepisów od Claude ---
const { validate } = await import('./batches.mjs');
const example = JSON.parse(readFileSync(new URL('../PRZEPISY.md', import.meta.url), 'utf8').match(/```json\n([\s\S]*?)```/)[1]);
const base = { seedProducts: products, seedRecipes: recipes };
eq(validate({ ...base, batches: [{ file: 'przyklad.json', ...example }] }).length, 0, 'przykład z PRZEPISY.md jest poprawny');
const bad = { file: 'zly.json', products: [{ id: 'nowy_ser', name: 'Ser', unit: 'kg', pack: 0.2 }], recipes: [
  { id: 'bolognese', category: 'makaron', name: 'X', ingredients: [{ pid: 'mielone_wol', amt: 1, unit: 'g' }, { pid: 'mielone_wol', amt: 1, unit: 'g' }], steps: ['a', 'b'] },
  { id: 'nowe-danie', category: 'ryby', name: 'Y', ingredients: [{ pid: 'nie_ma', amt: 1, unit: 'g' }, { pid: 'cebula', amt: 2, unit: 'szklanka' }], steps: ['a'] }] };
const errs = validate({ ...base, batches: [bad] });
eq(errs.length, 8, 'błędne przepisy są wyłapywane (' + errs.length + ')');
eq(errs.some(e => e.includes('„szklanka” spoza listy')), true, 'jednostka spoza listy jest nazwana w komunikacie');

// --- paragony ---
const R = await import('../web/receipt.js');
const bied = `Jeronimo Martins Polska S.A.\nBiedronka nr 1234\nNIP 779-10-11-327\n2026-10-30 nr wydr. 123456\nPARAGON FISKALNY\nMleko UHT 3,2% 1L C   2 x3,49   6,98C\nFilet z piersi kurczaka A\n  1,036 x22,99   23,82A\nRabat                  -3,00A\nPieczarki 500g C   1 x6,99   6,99C\nBanany luz C   0,756 x4,99   3,77C\nSPRZEDAŻ OPODATK. A   20,82\nPTU A 8,00%   1,54\nSUMA PLN   38,56\nKarta płatnicza   38,56`;
const lidl = `Lidl sp. z o.o. sp.k.\n30.10.2026 18:42\nFilet z piersi kurczaka XXL        15,53 A\n1,036 kg x 14,99 PLN/kg\nMascarpone 250 g                    5,49 B\nPassata pomidorowa 500 g            6,98 B\n2 x 3,49\nRabat Lidl Plus                    -1,00\nSuma                               27,00 PLN`;
for (const [n, t, cnt, total] of [['Biedronka', bied, 4, 38.56], ['Lidl', lidl, 3, 27]]) {
  const r = R.parseReceipt(t, '2026-10-31');
  eq(r.items.length + '|' + r.total + '|' + (Math.abs(r.sum - r.total) < 0.02), cnt + '|' + total + '|' + true, `paragon ${n}: pozycje, suma, zgodność`);
}
const rb = R.parseReceipt(bied, '2026-10-31');
eq(rb.store + '|' + rb.bought_on, 'b|2026-10-30', 'paragon: sklep i data');
eq(rb.items[1].discount + '|' + rb.items[1].total + '|' + rb.items[1].weighed, '3|20.82|true', 'paragon: rabat i waga');
const kat2 = cat.map(p => ({ ...p }));
const pf = R.matchProduct('Filet z piersi kurczaka', kat2), pm = R.matchProduct('Mascarpone 250 g', kat2);
eq(pf?.id + '|' + pm?.id, 'kurczak_filet|mascarpone', 'paragon: dopasowanie do katalogu');
eq(R.packPrice(rb.items[1], pf, pf.ref), 20.1, 'paragon: cena za kg po rabacie');
eq(R.packPrice({ name: 'Mascarpone 250 g', qty: 1, unit_price: 5.49, total: 5.49, discount: 0 }, pm, pm.ref), 5.49, 'paragon: cena opakowania');
eq(R.categoryOf('Piwo Pilsner 0,5 l') + '|' + R.categoryOf('Chleb wiejski') + '|' + R.categoryOf('Mleko', null), 'Alkohol|Pieczywo|Nabiał', 'paragon: kategorie');
eq(R.joinShots(['a\nb\nc', 'b\nc\nd']), 'a\nb\nc\nd', 'paragon: łączenie zrzutów');
// --- agregator gazetki.pl ---
{
  const E = await import('./extract.mjs');
  const P = [{ id: 'kurczak_filet', unit: 'kg', pack: 1, loose: true, kw: ['filet z kurczaka', 'filet z piersi kurczaka'], ref: 24 },
    { id: 'tunczyk', unit: 'kg', pack: 0.17, kw: ['tunczyk'], ref: 8 }, { id: 'limonka', unit: 'szt', pack: 1, kw: ['limonki', 'limonka'], ref: 1.4 }];
  const items = [{ kw: 'filet z kurczaka', cards: [
      { href: '/sklepy/biedronka/oferty/x-promocja-1/', text: 'Filet z kurczaka Kraina Mięs 1 kg\n3 dni\n24,90 zł\n14,99 zł' },
      { href: '/sklepy/biedronka/oferty/y-promocja-2/', text: 'Filet z kurczaka wędzony 100 g\n3 dni\n2,99 zł' },
      { href: '/sklepy/kaufland/oferty/z-promocja-3/', text: 'Filet z kurczaka\n3 dni\n9,99 zł' }],
    rows: [['', 'Filet z kurczaka Kraina Mięs 3 kg', 'Biedronka', '24,90 zł', '13,99 zł', '9,91 zł Rabat', '31 października 2026', '02 listopada 2026'],
      ['', 'Filet z kurczaka 1 kg', 'Biedronka', '', '11,99 zł', '', '01 października 2026', '03 października 2026']] },
    { kw: 'tunczyk', cards: [{ href: '/sklepy/biedronka/oferty/a/', text: 'Sałatka z tuńczykiem z kuskusem Seko\n6,99 zł' }], rows: [] },
    { kw: 'limonki', cards: [{ href: '/sklepy/lidl/oferty/a/', text: 'Limonki\n1,00 zł' }], rows: [] }];
  const o = E.aggOffers(items, P, 'biedronka', 'Biedronka', '2026-11-01');
  eq(o.map(x => x.product_id + ':' + x.price_for_pack + ':' + (x.valid_to || '')).join(','), 'kurczak_filet:13.99:2026-11-02', 'agregator: tylko ten sklep, aktualne, bez wędlin i sałatek');
  const o2 = E.aggOffers([{ kw: 'filet z kurczaka', cards: [
      { href: '', logos: 'Biedronka /img/biedronka-logo.png', text: 'Świeży filet z piersi kurczaka Kraina Mięs, Mega Paka\n3 dni\n24,90 zł\n12,99 zł' },
      { href: '', logos: 'Netto /img/netto.png', text: 'Filet z kurczaka\n3 dni\n9,99 zł' }], rows: [] }], P, 'biedronka', 'Biedronka', '2026-11-01');
  eq(o2.map(x => x.product_id + ':' + x.price_for_pack).join(','), 'kurczak_filet:12.99', 'agregator: kafelek rozpoznany po logo sklepu');
  eq(E.aggOffers([{ kw: 'gouda', cards: [{ href: '/sklepy/biedronka/oferty/a/', text: 'Ser Gouda z kurkami i cebulką\n2,99 zł' }], rows: [] }], [{ id: 'ser', unit: 'kg', pack: 0.15, kw: ['gouda'], ref: 5 }], 'biedronka', 'Biedronka', '2026-11-01').length, 0, 'agregator: bez serów smakowych');
  const P3 = [{ id: 'dynia', unit: 'kg', pack: 1, loose: true, kw: ['dynia'], ref: 4.5 }, { id: 'cytryna', unit: 'szt', pack: 1, kw: ['cytryna', 'cytryny'], ref: 1.3 }];
  eq(E.aggOffers([{ kw: 'dynia', cards: [{ href: '/sklepy/biedronka/oferty/a/', text: 'Bułka z dynią 70 g\n1,25 zł' }, { href: '/sklepy/biedronka/oferty/b/', text: 'Dynia piżmowa 1 kg\n2,99 zł' }], rows: [] },
    { kw: 'cytryny', cards: [{ href: '/sklepy/biedronka/oferty/c/', text: 'Lemoniada o smaku cytryny 1 l\n0,99 zł' }], rows: [] }], P3, 'biedronka', 'Biedronka', '2026-11-01').map(x => x.product_id + ':' + x.price_for_pack).join(','), 'dynia:2.99', 'agregator: produkt jako dodatek pomijany');
  eq(E.plDate('02 listopada 2026'), '2026-11-02', 'agregator: polska data');
}
if (fails) { console.log(fails, 'błędów'); process.exit(1); } else console.log('Wszystkie testy przeszły.');
