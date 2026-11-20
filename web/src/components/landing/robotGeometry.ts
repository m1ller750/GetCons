/**
 * Point cloud of the GetCons humanoid robot: the same body as the reference model (a white
 * clearcoat shell over gunmetal joints with chrome rings, a black glass chest plate, a head whose
 * face is one black glass visor with a glowing white line at eye level, slim arms with hands,
 * legs). Every part is the same simple shape as in the model (ellipsoids, cylinders, rings,
 * lathed limbs, the deformed head sphere), placed through the same hierarchy of joints; the
 * points sit on even grids over each surface, and points buried inside a neighbouring part are
 * dropped so joints stay clean.
 *
 * Model units are metres of the reference (the robot is ~1.8 tall, feet at y = 0). They are
 * mapped into the scene's robot space, where the chin sits at y ≈ 1.3 and the top of the head at
 * y ≈ 2.4 (the camera choreography frames the head and chest), the face looks towards +z.
 */

type V3 = [number, number, number];
/** Row-major 3×4 affine matrix. */
type M = number[];

export interface RobotCloud {
  count: number;
  /** xyz per point */
  positions: Float32Array;
  /** surface normal per point, for lighting; its length (0.3..1) is the ambient occlusion */
  normals: Float32Array;
  /**
   * 0 = dark satin, 1 = accent light (glows), 2 = gunmetal, 3 = lettering, 4 = white shell,
   * 5 = glossy black glass (5..5.4: lit by the eye line), 6 = eye line (glows), 7 = chrome
   */
  tones: Float32Array;
  /** 0..1: how much the point follows head rotation */
  headWeights: Float32Array;
}

const DARK = 0;
const METAL = 2;
const WHITE = 4;
const GLASS = 5;
const LIGHT = 6;
const CHROME = 7;

/** Model → scene: uniform scale, chin (model y 1.55) at scene y 1.3. */
const SCALE = 4.7;
const toScene = (p: V3): V3 => [p[0] * SCALE, (p[1] - 1.55) * SCALE + 1.3, p[2] * SCALE];

// ---------------------------------------------------------------------------
// Matrices (three.js conventions: T · R(XYZ Euler) · S)
// ---------------------------------------------------------------------------
const IDENTITY: M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function mul(a: M, b: M): M {
  const o = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 4 + c] = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]!;
    o[r * 4 + 3] = a[r * 4]! * b[3]! + a[r * 4 + 1]! * b[7]! + a[r * 4 + 2]! * b[11]! + a[r * 4 + 3]!;
  }
  return o;
}

function trs(pos: V3, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): M {
  const a = Math.cos(rot[0]), b = Math.sin(rot[0]);
  const c = Math.cos(rot[1]), d = Math.sin(rot[1]);
  const e = Math.cos(rot[2]), f = Math.sin(rot[2]);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  const r = [c * e, -c * f, d, af + be * d, ae - bf * d, -b * c, bf - ae * d, be + af * d, a * c];
  return [
    r[0]! * scale[0], r[1]! * scale[1], r[2]! * scale[2], pos[0],
    r[3]! * scale[0], r[4]! * scale[1], r[5]! * scale[2], pos[1],
    r[6]! * scale[0], r[7]! * scale[1], r[8]! * scale[2], pos[2],
  ];
}

