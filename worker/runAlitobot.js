// "AlitoBot" strategy loop — BTC-only, long-only martingale/grid (see
// lib/alitobotRules.js for the rule table and its source). Selected by
// worker/index.js when STRATEGY_MODE=alitobot; worker/runSignal.js is the
// other, unrelated candle-signal strategy — a bug here structurally cannot
// reach that file's state, they don't share anything except lib/bingx.js
// and lib/workerRuntime.js.
//
// Shape is fundamentally different from runSignal.js: this doesn't analyze
// candles at all. It polls the position's LIVE floating ROI% from BingX
// every tick, but reacts to it on two different cadences:
//   - EVERY tick: take-profit / circuit-breaker / early-warning — these are
//     risk-reducing, so they must never wait.
//   - At most ONCE PER CALENDAR DAY: the actual bala tranches (regular
//     bands + crítica + terminal) — checking every 20s reacted to normal
//     price noise (e.g. a -0.15% wobble) as if it were a real drawdown; the
//     rule table is meant to be read once a day, not continuously.
//
// This file's own persisted state (alitobot_state.json) only tracks what
// BingX itself has no concept of: which cargador/bala tranches we've
// already committed and which calendar day the last daily check ran.
//
// By explicit design (and explicit user instruction) this strategy has NO
// stop-loss and does NOT use lib/dailyLossTracker.js at all — daily-realized
// loss limits are a rule of the OTHER strategy and don't apply here. The
// only guardrails are the bala/cargador caps inside lib/alitobotRules.js and
// the circuit breaker below (ALITOBOT_CIRCUIT_BREAKER_PCT) — not part of the
// original "Reglas Michael Saylor" rule sheet, added here as a defensive
// floor since the original rules never stop adding to a losing position.
//
// Every order this file places is a LIMIT order priced close to the current
// mark price (see lib/alitobotRules.js's computeLimitPrice) — never MARKET,
// by explicit instruction, even for the take-profit/circuit-breaker exits.
const path = require('path');
const http = require('http');
const bingx = require('../lib/bingx');
const { sendMessage } = require('../lib/telegram');
const rules = require('../lib/alitobotRules');
const { AlitobotStateStore } = require('../lib/alitobotStateStore');
const { ModeStore } = require('../lib/modeStore');
const { resolveDataDir, roundQty, makeDryRunGate } = require('../lib/workerRuntime');

const SYMBOL = process.env.ALITOBOT_SYMBOL || 'BTC-USDT';
const POSITION_SIDE = 'LONG'; // long-only, by rule — never SHORT
const POLL_MS = Number(process.env.ALITOBOT_POLL_MS || process.env.BOT_POLL_MS || 20000);
// Mutable (not const): leverage can be overridden per cycle from the panel's
// "Arrancar ciclo" confirmation (see POST /alitobot/start below) — every
// other function in this file reads `cfg` through closure, so reassigning
// it here before opening a cycle is enough for the whole process to pick up
// the new leverage (bala size math, logging, etc.) without threading a
// per-call parameter through everything. Safe because only one cycle can be
// open at a time — there's no "two leverages active at once" case to get
// wrong.
let cfg = rules.getConfig();

const DATA_DIR = resolveDataDir(__dirname);
// Deliberately its own file, separate from runSignal.js's mode_state.json —
// these are two independent bots; AlitoBot's live/dry-run toggle must not
// inherit whatever the other strategy was last set to.
const stateStore = new AlitobotStateStore(path.join(DATA_DIR, 'alitobot_state.json'));
const modeStore = new ModeStore(path.join(DATA_DIR, 'alitobot_mode_state.json'));
const applyEffectiveDryRun = makeDryRunGate(modeStore);

const HEARTBEAT_MS = 5 * 60 * 1000;
let lastHeartbeat = 0;
let lastDigestDay = null; // 'YYYY-MM-DD' — one Telegram summary per calendar day, not per tick

function fmtUsd(n) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

