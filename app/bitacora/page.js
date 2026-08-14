'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { COLORS, Field, Panel, Stat, inputStyle, btnStyle } from '../components/ui';
import LogoutLink from '../components/LogoutLink';

const emptyForm = {
  fecha: '', horaEntrada: '', horaSalida: '', symbol: 'BTCUSDT', direccion: 'long',
  precioEntrada: '', precioSalida: '', monto: '', resultado: '', notas: '',
};

function money(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
}

// % de rentabilidad = resultado / monto invertido. null si no hay monto
// cargado (no se puede calcular, no se inventa un 0).
function pctReturn(resultado, monto) {
  const m = monto != null ? Number(monto) : null;
  if (!m) return null;
  const r = resultado != null ? Number(resultado) : 0;
  return (r / m) * 100;
}

function formatPct(p) {
  if (p == null) return '—';
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
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

const linkBtnStyle = {
  background: 'transparent', border: 'none', padding: 0, fontSize: 12, fontWeight: 600,
  fontFamily: 'inherit', textDecoration: 'underline', color: COLORS.accent, cursor: 'pointer',
};

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
    const wins = results.filter(r => r > 0);
    const losses = results.filter(r => r < 0);
    const mejor = wins.length ? Math.max(...wins) : 0;
    const peor = losses.length ? Math.min(...losses) : 0;

    const durations = g.entries.map(tradeDurationMinutes).filter(d => d != null);
    const duracionPromedio = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    const totalTrades = g.entries.length;
    const diasOperados = g.days.size;
    const tradesPorDia = diasOperados ? totalTrades / diasOperados : null;

    const montos = g.entries.map(e => e.monto).filter(m => m != null).map(Number);
    const montoTotal = montos.reduce((a, b) => a + b, 0);
    const pctRentabilidad = montoTotal ? (resultado / montoTotal) * 100 : null;

    return {
      monthKey, label, resultado, mejor, peor, duracionPromedio,
      totalTrades, diasOperados, tradesPorDia, montoTotal, pctRentabilidad,
      cerrado: monthKey < currentMonthKey,
    };
  });
}

function computeYTDStats(entries) {
  const year = String(new Date().getFullYear());
  const yearEntries = entries.filter(e => e.fecha?.slice(0, 4) === year);

  const results = yearEntries.map(e => e.resultado).filter(r => r != null).map(Number);
  const resultado = results.reduce((a, b) => a + b, 0);
  const wins = results.filter(r => r > 0);
  const losses = results.filter(r => r < 0);
  const mejor = wins.length ? Math.max(...wins) : 0;
  const peor = losses.length ? Math.min(...losses) : 0;

  const durations = yearEntries.map(tradeDurationMinutes).filter(d => d != null);
  const duracionPromedio = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

  return { year, resultado, mejor, peor, duracionPromedio, totalTrades: yearEntries.length };
}