/** A matrix whose local y axis runs from a to b (for rods between two points). */
function along(a: V3, b: V3): M {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const y: V3 = [d[0] / len, d[1] / len, d[2] / len];
  const ref: V3 = Math.abs(y[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const z = norm(cross(ref, y));
  const x = cross(y, z);
  const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return [x[0], y[0] * len, z[0], mid[0], x[1], y[1] * len, z[1], mid[1], x[2], y[2] * len, z[2], mid[2]];
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

const apply = (m: M, p: V3): V3 => [
  m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!,
  m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!,
  m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!,
];

function invert(m: M): M {
  const [a, b, c, , d, e, f, , g, h, i] = m as [number, number, number, number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  const t: V3 = [m[3]!, m[7]!, m[11]!];
  return [
    inv[0]!, inv[1]!, inv[2]!, -(inv[0]! * t[0] + inv[1]! * t[1] + inv[2]! * t[2]),
    inv[3]!, inv[4]!, inv[5]!, -(inv[3]! * t[0] + inv[4]! * t[1] + inv[5]! * t[2]),
    inv[6]!, inv[7]!, inv[8]!, -(inv[6]! * t[0] + inv[7]! * t[1] + inv[8]! * t[2]),
  ];
}

/** Normals go through the inverse transpose (correct under non-uniform scale). */
const normalOut = (inv: M, n: V3): V3 => norm([inv[0]! * n[0] + inv[4]! * n[1] + inv[8]! * n[2], inv[1]! * n[0] + inv[5]! * n[1] + inv[9]! * n[2], inv[2]! * n[0] + inv[6]! * n[1] + inv[10]! * n[2]]);

/** World length of the matrix's local axis k (0 = x, 1 = y, 2 = z). */
const axisScale = (m: M, k: number) => Math.hypot(m[k]!, m[4 + k]!, m[8 + k]!);

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------
interface SurfacePoint {
  p: V3;
  n: V3;
  tone: number;
}

interface Part {
  m: M;
  inv: M;
  tone: number;
  /** Point density relative to the rest (the head and chest are what the camera frames). */
  weight: number;
  /** 0..1: follows the head's rotation. */
  head: number;
  /** World bounding sphere for quick rejection in the buried-point test. */
  center: V3;
  radius: number;
  /** Surface points in local space for grid spacing `d` (world units). */
  sample(d: number): SurfacePoint[];
  /** Is a local point inside (by a relative margin)? Null for parts that hide nothing. */
  inside: ((q: V3, margin: number) => boolean) | null;
}

const TAU = Math.PI * 2;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const rows = (length: number, d: number, min = 2) => Math.max(min, Math.round(length / d));

class Body {
  parts: Part[] = [];

  private add(part: Omit<Part, 'inv' | 'center' | 'radius'>, boundRadius: number) {
    const center = apply(part.m, [0, 0, 0]);
    const s = Math.max(axisScale(part.m, 0), axisScale(part.m, 1), axisScale(part.m, 2));
    this.parts.push({ ...part, inv: invert(part.m), center, radius: boundRadius * s * 1.05 });
  }

  /** Unit sphere scaled by the matrix (three's SphereGeometry): ellipsoids and balls. */
  sphere(m: M, tone: number, weight: number, head = 0) {
    const sx = axisScale(m, 0), sy = axisScale(m, 1), sz = axisScale(m, 2);
    this.add(
      {
        m,
        tone,
        weight,
        head,
        sample: (d) => {
          const out: SurfacePoint[] = [];
          const n = rows((Math.PI * (sx + sy + sz)) / 3, d, 3);
          for (let i = 0; i < n; i++) {
            const theta = (Math.PI * (i + 0.5)) / n;
            const ring = rows((TAU * Math.sin(theta) * (sx + sz)) / 2, d, 3);
            for (let j = 0; j < ring; j++) {
              const phi = (TAU * (j + (i % 2) * 0.5)) / ring;
              const v: V3 = [Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi)];
              out.push({ p: v, n: v, tone });
            }
          }
          return out;
        },
        inside: (q, k) => q[0] * q[0] + q[1] * q[1] + q[2] * q[2] < (1 - k) * (1 - k),
      },
      1,
    );
  }

  /** Part of a sphere (three's SphereGeometry with phi/theta ranges): the chest plate. */
  patch(m: M, tone: number, weight: number, phi0: number, phiLen: number, theta0: number, thetaLen: number) {
    const sx = axisScale(m, 0), sy = axisScale(m, 1);
    const point = (phi: number, theta: number): V3 => [-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)];
    this.add(
      {
        m,
        tone,
        weight,
        head: 0,
        sample: (d) => {
          const out: SurfacePoint[] = [];
          const n = rows(thetaLen * sy, d, 3);
          for (let i = 0; i < n; i++) {
            const theta = theta0 + (thetaLen * (i + 0.5)) / n;
            const ring = rows(phiLen * Math.sin(theta) * sx, d, 3);
            for (let j = 0; j < ring; j++) {
              const v = point(phi0 + (phiLen * (j + 0.5)) / ring, theta);
              out.push({ p: v, n: v, tone });
            }
          }
          return out;
        },
        // Hides what lies under the plate (inside the sphere, within its angles).
        inside: (q) => {
          const r = Math.hypot(q[0], q[1], q[2]);
          if (r > 1 || r < 0.6) return false;
          const theta = Math.acos(q[1] / r);
          const phi = Math.atan2(q[2], -q[0]);
          return theta > theta0 && theta < theta0 + thetaLen && phi > phi0 && phi < phi0 + phiLen;
        },
      },
      1,
    );
  }

  /** three's CylinderGeometry (radiusTop at y = +h/2), with caps. */
  cylinder(m: M, top: number, bottom: number, h: number, tone: number, weight: number, head = 0) {
    const sx = axisScale(m, 0), sy = axisScale(m, 1);
    const radiusAt = (y: number) => bottom + ((top - bottom) * (y + h / 2)) / h;
    const slope = (bottom - top) / h;
    this.add(
      {
        m,
        tone,
        weight,
        head,
        sample: (d) => {
          const out: SurfacePoint[] = [];
          const n = rows(h * sy, d, 2);
          for (let i = 0; i < n; i++) {
            const y = -h / 2 + (h * (i + 0.5)) / n;
            const r = radiusAt(y);
            const ring = rows(TAU * r * sx, d, 6);
            for (let j = 0; j < ring; j++) {
              const phi = (TAU * (j + (i % 2) * 0.5)) / ring;
              out.push({ p: [r * Math.sin(phi), y, r * Math.cos(phi)], n: [Math.sin(phi), slope, Math.cos(phi)], tone });
            }
          }
          for (const [y, r, ny] of [[h / 2, top, 1], [-h / 2, bottom, -1]] as const) {
            const k = rows(r * sx, d, 1);
            out.push({ p: [0, y, 0], n: [0, ny, 0], tone });
            for (let i = 1; i <= k; i++) {
              const rr = (r * i) / k;
              const ring = rows(TAU * rr * sx, d, 6);
              for (let j = 0; j < ring; j++) {
                const phi = (TAU * j) / ring;
                out.push({ p: [rr * Math.sin(phi), y, rr * Math.cos(phi)], n: [0, ny, 0], tone });
              }
            }
          }
          return out;
        },
        inside: (q, k) => Math.abs(q[1]) < (h / 2) * (1 - k) && Math.hypot(q[0], q[2]) < radiusAt(q[1]) * (1 - k),
      },
      Math.hypot(Math.max(top, bottom), h / 2),
    );
  }

  /** three's TorusGeometry (in its own XY plane): the chrome rings. */
  torus(m: M, R: number, t: number, tone: number, weight: number, head = 0) {
    const s = (axisScale(m, 0) + axisScale(m, 1)) / 2;
    this.add(
      {
        m,
        tone,
        weight,
        head,
        sample: (d) => {
          const out: SurfacePoint[] = [];
          const nu = rows(TAU * R * s, d, 12);
          const nv = rows(TAU * t * s, d, 4);
          for (let i = 0; i < nu; i++) {
            const u = (TAU * i) / nu;
            for (let j = 0; j < nv; j++) {
              const v = (TAU * (j + (i % 2) * 0.5)) / nv;
              const nrm: V3 = [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)];
              out.push({ p: [(R + t * Math.cos(v)) * Math.cos(u), (R + t * Math.cos(v)) * Math.sin(u), t * Math.sin(v)], n: nrm, tone });
            }
          }
          return out;
        },
        inside: (q, k) => {
          const a = Math.hypot(q[0], q[1]) - R;
          return a * a + q[2] * q[2] < t * t * (1 - k) * (1 - k);
        },
      },
      R + t,
    );
  }

  /** The reference's limb(): a lathed profile hanging down from the joint (open ends). */
  limb(m: M, len: number, r0: number, r1: number, bulge: number, tone: number, weight: number, head = 0) {
    const sx = axisScale(m, 0), sy = axisScale(m, 1);
    const radius = (t: number) => r1 + (r0 - r1) * t + Math.sin(Math.PI * t) * bulge;
    const drdt = (t: number) => r0 - r1 + Math.PI * Math.cos(Math.PI * t) * bulge;
    this.add(
      {
        m,
        tone,
        weight,
        head,
        sample: (d) => {
          const out: SurfacePoint[] = [];
          const n = rows(len * sy, d, 3);
          for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n;
            const y = -len * (1 - t);
            const r = radius(t);
            const ring = rows(TAU * r * sx, d, 6);
            const slope = -drdt(t) / len;
            for (let j = 0; j < ring; j++) {
              const phi = (TAU * (j + (i % 2) * 0.5)) / ring;
              out.push({ p: [r * Math.sin(phi), y, r * Math.cos(phi)], n: [Math.sin(phi), slope, Math.cos(phi)], tone });
            }
          }
          return out;
        },
        inside: (q, k) => {
          if (q[1] > 0 || q[1] < -len) return false;
          const t = 1 + q[1] / len;
          return Math.hypot(q[0], q[2]) < radius(t) * (1 - k);
        },
      },
      Math.hypot(len / 2, Math.max(r0, r1) + bulge) + len / 2,
    );
  }

  /** The head: the reference's deformed sphere, its face a black glass visor with the eye line. */
  head(m: M, weight: number) {
    this.add(
      {
        m,
        tone: WHITE,
        weight,
        head: 1,
        sample: (d) => {
          const out: SurfacePoint[] = [];
          const n = rows(Math.PI * RY, d, 8);
          for (let i = 0; i < n; i++) {
            const theta = (Math.PI * (i + 0.5)) / n;
            const ring = rows(TAU * Math.sin(theta) * RX, d, 6);
            for (let j = 0; j < ring; j++) {
              const phi = (TAU * (j + (i % 2) * 0.5)) / ring - Math.PI;
              const p = headPoint(theta, phi);
              const e = 1e-3;
              const a = headPoint(theta + e, phi);
              const b = headPoint(theta, phi + e);
              let nrm = norm(cross([b[0] - p[0], b[1] - p[1], b[2] - p[2]], [a[0] - p[0], a[1] - p[1], a[2] - p[2]]));
              if (nrm[0] * p[0] + nrm[1] * (p[1] - YC) + nrm[2] * (p[2] + 0.01) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
              out.push({ p, n: nrm, tone: headTone(theta, phi, p) });
            }
          }
          // The eye line: three rows of light that thin out towards the temples.
          const step = d / 2.4;
          for (let ph = -EYE_HALF; ph <= EYE_HALF + 1e-9; ph += step / RX) {
            const taper = 1 - (ph / EYE_HALF) ** 2;
            for (const dy of [-0.0016, 0, 0.0016]) {
              if (dy !== 0 && taper < 0.35) continue;
              const p = eyeSurface(ph, EYE_Y + dy, 0.0016);
              out.push({ p, n: norm([Math.sin(ph), 0, Math.cos(ph)]), tone: LIGHT });
            }
          }
          return out;
        },
        inside: (q, k) => {
          // Approximate: compare with the head surface in the same direction.
          const dir = norm([q[0] / RX, (q[1] - YC) / RY, (q[2] + 0.01) / RZ]);
          const theta = Math.acos(Math.max(-1, Math.min(1, dir[1])));
          const phi = Math.atan2(dir[0], dir[2]);
          const s = headPoint(theta, phi);
          const rq = Math.hypot(q[0], q[1] - YC, q[2] + 0.01);
          const rs = Math.hypot(s[0], s[1] - YC, s[2] + 0.01);
          return rq < rs * (1 - k);
        },
      },
      0.3,
    );
  }
}

// The head of the reference model, in its own space (origin at the base of the skull).
const RX = 0.098;
const RY = 0.115;
const RZ = 0.106;
const YC = 0.115;
const EYE_Y = 0.118;
const EYE_HALF = 1.08;

/** hp() of the reference: the jaw narrows and the chin comes forward. */
function hp(nx: number, ny: number, nz: number): V3 {
  const lo = Math.pow(clamp01((-ny - 0.05) / 0.9), 1.5);
  return [RX * (1 - 0.2 * lo) * nx, YC + RY * ny, -0.01 + 0.052 * lo + (nz < 0 ? 0.112 : RZ) * nz];
}

/** Direction from (theta from the top, phi from the front towards +x) to the head surface. */
function headPoint(theta: number, phi: number): V3 {
  return hp(Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi));
}

