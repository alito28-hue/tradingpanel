// Cheap sanity check before building any strategy on top of funding rate:
// does extreme funding actually predict forward returns at all? Buckets
// historical 8h funding events by percentile and reports mean/median forward
// BTC return at several horizons per bucket. If there's no visible pattern
// here, there's no point building entries/exits around this data source.
// Usage: node check_funding_edge.js

const fs = require('fs');
const path = require('path');
const { fetchFundingRateHistory, fetchKlinesPaged } = require('../../lib/binance');

async function loadCached(fetchFn, cacheName, ...args) {
  const cachePath = path.join(__dirname, '..', 'results', cacheName);
  const [startTime, endTime] = [args[args.length - 2], args[args.length - 1]];
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.startTime === startTime && cached.endTime === endTime) {
      console.error(`Using cached ${cacheName}:`, cached.data.length);
      return cached.data;
    }
  }
  console.error(`Fetching ${cacheName}...`);
  const data = await fetchFn(...args, (n) => { if (n % 20 === 0) console.error(`batch ${n}`); });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ startTime, endTime, data }));
  return data;
}

function percentile(sorted, p) {
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}

// Price at or just after `time`, from a time-sorted 1h candle array.
function priceAt(candles, time) {
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time >= time) return candles[i].close;
  }
  return null;
}

(async function main() {
  try {
    const symbol = 'BTCUSDT';
    const rangeArg = process.argv.find(a => a.startsWith('--range='));
    const [rangeStart, rangeEnd] = rangeArg
      ? rangeArg.split('=')[1].split(',').map(Number)
      : [Date.UTC(2024, 6, 15, 0, 0, 0), Date.UTC(2026, 6, 15, 23, 59, 59)];
    const startTime = rangeStart, endTime = rangeEnd;
    const cacheSuffix = rangeArg ? `_${startTime}_${endTime}` : '_2y';

    const funding = await loadCached(fetchFundingRateHistory, `funding${cacheSuffix}.json`, symbol, startTime, endTime);
    const candles = await loadCached(fetchKlinesPaged, `candles_1h${cacheSuffix}.json`, symbol, '1h', startTime, endTime);
    console.error('Funding events:', funding.length, 'Candles:', candles.length);

    const rates = funding.map(f => f.rate).sort((a, b) => a - b);
    const buckets = [
      { label: 'Muy negativo (<p10)', test: r => r <= percentile(rates, 0.10) },
      { label: 'Negativo (p10-p30)', test: r => r > percentile(rates, 0.10) && r <= percentile(rates, 0.30) },
      { label: 'Neutral (p30-p70)', test: r => r > percentile(rates, 0.30) && r <= percentile(rates, 0.70) },
      { label: 'Positivo (p70-p90)', test: r => r > percentile(rates, 0.70) && r <= percentile(rates, 0.90) },
      { label: 'Muy positivo (>p90)', test: r => r > percentile(rates, 0.90) },
    ];
    const horizons = [
      { label: '8h (siguiente funding)', ms: 8 * 3600000 },
      { label: '24h', ms: 24 * 3600000 },
      { label: '3 dias', ms: 3 * 24 * 3600000 },
    ];

    console.log(`Rango de funding rate: min=${(rates[0] * 100).toFixed(4)}% max=${(rates[rates.length - 1] * 100).toFixed(4)}%`);
    console.log(`p10=${(percentile(rates, 0.10) * 100).toFixed(4)}% p30=${(percentile(rates, 0.30) * 100).toFixed(4)}% p70=${(percentile(rates, 0.70) * 100).toFixed(4)}% p90=${(percentile(rates, 0.90) * 100).toFixed(4)}%`);
    console.log('');

    for (const bucket of buckets) {
      const events = funding.filter(f => bucket.test(f.rate));
      const row = { bucket: bucket.label, n: events.length };
      for (const h of horizons) {
        const returns = [];
        for (const ev of events) {
          const p0 = priceAt(candles, ev.time);
          const p1 = priceAt(candles, ev.time + h.ms);
          if (p0 && p1) returns.push((p1 - p0) / p0 * 100);
        }
        const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
        const sorted = [...returns].sort((a, b) => a - b);
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
        row[h.label] = mean != null ? `mean=${mean.toFixed(3)}% median=${median.toFixed(3)}%` : 'n/a';
      }
      console.log(JSON.stringify(row, null, 0));
    }
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
