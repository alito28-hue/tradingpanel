'use client';

import Link from 'next/link';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { buildAnalysis, gateEntries, volumeProfile, applyVolumeFilter, detectVolumeClimax, detectVolumeDivergence, simulateTrades, computeMetrics, ema } from '../../lib/strategy';
import { fetchKlines, generateMockCandles } from '../../lib/binance';
import { COLORS, Field, NumberInput, Panel, Stat, inputStyle, btnStyle } from '../components/ui';
import StrategyChart from '../components/StrategyChart';
import LogoutLink from '../components/LogoutLink';

const INTERVAL_MS = { '1m': 60000, '5m': 300000, '15m': 900000 };
const CLIMAX_WINDOW = 20;
const CLIMAX_MULTIPLIER = 2.5;
const DIVERGENCE_LOOKBACK = 10;
// Argentina is fixed at UTC-3 year-round (no DST since 2009), so a plain
// IANA timezone is enough — no seasonal offset math needed.
const ART_TZ = 'America/Argentina/Buenos_Aires';
const fmtArt = (ms, opts) => ms ? new Date(ms).toLocaleString('es-AR', { timeZone: ART_TZ, ...opts }) : '—';
// SR+ATR trailing exit, validated against 180 days of real BTCUSDT data:
// far outperforms a fixed SL/TP on both long and short (see backtest chat).
const EXIT_CFG = {
  activationPct: 1.33, trailPct: 0.25, srLookbackBars: 50, srTolerancePct: 0.15,
  srMinTouches: 4, atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05, minStopAtrMultiple: 2.5,
  leverage: 10,
};

function tradeMarkers(trades, openPosition) {
  const markers = [];
  for (const t of trades) {
    markers.push({ index: t.entryIndex, kind: 'entry', marker: t.type === 'long' ? 'buy' : 'sell' });
    markers.push({ index: t.exitIndex, kind: 'exit', marker: t.type === 'long' ? 'exitLong' : 'exitShort' });
  }
  if (openPosition) {
    markers.push({ index: openPosition.entryIndex, kind: 'entry', marker: openPosition.type === 'long' ? 'buy' : 'sell' });
  }
  return markers;
}

// A 'stop' exit is, by definition, the original protective stop being hit —
function reasonLabel(reason) {
  if (reason === 'trailing') return 'trailing TP';
  if (reason === 'stop') return 'stop';
  return reason;
}

function LoadingBlock() {
  return <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: COLORS.muted, fontSize: 13 }}>Loading candles…</div>;
}

function volumeExtras(candles, deltaWindow) {
  if (!candles.length) return { delta: [], climax: [], divergence: [] };
  const { delta, deltaSum } = volumeProfile(candles, deltaWindow);
  return {
    delta,
    climax: detectVolumeClimax(candles, CLIMAX_WINDOW, CLIMAX_MULTIPLIER),
    divergence: detectVolumeDivergence(candles, deltaSum, DIVERGENCE_LOOKBACK),
  };
}

