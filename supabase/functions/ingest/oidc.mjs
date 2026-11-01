// Weryfikacja tokenu OIDC wystawionego przez GitHub Actions (RS256), bez zewnętrznych bibliotek.
// Korzysta z Web Crypto, więc działa w Deno (Supabase Edge Functions), w Node 20+ i w testach.
// Token dostaje tylko workflow z uprawnieniem id-token: write; forki i pull requesty z forków go nie dostaną.

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';

let jwksCache = { at: 0, value: null };

function b64urlBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function githubJwks(force = false) {
  if (!force && jwksCache.value && Date.now() - jwksCache.at < 60 * 60 * 1000) return jwksCache.value;
  const r = await fetch(GITHUB_ISSUER + '/.well-known/jwks');
  if (!r.ok) throw new Error('JWKS: HTTP ' + r.status);
  jwksCache = { at: Date.now(), value: await r.json() };
  return jwksCache.value;
}

/**
 * Sprawdza podpis i zawartość tokenu. Zwraca claims albo rzuca błąd.
 * opts: { audience, repositoryId, workflows: ['owner/repo/.github/workflows/x.yml'], ref = 'refs/heads/main',
 *         events = ['push', 'schedule', 'workflow_dispatch'], getJwks, now }
 */
export async function verifyGithubToken(token, opts) {
  const { audience, repositoryId, workflows, ref = 'refs/heads/main', events = ['push', 'schedule', 'workflow_dispatch'],
    getJwks = githubJwks, now = Date.now() } = opts;
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token: zły format');
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { throw new Error('token: nieczytelny'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('token: niedozwolony algorytm');

  let jwks = await getJwks(false);
  let jwk = jwks?.keys?.find(k => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) { jwks = await getJwks(true); jwk = jwks?.keys?.find(k => k.kid === header.kid && k.kty === 'RSA'); }
  if (!jwk) throw new Error('token: nieznany klucz');

  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('token: zły podpis');

  const t = Math.floor(now / 1000), skew = 60;
  if (claims.iss !== GITHUB_ISSUER) throw new Error('token: zły wystawca');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new Error('token: zły odbiorca');
  if (typeof claims.exp !== 'number' || claims.exp + skew < t) throw new Error('token: wygasł');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > t) throw new Error('token: jeszcze nieważny');
  if (String(claims.repository_id) !== String(repositoryId)) throw new Error('token: obce repozytorium');
  if (claims.ref !== ref) throw new Error('token: niedozwolona gałąź');
  if (!events.includes(claims.event_name)) throw new Error('token: niedozwolone zdarzenie');
  const workflow = String(claims.job_workflow_ref ?? claims.workflow_ref ?? '').split('@')[0];
  if (!workflows.includes(workflow)) throw new Error('token: niedozwolony workflow');
  return claims;
}
