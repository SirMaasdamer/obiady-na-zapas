import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import * as L from './logic.js';

const CFG = window.APP_CONFIG || {};
const STORES = L.STORES, SK = L.SK, SN = L.SN;
export const CATEGORIES = [
  ['drob', 'Drób'], ['mielone', 'Mielone'], ['wieprzowina', 'Wieprzowina'], ['wolowina', 'Wołowina'],
  ['zupy', 'Zupy'], ['wege', 'Bez mięsa'], ['makaron', 'Sosy do makaronu'],
];
const CATN = Object.fromEntries(CATEGORIES);
const PCATS = ['mięso', 'nabiał', 'warzywa', 'puszki i sosy', 'suche', 'spiżarnia'];

const S = L.S; // wspólny stan (produkty, ceny, przepisy…)
// przepis widoczny w tym domu: według wyboru domu, a bez wyboru według ustawienia domyślnego
const visible = r => { const h = S.hh[r.id]; return h ? h.active && !h.removed : r.default_active !== false; };
const activeRecipes = () => Object.values(S.recipes).filter(visible);
const bankFor = cat => Object.values(S.recipes).filter(r => !visible(r) && !S.hh[r.id]?.removed && r.category === cat);
const ui = {
  tab: 'przepisy', cat: lsGet('cat', 'all'), filter: 'all', q: '', pq: '', pmode: 'offers',
  portions: lsGet('portions', 8), trip: lsGet('trip', 8), plan: null, sheet: null,
  member: lsGet('member', ''), justAdded: new Set(),
};
let db = null, house = null, chan = null;
const HH_TABLES = ['hh_recipes', 'reactions', 'list_items', 'freezer', 'hh_prices'];

function lsGet(k, d) { try { const v = localStorage.getItem('onz_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem('onz_' + k, JSON.stringify(v)); } catch { } }
const $ = s => document.querySelector(s);
const { esc, zl, zs, num, dPL, today, daysSince, fmtAmt, buyText, fmtPack } = L;
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.2-9.4C1.7 7.8 3.9 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.7 1.1-1.6 2.7-2.7 4.7-2.7 3.4 0 5.6 3.3 4.5 6.6-1.7 4.8-9.2 9.4-9.2 9.4z" fill="currentColor"/></svg>';
const HEART_O = HEART.replace('fill="currentColor"', 'fill="none" stroke="currentColor" stroke-width="1.8"');

/* ---------- people ---------- */
const COLORS = ['#1E6B59', '#C84B3B', '#2C5FB8', '#7A3E8F', '#A8670B', '#2E7D8F'];
const colorOf = n => COLORS[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const faces = names => names.length ? '<span class="faces">' + names.slice(0, 5).map(n => `<span class="face" style="background:${colorOf(n)}" title="${esc(n)}">${esc(n[0]?.toUpperCase() || '?')}</span>`).join('') + '</span>' : '';

/* ---------- writes ---------- */
async function w(fn, ok) {
  try { const r = await fn(); const errs = [r].flat().map(x => x?.error).filter(Boolean); if (errs.length) throw errs[0]; if (ok) toast(ok); ping(); return true; }
  catch (e) { console.error(e); toast(navigator.onLine ? 'Nie udało się zapisać. Spróbuj ponownie.' : 'Brak internetu. Spróbuj, gdy wróci połączenie.'); return false; }
}
let tt; function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2800); }

/* ---------- data loading ---------- */
const TABLES = {
  products: q => q.select('*'),
  prices: q => q.select('*'),
  recipes: q => q.select('*').order('name'),
  hh_recipes: q => q.select('*'),
  hh_prices: q => q.select('*'),
  reactions: q => q.select('*'),
  list_items: q => q.select('*').order('created_at'),
  freezer: q => q.select('*'),
  offers: q => q.select('*').gte('valid_to', L.daysAgo(0)).order('store').limit(1500),
  scrape_runs: q => q.select('*').order('ran_at', { ascending: false }).limit(30),
};
async function load(t) {
  const { data, error } = await TABLES[t](db.from(t));
  if (error) { console.error(t, error); return; }
  L.setTable(t, data);
  try { localStorage.setItem('onz_cache_' + t, JSON.stringify(data)); } catch { }
}
const pending = new Set(); let pt;
function reload(t) { pending.add(t); clearTimeout(pt); pt = setTimeout(async () => { const ts = [...pending]; pending.clear(); await Promise.all(ts.map(load)); renderAll(); }, 250); }
async function loadAll() { await Promise.all(Object.keys(TABLES).map(load)); renderAll(); }
function loadCache() { for (const t of Object.keys(TABLES)) { try { const v = localStorage.getItem('onz_cache_' + t); if (v) L.setTable(t, JSON.parse(v)); } catch { } } }
// Zmiany domowników: po każdym zapisie wysyłamy sygnał na kanał domu, a pozostałe telefony odświeżają dane.
async function subscribe() {
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(house.key)))).slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  chan = db.channel('dom-' + id, { config: { broadcast: { self: false } } });
  chan.on('broadcast', { event: 'zmiana' }, () => HH_TABLES.forEach(reload)).subscribe();
  setInterval(() => { if (!document.hidden) HH_TABLES.forEach(reload); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAll(); });
  window.addEventListener('online', () => { $('#offline').hidden = true; loadAll(); });
  window.addEventListener('offline', () => $('#offline').hidden = false);
}

