// Biblioteki przeglądarki trzymane w repozytorium (web/vendor/) zamiast ładowania z CDN.
// Wersje są przypięte w package.json i package-lock.json (z sumami kontrolnymi npm).
//   node scripts/vendor.mjs          – kopiuje pliki z node_modules i zapisuje web/vendor/WERSJE.json
//   node scripts/vendor.mjs --check  – sprawdza, czy web/vendor/ zgadza się z pakietami (uruchamia to CI)
// Foldery fonts/ i README.md w web/vendor/ są utrzymywane ręcznie i ten skrypt ich nie dotyka.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NM = join(ROOT, 'node_modules');
const VENDOR = join(ROOT, 'web', 'vendor');
const MANAGED = ['supabase', 'pdfjs', 'tesseract'];
const PACKAGES = ['@supabase/supabase-js', 'pdfjs-dist', 'tesseract.js', 'tesseract.js-core', '@tesseract.js-data/pol', 'esbuild'];

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const version = async name => JSON.parse(await readFile(join(NM, name, 'package.json'), 'utf8')).version;
function first(...paths) {
  const p = paths.find(x => existsSync(join(NM, x)));
  if (!p) throw new Error('Brak pliku w pakiecie: ' + paths.join(' albo '));
  return join(NM, p);
}
async function list(dir, base = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...await list(join(dir, e.name), rel)); else out.push(rel);
  }
  return out.sort();
}

async function produce(out) {
  const copy = async (src, dest) => { await mkdir(dirname(join(out, dest)), { recursive: true }); await copyFile(src, join(out, dest)); };
  const license = async (pkg, dest) => {
    const f = (await readdir(join(NM, pkg))).find(n => /^licen[cs]e/i.test(n));
    if (f) await copy(join(NM, pkg, f), dest); else console.warn('Brak pliku licencji w', pkg);
  };

  // supabase-js: jeden moduł ES (eksport createClient), bez zależności ładowanych z sieci
  await build({
    stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: ROOT, sourcefile: 'supabase-wejscie.js', loader: 'js' },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(out, 'supabase', 'supabase.mjs'), logLevel: 'warning',
  });
  await license('@supabase/supabase-js', 'supabase/LICENSE');

  // pdf.js w wersji „legacy” (działa też na starszych iPhone'ach)
  await copy(first('pdfjs-dist/legacy/build/pdf.min.mjs', 'pdfjs-dist/legacy/build/pdf.mjs'), 'pdfjs/pdf.mjs');
  await copy(first('pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdfjs-dist/legacy/build/pdf.worker.mjs'), 'pdfjs/pdf.worker.mjs');
  const wasm = join(NM, 'pdfjs-dist', 'wasm');
  if (existsSync(wasm)) for (const f of await list(wasm)) await copy(join(wasm, f), 'pdfjs/wasm/' + f);
  await license('pdfjs-dist', 'pdfjs/LICENSE');

  // tesseract.js: biblioteka, worker, rdzeń WebAssembly (tylko LSTM: z SIMD i bez) i dane języka polskiego
  await copy(first('tesseract.js/dist/tesseract.min.js'), 'tesseract/tesseract.min.js');
  await copy(first('tesseract.js/dist/worker.min.js'), 'tesseract/worker.min.js');
  await license('tesseract.js', 'tesseract/LICENSE');
  for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js']) await copy(first('tesseract.js-core/' + f), 'tesseract/core/' + f);
  await license('tesseract.js-core', 'tesseract/core/LICENSE');
  await copy(first('@tesseract.js-data/pol/4.0.0_best_int/pol.traineddata.gz'), 'tesseract/lang/pol.traineddata.gz');
  await license('@tesseract.js-data/pol', 'tesseract/lang/LICENSE');

  const pliki = {};
  for (const d of MANAGED) for (const f of await list(join(out, d))) {
    const buf = await readFile(join(out, d, f));
    pliki[d + '/' + f] = { bajty: buf.length, sha256: sha256(buf) };
  }
  const pakiety = {};
  for (const p of PACKAGES) pakiety[p] = await version(p);
  return { uwaga: 'Plik tworzy scripts/vendor.mjs (workflow „Biblioteki przeglądarki”). Nie edytuj ręcznie.', pakiety, pliki };
}

if (process.argv.includes('--check')) {
  const tmp = await mkdtemp(join(tmpdir(), 'vendor-'));
  const fresh = await produce(tmp);
  const saved = JSON.parse(await readFile(join(VENDOR, 'WERSJE.json'), 'utf8').catch(() => '{}'));
  const errors = [];
  for (const [p, v] of Object.entries(fresh.pakiety)) if (saved.pakiety?.[p] !== v) errors.push(`${p}: w WERSJE.json ${saved.pakiety?.[p]}, w node_modules ${v}`);
  const present = new Set();
  for (const d of MANAGED) if (existsSync(join(VENDOR, d))) for (const f of await list(join(VENDOR, d))) present.add(d + '/' + f);
  for (const [f, { sha256: want }] of Object.entries(fresh.pliki)) {
    if (!present.has(f)) { errors.push(`brak pliku ${f}`); continue; }
    present.delete(f);
    if (sha256(await readFile(join(VENDOR, f))) !== want) errors.push(`${f}: inna zawartość niż w pakiecie`);
    if (saved.pliki?.[f]?.sha256 !== want) errors.push(`${f}: nieaktualna suma w WERSJE.json`);
  }
  for (const f of present) errors.push(`${f}: plik spoza pakietów`);
  await rm(tmp, { recursive: true, force: true });
  if (errors.length) { console.error('web/vendor/ nie zgadza się z pakietami npm:\n- ' + errors.join('\n- ')); process.exit(1); }
  console.log(`web/vendor/ zgodne z pakietami (${Object.keys(fresh.pliki).length} plików).`);
} else {
  for (const d of MANAGED) await rm(join(VENDOR, d), { recursive: true, force: true });
  const manifest = await produce(VENDOR);
  await writeFile(join(VENDOR, 'WERSJE.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [f, { bajty }] of Object.entries(manifest.pliki)) console.log(String(bajty).padStart(9), f);
  console.log('Zapisano web/vendor/WERSJE.json:', Object.entries(manifest.pakiety).map(([p, v]) => `${p}@${v}`).join(', '));
}
