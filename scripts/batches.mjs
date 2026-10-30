// Paczki przepisów dopisywane przez Claude do folderu przepisy/ (format opisany w PRZEPISY.md).
import { readFile, readdir } from 'node:fs/promises';
import { factor } from '../web/logic.js';

export const CATEGORIES = ['drob', 'mielone', 'wieprzowina', 'wolowina', 'zupy', 'wege', 'makaron'];
const UNITS = ['kg', 'l', 'szt', 'pęczek', 'łyżka'];
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
      if (!/^[a-z0-9_]+$/.test(p.id || '')) { at(`produkt "${p.id}": id tylko z małych liter, cyfr i _`); continue; }
      if (products.has(p.id)) continue; // już istnieje, zostaje bez zmian
      if (!p.name) at(`produkt ${p.id}: brak nazwy`);
      if (!UNITS.includes(p.unit)) at(`produkt ${p.id}: jednostka musi być jedną z ${UNITS.join(', ')}`);
      if (!p.pantry) {
        if (!(+p.pack > 0)) at(`produkt ${p.id}: brak rozmiaru opakowania (pack)`);
        if (!Array.isArray(p.kw) || !p.kw.length) at(`produkt ${p.id}: brak słów kluczowych (kw) do szukania w gazetkach`);
        if (!p.regular || !Object.values(p.regular).some(v => +v > 0)) at(`produkt ${p.id}: brak ceny regularnej (regular)`);
      }
      products.set(p.id, p);
    }
    for (const r of b.recipes || []) {
      const rr = m => at(`przepis ${r.id || r.name}: ${m}`);
      if (!/^[a-z0-9-]+$/.test(r.id || '')) { rr('id tylko z małych liter, cyfr i -'); continue; }
      if (recipeIds.has(r.id)) { rr('takie id już istnieje'); continue; }
      recipeIds.add(r.id);
      if (!r.name) rr('brak nazwy');
      if (!CATEGORIES.includes(r.category)) rr(`kategoria musi być jedną z ${CATEGORIES.join(', ')}`);
      if (!Array.isArray(r.steps) || r.steps.length < 2) rr('co najmniej 2 kroki');
      if (!Array.isArray(r.ingredients) || r.ingredients.length < 2) { rr('co najmniej 2 składniki'); continue; }
      for (const i of r.ingredients) {
        const p = products.get(i.pid);
        if (!p) { rr(`nieznany produkt "${i.pid}" (dodaj go w "products")`); continue; }
        if (!(+i.amt > 0)) rr(`${i.pid}: ilość musi być większa od zera`);
        if (!p.pantry && factor(i.unit, p) == null) rr(`${i.pid}: jednostki "${i.unit}" nie da się przeliczyć na ${p.unit}`);
      }
    }
  }
  return errors;
}

// Wgrywa paczki do bazy. Istniejące produkty i przepisy zostają bez zmian.
export async function importBatches(db, data, log = console.log) {
  const now = new Date().toISOString();
  const prods = data.batches.flatMap(b => b.products || []), recs = data.batches.flatMap(b => b.recipes || []);
  if (prods.length) {
    let r = await db.from('products').upsert(prods.map(({ regular, ...p }) => ({ ...p, pantry: !!p.pantry, loose: !!p.loose, pack: +p.pack || 1, cat: p.pantry ? 'spiżarnia' : p.cat })), { onConflict: 'id', ignoreDuplicates: true });
    if (r.error) throw r.error;
    const pr = prods.flatMap(p => Object.entries(p.regular || {}).map(([store, v]) => ({ product_id: p.id, store, regular: +v, regular_src: 'szac' })));
    if (pr.length) { r = await db.from('prices').upsert(pr, { onConflict: 'product_id,store', ignoreDuplicates: true }); if (r.error) throw r.error; }
  }
  if (recs.length) {
    const { data: existing } = await db.from('recipes').select('id').in('id', recs.map(r => r.id));
    const have = new Set((existing || []).map(r => r.id));
    const fresh = recs.filter(r => !have.has(r.id)).map(r => ({
      id: r.id, name: r.name, category: r.category, base: 2, minutes: +r.minutes || null, freeze_months: +r.freeze_months || 3,
      sides: r.sides || '', thaw: r.thaw || '', ingredients: r.ingredients, steps: r.steps, source: 'claude', active: true, activated_at: now,
    }));
    if (fresh.length) { const { error } = await db.from('recipes').insert(fresh); if (error) throw error; }
    log(`  nowe przepisy: ${fresh.length} (pominięte, bo już są: ${recs.length - fresh.length})`);
  } else log('  brak przepisów w folderze przepisy/');
}
