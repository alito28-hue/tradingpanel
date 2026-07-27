const { checkStopDistance } = require('./botSafety');

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

// Wilder's RMA (alpha = 1/length, first value seeded as a plain average) —
// this is what TradingView's ta.atr/ta.rsi actually use internally, not a
// simple moving average. Kept separate from atrSeries/rsi's SMA-style math
// above so the existing SR+ATR exit's calibration doesn't shift underfoot;
// only the V9 MA-cross strategy (built to mirror a specific Pine script)
// uses these.
function rma(values, length) {
  const out = new Array(values.length).fill(null);
  let avg = null, seedSum = 0, seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (avg == null) {
      seedSum += v; seedCount++;
      if (seedCount === length) avg = seedSum / length;
      out[i] = avg;
    } else {
      avg = (avg * (length - 1) + v) / length;
      out[i] = avg;
    }
  }
  return out;
}

function atrRma(candles, length) { return rma(trueRangeSeries(candles), length); }

// Wilder's RSI (ta.rsi in Pine): RMA of gains and losses, not a simple average.
function rsi(closes, length) {
  const gains = new Array(closes.length).fill(null);
  const losses = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains[i] = Math.max(change, 0);
    losses[i] = Math.max(-change, 0);
  }
  const avgGain = rma(gains, length);
  const avgLoss = rma(losses, length);
  return closes.map((_, i) => {
    if (avgGain[i] == null || avgLoss[i] == null) return null;
    if (avgLoss[i] === 0) return 100;
    return 100 - 100 / (1 + avgGain[i] / avgLoss[i]);
  });
}

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

// Mirrors the "MA Cross + MACD Zero Filter (Optimizado V9 - WunderTrading)"
// Pine v6 script exactly (crossover of close vs SMA±ATR buffer, MACD
// zero-line + alignment filters, RSI>50/<50 filter, direction-only cooldown
// that only blocks a repeat signal in the SAME direction). Single timeframe
// by design — the script has no separate regime gate, unlike buildAnalysis.
function buildAnalysisV9(candles, cfg) {
  const closes = candles.map(c => c.close);
  const maLine = sma(closes, cfg.maLen);
  const macdLine = macdLineOf(closes, 12, 26);
  const signalLine = ema(macdLine, 9);
  const rsiLine = rsi(closes, 14);
  const atr = atrRma(candles, 14);

  const signals = new Array(candles.length).fill(null);
  const cooldownMs = cfg.cooldownHours * 3600000;
  let lastUpTime = -Infinity, lastDownTime = -Infinity;

  for (let i = 1; i < candles.length; i++) {
    if ([maLine[i - 1], maLine[i], macdLine[i], signalLine[i], rsiLine[i], atr[i]].some(v => v == null)) continue;
    const buffer = cfg.useAtrBuffer ? atr[i] * cfg.atrMult : 0;
    const crossUp = closes[i - 1] <= maLine[i - 1] + buffer && closes[i] > maLine[i] + buffer;
    const crossDown = closes[i - 1] >= maLine[i - 1] - buffer && closes[i] < maLine[i] - buffer;

    const zeroUp = cfg.useMacdZeroFilter ? macdLine[i] > 0 : true;
    const zeroDown = cfg.useMacdZeroFilter ? macdLine[i] < 0 : true;
    const alignUp = cfg.useMacdAlignFilter ? macdLine[i] > signalLine[i] : true;
    const alignDown = cfg.useMacdAlignFilter ? macdLine[i] < signalLine[i] : true;
    const rsiUp = cfg.useRsiFilter ? rsiLine[i] > 50 : true;
    const rsiDown = cfg.useRsiFilter ? rsiLine[i] < 50 : true;

    const timeUpOk = candles[i].time - lastUpTime >= cooldownMs;
    const timeDownOk = candles[i].time - lastDownTime >= cooldownMs;

    if (crossUp && zeroUp && alignUp && rsiUp && timeUpOk) {
      signals[i] = 'up'; lastUpTime = candles[i].time;
    } else if (crossDown && zeroDown && alignDown && rsiDown && timeDownOk) {
      signals[i] = 'down'; lastDownTime = candles[i].time;
    }
  }
  return { maLine, macdLine, signalLine, rsiLine, signals };
}

