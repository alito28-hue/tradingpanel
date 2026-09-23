// Entry point Railway actually starts (railway.json's startCommand,
// package.json's "worker" script) — kept at this path/name so neither needs
// to change. Picks which strategy loop to run; each one is a fully separate
// file with its own main()/tick()/server, so a bug in one can't reach into
// the other's state.
//
//   STRATEGY_MODE=signal (default, unchanged from before this file existed)
//     -> worker/runSignal.js — candle-signal strategy with stop-loss.
//   STRATEGY_MODE=alitobot
//     -> worker/runAlitobot.js — BTC-only long martingale/grid strategy.
const STRATEGY_MODE = process.env.STRATEGY_MODE || 'signal';

if (STRATEGY_MODE === 'alitobot') {
  require('./runAlitobot');
} else {
  require('./runSignal');
}
