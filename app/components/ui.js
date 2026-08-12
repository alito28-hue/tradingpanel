'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const THEME_KEY = 'tp-theme';

// Cada valor es una referencia a una custom property CSS (definida en
// globals.css para :root y :root[data-theme="light"]). Así el cambio de
// tema lo resuelve el navegador vía cascada CSS, sin depender de que React
// vuelva a renderizar cada página — lo cual no pasa de forma confiable acá,
// porque el árbol de páginas llega como `children` "congelado" desde el
// layout y React puede saltarse su re-render aunque cambie el contexto.
export const COLORS = {
  bg: 'var(--tp-bg)',
  panel: 'var(--tp-panel)',
  panelAlt: 'var(--tp-panel-alt)',
  border: 'var(--tp-border)',
  text: 'var(--tp-text)',
  muted: 'var(--tp-muted)',
  accent: 'var(--tp-accent)',
  onAccent: 'var(--tp-on-accent)',
  bull: 'var(--tp-bull)',
  bear: 'var(--tp-bear)',
  warning: 'var(--tp-warning)',
  neutral: 'var(--tp-neutral)',
};

// Para consumidores que no pueden usar var() (ej. lightweight-charts, que
// pinta en <canvas> y necesita un color resuelto de verdad).
export function resolveColors() {
  const style = getComputedStyle(document.documentElement);
  const get = name => style.getPropertyValue(name).trim();
  return {
    bg: get('--tp-bg'), panel: get('--tp-panel'), panelAlt: get('--tp-panel-alt'),
    border: get('--tp-border'), text: get('--tp-text'), muted: get('--tp-muted'),
    accent: get('--tp-accent'), onAccent: get('--tp-on-accent'),
    bull: get('--tp-bull'), bear: get('--tp-bear'), warning: get('--tp-warning'), neutral: get('--tp-neutral'),
  };
}

const ThemeContext = createContext(null);

function applyDom(t) {
  document.documentElement.dataset.theme = t;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState('dark');

  useEffect(() => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { /* no-op */ }
    if (saved === 'light' || saved === 'dark') {
      applyDom(saved);
      setThemeState(saved);
    }
  }, []);

  const setTheme = useCallback(t => {
    applyDom(t);
    setThemeState(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* no-op */ }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme debe usarse dentro de <ThemeProvider>');
  return ctx;
}

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button onClick={toggleTheme} title={isDark ? 'Modo claro' : 'Modo oscuro'} aria-label="Cambiar modo claro/oscuro" style={{
      position: 'fixed', bottom: 20, right: 20, zIndex: 999,
      width: 44, height: 44, borderRadius: '50%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: COLORS.panel, color: COLORS.text, border: `1px solid ${COLORS.border}`,
      fontSize: 18, cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
    }}>
      {isDark ? '☀️' : '🌙'}
    </button>
  );
}

export function inputStyle() {
  return {
    background: COLORS.panelAlt, border: `1px solid ${COLORS.border}`, color: COLORS.text,
    borderRadius: 6, padding: '6px 8px', fontSize: 13, fontFamily: 'inherit',
  };
}

// variant: true = filled accent (primary action), 'outline' = accent border/text
// on transparent background (secondary but worth calling out — e.g. "Bot →"),
// falsy = plain secondary (default gray border).
export function btnStyle(variant) {
  if (variant === 'outline') {
    return {
      display: 'flex', alignItems: 'center', gap: 6, background: 'transparent',
      color: COLORS.accent, border: `1px solid ${COLORS.accent}`,
      borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
    };
  }
  return {
    display: 'flex', alignItems: 'center', gap: 6, background: variant ? COLORS.accent : COLORS.panelAlt,
    color: variant ? COLORS.onAccent : COLORS.text, border: `1px solid ${variant ? COLORS.accent : COLORS.border}`,
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
