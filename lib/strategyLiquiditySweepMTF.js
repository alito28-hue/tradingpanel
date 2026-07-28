// Turtle Soup / ICT-style liquidity sweep using REAL multi-timeframe levels
// (previous day high/low, previous week high/low, previous 4h candle,
// previous 1h candle) instead of a generic N-bar pivot on the entry
// timeframe — 2026-07-27 follow-up to yesterday's "Barrido" system (PF 0.27,
// the worst result of that session), testing whether stricter, more
// widely-watched levels change the outcome. Day/week boundaries are UTC
// midnight / Monday — BTC trades 24/7 so there's no exchange-session
// convention to anchor to instead.
const { ema } = require('./strategy');

const DAY_MS = 86400000;

function dayKey(t) { return Math.floor(t / DAY_MS); }
function weekKey(t) {
  // ISO-ish: days since a Monday epoch. Jan 5 1970 was a Monday.
  const days = Math.floor(t / DAY_MS) - 3; // Jan 1 1970 was Thursday; -3 aligns Monday=0
  return Math.floor(days / 7);
}

// Builds one high/low pair per aggregation key from source candles (assumed
// time-ordered, non-overlapping). keyFn maps a candle's time to its bucket.
function aggregate(candles, keyFn) {
  const buckets = new Map();
  for (const c of candles) {
    const k = keyFn(c.time);
    let b = buckets.get(k);
    if (!b) { b = { key: k, high: c.high, low: c.low, closeTime: c.closeTime }; buckets.set(k, b); }
    else { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.closeTime = c.closeTime; }
  }
  return [...buckets.values()].sort((a, b) => a.key - b.key);
}

// For each entry candle, the most recently CLOSED bucket's high/low as of
// that candle's time (no look-ahead) — two-pointer scan since both arrays
// are time-ordered.
function alignPreviousBucket(entryCandles, buckets) {
  const out = new Array(entryCandles.length).fill(null);
  let idx = -1;
  for (let i = 0; i < entryCandles.length; i++) {
    while (idx + 1 < buckets.length && buckets[idx + 1].closeTime < entryCandles[i].time) idx++;
    out[i] = idx >= 0 ? buckets[idx] : null;
  }
  return out;
}

function computeTrend(candles, emaFastLen, emaSlowLen) {
  const closes = candles.map(c => c.close);
  const emaF = ema(closes, emaFastLen);
  const emaS = ema(closes, emaSlowLen);
  const trendUp = new Array(candles.length).fill(false);
  const trendDn = new Array(candles.length).fill(false);
  for (let i = 3; i < candles.length; i++) {
    if (emaF[i] == null || emaS[i] == null || emaF[i - 3] == null) continue;
    trendUp[i] = emaF[i] > emaS[i] && emaF[i] > emaF[i - 3];
    trendDn[i] = emaF[i] < emaS[i] && emaF[i] < emaF[i - 3];
  }
  return { trendUp, trendDn };
}

// cfg: { candles1h (for aggregation), useTrendFilter, emaFastLen, emaSlowLen,
//   wickRejectionPct (default 0.4), levelTypes: subset of ['PDH_PDL','PWH_PWL','H4','H1'] }
function buildLiquiditySweepEntries(entryCandles, candles1h, cfg) {
  const dayBuckets = aggregate(candles1h, c => dayKey(c));
  const weekBuckets = aggregate(candles1h, c => weekKey(c));
  const h4Buckets = aggregate(candles1h, c => Math.floor(c / (4 * 3600000)));
  const h1Buckets = candles1h.map(c => ({ high: c.high, low: c.low, closeTime: c.closeTime }));

  const prevDay = alignPreviousBucket(entryCandles, dayBuckets);
  const prevWeek = alignPreviousBucket(entryCandles, weekBuckets);
  const prevH4 = alignPreviousBucket(entryCandles, h4Buckets);
  const prevH1 = alignPreviousBucket(entryCandles, h1Buckets);

  const { trendUp, trendDn } = computeTrend(entryCandles, cfg.emaFastLen, cfg.emaSlowLen);
  const wickPct = cfg.wickRejectionPct != null ? cfg.wickRejectionPct : 0.4;
  const levelSources = {
    PDH_PDL: prevDay, PWH_PWL: prevWeek, H4: prevH4, H1: prevH1,
  };

  const entries = [];
  const usedIndex = new Set();
  // Tracks the last bucket `key` (day/week) or closeTime (H4/H1) already
  // swept per level type + side, so the same level isn't faded repeatedly
  // within its own period, but a new period's level can be.
  const sweptHigh = { PDH_PDL: null, PWH_PWL: null, H4: null, H1: null };
  const sweptLow = { PDH_PDL: null, PWH_PWL: null, H4: null, H1: null };

  for (let i = 0; i < entryCandles.length; i++) {
    const c = entryCandles[i];
    const rng = c.high - c.low;
    if (rng <= 0) continue;
    const wTop = c.high - Math.max(c.open, c.close);
    const wBot = Math.min(c.open, c.close) - c.low;

    for (const type of (cfg.levelTypes || ['PDH_PDL', 'PWH_PWL', 'H4', 'H1'])) {
      const level = levelSources[type][i];
      if (!level) continue;
      const bucketId = level.key != null ? level.key : level.closeTime;

      const sweepHighNow = c.high > level.high && c.close < level.high && wTop >= rng * wickPct && sweptHigh[type] !== bucketId;
      const sweepLowNow = c.low < level.low && c.close > level.low && wBot >= rng * wickPct && sweptLow[type] !== bucketId;

      const sweepShort = sweepHighNow && (!cfg.useTrendFilter || !trendUp[i]);
      const sweepLong = sweepLowNow && (!cfg.useTrendFilter || !trendDn[i]);

      if (sweepShort) {
        sweptHigh[type] = bucketId;
        if (!usedIndex.has(i)) {
          const midR = (level.high + level.low) / 2;
          const entry = { index: i, type: 'short', system: 'SWEEP_' + type, entryPrice: c.close, stopPrice: c.high * 1.001, targetPrice: midR, targetPrice2: level.low };
          if (entry.stopPrice > entry.entryPrice && entry.targetPrice < entry.entryPrice) { entries.push(entry); usedIndex.add(i); }
        }
      }
      if (sweepLong) {
        sweptLow[type] = bucketId;
        if (!usedIndex.has(i)) {
          const midR = (level.high + level.low) / 2;
          const entry = { index: i, type: 'long', system: 'SWEEP_' + type, entryPrice: c.close, stopPrice: c.low * 0.999, targetPrice: midR, targetPrice2: level.high };
          if (entry.stopPrice < entry.entryPrice && entry.targetPrice > entry.entryPrice) { entries.push(entry); usedIndex.add(i); }
        }
      }
    }
  }

  entries.sort((a, b) => a.index - b.index);
  return { entries };
}

module.exports = { buildLiquiditySweepEntries, aggregate, alignPreviousBucket };
