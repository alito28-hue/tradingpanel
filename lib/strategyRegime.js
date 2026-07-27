// Mechanical, price-action + funding-rate approximation of the paused
// daily-regime playbook (estrategia_maestra_btc.md secc. 2 y 3: setups
// L1/L2/S1/S2/BR), built to backtest whether the *skeleton* of that system
// has edge over a full year — same rigor as strategyOrbSweep.js.
//
// HONEST CAVEAT (read before trusting the numbers): the documented system
// requires live Open Interest confirmation (part of the "2-de-3" context
// check) plus discretionary judgment (climax volume, VWAP reclaim,
// "aceptación" quality, entry scaling 1/2+1/2 or 1/3+1/3+1/3). None of that
// is reconstructable from historical data — Binance's free OI-history
// endpoint only retains ~30 days, nowhere near the 360 we need. Funding
// rate (available 2 years back) is used as the one real sentiment proxy
// from the "2-de-3" check. This backtest is therefore a LOWER/BASE-CASE
// test of the price-action skeleton (pivot structure + candle anatomy +
// trend regime + funding extremity), not a literal replay of the full
// discretionary system. If even the skeleton has no edge, the full system
// (which only adds a filter, i.e. fewer trades) is very unlikely to save it.
const { ema } = require('./strategy');

