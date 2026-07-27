// Backtests the "MA Cross + MACD Zero Filter (Optimizado V9 - WunderTrading)"
// Pine v6 script the user provided, with SL 0.7% / trailing activation 1.5% /
// trailing distance 0.25%. Single timeframe (1H), matching the script's own
// alert message strings ("_1H_"). Separate from run_backtest.js — this does
// not touch buildAnalysis/simulateTrades, which is what the live dashboard
// and worker use.
// Usage: node run_backtest_v9.js [--sl=0.7] [--activation=1.5] [--trail=0.25]
//        [--no-rsi] [--no-macd-align] [--no-macd-zero] [--no-atr-buffer]
// Caches fetched candles locally (same date range every run) so iterating on
// SL/filter variants doesn't re-fetch ~6 months of 1H klines each time.

const fs = require('fs');
const path = require('path');
const { buildAnalysisV9, simulateTradesFixedTrailing, computeMetrics } = require('../../lib/strategy');
const { fetchKlinesPaged } = require('../../lib/binance');

function argNum(flag, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${flag}=`));
  return arg ? Number(arg.split('=')[1]) : fallback;
}
const hasFlag = (flag) => process.argv.includes(`--${flag}`);

(async function main() {
  try {
    const symbol = 'BTCUSDT';
    const startTime = Date.UTC(2026, 0, 15, 0, 0, 0); // Jan 15 2026
    const endTime = Date.UTC(2026, 6, 15, 23, 59, 59); // Jul 15 2026 (~180 days)

    const cachePath = path.join(__dirname, '..', 'results', 'candles_1h_v9_cache.json');
    let candles;
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.startTime === startTime && cached.endTime === endTime) {
        candles = cached.candles;
        console.error('Using cached 1H candles:', candles.length);
      }
    }
    if (!candles) {
      console.error('Fetching 1H candles...');
      candles = await fetchKlinesPaged(symbol, '1h', startTime, endTime, (n) => console.error(`1h batch ${n}`));
      console.error('1H candles:', candles.length);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ startTime, endTime, candles }));
    }

    const entryCfg = {
      maLen: 200,
      cooldownHours: 4,
      useMacdZeroFilter: !hasFlag('no-macd-zero'),
      useMacdAlignFilter: !hasFlag('no-macd-align'),
      useRsiFilter: !hasFlag('no-rsi'),
      useAtrBuffer: !hasFlag('no-atr-buffer'),
      atrMult: 0.55,
    };
    const exitCfg = {
      slPct: argNum('sl', 0.7),
      activationPct: argNum('activation', 1.5),
      trailPct: argNum('trail', 0.25),
      commissionPct: 0.05,
      leverage: 10,
    };

    const analysis = buildAnalysisV9(candles, entryCfg);
    const entries = analysis.signals
      .map((s, i) => (s ? { index: i, type: s === 'up' ? 'long' : 'short' } : null))
      .filter(Boolean);
    console.error('Raw signals (before any trade got skipped by the leverage safety filter):', entries.length);

    const { trades, openPosition } = simulateTradesFixedTrailing(candles, entries, exitCfg);
    const metrics = computeMetrics(trades);
    console.error(`trades=${trades.length}`);
    if (metrics) {
      console.error(`winRate=${metrics.winRate.toFixed(1)}% profitFactor=${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)} totalPnl=${metrics.totalPnl.toFixed(1)}% maxDD=${metrics.maxDD.toFixed(1)}%`);
    } else {
      console.error('No trades — nothing to report metrics on.');
    }

    const output = {
      rangeStart: startTime, rangeEnd: endTime, candles: candles.length,
      entryCfg, exitCfg, signalCount: entries.length, tradeCount: trades.length,
      metrics, openPosition, trades,
    };
    const outputPath = path.join(__dirname, '..', 'backtest_v9_result.json');
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ tradeCount: trades.length, metrics }, null, 2));
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
