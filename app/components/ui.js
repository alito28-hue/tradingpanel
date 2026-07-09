export const COLORS = {
  bg: '#111316',
  panel: '#1a1c1f',
  panelAlt: '#242830',
  border: '#37393d',
  text: '#e2e8f0',
  muted: '#64748b',
  accent: '#ccff00',
  bull: '#ccff00',
  bear: '#ff4d4d',
  warning: '#fb923c',
  neutral: '#5B6472',
};

export function inputStyle() {
  return {
    background: COLORS.panelAlt, border: `1px solid ${COLORS.border}`, color: COLORS.text,
    borderRadius: 6, padding: '6px 8px', fontSize: 13, fontFamily: 'inherit',
  };
}

export function btnStyle(primary) {
  return {
    display: 'flex', alignItems: 'center', gap: 6, background: primary ? COLORS.accent : COLORS.panelAlt,
    color: primary ? '#0F1400' : COLORS.text, border: `1px solid ${primary ? COLORS.accent : COLORS.border}`,
    borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  };
}

export function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 140 }}>
      <span style={{ fontSize: 11, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      {children}
    </div>
  );
}

export function NumberInput({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: COLORS.muted }}>{label}</span>
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ ...inputStyle(), width: 64 }} />
    </div>
  );
}

export function Panel({ title, subtitle, children }) {
  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        {subtitle && <span style={{ fontSize: 11, color: COLORS.muted }}>{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 600, color: color || COLORS.text }}>{value}</div>
    </div>
  );
}
