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

// side: 'BUY' | 'SELL'. positionSide 'BOTH' assumes one-way mode (not hedge),
// which is sufficient since the bot only ever holds one position at a time.
async function placeLimitEntry({ symbol, side, quantity, price }) {
  const order = { symbol, side, positionSide: 'BOTH', type: 'LIMIT', quantity, price };
  return runOrDryRun('placeLimitEntry', order, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/order', order));
}

async function placeStopLoss({ symbol, side, quantity, stopPrice }) {
  const order = { symbol, side, positionSide: 'BOTH', type: 'STOP_MARKET', quantity, stopPrice, reduceOnly: true };
  return runOrDryRun('placeStopLoss', order, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/order', order));
}

// trailPct is a plain percentage (e.g. 0.25 for 0.25%); BingX's priceRate is
// the same value on a 0-1 scale.
async function placeTrailingStop({ symbol, side, quantity, activationPrice, trailPct }) {
  const order = {
    symbol, side, positionSide: 'BOTH', type: 'TRAILING_STOP_MARKET', quantity,
    activationPrice, priceRate: trailPct / 100, reduceOnly: true,
  };
  return runOrDryRun('placeTrailingStop', order, () =>
    signedRequest('POST', '/openApi/swap/v2/trade/order', order));
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
};