/* ---------- RECIPES ---------- */
function reactFor(rid) { const rs = S.reactions.filter(x => x.recipe_id === rid); return { like: rs.filter(x => x.liked).map(x => x.member), want: rs.filter(x => x.wanted).map(x => x.member) }; }
async function toggleReact(rid, field) {
  const cur = S.reactions.find(x => x.recipe_id === rid && x.member === ui.member) || { liked: false, wanted: false };
  const row = { recipe_id: rid, member: ui.member, liked: !!cur.liked, wanted: !!cur.wanted }; row[field] = !row[field];
  const i = S.reactions.findIndex(x => x.recipe_id === rid && x.member === ui.member);
  if (i >= 0) S.reactions[i] = row; else S.reactions.push(row); renderAll();
  await w(() => db.from('reactions').upsert(row));
}
function renderCats() {
  const counts = {}; activeRecipes().forEach(r => counts[r.category] = (counts[r.category] || 0) + 1);
  $('#rcats').innerHTML = [['all', 'Wszystkie']].concat(CATEGORIES).map(([k, n]) => `<button class="chip" data-act="cat" data-k="${k}" aria-pressed="${ui.cat === k}">${n}${k !== 'all' && counts[k] ? ` <span style="opacity:.6">${counts[k]}</span>` : ''}</button>`).join('');
  $('#rfilters').innerHTML = [['all', 'Wszystkie dania'], ['fav', '♥ Moje ulubione'], ['want', 'Zróbmy to'], ['promo', 'Z promocją'], ['new', 'Nowe']].map(([k, n]) => `<button class="chip soft" data-act="filter" data-k="${k}" aria-pressed="${ui.filter === k}">${n}</button>`).join('');
  $('#b-gen').textContent = ui.cat === 'all' ? '✦ Nowe przepisy' : `✦ Nowe: ${CATN[ui.cat]}`;
}
function renderRecipes() {
  const box = $('#rlist'); const all = activeRecipes();
  $('#rcount').textContent = all.length ? `${all.length} dań, które dobrze znoszą mrożenie` : 'Dania, które dobrze znoszą mrożenie';
  if (!all.length) { box.innerHTML = S.loaded.recipes ? `<div class="empty"><h3>Nie ma jeszcze przepisów</h3><div>Baza przepisów jeszcze się wczytuje. Zajrzyj za kilka minut.</div></div>` : `<div class="empty"><span class="spin"></span>Wczytuję przepisy…</div>`; return; }
  const q = ui.q.trim().toLowerCase(), week = Date.now() - 7 * 864e5;
  let list = all.map(r => ({ ...r, c: L.recipeCost(r, 2), re: reactFor(r.id), isNew: ui.justAdded.has(r.id) || (S.hh[r.id]?.activated_at && new Date(S.hh[r.id].activated_at).getTime() > week) || (r.source === 'claude' && r.added_on && new Date(r.added_on).getTime() > week) }))
    .filter(r => {
      if (ui.cat !== 'all' && r.category !== ui.cat) return false;
      if (q) { const hay = (r.name + ' ' + (r.ingredients || []).map(i => S.products[i.pid]?.name || '').join(' ')).toLowerCase(); if (!hay.includes(q)) return false; }
      if (ui.filter === 'fav') return r.re.like.includes(ui.member);
      if (ui.filter === 'want') return r.re.want.length > 0;
      if (ui.filter === 'promo') return r.c.promos.length > 0;
      if (ui.filter === 'new') return r.isNew;
      return true;
    });
  list.sort((a, b) => (b.isNew && ui.justAdded.has(b.id)) - (a.isNew && ui.justAdded.has(a.id)) || b.re.want.length - a.re.want.length || new Set(b.c.promos.map(x => x.pid)).size - new Set(a.c.promos.map(x => x.pid)).size || a.name.localeCompare(b.name, 'pl'));
  if (!list.length) { box.innerHTML = `<div class="empty"><h3>Nic tu nie pasuje</h3><div>Zmień filtr albo dobierz nowe dania w tej kategorii.</div><button class="btn pri" data-act="gen">✦ Nowe przepisy</button></div>`; return; }
  box.innerHTML = '<div class="cards">' + list.map(r => {
    const best = SK.filter(s => !r.c.miss[s]).sort((a, b) => r.c.tot[a] - r.c.tot[b])[0];
    const nPromo = new Set(r.c.promos.map(x => x.pid)).size, liked = r.re.like.includes(ui.member);
    return `<div class="card" role="button" tabindex="0" data-act="open" data-id="${esc(r.id)}">
      <span class="tape">${esc(CATN[r.category] || r.category)} · mroź do ${r.freeze_months || 3} mies.</span>
      <button class="heart ${liked ? 'on' : ''}" data-act="like" data-id="${esc(r.id)}" aria-label="Ulubione">${liked ? HEART : HEART_O}</button>
      <h3 style="padding-right:30px">${esc(r.name)}</h3>
      <div class="meta">${r.isNew ? '<span class="pill new">Nowe</span>' : ''}${nPromo ? `<span class="pill promo">${nPromo} w promocji</span>` : ''}${r.re.want.length ? `<span class="pill want">Zróbmy to ${faces(r.re.want)}</span>` : ''}${r.re.like.length ? `<span class="pill muted">♥ ${faces(r.re.like)}</span>` : ''}<span>${r.minutes || '?'} min · z: ${esc(r.sides || 'dowolne dodatki')}</span></div>
      <div class="price-line"><span class="sub">porcja od</span><span><b class="num">${zl(r.c.mix / 2)}</b>${best ? ` <span class="sub">· najtaniej <span class="store ${best}">${SN[best]}</span></span>` : ''}</span></div>
    </div>`;
  }).join('') + '</div>';
}

