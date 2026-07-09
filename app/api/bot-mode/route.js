// Protected implicitly by proxy.js's login cookie check (not excluded from
// its matcher) — no extra auth logic needed here.
export async function POST(request) {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.WORKER_API_SECRET;

  if (!workerUrl || !secret) {
    return Response.json({ error: 'WORKER_URL / WORKER_API_SECRET no configurados en Vercel' }, { status: 500 });
  }

  const { mode } = await request.json().catch(() => ({}));
  if (mode !== 'live' && mode !== 'dry_run') {
    return Response.json({ error: 'mode debe ser "live" o "dry_run"' }, { status: 400 });
  }

  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': secret },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json();
    if (!res.ok) return Response.json(data, { status: res.status });
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: `No se pudo conectar al worker: ${err.message}` }, { status: 502 });
  }
}
