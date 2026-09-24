// Pure decision logic for "AlitoBot" — a BTC-only, long-only martingale/grid:
// no candles, no stop-loss. It reads the position's live floating ROI%
// (unrealized PnL ÷ margin BingX currently has committed to the position —
// NOT raw BTC price %) and decides whether to add margin and/or size, based
// on which ROI band that sits in.
//
// Source of the rules: "Reglas Michael Saylor 2026"
// (criptonorber.com/estrategia-michael-saylor.html) — replicated here so the
// user can run it themselves instead of paying BingX copy-trading fees.
// No fs, no network — safe to unit-test and to import from a future
// dashboard preview page, same convention as lib/botSafety.js.
//
// Two different cadences, deliberately split into two entry points:
//   - checkExitConditions(): every tick (take-profit, circuit breaker, early
//     warning) — risk-reducing/safety actions should never wait.
//   - computeDailyRecarga(): once per calendar day (regular/crítica/terminal
//     bala tranches) — checking every 20s reacted to normal price noise
//     (e.g. a -0.15% wobble) as if it were a real drawdown; the rule table
//     is meant to be read once a day, not continuously.

function getConfig(env = process.env) {
  return {
    capitalUsd: Number(env.ALITOBOT_CAPITAL_USD || 5000),
    leverage: Number(env.ALITOBOT_LEVERAGE || 5),
    balasPerCargador: Number(env.ALITOBOT_BALAS_PER_CARGADOR || 30),
    maxCargadores: Number(env.ALITOBOT_MAX_CARGADORES || 2),
    inicioBalas: Number(env.ALITOBOT_INICIO_BALAS || 3),
    takeProfitPct: Number(env.ALITOBOT_TAKE_PROFIT_PCT || 20),
    criticalPct: Number(env.ALITOBOT_CRITICAL_PCT || -40),
    terminalPct: Number(env.ALITOBOT_TERMINAL_PCT || -60),
    circuitBreakerPct: Number(env.ALITOBOT_CIRCUIT_BREAKER_PCT || -75),
    earlyWarningPct: Number(env.ALITOBOT_EARLY_WARNING_PCT || -70),
    // Every order is a LIMIT order placed close to the current mark price
    // (never MARKET, by explicit instruction) — this is how close. A BUY
    // (opening/adding) prices slightly ABOVE mark so it crosses the book and
    // fills almost immediately; a SELL (closing) prices slightly BELOW mark
    // for the same reason. Still caps worst-case slippage, unlike a true
    // market order, at the cost of a small chance of not filling if price
    // moves fast enough.
    limitOffsetPct: Number(env.ALITOBOT_LIMIT_OFFSET_PCT || 0.05),
    // BingX's typical taker fee — used only to ESTIMATE the breakeven price
    // in DRY_RUN (no real fills to read a real fee off). In LIVE, the real
    // breakeven is derived from actual commission income instead (see
    // worker/runAlitobot.js's getCosts) — this default doesn't matter there.
    feePct: Number(env.ALITOBOT_FEE_PCT || 0.05),
  };
}

// direction: 'buy' | 'sell'. Always used with a fresh mark price, never a
// stale one — see worker/runAlitobot.js.
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

// Plain-language description of the rule that triggered a recarga, shown in
// the Telegram alert so the user can learn the table by seeing which row
// applied each time. Keep the wording in sync with REGULAR_BANDS above and
// the critical/terminal branches of computeDailyRecarga.
function describeBand(bandId, cfg) {
  switch (bandId) {
    case 'pos_gt_5': return 'ROI positivo mayor a +5% → 1 bala a posición';
    case 'pos_le_5': return 'ROI positivo hasta +5% → 2 balas a posición';
    case 'neg_le_5': return 'ROI negativo hasta -5% → 2 balas a posición';
    case 'neg_le_10': return 'ROI negativo entre -5% y -10% → 3 balas a posición';
    case 'neg_le_15': return 'ROI negativo entre -10% y -15% → 4 balas a posición';
    case 'neg_gt_15': return 'ROI negativo peor que -15% → 5 balas a posición';
    case 'critical': return `Recarga crítica (ROI peor que ${cfg.criticalPct}%) → 3 balas a posición + 3 balas a margen`;
    case 'terminal': return `Recarga terminal (ROI peor que ${cfg.terminalPct}%) → 6 balas a posición + 6 balas a margen`;
    default: return bandId;
  }
}

// Fresh state for a brand-new cycle, opened with the "Inicio" tranche.
function initialState(cfg) {
  return {
    phase: 'in_position',
    cargadores: [{ index: 0, balasUsed: cfg.inicioBalas }],
    lastRecargaDay: null, // set the first time computeDailyRecarga actually runs, not on open — the day it opens still gets its own daily check
    earlyWarningFired: false,
    circuitBreakerTripped: false,
  };
}

function totalBalasUsed(state) {
  return state.cargadores.reduce((sum, c) => sum + c.balasUsed, 0);
}

