'use client';

import { usePathname } from 'next/navigation';

export default function LogoutLink() {
  const pathname = usePathname();
  if (pathname === '/login') return null;

  return (
    <form action="/api/logout" method="POST" style={{ position: 'fixed', top: 10, right: 12, zIndex: 1000 }}>
      <button type="submit" style={{
        background: 'transparent', border: 'none', color: '#8B91A0', fontSize: 11,
        cursor: 'pointer', textDecoration: 'underline', padding: 0, fontFamily: 'inherit',
      }}>Cerrar sesión</button>
    </form>
  );
}
