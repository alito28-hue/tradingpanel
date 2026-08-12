import { query } from '../../../../lib/db';
import { deleteAttachment } from '../../../../lib/blob';

async function loadEntry(id) {
  const { rows } = await query(
    `SELECT e.*,
        COALESCE(
          json_agg(json_build_object('id', a.id, 'url', a.url, 'caption', a.caption) ORDER BY a.id)
          FILTER (WHERE a.id IS NOT NULL),
          '[]'
        ) AS attachments
      FROM bitacora_entries e
      LEFT JOIN bitacora_attachments a ON a.entry_id = e.id
      WHERE e.id = $1
      GROUP BY e.id`,
    [id]
  );
  return rows[0] || null;
}

export async function GET(_req, { params }) {
  const { id } = await params;
  const entry = await loadEntry(id);
  if (!entry) return Response.json({ error: 'No encontrada' }, { status: 404 });
  return Response.json({ entry });
}

export async function PUT(req, { params }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { rows } = await query(
      `UPDATE bitacora_entries SET
        fecha = $1, hora_entrada = $2, hora_salida = $3, symbol = $4, direccion = $5,
        precio_entrada = $6, precio_salida = $7, monto = $8, resultado = $9, notas = $10, updated_at = now()
       WHERE id = $11
       RETURNING id`,
      [
        body.fecha,
        body.horaEntrada || null,
        body.horaSalida || null,
        body.symbol || 'BTCUSDT',
        body.direccion || 'long',
        body.precioEntrada != null && body.precioEntrada !== '' ? Number(body.precioEntrada) : null,
        body.precioSalida != null && body.precioSalida !== '' ? Number(body.precioSalida) : null,
        body.monto != null && body.monto !== '' ? Number(body.monto) : null,
        body.resultado != null && body.resultado !== '' ? Number(body.resultado) : null,
        body.notas || '',
        id,
      ]
    );
    if (!rows.length) return Response.json({ error: 'No encontrada' }, { status: 404 });
    return Response.json({ ok: true, entry: await loadEntry(id) });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(_req, { params }) {
  try {
    const { id } = await params;
    const { rows } = await query('SELECT url FROM bitacora_attachments WHERE entry_id = $1', [id]);
    await Promise.all(rows.map(r => deleteAttachment(r.url).catch(() => {})));
    const del = await query('DELETE FROM bitacora_entries WHERE id = $1 RETURNING id', [id]);
    if (!del.rows.length) return Response.json({ error: 'No encontrada' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
