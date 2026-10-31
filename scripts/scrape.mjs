// Darmowe pobieranie cen promocyjnych Biedronki, Lidla i Kauflandu (bez płatnego AI).
// Źródła, od najdokładniejszego:
// 1) strony „oferta tygodnia” sklepu — ceny jako tekst na kafelkach produktów (te same promocje co w gazetce),
// 2) gazetka w PDF z warstwą tekstu (pdftotext),
// 3) gazetka jako obrazy → zrzuty stron + OCR (Tesseract); najmniej pewne, więc z ostrzejszą kontrolą cen.
// Produkty z katalogu wyszukiwane po słowach kluczowych, ceny sprawdzane z ceną regularną.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, today, env } from './lib.mjs';
import { loadAll, buildKatalog } from './batches.mjs';
import { matchOffers, findValidity, scoreLink, scoreOfferLink } from './extract.mjs';

const run = promisify(execFile);
const STORES = {
  b: { name: 'Biedronka', home: 'https://www.biedronka.pl/pl', start: ['https://www.biedronka.pl/pl/gazetki'] },
  l: { name: 'Lidl', home: 'https://www.lidl.pl/', start: ['https://www.lidl.pl/c/nasze-gazetki/s10008614', 'https://www.lidl.pl/'] },
  k: { name: 'Kaufland', home: 'https://www.kaufland.pl/', start: ['https://sklep.kaufland.pl/gazeta-reklamowa.html'] },
};
const ONLY = (env('STORES', false) || 'b,l,k').split(',').map(s => s.trim()).filter(s => STORES[s]);
const MAX_PAGES = +(env('MAX_PAGES', false) || 60);
const log = (...a) => console.log(...a);

// katalog = produkty startowe + dodane przez Claude (folder przepisy/); cena odniesienia = średnia cena regularna
const { products } = buildKatalog(await loadAll());
const catalog = products.filter(p => !p.pantry).map(p => { const v = Object.values(p.regular || {}).filter(x => +x > 0); return { ...p, ref: v.length ? v.reduce((a, b) => a + b) / v.length : null }; });
log(`Katalog: ${catalog.length} produktów, ${catalog.filter(p => p.ref && p.kw?.length).length} z ceną odniesienia i słowami kluczowymi.`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1100, height: 1500 }, deviceScaleFactor: 1.5, acceptDownloads: true,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
});

async function dismissCookies(page) {
  for (const s of ['#onetrust-accept-btn-handler', 'button#accept', '[data-testid="uc-accept-all-button"]']) {
    const el = page.locator(s).first(); if (await el.isVisible().catch(() => false)) { await el.click().catch(() => { }); await sleep(600); return; }
  }
  const btn = page.getByRole('button', { name: /akceptuj|zaakceptuj|zgadzam|zezwól|accept all|allow all/i }).first();
  if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => { }); await sleep(600); }
}
async function open(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500); await dismissCookies(page); await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => { });
}
async function links(page) {
  return page.$$eval('a[href]', as => as.map(a => ({ href: a.href.split('#')[0], text: (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 160) }))
    .filter(l => /^https?:/.test(l.href)).filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i));
}

// Znajduje do 2 gazetek spożywczych: idzie w głąb po najlepiej ocenionych linkach.
async function findLeaflets(store, page) {
  const seen = new Set(), found = [];
  async function visit(url, depth) {
    if (seen.has(url) || found.length >= 2) return; seen.add(url);
    log(`  ${'  '.repeat(depth)}otwieram ${url}`);
    try { await open(page, url); } catch (e) { log('   nie udało się:', e.message); return; }
    const ls = (await links(page)).map(l => ({ ...l, score: scoreLink(l) })).filter(l => l.score >= 5 && !seen.has(l.href)).sort((a, b) => b.score - a.score);
    // strona z kilkoma mocnymi linkami do gazetek to lista; w przeciwnym razie to sama gazetka
    if (depth > 0 && (ls.filter(l => l.score >= 9).length < 3 || depth >= 2)) { found.push(url); return; }
    for (const l of ls.slice(0, 3)) { await visit(l.href, depth + 1); if (found.length >= 2) break; }
  }
  for (const s of STORES[store].start) { await visit(s, 0); if (found.length) break; }
  return found;
}

