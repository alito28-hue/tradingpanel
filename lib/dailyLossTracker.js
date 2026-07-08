// Server-only (uses fs) — don't import from a Next.js client component.
const fs = require('fs');

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function freshDay() {
  return { day: todayKey(), realizedPnlUsd: 0, trades: 0, wins: 0, losses: 0 };
}

class DailyLossTracker {
  constructor(filePath, dailyLossLimitUsd) {
    this.filePath = filePath;
    this.dailyLossLimitUsd = Math.abs(dailyLossLimitUsd);
    const loaded = this._load();
    this.state = loaded.state;
    this.history = loaded.history;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return { state: raw.state || freshDay(), history: raw.history || [] };
    } catch {
      // no file yet, or unreadable — start fresh
    }
    return { state: freshDay(), history: [] };
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify({ state: this.state, history: this.history }));
  }

  // Archives the outgoing day into `history` the first time anything touches
  // the tracker on a new day — called from recordTrade/isKilled, and once
  // per worker tick via checkRollover() so a day with zero trades still gets
  // archived instead of silently merging into whatever day comes next.
  _rolloverIfNeeded() {
    if (this.state.day === todayKey()) return null;
    const finished = {
      ...this.state,
      winRate: this.state.trades ? Math.round((this.state.wins / this.state.trades) * 100) : 0,
    };
    this.history.unshift(finished);
    this.state = freshDay();
    this._save();
    return finished;
  }

  checkRollover() {
    return this._rolloverIfNeeded();
  }

  recordTrade(pnlUsd) {
    this._rolloverIfNeeded();
    this.state.realizedPnlUsd += pnlUsd;
    this.state.trades += 1;
    if (pnlUsd >= 0) this.state.wins += 1;
    else this.state.losses += 1;
    this._save();
  }

  isKilled() {
    this._rolloverIfNeeded();
    return this.state.realizedPnlUsd <= -this.dailyLossLimitUsd;
  }

  getHistory() {
    const today = {
      ...this.state,
      winRate: this.state.trades ? Math.round((this.state.wins / this.state.trades) * 100) : 0,
    };
    return { today, history: this.history };
  }

  reset() {
    this.state = freshDay();
    this._save();
  }
}

module.exports = { DailyLossTracker };
