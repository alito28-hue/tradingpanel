// Long-running bot process — deployed independently of Vercel (VPS/Railway/Fly.io),
// NOT as part of the Next.js app. Vercel serverless functions cannot hold this
// process's state (open positions) or run continuously.
//
// Reuses the exact same buildAnalysis/gateEntries/simulateTrades already
// validated in the dashboard/backtest, so live decisions match what's on
// screen. DRY_RUN=true (the hard default in lib/bingx.js) logs every order
// instead of sending it — flipping to real money is a manual env var change
// on whatever host runs this, never something this code does on its own.
const path = require('path');
const { buildAnalysis, gateEntries, simulateTrades } = require('../lib/strategy');
const { fetchKlines } = require('../lib/binance');
const bingx = require('../lib/bingx');
const { sendMessage } = require('../lib/telegram');
const { checkStopDistance } = require('../lib/botSafety');
const { DailyLossTracker } = require('../lib/dailyLossTracker');

// BingX's swap API wants the hyphenated form ("BTC-USDT"); Binance's klines
// API (used only for market data/signals, never for orders) wants it
// concatenated ("BTCUSDT") — hence the .replace('-', '') on fetchKlines calls.
const SYMBOL = process.env.BOT_SYMBOL || 'BTC-USDT';
const ENTRY_INTERVAL = process.env.BOT_ENTRY_INTERVAL || '1m';
const POLL_MS = Number(process.env.BOT_POLL_MS || 20000);
const LEVERAGE = Number(process.env.BOT_LEVERAGE || 10);
const POSITION_SIZE_USD = Number(process.env.BOT_POSITION_SIZE_USD || 100);
const DAILY_LOSS_LIMIT_USD = Number(process.env.BOT_DAILY_LOSS_LIMIT_USD || 30);

const H1_CFG = { length: 200, cooldownHours: 6 };
const ENTRY_CFG = { length: 200, cooldownMinutes: 0 };
// Same exit parameters validated in the dashboard/backtest (SR+ATR trailing).
const EXIT_CFG = {
  activationPct: 1.33, trailPct: 0.25, srLookbackBars: 50, srTolerancePct: 0.15,
  srMinTouches: 4, atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05,
};

const dailyLoss = new DailyLossTracker(path.join(__dirname, 'daily_loss_state.json'), DAILY_LOSS_LIMIT_USD);

let lastConsideredEntryIndex = -1;
let position = { phase: 'idle' }; // idle | awaiting_entry_fill | in_position

function roundQty(qty) {
  return Math.round(qty * 1000) / 1000; // 3 decimals — refine per-symbol precision before scaling up
}

async function tryOpenPosition(candlesEntry, candles1h, entries) {
  const { openPosition } = simulateTrades(candlesEntry, candles1h, entries, EXIT_CFG);
  if (!openPosition || openPosition.entryIndex === lastConsideredEntryIndex) return;
  lastConsideredEntryIndex = openPosition.entryIndex;

  const check = checkStopDistance(openPosition.entryPrice, openPosition.stopPrice, LEVERAGE);
  if (!check.ok) {
    const msg = `⚠️ Señal ${openPosition.type.toUpperCase()} ${SYMBOL} rechazada: stop a ${check.stopDistPct.toFixed(2)}% supera el ${check.safeThresholdPct.toFixed(2)}% seguro para ${LEVERAGE}x.`;
    console.log(msg);
    await sendMessage(msg);
    return;
  }

  const side = openPosition.type === 'long' ? 'BUY' : 'SELL';
  const quantity = roundQty((POSITION_SIZE_USD * LEVERAGE) / openPosition.entryPrice);
  const order = await bingx.placeLimitEntry({ symbol: SYMBOL, side, quantity, price: openPosition.entryPrice });

  position = {
    phase: 'awaiting_entry_fill',
    type: openPosition.type,
    entryOrderId: order.orderId || order.order?.orderId || 'dry-run',
    entryPrice: openPosition.entryPrice,
    stopPrice: openPosition.stopPrice,
    quantity,
  };
  const msg = `🟢 Nueva entrada ${openPosition.type.toUpperCase()} ${SYMBOL} @ ${openPosition.entryPrice.toFixed(1)} (orden LIMIT, qty ${quantity})`;
  console.log(msg);
  await sendMessage(msg);
}

async function checkEntryFill() {
  if (bingx.isDryRun()) {
    // Nothing to poll for in dry-run — treat as immediately filled so the
    // rest of the lifecycle (exits, notifications) can still be exercised.
    await placeExits();
    return;
  }
  const order = await bingx.getOrder(SYMBOL, position.entryOrderId);
  if (order.status === 'FILLED') await placeExits();
}

