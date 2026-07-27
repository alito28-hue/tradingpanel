// Log manual de operaciones reales (no las del bot/worker — esas ya tienen
// su propio endpoint en /api/bot-trades). Guarda en un JSON local dentro del
// repo para que Claude pueda cargarlo directo con sus herramientas de
// archivo cada vez que Alex manda el detalle de una operación, y para que
// Alex tenga la misma data si corre la app localmente (`npm run dev`).
//
// OJO deploy: en Vercel el filesystem de las funciones es de solo lectura en
// runtime (salvo /tmp, que es efímero) — el POST de acá abajo funciona en
// local pero NO persiste en la versión desplegada. La fuente de verdad real
// es el archivo app/results/manual_trades.json editado directamente.
import fs from 'fs';
import path from 'path';

const filePath = path.join(process.cwd(), 'app', 'results', 'manual_trades.json');

function readTrades() {
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

export async function GET() {
  const trades = readTrades();
  return Response.json({ trades });
}

export async function POST(req) {
  try {
    const body = await req.json();
    const trades = readTrades();
    const nextId = trades.length ? Math.max(...trades.map(t => t.id || 0)) + 1 : 1;
    const trade = {
      id: nextId,
      fecha: body.fecha || null,
      horaEntrada: body.horaEntrada || null,
      horaSalida: body.horaSalida || null,
      symbol: body.symbol || 'BTCUSDT',
      direccion: body.direccion || 'long',
      precioEntrada: body.precioEntrada != null ? Number(body.precioEntrada) : null,
      precioSalida: body.precioSalida != null ? Number(body.precioSalida) : null,
      monto: body.monto != null ? Number(body.monto) : null,
      palanca: body.palanca != null ? Number(body.palanca) : null,
      resultado: body.resultado != null ? Number(body.resultado) : null,
      gastos: body.gastos != null ? Number(body.gastos) : null,
      pnlReal: body.pnlReal != null ? Number(body.pnlReal) : null,
      notas: body.notas || '',
    };
    trades.push(trade);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(trades, null, 2));
    return Response.json({ ok: true, trade });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
