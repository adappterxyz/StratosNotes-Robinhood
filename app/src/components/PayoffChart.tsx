import { simulatePerf, totalPerUnit, type ProductParams } from '@sn/core';

/**
 * Payout per 100 of face against the final performance (% of strike; the worst
 * performer for a basket), assuming the note is not called earlier and earlier
 * observations sat just below the autocall level.
 */
export default function PayoffChart({ params }: { params: ProductParams }) {
  const W = 520,
    H = 220,
    L = 44,
    R = 12,
    T = 12,
    B = 30;
  const xs = Array.from({ length: 121 }, (_, i) => 20 + i); // 20%..140% of strike
  const n = params.observations;
  const ys = xs.map((x) => {
    const before = new Array(n - 1).fill(Math.min(0.9999, (params.autocallLevelPct ?? 100) / 100 - 0.0001));
    return 100 * totalPerUnit(simulatePerf(params, [...before, x / 100]));
  });
  const yMax = Math.max(120, Math.ceil(Math.max(...ys) / 10) * 10),
    yMin = 0;
  const sx = (x: number) => L + ((x - 20) / 120) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
  const path = xs.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join(' ');
  const area = `${path} L${sx(140)},${sy(0)} L${sx(20)},${sy(0)} Z`;
  const yTicks = Array.from({ length: Math.floor(yMax / 20) + 1 }, (_, i) => i * 20);
  const marks = [params.knockInBarrierPct, params.couponBarrierPct, params.autocallLevelPct].filter(
    (v): v is number => !!v,
  );
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Payout per 100 of face against the final ${params.underlyings.length > 1 ? 'worst performance' : 'level'}`}
    >
      {yTicks.map((y) => (
        <g key={y}>
          <line x1={L} x2={W - R} y1={sy(y)} y2={sy(y)} stroke="hsl(var(--border))" />
          <text x={L - 6} y={sy(y) + 4} textAnchor="end">
            {y}
          </text>
        </g>
      ))}
      {[20, 40, 60, 80, 100, 120, 140].map((x) => (
        <text key={x} x={sx(x)} y={H - 10} textAnchor="middle">
          {x}%
        </text>
      ))}
      {[...new Set(marks)].map((m) => (
        <line key={m} x1={sx(m)} x2={sx(m)} y1={T} y2={H - B} stroke="hsl(var(--accent) / 0.6)" strokeDasharray="3 3" />
      ))}
      <path d={area} fill="hsl(var(--accent) / 0.12)" />
      <path d={path} fill="none" stroke="hsl(var(--accent))" strokeWidth="2.5" />
      <line x1={L} x2={W - R} y1={sy(100)} y2={sy(100)} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 4" />
    </svg>
  );
}
