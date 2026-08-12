'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
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
              {entries.map(entry => (
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
                          <a href={a.url} target="_blank" rel="noreferrer">
                            <img src={a.url} alt="" style={{ width: 90, height: 90, objectFit: 'cover', borderRadius: 6, border: `1px solid ${COLORS.border}` }} />
                          </a>
                          <button onClick={() => removeAttachment(entry.id, a.id)} title="Borrar imagen" style={{
                            position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%',
                            background: COLORS.bear, color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, lineHeight: 1,
                          }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
