// Backtest for "Piloto Intradía — ORB + Barrido" (see lib/strategyOrbSweep.js
// for the Pine->JS mapping). Compares exit-management scenarios (2026-07-21
// follow-up after the TP1-only baseline lost money: TP2, partial 50/50, and
// ORB-only isolation, per user request).
// Usage: node run_backtest_orb_sweep.js
const fs = require('fs');
const path = require('path');
const { buildOrbSweepEntries, simulateOrbSweepTrades, simulateOrbSweepTradesPartial } = require('../../lib/strategyOrbSweep');
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
  console.error(`Fetching ${interval} candles (this may take a while)...`);
  const candles = await fetchKlinesPaged(symbol, interval, startTime, endTime, (n) => { if (n % 20 === 0) console.error(`${interval} batch ${n}`); });
  console.error(`${interval} candles:`, candles.length);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ startTime, endTime, candles }));
  return candles;
}

function reportGroup(label, trades, days) {
  const m = computeMetrics(trades);
  if (!m) { console.log(`${label}: sin trades`); return; }
  const perDay = trades.length / days;
  console.log(`${label}: trades=${trades.length} (${perDay.toFixed(2)}/día) winRate=${m.winRate.toFixed(1)}% PF=${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} PnL=${m.totalPnl.toFixed(1)}% maxDD=${m.maxDD.toFixed(1)}% avgWin=${m.avgWin.toFixed(2)}% avgLoss=${m.avgLoss.toFixed(2)}%`);
}

(async function main() {
  try {
    const symbol = 'BTCUSDT';
    const endTime = Date.now();
    const startTime = endTime - 360 * 24 * 3600 * 1000;
    const days = 360;

    const candles5m = await loadCached(symbol, '5m', startTime, endTime, 'candles_5m_orb_360d.json');

    const cfg = {
      emaFastLen: 20, emaSlowLen: 50, useTrendFilter: true,
      showORB: true, orbMinPct: 0.15, orbMaxPct: 1.0, rrTarget: 2.0,
      sessions: [
        { label: 'Asia', window: '1800-1830' },
        { label: 'London', window: '0400-0430' },
        { label: 'NY', window: '0900-0930' },
      ],
      showSweep: true, sweepHrs: 5.0, pivotLeft: 4,
      barMinutes: 5,
    };
    const exitCfg = { commissionPct: 0.05 };

    const { entries } = buildOrbSweepEntries(candles5m, cfg);
    const allEntries = entries;
    const orbEntries = entries.filter(e => e.system === 'ORB');
    console.error(`Entradas detectadas: ${entries.length} (ORB=${orbEntries.length}, SWEEP=${entries.length - orbEntries.length})`);

    const scenarios = [
      { key: 'tp1', label: 'TP1 único', run: (ents) => simulateOrbSweepTrades(candles5m, ents, exitCfg, 'tp1').trades },
      { key: 'tp2', label: 'TP2 único', run: (ents) => simulateOrbSweepTrades(candles5m, ents, exitCfg, 'tp2').trades },
      { key: 'partial', label: 'Parcial 50% TP1 + resto a BE/TP2', run: (ents) => simulateOrbSweepTradesPartial(candles5m, ents, exitCfg).trades },
    ];

    const output = { startTime, endTime, days, candles5m: candles5m.length, cfg, exitCfg, scenarios: {} };

    for (const s of scenarios) {
      console.log(`\n=== ${s.label} — TODOS LOS SISTEMAS ===`);
      const tradesAll = s.run(allEntries);
      reportGroup('TODOS', tradesAll, days);
      reportGroup('  ORB', tradesAll.filter(t => t.system === 'ORB'), days);
      reportGroup('  Barrido', tradesAll.filter(t => t.system === 'SWEEP'), days);

      console.log(`\n=== ${s.label} — SOLO ORB (Barrido descartado) ===`);
      const tradesOrb = s.run(orbEntries);
      reportGroup('ORB solo', tradesOrb, days);
      reportGroup('  Asia', tradesOrb.filter(t => t.session === 'Asia'), days);
      reportGroup('  London', tradesOrb.filter(t => t.session === 'London'), days);
      reportGroup('  NY', tradesOrb.filter(t => t.session === 'NY'), days);

      output.scenarios[s.key] = {
        all: { count: tradesAll.length, metrics: computeMetrics(tradesAll), trades: tradesAll },
        orbOnly: { count: tradesOrb.length, metrics: computeMetrics(tradesOrb), trades: tradesOrb },
      };
    }

    fs.writeFileSync(path.join(__dirname, '..', 'backtest_orb_sweep_result.json'), JSON.stringify(output, null, 2));
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
