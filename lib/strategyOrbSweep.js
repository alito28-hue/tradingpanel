// Mirrors the "Piloto Intradía — ORB + Barrido" Pine v5 indicator
// (docs conversation 2026-07-21): Sistema A is an opening-range breakout on
// three fixed ART session windows (Asia/London/NY), Sistema B is a
// liquidity-sweep reversal on confirmed swing pivots within a rolling hour
// window, gated by a shared EMA20/50 trend filter (Sweep only — the ORB is
// deliberately NOT trend-filtered in the source script, since filtering a
// breakout system with a lagging MA cancels out real breakouts as often as
// fake ones). Backtest-only module: the Pine script itself is an alert
// indicator with no position management, so entries here carry an explicit
// stopPrice/targetPrice per the source script's own TP1/stop labels.
const { ema } = require('./strategy');

// America/Argentina/Buenos_Aires has no DST — fixed UTC-3 year-round, so a
// static offset is safe (unlike most other IANA zones).
const ART_OFFSET_MS = 3 * 3600 * 1000;

function minutesOfDayART(utcMs) {
  const d = new Date(utcMs - ART_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function parseSession(window) {
  const [s, e] = window.split('-');
  const startMin = parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2), 10);
  const endMin = parseInt(e.slice(0, 2), 10) * 60 + parseInt(e.slice(2), 10);
  return { startMin, endMin };
}

// Simple ATR (Wilder-style RMA smoothing) used only by orbStopMode:'edge' to
// size the stop buffer beyond the broken range edge.
function computeATR(candles, len) {
  const n = candles.length;
  const atr = new Array(n).fill(null);
  let prevAtr = null;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    if (i === 0) { prevAtr = tr; atr[i] = tr; continue; }
    prevAtr = (prevAtr * (len - 1) + tr) / len;
    atr[i] = prevAtr;
  }
  return atr;
}

function computeTrend(candles, emaFastLen, emaSlowLen) {
  const closes = candles.map(c => c.close);
  const emaF = ema(closes, emaFastLen);
  const emaS = ema(closes, emaSlowLen);
  const trendUp = new Array(candles.length).fill(false);
  const trendDn = new Array(candles.length).fill(false);
  for (let i = 3; i < candles.length; i++) {
    if (emaF[i] == null || emaS[i] == null || emaF[i - 3] == null) continue;
    trendUp[i] = emaF[i] > emaS[i] && emaF[i] > emaF[i - 3];
    trendDn[i] = emaF[i] < emaS[i] && emaF[i] < emaF[i - 3];
  }
  return { trendUp, trendDn };
}

// Confirmed swing pivots (ta.pivothigh/pivotlow equivalent): pivotHighAt[i]
// holds the pivot's price at the bar where it becomes confirmed (i = pivot
// bar index + left), i.e. with the same right-side lag the Pine script has.
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

