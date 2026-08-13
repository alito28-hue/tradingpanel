'use client';

import Link from 'next/link';
import { COLORS, btnStyle } from '../components/ui';
import LogoutLink from '../components/LogoutLink';

export default function PlaybookPage() {
  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: '100%' }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 20, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}`,
        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.12em', color: COLORS.muted, textTransform: 'uppercase' }}>Documento</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>Playbook · Reacción en Liquidez Diaria</div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Link href="/dashboard" style={{ ...btnStyle(), textDecoration: 'none' }}>← Dashboard</Link>
          <Link href="/bitacora" style={{ ...btnStyle(), textDecoration: 'none' }}>Bitácora →</Link>
          <a href="/playbook/estrategia-btc-playbook.html" target="_blank" rel="noreferrer" style={{ ...btnStyle(), textDecoration: 'none' }}>
            Ver documento
          </a>
          <a href="/playbook/playbook_btc_smith.pdf" target="_blank" rel="noreferrer" style={{ ...btnStyle(), textDecoration: 'none' }}>
            Descargar PDF
          </a>
          <a href="/api/playbook/export-pdf" style={{ ...btnStyle(true), textDecoration: 'none' }}>
            Exportar PDF
          </a>
          <LogoutLink />
        </div>
      </div>

      <iframe
        src="/playbook/estrategia-btc-playbook.html"
        title="Playbook BTC"
        style={{ width: '100%', height: 'calc(100vh - 65px)', border: 'none', background: '#e8e6e0' }}
      />
    </div>
  );
}
