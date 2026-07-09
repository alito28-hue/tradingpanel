import { COOKIE_NAME } from '../../../lib/session';

// Triggered by a plain HTML <form method="POST"> (full page navigation), not
// a client-side fetch — so redirect back to /login instead of returning JSON.
// Built manually (not Response.redirect()) since that helper returns a
// Response with immutable headers — appending Set-Cookie to it throws.
export async function POST(request) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL('/login', request.url).toString(),
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}
