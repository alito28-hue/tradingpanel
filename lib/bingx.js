// Server-side only. Never import this from a Next.js client component or
// expose BINGX_API_KEY / BINGX_API_SECRET via NEXT_PUBLIC_ variables.
//
// Signing scheme, endpoint paths, and order field names verified against the
// ccxt library's BingX implementation (ccxt/ts/src/bingx.ts), not marketing
// docs: HMAC-SHA256 over the alphabetically-sorted, urlencoded query string
// (including `timestamp`), sent as `X-BX-APIKEY` header + `&signature=` on
// the URL — including for POST requests, which BingX's swap trade endpoints
// take as query params rather than a JSON body.
const crypto = require('crypto');

const BASE_URL = 'https://open-api.bingx.com';

function isDryRun() {
  return process.env.DRY_RUN !== 'false';
}

function requireCredentials() {
  const apiKey = process.env.BINGX_API_KEY;
  const apiSecret = process.env.BINGX_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('Missing BINGX_API_KEY/BINGX_API_SECRET environment variables');
  }
  return { apiKey, apiSecret };
}

function sign(params, secret) {
  const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return { query, signature };
}

async function signedRequest(method, path, params = {}) {
  const { apiKey, apiSecret } = requireCredentials();
  const fullParams = { ...params, timestamp: Date.now() };
  const { query, signature } = sign(fullParams, apiSecret);
  const url = `${BASE_URL}${path}?${query}&signature=${signature}`;
  const res = await fetch(url, { method, headers: { 'X-BX-APIKEY': apiKey } });
  const body = await res.json();
  if (!res.ok || body.code !== 0) {
    throw new Error(`BingX ${method} ${path} failed: ${body.code} ${body.msg || res.statusText}`);
  }
  return body.data;
}

async function getPrice(symbol) {
  const res = await fetch(`${BASE_URL}/openApi/swap/v2/quote/price?symbol=${symbol}`);
  if (!res.ok) throw new Error(`BingX price fetch failed (${res.status})`);
  return res.json();
}

async function getBalance() {
  return signedRequest('GET', '/openApi/swap/v2/user/balance');
}

async function getPositions(symbol) {
  return signedRequest('GET', '/openApi/swap/v2/user/positions', symbol ? { symbol } : {});
}

