// "Saylor" strategy loop — BTC-only, long-only martingale/grid (see
// lib/saylorRules.js for the rule table and its source). Selected by
// worker/index.js when STRATEGY_MODE=saylor; worker/runSignal.js is the
// other, unrelated candle-signal strategy — a bug here structurally cannot
// reach that file's state, they don't share anything except lib/bingx.js
// and lib/workerRuntime.js.
//
// Shape is fundamentally different from runSignal.js: this doesn't analyze
// candles at all. It polls the position's LIVE floating ROI% from BingX
// every tick and reacts to which ROI band that falls in. BingX itself is
// the source of truth for quantity/avg price/PnL — this file's own
// persisted state (saylor_state.json) only tracks what runSignal.js's
// dailyLossTracker/checkStopDistance CAN'T give us: which cargador/bala
// tranches we've already committed and which bands have already fired.
//
// By explicit design (and explicit user instruction) this strategy has NO
// stop-loss and does NOT use lib/dailyLossTracker.js at all — daily-realized
// loss limits are a rule of the OTHER strategy and don't apply here. The
// only guardrails are the bala/cargador caps inside lib/saylorRules.js and
// the circuit breaker below (SAYLOR_CIRCUIT_BREAKER_PCT) — not part of the
// original "Reglas Michael Saylor" rule sheet, added here as a defensive
// floor since the original rules never stop adding to a losing position.
//
// Every order this file places is a LIMIT order priced close to the current
// mark price (see lib/saylorRules.js's computeLimitPrice) — never MARKET,
// by explicit instruction, even for the take-profit/circuit-breaker exits.
const path = require('path');
const http = require('http');
const bingx = require('../lib/bingx');
const { sendMessage } = require('../lib/telegram');
const rules = require('../lib/saylorRules');
const { SaylorStateStore } = require('../lib/saylorStateStore');
const { ModeStore } = require('../lib/modeStore');
const { resolveDataDir, roundQty, makeDryRunGate } = require('../lib/workerRuntime');

const SYMBOL = process.env.SAYLOR_SYMBOL || 'BTC-USDT';
const POSITION_SIDE = 'LONG'; // long-only, by rule — never SHORT
const POLL_MS = Number(process.env.SAYLOR_POLL_MS || process.env.BOT_POLL_MS || 20000);
const cfg = rules.getConfig();

const DATA_DIR = resolveDataDir(__dirname);
// Deliberately its own file, separate from runSignal.js's mode_state.json —
// these are two independent bots; Saylor's live/dry-run toggle must not
// inherit whatever the other strategy was last set to.
const stateStore = new SaylorStateStore(path.join(DATA_DIR, 'saylor_state.json'));
const modeStore = new ModeStore(path.join(DATA_DIR, 'saylor_mode_state.json'));
const applyEffectiveDryRun = makeDryRunGate(modeStore);

const HEARTBEAT_MS = 5 * 60 * 1000;
let lastHeartbeat = 0;
let lastDigestDay = null; // 'YYYY-MM-DD' — one Telegram summary per calendar day, not per tick

function fmtUsd(n) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

// getPositionRoiPct() reads BingX's REAL position, which in DRY_RUN never
// exists (orders are logged, never sent) — so live mode and dry-run mode
// need two different sources of truth for "what's the floating ROI%":
//   - live: BingX's own position (authoritative, corrects any local drift).
//   - dry-run: simulated locally from avgEntryPrice/totalQuantity (updated
//     in applyAction as each dry-run "fill" is logged) against a REAL
//     current mark price (bingx.getPrice — read-only, works with zero
//     BingX credentials risk regardless of DRY_RUN).
// Without this split, dry-run could never simulate a full cycle: every tick
// would see "no real position" and immediately treat it as a desync.
function simulatedRoi(state, markPrice, cfg) {
  if (!state.totalQuantity) return null;
  const marginUsd = rules.totalBalasUsed(state) * rules.balaMarginUsd(cfg);
  const unrealizedProfitUsd = (markPrice - state.avgEntryPrice) * state.totalQuantity;
  return {
    roiPct: (unrealizedProfitUsd / marginUsd) * 100, unrealizedProfitUsd, marginUsd,
    markPrice, avgPrice: state.avgEntryPrice, positionAmt: state.totalQuantity,
  };
}

