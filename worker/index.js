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
const http = require('http');
const { buildAnalysis, gateEntries, simulateTrades, stepExit } = require('../lib/strategy');
const { fetchKlines } = require('../lib/binance');
const bingx = require('../lib/bingx');
const { sendMessage } = require('../lib/telegram');
const { checkStopDistance } = require('../lib/botSafety');
const { DailyLossTracker } = require('../lib/dailyLossTracker');
const { ModeStore } = require('../lib/modeStore');

// Captured once, before anything mutates process.env.DRY_RUN (see
// applyEffectiveDryRun below) — this is the actual manual value Railway was
// started with, i.e. the hard safety floor. process.env.DRY_RUN itself gets
// overwritten at runtime as the *effective* (post-floor) value for
// lib/bingx.js to read, so it can no longer be trusted as "what Railway
// says" after the first tick — this constant is what floor checks must use.
const RAILWAY_DRY_RUN_FLOOR = process.env.DRY_RUN;

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
  srMinTouches: 4, atrLength: 14, atrMultiplier: 0.5, commissionPct: 0.05, minStopAtrMultiple: 2.5,
  leverage: LEVERAGE,
};

// Railway injects RAILWAY_VOLUME_MOUNT_PATH automatically once a Volume is
// attached to this service — without one (e.g. running locally), falls back
// to a file next to the script like before.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const dailyLoss = new DailyLossTracker(path.join(DATA_DIR, 'daily_loss_state.json'), DAILY_LOSS_LIMIT_USD);
const modeStore = new ModeStore(path.join(DATA_DIR, 'mode_state.json'));

const HEARTBEAT_MS = 5 * 60 * 1000; // 5 min — enough to confirm the loop is alive without spamming logs

let lastConsideredEntryTime = -1;
let position = { phase: 'idle' }; // idle | awaiting_entry_fill | in_position
let lastHeartbeat = 0;

function roundQty(qty) {
  return Math.round(qty * 1000) / 1000; // 3 decimals — refine per-symbol precision before scaling up
}

// Two-layer safety gate for real money, written as an explicit early return
// (not a compact boolean expression) so it can be audited at a glance:
//   1. Railway's own DRY_RUN env var is a hard floor. It must be manually
//      set to 'false' on the host — a deliberate, out-of-band step — before
//      live trading is even possible. This is the original safety guarantee
//      from before the dashboard had a login, and it still holds regardless
//      of anything the web UI does.
//   2. Only once that floor allows it does the web-toggled mode (persisted
//      in modeStore, itself defaulting to 'dry_run') get to decide.
// Sets process.env.DRY_RUN so the existing bingx.isDryRun() (which reads it
// fresh on every call) picks this up everywhere with no other code changes.
function applyEffectiveDryRun() {
  if (RAILWAY_DRY_RUN_FLOOR !== 'false') {
    process.env.DRY_RUN = 'true';
    return true;
  }
  const isDryRun = modeStore.getMode() !== 'live';
  process.env.DRY_RUN = isDryRun ? 'true' : 'false';
  return isDryRun;
}

