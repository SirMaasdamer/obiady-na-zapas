// Wspólne reguły danych wspólnych (katalog, oferty, wyniki próśb).
// Używają ich: skrypty w CI (scripts/batches.mjs, scripts/ingest.mjs), funkcja „ingest” w Supabase
// i pośrednio Claude (komunikaty walidatora, PRZEPISY.md). Te same ograniczenia ma baza (CHECK).
// Czysty JavaScript bez zależności: działa w Node i w Deno.

export const CATEGORIES = ['drob', 'mielone', 'wieprzowina', 'wolowina', 'zupy', 'wege', 'makaron'];
export const PRODUCT_UNITS = ['kg', 'l', 'szt', 'pęczek', 'łyżka'];
export const INGREDIENT_UNITS = ['g', 'ml', 'kg', 'l', 'szt', 'pęczek', 'łyżka', 'łyżeczka', 'ząbek'];
export const STORES = ['b', 'l', 'k'];
export const SOURCES = ['gazetki.pl', 'json', 'www', 'pdf', 'ocr'];
export const REQUEST_STATUSES = ['gotowe', 'blad'];

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;          // do zamiany (flaga g)
const HAS_CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;       // do sprawdzania (bez stanu lastIndex)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PRODUCT_ID = /^[a-z0-9_]{1,60}$/;
export const RECIPE_ID = /^[a-z0-9-]{1,120}$/;