async function getEffectiveRoi(state) {
  if (bingx.isDryRun()) {
    const priceData = await bingx.getPrice(SYMBOL);
    return simulatedRoi(state, Number(priceData.data.price), cfg);
  }
  return bingx.getPositionRoiPct({ symbol: SYMBOL, positionSide: POSITION_SIDE });
}

// Weighted-average fill update, called after every add_to_position (dry-run
// "fill" or an optimistic live estimate — see the module-level comment on
// why live decisions still prefer BingX's own numbers over this).
function recordFill(state, price, quantity) {
  const newQty = (state.totalQuantity || 0) + quantity;
  const newAvg = ((state.avgEntryPrice || price) * (state.totalQuantity || 0) + price * quantity) / newQty;
  stateStore.update({ avgEntryPrice: newAvg, totalQuantity: newQty });
}

// Runs once at startup, real trading only (mirrors runSignal.js's
// recoverState — DRY_RUN has no real BingX state to recover). This does NOT
// try to reconstruct which bala tranches were already committed from BingX
// alone (impossible — BingX only reports the position's current totals, not
// its history) — it only checks that local state and BingX AGREE that a
// position exists or doesn't. Any mismatch means a human touched BingX
// directly (or this process lost its state file) and gets a loud alert
// instead of a silent guess.
async function recoverState() {
  if (bingx.isDryRun()) return;

  const roi = await bingx.getPositionRoiPct({ symbol: SYMBOL, positionSide: POSITION_SIDE });
  const state = stateStore.get();
  const localThinksOpen = state.phase === 'in_position' || state.phase === 'awaiting_entry_fill';

  if (roi && !localThinksOpen) {
    const msg = `⚠️ [Saylor] Reinicio: BingX tiene una posición LONG ${SYMBOL} abierta (ROI ${fmtUsd(roi.roiPct)}%) que este proceso no tiene registrada (fase local: ${state.phase}). NO la voy a tocar automáticamente — revisá BingX y, si es del bot, arrancá el estado a mano antes de dejarlo operar solo.`;
    console.log(msg);
    await sendMessage(msg);
    return;
  }
  if (!roi && localThinksOpen) {
    const msg = `⚠️ [Saylor] Reinicio: el estado local decía que había una posición en curso, pero BingX no tiene ninguna LONG ${SYMBOL} abierta — se cerró (o se tocó) fuera de este proceso. Vuelvo a idle.`;
    console.log(msg);
    await sendMessage(msg);
    stateStore.reset();
    return;
  }
  if (roi && localThinksOpen) {
    console.log(`[Saylor recover] posición confirmada: ROI ${fmtUsd(roi.roiPct)}%, ${state.cargadores.length} cargador(es), ${rules.totalBalasUsed(state)} balas usadas.`);
  } else {
    console.log('[Saylor recover] sin posición abierta — idle, esperando /saylor/start.');
  }
}

