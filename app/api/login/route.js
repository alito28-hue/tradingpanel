import { createToken, COOKIE_NAME, MAX_AGE_SECONDS } from '../../../lib/session';

export async function POST(request) {
  const { password } = await request.json().catch(() => ({}));
  const expected = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  if (!expected || !secret) {
    return Response.json({ error: 'DASHBOARD_PASSWORD / SESSION_SECRET no configurados en el servidor' }, { status: 500 });
  }
  if (password !== expected) {
    return Response.json({ error: 'Contraseña incorrecta' }, { status: 401 });
  }

  const res = Response.json({ ok: true });
  res.headers.append('Set-Cookie', [
    `${COOKIE_NAME}=${createToken(secret)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SECONDS}`,
  ].join('; '));
  return res;
}
