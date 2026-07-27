// Backtest for the ground-up momentum-burst scalp (2026-07-21 follow-up to
// the ORB/Barrido/funding tests). 1m EMA9/21 cross + range expansion +
// taker-volume confirmation, tight swing stop capped by the 30x
// liquidation-safety guard, fixed-$ target. This revision narrows frequency
// down to the user's real constraint ("no más de 1-2 entradas por día") two
// ways: (a) raising the expansion threshold so fewer signals qualify at all,
// and (b) keeping every signal but capping it to the top-N strongest per
// calendar day (ranked by expansion ratio) regardless of threshold.
// Usage: node run_backtest_scalp_momentum.js
const fs = require('fs');
const path = require('path');
const { buildMomentumEntries } = require('../../lib/strategyScalpMomentum');
const { simulateOrbSweepTrades } = require('../../lib/strategyOrbSweep');
const { computeMetrics } = require('../../lib/strategy');

function loadCache(name) {
  const p = path.join(__dirname, '..', 'results', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function report(label, trades, days) {
  const m = computeMetrics(trades);
  if (!m) { console.log(`${label}: sin trades`); return; }
  const perDay = trades.length / days;
  console.log(`${label}: trades=${trades.length} (${perDay.toFixed(2)}/día) winRate=${m.winRate.toFixed(1)}% PF=${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} PnLneto=${m.totalPnl.toFixed(1)}% PnLbruto=${m.grossTotalPnl.toFixed(1)}% comisión=${m.commissionCostPct.toFixed(1)}% maxDD=${m.maxDD.toFixed(1)}%`);
}

function capTopNPerDay(entries, candles, n) {
  const byDay = new Map();
  for (const e of entries) {
    const day = Math.floor(candles[e.index].time / 86400000);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const out = [];
  for (const dayEntries of byDay.values()) {
    dayEntries.sort((a, b) => b.strength - a.strength);
    out.push(...dayEntries.slice(0, n));
  }
  return out.sort((a, b) => a.index - b.index);
}

(function main() {
  const cached = loadCache('candles_1m_360d.json');
  const candles = cached.candles;
  const days = (cached.endTime - cached.startTime) / (24 * 3600 * 1000);
  console.error(`1m candles: ${candles.length} (${days.toFixed(0)} días)`);

  const leverage = 30;
  const targetUsd = 450;
  const exitCfg = { commissionPct: 0.05 };
  const baseCfg = { emaFastLen: 9, emaSlowLen: 21, rangeWindow: 20, volumeWindow: 10, swingLookback: 15, targetUsd, leverage, safetyFactor: 0.7 };

  console.log('\n--- Subiendo el umbral de expansión para bajar la frecuencia naturalmente ---');
  for (const mult of [1.5, 2.5, 3.5, 4.5, 6, 8]) {
    const cfg = { ...baseCfg, rangeExpansionMult: mult };
    const entries = buildMomentumEntries(candles, cfg);
    const { trades } = simulateOrbSweepTrades(candles, entries, exitCfg, 'tp1');
    console.log(`\n=== expansión >= ${mult}x ===`);
    report('resultado', trades, days);
  }

  console.log('\n\n--- Alternativa: quedarme SIEMPRE con las N señales más fuertes de cada día ---');
  const cfgWide = { ...baseCfg, rangeExpansionMult: 1.5 }; // umbral bajo, dejamos que el ranking filtre
  const allEntries = buildMomentumEntries(candles, cfgWide);
  for (const n of [1, 2]) {
    const capped = capTopNPerDay(allEntries, candles, n);
    const { trades } = simulateOrbSweepTrades(candles, capped, exitCfg, 'tp1');
    console.log(`\n=== top-${n}/día (de ${allEntries.length} señales candidatas) ===`);
    report('resultado', trades, days);
  }
})();