export const hasAngle = s => /[<>]/.test(String(s ?? ''));
export const isHttps = u => typeof u === 'string' && u.length <= 500 && /^https:\/\/[^\s"'<>]+$/.test(u);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const isBool = v => v === undefined || v === null || typeof v === 'boolean';

// Liczba z zakresu albo null (akceptuje też liczby zapisane jako tekst).
export function num(v, lo, hi) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

// Tekst ze źródeł zewnętrznych (oferty): bez znaków sterujących i bez < >, przycięty; null, gdy pusty.
export function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(CTRL, ' ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

// Tekst autorski (katalog): musi już być poprawny, bo błąd oznacza pomyłkę w przepisie do poprawienia.
function textOk(v, { min = 0, max, required = false }) {
  if (v === undefined || v === null || v === '') return !required && min === 0;
  return typeof v === 'string' && v.length >= min && v.length <= max && !hasAngle(v) && !HAS_CTRL.test(v);
}

// ---------- składniki i przepisy (używa też walidator paczek w CI) ----------

export function ingredientErrors(i) {
  const out = [];
  if (!i || typeof i !== 'object') return ['składnik nie jest obiektem'];
  if (typeof i.pid !== 'string' || !PRODUCT_ID.test(i.pid)) out.push(`zły identyfikator produktu „${String(i.pid).slice(0, 60)}”`);
  if (!INGREDIENT_UNITS.includes(i.unit)) out.push(`${i.pid}: jednostka „${String(i.unit).slice(0, 20)}” spoza listy: ${INGREDIENT_UNITS.join(', ')}`);
  if (typeof i.amt !== 'number' || !(i.amt > 0 && i.amt <= 100000)) out.push(`${i.pid}: ilość musi być liczbą większą od zera`);
  return out;
}

export function recipeErrors(r) {
  const out = [];
  const at = m => out.push(m);
  if (!r || typeof r !== 'object') return ['przepis nie jest obiektem'];
  if (typeof r.id !== 'string' || !RECIPE_ID.test(r.id)) at('id tylko z małych liter, cyfr i -');
  if (!textOk(r.name, { min: 2, max: 200, required: true })) at('nazwa: 2–200 znaków, bez < i >');
  if (!CATEGORIES.includes(r.category)) at(`kategoria musi być jedną z: ${CATEGORIES.join(', ')}`);
  if (r.base !== undefined && num(r.base, 1, 20) === null) at('base: liczba porcji 1–20');
  if (r.minutes !== undefined && r.minutes !== null && num(r.minutes, 1, 1440) === null) at('minutes: 1–1440');
  if (r.freeze_months !== undefined && r.freeze_months !== null && num(r.freeze_months, 0, 24) === null) at('freeze_months: 0–24');
  if (!textOk(r.sides, { max: 300 })) at('sides: do 300 znaków, bez < i >');
  if (!textOk(r.thaw, { max: 800 })) at('thaw: do 800 znaków, bez < i >');
  if (!textOk(r.inspired_by, { max: 120 })) at('inspired_by: do 120 znaków, bez < i >');
  if (r.source_url !== undefined && r.source_url !== null && !isHttps(r.source_url)) at('source_url: tylko pełny adres https://');
  if (!isBool(r.freezer) || !isBool(r.default_active)) at('freezer i default_active: true albo false');
  if (r.added_on !== undefined && r.added_on !== null && !isDate(r.added_on)) at('added_on: data RRRR-MM-DD');
  if (!Array.isArray(r.steps) || r.steps.length < 2 || r.steps.length > 30) at('steps: od 2 do 30 kroków');
  else r.steps.forEach((s, n) => { if (!textOk(s, { min: 1, max: 1000, required: true })) at(`krok ${n + 1}: 1–1000 znaków, bez < i >`); });
  if (!Array.isArray(r.ingredients) || r.ingredients.length < 2 || r.ingredients.length > 40) at('ingredients: od 2 do 40 składników');
  else r.ingredients.forEach(i => ingredientErrors(i).forEach(at));
  return out;
}

export function productErrors(p) {
  const out = [];
  const at = m => out.push(m);
  if (!p || typeof p !== 'object') return ['produkt nie jest obiektem'];
  if (typeof p.id !== 'string' || !PRODUCT_ID.test(p.id)) at('id tylko z małych liter, cyfr i _');
  if (!textOk(p.name, { min: 1, max: 120, required: true })) at('nazwa: 1–120 znaków, bez < i >');
  if (!PRODUCT_UNITS.includes(p.unit)) at(`jednostka musi być jedną z: ${PRODUCT_UNITS.join(', ')}`);
  if (p.pack !== undefined && p.pack !== null && num(p.pack, 0.0001, 9999) === null) at('pack: liczba większa od zera');
  if (!textOk(p.cat, { max: 40 })) at('cat: do 40 znaków, bez < i >');
  if (!isBool(p.pantry) || !isBool(p.loose)) at('pantry i loose: true albo false');
  if (p.conv !== undefined && p.conv !== null) {
    if (typeof p.conv !== 'object' || Array.isArray(p.conv)) at('conv: obiekt { jednostka: przelicznik }');
    else for (const [u, v] of Object.entries(p.conv)) {
      if (!INGREDIENT_UNITS.includes(u)) at(`conv: jednostka „${u.slice(0, 20)}” spoza listy`);
      if (typeof v !== 'number' || !(v > 0)) at(`conv.${u}: liczba większa od zera`);
    }
  }
  if (p.kw !== undefined && p.kw !== null) {
    if (!Array.isArray(p.kw) || p.kw.length > 20) at('kw: lista do 20 słów');
    else p.kw.forEach(k => { if (!textOk(k, { min: 1, max: 60, required: true })) at(`kw: „${String(k).slice(0, 30)}” (1–60 znaków, bez < i >)`); });
  }
  if (p.regular !== undefined && p.regular !== null) {
    if (typeof p.regular !== 'object' || Array.isArray(p.regular)) at('regular: obiekt { b, l, k }');
    else for (const [s, v] of Object.entries(p.regular)) {
      if (!STORES.includes(s)) at(`regular: nieznany sklep „${s.slice(0, 5)}”`);
      else if (num(v, 0.01, 9999) === null) at(`regular.${s}: cena większa od zera`);
    }
  }
  return out;
}

// ---------- pełny katalog (funkcja ingest) ----------

export function checkCatalog(kat) {
  const errors = [];
  if (!kat || typeof kat !== 'object' || !Array.isArray(kat.products) || !Array.isArray(kat.recipes)) {
    return { errors: ['katalog: wymagane listy products i recipes'], data: null };
  }
  const pids = new Set(), rids = new Set();
  const products = [];
  for (const p of kat.products) {
    const e = productErrors(p);
    if (!e.length && pids.has(p.id)) e.push('powtórzony identyfikator');
    if (e.length) { errors.push(...e.map(m => `produkt ${String(p?.id).slice(0, 60)}: ${m}`)); continue; }
    pids.add(p.id);
    products.push({
      id: p.id, name: p.name.trim(), unit: p.unit, pack: num(p.pack, 0.0001, 9999) ?? 1, loose: !!p.loose,
      cat: p.cat || null, pantry: !!p.pantry, conv: p.conv ?? null, kw: p.kw ?? null, regular: p.regular ?? null,
    });
  }
  const recipes = [];
  for (const r of kat.recipes) {
    const e = recipeErrors(r);
    if (!e.length && rids.has(r.id)) e.push('powtórzony identyfikator');
    if (!e.length) for (const i of r.ingredients) if (!pids.has(i.pid)) e.push(`nieznany produkt „${i.pid}”`);
    if (e.length) { errors.push(...e.map(m => `przepis ${String(r?.id).slice(0, 120)}: ${m}`)); continue; }
    rids.add(r.id);
    recipes.push({
      id: r.id, name: r.name.trim(), category: r.category, base: num(r.base, 1, 20) ?? 2, minutes: num(r.minutes, 1, 1440),
      freeze_months: num(r.freeze_months, 0, 24) ?? 3, sides: r.sides ?? '', thaw: r.thaw ?? '',
      ingredients: r.ingredients.map(i => ({ pid: i.pid, amt: i.amt, unit: i.unit })), steps: r.steps,
      source: r.source === 'claude' ? 'claude' : 'seed', default_active: r.default_active !== false,
      added_on: isDate(r.added_on) ? r.added_on : null, inspired_by: r.inspired_by || null,
      source_url: isHttps(r.source_url) ? r.source_url : null, freezer: r.freezer !== false,
    });
  }
  const prosby = [];
  for (const q of Array.isArray(kat.prosby) ? kat.prosby : []) {
    const e = requestResultErrors(q, rids);
    if (e.length) { errors.push(...e.map(m => `prośba ${String(q?.id).slice(0, 36)}: ${m}`)); continue; }
    prosby.push({ id: q.id, status: q.status, recipe_ids: q.recipe_ids ?? [], note: q.note ? String(q.note).slice(0, 300) : null });
  }
  return { errors, data: { products, recipes, prosby } };
}

export function requestResultErrors(q, recipeIds) {
  const out = [];
  if (!q || typeof q !== 'object') return ['wynik prośby nie jest obiektem'];
  if (typeof q.id !== 'string' || !UUID.test(q.id)) out.push('id prośby to UUID z pliku dane/prosby.json');
  if (!REQUEST_STATUSES.includes(q.status)) out.push(`status musi być jednym z: ${REQUEST_STATUSES.join(', ')}`);
  if (q.recipe_ids !== undefined && (!Array.isArray(q.recipe_ids) || q.recipe_ids.some(id => typeof id !== 'string' || !RECIPE_ID.test(id)))) {
    out.push('recipe_ids: lista identyfikatorów przepisów');
  } else if (recipeIds && q.recipe_ids) {
    for (const id of q.recipe_ids) if (!recipeIds.has(id)) out.push(`recipe_ids: nie ma przepisu „${id}”`);
  }
  if (q.status === 'gotowe' && (!Array.isArray(q.recipe_ids) || !q.recipe_ids.length)) out.push('status gotowe wymaga recipe_ids');
  if (!textOk(q.note, { max: 300 })) out.push('note: do 300 znaków, bez < i >');
  return out;
}

// ---------- oferty ze scrapera (funkcja ingest): czyszczenie zamiast odrzucania całego przebiegu ----------

export function checkOffers(of) {
  const errors = [];
  if (!of || typeof of !== 'object' || !Array.isArray(of.offers) || !Array.isArray(of.runs)) {
    return { errors: ['oferty: wymagane listy offers i runs'], data: null, dropped: 0 };
  }
  let dropped = 0;
  const offers = [];
  for (const o of of.offers) {
    const price_for_pack = num(o?.price_for_pack, 0.01, 9999);
    const name = cleanText(o?.name, 200);
    const valid_to = isDate(o?.valid_to) ? o.valid_to : null;
    const valid_from = isDate(o?.valid_from) ? o.valid_from : null;
    if (!o || !STORES.includes(o.store) || typeof o.product_id !== 'string' || !PRODUCT_ID.test(o.product_id)
        || price_for_pack === null || !name || !valid_to || (valid_from && valid_from > valid_to) || !SOURCES.includes(o.source)) {
      dropped++;
      continue;
    }
    offers.push({
      store: o.store, product_id: o.product_id, name, price: num(o.price, 0.01, 9999), price_for_pack,
      regular: num(o.regular, 0.01, 9999), unit_info: cleanText(o.unit_info, 40), valid_from, valid_to,
      note: cleanText(o.note, 200), source: o.source, page: o.page === undefined || o.page === null ? null : cleanText(o.page, 40),
      leaflet: isHttps(o.leaflet) ? o.leaflet : null,
    });
  }
  const runs = [];
  for (const r of of.runs) {
    if (!r || !STORES.includes(r.store) || !['ok', 'error'].includes(r.status) || typeof r.ran_at !== 'string' || Number.isNaN(Date.parse(r.ran_at))) continue;
    runs.push({
      store: r.store, ran_at: r.ran_at, status: r.status, message: cleanText(r.message, 500),
      valid_from: isDate(r.valid_from) ? r.valid_from : null, valid_to: isDate(r.valid_to) ? r.valid_to : null,
      matched: Number.isInteger(r.matched) && r.matched >= 0 ? r.matched : null,
    });
  }
  if (!runs.length) errors.push('oferty: brak poprawnych wpisów w runs');
  return { errors, data: { offers, runs }, dropped };
}