// Strony z ofertami tygodnia: przewijamy (doładowanie kafelków) i bierzemy widoczny tekst.
async function offerPages(store, page) {
  const out = [];
  try { await open(page, STORES[store].home); } catch (e) { log('   strona główna niedostępna:', e.message); return out; }
  const host = new URL(STORES[store].home).hostname.replace(/^www\./, '');
  const ls = (await links(page)).filter(l => l.href.includes(host)).map(l => ({ ...l, score: scoreOfferLink(l) })).filter(l => l.score >= 5).sort((a, b) => b.score - a.score).slice(0, 4);
  for (const l of ls) {
    try {
      await open(page, l.href);
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, 2500); await sleep(500);
        const more = page.getByRole('button', { name: /pokaż więcej|załaduj więcej|więcej produktów|zobacz więcej/i }).first();
        if (await more.isVisible().catch(() => false)) { await more.click().catch(() => { }); await sleep(1200); }
      }
      const text = await page.innerText('body').catch(() => '');
      log(`   oferty: ${l.text || l.href} → ${text.length} znaków`);
      if (text.length > 500) out.push({ page: 'www', text, src: 'www' });
    } catch (e) { log('   nie udało się:', e.message); }
  }
  return out;
}

const tmp = await mkdtemp(join(tmpdir(), 'gazetki-'));
let fileNo = 0;
async function ocr(file) {
  const { stdout } = await run('tesseract', [file, 'stdout', '-l', 'pol', '--psm', '11'], { maxBuffer: 20e6 }).catch(() => ({ stdout: '' }));
  return stdout;
}
async function pdfPages(buf) {
  const f = join(tmp, `g${++fileNo}.pdf`); await writeFile(f, buf);
  const { stdout } = await run('pdftotext', ['-layout', '-l', String(MAX_PAGES), f, '-'], { maxBuffer: 80e6 }).catch(() => ({ stdout: '' }));
  let pages = stdout.split('\f').map((text, i) => ({ page: i + 1, text, src: 'pdf' })).filter(p => p.text.trim());
  const letters = pages.reduce((n, p) => n + (p.text.match(/[a-ząćęłńóśźż]/gi) || []).length, 0);
  if (pages.length && letters / pages.length > 150) { log(`   PDF z tekstem: ${pages.length} stron`); return pages; }
  log('   PDF bez warstwy tekstu → OCR');
  const prefix = join(tmp, `p${fileNo}`);
  await run('pdftoppm', ['-r', '170', '-png', '-l', String(MAX_PAGES), f, prefix], { maxBuffer: 10e6 });
  const imgs = (await readdir(tmp)).filter(n => n.startsWith(`p${fileNo}-`)).sort();
  pages = [];
  for (const [i, n] of imgs.entries()) pages.push({ page: i + 1, text: await ocr(join(tmp, n)), src: 'ocr' });
  return pages;
}

// Zwraca tekst stron jednej gazetki: [{page, text}]
async function leafletPages(page, url) {
  const pdfUrls = new Set();
  const onResp = r => { const ct = r.headers()['content-type'] || ''; if (ct.includes('application/pdf') || /\.pdf(\?|$)/i.test(r.url())) pdfUrls.add(r.url()); };
  page.on('response', onResp);
  try {
    await open(page, url);
    (await page.$$eval('a[href]', as => as.map(a => a.href).filter(h => /\.pdf(\?|$)/i.test(h))).catch(() => [])).forEach(h => pdfUrls.add(h));
    if (!pdfUrls.size) {
      const dl = page.locator('a, button').filter({ hasText: /pobierz|download|\bpdf\b/i }).first();
      if (await dl.isVisible().catch(() => false)) {
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), dl.click().catch(() => { })]);
        if (download) { const p = await download.path(); if (p) { const buf = await readFile(p); if (buf.slice(0, 4).toString() === '%PDF') return pdfPages(buf); } }
        await sleep(2000);
      }
    }
    for (const u of pdfUrls) {
      const r = await page.request.get(u, { timeout: 90000 }).catch(() => null);
      if (r?.ok()) { const buf = await r.body(); if (buf.slice(0, 4).toString() === '%PDF') { log(`   PDF: ${u}`); return pdfPages(buf); } }
    }
    // brak PDF: przewijamy przeglądarkę gazetki, robimy zrzuty i OCR
    if (page.url() !== url) await open(page, url).catch(() => { });
    const pages = []; let last = null, same = 0;
    for (let i = 0; i < MAX_PAGES; i++) {
      const shot = await page.screenshot({ type: 'png' });
      const h = createHash('sha1').update(shot).digest('hex');
      if (h === last) { if (++same >= 2) break; }
      else { same = 0; last = h; const f = join(tmp, `s${++fileNo}.png`); await writeFile(f, shot); pages.push({ page: pages.length + 1, text: await ocr(f), src: 'ocr' }); }
      const next = page.locator('[aria-label*="nast" i], [aria-label*="next" i], [title*="nast" i], [class*="next" i]:not([class*="disabled" i])').filter({ visible: true }).first();
      if (await next.count().catch(() => 0)) await next.click({ timeout: 3000 }).catch(() => page.keyboard.press('ArrowRight'));
      else await page.keyboard.press('ArrowRight');
      await sleep(1500);
    }
    log(`   zrzuty + OCR: ${pages.length} ekranów`);
    return pages;
  } finally { page.off('response', onResp); }
}