// Status + control endpoint for the dashboard's /api/bot-history and
// /api/bot-mode routes to call — never called directly from the browser, so
// the shared secret never reaches client-side code. Only starts listening if
// PORT is set (Railway injects it once the service has public networking
// enabled); a worker without a public domain just skips this entirely.
function startServer() {
  const port = process.env.PORT;
  if (!port) {
    console.log('[server] PORT not set — skipping HTTP server (no public networking enabled).');
    return;
  }
  const secret = process.env.WORKER_API_SECRET;
  const server = http.createServer((req, res) => {
    if (!secret || req.headers['x-worker-secret'] !== secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/history') {
      // Reports the *effective* mode (post-floor), not just the stored
      // preference — otherwise the dashboard could show "LIVE" while the
      // Railway floor is silently keeping the worker in dry-run.
      const effectiveMode = applyEffectiveDryRun() ? 'dry_run' : 'live';
      // Same `position` object that drives the Telegram messages — the
      // dashboard reads this instead of re-simulating locally, so there's
      // one source of truth for "what is the bot actually doing" instead of
      // two independent guesses that can disagree.
      const publicPosition = position.phase === 'idle'
        ? { phase: 'idle' }
        : { phase: position.phase, type: position.type, entryPrice: position.entryPrice, stopPrice: position.stopPrice, entryTime: position.entryTime, quantity: position.quantity };
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ...dailyLoss.getHistory(), mode: effectiveMode, position: publicPosition }));
      return;
    }

    if (req.method === 'GET' && req.url === '/trades') {
      // Real (or DRY_RUN-simulated-with-real-prices) closed trades — what the
      // dashboard's Trade History table reads instead of re-simulating
      // locally in the browser.
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ trades: dailyLoss.getRecentTrades() }));
      return;
    }

    if (req.method === 'POST' && req.url === '/mode') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let requestedMode;
        try { requestedMode = JSON.parse(body).mode; } catch { /* falls through to validation below */ }
        if (requestedMode !== 'live' && requestedMode !== 'dry_run') {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'mode debe ser "live" o "dry_run"' }));
          return;
        }
        // Switching modes mid-position is exactly how a DRY_RUN position
        // (fake order IDs like 'dry-run') ends up being polled against
        // BingX's real order-status endpoint once LIVE — a guaranteed error
        // loop, since that ID was never a real order. Block the switch
        // entirely instead; the safe move is to wait for idle.
        if (position.phase !== 'idle') {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `No se puede cambiar de modo con una posición en curso (fase: ${position.phase}). Esperá a que se cierre.` }));
          return;
        }
        modeStore.setMode(requestedMode);
        const effectiveMode = applyEffectiveDryRun() ? 'dry_run' : 'live';
        const floorBlocked = requestedMode === 'live' && effectiveMode === 'dry_run';

        const msg = floorBlocked
          ? '⚠️ Se pidió pasar a LIVE desde el dashboard, pero Railway todavía tiene DRY_RUN=true — sigue en TEST. Cambiá esa variable a mano si realmente querés operar en real.'
          : (effectiveMode === 'live' ? '🔓 Modo cambiado a LIVE (dinero real) desde el dashboard.' : '🔒 Modo cambiado a TEST (DRY_RUN) desde el dashboard.');
        console.log(msg);
        await sendMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, mode: effectiveMode, floorBlocked }));
      });
      return;
    }

    res.writeHead(404).end();
  });
  server.listen(port, () => console.log(`[server] listening on ${port} (/history, /trades, /mode — requires X-Worker-Secret)`));
}

// Runs once at startup (real trading only — DRY_RUN has no real BingX state
// to recover, and querying it there could pick up unrelated manual activity
// on the account). BingX is the source of truth for what's actually open,
// not any local cache: a restart mid-position must never lead to opening a
// second one, and a position found with a missing stop/trailing order must
// never be left unprotected.
async function recoverState() {
  if (bingx.isDryRun()) return;

  const positions = await bingx.getPositions(SYMBOL);
  const openPos = (positions || []).find(p => Math.abs(Number(p.positionAmt || 0)) > 0);
  if (!openPos) {
    console.log('[recover] no open position on BingX — starting idle.');
    return;
  }

  const type = String(openPos.positionSide).toUpperCase() === 'SHORT' ? 'short' : 'long';
  const entryPrice = Number(openPos.avgPrice);
  const quantity = Math.abs(Number(openPos.positionAmt));
  const exitSide = type === 'long' ? 'SELL' : 'BUY';
  const bingxPositionSide = type === 'long' ? 'LONG' : 'SHORT';

  const openOrdersData = await bingx.getOpenOrders(SYMBOL);
  const openOrders = openOrdersData?.orders || [];
  let stopOrder = openOrders.find(o => o.type === 'STOP_MARKET' && (o.reduceOnly === true || o.reduceOnly === 'true'));
  let trailingOrder = openOrders.find(o => o.type === 'TRAILING_STOP_MARKET' && (o.reduceOnly === true || o.reduceOnly === 'true'));
  const reprotected = !stopOrder || !trailingOrder;

  position = { phase: 'in_position', type, entryPrice, quantity };

  // Missing protection is only expected if a restart landed mid-placeExits.
  // Re-derive a safe stop distance from the current leverage rather than
  // trying to recover the original SR+ATR level, which no longer exists.
  if (!stopOrder) {
    const safeStopPrice = type === 'long'
      ? entryPrice * (1 - checkStopDistance(entryPrice, entryPrice, LEVERAGE).safeThresholdPct / 100)
      : entryPrice * (1 + checkStopDistance(entryPrice, entryPrice, LEVERAGE).safeThresholdPct / 100);
    stopOrder = await bingx.placeStopLoss({ symbol: SYMBOL, side: exitSide, positionSide: bingxPositionSide, quantity, stopPrice: safeStopPrice });
    position.stopPrice = safeStopPrice;
  } else {
    position.stopPrice = Number(stopOrder.stopPrice);
  }
  position.stopOrderId = stopOrder.orderId;

  if (!trailingOrder) {
    const activationPrice = type === 'long'
      ? entryPrice * (1 + EXIT_CFG.activationPct / 100)
      : entryPrice * (1 - EXIT_CFG.activationPct / 100);
    trailingOrder = await bingx.placeTrailingStop({ symbol: SYMBOL, side: exitSide, positionSide: bingxPositionSide, quantity, activationPrice, trailPct: EXIT_CFG.trailPct });
  }
  position.trailingOrderId = trailingOrder.orderId;

  const msg = reprotected
    ? `🔄⚠️ Reinicio: encontré ${type.toUpperCase()} ${SYMBOL} abierta SIN protección completa — repuse la(s) orden(es) faltante(s). Revisar en BingX.`
    : `🔄 Reinicio: recuperé posición ${type.toUpperCase()} ${SYMBOL} @ ${entryPrice.toFixed(1)}, ya protegida (stop ${position.stopPrice.toFixed(1)}).`;
  console.log(msg);
  await sendMessage(msg);
}

