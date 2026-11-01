// Darmowe pobieranie cen promocyjnych Biedronki, Lidla i Kauflandu (bez płatnego AI).
// Źródła, od najdokładniejszego:
// 1) strony „oferta tygodnia” sklepu — ceny jako tekst na kafelkach produktów (te same promocje co w gazetce),
// 2) gazetka w PDF z warstwą tekstu (pdftotext),
// 3) gazetka jako obrazy → zrzuty stron + OCR (Tesseract); najmniej pewne, więc z ostrzejszą kontrolą cen.
// Produkty z katalogu wyszukiwane po słowach kluczowych, ceny sprawdzane z ceną regularną.
// Wynik: dane/oferty-przebieg.json (tylko ten przebieg). Workflow „Ceny z gazetek” wysyła go do funkcji „ingest”
// w osobnym jobie; diagnostyka (dane/debug/) trafia do artefaktu workflowu, nie do repozytorium.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, today, env } from './lib.mjs';
import { loadAll, buildKatalog } from './batches.mjs';
import { matchOffers, findValidity, scoreLink, scoreOfferLink, aggOffers } from './extract.mjs';

const run = promisify(execFile);
const STORES = {
  b: { name: 'Biedronka', home: 'https://www.biedronka.pl/pl', start: ['https://www.biedronka.pl/pl/gazetki'] },
  l: { name: 'Lidl', home: 'https://www.lidl.pl/', start: ['https://www.lidl.pl/c/nasze-gazetki/s10008614', 'https://www.lidl.pl/'] },
  k: { name: 'Kaufland', home: 'https://www.kaufland.pl/', start: ['https://sklep.kaufland.pl/gazeta-reklamowa.html'] },
};
const ONLY = (env('STORES', false) || 'b,l,k').split(',').map(s => s.trim()).filter(s => STORES[s]);
const MAX_PAGES = +(env('MAX_PAGES', false) || 60);
const PAUSE = +(env('PAUSE_MS', false) || 1200); // przerwa między stronami agregatora (uprzejmość wobec serwisu)
const log = (...a) => console.log(...a);

// katalog = produkty startowe + dodane przez Claude (folder przepisy/); szukamy tylko produktów używanych w przepisach;
// cena odniesienia = średnia cena regularna
const { products, recipes } = buildKatalog(await loadAll());
const used = new Set(recipes.flatMap(r => (r.ingredients || []).map(i => i.pid)));
// wszystkie produkty do kupienia: składniki przepisów i słownik zakupów domowych (used zostaje dla diagnostyki)
const catalog = products.filter(p => !p.pantry).map(p => { const v = Object.values(p.regular || {}).filter(x => +x > 0); return { ...p, ref: v.length ? v.reduce((a, b) => a + b) / v.length : null }; });
log(`Katalog: ${catalog.length} produktów, ${catalog.filter(p => p.ref && p.kw?.length).length} z ceną odniesienia i słowami kluczowymi.`);

const browser = await chromium.launch();
// uczciwy User-Agent: prawdziwa przeglądarka i system oraz nazwa robota z adresem projektu
const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split('.')[0]}.0.0.0 Safari/537.36 ObiadyNaZapas/1.0 (+https://github.com/SirMaasdamer/obiady-na-zapas)`;
const ctx = await browser.newContext({
  locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1100, height: 1500 }, deviceScaleFactor: 1.5, acceptDownloads: true, userAgent: UA,
});