// For every candle in `fastCandles`, the value from the most recently CLOSED
// candle in `slowCandles` at that time — a single sorted two-pointer pass
// (both arrays are already time-ordered), not a rescan per lookup like
// gateEntries' regimeAt/closedIndexAt. Needed here because this strategy
// pulls a 5m indicator onto a 1m series (~262k candles); rescanning per
// lookup the way the rest of the file does would be O(n*m) and far too slow
// at this scale.
function alignToFast(fastCandles, slowCandles, slowSeries) {
  const out = new Array(fastCandles.length).fill(null);
  let slowIdx = -1;
  for (let i = 0; i < fastCandles.length; i++) {
    while (slowIdx + 1 < slowCandles.length && slowCandles[slowIdx + 1].closeTime <= fastCandles[i].time) slowIdx++;
    out[i] = slowIdx >= 0 ? slowSeries[slowIdx] : null;
  }
  return out;
}

// Rolling percentile rank of fundingEvents[i].rate within the trailing
// `window` events (including itself) — only past data, no look-ahead. Used
// instead of a fixed threshold because the raw funding-rate distribution
// isn't stable over multi-year backtests (confirmed: p90 sat at Binance's
// funding cap for large stretches of 2022-23, unlike 2024-26).
function fundingPercentileRank(fundingEvents, window) {
  const ranks = new Array(fundingEvents.length).fill(null);
  for (let i = 0; i < fundingEvents.length; i++) {
    if (i < window) continue;
    const trailing = fundingEvents.slice(i - window, i + 1).map(f => f.rate).sort((a, b) => a - b);
    const rate = fundingEvents[i].rate;
    let below = 0;
    for (const r of trailing) { if (r < rate) below++; else break; }
    ranks[i] = below / (trailing.length - 1);
  }
  return ranks;
}

// Marks every 1H candle within `biasHours` after a qualifying (percentile <=
// threshold) funding event as long-eligible. Validated empirically (see
// check_funding_edge.js) against two very different regimes — extreme
// negative funding preceded above-baseline forward returns in both a
// bull-heavy 2024-26 window and the 2022-23 crash+recovery window, unlike
// extreme positive funding, whose sign flipped between the two. That's why
// this only builds a LONG bias, never a short one.
function buildFundingBiasEntries(candles1h, fundingEvents, cfg) {
  const ranks = fundingPercentileRank(fundingEvents, cfg.rankWindow);
  const biasUntil = new Array(candles1h.length).fill(false);
  for (let i = 0; i < fundingEvents.length; i++) {
    if (ranks[i] == null || ranks[i] > cfg.percentileThreshold) continue;
    const from = fundingEvents[i].time;
    const until = from + cfg.biasHours * 3600000;
    for (let j = 0; j < candles1h.length; j++) {
      if (candles1h[j].time >= from && candles1h[j].time < until) biasUntil[j] = true;
    }
  }
  return biasUntil;
}

