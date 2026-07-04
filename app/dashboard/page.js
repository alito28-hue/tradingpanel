'use client';

import Link from 'next/link';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { buildAnalysis, gateEntries, volumeProfile, applyVolumeFilter, detectVolumeClimax, detectVolumeDivergence, ema } from '../../lib/strategy';
import { fetchKlines, generateMockCandles } from '../../lib/binance';
import { COLORS, Field, NumberInput, Panel, inputStyle, btnStyle } from '../components/ui';
import VolumeChart from '../components/VolumeChart';
import MacdChart from '../components/MacdChart';

const INTERVAL_MS = { '1m': 60000, '5m': 300000, '15m': 900000 };
const CLIMAX_WINDOW = 20;
const CLIMAX_MULTIPLIER = 2.5;
const DIVERGENCE_LOOKBACK = 10;

function simulateMarkers(candles, signals, entries, regimeAt) {
  const markers = [];
  let open = null;
  const entryAtIndex = new Map(entries.map(e => [e.index, e]));
  for (let i = 0; i < candles.length; i++) {
    const e = entryAtIndex.get(i);
    if (e && !open) {
      open = { type: e.type };
      markers.push({ index: i, kind: 'entry', marker: e.type === 'long' ? 'buy' : 'sell' });
      continue;
    }
    if (open) {
      const oppositeSignal = open.type === 'long' ? 'down' : 'up';
      const regimeBroke = regimeAt(candles[i].time) !== (open.type === 'long' ? 'bullish' : 'bearish');
      if (signals[i] === oppositeSignal || regimeBroke) {
        markers.push({ index: i, kind: 'exit', marker: open.type === 'long' ? 'exitLong' : 'exitShort' });
        open = null;
      }
    }
  }
  return markers;
}

