// Bitácora diaria manual: un registro por operación (puede haber varias por
// día), con texto libre y capturas de gráficos adjuntas. Separado del log
// del bot (/api/manual-trades) — este vive en Postgres (no en un JSON del
// repo) porque tiene que persistir igual en local y en el sitio desplegado.
import { query } from '../../../lib/db';

const LIST_QUERY = `
  SELECT e.id, e.fecha, e.hora_entrada, e.hora_salida, e.symbol, e.direccion,
    e.precio_entrada, e.precio_salida, e.resultado, e.notas, e.created_at, e.updated_at,
    COALESCE(
      json_agg(json_build_object('id', a.id, 'url', a.url, 'caption', a.caption) ORDER BY a.id)
      FILTER (WHERE a.id IS NOT NULL),
      '[]'
    ) AS attachments
  FROM bitacora_entries e
  LEFT JOIN bitacora_attachments a ON a.entry_id = e.id
  WHERE ($1::date IS NULL OR e.fecha >= $1) AND ($2::date IS NULL OR e.fecha <= $2)
  GROUP BY e.id
  ORDER BY e.fecha DESC, e.id DESC
`;

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;
    const { rows } = await query(LIST_QUERY, [from, to]);
    return Response.json({ entries: rows });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.fecha) return Response.json({ error: 'fecha es requerida' }, { status: 400 });

    const { rows } = await query(
      `INSERT INTO bitacora_entries
        (fecha, hora_entrada, hora_salida, symbol, direccion, precio_entrada, precio_salida, resultado, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        body.fecha,
        body.horaEntrada || null,
        body.horaSalida || null,
        body.symbol || 'BTCUSDT',
        body.direccion || 'long',
        body.precioEntrada != null && body.precioEntrada !== '' ? Number(body.precioEntrada) : null,
        body.precioSalida != null && body.precioSalida !== '' ? Number(body.precioSalida) : null,
        body.resultado != null && body.resultado !== '' ? Number(body.resultado) : null,
        body.notas || '',
      ]
    );
    return Response.json({ ok: true, entry: { ...rows[0], attachments: [] } });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
