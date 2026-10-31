// Darmowy odczyt ofert z tekstu gazetki (z PDF albo z OCR): bez AI, na słowach kluczowych.
// Czyste funkcje, testowane w scripts/test.mjs.

// Usuwa polskie znaki, zachowując długość tekstu (pozycje pasują do oryginału).
export function norm(s) {
  let out = '';
  for (const c of s.toLowerCase()) {
    if (c === 'ł') { out += 'l'; continue; }
    const base = c.normalize('NFD')[0];
    out += base.length === 1 ? base : c;
  }
  return out;
}

const DATE_RE = /(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s*(?:r\.)?\s*(?:-|–|—|do)\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/g;

// Najbardziej prawdopodobny okres ważności gazetki (blisko dzisiejszej daty).
export function findValidity(text, todayIso) {
  const today = new Date(todayIso + 'T12:00:00'), y = today.getFullYear();
  const mk = (d, m, yy) => { let yr = yy ? (yy.length === 2 ? 2000 + +yy : +yy) : y; const dt = new Date(yr, m - 1, d, 12); if (!yy && dt - today > 200 * 864e5) dt.setFullYear(yr - 1); if (!yy && today - dt > 200 * 864e5) dt.setFullYear(yr + 1); return dt; };
  const iso = d => d.toLocaleDateString('sv-SE');
  const counts = new Map();
  for (const m of text.matchAll(DATE_RE)) {
    const [, d1, m1, y1, d2, m2, y2] = m;
    if (+m1 > 12 || +m2 > 12 || +d1 > 31 || +d2 > 31) continue;
    const a = mk(+d1, +m1, y1), b = mk(+d2, +m2, y2 || y1);
    if (b < a || b - a > 40 * 864e5) continue;
    if (Math.abs(a - today) > 10 * 864e5 && Math.abs(b - today) > 10 * 864e5) continue;
    const k = iso(a) + '|' + iso(b); counts.set(k, (counts.get(k) || 0) + 1);
  }
  const best = [...counts.entries()].sort((x, z) => z[1] - x[1])[0];
  return best ? { valid_from: best[0].split('|')[0], valid_to: best[0].split('|')[1] } : null;
}

const SIZE_RE = /(\d+(?:[,.]\d+)?)\s?(kg|g|ml|l)\b/g;
const PER_KG_RE = /(?:\/|za|cena za|zl\s*\/)\s*1?\s*kg\b|\/\s*kg|zl\s*\/\s*kg/;

function priceCandidates(win) {
  // usuwamy daty i rozmiary, żeby nie udawały cen
  const clean = win.replace(DATE_RE, m => ' '.repeat(m.length)).replace(/\d{1,2}\.\d{1,2}\.\d{2,4}/g, m => ' '.repeat(m.length))
    .replace(SIZE_RE, m => ' '.repeat(m.length)).replace(/\d+\s?%/g, m => ' '.repeat(m.length));
  const out = [];
  const add = (m, v) => { const after = win.slice(m.index + m[0].length, m.index + m[0].length + 14); out.push({ v, at: m.index, perKg: /^\s*(zl)?\s*(\/|za)\s*(1\s*)?kg/.test(after) }); };
  for (const m of clean.matchAll(/(?<![\d.,])(\d{1,3})\s?[,.]\s?(\d{2})(?![\d])/g)) add(m, +(m[1] + '.' + m[2]));
  // OCR często czyta „4⁹⁹” jako „4 99 zł”
  for (const m of clean.matchAll(/(?<![\d.,])(\d{1,3})\s(\d{2})(?=\s?(?:zl|pln))/g)) add(m, +(m[1] + '.' + m[2]));
  return out.filter(c => c.v >= 0.5 && c.v < 500);
}

function sizeInUnit(win, unit) {
  for (const m of win.matchAll(SIZE_RE)) {
    const n = parseFloat(m[1].replace(',', '.')), u = m[2];
    if (unit === 'kg' && (u === 'g' || u === 'kg')) return u === 'g' ? n / 1000 : n;
    if (unit === 'l' && (u === 'ml' || u === 'l' || u === 'g')) return u === 'l' ? n : n / 1000;
  }
  return null;
}

/**
 * Szuka produktów z katalogu w tekście stron gazetki.
 * pages: [{page, text}], products: [{id,name,unit,pack,loose,kw:[...], ref}]  (ref = typowa cena za opakowanie)
 * Blok oferty = od słowa kluczowego do następnego produktu (lub najwyżej 3 kolejnych linii).
 * Zwraca jedną ofertę na produkt (najtańszą wiarygodną).
 */
export function matchOffers(pages, products) {
  const res = {};
  const allKw = products.flatMap(p => (p.kw || []).map(k => ({ k, id: p.id })));
  for (const pg of pages) {
    const orig = pg.text, t = norm(orig);
    // pozycje wszystkich słów kluczowych na stronie (granice bloków)
    const hits = [];
    for (const { k, id } of allKw) { let i = -1; while ((i = t.indexOf(k, i + 1)) !== -1) if (!/[a-z]/.test(t[i - 1] || '')) hits.push({ i, id }); }
    hits.sort((a, b) => a.i - b.i);
    for (const p of products) {
      if (!p.kw?.length || !p.ref) continue;
      for (const kw of [...p.kw].sort((a, b) => b.length - a.length)) {
        let idx = -1;
        while ((idx = t.indexOf(kw, idx + 1)) !== -1) {
          if (/[a-z]/.test(t[idx - 1] || '')) continue; // środek innego słowa
          let end = idx + kw.length;
          for (let n = 0; n < 4 && end < t.length; n++) { const nl = t.indexOf('\n', end + 1); end = nl === -1 ? t.length : nl; }
          const nextOther = hits.find(h => h.i > idx + kw.length && h.id !== p.id);
          if (nextOther && nextOther.i < end) end = nextOther.i;
          const block = t.slice(idx, Math.min(end, idx + 260));
          const blockPerKg = PER_KG_RE.test(block);
          const size = sizeInUnit(block, p.unit);
          const lo = p.ref * 0.4, hi = p.ref * 1.25;
          const cands = priceCandidates(block).map(c => {
            const perKg = c.perKg || (blockPerKg && p.loose);
            let forPack;
            if (p.unit === 'szt' || p.unit === 'pęczek') forPack = c.v;
            else if (p.loose) forPack = perKg ? c.v : size ? c.v / size : c.v;
            else forPack = perKg ? c.v * p.pack : size ? c.v * p.pack / size : c.v;
            return { ...c, perKg, forPack: Math.round(forPack * 100) / 100 };
          }).filter(c => c.forPack >= lo && c.forPack <= hi);
          if (!cands.length) continue;
          const best = cands.reduce((a, b) => (b.forPack < a.forPack ? b : a));
          const reg = cands.filter(c => c.forPack > best.forPack * 1.05).sort((a, b) => b.forPack - a.forPack)[0];
          const lineEnd = orig.indexOf('\n', idx + kw.length);
          const line = orig.slice(idx, lineEnd === -1 ? orig.length : lineEnd).replace(/\s{2,}.*$/, '').replace(/\s+/g, ' ').trim().slice(0, 90);
          const cur = res[p.id];
          if (!cur || best.forPack < cur.price_for_pack) {
            res[p.id] = {
              product_id: p.id, name: line || p.name, price: best.v, price_for_pack: best.forPack,
              regular: reg ? reg.v : null,
              unit_info: best.perKg ? 'za kg' : size ? (size >= 1 ? size + (p.unit === 'kg' ? ' kg' : ' l') : Math.round(size * 1000) + (p.unit === 'kg' ? ' g' : ' ml')) : null,
              page: pg.page,
            };
          }
        }
      }
    }
  }
  return Object.values(res);
}

// Ocena linków na stronie sklepu: który prowadzi do gazetki spożywczej.
export function scoreLink(l) {
  const s = norm(l.text + ' ' + l.href);
  let sc = 0;
  if (/leaflet|gazetk|ulotk|\.pdf/.test(s)) sc += 5;
  if (/oferta|promocj|okazj/.test(s)) sc += 1;
  if (/tygodni|spozyw|od poniedzialku|od czwartku|aktualn|_kdz_|food/.test(s)) sc += 4;
  if (/\d{1,2}\.\d{1,2}/.test(l.text)) sc += 2;
  if (/odziez|znicz|ogrod|barek|alkohol|zabawk|non.?food|przemysl|ryby|moda|elektro|swiat|kosmety|chemi|dla domu|tekstyl|sport|rower|przepis/.test(s)) sc -= 9;
  if (/facebook|instagram|youtube|tiktok|apple\.com|google\.com|play\.google/.test(s)) sc -= 20;
  return sc;
}

// Ocena linków do stron z ofertami (kafelki produktów z cenami jako tekst – najdokładniejsze, darmowe źródło).
export function scoreOfferLink(l) {
  const s = norm(l.text + ' ' + l.href);
  let sc = 0;
  if (/oferta|oferty|promocj|okazj|super ceny|hity/.test(s)) sc += 5;
  if (/tydzie|tygodni|od poniedzialku|od czwartku|od srody|aktualn|spozyw|swieze|mieso|nabial|warzyw|food/.test(s)) sc += 3;
  if (/gazetk|leaflet|\.pdf/.test(s)) sc -= 3;
  if (/odziez|znicz|ogrod|barek|alkohol|zabawk|non.?food|przemysl|moda|elektro|kosmety|chemi|dla domu|tekstyl|sport|rower|przepis|kariera|praca|regulamin|kontakt|sklepy|polityk|cookies|aplikacj|karta|lojal/.test(s)) sc -= 9;
  if (/facebook|instagram|youtube|tiktok|apple\.com|google\.com|play\.google|linkedin/.test(s)) sc -= 20;
  return sc;
}

// ---------- agregator gazetki.pl: oferty jako dane strukturalne (kafelki + tabela historii) ----------
// Słowa wskazujące na przetworzony lub inny produkt (wędlina zamiast mięsa, danie gotowe, karma…).
// Pomijane, jeśli samo słowo kluczowe produktu je zawiera (np. „boczek wędzony”).
const OTHER = /wedzon|pieczon|gotowan|grillowan|panierowan|marynowan|dla (psow|psa|kota|kotow)|karma|danie|dania|pasztet|kabanos|parowk|chips|baton|zupa|sos |salatk|surowk|pierog|krokiet|nalesnik|kanapk|sloiczek|hipp|bobovit|gerber|kuskus|z nadzieniem|nadziewan|lody|deser|ciast|krem |napoj|sok |nektar|syrop|przekask|snack|mrozon|w sosie|plastr|w plastrach|krojon(?:y|a) w plastry|nasze smaki|high protein|z boczkiem|maslan/;
const PL_MONTHS = { stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6, lipca: 7, sierpnia: 8, wrzesnia: 9, pazdziernika: 10, listopada: 11, grudnia: 12 };
const isoAdd = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
export function plDate(s) { const m = norm(s || '').match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/); if (!m || !PL_MONTHS[m[2]]) return null; return `${m[3]}-${String(PL_MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
const zlv = s => [...norm(String(s || '')).matchAll(/(\d{1,4}),(\d{2})\s*zl/g)].map(m => +(m[1] + '.' + m[2]));

// Czy nazwa oferty to ten produkt: słowo kluczowe jako osobne słowo(a), bez oznak innego produktu.
export function aggNameFits(name, p) {
  const n = norm(name);
  const kw = (p.kw || []).find(k => { const i = n.indexOf(k); return i !== -1 && !/[a-z]/.test(n[i - 1] || '') && !/[a-z]/.test(n[i + k.length] || ''); });
  if (!kw) return false;
  const bad = n.match(OTHER);
  return !bad || (p.kw || []).some(k => k.includes(bad[0].trim()));
}

// Cena za opakowanie z katalogu na podstawie ceny oferty i rozmiaru w nazwie; null gdy niewiarygodna.
export function aggPackPrice(price, name, p) {
  const lo = p.ref * 0.4, hi = p.ref * 1.25, n = norm(name);
  const size = sizeInUnit(n, p.unit), opts = [];
  if (p.unit === 'szt' || p.unit === 'pęczek') opts.push(price);
  else if (p.loose) { if (size) opts.push(price / size); opts.push(price); }      // „3 kg 14,99 zł” bywa ceną za kg
  else opts.push(size ? price * p.pack / size : price);
  const ok = opts.map(v => Math.round(v * 100) / 100).find(v => v >= lo && v <= hi);
  return ok ?? null;
}

/**
 * items: [{kw, cards:[{href,text}], rows:[[...komórki]]}] zebrane ze stron gazetki.pl/oferty/<kw>/<sklep>
 * Zwraca najtańszą wiarygodną, aktualną ofertę na produkt.
 */
export function aggOffers(items, products, slug, storeName, todayIso) {
  const res = {}, sn = norm(storeName);
  const consider = (p, o) => { const cur = res[p.id]; if (!cur || o.price_for_pack < cur.price_for_pack) res[p.id] = o; };
  for (const it of items) {
    const prods = products.filter(p => p.ref && (p.kw || []).includes(it.kw));
    const cands = [];
    for (const c of it.cards || []) {
      if (!new RegExp(`/sklepy/${slug}/oferty/`).test(c.href || '')) continue;      // kafelek innego sklepu
      const lines = String(c.text || '').split('\n').map(s => s.trim()).filter(Boolean);
      const prices = zlv(c.text); if (!prices.length || !lines.length) continue;
      const t = norm(c.text); let from = null, to = null;
      const d = t.match(/(\d+)\s*dni/); if (d) to = isoAdd(todayIso, +d[1]);
      if (/dzisiaj|ostatni dzien/.test(t)) to = todayIso;
      const od = t.match(/od [a-z]+\.?,?\s*(\d{1,2})\.(\d{1,2})/); if (od) from = `${todayIso.slice(0, 4)}-${od[2].padStart(2, '0')}-${od[1].padStart(2, '0')}`;
      cands.push({ name: lines[0], price: prices[prices.length - 1], regular: prices.length > 1 ? prices[0] : null, from, to });
    }
    for (const r of it.rows || []) {
      const cells = r.map(x => String(x || '').trim()); if (cells.length < 7) continue;
      const si = cells.findIndex(x => norm(x) === sn); if (si < 1) continue;            // wiersz innego sklepu
      const name = cells[si - 1], reg = zlv(cells[si + 1])[0] ?? null, promo = zlv(cells[si + 2])[0] ?? reg;
      const dates = cells.slice(si + 3).map(plDate).filter(Boolean);
      if (!promo || dates.length < 2) continue;
      const [from, to] = dates.slice(-2);
      if (to < todayIso || from > isoAdd(todayIso, 3)) continue;                       // nieaktualna
      cands.push({ name, price: promo, regular: reg && reg > promo ? reg : null, from, to });
    }
    for (const c of cands) for (const p of prods) {
      if (!aggNameFits(c.name, p)) continue;
      const forPack = aggPackPrice(c.price, c.name, p); if (forPack == null) continue;
      consider(p, { product_id: p.id, name: c.name.slice(0, 90), price: c.price, price_for_pack: forPack, regular: c.regular, unit_info: null, page: 'gazetki.pl', valid_from: c.from || undefined, valid_to: c.to || undefined });
    }
  }
  return Object.values(res).map(o => { for (const k of ['valid_from', 'valid_to']) if (!o[k]) delete o[k]; return o; });
}