// Mirrors the "Estrategia Corta 1M - 20 Entradas - Mejorado" Pine v6
// strategy: long-only, MACD(12,26,9) crossover on the entry timeframe
// (normally 1m) gated by an absolute-value MACD zone filter, RSI(14) > 50 on
// the entry timeframe, and a higher-timeframe (normally 5m) RSI>=40 +
// MACD<60 confirmation. The MACD thresholds are raw price-difference units
// (EMA12-EMA26 in USD), same as the original script — not normalized, so
// they're implicitly calibrated to whatever price level the script was
// tuned against, not necessarily this backtest's BTC price range.
function buildAnalysisScalpV1(candlesFast, candlesMtf, cfg) {
  const closesFast = candlesFast.map(c => c.close);
  const macdLineFast = macdLineOf(closesFast, cfg.fastLength, cfg.slowLength);
  const signalLineFast = ema(macdLineFast, cfg.signalLength);
  const rsiFast = rsi(closesFast, cfg.rsiLength);

  const closesMtf = candlesMtf.map(c => c.close);
  const macdLineMtf = macdLineOf(closesMtf, cfg.fastLength, cfg.slowLength);
  const rsiMtf = rsi(closesMtf, cfg.rsiLengthMTF);

  const macdMtfAligned = alignToFast(candlesFast, candlesMtf, macdLineMtf);
  const rsiMtfAligned = alignToFast(candlesFast, candlesMtf, rsiMtf);

  const signals = new Array(candlesFast.length).fill(null);
  for (let i = 1; i < candlesFast.length; i++) {
    if ([macdLineFast[i - 1], signalLineFast[i - 1], macdLineFast[i], signalLineFast[i], rsiFast[i], macdMtfAligned[i], rsiMtfAligned[i]].some(v => v == null)) continue;
    const crossUp = macdLineFast[i - 1] <= signalLineFast[i - 1] && macdLineFast[i] > signalLineFast[i];
    const macdFilter = macdLineFast[i] < -30 || (macdLineFast[i] > -10 && macdLineFast[i] < -5);
    const rsiFilter = rsiFast[i] > cfg.rsiThreshold;
    const rsiMtfFilter = rsiMtfAligned[i] >= cfg.rsiThresholdMTF;
    const macdMtfFilter = macdMtfAligned[i] < cfg.macdMtfThreshold;
    if (crossUp && macdFilter && rsiFilter && rsiMtfFilter && macdMtfFilter) signals[i] = 'up';
  }
  return { signals };
}

// Approximates "reading the tape" from candle data: Binance klines include
// taker buy volume per candle, so we can split each candle's volume into
// aggressive buying vs aggressive selling without needing a live trade feed.
function volumeProfile(candles, window) {
  const delta = candles.map(c => (c.takerBuyVolume || 0) - ((c.volume || 0) - (c.takerBuyVolume || 0)));
  const deltaSum = new Array(candles.length).fill(0);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += delta[i];
    if (i >= window) sum -= delta[i - window];
    deltaSum[i] = sum;
  }
  return { delta, deltaSum };
}

function applyVolumeFilter(signals, deltaSum) {
  return signals.map((s, i) => {
    if (s === 'up' && deltaSum[i] <= 0) return null;
    if (s === 'down' && deltaSum[i] >= 0) return null;
    return s;
  });
}

function detectVolumeClimax(candles, window, multiplier) {
  const avgVolume = sma(candles.map(c => c.volume || 0), window);
  return candles.map((c, i) => avgVolume[i] != null && avgVolume[i] > 0 && c.volume > avgVolume[i] * multiplier);
}

