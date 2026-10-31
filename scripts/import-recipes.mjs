// Sprawdza katalog startowy i paczki przepisów z folderu przepisy/, po czym buduje dane/katalog.json.
// Funkcja „sync” w Supabase co godzinę pobiera ten plik i aktualizuje bazę.
//   node scripts/import-recipes.mjs          → sprawdzenie + zapis dane/katalog.json
//   node scripts/import-recipes.mjs --check  → tylko sprawdzenie
import { writeFile, mkdir } from 'node:fs/promises';
import { loadAll, validate, buildKatalog } from './batches.mjs';

const data = await loadAll();
const errors = validate(data);
const n = data.batches.reduce((s, b) => s + (b.recipes?.length || 0), 0);
if (errors.length) { console.log('✗ Błędy w przepisach:\n' + errors.map(e => '  - ' + e).join('\n')); process.exit(1); }
console.log(`✓ ${data.batches.length} paczek, ${n} przepisów od Claude: wszystko poprawne`);
if (process.argv.includes('--check')) process.exit(0);
const kat = buildKatalog(data);
await mkdir(new URL('../dane/', import.meta.url), { recursive: true });
await writeFile(new URL('../dane/katalog.json', import.meta.url), JSON.stringify(kat) + '\n');
console.log(`Zapisano dane/katalog.json: ${kat.products.length} produktów, ${kat.recipes.length} przepisów.`);