// Places one decided action against BingX and reflects it into the state
// store — the caller (tick()) supplies the price to trade at (a fresh mark
// price read once per tick, not per action, so several actions in the same
// tick quote off the same reference).
async function applyAction(action, markPrice) {
  const state = stateStore.get();

  if (action.type === 'add_to_position') {
    const price = rules.computeLimitPrice(markPrice, 'buy', cfg);
    const quantity = roundQty(action.notionalUsd / price);
    await bingx.placeLimitEntry({ symbol: SYMBOL, side: 'BUY', positionSide: POSITION_SIDE, quantity, price });
    recordFill(state, price, quantity);
    const msg = `🔫 [Saylor] Recarga a POSICIÓN: +${action.balas} bala(s) (${action.band}) · $${action.marginUsd.toFixed(2)} margen / $${action.notionalUsd.toFixed(2)} nocional · ROI ${fmtUsd(action.roiPct)}% · limit @ ${price.toFixed(1)}${action.insufficient ? ' ⚠️ pedido parcial: se agotó el capital disponible (2 cargadores).' : ''}`;
    console.log(msg);
    await sendMessage(msg);
    return;
  }

  if (action.type === 'add_margin') {
    await bingx.addIsolatedMargin({ symbol: SYMBOL, positionSide: POSITION_SIDE, amount: action.marginUsd });
    const msg = `🛡️ [Saylor] Recarga a MARGEN: +${action.balas} bala(s) (${action.band}) · $${action.marginUsd.toFixed(2)} agregados como margen aislado (no suma tamaño) · ROI ${fmtUsd(action.roiPct)}%${action.insufficient ? ' ⚠️ pedido parcial: se agotó el capital disponible.' : ''}`;
    console.log(msg);
    await sendMessage(msg);
    return;
  }

  if (action.type === 'insufficient_capital') {
    const msg = `⚠️ [Saylor] La banda "${action.band}" (ROI ${fmtUsd(action.roiPct)}%) pedía ${action.balasRequested} bala(s), pero ya no queda capital disponible (2 cargadores agotados). No se agregó nada.`;
    console.log(msg);
    await sendMessage(msg);
    return;
  }

  if (action.type === 'early_warning') {
    const msg = `🟠 [Saylor] Aviso temprano: ROI en ${fmtUsd(action.roiPct)}% (circuit breaker en ${cfg.circuitBreakerPct}%). Revisar.`;
    console.log(msg);
    await sendMessage(msg);
    return;
  }

  if (action.type === 'take_profit' || action.type === 'circuit_breaker') {
    const roi = await getEffectiveRoi(state);
    if (!roi) {
      console.log(`[Saylor] ${action.type}: no hay posición para cerrar (¿ya se cerró?). Reseteando a idle.`);
      stateStore.closeCycle({ reason: action.type, note: 'no position found at close time', roiPct: action.roiPct });
      return;
    }
    const quantity = Math.abs(roi.positionAmt);
    const price = rules.computeLimitPrice(markPrice, 'sell', cfg);
    await bingx.placeLimitExit({ symbol: SYMBOL, side: 'SELL', positionSide: POSITION_SIDE, quantity, price });

    const isTP = action.type === 'take_profit';
    const msg = isTP
      ? `✅ [Saylor] TAKE PROFIT: cerrando posición completa (${quantity} ${SYMBOL}) @ ~${price.toFixed(1)} · ROI ${fmtUsd(roi.roiPct)}% · PnL flotante ${fmtUsd(roi.unrealizedProfitUsd)} USD.`
      : `🛑 [Saylor] CIRCUIT BREAKER (${cfg.circuitBreakerPct}%): cerrando posición completa (${quantity} ${SYMBOL}) @ ~${price.toFixed(1)} · ROI ${fmtUsd(roi.roiPct)}% · PnL flotante ${fmtUsd(roi.unrealizedProfitUsd)} USD. Requiere reset manual (POST /saylor/reset-circuit-breaker) antes de volver a operar.`;
    console.log(msg);
    await sendMessage(msg);

    stateStore.closeCycle({
      reason: action.type, roiPct: roi.roiPct, unrealizedProfitUsd: roi.unrealizedProfitUsd,
      avgEntryPrice: roi.avgPrice, exitPriceApprox: price, quantity,
      cargadores: state.cargadores, balasUsed: rules.totalBalasUsed(state),
    });
    if (!isTP) {
      // closeCycle() already reset to idle — force the halted flag back on
      // top so tick() refuses to auto-resume; only the admin endpoint clears it.
      stateStore.update({ phase: 'halted_circuit_breaker', circuitBreakerTripped: true });
    }
  }
}

// One Telegram summary per calendar day while a cycle is open — separate
// from the per-action alerts (each tranche add/exit already notifies on its
// own). liquidationPrice comes straight from BingX in LIVE (authoritative);
// in DRY_RUN there's no real position to read it from, so it's estimated
// (see lib/saylorRules.js's estimateLiquidationPrice) and labeled as such.
async function sendDailyDigest(state, roi) {
  const notionalUsd = roi.avgPrice * Math.abs(roi.positionAmt);
  const liq = roi.liquidationPrice != null
    ? { value: roi.liquidationPrice, estimated: false }
    : { value: rules.estimateLiquidationPrice(roi.avgPrice, roi.marginUsd, notionalUsd), estimated: true };

  const cs = rules.cargadorStatus(state, cfg);
  const balasLine = cs.reservaAbierta
    ? `Balas restantes: ${cs.restantesActivo} de ${cfg.balasPerCargador} (cargador ${cs.cargadorActivo}, de reserva)`
    : `Balas restantes: ${cs.restantesActivo} de ${cfg.balasPerCargador} (cargador 1)${cs.reservaDisponible ? ' · cargador 2 de emergencia todavía sin abrir' : ''}`;

  const msg = [
    '📊 [Saylor] Resumen diario',
    `Posición total: ${Math.abs(roi.positionAmt)} ${SYMBOL} (~$${notionalUsd.toFixed(2)} nocional, $${roi.marginUsd.toFixed(2)} margen)`,
    `PnL flotante: ${fmtUsd(roi.unrealizedProfitUsd)} USD (ROI ${fmtUsd(roi.roiPct)}%)`,
    `Precio actual: ${roi.markPrice.toFixed(1)}`,
    `Precio de liquidación${liq.estimated ? ' (estimado)' : ''}: ${liq.value != null ? liq.value.toFixed(1) : '—'}`,
    balasLine,
  ].join('\n');
  console.log(msg.replace(/\n/g, ' · '));
  await sendMessage(msg);
}

