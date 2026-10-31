// Paragony: odczyt tekstu (PDF / zrzut ekranu) i rozbiór na pozycje. Wszystko dzieje się w telefonie.
// Część „parse…” to czyste funkcje bez DOM (testowane w scripts/test.mjs).

export function norm(s) {
  let out = '';
  for (const c of String(s).toLowerCase()) {
    if (c === 'ł') { out += 'l'; continue; }
    const base = c.normalize('NFD')[0];
    out += base.length === 1 ? base : c;
  }
  return out;
}
const num = s => parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
const r2 = v => Math.round(v * 100) / 100;

export const STORE_NAMES = { b: 'Biedronka', l: 'Lidl', k: 'Kaufland', z: 'Żabka', d: 'Dino', a: 'Aldi', n: 'Netto', au: 'Auchan', c: 'Carrefour', s: 'Stokrotka', r: 'Rossmann', inne: 'Inny sklep' };
export function detectStore(text) {
  const t = norm(text);
  const rules = [['b', /jeronimo martins|biedronk/], ['l', /\blidl\b/], ['k', /kaufland/], ['z', /zabka|zappka/], ['d', /\bdino\b/], ['a', /\baldi\b/], ['n', /\bnetto\b/], ['au', /auchan/], ['c', /carrefour/], ['s', /stokrotk/], ['r', /rossmann/]];
  for (const [k, re] of rules) if (re.test(t)) return k;
  return 'inne';
}

export function findDate(text, todayIso) {
  const today = new Date((todayIso || new Date().toISOString().slice(0, 10)) + 'T12:00:00');
  const ok = d => d && !isNaN(d) && d <= new Date(today.getTime() + 864e5) && today - d < 3 * 365 * 864e5;
  const cands = [];
  for (const m of text.matchAll(/(20\d\d)[-./](\d{1,2})[-./](\d{1,2})/g)) cands.push(new Date(+m[1], m[2] - 1, +m[3], 12));
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[-./](\d{1,2})[-./](20\d\d|\d\d)(?!\d)/g)) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; cands.push(new Date(y, m[2] - 1, +m[1], 12)); }
  const d = cands.find(ok);
  return d ? d.toLocaleDateString('sv-SE') : null;
}

const AMOUNT = /(-?\d{1,4}[,.]\s?\d{2})\s*(?:zl|pln)?\s*[a-g]?\s*\*?\s*$/;
const QTY = /(\d{1,3}(?:[,.]\d{1,3})?)\s*(szt\.?|kg|op\.?)?\s*[x×*]\s*(\d{1,4}[,.]\d{2})(?:\s*(?:zl|pln)?(?:\s*\/\s*(?:kg|szt\.?))?)?/;
const JUNK = /paragon|niefiskaln|\bnip\b|kasa\b|kasjer|sprzedaz opodatk|\bptu\b|\bvat\b|reszta|gotowk|karta\b|karty|platnosc|zaplacono|nr sys|nr transakcji|terminal|\bwww\.|\btel\b|\bbdo\b|numer|transakcj|^\s*data\b|godz|\bul\.|sklep nr|kod pocztowy|podsumowanie|zaplac|wydano|kwota|\bsuma\b|razem|do zaplaty|lacznie|sprzedaz|e-paragon|faktur|dziekujemy|zapraszamy|oszczedzasz|zaoszczedz|punkty|\bpkt\b/;
const DISCOUNT = /rabat|upust|obnizk|promocj|kupon|znizk|taniej|lidl plus|moja biedronka|kaufland card|okazj|gratis/;
const TOTAL = /\b(suma|razem|do zaplaty|lacznie|zaplacono|kwota)\b/;

export function findTotal(lines) {
  for (const l of lines) {
    const t = norm(l);
    if (!TOTAL.test(t) || /ptu|vat|opodatk|rabat|oszczed/.test(t)) continue;
    const m = t.match(/(\d{1,5}[,.]\s?\d{2})/g);
    if (m) return num(m[m.length - 1]);
  }
  return null;
}

