function sma(values, length) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    sum += v;
    if (i >= length) sum -= values[i - length] || 0;
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

function ema(values, length) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (length + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out[i] = prev; continue; }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function macdLineOf(closes, fast = 12, slow = 26) {
  const f = ema(closes, fast), s = ema(closes, slow);
  return closes.map((_, i) => (f[i] != null && s[i] != null) ? f[i] - s[i] : null);
}

function trueRangeSeries(candles) {
  const tr = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { tr[i] = candles[i].high - candles[i].low; continue; }
    const c = candles[i], pc = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  return tr;
}

function atrSeries(candles, length) { return sma(trueRangeSeries(candles), length); }

function buildAnalysis(candles, mode, sub, useMacdFilter, cooldownMs) {
  const closes = candles.map(c => c.close);
  let seriesA, seriesB, labelA, labelB;
  if (mode === 'dual') {
    seriesA = sma(closes, sub.fast);
    seriesB = sma(closes, sub.slow);
    labelA = `SMA ${sub.fast}`;
    labelB = `SMA ${sub.slow}`;
  } else {
    seriesA = closes;
    seriesB = sma(closes, sub.length);
    labelA = 'Price';
    labelB = `SMA ${sub.length}`;
  }
  const macdLine = macdLineOf(closes);
  const signals = new Array(candles.length).fill(null);
  let lastTime = -Infinity;
  for (let i = 1; i < candles.length; i++) {
    if ([seriesA[i - 1], seriesB[i - 1], seriesA[i], seriesB[i]].some(v => v == null)) continue;
    const up = seriesA[i - 1] <= seriesB[i - 1] && seriesA[i] > seriesB[i];
    const down = seriesA[i - 1] >= seriesB[i - 1] && seriesA[i] < seriesB[i];
    const filterUp = useMacdFilter ? (macdLine[i] != null && macdLine[i] > 0) : true;
    const filterDown = useMacdFilter ? (macdLine[i] != null && macdLine[i] < 0) : true;
    const timeOk = (candles[i].time - lastTime) >= cooldownMs;
    if (up && filterUp && timeOk) { signals[i] = 'up'; lastTime = candles[i].time; }
    else if (down && filterDown && timeOk) { signals[i] = 'down'; lastTime = candles[i].time; }
  }
  const regime = new Array(candles.length).fill(null);
  let cur = null;
  for (let i = 0; i < candles.length; i++) {
    if (signals[i] === 'up') cur = 'bullish';
    else if (signals[i] === 'down') cur = 'bearish';
    regime[i] = cur;
  }
  return { seriesA, seriesB, labelA, labelB, macdLine, signals, regime };
}

function gateEntries(candles1m, signals1m, candles1h, regime1h, gateByRegime = true) {
  const closesByTime = candles1h.map((c, i) => ({ closeTime: c.closeTime, regime: regime1h[i] }));
  function regimeAt(time) {
    let result = null;
    for (let i = 0; i < closesByTime.length; i++) {
      if (closesByTime[i].closeTime <= time) result = closesByTime[i].regime;
      else break;
    }
    return result;
  }
  const entries = [];
  for (let i = 0; i < candles1m.length; i++) {
    const targetRegime = signals1m[i] === 'up' ? 'bullish' : signals1m[i] === 'down' ? 'bearish' : null;
    if (!targetRegime) continue;
    const regimeOk = !gateByRegime || regimeAt(candles1m[i].time) === targetRegime;
    if (regimeOk) entries.push({ index: i, type: signals1m[i] === 'up' ? 'long' : 'short' });
  }
  return { entries, regimeAt };
}

function swingExtreme(candles, idx, lookback, type) {
  const start = Math.max(0, idx - lookback);
  let val = type === 'low' ? Infinity : -Infinity;
  for (let j = start; j < idx; j++) val = type === 'low' ? Math.min(val, candles[j].low) : Math.max(val, candles[j].high);
  return val === Infinity || val === -Infinity ? candles[idx].close : val;
}

function findSrZone(candles, uptoIdx, lookback, tolerancePct, minTouches, type) {
  const start = Math.max(0, uptoIdx - lookback);
  const vals = [];
  for (let j = start; j < uptoIdx; j++) vals.push(type === 'low' ? candles[j].low : candles[j].high);
  if (vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i < sorted.length; i++) {
    const base = sorted[i], tol = base * (tolerancePct / 100);
    const cluster = sorted.filter(v => Math.abs(v - base) <= tol);
    if (cluster.length >= minTouches && (!best || cluster.length > best.length)) best = cluster;
  }
  return best ? (type === 'low' ? Math.min(...best) : Math.max(...best)) : null;
}

