// Biblioteki są w repozytorium (vendor/, wersje i sumy w vendor/WERSJE.json), nie z CDN.
import { createClient } from './vendor/supabase/supabase.mjs';
import * as L from './logic.js';
import * as RC from './receipt.js';
import * as D from './dane.js';

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
const visible = r => !S.hh[r.id]?.removed; // wszystkie przepisy z bazy, poza usuniętymi przez dom
const activeRecipes = () => Object.values(S.recipes).filter(visible);
const ui = {
  tab: 'przepisy', cat: lsGet('cat', 'all'), filter: 'all', onlyFreezer: lsGet('onlyFreezer', false), q: '', pq: '', pmode: 'offers',
  portions: lsGet('portions', 8), trip: lsGet('trip', 8), plan: null, sheet: null,
  member: String(lsGet('member', '')).slice(0, 40), justAdded: new Set(), month: new Date().toISOString().slice(0, 7),
};
let db = null, house = null, chan = null, houseTag = '';
const HH_TABLES = ['recipe_requests', 'hh_recipes', 'reactions', 'list_items', 'freezer', 'hh_prices', 'receipts', 'receipt_items', 'hh_settings'];
// tabele wspólne i zbiory, od których zależą (wersje w dataset_versions; „dzien”: oferty filtrujemy po dacie)
const SHARED = { products: ['katalog'], recipes: ['katalog'], prices: ['katalog', 'oferty'], offers: ['oferty', 'dzien'], scrape_runs: ['oferty'] };
// klucze wierszy w tabelach domu (bez household_id); hh_settings ma jeden wiersz na dom
const PK = { list_items: ['id'], freezer: ['id'], receipts: ['id'], receipt_items: ['id'], recipe_requests: ['id'], reactions: ['recipe_id', 'member'], hh_prices: ['product_id', 'store'], hh_recipes: ['recipe_id'], hh_settings: [] };
const RAW = {}, VER = {};  // wiersze z serwera (albo z kopii w telefonie) i wersja danych, z którą się zgadzają
let pendingOps = [];       // zapisy czekające na wysłanie (kolejka w IndexedDB); widok = RAW + te zapisy
let netDown = false;

