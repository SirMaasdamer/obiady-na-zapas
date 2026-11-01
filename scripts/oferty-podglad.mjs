// Podgląd aktualnych promocji w repozytorium: dane/oferty.json. Czyta go Claude przy dobieraniu przepisów (PRZEPISY.md).
// Aplikacja bierze oferty z bazy (funkcja „ingest”), nie z tego pliku.
// Łączy wynik przebiegu (dane/oferty-przebieg.json) z poprzednim podglądem: sklep, którego nie udało się odczytać,
// zachowuje poprzednie, wciąż ważne promocje. Teksty ze stron sklepów są czyszczone tymi samymi regułami co w bazie.
import { readFile, writeFile } from 'node:fs/promises';
import { checkOffers, cleanText, num } from '../supabase/functions/ingest/walidacja.mjs';
import { today } from './lib.mjs';

const file = new URL('../dane/oferty.json', import.meta.url);
const run = JSON.parse(await readFile(new URL('../dane/oferty-przebieg.json', import.meta.url), 'utf8'));
const prev = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
const t = today();
const { data } = checkOffers({ offers: run.offers || [], runs: run.runs || [] });
const okStores = new Set(data.runs.filter(r => r.status === 'ok').map(r => r.store));
const keep = (arr, toKey) => (arr || []).filter(x => !okStores.has(x.store) && (x[toKey] || '9999') >= t);
const promos = (run.promos || []).filter(p => /^[a-z0-9_]{1,60}$/.test(p?.product_id || '') && ['b', 'l', 'k'].includes(p.store)).map(p => ({
  product_id: p.product_id, name: cleanText(p.name, 120), store: p.store, store_name: cleanText(p.store_name, 30),
  promo: num(p.promo, 0.01, 9999), regular: num(p.regular, 0.01, 9999), from: p.from || null, to: p.to || null, note: cleanText(p.note, 200),
}));
const out = {
  updated: run.updated || new Date().toISOString(),
  runs: [...data.runs, ...(prev.runs || []).filter(r => !data.runs.some(n => n.store === r.store && n.ran_at === r.ran_at))].slice(0, 30),
  promos: [...promos, ...keep(prev.promos, 'to')].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pl')),
  offers: [...data.offers, ...keep(prev.offers, 'valid_to')],
};
await writeFile(file, JSON.stringify(out, null, 1) + '\n');
console.log(`Zapisano dane/oferty.json: ${out.promos.length} promocji (${okStores.size ? 'nowe dla: ' + [...okStores].join(', ') : 'bez nowych'}).`);