// Rozbiór tekstu paragonu na pozycje. Obsługuje:
//   „Mleko UHT 1L  2 x3,49  6,98C”, „Banany luz 0,756 x4,99 3,77C”,
//   nazwę w jednej linii i „1 x5,99 5,99C” w następnej, rabaty „Rabat -1,00” pod pozycją.
export function parseItems(lines) {
  const items = []; let pending = null, started = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim(); if (!line) continue;
    const t = norm(line);
    if (started && /^(suma|razem|sprzedaz opodatk|ptu|do zaplaty|podsumowanie)/.test(t)) break;
    const am = t.match(AMOUNT), q = t.match(QTY);
    const letters = (t.replace(QTY, ' ').replace(AMOUNT, ' ').match(/[a-z]{2,}/g) || []).filter(w => !/^(szt|kg|zl|pln|op|x)$/.test(w));
    // rabat pod pozycją
    if (am && DISCOUNT.test(t) && items.length) {
      const v = Math.abs(num(am[1])); const last = items[items.length - 1];
      if (v > 0 && v < last.total + 0.001 && (num(am[1]) < 0 || /-\s*\d/.test(line) || /rabat|upust|obnizk|kupon|znizk/.test(t))) { last.discount = r2(last.discount + v); last.total = r2(last.total - v); }
      pending = null; continue;
    }
    if (JUNK.test(t) && !q) { pending = null; continue; }
    // sama ilość i cena (nazwa była wyżej)
    if (q && !letters.length) {
      const qty = num(q[1]), unit = num(q[3]), total = am && am.index > q.index ? num(am[1]) : r2(qty * unit);
      if (pending) { items.push(mk(pending, qty, unit, total, q[2])); pending = null; started = true; }
      else if (items.length && !items[items.length - 1].qtyKnown) Object.assign(items[items.length - 1], fix(items[items.length - 1], qty, unit, q[2]));
      continue;
    }
    if (am && letters.length) {
      const value = num(am[1]); if (value <= 0) { pending = null; continue; }
      let name = line.slice(0, q ? q.index : am.index).replace(/\s+[A-G]\s*$/, '').trim() || pending || line;
      if (pending && name.length < 3) name = pending;
      const it = q ? mk(name, num(q[1]), num(q[3]), value, q[2]) : mk(name, 1, value, value, null, false);
      items.push(it); pending = null; started = true; continue;
    }
    if (letters.length && !am && !JUNK.test(t)) pending = line.replace(/\s+[A-G]\s*$/, '').trim();
  }
  return items.map(({ qtyKnown, ...i }) => i);
}
function mk(name, qty, unit, total, unitWord, qtyKnown = true) {
  const weighed = /kg/.test(unitWord || '') || (qty % 1 !== 0 && qty < 30);
  return { name: name.replace(/\s{2,}/g, ' ').replace(/[\s|*#_=~:;,.\-]+$/, '').trim(), qty, weighed, unit_price: unit, total: r2(total), discount: 0, qtyKnown };
}
function fix(it, qty, unit, unitWord) {
  const weighed = /kg/.test(unitWord || '') || (qty % 1 !== 0 && qty < 30);
  return { qty, unit_price: unit, weighed, qtyKnown: true };
}

export function parseReceipt(text, todayIso) {
  const lines = text.split(/\r?\n/);
  const store = detectStore(text);
  const items = parseItems(lines);
  const sum = r2(items.reduce((s, i) => s + i.total, 0));
  return { store, store_name: STORE_NAMES[store], bought_on: findDate(text, todayIso) || todayIso, total: findTotal(lines) ?? sum, items, sum };
}

// Usuwa powtórzone linie na styku kolejnych zrzutów ekranu (gdy się nakładają).
export function joinShots(texts) {
  let out = [];
  for (const t of texts) {
    const ls = t.split(/\r?\n/).filter(l => l.trim());
    let k = Math.min(out.length, ls.length, 12);
    for (; k > 0; k--) if (out.slice(-k).join('\n') === ls.slice(0, k).join('\n')) break;
    out = out.concat(ls.slice(k));
  }
  return out.join('\n');
}

/* ---------- dopasowanie do katalogu i kategorie ---------- */
const CAT_OF_PRODUCT = { 'mięso': 'Mięso i ryby', 'nabiał': 'Nabiał', 'warzywa': 'Warzywa i owoce', 'puszki i sosy': 'Spiżarnia', 'suche': 'Spiżarnia', 'spiżarnia': 'Spiżarnia' };
const CATS = [
  ['Alkohol', /\bpiwo|\bwino\b|wodka|whisk|cydr|likier|\bgin\b|\brum\b|prosecco/],
  ['Chemia i higiena', /papier toal|recznik pap|plyn do|proszek|kapsulk|szampon|mydl|pasta do zeb|zel pod|dezodor|worki|gabk|chusteczk|pieluch|odswiez|domestos|tabletki do zmyw/],
  ['Pieczywo', /chleb|bulk|bagiet|rogal|tortill|pieczyw|kajzer|grahamk/],
  ['Mięso i ryby', /kurcz|filet|schab|karkow|wolow|wieprz|mielon|kielbas|szynk|boczek|parow|indyk|losos|dorsz|tunczyk|\bryba|pasztet|salami|polendwic|udko|podudz|skrzyd|watrob|zeberk|lopatk/],
  ['Nabiał', /mleko|\bser\b|sery|jogurt|kefir|masl|smietan|twarog|\bjaja|jajka|serek|mozzarel|mascarpone|maslank|skyr|feta|gouda/],
  ['Warzywa i owoce', /pomidor|ogor|ziemniak|cebul|marchew|papryk|jabl|banan|cytryn|pomarancz|salat|kapust|brokul|pieczark|winogr|gruszk|mandaryn|awokado|czosnek|warzyw|owoc|cukini|dyni|szpinak|koperek|pietruszk|seler|\bpor\b|kalafior|buraki|kiwi|truskaw|borowk|malin/],
  ['Napoje', /\bwoda\b|\bsok\b|napoj|cola|\bkawa\b|herbat|nektar|lemoniad|energy|izoton/],
  ['Słodycze i przekąski', /czekol|baton|ciast|chips|cukierk|\blody\b|wafel|herbatnik|zelki|chrupk|orzeszk|paluszk|draze|krakers|praliny|delicje|bake rolls/],
  ['Spiżarnia', /makaron|\bryz\b|kasza|\bmaka\b|cukier|\bolej\b|oliwa|przypraw|\bsos\b|ketchup|majonez|musztard|koncentrat|passata|fasol|ciecierzyc|platki|dzem|\bmiod|soczewic|groch|kukurydz|bulion|puszk/],
];
export function categoryOf(name, product) {
  if (product?.cat && CAT_OF_PRODUCT[product.cat]) return CAT_OF_PRODUCT[product.cat];
  const t = norm(name);
  for (const [c, re] of CATS) if (re.test(t)) return c;
  return 'Inne';
}

export function matchProduct(name, products) {
  const t = ' ' + norm(name).replace(/[^a-z0-9%,. ]/g, ' ') + ' ';
  let best = null, bestLen = 0;
  for (const p of products) for (const kw of p.kw || []) {
    const k = kw.trim(); if (k.length < 3) continue;
    const i = t.indexOf(' ' + k);
    if (i >= 0 && k.length > bestLen) { best = p; bestLen = k.length; }
  }
  return best;
}

// Cena za opakowanie z katalogu (jak w tabeli cen) z pozycji paragonu; null, gdy nie da się wiarygodnie policzyć.
export function packPrice(item, p, ref) {
  if (!p || !(item.unit_price > 0)) return null;
  const unit = item.discount > 0 && item.qty > 0 ? item.total / item.qty : item.unit_price;
  const m = norm(item.name).match(/(\d+(?:[,.]\d+)?)\s?(kg|g|ml|l)\b/);
  let size = null;
  if (m) { const n = num(m[1]); size = m[2] === 'g' || m[2] === 'ml' ? n / 1000 : n; }
  let v;
  if (p.unit === 'szt' || p.unit === 'pęczek') v = unit;
  else if (p.loose) v = item.weighed ? unit : size ? unit / size : null;
  else v = size ? unit * (p.pack || 1) / size : unit;
  if (v == null || !isFinite(v)) return null;
  v = r2(v);
  if (ref && (v < ref * 0.3 || v > ref * 2.5)) return null;
  return v;
}

/* ---------- odczyt plików (w przeglądarce) ---------- */
const loaded = {};
function script(src) { return loaded[src] ??= new Promise((ok, err) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => err(new Error('Nie udało się wczytać ' + src)); document.head.append(s); }); }

export async function pdfText(file) {
  await script('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, 10); n++) {
    const page = await doc.getPage(n), tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) { if (!it.str.trim()) continue; const y = Math.round(it.transform[5] / 3); (rows.get(y) ?? rows.set(y, []).get(y)).push({ x: it.transform[4], s: it.str, w: it.width }); }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const cells = rows.get(y).sort((a, b) => a.x - b.x); let line = '', end = null;
      for (const c of cells) { line += end != null && c.x - end > 4 ? '  ' + c.s : (line && end != null && c.x - end > 0.5 ? ' ' : '') + c.s; end = c.x + c.w; }
      out.push(line);
    }
  }
  return out.join('\n');
}

let worker = null;
export async function imageText(file, onProgress) {
  await script('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  if (!worker) worker = await window.Tesseract.createWorker('pol', 1, { logger: m => m.status === 'recognizing text' && onProgress?.(m.progress) });
  await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' }); // jedna kolumna: nazwa i cena w tej samej linii
  const { data } = await worker.recognize(await upscale(file));
  return data.text;
}
// Zrzuty ekranu z telefonu są ostre, ale drobne: powiększamy i zamieniamy na szarość, co poprawia OCR.
async function upscale(file) {
  const img = await createImageBitmap(file);
  const scale = img.width < 1400 ? 2 : 1, c = document.createElement('canvas');
  c.width = img.width * scale; c.height = img.height * scale;
  const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.4)'; g.drawImage(img, 0, 0, c.width, c.height);
  return new Promise(ok => c.toBlob(ok, 'image/png'));
}
