/**
 * The landing page's 3D scene: one structured note's life, drawn as an instrument rather than decoration.
 *
 *  - A price path (a worst-of phoenix: strike, four observations) runs left to right in front of three
 *    translucent barrier sheets: early repayment at 100%, the coupon floor at 70%, the knock-in at 60%.
 *  - The issuer's collateral sits locked at the back left; investors stand at the front left.
 *  - Scroll drives one number, `progress` (0..1). Everything that tells the story (the path drawing in,
 *    Chainlink's checks at each observation, coupons dropping to the holders, the collateral's release)
 *    is a pure function of it, so scrolling back plays the story backwards. Only ambient motion (dust,
 *    a slow camera sway, the oracle marks turning) uses the clock.
 *
 * Every material is unlit (basic / line), so the look is crisp line work and flat planes in the
 * white-and-navy palette, with fog towards white for depth. No post-processing, no glow.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Fog,
  Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineLoop,
  LineSegments,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { ENDING_SPLIT, STORY_END } from './beats';

// Light theme: white ground and fog, navy and blue line work, tinted glass sheets, a navy collateral block,
// green USDG coins. Every colour is dark enough to read on white.
const C = {
  // Brand (docs/brand/logo-guide.pdf): Ink line work, Signal for the live path, coins and CRE marks, Slate guides.
  bg: 0xffffff,
  line: 0xe3e5ea,
  lineStrong: 0xc3c8d1,
  text: 0x0e1116,
  soft: 0x4a5060,
  muted: 0x6b7280,
  blue: 0x0b7a52,
  blueHi: 0x12a971,
  green: 0x12a971,
  red: 0xc9363b,
  amber: 0x9a6200,
  panel: 0x0e1116,
  ink: 0x0e1116,
  signal: 0x12a971,
  signalInk: 0x0b7a52,
};

// ---- the note's world -------------------------------------------------------------------------------------
const X0 = -20,
  X1 = 20; // strike date .. maturity along x
const OBS_X = [-10, 0, 10, 20]; // observation dates
const LEVEL = (perf: number) => (perf - 0.6) * 20; // knock-in 60% = y 0, coupon 70% = y 2, autocall 100% = y 8
const PERFS = [1.0, 0.93, 0.78, 0.95, 1.04]; // strike, then the four observations: every coupon paid, par at maturity
const FLOOR_Y = -1.6;
const HOLDERS_Z = 9;
const ISSUER = new Vector3(-23, 0, -7);
const INVESTORS = new Vector3(-23, 0, 8);

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const frac = (v: number) => v - Math.floor(v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** How far the bright price path has drawn at story progress p (observe + pay beats). */
const pathAt = (p: number) => smooth(span(p, 0.47, 0.8));

/** The price path's y at x: a smooth curve through the strike and observation levels, with a deterministic wiggle. */
function pathY(x: number) {
  const knots = [X0, ...OBS_X];
  let i = 0;
  while (i < knots.length - 2 && x > knots[i + 1]) i++;
  const t = clamp((x - knots[i]) / (knots[i + 1] - knots[i]));
  const y0 = LEVEL(PERFS[Math.max(0, i - 1)]),
    y1 = LEVEL(PERFS[i]),
    y2 = LEVEL(PERFS[i + 1]),
    y3 = LEVEL(PERFS[Math.min(PERFS.length - 1, i + 2)]);
  // Catmull-Rom between the knots, then a wiggle that is zero at every knot.
  const t2 = t * t,
    t3 = t2 * t;
  const base =
    0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
  const wiggle =
    Math.sin(Math.PI * t) * (0.55 * Math.sin(x * 1.7 + 0.6) + 0.35 * Math.sin(x * 3.1 + 2.1) + 0.2 * Math.sin(x * 5.3));
  return base + wiggle;
}

/** A crisp text sprite from a canvas (mono labels, the page's typography). */
function label(text: string, color: string, height = 0.9, weight = 500) {
  const pad = 18,
    fontPx = 64;
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d')!;
  const font = `${weight} ${fontPx}px "Geist Mono", ui-monospace, Menlo, monospace`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  cv.width = w;
  cv.height = fontPx + pad * 2;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, cv.height / 2 + 2);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  const mat = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: true });
  const s = new Sprite(mat);
  s.scale.set(height * (cv.width / cv.height), height, 1);
  s.center.set(0, 0.5);
  return s;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** A coin face: a green disc with "USDG" on it, for the caps of every coupon and subscription coin. */
function usdgFace() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = hex(C.green);
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 34px "Geist Mono", ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('USDG', 64, 66);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
/** Side, top and bottom materials for a cylinder coin: green rim, USDG faces. */
function coinMaterials() {
  const face = new MeshBasicMaterial({ map: usdgFace() });
  return [new MeshBasicMaterial({ color: C.green }), face, face];
}

export interface SceneOptions {
  lowPower: boolean;
  reducedMotion: boolean;
}

export class NoteScene {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(42, 1, 0.1, 200);
  private target = 0;
  private current = 0;
  private raf = 0;
  private running = false;
  private visible = true;
  private last = 0;
  private clock = 0;
  private readonly opts: SceneOptions;