// Signed money with the $ before the digits: -$30.43 / +$12.00.
function fmtMoney(n) {
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
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
    return simulatedRoi(state, Number(priceData.data.price), cfg); // getPrice() returns BingX's raw {code,msg,data:{price,...}} envelope
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

// Real trading costs since the cycle opened — only available once real
// orders have actually filled (LIVE, with a real BingX income history).
// DRY_RUN never has real fills, so there's nothing to fetch: commission/
// realized stay null, and buildSnapshot() below falls back to
// lib/alitobotRules.js's fee-rate estimate for the breakeven price.
async function getCosts(state) {
  if (bingx.isDryRun() || !state.openedAt) return { commissionUsd: null, realizedUsd: null };
  try {
    const income = await bingx.getIncomeHistory({ symbol: SYMBOL, startTime: state.openedAt });
    const rows = income || [];
    const commissionUsd = rows.filter(r => r.incomeType === 'COMMISSION').reduce((s, r) => s + Math.abs(Number(r.income || 0)), 0);
    // Everything BingX charged/paid since open (commission + funding + any
    // realized PnL) — signed, as BingX reports it (a cost is negative).
    const realizedUsd = rows.reduce((s, r) => s + Number(r.income || 0), 0);
    return { commissionUsd, realizedUsd };
  } catch (err) {
    console.error('[AlitoBot] no se pudo leer comisiones/income:', err.message);
    return { commissionUsd: null, realizedUsd: null };
  }
}

// Everything the panel/digest need to show about the open position in one
// place, so the two call sites (sendDailyDigest, GET /history) can't drift.
// liquidationPrice/breakevenPrice come straight from BingX/its real fee
// history in LIVE (authoritative); in DRY_RUN there's nothing real to read,
// so both fall back to estimates (see lib/alitobotRules.js) and are labeled
// as such.
async function buildSnapshot(state, roi) {
  const notionalUsd = roi.avgPrice * Math.abs(roi.positionAmt);
  const liq = roi.liquidationPrice != null
    ? { value: roi.liquidationPrice, estimated: false }
    : { value: rules.estimateLiquidationPrice(roi.avgPrice, roi.marginUsd, notionalUsd), estimated: true };

  const { commissionUsd, realizedUsd } = await getCosts(state);
  // realizedUsd is signed (a cost comes through negative) — breakeven is the
  // price at which unrealized gain exactly offsets that cost.
  const breakeven = realizedUsd != null
    ? { value: roi.avgPrice - realizedUsd / Math.abs(roi.positionAmt), estimated: false }
    : { value: rules.estimateBreakevenPrice(roi.avgPrice, cfg), estimated: true };
  const pnlNetoUsd = roi.unrealizedProfitUsd + (realizedUsd || 0);

  return {
    roiPct: roi.roiPct, unrealizedProfitUsd: roi.unrealizedProfitUsd, markPrice: roi.markPrice,
    marginUsd: roi.marginUsd, notionalUsd, positionAmt: roi.positionAmt, avgEntryPrice: roi.avgPrice,
    liquidationPrice: liq.value, liquidationEstimated: liq.estimated,
    breakevenPrice: breakeven.value, breakevenEstimated: breakeven.estimated,
    commissionUsd, realizedUsd, pnlNetoUsd,
    cargador: rules.cargadorStatus(state, cfg),
  };
}

// One Telegram summary per calendar day while a cycle is open — separate
// from the per-action alerts (each tranche add/exit already notifies on its
// own).
async function sendDailyDigest(state, roi) {
  const snap = await buildSnapshot(state, roi);
  const cs = snap.cargador;
  const balasLine = cs.reservaAbierta
    ? `Balas restantes: ${cs.restantesActivo} de ${cfg.balasPerCargador} (cargador ${cs.cargadorActivo}, de reserva)`
    : `Balas restantes: ${cs.restantesActivo} de ${cfg.balasPerCargador} (cargador 1)${cs.reservaDisponible ? ' · cargador 2 de emergencia todavía sin abrir' : ''}`;

  // Built as Telegram HTML (see lib/telegram.js's parseMode) — one datum per
  // line, position/prices/margin in bold. Every interpolated value here is
  // a number or one of our own fixed strings, never free text, so there's
  // nothing that needs HTML-escaping.
  const msg = [
    '📊 <b>[AlitoBot] Resumen diario</b>',
    `Posición total: <b>$${snap.notionalUsd.toFixed(2)} USDT</b> nocional (${Math.abs(snap.positionAmt)} BTC)`,
    `Margen: <b>$${snap.marginUsd.toFixed(2)}</b>`,
    `Entrada prom.: <b>$${snap.avgEntryPrice.toFixed(1)}</b>`,
    `Precio de equilibrio${snap.breakevenEstimated ? ' (estimado)' : ''}: <b>${snap.breakevenPrice != null ? `$${snap.breakevenPrice.toFixed(1)}` : '—'}</b>`,
    `PnL flotante: ${fmtMoney(snap.unrealizedProfitUsd)} (ROI ${fmtUsd(snap.roiPct)}%)`,
    `Comisiones pagadas: ${snap.commissionUsd != null ? `$${snap.commissionUsd.toFixed(2)}` : '— (sin fills reales, DRY_RUN)'}`,
    `PNL NETO: ${fmtMoney(snap.pnlNetoUsd)}`,
    `Precio actual: <b>$${snap.markPrice.toFixed(1)}</b>`,
    `Precio de liquidación${snap.liquidationEstimated ? ' (estimado)' : ''}: <b>${snap.liquidationPrice != null ? `$${snap.liquidationPrice.toFixed(1)}` : '—'}</b>`,
    balasLine,
  ].join('\n');
  console.log(msg.replace(/<\/?b>/g, '').replace(/\n/g, ' · '));
  await sendMessage(msg, 'HTML');
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
  const localThinksOpen = state.phase === 'in_position';

  if (roi && !localThinksOpen) {
    const msg = `⚠️ [AlitoBot] Reinicio: BingX tiene una posición LONG ${SYMBOL} abierta (ROI ${fmtUsd(roi.roiPct)}%) que este proceso no tiene registrada (fase local: ${state.phase}). NO la voy a tocar automáticamente — revisá BingX y, si es del bot, arrancá el estado a mano antes de dejarlo operar solo.`;
    console.log(msg);
    await sendMessage(msg);
    return;
  }
  if (!roi && localThinksOpen) {
    const msg = `⚠️ [AlitoBot] Reinicio: el estado local decía que había una posición en curso, pero BingX no tiene ninguna LONG ${SYMBOL} abierta — se cerró (o se tocó) fuera de este proceso. Vuelvo a idle.`;
    console.log(msg);
    await sendMessage(msg);
    stateStore.reset();
    return;
  }
  if (roi && localThinksOpen) {
    console.log(`[AlitoBot recover] posición confirmada: ROI ${fmtUsd(roi.roiPct)}%, ${state.cargadores.length} cargador(es), ${rules.totalBalasUsed(state)} balas usadas.`);
  } else {
    console.log('[AlitoBot recover] sin posición abierta — idle, esperando /alitobot/start.');
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
    // Telegram HTML (see lib/telegram.js's parseMode) — only numbers and our
    // own fixed strings are interpolated, nothing that needs escaping.
    const msg = [
      `🔫 [AlitoBot] Recarga a POSICIÓN: +${action.balas} ${action.balas === 1 ? 'bala' : 'balas'} · <b>$${action.marginUsd.toFixed(2)} margen / $${action.notionalUsd.toFixed(2)} nocional</b>`,
      `Compra limit: <b>$${price.toFixed(1)}</b>`,
      `📖 Regla aplicada: ${rules.describeBand(action.band, cfg)}`,
      `📉 ROI al momento de la recarga: ${fmtUsd(action.roiPct)}%`,
      action.insufficient ? '⚠️ Pedido parcial: se agotó el capital disponible (2 cargadores).' : null,
    ].filter(Boolean).join('\n');
    console.log(msg.replace(/<\/?b>/g, ''));
    await sendMessage(msg, 'HTML');
    return;
  }

  if (action.type === 'add_margin') {
    await bingx.addIsolatedMargin({ symbol: SYMBOL, positionSide: POSITION_SIDE, amount: action.marginUsd });
    const msg = [
      `🛡️ [AlitoBot] Recarga a MARGEN: +${action.balas} ${action.balas === 1 ? 'bala' : 'balas'} · <b>$${action.marginUsd.toFixed(2)}</b> agregados como margen aislado (no suma tamaño)`,
      `📖 Regla aplicada: ${rules.describeBand(action.band, cfg)}`,
      `📉 ROI al momento de la recarga: ${fmtUsd(action.roiPct)}%`,
      action.insufficient ? '⚠️ Pedido parcial: se agotó el capital disponible.' : null,
    ].filter(Boolean).join('\n');
    console.log(msg.replace(/<\/?b>/g, ''));
    await sendMessage(msg, 'HTML');
    return;
  }

  if (action.type === 'insufficient_capital') {
    const msg = `⚠️ [AlitoBot] La banda "${action.band}" (ROI ${fmtUsd(action.roiPct)}%) pedía ${action.balasRequested} bala(s), pero ya no queda capital disponible (2 cargadores agotados). No se agregó nada.`;
    console.log(msg);
    await sendMessage(msg);
    return;
  }

  if (action.type === 'early_warning') {
    const msg = `🟠 [AlitoBot] Aviso temprano: ROI en ${fmtUsd(action.roiPct)}% (circuit breaker en ${cfg.circuitBreakerPct}%). Revisar.`;
    console.log(msg);
    await sendMessage(msg);
    return;
  }

  if (action.type === 'take_profit' || action.type === 'circuit_breaker' || action.type === 'manual_close') {
    const roi = await getEffectiveRoi(state);
    if (!roi) {
      console.log(`[AlitoBot] ${action.type}: no hay posición para cerrar (¿ya se cerró?). Reseteando a idle.`);
      stateStore.closeCycle({ reason: action.type, note: 'no position found at close time', roiPct: action.roiPct });
      return;
    }
    const quantity = Math.abs(roi.positionAmt);
    const notionalUsd = roi.avgPrice * quantity;
    const price = rules.computeLimitPrice(markPrice, 'sell', cfg);
    await bingx.placeLimitExit({ symbol: SYMBOL, side: 'SELL', positionSide: POSITION_SIDE, quantity, price });

    const label = { take_profit: '✅ TAKE PROFIT', circuit_breaker: `🛑 CIRCUIT BREAKER (${cfg.circuitBreakerPct}%)`, manual_close: '✋ CIERRE MANUAL' }[action.type];
    const extra = action.type === 'circuit_breaker' ? ' Requiere reset manual (POST /alitobot/reset-circuit-breaker) antes de volver a operar.' : '';
    const msg = `${label}: cerrando posición completa (~$${notionalUsd.toFixed(2)} USDT · ${quantity} BTC) @ ~${price.toFixed(1)} · ROI ${fmtUsd(roi.roiPct)}% · PnL flotante ${fmtUsd(roi.unrealizedProfitUsd)} USD.${extra}`;
    console.log(`[AlitoBot] ${msg}`);
    await sendMessage(`[AlitoBot] ${msg}`);

    stateStore.closeCycle({
      reason: action.type, roiPct: roi.roiPct, unrealizedProfitUsd: roi.unrealizedProfitUsd,
      avgEntryPrice: roi.avgPrice, exitPriceApprox: price, quantity, notionalUsd,
      cargadores: state.cargadores, balasUsed: rules.totalBalasUsed(state),
    });
    if (action.type === 'circuit_breaker') {
      // closeCycle() already reset to idle — force the halted flag back on
      // top so tick() refuses to auto-resume; only the admin endpoint clears it.
      stateStore.update({ phase: 'halted_circuit_breaker', circuitBreakerTripped: true });
    }
  }
}

async function tick() {
  applyEffectiveDryRun();
  const state = stateStore.get();

  if (state.phase === 'halted_circuit_breaker') return; // needs POST /alitobot/reset-circuit-breaker
  if (state.phase === 'idle') return; // needs POST /alitobot/start — no auto re-entry, by design

  const roi = await getEffectiveRoi(state);
  if (!roi) {
    // In DRY_RUN this just means /alitobot/start hasn't run yet in this
    // process's lifetime (totalQuantity still 0) — nothing to alert about,
    // the phase itself already guards against that (only reached when
    // phase is in_position, which /alitobot/start always sets together with
    // totalQuantity). In LIVE this is a real desync: BingX shows no
    // position while local state thinks one's open.
    if (bingx.isDryRun()) return;
    const msg = `⚠️ [AlitoBot] Fase local "in_position" pero BingX no reporta ninguna posición LONG ${SYMBOL} abierta — se cerró fuera de este proceso. Volviendo a idle sin registrar ciclo (no hay datos de cierre reales para guardar).`;
    console.log(msg);
    await sendMessage(msg);
    stateStore.reset();
    return;
  }

  // Continuous, every tick: exits + early warning. Never throttled.
  const { actions: exitActions } = rules.checkExitConditions(state, roi.roiPct, cfg);
  // Only the one field checkExitConditions can flip — NOT the whole `state`
  // object, which was captured before the `await` above. A concurrent
  // request (e.g. POST /alitobot/close arriving mid-await) can close the
  // cycle in between; spreading this stale full object back in would
  // resurrect the just-closed in_position phase (`update()` merges its
  // `partial` argument on top of whatever's current).
  stateStore.update({ earlyWarningFired: state.earlyWarningFired });
  for (const action of exitActions) {
    await applyAction(action, roi.markPrice);
  }
  if (exitActions.some(a => a.type === 'take_profit' || a.type === 'circuit_breaker')) {
    return; // cycle just closed — nothing left to do this tick
  }
  if (stateStore.get().phase !== 'in_position') return; // closed concurrently (e.g. manual /alitobot/close) during the awaits above

  // At most once per calendar day: the actual bala tranches.
  const today = todayKey();
  if (today !== state.lastRecargaDay) {
    const working = JSON.parse(JSON.stringify(stateStore.get()));
    const { actions: recargaActions } = rules.computeDailyRecarga(working, roi.roiPct, cfg);
    working.lastRecargaDay = today;
    stateStore.update(working);
    for (const action of recargaActions) {
      await applyAction(action, roi.markPrice);
    }
  }

  if (today !== lastDigestDay && stateStore.get().phase === 'in_position') {
    lastDigestDay = today;
    // Re-read ROI fresh rather than reusing the pre-actions `roi` above — a
    // take-profit/add this same tick would make that snapshot stale.
    const freshRoi = await getEffectiveRoi(stateStore.get());
    if (freshRoi) await sendDailyDigest(stateStore.get(), freshRoi);
  }

  if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = Date.now();
    console.log(`[AlitoBot heartbeat] alive · phase=${stateStore.get().phase} · ROI ${fmtUsd(roi.roiPct)}% · balas ${rules.totalBalasUsed(stateStore.get())}`);
  }
}

