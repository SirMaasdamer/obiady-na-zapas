// Synchronizacja: pobiera z repozytorium GitHub katalog (produkty + przepisy) i aktualne oferty,
// po czym wgrywa je do wspólnych tabel. Uruchamiana co godzinę przez pg_cron. Bez sekretów:
// repozytorium jest publiczne, a do bazy pisze klucz serwisowy dostępny tylko wewnątrz Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const REPO = Deno.env.get('REPO') || 'SirMaasdamer/obiady-na-zapas';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

// ref = konkretny commit (podaje go workflow, omija pamięć podręczną GitHuba) albo „main” (wywołanie z harmonogramu)
async function fetchFile(name: string, ref: string) {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${ref}/dane/${name}?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const text = await r.text();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, '0')).join('');
  return { data: JSON.parse(text), hash };
}

async function chunked<T>(rows: T[], fn: (part: T[]) => PromiseLike<{ error: unknown }>) {
  for (let i = 0; i < rows.length; i += 500) { const { error } = await fn(rows.slice(i, i + 500)); if (error) throw error; }
}

Deno.serve(async (req) => {
  const force = new URL(req.url).searchParams.has('force');
  const body = await req.json().catch(() => ({}));
  const ref = /^[0-9a-f]{40}$/.test(body?.sha ?? '') ? body.sha : 'main';
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: st } = await db.from('sync_state').select('key,hash');
  const prev = Object.fromEntries((st ?? []).map(r => [r.key, r.hash]));
  const report: Record<string, unknown> = {};
  try {
    // --- katalog: produkty, ceny regularne, przepisy ---
    const kat = await fetchFile('katalog.json', ref);
    if (kat && (force || kat.hash !== prev.katalog)) {
      const products = kat.data.products ?? [];
      await chunked(products.map((p: any) => ({ id: p.id, name: p.name, unit: p.unit, pack: +p.pack || 1, loose: !!p.loose, cat: p.cat ?? null, pantry: !!p.pantry, conv: p.conv ?? null, kw: p.kw ?? null, updated_at: new Date().toISOString() })),
        part => db.from('products').upsert(part, { onConflict: 'id' }));
      const regular = products.flatMap((p: any) => Object.entries(p.regular ?? {}).filter(([, v]) => +v > 0).map(([store, v]) => ({ product_id: p.id, store, regular: +v })));
      await chunked(regular, part => db.from('prices').upsert(part, { onConflict: 'product_id,store' }));
      const recipes = (kat.data.recipes ?? []).map((r: any) => ({
        id: r.id, name: r.name, category: r.category, base: r.base ?? 2, minutes: r.minutes ?? null, freeze_months: r.freeze_months ?? 3,
        sides: r.sides ?? '', thaw: r.thaw ?? '', ingredients: r.ingredients ?? [], steps: r.steps ?? [], source: r.source ?? 'seed',
        default_active: r.default_active !== false, added_on: r.added_on ?? null, inspired_by: r.inspired_by ?? null, freezer: r.freezer !== false,
        source_url: /^https:\/\//.test(r.source_url ?? '') ? r.source_url : null, updated_at: new Date().toISOString(),
      }));
      await chunked(recipes, part => db.from('recipes').upsert(part, { onConflict: 'id' }));
      await db.from('sync_state').upsert({ key: 'katalog', hash: kat.hash, synced_at: new Date().toISOString() });
      report.katalog = { products: products.length, recipes: recipes.length };
    } else report.katalog = kat ? 'bez zmian' : 'brak pliku';

    // --- oferty i ceny promocyjne ---
    const of = await fetchFile('oferty.json', ref);
    if (of && (force || of.hash !== prev.oferty)) {
      const { data: known } = await db.from('products').select('id');
      const ids = new Set((known ?? []).map(p => p.id));
      const offers = (of.data.offers ?? []).map((o: any) => ({
        store: o.store, product_id: ids.has(o.product_id) ? o.product_id : null, name: String(o.name ?? '').slice(0, 200), price: o.price ?? null,
        price_for_pack: o.price_for_pack ?? null, regular: o.regular ?? null, unit_info: o.unit_info ?? null, valid_from: o.valid_from ?? null,
        valid_to: o.valid_to ?? null, note: o.note ?? null, page: o.page == null ? null : String(o.page), leaflet: o.leaflet ?? null,
      }));
      let r = await db.from('offers').delete().gte('id', 0); if (r.error) throw r.error;
      await chunked(offers, part => db.from('offers').insert(part));
      r = await db.from('prices').update({ promo: null, promo_from: null, promo_to: null, promo_note: null }).not('promo', 'is', null); if (r.error) throw r.error;
      const promos = (of.data.promos ?? []).filter((p: any) => ids.has(p.product_id) && +p.promo > 0)
        .map((p: any) => ({ product_id: p.product_id, store: p.store, promo: +p.promo, promo_from: p.from ?? null, promo_to: p.to ?? null, promo_note: p.note ?? null, updated_at: new Date().toISOString() }));
      await chunked(promos, part => db.from('prices').upsert(part, { onConflict: 'product_id,store' }));
      const runs = (of.data.runs ?? []).map((x: any) => ({ store: x.store, ran_at: x.ran_at, status: x.status, message: x.message ?? null, valid_from: x.valid_from ?? null, valid_to: x.valid_to ?? null, matched: x.matched ?? null }));
      if (runs.length) await chunked(runs, part => db.from('scrape_runs').upsert(part, { onConflict: 'store,ran_at' }));
      await db.from('sync_state').upsert({ key: 'oferty', hash: of.hash, synced_at: new Date().toISOString() });
      report.oferty = { offers: offers.length, promos: promos.length };
    } else report.oferty = of ? 'bez zmian' : 'brak pliku';
    return json({ ok: true, ...report });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error)?.message ?? e), ...report }, 500);
  }
});