/** The visor: the front of the face up to the brow, its upper edge rounded (as fw() of the reference). */
function headTone(theta: number, phi: number, p: V3): number {
  const y = p[1];
  const f = 1.18 * (y > 0.13 ? Math.sqrt(clamp01(1 - ((y - 0.13) / 0.065) ** 2)) : 1);
  const k = y > 0.196 ? 0 : 1 - smoothstep(f - 0.03, f + 0.03, Math.abs(phi));
  void theta;
  if (k < 0.5) return WHITE;
  // Glass around the eye line catches its light.
  const dy = Math.abs(y - EYE_Y);
  const along = Math.max(0, Math.abs(phi) - EYE_HALF);
  const dist = Math.hypot(dy, along * RX);
  const spill = 1 - clamp01((dist - 0.003) / 0.016);
  return GLASS + 0.4 * spill * spill;
}

function eyeSurface(phi: number, y: number, offset: number): V3 {
  const ny = (y - YC) / RY;
  const rr = Math.sqrt(1 - ny * ny);
  const p = hp(Math.sin(phi) * rr, ny, Math.cos(phi) * rr);
  return [p[0] + Math.sin(phi) * offset, p[1], p[2] + Math.cos(phi) * offset];
}

// ---------------------------------------------------------------------------
// The robot, part by part, as in the reference
// ---------------------------------------------------------------------------
function buildBody(): Body {
  const b = new Body();
  const R = IDENTITY;
  const at = (parent: M, pos: V3, rot?: V3, scale?: V3) => mul(parent, trs(pos, rot, scale));
  const sph = (r: number, s: V3, tone: number, pos: V3, parent: M, weight: number, rot?: V3, head = 0) =>
    b.sphere(at(parent, pos, rot, [r * s[0], r * s[1], r * s[2]]), tone, weight, head);
  const ball = (r: number, tone: number, pos: V3, parent: M, weight: number, head = 0) => sph(r, [1, 1, 1], tone, pos, parent, weight, undefined, head);
  const ring = (r: number, t: number, tone: number, pos: V3, parent: M, weight: number, scaleY = 1, head = 0) =>
    b.torus(at(parent, pos, [Math.PI / 2, 0, 0], [1, scaleY, 1]), r, t, tone, weight, head);

  // Hips, waist and the segmented abdomen.
  sph(0.115, [1.2, 0.74, 0.88], WHITE, [0, 0.965, 0], R, 0.8);
  ball(0.075, METAL, [0, 1, 0], R, 0.8);
  for (let i = 0; i < 6; i++) ring(0.088 - Math.abs(i - 2.5) * 0.005, 0.011, METAL, [0, 1.035 + i * 0.02, 0], R, 1);
  b.cylinder(at(R, [0, 1.085, 0]), 0.07, 0.07, 0.16, DARK, 0.8);

  // Chest: white shell, the collarbone bar, the black glass plate, the spine rod.
  const ch = at(R, [0, 1.17, 0]);
  sph(0.15, [1.1, 1.25, 0.78], WHITE, [0, 0.13, 0], ch, 1.7);
  sph(0.05, [3.6, 0.64, 1.7], WHITE, [0, 0.268, -0.005], ch, 1.7);
  b.patch(at(ch, [0, 0.13, 0], undefined, [0.169, 0.191, 0.12]), GLASS, 1.9, Math.PI / 2 - 0.62, 1.24, 0.85, 1.3);
  b.cylinder(at(ch, [0, 0.13, -0.118]), 0.014, 0.014, 0.3, METAL, 1.2);

  // Arms, hands and fingers.
  for (const s of [-1, 1]) {
    const sh = at(R, [s * 0.2, 1.435, 0], [0, 0, s * 0.13]);
    ball(0.046, METAL, [0, 0, 0], sh, 1.4);
    sph(0.054, [1, 0.9, 1.05], WHITE, [s * 0.01, 0.016, 0], sh, 1.4);
    ring(0.043, 0.006, CHROME, [0, -0.03, 0], sh, 1.6);
    b.limb(at(sh, [0, -0.03, 0]), 0.29, 0.042, 0.034, 0.008, WHITE, 1.1);
    const el = at(sh, [0, -0.335, 0], [-0.3, 0, 0]);
    ball(0.04, METAL, [0, 0, 0], el, 1);
    ring(0.037, 0.006, CHROME, [0, -0.025, 0], el, 1.2);
    b.limb(at(el, [0, -0.03, 0]), 0.26, 0.038, 0.027, 0.011, WHITE, 0.9);
    b.cylinder(at(el, [0, -0.3, 0]), 0.027, 0.027, 0.03, METAL, 0.9);
    const hd = at(el, [0, -0.325, 0], [0, -s * Math.PI / 2, 0]);
    sph(0.03, [1, 1.2, 0.45], WHITE, [0, -0.04, 0], hd, 1);
    for (let f = 0; f < 4; f++) {
      let p = hd;
      const x = -s * (f - 1.5) * 0.0145;
      const sc = [0.95, 1.05, 1, 0.8][f]! * 1.2;
      for (let k = 0; k < 3; k++) {
        const L = [0.026, 0.019, 0.016][k]! * sc;
        const q = at(p, k ? [0, -[0.026, 0.019][k - 1]! * sc, 0] : [x, -0.064, 0], [-(0.12 + 0.3 * k), 0, 0]);
        const r = 0.0062 - k * 0.0006;
        b.cylinder(at(q, [0, -L / 2, 0]), r, r * 0.93, L, WHITE, 0.9);
        ball(r, METAL, [0, 0, 0], q, 0.9);
        p = q;
      }
    }
    let p = hd;
    for (let k = 0; k < 2; k++) {
      const L = 0.024 - k * 0.005;
      const r = 0.0072 - k * 0.0006;
      const q = at(p, k ? [0, -0.024, 0] : [s * 0.03, -0.04, 0.004], [-0.3, 0, k ? s * 0.3 : s * 0.5]);
      b.cylinder(at(q, [0, -L / 2, 0]), r, r * 0.92, L, WHITE, 0.9);
      ball(r, METAL, [0, 0, 0], q, 0.9);
      p = q;
    }
  }

  // Legs: hip joints, thighs, knees with caps and rings, shins, ankles, feet.
  for (const s of [-1, 1]) {
    const lg = at(R, [s * 0.092, 0.93, 0], [0, 0, s * 0.03]);
    ball(0.057, METAL, [0, 0, 0], lg, 0.5);
    b.limb(at(lg, [0, -0.02, 0]), 0.43, 0.072, 0.05, 0.014, WHITE, 0.35);
    const kn = at(lg, [0, -0.465, 0]);
    ball(0.049, METAL, [0, 0, 0], kn, 0.35);
    sph(0.042, [1, 1.15, 0.7], WHITE, [0, 0.005, 0.042], kn, 0.35);
    ring(0.045, 0.006, CHROME, [0, -0.045, 0], kn, 0.5);
    b.limb(at(kn, [0, -0.03, 0]), 0.37, 0.05, 0.034, 0.013, WHITE, 0.3);
    ball(0.034, METAL, [0, -0.405, 0], kn, 0.3);
    sph(0.05, [0.92, 0.8, 2.4], WHITE, [0, -0.425, 0.045], kn, 0.3);
    sph(0.05, [0.97, 0.18, 2.5], METAL, [0, -0.457, 0.045], kn, 0.3);
  }

  // Neck: dark column with chrome rings, the tendons and the trapezius shells.
  const neckHead = 0.55;
  b.limb(at(R, [0, 1.58, -0.012], undefined, [1, 1, 0.92]), 0.1, 0.056, 0.066, 0, DARK, 2.2, neckHead);
  for (const [y, r] of [[1.5, 0.064], [1.525, 0.0615], [1.55, 0.059]] as const) ring(r, 0.0035, CHROME, [0, y, -0.012], R, 2.4, 0.92, neckHead);
  for (const s of [-1, 1]) {
    b.cylinder(along([s * 0.06, 1.572, -0.015], [s * 0.036, 1.487, 0.06]), 0.012, 0.012, 1, WHITE, 2);
    sph(0.05, [1.7, 0.55, 1.15], WHITE, [s * 0.072, 1.465, -0.012], R, 1.8, [0, 0, -s * 0.28]);
  }
  ball(0.011, METAL, [0, 1.527, 0.044], R, 2);

  // Head with its ear modules.
  const HG = at(R, [0, 1.55, 0]);
  b.head(HG, 3.4);
  for (const s of [-1, 1]) {
    b.cylinder(at(HG, [s * 0.097, 0.1, -0.012], [0, 0, Math.PI / 2]), 0.03, 0.03, 0.016, METAL, 2.6, 1);
    b.cylinder(at(HG, [s * 0.101, 0.1, -0.012], [0, 0, Math.PI / 2]), 0.02, 0.02, 0.02, CHROME, 2.6, 1);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------
interface Sample {
  p: V3;
  n: V3;
  tone: number;
  head: number;
}

const BURIED = 0.02;
const CREASE = 0.12;

function sampleBody(body: Body, spacing: number): Sample[] {
  const out: Sample[] = [];
  const parts = body.parts;
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi]!;
    const d = spacing / Math.sqrt(part.weight);
    for (const s of part.sample(d)) {
      const p = apply(part.m, s.p);
      // Drop points buried in a neighbouring part; darken those in a crease next to one.
      let buried = false;
      let crease = false;
      for (let oi = 0; oi < parts.length && !buried; oi++) {
        if (oi === pi) continue;
        const other = parts[oi]!;
        if (!other.inside) continue;
        const dx = p[0] - other.center[0], dy = p[1] - other.center[1], dz = p[2] - other.center[2];
        if (dx * dx + dy * dy + dz * dz > other.radius * other.radius * 1.4) continue;
        const q = apply(other.inv, p);
        if (other.inside(q, BURIED)) buried = true;
        else if (!crease && other.inside(q, -CREASE)) crease = true;
      }
      if (buried) continue;
      const n = normalOut(part.inv, s.n);
      const ao = crease ? 0.62 : 1;
      out.push({ p: toScene(p), n: [n[0] * ao, n[1] * ao, n[2] * ao], tone: s.tone, head: part.head });
    }
  }
  return out;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildRobotCloud(total: number, seed = 7): RobotCloud {
  const rand = mulberry32(seed);
  const body = buildBody();

  // Calibrate the grid spacing so the sampled surface yields about `total` points.
  let spacing = 0.006;
  let samples = sampleBody(body, spacing);
  for (let i = 0; i < 3 && (samples.length > total * 1.03 || samples.length < total * 0.95); i++) {
    spacing *= Math.sqrt(samples.length / total);
    samples = sampleBody(body, spacing);
  }
  if (samples.length > total) {
    // A few too many: drop points that face away from the viewer (random removal leaves holes).
    samples = samples
      .map((s, i) => ({ s, i }))
      .sort((a, b) => a.s.n[2] - b.s.n[2])
      .slice(samples.length - total)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.s);
  }
  // Top up by duplicating random surface points with a tiny offset.
  const base = samples.length;
  while (samples.length < total) {
    const src = samples[Math.floor(rand() * Math.max(base, 1))]!;
    samples.push({ ...src, p: [src.p[0] + (rand() - 0.5) * 0.01, src.p[1] + (rand() - 0.5) * 0.01, src.p[2] + (rand() - 0.5) * 0.01] });
  }
  // Shuffle so every part of the wave feeds every part of the body during assembly.
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [samples[i], samples[j]] = [samples[j]!, samples[i]!];
  }

  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const tones = new Float32Array(total);
  const headWeights = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const s = samples[i]!;
    positions.set(s.p, i * 3);
    normals.set(s.n, i * 3);
    tones[i] = s.tone;
    headWeights[i] = s.head;
  }
  return { count: total, positions, normals, tones, headWeights };
}