function lsGet(k, d) { try { const v = localStorage.getItem('onz_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem('onz_' + k, JSON.stringify(v)); } catch { } }
const $ = s => document.querySelector(s);
const { esc, zl, zs, num, dPL, today, daysSince, fmtAmt, buyText, fmtPack } = L;
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.2-9.4C1.7 7.8 3.9 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.7 1.1-1.6 2.7-2.7 4.7-2.7 3.4 0 5.6 3.3 4.5 6.6-1.7 4.8-9.2 9.4-9.2 9.4z" fill="currentColor"/></svg>';
const HEART_O = HEART.replace('fill="currentColor"', 'fill="none" stroke="currentColor" stroke-width="1.8"');

/* ---------- people ---------- */
const COLORS = ['#2F5BEA', '#6D3FE0', '#B8327E', '#0B7285', '#B25E09', '#3D3880'];
const colorOf = n => COLORS[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const faces = names => names.length ? '<span class="faces">' + names.slice(0, 5).map(n => `<span class="face" style="background:${colorOf(n)}" title="${esc(n)}">${esc(n[0]?.toUpperCase() || '?')}</span>`).join('') + '</span>' : '';

/* ---------- zapisy ---------- */
// Komunikat o błędzie zapisu: limity z bazy mają już polskie komunikaty (kod P0001).
function errorText(e) {
  if (e?.code === 'P0001' && e.message) return e.message;
  if (e?.code === '23514' || e?.code === '22001') return 'Nie zapisano: za długi tekst albo niepoprawna wartość.';
  if (e?.code === '42501') return 'Nie zapisano: brak dostępu do domu (może zmieniono klucz domu).';
  return navigator.onLine ? 'Nie udało się zapisać. Spróbuj ponownie.' : 'Brak internetu. Spróbuj, gdy wróci połączenie.';
}
// Zapis od razu do bazy (funkcje RPC, prośby o przepisy): wymaga internetu.
async function w(fn, ok) {
  try { const r = await fn(); const errs = [r].flat().map(x => x?.error).filter(Boolean); if (errs.length) throw errs[0]; if (ok) toast(ok); return true; }
  catch (e) { (e?.code === 'P0001' ? console.warn : console.error)(e); toast(errorText(e)); return false; }
}
let tt; function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2800); }

// Zmiana w danych domu: od razu widać ją na ekranie, trafia do kolejki w telefonie i jest wysyłana, gdy jest internet.
// Ponowne wysłanie niczego nie dubluje: nowe wiersze mają identyfikatory nadane w telefonie.
async function write(ops, okMsg) {
  ops = [ops].flat().map(op => ({ ...op, key: house.key, at: Date.now() }));
  pendingOps.push(...ops);
  new Set(ops.map(o => o.t)).forEach(recompute); renderAll(); netBanner();
  for (const op of ops) op.seq = await D.outboxAdd(op);
  if (okMsg) toast(navigator.onLine ? okMsg : okMsg + ' · wyślę, gdy wróci internet');
  sync();
}
const newId = () => crypto.randomUUID();
// Nałożenie zapisu na wiersze tabeli (w telefonie, zanim odpowie serwer).
function applyOp(rows, op) {
  const pk = PK[op.t] || ['id'], same = (a, b) => pk.every(k => a[k] === b[k]);
  const hit = r => Object.entries(op.match || {}).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v);
  if (op.kind === 'insert' || op.kind === 'upsert') {
    const out = rows.slice();
    for (const row of op.rows) {
      const i = pk.length ? out.findIndex(r => same(r, row)) : out.length ? 0 : -1;
      if (i < 0) out.push({ ...row }); else if (op.kind === 'upsert') out[i] = { ...out[i], ...row };
    }
    return out;
  }
  if (op.kind === 'update') return rows.map(r => hit(r) ? { ...r, ...op.values } : r);
  if (op.kind === 'delete') return rows.filter(r => !hit(r));
  return rows;
}
function recompute(t) {
  const mine = pendingOps.filter(o => o.t === t && o.key === house?.key);
  if (!(t in RAW) && !mine.length) return;
  L.setTable(t, mine.reduce(applyOp, RAW[t] || []));
}
const clients = new Map();
const clientFor = key => clients.get(key) ?? clients.set(key, client(key)).get(key);
function execOp(op) {
  let q = clientFor(op.key).from(op.t);
  if (op.kind === 'insert') q = q.upsert(op.rows, { onConflict: (PK[op.t] || ['id']).join(','), ignoreDuplicates: true });
  else if (op.kind === 'upsert') q = q.upsert(op.rows);
  else if (op.kind === 'update') q = q.update(op.values);
  else q = q.delete();
  for (const [k, v] of Object.entries(op.match || {})) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
  return q;
}
// Wysyła kolejkę po kolei. Brak sieci albo błąd serwera: zostaje na później. Odrzucenie przez bazę: cofamy na ekranie.
async function flush() {
  const sent = new Set();
  for (const op of [...pendingOps]) {
    if (op.seq == null) break; // jeszcze nie zapisana w telefonie
    const r = await execOp(op).then(x => x, e => ({ error: e, status: 0 })); // zapytanie supabase ma tylko then()
    if (r.error && (!r.status || r.status >= 500 || r.status === 408 || r.status === 429)) { netDown = true; break; }
    pendingOps = pendingOps.filter(x => x !== op); D.outboxDel(op.seq);
    if (op.key !== house?.key) continue;
    if (r.error) { console.error(op.t, r.error); toast(errorText(r.error)); recompute(op.t); continue; }
    RAW[op.t] = applyOp(RAW[op.t] || [], op); recompute(op.t); sent.add(op.t);
    D.cachePut({ t: op.t, data: RAW[op.t], ver: VER[op.t], house: houseTag });
  }
  if (sent.size) ping([...sent]);
  netBanner();
}

/* ---------- wczytywanie danych ---------- */
const TABLES = {
  products: q => q.select('*').order('id'),
  prices: q => q.select('*').order('product_id').order('store'),
  recipes: q => q.select('*').order('name').order('id'),
  hh_recipes: q => q.select('*').order('recipe_id'),
  hh_prices: q => q.select('*').order('product_id').order('store'),
  reactions: q => q.select('*').order('recipe_id').order('member'),
  list_items: q => q.select('*').order('created_at').order('id'),
  freezer: q => q.select('*').order('id'),
  offers: q => q.select('*').gte('valid_to', L.daysAgo(0)).order('store').order('id'),
  scrape_runs: q => q.select('*').order('ran_at', { ascending: false }).limit(30),
  receipts: q => q.select('*').order('bought_on', { ascending: false }).order('id'),
  receipt_items: q => q.select('*').order('id'),
  hh_settings: q => q.select('*'),
  recipe_requests: q => q.select('*').order('created_at', { ascending: false }).limit(50),
};
const ONE_PAGE = new Set(['scrape_runs', 'recipe_requests', 'hh_settings']);
// Supabase oddaje najwyżej 1000 wierszy na zapytanie, więc większe tabele pobieramy stronami.
async function fetchAll(t, build = TABLES[t], all = false) {
  if (ONE_PAGE.has(t) && !all) { const { data, error } = await build(db.from(t)); if (error) throw error; return data || []; }
  const out = [], PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(db.from(t)).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data); if (data.length < PAGE) return out;
  }
}
async function load(t, ver) {
  try {
    const rows = await fetchAll(t);
    RAW[t] = rows; VER[t] = ver; recompute(t);
    D.cachePut({ t, data: rows, ver, house: SHARED[t] ? '' : houseTag });
  } catch (e) { console.error(t, e); }
}
// Synchronizacja: wysyła kolejkę zapisów, pyta o wersje danych (jedno małe zapytanie) i pobiera tylko to, co się zmieniło.
let syncP = null, syncAgain = false;
function sync() {
  if (!db) return Promise.resolve();
  if (syncP) { syncAgain = true; return syncP; }
  return syncP = (async () => { do { syncAgain = false; await syncOnce(); } while (syncAgain); })().finally(() => { syncP = null; });
}
async function syncOnce() {
  await flush();
  const { data, error, status } = await db.rpc('app_state').then(r => r, e => ({ error: e, status: 0 }));
  if (error) { if (!status || status >= 500) netDown = true; netBanner(); return; }
  netDown = false; netBanner();
  $('#lost').hidden = !!data?.dom;
  if (!data?.dom) { $('#lost').innerHTML = lostHtml(); return; }
  if (data.dom.name && data.dom.name !== house.name) { house.name = data.dom.name; lsSet('house', house); remember(house); }
  const want = {};
  for (const [t, deps] of Object.entries(SHARED)) want[t] = deps.map(d => d === 'dzien' ? today() : d + '=' + (data.zbiory?.[d] ?? '?')).join('|');
  for (const t of HH_TABLES) want[t] = data.tabele?.[t] ?? 'brak';
  const stale = Object.keys(want).filter(t => VER[t] !== want[t]);
  if (stale.length) { await Promise.all(stale.map(t => load(t, want[t]))); renderAll(); }
}
let soonT; const syncSoon = () => { clearTimeout(soonT); soonT = setTimeout(sync, 400); };
function netBanner() {
  const n = pendingOps.filter(o => o.key === house?.key).length, off = !navigator.onLine || netDown, el = $('#offline');
  el.hidden = !off;
  el.textContent = 'Brak połączenia. Pokazuję ostatnio wczytane dane.' + (n ? ` Zmiany (${n}) zapiszę, gdy wróci internet.` : '');
}
const lostHtml = () => `<b>Ten telefon nie ma już dostępu do domu „${esc(house.name)}”.</b> Klucz domu zmieniono na innym telefonie albo dom usunięto. Otwórz nowy link zaproszenia od domownika.<div class="row" style="margin-top:8px"><button class="btn sm" data-act="ask-leave-lost">Opuść ten dom</button></div>`;
// Zmiany domowników: po zapisie wysyłamy sygnał na kanał domu, a pozostałe telefony sprawdzają wersje danych.
function subscribe() {
  chan = db.channel('dom-' + houseTag, { config: { broadcast: { self: false } } });
  chan.on('broadcast', { event: 'zmiana' }, syncSoon).subscribe();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
window.addEventListener('online', () => { netDown = false; netBanner(); sync(); });
window.addEventListener('offline', netBanner);
setInterval(() => { if (!document.hidden) sync(); }, 120000);
// Pierwsze uruchomienie po aktualizacji: dane z poprzedniej wersji aplikacji (localStorage) jako punkt startowy.
function oldCache() {
  const out = [];
  try {
    for (const k of Object.keys(localStorage).filter(k => k.startsWith('onz_cache_'))) {
      const t = k.slice(10); if (TABLES[t]) out.push({ t, data: JSON.parse(localStorage.getItem(k)) });
      localStorage.removeItem(k);
    }
  } catch { }
  return out;
}

/* ---------- RECIPES ---------- */
function reactFor(rid) { const rs = S.reactions.filter(x => x.recipe_id === rid); return { like: rs.filter(x => x.liked).map(x => x.member), want: rs.filter(x => x.wanted).map(x => x.member) }; }
function toggleReact(rid, field) {
  if (!ui.member) { toast('Najpierw wpisz swoje imię w ustawieniach (przycisk w prawym górnym rogu).'); return; }
  const cur = S.reactions.find(x => x.recipe_id === rid && x.member === ui.member) || { liked: false, wanted: false };
  const row = { recipe_id: rid, member: ui.member, liked: !!cur.liked, wanted: !!cur.wanted }; row[field] = !row[field];
  write({ t: 'reactions', kind: 'upsert', rows: [row] });
}
function renderCats() {
  const counts = {}; activeRecipes().forEach(r => counts[r.category] = (counts[r.category] || 0) + 1);
  $('#rcats').innerHTML = [['all', 'Wszystkie']].concat(CATEGORIES).map(([k, n]) => `<button class="chip" data-act="cat" data-k="${k}" aria-pressed="${ui.cat === k}">${n}${k !== 'all' && counts[k] ? ` <span style="opacity:.6">${counts[k]}</span>` : ''}</button>`).join('');
  $('#rfilters').innerHTML = `<button class="chip soft" data-act="only-freezer" aria-pressed="${ui.onlyFreezer}">❄ Do mrożenia</button>` + [['all', 'Wszystkie dania'], ['fav', '♥ Moje ulubione'], ['want', 'Zróbmy to'], ['promo', 'Z promocją'], ['new', 'Nowe']].map(([k, n]) => `<button class="chip soft" data-act="filter" data-k="${k}" aria-pressed="${ui.filter === k}">${n}</button>`).join('');
}
// największa obniżka z gazetek wśród produktów używanych w aktywnych przepisach
function bestDeal(all) {
  const uses = {}; for (const r of all) for (const pid of new Set((r.ingredients || []).map(i => i.pid))) uses[pid] = (uses[pid] || 0) + 1;
  let best = null;
  for (const pid of Object.keys(uses)) {
    const p = S.products[pid]; if (!p || p.pantry) continue;
    for (const s of SK) {
      const pr = L.priceOf(pid, s); if (!pr?.promo || !pr.regular || pr.regular <= pr.p) continue;
      const off = 1 - pr.p / pr.regular;
      if (off >= 0.15 && (!best || off > best.off)) best = { pid, p, s, pr, off, n: uses[pid] };
    }
  }
  return best;
}
function dealHtml(all) {
  const d = bestDeal(all); if (!d) return '';
  const unit = d.p.loose ? (d.p.unit === 'kg' ? '/kg' : d.p.unit === 'l' ? '/l' : '') : '';
  const pricePer = d.p.loose ? d.pr.p / (d.p.pack || 1) : d.pr.p;
  return `<button class="deal" data-act="deal" data-pid="${esc(d.pid)}"><span class="deal-ic"><svg viewBox="0 0 24 24"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg></span><span class="deal-t"><b>${esc(d.p.name)} ${zl(pricePer)}${unit} w ${SN[d.s] === 'Lidl' ? 'Lidlu' : SN[d.s] === 'Kaufland' ? 'Kauflandzie' : 'Biedronce'}</b><span>−${Math.round(d.off * 100)}%${d.pr.until ? ' · do ' + dPL(d.pr.until) : ''} · pasuje do ${d.n} ${d.n === 1 ? 'przepisu' : 'przepisów'}</span></span><svg class="deal-go" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button>`;
}
/* prośby o przepisy (realizuje je zaplanowane zadanie Claude) */
// statusy jak w bazie (recipe_requests_status_check)
const REQ_ST = { czeka: ['muted', 'czeka w kolejce'], w_trakcie: ['want', 'Claude szuka…'], gotowe: ['promo', 'gotowe'], blad: ['muted', 'nie udało się'] };
function readyHtml() {
  const seen = lsGet('seenReq', []), fresh = (S.recipe_requests || []).filter(r => r.status === 'gotowe' && !seen.includes(r.id) && (r.recipe_ids || []).some(id => S.recipes[id]));
  if (!fresh.length) return '';
  return fresh.slice(0, 2).map(r => { const n = r.recipe_ids.filter(id => S.recipes[id]).length;
    return `<button class="deal ready" data-act="req-show" data-id="${esc(r.id)}"><span class="deal-ic"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span><span class="deal-t"><b>Gotowe: ${esc(r.query)}</b><span>${n} ${n === 1 ? 'nowy przepis' : n < 5 ? 'nowe przepisy' : 'nowych przepisów'} w bazie · stuknij, żeby zobaczyć</span></span><svg class="deal-go" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button>`; }).join('');
}
function askSheet() {
  const st = ui.sheet, reqs = S.recipe_requests || [];
  return `<div class="sheet-head"><div><h2>Brakuje przepisu?</h2><div class="sub" style="margin-top:4px">Wpisz danie, na które macie ochotę. Claude kilka razy dziennie przegląda prośby, szuka sprawdzonych przepisów i dopisuje 2–3 wersje do bazy. Zwykle trwa to do kilku godzin.</div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  <form id="f-ask" class="row" style="flex-wrap:nowrap"><input class="input" id="ask-q" maxlength="80" placeholder="np. burrito, kurczak tikka masala" value="${esc(st.q || '')}" autocomplete="off"><button class="btn pri" type="submit">Poproś</button></form>
  <div class="sub">Dom może mieć naraz najwyżej 3 oczekujące prośby.</div>
  <div class="sec"><h4>Wasze prośby</h4>${reqs.length ? `<div class="grp">${reqs.map(r => { const [cls, lbl] = REQ_ST[r.status] || REQ_ST.czeka, got = (r.recipe_ids || []).filter(id => S.recipes[id]);
    return `<div class="req"><div class="nm"><b>${esc(r.query)}</b><small>${esc(r.member || '')}${r.member ? ' · ' : ''}${new Date(r.created_at).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })}${r.note ? ' · ' + esc(r.note) : ''}</small>${got.length ? `<div class="req-r">${got.map(id => `<button class="chip" data-act="open" data-id="${esc(id)}">${esc(S.recipes[id].name)}</button>`).join('')}</div>` : ''}</div><div class="req-s"><span class="pill ${cls}">${lbl}</span>${r.status === 'czeka' ? `<button class="btn sm ghost" data-act="req-del" data-id="${esc(r.id)}" aria-label="Usuń prośbę">Usuń</button>` : ''}</div></div>`; }).join('')}</div>` : '<div class="sub">Na razie nic. Prośby całego domu pojawią się tutaj.</div>'}</div>`;
}
async function sendAsk() {
  // baza przyjmuje 2–80 znaków, bez < > { } i znaków nowej linii
  const q = $('#ask-q').value.replace(/[<>{}\r\n\t]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 80); if (q.length < 2) return;
  if ((S.recipe_requests || []).some(r => ['czeka', 'w_trakcie'].includes(r.status) && r.query.toLowerCase() === q.toLowerCase())) { toast('Ta prośba już czeka'); return; }
  if (!navigator.onLine) { toast('Prośbę wyślesz, gdy wróci internet.'); return; }
  if (await w(() => db.from('recipe_requests').insert({ query: q, member: ui.member || null }), `Wysłano prośbę: ${q}`)) { ui.sheet.q = ''; ping(['recipe_requests']); await sync(); drawSheet(); }
}
let rObserver = null, rKey = '', rShown = 24;
function renderRecipes() {
  const box = $('#rlist'); const all = activeRecipes();
  $('#rcount').textContent = all.length ? `${all.length} dań · ${all.filter(r => r.freezer !== false).length} do mrożenia` : 'Przepisy na obiady';
  if (!all.length) { box.innerHTML = S.loaded.recipes ? `<div class="empty"><h3>Nie ma jeszcze przepisów</h3><div>Baza przepisów jeszcze się wczytuje. Zajrzyj za kilka minut.</div></div>` : `<div class="empty"><span class="spin"></span>Wczytuję przepisy…</div>`; return; }
  const q = ui.q.trim().toLowerCase(), week = Date.now() - 7 * 864e5;
  let list = all.map(r => ({ ...r, c: costOf(r), re: reactFor(r.id), isNew: ui.justAdded.has(r.id) || (S.hh[r.id]?.activated_at && new Date(S.hh[r.id].activated_at).getTime() > week) || (r.source === 'claude' && r.added_on && new Date(r.added_on).getTime() > week) }))
    .filter(r => {
      if (ui.cat !== 'all' && r.category !== ui.cat) return false;
      if (ui.onlyFreezer && r.freezer === false) return false;
      if (q) { const hay = (r.name + ' ' + (r.ingredients || []).map(i => S.products[i.pid]?.name || '').join(' ')).toLowerCase(); if (!hay.includes(q)) return false; }
      if (ui.filter === 'fav') return r.re.like.includes(ui.member);
      if (ui.filter === 'want') return r.re.want.length > 0;
      if (ui.filter === 'promo') return r.c.promos.length > 0;
      if (ui.filter === 'new') return r.isNew;
      return true;
    });
  list.sort((a, b) => (b.isNew && ui.justAdded.has(b.id)) - (a.isNew && ui.justAdded.has(a.id)) || b.re.want.length - a.re.want.length || new Set(b.c.promos.map(x => x.pid)).size - new Set(a.c.promos.map(x => x.pid)).size || a.name.localeCompare(b.name, 'pl'));
  const deal = (ui.q ? '' : dealHtml(all)) + readyHtml();
  if (!list.length) { box.innerHTML = deal + `<div class="empty"><h3>Nic tu nie pasuje</h3><div>${ui.q ? `Nie mamy jeszcze przepisu na „${esc(ui.q)}”. Poproś, a Claude poszuka przepisów i dopisze je do bazy.` : 'Zmień filtr, kategorię albo wyszukiwanie.'}</div>${ui.q ? `<button class="btn pri" data-act="ask" data-q="${esc(ui.q)}">Poproś o „${esc(ui.q)}”</button>` : ''}</div>`; return; }
  // karty dokładamy partiami przy przewijaniu: pierwsze 24 od razu, kolejne gdy użytkownik dojedzie do końca
  const card = r => {
    const best = SK.filter(s => !r.c.miss[s]).sort((a, b) => r.c.tot[a] - r.c.tot[b])[0];
    const nPromo = new Set(r.c.promos.map(x => x.pid)).size, liked = r.re.like.includes(ui.member);
    return `<div class="card" role="button" tabindex="0" data-act="open" data-id="${esc(r.id)}">
      <span class="tape">${esc(CATN[r.category] || r.category)} · ${r.freezer === false ? 'na bieżąco' : `mroź do ${r.freeze_months || 3} mies.`}</span>
      <button class="heart ${liked ? 'on' : ''}" data-act="like" data-id="${esc(r.id)}" aria-label="Ulubione">${liked ? HEART : HEART_O}</button>
      <h3 style="padding-right:30px">${esc(r.name)}</h3>
      <div class="meta">${r.isNew ? '<span class="pill new">Nowe</span>' : ''}${nPromo ? `<span class="pill promo">${nPromo} w promocji</span>` : ''}${r.re.want.length ? `<span class="pill want">Zróbmy to ${faces(r.re.want)}</span>` : ''}${r.re.like.length ? `<span class="pill muted">♥ ${faces(r.re.like)}</span>` : ''}<span>${r.minutes || '?'} min · z: ${esc(r.sides || 'dowolne dodatki')}</span></div>
      <div class="price-line"><span class="sub">porcja od</span><span><b class="num">${zl(r.c.mix / 2)}</b>${best ? ` <span class="sub">· najtaniej <span class="store ${best}">${SN[best]}</span></span>` : ''}</span></div>
    </div>`;
  };
  // przy odświeżeniu danych zostaje tyle kart, ile było widać; nowy filtr lub wyszukiwanie zaczyna od 24
  const fkey = [ui.cat, ui.filter, ui.onlyFreezer, ui.q].join('|'); if (fkey !== rKey) { rKey = fkey; rShown = 24; }
  let shown = Math.min(list.length, Math.max(24, rShown));
  const more = () => list.length > shown ? `<div class="rmore" id="rmore"><span class="spin"></span> Wczytuję kolejne przepisy…</div>` : (ui.q ? `<div class="empty" style="margin-top:12px"><div>Szukasz innej wersji? Claude dopisze kilka przepisów na „${esc(ui.q)}”.</div><button class="btn sm" data-act="ask" data-q="${esc(ui.q)}">Poproś o więcej</button></div>` : '');
  box.innerHTML = deal + '<div class="cards">' + list.slice(0, shown).map(card).join('') + '</div>' + more();
  rObserver?.disconnect();
  const watch = () => { const el = $('#rmore'); if (!el) return; rObserver = new IntersectionObserver(es => { if (!es.some(e => e.isIntersecting)) return; rObserver.disconnect();
    const next = list.slice(shown, shown + 24); shown += next.length; rShown = shown; box.querySelector('.cards').insertAdjacentHTML('beforeend', next.map(card).join(''));
    el.outerHTML = more(); watch(); }, { rootMargin: '600px' }); rObserver.observe(el); };
  watch();
}

function recipeSheet() {
  const r = S.recipes[ui.sheet.id]; if (!r) return closeSheet();
  return `<div class="sheet-head"><div><h2>${esc(r.name)}</h2><div class="meta" style="margin-top:6px"><span>${esc(CATN[r.category] || '')}</span><span>${r.minutes || '?'} min</span><span>${r.freezer === false ? 'najlepsze na świeżo' : `mrożenie do ${r.freeze_months || 3} mies.`}</span><span>z: ${esc(r.sides || 'dowolne dodatki')}</span></div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  ${r.inspired_by ? `<div class="sub">Inspiracja: ${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">${esc(r.inspired_by)} ↗</a>` : esc(r.inspired_by)}</div>` : ''}
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
  ${r.thaw ? `<div class="sec"><h4>${r.freezer === false ? 'Przechowywanie' : 'Mrożenie i odgrzewanie'}</h4><div class="box">${esc(r.thaw)}</div></div>` : ''}
  <div>${ui.sheet.confirmDel ? `<div class="row"><span class="sub">Usunąć to danie z Waszych przepisów?</span><button class="btn sm danger" data-act="del-recipe">Tak, usuń</button><button class="btn sm" data-act="cancel-del">Anuluj</button></div>` : `<button class="btn sm ghost danger" data-act="ask-del">Usuń przepis</button>`}</div>`;
}
function addRecipeToList() {
  const r = S.recipes[ui.sheet.id], n = ui.portions, m = n / (r.base || 2), batch = r.id + '-' + Date.now();
  const rows = (r.ingredients || []).map(i => { const p = S.products[i.pid]; if (!p) return null; return { id: newId(), product_id: i.pid, qty: L.needOf(i, m, p) ?? 0, pantry: !!p.pantry, recipe_id: r.id, recipe_name: r.name, servings: n, batch, member: ui.member || null }; }).filter(Boolean);
  closeSheet();
  write({ t: 'list_items', kind: 'insert', rows }, `Dodano ${r.name} (${n} porcji) do listy`);
}

/* ---------- LIST ---------- */
// liczba rzeczy do kupienia na zakładce „Lista” (widoczna z każdego widoku)
function renderBadge() {
  const { rows, manual } = L.aggList(), left = rows.filter(g => !g.done).length + manual.filter(m => !m.done).length;
  const b = $('#lbadge'); b.hidden = !left; b.textContent = left;
}
function renderList() {
  const box = $('#llist'), { rows, pantry, manual } = L.aggList();
  renderBadge();
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
        return `<div class="item ${g.done ? 'done' : ''}"><button class="ck ${g.done ? 'on' : ''}" data-act="tick" data-pid="${esc(g.pid)}" aria-label="Kupione">${g.done ? CHECK : ''}</button><div class="nm"><b>${esc(g.p.name)}</b><small>${buyText(g.p, g.q)}${pr?.promo ? ` · <span style="color:var(--promo);font-weight:700">promocja${pr.until ? ' do ' + dPL(pr.until) : ''}</span>` : ''}${pr?.note ? ' · ' + esc(pr.note) : ''}</small><small>${esc([...g.srcs].join(', '))}</small>${g.docs.some(x => !x.recipe_id) ? `<span class="own"><button class="round sm" data-act="own-dec" data-pid="${esc(g.pid)}" aria-label="Mniej">−</button><button class="round sm" data-act="own-inc" data-pid="${esc(g.pid)}" aria-label="Więcej">+</button></span>` : ''}</div><div class="pr">${a ? zs(a.c) : ''}</div></div>`;
      }).join('')}</div>`;
    }
  }
  if (manual.length) h += `<div class="grp"><div class="grp-h"><h3>Inne</h3></div>${manual.sort((a, b) => a.done - b.done).map(m => `<div class="item ${m.done ? 'done' : ''}"><button class="ck ${m.done ? 'on' : ''}" data-act="tick-m" data-id="${esc(m.id)}" aria-label="Kupione">${m.done ? CHECK : ''}</button><div class="nm"><b>${esc(m.name || S.products[m.product_id]?.name || '?')}</b>${m.member ? `<small>dopisał(a): ${esc(m.member)}</small>` : ''}</div><div class="pr"><button class="btn sm ghost" data-act="del-item" data-id="${esc(m.id)}" aria-label="Usuń">✕</button></div></div>`).join('')}</div>`;
  if (pantry.length) h += `<div class="grp"><div class="grp-h"><h3>Sprawdź w domu</h3><span class="sub">przyprawy i zapasy</span></div>${pantry.map(g => `<div class="item ${g.done ? 'done' : ''}"><button class="ck ${g.done ? 'on' : ''}" data-act="tick" data-pid="${esc(g.pid)}" aria-label="Mam">${g.done ? CHECK : ''}</button><div class="nm"><b>${esc(g.p.name)}</b><small>${esc([...g.srcs].join(', '))}</small></div><div class="pr"></div></div>`).join('')}</div>`;
  box.innerHTML = h;
}
function tickGroup(pid) {
  const items = S.list_items.filter(x => x.product_id === pid && !x.manual); if (!items.length) return;
  const done = !items.every(d => d.done);
  write({ t: 'list_items', kind: 'update', values: { done }, match: { id: items.map(i => i.id) } });
}