// Agrupa por mes (más reciente primero) y ordena cada mes de forma
// cronológica ascendente para poder calcular un acumulado corrido tipo
// planilla ("Acumulado (mes)"), fila a fila, como una hoja de cálculo.
function computeHistorialGroups(entries) {
  const sorted = [...entries].sort((a, b) => {
    const da = a.fecha?.slice(0, 10) || '';
    const db = b.fecha?.slice(0, 10) || '';
    if (da !== db) return da < db ? -1 : 1;
    const ha = a.hora_entrada || '';
    const hb = b.hora_entrada || '';
    if (ha !== hb) return ha < hb ? -1 : 1;
    return a.id - b.id;
  });

  const groups = new Map();
  for (const e of sorted) {
    const dateStr = e.fecha?.slice(0, 10);
    if (!dateStr) continue;
    const monthKey = dateStr.slice(0, 7);
    if (!groups.has(monthKey)) groups.set(monthKey, []);
    groups.get(monthKey).push(e);
  }

  return [...groups.keys()].sort().reverse().map(monthKey => {
    let acumulado = 0;
    const rows = groups.get(monthKey).map(e => {
      acumulado += e.resultado != null ? Number(e.resultado) : 0;
      return { ...e, acumulado };
    });
    const [year, month] = monthKey.split('-');
    const label = `${MONTH_NAMES[Number(month) - 1]} ${year}`;
    return { monthKey, label, rows };
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
  const [expandedId, setExpandedId] = useState(null);
  const [monthOverrides, setMonthOverrides] = useState({});
  const [capitalTotal, setCapitalTotal] = useState(null);
  const [editingCapital, setEditingCapital] = useState(false);
  const [capitalInput, setCapitalInput] = useState('');
  const [savingCapital, setSavingCapital] = useState(false);

  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = e => { if (e.key === 'Escape') setLightboxUrl(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxUrl]);

  const currentMonthKey = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);
  function isMonthExpanded(monthKey) {
    return monthOverrides[monthKey] != null ? monthOverrides[monthKey] : monthKey === currentMonthKey;
  }
  function toggleMonth(monthKey) {
    setMonthOverrides(prev => ({ ...prev, [monthKey]: !isMonthExpanded(monthKey) }));
  }

  const monthlyStats = useMemo(() => computeMonthlyStats(entries || []), [entries]);
  const ytdStats = useMemo(() => computeYTDStats(entries || []), [entries]);
  const historialGroups = useMemo(() => computeHistorialGroups(entries || []), [entries]);

  // Resultado acumulado = capital invertido + resultado YTD (suma de todos los
  // meses). Rendimiento % = ese resultado sobre el capital invertido inicial.
  const resultadoAcumulado = capitalTotal != null ? capitalTotal + ytdStats.resultado : null;
  const pctRendimientoCapital = capitalTotal ? (ytdStats.resultado / capitalTotal) * 100 : null;

  useEffect(() => {
    fetch('/api/bitacora/settings', { cache: 'no-store' })
      .then(res => res.json())
      .then(data => {
        const v = data.settings?.capital_total;
        if (v != null) setCapitalTotal(Number(v));
      })
      .catch(() => {});
  }, []);

  function startEditCapital() {
    setCapitalInput(capitalTotal != null ? String(capitalTotal) : '');
    setEditingCapital(true);
  }

  async function saveCapitalTotal(e) {
    e.preventDefault();
    setSavingCapital(true);
    try {
      const res = await fetch('/api/bitacora/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capitalTotal: capitalInput }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || `Error ${res.status}`); return; }
      setCapitalTotal(Number(capitalInput));
      setEditingCapital(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingCapital(false);
    }
  }

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
      monto: entry.monto ?? '',
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
              <Field label="Monto invertido">
                <input type="number" step="any" value={form.monto} onChange={e => setForm({ ...form, monto: e.target.value })} style={{ ...inputStyle(), width: 110 }} />
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

        {!entries ? (
          <Panel title="Historial"><div style={{ color: COLORS.muted, fontSize: 13 }}>Cargando…</div></Panel>
        ) : historialGroups.length === 0 ? (
          <Panel title="Historial"><div style={{ color: COLORS.muted, fontSize: 13 }}>Todavía no hay entradas en este rango.</div></Panel>
        ) : historialGroups.map(g => {
          const stats = monthlyStats.find(s => s.monthKey === g.monthKey);
          const expanded = isMonthExpanded(g.monthKey);
          const opsLabel = `${g.rows.length} operaci${g.rows.length === 1 ? 'ón' : 'ones'}`;
          return (
            <Panel key={g.monthKey}
              title={
                <button onClick={() => toggleMonth(g.monthKey)} style={{
                  background: 'transparent', border: 'none', padding: 0, margin: 0, cursor: 'pointer',
                  font: 'inherit', fontWeight: 600, fontSize: 13, color: COLORS.text,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{ fontSize: 10, color: COLORS.muted }}>{expanded ? '▾' : '▸'}</span>
                  {g.label}
                </button>
              }
              subtitle={expanded ? opsLabel : `${opsLabel} · ${money(stats.resultado)}`}>
              {expanded && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ color: COLORS.muted, textAlign: 'left' }}>
                      <th style={{ padding: '4px 8px' }}>Día</th>
                      <th style={{ padding: '4px 8px' }}>Symbol</th>
                      <th style={{ padding: '4px 8px' }}>Dir.</th>
                      <th style={{ padding: '4px 8px' }}>Entrada → Salida</th>
                      <th style={{ padding: '4px 8px' }}>Duración</th>
                      <th style={{ padding: '4px 8px' }}>Monto</th>
                      <th style={{ padding: '4px 8px' }}>Ganancia</th>
                      <th style={{ padding: '4px 8px' }}>%</th>
                      <th style={{ padding: '4px 8px' }}>Acumulado (mes)</th>
                      <th style={{ padding: '4px 8px' }}>Tools</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map(entry => {
                      const durMin = tradeDurationMinutes(entry);
                      const isOpen = expandedId === entry.id;
                      const hasDetail = entry.notas || entry.attachments?.length > 0;
                      return (
                        <Fragment key={entry.id}>
                          <tr style={{ borderTop: `1px solid ${COLORS.border}` }}>
                            <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{Number(entry.fecha.slice(8, 10))}</td>
                            <td style={{ padding: '4px 8px', color: COLORS.muted }}>{entry.symbol}</td>
                            <td style={{ padding: '4px 8px', color: entry.direccion === 'long' ? COLORS.bull : COLORS.bear, fontWeight: 700 }}>
                              {entry.direccion === 'long' ? 'LONG' : 'SHORT'}
                            </td>
                            <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
                              {entry.hora_entrada || '—'} @ {entry.precio_entrada ?? '—'} → {entry.hora_salida || '—'} @ {entry.precio_salida ?? '—'}
                            </td>
                            <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{formatDuration(durMin)}</td>
                            <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: COLORS.muted }}>
                              {entry.monto != null ? `$${Number(entry.monto).toFixed(2)}` : '—'}
                            </td>
                            <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: entry.resultado >= 0 ? COLORS.bull : COLORS.bear }}>
                              {money(entry.resultado)}
                            </td>
                            <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: entry.monto == null ? COLORS.muted : entry.resultado >= 0 ? COLORS.bull : COLORS.bear }}>
                              {formatPct(pctReturn(entry.resultado, entry.monto))}
                            </td>
                            <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: entry.acumulado >= 0 ? COLORS.bull : COLORS.bear }}>
                              {money(entry.acumulado)}
                            </td>
                            <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                              <button onClick={() => setExpandedId(isOpen ? null : entry.id)} disabled={!hasDetail}
                                style={{ ...linkBtnStyle, opacity: hasDetail ? 1 : 0.35, cursor: hasDetail ? 'pointer' : 'default' }}>Ver</button>
                              {' - '}
                              <button onClick={() => startEdit(entry)} style={linkBtnStyle}>Editar</button>
                              {' - '}
                              <button onClick={() => removeEntry(entry.id)} style={{ ...linkBtnStyle, color: COLORS.bear }}>Borrar</button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={10} style={{ padding: '10px 8px 16px', background: COLORS.panelAlt }}>
                                {entry.notas && (
                                  <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginBottom: entry.attachments?.length ? 10 : 0 }}>{entry.notas}</div>
                                )}
                                {entry.attachments?.length > 0 && (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
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
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: `2px solid ${COLORS.border}`, fontWeight: 700 }}>
                      <td style={{ padding: '6px 8px' }} colSpan={6}>Total</td>
                      <td style={{ padding: '6px 8px', fontFamily: 'JetBrains Mono, monospace', color: stats.resultado >= 0 ? COLORS.bull : COLORS.bear }}>
                        {money(stats.resultado)}
                      </td>
                      <td style={{ padding: '6px 8px', fontFamily: 'JetBrains Mono, monospace', color: stats.pctRentabilidad == null ? COLORS.muted : stats.pctRentabilidad >= 0 ? COLORS.bull : COLORS.bear }}>
                        {formatPct(stats.pctRentabilidad)}
                      </td>
                      <td colSpan={2} />
                    </tr>
                    <tr>
                      <td style={{ padding: '6px 8px', color: COLORS.muted }} colSpan={5}>
                        Promedio operac./día: {stats.tradesPorDia != null ? stats.tradesPorDia.toFixed(1) : '—'}
                      </td>
                      <td style={{ padding: '6px 8px', color: COLORS.muted }} colSpan={5}>
                        Duración promedio: {formatDuration(stats.duracionPromedio != null ? Math.round(stats.duracionPromedio) : null)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              )}
            </Panel>
          );
        })}
        </>)}

        {tab === 'estadisticas' && (<>
        <Panel title="Capital"
          subtitle={!editingCapital && <button onClick={startEditCapital} style={linkBtnStyle}>{capitalTotal != null ? 'Editar' : 'Cargar capital total'}</button>}>
          {editingCapital ? (
            <form onSubmit={saveCapitalTotal} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Capital total ($)">
                <input type="number" step="any" value={capitalInput} onChange={e => setCapitalInput(e.target.value)}
                  style={{ ...inputStyle(), width: 140 }} autoFocus required />
              </Field>
              <button type="submit" disabled={savingCapital} style={btnStyle(true)}>{savingCapital ? 'Guardando…' : 'Guardar'}</button>
              <button type="button" onClick={() => setEditingCapital(false)} style={btnStyle()}>Cancelar</button>
            </form>
          ) : capitalTotal == null ? (
            <div style={{ color: COLORS.muted, fontSize: 13 }}>Todavía no cargaste el capital total de la cuenta. Cargalo para ver el rendimiento % sobre el capital.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
              <Stat label="Capital invertido" value={`$${capitalTotal.toFixed(2)}`} />
              <Stat label="Resultado YTD" value={money(ytdStats.resultado)} color={ytdStats.resultado >= 0 ? COLORS.bull : COLORS.bear} />
              <Stat label="Resultado acumulado" value={`$${resultadoAcumulado.toFixed(2)}`} color={ytdStats.resultado >= 0 ? COLORS.bull : COLORS.bear} />
              <Stat label="Rendimiento del capital" value={formatPct(pctRendimientoCapital)}
                color={pctRendimientoCapital == null ? COLORS.muted : pctRendimientoCapital >= 0 ? COLORS.bull : COLORS.bear} />
            </div>
          )}
        </Panel>
        {monthlyStats.length > 0 && (
          <Panel title={`Año en curso (YTD ${ytdStats.year})`} subtitle={`${ytdStats.totalTrades} operaci${ytdStats.totalTrades === 1 ? 'ón' : 'ones'}`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
              <Stat label="Resultado YTD" value={money(ytdStats.resultado)} color={ytdStats.resultado >= 0 ? COLORS.bull : COLORS.bear} />
              <Stat label="Mejor operación YTD" value={money(ytdStats.mejor)} color={COLORS.bull} />
              <Stat label="Peor operación YTD" value={money(ytdStats.peor)} color={COLORS.bear} />
              <Stat label="Duración prom. YTD" value={formatDuration(ytdStats.duracionPromedio != null ? Math.round(ytdStats.duracionPromedio) : null)} />
            </div>
          </Panel>
        )}
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
                      <th style={{ padding: '4px 8px' }}>% Rentabilidad</th>
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
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: s.pctRentabilidad == null ? COLORS.muted : s.pctRentabilidad >= 0 ? COLORS.bull : COLORS.bear }}>
                          {formatPct(s.pctRentabilidad)}
                        </td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{s.totalTrades}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{s.diasOperados}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{s.tradesPorDia != null ? s.tradesPorDia.toFixed(1) : '—'}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{formatDuration(s.duracionPromedio != null ? Math.round(s.duracionPromedio) : null)}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: COLORS.bull }}>{money(s.mejor)}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: COLORS.bear }}>{money(s.peor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 12, lineHeight: 1.6 }}>
              "Prom. operac./día" = total de operaciones del mes ÷ días en que operaste (no ÷ 30). "Duración prom." = duración promedio de una operación individual. "% Rentabilidad" = resultado total del mes ÷ monto invertido total del mes (solo cuenta operaciones con monto cargado; queda en "—" si ninguna operación del mes tiene monto). Un mes queda "Cerrado" cuando ya terminó el mes calendario; el mes actual figura "En curso".
            </div>
          </Panel>
        </>)}
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
