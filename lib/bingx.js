// Server-side only. Never import this from a Next.js client component or
// expose BINGX_API_KEY / BINGX_API_SECRET via NEXT_PUBLIC_ variables.
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

async function getPrice(symbol) {
  const res = await fetch(`${BASE_URL}/openApi/swap/v2/quote/price?symbol=${symbol}`);
  if (!res.ok) throw new Error(`BingX price fetch failed (${res.status})`);
  return res.json();
}

// Placeholder — real order execution (signing, balances) is intentionally
// not implemented yet. This is scaffolding for the worker; live trading
// needs its own dedicated pass with explicit review before real money moves.
async function placeOrder(order) {
  requireCredentials();
  if (isDryRun()) {
    console.log('[DRY_RUN] would place order:', order);
    return { dryRun: true, order };
  }
  throw new Error('Live order execution is not implemented yet — set DRY_RUN=true');
}

module.exports = { getPrice, placeOrder, isDryRun };
