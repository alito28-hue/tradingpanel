// Shared between worker/runSignal.js and worker/runSaylor.js — deliberately
// pulled out of either loop file so the real-money dry-run/live gate can
// never silently diverge between the two strategies through copy-paste.
// This is the single most safety-critical piece of logic in the worker.

// Railway injects RAILWAY_VOLUME_MOUNT_PATH automatically once a Volume is
// attached to this service — without one (e.g. running locally), falls back
// to a file next to the calling script.
function resolveDataDir(fallbackDir) {
  return process.env.RAILWAY_VOLUME_MOUNT_PATH || fallbackDir;
}

function roundQty(qty, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(qty * factor) / factor; // 3 decimals default — refine per-symbol precision before scaling up
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
//
// The floor MUST be captured at module load time, before anything mutates
// process.env.DRY_RUN — callers pass modeStore in and get back a bound
// function; do not call this more than once per process with different
// modeStore instances, since the floor is captured once, here.
function makeDryRunGate(modeStore) {
  const floor = process.env.DRY_RUN;
  return function applyEffectiveDryRun() {
    if (floor !== 'false') {
      process.env.DRY_RUN = 'true';
      return true;
    }
    const isDryRun = modeStore.getMode() !== 'live';
    process.env.DRY_RUN = isDryRun ? 'true' : 'false';
    return isDryRun;
  };
}

module.exports = { resolveDataDir, roundQty, makeDryRunGate };
