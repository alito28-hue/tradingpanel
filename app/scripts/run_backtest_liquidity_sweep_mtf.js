// Turtle Soup / ICT-style liquidity sweep backtest using real multi-timeframe
// levels (prev day, prev week, prev 4h candle, prev 1h candle) — 2026-07-27
// follow-up to the generic-pivot "Barrido" system from the previous session
// (PF 0.27). Exit: full exit at TP1 (midpoint of the swept range) or stop,
// same convention used throughout this project's backtests.
// Usage: node run_backtest_liquidity_sweep_mtf.js
const fs = require('fs');
const path = require('path');
const { buildLiquiditySweepEntries } = require('../../lib/strategyLiquiditySweepMTF');
const { simulateOrbSweepTrades } = require('../../lib/strategyOrbSweep');
const { computeMetrics } = require('../../lib/strategy');
const { fetchKlinesPaged } = require('../../lib/binance');

async function loadCached(symbol, interval, startTime, endTime, cacheName) {
  const cachePath = path.join(__dirname, '..', 'results', cacheName);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.startTime === startTime && cached.endTime === endTime) {
      console.error(`Using cached ${interval} candles:`, cached.candles.length);
      return cached.candles;
    }
  }
  console.error(`Fetching ${interval} candles...`);
  const candles = await fetchKlinesPaged(symbol, interval, startTime, endTime, (n) => { if (n % 20 === 0) console.error(`${interval} batch ${n}`); });
  console.error(`${interval} candles:`, candles.length);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ startTime, endTime, candles }));
  return candles;
}

function report(label, trades, days) {
  const m = computeMetrics(trades);
  if (!m) { console.log(`${label}: sin trades`); return; }
  const perDay = trades.length / days;
  console.log(`${label}: trades=${trades.length} (${perDay.toFixed(2)}/día) winRate=${m.winRate.toFixed(1)}% PF=${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} PnL=${m.totalPnl.toFixed(1)}% maxDD=${m.maxDD.toFixed(1)}%`);
}

(async function main() {
  try {
    const symbol = 'BTCUSDT';
    const cached5m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', 'candles_5m_orb_360d.json'), 'utf8'));
    const candles5m = cached5m.candles;
    const startTime = cached5m.startTime, endTime = cached5m.endTime;
    const days = (endTime - startTime) / 86400000;

    const candles1h = await loadCached(symbol, '1h', startTime, endTime, 'candles_1h_mtf_sweep.json');
    console.error(`5m candles: ${candles5m.length}, 1h candles: ${candles1h.length}, días: ${days.toFixed(0)}`);

    const baseCfg = { useTrendFilter: true, emaFastLen: 20, emaSlowLen: 50, wickRejectionPct: 0.4 };
    const exitCfg = { commissionPct: 0.05 };

    for (const trend of [true, false]) {
      console.log(`\n\n========== Filtro de tendencia: ${trend ? 'SI' : 'NO'} ==========`);
      const cfg = { ...baseCfg, useTrendFilter: trend };
      const { entries } = buildLiquiditySweepEntries(candles5m, candles1h, cfg);
      const { trades } = simulateOrbSweepTrades(candles5m, entries, exitCfg, 'tp1');
      report('TODOS los niveles combinados', trades, days);
      for (const type of ['PDH_PDL', 'PWH_PWL', 'H4', 'H1']) {
        const sub = trades.filter(t => t.system === 'SWEEP_' + type);
        report(`  ${type}`, sub, days);
      }
      const longs = trades.filter(t => t.type === 'long');
      const shorts = trades.filter(t => t.type === 'short');
      report('  (todos) LONG', longs, days);
      report('  (todos) SHORT', shorts, days);
    }
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
