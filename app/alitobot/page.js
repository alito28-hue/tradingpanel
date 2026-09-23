'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { COLORS, Panel, Stat, inputStyle, btnStyle } from '../components/ui';
import LogoutLink from '../components/LogoutLink';

function fmtUsd(n) {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function AlitobotPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [liveConfirmText, setLiveConfirmText] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/alitobot/history', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || json.error) { setError(json.error || `Error ${res.status}`); return; }
      setError(null);
      setData(json);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  async function runAction(path, body) {
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok || json.error) { setActionError(json.error || `Error ${res.status}`); return; }
      if (json.floorBlocked) setActionError('Railway todavía tiene DRY_RUN=true — cambiala a mano ahí primero para poder activar LIVE.');
      setLiveConfirmText('');
      await load();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  const phase = data?.position?.phase;
  const live = data?.live;
  const cargador = live?.cargador;

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: '100%' }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 20, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}`,
        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/logo.png" width={32} height={32} alt="TradingPanel" />
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.muted, textTransform: 'uppercase' }}>Estrategia BTC</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>AlitoBot</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Link href="/dashboard" style={{ ...btnStyle(), textDecoration: 'none' }}>← Dashboard</Link>
          <Link href="/bot" style={{ ...btnStyle(), textDecoration: 'none' }}>Bot (señales) →</Link>
          <LogoutLink />
        </div>
      </div>

      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 14, lineHeight: 1.6 }}>
          Martingala long-only en BTC-USDT, 5x, margen aislado. Arranque de ciclo manual (nunca reabre solo). Recargas
          según la banda de ROI% del día (se revisan una vez por día), take-profit y circuit breaker en tiempo real.
        </div>

        {error && (
          <div style={{ background: 'rgba(255,77,77,0.14)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear, padding: '10px 12px', borderRadius: 8, fontSize: 12, marginBottom: 14 }}>
            No se pudo conectar con el worker ({error}).
          </div>
        )}

        <Panel title="Estado" subtitle={data ? `Modo: ${data.mode === 'live' ? '🔓 LIVE' : '🔒 TEST'}` : ''}>
          {!data ? (
            <div style={{ color: COLORS.muted, fontSize: 13 }}>Cargando…</div>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 16 }}>
                <Stat label="Fase" value={
                  phase === 'idle' ? 'Idle' : phase === 'in_position' ? 'En posición' : phase === 'halted_circuit_breaker' ? 'Circuit breaker' : phase
                } color={phase === 'halted_circuit_breaker' ? COLORS.bear : phase === 'in_position' ? COLORS.bull : COLORS.muted} />
                {live && (
                  <>
                    <Stat label="ROI" value={`${fmtUsd(live.roiPct)}%`} color={live.roiPct >= 0 ? COLORS.bull : COLORS.bear} />
                    <Stat label="PnL flotante" value={`${fmtUsd(live.unrealizedProfitUsd)} USD`} color={live.unrealizedProfitUsd >= 0 ? COLORS.bull : COLORS.bear} />
                    <Stat label="Precio actual" value={live.markPrice.toFixed(1)} />
                    <Stat label={`Liquidación${live.liquidationEstimated ? ' (est.)' : ''}`} value={live.liquidationPrice != null ? live.liquidationPrice.toFixed(1) : '—'} color={COLORS.bear} />
                  </>
                )}
              </div>
              {cargador && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 16 }}>
                  <Stat label="Cargador activo" value={cargador.cargadorActivo} />
                  <Stat label="Balas restantes" value={`${cargador.restantesActivo} de 30`} />
                  <Stat label="Reserva (cargador 2)" value={cargador.reservaAbierta ? 'Abierta' : cargador.reservaDisponible ? 'Disponible' : 'Agotada'} />
                  <Stat label="Posición total" value={`$${live.notionalUsd.toFixed(2)} USDT (${live.positionAmt} BTC)`} />
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                {phase === 'idle' && (
                  <button onClick={() => runAction('/api/alitobot/start')} disabled={actionLoading} style={{ ...btnStyle(true), opacity: actionLoading ? 0.6 : 1 }}>
                    {actionLoading ? 'Arrancando…' : '🚀 Arrancar ciclo'}
                  </button>
                )}
                {phase === 'halted_circuit_breaker' && (
                  <button onClick={() => runAction('/api/alitobot/reset-circuit-breaker')} disabled={actionLoading} style={{ ...btnStyle(true), opacity: actionLoading ? 0.6 : 1 }}>
                    {actionLoading ? 'Reseteando…' : '🔧 Resetear circuit breaker'}
                  </button>
                )}
                {phase === 'in_position' && (
                  <button
                    onClick={() => { if (confirm('¿Cerrar la posición completa ahora mismo?')) runAction('/api/alitobot/close'); }}
                    disabled={actionLoading}
                    style={{ ...btnStyle(), borderColor: COLORS.bear, color: COLORS.bear, opacity: actionLoading ? 0.6 : 1 }}
                  >
                    {actionLoading ? 'Cerrando…' : '✋ Cerrar posición'}
                  </button>
                )}

                {data.mode === 'live' ? (
                  <button onClick={() => runAction('/api/alitobot/mode', { mode: 'dry_run' })} disabled={actionLoading} style={{ ...btnStyle(), opacity: actionLoading ? 0.6 : 1 }}>
                    Volver a TEST
                  </button>
                ) : (
                  <>
                    <input
                      value={liveConfirmText}
                      onChange={e => setLiveConfirmText(e.target.value)}
                      placeholder='Escribir "LIVE" para confirmar'
                      style={{ ...inputStyle(), width: 200 }}
                    />
                    <button
                      onClick={() => runAction('/api/alitobot/mode', { mode: 'live' })}
                      disabled={actionLoading || liveConfirmText !== 'LIVE'}
                      style={{ ...btnStyle(), opacity: (actionLoading || liveConfirmText !== 'LIVE') ? 0.5 : 1 }}
                    >
                      Pasar a LIVE
                    </button>
                  </>
                )}
              </div>
              {actionError && <div style={{ color: COLORS.bear, fontSize: 12, marginTop: 8 }}>{actionError}</div>}
              <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 12, lineHeight: 1.6 }}>
                LIVE solo puede activarse si <code>DRY_RUN=false</code> está puesto a mano en las Variables de Railway —
                es un piso de seguridad manual, este botón no lo cambia.
              </div>
            </>
          )}
        </Panel>

        <Panel title="Ciclos cerrados" subtitle={data?.cycles ? `${data.cycles.length}` : ''}>
          {!data ? (
            <div style={{ color: COLORS.muted, fontSize: 13 }}>Cargando…</div>
          ) : data.cycles.length === 0 ? (
            <div style={{ color: COLORS.muted, fontSize: 13 }}>Todavía no se cerró ningún ciclo.</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: COLORS.muted, textAlign: 'left' }}>
                  <th style={{ padding: '4px 8px' }}>Cerrado</th>
                  <th style={{ padding: '4px 8px' }}>Motivo</th>
                  <th style={{ padding: '4px 8px' }}>ROI</th>
                  <th style={{ padding: '4px 8px' }}>PnL</th>
                  <th style={{ padding: '4px 8px' }}>Entrada prom.</th>
                  <th style={{ padding: '4px 8px' }}>Salida (aprox.)</th>
                  <th style={{ padding: '4px 8px' }}>Balas usadas</th>
                </tr>
              </thead>
              <tbody>
                {data.cycles.map((c, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{fmtDate(c.closedAt)}</td>
                    <td style={{ padding: '4px 8px' }}>{c.reason === 'take_profit' ? '✅ Take profit' : c.reason === 'circuit_breaker' ? '🛑 Circuit breaker' : c.reason || '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: c.roiPct >= 0 ? COLORS.bull : COLORS.bear }}>{c.roiPct != null ? `${fmtUsd(c.roiPct)}%` : '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: c.unrealizedProfitUsd >= 0 ? COLORS.bull : COLORS.bear }}>{c.unrealizedProfitUsd != null ? `${fmtUsd(c.unrealizedProfitUsd)} USD` : '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{c.avgEntryPrice != null ? c.avgEntryPrice.toFixed(1) : '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{c.exitPriceApprox != null ? c.exitPriceApprox.toFixed(1) : '—'}</td>
                    <td style={{ padding: '4px 8px' }}>{c.balasUsed ?? '—'}</td>
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
