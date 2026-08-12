// Vista imprimible de la bitácora, filtrada por rango de fechas. Server
// component sin interactividad: es la página que el endpoint de export a PDF
// (/api/bitacora/export-pdf) le pide a Puppeteer que renderice y convierta.
import { query } from '../../../lib/db';

function money(v) {
  if (v == null) return '—';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
}

async function loadEntries(from, to) {
  const { rows } = await query(
    `SELECT e.*,
        COALESCE(
          json_agg(json_build_object('id', a.id, 'url', a.url, 'caption', a.caption) ORDER BY a.id)
          FILTER (WHERE a.id IS NOT NULL),
          '[]'
        ) AS attachments
      FROM bitacora_entries e
      LEFT JOIN bitacora_attachments a ON a.entry_id = e.id
      WHERE ($1::date IS NULL OR e.fecha >= $1) AND ($2::date IS NULL OR e.fecha <= $2)
      GROUP BY e.id
      ORDER BY e.fecha ASC, e.id ASC`,
    [from || null, to || null]
  );
  return rows;
}

export default async function BitacoraPrintPage({ searchParams }) {
  const sp = await searchParams;
  const from = sp?.from || null;
  const to = sp?.to || null;
  const entries = await loadEntries(from, to);

  return (
    <>
      <style>{`
        @page { size: letter; margin: 0.6in; }
        html, body { background: #fff !important; color: #1c1c1a !important; margin: 0; font-family: -apple-system, Helvetica, Arial, sans-serif; }
        .print-page * { box-sizing: border-box; }
        .print-page .header { border-bottom: 2px solid #1c1c1a; padding-bottom: 12px; margin-bottom: 20px; }
        .print-page .header h1 { font-size: 24px; margin: 0 0 4px; }
        .print-page .header .range { font-size: 12px; color: #666; font-family: monospace; }
        .print-page .entry { break-inside: avoid; border: 1px solid #ccc; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
        .print-page .entry-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
        .print-page .entry-title { font-size: 14px; font-weight: 700; font-family: monospace; }
        .print-page .dir-long { color: #1a7a3c; }
        .print-page .dir-short { color: #c0392b; }
        .print-page .fields { display: flex; flex-wrap: wrap; gap: 14px; font-size: 11px; color: #444; margin-bottom: 8px; }
        .print-page .fields b { color: #111; font-family: monospace; }
        .print-page .notas { font-size: 12px; line-height: 1.5; white-space: pre-wrap; margin-bottom: 10px; }
        .print-page .images { display: flex; flex-wrap: wrap; gap: 8px; }
        .print-page .images img { width: 220px; max-width: 100%; border: 1px solid #ddd; border-radius: 4px; }
        .print-page .empty { color: #666; font-size: 13px; }
      `}</style>
      <div className="print-page">
        <div className="header">
          <h1>Bitácora de operaciones — BTC</h1>
          <div className="range">{from || 'inicio'} → {to || 'hoy'} · {entries.length} operaci{entries.length === 1 ? 'ón' : 'ones'}</div>
        </div>

        {entries.length === 0 ? (
          <div className="empty">No hay operaciones en este rango.</div>
        ) : (
          entries.map(e => (
            <div className="entry" key={e.id}>
              <div className="entry-top">
                <div className="entry-title">
                  {new Date(e.fecha).toLocaleDateString('es-AR')} · {e.symbol}{' '}
                  <span className={e.direccion === 'long' ? 'dir-long' : 'dir-short'}>
                    {e.direccion === 'long' ? 'LONG' : 'SHORT'}
                  </span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: e.resultado >= 0 ? '#1a7a3c' : '#c0392b' }}>
                  {money(e.resultado)}
                </div>
              </div>
              <div className="fields">
                <span>Entrada: <b>{e.hora_entrada || '—'} @ {e.precio_entrada ?? '—'}</b></span>
                <span>Salida: <b>{e.hora_salida || '—'} @ {e.precio_salida ?? '—'}</b></span>
              </div>
              {e.notas && <div className="notas">{e.notas}</div>}
              {e.attachments.length > 0 && (
                <div className="images">
                  {e.attachments.map(a => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={a.id} src={a.url} alt={a.caption || ''} />
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