async function placeExits() {
  const exitSide = position.type === 'long' ? 'SELL' : 'BUY';
  const activationPrice = position.type === 'long'
    ? position.entryPrice * (1 + EXIT_CFG.activationPct / 100)
    : position.entryPrice * (1 - EXIT_CFG.activationPct / 100);

  const stopOrder = await bingx.placeStopLoss({ symbol: SYMBOL, side: exitSide, quantity: position.quantity, stopPrice: position.stopPrice });
  const trailingOrder = await bingx.placeTrailingStop({
    symbol: SYMBOL, side: exitSide, quantity: position.quantity, activationPrice, trailPct: EXIT_CFG.trailPct,
  });

  position.phase = 'in_position';
  position.stopOrderId = stopOrder.orderId || stopOrder.order?.orderId || 'dry-run';
  position.trailingOrderId = trailingOrder.orderId || trailingOrder.order?.orderId || 'dry-run';

  const msg = `Entrada ${SYMBOL} llena @ ${position.entryPrice.toFixed(1)}. Exits: stop ${position.stopPrice.toFixed(1)}, trailing activa en ${activationPrice.toFixed(1)} (${EXIT_CFG.trailPct}% trail).`;
  console.log(msg);
  await sendMessage(msg);
}

async function checkExitFill() {
  if (bingx.isDryRun()) return; // nothing real to poll for in dry-run

  const [stopStatus, trailStatus] = await Promise.all([
    bingx.getOrder(SYMBOL, position.stopOrderId),
    bingx.getOrder(SYMBOL, position.trailingOrderId),
  ]);

  const filled = stopStatus.status === 'FILLED' ? stopStatus : (trailStatus.status === 'FILLED' ? trailStatus : null);
  if (!filled) return;

  const otherOrderId = filled === stopStatus ? position.trailingOrderId : position.stopOrderId;
  await bingx.cancelOrder(SYMBOL, otherOrderId).catch((err) => console.error('cancelOrder failed (may have already filled/expired):', err.message));

  const exitPrice = Number(filled.avgPrice || filled.price);
  const isLong = position.type === 'long';
  const pnlUsd = (isLong ? exitPrice - position.entryPrice : position.entryPrice - exitPrice) * position.quantity;
  dailyLoss.recordTrade(pnlUsd);

  const msg = `${pnlUsd >= 0 ? '✅' : '🔴'} Cerrado ${position.type.toUpperCase()} ${SYMBOL} @ ${exitPrice.toFixed(1)} · PnL ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} USD. PnL del día: ${dailyLoss.state.realizedPnlUsd.toFixed(2)} USD.`;
  console.log(msg);
  await sendMessage(msg);

  position = { phase: 'idle' };

  if (dailyLoss.isKilled()) {
    const killMsg = `🛑 Límite de pérdida diaria (-${DAILY_LOSS_LIMIT_USD} USD) alcanzado. El bot no abre posiciones nuevas hasta que lo reinicies.`;
    console.log(killMsg);
    await sendMessage(killMsg);
  }
}

async function tick() {
  if (dailyLoss.isKilled() && position.phase === 'idle') return;

  const [candles1h, candlesEntry] = await Promise.all([
    fetchKlines(SYMBOL.replace('-', ''), '1h', 500),
    fetchKlines(SYMBOL.replace('-', ''), ENTRY_INTERVAL, 500),
  ]);

  if (position.phase === 'in_position') {
    await checkExitFill();
  } else if (position.phase === 'awaiting_entry_fill') {
    await checkEntryFill();
  } else {
    // position.phase === 'idle': the single `position` variable is the whole
    // state machine, so MAX_OPEN_POSITIONS (1) is enforced by construction —
    // there's no code path that opens a second one while phase isn't 'idle'.
    const analysis1h = buildAnalysis(candles1h, 'single', H1_CFG, true, H1_CFG.cooldownHours * 3600000);
    const analysisEntry = buildAnalysis(candlesEntry, 'single', ENTRY_CFG, true, ENTRY_CFG.cooldownMinutes * 60000);
    const { entries } = gateEntries(candlesEntry, analysisEntry.signals, candles1h, analysis1h.regime, true);
    await tryOpenPosition(candlesEntry, candles1h, entries);
  }
}

async function main() {
  console.log(`Bot worker starting for ${SYMBOL} (poll ${POLL_MS}ms, leverage ${LEVERAGE}x, size $${POSITION_SIZE_USD}, daily loss limit $${DAILY_LOSS_LIMIT_USD}, DRY_RUN=${bingx.isDryRun()})`);
  await bingx.setLeverage(SYMBOL, 'LONG', LEVERAGE);
  await bingx.setLeverage(SYMBOL, 'SHORT', LEVERAGE);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error('tick failed:', err.message);
      await sendMessage(`⚠️ Error en el bot: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