/* ---------- FREEZER ---------- */
function renderFreezer() {
  const box = $('#flist'); const fs = [...S.freezer].sort((a, b) => (a.frozen_on || '').localeCompare(b.frozen_on || ''));
  const soonN = fs.filter(f => daysSince(f.frozen_on) > (S.recipes[f.recipe_id]?.freeze_months || 3) * 30 - 14).length;
  const totalP = fs.reduce((t, f) => t + (f.portions || 0), 0);
  $('#fstats').innerHTML = fs.length ? `<div class="tile"><b class="num">${num(totalP / 2, 0)}</b><span>obiadów</span></div><div class="tile"><b class="num">${fs.length}</b><span>${fs.length === 1 ? 'pudełko' : 'pudełek'}</span></div><div class="tile ${soonN ? 'hot' : ''}"><b class="num">${soonN}</b><span>zjeść wkrótce</span></div>` : '';
  $('#fsub').textContent = fs.length ? `Starczy na ok. ${num(totalP / 2, 0)} ${totalP / 2 >= 5 ? 'obiadów' : 'obiady'} dla 2 osób` : 'Najstarsze pudełka na górze';
  if (!fs.length) { box.innerHTML = `<div class="empty"><h3>Zamrażarka jest pusta</h3><div>Po ugotowaniu otwórz przepis i wybierz „Ugotowane → do zamrażarki”. Zobaczysz tu, ile porcji zostało i co zjeść najpierw.</div></div>`; return; }
  const total = fs.reduce((t, f) => t + (f.portions || 0), 0);
  box.innerHTML = `<div class="sub">Najstarsze na górze · razem ${total} porcji</div>` + fs.map(f => {
    const age = daysSince(f.frozen_on), lim = (S.recipes[f.recipe_id]?.freeze_months || 3) * 30, old = age > lim;
    return `<div class="fz"><span class="tape">${dPL(f.frozen_on)} · ${age} dni${old ? ' · zjedz szybko' : ''}</span><div><h3>${esc(f.name)}</h3><div class="sub ${old ? 'old' : ''}">${old ? 'Przekroczony zalecany czas mrożenia' : (lim - age < 7 ? 'Zjedz w tym tygodniu' : 'Dobre jeszcze ok. ' + Math.round((lim - age) / 7) + ' tyg.')}</div></div>
    <div class="n"><button class="round" data-act="fz-dec" data-id="${esc(f.id)}" aria-label="Wyjmij porcję">−</button><b class="num">${f.portions}</b><button class="round" data-act="fz-inc" data-id="${esc(f.id)}" aria-label="Dodaj porcję">+</button></div><div class="life ${old || lim - age < 14 ? 'old' : ''}"><i style="width:${Math.min(100, Math.round(age / lim * 100))}%"></i></div></div>`;
  }).join('');
}
function fzChange(id, d) {
  const f = S.freezer.find(x => x.id === id); if (!f) return; const n = Math.min(200, (f.portions || 0) + d);
  if (n <= 0) write({ t: 'freezer', kind: 'delete', match: { id } }, 'Pudełko zjedzone. Usunięto z zamrażarki.');
  else write({ t: 'freezer', kind: 'update', values: { portions: n }, match: { id } });
}