// ---------- diagnostyka: co robot widzi (zapis w dane/debug/, żeby dało się poprawiać odczyt) ----------
const DEBUG = {};
const dbg = (store, ...lines) => { (DEBUG[store] ??= []).push(lines.join(' ')); };
let shotNo = 0;
async function snapshot(store, page, label) {
  try {
    const text = (await page.innerText('body').catch(() => '')).replace(/\n{3,}/g, '\n\n');
    const ls = await links(page).catch(() => []);
    dbg(store, `\n===== ${label}: ${page.url()} | tytuł: ${await page.title().catch(() => '')} | tekst: ${text.length} znaków`);
    dbg(store, text.slice(0, 6000));
    dbg(store, `--- linki (${ls.length}), najlepiej ocenione:`);
    for (const l of ls.map(l => ({ ...l, s1: scoreLink(l), s2: scoreOfferLink(l) })).sort((a, b) => Math.max(b.s1, b.s2) - Math.max(a.s1, a.s2)).slice(0, 25)) dbg(store, `  [${l.s1}/${l.s2}] ${l.text} → ${l.href}`);
    if (shotNo < 12) {
      await mkdir(new URL('../dane/debug/', import.meta.url), { recursive: true });
      const f = `${store}-${++shotNo}.jpg`;
      await page.screenshot({ path: new URL('../dane/debug/' + f, import.meta.url).pathname, type: 'jpeg', quality: 45, scale: 'css' });
      dbg(store, `--- zrzut: dane/debug/${f}`);
    }
  } catch (e) { dbg(store, 'snapshot błąd: ' + e.message); }
}

// ---------- dane JSON ładowane przez strony sklepów (oferty, gazetki) → linie „nazwa … cena” ----------
const JSON_LINES = {}; let curStore = null;
const PRICE_KEY = /^(price|prices|currentprice|pricevalue|cena|amount|value|gross|promoprice|promotionprice|saleprice|finalprice)$/i;
const OLD_KEY = /^(oldprice|regularprice|strikeprice|originalprice|baseprice|cenaregularna|previousprice|crossedprice)$/i;
const NAME_KEY = /^(title|name|productname|fulltitle|displayname|label|headline|subtitle|description|brand|keyfacts|basicprice|packaging|unit)$/i;
function flattenJson(node, out, depth = 0) {
  if (!node || depth > 12 || out.length > 4000) return;
  if (Array.isArray(node)) { node.forEach(n => flattenJson(n, out, depth + 1)); return; }
  if (typeof node !== 'object') return;
  const words = [], prices = [], olds = [];
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && NAME_KEY.test(k) && v.length < 160 && !/^https?:/.test(v)) words.push(v.replace(/<[^>]+>/g, ' '));
    const pv = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}([.,]\d{1,2})?$/.test(v.trim()) ? parseFloat(v.replace(',', '.')) : (v && typeof v === 'object' && !Array.isArray(v) && (typeof v.price === 'number' || typeof v.value === 'number')) ? (v.price ?? v.value) : null;
    if (pv != null && pv > 0.3 && pv < 1000) { if (PRICE_KEY.test(k)) prices.push(pv); else if (OLD_KEY.test(k)) olds.push(pv); }
  }
  if (words.length && prices.length) out.push(`${words.join(' ')}\n${olds.length ? olds[0].toFixed(2).replace('.', ',') + ' zł\n' : ''}${Math.min(...prices).toFixed(2).replace('.', ',')} zł`);
  for (const v of Object.values(node)) if (v && typeof v === 'object') flattenJson(v, out, depth + 1);
}
ctx.on('response', async r => {
  try {
    const ct = r.headers()['content-type'] || ''; if (!curStore || !ct.includes('json')) return;
    const len = +(r.headers()['content-length'] || 0); if (len > 8e6) return;
    const body = await r.json().catch(() => null); if (!body) return;
    const out = []; flattenJson(body, out);
    if (out.length) { (JSON_LINES[curStore] ??= new Map()).set(r.url(), out); dbg(curStore, `--- JSON ${r.url().slice(0, 160)}: ${out.length} pozycji, np.: ${out.slice(0, 3).map(x => x.replace(/\n/g, ' | ')).join(' || ')}`); }
  } catch { }
});