function startServer() {
  const port = process.env.PORT;
  if (!port) {
    console.log('[AlitoBot server] PORT not set — skipping HTTP server.');
    return;
  }
  const secret = process.env.WORKER_API_SECRET;
  const server = http.createServer((req, res) => {
    if (!secret || req.headers['x-worker-secret'] !== secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/history') {
      (async () => {
        const effectiveMode = applyEffectiveDryRun() ? 'dry_run' : 'live';
        const state = stateStore.get();
        // Live snapshot (ROI/price/liquidation) — same source split as
        // tick()/sendDailyDigest: simulated in DRY_RUN, real BingX in LIVE.
        // Only meaningful once a cycle is open; the dashboard shows this
        // instead of the raw persisted state alone so it doesn't need its
        // own copy of getEffectiveRoi's logic.
        let live = null;
        if (state.phase === 'in_position') {
          try {
            const roi = await getEffectiveRoi(state);
            if (roi) live = await buildSnapshot(state, roi);
          } catch (err) {
            console.error('[AlitoBot /history] no se pudo leer ROI en vivo:', err.message);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          mode: effectiveMode, position: state, live, cycles: stateStore.getHistory(),
          config: { leverage: cfg.leverage, capitalUsd: cfg.capitalUsd },
        }));
      })();
      return;
    }

    if (req.method === 'GET' && req.url === '/trades') {
      // "Trades" here = closed AlitoBot cycles (open→take-profit/circuit-breaker),
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
          ? '⚠️ [AlitoBot] Se pidió LIVE pero Railway sigue con DRY_RUN=true — sigue en TEST.'
          : (effectiveMode === 'live' ? '🔓 [AlitoBot] Modo cambiado a LIVE (dinero real).' : '🔒 [AlitoBot] Modo cambiado a TEST (DRY_RUN).');
        console.log(msg);
        await sendMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, mode: effectiveMode, floorBlocked }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/alitobot/start') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => (async () => {
        const state = stateStore.get();
        if (state.phase !== 'idle') {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Ya hay un ciclo en curso (fase: ${state.phase}).` }));
          return;
        }
        // Leverage is fixed for the whole cycle (can't change it once a
        // position is open), so this is the only moment it can be chosen —
        // confirmed here, not editable mid-cycle. Omitted/invalid falls
        // back to the deployed default (ALITOBOT_LEVERAGE).
        let requestedLeverage;
        try { requestedLeverage = JSON.parse(body || '{}').leverage; } catch { /* falls through to default */ }
        if (requestedLeverage != null) {
          const n = Number(requestedLeverage);
          if (!Number.isFinite(n) || n <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'leverage debe ser un número mayor a 0' }));
            return;
          }
          cfg = rules.getConfig({ ...process.env, ALITOBOT_LEVERAGE: String(n) });
        }
        try {
          await bingx.setLeverage(SYMBOL, POSITION_SIDE, cfg.leverage);
          await bingx.setMarginMode({ symbol: SYMBOL, marginType: 'ISOLATED' }).catch(err =>
            console.log('[AlitoBot] setMarginMode falló (probablemente ya estaba en ISOLATED):', err.message));
          const priceData = await bingx.getPrice(SYMBOL);
          const markPrice = Number(priceData.data.price); // getPrice() returns BingX's raw {code,msg,data:{price,...}} envelope
          const initial = rules.initialState(cfg);
          const { notionalUsd } = rules.balasToUsd(cfg, cfg.inicioBalas);
          const price = rules.computeLimitPrice(markPrice, 'buy', cfg);
          const quantity = roundQty(notionalUsd / price);
          await bingx.placeLimitEntry({ symbol: SYMBOL, side: 'BUY', positionSide: POSITION_SIDE, quantity, price });
          // lastRecargaDay = hoy: el día que arranca el ciclo cuenta como ya
          // revisado — Inicio es la única acción de hoy, la primera recarga
          // real recién corre mañana. Sin esto, el chequeo diario (gateado
          // por "today !== lastRecargaDay", que arranca en null) se dispara
          // en el mismo tick que Inicio, sumando una recarga el mismo día.
          stateStore.update({ ...initial, avgEntryPrice: price, totalQuantity: quantity, openedAt: Date.now(), lastRecargaDay: todayKey() });

          const msg = `🚀 [AlitoBot] Ciclo iniciado: Inicio ${cfg.inicioBalas} balas · $${notionalUsd.toFixed(2)} nocional · limit @ ${price.toFixed(1)} · leverage ${cfg.leverage}x.`;
          console.log(msg);
          await sendMessage(msg);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, state: stateStore.get() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
        }
      })());
      return;
    }

    if (req.method === 'POST' && req.url === '/alitobot/close') {
      (async () => {
        const state = stateStore.get();
        if (state.phase !== 'in_position') {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `No hay posición para cerrar (fase: ${state.phase}).` }));
          return;
        }
        try {
          const roi = await getEffectiveRoi(state);
          if (!roi) {
            res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'No se pudo leer el ROI actual de la posición.' }));
            return;
          }
          await applyAction({ type: 'manual_close', roiPct: roi.roiPct }, roi.markPrice);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, state: stateStore.get() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    if (req.method === 'POST' && req.url === '/alitobot/reset-circuit-breaker') {
      (async () => {
        const state = stateStore.get();
        if (state.phase !== 'halted_circuit_breaker') {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'El circuit breaker no está activo.' }));
          return;
        }
        stateStore.reset();
        const msg = '🔧 [AlitoBot] Circuit breaker reseteado a mano — vuelve a esperar /alitobot/start.';
        console.log(msg);
        await sendMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      })();
      return;
    }

    if (req.method === 'POST' && req.url === '/admin/clear-history') {
      stateStore.clearAll();
      console.log('[AlitoBot admin] historial de ciclos borrado via /admin/clear-history');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404).end();
  });
  server.listen(port, () => console.log(`[AlitoBot server] listening on ${port} (/history, /trades, /mode, /alitobot/start, /alitobot/close, /alitobot/reset-circuit-breaker, /admin/clear-history — requires X-Worker-Secret)`));
}

async function main() {
  const startedDryRun = applyEffectiveDryRun();
  console.log(`AlitoBot worker starting for ${SYMBOL} (poll ${POLL_MS}ms, leverage ${cfg.leverage}x, capital $${cfg.capitalUsd}, bala $${rules.balaMarginUsd(cfg).toFixed(2)} margen / $${rules.balaNotionalUsd(cfg).toFixed(2)} nocional, TP ${cfg.takeProfitPct}%, circuit breaker ${cfg.circuitBreakerPct}%, recargas: 1x/día, DRY_RUN=${bingx.isDryRun()})`);
  await sendMessage(startedDryRun
    ? '🔒 [AlitoBot] Worker arrancó en modo TEST (DRY_RUN). Esperando POST /alitobot/start para abrir un ciclo.'
    : '🔓 [AlitoBot] Worker arrancó en modo LIVE (dinero real). Esperando POST /alitobot/start para abrir un ciclo.');

  try {
    await bingx.setLeverage(SYMBOL, POSITION_SIDE, cfg.leverage);
    await recoverState();
  } catch (err) {
    console.error('[AlitoBot] startup failed:', err.message);
    stateStore.update({ phase: 'halted_circuit_breaker', circuitBreakerTripped: true }); // safest halted state: refuses to auto-resume, needs manual reset
    await sendMessage(`🛑 [AlitoBot] Error crítico al arrancar: ${err.message}. Revisá BingX a mano antes de resetear (POST /alitobot/reset-circuit-breaker).`);
  }

  startServer();
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error('[AlitoBot] tick failed:', err.message);
      await sendMessage(`⚠️ [AlitoBot] Error en el bot: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main();
