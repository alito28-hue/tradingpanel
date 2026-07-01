const fs = require('fs');
const path = require('path');

function parseCsv(content) {
  const lines = content.trim().split('\n');
  const hdr = lines.shift().split(',');
  return lines.map(l => {
    // simple CSV parser assuming no commas in fields
    const cols = l.split(',');
    const obj = {};
    for (let i = 0; i < hdr.length; i++) obj[hdr[i]] = cols[i];
    // coerce fields
    obj.entryIndex = Number(obj.entryIndex);
    obj.entryTime = Number(obj.entryTime);
    obj.entryPrice = Number(obj.entryPrice);
    obj.stopPrice = Number(obj.stopPrice);
    obj.peak = Number(obj.peak);
    obj.activated = obj.activated === 'true';
    obj.exitIndex = Number(obj.exitIndex);
    obj.exitTime = Number(obj.exitTime);
    obj.exitPrice = Number(obj.exitPrice);
    obj.pnlPct = Number(obj.pnlPct);
    return obj;
  });
}

function summarize(trades) {
  const count = trades.length;
  const normalized = trades.map(t => ({
    ...t,
    netPnlPct: Number(t.netPnlPct ?? t.pnlPct ?? 0),
    grossPnlPct: Number(t.grossPnlPct ?? t.pnlPct ?? 0),
    durationMinutes: Number(t.durationMinutes ?? ((t.exitTime - t.entryTime) / 60000))
  }));
  const wins = normalized.filter(t => t.netPnlPct > 0);
  const losses = normalized.filter(t => t.netPnlPct <= 0);
  const avgWin = wins.length ? wins.reduce((s,t)=>s+t.netPnlPct,0)/wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s,t)=>s+t.netPnlPct,0)/losses.length : 0;
  const winRate = wins.length / count * 100;
  const totalPnl = normalized.reduce((s,t)=>s+t.netPnlPct,0);
  const durations = normalized.map(t => t.durationMinutes);
  const avgDurationMin = durations.reduce((s,d)=>s+d,0)/durations.length;
  const topWins = [...normalized].sort((a,b)=>b.netPnlPct - a.netPnlPct).slice(0,5);
  const topLosses = [...normalized].sort((a,b)=>a.netPnlPct - b.netPnlPct).slice(0,5);
  const reasons = normalized.reduce((acc,t)=>{ acc[t.reason] = (acc[t.reason]||0)+1; return acc; },{});
  return { count, winRate, avgWin, avgLoss, totalPnl, avgDurationMin, topWins, topLosses, reasons };
}

function loadAndSummarize(file) {
  if (!fs.existsSync(file)) { console.error('Missing', file); return null; }
  const raw = fs.readFileSync(file, 'utf8');
  const trades = parseCsv(raw);
  return summarize(trades);
}

const base = path.join(__dirname, '..', 'results');
const files = [
  { label: 'Con filtro 1H', file: path.join(base, 'con_filtro_de_r_gimen_1h_trades.csv') },
  { label: 'Sin filtro 1H', file: path.join(base, 'sin_filtro_de_r_gimen_1h_trades.csv') },
];

for (const f of files) {
  const res = loadAndSummarize(f.file);
  console.log('---', f.label, '---');
  if (!res) continue;
  console.log(`Trades: ${res.count}`);
  console.log(`Win rate: ${res.winRate.toFixed(2)}%`);
  console.log(`Avg win: ${res.avgWin.toFixed(3)}%  Avg loss: ${res.avgLoss.toFixed(3)}%`);
  console.log(`Total PnL neto: ${res.totalPnl.toFixed(3)}%`);
  console.log(`Avg duration: ${res.avgDurationMin.toFixed(1)} minutes`);
  console.log('Reasons:', res.reasons);
  console.log('Top 5 wins:');
  res.topWins.forEach(t => console.log(`  ${t.netPnlPct.toFixed(3)}% net @ ${new Date(t.entryTime).toISOString()} -> ${new Date(t.exitTime).toISOString()} | gross ${t.grossPnlPct.toFixed(3)}%`));
  console.log('Top 5 losses:');
  res.topLosses.forEach(t => console.log(`  ${t.netPnlPct.toFixed(3)}% net @ ${new Date(t.entryTime).toISOString()} -> ${new Date(t.exitTime).toISOString()} | gross ${t.grossPnlPct.toFixed(3)}%`));
  console.log('\n');
}
