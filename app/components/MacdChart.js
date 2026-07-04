import { COLORS } from './ui';

export default function MacdChart({ macdLine, signalLine, height = 100 }) {
  if (!macdLine || macdLine.length < 2) return null;
  const width = 1000;
  const pad = { top: 10, right: 56, bottom: 6, left: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const n = macdLine.length;
  const slot = innerW / n;
  const barW = Math.max(1.4, slot * 0.62);

  const histogram = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  const vals = [...macdLine, ...signalLine, ...histogram].filter(v => v != null).map(Math.abs);
  const maxAbs = Math.max(...vals, 1);

  const xAt = i => pad.left + i * slot + slot / 2;
  const yAt = v => pad.top + innerH / 2 - (v / maxAbs) * (innerH / 2);
  const zeroY = yAt(0);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height, display: 'block' }}>
      <line x1={pad.left} x2={width - pad.right} y1={zeroY} y2={zeroY} stroke={COLORS.border} strokeWidth={1} />
      <text x={width - pad.right + 6} y={zeroY + 3} fontSize="10" fill={COLORS.muted} fontFamily="JetBrains Mono, monospace">0</text>

      {histogram.map((v, i) => {
        if (v == null) return null;
        const y = v >= 0 ? yAt(v) : zeroY;
        const h = Math.max(1, Math.abs(zeroY - yAt(v)));
        return <rect key={i} x={xAt(i) - barW / 2} y={y} width={barW} height={h} fill={v >= 0 ? COLORS.bull : COLORS.bear} opacity={0.5} />;
      })}

      <polyline fill="none" stroke={COLORS.accent} strokeWidth={1.4}
        points={macdLine.map((v, i) => v != null ? `${xAt(i)},${yAt(v)}` : null).filter(Boolean).join(' ')} />
      <polyline fill="none" stroke="#5B8DEF" strokeWidth={1.2}
        points={signalLine.map((v, i) => v != null ? `${xAt(i)},${yAt(v)}` : null).filter(Boolean).join(' ')} />
    </svg>
  );
}
