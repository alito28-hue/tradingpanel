// Free historical forex/CFD candles via Dukascopy (no API key), used to test
// whether strategies validated on BTC generalize to other instruments —
// 2026-07-27. Converts to this project's standard candle shape so the same
// strategy/backtest code (lib/strategy.js, lib/strategyOrbSweep.js,
// lib/strategyLiquiditySweepMTF.js) works unmodified regardless of source.
const { getHistoricalRates } = require('dukascopy-node');

const TF_MS = { m1: 60000, m5: 5 * 60000, m15: 15 * 60000, m30: 30 * 60000, h1: 3600000, h4: 4 * 3600000, d1: 86400000 };

// Forex has no taker-buy/sell aggressor split like crypto perpetuals — set
// to half of volume (neutral) so any shared code that reads takerBuyVolume
// doesn't see null, even though none of this project's forex-tested
// strategies (ORB/Sweep) actually use it.
async function fetchForexCandles(instrument, timeframe, fromDate, toDate) {
  const intervalMs = TF_MS[timeframe];
  if (!intervalMs) throw new Error(`Unknown timeframe: ${timeframe}`);
  const raw = await getHistoricalRates({
    instrument, dates: { from: fromDate, to: toDate }, timeframe, format: 'json',
  });
  return raw.map(r => ({
    time: r.timestamp,
    open: r.open, high: r.high, low: r.low, close: r.close,
    volume: r.volume,
    closeTime: r.timestamp + intervalMs - 1,
    takerBuyVolume: r.volume / 2,
  }));
}

module.exports = { fetchForexCandles };
