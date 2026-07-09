'use client';

import Link from 'next/link';
import { useState, useEffect, useMemo } from 'react';
import { fetchKlines } from '../../lib/binance';
import { checkStopDistance } from '../../lib/botSafety';
import { COLORS, Field, NumberInput, Panel, Stat, inputStyle, btnStyle } from '../components/ui';

const fmtDay = (dayKey) => {
  if (!dayKey) return '—';
  const [y, m, d] = dayKey.split('-');
  return `${d}/${m}`;
};

export default function BotConfigPage() {
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [entryInterval, setEntryInterval] = useState('1m');
  const [leverage, setLeverage] = useState(10);
  const [positionSizeUsd, setPositionSizeUsd] = useState(100);
  const [dailyLossLimitUsd, setDailyLossLimitUsd] = useState(30);
  const [pollSeconds, setPollSeconds] = useState(20);
  const [lastPrice, setLastPrice] = useState(null);
  const [botHistory, setBotHistory] = useState(null);
  const [botHistoryError, setBotHistoryError] = useState(null);
  const [historyPage, setHistoryPage] = useState(0);
  const HISTORY_PER_PAGE = 7;
  const [liveConfirmText, setLiveConfirmText] = useState('');
  const [toggleLoading, setToggleLoading] = useState(false);
  const [toggleError, setToggleError] = useState(null);

  async function loadBotHistory() {
    try {
      const res = await fetch('/api/bot-history');
      const data = await res.json();
      if (!res.ok || data.error) { setBotHistoryError(data.error || `Error ${res.status}`); return; }
      setBotHistoryError(null);
      setBotHistory(data);
    } catch (err) {
      setBotHistoryError(err.message);
    }
  }

  useEffect(() => { loadBotHistory(); }, []);

  async function switchMode(mode) {
    setToggleLoading(true);
    setToggleError(null);
    try {
      const res = await fetch('/api/bot-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setToggleError(data.error || `Error ${res.status}`); return; }
      if (data.floorBlocked) {
        setToggleError('Railway todavía tiene DRY_RUN=true — cambiala a mano ahí primero para poder activar LIVE.');
      }
      setLiveConfirmText('');
      await loadBotHistory();
    } catch (err) {
      setToggleError(err.message);
    } finally {
      setToggleLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchKlines(symbol.replace('-', ''), '1h', 2)
      .then(candles => { if (!cancelled) setLastPrice(candles[candles.length - 1].close); })
      .catch(() => { if (!cancelled) setLastPrice(null); });
    return () => { cancelled = true; };
  }, [symbol]);

  const notionalUsd = positionSizeUsd * leverage;
  const quantity = lastPrice ? notionalUsd / lastPrice : null;

  // Same 0.7x-of-liquidation-threshold safety margin the worker enforces —
  // shown here against a representative 2% stop just so the leverage choice
  // itself can be sanity-checked before touching the worker's env vars.
  const sampleCheck = useMemo(() => {
    if (!lastPrice) return null;
    const sampleStopPrice = lastPrice * 0.98;
    return checkStopDistance(lastPrice, sampleStopPrice, leverage);
  }, [lastPrice, leverage]);

  const envBlock = [
    `BOT_SYMBOL=${symbol}`,
    `BOT_ENTRY_INTERVAL=${entryInterval}`,
    `BOT_LEVERAGE=${leverage}`,
    `BOT_POSITION_SIZE_USD=${positionSizeUsd}`,
    `BOT_DAILY_LOSS_LIMIT_USD=${dailyLossLimitUsd}`,
    `BOT_POLL_MS=${pollSeconds * 1000}`,
    '',
    '# Trading real vs. simulado — cambiar a mano en el host del worker,',
    '# nunca desde esta pantalla:',
    'DRY_RUN=true',
    '',
    '# Credenciales de BingX (permisos de solo trading, sin retiro):',
    'BINGX_API_KEY=',
    'BINGX_API_SECRET=',
    '',
    '# Notificaciones Telegram (opcional, @BotFather + tu chat id):',
    'TELEGRAM_BOT_TOKEN=',
    'TELEGRAM_CHAT_ID=',
  ].join('\n');

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: '100vh', padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.muted, textTransform: 'uppercase' }}>Bot</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>Configuración — BingX Perpetual Futures</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/dashboard" style={{ ...btnStyle(), textDecoration: 'none' }}>← Dashboard</Link>
          <Link href="/backtest" style={{ ...btnStyle(), textDecoration: 'none' }}>Backtest →</Link>
        </div>
      </div>

      <div style={{ background: 'rgba(226,89,107,0.14)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear, padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
        Esta pantalla solo genera la configuración — no envía órdenes ni corre el bot. El bot corre como proceso aparte
        (<code>worker/</code>) en un host propio (VPS/Railway/Fly.io), leyendo estas mismas variables de entorno. El default
        es <strong>DRY_RUN=true</strong> (simulado, sin plata real) — pasar a real es un cambio manual en el host, no un botón acá.
      </div>

      <Panel title="Parámetros">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
          <Field label="Symbol (formato BingX)">
            <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} style={inputStyle()} placeholder="BTC-USDT" />
          </Field>
          <Field label="Timeframe de entrada">
            <select value={entryInterval} onChange={e => setEntryInterval(e.target.value)} style={inputStyle()}>
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
            </select>
          </Field>
          <NumberInput label="Apalancamiento (x)" value={leverage} onChange={setLeverage} />
          <NumberInput label="Tamaño por trade (USD margen)" value={positionSizeUsd} onChange={setPositionSizeUsd} />
          <NumberInput label="Límite pérdida diaria (USD)" value={dailyLossLimitUsd} onChange={setDailyLossLimitUsd} />
          <NumberInput label="Polling (segundos)" value={pollSeconds} onChange={setPollSeconds} />
        </div>
      </Panel>

      <Panel title="Vista previa" subtitle={lastPrice ? `Precio actual: $${lastPrice.toLocaleString()}` : 'Cargando precio…'}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: COLORS.muted, textTransform: 'uppercase' }}>Notional (margen × leverage)</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 600 }}>${notionalUsd.toLocaleString()}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: COLORS.muted, textTransform: 'uppercase' }}>Cantidad estimada</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 600 }}>{quantity ? quantity.toFixed(4) : '—'} {symbol.split('-')[0]}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: COLORS.muted, textTransform: 'uppercase' }}>Umbral seguro de stop a {leverage}x</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 600, color: sampleCheck ? COLORS.bull : COLORS.muted }}>
              {sampleCheck ? `${sampleCheck.safeThresholdPct.toFixed(2)}%` : '—'}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: COLORS.muted, lineHeight: 1.6 }}>
          El worker rechaza automáticamente cualquier señal cuyo stop SR+ATR calculado quede más lejos que este umbral —
          eso protege contra abrir una posición que podría liquidarse antes de que el stop se ejecute. Con 20x este umbral
          bajaba tanto que ~14% de los trades históricos lo hubieran superado; con 10x baja a ~1.5%.
        </div>
      </Panel>

      <Panel title=".env para el host del worker" subtitle="Copiar tal cual, completar las credenciales">
        <pre style={{
          background: COLORS.panelAlt, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 14,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 12, lineHeight: 1.6, overflowX: 'auto', color: COLORS.text,
        }}>{envBlock}</pre>
      </Panel>

      <Panel title="Modo del bot" subtitle="Test (DRY_RUN) o live (dinero real)">
        {botHistoryError || !botHistory ? (
          <div style={{ color: COLORS.muted, fontSize: 13 }}>{botHistoryError ? 'No se pudo leer el modo actual.' : 'Cargando…'}</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <span style={{
                fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 999, letterSpacing: '0.05em',
                background: botHistory.mode === 'live' ? 'rgba(226,89,107,0.16)' : 'rgba(63,203,145,0.14)',
                color: botHistory.mode === 'live' ? COLORS.bear : COLORS.bull,
                border: `1px solid ${botHistory.mode === 'live' ? COLORS.bear : COLORS.bull}`,
              }}>
                {botHistory.mode === 'live' ? '🔓 LIVE — dinero real' : '🔒 TEST — DRY_RUN'}
              </span>
            </div>

            {botHistory.mode === 'live' ? (
              <button onClick={() => switchMode('dry_run')} disabled={toggleLoading} style={{ ...btnStyle(), opacity: toggleLoading ? 0.6 : 1 }}>
                {toggleLoading ? 'Cambiando…' : 'Volver a TEST'}
              </button>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                <input
                  value={liveConfirmText}
                  onChange={e => setLiveConfirmText(e.target.value)}
                  placeholder='Escribir "LIVE" para confirmar'
                  style={{ ...inputStyle(), width: 200 }}
                />
                <button
                  onClick={() => switchMode('live')}
                  disabled={toggleLoading || liveConfirmText !== 'LIVE'}
                  style={{ ...btnStyle(true), opacity: (toggleLoading || liveConfirmText !== 'LIVE') ? 0.5 : 1 }}
                >
                  {toggleLoading ? 'Cambiando…' : 'Pasar a LIVE'}
                </button>
              </div>
            )}
            {toggleError && <div style={{ color: COLORS.bear, fontSize: 12, marginTop: 8 }}>{toggleError}</div>}

            <div style={{ fontSize: 12, color: COLORS.muted, lineHeight: 1.6, marginTop: 14 }}>
              Este toggle solo puede habilitar LIVE si <code>DRY_RUN=false</code> está puesto a mano en las Variables del
              worker en Railway — es un piso de seguridad manual que no cambia desde acá. Si Railway todavía dice
              <code> DRY_RUN=true</code>, este botón queda sin efecto aunque se confirme. El cambio de modo aplica recién
              en el próximo ciclo del worker (no afecta órdenes ya puestas en BingX).
            </div>
          </>
        )}
      </Panel>

      <Panel title="Historial diario" subtitle="PnL real/DRY_RUN del worker, día por día">
        {botHistoryError ? (
          <div style={{ color: COLORS.muted, fontSize: 13, lineHeight: 1.6 }}>
            No se pudo cargar el historial ({botHistoryError}). Revisar que <code>WORKER_URL</code> y{' '}
            <code>WORKER_API_SECRET</code> estén configurados en Vercel y que el worker tenga un dominio público en Railway.
          </div>
        ) : !botHistory ? (
          <div style={{ color: COLORS.muted, fontSize: 13 }}>Cargando…</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 14 }}>
              <Stat label="Hoy — trades" value={botHistory.today.trades} />
              <Stat label="Hoy — win rate" value={`${botHistory.today.winRate}%`} color={botHistory.today.winRate >= 50 ? COLORS.bull : COLORS.bear} />
              <Stat label="Hoy — PnL" value={`${botHistory.today.realizedPnlUsd >= 0 ? '+' : ''}${botHistory.today.realizedPnlUsd.toFixed(2)} USD`}
                color={botHistory.today.realizedPnlUsd >= 0 ? COLORS.bull : COLORS.bear} />
            </div>
            {botHistory.history.length === 0 ? (
              <div style={{ color: COLORS.muted, fontSize: 13 }}>Todavía no se cerró ningún día completo.</div>
            ) : (() => {
              const totalPages = Math.max(1, Math.ceil(botHistory.history.length / HISTORY_PER_PAGE));
              const page = Math.min(historyPage, totalPages - 1);
              const pageItems = botHistory.history.slice(page * HISTORY_PER_PAGE, page * HISTORY_PER_PAGE + HISTORY_PER_PAGE);
              return (
                <>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ color: COLORS.muted, textAlign: 'left' }}>
                        <th style={{ padding: '4px 8px' }}>Día</th>
                        <th style={{ padding: '4px 8px' }}>Trades</th>
                        <th style={{ padding: '4px 8px' }}>Win rate</th>
                        <th style={{ padding: '4px 8px' }}>PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageItems.map((d, i) => (
                        <tr key={i} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                          <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{fmtDay(d.day)}</td>
                          <td style={{ padding: '4px 8px' }}>{d.trades}</td>
                          <td style={{ padding: '4px 8px', color: d.winRate >= 50 ? COLORS.bull : COLORS.bear }}>{d.winRate}%</td>
                          <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: d.realizedPnlUsd >= 0 ? COLORS.bull : COLORS.bear }}>
                            {d.realizedPnlUsd >= 0 ? '+' : ''}{d.realizedPnlUsd.toFixed(2)} USD
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
                    <button onClick={() => setHistoryPage(p => Math.max(0, p - 1))} disabled={page === 0}
                      style={{ ...btnStyle(), opacity: page === 0 ? 0.4 : 1, cursor: page === 0 ? 'default' : 'pointer' }}>← Anterior</button>
                    <span style={{ fontSize: 12, color: COLORS.muted }}>Página {page + 1} de {totalPages}</span>
                    <button onClick={() => setHistoryPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                      style={{ ...btnStyle(), opacity: page >= totalPages - 1 ? 0.4 : 1, cursor: page >= totalPages - 1 ? 'default' : 'pointer' }}>Siguiente →</button>
                  </div>
                </>
              );
            })()}
          </>
        )}
      </Panel>

      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, fontSize: 13, color: COLORS.muted, lineHeight: 1.6 }}>
        <div style={{ color: COLORS.text, fontWeight: 600, marginBottom: 6 }}>Reglas de seguridad activas (siempre, no dependen del DRY_RUN)</div>
        Máximo 1 posición abierta a la vez · Entradas con orden LIMIT · Salidas con STOP_MARKET (inicial) + TRAILING_STOP_MARKET
        (una vez que el precio se mueve {`${1.33}%`} a favor, trailing {`${0.25}%`}) · Corte automático al superar el límite de
        pérdida diaria configurado arriba.
      </div>
    </div>
  );
}
