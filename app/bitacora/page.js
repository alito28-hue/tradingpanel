'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { COLORS, Field, Panel, inputStyle, btnStyle } from '../components/ui';
import LogoutLink from '../components/LogoutLink';

const emptyForm = {
  fecha: '', horaEntrada: '', horaSalida: '', symbol: 'BTCUSDT', direccion: 'long',
  precioEntrada: '', precioSalida: '', resultado: '', notas: '',
};

function money(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
}

// hora_entrada/hora_salida se guardan siempre en formato 24 hs (HH:MM, tipo
// TIME de Postgres) sin importar cómo el navegador dibuje el selector.
function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function tradeDurationMinutes(entry) {
  const start = timeToMinutes(entry.hora_entrada);
  const end = timeToMinutes(entry.hora_salida);
  if (start == null || end == null) return null;
  let diff = end - start;
  if (diff < 0) diff += 24 * 60; // cruzó medianoche: se asume salida al día siguiente
  return diff;
}

function formatDuration(mins) {
  if (mins == null) return '—';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function computeMonthlyStats(entries) {
  const groups = new Map();
  for (const e of entries) {
    const dateStr = e.fecha?.slice(0, 10);
    if (!dateStr) continue;
    const monthKey = dateStr.slice(0, 7); // YYYY-MM
    if (!groups.has(monthKey)) groups.set(monthKey, { entries: [], days: new Set() });
    const g = groups.get(monthKey);
    g.entries.push(e);
    g.days.add(dateStr);
  }

  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return [...groups.keys()].sort().reverse().map(monthKey => {
    const g = groups.get(monthKey);
    const [year, month] = monthKey.split('-');
    const label = `${MONTH_NAMES[Number(month) - 1]} ${year}`;

    const results = g.entries.map(e => e.resultado).filter(r => r != null).map(Number);
    const resultado = results.reduce((a, b) => a + b, 0);
    const mejor = results.length ? Math.max(...results) : null;
    const peor = results.length ? Math.min(...results) : null;

    const durations = g.entries.map(tradeDurationMinutes).filter(d => d != null);
    const duracionPromedio = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    const totalTrades = g.entries.length;
    const diasOperados = g.days.size;
    const tradesPorDia = diasOperados ? totalTrades / diasOperados : null;

    return {
      monthKey, label, resultado, mejor, peor, duracionPromedio,
      totalTrades, diasOperados, tradesPorDia,
      cerrado: monthKey < currentMonthKey,
    };
  });
}

export default function BitacoraPage() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tab, setTab] = useState('historial');
  const [lightboxUrl, setLightboxUrl] = useState(null);

  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = e => { if (e.key === 'Escape') setLightboxUrl(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxUrl]);

  const monthlyStats = useMemo(() => computeMonthlyStats(entries || []), [entries]);

  const load = useCallback(async (f, t) => {
    try {
      const params = new URLSearchParams();
      if (f) params.set('from', f);
      if (t) params.set('to', t);
      const res = await fetch(`/api/bitacora?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || `Error ${res.status}`); return; }
      setError(null);
      setEntries(data.entries);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(from, to); }, [load, from, to]);

  function startCreate() {
    setForm(emptyForm);
    setEditingId(null);
    setPendingFiles([]);
    setShowForm(true);
  }

  function startEdit(entry) {
    setForm({
      fecha: entry.fecha?.slice(0, 10) || '',
      horaEntrada: entry.hora_entrada || '',
      horaSalida: entry.hora_salida || '',
      symbol: entry.symbol || 'BTCUSDT',
      direccion: entry.direccion || 'long',
      precioEntrada: entry.precio_entrada ?? '',
      precioSalida: entry.precio_salida ?? '',
      resultado: entry.resultado ?? '',
      notas: entry.notas || '',
    });
    setEditingId(entry.id);
    setPendingFiles([]);
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setForm(emptyForm);
    setEditingId(null);
    setPendingFiles([]);
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const url = editingId ? `/api/bitacora/${editingId}` : '/api/bitacora';
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || `Error ${res.status}`); return; }

      const entryId = data.entry.id;
      if (pendingFiles.length) {
        const fd = new FormData();
        pendingFiles.forEach(f => fd.append('files', f));
        const upRes = await fetch(`/api/bitacora/${entryId}/attachments`, { method: 'POST', body: fd });
        const upData = await upRes.json();
        if (!upRes.ok || upData.error) { setError(upData.error || `Error subiendo imágenes`); }
      }

      cancelForm();
      await load(from, to);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeEntry(id) {
    if (!confirm('¿Borrar esta operación y sus imágenes?')) return;
    try {
      const res = await fetch(`/api/bitacora/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || `Error ${res.status}`); return; }
      await load(from, to);
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeAttachment(entryId, attachmentId) {
    if (!confirm('¿Borrar esta imagen?')) return;
    try {
      const res = await fetch(`/api/bitacora/${entryId}/attachments/${attachmentId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || `Error ${res.status}`); return; }
      await load(from, to);
    } catch (err) {
      setError(err.message);
    }
  }

  function exportPdf() {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    window.location.href = `/api/bitacora/export-pdf?${params.toString()}`;
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
            <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.muted, textTransform: 'uppercase' }}>Bitácora diaria</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>Bitácora de operaciones</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Link href="/dashboard" style={{ ...btnStyle(), textDecoration: 'none' }}>← Dashboard</Link>
          <Link href="/trades" style={{ ...btnStyle(), textDecoration: 'none' }}>Log del bot →</Link>
          <button onClick={startCreate} style={btnStyle(true)}>+ Nueva entrada</button>
          <LogoutLink />
        </div>
      </div>

      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 14, lineHeight: 1.6 }}>
          Registro manual, redactado a diario: una fila por operación (puede haber varias por día), con notas libres y capturas de gráficos.
        </div>

        {error && (
          <div style={{ background: 'rgba(255,77,77,0.14)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear, padding: '10px 12px', borderRadius: 8, fontSize: 12, marginBottom: 14 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button onClick={() => setTab('historial')} style={btnStyle(tab === 'historial')}>Historial</button>
          <button onClick={() => setTab('estadisticas')} style={btnStyle(tab === 'estadisticas')}>Estadísticas</button>
        </div>

        {tab === 'historial' && (<>
        <Panel title="Rango de fechas / exportar">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <Field label="Desde">
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle()} />
            </Field>
            <Field label="Hasta">
              <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inputStyle()} />
            </Field>
            <button onClick={exportPdf} style={btnStyle('outline')}>Exportar PDF</button>
          </div>
        </Panel>

        {showForm && (
          <Panel title={editingId ? 'Editar entrada' : 'Nueva entrada'}>
            <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 10 }}>
              La hora se guarda en formato 24 hs (ej: 15:00 = 3 de la tarde, 03:00 = 3 de la mañana).
            </div>
            <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <Field label="Fecha">
                <input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} style={inputStyle()} required />
              </Field>
              <Field label="Hora entrada (24 hs)">
                <input type="time" lang="es-AR" value={form.horaEntrada} onChange={e => setForm({ ...form, horaEntrada: e.target.value })} style={inputStyle()} />
              </Field>
              <Field label="Hora salida (24 hs)">
                <input type="time" lang="es-AR" value={form.horaSalida} onChange={e => setForm({ ...form, horaSalida: e.target.value })} style={inputStyle()} />
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
              <Field label="Resultado $">
                <input type="number" step="any" value={form.resultado} onChange={e => setForm({ ...form, resultado: e.target.value })} style={{ ...inputStyle(), width: 100 }} />
              </Field>
              <Field label="Imágenes">
                <input type="file" accept="image/*" multiple onChange={e => setPendingFiles(Array.from(e.target.files))} style={{ fontSize: 12 }} />
              </Field>
              <div style={{ flexBasis: '100%' }}>
                <Field label="Notas">
                  <textarea value={form.notas} onChange={e => setForm({ ...form, notas: e.target.value })}
                    rows={4} style={{ ...inputStyle(), width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
                </Field>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" disabled={saving} style={btnStyle(true)}>{saving ? 'Guardando…' : 'Guardar'}</button>
                <button type="button" onClick={cancelForm} style={btnStyle()}>Cancelar</button>
              </div>
            </form>
          </Panel>
        )}

        <Panel title="Historial" subtitle={entries ? `${entries.length} operaci${entries.length === 1 ? 'ón' : 'ones'}` : ''}>
          {!entries ? (
            <div style={{ color: COLORS.muted, fontSize: 13 }}>Cargando…</div>
          ) : entries.length === 0 ? (
            <div style={{ color: COLORS.muted, fontSize: 13 }}>Todavía no hay entradas en este rango.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {entries.map(entry => {
                const durMin = tradeDurationMinutes(entry);
                return (
                <div key={entry.id} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, alignItems: 'center' }}>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>{entry.fecha?.slice(0, 10)}</span>
                      <span style={{ color: COLORS.muted }}>{entry.symbol}</span>
                      <span style={{ color: entry.direccion === 'long' ? COLORS.bull : COLORS.bear, fontWeight: 700 }}>
                        {entry.direccion === 'long' ? 'LONG' : 'SHORT'}
                      </span>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        {entry.hora_entrada || '—'} @ {entry.precio_entrada ?? '—'} → {entry.hora_salida || '—'} @ {entry.precio_salida ?? '—'}
                      </span>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', color: COLORS.muted }}>
                        {formatDuration(durMin)}
                      </span>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: entry.resultado >= 0 ? COLORS.bull : COLORS.bear }}>
                        {money(entry.resultado)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => startEdit(entry)} style={btnStyle()}>Editar</button>
                      <button onClick={() => removeEntry(entry.id)} style={{ ...btnStyle(), color: COLORS.bear, borderColor: COLORS.bear }}>Borrar</button>
                    </div>
                  </div>
                  {entry.notas && (
                    <div style={{ fontSize: 12, color: COLORS.text, marginTop: 8, whiteSpace: 'pre-wrap' }}>{entry.notas}</div>
                  )}
                  {entry.attachments?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                      {entry.attachments.map(a => (
                        <div key={a.id} style={{ position: 'relative' }}>
                          <img src={a.url} alt="" onClick={() => setLightboxUrl(a.url)}
                            style={{ width: 90, height: 90, objectFit: 'cover', borderRadius: 6, border: `1px solid ${COLORS.border}`, cursor: 'zoom-in' }} />
                          <button onClick={() => removeAttachment(entry.id, a.id)} title="Borrar imagen" style={{
                            position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%',
                            background: COLORS.bear, color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, lineHeight: 1,
                          }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );})}
            </div>
          )}
        </Panel>
        </>)}

        {tab === 'estadisticas' && (
          <Panel title="Estadísticas por mes" subtitle={monthlyStats.length ? `${monthlyStats.length} mes${monthlyStats.length === 1 ? '' : 'es'}` : ''}>
            {!entries ? (
              <div style={{ color: COLORS.muted, fontSize: 13 }}>Cargando…</div>
            ) : monthlyStats.length === 0 ? (
              <div style={{ color: COLORS.muted, fontSize: 13 }}>Todavía no hay entradas para calcular estadísticas.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ color: COLORS.muted, textAlign: 'left' }}>
                      <th style={{ padding: '4px 8px' }}>Mes</th>
                      <th style={{ padding: '4px 8px' }}>Estado</th>
                      <th style={{ padding: '4px 8px' }}>Resultado</th>
                      <th style={{ padding: '4px 8px' }}>Operaciones</th>
                      <th style={{ padding: '4px 8px' }}>Días operados</th>
                      <th style={{ padding: '4px 8px' }}>Prom. operac./día</th>
                      <th style={{ padding: '4px 8px' }}>Duración prom.</th>
                      <th style={{ padding: '4px 8px' }}>Mejor operación</th>
                      <th style={{ padding: '4px 8px' }}>Peor operación</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthlyStats.map(s => (
                      <tr key={s.monthKey} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                        <td style={{ padding: '4px 8px', fontWeight: 700 }}>{s.label}</td>
                        <td style={{ padding: '4px 8px', color: s.cerrado ? COLORS.muted : COLORS.accent }}>{s.cerrado ? 'Cerrado' : 'En curso'}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: s.resultado >= 0 ? COLORS.bull : COLORS.bear }}>{money(s.resultado)}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{s.totalTrades}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{s.diasOperados}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{s.tradesPorDia != null ? s.tradesPorDia.toFixed(1) : '—'}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{formatDuration(s.duracionPromedio != null ? Math.round(s.duracionPromedio) : null)}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: COLORS.bull }}>{s.mejor != null ? money(s.mejor) : '—'}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: COLORS.bear }}>{s.peor != null ? money(s.peor) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 12, lineHeight: 1.6 }}>
              "Prom. operac./día" = total de operaciones del mes ÷ días en que operaste (no ÷ 30). "Duración prom." = duración promedio de una operación individual. Un mes queda "Cerrado" cuando ya terminó el mes calendario; el mes actual figura "En curso".
            </div>
          </Panel>
        )}
      </div>

      {lightboxUrl && (
        <div onClick={() => setLightboxUrl(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 24, cursor: 'zoom-out',
        }}>
          <img src={lightboxUrl} alt="" onClick={e => e.stopPropagation()}
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, border: `1px solid ${COLORS.border}`, cursor: 'default' }} />
          <button onClick={() => setLightboxUrl(null)} title="Cerrar" style={{
            position: 'absolute', top: 20, right: 20, width: 36, height: 36, borderRadius: '50%',
            background: COLORS.panelAlt, color: COLORS.text, border: `1px solid ${COLORS.border}`, cursor: 'pointer', fontSize: 18, lineHeight: 1,
          }}>×</button>
        </div>
      )}
    </div>
  );
}
