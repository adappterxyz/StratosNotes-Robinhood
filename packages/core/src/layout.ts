/**
 * Deterministic layout for generated BPMN collaborations (the DI only: positions never reach the compiled
 * definition, so a definition's content address does not depend on them).
 *
 * The note workflows are wide and branchy: every period has a funding check, a grace window, a margin call and
 * a default path, and every default path meets the same "Default" step. A fixed hand-placed grid cannot route
 * that cleanly, so the layout is computed from the graph:
 *
 *  1. Columns (layers): longest path over sequence flows and message flows (a message's target never sits left
 *     of its sender), back edges ignored. Columns are shared by every pool, so message flows run vertically.
 *  2. Rows, per pool: the happy path (the "spine": from the start, prefer the successor the caller hinted on
 *     row 0, then the longest remaining path) takes row 0. Everything else is cut into short chains (a branch
 *     and its continuation) and packed into the lowest row below that is free over the chain's columns.
 *  3. Routing: every shape sits in a cell; the gaps between columns and between rows are channels no shape
 *     enters. An edge takes the simplest orthogonal route that crosses no shape (straight, one bend, two bends)
 *     and otherwise runs through the channels: out of its source, along a row channel, into its target.
 *     Edges into the same target share their channel lanes, so converging paths merge into one line.
 *  4. Labels: gateway and event names, and branch names, are placed next to their element or the start of
 *     their edge, at the first candidate position that overlaps no shape and no other label.
 *
 * Hints (SpecNode.row, from the product generator or an earlier layout) only choose the spine; columns and rows
 * always come from the graph, so an edited workflow lays out as cleanly as a generated one.
 */

