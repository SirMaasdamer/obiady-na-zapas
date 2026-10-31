// Czysta logika: ceny, ilości, koszt przepisu, plan zakupów. Bez DOM, testowalna w Node.
export const STORES = [{ k: 'b', n: 'Biedronka' }, { k: 'l', n: 'Lidl' }, { k: 'k', n: 'Kaufland' }];
export const SK = STORES.map(s => s.k);
export const SN = Object.fromEntries(STORES.map(s => [s.k, s.n]));

export const S = { products: {}, prices: {}, recipes: {}, hh: {}, hhp: {}, receipts: [], receipt_items: [], settings: {}, reactions: [], list_items: [], freezer: [], offers: [], scrape_runs: [], loaded: {} };

export function setTable(t, data) {
  data = data || [];
  if (t === 'products' || t === 'recipes') S[t] = Object.fromEntries(data.map(r => [r.id, r]));
  else if (t === 'prices') { const o = {}; for (const r of data) (o[r.product_id] ??= {})[r.store] = r; S.prices = o; }
  else if (t === 'hh_recipes') S.hh = Object.fromEntries(data.map(r => [r.recipe_id, r]));        // przepisy odblokowane/usunięte w tym domu
  else if (t === 'hh_settings') S.settings = data[0] || {};
  else if (t === 'hh_prices') { const o = {}; for (const r of data) (o[r.product_id] ??= {})[r.store] = r; S.hhp = o; } // ceny wpisane przez dom
  else S[t] = data;
  S.loaded[t] = true;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const zs = v => v == null || !isFinite(v) ? '—' : v.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const zl = v => v == null || !isFinite(v) ? '—' : zs(v) + ' zł';
export const num = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('pl-PL', { maximumFractionDigits: d });
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
export const daysAgo = n => new Date(Date.now() - n * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
export const dPL = s => { if (!s) return ''; const [, m, d] = String(s).split('-'); return d + '.' + m; };
export const daysSince = s => Math.max(0, Math.floor((new Date(today()) - new Date(s)) / 864e5));
export const parsePL = v => { const n = parseFloat(String(v).replace(',', '.').replace(/[^\d.]/g, '')); return isFinite(n) ? n : null; };

/* ceny: promocja z gazetki, jeśli trwa; inaczej cena regularna */
export function priceOf(pid, s) {
  const r = S.prices[pid]?.[s], own = S.hhp[pid]?.[s]; const t = today();
  const regular = own ? +own.regular : r?.regular != null ? +r.regular : null;
  if (r?.promo != null && (!r.promo_from || r.promo_from <= t) && (!r.promo_to || r.promo_to >= t) && !(regular != null && own && +r.promo > regular))
    return { p: +r.promo, promo: true, until: r.promo_to, note: r.promo_note, regular };
  if (regular != null) return { p: regular, promo: false, own: !!own, src: own?.src || null, seen: own?.seen_on || null };
  return null;
}

/* ilości */
export function factor(u, p) {
  if (u === p.unit) return 1;
  if ((u === 'g' && p.unit === 'kg') || (u === 'ml' && p.unit === 'l') || (u === 'g' && p.unit === 'l') || (u === 'ml' && p.unit === 'kg')) return .001;
  return p.conv?.[u] ?? null;
}
export const needOf = (ing, m, p) => { const f = factor(ing.unit, p); return f == null ? null : ing.amt * m * f; };
export const packsFor = (p, q) => Math.max(1, Math.ceil(q / (p.pack || 1) - 1e-6));
export const costProp = (p, s, q) => { const pr = priceOf(p.id, s); return pr ? q * pr.p / (p.pack || 1) : null; };
export const costBuy = (p, s, q) => { const pr = priceOf(p.id, s); if (!pr) return null; return p.loose ? q * pr.p / (p.pack || 1) : packsFor(p, q) * pr.p; };
export function fmtAmt(a, u) {
  if (u === 'g' || u === 'ml') { const big = u === 'g' ? 'kg' : 'l'; if (a >= 1000) return num(a / 1000, 2) + ' ' + big; return (a < 20 ? num(a, 0) : Math.round(a / 5) * 5) + ' ' + u; }
  if (u === 'kg' || u === 'l') return num(a, 2) + ' ' + u;
  return num(Math.ceil(a * 2 - 1e-6) / 2, 1) + ' ' + u;
}
export function fmtQ(p, q) { if (p.unit === 'kg') return q < 1 ? fmtAmt(q * 1000, 'g') : num(q, 2) + ' kg'; if (p.unit === 'l') return q < 1 ? fmtAmt(q * 1000, 'ml') : num(q, 2) + ' l'; return fmtAmt(q, p.unit); }
export const fmtPack = p => fmtQ(p, p.pack || 1);
export const buyText = (p, q) => p.loose ? 'ok. ' + fmtQ(p, q) : (packsFor(p, q) > 1 ? packsFor(p, q) + ' × ' : '') + fmtPack(p);

/* koszt przepisu dla n porcji w każdym sklepie i w wariancie „mix” */
export function recipeCost(r, n) {
  const m = n / (r.base || 2), res = { tot: { b: 0, l: 0, k: 0 }, miss: { b: 0, l: 0, k: 0 }, mix: 0, mixMiss: 0, promos: [] };
  for (const ing of r.ingredients || []) {
    const p = S.products[ing.pid]; if (!p || p.pantry) continue; const q = needOf(ing, m, p); if (q == null) continue;
    let best = null;
    for (const s of SK) {
      const c = costProp(p, s, q); if (c == null) { res.miss[s]++; continue; }
      res.tot[s] += c; if (best == null || c < best) best = c; if (priceOf(p.id, s).promo) res.promos.push({ pid: p.id, s });
    }
    if (best == null) res.mixMiss++; else res.mix += best;
  }
  return res;
}

/* lista zakupów zgrupowana po produkcie */
export function aggList() {
  const rows = {}, pantry = {}, manual = [];
  for (const it of S.list_items) {
    const p = S.products[it.product_id];
    if (it.manual || !p) { manual.push(it); continue; }
    const b = p.pantry ? pantry : rows, g = b[p.id] ??= { pid: p.id, p, q: 0, docs: [], srcs: new Set() };
    g.q += +it.qty || 0; g.docs.push(it); if (it.recipe_name) g.srcs.add(it.recipe_name);
  }
  const fin = o => Object.values(o).map(g => ({ ...g, done: g.docs.every(d => d.done) }));
  return { rows: fin(rows), pantry: fin(pantry), manual };
}

/* warianty zakupów: 1, 2 lub 3 sklepy; każdy produkt w najtańszym z wybranych */
export function plans(rows) {
  const todo = rows.filter(g => !g.done), subs = [['b'], ['l'], ['k'], ['b', 'l'], ['b', 'k'], ['l', 'k'], ['b', 'l', 'k']];
  return subs.map(st => {
    let total = 0, missing = 0; const assign = {};
    for (const g of rows) {
      let best = null, bs = null;
      for (const s of st) { const c = costBuy(g.p, s, g.q); if (c != null && (best == null || c < best)) { best = c; bs = s; } }
      assign[g.pid] = bs ? { s: bs, c: best } : null;
      if (!g.done) { if (bs) total += best; else missing++; }
    }
    return { key: st.join(''), st, total, missing, assign, todo: todo.length };
  });
}
export function pickPlan(ps, trip, chosenKey) {
  const score = p => p.missing * 1000 + p.total + (p.st.length - 1) * trip;
  const rec = [...ps].sort((a, b) => score(a) - score(b))[0];
  return { rec, chosen: ps.find(p => p.key === chosenKey) || rec };
}
