// Server-only (uses fs) — persists the Saylor strategy's cycle state across
// worker restarts. Same file-backed pattern as lib/dailyLossTracker.js /
// lib/modeStore.js. BingX is still the source of truth for what's actually
// open (see worker/runSaylor.js's recoverState) — this file is the *local
// bookkeeping* of which bands already fired and how many balas/cargadores
// have been committed, which BingX itself has no concept of.
const fs = require('fs');

function idleState() {
  return {
    phase: 'idle', // idle | in_position | halted_circuit_breaker
    cargadores: [],
    avgEntryPrice: null,
    totalQuantity: 0,
    entryOrderIds: [],
    regularBand: { current: null, fired: false },
    exceptional: { critical: { fired: false }, terminal: { fired: false } },
    earlyWarningFired: false,
    circuitBreakerTripped: false,
    openedAt: null,
    lastTickAt: null,
  };
}

class SaylorStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    const loaded = this._load();
    this.state = loaded.state;
    this.history = loaded.history;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return { state: raw.state || idleState(), history: raw.history || [] };
    } catch {
      // no file yet, or unreadable — start fresh
    }
    return { state: idleState(), history: [] };
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify({ state: this.state, history: this.history }));
  }

  get() {
    return this.state;
  }

  // Merges partial updates into the live state and persists — the caller
  // (worker/runSaylor.js) owns the actual decision logic (lib/saylorRules.js
  // mutates a working copy of `state`), this just commits it to disk.
  update(partial) {
    this.state = { ...this.state, ...partial, lastTickAt: Date.now() };
    this._save();
    return this.state;
  }

  // Archives the closed cycle into history and resets to idle — called on
  // take-profit close or circuit-breaker close.
  closeCycle(summary) {
    this.history.unshift({ ...summary, closedAt: Date.now() });
    this.state = idleState();
    this._save();
  }

  reset() {
    this.state = idleState();
    this._save();
  }

  clearAll() {
    this.state = idleState();
    this.history = [];
    this._save();
  }

  getHistory(limit = 50) {
    return this.history.slice(0, limit);
  }
}

module.exports = { SaylorStateStore, idleState };
