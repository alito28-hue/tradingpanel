// V9 entries on 1m/5m, gated by 1H bias (same dual-timeframe architecture as
// production), stop at the nearest recent swing low/high on the entry
// timeframe itself (not an SR/ATR level on 1H) — "lo mas cerca posible sin
// cortar el trade". Trailing activation/distance carried over from the best
// fixed-exit variant found earlier today (0.65% / 0.20%).
// Usage: node run_backtest_v9_swingstop.js --tf=1m --lookback=20

const fs = require('fs');
const path = require('path');
const { buildAnalysis, buildAnalysisV9, gateEntries, simulateTradesSwingStop, computeMetrics } = require('../../lib/strategy');

const tf = (process.argv.find(a => a.startsWith('--tf=')) || '--tf=1m').split('=')[1];
const swingLookback = Number((process.argv.find(a => a.startsWith('--lookback=')) || '--lookback=20').split('=')[1]);

const cacheFiles = {
  '1h_180d': 'candles_1h_v9_cache.json',
  '1m_180d': 'candles_1m_v9_cache.json',
  '5m_180d': 'candles_5m_v9_cache.json',
};

function loadCache(name) {
  const p = path.join(__dirname, '..', 'results', cacheFiles[name]);
  if (!fs.existsSync(p)) { console.error('Missing cache:', p); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8')).candles;
}

(function main() {
  const c1h = loadCache('1h_180d');
  const cFast = loadCache(`${tf}_180d`);
  console.error(`1H candles: ${c1h.length}, ${tf} candles: ${cFast.length}`);

  const h1 = { length: 200, cooldownHours: 6 };
  const regimeAnalysis = buildAnalysis(c1h, 'single', h1, true, h1.cooldownHours * 3600000);

  const entryCfg = { maLen: 200, cooldownHours: 4, useMacdZeroFilter: true, useMacdAlignFilter: true, useRsiFilter: true, useAtrBuffer: true, atrMult: 0.55 };
  const v9 = buildAnalysisV9(cFast, entryCfg);
  console.error('Raw V9 signals:', v9.signals.filter(Boolean).length);

  const exitCfg = { swingLookback, activationPct: 0.65, trailPct: 0.20, commissionPct: 0.05, leverage: 10 };

  for (const gateByRegime of [true, false]) {
    const { entries } = gateEntries(cFast, v9.signals, c1h, regimeAnalysis.regime, gateByRegime);
    const { trades } = simulateTradesSwingStop(cFast, entries, exitCfg);
    const m = computeMetrics(trades);
    const label = gateByRegime ? 'Con gate 1H' : 'Sin gate 1H';
    console.log(`[${tf}, lookback=${swingLookback}, ${label}] entries=${entries.length} trades=${trades.length}`);
    if (m) {
      console.log(`  winRate=${m.winRate.toFixed(1)}% PF=${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} PnL=${m.totalPnl.toFixed(1)}% maxDD=${m.maxDD.toFixed(1)}%`);
      const reasons = {}; trades.forEach(t => { reasons[t.reason] = (reasons[t.reason] || 0) + 1; });
      console.log('  reasons:', JSON.stringify(reasons));
    } else {
      console.log('  sin trades');
    }
  }
})();
