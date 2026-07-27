// "Estrategia Corta 1M - 20 Entradas - Mejorado": long-only, MACD crossover
// on 1m gated by RSI(1m)+RSI(5m)+MACD(5m) confirmation, fixed SL 1% / trailing
// TP activate 0.45% / distance 0.05%. Tested both gated and ungated by the
// 1H regime, since the user's own caveat is "solo sirve si sabes para que
// lado esta la tendencia" — that external trend read is our existing 1H gate.
// Usage: node run_backtest_scalpv1.js

const fs = require('fs');
const path = require('path');
const { buildAnalysis, buildAnalysisScalpV1, gateEntries, simulateTradesFixedTrailing, computeMetrics } = require('../../lib/strategy');

function loadCache(name) {
  const p = path.join(__dirname, '..', 'results', name);
  if (!fs.existsSync(p)) { console.error('Missing cache:', p); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8')).candles;
}

(function main() {
  const c1h = loadCache('candles_1h_v9_cache.json');
  const c1m = loadCache('candles_1m_v9_cache.json');
  const c5m = loadCache('candles_5m_v9_cache.json');
  console.error(`1H: ${c1h.length}, 1m: ${c1m.length}, 5m: ${c5m.length}`);

  const h1 = { length: 200, cooldownHours: 6 };
  const regimeAnalysis = buildAnalysis(c1h, 'single', h1, true, h1.cooldownHours * 3600000);

  const entryCfg = {
    fastLength: 12, slowLength: 26, signalLength: 9,
    rsiLength: 14, rsiThreshold: 50,
    rsiLengthMTF: 14, rsiThresholdMTF: 40,
    macdMtfThreshold: 60,
  };
  const scalp = buildAnalysisScalpV1(c1m, c5m, entryCfg);
  console.error('Raw signals:', scalp.signals.filter(Boolean).length);

  const exitCfg = { slPct: 1, activationPct: 0.45, trailPct: 0.05, commissionPct: 0.05, leverage: 10 };

  for (const gateByRegime of [true, false]) {
    const { entries } = gateEntries(c1m, scalp.signals, c1h, regimeAnalysis.regime, gateByRegime);
    const { trades } = simulateTradesFixedTrailing(c1m, entries, exitCfg);
    const m = computeMetrics(trades);
    const label = gateByRegime ? 'Con gate 1H (solo long si 1H bullish)' : 'Sin gate 1H (long siempre que dispare)';
    console.log(`[${label}] entries=${entries.length} trades=${trades.length}`);
    if (m) {
      console.log(`  winRate=${m.winRate.toFixed(1)}% PF=${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} PnL=${m.totalPnl.toFixed(1)}% maxDD=${m.maxDD.toFixed(1)}%`);
      const reasons = {}; trades.forEach(t => { reasons[t.reason] = (reasons[t.reason] || 0) + 1; });
      console.log('  reasons:', JSON.stringify(reasons));
    } else {
      console.log('  sin trades');
    }
  }
})();