function recipeSheet() {
  const r = S.recipes[ui.sheet.id]; if (!r) return closeSheet();
  return `<div class="sheet-head"><div><h2>${esc(r.name)}</h2><div class="meta" style="margin-top:6px"><span>${esc(CATN[r.category] || '')}</span><span>${r.minutes || '?'} min</span><span>mrożenie do ${r.freeze_months || 3} mies.</span><span>z: ${esc(r.sides || 'dowolne dodatki')}</span></div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  <div id="rd-react"></div>
  <div class="sec"><h4>Ile porcji robisz?</h4><div class="stepper"><div class="n"><button data-act="pdec" aria-label="Mniej">−</button><input id="rd-n" type="number" inputmode="numeric" min="1" max="40" value="${ui.portions}"><button data-act="pinc" aria-label="Więcej">+</button></div>
   <div class="chips">${[[4, '2 dni'], [6, '3 dni'], [8, '4 dni'], [10, '5 dni']].map(([n, l]) => `<button class="chip" data-act="pset" data-n="${n}" aria-pressed="${ui.portions == n}">${n} · ${l}</button>`).join('')}</div></div><div class="sub">Dla 2 osób: 1 dzień = 2 porcje.</div></div>
  <div id="rd-dyn" class="sec" style="gap:16px"></div>`;
}
function drawRecipeDyn() {
  const r = S.recipes[ui.sheet?.id]; if (!r || !$('#rd-dyn')) return;
  const n = ui.portions, m = n / (r.base || 2), c = L.recipeCost(r, n), re = reactFor(r.id);
  const liked = re.like.includes(ui.member), wanted = re.want.includes(ui.member);
  $('#rd-react').innerHTML = `<div class="row"><button class="btn sm ${liked ? 'pri' : ''}" data-act="like" data-id="${esc(r.id)}">${liked ? '♥ W ulubionych' : '♡ Do ulubionych'}</button><button class="btn sm ${wanted ? 'pri' : ''}" data-act="want" data-id="${esc(r.id)}">${wanted ? '✓ Chcę to zrobić' : 'Zróbmy to'}</button>${re.like.length ? `<span class="sub">lubi: ${faces(re.like)}</span>` : ''}${re.want.length ? `<span class="sub">chce: ${faces(re.want)}</span>` : ''}</div>`;
  const cols = [...SK.map(s => ({ k: s, n: SN[s], v: c.tot[s], miss: c.miss[s] })), { k: 'mix', n: 'Mix', v: c.mix, miss: c.mixMiss }];
  const bestK = cols.filter(x => !x.miss && x.k !== 'mix').sort((a, b) => a.v - b.v)[0]?.k;
  const promoSet = new Set(c.promos.map(x => x.pid + '|' + x.s));
  const ing = (r.ingredients || []).map(i => {
    const p = S.products[i.pid] || { name: i.pid, unit: i.unit };
    const pr = SK.filter(s => promoSet.has(i.pid + '|' + s)).map(s => { const v = L.priceOf(i.pid, s); return `<span class="store ${s}">${SN[s]} ${zs(v.p)}${v.until ? ' do ' + dPL(v.until) : ''}</span>`; });
    const q = L.needOf(i, m, p);
    return `<li><span class="nm">${esc(p.name)}${p.pantry ? '<small>z zapasów</small>' : pr.length ? `<small>promocja: ${pr.join(', ')}</small>` : ''}</span><span class="q">${fmtAmt(i.amt * m, i.unit)}${!p.pantry && q != null && p.pack ? `<small>${buyText(p, q)}</small>` : ''}</span></li>`;
  }).join('');
  $('#rd-dyn').innerHTML = `
  <div class="sec"><h4>Koszt ${n} porcji</h4><div class="costgrid">${cols.map(x => `<div class="cost ${x.k === bestK ? 'best' : ''}"><span class="lbl ${x.k !== 'mix' ? 'store ' + x.k : ''}">${x.n}</span><b class="num">${zs(x.v)}</b><small>${x.miss ? `bez ${x.miss} cen` : zs(x.v / n) + '/porc.'}</small></div>`).join('')}</div>
   <div class="sub">„Mix” to każdy składnik w najtańszym sklepie. Liczone proporcjonalnie, bez przypraw.</div></div>
  <div class="row"><button class="btn pri" data-act="to-list" style="flex:1">Dodaj ${n} porcji do listy</button><button class="btn" data-act="to-freezer">Ugotowane → do zamrażarki</button></div>
  <div class="sec"><h4>Składniki · ${n} porcji</h4><div class="box" style="padding-block:4px"><ul class="ing">${ing}</ul></div></div>
  <div class="sec"><h4>Przygotowanie</h4><ol class="steps">${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>
  ${r.thaw ? `<div class="sec"><h4>Mrożenie i odgrzewanie</h4><div class="box">${esc(r.thaw)}</div></div>` : ''}
  <div>${ui.sheet.confirmDel ? `<div class="row"><span class="sub">Usunąć to danie z Waszych przepisów?</span><button class="btn sm danger" data-act="del-recipe">Tak, usuń</button><button class="btn sm" data-act="cancel-del">Anuluj</button></div>` : `<button class="btn sm ghost danger" data-act="ask-del">Usuń przepis</button>`}</div>`;
}
async function addRecipeToList() {
  const r = S.recipes[ui.sheet.id], n = ui.portions, m = n / (r.base || 2), batch = r.id + '-' + Date.now();
  const rows = (r.ingredients || []).map(i => { const p = S.products[i.pid]; if (!p) return null; return { product_id: i.pid, qty: L.needOf(i, m, p) ?? 0, pantry: !!p.pantry, recipe_id: r.id, recipe_name: r.name, servings: n, batch, member: ui.member }; }).filter(Boolean);
  if (await w(() => db.from('list_items').insert(rows), `Dodano ${r.name} (${n} porcji) do listy`)) { closeSheet(); reload('list_items'); }
}

/* ---------- nowe przepisy z banku ---------- */
function genSheet() {
  const st = ui.sheet, left = st.cat ? bankFor(st.cat).length : 0;
  return `<div class="sheet-head"><div><h2>Nowe przepisy</h2><div class="sub" style="margin-top:4px">Dobiorę dania z banku przepisów. Najpierw te, których składniki są teraz w promocji.</div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  <form id="f-gen" class="sec" style="gap:14px">
   <div class="field"><label>Kategoria</label><div class="chips" style="flex-wrap:wrap">${CATEGORIES.map(([k, n]) => `<button type="button" class="chip" data-act="gen-cat" data-k="${k}" aria-pressed="${st.cat === k}">${n} <span style="opacity:.6">${bankFor(k).length}</span></button>`).join('')}</div><div class="sub">Liczba przy kategorii to dania, które jeszcze czekają w banku.</div></div>
   <div class="field"><label>Ile przepisów</label><div class="chips">${[2, 4, 6].map(n => `<button type="button" class="chip" data-act="gen-n" data-n="${n}" aria-pressed="${st.n === n}">${n}</button>`).join('')}</div></div>
   <div class="banner">Chcesz dań spoza banku? Napisz do Claude, np. <b>„dodaj 4 przepisy z mielonego, coś azjatyckiego”</b>. Pojawią się tu po kilku minutach z etykietą „Nowe”.</div>
   <button class="btn pri" type="submit" ${!st.cat || !left ? 'disabled' : ''}>${!st.cat ? 'Wybierz kategorię' : left ? `✦ Dodaj ${Math.min(st.n, left)}: ${CATN[st.cat]}` : 'W tej kategorii bank jest już pusty'}</button></form>`;
}
async function runGen() {
  const st = ui.sheet, t = L.today();
  const pick = bankFor(st.cat).map(r => ({ r, promo: new Set(L.recipeCost(r, 2).promos.map(x => x.pid)).size, rnd: Math.random() }))
    .sort((a, b) => b.promo - a.promo || a.rnd - b.rnd).slice(0, st.n).map(x => x.r);
  if (!pick.length) return;
  const ids = pick.map(r => r.id), now = new Date().toISOString();
  const rows = ids.map(id => ({ recipe_id: id, active: true, removed: false, activated_at: now }));
  rows.forEach(r => { S.hh[r.recipe_id] = r; ui.justAdded.add(r.recipe_id); });
  ui.cat = st.cat; lsSet('cat', ui.cat); ui.filter = 'all'; closeSheet(); renderAll(); window.scrollTo(0, 0);
  if (await w(() => db.from('hh_recipes').upsert(rows), `Dodano ${pick.length} przepisy: ${CATN[st.cat]}`)) reload('hh_recipes');
}

