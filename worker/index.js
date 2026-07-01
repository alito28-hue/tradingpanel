// Long-running bot process — deployed independently of Vercel (VPS/Railway/Fly.io),
// NOT as part of the Next.js app. Vercel serverless functions cannot hold this
// process's state (open positions) or run continuously.
//
// This is scaffolding only: it wires up the same signal logic used by the
// dashboard/backtest so live decisions match what you've already validated,
// but order execution goes through lib/bingx.js in DRY_RUN mode until that
// module implements real, reviewed order placement.

const { buildAnalysis, gateEntries } = require('../lib/strategy');
const { fetchKlines } = require('../lib/binance');
const { placeOrder, isDryRun } = require('../lib/bingx');

const SYMBOL = process.env.BOT_SYMBOL || 'BTCUSDT';
const POLL_MS = Number(process.env.BOT_POLL_MS || 60000);
const H1_CFG = { length: 200, cooldownHours: 6 };
const M1_CFG = { length: 200, cooldownMinutes: 0 };

let lastSignalIndex = -1;

async function tick() {
  const [candles1h, candles1m] = await Promise.all([
    fetchKlines(SYMBOL, '1h', 500),
    fetchKlines(SYMBOL, '1m', 500),
  ]);

  const analysis1h = buildAnalysis(candles1h, 'single', H1_CFG, true, H1_CFG.cooldownHours * 3600000);
  const analysis1m = buildAnalysis(candles1m, 'single', M1_CFG, true, M1_CFG.cooldownMinutes * 60000);
  const { entries } = gateEntries(candles1m, analysis1m.signals, candles1h, analysis1h.regime, true);

  const latest = entries[entries.length - 1];
  if (latest && latest.index !== lastSignalIndex) {
    lastSignalIndex = latest.index;
    console.log(`[${new Date().toISOString()}] new ${latest.type} signal on ${SYMBOL} at candle ${latest.index}`);
    await placeOrder({ symbol: SYMBOL, side: latest.type === 'long' ? 'BUY' : 'SELL' });
  }
}

async function main() {
  console.log(`Bot worker starting for ${SYMBOL} (poll every ${POLL_MS}ms, DRY_RUN=${isDryRun()})`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error('tick failed:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