async function tick() {
  applyEffectiveDryRun();
  const state = stateStore.get();

  if (state.phase === 'halted_circuit_breaker') return; // needs POST /saylor/reset-circuit-breaker
  if (state.phase === 'idle') return; // needs POST /saylor/start — no auto re-entry, by design

  const roi = await getEffectiveRoi(state);
  if (!roi) {
    // In DRY_RUN this just means /saylor/start hasn't run yet in this
    // process's lifetime (totalQuantity still 0) — nothing to alert about,
    // the phase itself already guards against that (only reached when
    // phase is in_position, which /saylor/start always sets together with
    // totalQuantity). In LIVE this is a real desync: BingX shows no
    // position while local state thinks one's open.
    if (bingx.isDryRun()) return;
    const msg = `⚠️ [Saylor] Fase local "in_position" pero BingX no reporta ninguna posición LONG ${SYMBOL} abierta — se cerró fuera de este proceso. Volviendo a idle sin registrar ciclo (no hay datos de cierre reales para guardar).`;
    console.log(msg);
    await sendMessage(msg);
    stateStore.reset();
    return;
  }

  // computeNextAction mutates a plain working copy of the persisted state
  // (band-fired flags, cargadores) — commit it back only after a successful
  // tick, same "decide, then persist" split as lib/strategy.js's
  // simulateTrades/worker's own state var.
  const working = JSON.parse(JSON.stringify(state));
  const { actions } = rules.computeNextAction(working, roi.roiPct, cfg);
  stateStore.update(working);

  for (const action of actions) {
    await applyAction(action, roi.markPrice);
  }

  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastDigestDay && stateStore.get().phase === 'in_position') {
    lastDigestDay = today;
    // Re-read ROI fresh rather than reusing the pre-actions `roi` above — a
    // take-profit/add this same tick would make that snapshot stale.
    const freshRoi = await getEffectiveRoi(stateStore.get());
    if (freshRoi) await sendDailyDigest(stateStore.get(), freshRoi);
  }

  if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = Date.now();
    console.log(`[Saylor heartbeat] alive · phase=${stateStore.get().phase} · ROI ${fmtUsd(roi.roiPct)}% · balas ${rules.totalBalasUsed(stateStore.get())}`);
  }
}

