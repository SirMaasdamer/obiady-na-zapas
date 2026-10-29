// Pobiera aktualne gazetki Biedronki, Lidla i Kauflandu, odczytuje oferty przez Claude
// i zapisuje promocyjne ceny w bazie. Uruchamiane przez workflow „Ceny z gazetek”.
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { adminClient, claude, parseJson, sleep, today, env } from './lib.mjs';

const STORES = {
  b: { name: 'Biedronka', start: ['https://www.biedronka.pl/pl/gazetki'] },
  l: { name: 'Lidl', start: ['https://www.lidl.pl/c/nasze-gazetki/s10008614', 'https://www.lidl.pl/'] },
  k: { name: 'Kaufland', start: ['https://sklep.kaufland.pl/gazeta-reklamowa.html'] },
};
const ONLY = (env('STORES', false) || 'b,l,k').split(',').map(s => s.trim()).filter(s => STORES[s]);
const MAX_PAGES = +(env('MAX_PAGES', false) || 48);
const PICK_MODEL = env('PICK_MODEL', false) || 'claude-haiku-5-5';
const READ_MODEL = env('READ_MODEL', false) || 'claude-haiku-5-5';
const FORCE = env('FORCE', false) === 'true';
const log = (...a) => console.log(...a);
let tokensIn = 0, tokensOut = 0;
const track = u => { tokensIn += u?.input_tokens || 0; tokensOut += u?.output_tokens || 0; };

const { db } = await adminClient();
const { data: products } = await db.from('products').select('id,name,unit,pack,loose,pantry');
const catalog = products.filter(p => !p.pantry);
const catalogText = catalog.map(p => `${p.id} | ${p.name} | ${p.loose ? 'cena za 1 ' + p.unit : 'opakowanie ' + p.pack + ' ' + p.unit}`).join('\n');
const catalogIds = new Set(catalog.map(p => p.id));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1100, height: 1500 }, acceptDownloads: true,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
});

async function dismissCookies(page) {
  const sels = ['#onetrust-accept-btn-handler', 'button#accept', '[data-testid="uc-accept-all-button"]'];
  for (const s of sels) { const el = page.locator(s).first(); if (await el.isVisible().catch(() => false)) { await el.click().catch(() => { }); await sleep(600); return; } }
  const btn = page.getByRole('button', { name: /akceptuj|zaakceptuj|zgadzam|zezwól|accept all|allow all|akceptuję/i }).first();
  if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => { }); await sleep(600); }
}

async function links(page) {
  return page.$$eval('a[href]', as => as.map(a => ({ href: a.href, text: (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 140) }))
    .filter(l => /^https?:/.test(l.href)).filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i).slice(0, 300));
}

// Claude wybiera z listy linków aktualną gazetkę spożywczą (albo stronę z listą gazetek).
async function pickLeaflets(store, page) {
  const ls = await links(page);
  const pageText = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 4000);
  const { text, usage } = await claude({
    model: PICK_MODEL, maxTokens: 800,
    content: `Jesteś na stronie sklepu ${STORES[store].name}: ${page.url()}. Dzisiaj jest ${today()}.
Wybierz linki do AKTUALNYCH gazetek z ofertą SPOŻYWCZĄ (główna gazetka tygodnia, ważna dziś albo startująca w ciągu 3 dni). Pomiń katalogi nieżywnościowe (odzież, dom, znicze, ogród, alkohol, katalogi tematyczne). Najwyżej 2 linki.
Jeśli na tej stronie nie ma linków do konkretnych gazetek, ale jest link do strony z listą gazetek, podaj go jako "next".
Tekst strony (fragment): ${pageText}
Linki (adres | tekst):
${ls.map(l => `${l.href} | ${l.text}`).join('\n')}
Zwróć WYŁĄCZNIE JSON: {"leaflets":[{"url":"...","title":"...","valid_from":"YYYY-MM-DD lub null","valid_to":"YYYY-MM-DD lub null"}],"next":null}`,
  });
  track(usage);
  return parseJson(text);
}

async function findLeaflets(store, page) {
  for (const start of STORES[store].start) {
    let url = start;
    for (let hop = 0; hop < 3 && url; hop++) {
      log(`  otwieram ${url}`);
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { log('  nie udało się otworzyć:', e.message); break; }
      await sleep(2500); await dismissCookies(page); await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
      const pick = await pickLeaflets(store, page).catch(e => { log('  błąd wyboru:', e.message); return null; });
      if (pick?.leaflets?.length) return pick.leaflets.filter(l => /^https?:/.test(l.url)).slice(0, 2);
      url = pick?.next && pick.next !== url ? pick.next : null;
    }
  }
  return [];
}

