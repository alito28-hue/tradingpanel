// Pure decision logic for the "Saylor" strategy — a BTC-only, long-only
// martingale/grid: no candles, no stop-loss. It reads the position's live
// floating ROI% (unrealized PnL ÷ margin BingX currently has committed to
// the position — NOT raw BTC price %) and decides whether to add margin
// and/or size, based on which ROI band that sits in.
//
// Source of the rules: "Reglas Michael Saylor 2026"
// (criptonorber.com/estrategia-michael-saylor.html) — replicated here so the
// user can run it themselves instead of paying BingX copy-trading fees.
// No fs, no network — safe to unit-test and to import from a future
// dashboard preview page, same convention as lib/botSafety.js.

function getConfig(env = process.env) {
  return {
    capitalUsd: Number(env.SAYLOR_CAPITAL_USD || 5000),
    leverage: Number(env.SAYLOR_LEVERAGE || 5),
    balasPerCargador: Number(env.SAYLOR_BALAS_PER_CARGADOR || 30),
    maxCargadores: Number(env.SAYLOR_MAX_CARGADORES || 2),
    inicioBalas: Number(env.SAYLOR_INICIO_BALAS || 3),
    takeProfitPct: Number(env.SAYLOR_TAKE_PROFIT_PCT || 20),
    criticalPct: Number(env.SAYLOR_CRITICAL_PCT || -40),
    terminalPct: Number(env.SAYLOR_TERMINAL_PCT || -60),
    circuitBreakerPct: Number(env.SAYLOR_CIRCUIT_BREAKER_PCT || -75),
    earlyWarningPct: Number(env.SAYLOR_EARLY_WARNING_PCT || -70),
    // Every Saylor order is a LIMIT order placed close to the current price
    // (never MARKET, by explicit instruction) — this is how close. A BUY
    // (opening/adding) prices slightly ABOVE mark so it crosses the book and
    // fills almost immediately; a SELL (closing) prices slightly BELOW mark
    // for the same reason. Still caps worst-case slippage, unlike a true
    // market order, at the cost of a small chance of not filling if price
    // moves fast enough — acceptable since the next tick (BOT_POLL_MS later)
    // re-evaluates and would retry.
    limitOffsetPct: Number(env.SAYLOR_LIMIT_OFFSET_PCT || 0.05),
  };
}

// direction: 'buy' | 'sell'. Always used with a fresh mark price, never a
// stale one — see worker/runSaylor.js.
function computeLimitPrice(markPrice, direction, cfg) {
  const offset = cfg.limitOffsetPct / 100;
  return direction === 'buy' ? markPrice * (1 + offset) : markPrice * (1 - offset);
}

function cargadorUsd(cfg) {
  return cfg.capitalUsd / 2;
}

function balaMarginUsd(cfg) {
  return cargadorUsd(cfg) / cfg.balasPerCargador;
}

function balaNotionalUsd(cfg) {
  return balaMarginUsd(cfg) * cfg.leverage;
}

// Mutually exclusive, partition the whole ROI axis — "Inicio" (3 balas) is
// NOT one of these, it only fires once, on manual cycle start.
const REGULAR_BANDS = [
  { id: 'pos_gt_5', test: roi => roi > 5, balas: 1 },
  { id: 'pos_le_5', test: roi => roi > 0 && roi <= 5, balas: 2 },
  { id: 'neg_le_5', test: roi => roi <= 0 && roi > -5, balas: 2 },
  { id: 'neg_le_10', test: roi => roi <= -5 && roi > -10, balas: 3 },
  { id: 'neg_le_15', test: roi => roi <= -10 && roi > -15, balas: 4 },
  { id: 'neg_gt_15', test: roi => roi <= -15, balas: 5 },
];

function classifyRoiBand(roiPct) {
  const band = REGULAR_BANDS.find(b => b.test(roiPct));
  return band ? band.id : null;
}

function getRegularBandBalas(bandId) {
  const band = REGULAR_BANDS.find(b => b.id === bandId);
  return band ? band.balas : 0;
}

// Fresh state for a brand-new cycle, opened with the "Inicio" tranche.
function initialState(cfg) {
  return {
    phase: 'in_position',
    cargadores: [{ index: 0, balasUsed: cfg.inicioBalas }],
    regularBand: { current: null, fired: false },
    exceptional: { critical: { fired: false }, terminal: { fired: false } },
    circuitBreakerTripped: false,
  };
}

function totalBalasUsed(state) {
  return state.cargadores.reduce((sum, c) => sum + c.balasUsed, 0);
}