// ---------- agregatory gazetek: wyszukiwanie produktu w ofertach danego sklepu (tekst, nie obrazy) ----------
const AGG_SLUG = { b: 'biedronka', l: 'lidl', k: 'kaufland' };
async function aggregatorPages(store, page) {
  // dla każdego produktu odwiedzamy strony do 4 słów kluczowych (różne nazwy tego samego produktu dają różne oferty)
  const items = [], seen = new Set(); let ok = 0, fail = 0;
  for (const p of catalog.filter(p => p.kw?.length && p.ref)) {
    for (const kw of p.kw.slice(0, 4).map(k => k.trim())) {
      if (seen.has(kw)) continue; seen.add(kw);
      const url = `https://www.gazetki.pl/oferty/${encodeURIComponent(kw.replace(/\s+/g, '-'))}/${AGG_SLUG[store]}`;
      await sleep(PAUSE + Math.random() * 500);
      try {
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (!r || r.status() >= 400) { fail++; if (fail >= 8 && !ok) return items; continue; }
        if (ok === 0) { await sleep(1500); await dismissCookies(page); }
        // kafelki doładowują się skryptem: czekamy aż pojawi się cena (albo strona bez ofert się ustabilizuje)
        await page.waitForFunction(() => /\d,\d{2}\s*zł/.test(document.body.innerText) || /\b0 promocji|brak (ofert|promocji)/i.test(document.body.innerText), null, { timeout: 7000 }).catch(() => { });
        await sleep(400);
        const cards = await page.evaluate(() => {
          // kafelek = najbliższy przodek ceny, który ma obrazek i kilka linii tekstu (niezależnie od klas CSS)
          const out = [], seen = new Set();
          const leaves = [...document.querySelectorAll('body *')].filter(e => !e.children.length && !e.closest('table') && /\d,\d{2}\s*zł/.test(e.textContent || ''));
          for (const leaf of leaves) {
            let el = leaf;
            while (el.parentElement && !(el.querySelector('img') && (el.innerText || '').split('\n').filter(x => x.trim()).length >= 2)) el = el.parentElement;
            if (!el || el === document.body || seen.has(el) || (el.innerText || '').length > 400) continue; seen.add(el);
            const a = el.closest('a[href]') || el.querySelector('a[href]');
            const logos = [...el.querySelectorAll('img')].map(i => (i.alt || '') + ' ' + (i.getAttribute('src') || '')).join(' ').slice(0, 600);
            out.push({ href: a ? a.getAttribute('href') || '' : '', text: el.innerText || '', logos });
          }
          return out;
        }).catch(() => []);
        const rows = await page.$$eval('table tr', trs => trs.map(tr => [...tr.cells].map(td => td.innerText.trim()))).catch(() => []);
        if (ok === 0) { await snapshot(store, page, 'agregator (pierwsza strona)'); dbg(store, `kafelki: ${JSON.stringify(cards.slice(0, 4))}\nwiersze: ${JSON.stringify(rows.slice(0, 3))}`); }
        ok++; items.push({ kw, cards, rows });
      } catch (e) { fail++; if (fail >= 8 && !ok) return items; }
    }
  }
  log(`   agregator: ${ok} stron, ${fail} błędów`);
  dbg(store, `agregator: ${ok} stron, ${fail} błędów`);
  return items;
}

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
    try { await open(page, url); await snapshot(store, page, `gazetki (poziom ${depth})`); } catch (e) { log('   nie udało się:', e.message); dbg(store, `${url}: ${e.message}`); return; }
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
  try { await open(page, STORES[store].home); await snapshot(store, page, 'strona główna'); } catch (e) { log('   strona główna niedostępna:', e.message); dbg(store, 'strona główna: ' + e.message); return out; }
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
      await snapshot(store, page, 'oferty');
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
function collect(store, leaflet, pages, agg = []) {
  const all = pages.map(p => p.text).join('\n');
  const v = findValidity(all, today()) || { valid_from: today(), valid_to: new Date(Date.now() + 6 * 864e5).toLocaleDateString('sv-SE') };
  // tekst (www, PDF) ma pierwszeństwo; OCR tylko dla produktów, których tam nie było, i z węższym zakresem cen
  // gazetki.pl: dane strukturalne, sklep i daty podane wprost → najpewniejsze; strony sklepu uzupełniają resztę
  const fromAgg = aggOffers(agg, catalog, AGG_SLUG[store], STORES[store].name, today());
  const own = matchOffers(pages.filter(p => p.src !== 'ocr'), catalog.filter(p => !fromAgg.some(o => o.product_id === p.id)));
  const exact = [...fromAgg, ...own];
  const got = new Set(exact.map(o => o.product_id));
  const fromOcr = matchOffers(pages.filter(p => p.src === 'ocr'), catalog.filter(p => !got.has(p.id)))
    .filter(o => { const p = catalog.find(c => c.id === o.product_id); return o.price_for_pack >= p.ref * 0.5 && o.price_for_pack <= p.ref * 1.1; })
    .map(o => ({ ...o, note: 'odczyt OCR, sprawdź w sklepie' }));
  const rows = [...exact, ...fromOcr].map(o => ({ store, leaflet: o.page === 'gazetki.pl' ? `https://www.gazetki.pl/sklepy/${AGG_SLUG[store]}/gazetka` : leaflet, valid_from: v.valid_from, valid_to: v.valid_to, ...o, page: o.page == null ? null : String(o.page) }));
  const name = Object.fromEntries(catalog.map(p => [p.id, p.name]));
  OUT.offers.push(...rows);
  dbg(store, `\n===== DOPASOWANE (${rows.length}):`); rows.forEach(r => dbg(store, `  ${r.product_id}: ${r.price_for_pack} zł ← „${r.name}” (${r.unit_info || ''})`));
  for (const pg of pages) dbg(store, `źródło ${pg.src}/${pg.page}: ${pg.text.length} znaków`);
  OUT.promos.push(...rows.map(r => ({ product_id: r.product_id, name: name[r.product_id], store, store_name: STORES[store].name, promo: r.price_for_pack, regular: r.regular, from: r.valid_from, to: r.valid_to, note: [r.name, r.note].filter(Boolean).join(' · ').slice(0, 200) })));
  const chars = all.replace(/\s/g, '').length, ok = chars > 500 || fromAgg.length > 0;
  OUT.runs.push({ store, ran_at: new Date().toISOString(), status: ok ? 'ok' : 'error', valid_from: v.valid_from, valid_to: v.valid_to, matched: rows.length, message: ok ? `gazetki.pl: ${fromAgg.length} · strony sklepu: ${own.length} · OCR: ${fromOcr.length}` : 'Nie udało się odczytać tekstu ofert.' });
  return { matched: rows.length, exact: exact.length, ocr: fromOcr.length, valid: v, ok };
}

