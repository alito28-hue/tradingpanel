// Server-only (uses fs) — don't import from a Next.js client component.
const fs = require('fs');

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

class DailyLossTracker {
  constructor(filePath, dailyLossLimitUsd) {
    this.filePath = filePath;
    this.dailyLossLimitUsd = Math.abs(dailyLossLimitUsd);
    this.state = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw.day === todayKey()) return raw;
    } catch {
      // no file yet, or unreadable — start fresh
    }
    return { day: todayKey(), realizedPnlUsd: 0 };
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state));
  }

  recordTrade(pnlUsd) {
    if (this.state.day !== todayKey()) this.state = { day: todayKey(), realizedPnlUsd: 0 };
    this.state.realizedPnlUsd += pnlUsd;
    this._save();
  }

  isKilled() {
    if (this.state.day !== todayKey()) this.state = { day: todayKey(), realizedPnlUsd: 0 };
    return this.state.realizedPnlUsd <= -this.dailyLossLimitUsd;
  }

  reset() {
    this.state = { day: todayKey(), realizedPnlUsd: 0 };
    this._save();
  }
}

module.exports = { DailyLossTracker };