async function setLeverage(symbol, side, leverage) {
  return runOrDryRun('setLeverage', { symbol, side, leverage }, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/leverage', { symbol, side, leverage }));
}

async function getOrder(symbol, orderId) {
  return signedRequest('GET', '/openApi/swap/v2/trade/order', { symbol, orderId });
}

// Used on worker startup to recover state after a restart — BingX is the
// source of truth for what orders actually exist, not any local cache.
async function getOpenOrders(symbol) {
  return signedRequest('GET', '/openApi/swap/v2/trade/openOrders', { symbol });
}

async function cancelOrder(symbol, orderId) {
  return runOrDryRun('cancelOrder', { symbol, orderId }, () =>
    signedRequest('DELETE', '/openApi/swap/v2/trade/order', { symbol, orderId }));
}

async function runOrDryRun(label, order, real) {
  if (isDryRun()) {
    console.log(`[DRY_RUN] ${label}:`, order);
    return { dryRun: true, label, order };
  }
  return real();
}

// side: 'BUY' | 'SELL'. positionSide: 'LONG' | 'SHORT' — the position bucket
// being opened or closed, always the trade's direction (for exits too: a
// SHORT close still uses positionSide 'SHORT' even though side is 'BUY').
// This account is in BingX Hedge Mode, which rejects anything but LONG/SHORT
// here (previously hardcoded 'BOTH', which is only valid in One-way mode —
// every real order failed with BingX error 109400 until this was fixed).
async function placeLimitEntry({ symbol, side, positionSide, quantity, price }) {
  const order = { symbol, side, positionSide, type: 'LIMIT', quantity, price };
  return runOrDryRun('placeLimitEntry', order, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/order', order));
}

async function placeStopLoss({ symbol, side, positionSide, quantity, stopPrice }) {
  const order = { symbol, side, positionSide, type: 'STOP_MARKET', quantity, stopPrice, reduceOnly: true };
  return runOrDryRun('placeStopLoss', order, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/order', order));
}

// trailPct is a plain percentage (e.g. 0.25 for 0.25%); BingX's priceRate is
// the same value on a 0-1 scale.
async function placeTrailingStop({ symbol, side, positionSide, quantity, activationPrice, trailPct }) {
  const order = {
    symbol, side, positionSide, type: 'TRAILING_STOP_MARKET', quantity,
    activationPrice, priceRate: trailPct / 100, reduceOnly: true,
  };
  return runOrDryRun('placeTrailingStop', order, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/order', order));
}

// Reduce-only counterpart to placeLimitEntry — used for Saylor's full-close
// exits (take-profit / circuit breaker). Always LIMIT, never MARKET: per
// explicit instruction, every Saylor order (adds and exits alike) must be a
// limit order placed very close to price (a "marketable" limit — close
// enough to fill almost immediately) rather than a true market order, to
// cap worst-case slippage. See worker/runSaylor.js for how the price is
// computed (current mark price ± a small offset in the direction that
// crosses the book).
async function placeLimitExit({ symbol, side, positionSide, quantity, price }) {
  const order = { symbol, side, positionSide, type: 'LIMIT', quantity, price, reduceOnly: true };
  return runOrDryRun('placeLimitExit', order, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/order', order));
}

// Must be called once before Saylor opens a cycle — nothing in this file
// previously set margin mode (only setLeverage), and the whole strategy
// depends on isolated margin (addIsolatedMargin below only makes sense
// isolated; in cross margin "margin per position" isn't a real concept).
// Non-fatal by convention at the call site: BingX rejects changing margin
// mode while a position is open, which usually just means it's already
// correct — callers should catch and log, not crash the loop over it.
async function setMarginMode({ symbol, marginType }) {
  return runOrDryRun('setMarginMode', { symbol, marginType }, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/marginType', { symbol, marginType }));
}

// Injects isolated margin into an EXISTING position without adding contracts
// — BingX's positionMargin endpoint, type 1 = add (2 = reduce, unused here).
// This is the "a margen" tranche destination in the Saylor rules, distinct
// from placeLimitEntry ("a posición", which does add contracts).
async function addIsolatedMargin({ symbol, positionSide, amount }) {
  const params = { symbol, positionSide, amount, type: 1 };
  return runOrDryRun('addIsolatedMargin', params, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/positionMargin', params));
}

// Live floating ROI% for one open position — Saylor's tick loop polls this
// instead of analyzing candles. ROI% = unrealized PnL ÷ the margin BingX
// currently has committed to the position (not the bot's local bala
// bookkeeping), because addIsolatedMargin tranches only make sense if ROI%
// is computed off the same live number they change.
//
// Field names below (unrealizedProfit/margin/avgPrice) match BingX's
// documented /openApi/swap/v2/user/positions response — confirm against a
// real populated position the first time a Saylor cycle actually opens one
// (this repo had zero open positions when this was written) and adjust here
// if BingX's real payload differs.
async function getPositionRoiPct({ symbol, positionSide }) {
  const positions = await getPositions(symbol);
  const pos = (positions || []).find(p => p.positionSide === positionSide && Math.abs(Number(p.positionAmt)) > 0);
  if (!pos) return null; // no open position for this side — caller treats as idle
  const unrealizedProfitUsd = Number(pos.unrealizedProfit);
  const marginUsd = Number(pos.margin ?? pos.isolatedMargin ?? pos.initialMargin);
  if (!marginUsd) throw new Error(`getPositionRoiPct: no margin field on position response, got keys: ${Object.keys(pos).join(',')}`);
  return {
    roiPct: (unrealizedProfitUsd / marginUsd) * 100,
    unrealizedProfitUsd,
    marginUsd,
    markPrice: Number(pos.markPrice),
    avgPrice: Number(pos.avgPrice),
    positionAmt: Number(pos.positionAmt),
    raw: pos,
  };
}

module.exports = {
  isDryRun,
  getPrice,
  getBalance,
  getPositions,
  setLeverage,
  getOrder,
  getOpenOrders,
  cancelOrder,
  placeLimitEntry,
  placeStopLoss,
  placeTrailingStop,
  placeLimitExit,
  setMarginMode,
  addIsolatedMargin,
  getPositionRoiPct,
};
