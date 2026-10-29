// Generator przepisów: tworzy kilka nowych dań w wybranej kategorii i zapisuje je w bazie.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const CATS: Record<string, string> = {
  drob: 'Drób (kurczak, indyk)', mielone: 'Mięso mielone', wieprzowina: 'Wieprzowina', wolowina: 'Wołowina',
  zupy: 'Zupy', wege: 'Bez mięsa', makaron: 'Sosy do makaronu',
};
const HOUSE_EMAIL = 'dom@obiady-na-zapas.app';
const MODEL = Deno.env.get('RECIPE_MODEL') || 'claude-sonnet-5-5';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

function parseJson(text: string) {
  const f = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = f ? f[1] : text;
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: u } = await caller.auth.getUser();
    if (u?.user?.email !== HOUSE_EMAIL) return json({ error: 'Zaloguj się kodem domu.' }, 401);

    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) return json({ error: 'Generator jest wyłączony: brak klucza Anthropic.' }, 400);

    const { category, count = 4, hint = '' } = await req.json();
    if (!CATS[category]) return json({ error: 'Nieznana kategoria.' }, 400);
    const n = Math.min(Math.max(1, Number(count) || 4), 6);

    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const [{ data: products }, { data: recipes }, { data: prices }] = await Promise.all([
      db.from('products').select('id,name,unit,pantry'),
      db.from('recipes').select('name,category'),
      db.from('prices').select('product_id,store,promo,promo_from,promo_to').not('promo', 'is', null),
    ]);
    const t = today();
    const promoIds = [...new Set((prices ?? []).filter(p => (!p.promo_from || p.promo_from <= t) && (!p.promo_to || p.promo_to >= t)).map(p => p.product_id))];
    const names = (recipes ?? []).map(r => r.name);
    const catalog = (products ?? []).map(p => `${p.id} | ${p.name} | ${p.unit}${p.pantry ? ' | spiżarnia' : ''}`).join('\n');

    const prompt = `Gotujemy obiady na zapas dla 2 osób: robimy główny element dania na kilka dni i mrozimy porcje, a dodatki (ryż, ziemniaki, kasza, makaron, surówki) robimy na świeżo.
Zaproponuj ${n} RÓŻNE dania w kategorii: ${CATS[category]}.
Każde danie musi dobrze znosić mrożenie i odgrzewanie. Kuchnia domowa, polska lub popularna w Polsce. Składniki muszą być łatwo dostępne w Biedronce, Lidlu i Kauflandzie.
Preferuj produkty, które są teraz w promocji: ${promoIds.join(', ') || 'brak danych'}.
Nie powtarzaj istniejących dań: ${names.join('; ')}.
${hint ? 'Życzenie domowników: ' + hint : ''}

Katalog produktów (id | nazwa | jednostka | spiżarnia):
${catalog}

Zasady:
- Ilości na 2 porcje.
- Używaj id z katalogu. Produkt w kg podawaj w "g", w l w "ml", w szt w "szt", pęczek w "pęczek". Czosnek podawaj w "ząbek". Przyprawy, sól, olej, mąkę, bulion podawaj w "łyżka", "łyżeczka" albo "szt".
- Brakujący produkt dodaj do "newProducts": id w snake_case bez polskich znaków, unit kg|l|szt, pack = typowe opakowanie w tej jednostce (np. 0.4), loose = true dla mięsa i warzyw na wagę, pantry = true dla przypraw, cat jedna z: mięso, nabiał, warzywa, puszki i sosy, suche, spiżarnia.
- 3 do 6 krótkich kroków po polsku. "thaw": jedna lub dwie wskazówki o mrożeniu i odgrzewaniu.

Zwróć WYŁĄCZNIE JSON:
{"recipes":[{"name":"...","minutes":45,"freezeMonths":3,"sides":"ryż, kasza","thaw":"...","ingredients":[{"pid":"...","amt":300,"unit":"g"}],"steps":["..."]}],"newProducts":[{"id":"...","name":"...","unit":"kg","pack":1,"loose":true,"pantry":false,"cat":"warzywa"}]}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) {
      const b = await res.text();
      return json({ error: /credit/i.test(b) ? 'Brak środków na koncie Anthropic.' : 'Claude nie odpowiedział. Spróbuj ponownie.' }, 502);
    }
    const out = parseJson((await res.json()).content.map((c: { text?: string }) => c.text ?? '').join(''));

    const known = new Set((products ?? []).map(p => p.id));
    const newProducts = (out.newProducts ?? []).filter((p: any) => p?.id && p?.name).map((p: any) => ({
      id: slug(p.id).replace(/-/g, '_'), name: String(p.name), unit: ['kg', 'l', 'szt'].includes(p.unit) ? p.unit : (p.pantry ? 'łyżka' : 'kg'),
      pack: Number(p.pack) || 1, loose: !!p.loose, pantry: !!p.pantry, cat: p.pantry ? 'spiżarnia' : String(p.cat || 'inne'),
    })).filter((p: any) => !known.has(p.id));
    newProducts.forEach((p: any) => known.add(p.id));
    if (newProducts.length) await db.from('products').upsert(newProducts, { onConflict: 'id', ignoreDuplicates: true });

    const rows = (out.recipes ?? []).map((r: any) => ({
      id: `${slug(r.name)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name: String(r.name), category, base: 2, minutes: Number(r.minutes) || 45, freeze_months: Number(r.freezeMonths) || 3,
      sides: String(r.sides ?? ''), thaw: String(r.thaw ?? ''),
      ingredients: (r.ingredients ?? []).filter((i: any) => known.has(i?.pid) && Number(i.amt) > 0).map((i: any) => ({ pid: i.pid, amt: Number(i.amt), unit: String(i.unit || 'g') })),
      steps: (r.steps ?? []).map(String), source: 'claude',
    })).filter((r: any) => r.name && r.ingredients.length >= 2 && !names.includes(r.name));
    if (!rows.length) return json({ error: 'Nie udało się ułożyć przepisów. Spróbuj ponownie.' }, 502);
    const { error } = await db.from('recipes').insert(rows);
    if (error) throw error;
    return json({ added: rows.map((r: any) => ({ id: r.id, name: r.name })) });
  } catch (e) {
    console.error(e);
    return json({ error: 'Coś poszło nie tak przy generowaniu. Spróbuj ponownie.' }, 500);
  }
});
