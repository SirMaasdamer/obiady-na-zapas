// Szybkie testy logiki cen i planu zakupów na danych startowych.
import { readFileSync } from 'node:fs';
import * as L from '../web/logic.js';
import { parseJson } from './lib.mjs';
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
if (fails) { console.log(fails, 'błędów'); process.exit(1); } else console.log('Wszystkie testy przeszły.');
