// Server-only (uses fs) — persists the worker's runtime test/live mode on
// the same Railway volume as lib/dailyLossTracker.js, so it survives
// restarts (needed since recoverState() already resumes a real open
// position after a redeploy — the mode it resumes into has to persist too).
const fs = require('fs');

class ModeStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  // No file yet (fresh deploy, or never toggled) resolves to 'dry_run' —
  // never 'live' — so a missing/corrupt file can't accidentally enable
  // real trading.
  getMode() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return raw.mode === 'live' ? 'live' : 'dry_run';
    } catch {
      return 'dry_run';
    }
  }

  setMode(mode) {
    const normalized = mode === 'live' ? 'live' : 'dry_run';
    fs.writeFileSync(this.filePath, JSON.stringify({ mode: normalized }));
    return normalized;
  }
}

module.exports = { ModeStore };