// Scales with each timeframe's own volatility (ATR) instead of a fixed % move,
// so the same call is meaningfully selective on 1m, 15m, and 1H candles alike.
function detectVolumeDivergence(candles, deltaSum, priceLookback, atrMultiplier = 2) {
  const atr = atrSeries(candles, priceLookback);
  return candles.map((c, i) => {
    if (i < priceLookback || atr[i] == null) return null;
    const prevClose = candles[i - priceLookback].close;
    const change = c.close - prevClose;
    const threshold = atr[i] * atrMultiplier;
    if (change > threshold && deltaSum[i] <= 0) return 'bearish';
    if (change < -threshold && deltaSum[i] >= 0) return 'bullish';
    return null;
  });
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

// Checks one more candle against an in-progress position (peak/activation/
// trailing math), mutating `pos` in place. Returns null if the candle didn't
// touch the stop, or the exit details if it did. Shared between the backtest
// loop below and the worker's live DRY_RUN exit simulation (worker/index.js)
// — the whole point is that both use the exact same math, not two versions
// that can quietly drift apart.
function stepExit(pos, candle, exitCfg) {
  const isLong = pos.type === 'long';
  pos.peak = isLong ? Math.max(pos.peak, candle.high) : Math.min(pos.peak, candle.low);
  if (!pos.activated) {
    const activationPrice = isLong ? pos.entryPrice * (1 + exitCfg.activationPct / 100) : pos.entryPrice * (1 - exitCfg.activationPct / 100);
    if (isLong ? pos.peak >= activationPrice : pos.peak <= activationPrice) pos.activated = true;
  }
  const effectiveStop = pos.activated
    ? (isLong ? pos.peak * (1 - exitCfg.trailPct / 100) : pos.peak * (1 + exitCfg.trailPct / 100))
    : pos.stopPrice;
  pos.currentStop = effectiveStop;
  const hit = isLong ? candle.low <= effectiveStop : candle.high >= effectiveStop;
  if (!hit) return null;

  const exitPrice = effectiveStop;
  const grossPnlPct = isLong ? (exitPrice - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - exitPrice) / pos.entryPrice * 100;
  const commissionPct = Number(exitCfg.commissionPct || 0);
  const netPnlPct = grossPnlPct - commissionPct * 2;
  return { exitPrice, grossPnlPct, netPnlPct, commissionPct, reason: pos.activated ? 'trailing' : 'stop' };
}

function simulateTrades(candles1m, candles1h, entries, exitCfg) {
  const atr1h = atrSeries(candles1h, exitCfg.atrLength);
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
      // findSrZone/swingExtreme pick the most-touched (or highest/lowest)
      // level within the lookback window, with no guarantee it's actually on
      // the protective side of entry — if price just broke out past every
      // high in the lookback, the "resistance" it finds can sit BELOW the
      // entry price for a short (or a "support" above entry for a long).
      // That's not a stop at all: it's already been crossed, so the
      // simulated position "exits" on the very next candle at a price with
      // no relation to real risk. Skip the signal rather than trade with a
      // non-functional stop.
      const stopIsProtective = e.type === 'long' ? stopPrice < entryPrice : stopPrice > entryPrice;
      if (!stopIsProtective) {
        continue;
      }
      // The SR zone can sit arbitrarily close to entry (e.g. price just under a
      // tight resistance cluster) — without a floor on the stop distance, that
      // trade gets taken with a stop so close that ordinary noise stops it out
      // before the setup has a chance to play out. Skip the signal entirely
      // rather than widening the stop, since a resized stop would no longer
      // reflect the actual SR level. Measured in ATR (not a fixed %) so it
      // scales with current volatility, same reasoning as the divergence fix.
      if (exitCfg.minStopAtrMultiple && a > 0 && Math.abs(entryPrice - stopPrice) < exitCfg.minStopAtrMultiple * a) {
        continue;
      }
      // Same leverage-liquidation safety filter the worker applies before
      // ever placing a real order (lib/botSafety.js) — folded in here
      // instead of left as a separate post-hoc check, so backtests actually
      // reflect what the bot would have done, not an optimistic upper bound.
      if (exitCfg.leverage && !checkStopDistance(entryPrice, stopPrice, exitCfg.leverage).ok) {
        continue;
      }
      pos = { type: e.type, entryIndex: i, entryTime: candles1m[i].time, entryPrice, stopPrice, peak: entryPrice, activated: false };
      continue;
    }
    if (pos) {
      const c = candles1m[i];
      const result = stepExit(pos, c, exitCfg);
      if (result) {
        const durationMinutes = (c.time - pos.entryTime) / 60000;
        trades.push({ ...pos, exitIndex: i, exitTime: c.time, durationMinutes, ...result });
        pos = null;
      }
    }
  }
  return { trades, openPosition: pos };
}

// Fixed-% initial stop (exitCfg.slPct) instead of an SR+ATR level, but reuses
// stepExit() as-is for the activation/trailing math — same source of truth
// as simulateTrades and the worker's DRY_RUN exit simulation, just with a
// different way of picking the starting stopPrice.
function simulateTradesFixedTrailing(candles, entries, exitCfg) {
  const entryAtIndex = new Map(entries.map(e => [e.index, e]));
  const trades = [];
  let pos = null;
  for (let i = 0; i < candles.length; i++) {
    const e = entryAtIndex.get(i);
    if (e && !pos) {
      const entryPrice = candles[i].close;
      const isLong = e.type === 'long';
      const stopPrice = isLong ? entryPrice * (1 - exitCfg.slPct / 100) : entryPrice * (1 + exitCfg.slPct / 100);
      if (exitCfg.leverage && !checkStopDistance(entryPrice, stopPrice, exitCfg.leverage).ok) continue;
      pos = { type: e.type, entryIndex: i, entryTime: candles[i].time, entryPrice, stopPrice, peak: entryPrice, activated: false };
      continue;
    }
    if (pos) {
      const c = candles[i];
      const result = stepExit(pos, c, exitCfg);
      if (result) {
        const durationMinutes = (c.time - pos.entryTime) / 60000;
        trades.push({ ...pos, exitIndex: i, exitTime: c.time, durationMinutes, ...result });
        pos = null;
      }
    }
  }
  return { trades, openPosition: pos };
}

