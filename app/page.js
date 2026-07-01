import Link from 'next/link';
import { COLORS } from './components/ui';

export default function Home() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: COLORS.bg, color: COLORS.text,
    }}>
      <div style={{ width: '100%', maxWidth: 480, padding: '48px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.accent, textTransform: 'uppercase' }}>TradingPanel</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: '8px 0 0' }}>Intraday Momentum</h1>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Link href="/dashboard" style={cardStyle()}>
            <div style={{ fontWeight: 600 }}>Dashboard</div>
            <div style={{ fontSize: 13, color: COLORS.muted }}>Señales en vivo sobre datos de Binance (1H/1M)</div>
          </Link>
          <Link href="/backtest" style={cardStyle()}>
            <div style={{ fontWeight: 600 }}>Backtest</div>
            <div style={{ fontSize: 13, color: COLORS.muted }}>Backtest interactivo sobre histórico real</div>
          </Link>
        </div>
      </div>
    </div>
  );
}

function cardStyle() {
  return {
    display: 'block', textDecoration: 'none', color: COLORS.text,
    background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16,
  };
}
