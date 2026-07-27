// V9's entry filters (MA200 + MACD zero/alignment + RSI + ATR noise buffer +
// direction-only cooldown) computed on a faster timeframe (1m/5m), gated by
// the 1H regime — same dual-timeframe architecture the live dashboard/worker
// use (buildAnalysis + gateEntries), with the SR+ATR exit already validated
// as far better than a fixed % SL for this instrument/timeframe combo.
// Usage: node run_backtest_v9_fast.js --tf=5m   (or --tf=1m)

const fs = require('fs');
const path = require('path');
const { buildAnalysis, buildAnalysisV9, gateEntries, simulateTrades, computeMetrics } = require('../../lib/strategy');
const { fetchKlinesPaged } = require('../../lib/binance');

const tf = (process.argv.find(a => a.startsWith('--tf=')) || '--tf=5m').split('=')[1];

async function loadCached(symbol, interval, startTime, endTime, cacheName) {
  const cachePath = path.join(__dirname, '..', 'results', cacheName);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.startTime === startTime && cached.endTime === endTime) {
      console.error(`Using cached ${interval} candles:`, cached.candles.length);
      return cached.candles;
    }
  }
  console.error(`Fetching ${interval} candles (this may take a while)...`);
  const candles = await fetchKlinesPaged(symbol, interval, startTime, endTime, (n) => console.error(`${interval} batch ${n}`));
  console.error(`${interval} candles:`, candles.length);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ startTime, endTime, candles }));
  return candles;
}

(async function main() {
  try {
    const symbol = 'BTCUSDT';
    const startTime = Date.UTC(2026, 0, 15, 0, 0, 0);
    const endTime = Date.UTC(2026, 6, 15, 23, 59, 59);

    const candles1h = await loadCached(symbol, '1h', startTime, endTime, 'candles_1h_v9_cache.json');
    const candlesFast = await loadCached(symbol, tf, startTime, endTime, `candles_${tf}_v9_cache.json`);

    const h1 = { length: 200, cooldownHours: 6 };
    const regimeAnalysis = buildAnalysis(candles1h, 'single', h1, true, h1.cooldownHours * 3600000);

    const entryCfg = {
      maLen: 200, cooldownHours: 4,
      useMacdZeroFilter: true, useMacdAlignFilter: true, useRsiFilter: true,
      useAtrBuffer: true, atrMult: 0.55,
    };
    const v9 = buildAnalysisV9(candlesFast, entryCfg);
    console.error(`Raw V9 signals on ${tf}:`, v9.signals.filter(Boolean).length);

    const exitCfg = {
      activationPct: 1.33, trailPct: 0.25, srLookbackBars: 50, srTolerancePct: 0.15,
      srMinTouches: 4, atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05,
      minStopAtrMultiple: 2.5, leverage: 10,
    };

    for (const gateByRegime of [true, false]) {
      const { entries } = gateEntries(candlesFast, v9.signals, candles1h, regimeAnalysis.regime, gateByRegime);
      const { trades } = simulateTrades(candlesFast, candles1h, entries, exitCfg);
      const m = computeMetrics(trades);
      const label = gateByRegime ? 'Con filtro de régimen 1H' : 'Sin filtro de régimen 1H';
      console.error(`\n[${label}] entradas gateadas=${entries.length} trades=${trades.length}`);
      if (m) {
        console.error(`winRate=${m.winRate.toFixed(1)}% profitFactor=${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} totalPnl=${m.totalPnl.toFixed(1)}% maxDD=${m.maxDD.toFixed(1)}%`);
        const reasons = {}; trades.forEach(t => { reasons[t.reason] = (reasons[t.reason] || 0) + 1; });
        console.error('reasons:', JSON.stringify(reasons));
      } else {
        console.error('No trades.');
      }
      fs.writeFileSync(path.join(__dirname, '..', `backtest_v9_fast_${tf}_${gateByRegime ? 'gated' : 'ungated'}_result.json`),
        JSON.stringify({ tf, gateByRegime, entryCfg, exitCfg, tradeCount: trades.length, metrics: m, trades }, null, 2));
    }
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
