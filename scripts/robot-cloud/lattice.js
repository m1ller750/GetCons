// Lattice sampling of the robot mesh: points where a regular grid of axis-aligned rays crosses the
// surface. Each surface patch takes the axis closest to its normal, so the points sit in even rows
// and columns (like a 3D scan) instead of random grain. Finer grid on the head, coarser on the legs.
import * as THREE from 'three';

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

async function imageData(url) {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, d: ctx.getImageData(0, 0, img.width, img.height).data };
}
function texel(t, u, v, r) {
  const cx = Math.floor((((u % 1) + 1) % 1) * t.w), cy = Math.floor((1 - (((v % 1) + 1) % 1)) * t.h);
  let R = 0, G = 0, B = 0, n = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.min(t.w - 1, Math.max(0, cx + dx)), y = Math.min(t.h - 1, Math.max(0, cy + dy));
    const k = (y * t.w + x) * 4; R += t.d[k]; G += t.d[k + 1]; B += t.d[k + 2]; n++;
  }
  return [R / n, G / n, B / n];
}

/**
 * Casts rays along `axis` (0 = x, 1 = y, 2 = z) on a lattice over the two other axes, inside the
 * height band [y0, y1), with spacing h. Returns hits whose normal is dominated by that axis.
 */
function castLattice(geo, axis, y0, y1, h, phase, out) {
  const pos = geo.attributes.position.array, nor = geo.attributes.normal.array, uv = geo.attributes.uv.array;
  const ua = axis === 0 ? 2 : 0; // first lattice coordinate
  const va = axis === 1 ? 2 : 1; // second lattice coordinate
  const triCount = pos.length / 9;
  // Bin triangles by their projected bounding box on the lattice cells.
  const bins = new Map();
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ymin = Math.min(pos[o + 1], pos[o + 4], pos[o + 7]), ymax = Math.max(pos[o + 1], pos[o + 4], pos[o + 7]);
    if (ymax < y0 - h || ymin >= y1 + h) continue;
    const u0 = Math.min(pos[o + ua], pos[o + 3 + ua], pos[o + 6 + ua]), u1 = Math.max(pos[o + ua], pos[o + 3 + ua], pos[o + 6 + ua]);
    const v0 = Math.min(pos[o + va], pos[o + 3 + va], pos[o + 6 + va]), v1 = Math.max(pos[o + va], pos[o + 3 + va], pos[o + 6 + va]);
    const i0 = Math.ceil((u0 - phase[0]) / h), i1 = Math.floor((u1 - phase[0]) / h);
    const j0 = Math.ceil((v0 - phase[1]) / h), j1 = Math.floor((v1 - phase[1]) / h);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = i * 100003 + j;
      const l = bins.get(key); if (l) l.push(t); else bins.set(key, [t]);
    }
  }
  let n = 0;
  for (const [key, tris] of bins) {
    const i = Math.round(key / 100003); const j = key - i * 100003;
    const pu = phase[0] + i * h, pv = phase[1] + j * h;
    const hits = [];
    for (const t of tris) {
      const o = t * 9;
      const ax = pos[o + ua], ay = pos[o + va], bx = pos[o + 3 + ua], by = pos[o + 3 + va], cx = pos[o + 6 + ua], cy = pos[o + 6 + va];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-14) continue;
      const w0 = ((by - cy) * (pu - cx) + (cx - bx) * (pv - cy)) / d;
      const w1 = ((cy - ay) * (pu - cx) + (ax - cx) * (pv - cy)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
      const depth = w0 * pos[o + axis] + w1 * pos[o + 3 + axis] + w2 * pos[o + 6 + axis];
      hits.push([depth, t, w0, w1, w2]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    let last = -1e9;
    for (const [depth, t, w0, w1, w2] of hits) {
      if (depth - last < 1e-4) continue; // the same crossing found on two neighbouring triangles
      last = depth;
      const o = t * 9, q = t * 6;
      const p = [0, 0, 0];
      p[axis] = depth; p[ua] = pu; p[va] = pv;
      if (p[1] < y0 || p[1] >= y1) continue;
      let nx = w0 * nor[o] + w1 * nor[o + 3] + w2 * nor[o + 6];
      let ny = w0 * nor[o + 1] + w1 * nor[o + 4] + w2 * nor[o + 7];
      let nz = w0 * nor[o + 2] + w1 * nor[o + 5] + w2 * nor[o + 8];
      const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
      const a = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
      if (a[axis] < a[(axis + 1) % 3] || a[axis] < a[(axis + 2) % 3]) continue; // another axis owns this patch
      out.push({
        p, n: [nx, ny, nz],
        uv: [w0 * uv[q] + w1 * uv[q + 2] + w2 * uv[q + 4], w0 * uv[q + 1] + w1 * uv[q + 3] + w2 * uv[q + 5]],
        coarse: (((i % 2) + 2) % 2 === 0) && (((j % 2) + 2) % 2 === 0),
      });
      n++;
    }
  }
  return n;
}

window.convertLattice = async (o) => {
  const log = [];
  let mesh; window.model.traverse((x) => { if (x.isMesh) mesh = x; });
  const g = mesh.geometry.clone(); g.applyMatrix4(mesh.matrixWorld);
  if (g.index) throw new Error('indexed geometry not expected');
  const rand = mulberry32(o.seed);

  // Height bands (model units) and their grid spacing relative to the head's.
  const bands = [
    [o.chinY - 0.05, 99, 1.0],
    [o.neckLo, o.chinY - 0.05, 1.12],
    [2.0, o.neckLo, 1.3],
    [0.0, 2.0, 1.55],
    [-1.0, 0.0, 1.85],
    [-3.5, -1.0, 2.3],
    [-99, -3.5, 2.7],
  ];
  const run = (h0) => {
    const pts = [];
    for (const [y0, y1, f] of bands) {
      const h = h0 * f;
      for (let axis = 0; axis < 3; axis++) castLattice(g, axis, y0, y1, h, [0.5 * h, 0.5 * h], pts);
    }
    return pts;
  };
  // Find the head spacing that gives about N points (count ~ 1/h^2).
  let h0 = o.h0 ?? 0.03, pts = run(h0);
  for (let it = 0; it < 4 && Math.abs(pts.length - o.N) > o.N * 0.02; it++) {
    h0 *= Math.sqrt(pts.length / o.N);
    pts = run(h0);
  }
  log.push(`lattice h0 ${h0.toFixed(4)} -> ${pts.length} points`);

  // Visibility from many directions: drop points buried inside the shell, measure occlusion.
  const box = new THREE.Box3().setFromBufferAttribute(g.attributes.position);
  const center = box.getCenter(new THREE.Vector3());
  const R = (box.getSize(new THREE.Vector3()).length() / 2) * 1.02;
  const S = o.mapSize;
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(64, 64);
  const rt = new THREE.WebGLRenderTarget(S, S, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: 'varying float vD; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying float vD; void main(){ gl_FragColor = vec4(vD, 0.0, 0.0, 1.0); }',
  });
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(g, mat));
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.01, R * 8);
  const buf = new Float32Array(S * S * 4);
  const C = pts.length;
  const vis = new Uint16Array(C), hemi = new Uint16Array(C), seen = new Uint8Array(C);
  const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
  for (let k = 0; k < o.dirs; k++) {
    const yk = 1 - (2 * (k + 0.5)) / o.dirs, rk = Math.sqrt(1 - yk * yk), th = k * Math.PI * (3 - Math.sqrt(5));
    const dir = new THREE.Vector3(Math.cos(th) * rk, yk, Math.sin(th) * rk);
    cam.position.copy(center).addScaledVector(dir, R * 3);
    if (Math.abs(dir.y) > 0.95) cam.up.set(1, 0, 0); else cam.up.set(0, 1, 0);
    cam.lookAt(center); cam.updateMatrixWorld();
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf);
    right.setFromMatrixColumn(cam.matrixWorld, 0); up.setFromMatrixColumn(cam.matrixWorld, 1); fwd.setFromMatrixColumn(cam.matrixWorld, 2).negate();
    for (let i = 0; i < C; i++) {
      const pt = pts[i];
      const facing = pt.n[0] * dir.x + pt.n[1] * dir.y + pt.n[2] * dir.z > 0.15;
      const qx = pt.p[0] - cam.position.x, qy = pt.p[1] - cam.position.y, qz = pt.p[2] - cam.position.z;
      const px = Math.floor(((qx * right.x + qy * right.y + qz * right.z) / R + 1) * 0.5 * S);
      const py = Math.floor(((qx * up.x + qy * up.y + qz * up.z) / R + 1) * 0.5 * S);
      const d = qx * fwd.x + qy * fwd.y + qz * fwd.z;
      let ok = true;
      if (px >= 0 && py >= 0 && px < S && py < S) { const m = buf[(py * S + px) * 4]; ok = m === 0 || d <= m + o.eps; }
      if (ok) seen[i] = 1;
      if (facing) { hemi[i]++; if (ok) vis[i]++; }
    }
  }
  renderer.setRenderTarget(null); rt.dispose(); renderer.dispose();

  // Colours → tones; coarse lattice points first (phones use only them), each group shuffled.
  const base = await imageData('/model/' + o.base + '.png');
  const s = 1.1 / (o.topY - o.chinY);
  const toneCount = [0, 0, 0, 0, 0, 0, 0, 0];
  const keep = [];
  for (let i = 0; i < C; i++) {
    if (!seen[i] || vis[i] === 0) continue;
    const pt = pts[i];
    const [r, gg, b] = texel(base, pt.uv[0], pt.uv[1], o.blur);
    const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    let tone;
    if (b > 150 && b - r > 28 && lum > 110) tone = 6;
    else if (lum >= o.whiteLum) tone = 4;
    else tone = o.darkTone;
    toneCount[tone]++;
    const [x, y, z] = pt.p;
    const radial = Math.hypot(x, z - o.zc);
    const head = y >= o.chinY ? 1 : smooth(o.neckLo, o.chinY, y) * (1 - smooth(0.5, 0.8, radial));
    keep.push({ p: [x * s, 1.3 + (y - o.chinY) * s, (z - o.zc) * s], n: pt.n, ao: hemi[i] ? vis[i] / hemi[i] : 1, tone, head, coarse: pt.coarse });
  }
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
  const coarse = shuffle(keep.filter((k) => k.coarse)), fine = shuffle(keep.filter((k) => !k.coarse));
  const rec = coarse.concat(fine);
  log.push(`kept ${rec.length} (coarse ${coarse.length}); tones ${toneCount.join(',')}`);

  const count = rec.length;
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const r of rec) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], r.p[k]); mx[k] = Math.max(mx[k], r.p[k]); }
  const bytes = new ArrayBuffer(32 + count * 8);
  const dv = new DataView(bytes);
  [71, 67, 82, 49].forEach((ch, k) => dv.setUint8(k, ch));
  dv.setUint32(4, count, true);
  for (let k = 0; k < 3; k++) { dv.setFloat32(8 + k * 4, mn[k], true); dv.setFloat32(20 + k * 4, mx[k], true); }
  const pos = new Uint32Array(bytes, 32, count);
  const oct = new Int8Array(bytes, 32 + count * 4, count * 2);
  const len = new Uint8Array(bytes, 32 + count * 6, count);
  const th = new Uint8Array(bytes, 32 + count * 7, count);
  const BITS = [1023, 4095, 1023];
  rec.forEach((r, i) => {
    const q = r.p.map((v, k) => Math.round(((v - mn[k]) / (mx[k] - mn[k] || 1)) * BITS[k]));
    pos[i] = (q[0] | (q[1] << 10) | (q[2] << 22)) >>> 0;
    let [x, y, z] = r.n; const L = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1; x /= L; y /= L; z /= L;
    if (z < 0) { const ox = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1), oy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1); x = ox; y = oy; }
    oct[i * 2] = Math.round(x * 127); oct[i * 2 + 1] = Math.round(y * 127);
    len[i] = Math.round(Math.min(1, Math.max(0, r.ao)) * 255);
    th[i] = (r.tone & 15) | (Math.round(r.head * 15) << 4);
  });
  let bin = ''; const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { log, b64: btoa(bin), bbox: [mn, mx] };
};
window.latticeReady = true;