export interface LayoutNode {
  id: string;
  type: string;
  name: string;
  rowHint?: number;
}
export interface LayoutFlow {
  id: string;
  src: string;
  tgt: string;
  name?: string;
}
export interface LayoutPool {
  id: string;
  nodes: LayoutNode[];
  flows: LayoutFlow[];
}
export interface LayoutMessage {
  id: string;
  src: string;
  tgt: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Pt = [number, number];
export interface Layout {
  pools: Record<string, Box>;
  shapes: Record<string, Box>;
  edges: Record<string, Pt[]>;
  /** External labels (events, gateways and named flows). */
  labels: Record<string, Box>;
}

const COL_W = 210,
  ROW_H = 130,
  X0 = 220,
  POOL_X = 140,
  POOL_PAD = 15,
  POOL_GAP = 20,
  Y0 = 80,
  ESCROW_H = 60;
const SIZE: Record<string, [number, number]> = { task: [150, 80], event: [36, 36], gateway: [44, 44] };
export const kindOf = (t: string) =>
  t === 'startEvent' || t === 'endEvent' || t === 'intermediateCatchEvent'
    ? 'event'
    : t.endsWith('Gateway')
      ? 'gateway'
      : 'task';
const LANES = [0, 7, -7, 14, -14, 21, -21];
const LABEL_LINE = 14,
  LABEL_MAX_W = 110,
  CHAR_W = 5.6;

/** Width and height a label of `text` takes (bpmn-js external labels: 11px, wrapped). */
function labelSize(text: string, maxW = LABEL_MAX_W): [number, number] {
  const w = Math.ceil(text.length * CHAR_W) + 6;
  if (w <= maxW) return [Math.max(w, 24), LABEL_LINE];
  // Wrapped at word breaks, so allow a little slack per line.
  const lines = Math.ceil(w / (maxW - 8));
  return [maxW, LABEL_LINE * lines];
}

const overlaps = (a: Box, b: Box, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/** Does the axis-parallel segment p-q cross the inside of box b (grown by `pad`)? */
export function segmentHits(p: Pt, q: Pt, b: Box, pad = 2): boolean {
  const x0 = b.x - pad,
    x1 = b.x + b.w + pad,
    y0 = b.y - pad,
    y1 = b.y + b.h + pad;
  if (p[0] === q[0]) {
    const lo = Math.min(p[1], q[1]),
      hi = Math.max(p[1], q[1]);
    return p[0] > x0 && p[0] < x1 && hi > y0 && lo < y1;
  }
  const lo = Math.min(p[0], q[0]),
    hi = Math.max(p[0], q[0]);
  return p[1] > y0 && p[1] < y1 && hi > x0 && lo < x1;
}

export function layoutCollaboration(pools: LayoutPool[], messages: LayoutMessage[]): Layout {
  const nodes = pools.flatMap((p) => p.nodes);
  const poolOf = new Map<string, string>();
  for (const p of pools) for (const n of p.nodes) poolOf.set(n.id, p.id);
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const node = new Map(nodes.map((n) => [n.id, n]));
  const flows = pools.flatMap((p) => p.flows).filter((f) => node.has(f.src) && node.has(f.tgt));
  const msgs = messages.filter((m) => node.has(m.src) && node.has(m.tgt));

  // ---- 1. layers --------------------------------------------------------------------------------------
  const out = new Map<string, string[]>();
  const add = (a: string, b: string) => out.set(a, [...(out.get(a) ?? []), b]);
  for (const f of flows) add(f.src, f.tgt);
  // Back edges (cycles), found by a deterministic DFS, do not constrain the layers.
  const back = new Set<string>();
  const state = new Map<string, number>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out.get(id) ?? []) {
      if (state.get(t) === 1) back.add(`${id}>${t}`);
      else if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
  };
  const hasIn = new Set(flows.map((f) => f.tgt));
  for (const n of nodes) if (!hasIn.has(n.id) && !state.has(n.id)) visit(n.id);
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);
  // Constraints: flow target at least one column right; message target not left of its sender.
  const cons: Array<[string, string, number]> = [
    ...flows.filter((f) => !back.has(`${f.src}>${f.tgt}`)).map((f) => [f.src, f.tgt, 1] as [string, string, number]),
    ...msgs.map((m) => [m.src, m.tgt, 0] as [string, string, number]),
  ];
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  for (let iter = 0; iter <= nodes.length + 1; iter++) {
    let changed = false;
    for (const [a, b, d] of cons) {
      const want = layer.get(a)! + d;
      if (layer.get(b)! < want) {
        layer.set(b, want);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // ---- 2. rows ----------------------------------------------------------------------------------------
  const row = new Map<string, number>();
  const rowsOf = new Map<string, number>();
  for (const p of pools) {
    if (!p.nodes.length) {
      rowsOf.set(p.id, 0);
      continue;
    }
    const inPool = (id: string) => poolOf.get(id) === p.id;
    const succ = new Map<string, string[]>();
    for (const f of p.flows)
      if (inPool(f.src) && inPool(f.tgt) && layer.get(f.tgt)! > layer.get(f.src)!)
        succ.set(f.src, [...(succ.get(f.src) ?? []), f.tgt]);
    // Longest remaining path from each node (forward edges only).
    const depth = new Map<string, number>();
    const byLayerDesc = [...p.nodes].sort(
      (a, b) => layer.get(b.id)! - layer.get(a.id)! || order.get(a.id)! - order.get(b.id)!,
    );
    for (const n of byLayerDesc) depth.set(n.id, Math.max(0, ...(succ.get(n.id) ?? []).map((s) => depth.get(s)! + 1)));
    const pick = (cands: string[]) =>
      [...cands].sort(
        (a, b) =>
          (node.get(a)!.rowHint ?? 0) - (node.get(b)!.rowHint ?? 0) ||
          depth.get(b)! - depth.get(a)! ||
          order.get(a)! - order.get(b)!,
      )[0];
    const pIn = new Set(p.flows.filter((f) => inPool(f.src) && inPool(f.tgt)).map((f) => f.tgt));
    const starts = p.nodes.filter((n) => !pIn.has(n.id));
    const first = pick((starts.length ? starts : p.nodes).map((n) => n.id));
    const used = new Set<string>(); // `${row}:${layer}`
    for (let cur: string | undefined = first; cur;) {
      row.set(cur, 0);
      used.add(`0:${layer.get(cur)}`);
      const next: string[] = (succ.get(cur) ?? []).filter((s) => !row.has(s));
      cur = next.length ? pick(next) : undefined;
    }
    // Branches: chains of short hops, packed into the lowest free row.
    const rest = [...p.nodes]
      .filter((n) => !row.has(n.id))
      .sort((a, b) => layer.get(a.id)! - layer.get(b.id)! || order.get(a.id)! - order.get(b.id)!);
    let rows = 1;
    for (const n of rest) {
      if (row.has(n.id)) continue;
      const chain = [n.id];
      for (;;) {
        const cur = chain[chain.length - 1];
        const next = (succ.get(cur) ?? []).filter(
          (s) => !row.has(s) && !chain.includes(s) && layer.get(s)! - layer.get(cur)! <= 2,
        );
        if (!next.length) break;
        chain.push(pick(next));
      }
      const lo = layer.get(chain[0])!,
        hi = layer.get(chain[chain.length - 1])!;
      let r = 1;
      const free = (rr: number) => {
        for (let l = lo; l <= hi; l++) if (used.has(`${rr}:${l}`)) return false;
        return true;
      };
      while (!free(r)) r++;
      for (const id of chain) row.set(id, r);
      for (let l = lo; l <= hi; l++) used.add(`${r}:${l}`);
      rows = Math.max(rows, r + 1);
    }
    rowsOf.set(p.id, rows);
  }

  // ---- geometry ---------------------------------------------------------------------------------------
  const maxLayer = Math.max(0, ...nodes.map((n) => layer.get(n.id)!));
  const width = X0 - POOL_X + (maxLayer + 1) * COL_W + 10;
  const poolBox: Record<string, Box> = {};
  const shapes: Record<string, Box> = {};
  const center = new Map<string, Pt>();
  const rowY0 = new Map<string, number>(); // y of row 0's top boundary, per pool
  let y = Y0;
  for (const p of pools) {
    const rows = rowsOf.get(p.id)!;
    const h = p.nodes.length ? POOL_PAD * 2 + rows * ROW_H : ESCROW_H;
    poolBox[p.id] = { x: POOL_X, y, w: width, h };
    rowY0.set(p.id, y + POOL_PAD);
    for (const n of p.nodes) {
      const [w, hh] = SIZE[kindOf(n.type)];
      const cx = X0 + layer.get(n.id)! * COL_W + 75;
      const cy = y + POOL_PAD + Math.floor(ROW_H / 2) + row.get(n.id)! * ROW_H;
      center.set(n.id, [cx, cy]);
      shapes[n.id] = { x: cx - Math.floor(w / 2), y: cy - Math.floor(hh / 2), w, h: hh };
    }
    y += h + POOL_GAP;
  }
  const shapeList = Object.entries(shapes);
  const colRight = (id: string) => X0 + layer.get(id)! * COL_W + 150; // right edge of the column's cell
  const chanAfter = (id: string) => colRight(id) + Math.floor((COL_W - 150) / 2);
  const chanBefore = (id: string) => X0 + layer.get(id)! * COL_W - Math.floor((COL_W - 150) / 2);
  const rowBoundary = (id: string, below: boolean) =>
    rowY0.get(poolOf.get(id)!)! + (row.get(id)! + (below ? 1 : 0)) * ROW_H;

  const clear = (pts: Pt[], skip: Set<string>, within?: string) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      for (const [id, b] of shapeList) {
        if (skip.has(id) || (within && poolOf.get(id) !== within)) continue;
        if (segmentHits(pts[i], pts[i + 1], b)) return false;
      }
    }
    return true;
  };
  const tidy = (pts: Pt[]) => {
    const o: Pt[] = [];
    for (const p of pts) {
      const r: Pt = [Math.round(p[0]), Math.round(p[1])];
      if (o.length && o[o.length - 1][0] === r[0] && o[o.length - 1][1] === r[1]) continue;
      // Drop the middle of three collinear points.
      if (o.length >= 2) {
        const a = o[o.length - 2],
          b = o[o.length - 1];
        if ((a[0] === b[0] && b[0] === r[0]) || (a[1] === b[1] && b[1] === r[1])) o.pop();
      }
      o.push(r);
    }
    return o;
  };
  const lanes = new Map<string, Map<string, number>>();
  const lane = (channel: string, key: string) => {
    const m = lanes.get(channel) ?? new Map<string, number>();
    lanes.set(channel, m);
    if (!m.has(key)) m.set(key, LANES[m.size % LANES.length]);
    return m.get(key)!;
  };

  // ---- 3. routing -------------------------------------------------------------------------------------
  const edges: Record<string, Pt[]> = {};
  for (const f of flows) {
    const s = shapes[f.src],
      t = shapes[f.tgt];
    const [sx, sy] = center.get(f.src)!,
      [tx, ty] = center.get(f.tgt)!;
    const skip = new Set([f.src, f.tgt]);
    const pool = poolOf.get(f.src);
    const sR = s.x + s.w,
      tL = t.x,
      sB = s.y + s.h,
      sT = s.y,
      tB = t.y + t.h,
      tT = t.y;
    const gw = kindOf(node.get(f.src)!.type) === 'gateway';
    const cands: Pt[][] = [];
    if (sy === ty && tx > sx)
      cands.push([
        [sR, sy],
        [tL, ty],
      ]);
    if (tx > sx && ty !== sy) {
      // Down or up out of the source, then straight into the target's side.
      const ex: Pt = ty > sy ? [sx, sB] : [sx, sT];
      if (gw) cands.push([ex, [sx, ty], [tL, ty]]);
      cands.push([
        [sR, sy],
        [tx, sy],
        [tx, ty > sy ? tT : tB],
      ]);
      if (!gw) cands.push([ex, [sx, ty], [tL, ty]]);
      const a = chanAfter(f.src) + lane(`v${chanAfter(f.src)}`, f.src);
      cands.push([
        [sR, sy],
        [a, sy],
        [a, ty],
        [tL, ty],
      ]);
      const b = chanBefore(f.tgt) + lane(`v${chanBefore(f.tgt)}`, f.tgt);
      cands.push([
        [sR, sy],
        [b, sy],
        [b, ty],
        [tL, ty],
      ]);
    }
    // Through the channels: always clear (no shape sits in a channel).
    const a = chanAfter(f.src) + lane(`v${chanAfter(f.src)}`, f.src);
    const b = chanBefore(f.tgt) + lane(`v${chanBefore(f.tgt)}`, f.tgt);
    const viaRows: Pt[][] = [true, false].map((below) => {
      const h = rowBoundary(f.tgt, below) + lane(`h${rowBoundary(f.tgt, below)}`, f.tgt);
      return [
        [sR, sy],
        [a, sy],
        [a, h],
        [b, h],
        [b, ty],
        [tL, ty],
      ] as Pt[];
    });
    // Prefer the row channel on the source's side of the target.
    if (sy > ty) cands.push(viaRows[0], viaRows[1]);
    else cands.push(viaRows[1], viaRows[0]);
    const route = cands.map(tidy).find((c) => clear(c, skip, pool)) ?? tidy(cands[cands.length - 1]);
    edges[f.id] = route;
  }
  for (const m of msgs) {
    const s = shapes[m.src],
      t = shapes[m.tgt];
    const [sx, sy] = center.get(m.src)!,
      [tx, ty] = center.get(m.tgt)!;
    const skip = new Set([m.src, m.tgt]);
    const down = ty > sy;
    const sOut: Pt = down ? [sx, s.y + s.h] : [sx, s.y];
    const tIn: Pt = down ? [tx, t.y] : [tx, t.y + t.h];
    const sCh = rowBoundary(m.src, down) + lane(`m${rowBoundary(m.src, down)}`, m.src);
    const tCh = rowBoundary(m.tgt, !down) + lane(`m${rowBoundary(m.tgt, !down)}`, m.tgt);
    const v = chanBefore(m.tgt) + lane(`mv${chanBefore(m.tgt)}`, m.tgt);
    const cands: Pt[][] = [];
    if (sx === tx) cands.push([sOut, tIn]);
    cands.push([sOut, [sx, sCh], [tx, sCh], tIn]);
    cands.push([sOut, [sx, tCh], [tx, tCh], tIn]);
    cands.push([sOut, [sx, sCh], [v, sCh], [v, tCh], [tx, tCh], tIn]);
    edges[m.id] = cands.map(tidy).find((c) => clear(c, skip)) ?? tidy(cands[cands.length - 1]);
  }

  // ---- 4. labels --------------------------------------------------------------------------------------
  const labels: Record<string, Box> = {};
  const placed: Box[] = [];
  const free = (b: Box, avoidSegs: Array<[Pt, Pt]>) =>
    !shapeList.some(([, s]) => overlaps(b, s, 2)) &&
    !placed.some((l) => overlaps(b, l, 1)) &&
    !avoidSegs.some(([p, q]) => segmentHits(p, q, b, 1));
  const segsOf = (pts: Pt[]) => pts.slice(1).map((q, i) => [pts[i], q] as [Pt, Pt]);
  const incident = new Map<string, Array<[Pt, Pt]>>();
  for (const f of [...flows, ...msgs])
    for (const id of [f.src, f.tgt]) incident.set(id, [...(incident.get(id) ?? []), ...segsOf(edges[f.id])]);
  const allSegs = Object.values(edges).flatMap(segsOf);
  // Element labels: events below, gateways above (then the other side, then beside).
  for (const n of nodes) {
    const k = kindOf(n.type);
    if (k === 'task' || !n.name) continue;
    const [w, h] = labelSize(n.name);
    const b = shapes[n.id],
      cx = b.x + b.w / 2;
    const above: Box = { x: cx - w / 2, y: b.y - 4 - h, w, h },
      below: Box = { x: cx - w / 2, y: b.y + b.h + 4, w, h };
    const right: Box = { x: b.x + b.w + 4, y: b.y - h - 2, w, h },
      left: Box = { x: b.x - 4 - w, y: b.y - h - 2, w, h };
    const rightLow: Box = { x: b.x + b.w + 4, y: b.y + b.h + 2, w, h },
      leftLow: Box = { x: b.x - 4 - w, y: b.y + b.h + 2, w, h };
    const cands =
      k === 'gateway' ? [above, below, left, right, leftLow, rightLow] : [below, above, right, left, rightLow, leftLow];
    const avoid = incident.get(n.id) ?? [];
    const pick = cands.find((c) => free(c, avoid)) ?? cands.find((c) => free(c, [])) ?? cands[0];
    labels[n.id] = pick;
    placed.push(pick);
  }
  // Flow labels: beside the first segments of the edge.
  for (const f of flows) {
    if (!f.name) continue;
    const [w, h] = labelSize(f.name);
    const pts = edges[f.id];
    const cands: Box[] = [];
    // Beside each segment, nearest the source first: at its start, middle and end, on either side.
    for (let i = 0; i + 1 < pts.length; i++) {
      const [p, q] = [pts[i], pts[i + 1]];
      if (p[1] === q[1]) {
        const lo = Math.min(p[0], q[0]),
          hi = Math.max(p[0], q[0]);
        // A short segment (a gateway into its neighbour) gets a narrower, wrapped label that fits beside it.
        const [ww, hh] = w > hi - lo - 10 ? labelSize(f.name, Math.max(48, hi - lo - 10)) : [w, h];
        const xs = q[0] > p[0] ? [lo + 5, (lo + hi - ww) / 2, hi - 5 - ww] : [hi - 5 - ww, (lo + hi - ww) / 2, lo + 5];
        for (const x of xs) cands.push({ x, y: p[1] - 3 - hh, w: ww, h: hh }, { x, y: p[1] + 3, w: ww, h: hh });
      } else {
        const lo = Math.min(p[1], q[1]),
          hi = Math.max(p[1], q[1]);
        const ys = q[1] > p[1] ? [lo + 6, (lo + hi - h) / 2, hi - 6 - h] : [hi - 6 - h, (lo + hi - h) / 2, lo + 6];
        for (const y of ys) cands.push({ x: p[0] + 4, y, w, h }, { x: p[0] - 4 - w, y, w, h });
      }
    }
    const own = segsOf(pts);
    const others = allSegs.filter((sg) => !own.some((o) => o[0] === sg[0] && o[1] === sg[1]));
    const pick = cands.find((c) => free(c, others)) ?? cands.find((c) => free(c, own.length ? [] : [])) ?? cands[0];
    labels[f.id] = pick;
    placed.push(pick);
  }
  return { pools: poolBox, shapes, edges, labels };
}
