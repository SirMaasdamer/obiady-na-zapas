// Atrapa Supabase do testów aplikacji w przeglądarce (scripts/test-aplikacji.mjs): PostgREST (tabele, RPC),
// Realtime (WebSocket, protokół 2.0.0 z binarnym broadcastem) i serwer plików web/ pod /obiady-na-zapas/ jak na GitHub Pages.
// Odwzorowuje zachowanie bazy ważne dla aplikacji: RLS po kluczu domu, limity próśb, wersje tabel (app_state).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAll, buildKatalog } from './batches.mjs';

export const WEB = fileURLToPath(new URL('../web', import.meta.url));
export const BASE = '/obiady-na-zapas/';
export const SUPA = 'https://jnomchdxgmoegbpfjtii.supabase.co';
const iso = () => new Date().toISOString();
const day = (d = 0) => new Date(Date.now() + d * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

/* ---------- pliki aplikacji (jak GitHub Pages pod /obiady-na-zapas/) ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.md': 'text/markdown', '.txt': 'text/plain' };
export const served = [];
export async function startServer(port = 8765) {
  const server = http.createServer(async (req, res) => {
    served.push(req.url);
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith(BASE)) { res.writeHead(404); return res.end(); }
    let p = decodeURIComponent(u.pathname.slice(BASE.length)); if (!p || p.endsWith('/')) p += 'index.html';
    const f = normalize(join(WEB, p)); if (!f.startsWith(WEB)) { res.writeHead(403); return res.end(); }
    try { const buf = await readFile(f); res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' }); res.end(buf); }
    catch { res.writeHead(404); res.end('brak'); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { server, app: `http://127.0.0.1:${port}${BASE}` };
}

/* ---------- stan bazy ---------- */
const kat = buildKatalog(await loadAll());
const products = kat.products.map(p => ({ id: p.id, name: p.name, unit: p.unit, pack: p.pack, loose: !!p.loose, cat: p.cat, pantry: !!p.pantry, conv: p.conv ?? null, kw: p.kw ?? null }));
const recipes = kat.recipes.map(r => ({ ...r, retired_at: null }));
const prices = [];
for (const p of kat.products) for (const [s, v] of Object.entries(p.regular || {})) if (+v > 0) prices.push({ product_id: p.id, store: s, regular: +v, regular_src: 'szacunek', promo: null, promo_from: null, promo_to: null, promo_note: null });
const promoP = prices.find(x => x.store === 'b' && products.find(p => p.id === x.product_id && !p.pantry));
Object.assign(promoP, { promo: +(promoP.regular * 0.6).toFixed(2), promo_from: day(-1), promo_to: day(3), promo_note: 'z kartą', regular_src: 'gazetka' });
export const M = {
  houses: new Map(), // klucz → { id, name }
  rows: { list_items: [], freezer: [], reactions: [], hh_recipes: [], hh_prices: [], receipts: [], receipt_items: [], hh_settings: [], recipe_requests: [] },
  hhv: new Map(),
  members: new Map(), // klucz telefonu → { id, hh, name, device, created_at, last_seen }
  invites: new Map(), // kod → { hh, exp }
  versions: { katalog: 'k1', oferty: 'o1' },
  shared: {
    products, recipes, prices,
    offers: [{ id: 1, store: 'b', product_id: promoP.product_id, name: 'Oferta <b>testowa</b>', price: promoP.promo, price_for_pack: promoP.promo, regular: promoP.regular, unit_info: '1 kg', valid_from: day(-1), valid_to: day(3), note: null, page: null, leaflet: null, source: 'gazetki.pl' }],
    scrape_runs: [{ store: 'b', ran_at: iso(), status: 'ok', message: '', valid_from: day(-1), valid_to: day(3), matched: 1, run_id: 'gh-1-1' }, { store: 'l', ran_at: iso(), status: 'ostrzezenie', message: 'mało ofert', valid_from: null, valid_to: null, matched: 2, run_id: 'gh-1-1' }],
  },
  log: [], down: false,
};
const PK = { list_items: ['id'], freezer: ['id'], receipts: ['id'], receipt_items: ['id'], recipe_requests: ['id'], reactions: ['household_id', 'recipe_id', 'member'], hh_prices: ['household_id', 'product_id', 'store'], hh_recipes: ['household_id', 'recipe_id'], hh_settings: ['household_id'] };
const DEF = {
  list_items: () => ({ done: false, manual: false, pantry: false, qty: null, name: null, created_at: iso() }),
  freezer: () => ({ frozen_on: day(), created_at: iso() }),
  recipe_requests: () => ({ status: 'czeka', attempts: 0, note: null, recipe_ids: [], created_at: iso(), done_at: null, claimed_at: null }),
  reactions: () => ({ liked: false, wanted: false, created_at: iso() }),
  receipts: () => ({ created_at: iso() }), receipt_items: () => ({ created_at: iso() }), hh_prices: () => ({}), hh_recipes: () => ({ activated_at: null }), hh_settings: () => ({ budget: null }),
};
const houseById = id => [...M.houses.values()].find(h => h.id === id) || null;
export const houseOf = key => M.houses.get(key) || (M.members.has(key) ? houseById(M.members.get(key).hh) : null);
export function newInvite(key) { const hh = houseOf(key); const code = randomBytes(32).toString('hex'); M.invites.set(code, { hh: hh.id, exp: Date.now() + 14 * 864e5 }); return code; }
function codeKind(code) {
  if (M.members.has(code)) return { hh: houseById(M.members.get(code).hh), kind: 'domownik', member_id: M.members.get(code).id };
  const i = M.invites.get(code); if (i && i.exp > Date.now()) return { hh: houseById(i.hh), kind: 'zaproszenie' };
  if (M.houses.has(code)) return { hh: M.houses.get(code), kind: 'klucz' };
  return null;
}
export function newHouse(name) { const key = randomBytes(32).toString('hex'), id = randomUUID(); M.houses.set(key, { id, name }); return { key, id, name }; }
const bump = (hh, t) => M.hhv.set(hh + '|' + t, new Date(Date.now() + Math.random()).toISOString());

function filtersOf(u) {
  const fs = [];
  for (const [k, v] of u.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    const m = v.match(/^(eq|neq|gte|lte|gt|lt|in|is)\.(.*)$/s); if (!m) continue;
    let val = m[2]; if (m[1] === 'in') val = val.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, ''));
    fs.push([k, m[1], val]);
  }
  return fs;
}
const hit = (r, fs) => fs.every(([k, op, v]) => { const x = r[k] == null ? null : String(r[k]); return op === 'eq' ? x === v : op === 'neq' ? x !== v : op === 'gte' ? x >= v : op === 'lte' ? x <= v : op === 'gt' ? x > v : op === 'lt' ? x < v : op === 'in' ? v.includes(x) : op === 'is' ? (v === 'null' ? x == null : x === v) : true; });
function ordered(rows, u) {
  const o = u.searchParams.get('order'); if (!o) return rows;
  const keys = o.split(',').map(s => { const [c, dir] = s.split('.'); return [c, dir === 'desc' ? -1 : 1]; });
  return [...rows].sort((a, b) => { for (const [c, d] of keys) { const x = a[c] ?? '', y = b[c] ?? ''; if (x < y) return -d; if (x > y) return d; } return 0; });
}

