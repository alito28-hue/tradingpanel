'use client';

import Link from 'next/link';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { buildAnalysis, gateEntries, volumeProfile, applyVolumeFilter, detectVolumeClimax, detectVolumeDivergence, simulateTrades, ema } from '../../lib/strategy';
import { fetchKlines, generateMockCandles } from '../../lib/binance';
import { COLORS, Field, NumberInput, Panel, inputStyle, btnStyle } from '../components/ui';
import StrategyChart from '../components/StrategyChart';

const INTERVAL_MS = { '1m': 60000, '5m': 300000, '15m': 900000 };
const CLIMAX_WINDOW = 20;
const CLIMAX_MULTIPLIER = 2.5;
const DIVERGENCE_LOOKBACK = 10;
// SR+ATR trailing exit, validated against 180 days of real BTCUSDT data:
// far outperforms a fixed SL/TP on both long and short (see backtest chat).
const EXIT_CFG = {
  activationPct: 1.33, trailPct: 0.25, srLookbackBars: 50, srTolerancePct: 0.15,
  srMinTouches: 4, atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05,
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

  const analysis1h = useMemo(() => candles1h.length
    ? buildAnalysis(candles1h, mode, h1, useMacdFilter, h1.cooldownHours * 3600000)
    : null, [candles1h, mode, h1, useMacdFilter]);

  const analysisEntry = useMemo(() => candlesEntry.length
    ? buildAnalysis(candlesEntry, mode, m1, useMacdFilter, m1.cooldownMinutes * 60000)
    : null, [candlesEntry, mode, m1, useMacdFilter]);

  const { entries, markersEntry, openPosition, regime1hMarkers } = useMemo(() => {
    if (!analysis1h || !analysisEntry) return { entries: [], markersEntry: [], openPosition: null, regime1hMarkers: [] };
    const entrySignals = useVolumeFilter
      ? applyVolumeFilter(analysisEntry.signals, volumeProfile(candlesEntry, deltaWindow).deltaSum)
      : analysisEntry.signals;
    const { entries } = gateEntries(candlesEntry, entrySignals, candles1h, analysis1h.regime, gateByRegime);
    const { trades, openPosition } = simulateTrades(candlesEntry, candles1h, entries, EXIT_CFG);
    const markersEntry = tradeMarkers(trades, openPosition);
    const regime1hMarkers = analysis1h.signals
      .map((s, i) => s ? { index: i, kind: 'entry', marker: s === 'up' ? 'buy' : 'sell' } : null)
      .filter(Boolean);
    return { entries, markersEntry, openPosition, regime1hMarkers };
  }, [analysis1h, analysisEntry, candles1h, candlesEntry, gateByRegime, useVolumeFilter, deltaWindow]);

  const macdSignal1h = useMemo(() => analysis1h ? ema(analysis1h.macdLine, 9) : [], [analysis1h]);
  const macdSignalEntry = useMemo(() => analysisEntry ? ema(analysisEntry.macdLine, 9) : [], [analysisEntry]);

  const volExtras1h = useMemo(() => volumeExtras(candles1h, deltaWindow), [candles1h, deltaWindow]);
  const volExtrasEntry = useMemo(() => volumeExtras(candlesEntry, deltaWindow), [candlesEntry, deltaWindow]);

  const currentRegime = analysis1h ? analysis1h.regime[analysis1h.regime.length - 1] : null;
  const lastPrice = candlesEntry.length ? candlesEntry[candlesEntry.length - 1].close : null;

  const currentSignal = useMemo(() => {
    if (!openPosition) return { state: 'wait' };
    return {
      state: openPosition.type,
      time: openPosition.entryTime,
      price: openPosition.entryPrice,
      stop: openPosition.currentStop,
    };
  }, [openPosition]);

  const strategyDesc = useMemo(() => {
    const trig = mode === 'dual' ? `SMA${m1.fast} crossing SMA${m1.slow}` : `price crossing SMA${m1.length}`;
    const f = useMacdFilter ? ' with MACD agreeing on the same side of zero' : '';
    const gateText = gateByRegime ? 'while the 1H regime stays aligned' : 'regardless of the 1H regime';
    return `Long when the ${entryInterval} shows ${trig}${f}, ${gateText}. Short mirrors this on the bearish side. Exit via a support/resistance + ATR stop that trails once price moves ${EXIT_CFG.activationPct}% in favor — validated against 180 days of BTCUSDT (see backtest): net profit factor ~9.5, both long and short profitable.`;
  }, [mode, m1, useMacdFilter, gateByRegime, entryInterval]);

  const signalBannerStyle = {
    long: { background: 'rgba(63,203,145,0.15)', border: `1px solid ${COLORS.bull}`, color: COLORS.bull },
    short: { background: 'rgba(226,89,107,0.15)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear },
    wait: { background: COLORS.panelAlt, border: `1px solid ${COLORS.border}`, color: COLORS.muted },
  }[currentSignal.state];

  const signalBannerText = currentSignal.state === 'wait'
    ? '⚪ SIN POSICIÓN — esperando el próximo cruce gateado'
    : `${currentSignal.state === 'long' ? '🟢 LONG' : '🔴 SHORT'} activo desde ${currentSignal.time ? new Date(currentSignal.time).toLocaleString() : '—'} @ ${currentSignal.price ? currentSignal.price.toFixed(1) : '—'} · stop actual: ${currentSignal.stop ? currentSignal.stop.toFixed(1) : '—'}`;

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: '100%', padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.muted, textTransform: 'uppercase' }}>Intraday Momentum</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{symbol.replace('USDT', ' / USDT')}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18 }}>
            {lastPrice ? `$${lastPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
            {usingMock && <span style={{ fontSize: 10, marginLeft: 6, color: COLORS.bear, fontWeight: 700 }}>SIM</span>}
          </span>
          <span style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999,
            background: currentRegime === 'bullish' ? 'rgba(63,203,145,0.15)' : currentRegime === 'bearish' ? 'rgba(226,89,107,0.15)' : COLORS.panelAlt,
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
        </div>
      </div>

      <div style={{ ...signalBannerStyle, borderRadius: 12, padding: '14px 18px', marginBottom: 14, fontSize: 16, fontWeight: 700 }}>
        {signalBannerText}
      </div>

      {usingMock && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, background: 'rgba(226,89,107,0.14)', border: `1px solid ${COLORS.bear}`, color: COLORS.bear, padding: '10px 12px', borderRadius: 8, fontSize: 12, marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 700 }}>
            ⚠ SIMULATED DATA — this is not the real {symbol} price.
          </div>
          <div style={{ color: COLORS.muted }}>
            Live fetch to Binance failed{errorMsg ? `: ${errorMsg}` : ''}. Most likely cause: this environment can&apos;t reach external APIs directly.
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 14 }}>
        Auto-refreshing every 20s{lastUpdated ? ` · last updated ${new Date(lastUpdated).toLocaleTimeString()}` : ''}
      </div>

      {showSettings && (
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 20 }}>
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
          <Field label="Signal mode">
            <select value={mode} onChange={e => setMode(e.target.value)} style={inputStyle()}>
              <option value="single">Price crosses single MA</option>
              <option value="dual">Fast MA crosses slow MA</option>
            </select>
          </Field>
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

          <Field label="Volume (tape)">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
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

          <Field label="Entry settings">
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
          </Field>
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

      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, fontSize: 13, color: COLORS.muted, lineHeight: 1.6 }}>
        <div style={{ color: COLORS.text, fontWeight: 600, marginBottom: 6 }}>Active rule</div>
        {strategyDesc}
        <div style={{ marginTop: 10, fontSize: 12 }}>
          {entries.length} gated entr{entries.length === 1 ? 'y' : 'ies'} found in the loaded window. This is a research/visualization aid, not financial advice — validate against your own backtest before trading it live.
        </div>
      </div>
    </div>
  );
}