async function tryOpenPosition(candlesEntry, candles1h, entries) {
  // EXIT_CFG.leverage is threaded into simulateTrades itself now (see
  // lib/strategy.js), so any candidate it returns has already passed the
  // same checkStopDistance() safety check — no separate post-hoc rejection
  // needed here anymore.
  const { openPosition } = simulateTrades(candlesEntry, candles1h, entries, EXIT_CFG);
  // entryTime (absolute) rather than entryIndex — candlesEntry is re-fetched
  // fresh every tick as "the latest 500 candles", so the same real signal
  // lands at a different array index each poll as the window slides. Tracking
  // by index meant the same signal (including a failed order placement) got
  // retried every single tick forever instead of being considered once.
  if (!openPosition || openPosition.entryTime === lastConsideredEntryTime) return;
  lastConsideredEntryTime = openPosition.entryTime;

  const side = openPosition.type === 'long' ? 'BUY' : 'SELL';
  const positionSide = openPosition.type === 'long' ? 'LONG' : 'SHORT';
  const quantity = roundQty((POSITION_SIZE_USD * LEVERAGE) / openPosition.entryPrice);
  const order = await bingx.placeLimitEntry({ symbol: SYMBOL, side, positionSide, quantity, price: openPosition.entryPrice });

  position = {
    phase: 'awaiting_entry_fill',
    type: openPosition.type,
    entryOrderId: order.orderId || order.order?.orderId || 'dry-run',
    entryPrice: openPosition.entryPrice,
    stopPrice: openPosition.stopPrice,
    quantity,
    entryTime: Date.now(),
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
  const positionSide = position.type === 'long' ? 'LONG' : 'SHORT';
  const activationPrice = position.type === 'long'
    ? position.entryPrice * (1 + EXIT_CFG.activationPct / 100)
    : position.entryPrice * (1 - EXIT_CFG.activationPct / 100);

  const stopOrder = await bingx.placeStopLoss({ symbol: SYMBOL, side: exitSide, positionSide, quantity: position.quantity, stopPrice: position.stopPrice });
  const trailingOrder = await bingx.placeTrailingStop({
    symbol: SYMBOL, side: exitSide, positionSide, quantity: position.quantity, activationPrice, trailPct: EXIT_CFG.trailPct,
  });

  position.phase = 'in_position';
  position.stopOrderId = stopOrder.orderId || stopOrder.order?.orderId || 'dry-run';
  position.trailingOrderId = trailingOrder.orderId || trailingOrder.order?.orderId || 'dry-run';
  // Same shape as a backtest `pos` object — stepExit() (lib/strategy.js)
  // needs these to simulate the exit against real candles in DRY_RUN.
  position.peak = position.entryPrice;
  position.activated = false;
  position.currentStop = position.stopPrice;
  position.lastCheckedTime = position.entryTime;

  const msg = `Entrada ${SYMBOL} llena @ ${position.entryPrice.toFixed(1)}. Exits: stop ${position.stopPrice.toFixed(1)}, trailing activa en ${activationPrice.toFixed(1)} (${EXIT_CFG.trailPct}% trail).`;
  console.log(msg);
  await sendMessage(msg);
}

// Shared by both the real-fill path and the DRY_RUN simulated-fill path —
// one place records the trade, notifies, and resets state, so those two
// paths can never quietly diverge in what they consider "closed".
async function closePosition(exitPrice, exitTime, reason) {
  const isLong = position.type === 'long';
  const pnlUsd = (isLong ? exitPrice - position.entryPrice : position.entryPrice - exitPrice) * position.quantity;
  const grossPnlPct = (isLong ? (exitPrice - position.entryPrice) / position.entryPrice : (position.entryPrice - exitPrice) / position.entryPrice) * 100;
  const netPnlPct = grossPnlPct - EXIT_CFG.commissionPct * 2;

  dailyLoss.recordTrade(pnlUsd, {
    entryTime: position.entryTime, exitTime, entryPrice: position.entryPrice, exitPrice,
    type: position.type, grossPnlPct, netPnlPct, reason, symbol: SYMBOL,
  });

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

async function checkExitFill(candlesEntry) {
  if (bingx.isDryRun()) {
    // No real order to poll — replay any candles that arrived since the last
    // check through the exact same stop/trailing math the backtest uses
    // (stepExit, lib/strategy.js), against real prices from Binance. This is
    // what makes DRY_RUN actually record a closed trade instead of never
    // detecting an exit at all.
    const newCandles = candlesEntry.filter(c => c.time > position.lastCheckedTime);
    for (const c of newCandles) {
      const result = stepExit(position, c, EXIT_CFG);
      position.lastCheckedTime = c.time;
      if (result) {
        await closePosition(result.exitPrice, c.time, result.reason);
        return;
      }
    }
    return;
  }

  const [stopStatus, trailStatus] = await Promise.all([
    bingx.getOrder(SYMBOL, position.stopOrderId),
    bingx.getOrder(SYMBOL, position.trailingOrderId),
  ]);

  const filled = stopStatus.status === 'FILLED' ? stopStatus : (trailStatus.status === 'FILLED' ? trailStatus : null);
  if (!filled) return;

  const otherOrderId = filled === stopStatus ? position.trailingOrderId : position.stopOrderId;
  await bingx.cancelOrder(SYMBOL, otherOrderId).catch((err) => console.error('cancelOrder failed (may have already filled/expired):', err.message));

  const exitPrice = Number(filled.avgPrice || filled.price);
  const reason = filled === stopStatus ? 'stop' : 'trailing';
  await closePosition(exitPrice, Date.now(), reason);
}

async function tick() {
  applyEffectiveDryRun(); // picks up a mode change made via POST /mode since the last tick

  const finishedDay = dailyLoss.checkRollover();
  if (finishedDay) {
    const msg = `📅 Resumen ${finishedDay.day}: ${finishedDay.trades} trade${finishedDay.trades === 1 ? '' : 's'}, ${finishedDay.winRate}% win rate, PnL ${finishedDay.realizedPnlUsd >= 0 ? '+' : ''}${finishedDay.realizedPnlUsd.toFixed(2)} USD.`;
    console.log(msg);
    await sendMessage(msg);
  }

  if (dailyLoss.isKilled() && position.phase === 'idle') return;

  const [candles1h, candlesEntry] = await Promise.all([
    fetchKlines(SYMBOL.replace('-', ''), '1h', 500),
    fetchKlines(SYMBOL.replace('-', ''), ENTRY_INTERVAL, 500),
  ]);

  if (position.phase === 'in_position') {
    await checkExitFill(candlesEntry);
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

  if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = Date.now();
    console.log(`[heartbeat] alive · phase=${position.phase} · daily PnL ${dailyLoss.state.realizedPnlUsd.toFixed(2)} USD`);
  }
}

async function main() {
  const startedDryRun = applyEffectiveDryRun(); // resolved before anything below reads bingx.isDryRun()
  console.log(`Bot worker starting for ${SYMBOL} (poll ${POLL_MS}ms, leverage ${LEVERAGE}x, size $${POSITION_SIZE_USD}, daily loss limit $${DAILY_LOSS_LIMIT_USD}, DRY_RUN=${bingx.isDryRun()})`);
  // A restart that resumes straight into live trading (Railway floor=false,
  // stored mode=live) must never be silent — that's exactly the scenario
  // recoverState() below exists to handle safely.
  await sendMessage(startedDryRun ? '🔒 Worker arrancó en modo TEST (DRY_RUN).' : '🔓 Worker arrancó en modo LIVE (dinero real).');
  await bingx.setLeverage(SYMBOL, 'LONG', LEVERAGE);
  await bingx.setLeverage(SYMBOL, 'SHORT', LEVERAGE);
  await recoverState();
  startServer();
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
