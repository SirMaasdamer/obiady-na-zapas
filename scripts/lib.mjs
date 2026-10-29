// Wspólne funkcje skryptów instalacji i pobierania gazetek.
export const HOUSE_EMAIL = 'dom@obiady-na-zapas.app';
const MGMT = 'https://api.supabase.com/v1';

export function env(name, required = true) {
  const v = (process.env[name] || '').trim();
  if (!v && required) throw new Error(`Brak sekretu ${name}. Dodaj go w GitHub: Settings → Secrets and variables → Actions.`);
  return v;
}

// SUPABASE_PROJECT może być samym identyfikatorem albo pełnym adresem https://xxxx.supabase.co
export function projectRef() {
  const raw = env('SUPABASE_PROJECT');
  const m = raw.match(/([a-z0-9]{20})/);
  if (!m) throw new Error('SUPABASE_PROJECT nie wygląda na identyfikator projektu (20 znaków) ani adres https://xxxx.supabase.co');
  return m[1];
}

export async function mgmt(path, init = {}) {
  const res = await fetch(MGMT + path, {
    ...init,
    headers: { Authorization: `Bearer ${env('SUPABASE_ACCESS_TOKEN')}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase API ${path}: ${res.status} ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}

export async function apiKeys(ref) {
  const keys = await mgmt(`/projects/${ref}/api-keys?reveal=true`);
  const find = (...preds) => { for (const p of preds) { const k = keys.find(p); if (k?.api_key) return k.api_key; } return null; };
  const anon = find(k => k.name === 'anon', k => k.type === 'publishable');
  const service = find(k => k.name === 'service_role', k => k.type === 'secret');
  if (!anon || !service) throw new Error('Nie udało się odczytać kluczy projektu Supabase.');
  return { url: `https://${ref}.supabase.co`, anon, service };
}

export async function adminClient() {
  const ref = projectRef();
  const k = await apiKeys(ref);
  const { createClient } = await import('@supabase/supabase-js');
  return { ...k, ref, db: createClient(k.url, k.service, { auth: { persistSession: false } }) };
}

// --- Claude API ---
export async function claude({ model, system, content, maxTokens = 8000 }) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    });
    if (res.ok) {
      const j = await res.json();
      return { text: j.content.filter(c => c.type === 'text').map(c => c.text).join(''), usage: j.usage };
    }
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(5000 * attempt); continue; }
    if (res.status === 401) throw new Error('Klucz ANTHROPIC_API_KEY jest nieprawidłowy.');
    if (res.status === 400 && /credit/i.test(body)) throw new Error('Brak środków na koncie Anthropic. Doładuj je w console.anthropic.com → Billing.');
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 400)}`);
  }
}

// Wyciąga pierwszy obiekt JSON z odpowiedzi modelu (także z bloku ```json).
export function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf('{');
  if (start < 0) throw new Error('Brak JSON w odpowiedzi');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error('Niepełny JSON w odpowiedzi');
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
