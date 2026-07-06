'use client';

import Link from 'next/link';
import { useState } from 'react';
import { buildAnalysis, gateEntries, simulateTrades, simulateTradesFixedPct, computeMetrics, volumeProfile, applyVolumeFilter } from '../../lib/strategy';
import { fetchKlinesPaged } from '../../lib/binance';
import { COLORS, Field, NumberInput, Panel, Stat, inputStyle, btnStyle } from '../components/ui';

export default function BacktestPage() {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [lookbackDays, setLookbackDays] = useState(7);
  const [mode] = useState('single');
  const [useMacdFilter] = useState(true);
  const [entryInterval, setEntryInterval] = useState('1m');
  const [exitMode, setExitMode] = useState('sr_atr');
  const [h1, setH1] = useState({ length: 200, cooldownHours: 6 });
  const [m1, setM1] = useState({ length: 200, cooldownMinutes: 0 });
  const [exitCfg, setExitCfg] = useState({
    activationPct: 1.33, trailPct: 0.25, srLookbackBars: 50, srTolerancePct: 0.15, srMinTouches: 4,
    atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05, slPct: 1.5, tpPct: 3,
  });
  const [useVolumeFilter, setUseVolumeFilter] = useState(false);
  const [deltaWindow, setDeltaWindow] = useState(5);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null);

  const run = async () => {
    setRunning(true); setError(null); setResults(null);
    try {
      const endTime = Date.now();
      const startTime = endTime - lookbackDays * 24 * 3600 * 1000;
      setProgress('Descargando velas de 1H…');
      const candles1h = await fetchKlinesPaged(symbol, '1h', startTime, endTime, (n) => setProgress(`Descargando velas de 1H… lote ${n}`));
      setProgress(`Descargando velas de ${entryInterval} (puede tardar según el rango)…`);
      const candlesEntry = await fetchKlinesPaged(symbol, entryInterval, startTime, endTime, (n) => setProgress(`Descargando velas de ${entryInterval}… lote ${n}`));
      setProgress('Calculando señales y simulando trades…');
      const analysis1h = buildAnalysis(candles1h, mode, h1, useMacdFilter, h1.cooldownHours * 3600000);
      const analysisEntry = buildAnalysis(candlesEntry, mode, m1, useMacdFilter, m1.cooldownMinutes * 60000);
      const entrySignals = useVolumeFilter
        ? applyVolumeFilter(analysisEntry.signals, volumeProfile(candlesEntry, deltaWindow).deltaSum)
        : analysisEntry.signals;
      const comparison = [
        { label: 'Con filtro de régimen 1H', gateByRegime: true },
        { label: 'Sin filtro de régimen 1H', gateByRegime: false },
      ].map((scenario) => {
        const { entries } = gateEntries(candlesEntry, entrySignals, candles1h, analysis1h.regime, scenario.gateByRegime);
        const trades = exitMode === 'fixed_pct'
          ? simulateTradesFixedPct(candlesEntry, entries, exitCfg)
          : simulateTrades(candlesEntry, candles1h, entries, exitCfg).trades;
        return { ...scenario, trades, metrics: computeMetrics(trades) };
      });
      setResults({
        comparison,
        entryInterval,
        candlesEntryCount: candlesEntry.length, candles1hCount: candles1h.length,
        rangeStart: candlesEntry[0]?.time, rangeEnd: candlesEntry[candlesEntry.length - 1]?.time,
      });
    } catch (err) {
      setError(err.message || 'Error desconocido');
    } finally {
      setRunning(false);
    }
  };

  const fmtDate = (ms) => ms ? new Date(ms).toLocaleString() : '—';
  const reasonLabel = (reason) => {
    if (reason === 'trailing') return 'trailing TP';
    if (reason === 'take_profit') return 'take profit';
    if (reason === 'stop_loss') return 'stop loss';
    return 'stop';
  };

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: '100vh', padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.muted, textTransform: 'uppercase' }}>Backtest</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>Intraday Momentum — datos históricos reales</div>
        </div>
        <Link href="/dashboard" style={{ ...btnStyle(), textDecoration: 'none' }}>
          ← Dashboard
        </Link>
      </div>

      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-end' }}>
        <Field label="Symbol">
          <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} style={inputStyle()} />
        </Field>
        <NumberInput label="Días hacia atrás" value={lookbackDays} onChange={setLookbackDays} />
        <Field label="Timeframe de entrada">
          <select value={entryInterval} onChange={e => setEntryInterval(e.target.value)} style={inputStyle()}>
            <option value="1m">1m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
          </select>
        </Field>
        <NumberInput label="Cooldown 1H (h)" value={h1.cooldownHours} onChange={v => setH1({ ...h1, cooldownHours: v })} />
        <NumberInput label="Cooldown entrada (min)" value={m1.cooldownMinutes} onChange={v => setM1({ ...m1, cooldownMinutes: v })} />
        <Field label="Volumen (tape)">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: COLORS.muted }}>
            <input type="checkbox" checked={useVolumeFilter} onChange={e => setUseVolumeFilter(e.target.checked)} />
            Confirmar con volumen
          </label>
        </Field>
        {useVolumeFilter && (
          <NumberInput label="Ventana delta (velas)" value={deltaWindow} onChange={setDeltaWindow} />
        )}
        <Field label="Modo de salida">
          <select value={exitMode} onChange={e => setExitMode(e.target.value)} style={inputStyle()}>
            <option value="sr_atr">SR + ATR (trailing)</option>
            <option value="fixed_pct">SL / TP fijo %</option>
          </select>
        </Field>
        <NumberInput label="Maker fee % por lado" value={exitCfg.commissionPct} onChange={v => setExitCfg({ ...exitCfg, commissionPct: v })} />
        {exitMode === 'fixed_pct' ? (
          <>
            <NumberInput label="Stop loss %" value={exitCfg.slPct} onChange={v => setExitCfg({ ...exitCfg, slPct: v })} />
            <NumberInput label="Take profit %" value={exitCfg.tpPct} onChange={v => setExitCfg({ ...exitCfg, tpPct: v })} />
          </>
        ) : (
          <>
            <NumberInput label="SR lookback (1H)" value={exitCfg.srLookbackBars} onChange={v => setExitCfg({ ...exitCfg, srLookbackBars: v })} />
            <NumberInput label="SR tolerancia %" value={exitCfg.srTolerancePct} onChange={v => setExitCfg({ ...exitCfg, srTolerancePct: v })} />
            <NumberInput label="Min touches" value={exitCfg.srMinTouches} onChange={v => setExitCfg({ ...exitCfg, srMinTouches: v })} />
            <NumberInput label="ATR ×" value={exitCfg.atrMultiplier} onChange={v => setExitCfg({ ...exitCfg, atrMultiplier: v })} />
            <NumberInput label="Trail activate %" value={exitCfg.activationPct} onChange={v => setExitCfg({ ...exitCfg, activationPct: v })} />
            <NumberInput label="Trail %" value={exitCfg.trailPct} onChange={v => setExitCfg({ ...exitCfg, trailPct: v })} />
          </>
        )}
        <button onClick={run} disabled={running} style={{ ...btnStyle(true), opacity: running ? 0.6 : 1, cursor: running ? 'default' : 'pointer' }}>
          {running ? 'Corriendo…' : 'Ejecutar backtest'}
        </button>
      </div>

      {progress && running && (
        <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 14 }}>{progress}</div>
      )}
      {error && (
        <div style={{ background: 'rgba(226,89,107,0.14)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear, padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {results && (
        <>
          <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 12 }}>
            Rango cubierto: {fmtDate(results.rangeStart)} → {fmtDate(results.rangeEnd)} · {results.candlesEntryCount.toLocaleString()} velas de {results.entryInterval} · {results.candles1hCount.toLocaleString()} velas de 1h
          </div>

          {!results.comparison?.length ? (
            <div style={{ color: COLORS.muted, fontSize: 13 }}>No se generaron entradas en este rango con la configuración actual.</div>
          ) : (
            <>
              {results.comparison.map((scenario) => {
                const metrics = scenario.metrics;
                if (!metrics) return null;
                return (
                  <div key={scenario.label} style={{ marginBottom: 18 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{scenario.label}</div>
                    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 24 }}>
                      <Stat label="Trades" value={metrics.count} />
                      <Stat label="Win rate" value={`${metrics.winRate.toFixed(0)}%`} color={metrics.winRate >= 50 ? COLORS.bull : COLORS.bear} />
                      <Stat label="Profit factor" value={metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)} color={metrics.profitFactor >= 1.2 ? COLORS.bull : COLORS.bear} />
                      <Stat label="Avg win" value={`+${metrics.avgWin.toFixed(2)}%`} color={COLORS.bull} />
                      <Stat label="Avg loss" value={`${metrics.avgLoss.toFixed(2)}%`} color={COLORS.bear} />
                      <Stat label="Expectancy/trade" value={`${metrics.expectancy >= 0 ? '+' : ''}${metrics.expectancy.toFixed(2)}%`} color={metrics.expectancy >= 0 ? COLORS.bull : COLORS.bear} />
                      <Stat label="Retorno neto" value={`${metrics.totalPnl >= 0 ? '+' : ''}${metrics.totalPnl.toFixed(1)}%`} color={metrics.totalPnl >= 0 ? COLORS.bull : COLORS.bear} />
                      <Stat label="Retorno bruto" value={`${metrics.grossTotalPnl >= 0 ? '+' : ''}${metrics.grossTotalPnl.toFixed(1)}%`} color={metrics.grossTotalPnl >= 0 ? COLORS.bull : COLORS.bear} />
                      <Stat label="Comisión total" value={`${metrics.commissionCostPct >= 0 ? '-' : ''}${Math.abs(metrics.commissionCostPct).toFixed(1)}%`} color={COLORS.bear} />
                      <Stat label="Max drawdown" value={`-${metrics.maxDD.toFixed(1)}%`} color={COLORS.bear} />
                    </div>
                    <Panel title={`Trades (${Math.min(30, scenario.trades.length)} de ${scenario.trades.length})`}>
                      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ color: COLORS.muted, textAlign: 'left' }}>
                              <th style={{ padding: '4px 8px' }}>Entrada</th>
                              <th style={{ padding: '4px 8px' }}>Salida</th>
                              <th style={{ padding: '4px 8px' }}>Dur.</th>
                              <th style={{ padding: '4px 8px' }}>Tipo</th>
                              <th style={{ padding: '4px 8px' }}>Precio in</th>
                              <th style={{ padding: '4px 8px' }}>Precio out</th>
                              <th style={{ padding: '4px 8px' }}>P&amp;L bruto</th>
                              <th style={{ padding: '4px 8px' }}>P&amp;L neto</th>
                              <th style={{ padding: '4px 8px' }}>Razón</th>
                            </tr>
                          </thead>
                          <tbody>
                            {scenario.trades.slice(-30).reverse().map((t, i) => (
                              <tr key={i} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                                <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{fmtDate(t.entryTime)}</td>
                                <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{fmtDate(t.exitTime)}</td>
                                <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{Math.round(t.durationMinutes || 0)}m</td>
                                <td style={{ padding: '4px 8px', color: t.type === 'long' ? COLORS.bull : COLORS.bear }}>{t.type === 'long' ? 'LONG' : 'SHORT'}</td>
                                <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.entryPrice.toFixed(1)}</td>
                                <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.exitPrice.toFixed(1)}</td>
                                <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: t.grossPnlPct >= 0 ? COLORS.bull : COLORS.bear }}>{t.grossPnlPct >= 0 ? '+' : ''}{t.grossPnlPct.toFixed(2)}%</td>
                                <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: t.netPnlPct >= 0 ? COLORS.bull : COLORS.bear }}>{t.netPnlPct >= 0 ? '+' : ''}{t.netPnlPct.toFixed(2)}%</td>
                                <td style={{ padding: '4px 8px', color: COLORS.muted }}>{reasonLabel(t.reason)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  </div>
                );
              })}
              <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 8 }}>
                Nota: &quot;retorno simple&quot; suma el % de cada trade sin reinvertir — no es una curva de capital compuesta. Sirve para comparar configuraciones entre sí, no como proyección de ganancia real.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