/* ---------- LIST ---------- */
function renderList() {
  const box = $('#llist'), { rows, pantry, manual } = L.aggList();
  const left = rows.filter(g => !g.done).length + manual.filter(m => !m.done).length;
  const b = $('#lbadge'); b.hidden = !left; b.textContent = left;
  if (!S.list_items.length) { box.innerHTML = `<div class="empty"><h3>Lista jest pusta</h3><div>Otwórz przepis, ustaw liczbę porcji i dodaj składniki. Policzę, gdzie wyjdzie najtaniej.</div><button class="btn pri" data-tab="przepisy">Wybierz danie</button></div>`; return; }
  const batches = {}; S.list_items.forEach(x => { if (x.batch && !batches[x.batch]) batches[x.batch] = { name: x.recipe_name, n: x.servings }; });
  let h = '';
  if (Object.keys(batches).length) h += `<div class="sec"><h4>Na liście</h4><div class="batches">${Object.entries(batches).map(([k, v]) => `<span class="batch">${esc(v.name)} · ${v.n} porc.<button data-act="del-batch" data-k="${esc(k)}" aria-label="Usuń z listy">✕</button></span>`).join('')}</div></div>`;
  if (rows.length) {
    const ps = L.plans(rows), { rec, chosen } = L.pickPlan(ps, ui.trip, ui.plan);
    const singles = ps.filter(p => p.st.length === 1), worst = Math.max(0, ...singles.filter(p => !p.missing).map(p => p.total));
    const shown = [rec, ...singles.sort((a, b) => a.missing - b.missing || a.total - b.total), ...ps.filter(p => p.st.length > 1 && p !== rec).sort((a, b) => a.total - b.total).slice(0, 2)].filter((p, i, a) => a.indexOf(p) === i);
    h += `<div class="plan"><div class="sec" style="gap:4px"><h4>Gdzie kupić najtaniej</h4>
      <div class="row" style="justify-content:space-between;align-items:baseline"><span class="big num">${zl(chosen.total)}</span><span>${chosen.st.map(s => `<span class="store ${s}">${SN[s]}</span>`).join(' + ')}</span></div>
      <div class="sub">${chosen.todo} pozycji do kupienia${chosen.missing ? ` · ${chosen.missing} bez ceny` : ''}${worst && !chosen.missing && worst - chosen.total > 0.5 ? ` · oszczędzasz ${zl(worst - chosen.total)} wobec najdroższego sklepu` : ''}</div></div>
      <div class="opts">${shown.map(p => `<button class="opt" data-act="plan" data-k="${p.key}" aria-pressed="${p === chosen}"><span>${p.st.map(s => `<span class="store ${s}">${SN[s]}</span>`).join(' + ')}${p === rec ? ' <span class="pill want">polecam</span>' : ''}<span class="d">${p.missing ? ` · brak ${p.missing} cen` : ''}</span></span><b class="num" style="font-family:var(--f-mono)">${zs(p.total)}</b></button>`).join('')}</div>
      <div class="sub">Dodatkowy sklep polecam, gdy oszczędza co najmniej <button class="btn sm" data-act="trip" style="padding:2px 9px">${ui.trip} zł</button></div></div>`;
    const groups = {}; for (const g of rows) { const a = chosen.assign[g.pid]; (groups[a ? a.s : 'none'] ??= []).push(g); }
    for (const s of [...chosen.st, 'none']) {
      const gs = groups[s]; if (!gs) continue; gs.sort((a, b) => a.done - b.done || a.p.name.localeCompare(b.p.name, 'pl'));
      const sub = gs.filter(g => !g.done).reduce((t, g) => t + (chosen.assign[g.pid]?.c || 0), 0);
      h += `<div class="grp"><div class="grp-h"><h3 class="${s !== 'none' ? 'store ' + s : ''}">${s === 'none' ? 'Bez ceny' : SN[s]}</h3>${s !== 'none' ? `<span class="num" style="font-family:var(--f-mono)">${zs(sub)} zł</span>` : ''}</div>${gs.map(g => {
        const a = chosen.assign[g.pid], pr = a ? L.priceOf(g.pid, a.s) : null;
        return `<div class="item ${g.done ? 'done' : ''}"><button class="ck ${g.done ? 'on' : ''}" data-act="tick" data-pid="${esc(g.pid)}" aria-label="Kupione">${g.done ? CHECK : ''}</button><div class="nm"><b>${esc(g.p.name)}</b><small>${buyText(g.p, g.q)}${pr?.promo ? ` · <span style="color:var(--promo);font-weight:700">promocja${pr.until ? ' do ' + dPL(pr.until) : ''}</span>` : ''}${pr?.note ? ' · ' + esc(pr.note) : ''}</small><small>${esc([...g.srcs].join(', '))}</small></div><div class="pr">${a ? zs(a.c) : ''}</div></div>`;
      }).join('')}</div>`;
    }
  }
  if (manual.length) h += `<div class="grp"><div class="grp-h"><h3>Inne</h3></div>${manual.sort((a, b) => a.done - b.done).map(m => `<div class="item ${m.done ? 'done' : ''}"><button class="ck ${m.done ? 'on' : ''}" data-act="tick-m" data-id="${esc(m.id)}" aria-label="Kupione">${m.done ? CHECK : ''}</button><div class="nm"><b>${esc(m.name || S.products[m.product_id]?.name || '?')}</b>${m.member ? `<small>dopisał(a): ${esc(m.member)}</small>` : ''}</div><div class="pr"><button class="btn sm ghost" data-act="del-item" data-id="${esc(m.id)}" aria-label="Usuń">✕</button></div></div>`).join('')}</div>`;
  if (pantry.length) h += `<div class="grp"><div class="grp-h"><h3>Sprawdź w domu</h3><span class="sub">przyprawy i zapasy</span></div>${pantry.map(g => `<div class="item ${g.done ? 'done' : ''}"><button class="ck ${g.done ? 'on' : ''}" data-act="tick" data-pid="${esc(g.pid)}" aria-label="Mam">${g.done ? CHECK : ''}</button><div class="nm"><b>${esc(g.p.name)}</b><small>${esc([...g.srcs].join(', '))}</small></div><div class="pr"></div></div>`).join('')}</div>`;
  box.innerHTML = h;
}
async function tickGroup(pid) {
  const items = S.list_items.filter(x => x.product_id === pid && !x.manual); const done = !items.every(d => d.done);
  items.forEach(i => i.done = done); renderList();
  await w(() => db.from('list_items').update({ done }).in('id', items.map(i => i.id)));
}

