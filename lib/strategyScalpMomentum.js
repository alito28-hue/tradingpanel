// Purpose-built for the "hiper apalancado, blanco fijo en USD" plan
// (2026-07-21): a 1m momentum-burst entry (EMA9/21 cross + range expansion +
// taker-volume confirmation) with a tight swing-based stop and a fixed-$
// target, instead of adapting an existing indicator's own SL/TP shape.
// Reuses swingExtreme/volumeProfile/ema from strategy.js — no new math for
// pieces that already exist there.
const { ema, sma, swingExtreme, volumeProfile } = require('./strategy');
const { checkStopDistance } = require('./botSafety');

// cfg: { emaFastLen, emaSlowLen, rangeWindow, rangeExpansionMult,
//   volumeWindow, swingLookback, targetUsd, leverage, safetyFactor }
function buildMomentumEntries(candles, cfg) {
  const closes = candles.map(c => c.close);
  const emaF = ema(closes, cfg.emaFastLen);
  const emaS = ema(closes, cfg.emaSlowLen);
  const ranges = candles.map(c => c.high - c.low);
  const avgRange = sma(ranges, cfg.rangeWindow);
  const { deltaSum } = volumeProfile(candles, cfg.volumeWindow);

  const entries = [];
  for (let i = 1; i < candles.length; i++) {
    if ([emaF[i - 1], emaS[i - 1], emaF[i], emaS[i], avgRange[i]].some(v => v == null)) continue;
    const crossUp = emaF[i - 1] <= emaS[i - 1] && emaF[i] > emaS[i];
    const crossDn = emaF[i - 1] >= emaS[i - 1] && emaF[i] < emaS[i];
    const expansion = ranges[i] >= avgRange[i] * cfg.rangeExpansionMult;
    if (!expansion || (!crossUp && !crossDn)) continue;

    const entryPrice = candles[i].close;
    const isLong = crossUp && deltaSum[i] > 0;
    const isShort = crossDn && deltaSum[i] < 0;
    if (!isLong && !isShort) continue;

    const stopPrice = swingExtreme(candles, i, cfg.swingLookback, isLong ? 'low' : 'high');
    const stopOk = isLong ? stopPrice < entryPrice : stopPrice > entryPrice;
    if (!stopOk) continue;
    // Same liquidation-safety guard the bot applies before a real order
    // (lib/botSafety.js) — at 30x this is what actually caps how wide the
    // swing stop is allowed to be, so the backtest reflects that ceiling.
    if (cfg.leverage && !checkStopDistance(entryPrice, stopPrice, cfg.leverage, cfg.safetyFactor).ok) continue;

    const targetPrice = isLong ? entryPrice + cfg.targetUsd : entryPrice - cfg.targetUsd;
    // Expansion ratio at the trigger candle — lets a caller rank same-day
    // signals by conviction and keep only the strongest N (see the
    // "at most 1-2/day" variant in run_backtest_scalp_momentum.js).
    const strength = ranges[i] / avgRange[i];
    entries.push({ index: i, type: isLong ? 'long' : 'short', entryPrice, stopPrice, targetPrice, strength });
  }
  return entries;
}

module.exports = { buildMomentumEntries };
