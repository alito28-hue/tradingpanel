import { COLORS } from './ui';

export default function VolumeChart({ candles, delta, climax, divergence, height = 120 }) {
  if (!candles || candles.length < 2) return null;
  const width = 1000;
  const pad = { top: 10, right: 56, bottom: 6, left: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const n = candles.length;
  const slot = innerW / n;
  const barW = Math.max(1.4, slot * 0.62);

  const volumes = candles.map(c => c.volume || 0);
  const maxVol = Math.max(...volumes, 1);

  const xAt = i => pad.left + i * slot + slot / 2;
  const barHeight = v => (v / maxVol) * innerH;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height, display: 'block' }}>
      {candles.map((c, i) => {
        const isClimax = climax && climax[i];
        const up = !delta || delta[i] >= 0;
        const color = up ? COLORS.bull : COLORS.bear;
        const h = barHeight(c.volume || 0);
        const xC = xAt(i);
        return (
          <rect key={i} x={xC - barW / 2} y={pad.top + innerH - h} width={barW} height={Math.max(1, h)}
            fill={color} opacity={isClimax ? 1 : 0.5}
            stroke={isClimax ? COLORS.accent : 'none'} strokeWidth={isClimax ? 1 : 0} />
        );
      })}

      {divergence && divergence.map((d, i) => {
        if (!d) return null;
        const xC = xAt(i);
        const isBullish = d === 'bullish';
        const fill = isBullish ? COLORS.bull : COLORS.bear;
        return (
          <g key={`div-${i}`} transform={`translate(${xC}, ${pad.top})`}>
            <polygon points={isBullish ? '-5,4 5,4 0,-4' : '-5,-4 5,-4 0,4'} fill={fill} />
          </g>
        );
      })}
    </svg>
  );
}