// cfg: { emaFastLen, emaSlowLen, useTrendFilter, showORB, orbMinPct,
//   orbMaxPct, sessions: [{label, window:'HHMM-HHMM'}], showSweep, sweepHrs,
//   pivotLeft, barMinutes }
function buildOrbSweepEntries(candles, cfg) {
  const n = candles.length;
  const { trendUp, trendDn } = computeTrend(candles, cfg.emaFastLen, cfg.emaSlowLen);
  const { pivotHighAt, pivotLowAt } = computePivots(candles, cfg.pivotLeft);
  const atr = cfg.orbStopMode === 'edge' ? computeATR(candles, cfg.atrLen || 14) : null;
  const sessions = cfg.sessions.map(s => ({ label: s.label, ...parseSession(s.window) }));
  const sweepBars = Math.round(cfg.sweepHrs * 60 / cfg.barMinutes);

  const entries = [];
  const usedIndex = new Set();
  function pushEntry(entry) {
    if (usedIndex.has(entry.index)) return; // one system fires per bar, first wins
    const isLong = entry.type === 'long';
    const stopOk = isLong ? entry.stopPrice < entry.entryPrice : entry.stopPrice > entry.entryPrice;
    const targetOk = isLong ? entry.targetPrice > entry.entryPrice : entry.targetPrice < entry.entryPrice;
    if (!stopOk || !targetOk) return; // non-functional level, skip rather than trade garbage
    // TP2 can end up on the wrong side (e.g. a sweep's opposite pivot sitting
    // behind entry) even when TP1 is fine — null it out rather than dropping
    // the whole entry, so TP1-only scenarios still get to use it.
    if (entry.targetPrice2 != null) {
      const target2Ok = isLong ? entry.targetPrice2 > entry.entryPrice : entry.targetPrice2 < entry.entryPrice;
      if (!target2Ok) entry.targetPrice2 = null;
    }
    entries.push(entry);
    usedIndex.add(entry.index);
  }

  let lastPivotHigh = null, lastPivotHighIdx = -Infinity;
  let lastPivotLow = null, lastPivotLowIdx = -Infinity;
  let sweptHighLevel = null, sweptLowLevel = null;

  let orbHigh = null, orbLow = null, orbDoneUp = false, orbDoneDn = false;
  let orbValidRange = false, activeSessionLabel = null, inAnyPrev = false;

  for (let i = 0; i < n; i++) {
    const c = candles[i];

    if (pivotHighAt[i] != null) { lastPivotHigh = pivotHighAt[i]; lastPivotHighIdx = i; }
    if (pivotLowAt[i] != null) { lastPivotLow = pivotLowAt[i]; lastPivotLowIdx = i; }
    const pivotHighValid = lastPivotHigh != null && (i - lastPivotHighIdx) <= sweepBars;
    const pivotLowValid = lastPivotLow != null && (i - lastPivotLowIdx) <= sweepBars;

    if (cfg.showSweep) {
      const rng = c.high - c.low;
      const wTop = c.high - Math.max(c.open, c.close);
      const wBot = Math.min(c.open, c.close) - c.low;
      const sweepHighNow = pivotHighValid && c.high > lastPivotHigh && c.close < lastPivotHigh && wTop >= rng * 0.4 && lastPivotHigh !== sweptHighLevel;
      const sweepLowNow = pivotLowValid && c.low < lastPivotLow && c.close > lastPivotLow && wBot >= rng * 0.4 && lastPivotLow !== sweptLowLevel;
      const sweepShort = sweepHighNow && (!cfg.useTrendFilter || !trendUp[i]);
      const sweepLong = sweepLowNow && (!cfg.useTrendFilter || !trendDn[i]);

      if (sweepShort) {
        sweptHighLevel = lastPivotHigh;
        pushEntry({ index: i, type: 'short', system: 'SWEEP', entryPrice: c.close, stopPrice: c.high * 1.001, targetPrice: (lastPivotHigh + lastPivotLow) / 2, targetPrice2: lastPivotLow });
      }
      if (sweepLong) {
        sweptLowLevel = lastPivotLow;
        pushEntry({ index: i, type: 'long', system: 'SWEEP', entryPrice: c.close, stopPrice: c.low * 0.999, targetPrice: (lastPivotHigh + lastPivotLow) / 2, targetPrice2: lastPivotHigh });
      }
    }

    let curSessionLabel = null;
    if (cfg.showORB) {
      const mins = minutesOfDayART(c.time);
      for (const s of sessions) { if (mins >= s.startMin && mins < s.endMin) { curSessionLabel = s.label; break; } }
    }
    const inAny = curSessionLabel != null;

    if (inAny && !inAnyPrev) {
      orbHigh = c.high; orbLow = c.low; orbDoneUp = false; orbDoneDn = false; activeSessionLabel = curSessionLabel;
    } else if (inAny) {
      orbHigh = Math.max(orbHigh, c.high);
      orbLow = Math.min(orbLow, c.low);
    }
    if (!inAny && inAnyPrev) {
      const orbRange = orbHigh - orbLow;
      const orbRangePct = orbLow > 0 ? orbRange / orbLow * 100 : 0;
      orbValidRange = orbRangePct >= cfg.orbMinPct && orbRangePct <= cfg.orbMaxPct;
    }

    if (cfg.showORB && orbValidRange && !inAny && !orbDoneUp && !orbDoneDn && orbHigh != null && i > 0) {
      const prevClose = candles[i - 1].close;
      const orbRange = orbHigh - orbLow;
      // orbStopMode: 'range' (default, mirrors the live Pine script) puts the
      // stop at the OPPOSITE edge of the opening range. 'edge' is the
      // 2026-07-21 structural-fix candidate: stop at the broken edge itself,
      // buffered by atrMult*ATR(atrLen) instead of the far side of the range
      // — risk becomes proportional to current volatility instead of ~1 full
      // range while target stays ~1 range, targeting the R:R asymmetry
      // diagnosed in the 360d backtest (PF 0.61, avgWin/avgLoss ~0.5).
      const atrMult = cfg.atrMult != null ? cfg.atrMult : 1.0;
      const atrBuffer = atr ? atr[i] * atrMult : 0;
      if (c.close > orbHigh && prevClose <= orbHigh) {
        orbDoneUp = true;
        const stopPrice = cfg.orbStopMode === 'edge' ? orbHigh - atrBuffer : orbLow;
        pushEntry({ index: i, type: 'long', system: 'ORB', session: activeSessionLabel, entryPrice: c.close, stopPrice, targetPrice: c.close + orbRange, targetPrice2: c.close + orbRange * cfg.rrTarget });
      } else if (c.close < orbLow && prevClose >= orbLow) {
        orbDoneDn = true;
        const stopPrice = cfg.orbStopMode === 'edge' ? orbLow + atrBuffer : orbHigh;
        pushEntry({ index: i, type: 'short', system: 'ORB', session: activeSessionLabel, entryPrice: c.close, stopPrice, targetPrice: c.close - orbRange, targetPrice2: c.close - orbRange * cfg.rrTarget });
      }
    }

    inAnyPrev = inAny;
  }

  entries.sort((a, b) => a.index - b.index);
  return { entries };
}