/* ---------- PRICES ---------- */
function renderStores() {
  const runs = S.scrape_runs || [];
  $('#pstores').innerHTML = `<div class="stores">${STORES.map(s => {
    const ok = runs.find(r => r.store === s.k && r.status === 'ok'), last = runs.find(r => r.store === s.k);
    // „ostrzezenie”: przebieg znalazł podejrzanie mało ofert, więc zostały poprzednie
    const err = last && last.status !== 'ok', warn = last?.status === 'ostrzezenie';
    return `<div class="st ${err ? 'err' : ''}"><b class="store ${s.k}">${s.n}</b>${ok ? `<span>gazetka ${dPL(ok.valid_from)}–${dPL(ok.valid_to)}</span><span>${ok.matched} produktów w promocji</span>` : '<span>jeszcze nie pobrano</span>'}${warn ? `<span class="old">ostatnio mniej ofert niż zwykle, pokazuję poprzednie</span>` : err ? `<span class="old">ostatnia próba: błąd</span>` : last ? `<span>pobrano ${new Date(last.ran_at).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })}</span>` : ''}</div>`;
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
  let h = `<div class="sub">Czerwone ceny pochodzą z aktualnych ofert sklepów. „Gazetka” to cena regularna przekreślona w ostatniej gazetce, a „szac.” to cena orientacyjna: stuknij, żeby wpisać prawdziwą. Wpisane ceny widzi tylko Wasz dom.</div><div class="ptable"><div class="prow head"><span>Produkt</span>${STORES.map(s => `<span class="store ${s.k}" style="text-align:center">${s.n}</span>`).join('')}</div>`;
  const cats = [...new Set([...PCATS, ...priced.map(p => p.cat || 'inne')])];
  for (const c of cats) {
    const ps = priced.filter(p => (p.cat || 'inne') === c).sort((a, b) => a.name.localeCompare(b.name, 'pl')); if (!ps.length) continue;
    h += `<div class="prow cat">${esc(c)}</div>` + ps.map(p => {
      const vals = SK.map(s => L.priceOf(p.id, s)), have = vals.filter(Boolean), min = Math.min(...have.map(v => v.p));
      return `<div class="prow"><div class="nm">${esc(p.name)}<small>${p.loose ? 'za kg' : fmtPack(p)}</small></div>${SK.map((s, i) => {
        const v = vals[i];
        const cls = !v ? 'none' : v.promo ? 'promo' : (v.p === min && have.length > 1 ? 'cheap' : '');
        const tag = !v ? '' : v.promo ? (v.until ? 'do ' + dPL(v.until) : 'promo') : v.src === 'paragon' ? 'paragon' : v.own ? 'Wasza' : v.rsrc === 'gazetka' ? 'gazetka' : 'szac.';
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
   <button class="btn pri" type="submit">Zapisz cenę</button></form>
  ${historyHtml(pid)}`;
}
function savePrice() {
  const { pid, s } = ui.sheet, v = L.parsePL($('#pp').value); if (v == null || !(v > 0 && v < 10000)) return toast('Wpisz cenę, np. 6,99');
  closeSheet();
  write({ t: 'hh_prices', kind: 'upsert', rows: [{ product_id: pid, store: s, regular: v, src: 'ręcznie', seen_on: L.today(), updated_at: new Date().toISOString() }] }, 'Zapisano cenę');
}

/* ---------- WYDATKI: paragony, budżet, analizy ---------- */
const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const shiftMonth = (m, d) => { const [y, mo] = m.split('-').map(Number); const t = new Date(y, mo - 1 + d, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
const monthName = m => { const [y, mo] = m.split('-').map(Number); return `${MONTHS[mo - 1]} ${y}`; };
const STORE_OPTS = Object.entries(RC.STORE_NAMES);
const paragonow = n => `${n} ${n === 1 ? 'paragon' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'paragony' : 'paragonów'}`;
const CAT_NAMES = ['Mięso i ryby', 'Nabiał', 'Warzywa i owoce', 'Pieczywo', 'Spiżarnia', 'Napoje', 'Słodycze i przekąski', 'Alkohol', 'Chemia i higiena', 'Inne'];
const bars = (rows, max) => `<div class="bars">${rows.map(([n, v, cls]) => `<div class="bar"><span class="${cls || ''}">${esc(n)}</span><b>${zs(v)} zł</b><span class="t"><i style="width:${Math.max(2, Math.round(v / max * 100))}%"></i></span></div>`).join('')}</div>`;

function renderSpend() {
  const box = $('#wlist'); if (!box) return;
  const recs = S.receipts.filter(r => (r.bought_on || '').startsWith(ui.month));
  const spent = recs.reduce((t, r) => t + +r.total, 0), budget = +S.settings.budget || 0;
  { const [y, mo] = ui.month.split('-').map(Number), last = new Date(y, mo, 0).getDate();
    const wk = [[1, 7], [8, 14], [15, 21], [22, last]].map(([a, b]) => ({ a, b, v: recs.filter(r => { const d = +String(r.bought_on).slice(8, 10); return d >= a && d <= b; }).reduce((t, r) => t + +r.total, 0) }));
    const mx = Math.max(...wk.map(x => x.v), 1), tdy = today(), cur = tdy.startsWith(ui.month) ? +tdy.slice(8, 10) : 0;
    $('#wchart').innerHTML = recs.length ? wk.map(x => `<div class="wk ${cur >= x.a && cur <= x.b ? 'now' : ''}"><small class="num">${x.v ? Math.round(x.v) + ' zł' : ''}</small><i style="height:${Math.max(4, Math.round(x.v / mx * 64))}px"></i><span>${x.a}–${x.b}</span></div>`).join('') : '';
    $('#wsub').textContent = recs.length ? `${monthName(ui.month)} · ${zl(spent)}` : 'Z paragonów Waszego domu'; }
  let h = `<div class="month"><button data-act="month" data-d="-1" aria-label="Poprzedni miesiąc">‹</button><b>${monthName(ui.month)}</b><button data-act="month" data-d="1" aria-label="Następny miesiąc">›</button></div>`;
  const pct = budget ? spent / budget : 0;
  h += `<div class="budget"><div class="row" style="justify-content:space-between;align-items:baseline"><span class="big num">${zl(spent)}</span><button class="btn sm" data-act="budget">${budget ? 'Budżet ' + zs(budget) + ' zł' : 'Ustaw budżet'}</button></div>
    ${budget ? `<div class="meter ${pct > 1 ? 'over' : pct > 0.85 ? 'warn' : ''}"><i style="width:${Math.min(100, pct * 100)}%"></i></div><div class="sub">${pct > 1 ? `Budżet przekroczony o ${zl(spent - budget)}` : `Zostało ${zl(budget - spent)}`} · ${paragonow(recs.length)}</div>` : `<div class="sub">${paragonow(recs.length)} w tym miesiącu</div>`}</div>`;
  if (!S.receipts.length) {
    h += `<div class="empty"><h3>Dodaj pierwszy paragon</h3><div>W aplikacji Lidl Plus albo Moja Biedronka otwórz e-paragon i zrób zrzut ekranu. Długi paragon możesz uchwycić w kilku zrzutach. Możesz też zapisać paragon jako PDF albo sfotografować papierowy.</div><label class="btn pri" for="rfile">+ Paragon</label><div class="sub">Paragon odczytuje telefon. Zdjęcia nie są nigdzie wysyłane.</div></div>`;
    box.innerHTML = h; return;
  }
  if (recs.length) {
    const byStore = {}; recs.forEach(r => byStore[r.store_name] = (byStore[r.store_name] || 0) + +r.total);
    const ids = new Set(recs.map(r => r.id)), byCat = {};
    S.receipt_items.filter(i => ids.has(i.receipt_id)).forEach(i => byCat[i.category || 'Inne'] = (byCat[i.category || 'Inne'] || 0) + +i.total);
    const ss = Object.entries(byStore).sort((a, b) => b[1] - a[1]), cs = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const codeOf = Object.fromEntries(STORE_OPTS.map(([k, n]) => [n, k]));
    h += `<div class="sec"><h4>Sklepy</h4><div class="box">${bars(ss.map(([n, v]) => [n, v, 'store ' + (codeOf[n] || '')]), ss[0][1])}</div></div>`;
    if (cs.length) h += `<div class="sec"><h4>Kategorie</h4><div class="box">${bars(cs, cs[0][1])}</div></div>`;
  }
  h += `<div class="grp"><div class="grp-h"><h3>Paragony</h3><span class="sub">${recs.length ? monthName(ui.month) : 'brak w tym miesiącu'}</span></div>${recs.map(r => {
    const n = S.receipt_items.filter(i => i.receipt_id === r.id).length;
    return `<button class="rc" data-act="open-receipt" data-id="${esc(r.id)}"><span class="d">${dPL(r.bought_on)}</span><span><span class="store ${esc(r.store)}">${esc(r.store_name)}</span><span class="sub"> · ${n} poz.${r.member ? ' · ' + esc(r.member) : ''}</span></span><b>${zs(+r.total)}</b></button>`;
  }).join('')}</div>`;
  box.innerHTML = h;
}

function budgetSheet() {
  return `<div class="sheet-head"><div><h2>Budżet na zakupy</h2><div class="sub" style="margin-top:4px">Miesięczny limit dla całego domu</div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  <form id="f-budget" class="sec" style="gap:12px"><div class="field"><label for="b-val">Kwota na miesiąc (zł)</label><input class="input" id="b-val" inputmode="decimal" value="${S.settings.budget ? String(S.settings.budget).replace('.', ',') : ''}" placeholder="np. 1500"></div>
  <button class="btn pri" type="submit">Zapisz</button></form>`;
}
function saveBudget() {
  const v = L.parsePL($('#b-val').value);
  if (v != null && !(v >= 0 && v < 1000000)) return toast('Wpisz kwotę mniejszą niż milion zł.');
  closeSheet();
  write({ t: 'hh_settings', kind: 'upsert', rows: [{ budget: v }] }, 'Zapisano budżet');
}

// Odczyt wybranych plików: PDF → tekst; zdjęcia/zrzuty → OCR w telefonie. Kilka zrzutów = jeden paragon.
async function importReceipt(files) {
  setTab('wydatki');
  ui.sheet = { type: 'rimport', busy: true, progress: 0, msg: 'Wczytuję narzędzia do odczytu…' }; drawSheet();
  try {
    const texts = [];
    for (const [i, f] of files.entries()) {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) { ui.sheet.msg = 'Czytam PDF…'; drawSheet(); texts.push(await RC.pdfText(f, p => { if (ui.sheet?.type !== 'rimport') return; ui.sheet.msg = 'Rozpoznaję tekst z PDF…'; const b = $('#rprog'); if (b) b.style.width = Math.round(p * 100) + '%'; else drawSheet(); })); }
      else {
        ui.sheet.msg = files.length > 1 ? `Rozpoznaję tekst (${i + 1} z ${files.length})…` : 'Rozpoznaję tekst…'; drawSheet();
        texts.push(await RC.imageText(f, p => { if (ui.sheet?.type !== 'rimport') return; ui.sheet.progress = (i + p) / files.length; const b = $('#rprog'); if (b) b.style.width = Math.round(ui.sheet.progress * 100) + '%'; }));
      }
    }
    const text = files.length > 1 ? RC.joinShots(texts) : texts.join('\n');
    const r = RC.parseReceipt(text, L.today());
    const catalog = Object.values(S.products).filter(p => !p.pantry);
    r.items.forEach(it => { const p = RC.matchProduct(it.name, catalog); it.product_id = p?.id || null; it.category = RC.categoryOf(it.name, p); });
    ui.sheet = { type: 'rimport', draft: r, text, source: files.some(f => /pdf/i.test(f.type)) ? 'pdf' : 'zdjęcie' };
  } catch (e) {
    console.error(e);
    ui.sheet = { type: 'rimport', error: navigator.onLine ? 'Nie udało się odczytać paragonu. Spróbuj wyraźniejszego zrzutu albo pliku PDF.' : 'Do pierwszego odczytu potrzebny jest internet (telefon pobiera narzędzie do rozpoznawania tekstu).' };
  }
  drawSheet();
}
function readForm() {
  const d = ui.sheet?.draft; if (!d || !$('#r-store')) return;
  d.store = $('#r-store').value; d.store_name = RC.STORE_NAMES[d.store] || d.store_name; d.bought_on = $('#r-date').value || d.bought_on; d.total = L.parsePL($('#r-total').value) ?? d.total;
  d.items.forEach((it, i) => { const n = $('#ri-n' + i), v = $('#ri-v' + i), c = $('#ri-c' + i); if (n) it.name = n.value; if (v) it.total = L.parsePL(v.value) ?? 0; if (c) it.category = c.value; });
}
function importSheet() {
  const st = ui.sheet;
  const head = t => `<div class="sheet-head"><div><h2>${t}</h2></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>`;
  if (st.error) return head('Paragon') + `<div class="banner">${esc(st.error)}</div><label class="btn pri" for="rfile">Wybierz inny plik</label>`;
  if (st.busy) return head('Odczytuję paragon') + `<div class="sec"><div class="sub">${esc(st.msg)}</div><div class="prog"><i id="rprog" style="width:${Math.round((st.progress || 0) * 100)}%"></i></div><div class="sub">Pierwszy odczyt zdjęcia trwa dłużej: telefon pobiera narzędzie do rozpoznawania polskiego tekstu (ok. 2 MB).</div></div>`;
  const d = st.draft, sum = d.items.reduce((t, i) => t + (+i.total || 0), 0);
  const dup = S.receipts.find(r => r.store === d.store && r.bought_on === d.bought_on && Math.abs(+r.total - +d.total) < 0.01);
  const diff = Math.abs(sum - (+d.total || 0));
  return head('Sprawdź paragon') + `
  <div class="sub">Popraw, jeśli coś się nie zgadza, i zapisz.${d.items.some(i => i.product_id) ? ' Ceny produktów z przepisów trafią do Waszych cen.' : ''}</div>
  <div class="grid2"><div class="field"><label for="r-store">Sklep</label><select class="input" id="r-store">${STORE_OPTS.map(([k, n]) => `<option value="${k}" ${k === d.store ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
  <div class="field"><label for="r-date">Data</label><input class="input" id="r-date" type="date" value="${esc(d.bought_on || '')}"></div></div>
  <div class="field"><label for="r-total">Do zapłaty (zł)</label><input class="input" id="r-total" inputmode="decimal" value="${String(d.total ?? '').replace('.', ',')}"></div>
  ${dup ? `<div class="warnbox">Ten paragon chyba już jest: ${esc(dup.store_name)}, ${dPL(dup.bought_on)}, ${zs(+dup.total)} zł.</div>` : ''}
  ${!d.items.length ? `<div class="warnbox">Nie rozpoznałem pozycji. Możesz dopisać je ręcznie albo spróbować wyraźniejszego zrzutu.</div>` : diff > 0.05 ? `<div class="warnbox">Suma pozycji (${zs(sum)} zł) różni się od kwoty do zapłaty o ${zs(diff)} zł. Sprawdź ceny poniżej.</div>` : `<div class="sub" style="color:var(--good)">✓ Suma pozycji zgadza się z paragonem</div>`}
  <div class="box" style="padding-block:4px">${d.items.map((it, i) => {
    const p = S.products[it.product_id];
    return `<div class="ri"><input class="input" id="ri-n${i}" value="${esc(it.name)}" aria-label="Nazwa"><input class="input num" id="ri-v${i}" inputmode="decimal" value="${String(it.total).replace('.', ',')}" aria-label="Kwota"><button class="x" data-act="ri-del" data-i="${i}" aria-label="Usuń pozycję">✕</button>
      <div class="meta">${it.qty !== 1 ? `<span>${num(it.qty, 3)} ${it.weighed ? 'kg' : 'szt.'} × ${zs(it.unit_price)}</span>` : ''}${it.discount ? `<span style="color:var(--promo)">rabat ${zs(it.discount)}</span>` : ''}${p ? `<span class="pill want">${esc(p.name)}</span>` : ''}<select class="input" id="ri-c${i}" aria-label="Kategoria">${CAT_NAMES.map(c => `<option ${c === it.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>`;
  }).join('')}</div>
  <button class="btn sm ghost" data-act="ri-add" style="align-self:flex-start">+ Dodaj pozycję</button>
  <button class="btn pri" data-act="save-receipt">Zapisz paragon</button>
  <details><summary class="sub">Odczytany tekst</summary><pre class="sub" style="white-space:pre-wrap;font-size:11.5px">${esc(st.text || '')}</pre></details>`;
}
async function saveReceipt() {
  readForm(); const d = ui.sheet.draft, src = ui.sheet.source;
  if (!d.bought_on) return toast('Wpisz datę zakupów.');
  if (!(+d.total > 0)) return toast('Wpisz kwotę do zapłaty.');
  if (!(+d.total < 100000)) return toast('Kwota do zapłaty wygląda na błędną.');
  const id = newId();
  const items = d.items.filter(i => i.name.trim() && +i.total > 0 && +i.total < 100000).map(i => ({ id: newId(), receipt_id: id, name: i.name.trim().slice(0, 120), qty: +i.qty > 0 && +i.qty < 10000 ? +i.qty : 1, weighed: !!i.weighed, unit_price: i.unit_price ?? null, total: +i.total, discount: +i.discount > 0 ? +i.discount : 0, product_id: i.product_id || null, category: (i.category || 'Inne').slice(0, 40) }));
  // prawdziwe ceny regularne (bez rabatu) dla produktów z katalogu w Biedronce, Lidlu i Kauflandzie
  const prices = [];
  if (SK.includes(d.store)) for (const i of items) {
    const p = S.products[i.product_id]; if (!p) continue;
    const ref = SK.map(s => S.prices[p.id]?.[s]?.regular).filter(Boolean).map(Number), avg = ref.length ? ref.reduce((a, b) => a + b) / ref.length : null;
    const v = RC.packPrice({ ...i, discount: 0 }, p, avg); if (v == null) continue;
    const cur = S.hhp[p.id]?.[d.store];
    if (cur?.seen_on && cur.seen_on > d.bought_on) continue;
    if (!prices.some(x => x.product_id === p.id)) prices.push({ product_id: p.id, store: d.store, regular: v, src: 'paragon', seen_on: d.bought_on, updated_at: new Date().toISOString() });
  }
  // trzy zapisy w kolejności (paragon, pozycje, ceny); bez internetu czekają w telefonie
  const ops = [{ t: 'receipts', kind: 'insert', rows: [{ id, store: String(d.store).slice(0, 10), store_name: String(RC.STORE_NAMES[d.store] || d.store_name || 'Inny sklep').slice(0, 60), bought_on: d.bought_on, total: +d.total, source: src, member: ui.member || null }] }];
  if (items.length) ops.push({ t: 'receipt_items', kind: 'insert', rows: items });
  if (prices.length) ops.push({ t: 'hh_prices', kind: 'upsert', rows: prices });
  ui.month = d.bought_on.slice(0, 7); closeSheet();
  write(ops, `Zapisano paragon${prices.length ? ` · zaktualizowano ${prices.length} cen` : ''}`);
}
function receiptSheet() {
  const r = S.receipts.find(x => x.id === ui.sheet.id); if (!r) return closeSheet();
  const items = S.receipt_items.filter(i => i.receipt_id === r.id);
  return `<div class="sheet-head"><div><h2>${esc(r.store_name)} · ${zs(+r.total)} zł</h2><div class="sub" style="margin-top:4px">${dPL(r.bought_on)}.${r.bought_on.slice(0, 4)}${r.member ? ' · dodał(a): ' + esc(r.member) : ''}</div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  <div class="box" style="padding-block:4px"><ul class="ing">${items.map(i => `<li><span class="nm">${esc(i.name)}<small>${esc(i.category || 'Inne')}${+i.qty !== 1 ? ` · ${num(+i.qty, 3)} ${i.weighed ? 'kg' : 'szt.'} × ${zs(+i.unit_price)}` : ''}${+i.discount ? ` · rabat ${zs(+i.discount)}` : ''}</small></span><span class="q">${zs(+i.total)}</span></li>`).join('') || '<li class="sub">Brak pozycji</li>'}</ul></div>
  ${ui.sheet.confirmDel ? `<div class="row"><span class="sub">Usunąć ten paragon?</span><button class="btn sm danger" data-act="del-receipt">Tak, usuń</button></div>` : `<button class="btn sm ghost danger" data-act="ask-del-receipt" style="align-self:flex-start">Usuń paragon</button>`}`;
}
// Historia cen produktu z Waszych paragonów (w okienku ceny).
function historyHtml(pid) {
  const rec = Object.fromEntries(S.receipts.map(r => [r.id, r]));
  const rows = S.receipt_items.filter(i => i.product_id === pid && rec[i.receipt_id]).map(i => ({ i, r: rec[i.receipt_id] })).sort((a, b) => b.r.bought_on.localeCompare(a.r.bought_on)).slice(0, 12);
  if (!rows.length) return '';
  return `<div class="sec"><h4>Wasze zakupy</h4><div class="box" style="padding-block:4px"><ul class="ing">${rows.map(({ i, r }) => `<li><span class="nm">${dPL(r.bought_on)} · <span class="store ${esc(r.store)}">${esc(r.store_name)}</span><small>${esc(i.name)}</small></span><span class="q">${+i.qty !== 1 ? zs(+i.unit_price) + (i.weighed ? '/kg' : '/szt.') : zs(+i.total) + ' zł'}</span></li>`).join('')}</ul></div></div>`;
}

/* ---------- sheet & routing ---------- */
function drawSheet() {
  const st = ui.sheet, el = $('#sheet'), inn = $('#sheet-in'); if (!st) { el.hidden = true; return; }
  const html = st.type === 'recipe' ? recipeSheet() : st.type === 'price' ? priceSheet() : st.type === 'look' ? lookSheet() : st.type === 'ask' ? askSheet() : st.type === 'rimport' ? importSheet() : st.type === 'receipt' ? receiptSheet() : st.type === 'budget' ? budgetSheet() : whoSheet();
  if (!ui.sheet) return; inn.innerHTML = html; el.hidden = false; document.body.style.overflow = 'hidden';
  if (st.type === 'recipe') drawRecipeDyn();
}
function whoSheet() {
  const st = ui.sheet;
  return `<div class="sheet-head"><div><h2>${esc(house.name)}</h2><div class="sub" style="margin-top:4px">Ustawienia domu i zaproszenia</div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  <div class="sec"><h4>Zaproś domownika</h4><div class="box sub">Wyślij link osobie, z którą dzielisz kuchnię. Zobaczy Waszą listę zakupów, zamrażarkę i ulubione. Znajomemu z innego domu wyślij zwykły adres aplikacji, żeby założył własny dom.</div>
   <div class="row"><button class="btn pri" type="button" data-act="invite" style="flex:1">Wyślij zaproszenie</button><button class="btn" type="button" data-act="share-app">Adres dla znajomego</button></div></div>
  <form id="f-who" class="sec" style="gap:12px"><h4>Ty i Twój dom</h4>
   <div class="field"><label for="w-name">Twoje imię (widoczne dla domowników)</label><input class="input" id="w-name" value="${esc(ui.member)}" autocomplete="given-name" maxlength="40"></div>
   <div class="field"><label for="w-house">Nazwa domu</label><input class="input" id="w-house" value="${esc(house.name)}" maxlength="60"></div>
   <button class="btn pri" type="submit">Zapisz</button></form>
  ${knownHtml(house.key, 'who')}
  <div class="sec"><h4>Klucz domu</h4><div class="box sub">Link zaproszenia działa jak klucz: kto go ma, widzi dane domu. Jeśli trafił do niewłaściwej osoby, zmień klucz. Stare linki przestaną działać, a domownicy muszą dostać nowy link.</div>
   ${st.rotated ? `<div class="banner">Klucz zmieniony. Wyślij domownikom nowy link zaproszenia.</div>` : ''}
   ${st.confirmRotate ? `<div class="row"><button class="btn danger" type="button" data-act="rotate">Tak, zmień klucz</button><button class="btn" type="button" data-act="cancel-rotate">Anuluj</button></div>` : `<button class="btn ghost" type="button" data-act="ask-rotate" style="align-self:flex-start">Zmień klucz domu</button>`}</div>
  <div class="sec"><h4>Dane domu</h4><div class="box sub">Kopia listy zakupów, zamrażarki, paragonów, cen i ustawień domu w pliku JSON.</div>
   <button class="btn ghost" type="button" data-act="export" style="align-self:flex-start">Pobierz dane domu</button></div>
  <div class="sec"><h4>Ten telefon</h4>${st.confirmLeave ? `<div class="banner">Ten telefon przestanie widzieć dane domu. Wrócisz do niego tylko z linkiem zaproszenia od domownika.${pendingOps.some(o => o.key === house.key) ? ' Uwaga: część zmian nie została jeszcze wysłana i przepadnie.' : ''}</div><div class="row"><button class="btn danger" type="button" data-act="leave">Tak, opuść dom</button><button class="btn" type="button" data-act="cancel-leave">Anuluj</button></div>` : `<button class="btn ghost danger" type="button" data-act="ask-leave">Opuść dom na tym telefonie</button>`}</div>
  <div class="sec"><h4>Usunięcie domu</h4>${st.confirmDelete ? `<div class="banner">Z serwera znikną lista zakupów, zamrażarka, paragony, ceny, prośby i ustawienia domu, a wszyscy domownicy stracą do niego dostęp. Tego nie da się cofnąć.</div><div class="row"><button class="btn danger" type="button" data-act="delete-house">Tak, usuń dom i dane</button><button class="btn" type="button" data-act="cancel-delete">Anuluj</button></div>` : `<button class="btn ghost danger" type="button" data-act="ask-delete" style="align-self:flex-start">Usuń dom i wszystkie jego dane</button>`}</div>`;
}
/* domy zapamiętane na tym telefonie (zaproszenie do innego domu nie kasuje poprzedniego) */
const knownHouses = () => (lsGet('houses', []) || []).filter(h => keyFrom(h?.key));
function remember(h) { lsSet('houses', [{ key: h.key, name: h.name }, ...knownHouses().filter(x => x.key !== h.key)].slice(0, 8)); }
function forget(key) { lsSet('houses', knownHouses().filter(x => x.key !== key)); }
function knownHtml(exceptKey, where) {
  const hs = knownHouses().filter(h => h.key !== exceptKey); if (!hs.length) return '';
  return `<div class="sec"><h4>${where === 'who' ? 'Inne domy na tym telefonie' : 'Twoje domy na tym telefonie'}</h4><div class="box">${hs.map(h => `<div class="hrow"><b>${esc(h.name)}</b><div class="row"><button class="btn sm pri" type="button" data-act="open-known" data-k="${esc(h.key)}">${where === 'who' ? 'Przełącz' : 'Otwórz'}</button><button class="btn sm ghost" type="button" data-act="forget-known" data-k="${esc(h.key)}" aria-label="Zapomnij ten dom">✕</button></div></div>`).join('')}</div></div>`;
}
function lookSheet() {
  const t = lsGet('theme', 'light'), a = lsGet('accent', 'niebieski'), P = window.THEME?.presets || {};
  return `<div class="sheet-head"><div><h2>Wygląd</h2><div class="sub" style="margin-top:4px">Zmiana działa od razu, tylko na tym telefonie</div></div><button class="x" data-act="close" aria-label="Zamknij">✕</button></div>
  <div class="sec"><h4>Motyw</h4><div class="chips">${[['light', 'Jasny'], ['dark', 'Ciemny'], ['auto', 'Jak w telefonie']].map(([k, n]) => `<button class="chip" data-act="set-theme" data-k="${k}" aria-pressed="${t === k}">${n}</button>`).join('')}</div></div>
  <div class="sec"><h4>Kolory</h4><div class="swatches">${Object.entries(P).map(([k, p]) => `<button class="sw" data-act="set-accent" data-k="${k}" aria-pressed="${a === k}"><i><b style="background:${p.l[0]}"></b><b style="background:${p.l[1]}"></b></i>${esc(p.n)}</button>`).join('')}</div></div>`;
}
function closeSheet() { ui.sheet = null; $('#sheet').hidden = true; document.body.style.overflow = ''; }
const TABS = ['przepisy', 'lista', 'zamrazarka', 'wydatki', 'ceny'];
function setTab(t) {
  const changed = ui.tab !== t;
  ui.tab = t; document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'));
  TABS.forEach(v => $('#v-' + v).hidden = v !== t); if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t); window.scrollTo(0, 0);
  if (changed && db) renderAll();
}
// Rysujemy tylko widoczny widok (pozostałe przy przełączeniu zakładki) i licznik na zakładce „Lista”.
// koszt porcji liczony raz na wczytanie danych (wyszukiwarka nie przelicza 300 przepisów przy każdej literze)
let costCache = new Map();
const costOf = r => { let c = costCache.get(r.id); if (!c) { c = L.recipeCost(r, 2); costCache.set(r.id, c); } return c; };
let qTimer;
/* słownik produktów do listy zakupów: podpowiedzi przy wpisywaniu */
const fold = t => String(t || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function renderSugg() {
  const box = $('#sugg'); if (!box) return; const q = fold($('#manual')?.value.trim());
  if (q.length < 2) { box.innerHTML = ''; return; }
  const hits = Object.values(S.products).filter(p => !p.pantry && (fold(p.name).includes(q) || (p.kw || []).some(k => k.includes(q))))
    .map(p => ({ p, s: fold(p.name).startsWith(q) ? 0 : fold(p.name).split(/\s+/).some(w => w.startsWith(q)) ? 1 : 2 }))
    .sort((a, b) => a.s - b.s || a.p.name.localeCompare(b.p.name, 'pl')).slice(0, 6);
  box.innerHTML = hits.map(({ p }) => { const best = SK.map(s => ({ s, pr: L.priceOf(p.id, s) })).filter(x => x.pr).sort((a, b) => a.pr.p - b.pr.p)[0];
    return `<button type="button" class="sg" data-act="pick" data-pid="${esc(p.id)}"><span><b>${esc(p.name)}</b><small>${p.loose ? 'na wagę' : fmtPack(p)}</small></span>${best ? `<span class="sg-p">od ${zl(best.pr.p)}${p.loose ? '/' + (p.unit === 'kg' ? 'kg' : p.unit) : ''}<small class="store ${best.s}">${SN[best.s]}${best.pr.promo ? ' · promocja' : ''}</small></span>` : ''}</button>`; }).join('')
    + (hits.length ? `<div class="sub" style="padding:4px 2px">Nie ma na liście? Stuknij „Dodaj”, dopiszę jako zwykłą pozycję.</div>` : '');
}
function addOwn(pid) { const p = S.products[pid]; if (!p) return; write({ t: 'list_items', kind: 'insert', rows: [{ id: newId(), product_id: pid, qty: p.pack || 1, pantry: false, name: p.name.slice(0, 200), member: ui.member || null }] }, `Dodano: ${p.name}`); }
function renderAll() { costCache = new Map();
  renderBadge();
  if (ui.tab === 'przepisy') { renderCats(); renderRecipes(); }
  else if (ui.tab === 'lista') renderList();
  else if (ui.tab === 'zamrazarka') renderFreezer();
  else if (ui.tab === 'wydatki') renderSpend();
  else if (ui.tab === 'ceny') renderPrices();
  if (ui.sheet?.type === 'recipe') drawRecipeDyn();
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-tab]'); if (!t) return;
  if (t.dataset.tab) { setTab(t.dataset.tab); return; }
  const a = t.dataset.act, d = t.dataset;
  switch (a) {
    case 'open': ui.sheet = { type: 'recipe', id: d.id }; drawSheet(); break;
    case 'close': closeSheet(); break;
    case 'cat': ui.cat = d.k; lsSet('cat', d.k); renderCats(); renderRecipes(); break;
    case 'filter': ui.filter = d.k; renderCats(); renderRecipes(); break;
    case 'deal': { const n = S.products[d.pid]?.name || ''; ui.q = n.toLowerCase(); $('#q').value = n; ui.filter = 'all'; renderCats(); renderRecipes(); window.scrollTo(0, 0); break; }
    case 'ask': ui.sheet = { type: 'ask', q: d.q || '' }; drawSheet(); break;
    case 'req-del': await write({ t: 'recipe_requests', kind: 'delete', match: { id: d.id } }, 'Usunięto prośbę'); drawSheet(); break;
    case 'req-show': { const r = (S.recipe_requests || []).find(x => x.id === d.id); lsSet('seenReq', [...lsGet('seenReq', []), d.id].slice(-50)); ui.sheet = { type: 'ask' }; drawSheet(); renderRecipes(); break; }
    case 'look': ui.sheet = { type: 'look' }; drawSheet(); break;
    case 'set-theme': lsSet('theme', d.k); window.THEME?.apply(); drawSheet(); break;
    case 'set-accent': lsSet('accent', d.k); window.THEME?.apply(); drawSheet(); break;
    case 'only-freezer': ui.onlyFreezer = !ui.onlyFreezer; lsSet('onlyFreezer', ui.onlyFreezer); renderCats(); renderRecipes(); break;
    case 'like': e.stopPropagation(); toggleReact(d.id, 'liked'); break;
    case 'want': toggleReact(d.id, 'wanted'); break;
    case 'pinc': case 'pdec': case 'pset': {
      ui.portions = a === 'pset' ? +d.n : Math.min(40, Math.max(1, ui.portions + (a === 'pinc' ? 1 : -1))); lsSet('portions', ui.portions);
      $('#rd-n').value = ui.portions; document.querySelectorAll('[data-act="pset"]').forEach(c => c.setAttribute('aria-pressed', +c.dataset.n === ui.portions)); drawRecipeDyn(); break;
    }
    case 'to-list': addRecipeToList(); break;
    case 'to-freezer': { const r = S.recipes[ui.sheet.id]; write({ t: 'freezer', kind: 'insert', rows: [{ id: newId(), recipe_id: r.id, name: r.name.slice(0, 200), portions: ui.portions, member: ui.member || null, frozen_on: today() }] }, `Do zamrażarki: ${ui.portions} porcji`); break; }
    case 'ask-del': ui.sheet.confirmDel = true; drawRecipeDyn(); break;
    case 'cancel-del': ui.sheet.confirmDel = false; drawRecipeDyn(); break;
    case 'del-recipe': { const id = ui.sheet.id; closeSheet(); write({ t: 'hh_recipes', kind: 'upsert', rows: [{ recipe_id: id, active: false, removed: true }] }, 'Usunięto przepis'); break; }
    case 'plan': ui.plan = d.k; renderList(); break;
    case 'trip': ui.trip = ui.trip >= 20 ? 0 : ui.trip + 4; lsSet('trip', ui.trip); ui.plan = null; renderList(); break;
    case 'tick': tickGroup(d.pid); break;
    case 'tick-m': { const m = S.list_items.find(x => x.id === d.id); if (m) write({ t: 'list_items', kind: 'update', values: { done: !m.done }, match: { id: d.id } }); break; }
    case 'pick': addOwn(d.pid); $('#manual').value = ''; renderSugg(); break;
    case 'own-inc': addOwn(d.pid); break;
    case 'own-dec': { const own = S.list_items.filter(x => x.product_id === d.pid && !x.recipe_id && !x.manual); const last = own[own.length - 1]; if (last) write({ t: 'list_items', kind: 'delete', match: { id: last.id } }); break; }
    case 'del-item': write({ t: 'list_items', kind: 'delete', match: { id: d.id } }); break;
    case 'del-batch': write({ t: 'list_items', kind: 'delete', match: { batch: d.k } }, 'Usunięto z listy'); break;
    case 'clear-done': { const ids = S.list_items.filter(x => x.done).map(x => x.id); if (!ids.length) return toast('Nic jeszcze nie jest odhaczone.'); write({ t: 'list_items', kind: 'delete', match: { id: ids } }, `Usunięto ${ids.length} kupionych`); break; }
    case 'fz-dec': fzChange(d.id, -1); break;
    case 'fz-inc': fzChange(d.id, 1); break;
    case 'price': ui.sheet = { type: 'price', pid: d.pid, s: d.s }; drawSheet(); break;
    case 'pmode': ui.pmode = d.k; renderPrices(); break;
    case 'month': ui.month = shiftMonth(ui.month, +d.d); renderSpend(); break;
    case 'budget': ui.sheet = { type: 'budget' }; drawSheet(); break;
    case 'open-receipt': ui.sheet = { type: 'receipt', id: d.id }; drawSheet(); break;
    case 'del-receipt': { const id = ui.sheet.id; closeSheet(); write([{ t: 'receipt_items', kind: 'delete', match: { receipt_id: id } }, { t: 'receipts', kind: 'delete', match: { id } }], 'Usunięto paragon'); break; }
    case 'ask-del-receipt': ui.sheet.confirmDel = true; drawSheet(); break;
    case 'ri-del': readForm(); ui.sheet.draft.items.splice(+d.i, 1); drawSheet(); break;
    case 'ri-add': readForm(); ui.sheet.draft.items.push({ name: '', qty: 1, weighed: false, unit_price: null, total: 0, discount: 0, category: 'Inne' }); drawSheet(); break;
    case 'save-receipt': saveReceipt(); break;
    case 'whoami': ui.sheet = { type: 'who' }; drawSheet(); break;
    case 'invite': shareLink(inviteUrl(), `Dołącz do domu „${house.name}” w Obiadach na Zapas`); break;
    case 'share-app': shareLink(appUrl(), 'Obiady na Zapas: przepisy do mrożenia, wspólna lista zakupów i ceny z gazetek'); break;
    case 'ask-leave': ui.sheet.confirmLeave = true; drawSheet(); break;
    case 'ask-leave-lost': ui.sheet = { type: 'who', confirmLeave: true }; drawSheet(); break;
    case 'cancel-leave': ui.sheet.confirmLeave = false; drawSheet(); break;
    case 'leave': leaveHouse(); break;
    case 'ask-rotate': ui.sheet.confirmRotate = true; drawSheet(); break;
    case 'cancel-rotate': ui.sheet.confirmRotate = false; drawSheet(); break;
    case 'rotate': busy(t, rotateKey); break;
    case 'export': busy(t, exportData); break;
    case 'ask-delete': ui.sheet.confirmDelete = true; drawSheet(); break;
    case 'cancel-delete': ui.sheet.confirmDelete = false; drawSheet(); break;
    case 'delete-house': busy(t, deleteHouse); break;
    case 'open-known': { const h = knownHouses().find(x => x.key === d.k); if (h) switchTo(h); break; }
    case 'forget-known': forget(d.k); if (ui.sheet) drawSheet(); else showKnown(); break;
    case 'switch-house': if (pendingInvite) switchTo(pendingInvite); break;
    case 'stay-house': stayHere(); break;
    case 'w-mode': $('#f-create').hidden = d.k !== 'create'; $('#f-join').hidden = d.k !== 'join'; document.querySelectorAll('[data-act="w-mode"]').forEach(c => c.setAttribute('aria-pressed', c.dataset.k === d.k)); break;
    case 'install-now': if (installEvt) { installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; }); } break;
    case 'hide-install': lsSet('noinstall', true); $('#install').hidden = true; break;
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.sheet) closeSheet(); if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card[data-act="open"]')) { e.preventDefault(); ui.sheet = { type: 'recipe', id: e.target.dataset.id }; drawSheet(); } });
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('submit', async e => {
  e.preventDefault(); const id = e.target.id;
  if (id === 'f-price') savePrice();
  else if (id === 'f-who') {
    const n = $('#w-name').value.trim().slice(0, 40), hn = $('#w-house').value.trim().slice(0, 60);
    if (n) { ui.member = n; lsSet('member', n); $('#who').textContent = n; }
    if (hn && hn !== house.name && await w(() => db.rpc('rename_household', { p_name: hn }))) { house.name = hn; lsSet('house', house); remember(house); ping(['dom']); }
    closeSheet(); renderAll(); toast('Zapisano');
  }
  else if (id === 'f-ask') sendAsk();
  else if (id === 'f-manual') { const v = $('#manual').value.trim().slice(0, 200); if (!v) return; $('#manual').value = ''; renderSugg();
    const exact = Object.values(S.products).find(p => !p.pantry && fold(p.name) === fold(v)); if (exact) { addOwn(exact.id); return; } write({ t: 'list_items', kind: 'insert', rows: [{ id: newId(), manual: true, name: v, member: ui.member || null }] }); }
  else if (id === 'f-freeze') { const v = $('#fz-name').value.trim().slice(0, 200), n = Math.min(200, Math.max(1, Math.round(+$('#fz-n').value) || 1)); if (!v) return; $('#fz-name').value = ''; write({ t: 'freezer', kind: 'insert', rows: [{ id: newId(), name: v, portions: n, member: ui.member || null, frozen_on: today() }] }, 'Dodano do zamrażarki'); }
  else if (id === 'f-create') createHouse();
  else if (id === 'f-budget') saveBudget();
  else if (id === 'f-join') joinHouse();
});
document.addEventListener('change', e => { if (e.target.id === 'rfile' && e.target.files.length) { const fs = [...e.target.files]; e.target.value = ''; importReceipt(fs); } });
document.addEventListener('input', e => {
  if (e.target.id === 'q') { ui.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(renderRecipes, 220); }
  else if (e.target.id === 'manual') renderSugg();
  else if (e.target.id === 'pq') { ui.pq = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(renderPrices, 220); }
  else if (e.target.id === 'rd-n') { const n = parseInt(e.target.value); if (n > 0 && n <= 40) { ui.portions = n; lsSet('portions', n); document.querySelectorAll('[data-act="pset"]').forEach(c => c.setAttribute('aria-pressed', +c.dataset.n === n)); drawRecipeDyn(); } }
});
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TABS.includes(h)) setTab(h); });

/* ---------- dom: zakładanie, zaproszenia, start ---------- */
const keyFrom = v => (String(v || '').match(/[0-9a-f]{64}/) || [null])[0];
const appUrl = () => location.origin + location.pathname;
// Zaproszenie ma klucz po „#”: ta część adresu nie jest wysyłana do serwerów (GitHub Pages, podglądy linków).
const inviteUrl = () => `${appUrl()}#dom=${house.key}`;
const inviteKey = () => { const m = location.hash.match(/[#&]dom=([0-9a-f]{64})/); return m ? m[1] : keyFrom(new URLSearchParams(location.search).get('dom')); };
const client = key => createClient(CFG.url, CFG.anon, { auth: { persistSession: false }, global: key ? { headers: { 'x-dom': key } } : {} });
function ping(t = []) { chan?.send({ type: 'broadcast', event: 'zmiana', payload: { t } })?.catch?.(() => { }); }
function lsDel(k) { try { localStorage.removeItem('onz_' + k); } catch { } }
async function tagOf(key) { // skrót klucza: nazwa kanału domu i znacznik kopii danych w telefonie
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(b.slice(0, 12), x => x.toString(16).padStart(2, '0')).join('');
}
let pendingInvite = null, toastLater = '';
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
  remember(h); house = h; lsSet('house', h); ui.member = member.slice(0, 40); lsSet('member', ui.member);
  start();
}
// Zmiana domu na tym telefonie: poprzedni zostaje na liście znanych domów; pełne przeładowanie = czysty stan.
function switchTo(h) {
  const name = (ui.member || $('#w-member')?.value || '').trim().slice(0, 40);
  if (!name) return welcomeError('Wpisz swoje imię.');
  const cur = lsGet('house', null); if (cur?.key) remember(cur);
  remember(h); lsSet('house', { key: h.key, name: h.name }); ui.member = name; lsSet('member', name);
  location.replace(`${appUrl()}?dom=${h.key}#przepisy`);
}
function stayHere() { pendingInvite = null; $('#w-switch').hidden = true; house = lsGet('house', null); if (house?.key) start(); else showWelcome(null); }
async function leaveHouse() {
  if (house?.key) forget(house.key);
  lsDel('house'); lsDel('seenReq'); lsDel('rotated');
  if (!knownHouses().length) try { Object.keys(localStorage).filter(k => k.startsWith('onz_') && !['onz_theme', 'onz_accent'].includes(k)).forEach(k => localStorage.removeItem(k)); } catch { }
  await D.wipe();
  try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch { }
  location.replace(appUrl());
}
async function rotateKey() {
  await sync();
  if (pendingOps.some(o => o.key === house.key)) return toast('Najpierw muszę wysłać zapisane zmiany. Połącz się z internetem.');
  const { data, error } = await db.rpc('rotate_household_secret');
  if (error || !data?.secret) return toast(errorText(error));
  // domownicy na starym kanale od razu zobaczą, że ich link przestał działać
  await Promise.race([chan?.send({ type: 'broadcast', event: 'zmiana', payload: { t: ['dom'] } }), new Promise(r => setTimeout(r, 1500))]).catch(() => { });
  forget(house.key); const h = { key: data.secret, name: house.name }; remember(h); lsSet('house', h); lsSet('rotated', true);
  location.replace(`${appUrl()}?dom=${h.key}#przepisy`);
}
const EXPORT_ORDER = { recipe_requests: ['created_at', 'id'], hh_recipes: ['recipe_id'], reactions: ['recipe_id', 'member'], list_items: ['created_at', 'id'], freezer: ['id'], hh_prices: ['product_id', 'store'], receipts: ['bought_on', 'id'], receipt_items: ['id'], hh_settings: ['household_id'] };
async function exportData() {
  try {
    const out = { aplikacja: 'Obiady na Zapas', wyeksportowano: new Date().toISOString(), dom: house.name, tabele: {} };
    for (const t of HH_TABLES) out.tabele[t] = await fetchAll(t, q => EXPORT_ORDER[t].reduce((x, c) => x.order(c), q.select('*')), true);
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `obiady-na-zapas-${today()}.json` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Pobrano dane domu');
  } catch (e) { console.error(e); toast(navigator.onLine ? 'Nie udało się pobrać danych.' : 'Do pobrania danych potrzebny jest internet.'); }
}
async function deleteHouse() {
  const { error } = await db.rpc('delete_household');
  if (error) return toast(error.code === 'PGRST202' ? 'Usuwanie domu nie jest jeszcze włączone w bazie.' : errorText(error));
  ping(['dom']);
  await leaveHouse();
}
/* instrukcja dodania do ekranu głównego: iPhone (Safari) i Android (Chrome) */
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; document.querySelectorAll('[data-act="install-now"]').forEach(b => b.hidden = false); });
window.addEventListener('appinstalled', () => { $('#install').hidden = true; $('#w-install').hidden = true; });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function installHtml(welcome) {
  const lead = welcome ? '<b>Dodaj aplikację do ekranu głównego</b> – otworzysz ją jak zwykłą aplikację, bez paska przeglądarki. Najlepiej najpierw załóż dom (albo dołącz z zaproszenia), a potem:' : '<b>Dodaj aplikację do ekranu głównego:</b>';
  const steps = isIOS
    ? '<ol class="isteps"><li>Otwórz tę stronę w <b>Safari</b>.</li><li>Stuknij <b>Udostępnij</b> (kwadrat ze strzałką w górę).</li><li>Wybierz <b>Do ekranu początkowego</b>, potem <b>Dodaj</b>.</li></ol>'
    : '<ol class="isteps"><li>Otwórz tę stronę w <b>Chrome</b>.</li><li>Stuknij <b>⋮</b> w prawym górnym rogu.</li><li>Wybierz <b>Zainstaluj aplikację</b> albo <b>Dodaj do ekranu głównego</b>, potem <b>Zainstaluj</b>.</li></ol>';
  return `${lead}${steps}<div class="row"><button class="btn pri sm" type="button" data-act="install-now" ${installEvt ? '' : 'hidden'}>Zainstaluj teraz</button>${welcome ? '' : '<button class="btn sm ghost" type="button" data-act="hide-install">Ukryj</button>'}</div>`;
}
function showWelcome(invite) {
  $('#welcome').hidden = false; $('#app').hidden = true;
  const wi = $('#w-install'); wi.hidden = isStandalone() || !(isIOS || isAndroid); if (!wi.hidden) wi.innerHTML = installHtml(true);
  $('#w-member').value = ui.member || '';
  if (invite) {
    pendingInvite = invite;
    $('#w-modes').hidden = true; $('#f-create').hidden = true; $('#f-join').hidden = false;
    $('#w-code').value = invite.key; $('#j-title').textContent = `Dołączasz do domu „${invite.name}”`;
  }
  showKnown();
}
function showKnown() { const el = $('#w-known'), h = knownHtml(pendingInvite?.key, 'welcome'); el.innerHTML = h; el.hidden = !h; }
// Link do innego domu, gdy na telefonie jest już dom: pytamy, zamiast po cichu przełączać.
function showSwitch(invite, saved) {
  showWelcome(null); pendingInvite = invite; showKnown();
  $('#w-modes').hidden = true; $('#f-create').hidden = true; $('#f-join').hidden = true;
  const el = $('#w-switch'); el.hidden = false;
  el.innerHTML = `<div class="banner">Ten link zaprasza do domu <b>„${esc(invite.name)}”</b>. Na tym telefonie masz dom <b>„${esc(saved.name)}”</b>.</div>
    <div class="sub">Po przełączeniu dom „${esc(saved.name)}” zostanie zapamiętany i wrócisz do niego w ustawieniach.</div>
    <div class="row"><button class="btn pri" type="button" data-act="switch-house">Przełącz na „${esc(invite.name)}”</button><button class="btn" type="button" data-act="stay-house">Zostań w „${esc(saved.name)}”</button></div>`;
}
async function start() {
  db = clientFor(house.key); houseTag = await tagOf(house.key); remember(house);
  $('#welcome').hidden = true; $('#app').hidden = false; $('#who').textContent = ui.member || 'Ustawienia';
  const ib = $('#install'); ib.hidden = isStandalone() || lsGet('noinstall', false) || !(isIOS || isAndroid); if (!ib.hidden) ib.innerHTML = installHtml(false);
  // klucz domu w adresie (bez zaproszenia po „#”): ikona dodana do ekranu początkowego otworzy ten dom.
  // Do serwera strony klucz nie trafia: service worker pobiera stronę bez parametrów.
  const h = location.hash.slice(1), tab = TABS.includes(h) ? h : 'przepisy';
  history.replaceState(null, '', `?dom=${house.key}#${tab}`);
  setTab(tab);
  // najpierw dane z telefonu (kopia + zapisy czekające na wysłanie), potem tylko zmiany z serwera
  const [cached, ops, old] = await Promise.all([D.cacheAll(), D.outboxAll(), oldCache()]);
  pendingOps = ops;
  for (const c of cached.length ? cached : old) if (TABLES[c.t] && (SHARED[c.t] || !cached.length || c.house === houseTag)) { RAW[c.t] = c.data; VER[c.t] = c.ver; }
  Object.keys(TABLES).forEach(recompute);
  renderAll(); netBanner();
  subscribe(); sync();
  if (lsGet('rotated', false)) { lsDel('rotated'); ui.sheet = { type: 'who', rotated: true }; drawSheet(); }
  if (toastLater) toast(toastLater);
}
/* iOS (aplikacja z ekranu głównego): po pierwszym otwarciu klawiatury WebKit potrafi na stałe „zmniejszyć” ekran –
   dolne menu wisi wtedy wyżej, a pod nim zostaje pusty pas. Pomaga tylko wymuszenie ponownego pomiaru:
   chwilowe ukrycie i pokazanie głównego kontenera (opis: dev.to/cederhook, iOS 17–18). */
let maxVH = window.innerHeight;
window.addEventListener('resize', () => { maxVH = Math.max(maxVH, window.innerHeight); });
function healViewport() {
  const a = document.activeElement; if (a && a.matches?.('input,textarea,select')) return;   // klawiatura nadal otwarta
  if (maxVH - window.innerHeight <= 4) return;
  const el = $('#app').hidden ? $('#welcome') : $('#app'), y = window.scrollY;
  el.style.display = 'none'; void el.offsetHeight; el.style.display = '';
  window.scrollTo(0, y);
}
document.addEventListener('focusout', e => { if (e.target.matches?.('input,textarea,select')) { setTimeout(healViewport, 150); setTimeout(healViewport, 600); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(healViewport, 150); });
window.addEventListener('pageshow', () => setTimeout(healViewport, 150));
(async function boot() {
  if (window.top !== window.self) return; // nie działamy w ramce cudzej strony
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  if (!CFG.url) { document.body.innerHTML = '<div class="wrap" style="padding:40px 16px"><h2>Aplikacja jeszcze nie jest skonfigurowana</h2></div>'; return; }
  const saved = lsGet('house', null), fromUrl = inviteKey();
  if (fromUrl && fromUrl !== saved?.key) {
    // link zaproszenia albo pierwsze otwarcie z ikony na ekranie początkowym
    const h = await houseFor(fromUrl).catch(() => undefined); // undefined: brak połączenia, null: nieaktualny link
    if (h && saved?.key) return showSwitch(h, saved);
    if (h) return showWelcome(h);
    if (!saved?.key) { showWelcome(null); return welcomeError(h === null ? 'Ten link zaproszenia jest nieaktualny. Poproś domownika o nowy.' : 'Brak połączenia. Otwórz link zaproszenia ponownie, gdy wróci internet.'); }
    toastLater = h === null ? 'Link zaproszenia był nieaktualny. Zostajesz w swoim domu.' : 'Brak połączenia: link zaproszenia otwórz ponownie, gdy wróci internet.';
  }
  if (saved?.key) { house = saved; return start(); }
  showWelcome(null);
})();
