// Node script to run the intraday momentum backtest for a date range
// Usage: node run_backtest.js

const fs = require('fs');
const path = require('path');
const { buildAnalysis, gateEntries, simulateTrades, computeMetrics } = require('../../lib/strategy');
const { fetchKlinesPaged } = require('../../lib/binance');

(async function main(){
  try {
    const symbol = 'BTCUSDT';
    const startTime = Date.UTC(2026, 4, 1, 0, 0, 0); // May 1 2026
    const endTime = Date.UTC(2026, 5, 30, 23, 59, 59); // Jun 30 2026
    console.error('Fetching 1H candles...');
    const candles1h = await fetchKlinesPaged(symbol, '1h', startTime, endTime, (n) => console.error(`1h batch ${n}`));
    console.error('1H candles:', candles1h.length);
    console.error('Fetching 1M candles (this may take a while)...');
    const candles1m = await fetchKlinesPaged(symbol, '1m', startTime, endTime, (n) => console.error(`1m batch ${n}`));
    console.error('1M candles:', candles1m.length);

    const mode = 'single';
    const useMacdFilter = true;
    const h1 = { length: 200, cooldownHours: 6 };
    const m1 = { length: 200, cooldownMinutes: 0 };
    const exitCfg = { activationPct: 1.33, trailPct: 0.25, srLookbackBars: 50, srTolerancePct: 0.15, srMinTouches: 4, atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05 };

    const analysis1h = buildAnalysis(candles1h, mode, h1, useMacdFilter, h1.cooldownHours * 3600000);
    const analysis1m = buildAnalysis(candles1m, mode, m1, useMacdFilter, m1.cooldownMinutes * 60000);

    const scenarios = [ {label: 'Con filtro de régimen 1H', gateByRegime: true}, {label: 'Sin filtro de régimen 1H', gateByRegime: false} ];
    const comparison = [];
    for (const s of scenarios) {
      const { entries } = gateEntries(candles1m, analysis1m.signals, candles1h, analysis1h.regime, s.gateByRegime);
      const { trades } = simulateTrades(candles1m, candles1h, entries, exitCfg);
      const metrics = computeMetrics(trades);
      comparison.push({ label: s.label, count: trades.length, metrics, trades, sampleTrades: trades.slice(-30) });
      console.error(`${s.label}: trades=${trades.length}`);
    }

    const output = { rangeStart: startTime, rangeEnd: endTime, candles1m: candles1m.length, candles1h: candles1h.length, comparison };
    const outputPath = path.join(__dirname, '..', 'backtest_result.json');
    const resultsDir = path.join(__dirname, '..', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    fs.writeFileSync(path.join(resultsDir, 'backtest_result.json'), JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
