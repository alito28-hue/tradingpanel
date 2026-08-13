import { query } from '../../../../lib/db';

export async function GET() {
  try {
    const { rows } = await query(`SELECT key, value FROM bitacora_settings`);
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    return Response.json({ settings });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req) {
  try {
    const body = await req.json();
    if (body.capitalTotal == null || body.capitalTotal === '' || Number.isNaN(Number(body.capitalTotal))) {
      return Response.json({ error: 'capitalTotal inválido' }, { status: 400 });
    }
    await query(
      `INSERT INTO bitacora_settings (key, value, updated_at) VALUES ('capital_total', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [String(Number(body.capitalTotal))]
    );
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