function simulateTrades(candles1m, candles1h, entries, exitCfg) {
  const atr1h = atrSeries(candles1h, exitCfg.atrLength);
  const commissionPct = Number(exitCfg.commissionPct || 0);
  function closedIndexAt(time) {
    let result = -1;
    for (let i = 0; i < candles1h.length; i++) { if (candles1h[i].closeTime <= time) result = i; else break; }
    return result;
  }
  const entryAtIndex = new Map(entries.map(e => [e.index, e]));
  const trades = [];
  let pos = null;
  for (let i = 0; i < candles1m.length; i++) {
    const e = entryAtIndex.get(i);
    if (e && !pos) {
      const entryPrice = candles1m[i].close;
      const h1Idx = closedIndexAt(candles1m[i].time);
      const uptoIdx = h1Idx + 1;
      const type = e.type === 'long' ? 'low' : 'high';
      let level = findSrZone(candles1h, uptoIdx, exitCfg.srLookbackBars, exitCfg.srTolerancePct, exitCfg.srMinTouches, type);
      if (level == null) level = swingExtreme(candles1h, uptoIdx, exitCfg.srLookbackBars, type);
      const a = (h1Idx >= 0 && atr1h[h1Idx] != null) ? atr1h[h1Idx] : 0;
      const stopPrice = e.type === 'long' ? level - exitCfg.atrMultiplier * a : level + exitCfg.atrMultiplier * a;
      pos = { type: e.type, entryIndex: i, entryTime: candles1m[i].time, entryPrice, stopPrice, peak: entryPrice, activated: false };
      continue;
    }
    if (pos) {
      const c = candles1m[i];
      const isLong = pos.type === 'long';
      pos.peak = isLong ? Math.max(pos.peak, c.high) : Math.min(pos.peak, c.low);
      if (!pos.activated) {
        const activationPrice = isLong ? pos.entryPrice * (1 + exitCfg.activationPct / 100) : pos.entryPrice * (1 - exitCfg.activationPct / 100);
        if (isLong ? pos.peak >= activationPrice : pos.peak <= activationPrice) pos.activated = true;
      }
      const effectiveStop = pos.activated
        ? (isLong ? pos.peak * (1 - exitCfg.trailPct / 100) : pos.peak * (1 + exitCfg.trailPct / 100))
        : pos.stopPrice;
      const hit = isLong ? c.low <= effectiveStop : c.high >= effectiveStop;
      if (hit) {
        const exitPrice = effectiveStop;
        const grossPnlPct = isLong ? (exitPrice - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - exitPrice) / pos.entryPrice * 100;
        const feePct = Number(commissionPct || 0);
        const netPnlPct = grossPnlPct - feePct * 2;
        const durationMinutes = (c.time - pos.entryTime) / 60000;
        trades.push({
          ...pos,
          exitIndex: i,
          exitTime: c.time,
          exitPrice,
          grossPnlPct,
          netPnlPct,
          commissionPct,
          durationMinutes,
          reason: pos.activated ? 'trailing' : 'stop'
        });
        pos = null;
      }
    }
  }
  return trades;
}

function computeMetrics(trades) {
  if (!trades.length) return null;
  const netWins = trades.filter(t => t.netPnlPct > 0);
  const netLosses = trades.filter(t => t.netPnlPct <= 0);
  const grossWins = trades.filter(t => t.grossPnlPct > 0);
  const grossLosses = trades.filter(t => t.grossPnlPct <= 0);
  const netWin = netWins.reduce((s, t) => s + t.netPnlPct, 0);
  const netLoss = Math.abs(netLosses.reduce((s, t) => s + t.netPnlPct, 0));
  const grossWin = grossWins.reduce((s, t) => s + t.grossPnlPct, 0);
  const grossLoss = Math.abs(grossLosses.reduce((s, t) => s + t.grossPnlPct, 0));
  let equity = 0, peak = 0, maxDD = 0;
  const curve = [0];
  trades.forEach(t => {
    equity += t.netPnlPct;
    curve.push(equity);
    if (equity > peak) peak = equity;
    maxDD = Math.max(maxDD, peak - equity);
  });
  const commissionCostPct = trades.reduce((s, t) => s + (t.grossPnlPct - t.netPnlPct), 0);
  return {
    count: trades.length,
    winRate: netWins.length / trades.length * 100,
    avgWin: netWins.length ? netWin / netWins.length : 0,
    avgLoss: netLosses.length ? -netLoss / netLosses.length : 0,
    expectancy: trades.reduce((s, t) => s + t.netPnlPct, 0) / trades.length,
    profitFactor: netLoss > 0 ? netWin / netLoss : Infinity,
    totalPnl: equity,
    grossTotalPnl: grossWins.reduce((s, t) => s + t.grossPnlPct, 0) + grossLosses.reduce((s, t) => s + t.grossPnlPct, 0),
    commissionCostPct,
    maxDD,
    curve,
    grossWinRate: grossWins.length / trades.length * 100,
    grossAvgWin: grossWins.length ? grossWin / grossWins.length : 0,
    grossAvgLoss: grossLosses.length ? -grossLoss / grossLosses.length : 0,
  };
}

module.exports = {
  sma,
  ema,
  macdLineOf,
  trueRangeSeries,
  atrSeries,
  buildAnalysis,
  gateEntries,
  swingExtreme,
  findSrZone,
  simulateTrades,
  computeMetrics,
};
