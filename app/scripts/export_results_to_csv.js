const fs = require('fs');
const path = require('path');

const inPath = path.join(__dirname, '..', 'backtest_result.json');
const outDir = path.join(__dirname, '..', 'results');

function safeName(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function toCsv(rows) {
  if (!rows || !rows.length) return '';
  const keys = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const header = keys.join(',') + '\n';
  const lines = rows.map(r => keys.map(k => {
    const v = r[k] == null ? '' : String(r[k]);
    // escape quotes
    if (v.includes(',') || v.includes('\"') || v.includes('\n')) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }).join(','));
  return header + lines.join('\n');
}

(async () => {
  if (!fs.existsSync(inPath)) {
    console.error('Input JSON not found:', inPath);
    process.exit(1);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const raw = fs.readFileSync(inPath, 'utf8');
  const data = JSON.parse(raw);

  // write full JSON copy (already present but ensure up-to-date)
  fs.writeFileSync(path.join(outDir, 'backtest_result.json'), JSON.stringify(data, null, 2));

  if (!Array.isArray(data.comparison)) {
    console.warn('No comparison array found');
    process.exit(0);
  }

  for (const scenario of data.comparison) {
    const label = scenario.label || 'scenario';
    const name = safeName(label);
    const trades = (scenario.trades && scenario.trades.length ? scenario.trades : scenario.sampleTrades) || [];
    const normalizedTrades = trades.map(t => ({
      ...t,
      netPnlPct: t.netPnlPct ?? t.pnlPct ?? 0,
      grossPnlPct: t.grossPnlPct ?? t.pnlPct ?? 0,
      durationMinutes: t.durationMinutes ?? ((t.exitTime - t.entryTime) / 60000)
    }));
    const csv = toCsv(normalizedTrades);
    fs.writeFileSync(path.join(outDir, `${name}_trades.csv`), csv);
    // also write metrics
    fs.writeFileSync(path.join(outDir, `${name}_metrics.json`), JSON.stringify(scenario.metrics || {}, null, 2));
  }

  console.log('Exported results to', outDir);
})();
