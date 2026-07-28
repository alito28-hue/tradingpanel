// Same Turtle Soup / ICT multi-timeframe liquidity sweep backtest as
// run_backtest_liquidity_sweep_mtf.js, run on EUR/USD via Dukascopy instead
// of BTCUSDT via Binance — 2026-07-27, testing whether the strategy
// generalizes to an instrument/market structure it was actually designed
// around (real trading sessions, historically more range-bound than BTC).
// Usage: node run_backtest_liquidity_sweep_forex.js
const fs = require('fs');
const path = require('path');
const { buildLiquiditySweepEntries } = require('../../lib/strategyLiquiditySweepMTF');
const { simulateOrbSweepTrades } = require('../../lib/strategyOrbSweep');
const { computeMetrics } = require('../../lib/strategy');
const { fetchForexCandles } = require('../../lib/dukascopy');

async function loadCached(instrument, timeframe, fromDate, toDate, cacheName) {
  const cachePath = path.join(__dirname, '..', 'results', cacheName);
  const startTime = fromDate.getTime(), endTime = toDate.getTime();
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.startTime === startTime && cached.endTime === endTime) {
      console.error(`Using cached ${timeframe} candles:`, cached.candles.length);
      return cached.candles;
    }
  }
  console.error(`Fetching ${instrument} ${timeframe} from Dukascopy...`);
  const candles = await fetchForexCandles(instrument, timeframe, fromDate, toDate);
  console.error(`${timeframe} candles:`, candles.length);
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
    const instrument = 'eurusd';
    const toDate = new Date('2026-07-22');
    const fromDate = new Date(toDate.getTime() - 360 * 86400000);
    const days = 360;

    const candles5m = await loadCached(instrument, 'm5', fromDate, toDate, 'candles_forex_eurusd_m5_360d.json');
    const candles1h = await loadCached(instrument, 'h1', fromDate, toDate, 'candles_forex_eurusd_h1_360d.json');
    console.error(`5m candles: ${candles5m.length}, 1h candles: ${candles1h.length}, días: ${days}`);

    const baseCfg = { useTrendFilter: true, emaFastLen: 20, emaSlowLen: 50, wickRejectionPct: 0.4 };
    // No exchange fee on spot FX rate data itself — this backtest measures
    // pure price edge in %, same convention as commissionPct=0 would in the
    // crypto scripts. Real forex execution costs (spread) aren't modeled
    // here; that's a separate, later check once/if there's an edge to protect.
    const exitCfg = { commissionPct: 0 };

    for (const trend of [true, false]) {
      console.log(`\n\n========== EUR/USD — Filtro de tendencia: ${trend ? 'SI' : 'NO'} ==========`);
      const cfg = { ...baseCfg, useTrendFilter: trend };
      const { entries } = buildLiquiditySweepEntries(candles5m, candles1h, cfg);
      const { trades } = simulateOrbSweepTrades(candles5m, entries, exitCfg, 'tp1');
      report('TODOS los niveles combinados', trades, days);
      for (const type of ['PDH_PDL', 'PWH_PWL', 'H4', 'H1']) {
        const sub = trades.filter(t => t.system === 'SWEEP_' + type);
        report(`  ${type}`, sub, days);
      }
      report('  (todos) LONG', trades.filter(t => t.type === 'long'), days);
      report('  (todos) SHORT', trades.filter(t => t.type === 'short'), days);
    }
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
