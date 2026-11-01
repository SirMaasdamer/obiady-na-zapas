// Paczki przepisów dopisywane przez Claude do folderu przepisy/ (format opisany w PRZEPISY.md).
// Reguły pól (jednostki, długości, zakaz < >, linki https) są wspólne z funkcją „ingest” w Supabase:
// supabase/functions/ingest/walidacja.mjs. Tutaj dochodzą reguły, które wymagają całego katalogu.
import { readFile, readdir } from 'node:fs/promises';
import { factor } from '../web/logic.js';
import { CATEGORIES, INGREDIENT_UNITS, PRODUCT_ID, RECIPE_ID, productErrors, recipeErrors, requestResultErrors } from '../supabase/functions/ingest/walidacja.mjs';

export { CATEGORIES };
const root = new URL('../', import.meta.url);

export async function loadAll() {
  const seedProducts = JSON.parse(await readFile(new URL('seed/products.json', root), 'utf8'));
  const seedRecipes = JSON.parse(await readFile(new URL('seed/recipes.json', root), 'utf8'));
  const files = (await readdir(new URL('przepisy/', root)).catch(() => [])).filter(f => f.endsWith('.json')).sort();
  const batches = [];
  for (const f of files) {
    try { batches.push({ file: f, ...JSON.parse(await readFile(new URL('przepisy/' + f, root), 'utf8')) }); }
    catch (e) { batches.push({ file: f, error: 'niepoprawny JSON: ' + e.message }); }
  }
  return { seedProducts, seedRecipes, batches };
}

// Zwraca listę błędów (pustą, gdy wszystko jest w porządku).
export function validate({ seedProducts, seedRecipes, batches }) {
  const errors = [], products = new Map(seedProducts.map(p => [p.id, p])), recipeIds = new Set(seedRecipes.map(r => r.id));
  for (const b of batches) {
    const at = m => errors.push(`${b.file}: ${m}`);
    if (b.error) { at(b.error); continue; }
    for (const p of b.products || []) {
      if (!PRODUCT_ID.test(p?.id || '')) { at(`produkt "${p?.id}": id tylko z małych liter, cyfr i _`); continue; }
      if (products.has(p.id)) continue; // już istnieje, zostaje bez zmian
      for (const m of productErrors(p)) at(`produkt ${p.id}: ${m}`);
      if (!p.pantry) {
        if (!(+p.pack > 0)) at(`produkt ${p.id}: brak rozmiaru opakowania (pack)`);
        if (!Array.isArray(p.kw) || !p.kw.length) at(`produkt ${p.id}: brak słów kluczowych (kw) do szukania w gazetkach`);
        if (!p.regular || !Object.values(p.regular).some(v => +v > 0)) at(`produkt ${p.id}: brak ceny regularnej (regular)`);
      }
      products.set(p.id, p);
    }
  }
  // przepisy sprawdzamy dopiero po wczytaniu produktów ze wszystkich paczek (paczka może używać produktu z innej)
  for (const b of batches) {
    const at = m => errors.push(`${b.file}: ${m}`);
    if (b.error) continue;
    for (const r of b.recipes || []) {
      const rr = m => at(`przepis ${r?.id || r?.name}: ${m}`);
      if (!RECIPE_ID.test(r?.id || '')) { rr('id tylko z małych liter, cyfr i -'); continue; }
      if (recipeIds.has(r.id)) { rr('takie id już istnieje'); continue; }
      recipeIds.add(r.id);
      recipeErrors(r).forEach(rr);
      for (const i of Array.isArray(r.ingredients) ? r.ingredients : []) {
        const p = products.get(i?.pid);
        if (!p) { rr(`nieznany produkt "${i?.pid}" (dodaj go w "products")`); continue; }
        if (!INGREDIENT_UNITS.includes(i.unit)) continue; // już zgłoszone wyżej
        if (!p.pantry && factor(i.unit, p) == null) rr(`${i.pid}: jednostki "${i.unit}" nie da się przeliczyć na ${p.unit}`);
      }
    }
  }
  // wyniki próśb z aplikacji (pole „prosby” w paczce) – po przepisach, bo mogą wskazywać przepisy z dowolnej paczki
  for (const b of batches) {
    if (b.error || b.prosby === undefined) continue;
    const at = m => errors.push(`${b.file}: ${m}`);
    if (!Array.isArray(b.prosby)) { at('prosby: lista wyników'); continue; }
    for (const q of b.prosby) for (const m of requestResultErrors(q, recipeIds)) at(`prośba ${String(q?.id).slice(0, 36)}: ${m}`);
  }
  return errors;
}

// Łączy katalog startowy z paczkami od Claude w jeden katalog (wysyła go workflow „Nowe przepisy”).
export function buildKatalog({ seedProducts, seedRecipes, batches }) {
  const products = new Map(seedProducts.map(p => [p.id, p]));
  for (const b of batches) for (const p of b.products || []) if (!products.has(p.id)) products.set(p.id, { ...p, pantry: !!p.pantry, loose: !!p.loose, pack: +p.pack || 1, cat: p.pantry ? 'spiżarnia' : p.cat });
  const recipes = seedRecipes.map(({ active, ...r }) => ({ freezer: true, ...r, source: 'seed', default_active: active !== false }));
  const ids = new Set(recipes.map(r => r.id));
  for (const b of batches) {
    const added_on = (b.file.match(/^\d{4}-\d{2}-\d{2}/) || [null])[0];
    for (const r of b.recipes || []) if (!ids.has(r.id)) { ids.add(r.id); recipes.push({ base: 2, freezer: true, ...r, source: 'claude', default_active: true, added_on }); }
  }
  const prosby = batches.flatMap(b => (Array.isArray(b.prosby) ? b.prosby : []));
  return { products: [...products.values()], recipes, prosby };
}
