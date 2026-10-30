// Sprawdza paczki z folderu przepisy/ i wgrywa nowe przepisy do bazy.
// Bez sekretów (np. lokalnie albo w Claude) tylko sprawdza poprawność: node scripts/import-recipes.mjs --check
import { loadAll, validate, importBatches } from './batches.mjs';

const data = await loadAll();
const errors = validate(data);
const n = data.batches.reduce((s, b) => s + (b.recipes?.length || 0), 0);
if (errors.length) { console.log('✗ Błędy w przepisach:\n' + errors.map(e => '  - ' + e).join('\n')); process.exit(1); }
console.log(`✓ ${data.batches.length} paczek, ${n} przepisów: wszystko poprawne`);
if (process.argv.includes('--check')) process.exit(0);
const { adminClient } = await import('./lib.mjs');
const { db } = await adminClient();
await importBatches(db, data);
