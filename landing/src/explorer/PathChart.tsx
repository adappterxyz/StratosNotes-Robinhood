import { useEffect, useRef, useState } from 'react';
import { clamp, HI, LO, MONTHS, N, type Terms } from './model';

// Drawn at the container's own pixel size, so labels stay readable on a phone instead of shrinking with a fixed viewBox.
const PL = 44,
  PR = 40,
  PT = 26,
  PB = 40;

export const LINE_COLORS = ['var(--purple)', 'var(--cyan)', 'var(--amber)'];

interface Props {
  terms: Terms;
  paths: number[][];
  worstIdx: number[];
  calledAt?: number;
  coupons: number[];
  onMove: (path: number, k: number, v: number) => void;
}

/** Level lines drawn to scale; labels pushed apart so close barriers stay readable. */
function levels(t: Terms, y: (v: number) => number) {
  const ls: Array<{ v: number; label: string; cls: string }> = [];
  const add = (v: number, label: string, cls: string) => {
    const same = ls.find((l) => l.v === v);
    if (same) same.label += ` · ${label}`;
    else ls.push({ v, label, cls });
  };
  add(100, 'Strike', 'strike');
  if (t.type === 'fcn' || t.type === 'phoenix' || t.type === 'snowball')
    add(t.autocall, `Autocall ${t.autocall}%`, 'call');
  if (t.type === 'phoenix') add(t.couponBarrier, `Coupon barrier ${t.couponBarrier}%`, 'coupon');
  if (t.type !== 'ppn') add(t.knockIn, `Knock-in ${t.knockIn}%`, 'ki');
  const sorted = [...ls].sort((a, b) => b.v - a.v).map((l) => ({ ...l, ly: y(l.v) - 5 }));
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].ly - sorted[i - 1].ly < 13) sorted[i].ly = sorted[i - 1].ly + 13;
  return sorted;
}

export default function PathChart({ terms, paths, worstIdx, calledAt, coupons, onMove }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(300, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 520 ? 300 : 340;
  const x = (k: number) => PL + (k / N) * (W - PL - PR);
  const y = (v: number) => PT + ((HI - v) / (HI - LO)) * (H - PT - PB);
  const fromY = (py: number) => HI - ((py - PT) / (H - PT - PB)) * (HI - LO);
  const narrow = W < 520;
  const drag = useRef<{ p: number; k: number } | null>(null);
  const multi = paths.length > 1;

  const toLevel = (clientY: number) => {
    const r = svg.current!.getBoundingClientRect();
    return clamp(Math.round(fromY(((clientY - r.top) / r.height) * H)), LO, HI);
  };
  const onDown = (p: number, k: number) => (e: React.PointerEvent<SVGGElement>) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { p, k };
    onMove(p, k, toLevel(e.clientY));
  };
  const onMoveP = (e: React.PointerEvent<SVGGElement>) => {
    if (drag.current) onMove(drag.current.p, drag.current.k, toLevel(e.clientY));
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (p: number, k: number, v: number) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const nv =
      e.key === 'ArrowUp' || e.key === 'ArrowRight'
        ? v + step
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft'
          ? v - step
          : e.key === 'PageUp'
            ? v + 10
            : e.key === 'PageDown'
              ? v - 10
              : e.key === 'Home'
                ? LO
                : e.key === 'End'
                  ? HI
                  : null;
    if (nv === null) return;
    e.preventDefault();
    onMove(p, k, clamp(nv, LO, HI));
  };

  const ticks = [40, 60, 80, 100, 120, 140, 160];
  const last = calledAt ?? N;
  return (
    <div ref={wrap} className="pchart-wrap">
      <svg
        ref={svg}
        className="pchart"
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label="Price path, as a percentage of strike. Drag a point, or focus it and use the arrow keys."
      >
        <rect x={PL} y={PT} width={W - PL - PR} height={H - PT - PB} className="plot" />
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PL - 8} y={y(v) + 4} className="tick" textAnchor="end">
              {v}%
            </text>
          </g>
        ))}
        {calledAt && (
          <rect x={x(calledAt)} y={PT} width={W - PR - x(calledAt)} height={H - PT - PB} className="after-call" />
        )}
        {levels(terms, y).map((l) => (
          <g key={l.v}>
            <line x1={PL} x2={W - PR} y1={y(l.v)} y2={y(l.v)} className={`lvl ${l.cls}`} />
            <text x={PL + 6} y={l.ly} className={`lvl-label ${l.cls}`}>
              {l.label}
            </text>
          </g>
        ))}
        <text x={x(0)} y={H - PB + 18} className="tick" textAnchor="middle">
          Strike
        </text>
        {MONTHS.map((m, i) => (
          <text
            key={m}
            x={x(i + 1)}
            y={H - PB + 18}
            className={`tick${i + 1 > last ? ' faded' : ''}`}
            textAnchor="middle"
          >
            {narrow ? `M${m}` : `Obs ${i + 1} · M${m}`}
          </text>
        ))}
        {paths.map((path, p) => {
          const isWorstAtEnd = multi && worstIdx[last - 1] === p;
          const d = `M ${x(0)} ${y(100)} ` + path.map((v, k) => `L ${x(k + 1)} ${y(v)}`).join(' ');
          return (
            <path
              key={p}
              d={d}
              className={`path${multi && !isWorstAtEnd ? ' dim' : ''}`}
              style={{ stroke: LINE_COLORS[p] }}
            />
          );
        })}
        {coupons.map(
          (c, k) =>
            k < last &&
            c > 0 && (
              <text key={k} x={x(k + 1)} y={PT - 8} className="coupon-mark" textAnchor="middle">
                +{(c * 100).toFixed(2).replace(/\.?0+$/, '')}%
              </text>
            ),
        )}
        {calledAt && (
          <text x={x(calledAt) + 6} y={H - PB - 8} className="call-mark">
            called
          </text>
        )}
        {paths.map((path, p) =>
          path.map((v, k) => {
            const worst = multi && worstIdx[k] === p;
            return (
              <g
                key={`${p}-${k}`}
                className={`handle${k + 1 > last ? ' after' : ''}`}
                tabIndex={0}
                role="slider"
                aria-label={`${terms.syms[p]} at observation ${k + 1}`}
                aria-valuemin={LO}
                aria-valuemax={HI}
                aria-valuenow={v}
                aria-valuetext={`${v}% of strike`}
                onPointerDown={onDown(p, k)}
                onPointerMove={onMoveP}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onKeyDown={onKey(p, k, v)}
              >
                <circle cx={x(k + 1)} cy={y(v)} r={18} className="hit" />
                <circle
                  cx={x(k + 1)}
                  cy={y(v)}
                  r={worst ? 8 : 6.5}
                  className="dot"
                  style={{ stroke: LINE_COLORS[p], fill: worst ? LINE_COLORS[p] : 'var(--bg-0)' }}
                />
                {!multi && (
                  <text x={x(k + 1)} y={y(v) - 13} className="val" textAnchor="middle">
                    {v}%
                  </text>
                )}
              </g>
            );
          }),
        )}
      </svg>
    </div>
  );
}
