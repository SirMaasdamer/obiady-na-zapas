// Funkcja „ingest”: przyjmuje dane wspólne wypychane przez workflowy GitHub Actions.
//   POST /ingest/oferty   ← ceny.yml     (oferty z gazetek → obserwacje)
//   POST /ingest/katalog  ← przepisy.yml (produkty, przepisy, wyniki próśb)
//   POST /ingest/prosby   ← prosby.yml   (zwraca prośby do realizacji: id + nazwa dania)
// Uwierzytelnienie: token OIDC GitHuba (bez przechowywanych sekretów). Przyjmowane są tylko tokeny
// z gałęzi main tego repozytorium i tylko z workflowu przypisanego do danego zasobu.
// Zapis: jedna funkcja SQL na wywołanie (jedna transakcja), dostępna wyłącznie dla service_role.
import { verifyGithubToken } from './oidc.mjs';
import { checkCatalog, checkOffers } from './walidacja.mjs';

const REPOSITORY_ID = '1439103371'; // SirMaasdamer/obiady-na-zapas (identyfikator nie zmienia się przy zmianie nazwy)
const AUDIENCE = 'obiady-ingest';
const workflow = (file: string) => `SirMaasdamer/obiady-na-zapas/.github/workflows/${file}`;
const ROUTES: Record<string, string[]> = {
  oferty: [workflow('ceny.yml')],
  katalog: [workflow('przepisy.yml')],
  prosby: [workflow('prosby.yml')],
};
const MAX_BODY = 5_000_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function rpc(fn: string, args: unknown) {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Dozwolone tylko POST.' }, 405);
  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
  const workflows = ROUTES[route];
  if (!workflows) return json({ ok: false, error: 'Nieznany zasób.' }, 404);

  let claims: Record<string, unknown>;
  try {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    claims = await verifyGithubToken(token, { audience: AUDIENCE, repositoryId: REPOSITORY_ID, workflows });
  } catch (e) {
    console.warn('ingest: odrzucony token', String((e as Error)?.message ?? e));
    return json({ ok: false, error: 'Brak uprawnień.' }, 401);
  }

  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ ok: false, error: 'Za duże dane.' }, 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'Za duże dane.' }, 413);
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ ok: false, error: 'Niepoprawny JSON.' }, 400); }

  try {
    if (route === 'oferty') {
      const { errors, data, dropped } = checkOffers(body);
      if (errors.length) return json({ ok: false, errors: errors.slice(0, 50) }, 422);
      const runId = `gh-${claims.run_id}-${claims.run_attempt ?? 1}`;
      const result = await rpc('ingest_offers', { p_data: data, p_run_id: runId });
      return json({ ok: true, runId, dropped, ...result });
    }
    if (route === 'katalog') {
      const { errors, data } = checkCatalog(body);
      if (errors.length) return json({ ok: false, errors: errors.slice(0, 50) }, 422);
      const result = await rpc('ingest_catalog', { p_data: data, p_version: String(claims.sha ?? 'brak').slice(0, 64) });
      return json({ ok: true, ...result });
    }
    const prosby = await rpc('export_recipe_requests', { p_limit: 5 });
    return json({ ok: true, prosby });
  } catch (e) {
    console.error('ingest:', route, String((e as Error)?.message ?? e));
    return json({ ok: false, error: 'Błąd zapisu w bazie (szczegóły w logach funkcji).' }, 500);
  }
});
