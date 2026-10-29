// Instalacja: baza, konto domu, przepisy startowe, konfiguracja aplikacji.
// Uruchamiane przez workflow „Instalacja i publikacja”. Można uruchamiać wielokrotnie.
import { readFile, writeFile } from 'node:fs/promises';
import { env, projectRef, mgmt, apiKeys, HOUSE_EMAIL } from './lib.mjs';
import { createClient } from '@supabase/supabase-js';

const step = m => console.log(`\n▶ ${m}`);

const ref = projectRef();
const houseKey = env('KOD_DOMU');
if (houseKey.length < 6) throw new Error('KOD_DOMU musi mieć co najmniej 6 znaków.');
const aiKey = env('ANTHROPIC_API_KEY', false);

step('Tworzę tabele w bazie');
const sql = await readFile(new URL('../supabase/migrations/001_init.sql', import.meta.url), 'utf8');
await mgmt(`/projects/${ref}/database/query`, { method: 'POST', body: JSON.stringify({ query: sql }) });
console.log('  gotowe');

step('Pobieram klucze projektu');
const keys = await apiKeys(ref);
const db = createClient(keys.url, keys.service, { auth: { persistSession: false } });

step('Ustawiam konto domu (logowanie kodem)');
{
  const { error } = await db.auth.admin.createUser({ email: HOUSE_EMAIL, password: houseKey, email_confirm: true });
  if (error) {
    const { data, error: e2 } = await db.auth.admin.listUsers({ perPage: 200 });
    if (e2) throw e2;
    const u = data.users.find(u => u.email === HOUSE_EMAIL);
    if (!u) throw error;
    const { error: e3 } = await db.auth.admin.updateUserById(u.id, { password: houseKey });
    if (e3) throw e3;
    console.log('  konto istniało, zaktualizowano kod domu');
  } else console.log('  utworzono konto domu');
}

step('Wgrywam produkty i przepisy startowe (istniejące zostają bez zmian)');
{
  const products = JSON.parse(await readFile(new URL('../seed/products.json', import.meta.url), 'utf8'));
  const recipes = JSON.parse(await readFile(new URL('../seed/recipes.json', import.meta.url), 'utf8'));
  const prodRows = products.map(({ regular, ...p }) => p);
  let r = await db.from('products').upsert(prodRows, { onConflict: 'id', ignoreDuplicates: true });
  if (r.error) throw r.error;
  const priceRows = products.flatMap(p => Object.entries(p.regular || {}).map(([store, v]) => ({ product_id: p.id, store, regular: v, regular_src: 'szac' })));
  r = await db.from('prices').upsert(priceRows, { onConflict: 'product_id,store', ignoreDuplicates: true });
  if (r.error) throw r.error;
  r = await db.from('recipes').upsert(recipes, { onConflict: 'id', ignoreDuplicates: true });
  if (r.error) throw r.error;
  console.log(`  ${products.length} produktów, ${recipes.length} przepisów`);
}

if (aiKey) {
  step('Zapisuję klucz Anthropic dla generatora przepisów');
  await mgmt(`/projects/${ref}/secrets`, { method: 'POST', body: JSON.stringify([{ name: 'ANTHROPIC_API_KEY', value: aiKey }]) });
  console.log('  gotowe');
} else console.log('\n(brak ANTHROPIC_API_KEY — generator przepisów i odczyt gazetek przez AI wyłączone)');

step('Zapisuję konfigurację aplikacji');
await writeFile(new URL('../web/config.js', import.meta.url),
  `window.APP_CONFIG=${JSON.stringify({ url: keys.url, anon: keys.anon, email: HOUSE_EMAIL, ai: !!aiKey })};\n`);
console.log('  gotowe');
