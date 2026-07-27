// Long-only strategy built on the one funding-rate finding that held up
// across two very different regimes (see check_funding_edge.js): extreme
// negative funding precedes above-baseline forward returns. Percentile is
// rolling/trailing (no look-ahead), unlike the exploratory check which used
// whole-sample percentiles. Exit reuses the SR+ATR trailing stop already
// validated as the best performer today. Tests both a pure-signal entry
// (immediate, no technical trigger) and one gated by a simple confirmation
// (green 1H candle), over both regimes.
// Usage: node run_backtest_funding.js --range=<start>,<end> --cache=<suffix>

const fs = require('fs');
const path = require('path');
const { buildFundingBiasEntries, simulateTrades, computeMetrics } = require('../../lib/strategy');

function loadCache(name) {
  const p = path.join(__dirname, '..', 'results', name);
  if (!fs.existsSync(p)) { console.error('Missing cache:', p); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8')).data;
}

function report(label, trades) {
  const m = computeMetrics(trades);
  if (!m) { console.log(`${label}: sin trades`); return; }
  console.log(`${label}: trades=${trades.length} winRate=${m.winRate.toFixed(1)}% PF=${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} PnL=${m.totalPnl.toFixed(1)}% maxDD=${m.maxDD.toFixed(1)}%`);
}

(function main() {
  const cacheSuffix = (process.argv.find(a => a.startsWith('--cache=')) || '--cache=_2y').split('=')[1];
  const periodLabel = (process.argv.find(a => a.startsWith('--label=')) || '--label=periodo').split('=')[1];

  const funding = loadCache(`funding${cacheSuffix}.json`);
  const c1h = loadCache(`candles_1h${cacheSuffix}.json`);
  console.error(`[${periodLabel}] funding events: ${funding.length}, 1H candles: ${c1h.length}`);

  const exitCfg = { activationPct: 1.33, trailPct: 0.25, srLookbackBars: 50, srTolerancePct: 0.15, srMinTouches: 4, atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05, minStopAtrMultiple: 2.5, leverage: 10 };

  const thresholds = [0.10, 0.15, 0.20, 0.25, 0.30];
  for (const percentileThreshold of thresholds) {
    const biasUntil = buildFundingBiasEntries(c1h, funding, { rankWindow: 270, percentileThreshold, biasHours: 24 });

    // Variant B only (bias + green-candle confirmation) — already the better of the two.
    const entriesB = [];
    let takenSinceRise = false;
    for (let i = 1; i < c1h.length; i++) {
      if (biasUntil[i] && !biasUntil[i - 1]) takenSinceRise = false;
      if (!biasUntil[i]) { takenSinceRise = false; continue; }
      if (takenSinceRise) continue;
      const isGreen = c1h[i].close > c1h[i].open;
      if (isGreen) { entriesB.push({ index: i, type: 'long' }); takenSinceRise = true; }
    }
    const { trades } = simulateTrades(c1h, c1h, entriesB, exitCfg);
    const pct = (biasUntil.filter(Boolean).length / c1h.length * 100).toFixed(1);
    report(`[${periodLabel}] p<=${(percentileThreshold * 100).toFixed(0)} (bias activo ${pct}% del tiempo)`, trades);
  }
})();