// Stop at the nearest recent swing low/high on the entry timeframe itself
// (not a higher-timeframe SR zone) — "lo más cerca posible sin cortar el
// trade": the tightest stop the recent 1m/5m structure actually supports,
// reusing swingExtreme() and stepExit() rather than duplicating their logic.
function simulateTradesSwingStop(candles, entries, exitCfg) {
  const entryAtIndex = new Map(entries.map(e => [e.index, e]));
  const trades = [];
  let pos = null;
  for (let i = 0; i < candles.length; i++) {
    const e = entryAtIndex.get(i);
    if (e && !pos) {
      const entryPrice = candles[i].close;
      const isLong = e.type === 'long';
      const stopPrice = swingExtreme(candles, i, exitCfg.swingLookback, isLong ? 'low' : 'high');
      const stopIsProtective = isLong ? stopPrice < entryPrice : stopPrice > entryPrice;
      if (!stopIsProtective) continue;
      if (exitCfg.leverage && !checkStopDistance(entryPrice, stopPrice, exitCfg.leverage).ok) continue;
      pos = { type: e.type, entryIndex: i, entryTime: candles[i].time, entryPrice, stopPrice, peak: entryPrice, activated: false };
      continue;
    }
    if (pos) {
      const c = candles[i];
      const result = stepExit(pos, c, exitCfg);
      if (result) {
        const durationMinutes = (c.time - pos.entryTime) / 60000;
        trades.push({ ...pos, exitIndex: i, exitTime: c.time, durationMinutes, ...result });
        pos = null;
      }
    }
  }
  return { trades, openPosition: pos };
}

function simulateTradesFixedPct(candles, entries, cfg) {
  const commissionPct = Number(cfg.commissionPct || 0);
  const entryAtIndex = new Map(entries.map(e => [e.index, e]));
  const trades = [];
  let pos = null;
  for (let i = 0; i < candles.length; i++) {
    const e = entryAtIndex.get(i);
    if (e && !pos) {
      const entryPrice = candles[i].close;
      const isLong = e.type === 'long';
      const stopPrice = isLong ? entryPrice * (1 - cfg.slPct / 100) : entryPrice * (1 + cfg.slPct / 100);
      const takeProfitPrice = isLong ? entryPrice * (1 + cfg.tpPct / 100) : entryPrice * (1 - cfg.tpPct / 100);
      pos = { type: e.type, entryIndex: i, entryTime: candles[i].time, entryPrice, stopPrice, takeProfitPrice };
      continue;
    }
    if (pos) {
      const c = candles[i];
      const isLong = pos.type === 'long';
      const stopHit = isLong ? c.low <= pos.stopPrice : c.high >= pos.stopPrice;
      const tpHit = isLong ? c.high >= pos.takeProfitPrice : c.low <= pos.takeProfitPrice;
      // OHLC candles don't tell us the intrabar order, so when both the stop
      // and the target fall inside the same candle we conservatively assume
      // the stop hit first.
      if (stopHit || tpHit) {
        const hitStop = stopHit;
        const exitPrice = hitStop ? pos.stopPrice : pos.takeProfitPrice;
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
          reason: hitStop ? 'stop_loss' : 'take_profit',
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
  rma,
  atrRma,
  rsi,
  buildAnalysis,
  buildAnalysisV9,
  buildAnalysisScalpV1,
  alignToFast,
  fundingPercentileRank,
  buildFundingBiasEntries,
  volumeProfile,
  applyVolumeFilter,
  detectVolumeClimax,
  detectVolumeDivergence,
  gateEntries,
  swingExtreme,
  findSrZone,
  stepExit,
  simulateTrades,
  simulateTradesFixedTrailing,
  simulateTradesSwingStop,
  simulateTradesFixedPct,
  computeMetrics,
};