/* ---------- FREEZER ---------- */
function renderFreezer() {
  const box = $('#flist'); const fs = [...S.freezer].sort((a, b) => (a.frozen_on || '').localeCompare(b.frozen_on || ''));
  if (!fs.length) { box.innerHTML = `<div class="empty"><h3>Zamrażarka jest pusta</h3><div>Po ugotowaniu otwórz przepis i wybierz „Ugotowane → do zamrażarki”. Zobaczysz tu, ile porcji zostało i co zjeść najpierw.</div></div>`; return; }
  const total = fs.reduce((t, f) => t + (f.portions || 0), 0);
  box.innerHTML = `<div class="sub">Razem ${total} porcji · ok. ${num(total / 2, 1)} obiadów dla 2 osób</div>` + fs.map(f => {
    const age = daysSince(f.frozen_on), lim = (S.recipes[f.recipe_id]?.freeze_months || 3) * 30, old = age > lim;
    return `<div class="fz"><span class="tape">${dPL(f.frozen_on)} · ${age} dni${old ? ' · zjedz szybko' : ''}</span><div><h3>${esc(f.name)}</h3><div class="sub ${old ? 'old' : ''}">${old ? 'Przekroczony zalecany czas mrożenia' : 'Dobre jeszcze ok. ' + Math.max(0, Math.round((lim - age) / 7)) + ' tyg.'}</div></div>
    <div class="n"><button class="round" data-act="fz-dec" data-id="${esc(f.id)}" aria-label="Wyjmij porcję">−</button><b class="num">${f.portions}</b><button class="round" data-act="fz-inc" data-id="${esc(f.id)}" aria-label="Dodaj porcję">+</button></div></div>`;
  }).join('');
}
async function fzChange(id, d) {
  const f = S.freezer.find(x => x.id === id); if (!f) return; const n = (f.portions || 0) + d;
  if (n <= 0) { if (await w(() => db.from('freezer').delete().eq('id', id), 'Pudełko zjedzone. Usunięto z zamrażarki.')) reload('freezer'); }
  else { f.portions = n; renderFreezer(); await w(() => db.from('freezer').update({ portions: n }).eq('id', id)); }
}

