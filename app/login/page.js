'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { COLORS, inputStyle, btnStyle } from '../components/ui';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || `Error ${res.status}`); setLoading(false); return; }
      router.push(searchParams.get('next') || '/dashboard');
      router.refresh();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: COLORS.bg, color: COLORS.text,
    }}>
      <form onSubmit={handleSubmit} style={{
        width: '100%', maxWidth: 340, padding: 24, background: COLORS.panel,
        border: `1px solid ${COLORS.border}`, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/logo.png" width={32} height={32} alt="TradingPanel" />
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.accent, textTransform: 'uppercase' }}>TradingPanel</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>Iniciar sesión</div>
          </div>
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Contraseña"
          style={{ ...inputStyle(), width: '100%' }}
        />
        {error && <div style={{ color: COLORS.bear, fontSize: 12 }}>{error}</div>}
        <button type="submit" disabled={loading || !password} style={{ ...btnStyle(true), justifyContent: 'center', opacity: loading || !password ? 0.6 : 1 }}>
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
