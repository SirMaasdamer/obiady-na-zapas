// Testy zabezpieczeń: escapowanie w formatowaniu, wspólna walidacja danych, weryfikacja tokenu OIDC GitHuba.
import { webcrypto } from 'node:crypto';
import * as L from '../web/logic.js';
import { checkCatalog, checkOffers, recipeErrors, requestResultErrors } from '../supabase/functions/ingest/walidacja.mjs';
import { verifyGithubToken, GITHUB_ISSUER } from '../supabase/functions/ingest/oidc.mjs';
import { loadAll, validate, buildKatalog } from './batches.mjs';

const crypto = globalThis.crypto ?? webcrypto;
let fails = 0;
const eq = (a, b, m) => { if (a !== b) { fails++; console.log('✗', m, JSON.stringify(a), '!==', JSON.stringify(b)); } else console.log('✓', m); };
const HTML = '<img src=x onerror=alert(1)>';

// --- formatowanie ilości nie przepuszcza HTML ---
eq(L.fmtAmt(1, HTML).includes('<'), false, 'fmtAmt escapuje jednostkę');
eq(L.fmtPack({ unit: HTML, pack: 1 }).includes('<'), false, 'fmtPack escapuje jednostkę produktu');
eq(L.buyText({ unit: HTML, pack: 1, loose: false }, 2).includes('<'), false, 'buyText escapuje jednostkę produktu');
eq(L.fmtAmt(250, 'g'), '250 g', 'fmtAmt bez zmian dla zwykłych jednostek');

// --- walidacja przepisów: biała lista jednostek, bez < > ---
const ok = { id: 'test-ok', name: 'Test', category: 'wege', steps: ['a', 'b'], ingredients: [{ pid: 'ryz', amt: 100, unit: 'g' }, { pid: 'sol', amt: 1, unit: 'łyżeczka' }] };
eq(recipeErrors(ok).length, 0, 'poprawny przepis przechodzi');
eq(recipeErrors({ ...ok, ingredients: [ok.ingredients[0], { pid: 'sol', amt: 1, unit: HTML }] }).length > 0, true, 'HTML w jednostce składnika odrzucony');
eq(recipeErrors({ ...ok, name: 'Zupa <b>' }).length > 0, true, 'HTML w nazwie odrzucony');
eq(recipeErrors({ ...ok, source_url: 'javascript:alert(1)' }).length > 0, true, 'link inny niż https odrzucony');
eq(recipeErrors({ ...ok, steps: ['krok 1', 'x'.repeat(1001)] }).length > 0, true, 'za długi krok odrzucony');

// --- walidator paczek w CI używa tych samych reguł (także dla składników ze spiżarni) ---
const data = await loadAll();
eq(validate(data).length, 0, 'paczki przepisów w repozytorium są poprawne');
const pantryHtml = { file: 'zla.json', recipes: [{ ...ok, id: 'html-w-jednostce', ingredients: [{ pid: 'cebula', amt: 1, unit: 'szt' }, { pid: 'sol', amt: 1, unit: HTML }] }] };
eq(validate({ ...data, batches: [pantryHtml] }).some(e => e.includes('jednostka')), true, 'walidator paczek odrzuca HTML w jednostce składnika ze spiżarni');

// --- pełny katalog z repozytorium przechodzi walidację serwera ---
const kat = buildKatalog(data);
const cc = checkCatalog(kat);
eq(cc.errors.length, 0, `katalog z repozytorium przechodzi walidację funkcji ingest (${cc.errors.slice(0, 3).join('; ')})`);
eq(cc.data.recipes.length, kat.recipes.length, 'katalog: wszystkie przepisy zachowane');
eq(checkCatalog({ ...kat, recipes: [...kat.recipes, { ...ok, id: 'x-html', ingredients: [{ pid: 'cebula', amt: 1, unit: HTML }, ok.ingredients[0]] }] }).errors.length > 0, true, 'katalog z HTML odrzucony przez serwer');

// --- wyniki próśb ---
const rid = kat.recipes[0].id, uuid = '0b9b2a3e-7a4f-4f6c-9d1e-2b3c4d5e6f70';
eq(requestResultErrors({ id: uuid, status: 'gotowe', recipe_ids: [rid] }, new Set([rid])).length, 0, 'poprawny wynik prośby');
eq(requestResultErrors({ id: uuid, status: 'gotowe', recipe_ids: [] }, new Set([rid])).length > 0, true, 'gotowe bez przepisów odrzucone');
eq(requestResultErrors({ id: 'x', status: 'gotowe', recipe_ids: [rid] }, new Set([rid])).length > 0, true, 'zły identyfikator prośby odrzucony');
eq(requestResultErrors({ id: uuid, status: 'w_toku' }, new Set()).length > 0, true, 'nieznany status odrzucony');

