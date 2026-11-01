// Funkcja wycofana (1.11.2026). Dane wspólne wysyłają teraz workflowy GitHub do funkcji „ingest”
// (uwierzytelnienie tokenem OIDC GitHuba). Ta wersja niczego nie czyta ani nie zapisuje.
Deno.serve(() => new Response(JSON.stringify({ ok: false, error: 'Funkcja sync jest wyłączona. Dane przyjmuje funkcja ingest.' }), {
  status: 410,
  headers: { 'Content-Type': 'application/json' },
}));
