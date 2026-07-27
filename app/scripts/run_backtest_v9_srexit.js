// Isolates entry quality from exit quality: takes the V9 Pine script's entry
// signals (MA200 cross + MACD zero/alignment + RSI + ATR noise buffer +
// direction-only cooldown) but runs them through the SAME SR+ATR trailing
// exit already used by the live dashboard/worker (EXIT_CFG in
// app/dashboard/page.js), instead of the fixed 0.7-1% SL that was drowning
// every trade in 1H noise. Single timeframe (1H) — simulateTrades accepts
// the same candle array for both the "entry" and "1H" params, which works
// because V9's signals are already indices into a 1H array.
// Usage: node run_backtest_v9_srexit.js

const fs = require('fs');
const path = require('path');
const { buildAnalysisV9, simulateTrades, computeMetrics } = require('../../lib/strategy');

(async function main() {
  try {
    const cachePath = path.join(__dirname, '..', 'results', 'candles_1h_v9_cache.json');
    if (!fs.existsSync(cachePath)) {
      console.error('No cached candles found — run run_backtest_v9.js first.');
      process.exit(1);
    }
    const { candles } = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    console.error('1H candles:', candles.length);

    const entryCfg = {
      maLen: 200, cooldownHours: 4,
      useMacdZeroFilter: true, useMacdAlignFilter: true, useRsiFilter: true,
      useAtrBuffer: true, atrMult: 0.55,
    };
    // Exact same EXIT_CFG the live dashboard/worker use today (app/dashboard/page.js).
    const exitCfg = {
      activationPct: 1.33, trailPct: 0.25, srLookbackBars: 50, srTolerancePct: 0.15,
      srMinTouches: 4, atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05,
      minStopAtrMultiple: 2.5, leverage: 10,
    };

    const analysis = buildAnalysisV9(candles, entryCfg);
    const entries = analysis.signals
      .map((s, i) => (s ? { index: i, type: s === 'up' ? 'long' : 'short' } : null))
      .filter(Boolean);
    console.error('Raw V9 signals:', entries.length);

    const { trades, openPosition } = simulateTrades(candles, candles, entries, exitCfg);
    const metrics = computeMetrics(trades);
    console.error(`trades=${trades.length}`);
    if (metrics) {
      console.error(`winRate=${metrics.winRate.toFixed(1)}% profitFactor=${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)} totalPnl=${metrics.totalPnl.toFixed(1)}% maxDD=${metrics.maxDD.toFixed(1)}%`);
      const reasons = {};
      trades.forEach(t => { reasons[t.reason] = (reasons[t.reason] || 0) + 1; });
      console.error('Exit reasons:', JSON.stringify(reasons));
    } else {
      console.error('No trades.');
    }

    fs.writeFileSync(path.join(__dirname, '..', 'backtest_v9_srexit_result.json'),
      JSON.stringify({ entryCfg, exitCfg, signalCount: entries.length, tradeCount: trades.length, metrics, trades }, null, 2));
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