// --- oferty: czyszczenie zamiast odrzucania całości ---
const co = checkOffers({
  runs: [{ store: 'b', ran_at: '2026-11-01T02:00:00Z', status: 'ok', matched: 2, message: 'x' }],
  offers: [
    { store: 'b', product_id: 'kurczak_filet', name: `Filet ${HTML}`, price: 14.99, price_for_pack: 14.99, valid_from: '2026-11-02', valid_to: '2026-11-04', source: 'gazetki.pl', leaflet: 'javascript:alert(1)' },
    { store: 'x', product_id: 'kurczak_filet', name: 'zły sklep', price_for_pack: 1, valid_to: '2026-11-04', source: 'www' },
    { store: 'l', product_id: 'mascarpone', name: 'Mascarpone', price_for_pack: 0, valid_to: '2026-11-04', source: 'www' },
  ],
});
eq(co.data.offers.length + '|' + co.dropped, '1|2', 'oferty: złe wpisy pominięte');
eq(co.data.offers[0].name.includes('<'), false, 'oferty: HTML usunięty z nazwy');
eq(co.data.offers[0].leaflet, null, 'oferty: link inny niż https usunięty');

// --- token OIDC GitHuba ---
const enc = s => Buffer.from(typeof s === 'string' ? s : JSON.stringify(s)).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
const getJwks = async () => ({ keys: [jwk] });
const now = Date.now(), t = Math.floor(now / 1000);
const WF = 'SirMaasdamer/obiady-na-zapas/.github/workflows/ceny.yml';
const good = { iss: GITHUB_ISSUER, aud: 'obiady-ingest', exp: t + 300, nbf: t - 10, iat: t - 10, repository_id: '1439103371', repository: 'SirMaasdamer/obiady-na-zapas', ref: 'refs/heads/main', event_name: 'schedule', job_workflow_ref: WF + '@refs/heads/main', run_id: '42', run_attempt: '1' };
async function sign(claims, kid = 'k1', key = privateKey) {
  const head = enc({ alg: 'RS256', typ: 'JWT', kid }), body = enc(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body));
  return head + '.' + body + '.' + Buffer.from(sig).toString('base64url');
}
const opts = { audience: 'obiady-ingest', repositoryId: '1439103371', workflows: [WF], getJwks, now };
const verdict = async (token, o = opts) => { try { await verifyGithubToken(token, o); return 'ok'; } catch (e) { return e.message; } };
eq(await verdict(await sign(good)), 'ok', 'OIDC: poprawny token przyjęty');
const tok = await sign(good), [h, b, s] = tok.split('.');
eq(await verdict(h + '.' + enc({ ...good, repository_id: '1' }) + '.' + s), 'token: zły podpis', 'OIDC: zmieniona treść odrzucona');
eq(await verdict(await sign({ ...good, repository_id: '999' })), 'token: obce repozytorium', 'OIDC: token z innego repozytorium (np. forka) odrzucony');
eq(await verdict(await sign({ ...good, ref: 'refs/pull/7/merge' })), 'token: niedozwolona gałąź', 'OIDC: token z pull requesta odrzucony');
eq(await verdict(await sign({ ...good, job_workflow_ref: 'SirMaasdamer/obiady-na-zapas/.github/workflows/inny.yml@refs/heads/main' })), 'token: niedozwolony workflow', 'OIDC: inny workflow odrzucony');
eq(await verdict(await sign({ ...good, exp: t - 600 })), 'token: wygasł', 'OIDC: wygasły token odrzucony');
eq(await verdict(await sign({ ...good, aud: 'inny' })), 'token: zły odbiorca', 'OIDC: zły odbiorca odrzucony');
eq(await verdict(await sign({ ...good, event_name: 'pull_request_target' })), 'token: niedozwolone zdarzenie', 'OIDC: niedozwolone zdarzenie odrzucone');
eq(await verdict(await sign({ ...good, iss: 'https://evil.example' })), 'token: zły wystawca', 'OIDC: obcy wystawca odrzucony');
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
eq(await verdict(await sign(good, 'k1', other.privateKey)), 'token: zły podpis', 'OIDC: podpis cudzym kluczem odrzucony');
eq(await verdict(await sign(good, 'k2')), 'token: nieznany klucz', 'OIDC: nieznany identyfikator klucza odrzucony');
eq(await verdict('abc.def'), 'token: zły format', 'OIDC: śmieci odrzucone');
const hs = enc({ alg: 'HS256', kid: 'k1' }) + '.' + enc(good) + '.x';
eq(await verdict(hs), 'token: niedozwolony algorytm', 'OIDC: algorytm inny niż RS256 odrzucony');

if (fails) { console.log(fails, 'błędów'); process.exit(1); } else console.log('Wszystkie testy zabezpieczeń przeszły.');