/* ---------- PRICES ---------- */
function renderStores() {
  const runs = S.scrape_runs || [];
  $('#pstores').innerHTML = `<div class="stores">${STORES.map(s => {
    const ok = runs.find(r => r.store === s.k && r.status === 'ok'), last = runs.find(r => r.store === s.k);
    const err = last && last.status !== 'ok';
    return `<div class="st ${err ? 'err' : ''}"><b class="store ${s.k}">${s.n}</b>${ok ? `<span>gazetka ${dPL(ok.valid_from)}–${dPL(ok.valid_to)}</span><span>${ok.matched} produktów w promocji</span>` : '<span>jeszcze nie pobrano</span>'}${err ? `<span class="old">ostatnia próba: błąd</span>` : last ? `<span>pobrano ${new Date(last.ran_at).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })}</span>` : ''}</div>`;
  }).join('')}</div>`;
  $('#pm-offers').setAttribute('aria-pressed', ui.pmode === 'offers'); $('#pm-table').setAttribute('aria-pressed', ui.pmode === 'table');
}
function renderPrices() {
  renderStores();
  const box = $('#plist'), q = ui.pq.trim().toLowerCase();
  if (ui.pmode === 'offers') {
    const offs = (S.offers || []).filter(o => !q || o.name.toLowerCase().includes(q));
    if (!offs.length) { box.innerHTML = `<div class="empty"><h3>${q ? 'Brak takich ofert' : 'Brak promocji'}</h3><div>${q ? 'Spróbuj innej nazwy.' : 'Promocje pojawią się po pierwszym automatycznym pobraniu ofert (poniedziałki i czwartki rano).'}</div></div>`; return; }
    box.innerHTML = STORES.map(s => {
      const os = offs.filter(o => o.store === s.k).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
      if (!os.length) return '';
      return `<div class="grp"><div class="grp-h"><h3 class="store ${s.k}">${s.n}</h3><span class="sub">${os.length} ofert</span></div>${os.map(o => `<div class="offer"><div class="nm">${esc(S.products[o.product_id]?.name || o.name)}<small>${esc(o.name)}${o.unit_info ? ' · ' + esc(o.unit_info) : ''}${o.valid_from || o.valid_to ? ` · ${dPL(o.valid_from)}–${dPL(o.valid_to)}` : ''}${o.note ? ' · ' + esc(o.note) : ''}</small></div><div class="pr">${o.price != null ? zs(o.price) + ' zł' : ''}${o.regular ? `<small>${zs(o.regular)} zł</small>` : ''}</div></div>`).join('')}</div>`;
    }).join('');
    return;
  }
  const all = Object.values(S.products).filter(p => !q || p.name.toLowerCase().includes(q));
  const priced = all.filter(p => !p.pantry), pantry = all.filter(p => p.pantry);
  let h = `<div class="sub">Czerwone ceny pochodzą z aktualnych ofert sklepów. Ceny „szac.” są orientacyjne: stuknij, żeby wpisać prawdziwą. Wpisane ceny widzi tylko Wasz dom.</div><div class="ptable"><div class="prow head"><span>Produkt</span>${STORES.map(s => `<span class="store ${s.k}" style="text-align:center">${s.n}</span>`).join('')}</div>`;
  const cats = [...new Set([...PCATS, ...priced.map(p => p.cat || 'inne')])];
  for (const c of cats) {
    const ps = priced.filter(p => (p.cat || 'inne') === c).sort((a, b) => a.name.localeCompare(b.name, 'pl')); if (!ps.length) continue;
    h += `<div class="prow cat">${esc(c)}</div>` + ps.map(p => {
      const vals = SK.map(s => L.priceOf(p.id, s)), have = vals.filter(Boolean), min = Math.min(...have.map(v => v.p));
      return `<div class="prow"><div class="nm">${esc(p.name)}<small>${p.loose ? 'za kg' : fmtPack(p)}</small></div>${SK.map((s, i) => {
        const v = vals[i];
        const cls = !v ? 'none' : v.promo ? 'promo' : (v.p === min && have.length > 1 ? 'cheap' : '');
        const tag = !v ? '' : v.promo ? (v.until ? 'do ' + dPL(v.until) : 'promo') : v.own ? 'Wasza' : 'szac.';
        return `<button class="pc ${cls}" data-act="price" data-pid="${esc(p.id)}" data-s="${s}">${v ? zs(v.p) : '+'}<small>${tag}</small></button>`;
      }).join('')}</div>`;
    }).join('');
  }
  h += '</div>';
  if (pantry.length) h += `<details><summary>Spiżarnia (${pantry.length}) · bez liczenia kosztu</summary><div class="sub">${pantry.map(p => esc(p.name)).join(', ')}</div></details>`;
  box.innerHTML = h;
}
function priceSheet() {
  const { pid, s } = ui.sheet, p = S.products[pid]; if (!p) return closeSheet(); const v = L.priceOf(pid, s), row = { regular: v?.regular ?? (v && !v.promo ? v.p : null) };
  return `<div class="sheet-head"><div><h2>${esc(p.name)}</h2><div class="sub" style="margin-top:4px">cena regularna ${p.loose ? 'za 1 kg' : 'za opakowanie ' + fmtPack(p)}</div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  <form id="f-price" class="sec" style="gap:12px">
   <div class="chips">${SK.map(k => `<button type="button" class="chip" data-act="price" data-pid="${esc(pid)}" data-s="${k}" aria-pressed="${k === s}">${SN[k]}</button>`).join('')}</div>
   ${v?.promo ? `<div class="banner">Teraz w promocji: <b>${zs(v.p)} zł</b>${v.until ? ' do ' + dPL(v.until) : ''}${v.note ? ' · ' + esc(v.note) : ''}. Promocje aktualizują się same z gazetek.</div>` : ''}
   <div class="field"><label for="pp">Cena regularna (zł)</label><input class="input" id="pp" inputmode="decimal" value="${row.regular != null ? String(row.regular).replace('.', ',') : ''}" placeholder="np. 6,99"></div>
   <button class="btn pri" type="submit">Zapisz cenę</button></form>`;
}
async function savePrice() {
  const { pid, s } = ui.sheet, v = L.parsePL($('#pp').value); if (v == null) return toast('Wpisz cenę, np. 6,99');
  if (await w(() => db.from('hh_prices').upsert({ product_id: pid, store: s, regular: v, updated_at: new Date().toISOString() }), 'Zapisano cenę')) { closeSheet(); reload('hh_prices'); }
}