function aggregate(candles, periodMs) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const bucket = Math.floor(c.time / periodMs) * periodMs;
    if (!cur || cur.time !== bucket) {
      if (cur) out.push(cur);
      cur = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Value from a CLOSED higher-timeframe bar, valid only once that bar's own
// period has fully elapsed (no lookahead). Pointer assumes increasing time.
function closedBarLookup(aggCandles, values, periodMs) {
  let idx = -1;
  return function (time) {
    while (idx + 1 < aggCandles.length && (aggCandles[idx + 1].time + periodMs) <= time) idx++;
    return idx >= 0 ? values[idx] : null;
  };
}

// Value from a point-in-time event series (e.g. funding), already realized
// at event.time — no closed-bar delay needed.
function pointLookup(events, timeKey, valueKey) {
  let idx = -1;
  return function (time) {
    while (idx + 1 < events.length && events[idx + 1][timeKey] <= time) idx++;
    return idx >= 0 ? events[idx][valueKey] : null;
  };
}

function computeTrend(closes, emaFastLen, emaSlowLen) {
  const emaF = ema(closes, emaFastLen);
  const emaS = ema(closes, emaSlowLen);
  const trendUp = new Array(closes.length).fill(false);
  const trendDn = new Array(closes.length).fill(false);
  for (let i = 3; i < closes.length; i++) {
    if (emaF[i] == null || emaS[i] == null || emaF[i - 3] == null) continue;
    trendUp[i] = emaF[i] > emaS[i] && emaF[i] > emaF[i - 3];
    trendDn[i] = emaF[i] < emaS[i] && emaF[i] < emaF[i - 3];
  }
  return { emaF, emaS, trendUp, trendDn };
}

function computePivots(candles, left) {
  const n = candles.length;
  const pivotHighAt = new Array(n).fill(null);
  const pivotLowAt = new Array(n).fill(null);
  for (let i = 2 * left; i < n; i++) {
    const p = i - left;
    const hp = candles[p].high, lp = candles[p].low;
    let isHigh = true, isLow = true;
    for (let k = p - left; k < p; k++) {
      if (candles[k].high >= hp) isHigh = false;
      if (candles[k].low <= lp) isLow = false;
    }
    if (isHigh || isLow) {
      for (let k = p + 1; k <= i; k++) {
        if (candles[k].high >= hp) isHigh = false;
        if (candles[k].low <= lp) isLow = false;
      }
    }
    if (isHigh) pivotHighAt[i] = hp;
    if (isLow) pivotLowAt[i] = lp;
  }
  return { pivotHighAt, pivotLowAt };
}

function percentile(sortedArr, p) {
  const idx = Math.floor(p * (sortedArr.length - 1));
  return sortedArr[idx];
}

function wickShape(c) {
  const rng = c.high - c.low;
  const wTop = c.high - Math.max(c.open, c.close);
  const wBot = Math.min(c.open, c.close) - c.low;
  const pos = rng > 0 ? (c.close - c.low) / rng : 0.5;
  return { rng, wTop, wBot, pos };
}
// Same anatomy bar the "gatillo candidato" Pine detector uses: dominant wick
// (>=50% of range) + close in the outer 35% of the range, correct color.
function bullishReversal(c) {
  const { rng, wBot, pos } = wickShape(c);
  return rng > 0 && c.close > c.open && wBot >= rng * 0.5 && pos >= 0.65;
}
function bearishReversal(c) {
  const { rng, wTop, pos } = wickShape(c);
  return rng > 0 && c.close < c.open && wTop >= rng * 0.5 && pos <= 0.35;
}

// candles: 15m BTCUSDT candles (time,open,high,low,close). fundingEvents:
// [{time,rate}] raw Binance funding history. cfg: see defaults in the
// runner script.
function buildRegimeEntries(candles15m, fundingEvents, cfg) {
  const n = candles15m.length;
  const candles4h = aggregate(candles15m, 4 * 3600 * 1000);
  const candles1d = aggregate(candles15m, 24 * 3600 * 1000);
  const trend4h = computeTrend(candles4h.map(c => c.close), cfg.emaFastLen, cfg.emaSlowLen);
  const trend1d = computeTrend(candles1d.map(c => c.close), cfg.emaFastLen, cfg.emaSlowLen);
  const ema20_4h = closedBarLookup(candles4h, trend4h.emaF, 4 * 3600 * 1000);
  const trendUp1d = closedBarLookup(candles1d, trend1d.trendUp, 24 * 3600 * 1000);
  const trendDn1d = closedBarLookup(candles1d, trend1d.trendDn, 24 * 3600 * 1000);
  const fundingRate = pointLookup(fundingEvents, 'time', 'rate');

  const rates = fundingEvents.map(f => f.rate).slice().sort((a, b) => a - b);
  const fundingP75 = percentile(rates, 0.75);
  const fundingP25 = percentile(rates, 0.25);

  const { pivotHighAt, pivotLowAt } = computePivots(candles15m, cfg.pivotLeft);

  const entries = [];
  function pushEntry(e) {
    const isLong = e.type === 'long';
    const stopOk = isLong ? e.stopPrice < e.entryPrice : e.stopPrice > e.entryPrice;
    if (!stopOk) return;
    entries.push(e);
  }

  // Rolling high/low over the last `climaxBars` bars (including current) —
  // O(n*w), w is small (12-16), fine at this data size.
  function rollHigh(i, w) { let m = -Infinity; for (let k = Math.max(0, i - w + 1); k <= i; k++) m = Math.max(m, candles15m[k].high); return m; }
  function rollLow(i, w) { let m = Infinity; for (let k = Math.max(0, i - w + 1); k <= i; k++) m = Math.min(m, candles15m[k].low); return m; }

  let cooldownL1 = -Infinity, cooldownS1 = -Infinity, cooldownL2 = -Infinity, cooldownS2 = -Infinity;

  // BR: watched levels awaiting retest. {level, dir:'up'|'dn', acceptedAt, expiresAt}
  const watchedBR = [];
  const usedBRLevels = new Set();

  let lastPivotHigh = null, lastPivotHighIdx = -Infinity;
  let lastPivotLow = null, lastPivotLowIdx = -Infinity;

  for (let i = 0; i < n; i++) {
    const c = candles15m[i];
    const t = c.time;

    if (pivotHighAt[i] != null) { lastPivotHigh = pivotHighAt[i]; lastPivotHighIdx = i; }
    if (pivotLowAt[i] != null) { lastPivotLow = pivotLowAt[i]; lastPivotLowIdx = i; }

    // ── L1: Long Capitulación ──────────────────────────────────────────
    if (i >= cooldownL1) {
      const hi = rollHigh(i, cfg.climaxBars);
      const downMovePct = hi > 0 ? (hi - c.low) / hi * 100 : 0;
      const fr = fundingRate(t);
      if (downMovePct >= cfg.climaxPct && fr != null && fr < 0 && bullishReversal(c)) {
        const stopPrice = c.low * (1 - cfg.stopMarginPct / 100);
        const risk = c.close - stopPrice;
        pushEntry({ index: i, type: 'long', system: 'L1', entryPrice: c.close, stopPrice, targetPrice: c.close + risk * cfg.rrL1S1 });
        cooldownL1 = i + cfg.cooldownBars;
      }
    }

    // ── S1: Short Euforia / Fallo de Ruptura (SFP) ───────────────────────
    if (i >= cooldownS1) {
      const lo = rollLow(i, cfg.climaxBars);
      const upMovePct = lo > 0 ? (c.high - lo) / lo * 100 : 0;
      const fr = fundingRate(t);
      const sweptRecentHigh = lastPivotHigh != null && (i - lastPivotHighIdx) <= cfg.climaxBars && c.high > lastPivotHigh && c.close < lastPivotHigh;
      if (upMovePct >= cfg.climaxPct && fr != null && fr > fundingP75 && sweptRecentHigh && bearishReversal(c)) {
        const stopPrice = c.high * (1 + cfg.stopMarginPct / 100);
        const risk = stopPrice - c.close;
        pushEntry({ index: i, type: 'short', system: 'S1', entryPrice: c.close, stopPrice, targetPrice: c.close - risk * cfg.rrL1S1 });
        cooldownS1 = i + cfg.cooldownBars;
      }
    }

    // ── L2: Long Continuación (pullback en tendencia alcista 1D) ────────
    if (i >= cooldownL2) {
      const up1d = trendUp1d(t);
      const ema4h = ema20_4h(t);
      const fr = fundingRate(t);
      if (up1d && ema4h != null && fr != null && fr <= fundingP75) {
        const distPct = Math.abs(c.low - ema4h) / ema4h * 100;
        if (distPct <= cfg.pullbackTolPct && bullishReversal(c) && lastPivotLow != null && (i - lastPivotLowIdx) <= cfg.climaxBars * 2) {
          const stopPrice = lastPivotLow * (1 - cfg.stopMarginPct / 100);
          const risk = c.close - stopPrice;
          if (risk > 0) {
            pushEntry({ index: i, type: 'long', system: 'L2', entryPrice: c.close, stopPrice, targetPrice: c.close + risk * cfg.rrL2S2 });
            cooldownL2 = i + cfg.cooldownBars;
          }
        }
      }
    }

    // ── S2: Short Rallie de Alivio (rebote en tendencia bajista 1D) ─────
    if (i >= cooldownS2) {
      const dn1d = trendDn1d(t);
      const ema4h = ema20_4h(t);
      if (dn1d && ema4h != null) {
        const distPct = Math.abs(c.high - ema4h) / ema4h * 100;
        if (distPct <= cfg.pullbackTolPct && bearishReversal(c) && lastPivotHigh != null && (i - lastPivotHighIdx) <= cfg.climaxBars * 2) {
          const stopPrice = lastPivotHigh * (1 + cfg.stopMarginPct / 100);
          const risk = stopPrice - c.close;
          if (risk > 0) {
            pushEntry({ index: i, type: 'short', system: 'S2', entryPrice: c.close, stopPrice, targetPrice: c.close - risk * cfg.rrL2S2 });
            cooldownS2 = i + cfg.cooldownBars;
          }
        }
      }
    }

    // ── BR: Ruptura y Retest (bidireccional) ─────────────────────────────
    // Mark acceptance when price closes beyond a confirmed pivot for
    // `acceptBars` consecutive bars, then watch for a retest within
    // `retestWindowBars`. Trigger on a rejection/continuation candle at the
    // retest, in the breakout direction. Un-retested breakouts expire
    // ("se dejó ir") rather than firing late.
    if (lastPivotHigh != null && !usedBRLevels.has('up:' + lastPivotHigh) && i - lastPivotHighIdx >= cfg.acceptBars) {
      let accepted = true;
      for (let k = i - cfg.acceptBars + 1; k <= i; k++) { if (candles15m[k].close <= lastPivotHigh) { accepted = false; break; } }
      if (accepted) {
        watchedBR.push({ level: lastPivotHigh, dir: 'up', expiresAt: i + cfg.retestWindowBars });
        usedBRLevels.add('up:' + lastPivotHigh);
      }
    }
    if (lastPivotLow != null && !usedBRLevels.has('dn:' + lastPivotLow) && i - lastPivotLowIdx >= cfg.acceptBars) {
      let accepted = true;
      for (let k = i - cfg.acceptBars + 1; k <= i; k++) { if (candles15m[k].close >= lastPivotLow) { accepted = false; break; } }
      if (accepted) {
        watchedBR.push({ level: lastPivotLow, dir: 'dn', expiresAt: i + cfg.retestWindowBars });
        usedBRLevels.add('dn:' + lastPivotLow);
      }
    }
    for (let w = watchedBR.length - 1; w >= 0; w--) {
      const wl = watchedBR[w];
      if (i > wl.expiresAt) { watchedBR.splice(w, 1); continue; }
      const tolAbs = wl.level * (cfg.brRetestTolPct / 100);
      if (wl.dir === 'up') {
        const touched = c.low <= wl.level + tolAbs;
        if (touched && bullishReversal(c)) {
          const stopPrice = wl.level * (1 - cfg.stopMarginPct / 100);
          const risk = c.close - stopPrice;
          if (risk > 0) pushEntry({ index: i, type: 'long', system: 'BR', entryPrice: c.close, stopPrice, targetPrice: c.close + risk * cfg.rrBR });
          watchedBR.splice(w, 1);
        }
      } else {
        const touched = c.high >= wl.level - tolAbs;
        if (touched && bearishReversal(c)) {
          const stopPrice = wl.level * (1 + cfg.stopMarginPct / 100);
          const risk = stopPrice - c.close;
          if (risk > 0) pushEntry({ index: i, type: 'short', system: 'BR', entryPrice: c.close, stopPrice, targetPrice: c.close - risk * cfg.rrBR });
          watchedBR.splice(w, 1);
        }
      }
    }
  }

  entries.sort((a, b) => a.index - b.index);
  return { entries };
}

function pctMove(isLong, entryPrice, exitPrice) {
  return isLong ? (exitPrice - entryPrice) / entryPrice * 100 : (entryPrice - exitPrice) / entryPrice * 100;
}

// One trade at a time across ALL setups (mirrors "máximo 2 posiciones
// simultáneas" loosely by just not overlapping at all — conservative: if two
// setups signal on the same bar, first one wins, same convention as ORB/Sweep).
function simulateRegimeTrades(candles, entries, exitCfg) {
  const commissionPct = Number(exitCfg.commissionPct || 0);
  const entryAtIndex = new Map();
  for (const e of entries) { if (!entryAtIndex.has(e.index)) entryAtIndex.set(e.index, e); }
  const trades = [];
  let pos = null;
  for (let i = 0; i < candles.length; i++) {
    const e = entryAtIndex.get(i);
    if (e && !pos) {
      pos = { type: e.type, system: e.system, entryIndex: i, entryTime: candles[i].time, entryPrice: candles[i].close, stopPrice: e.stopPrice, targetPrice: e.targetPrice };
      continue;
    }
    if (pos) {
      const c = candles[i];
      const isLong = pos.type === 'long';
      const stopHit = isLong ? c.low <= pos.stopPrice : c.high >= pos.stopPrice;
      const targetHit = isLong ? c.high >= pos.targetPrice : c.low <= pos.targetPrice;
      if (stopHit || targetHit) {
        const hitStop = stopHit;
        const exitPrice = hitStop ? pos.stopPrice : pos.targetPrice;
        const grossPnlPct = pctMove(isLong, pos.entryPrice, exitPrice);
        const netPnlPct = grossPnlPct - commissionPct * 2;
        trades.push({ ...pos, exitIndex: i, exitTime: c.time, exitPrice, grossPnlPct, netPnlPct, commissionPct, durationMinutes: (c.time - pos.entryTime) / 60000, reason: hitStop ? 'stop' : 'target' });
        pos = null;
      }
    }
  }
  return { trades, openPosition: pos };
}

module.exports = { buildRegimeEntries, simulateRegimeTrades, aggregate };
