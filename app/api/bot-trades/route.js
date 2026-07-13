// Server-side proxy: the worker's /trades endpoint requires a secret header.
// Keeping the fetch here (not in client code) means WORKER_API_SECRET never
// reaches the browser bundle.
export async function GET() {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.WORKER_API_SECRET;

  if (!workerUrl || !secret) {
    return Response.json({ error: 'WORKER_URL / WORKER_API_SECRET no configurados en Vercel' }, { status: 500 });
  }

  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}/trades`, {
      headers: { 'X-Worker-Secret': secret },
      cache: 'no-store',
    });
    if (!res.ok) {
      return Response.json({ error: `Worker respondió ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: `No se pudo conectar al worker: ${err.message}` }, { status: 502 });
  }
}