/* ---------- sheet & routing ---------- */
function drawSheet() {
  const st = ui.sheet, el = $('#sheet'), inn = $('#sheet-in'); if (!st) { el.hidden = true; return; }
  const html = st.type === 'recipe' ? recipeSheet() : st.type === 'price' ? priceSheet() : st.type === 'gen' ? genSheet() : whoSheet();
  if (!ui.sheet) return; inn.innerHTML = html; el.hidden = false; document.body.style.overflow = 'hidden';
  if (st.type === 'recipe') drawRecipeDyn();
}
function whoSheet() {
  const st = ui.sheet;
  return `<div class="sheet-head"><div><h2>${esc(house.name)}</h2><div class="sub" style="margin-top:4px">Ustawienia domu i zaproszenia</div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  <div class="sec"><h4>Zaproś domownika</h4><div class="box sub">Wyślij link osobie, z którą dzielisz kuchnię. Zobaczy Waszą listę zakupów, zamrażarkę i ulubione. Znajomemu z innego domu wyślij zwykły adres aplikacji, żeby założył własny dom.</div>
   <div class="row"><button class="btn pri" type="button" data-act="invite" style="flex:1">Wyślij zaproszenie</button><button class="btn" type="button" data-act="share-app">Adres dla znajomego</button></div></div>
  <form id="f-who" class="sec" style="gap:12px"><h4>Ty i Twój dom</h4>
   <div class="field"><label for="w-name">Twoje imię (widoczne dla domowników)</label><input class="input" id="w-name" value="${esc(ui.member)}" autocomplete="given-name"></div>
   <div class="field"><label for="w-house">Nazwa domu</label><input class="input" id="w-house" value="${esc(house.name)}"></div>
   <button class="btn pri" type="submit">Zapisz</button></form>
  <div class="sec"><h4>Ten telefon</h4>${st.confirmLeave ? `<div class="banner">Ten telefon przestanie widzieć dane domu. Wrócisz do niego tylko z linkiem zaproszenia od domownika.</div><div class="row"><button class="btn danger" type="button" data-act="leave">Tak, opuść dom</button><button class="btn" type="button" data-act="cancel-leave">Anuluj</button></div>` : `<button class="btn ghost danger" type="button" data-act="ask-leave">Opuść dom na tym telefonie</button>`}</div>`;
}
function closeSheet() { ui.sheet = null; $('#sheet').hidden = true; document.body.style.overflow = ''; }
const TABS = ['przepisy', 'lista', 'zamrazarka', 'ceny'];
function setTab(t) {
  ui.tab = t; document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'));
  TABS.forEach(v => $('#v-' + v).hidden = v !== t); if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t); window.scrollTo(0, 0);
}
function renderAll() { renderCats(); renderRecipes(); renderList(); renderFreezer(); renderPrices(); if (ui.sheet?.type === 'recipe') drawRecipeDyn(); }

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-tab]'); if (!t) return;
  if (t.dataset.tab) { setTab(t.dataset.tab); return; }
  const a = t.dataset.act, d = t.dataset;
  switch (a) {
    case 'open': ui.sheet = { type: 'recipe', id: d.id }; drawSheet(); break;
    case 'close': closeSheet(); break;
    case 'cat': ui.cat = d.k; lsSet('cat', d.k); renderCats(); renderRecipes(); break;
    case 'filter': ui.filter = d.k; renderCats(); renderRecipes(); break;
    case 'like': e.stopPropagation(); toggleReact(d.id, 'liked'); break;
    case 'want': toggleReact(d.id, 'wanted'); break;
    case 'pinc': case 'pdec': case 'pset': {
      ui.portions = a === 'pset' ? +d.n : Math.min(40, Math.max(1, ui.portions + (a === 'pinc' ? 1 : -1))); lsSet('portions', ui.portions);
      $('#rd-n').value = ui.portions; document.querySelectorAll('[data-act="pset"]').forEach(c => c.setAttribute('aria-pressed', +c.dataset.n === ui.portions)); drawRecipeDyn(); break;
    }
    case 'to-list': addRecipeToList(); break;
    case 'to-freezer': { const r = S.recipes[ui.sheet.id]; if (await w(() => db.from('freezer').insert({ recipe_id: r.id, name: r.name, portions: ui.portions, member: ui.member }), `Do zamrażarki: ${ui.portions} porcji`)) reload('freezer'); break; }
    case 'ask-del': ui.sheet.confirmDel = true; drawRecipeDyn(); break;
    case 'cancel-del': ui.sheet.confirmDel = false; drawRecipeDyn(); break;
    case 'del-recipe': { const id = ui.sheet.id, row = { recipe_id: id, active: false, removed: true }; S.hh[id] = row; closeSheet(); renderAll(); if (await w(() => db.from('hh_recipes').upsert(row), 'Usunięto przepis')) reload('hh_recipes'); break; }
    case 'gen': ui.sheet = { type: 'gen', cat: ui.cat === 'all' ? null : ui.cat, n: 4 }; drawSheet(); break;
    case 'gen-cat': ui.sheet.cat = d.k; drawSheet(); break;
    case 'gen-n': ui.sheet.n = +d.n; drawSheet(); break;
    case 'plan': ui.plan = d.k; renderList(); break;
    case 'trip': ui.trip = ui.trip >= 20 ? 0 : ui.trip + 4; lsSet('trip', ui.trip); ui.plan = null; renderList(); break;
    case 'tick': tickGroup(d.pid); break;
    case 'tick-m': { const m = S.list_items.find(x => x.id === d.id); if (m) { m.done = !m.done; renderList(); w(() => db.from('list_items').update({ done: m.done }).eq('id', d.id)); } break; }
    case 'del-item': if (await w(() => db.from('list_items').delete().eq('id', d.id))) reload('list_items'); break;
    case 'del-batch': if (await w(() => db.from('list_items').delete().eq('batch', d.k), 'Usunięto z listy')) reload('list_items'); break;
    case 'clear-done': { const ids = S.list_items.filter(x => x.done).map(x => x.id); if (!ids.length) return toast('Nic jeszcze nie jest odhaczone.'); if (await w(() => db.from('list_items').delete().in('id', ids), `Usunięto ${ids.length} kupionych`)) reload('list_items'); break; }
    case 'fz-dec': fzChange(d.id, -1); break;
    case 'fz-inc': fzChange(d.id, 1); break;
    case 'price': ui.sheet = { type: 'price', pid: d.pid, s: d.s }; drawSheet(); break;
    case 'pmode': ui.pmode = d.k; renderPrices(); break;
    case 'whoami': ui.sheet = { type: 'who' }; drawSheet(); break;
    case 'invite': shareLink(inviteUrl(), `Dołącz do domu „${house.name}” w Obiadach na Zapas`); break;
    case 'share-app': shareLink(appUrl(), 'Obiady na Zapas: przepisy do mrożenia, wspólna lista zakupów i ceny z gazetek'); break;
    case 'ask-leave': ui.sheet.confirmLeave = true; drawSheet(); break;
    case 'cancel-leave': ui.sheet.confirmLeave = false; drawSheet(); break;
    case 'leave': leaveHouse(); break;
    case 'w-mode': $('#f-create').hidden = d.k !== 'create'; $('#f-join').hidden = d.k !== 'join'; document.querySelectorAll('[data-act="w-mode"]').forEach(c => c.setAttribute('aria-pressed', c.dataset.k === d.k)); break;
    case 'hide-install': lsSet('noinstall', true); $('#install').hidden = true; break;
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.sheet) closeSheet(); if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card[data-act="open"]')) { e.preventDefault(); ui.sheet = { type: 'recipe', id: e.target.dataset.id }; drawSheet(); } });
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('submit', async e => {
  e.preventDefault(); const id = e.target.id;
  if (id === 'f-price') savePrice();
  else if (id === 'f-gen') runGen();
  else if (id === 'f-who') {
    const n = $('#w-name').value.trim(), hn = $('#w-house').value.trim();
    if (n) { ui.member = n; lsSet('member', n); $('#who').textContent = n; }
    if (hn && hn !== house.name && await w(() => db.rpc('rename_household', { p_name: hn }))) { house.name = hn; lsSet('house', house); }
    closeSheet(); renderAll(); toast('Zapisano');
  }
  else if (id === 'f-manual') { const v = $('#manual').value.trim(); if (!v) return; if (await w(() => db.from('list_items').insert({ manual: true, name: v, member: ui.member }))) { $('#manual').value = ''; reload('list_items'); } }
  else if (id === 'f-freeze') { const v = $('#fz-name').value.trim(), n = +$('#fz-n').value || 1; if (!v) return; if (await w(() => db.from('freezer').insert({ name: v, portions: n, member: ui.member }), 'Dodano do zamrażarki')) { $('#fz-name').value = ''; reload('freezer'); } }
  else if (id === 'f-create') createHouse();
  else if (id === 'f-join') joinHouse();
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { ui.q = e.target.value; renderRecipes(); }
  else if (e.target.id === 'pq') { ui.pq = e.target.value; renderPrices(); }
  else if (e.target.id === 'rd-n') { const n = parseInt(e.target.value); if (n > 0 && n <= 40) { ui.portions = n; lsSet('portions', n); document.querySelectorAll('[data-act="pset"]').forEach(c => c.setAttribute('aria-pressed', +c.dataset.n === n)); drawRecipeDyn(); } }
});
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TABS.includes(h)) setTab(h); });