// Spills into the next cargador (opening one if needed and allowed) when the
// active one doesn't have enough balas left — balas are fungible margin
// units, "cargador" is just a capital-tranche label, not a hard boundary.
// Returns { granted, insufficient } — granted may be less than requested if
// SAYLOR_MAX_CARGADORES is exhausted; insufficient=true means the caller
// should alert (the rule asked for more capital than is allowed to deploy).
function allocateBalas(state, cfg, balasRequested) {
  let remaining = balasRequested;
  let granted = 0;
  const opened = [];
  let cargadorIdx = state.cargadores.length - 1;

  while (remaining > 0) {
    if (cargadorIdx < 0 || cargadorIdx >= state.cargadores.length) {
      if (state.cargadores.length >= cfg.maxCargadores) break; // hard cap — never deploy more than maxCargadores worth
      state.cargadores.push({ index: state.cargadores.length, balasUsed: 0 });
      opened.push(state.cargadores.length - 1);
      cargadorIdx = state.cargadores.length - 1;
    }
    const cargador = state.cargadores[cargadorIdx];
    const free = cfg.balasPerCargador - cargador.balasUsed;
    if (free <= 0) { cargadorIdx += 1; continue; }
    const take = Math.min(free, remaining);
    cargador.balasUsed += take;
    granted += take;
    remaining -= take;
  }

  return { granted, insufficient: granted < balasRequested, cargadoresOpened: opened };
}

function balasToUsd(cfg, balas) {
  return { marginUsd: balas * balaMarginUsd(cfg), notionalUsd: balas * balaNotionalUsd(cfg) };
}

// The core tick decision. `state` is mutated in place (caller persists it)
// and actions to execute are returned — never executes anything itself,
// mirrors lib/strategy.js's simulateTrades (pure decision, order placement
// stays in the worker loop).
function computeNextAction(state, roiPct, cfg) {
  const actions = [];

  if (roiPct <= cfg.circuitBreakerPct) {
    actions.push({ type: 'circuit_breaker', roiPct });
    return { actions };
  }

  if (roiPct >= cfg.takeProfitPct) {
    actions.push({ type: 'take_profit', roiPct });
    return { actions };
  }

  if (roiPct <= cfg.earlyWarningPct && !state.earlyWarningFired) {
    state.earlyWarningFired = true;
    actions.push({ type: 'early_warning', roiPct });
  } else if (roiPct > cfg.earlyWarningPct) {
    state.earlyWarningFired = false;
  }

  // Regular band — fires once per crossing into a *different* band than last tick.
  const newBand = classifyRoiBand(roiPct);
  if (newBand !== state.regularBand.current) {
    state.regularBand = { current: newBand, fired: false };
  }
  if (newBand && !state.regularBand.fired) {
    const balas = getRegularBandBalas(newBand);
    const { granted, insufficient, cargadoresOpened } = allocateBalas(state, cfg, balas);
    state.regularBand.fired = true;
    if (granted > 0) {
      actions.push({ type: 'add_to_position', balas: granted, ...balasToUsd(cfg, granted), band: newBand, cargadoresOpened, insufficient, roiPct });
    } else if (insufficient) {
      actions.push({ type: 'insufficient_capital', band: newBand, balasRequested: balas, roiPct });
    }
  }

  // Exceptional bands — independent of the regular one, each its own fire-once-per-crossing.
  if (roiPct <= cfg.criticalPct && !state.exceptional.critical.fired) {
    state.exceptional.critical.fired = true;
    const toPos = allocateBalas(state, cfg, 3);
    const toMargin = allocateBalas(state, cfg, 3);
    if (toPos.granted > 0) actions.push({ type: 'add_to_position', balas: toPos.granted, ...balasToUsd(cfg, toPos.granted), band: 'critical', cargadoresOpened: toPos.cargadoresOpened, insufficient: toPos.insufficient, roiPct });
    if (toMargin.granted > 0) actions.push({ type: 'add_margin', balas: toMargin.granted, ...balasToUsd(cfg, toMargin.granted), band: 'critical', cargadoresOpened: toMargin.cargadoresOpened, insufficient: toMargin.insufficient, roiPct });
  } else if (roiPct > cfg.criticalPct) {
    state.exceptional.critical.fired = false;
  }

  if (roiPct <= cfg.terminalPct && !state.exceptional.terminal.fired) {
    state.exceptional.terminal.fired = true;
    const toPos = allocateBalas(state, cfg, 6);
    const toMargin = allocateBalas(state, cfg, 6);
    if (toPos.granted > 0) actions.push({ type: 'add_to_position', balas: toPos.granted, ...balasToUsd(cfg, toPos.granted), band: 'terminal', cargadoresOpened: toPos.cargadoresOpened, insufficient: toPos.insufficient, roiPct });
    if (toMargin.granted > 0) actions.push({ type: 'add_margin', balas: toMargin.granted, ...balasToUsd(cfg, toMargin.granted), band: 'terminal', cargadoresOpened: toMargin.cargadoresOpened, insufficient: toMargin.insufficient, roiPct });
  } else if (roiPct > cfg.terminalPct) {
    state.exceptional.terminal.fired = false;
  }

  return { actions };
}

module.exports = {
  getConfig, cargadorUsd, balaMarginUsd, balaNotionalUsd, computeLimitPrice,
  classifyRoiBand, getRegularBandBalas, initialState, totalBalasUsed,
  allocateBalas, balasToUsd, computeNextAction,
};