export default function DashboardPage() {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [symbolInput, setSymbolInput] = useState('BTCUSDT');
  const [entryInterval, setEntryInterval] = useState('1m');
  const [candles1h, setCandles1h] = useState([]);
  const [candlesEntry, setCandlesEntry] = useState([]);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [mode, setMode] = useState('single');
  const [useMacdFilter, setUseMacdFilter] = useState(true);
  const [gateByRegime, setGateByRegime] = useState(true);
  const [h1, setH1] = useState({ length: 200, fast: 50, slow: 200, cooldownHours: 6 });
  const [m1, setM1] = useState({ length: 200, fast: 9, slow: 21, cooldownMinutes: 0 });
  const [useVolumeFilter, setUseVolumeFilter] = useState(false);
  const [deltaWindow, setDeltaWindow] = useState(5);
  const [showClimax, setShowClimax] = useState(false);
  const [showDivergence, setShowDivergence] = useState(false);

  const load = useCallback(async (sym, interval) => {
    setLoading(true);
    try {
      const [h, e] = await Promise.all([
        fetchKlines(sym, '1h', 500),
        fetchKlines(sym, interval, 500),
      ]);
      setCandles1h(h);
      setCandlesEntry(e);
      setUsingMock(false);
      setErrorMsg(null);
    } catch (err) {
      const lastPrice = 60000 + Math.random() * 20000;
      setCandles1h(generateMockCandles(500, 3600000, lastPrice));
      setCandlesEntry(generateMockCandles(500, INTERVAL_MS[interval], lastPrice));
      setUsingMock(true);
      setErrorMsg(err && err.message ? err.message : 'Unknown fetch error');
    } finally {
      setLoading(false);
      setLastUpdated(Date.now());
    }
  }, []);

  useEffect(() => { load(symbol, entryInterval); }, [symbol, entryInterval, load]);

  useEffect(() => {
    const id = setInterval(() => load(symbol, entryInterval), 20000);
    return () => clearInterval(id);
  }, [symbol, entryInterval, load]);

  // The worker is the only process that actually decides/places orders — the
  // banner below reads its real position instead of re-simulating locally,
  // so it can never show a different "current signal" than what shows up in
  // Telegram or on Railway. See app/api/bot-history/route.js (server-side,
  // never exposes the worker's shared secret to the browser).
  const [botStatus, setBotStatus] = useState(null);
  const [botStatusError, setBotStatusError] = useState(null);

  const loadBotStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bot-history');
      const data = await res.json();
      if (!res.ok || data.error) { setBotStatusError(data.error || `Error ${res.status}`); return; }
      setBotStatusError(null);
      setBotStatus(data);
    } catch (err) {
      setBotStatusError(err.message);
    }
  }, []);

  useEffect(() => { loadBotStatus(); }, [loadBotStatus]);
  useEffect(() => {
    const id = setInterval(loadBotStatus, 20000);
    return () => clearInterval(id);
  }, [loadBotStatus]);

  const analysis1h = useMemo(() => candles1h.length
    ? buildAnalysis(candles1h, mode, h1, useMacdFilter, h1.cooldownHours * 3600000)
    : null, [candles1h, mode, h1, useMacdFilter]);

  const analysisEntry = useMemo(() => candlesEntry.length
    ? buildAnalysis(candlesEntry, mode, m1, useMacdFilter, m1.cooldownMinutes * 60000)
    : null, [candlesEntry, mode, m1, useMacdFilter]);

  const { entries, trades, markersEntry, openPosition, regime1hMarkers } = useMemo(() => {
    if (!analysis1h || !analysisEntry) return { entries: [], trades: [], markersEntry: [], openPosition: null, regime1hMarkers: [] };
    const entrySignals = useVolumeFilter
      ? applyVolumeFilter(analysisEntry.signals, volumeProfile(candlesEntry, deltaWindow).deltaSum)
      : analysisEntry.signals;
    const { entries } = gateEntries(candlesEntry, entrySignals, candles1h, analysis1h.regime, gateByRegime);
    const { trades, openPosition } = simulateTrades(candlesEntry, candles1h, entries, EXIT_CFG);
    const markersEntry = tradeMarkers(trades, openPosition);
    const regime1hMarkers = analysis1h.signals
      .map((s, i) => s ? { index: i, kind: 'entry', marker: s === 'up' ? 'buy' : 'sell' } : null)
      .filter(Boolean);
    return { entries, trades, markersEntry, openPosition, regime1hMarkers };
  }, [analysis1h, analysisEntry, candles1h, candlesEntry, gateByRegime, useVolumeFilter, deltaWindow]);

  // Real closed trades from the worker (same source as the header banner and
  // Telegram) — not a local re-simulation. That local approach produced
  // impossible overlapping "positions" and instant fake closes, since each
  // 20s poll re-simulated from scratch over a rolling, shifting window with
  // no memory of what a previous poll had already computed.
  const [tradeLog, setTradeLog] = useState(null);
  const [tradeLogError, setTradeLogError] = useState(null);
  const [tradeLogPage, setTradeLogPage] = useState(0);
  const TRADES_PER_PAGE = 5;

  const loadTradeLog = useCallback(async () => {
    try {
      const res = await fetch('/api/bot-trades');
      const data = await res.json();
      if (!res.ok || data.error) { setTradeLogError(data.error || `Error ${res.status}`); return; }
      setTradeLogError(null);
      setTradeLog(data.trades);
    } catch (err) {
      setTradeLogError(err.message);
    }
  }, []);

  useEffect(() => { loadTradeLog(); }, [loadTradeLog]);
  useEffect(() => {
    const id = setInterval(loadTradeLog, 20000);
    return () => clearInterval(id);
  }, [loadTradeLog]);

  const macdSignal1h = useMemo(() => analysis1h ? ema(analysis1h.macdLine, 9) : [], [analysis1h]);
  const macdSignalEntry = useMemo(() => analysisEntry ? ema(analysisEntry.macdLine, 9) : [], [analysisEntry]);

  const volExtras1h = useMemo(() => volumeExtras(candles1h, deltaWindow), [candles1h, deltaWindow]);
  const volExtrasEntry = useMemo(() => volumeExtras(candlesEntry, deltaWindow), [candlesEntry, deltaWindow]);

  const currentRegime = analysis1h ? analysis1h.regime[analysis1h.regime.length - 1] : null;
  const lastPrice = candlesEntry.length ? candlesEntry[candlesEntry.length - 1].close : null;

  const strategyDesc = useMemo(() => {
    const trig = mode === 'dual' ? `SMA${m1.fast} crossing SMA${m1.slow}` : `price crossing SMA${m1.length}`;
    const f = useMacdFilter ? ' with MACD agreeing on the same side of zero' : '';
    const gateText = gateByRegime ? 'while the 1H regime stays aligned' : 'regardless of the 1H regime';
    return `Long when the ${entryInterval} shows ${trig}${f}, ${gateText}. Short mirrors this on the bearish side. Exit via a support/resistance + ATR stop that trails once price moves ${EXIT_CFG.activationPct}% in favor. Ver métricas actuales (win rate, profit factor, PnL) en /backtest — no hardcodeadas acá, para que nunca queden desactualizadas si el código cambia.`;
  }, [mode, m1, useMacdFilter, gateByRegime, entryInterval]);

  // Condensed, worker-sourced signal for the sticky header — the *real*
  // state of the bot (same object the Telegram messages come from), not the
  // locally-simulated one used by the exploration charts below.
  const workerPosition = botStatus?.position;
  const workerPhase = workerPosition?.phase;
  const workerSignalStyle = {
    long: { background: 'rgba(204,255,0,0.15)', border: `1px solid ${COLORS.bull}`, color: COLORS.bull },
    short: { background: 'rgba(255,77,77,0.15)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear },
    pending: { background: COLORS.panelAlt, border: `1px solid ${COLORS.accent}`, color: COLORS.accent },
    halted: { background: 'rgba(255,77,77,0.15)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear },
    idle: { background: COLORS.panelAlt, border: `1px solid ${COLORS.border}`, color: COLORS.muted },
  }[workerPhase === 'in_position' ? workerPosition.type : workerPhase === 'awaiting_entry_fill' ? 'pending' : workerPhase === 'halted' ? 'halted' : 'idle'];

  // Every branch below is explicit about which phase it handles (mirrors the
  // worker's own explicit tick() branching) — a phase this doesn't recognize
  // falls to the last line instead of into a branch that assumes fields
  // (entryPrice, stopPrice) that only exist on in_position/awaiting_entry_fill.
  const workerSignalText = botStatusError
    ? '⚠ No se pudo conectar con el worker'
    : !botStatus
    ? 'Cargando estado del bot…'
    : workerPhase === 'halted'
    ? '🛑 Bot detenido (halted) — requiere revisión manual'
    : !workerPosition || workerPhase === 'idle'
    ? '⚪ Sin posición'
    : workerPhase === 'awaiting_entry_fill'
    ? `🟡 Orden LIMIT pendiente ${workerPosition.type === 'long' ? 'LONG' : 'SHORT'} @ ${workerPosition.entryPrice.toFixed(1)}`
    : workerPhase === 'in_position'
    ? `${workerPosition.type === 'long' ? '🟢 LONG' : '🔴 SHORT'} activo @ ${workerPosition.entryPrice.toFixed(1)} · stop inicial ${workerPosition.stopPrice.toFixed(1)}`
    : `⚪ Estado desconocido (${workerPhase})`;

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: '100%' }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 20, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}`,
        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/logo.png" width={32} height={32} alt="TradingPanel" />
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.muted, textTransform: 'uppercase' }}>Intraday Momentum</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{symbol.replace('USDT', ' / USDT')}</div>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 200 }}>
          <span style={{
            ...workerSignalStyle, borderRadius: 999, padding: '6px 14px', fontSize: 13, fontWeight: 700,
            whiteSpace: 'nowrap',
          }}>
            {workerSignalText}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18 }}>
            {lastPrice ? `$${lastPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
            {usingMock && <span style={{ fontSize: 10, marginLeft: 6, color: COLORS.bear, fontWeight: 700 }}>SIM</span>}
          </span>
          <span style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999,
            background: currentRegime === 'bullish' ? 'rgba(204,255,0,0.15)' : currentRegime === 'bearish' ? 'rgba(255,77,77,0.15)' : COLORS.panelAlt,
            color: currentRegime === 'bullish' ? COLORS.bull : currentRegime === 'bearish' ? COLORS.bear : COLORS.muted,
            fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>
            {currentRegime === 'bullish' ? '▲' : currentRegime === 'bearish' ? '▼' : null}
            1H {currentRegime || 'neutral'}
          </span>
          <button onClick={() => setShowSettings(s => !s)} style={btnStyle()}>
            ⚙ Settings
          </button>
          <button onClick={() => load(symbol, entryInterval)} style={btnStyle(true)}>
            ↻ Refresh
          </button>
          <Link href="/backtest" style={{ ...btnStyle(), textDecoration: 'none' }}>
            Backtest →
          </Link>
          <Link href="/trades" style={{ ...btnStyle(), textDecoration: 'none' }}>
            Operaciones →
          </Link>
          <Link href="/bitacora" style={{ ...btnStyle(), textDecoration: 'none' }}>
            Bitácora →
          </Link>
          <Link href="/playbook" style={{ ...btnStyle(), textDecoration: 'none' }}>
            Playbook →
          </Link>
          <Link href="/bot" style={{ ...btnStyle('outline'), textDecoration: 'none' }}>
            Bot →
          </Link>
          <LogoutLink />
        </div>
      </div>

      <div style={{ padding: '20px' }}>

      {usingMock && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, background: 'rgba(255,77,77,0.14)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear, padding: '10px 12px', borderRadius: 8, fontSize: 12, marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 700 }}>
            ⚠ SIMULATED DATA — this is not the real {symbol} price.
          </div>
          <div style={{ color: COLORS.muted }}>
            Live fetch to Binance failed{errorMsg ? `: ${errorMsg}` : ''}. Most likely cause: this environment can&apos;t reach external APIs directly.
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 14 }}>
        Auto-refreshing every 20s{lastUpdated ? ` · last updated ${fmtArt(lastUpdated, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} ART` : ''}
      </div>

      {showSettings && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 16 }}>
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minWidth: 180 }}>
            <Field label="Symbol">
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={symbolInput} onChange={e => setSymbolInput(e.target.value.toUpperCase())}
                  style={inputStyle()} placeholder="BTCUSDT" />
                <button onClick={() => setSymbol(symbolInput)} style={btnStyle(true)}>Load</button>
              </div>
            </Field>
            <Field label="Entry timeframe">
              <select value={entryInterval} onChange={e => setEntryInterval(e.target.value)} style={inputStyle()}>
                <option value="1m">1m</option>
                <option value="5m">5m</option>
                <option value="15m">15m</option>
              </select>
            </Field>
          </div>

          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minWidth: 180 }}>
            <Field label="Signal mode">
              <select value={mode} onChange={e => setMode(e.target.value)} style={inputStyle()}>
                <option value="single">Price crosses single MA</option>
                <option value="dual">Fast MA crosses slow MA</option>
              </select>
            </Field>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {mode === 'single' ? (
                <NumberInput label="MA len" value={m1.length} onChange={v => setM1({ ...m1, length: v })} />
              ) : (
                <>
                  <NumberInput label="Fast" value={m1.fast} onChange={v => setM1({ ...m1, fast: v })} />
                  <NumberInput label="Slow" value={m1.slow} onChange={v => setM1({ ...m1, slow: v })} />
                </>
              )}
              <NumberInput label="Cooldown (min)" value={m1.cooldownMinutes} onChange={v => setM1({ ...m1, cooldownMinutes: v })} />
            </div>
          </div>

          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minWidth: 180 }}>
            <Field label="MACD zero filter">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={useMacdFilter} onChange={e => setUseMacdFilter(e.target.checked)} />
                Require MACD agreement
              </label>
            </Field>
            <Field label="Regime gate">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={gateByRegime} onChange={e => setGateByRegime(e.target.checked)} />
                Gate entries by the 1H regime
              </label>
            </Field>
          </div>

          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minWidth: 190 }}>
            <Field label="Volume (tape)">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={useVolumeFilter} onChange={e => setUseVolumeFilter(e.target.checked)} />
                  Confirm with aggressor volume
                </label>
                {useVolumeFilter && (
                  <NumberInput label="Delta window" value={deltaWindow} onChange={setDeltaWindow} />
                )}
              </div>
            </Field>
            <Field label="Volumen v2">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={showClimax} onChange={e => setShowClimax(e.target.checked)} />
                  Marcar climax
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={showDivergence} onChange={e => setShowDivergence(e.target.checked)} />
                  Marcar divergencia
                </label>
              </div>
            </Field>
          </div>

          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minWidth: 180 }}>
            <Field label="1H settings">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {mode === 'single' ? (
                  <NumberInput label="MA len" value={h1.length} onChange={v => setH1({ ...h1, length: v })} />
                ) : (
                  <>
                    <NumberInput label="Fast" value={h1.fast} onChange={v => setH1({ ...h1, fast: v })} />
                    <NumberInput label="Slow" value={h1.slow} onChange={v => setH1({ ...h1, slow: v })} />
                  </>
                )}
                <NumberInput label="Cooldown (h)" value={h1.cooldownHours} onChange={v => setH1({ ...h1, cooldownHours: v })} />
              </div>
            </Field>
          </div>
        </div>
      )}

      <Panel title="1H — Regime" subtitle={analysis1h ? `${analysis1h.labelA} vs ${analysis1h.labelB}` : ''}>
        {loading ? <LoadingBlock /> : (
          <StrategyChart
            candles={candles1h}
            maLine={analysis1h.seriesB}
            markers={regime1hMarkers}
            macdLine={analysis1h.macdLine}
            macdSignal={macdSignal1h}
            volumeDelta={volExtras1h.delta}
            climax={showClimax ? volExtras1h.climax : null}
            divergence={showDivergence ? volExtras1h.divergence : null}
            height={480}
          />
        )}
      </Panel>

      <Panel title={`Entry (${entryInterval}) — Entries & Exits`} subtitle="▲ green = long · ▼ red = short · ✕ amber = exit">
        <div style={{ marginBottom: 10 }}>
          <Field label="Timeframe de este chart">
            <select value={entryInterval} onChange={e => setEntryInterval(e.target.value)} style={inputStyle()}>
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
            </select>
          </Field>
        </div>
        {loading ? <LoadingBlock /> : (
          <StrategyChart
            candles={candlesEntry}
            maLine={analysisEntry.seriesB}
            markers={markersEntry}
            macdLine={analysisEntry.macdLine}
            macdSignal={macdSignalEntry}
            volumeDelta={volExtrasEntry.delta}
            climax={showClimax ? volExtrasEntry.climax : null}
            divergence={showDivergence ? volExtrasEntry.divergence : null}
            height={520}
          />
        )}
      </Panel>

      <Panel title="Trade history" subtitle={tradeLog ? `${tradeLog.length} trade${tradeLog.length === 1 ? '' : 's'} cerrados en total · datos reales del worker` : ''}>
        {tradeLogError ? (
          <div style={{ color: COLORS.muted, fontSize: 13, lineHeight: 1.6 }}>
            No se pudo conectar con el worker ({tradeLogError}). Revisar que <code>WORKER_URL</code> y{' '}
            <code>WORKER_API_SECRET</code> estén configurados en Vercel y que el worker tenga un dominio público en Railway.
          </div>
        ) : !tradeLog ? (
          <div style={{ color: COLORS.muted, fontSize: 13 }}>Cargando…</div>
        ) : (() => {
          const metrics = computeMetrics(tradeLog);
          return metrics ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 14 }}>
              <Stat label="Win rate" value={`${metrics.winRate.toFixed(0)}%`} color={metrics.winRate >= 50 ? COLORS.bull : COLORS.bear} />
              <Stat label="Profit factor" value={metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)} color={metrics.profitFactor >= 1.2 ? COLORS.bull : COLORS.bear} />
              <Stat label="PnL neto" value={`${metrics.totalPnl >= 0 ? '+' : ''}${metrics.totalPnl.toFixed(1)}%`} color={metrics.totalPnl >= 0 ? COLORS.bull : COLORS.bear} />
              <Stat label="Max drawdown" value={`-${metrics.maxDD.toFixed(1)}%`} color={COLORS.bear} />
            </div>
          ) : null;
        })()}
        {tradeLog && tradeLog.length === 0 ? (
          <div style={{ color: COLORS.muted, fontSize: 13 }}>Ningún trade se cerró todavía.</div>
        ) : tradeLog && tradeLog.length > 0 && (() => {
          const reversed = tradeLog; // getRecentTrades() on the worker already sorts newest-first
          const totalPages = Math.max(1, Math.ceil(reversed.length / TRADES_PER_PAGE));
          const page = Math.min(tradeLogPage, totalPages - 1);
          const pageItems = reversed.slice(page * TRADES_PER_PAGE, page * TRADES_PER_PAGE + TRADES_PER_PAGE);
          return (
            <>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: COLORS.muted, textAlign: 'left' }}>
                    <th style={{ padding: '4px 8px' }}>Symbol</th>
                    <th style={{ padding: '4px 8px' }}>Entrada</th>
                    <th style={{ padding: '4px 8px' }}>Salida</th>
                    <th style={{ padding: '4px 8px' }}>Tipo</th>
                    <th style={{ padding: '4px 8px' }}>Precio in</th>
                    <th style={{ padding: '4px 8px' }}>Precio out</th>
                    <th style={{ padding: '4px 8px' }}>P&amp;L neto</th>
                    <th style={{ padding: '4px 8px' }}>Razón</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((t, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                      <td style={{ padding: '4px 8px', color: COLORS.muted }}>{t.symbol || symbol}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{fmtArt(t.entryTime)}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{fmtArt(t.exitTime)}</td>
                      <td style={{ padding: '4px 8px', color: t.type === 'long' ? COLORS.bull : COLORS.bear }}>{t.type === 'long' ? 'LONG' : 'SHORT'}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.entryPrice.toFixed(1)}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{t.exitPrice.toFixed(1)}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', color: t.netPnlPct >= 0 ? COLORS.bull : COLORS.bear }}>{t.netPnlPct >= 0 ? '+' : ''}{t.netPnlPct.toFixed(2)}%</td>
                      <td style={{ padding: '4px 8px', color: COLORS.muted }}>{reasonLabel(t.reason)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
                <button onClick={() => setTradeLogPage(p => Math.max(0, p - 1))} disabled={page === 0}
                  style={{ ...btnStyle(), opacity: page === 0 ? 0.4 : 1, cursor: page === 0 ? 'default' : 'pointer' }}>← Anterior</button>
                <span style={{ fontSize: 12, color: COLORS.muted }}>Página {page + 1} de {totalPages}</span>
                <button onClick={() => setTradeLogPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                  style={{ ...btnStyle(), opacity: page >= totalPages - 1 ? 0.4 : 1, cursor: page >= totalPages - 1 ? 'default' : 'pointer' }}>Siguiente →</button>
              </div>
            </>
          );
        })()}
      </Panel>

      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, fontSize: 13, color: COLORS.muted, lineHeight: 1.6 }}>
        <div style={{ color: COLORS.text, fontWeight: 600, marginBottom: 6 }}>Active rule (exploración)</div>
        {strategyDesc}
        <div style={{ marginTop: 10, fontSize: 12 }}>
          {entries.length} gated entr{entries.length === 1 ? 'y' : 'ies'} found in the loaded window. Esto simula con los parámetros elegidos acá arriba — puede no coincidir con la configuración real del worker.
          El estado real del bot es el que se muestra arriba, en el header. This is a research/visualization aid, not financial advice — validate against your own backtest before trading it live.
        </div>
      </div>
      </div>
    </div>
  );
}