/* ---------- dom: zakładanie, zaproszenia, start ---------- */
const keyFrom = v => (String(v || '').match(/[0-9a-f]{64}/) || [null])[0];
const appUrl = () => location.origin + location.pathname;
const inviteUrl = () => `${appUrl()}?dom=${house.key}`;
const client = key => createClient(CFG.url, CFG.anon, { auth: { persistSession: false }, global: key ? { headers: { 'x-dom': key } } : {} });
function ping() { chan?.send({ type: 'broadcast', event: 'zmiana', payload: {} }).catch?.(() => { }); }
async function shareLink(url, text) {
  try { if (navigator.share) { await navigator.share({ title: 'Obiady na Zapas', text, url }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Skopiowano link'); } catch { toast('Nie udało się skopiować. Link: ' + url); }
}
async function houseFor(key) {
  const { data, error } = await client(key).rpc('household_info');
  if (error) throw error;
  return data ? { key, name: data.name } : null;
}
function welcomeError(m) { const e = $('#w-err'); e.textContent = m; e.hidden = !m; }
async function busy(btn, fn) { const t = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; try { await fn(); } finally { btn.disabled = false; btn.textContent = t; } }
async function createHouse() {
  const name = $('#w-member').value.trim(); if (!name) return welcomeError('Wpisz swoje imię.');
  await busy($('#c-btn'), async () => {
    const { data, error } = await client(null).rpc('create_household', { p_name: $('#w-house').value.trim() || `Dom: ${name}` });
    if (error || !data?.secret) return welcomeError(navigator.onLine ? 'Nie udało się założyć domu. Spróbuj ponownie.' : 'Brak internetu.');
    enter({ key: data.secret, name: data.name }, name);
  });
}
async function joinHouse() {
  const name = $('#w-member').value.trim(), key = keyFrom($('#w-code').value);
  if (!name) return welcomeError('Wpisz swoje imię.');
  if (!key) return welcomeError('To nie wygląda na link zaproszenia. Wklej cały link od domownika.');
  await busy($('#j-btn'), async () => {
    const h = await houseFor(key).catch(() => undefined);
    if (h === undefined) return welcomeError('Brak połączenia. Spróbuj ponownie.');
    if (!h) return welcomeError('Nie znaleziono domu z tego zaproszenia. Poproś domownika o nowy link.');
    enter(h, name);
  });
}
function enter(h, member) {
  house = h; lsSet('house', h); ui.member = member; lsSet('member', member);
  // klucz domu w adresie: po „Dodaj do ekranu początkowego” ikona otworzy już ten dom
  history.replaceState(null, '', `?dom=${h.key}#przepisy`);
  start();
}
function leaveHouse() {
  try { Object.keys(localStorage).filter(k => k.startsWith('onz_')).forEach(k => localStorage.removeItem(k)); } catch { }
  location.replace(appUrl());
}
function showWelcome(invite) {
  $('#welcome').hidden = false; $('#app').hidden = true;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#w-install').hidden = standalone || !/iPhone|iPad/.test(navigator.userAgent);
  $('#w-member').value = ui.member || '';
  if (invite) {
    $('#w-modes').hidden = true; $('#f-create').hidden = true; $('#f-join').hidden = false;
    $('#w-code').value = invite.key; $('#j-title').textContent = `Dołączasz do domu „${invite.name}”`;
  }
}
function start() {
  db = client(house.key);
  $('#welcome').hidden = true; $('#app').hidden = false; $('#who').textContent = ui.member || 'Ustawienia';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#install').hidden = standalone || lsGet('noinstall', false) || !/iPhone|iPad/.test(navigator.userAgent);
  $('#offline').hidden = navigator.onLine;
  const h = location.hash.slice(1); setTab(TABS.includes(h) ? h : 'przepisy');
  loadCache(); renderAll(); loadAll(); subscribe();
}
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  if (!CFG.url) { document.body.innerHTML = '<div class="wrap" style="padding:40px 16px"><h2>Aplikacja jeszcze nie jest skonfigurowana</h2></div>'; return; }
  const saved = lsGet('house', null), fromUrl = keyFrom(new URLSearchParams(location.search).get('dom'));
  if (fromUrl && fromUrl !== saved?.key) {
    // link zaproszenia albo pierwsze otwarcie z ikony
    const h = await houseFor(fromUrl).catch(() => null);
    if (h && ui.member) return enter(h, ui.member);
    if (h) return showWelcome(h);
  }
  if (saved?.key) { house = saved; if (!fromUrl) history.replaceState(null, '', `?dom=${saved.key}${location.hash || '#przepisy'}`); return start(); }
  showWelcome(null);
})();
