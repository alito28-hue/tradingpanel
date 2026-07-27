// Fetches 360 days once, computes both strategies (production's MA200+MACD
// zero filter, and V9's RSI+MACD-alignment+ATR-buffer filter) over the FULL
// history so indicators have proper warmup, then reports metrics both for
// the whole 360 days AND for two sub-windows: the already-tested 180d/60d
// windows (as a consistency check) and a genuinely new out-of-sample chunk
// (the first 180 days of this range, never tested before in this session).
// Usage: node run_backtest_v9_360d.js

const fs = require('fs');
const path = require('path');
const { buildAnalysis, buildAnalysisV9, gateEntries, simulateTrades, computeMetrics } = require('../../lib/strategy');
const { fetchKlinesPaged } = require('../../lib/binance');

async function loadCached(symbol, interval, startTime, endTime, cacheName) {
  const cachePath = path.join(__dirname, '..', 'results', cacheName);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.startTime === startTime && cached.endTime === endTime) {
      console.error(`Using cached ${interval}:`, cached.candles.length);
      return cached.candles;
    }
  }
  console.error(`Fetching ${interval} (this will take a few minutes for 1m)...`);
  const candles = await fetchKlinesPaged(symbol, interval, startTime, endTime, (n) => { if (n % 20 === 0) console.error(`${interval} batch ${n}`); });
  console.error(`${interval} candles:`, candles.length);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ startTime, endTime, candles }));
  return candles;
}

function reportWindow(label, trades, from, to) {
  const windowTrades = trades.filter(t => t.entryTime >= from && t.entryTime < to);
  const m = computeMetrics(windowTrades);
  if (!m) { console.log(`${label}: sin trades`); return; }
  console.log(`${label}: trades=${windowTrades.length} winRate=${m.winRate.toFixed(1)}% PF=${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} PnL=${m.totalPnl.toFixed(1)}% maxDD=${m.maxDD.toFixed(1)}%`);
}

(async function main() {
  try {
    const symbol = 'BTCUSDT';
    const endTime = Date.UTC(2026, 6, 15, 23, 59, 59); // Jul 15 2026
    const startTime = endTime - 360 * 24 * 3600 * 1000; // 360 days back

    const c1h = await loadCached(symbol, '1h', startTime, endTime, 'candles_1h_360d.json');
    const c1m = await loadCached(symbol, '1m', startTime, endTime, 'candles_1m_360d.json');

    const h1 = { length: 200, cooldownHours: 6 };
    const m1 = { length: 200, cooldownMinutes: 0 };
    const regimeAnalysis = buildAnalysis(c1h, 'single', h1, true, h1.cooldownHours * 3600000);

    const exitCfg = { activationPct: 1.33, trailPct: 0.25, srLookbackBars: 50, srTolerancePct: 0.15, srMinTouches: 4, atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05, minStopAtrMultiple: 2.5, leverage: 10 };

    // windows: full 360d, the already-tested 180d, the already-tested 60d
    // (May-Jun), and a fresh out-of-sample 180d chunk never tested before.
    const jan15 = Date.UTC(2026, 0, 15, 0, 0, 0);
    const may1 = Date.UTC(2026, 4, 1, 0, 0, 0);
    const jun30end = Date.UTC(2026, 5, 30, 23, 59, 59);
    const windows = [
      ['360d completo', startTime, endTime],
      ['180d ya testeado (15ene-15jul)', jan15, endTime],
      ['60d ya testeado (1may-30jun)', may1, jun30end],
      ['180d NUEVO fuera de muestra (inicio del rango-15ene)', startTime, jan15],
    ];

    console.log('\n=== PRODUCCION (MA200 + MACD zero filter) ===');
    const prodAnalysis = buildAnalysis(c1m, 'single', m1, true, m1.cooldownMinutes * 60000);
    const { entries: prodEntries } = gateEntries(c1m, prodAnalysis.signals, c1h, regimeAnalysis.regime, true);
    const { trades: prodTrades } = simulateTrades(c1m, c1h, prodEntries, exitCfg);
    for (const [label, from, to] of windows) reportWindow(label, prodTrades, from, to);

    console.log('\n=== V9 (RSI + alineacion MACD + buffer ATR + cooldown direccional) ===');
    const v9EntryCfg = { maLen: 200, cooldownHours: 4, useMacdZeroFilter: true, useMacdAlignFilter: true, useRsiFilter: true, useAtrBuffer: true, atrMult: 0.55 };
    const v9 = buildAnalysisV9(c1m, v9EntryCfg);
    const { entries: v9Entries } = gateEntries(c1m, v9.signals, c1h, regimeAnalysis.regime, true);
    const { trades: v9Trades } = simulateTrades(c1m, c1h, v9Entries, exitCfg);
    for (const [label, from, to] of windows) reportWindow(label, v9Trades, from, to);

    fs.writeFileSync(path.join(__dirname, '..', 'backtest_360d_comparison.json'),
      JSON.stringify({ startTime, endTime, prodTrades, v9Trades }, null, 2));
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
