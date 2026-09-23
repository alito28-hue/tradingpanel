// Server-side proxy: the worker's /history endpoint requires a secret header.
// Keeping the fetch here (not in client code) means WORKER_API_SECRET never
// reaches the browser bundle. Same WORKER_URL as the signal strategy — it's
// the same Railway service, STRATEGY_MODE just picks which loop runs.
export async function GET() {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.WORKER_API_SECRET;

  if (!workerUrl || !secret) {
    return Response.json({ error: 'WORKER_URL / WORKER_API_SECRET no configurados en Vercel' }, { status: 500 });
  }

  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}/history`, {
      headers: { 'X-Worker-Secret': secret },
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) return Response.json(data, { status: res.status });
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: `No se pudo conectar al worker: ${err.message}` }, { status: 502 });
  }
}
