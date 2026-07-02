async function fetchKlines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance fetch failed (${res.status})`);
  const raw = await res.json();
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty response');
  return raw.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    takerBuyVolume: parseFloat(k[9]),
  }));
}

async function fetchKlinesPaged(symbol, interval, startTime, endTime, onProgress) {
  let all = [];
  let curEnd = endTime;
  let batches = 0;
  while (curEnd > startTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${curEnd}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance fetch failed (${res.status})`);
    const raw = await res.json();
    if (!raw.length) break;
    const batch = raw.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: k[6], takerBuyVolume: +k[9] }));
    all = batch.concat(all);
    batches++;
    if (onProgress) onProgress(batches, interval);
    if (batch[0].time <= startTime) break;
    curEnd = batch[0].time - 1;
    await new Promise(r => setTimeout(r, 120));
  }
  return all.filter(c => c.time >= startTime && c.time <= endTime);
}

function generateMockCandles(count, intervalMs, startPrice) {
  const now = Date.now();
  let price = startPrice;
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const time = now - i * intervalMs;
    const drift = Math.sin(i / 18) * 0.0018 + (Math.random() - 0.5) * 0.0045;
    const open = price;
    price = Math.max(1, price * (1 + drift));
    const close = price;
    const high = Math.max(open, close) * (1 + Math.random() * 0.0015);
    const low = Math.min(open, close) * (1 - Math.random() * 0.0015);
    const volume = 10 + Math.random() * 90;
    const buyBias = close >= open ? 0.5 + Math.random() * 0.3 : 0.5 - Math.random() * 0.3;
    out.push({ time, open, high, low, close, volume, closeTime: time + intervalMs - 1, takerBuyVolume: volume * buyBias });
  }
  return out;
}

module.exports = { fetchKlines, fetchKlinesPaged, generateMockCandles };
