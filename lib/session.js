// Shared by middleware.js and the login/logout API routes. Signed (not just
// hashed) so a leaked cookie eventually expires instead of being a
// forever-valid bearer token, and so the raw password never needs to travel
// anywhere but the initial login POST.
const crypto = require('crypto');

const COOKIE_NAME = 'tp_auth';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createToken(secret) {
  const payload = String(Date.now() + MAX_AGE_SECONDS * 1000);
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;

  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const exp = Number(payload);
  return Number.isFinite(exp) && Date.now() < exp;
}

module.exports = { COOKIE_NAME, MAX_AGE_SECONDS, createToken, verifyToken };
