// Meant to be placed inline inside each page's own header button cluster
// (not a global fixed overlay) — that was colliding with the real nav
// buttons ("Bot →", etc.) on wide headers.
export default function LogoutLink() {
  return (
    <form action="/api/logout" method="POST" style={{ display: 'flex', alignItems: 'center' }}>
      <button type="submit" style={{
        background: 'transparent', border: 'none', color: '#8B91A0', fontSize: 11,
        cursor: 'pointer', textDecoration: 'underline', padding: 0, fontFamily: 'inherit',
      }}>Cerrar sesión</button>
    </form>
  );
}