  // story parts
  private pathGeo!: TubeGeometry;
  private pathSegs = 0;
  private pathRadial = 6;
  private curve!: CatmullRomCurve3;
  private head!: Mesh;
  private preview!: Mesh;
  private obs: Array<{ ring: Mesh; pulse: Mesh; hexMark: LineLoop; stem: Line; x: number; at: number; cre: Sprite }> =
    [];
  private strikeMark!: Group;
  private strikeCre!: Sprite;
  private marginCre!: Sprite;
  private coins!: InstancedMesh;
  private coinFrom: Vector3[] = [];
  private coinTo: Vector3[] = [];
  private coinAt: number[] = [];
  private flowCoins!: InstancedMesh;
  private flowUnits!: InstancedMesh;
  private collateral!: Group;
  private bands: Mesh[] = [];
  private collLabel!: Sprite;
  private collLabelReleased!: Sprite;
  private collEdges!: LineSegments;
  private dust!: Points;
  private dustBase!: Float32Array;
  private holdersLabel!: Sprite;
  private couponTags: Array<{ s: Sprite; at: number }> = [];
  private principal!: InstancedMesh;
  private principalFrom: Vector3[] = [];
  private principalTo: Vector3[] = [];
  private principalTag!: Sprite;
  private branch!: Mesh;
  private branchGeo!: TubeGeometry;
  private branchSegs = 0;
  private knockTag!: Sprite;
  private tsla!: InstancedMesh;
  private tslaFrom: Vector3[] = [];
  private tslaTo: Vector3[] = [];
  private tslaTag!: Sprite;
  private swapMark!: Group;
  private swapTag!: Sprite;
  private readonly tmp = new Object3D();
  private readonly v = new Vector3();
  private readonly look = new Vector3();