let failed = 0;
for (const store of ONLY) {
  log(`\n▶ ${STORES[store].name}`);
  const page = await ctx.newPage();
  try {
    curStore = store;
    const pages = await offerPages(store, page);
    const leaflets = await findLeaflets(store, page);
    for (const url of leaflets) { log(`  gazetka: ${url}`); pages.push(...await leafletPages(page, url)); }
    const agg = await aggregatorPages(store, page);
    const js = [...(JSON_LINES[store]?.values() || [])].flat();
    if (js.length) { pages.push({ page: 'json', text: js.join('\n\n'), src: 'json' }); log(`   dane JSON: ${js.length} pozycji`); }
    curStore = null;
    if (!pages.length && !agg.length) throw new Error('Nie znalazłem ani ofert, ani gazetki na stronie sklepu.');
    const s = collect(store, leaflets[0] || STORES[store].home, pages, agg);
    if (!s.ok) failed++;
    log(`  ważne ${s.valid.valid_from} – ${s.valid.valid_to}; produkty z katalogu: ${s.exact} z tekstu, ${s.ocr} z OCR`);
  } catch (e) {
    failed++; log(`  ✗ ${e.message}`);
    OUT.runs.push({ store, ran_at: new Date().toISOString(), status: 'error', message: e.message.slice(0, 500) });
  } finally { await page.close(); }
}
// ---------- próba: Blix (blix.pl) – tylko diagnostyka, nic nie trafia do ofert ----------
// Zapisuje w dane/debug/blix.txt, co serwis pokazuje (tekst, linki, odpowiedzi JSON), żeby ocenić, czy nadaje się na drugie źródło.
async function blixProbe() {
  const st = 'blix', page = await ctx.newPage(), json = [];
  page.on('response', async r => { try { const ct = r.headers()['content-type'] || ''; if (!ct.includes('json') || !/blix/.test(r.url())) return; const t = await r.text(); json.push(`${r.url().slice(0, 220)} :: ${t.length} B :: ${t.slice(0, 900).replace(/\s+/g, ' ')}`); } catch { } });
  let shots = 0;
  const visit = async (url, label) => {
    try {
      await open(page, url); await sleep(1500);
      const text = (await page.innerText('body').catch(() => '')).replace(/\n{3,}/g, '\n\n');
      dbg(st, `\n===== ${label}: ${page.url()} | tytuł: ${await page.title().catch(() => '')} | tekst: ${text.length} znaków`);
      dbg(st, text.slice(0, 5000));
      const ls = (await links(page)).filter(l => /blix\.pl/.test(l.href));
      dbg(st, `--- linki blix (${ls.length}):`); for (const l of ls.slice(0, 120)) dbg(st, `  ${l.text.slice(0, 60)} → ${l.href}`);
      if (shots++ < 6) { await mkdir(new URL('../dane/debug/', import.meta.url), { recursive: true }); await page.screenshot({ path: new URL(`../dane/debug/blix-${shots}.jpg`, import.meta.url).pathname, type: 'jpeg', quality: 45, scale: 'css' }); }
      return ls;
    } catch (e) { dbg(st, `${label} ${url}: ${e.message}`); return []; }
  };
  try {
    const home = await visit('https://blix.pl/', 'strona główna');
    for (const [k, n] of [['l', 'lidl'], ['b', 'biedronka'], ['k', 'kaufland']]) {
      const shop = home.find(l => new RegExp(`/${n}/?$`, 'i').test(new URL(l.href).pathname) || new RegExp(`sklep/${n}`, 'i').test(l.href))?.href || `https://blix.pl/sklep/${n}/`;
      const ls = await visit(shop, `sklep ${n}`);
      const leaflet = ls.find(l => /gazetka/i.test(l.href) && new RegExp(n, 'i').test(l.href) && l.href !== shop)?.href;
      if (leaflet) await visit(leaflet, `gazetka ${n}`);
      if (k === 'l') await visit(`https://blix.pl/szukaj/?szukaj=${encodeURIComponent('filet z kurczaka')}`, 'wyszukiwarka');
    }
  } finally {
    dbg(st, `\n===== odpowiedzi JSON (${json.length}):`); for (const j of json.slice(0, 60)) dbg(st, j);
    await page.close();
  }
}
if (env('BLIX_PROBE', false) !== '0') { log('\n▶ Blix (próba)'); await blixProbe().catch(e => log('  blix: ' + e.message)); }
await browser.close();

// Podgląd dla diagnostyki
await mkdir(new URL('../dane/debug/', import.meta.url), { recursive: true });
for (const [st, lines] of Object.entries(DEBUG)) await writeFile(new URL(`../dane/debug/${st}.txt`, import.meta.url), lines.join('\n').slice(0, 400000) + '\n');

// Wynik tego przebiegu (bez łączenia z poprzednimi): bazę uzupełnia funkcja „ingest”, a sklep, którego nie udało się
// odczytać, zachowuje w bazie poprzednie, wciąż ważne oferty. Podgląd w repozytorium: scripts/oferty-podglad.mjs.
{
  const out = { updated: new Date().toISOString(), runs: OUT.runs, promos: OUT.promos, offers: OUT.offers };
  await mkdir(new URL('../dane/', import.meta.url), { recursive: true });
  await writeFile(new URL('../dane/oferty-przebieg.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  log(`\nZapisano dane/oferty-przebieg.json: ${out.offers.length} ofert, ${out.runs.length} przebiegów.`);
}
if (failed === ONLY.length) process.exit(1);