// "Balas restantes" para el día a día es lo que queda en el cargador que se
// está usando ahora, NO la suma teórica de los dos cargadores — el segundo
// cargador es una reserva de emergencia ("hasta 1 cargador extra ante una
// corrección o caída prolongada"), no un pozo disponible desde el arranque.
function cargadorStatus(state, cfg) {
  const activo = state.cargadores[state.cargadores.length - 1];
  return {
    cargadorActivo: activo.index + 1, // 1-based para mostrar
    restantesActivo: cfg.balasPerCargador - activo.balasUsed,
    reservaAbierta: state.cargadores.length > 1,
    reservaDisponible: state.cargadores.length < cfg.maxCargadores,
  };
}

// Only used in DRY_RUN, where there's no real BingX position to read a real
// liquidationPrice off — a standard isolated-margin approximation:
// liq = avgEntry * (1 - margin/notional + maintenanceMarginRate). Adding
// margin without adding size (the "a margen" tranches) pushes this further
// from price, same direction BingX's real number would move. Not exact
// (BingX's real maintenance margin is tiered by notional) — good enough for
// an informational Telegram digest, not a trading decision.
function estimateLiquidationPrice(avgEntryPrice, marginUsd, notionalUsd, maintenanceMarginRate = 0.004) {
  if (!avgEntryPrice || !notionalUsd) return null;
  return avgEntryPrice * (1 - marginUsd / notionalUsd + maintenanceMarginRate);
}

// Estimated round-trip-fee breakeven for a long (entry fee + exit fee, both
// at cfg.feePct) — only used as a fallback where a real one can't be
// computed from actual paid commissions (see worker/runAlitobot.js's
// getCosts, which prefers the real number whenever fills/costs exist).
function estimateBreakevenPrice(avgEntryPrice, cfg) {
  if (!avgEntryPrice) return null;
  return avgEntryPrice * (1 + (2 * cfg.feePct) / 100);
}

// Spills into the next cargador (opening one if needed and allowed) when the
// active one doesn't have enough balas left — balas are fungible margin
// units, "cargador" is just a capital-tranche label, not a hard boundary.
// Returns { granted, insufficient } — granted may be less than requested if
// ALITOBOT_MAX_CARGADORES is exhausted; insufficient=true means the caller
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

// Called on EVERY tick — never throttled, these are risk-reducing actions
// (locking in profit, or cutting losses beyond what the rule table itself
// ever intended to survive) and must react immediately, not wait for a
// once-a-day check.
function checkExitConditions(state, roiPct, cfg) {
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
  return { actions };
}

// Called AT MOST once per calendar day (caller gates this via
// state.lastRecargaDay) — evaluates the CURRENT roiPct against the rule
// table fresh each time, no "already fired" tracking needed since it's only
// ever invoked once per day in the first place. mutates `state.cargadores`
// (and the caller persists it).
function computeDailyRecarga(state, roiPct, cfg) {
  const actions = [];

  const band = classifyRoiBand(roiPct);
  if (band) {
    const balas = getRegularBandBalas(band);
    const { granted, insufficient, cargadoresOpened } = allocateBalas(state, cfg, balas);
    if (granted > 0) {
      actions.push({ type: 'add_to_position', balas: granted, ...balasToUsd(cfg, granted), band, cargadoresOpened, insufficient, roiPct });
    } else if (insufficient) {
      actions.push({ type: 'insufficient_capital', band, balasRequested: balas, roiPct });
    }
  }

  if (roiPct <= cfg.criticalPct) {
    const toPos = allocateBalas(state, cfg, 3);
    const toMargin = allocateBalas(state, cfg, 3);
    if (toPos.granted > 0) actions.push({ type: 'add_to_position', balas: toPos.granted, ...balasToUsd(cfg, toPos.granted), band: 'critical', cargadoresOpened: toPos.cargadoresOpened, insufficient: toPos.insufficient, roiPct });
    if (toMargin.granted > 0) actions.push({ type: 'add_margin', balas: toMargin.granted, ...balasToUsd(cfg, toMargin.granted), band: 'critical', cargadoresOpened: toMargin.cargadoresOpened, insufficient: toMargin.insufficient, roiPct });
  }

  if (roiPct <= cfg.terminalPct) {
    const toPos = allocateBalas(state, cfg, 6);
    const toMargin = allocateBalas(state, cfg, 6);
    if (toPos.granted > 0) actions.push({ type: 'add_to_position', balas: toPos.granted, ...balasToUsd(cfg, toPos.granted), band: 'terminal', cargadoresOpened: toPos.cargadoresOpened, insufficient: toPos.insufficient, roiPct });
    if (toMargin.granted > 0) actions.push({ type: 'add_margin', balas: toMargin.granted, ...balasToUsd(cfg, toMargin.granted), band: 'terminal', cargadoresOpened: toMargin.cargadoresOpened, insufficient: toMargin.insufficient, roiPct });
  }

  return { actions };
}

module.exports = {
  getConfig, cargadorUsd, balaMarginUsd, balaNotionalUsd, computeLimitPrice,
  classifyRoiBand, getRegularBandBalas, describeBand, initialState, totalBalasUsed, cargadorStatus,
  estimateLiquidationPrice, estimateBreakevenPrice, allocateBalas, balasToUsd, checkExitConditions, computeDailyRecarga,
};