// Zwraca {pdf: Buffer} albo {images: Buffer[]} dla jednej gazetki.
async function grabLeaflet(page, url) {
  const pdfUrls = new Set();
  const onResp = r => { const ct = r.headers()['content-type'] || ''; if (ct.includes('application/pdf') || /\.pdf(\?|$)/i.test(r.url())) pdfUrls.add(r.url()); };
  page.on('response', onResp);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000); await dismissCookies(page); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

    // 1) bezpośredni PDF (link „Pobierz” / plik .pdf)
    const hrefs = await page.$$eval('a[href]', as => as.map(a => a.href).filter(h => /\.pdf(\?|$)/i.test(h))).catch(() => []);
    hrefs.forEach(h => pdfUrls.add(h));
    if (!pdfUrls.size) {
      const dl = page.locator('a, button').filter({ hasText: /pobierz|download|\bpdf\b/i }).first();
      if (await dl.isVisible().catch(() => false)) {
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), dl.click().catch(() => { })]);
        if (download) { const p = await download.path(); if (p) { const { readFile } = await import('node:fs/promises'); const buf = await readFile(p); if (buf.slice(0, 4).toString() === '%PDF') return { pdf: buf }; } }
        await sleep(2000);
      }
    }
    for (const u of pdfUrls) {
      const r = await page.request.get(u, { timeout: 60000 }).catch(() => null);
      if (r?.ok()) { const buf = await r.body(); if (buf.slice(0, 4).toString() === '%PDF' && buf.length < 60e6) return { pdf: buf }; }
    }

    // 2) zrzuty ekranu kolejnych stron przeglądarki gazetki
    if (page.url() !== url) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { }); await sleep(3000); }
    const images = []; let lastHash = null, same = 0;
    for (let i = 0; i < MAX_PAGES; i++) {
      const shot = await page.screenshot({ type: 'jpeg', quality: 72 });
      const h = createHash('sha1').update(shot).digest('hex');
      if (h === lastHash) { if (++same >= 2) break; } else { same = 0; images.push(shot); lastHash = h; }
      const next = page.locator('[aria-label*="nast" i], [aria-label*="next" i], [title*="nast" i], [class*="next" i]:not([class*="disabled" i])').filter({ visible: true }).first();
      if (await next.count().catch(() => 0)) await next.click({ timeout: 3000 }).catch(() => page.keyboard.press('ArrowRight'));
      else await page.keyboard.press('ArrowRight');
      await sleep(1400);
    }
    return { images };
  } finally { page.off('response', onResp); }
}

