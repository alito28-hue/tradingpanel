'use client';

import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts';
import { COLORS } from './ui';

// Lightweight Charts renders timestamps as if they were UTC. Argentina is a
// fixed UTC-3 with no DST, so shifting the epoch by -3h before feeding it in
// makes the axis/crosshair show ART wall-clock time without extra libraries.
const ART_OFFSET_SECONDS = 3 * 3600;
function toTime(ms) {
  return Math.floor(ms / 1000) - ART_OFFSET_SECONDS;
}

// Interactive replacement for the old static SVG charts (CandleChart + MacdChart +
// VolumeChart combined): real zoom/pan/hover via TradingView's own open-source
// Lightweight Charts, but plotting our own computed strategy data (MA, gated
// entries/exits, MACD, aggressor volume) — not a generic price feed.
export default function StrategyChart({
  candles, maLine, markers, macdLine, macdSignal,
  volumeDelta, climax, divergence, height = 520,
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: COLORS.panel }, textColor: COLORS.muted },
      grid: { vertLines: { color: COLORS.border }, horzLines: { color: COLORS.border } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: COLORS.border },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.bull, downColor: COLORS.bear, borderVisible: false,
      wickUpColor: COLORS.bull, wickDownColor: COLORS.bear,
    }, 0);
    const maSeries = chart.addSeries(LineSeries, { color: COLORS.accent, lineWidth: 2 }, 0);
    const priceMarkers = createSeriesMarkers(candleSeries, []);

    const macdHistSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 1 } }, 1);
    const macdLineSeries = chart.addSeries(LineSeries, { color: COLORS.accent, lineWidth: 1 }, 1);
    const macdSignalSeries = chart.addSeries(LineSeries, { color: '#5B8DEF', lineWidth: 1 }, 1);

    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' } }, 2);
    const volumeMarkers = createSeriesMarkers(volumeSeries, []);

    chart.panes()[0].setHeight(Math.round(height * 0.55));
    chart.panes()[1].setHeight(Math.round(height * 0.2));
    chart.panes()[2].setHeight(Math.round(height * 0.25));

    seriesRef.current = { candleSeries, maSeries, priceMarkers, macdHistSeries, macdLineSeries, macdSignalSeries, volumeSeries, volumeMarkers };

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s.candleSeries || !candles || !candles.length) return;

    s.candleSeries.setData(candles.map(c => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));

    s.maSeries.setData(
      candles.map((c, i) => (maLine && maLine[i] != null ? { time: toTime(c.time), value: maLine[i] } : null)).filter(Boolean)
    );

    const priceMarkerData = (markers || []).map(m => {
      const upShape = m.marker === 'buy' || m.marker === 'exitShort';
      return {
        time: toTime(candles[m.index].time),
        position: upShape ? 'belowBar' : 'aboveBar',
        color: m.kind === 'entry' ? (m.marker === 'buy' ? COLORS.bull : COLORS.bear) : COLORS.accent,
        shape: upShape ? 'arrowUp' : 'arrowDown',
        text: m.kind === 'entry' ? (m.marker === 'buy' ? 'LONG' : 'SHORT') : 'EXIT',
      };
    });
    s.priceMarkers.setMarkers(priceMarkerData);

    if (macdLine && macdSignal) {
      s.macdHistSeries.setData(candles.map((c, i) => {
        if (macdLine[i] == null || macdSignal[i] == null) return null;
        const h = macdLine[i] - macdSignal[i];
        return { time: toTime(c.time), value: h, color: h >= 0 ? COLORS.bull : COLORS.bear };
      }).filter(Boolean));
      s.macdLineSeries.setData(candles.map((c, i) => macdLine[i] != null ? { time: toTime(c.time), value: macdLine[i] } : null).filter(Boolean));
      s.macdSignalSeries.setData(candles.map((c, i) => macdSignal[i] != null ? { time: toTime(c.time), value: macdSignal[i] } : null).filter(Boolean));
    }

    if (volumeDelta) {
      s.volumeSeries.setData(candles.map((c, i) => ({
        time: toTime(c.time),
        value: c.volume || 0,
        color: (climax && climax[i]) ? COLORS.accent : (volumeDelta[i] >= 0 ? COLORS.bull : COLORS.bear),
      })));
      const divMarkerData = (divergence || []).map((d, i) => {
        if (!d) return null;
        const isBullish = d === 'bullish';
        return {
          time: toTime(candles[i].time),
          position: isBullish ? 'belowBar' : 'aboveBar',
          color: isBullish ? COLORS.bull : COLORS.bear,
          shape: isBullish ? 'arrowUp' : 'arrowDown',
          text: 'DIV',
        };
      }).filter(Boolean);
      s.volumeMarkers.setMarkers(divMarkerData);
    }

    const VISIBLE_BARS = 150;
    if (candles.length > VISIBLE_BARS) {
      chartRef.current.timeScale().setVisibleLogicalRange({ from: candles.length - VISIBLE_BARS, to: candles.length });
    } else {
      chartRef.current.timeScale().fitContent();
    }
  }, [candles, maLine, markers, macdLine, macdSignal, volumeDelta, climax, divergence]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
}
