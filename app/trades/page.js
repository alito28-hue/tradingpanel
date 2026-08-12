'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { COLORS, Field, Panel, Stat, inputStyle, btnStyle } from '../components/ui';
import LogoutLink from '../components/LogoutLink';

const emptyForm = {
  fecha: '', horaEntrada: '', horaSalida: '', symbol: 'BTCUSDT', direccion: 'long',
  precioEntrada: '', precioSalida: '', monto: '', palanca: '', resultado: '', gastos: '', pnlReal: '', notas: '',
};

function money(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
}

export default function TradesPage() {
  const [trades, setTrades] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/manual-trades', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || `Error ${res.status}`); return; }
      setError(null);
      setTrades(data.trades);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    if (!trades || !trades.length) return null;
    const withPnl = trades.filter(t => t.pnlReal != null);
    if (!withPnl.length) return null;
    const wins = withPnl.filter(t => t.pnlReal > 0);
    const total = withPnl.reduce((a, t) => a + t.pnlReal, 0);
    const totalGastos = trades.reduce((a, t) => a + (t.gastos || 0), 0);
    return {
      count: trades.length,
      winRate: (wins.length / withPnl.length) * 100,
      total,
      totalGastos,
    };
  }, [trades]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/manual-trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || `Error ${res.status}`); return; }
      setForm(emptyForm);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: '100%' }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 20, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}`,
        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/logo.png" width={32} height={32} alt="TradingPanel" />
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.muted, textTransform: 'uppercase' }}>Log manual</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>Operaciones reales</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Link href="/dashboard" style={{ ...btnStyle(), textDecoration: 'none' }}>← Dashboard</Link>
          <Link href="/bitacora" style={{ ...btnStyle(), textDecoration: 'none' }}>Bitácora →</Link>
          <Link href="/backtest" style={{ ...btnStyle(), textDecoration: 'none' }}>Backtest →</Link>
          <button onClick={() => setShowForm(s => !s)} style={btnStyle(true)}>
            {showForm ? 'Cerrar' : '+ Nueva operación'}
          </button>
          <LogoutLink />
        </div>
      </div>

      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 14, lineHeight: 1.6 }}>
          Registro de operaciones reales (no simuladas, no las del bot). Alex las ejecuta manualmente y las carga acá
          (o le pasa el detalle a Claude para que las cargue) para tener el mismo historial los dos.
        </div>

        {error && (
          <div style={{ background: 'rgba(255,77,77,0.14)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear, padding: '10px 12px', borderRadius: 8, fontSize: 12, marginBottom: 14 }}>
            {error}
          </div>
        )}

        {stats && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 16 }}>
            <Stat label="Operaciones" value={stats.count} />
            <Stat label="Win rate" value={`${stats.winRate.toFixed(0)}%`} color={stats.winRate >= 50 ? COLORS.bull : COLORS.bear} />
            <Stat label="PnL real acumulado" value={money(stats.total)} color={stats.total >= 0 ? COLORS.bull : COLORS.bear} />
            <Stat label="Gastos acumulados" value={stats.totalGastos ? `$${stats.totalGastos.toFixed(2)}` : '—'} color={COLORS.muted} />
          </div>
        )}

        {showForm && (
          <Panel title="Nueva operación">
            <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <Field label="Fecha">
                <input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} style={inputStyle()} required />
              </Field>
              <Field label="Hora entrada">
                <input type="time" value={form.horaEntrada} onChange={e => setForm({ ...form, horaEntrada: e.target.value })} style={inputStyle()} />
              </Field>
              <Field label="Hora salida">
                <input type="time" value={form.horaSalida} onChange={e => setForm({ ...form, horaSalida: e.target.value })} style={inputStyle()} />
              </Field>
              <Field label="Symbol">
                <input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase() })} style={{ ...inputStyle(), width: 100 }} />
              </Field>
              <Field label="Dirección">
                <select value={form.direccion} onChange={e => setForm({ ...form, direccion: e.target.value })} style={inputStyle()}>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </Field>
              <Field label="Precio entrada">
                <input type="number" step="any" value={form.precioEntrada} onChange={e => setForm({ ...form, precioEntrada: e.target.value })} style={{ ...inputStyle(), width: 110 }} />
              </Field>
              <Field label="Precio salida">
                <input type="number" step="any" value={form.precioSalida} onChange={e => setForm({ ...form, precioSalida: e.target.value })} style={{ ...inputStyle(), width: 110 }} />
              </Field>
              <Field label="Monto (margen $)">
                <input type="number" step="any" value={form.monto} onChange={e => setForm({ ...form, monto: e.target.value })} style={{ ...inputStyle(), width: 100 }} />
              </Field>
              <Field label="Palanca">
                <input type="number" step="any" value={form.palanca} onChange={e => setForm({ ...form, palanca: e.target.value })} style={{ ...inputStyle(), width: 70 }} />
              </Field>
              <Field label="Resultado bruto $">
                <input type="number" step="any" value={form.resultado} onChange={e => setForm({ ...form, resultado: e.target.value })} style={{ ...inputStyle(), width: 100 }} />
              </Field>
              <Field label="Gastos $">
                <input type="number" step="any" value={form.gastos} onChange={e => setForm({ ...form, gastos: e.target.value })} style={{ ...inputStyle(), width: 90 }} />
              </Field>
              <Field label="PnL real $">
                <input type="number" step="any" value={form.pnlReal} onChange={e => setForm({ ...form, pnlReal: e.target.value })} style={{ ...inputStyle(), width: 100 }} required />
              </Field>
              <Field label="Notas">
                <input value={form.notas} onChange={e => setForm({ ...form, notas: e.target.value })} style={{ ...inputStyle(), width: 260 }} />
              </Field>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button type="submit" disabled={saving} style={btnStyle(true)}>{saving ? 'Guardando…' : 'Guardar'}</button>
              </div>
            </form>
          </Panel>
        )}

        <Panel title="Historial" subtitle={trades ? `${trades.length} operaci${trades.length === 1 ? 'ón' : 'ones'}` : ''}>
          {!trades ? (
            <div style={{ color: COLORS.muted, fontSize: 13 }}>Cargando…</div>
          ) : trades.length === 0 ? (
            <div style={{ color: COLORS.muted, fontSize: 13 }}>Todavía no hay operaciones cargadas.</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: COLORS.muted, textAlign: 'left' }}>
                  <th style={{ padding: '4px 8px' }}>Fecha</th>
                  <th style={{ padding: '4px 8px' }}>Entrada</th>
                  <th style={{ padding: '4px 8px' }}>Salida</th>
                  <th style={{ padding: '4px 8px' }}>Symbol</th>
                  <th style={{ padding: '4px 8px' }}>Dir.</th>
                  <th style={{ padding: '4px 8px' }}>Precio in</th>
                  <th style={{ padding: '4px 8px' }}>Precio out</th>
                  <th style={{ padding: '4px 8px' }}>Monto</th>
                  <th style={{ padding: '4px 8px' }}>Palanca</th>
                  <th style={{ padding: '4px 8px' }}>Resultado</th>
                  <th style={{ padding: '4px 8px' }}>Gastos</th>
                  <th style={{ padding: '4px 8px' }}>PnL real</th>
                  <th style={{ padding: '4px 8px' }}>Notas</th>
                </tr>
              </thead>
              <tbody>
                {[...trades].reverse().map(t => (
                  <tr key={t.id} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.fecha || '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.horaEntrada || '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.horaSalida || '—'}</td>
                    <td style={{ padding: '4px 8px', color: COLORS.muted }}>{t.symbol}</td>
                    <td style={{ padding: '4px 8px', color: t.direccion === 'long' ? COLORS.bull : COLORS.bear }}>{t.direccion === 'long' ? 'LONG' : 'SHORT'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.precioEntrada ?? '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.precioSalida ?? '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.monto != null ? `$${t.monto}` : '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.palanca != null ? `${t.palanca}x` : '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: t.resultado >= 0 ? COLORS.bull : COLORS.bear }}>{money(t.resultado)}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: COLORS.muted }}>{t.gastos != null ? `$${t.gastos}` : '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: t.pnlReal >= 0 ? COLORS.bull : COLORS.bear }}>{money(t.pnlReal)}</td>
                    <td style={{ padding: '4px 8px', color: COLORS.muted, maxWidth: 260 }}>{t.notas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
