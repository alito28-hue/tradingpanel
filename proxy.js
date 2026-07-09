import { NextResponse } from 'next/server';
import { COOKIE_NAME, verifyToken } from './lib/session';

// Denylist matcher (not an allowlist): every route is protected by default,
// only /login, /api/login, and static public assets (plus Next internals)
// are carved out. New routes added later — like the bot-mode toggle — stay
// protected without needing to remember to add them anywhere.
export const config = {
  matcher: '/((?!_next|favicon.ico|logo.png|login|api/login).*)',
};

export function proxy(request) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (verifyToken(token, process.env.SESSION_SECRET)) {
    return NextResponse.next();
  }
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}