function pctMove(isLong, entryPrice, exitPrice) {
  return isLong ? (exitPrice - entryPrice) / entryPrice * 100 : (entryPrice - exitPrice) / entryPrice * 100;
}

// Full exit at a single target (TP1 or TP2) or the stop, whichever the
// candle touches first; if both fall inside the same candle we
// conservatively assume the stop hit first (same convention as
// simulateTradesFixedPct in strategy.js). mode: 'tp1' | 'tp2' — 'tp2'
// entries need a valid targetPrice2 (see pushEntry) and are skipped otherwise.
function simulateOrbSweepTrades(candles, entries, exitCfg, mode = 'tp1') {
  const commissionPct = Number(exitCfg.commissionPct || 0);
  const usable = mode === 'tp2' ? entries.filter(e => e.targetPrice2 != null) : entries;
  const entryAtIndex = new Map(usable.map(e => [e.index, e]));
  const trades = [];
  let pos = null;
  for (let i = 0; i < candles.length; i++) {
    const e = entryAtIndex.get(i);
    if (e && !pos) {
      const target = mode === 'tp2' ? e.targetPrice2 : e.targetPrice;
      pos = {
        type: e.type, system: e.system, session: e.session || null,
        entryIndex: i, entryTime: candles[i].time, entryPrice: candles[i].close,
        stopPrice: e.stopPrice, targetPrice: target,
      };
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
        const durationMinutes = (c.time - pos.entryTime) / 60000;
        trades.push({ ...pos, exitIndex: i, exitTime: c.time, exitPrice, grossPnlPct, netPnlPct, commissionPct, durationMinutes, reason: hitStop ? 'stop' : 'target' });
        pos = null;
      }
    }
  }
  return { trades, openPosition: pos };
}

// Close 50% at TP1 and move the stop on the remainder to breakeven (entry
// price), let the remainder run to TP2 or the breakeven stop. Only entries
// with a valid targetPrice2 are usable (see pushEntry). If stop and target
// land in the same candle we conservatively assume the stop/breakeven side
// hit first, same convention as the single-target simulator above.
function simulateOrbSweepTradesPartial(candles, entries, exitCfg) {
  const commissionPct = Number(exitCfg.commissionPct || 0);
  const usable = entries.filter(e => e.targetPrice2 != null);
  const entryAtIndex = new Map(usable.map(e => [e.index, e]));
  const trades = [];
  let pos = null;
  for (let i = 0; i < candles.length; i++) {
    const e = entryAtIndex.get(i);
    if (e && !pos) {
      pos = {
        type: e.type, system: e.system, session: e.session || null,
        entryIndex: i, entryTime: candles[i].time, entryPrice: candles[i].close,
        stopPrice: e.stopPrice, tp1: e.targetPrice, tp2: e.targetPrice2,
        half1Closed: false, leg1Pnl: null,
      };
      continue;
    }
    if (pos) {
      const c = candles[i];
      const isLong = pos.type === 'long';
      if (!pos.half1Closed) {
        const stopHit = isLong ? c.low <= pos.stopPrice : c.high >= pos.stopPrice;
        const tp1Hit = isLong ? c.high >= pos.tp1 : c.low <= pos.tp1;
        if (stopHit) {
          const grossPnlPct = pctMove(isLong, pos.entryPrice, pos.stopPrice);
          const netPnlPct = grossPnlPct - commissionPct * 2;
          trades.push({ ...pos, exitIndex: i, exitTime: c.time, exitPrice: pos.stopPrice, grossPnlPct, netPnlPct, commissionPct, durationMinutes: (c.time - pos.entryTime) / 60000, reason: 'stop_full' });
          pos = null;
        } else if (tp1Hit) {
          pos.half1Closed = true;
          pos.leg1Pnl = pctMove(isLong, pos.entryPrice, pos.tp1);
          pos.stopPrice = pos.entryPrice; // breakeven on the remainder
        }
        continue;
      }
      const beHit = isLong ? c.low <= pos.stopPrice : c.high >= pos.stopPrice;
      const tp2Hit = isLong ? c.high >= pos.tp2 : c.low <= pos.tp2;
      if (beHit || tp2Hit) {
        const hitBE = beHit;
        const exitPrice = hitBE ? pos.stopPrice : pos.tp2;
        const leg2Pnl = pctMove(isLong, pos.entryPrice, exitPrice);
        const grossPnlPct = pos.leg1Pnl * 0.5 + leg2Pnl * 0.5;
        const netPnlPct = grossPnlPct - commissionPct * 2; // one round-trip commission per half, netted here as a whole
        trades.push({ ...pos, exitIndex: i, exitTime: c.time, exitPrice, grossPnlPct, netPnlPct, commissionPct, durationMinutes: (c.time - pos.entryTime) / 60000, reason: hitBE ? 'breakeven+target1' : 'target1+target2' });
        pos = null;
      }
    }
  }
  return { trades, openPosition: pos };
}

module.exports = { buildOrbSweepEntries, simulateOrbSweepTrades, simulateOrbSweepTradesPartial };