function CandleChart({ candles, lines, markers, regimeBg, height }) {
  if (!candles || candles.length < 2) return null;
  const width = 1000;
  const pad = { top: 16, right: 56, bottom: 8, left: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const n = candles.length;
  const slot = innerW / n;
  const bodyW = Math.max(1.4, slot * 0.62);

  let prices = [];
  candles.forEach(c => prices.push(c.high, c.low));
  (lines || []).forEach(l => l.values.forEach(v => { if (v != null) prices.push(v); }));
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const padP = (maxP - minP) * 0.06 || maxP * 0.01;
  const yMin = minP - padP, yMax = maxP + padP;

  const xAt = i => pad.left + i * slot + slot / 2;
  const yAt = p => pad.top + (1 - (p - yMin) / (yMax - yMin)) * innerH;

  const gridVals = [yMax, yMax - (yMax - yMin) / 3, yMax - 2 * (yMax - yMin) / 3, yMin];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height, display: 'block' }}>
      {regimeBg && candles.map((c, i) => {
        const r = regimeBg[i];
        if (!r) return null;
        return (
          <rect key={`bg-${i}`} x={pad.left + i * slot} y={pad.top} width={slot} height={innerH}
            fill={r === 'bullish' ? COLORS.bull : COLORS.bear} opacity={0.06} />
        );
      })}

      {gridVals.map((v, i) => (
        <g key={`grid-${i}`}>
          <line x1={pad.left} x2={width - pad.right} y1={yAt(v)} y2={yAt(v)} stroke={COLORS.border} strokeWidth={1} />
          <text x={width - pad.right + 6} y={yAt(v) + 3} fontSize="10" fill={COLORS.muted} fontFamily="JetBrains Mono, monospace">
            {v >= 1000 ? v.toFixed(0) : v.toFixed(2)}
          </text>
        </g>
      ))}

      {candles.map((c, i) => {
        const up = c.close >= c.open;
        const color = up ? COLORS.bull : COLORS.bear;
        const xC = xAt(i);
        const yO = yAt(c.open), yC = yAt(c.close);
        return (
          <g key={i}>
            <line x1={xC} x2={xC} y1={yAt(c.high)} y2={yAt(c.low)} stroke={color} strokeWidth={1} />
            <rect x={xC - bodyW / 2} y={Math.min(yO, yC)} width={bodyW} height={Math.max(1, Math.abs(yO - yC))} fill={color} />
          </g>
        );
      })}

      {(lines || []).map((l, li) => (
        <polyline key={li} fill="none" stroke={l.color} strokeWidth={1.4}
          points={candles.map((c, i) => l.values[i] != null ? `${xAt(i)},${yAt(l.values[i])}` : null).filter(Boolean).join(' ')} />
      ))}

      {(markers || []).map((m, mi) => {
        const xC = xAt(m.index);
        const upShape = m.marker === 'buy' || m.marker === 'exitShort';
        const y = upShape ? yAt(candles[m.index].low) + 16 : yAt(candles[m.index].high) - 16;
        let fill = COLORS.accent;
        if (m.kind === 'entry') fill = m.marker === 'buy' ? COLORS.bull : COLORS.bear;
        return (
          <g key={mi} transform={`translate(${xC}, ${y})`}>
            <polygon points={upShape ? '-6,6 6,6 0,-6' : '-6,-6 6,-6 0,6'} fill={fill} opacity={m.kind === 'entry' ? 1 : 0.9} />
          </g>
        );
      })}
    </svg>
  );
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
  const [showVolumePanel, setShowVolumePanel] = useState(false);
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

  const { entries, markersEntry, regime1hMarkers } = useMemo(() => {
    if (!analysis1h || !analysisEntry) return { entries: [], markersEntry: [], regime1hMarkers: [] };
    const entrySignals = useVolumeFilter
      ? applyVolumeFilter(analysisEntry.signals, volumeProfile(candlesEntry, deltaWindow).deltaSum)
      : analysisEntry.signals;
    const { entries, regimeAt } = gateEntries(candlesEntry, entrySignals, candles1h, analysis1h.regime, gateByRegime);
    const markersEntry = simulateMarkers(candlesEntry, entrySignals, entries, regimeAt);
    const regime1hMarkers = analysis1h.signals
      .map((s, i) => s ? { index: i, kind: 'entry', marker: s === 'up' ? 'buy' : 'sell' } : null)
      .filter(Boolean);
    return { entries, markersEntry, regime1hMarkers };
  }, [analysis1h, analysisEntry, candles1h, candlesEntry, gateByRegime, useVolumeFilter, deltaWindow]);

  const macdSignal1h = useMemo(() => analysis1h ? ema(analysis1h.macdLine, 9) : [], [analysis1h]);
  const macdSignalEntry = useMemo(() => analysisEntry ? ema(analysisEntry.macdLine, 9) : [], [analysisEntry]);

  const volExtras1h = useMemo(() => volumeExtras(candles1h, deltaWindow), [candles1h, deltaWindow]);
  const volExtrasEntry = useMemo(() => volumeExtras(candlesEntry, deltaWindow), [candlesEntry, deltaWindow]);

  const DISPLAY = 130;
  const slice = (arr) => arr.slice(-DISPLAY);
  const offset = (arr) => Math.max(0, arr.length - DISPLAY);

  const view1h = slice(candles1h);
  const viewEntry = slice(candlesEntry);
  const off1h = offset(candles1h);
  const offEntry = offset(candlesEntry);

  const reindex = (markers, off, len) => markers
    .map(m => ({ ...m, index: m.index - off }))
    .filter(m => m.index >= 0 && m.index < len);

  const currentRegime = analysis1h ? analysis1h.regime[analysis1h.regime.length - 1] : null;
  const lastPrice = candlesEntry.length ? candlesEntry[candlesEntry.length - 1].close : null;

  const strategyDesc = useMemo(() => {
    const trig = mode === 'dual' ? `SMA${m1.fast} crossing SMA${m1.slow}` : `price crossing SMA${m1.length}`;
    const f = useMacdFilter ? ' with MACD agreeing on the same side of zero' : '';
    const gateText = gateByRegime ? 'while the 1H regime stays aligned' : 'regardless of the 1H regime';
    return `Long when the ${entryInterval} shows ${trig}${f}, ${gateText}. Short mirrors this on the bearish side. Exit on the opposite ${entryInterval} signal or if the 1H regime flips — this exit rule is a placeholder until your real stop/target is wired in.`;
  }, [mode, m1, useMacdFilter, gateByRegime, entryInterval]);

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
                <input type="checkbox" checked={showVolumePanel} onChange={e => setShowVolumePanel(e.target.checked)} />
                Panel de volumen
              </label>
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
          <>
            <CandleChart
              candles={view1h}
              lines={[{ color: COLORS.accent, values: slice(analysis1h.seriesB) }]}
              markers={reindex(regime1hMarkers, off1h, view1h.length)}
              regimeBg={slice(analysis1h.regime)}
              height={260}
            />
            <div style={{ marginTop: 6 }}>
              <MacdChart macdLine={slice(analysis1h.macdLine)} signalLine={slice(macdSignal1h)} height={90} />
            </div>
            {showVolumePanel && (
              <div style={{ marginTop: 6 }}>
                <VolumeChart
                  candles={view1h}
                  delta={slice(volExtras1h.delta)}
                  climax={showClimax ? slice(volExtras1h.climax) : null}
                  divergence={showDivergence ? slice(volExtras1h.divergence) : null}
                  height={90}
                />
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel title={`Entry (${entryInterval}) — Entries & Exits`} subtitle="▲ green = long · ▼ red = short · ✕ amber-tinted = exit">
        {loading ? <LoadingBlock /> : (
          <>
            <CandleChart
              candles={viewEntry}
              lines={[{ color: COLORS.accent, values: slice(analysisEntry.seriesB) }]}
              markers={reindex(markersEntry, offEntry, viewEntry.length)}
              height={300}
            />
            <div style={{ marginTop: 6 }}>
              <MacdChart macdLine={slice(analysisEntry.macdLine)} signalLine={slice(macdSignalEntry)} height={90} />
            </div>
            {showVolumePanel && (
              <div style={{ marginTop: 6 }}>
                <VolumeChart
                  candles={viewEntry}
                  delta={slice(volExtrasEntry.delta)}
                  climax={showClimax ? slice(volExtrasEntry.climax) : null}
                  divergence={showDivergence ? slice(volExtrasEntry.divergence) : null}
                  height={90}
                />
              </div>
            )}
          </>
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
