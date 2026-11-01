// Dane w telefonie (IndexedDB): kopia tabel do pracy bez internetu i kolejka zapisów, które czekają na połączenie.
// Gdy IndexedDB nie działa (np. tryb prywatny starszego Safari), wszystko zostaje tylko w pamięci do zamknięcia aplikacji.
const NAME = 'obiady', VERSION = 1;
const mem = { cache: new Map(), outbox: new Map(), seq: 0 };
let opened = null;

function open() {
  return opened ??= new Promise(resolve => {
    try {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 't' });
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); opened = null; }; resolve(d); };
      r.onerror = r.onblocked = () => { console.warn('IndexedDB niedostępne:', r.error); resolve(null); };
    } catch (e) { console.warn('IndexedDB niedostępne:', e); resolve(null); }
  });
}
// jedna operacja w jednej transakcji; wynik dopiero po zatwierdzeniu transakcji
function run(d, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode), req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

/* kopia tabel: { t, data, ver, house } */
export async function cacheAll() {
  const d = await open();
  if (!d) return [...mem.cache.values()];
  return run(d, 'cache', 'readonly', s => s.getAll()).catch(e => { console.warn('cache', e); return []; });
}
export async function cachePut(entry) {
  const d = await open();
  if (!d) { mem.cache.set(entry.t, entry); return; }
  await run(d, 'cache', 'readwrite', s => s.put(entry)).catch(e => console.warn('cache', e));
}

/* kolejka zapisów: kolejność według seq; każda operacja ma klucz domu, w którym ją zrobiono */
export async function outboxAll() {
  const d = await open();
  if (!d) return [...mem.outbox.values()].sort((a, b) => a.seq - b.seq);
  return run(d, 'outbox', 'readonly', s => s.getAll()).catch(e => { console.warn('outbox', e); return []; });
}
export async function outboxAdd(op) {
  const { seq, ...rec } = op;
  const d = await open();
  if (!d) { const k = ++mem.seq; mem.outbox.set(k, { ...rec, seq: k }); return k; }
  try { return await run(d, 'outbox', 'readwrite', s => s.add(rec)); }
  catch (e) { console.warn('outbox', e); const k = ++mem.seq + 1e9; mem.outbox.set(k, { ...rec, seq: k }); return k; }
}
export async function outboxDel(seq) {
  mem.outbox.delete(seq);
  const d = await open();
  if (d) await run(d, 'outbox', 'readwrite', s => s.delete(seq)).catch(e => console.warn('outbox', e));
}

/* wszystko z tego telefonu (opuszczenie domu) */
export async function wipe() {
  mem.cache.clear(); mem.outbox.clear();
  const d = await open(); opened = null;
  d?.close();
  await new Promise(resolve => {
    try { const r = indexedDB.deleteDatabase(NAME); r.onsuccess = r.onerror = r.onblocked = () => resolve(); }
    catch { resolve(); }
  });
}