/* ---------- PostgREST ---------- */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range' };
export async function handle(route) {
  const req = route.request(), u = new URL(req.url()), method = req.method();
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (M.down) return route.abort('connectionfailed');
  const h = await req.allHeaders(), key = h['x-dom'] || null, hh = key ? houseOf(key) : null, me = key ? M.members.get(key) : null;
  const send = (status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: body === undefined ? '' : JSON.stringify(body) });
  const body = (() => { try { return req.postDataJSON(); } catch { return null; } })();
  M.log.push({ method, path: u.pathname, search: decodeURIComponent(u.search), key: key && key.slice(0, 6), prefer: h.prefer || '', body });
  if (u.pathname === '/realtime/v1/api/broadcast') { for (const m of body?.messages || []) relay(null, 'realtime:' + m.topic, m.event, m.payload); return send(202, {}); }
  const rpc = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
  if (rpc) {
    const fn = rpc[1];
    if (fn === 'household_info') return send(200, hh ? { id: hh.id, name: hh.name } : null);
    if (fn === 'create_household') { const n = newHouse(String(body?.p_name || '').trim().slice(0, 60) || 'Mój dom'); return send(200, { id: n.id, name: n.name, secret: n.key }); }
    if (fn === 'rename_household') { if (hh) hh.name = String(body?.p_name || hh.name).trim().slice(0, 60); return route.fulfill({ status: 204, headers: CORS }); }
    if (fn === 'rotate_household_secret') {
      if (!hh) return send(403, { code: '42501', message: 'Nie rozpoznano domu.' });
      const nk = randomBytes(32).toString('hex'); M.houses.delete(key); M.houses.set(nk, hh); return send(200, { secret: nk });
    }
    if (fn === 'invite_info') { const c = codeKind(body?.p_code); return send(200, c?.hh ? { name: c.hh.name, kind: c.kind, member_id: c.member_id || null } : null); }
    if (fn === 'join_household') {
      const c = codeKind(body?.p_code); if (!c?.hh || c.kind === 'domownik') return send(400, { code: 'P0001', message: 'Ten link zaproszenia jest nieaktualny.' });
      const token = randomBytes(32).toString('hex'), id = randomUUID();
      M.members.set(token, { id, hh: c.hh.id, name: String(body?.p_name || 'Domownik').trim().slice(0, 40), device: body?.p_device || null, created_at: iso(), last_seen: iso() });
      bump(c.hh.id, 'hh_members'); return send(200, { token, member_id: id, household_id: c.hh.id, name: c.hh.name });
    }
    if (fn === 'create_invite') { if (!me) return send(403, { code: '42501', message: 'Nie rozpoznano telefonu domownika.' }); return send(200, { code: newInvite(key) }); }
    if (fn === 'member_touch') { if (me) { me.name = String(body?.p_name || me.name).slice(0, 40); me.device = body?.p_device || null; me.last_seen = iso(); bump(me.hh, 'hh_members'); } return route.fulfill({ status: 204, headers: CORS }); }
    if (fn === 'remove_member') {
      if (!me) return send(403, { code: '42501', message: 'Nie rozpoznano telefonu domownika.' });
      if (body?.p_id === me.id) return send(400, { code: 'P0001', message: 'Siebie odłączasz opcją „Odłącz ten telefon”.' });
      const t = [...M.members].find(([, m]) => m.id === body?.p_id && m.hh === me.hh); if (!t) return send(400, { code: 'P0001', message: 'Nie ma takiego domownika.' });
      M.members.delete(t[0]); for (const [c, i] of M.invites) if (i.hh === me.hh) M.invites.delete(c);
      for (const [k, v] of M.houses) if (v.id === me.hh) { M.houses.delete(k); M.houses.set(randomBytes(32).toString('hex'), v); }
      bump(me.hh, 'hh_members'); return route.fulfill({ status: 204, headers: CORS });
    }
    if (fn === 'leave_household') { if (me) { M.members.delete(key); bump(me.hh, 'hh_members'); } return route.fulfill({ status: 204, headers: CORS }); }
    if (fn === 'app_state') {
      const tabele = {}; if (hh) for (const [k, v] of M.hhv) { const [id, t] = k.split('|'); if (id === hh.id) tabele[t] = v; }
      return send(200, { dom: hh ? { id: hh.id, name: hh.name } : null, zbiory: M.versions, tabele });
    }
    return send(404, { code: 'PGRST202', message: `Could not find the function public.${fn} without parameters in the schema cache` });
  }
  const t = u.pathname.match(/^\/rest\/v1\/(\w+)$/)?.[1];
  if (!t) return send(404, { message: 'brak' });
  const fs = filtersOf(u);
  if (M.shared[t]) {
    if (method !== 'GET') return send(401, { code: '42501', message: `permission denied for table ${t}` });
    let rows = ordered(M.shared[t].filter(r => hit(r, fs)), u);
    const off = +(u.searchParams.get('offset') || 0), lim = Math.min(+(u.searchParams.get('limit') || 1000), 1000);
    return send(200, rows.slice(off, off + lim));
  }
  if (t === 'hh_members') {
    if (method !== 'GET') return send(401, { code: '42501', message: 'permission denied for table hh_members' });
    if (/\*/.test(u.searchParams.get('select') || '*')) return send(401, { code: '42501', message: 'permission denied for table hh_members' });
    const rows = [...M.members.values()].filter(m => hh && m.hh === hh.id).map(({ hh: _, ...m }) => m);
    return send(200, ordered(rows, u));
  }
  const table = M.rows[t]; if (!table) return send(404, { code: '42P01', message: `relation ${t} does not exist` });
  if (method === 'GET') {
    const rows = ordered(table.filter(r => hh && r.household_id === hh.id && hit(r, fs)), u);
    const off = +(u.searchParams.get('offset') || 0), lim = Math.min(+(u.searchParams.get('limit') || 1000), 1000);
    return send(200, rows.slice(off, off + lim));
  }
  if (!hh) return send(401, { code: '42501', message: `new row violates row-level security policy for table "${t}"` });
  if (method === 'POST') {
    const input = Array.isArray(body) ? body : [body], prefer = h.prefer || '';
    const cols = u.searchParams.get('on_conflict')?.split(',') || PK[t];
    if (t === 'recipe_requests') {
      if (input.some(r => Object.keys(r).some(k => !['query', 'member'].includes(k)))) return send(401, { code: '42501', message: 'permission denied for table recipe_requests' });
      const q = String(input[0].query || '');
      if (q.trim().length < 2 || q.trim().length > 80 || /[<>{}\r\n\t]/.test(q)) return send(400, { code: '23514', message: 'new row for relation "recipe_requests" violates check constraint "recipe_requests_query_short"' });
      if (table.filter(r => r.household_id === hh.id && ['czeka', 'w_trakcie'].includes(r.status)).length >= 3) return send(400, { code: 'P0001', message: 'Możecie mieć najwyżej 3 oczekujące prośby.' });
    }
    for (const row of input) {
      const r = { id: PK[t][0] === 'id' ? randomUUID() : undefined, ...DEF[t](), ...row, household_id: hh.id };
      if (r.id === undefined) delete r.id;
      const ex = table.find(x => cols.every(c => String(x[c]) === String(r[c])));
      if (ex) { if (/ignore-duplicates/.test(prefer)) continue; if (/merge-duplicates/.test(prefer)) { Object.assign(ex, row); continue; } return send(409, { code: '23505', message: 'duplicate key value violates unique constraint' }); }
      table.push(r);
    }
    bump(hh.id, t);
    return /return=representation/.test(prefer) ? send(201, input) : route.fulfill({ status: 201, headers: CORS });
  }
  if (method === 'PATCH') { table.filter(r => r.household_id === hh.id && hit(r, fs)).forEach(r => Object.assign(r, body)); bump(hh.id, t); return route.fulfill({ status: 204, headers: CORS }); }
  if (method === 'DELETE') { M.rows[t] = table.filter(r => !(r.household_id === hh.id && hit(r, fs))); bump(hh.id, t); return route.fulfill({ status: 204, headers: CORS }); }
  return send(405, { message: 'metoda' });
}
export const rowsOf = (t, key) => { const hh = houseOf(key); return hh ? M.rows[t].filter(r => r.household_id === hh.id) : []; };