  constructor(canvas: HTMLCanvasElement, opts: SceneOptions) {
    this.opts = opts;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: !opts.lowPower,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.lowPower ? 1.5 : 2));
    this.renderer.setClearColor(C.bg, 1);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.scene.fog = new Fog(C.bg, 28, 86);
    this.build();
    this.resize();
  }

  // ---------------------------------------------------------------------------------------------------------
  private build() {
    const s = this.scene;
    const low = this.opts.lowPower;

    // The ground: a drafting grid that fades into fog.
    {
      const pts: number[] = [];
      for (let x = -48; x <= 48; x += 2) pts.push(x, FLOOR_Y, -40, x, FLOOR_Y, 24);
      for (let z = -40; z <= 24; z += 2) pts.push(-48, FLOOR_Y, z, 48, FLOOR_Y, z);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
      s.add(new LineSegments(g, new LineBasicMaterial({ color: C.line, transparent: true, opacity: 0.9 })));
    }

    // Barrier sheets: horizontal glass at each level, with a crisp front edge and a label.
    const sheets: Array<[number, number, string, number]> = [
      [LEVEL(1.0), C.ink, 'EARLY REPAYMENT 100%', 0.05],
      [LEVEL(0.7), C.amber, 'COUPON FLOOR 70%', 0.04],
      [LEVEL(0.6), C.red, 'KNOCK-IN 60%', 0.05],
    ];
    for (const [y, color, text, op] of sheets) {
      const plane = new Mesh(
        new PlaneGeometry(X1 - X0 + 8, 12),
        new MeshBasicMaterial({ color, transparent: true, opacity: op, side: DoubleSide, depthWrite: false }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(0, y, -1);
      s.add(plane);
      const edge = new BufferGeometry().setFromPoints([
        new Vector3(X0 - 4, y, 5),
        new Vector3(X1 + 4, y, 5),
        new Vector3(X1 + 4, y, -7),
        new Vector3(X0 - 4, y, -7),
      ]);
      s.add(new LineLoop(edge, new LineBasicMaterial({ color, transparent: true, opacity: 0.8 })));
      const l = label(text, hex(color), 0.62);
      l.position.set(X1 + 4.6, y, 5);
      s.add(l);
    }

    // The price path: a ghost of the whole path (visible in the hero), and the bright path that draws in.
    const pts: Vector3[] = [];
    const N = low ? 160 : 320;
    for (let i = 0; i <= N; i++) {
      const x = X0 + (X1 - X0) * (i / N);
      pts.push(new Vector3(x, pathY(x), 0));
    }
    this.curve = new CatmullRomCurve3(pts);
    {
      const ghost = new BufferGeometry().setFromPoints(this.curve.getPoints(N));
      const gl = new Line(
        ghost,
        new LineDashedMaterial({ color: C.soft, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.4 }),
      );
      gl.computeLineDistances();
      s.add(gl);
      // Its shadow on the floor, for depth.
      const shadow = new BufferGeometry().setFromPoints(pts.map((p) => new Vector3(p.x, FLOOR_Y + 0.02, p.z)));
      s.add(new Line(shadow, new LineBasicMaterial({ color: C.lineStrong, transparent: true, opacity: 0.8 })));
    }
    this.pathSegs = low ? 220 : 480;
    this.pathRadial = low ? 5 : 8;
    this.pathGeo = new TubeGeometry(this.curve, this.pathSegs, 0.11, this.pathRadial, false);
    s.add(new Mesh(this.pathGeo, new MeshBasicMaterial({ color: C.blueHi })));
    this.head = new Mesh(new SphereGeometry(0.26, 16, 12), new MeshBasicMaterial({ color: C.text }));
    s.add(this.head);
    // The opening shot shows the whole path; it steps back to a ghost when the story starts, then redraws.
    this.preview = new Mesh(
      new TubeGeometry(this.curve, this.pathSegs, 0.06, this.pathRadial, false),
      new MeshBasicMaterial({ color: C.soft, transparent: true, depthWrite: false }),
    );
    s.add(this.preview);

    // Strike date.
    this.strikeMark = new Group();
    {
      const y = pathY(X0);
      const stem = new BufferGeometry().setFromPoints([new Vector3(X0, FLOOR_Y, 0), new Vector3(X0, y, 0)]);
      this.strikeMark.add(new Line(stem, new LineBasicMaterial({ color: C.lineStrong })));
      const l = label('STRIKE', hex(C.muted), 0.55);
      l.position.set(X0 - 1.4, FLOOR_Y - 0.9, 0.6);
      this.strikeMark.add(l);
      this.strikeCre = label('CRE · STRIKE FIXED', hex(C.blue), 0.48, 600);
      this.strikeCre.position.set(X0 - 2.2, y + 1.6, 0);
      (this.strikeCre.material as SpriteMaterial).opacity = 0;
      this.strikeMark.add(this.strikeCre);
    }
    s.add(this.strikeMark);

    // Observation dates: a stem, a ring at the price, a pulse when the date passes, and Chainlink's check mark.
    const ringGeo = new RingGeometry(0.42, 0.52, 40);
    const hexPts = Array.from(
      { length: 6 },
      (_, k) =>
        new Vector3(
          Math.cos((k * Math.PI) / 3 + Math.PI / 6) * 0.9,
          Math.sin((k * Math.PI) / 3 + Math.PI / 6) * 0.9,
          0,
        ),
    );
    OBS_X.forEach((x, k) => {
      const y = pathY(x);
      const stem = new Line(
        new BufferGeometry().setFromPoints([new Vector3(x, FLOOR_Y, 0), new Vector3(x, y, 0)]),
        new LineBasicMaterial({ color: C.lineStrong, transparent: true, opacity: 0.9 }),
      );
      const ring = new Mesh(
        ringGeo,
        new MeshBasicMaterial({ color: C.text, transparent: true, side: DoubleSide, depthWrite: false }),
      );
      ring.position.set(x, y, 0);
      const pulse = new Mesh(
        ringGeo,
        new MeshBasicMaterial({ color: C.signal, transparent: true, side: DoubleSide, depthWrite: false }),
      );
      pulse.position.copy(ring.position);
      const hexMark = new LineLoop(
        new BufferGeometry().setFromPoints(hexPts),
        new LineBasicMaterial({ color: C.signal, transparent: true }),
      );
      hexMark.position.set(x, y + 2.1, 0);
      const l = label(k === OBS_X.length - 1 ? 'MATURITY' : `OBSERVATION ${k + 1}`, hex(C.muted), 0.5);
      l.position.set(x - 1.6, FLOOR_Y - 0.9, 0.6);
      const cre = label('CHAINLINK CRE', hex(C.blue), 0.42, 600);
      cre.position.set(x - 1.9, y + 3.35, 0);
      (cre.material as SpriteMaterial).opacity = 0;
      s.add(stem, ring, pulse, hexMark, l, cre);
      this.obs.push({ ring, pulse, hexMark, stem, x, at: (x - X0) / (X1 - X0), cre });
    });

    // Holders: a rail at the front where coupons land.
    {
      const rail = new BufferGeometry().setFromPoints([
        new Vector3(X0 - 4, FLOOR_Y + 0.01, HOLDERS_Z),
        new Vector3(X1 + 4, FLOOR_Y + 0.01, HOLDERS_Z),
      ]);
      s.add(new Line(rail, new LineBasicMaterial({ color: C.green, transparent: true, opacity: 0.5 })));
      this.holdersLabel = label('HOLDERS · COUPONS IN USDG', hex(C.signalInk), 0.6);
      this.holdersLabel.position.set(X1 + 4.6, FLOOR_Y + 0.2, HOLDERS_Z);
      s.add(this.holdersLabel);
    }

    // Coupons: a handful of coins per observation, falling from the price to the holders' rail.
    const perObs = low ? 5 : 8;
    const coinGeo = new CylinderGeometry(0.5, 0.5, 0.1, 32);
    this.coins = new InstancedMesh(coinGeo, coinMaterials(), OBS_X.length * perObs);
    let ci = 0;
    OBS_X.forEach((x, k) => {
      const y = pathY(x);
      for (let j = 0; j < perObs; j++) {
        const jitter = (j - (perObs - 1) / 2) * 0.55;
        this.coinFrom.push(new Vector3(x + jitter * 0.3, y, 0));
        this.coinTo.push(
          new Vector3(x + jitter * 1.6, FLOOR_Y + 0.5 + (j % 3) * 0.12, HOLDERS_Z + (Math.floor(j / 3) - 1) * 0.7),
        );
        this.coinAt.push(this.obs[k].at + j * 0.004);
        ci++;
      }
      const tag = label('COUPON PAID IN USDG', hex(C.signalInk), 0.5, 600);
      tag.position.set(x - 2.6, FLOOR_Y + 2.2, HOLDERS_Z + 0.6);
      (tag.material as SpriteMaterial).opacity = 0;
      this.couponTags.push({ s: tag, at: this.obs[k].at });
      s.add(tag);
    });
    this.coins.count = ci;
    s.add(this.coins);

    // Collateral: a locked block at the issuer's side, released at the end.
    this.collateral = new Group();
    {
      const box = new BoxGeometry(5.6, 3.2, 4.2);
      const body = new Mesh(box, new MeshBasicMaterial({ color: C.panel, transparent: true, opacity: 0.9 }));
      this.collEdges = new LineSegments(new EdgesGeometry(box), new LineBasicMaterial({ color: C.ink }));
      this.collateral.add(body, this.collEdges);
      for (const dy of [-0.7, 0.7]) {
        const band = new Mesh(new BoxGeometry(5.9, 0.16, 4.5), new MeshBasicMaterial({ color: C.signal }));
        band.position.y = dy;
        this.bands.push(band);
        this.collateral.add(band);
      }
      this.collateral.position.set(ISSUER.x, FLOOR_Y + 1.6, ISSUER.z);
      this.collLabel = label('COLLATERAL · LOCKED', hex(C.text), 0.6);
      this.collLabel.position.set(ISSUER.x - 2.8, FLOOR_Y + 4.1, ISSUER.z + 2.2);
      this.collLabelReleased = label('CRE · COLLATERAL RELEASED', hex(C.signalInk), 0.6);
      this.collLabelReleased.position.copy(this.collLabel.position);
      const issuerLbl = label('ISSUER', hex(C.muted), 0.55);
      issuerLbl.position.set(ISSUER.x - 2.8, FLOOR_Y - 0.9, ISSUER.z + 2.3);
      this.marginCre = label('CRE · MARGIN CHECKED', hex(C.blue), 0.5, 600);
      this.marginCre.position.set(ISSUER.x - 2.8, FLOOR_Y + 5.0, ISSUER.z + 2.2);
      (this.marginCre.material as SpriteMaterial).opacity = 0;
      s.add(this.collateral, this.collLabel, this.collLabelReleased, issuerLbl, this.marginCre);
    }

    // Investors: a small crowd at the front left.
    {
      const crowd = new InstancedMesh(new SphereGeometry(0.28, 12, 10), new MeshBasicMaterial({ color: C.text }), 14);
      for (let i = 0; i < 14; i++) {
        const a = i * 2.39996,
          r = 0.55 * Math.sqrt(i + 0.5);
        this.tmp.position.set(INVESTORS.x + Math.cos(a) * r, FLOOR_Y + 0.3, INVESTORS.z + Math.sin(a) * r);
        this.tmp.updateMatrix();
        crowd.setMatrixAt(i, this.tmp.matrix);
      }
      const l = label('INVESTORS', hex(C.muted), 0.55);
      l.position.set(INVESTORS.x - 2.4, FLOOR_Y - 0.9, INVESTORS.z + 2.6);
      s.add(crowd, l);
    }

    // Subscription flows: stablecoins to the issuer, note units to the investors.
    const flowN = low ? 10 : 18;
    this.flowCoins = new InstancedMesh(new CylinderGeometry(0.3, 0.3, 0.07, 24), coinMaterials(), flowN);
    this.flowUnits = new InstancedMesh(
      new BoxGeometry(0.34, 0.34, 0.34),
      new MeshBasicMaterial({ color: C.text }),
      flowN,
    );
    s.add(this.flowCoins, this.flowUnits);
    // The swap point: USDG and units cross here in the same transaction (DvP), so the note shows it as one step.
    {
      const mid = new Vector3().lerpVectors(INVESTORS, ISSUER, 0.5);
      this.swapMark = new Group();
      const ring = new Mesh(
        new RingGeometry(1.25, 1.4, 48),
        new MeshBasicMaterial({ color: C.signal, transparent: true, side: DoubleSide, depthWrite: false }),
      );
      ring.rotation.y = Math.PI / 2;
      this.swapMark.add(ring);
      this.swapMark.position.set(mid.x, FLOOR_Y + 1.6, mid.z);
      this.swapTag = label('ATOMIC SWAP · ONE TRANSACTION', hex(C.blue), 0.55, 600);
      this.swapTag.position.set(mid.x - 3.4, FLOOR_Y - 0.5, mid.z + 2.4);
      s.add(this.swapMark, this.swapTag);
    }

    // Ending A: principal back in USDG, from the issuer to the holders near maturity.
    {
      const n = low ? 6 : 10;
      this.principal = new InstancedMesh(new CylinderGeometry(0.62, 0.62, 0.12, 32), coinMaterials(), n);
      for (let i = 0; i < n; i++) {
        this.principalFrom.push(new Vector3(ISSUER.x + 1, FLOOR_Y + 2.4, ISSUER.z + 2));
        this.principalTo.push(
          new Vector3(
            13 + (i % 5) * 1.5,
            FLOOR_Y + 0.75 + Math.floor(i / 5) * 0.25,
            HOLDERS_Z - 0.6 + Math.floor(i / 5) * 1.1,
          ),
        );
      }
      this.principal.count = n;
      s.add(this.principal);
      this.principalTag = label('PRINCIPAL BACK · USDG', hex(C.signalInk), 0.62, 600);
      this.principalTag.position.set(12.4, FLOOR_Y + 3.1, HOLDERS_Z + 0.6);
      (this.principalTag.material as SpriteMaterial).opacity = 0;
      s.add(this.principalTag);
    }
    // Ending B: the price falls through the knock-in at maturity (a red branch from the last observation).
    {
      const x0 = OBS_X[2],
        x1 = X1,
        yEnd = LEVEL(0.5);
      const bp: Vector3[] = [];
      for (let i = 0; i <= 80; i++) {
        const tt = i / 80,
          x = mix(x0, x1, tt);
        bp.push(
          new Vector3(x, mix(pathY(x0), yEnd, smooth(tt)) + Math.sin(Math.PI * tt) * 0.5 * Math.sin(x * 2.3), 0.15),
        );
      }
      this.branchSegs = low ? 90 : 160;
      this.branchGeo = new TubeGeometry(new CatmullRomCurve3(bp), this.branchSegs, 0.12, this.pathRadial, false);
      this.branch = new Mesh(this.branchGeo, new MeshBasicMaterial({ color: C.red }));
      this.branch.visible = false;
      s.add(this.branch);
      this.knockTag = label('CRE · KNOCKED IN, BELOW 60%', hex(C.red), 0.6, 600);
      this.knockTag.position.set(x1 - 3.5, yEnd - 1.2, 1.2);
      (this.knockTag.material as SpriteMaterial).opacity = 0;
      s.add(this.knockTag);
      // Stock tokens: holders receive TSLA instead of cash.
      const n = low ? 6 : 9;
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const g2 = cv.getContext('2d')!;
      g2.fillStyle = hex(C.text);
      g2.fillRect(0, 0, 128, 128);
      g2.strokeStyle = 'rgba(255,255,255,.6)';
      g2.lineWidth = 6;
      g2.strokeRect(8, 8, 112, 112);
      g2.fillStyle = '#ffffff';
      g2.font = '700 38px "Geist Mono", ui-monospace, Menlo, monospace';
      g2.textAlign = 'center';
      g2.textBaseline = 'middle';
      g2.fillText('USDG', 64, 66); // the cash-settled form: final ÷ strike in USDG (a physical note delivers the stock token)
      const tex = new CanvasTexture(cv);
      tex.colorSpace = SRGBColorSpace;
      this.tsla = new InstancedMesh(new BoxGeometry(0.95, 0.95, 0.95), new MeshBasicMaterial({ map: tex }), n);
      for (let i = 0; i < n; i++) {
        this.tslaFrom.push(new Vector3(x1, yEnd, 0));
        this.tslaTo.push(new Vector3(12.5 + (i % 5) * 1.6, FLOOR_Y + 0.5, HOLDERS_Z - 0.4 + Math.floor(i / 5) * 1.3));
      }
      this.tsla.count = n;
      s.add(this.tsla);
      this.tslaTag = label('HOLDERS REPAID FINAL ÷ STRIKE · USDG', hex(C.text), 0.58, 600);
      this.tslaTag.position.set(9.5, FLOOR_Y + 3.0, HOLDERS_Z + 0.8);
      (this.tslaTag.material as SpriteMaterial).opacity = 0;
      s.add(this.tslaTag);
    }

    // Dust: depth and quiet motion.
    {
      const n = low ? 260 : 700;
      this.dustBase = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = (k: number) => frac(Math.sin((i + 1) * (12.9898 + k * 7.233)) * 43758.5453);
        this.dustBase[i * 3] = -44 + r(1) * 88;
        this.dustBase[i * 3 + 1] = FLOOR_Y + r(2) * 18;
        this.dustBase[i * 3 + 2] = -36 + r(3) * 58;
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(this.dustBase.slice(), 3));
      this.dust = new Points(
        g,
        new PointsMaterial({ color: C.soft, size: 0.06, transparent: true, opacity: 0.3, depthWrite: false }),
      );
      s.add(this.dust);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  /** Camera key shots along the story (position, look-at). */
  private static SHOTS: Array<{ p: number; pos: [number, number, number]; at: [number, number, number] }> = [
    { p: 0.0, pos: [16, 13, 31], at: [-1, 3.2, 0] },
    { p: 0.12, pos: [12, 11, 27], at: [-4, 2.6, 0] },
    { p: 0.22, pos: [-9, 5.5, 9], at: [-22, 1, -6] },
    { p: 0.38, pos: [-7, 8.5, 22], at: [-22, 0.6, 1] },
    { p: 0.47, pos: [-16, 10, 18], at: [-12, 4, 0] },
    { p: 0.6, pos: [4, 9, 19], at: [3, 3.4, 0] },
    { p: 0.74, pos: [17, 6.5, 22], at: [10, 1.4, 5] },
    { p: 0.86, pos: [-6, 7, 13], at: [-21, 1.2, -5] },
    { p: 1.0, pos: [20, 17, 38], at: [-1, 2.8, 0] },
  ];

  private placeCamera(p: number, t: number) {
    const S = NoteScene.SHOTS;
    let i = 0;
    while (i < S.length - 2 && p > S[i + 1].p) i++;
    const a = S[i],
      b = S[i + 1];
    const k = smoother(span(p, a.p, b.p));
    this.camera.position.set(mix(a.pos[0], b.pos[0], k), mix(a.pos[1], b.pos[1], k), mix(a.pos[2], b.pos[2], k));
    this.look.set(mix(a.at[0], b.at[0], k), mix(a.at[1], b.at[1], k), mix(a.at[2], b.at[2], k));
    // Observe and pay: fly alongside the head of the price path.
    const follow = smooth(span(p, 0.45, 0.5)) * (1 - smooth(span(p, 0.8, 0.86)));
    if (follow > 0) {
      this.curve.getPointAt(clamp(pathAt(p)), this.v);
      const fx = this.v.x,
        fy = this.v.y;
      // Observing: close, beside the head. Paying: lower and wider, so coins can be seen landing with the holders.
      const pay = smooth(span(p, 0.63, 0.7));
      const lx = mix(fx + 3, fx * 0.45, pay),
        ly = mix(fy * 0.6 + 1.2, 1.6, pay),
        lz = mix(0.5, 3.5, pay);
      const cx = mix(fx + 9, fx * 0.45 + 9, pay),
        cy = mix(fy * 0.5 + 6.5, 9.5, pay),
        cz = mix(17, 31, pay);
      this.look.set(mix(this.look.x, lx, follow), mix(this.look.y, ly, follow), mix(this.look.z, lz, follow));
      this.camera.position.set(
        mix(this.camera.position.x, cx, follow),
        mix(this.camera.position.y, cy, follow),
        mix(this.camera.position.z, cz, follow),
      );
    }
    if (!this.opts.reducedMotion) {
      // A slow sway, strongest on the opening shot.
      const sway = 1 - smooth(span(p, 0.02, 0.16)) * 0.75;
      this.camera.position.x += Math.sin(t * 0.13) * 1.6 * sway;
      this.camera.position.y += Math.sin(t * 0.17 + 1) * 0.6 * sway;
    }
    // Keep the whole stage in frame on narrow (portrait) screens.
    if (this.camera.aspect < 1) {
      const pull = clamp((1 - this.camera.aspect) * 0.75, 0, 0.55) * (1 - 0.6 * smooth(span(p, 0.84, 1)));
      this.v
        .copy(this.camera.position)
        .sub(this.look)
        .multiplyScalar(1 + pull);
      this.camera.position.copy(this.look).add(this.v);
      // Captions sit at the bottom on phones: aim lower so the subject rides in the upper half.
      const drop = (1 - this.camera.aspect) * 7;
      this.look.y -= drop;
      this.camera.position.y -= drop * 0.4;
    }
    this.camera.lookAt(this.look);
    // The opening frame: on landscape screens the hero copy sits on the left, so render the scene off-centre to the
    // right (a lens shift, not a camera move) and ease it back to centre as the story starts.
    const shift = this.camera.aspect >= 1 ? 0.27 * (1 - smooth(span(p, 0.03, 0.13))) : 0;
    if (shift > 0.001) {
      const fw = 1000,
        fh = 1000 / this.camera.aspect;
      this.camera.setViewOffset(fw, fh, -shift * fw, 0, fw, fh);
    } else if (this.camera.view?.enabled) {
      this.camera.clearViewOffset();
    }
  }

  /** Lay out every story element for progress p (pure: scrolling back plays it backwards). */
  private apply(p: number, t: number) {
    // 1. Issue: the lock bands close around the collateral.
    const lock = smooth(span(p, 0.14, 0.24));
    const release = smooth(span(p, 0.86, 0.97));
    this.bands.forEach((b, i) => {
      const off = (1 - lock) * 3.2 * (i === 0 ? -1 : 1) + release * (i === 0 ? -2.6 : 2.6);
      b.position.y = (i === 0 ? -0.7 : 0.7) + off;
      const bm = b.material as MeshBasicMaterial;
      bm.transparent = true;
      bm.opacity = clamp(lock * (1 - release));
      b.visible = lock * (1 - release) > 0.01;
    });
    this.collateral.position.y = FLOOR_Y + 1.6 + release * 1.4;
    (this.collEdges.material as LineBasicMaterial).color.setHex(release > 0.5 ? C.signal : C.ink);
    (this.collLabel.material as SpriteMaterial).opacity = 1 - release;
    (this.collLabelReleased.material as SpriteMaterial).opacity = release;

    // 2. Subscribe: atomic settlement. Each wave of USDG (investors -> issuer) and of note units (issuer ->
    //    investors) moves in lockstep and crosses at the swap point together: one transaction, no leg alone.
    const sub = span(p, 0.3, 0.45);
    const flowOn = sub > 0 && sub < 1;
    const flowFade = Math.sin(Math.PI * sub);
    const n = this.flowCoins.count;
    const WAVES = 3,
      perWave = Math.max(1, Math.floor(n / WAVES));
    let cross = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.floor(i / perWave),
        j = i % perWave;
      const ph = clamp(sub * 1.6 - w * 0.28);
      const e = smoother(ph);
      cross = Math.max(cross, 1 - Math.min(1, Math.abs(e - 0.5) * 6));
      const arc = Math.sin(Math.PI * e) * 2.4;
      const spread = (j - (perWave - 1) / 2) * 0.45;
      const live = flowOn && ph > 0 && ph < 1;
      // USDG: investors -> issuer, faces turned to the camera
      this.v.lerpVectors(INVESTORS, ISSUER, e);
      this.tmp.position.set(this.v.x + 0.9, FLOOR_Y + 1.6 + arc + spread * 0.2, this.v.z + spread);
      this.tmp.scale.setScalar(live ? Math.max(0.0001, flowFade) : 0.0001);
      this.tmp.rotation.set(Math.PI / 2, 0, 0);
      this.tmp.updateMatrix();
      this.flowCoins.setMatrixAt(i, this.tmp.matrix);
      // note units: issuer -> investors, same instant
      this.v.lerpVectors(ISSUER, INVESTORS, e);
      this.tmp.position.set(this.v.x - 0.9, FLOOR_Y + 1.6 - arc * 0.4 + spread * 0.2, this.v.z + spread);
      this.tmp.rotation.set(e * 3, e * 4, 0);
      this.tmp.updateMatrix();
      this.flowUnits.setMatrixAt(i, this.tmp.matrix);
    }
    const swapOn = flowOn ? flowFade : 0;
    this.swapMark.scale.setScalar(0.85 + cross * 0.35);
    ((this.swapMark.children[0] as Mesh).material as MeshBasicMaterial).opacity = swapOn * (0.45 + cross * 0.55);
    (this.swapTag.material as SpriteMaterial).opacity = swapOn;
    this.flowCoins.instanceMatrix.needsUpdate = true;
    this.flowUnits.instanceMatrix.needsUpdate = true;

    // The opening shot's full path fades out as the story begins.
    const pv = 1 - smooth(span(p, 0.05, 0.13));
    (this.preview.material as MeshBasicMaterial).opacity = pv * 0.85;
    this.preview.visible = pv > 0.01;

    // 3–4. Observe and pay: the bright path draws from the strike to maturity.
    const pathT = pathAt(p);
    const segs = Math.floor(pathT * this.pathSegs);
    this.pathGeo.setDrawRange(0, segs * this.pathRadial * 6);
    this.head.visible = pathT > 0.002 && pathT < 0.998;
    this.curve.getPointAt(clamp(pathT, 0, 1), this.v);
    this.head.position.copy(this.v);
    for (const o of this.obs) {
      const since = pathT - o.at;
      const hit = since >= 0;
      const lit = hit || pv > 0.5;
      const ringMat = o.ring.material as MeshBasicMaterial;
      ringMat.color.setHex(lit ? C.signal : C.muted);
      ringMat.opacity = lit ? 1 : 0.55;
      o.ring.quaternion.copy(this.camera.quaternion);
      // pulse: one expanding ring right after the date passes
      const pulse = hit ? clamp(since / 0.07) : 0;
      o.pulse.visible = pulse > 0 && pulse < 1;
      o.pulse.scale.setScalar(1 + pulse * 3.2);
      (o.pulse.material as MeshBasicMaterial).opacity = (1 - pulse) * 0.9;
      o.pulse.quaternion.copy(this.camera.quaternion);
      // Chainlink's check: a hexagon that appears at the date and keeps turning slowly
      const check = hit ? smooth(clamp(since / 0.035)) : 0;
      o.hexMark.visible = check > 0.01;
      o.hexMark.scale.setScalar(0.4 + check * 0.6);
      (o.hexMark.material as LineBasicMaterial).opacity = check;
      (o.cre.material as SpriteMaterial).opacity = check;
      o.hexMark.quaternion.copy(this.camera.quaternion);
      if (!this.opts.reducedMotion) o.hexMark.rotateZ(t * 0.4 + o.x);
    }

    // Coupons: fall from the price to the holders, staggered.
    for (let i = 0; i < this.coinAt.length; i++) {
      const k = clamp((pathT - this.coinAt[i]) / 0.05);
      const e = smooth(k);
      this.v.lerpVectors(this.coinFrom[i], this.coinTo[i], e);
      this.v.y += Math.sin(Math.PI * e) * 2.2; // a small hop before the drop
      this.tmp.position.copy(this.v);
      this.tmp.rotation.set(e * Math.PI * 3, 0, e * Math.PI);
      this.tmp.scale.setScalar(k > 0 ? 1 : 0.0001);
      // Landed coins stand tilted towards the camera, so their USDG faces read.
      if (k >= 1) this.tmp.rotation.set(1.15, 0, 0);
      this.tmp.updateMatrix();
      this.coins.setMatrixAt(i, this.tmp.matrix);
    }
    this.coins.instanceMatrix.needsUpdate = true;
    for (const c of this.couponTags)
      (c.s.material as SpriteMaterial).opacity = smooth(clamp((pathT - c.at - 0.02) / 0.05));
    (this.strikeCre.material as SpriteMaterial).opacity =
      smooth(clamp(pathT / 0.03)) * (1 - smooth(span(p, 0.86, 0.9)));
    (this.marginCre.material as SpriteMaterial).opacity =
      smooth(span(p, 0.5, 0.56)) * (1 - smooth(span(p, 0.84, 0.88)));

    // Dust drifts slowly upward.
    if (!this.opts.reducedMotion) {
      const pos = this.dust.geometry.getAttribute('position') as BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 1; i < arr.length; i += 3)
        arr[i] = FLOOR_Y + frac((this.dustBase[i] - FLOOR_Y + t * 0.18) / 18) * 18;
      pos.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  setProgress(p: number) {
    this.target = clamp(p);
    this.wake();
  }
  setVisible(v: boolean) {
    this.visible = v;
    if (v) this.wake();
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth,
      h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.fov = this.camera.aspect < 1 ? 58 : 42;
    this.camera.updateProjectionMatrix();
    this.renderFrame(performance.now());
  }

  /** Render one frame now (first paint, reduced motion, resize). */
  renderFrame(now = performance.now(), q = this.current) {
    this.clock = now / 1000;
    // The story up to the coupons runs on the original timeline (0..0.8); ending A finishes it (0.8..1: the
    // collateral is released); ending B is the other branch, layered on top.
    const p = q <= STORY_END ? (q / STORY_END) * 0.8 : 0.8 + 0.2 * clamp((q - STORY_END) / (ENDING_SPLIT - STORY_END));
    this.placeCamera(p, this.clock);
    this.apply(p, this.clock);
    this.applyEndings(q);
    this.renderer.render(this.scene, this.camera);
  }

  /** The two endings: A, the price holds (principal back in USDG); B, knocked in (holders repaid final ÷ strike in USDG). */
  private applyEndings(q: number) {
    const a = smoother(span(q, STORY_END + 0.02, STORY_END + 0.12));
    const b = smoother(span(q, ENDING_SPLIT, ENDING_SPLIT + 0.08));
    const deliver = smoother(span(q, ENDING_SPLIT + 0.05, ENDING_SPLIT + 0.14));
    // A: principal coins from the issuer to the holders (fading out when the story turns to ending B).
    for (let i = 0; i < this.principalFrom.length; i++) {
      const e = smoother(clamp(a * 1.25 - i * 0.03));
      this.v.lerpVectors(this.principalFrom[i], this.principalTo[i], e);
      this.v.y += Math.sin(Math.PI * e) * 3;
      this.tmp.position.copy(this.v);
      this.tmp.rotation.set(e >= 1 ? 1.15 : e * Math.PI * 2, 0, 0);
      this.tmp.scale.setScalar(e > 0 ? Math.max(0.0001, 1 - b) : 0.0001);
      this.tmp.updateMatrix();
      this.principal.setMatrixAt(i, this.tmp.matrix);
    }
    this.principal.instanceMatrix.needsUpdate = true;
    (this.principalTag.material as SpriteMaterial).opacity = a * (1 - b);
    // B: the price falls through the knock-in at maturity: a red branch, then the reduced cash repayment to the holders.
    this.branchGeo.setDrawRange(0, Math.floor(b * this.branchSegs) * this.pathRadial * 6);
    this.branch.visible = b > 0.001;
    (this.knockTag.material as SpriteMaterial).opacity = b;
    for (let i = 0; i < this.tslaFrom.length; i++) {
      const e = smoother(clamp(deliver * 1.3 - i * 0.04));
      this.v.lerpVectors(this.tslaFrom[i], this.tslaTo[i], e);
      this.v.y += Math.sin(Math.PI * e) * 2.4;
      this.tmp.position.copy(this.v);
      this.tmp.rotation.set(0, e >= 1 ? -0.35 : e * Math.PI * 2, 0);
      this.tmp.scale.setScalar(e > 0 ? 1 : 0.0001);
      this.tmp.updateMatrix();
      this.tsla.setMatrixAt(i, this.tmp.matrix);
    }
    this.tsla.instanceMatrix.needsUpdate = true;
    (this.tslaTag.material as SpriteMaterial).opacity = deliver;
    // Camera: ending A frames the holders receiving principal; ending B settles on maturity and the rail.
    const ca = smooth(span(q, STORY_END + 0.01, STORY_END + 0.08)) * (1 - smooth(b));
    if (ca > 0) {
      this.camera.position.set(
        mix(this.camera.position.x, 22, ca),
        mix(this.camera.position.y, 10, ca),
        mix(this.camera.position.z, 31, ca),
      );
      this.look.set(mix(this.look.x, 6, ca), mix(this.look.y, 1.2, ca), mix(this.look.z, 3, ca));
      if (this.camera.aspect < 1) {
        this.camera.position.z += 10 * ca;
      }
      this.camera.lookAt(this.look);
    }
    if (b > 0) {
      const k = smooth(b);
      this.camera.position.set(
        mix(this.camera.position.x, 30, k),
        mix(this.camera.position.y, 8.5, k),
        mix(this.camera.position.z, 27, k),
      );
      this.look.set(mix(this.look.x, 15, k), mix(this.look.y, 0.4, k), mix(this.look.z, 4.5, k));
      if (this.camera.aspect < 1) {
        this.camera.position.z += 10 * k;
        this.camera.position.x += 4 * k;
      }
      this.camera.lookAt(this.look);
    }
  }

  /** Jump straight to a progress value (no easing), e.g. the reduced-motion still. */
  snap(p: number) {
    this.current = this.target = clamp(p);
    this.renderFrame();
  }

  private wake() {
    if (this.opts.reducedMotion) {
      this.current = this.target;
      this.renderFrame();
      return;
    }
    if (this.running || !this.visible) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      // Ease toward the scroll position: smooth, never laggy.
      this.current += (this.target - this.current) * (1 - Math.exp(-dt * 6));
      if (Math.abs(this.target - this.current) < 0.0004) this.current = this.target;
      this.renderFrame(now, this.current);
      if (!this.visible) {
        this.running = false;
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    this.scene.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as unknown;
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
      for (const x of mats as Array<{ map?: { dispose(): void }; dispose(): void }>) {
        x.map?.dispose();
        x.dispose();
      }
    });
    this.renderer.dispose();
  }
}
