// Wspólne drobiazgi skryptów.
export function env(name, required = true) {
  const v = (process.env[name] || '').trim();
  if (!v && required) throw new Error(`Brak zmiennej ${name}.`);
  return v;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

// Wyciąga pierwszy obiekt JSON z tekstu (także z bloku ```json).
export function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf('{');
  if (start < 0) throw new Error('Brak JSON w tekście');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error('Niepełny JSON');
}