async function* chunks(content) {
  if (content.pdf) {
    const src = await PDFDocument.load(content.pdf, { ignoreEncryption: true });
    const n = Math.min(src.getPageCount(), MAX_PAGES);
    for (let i = 0; i < n; i += 8) {
      const out = await PDFDocument.create();
      const idx = [...Array(Math.min(8, n - i)).keys()].map(k => i + k);
      (await out.copyPages(src, idx)).forEach(p => out.addPage(p));
      yield { first: i + 1, blocks: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(await out.save()).toString('base64') } }] };
    }
  } else {
    for (let i = 0; i < content.images.length; i += 6)
      yield { first: i + 1, blocks: content.images.slice(i, i + 6).map(b => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') } })) };
  }
}

async function readOffers(store, content, hint) {
  const all = []; let vf = hint.valid_from || null, vt = hint.valid_to || null;
  for await (const ch of chunks(content)) {
    const out = await claude({
      model: READ_MODEL, maxTokens: 8000,
      system: 'Odczytujesz polskie gazetki promocyjne i zwracasz wyłącznie poprawny JSON.',
      content: [...ch.blocks, {
        type: 'text', text: `To strony gazetki sklepu ${STORES[store].name} (od strony ${ch.first}). Dzisiaj jest ${today()}.
Wypisz WSZYSTKIE oferty spożywcze (żywność, napoje bezalkoholowe, przyprawy). Pomiń produkty niespożywcze i alkohol.
Dla każdej oferty:
- name: nazwa produktu z gazetki, z gramaturą jeśli podana
- price: cena promocyjna w zł (liczba). Jeśli cena zależy od warunku (aplikacja, karta, „2+1”, „przy zakupie 2”), podaj cenę z warunkiem, a warunek opisz w note.
- unit_info: za co jest cena, np. "za kg", "500 g", "opak."
- regular: cena przed obniżką, jeśli widoczna, inaczej null
- valid_from, valid_to: daty obowiązywania w formacie YYYY-MM-DD, jeśli podane
- page: numer strony gazetki, jeśli widoczny
- product_id: id z katalogu poniżej, jeśli to ten sam rodzaj produktu (np. dowolny filet z piersi kurczaka → kurczak_filet), inaczej null
- price_for_pack: gdy product_id nie jest null, cena przeliczona na rozmiar z katalogu (np. katalog „opakowanie 0.25 kg”, a gazetka 250 g za 5,99 → 5.99; katalog „cena za 1 kg”, a gazetka 500 g za 9,99 → 19.98)
Podaj też ogólne daty gazetki, jeśli są widoczne.
Katalog (id | nazwa | rozmiar):
${catalogText}
Zwróć WYŁĄCZNIE JSON: {"valid_from":null,"valid_to":null,"offers":[{"name":"","price":0,"unit_info":"","regular":null,"valid_from":null,"valid_to":null,"note":null,"page":null,"product_id":null,"price_for_pack":null}]}` }],
    }).catch(e => { log('   błąd odczytu:', e.message); if (/środków|nieprawidłowy/.test(e.message)) throw e; return null; });
    if (!out?.text) continue;
    const { text, usage } = out;
    track(usage);
    try {
      const j = parseJson(text); vf ||= j.valid_from; vt ||= j.valid_to;
      for (const o of j.offers || []) if (o?.name && +o.price > 0) all.push(o);
      log(`   strony od ${ch.first}: ${j.offers?.length || 0} ofert`);
    } catch (e) { log('   nie udało się odczytać odpowiedzi:', e.message); }
  }
  return { offers: all, valid_from: vf, valid_to: vt };
}

const isDate = s => /^\d{4}-\d\d-\d\d$/.test(s || '');
async function save(store, leaflet, res) {
  const vf = isDate(res.valid_from) ? res.valid_from : today();
  const vt = isDate(res.valid_to) ? res.valid_to : new Date(Date.now() + 6 * 864e5).toLocaleDateString('sv-SE');
  const rows = res.offers.map(o => ({
    store, name: String(o.name).slice(0, 200), price: +o.price, unit_info: o.unit_info || null, regular: +o.regular || null,
    valid_from: isDate(o.valid_from) ? o.valid_from : vf, valid_to: isDate(o.valid_to) ? o.valid_to : vt,
    note: o.note || null, page: Number.isInteger(+o.page) ? +o.page : null, leaflet,
    product_id: catalogIds.has(o.product_id) ? o.product_id : null,
    price_for_pack: catalogIds.has(o.product_id) && +o.price_for_pack > 0 ? +o.price_for_pack : null,
  }));
  await db.from('offers').delete().eq('store', store).eq('leaflet', leaflet);
  for (let i = 0; i < rows.length; i += 500) { const { error } = await db.from('offers').insert(rows.slice(i, i + 500)); if (error) throw error; }

  // najniższa cena dla każdego produktu z katalogu → promocja w tabeli cen
  const best = {};
  for (const r of rows) if (r.product_id && r.price_for_pack && r.valid_to >= today()) {
    const b = best[r.product_id]; if (!b || r.price_for_pack < b.price_for_pack) best[r.product_id] = r;
  }
  const up = Object.values(best).map(r => ({ product_id: r.product_id, store, promo: r.price_for_pack, promo_from: r.valid_from, promo_to: r.valid_to, promo_note: [r.name, r.note].filter(Boolean).join(' · ').slice(0, 200), promo_leaflet: leaflet, updated_at: new Date().toISOString() }));
  if (up.length) { const { error } = await db.from('prices').upsert(up, { onConflict: 'product_id,store' }); if (error) throw error; }
  await db.from('scrape_runs').insert({ store, leaflet, valid_from: vf, valid_to: vt, pages: res.pages, offers: rows.length, matched: up.length, status: 'ok' });
  return { offers: rows.length, matched: up.length };
}

let failed = 0;
for (const store of ONLY) {
  log(`\n▶ ${STORES[store].name}`);
  const page = await ctx.newPage();
  try {
    const leaflets = await findLeaflets(store, page);
    if (!leaflets.length) throw new Error('Nie znalazłem aktualnej gazetki na stronie sklepu.');
    for (const lf of leaflets) {
      log(`  gazetka: ${lf.title || ''} ${lf.url}`);
      const { data: done } = await db.from('scrape_runs').select('id').eq('store', store).eq('leaflet', lf.url).eq('status', 'ok').limit(1);
      if (done?.length && !FORCE) { log('  już odczytana wcześniej, pomijam'); continue; }
      const content = await grabLeaflet(page, lf.url);
      const pages = content.pdf ? 'PDF' : content.images.length;
      log(`  pobrano: ${content.pdf ? 'plik PDF' : pages + ' zrzutów stron'}`);
      if (!content.pdf && content.images.length < 2) throw new Error('Nie udało się przewinąć stron gazetki.');
      const res = await readOffers(store, content, lf);
      res.pages = content.pdf ? null : content.images.length;
      const s = await save(store, lf.url, res);
      log(`  zapisano ${s.offers} ofert, ${s.matched} produktów z katalogu`);
    }
  } catch (e) {
    failed++; log(`  ✗ ${e.message}`);
    await db.from('scrape_runs').insert({ store, status: 'error', message: e.message.slice(0, 500) });
    if (/środków|nieprawidłowy/.test(e.message)) break;
  } finally { await page.close(); }
}
await db.from('offers').delete().lt('valid_to', new Date(Date.now() - 2 * 864e5).toLocaleDateString('sv-SE'));
await browser.close();
log(`\nZużycie Claude: ${tokensIn} tokenów wejścia, ${tokensOut} wyjścia.`);
if (failed === ONLY.length) process.exit(1);