const OUT = { offers: [], promos: [], runs: [] };
function collect(store, leaflet, pages) {
  const all = pages.map(p => p.text).join('\n');
  const v = findValidity(all, today()) || { valid_from: today(), valid_to: new Date(Date.now() + 6 * 864e5).toLocaleDateString('sv-SE') };
  // tekst (www, PDF) ma pierwszeństwo; OCR tylko dla produktów, których tam nie było, i z węższym zakresem cen
  const exact = matchOffers(pages.filter(p => p.src !== 'ocr'), catalog);
  const got = new Set(exact.map(o => o.product_id));
  const fromOcr = matchOffers(pages.filter(p => p.src === 'ocr'), catalog.filter(p => !got.has(p.id)))
    .filter(o => { const p = catalog.find(c => c.id === o.product_id); return o.price_for_pack >= p.ref * 0.5 && o.price_for_pack <= p.ref * 1.1; })
    .map(o => ({ ...o, note: 'odczyt OCR, sprawdź w sklepie' }));
  const rows = [...exact, ...fromOcr].map(o => ({ store, leaflet, valid_from: v.valid_from, valid_to: v.valid_to, ...o }));
  const name = Object.fromEntries(catalog.map(p => [p.id, p.name]));
  OUT.offers.push(...rows);
  OUT.promos.push(...rows.map(r => ({ product_id: r.product_id, name: name[r.product_id], store, store_name: STORES[store].name, promo: r.price_for_pack, regular: r.regular, from: r.valid_from, to: r.valid_to, note: [r.name, r.note].filter(Boolean).join(' · ').slice(0, 200) })));
  const chars = all.replace(/\s/g, '').length, ok = chars > 500;
  OUT.runs.push({ store, ran_at: new Date().toISOString(), status: ok ? 'ok' : 'error', valid_from: v.valid_from, valid_to: v.valid_to, matched: rows.length, message: ok ? `tekst: ${exact.length} · OCR: ${fromOcr.length}` : 'Nie udało się odczytać tekstu ofert.' });
  return { matched: rows.length, exact: exact.length, ocr: fromOcr.length, valid: v, ok };
}

let failed = 0;
for (const store of ONLY) {
  log(`\n▶ ${STORES[store].name}`);
  const page = await ctx.newPage();
  try {
    const pages = await offerPages(store, page);
    const leaflets = await findLeaflets(store, page);
    for (const url of leaflets) { log(`  gazetka: ${url}`); pages.push(...await leafletPages(page, url)); }
    if (!pages.length) throw new Error('Nie znalazłem ani ofert, ani gazetki na stronie sklepu.');
    const s = collect(store, leaflets[0] || STORES[store].home, pages);
    if (!s.ok) failed++;
    log(`  ważne ${s.valid.valid_from} – ${s.valid.valid_to}; produkty z katalogu: ${s.exact} z tekstu, ${s.ocr} z OCR`);
  } catch (e) {
    failed++; log(`  ✗ ${e.message}`);
    OUT.runs.push({ store, ran_at: new Date().toISOString(), status: 'error', message: e.message.slice(0, 500) });
  } finally { await page.close(); }
}
await browser.close();

// Wynik do dane/oferty.json (stąd funkcja „sync” w Supabase wgrywa go do bazy, a Claude dobiera przepisy).
// Sklep, którego nie udało się odczytać, zachowuje poprzednie, wciąż ważne oferty.
{
  const file = new URL('../dane/oferty.json', import.meta.url), t = today();
  const prev = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
  const okStores = new Set(OUT.runs.filter(r => r.status === 'ok').map(r => r.store));
  const keep = (arr, toKey) => (arr || []).filter(x => !okStores.has(x.store) && (x[toKey] || '9999') >= t);
  const out = {
    updated: new Date().toISOString(),
    runs: [...OUT.runs, ...(prev.runs || []).filter(r => !OUT.runs.some(n => n.store === r.store && n.ran_at === r.ran_at))].slice(0, 30),
    promos: [...OUT.promos, ...keep(prev.promos, 'to')].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pl')),
    offers: [...OUT.offers, ...keep(prev.offers, 'valid_to')],
  };
  await mkdir(new URL('../dane/', import.meta.url), { recursive: true });
  await writeFile(file, JSON.stringify(out, null, 1) + '\n');
  log(`\nZapisano dane/oferty.json: ${out.promos.length} promocji.`);
}
if (failed === ONLY.length) process.exit(1);
