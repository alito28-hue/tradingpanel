// Protected implicitly by proxy.js's login cookie check (not excluded from
// its matcher) — no extra auth logic needed here.
export async function POST() {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.WORKER_API_SECRET;

  if (!workerUrl || !secret) {
    return Response.json({ error: 'WORKER_URL / WORKER_API_SECRET no configurados en Vercel' }, { status: 500 });
  }

  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}/alitobot/reset-circuit-breaker`, {
      method: 'POST',
      headers: { 'X-Worker-Secret': secret },
    });
    const data = await res.json();
    if (!res.ok) return Response.json(data, { status: res.status });
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: `No se pudo conectar al worker: ${err.message}` }, { status: 502 });
  }
}