function startServer() {
  const port = process.env.PORT;
  if (!port) {
    console.log('[Saylor server] PORT not set — skipping HTTP server.');
    return;
  }
  const secret = process.env.WORKER_API_SECRET;
  const server = http.createServer((req, res) => {
    if (!secret || req.headers['x-worker-secret'] !== secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/history') {
      const effectiveMode = applyEffectiveDryRun() ? 'dry_run' : 'live';
      const state = stateStore.get();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        mode: effectiveMode, position: state, cycles: stateStore.getHistory(),
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/trades') {
      // "Trades" here = closed Saylor cycles (open→take-profit/circuit-breaker),
      // not individual tranche adds — kept for rough shape-compatibility with
      // the signal strategy's /trades, but the dashboard's Trade History table
      // (built for that other shape) needs its own updates to render this well.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ trades: stateStore.getHistory() }));
      return;
    }

    if (req.method === 'POST' && req.url === '/mode') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let requestedMode;
        try { requestedMode = JSON.parse(body).mode; } catch { /* falls through */ }
        if (requestedMode !== 'live' && requestedMode !== 'dry_run') {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'mode debe ser "live" o "dry_run"' }));
          return;
        }
        if (stateStore.get().phase !== 'idle') {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `No se puede cambiar de modo con un ciclo en curso (fase: ${stateStore.get().phase}).` }));
          return;
        }
        modeStore.setMode(requestedMode);
        const effectiveMode = applyEffectiveDryRun() ? 'dry_run' : 'live';
        const floorBlocked = requestedMode === 'live' && effectiveMode === 'dry_run';
        const msg = floorBlocked
          ? '⚠️ [Saylor] Se pidió LIVE pero Railway sigue con DRY_RUN=true — sigue en TEST.'
          : (effectiveMode === 'live' ? '🔓 [Saylor] Modo cambiado a LIVE (dinero real).' : '🔒 [Saylor] Modo cambiado a TEST (DRY_RUN).');
        console.log(msg);
        await sendMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, mode: effectiveMode, floorBlocked }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/saylor/start') {
      (async () => {
        const state = stateStore.get();
        if (state.phase !== 'idle') {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Ya hay un ciclo en curso (fase: ${state.phase}).` }));
          return;
        }
        try {
          await bingx.setMarginMode({ symbol: SYMBOL, marginType: 'ISOLATED' }).catch(err =>
            console.log('[Saylor] setMarginMode falló (probablemente ya estaba en ISOLATED):', err.message));
          const priceData = await bingx.getPrice(SYMBOL);
          const markPrice = Number(priceData.data.price); // getPrice() returns BingX's raw {code,msg,data:{price,...}} envelope
          const initial = rules.initialState(cfg);
          const { notionalUsd } = rules.balasToUsd(cfg, cfg.inicioBalas);
          const price = rules.computeLimitPrice(markPrice, 'buy', cfg);
          const quantity = roundQty(notionalUsd / price);
          await bingx.placeLimitEntry({ symbol: SYMBOL, side: 'BUY', positionSide: POSITION_SIDE, quantity, price });
          stateStore.update({ ...initial, avgEntryPrice: price, totalQuantity: quantity, openedAt: Date.now() });

          const msg = `🚀 [Saylor] Ciclo iniciado: Inicio ${cfg.inicioBalas} balas · $${notionalUsd.toFixed(2)} nocional · limit @ ${price.toFixed(1)}.`;
          console.log(msg);
          await sendMessage(msg);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, state: stateStore.get() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    if (req.method === 'POST' && req.url === '/saylor/reset-circuit-breaker') {
      (async () => {
        const state = stateStore.get();
        if (state.phase !== 'halted_circuit_breaker') {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'El circuit breaker no está activo.' }));
          return;
        }
        stateStore.reset();
        const msg = '🔧 [Saylor] Circuit breaker reseteado a mano — vuelve a esperar /saylor/start.';
        console.log(msg);
        await sendMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      })();
      return;
    }

    if (req.method === 'POST' && req.url === '/admin/clear-history') {
      stateStore.clearAll();
      console.log('[Saylor admin] historial de ciclos borrado via /admin/clear-history');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404).end();
  });
  server.listen(port, () => console.log(`[Saylor server] listening on ${port} (/history, /trades, /mode, /saylor/start, /saylor/reset-circuit-breaker, /admin/clear-history — requires X-Worker-Secret)`));
}

async function main() {
  const startedDryRun = applyEffectiveDryRun();
  console.log(`Saylor worker starting for ${SYMBOL} (poll ${POLL_MS}ms, leverage ${cfg.leverage}x, capital $${cfg.capitalUsd}, bala $${rules.balaMarginUsd(cfg).toFixed(2)} margen / $${rules.balaNotionalUsd(cfg).toFixed(2)} nocional, TP ${cfg.takeProfitPct}%, circuit breaker ${cfg.circuitBreakerPct}%, DRY_RUN=${bingx.isDryRun()})`);
  await sendMessage(startedDryRun
    ? '🔒 [Saylor] Worker arrancó en modo TEST (DRY_RUN). Esperando POST /saylor/start para abrir un ciclo.'
    : '🔓 [Saylor] Worker arrancó en modo LIVE (dinero real). Esperando POST /saylor/start para abrir un ciclo.');

  try {
    await bingx.setLeverage(SYMBOL, POSITION_SIDE, cfg.leverage);
    await recoverState();
  } catch (err) {
    console.error('[Saylor] startup failed:', err.message);
    stateStore.update({ phase: 'halted_circuit_breaker', circuitBreakerTripped: true }); // safest halted state: refuses to auto-resume, needs manual reset
    await sendMessage(`🛑 [Saylor] Error crítico al arrancar: ${err.message}. Revisá BingX a mano antes de resetear (POST /saylor/reset-circuit-breaker).`);
  }

  startServer();
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error('[Saylor] tick failed:', err.message);
      await sendMessage(`⚠️ [Saylor] Error en el bot: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main();