/* ---------- Realtime (Phoenix, vsn 2.0.0: JSON w tablicach, broadcast binarnie) ---------- */
const conns = new Set();
export const wsLog = [];
function encodeBroadcast(topic, event, payload) {
  const te = new TextEncoder(), tb = te.encode(topic), eb = te.encode(event), pb = te.encode(JSON.stringify(payload ?? {}));
  const head = Buffer.from([4, tb.length, eb.length, 0, 1]);
  return Buffer.concat([head, Buffer.from(tb), Buffer.from(eb), Buffer.from(pb)]);
}
function decodePush(buf) {
  const b = new Uint8Array(buf), td = new TextDecoder(); if (b[0] !== 3) return null;
  const [jl, rl, tl, el, ml, enc] = [b[1], b[2], b[3], b[4], b[5], b[6]]; let i = 7;
  const take = n => { const s = td.decode(b.slice(i, i + n)); i += n; return s; };
  const join_ref = take(jl), ref = take(rl), topic = take(tl), event = take(el); take(ml);
  const rest = b.slice(i); return { join_ref, ref, topic, event, payload: enc === 1 ? JSON.parse(td.decode(rest) || '{}') : rest };
}
function relay(from, topic, event, payload) {
  wsLog.push({ topic, event, payload });
  for (const c of conns) if (c !== from && c.topics.has(topic)) c.ws.send(encodeBroadcast(topic, event, payload));
}
export async function routeRealtime(ctx) {
  await ctx.routeWebSocket(/\/realtime\/v1\/websocket/, ws => {
    const c = { ws, topics: new Set() }; conns.add(c);
    ws.onMessage(msg => {
      if (typeof msg !== 'string') { const p = decodePush(msg); if (p) relay(c, p.topic, p.event, p.payload); return; }
      const [join_ref, ref, topic, event, payload] = JSON.parse(msg);
      const reply = response => ws.send(JSON.stringify([join_ref, ref, topic, 'phx_reply', { status: 'ok', response }]));
      if (event === 'phx_join') { c.topics.add(topic); reply({ postgres_changes: [] }); }
      else if (event === 'phx_leave') { c.topics.delete(topic); reply({}); }
      else if (event === 'heartbeat') reply({});
      else if (event === 'broadcast') relay(c, topic, payload?.event, payload?.payload);
      else reply({});
    });
    ws.onClose(() => conns.delete(c));
  });
}
