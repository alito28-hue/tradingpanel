// Pure calculations, no Node built-ins — safe to import from client
// components too (e.g. the bot config page's live preview). DailyLossTracker
// lives separately in lib/dailyLossTracker.js since it needs fs.
const MAX_OPEN_POSITIONS = 1;

// Rejects a trade whose own stop is farther than a safe fraction of the
// approximate liquidation distance for the given leverage. Backtested against
// 180 days of BTCUSDT: at 20x (~5% liquidation threshold) 14.4% of trades had
// a wider stop than that; at 10x (~10%) only 1.5% did. safetyFactor leaves
// headroom below the raw threshold for slippage/fees.
function checkStopDistance(entryPrice, stopPrice, leverage, safetyFactor = 0.7) {
  const stopDistPct = Math.abs(entryPrice - stopPrice) / entryPrice * 100;
  const liquidationThresholdPct = 100 / leverage;
  const safeThresholdPct = liquidationThresholdPct * safetyFactor;
  return { ok: stopDistPct <= safeThresholdPct, stopDistPct, liquidationThresholdPct, safeThresholdPct };
}

module.exports = { MAX_OPEN_POSITIONS, checkStopDistance };
