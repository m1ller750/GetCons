import * as THREE from 'three';
import cloudUrl from './robot-cloud.bin?url';
import { loadRobotCloud, type RobotCloud } from './robotCloud';

/** Where the particles are and what they form, driven by scroll. */
export interface SceneState {
  /** 0 = particles form the wave "ceiling", 1 = assembled robot */
  assemble: number;
  /** robot placement in world units (camera looks at the origin from z = 12) */
  x: number;
  y: number;
  scale: number;
  rotY: number;
  /** 0..1: the robot dissolves into dust spread over the whole screen */
  dust: number;
  /** 0..1: the dust gathers into the "GetCons" wordmark */
  text: number;
  opacity: number;
  /** robot height (local units) where the body has faded out; it is opaque 0.55 higher */
  fade: number;
}

const CAMERA_Z = 12;
const FOV = 35;
const WORDMARK = 'GetCons';

const VERT = /* glsl */ `
uniform float uTime;
uniform float uAssemble;
uniform float uDust;
uniform float uText;
uniform float uOpacity;
uniform float uFade;
uniform float uPixelRatio;
uniform float uWaveSize;
uniform float uBodySize;
uniform float uAspect;
uniform float uMouseStrength;
uniform vec2 uPointer;
uniform vec2 uHeadRot;
uniform mat4 uRobotModel;
uniform float uRobotScale;
uniform float uTextHalfWidth;

attribute vec3 aRobot;
attribute vec3 aNormal;
attribute vec2 aWave;
attribute vec4 aRand;
attribute float aTone;
attribute float aHead;
attribute vec3 aText;

varying vec3 vColor;
varying float vAlpha;
/** 1 on the assembled body: dots are shaded like tiny glossy beads */
varying float vShade;
/** 1 on lights (visor strip, sensor bar, ear rings, chest core): bright core with a soft halo */
varying float vGlow;

const float TAN_HALF_FOV = ${Math.tan(THREE.MathUtils.degToRad(FOV / 2)).toFixed(5)};
const float PI = 3.14159265;

vec3 headTurn(vec3 q, float w) {
  float yaw = uHeadRot.x * w;
  float pitch = uHeadRot.y * w;
  float cy = cos(yaw), sy = sin(yaw);
  q = vec3(cy * q.x + sy * q.z, q.y, -sy * q.x + cy * q.z);
  float cp = cos(pitch), sp = sin(pitch);
  return vec3(q.x, cp * q.y - sp * q.z, sp * q.y + cp * q.z);
}

// The ceiling: rows from just in front of the camera to the horizon, always wider than the view.
vec3 wavePosition(vec2 uv, out float crest) {
  float dist = mix(6.6, 40.0, uv.y);
  float z = ${CAMERA_Z.toFixed(1)} - dist;
  float x = uv.x * (TAN_HALF_FOV * uAspect * dist * 1.12 + 1.8 * uAspect);
  float t = uTime * 0.3;
  float h = sin(x * 0.33 + t) * 0.55 + sin(z * 0.37 + t * 1.3) * 0.45 + sin((x + z) * 0.2 - t * 0.7) * 0.4;
  crest = h / 1.4;
  return vec3(x, 2.8 + h * mix(0.45, 1.25, smoothstep(0.0, 0.7, uv.y)), z);
}

// Dust: every particle gets a spot somewhere in the visible volume and drifts slowly.
vec3 dustPosition(vec4 r) {
  float z = mix(-7.0, 5.5, r.z);
  float dist = ${CAMERA_Z.toFixed(1)} - z;
  vec3 p = vec3((fract(r.x * 7.31 + r.w) * 2.0 - 1.0) * TAN_HALF_FOV * uAspect * dist * 1.04,
                0.6 + (fract(r.y * 5.17 + r.z) * 2.0 - 1.0) * TAN_HALF_FOV * dist * 1.04,
                z);
  float t = uTime * 0.12;
  p += vec3(sin(t + r.w * 31.0), cos(t * 0.8 + r.x * 27.0), sin(t * 0.6 + r.y * 19.0) * 0.6) * 0.45;
  return p;
}

// Smoother than smoothstep: zero velocity and acceleration at both ends.
float smoother(float x) {
  x = clamp(x, 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

void main() {
  // Unhurried, staggered assembly: the head forms first, then the shoulders; each particle
  // takes a long, gently eased flight from the ceiling.
  float height = clamp((aRobot.y + 1.05) / 3.7, 0.0, 1.0) * 0.85 + clamp((aRobot.y + 6.0) / 4.95, 0.0, 1.0) * 0.15;
  float delay = aRand.x * 0.28 + (1.0 - height) * 0.22;
  float ease = smoother((uAssemble - delay) / 0.5);
  // ...and the same, more loosely, when the robot dissolves and the dust becomes the wordmark.
  float dustE = smoother((uDust - aRand.w * 0.4) / 0.6);
  float textE = smoother((uText - aRand.y * 0.35) / 0.65);

  // Robot: idle breathing, the head follows the cursor.
  const vec3 pivot = vec3(0.0, 1.0, -0.04);
  vec3 local = headTurn(aRobot - pivot, aHead) + pivot;
  local.y += sin(uTime * 1.1) * 0.012 * (1.0 - aHead * 0.5);
  vec3 robot = (uRobotModel * vec4(local, 1.0)).xyz;
  float ao = length(aNormal); // the normal's length carries ambient occlusion
  vec3 normal = ao > 0.0 ? normalize(mat3(uRobotModel) * headTurn(aNormal / ao, aHead)) : vec3(0.0, 0.0, 1.0);

  float crest;
  vec3 wave = wavePosition(aWave, crest);

  // In flight: a soft curl, strongest halfway through each transition.
  vec3 curl = vec3(
    sin(aRand.y * 23.0 + uTime * 0.5),
    cos(aRand.z * 19.0 + uTime * 0.4) - 0.3,
    sin(aRand.w * 17.0 + uTime * 0.6)
  );
  vec3 world = mix(wave, robot, ease) + curl * 0.6 * sin(ease * PI);
  world = mix(world, dustPosition(aRand), dustE) + curl * 0.9 * sin(dustE * PI);
  vec3 textPos = aText + vec3(0.0, 0.0, sin(uTime * 1.2 + aRand.x * 20.0) * 0.04);
  world = mix(world, textPos, textE) + curl * 0.7 * sin(textE * PI);

  vec4 mv = viewMatrix * vec4(world, 1.0);
  vec4 clip = projectionMatrix * mv;

  // Cursor: particles around the pointer are pushed aside on screen and light up.
  vec2 ndc = clip.xy / clip.w;
  vec2 delta = (ndc - uPointer) * vec2(uAspect, 1.0);
  float influence = (1.0 - smoothstep(0.0, 0.24, length(delta))) * uMouseStrength;
  ndc += normalize(delta + vec2(0.00001)) * influence * 0.075 / vec2(uAspect, 1.0);
  clip.xy = ndc * clip.w;
  gl_Position = clip;

  bool emissive = (aTone > 0.5 && aTone < 1.5) || (aTone > 5.5 && aTone < 6.5);
  float dist = -mv.z;
  float waveSize = uWaveSize * 30.0 / dist * (0.8 + aRand.w * 0.4);
  // even dots on the body read as a manufactured surface; a little variation keeps it alive
  float bodySize = uBodySize * (12.0 / dist) * clamp(sqrt(uRobotScale), 0.8, 2.0) * (emissive ? 1.9 : 1.0) * (0.94 + aRand.w * 0.12);
  float dustSize = uWaveSize * 17.0 / dist * (0.6 + aRand.z * 0.8);
  float textSize = uBodySize * 1.05 * (12.0 / dist) * (0.85 + aRand.w * 0.3);
  float size = mix(waveSize, bodySize, ease) * (1.0 - sin(ease * PI) * 0.35);
  size = mix(mix(size, dustSize, dustE), textSize, textE);
  gl_PointSize = clamp(size * (1.0 + influence * 0.8), 1.0, 11.0) * uPixelRatio;
  float onBody = ease * (1.0 - dustE) * (1.0 - textE);
  vShade = onBody;
  vGlow = emissive ? onBody : 0.0;

  // Ceiling: lavender-white up close, violet towards a glowing horizon, brighter on the crests.
  float depth = aWave.y;
  vec3 waveColor = mix(vec3(0.94, 0.91, 1.0), vec3(0.7, 0.36, 1.0), smoothstep(0.25, 0.85, depth));
  waveColor = mix(waveColor, vec3(0.96, 0.58, 1.0), smoothstep(0.85, 1.0, depth) * 0.6);
  waveColor *= 0.7 + 0.4 * smoothstep(-1.0, 1.0, crest);
  float waveAlpha = mix(1.0, 0.55, smoothstep(0.5, 1.0, depth)) * (1.0 - smoothstep(0.96, 1.0, depth));

  // Body materials, lit by a key light from the upper left, a violet fill from the right and a
  // rim light on the silhouette; creases darkened by ambient occlusion, the far side kept dark.
  vec3 toCamera = normalize(cameraPosition - robot);
  float facing = dot(normal, toCamera);
  vec3 keyDir = normalize(vec3(-0.6, 0.5, 0.65));
  float key = max(dot(normal, keyDir), 0.0);
  float fill = max(dot(normal, normalize(vec3(0.7, -0.1, 0.5))), 0.0);
  float ndh = max(dot(normal, normalize(keyDir + toCamera)), 0.0);
  float rim = pow(1.0 - clamp(facing, 0.0, 1.0), 3.0);
  float occl = ao > 0.0 ? ao : 1.0;
  vec3 rimColor = vec3(0.62, 0.42, 1.0) * rim;
  vec3 bodyColor;
  if (aTone > 6.5) {
    // polished chrome rings: mostly reflection, a bright highlight and a cool rim
    vec3 refl = reflect(-toCamera, normal);
    float sky = smoothstep(-0.2, 0.9, refl.y);
    bodyColor = vec3(0.32, 0.33, 0.38) * (0.35 + 0.65 * sky) + vec3(0.9, 0.9, 1.0) * pow(ndh, 40.0) * 1.4 + rimColor * 0.6;
  } else if (aTone > 5.5) {
    // the eye line across the visor: white light with a faint cool tint
    bodyColor = vec3(1.0, 0.97, 1.12);
  } else if (aTone > 4.5) {
    // glossy black glass (face, elbow discs): a deep base that reflects the "sky" above, a broad
    // sheen, a sharp highlight and a bright Fresnel edge, so it reads even on the dark page
    vec3 refl = reflect(-toCamera, normal);
    float sky = smoothstep(-0.1, 0.85, refl.y);
    float fres = pow(1.0 - clamp(facing, 0.0, 1.0), 2.5);
    bodyColor = vec3(0.075, 0.074, 0.095) + vec3(0.6, 0.6, 0.72) * sky * sky * 0.45
              + vec3(0.8, 0.78, 0.95) * pow(ndh, 16.0) * 0.26 + vec3(1.05, 1.0, 1.1) * pow(ndh, 150.0) * 2.6
              + vec3(0.6, 0.5, 0.9) * fres * 0.6;
    // two tall studio softboxes either side of the camera: long vertical reflections that break
    // at the crest of the visor, the way a real glossy helmet catches a window
    float boxL = smoothstep(-0.8, -0.62, refl.x) * (1.0 - smoothstep(-0.36, -0.22, refl.x));
    float boxR = smoothstep(0.3, 0.44, refl.x) * (1.0 - smoothstep(0.66, 0.82, refl.x));
    float tall = smoothstep(-0.5, -0.22, refl.y) * (1.0 - smoothstep(0.55, 0.82, refl.y)) * step(0.0, refl.z);
    bodyColor += (vec3(0.85, 0.82, 1.0) * boxL * 0.5 + vec3(0.62, 0.45, 1.0) * boxR * 0.32) * tall;
    // light from the eye line spilling onto the glass around it
    float spill = clamp((aTone - 5.0) * 2.5, 0.0, 1.0);
    bodyColor += vec3(0.8, 0.78, 1.0) * spill * 0.75;
  } else if (aTone > 3.5) {
    // white clearcoat shell: soft diffuse light plus a glossy highlight
    bodyColor = vec3(0.95, 0.95, 0.98) * (0.22 + 0.85 * key) * occl + vec3(0.45, 0.32, 0.95) * fill * 0.2
              + vec3(pow(ndh, 30.0) * 0.14 + pow(ndh, 90.0) * 0.4) + rimColor * 0.4;
  } else if (aTone > 2.5) {
    // printed lettering
    bodyColor = vec3(0.2, 0.13, 0.36) * (0.5 + 0.5 * key);
  } else if (aTone > 1.5) {
    // gunmetal joints: dark, with a crisp metallic highlight
    bodyColor = vec3(0.2, 0.21, 0.25) * (0.35 + 0.9 * key) * occl + vec3(0.85, 0.86, 0.95) * pow(ndh, 36.0) * 0.8 + rimColor * 0.45;
  } else if (aTone > 0.5) {
    // accent lights: the edge of the glass, the rings of the side sensors
    bodyColor = vec3(0.85, 0.55, 1.4);
  } else {
    // dark satin core (neck, abdomen)
    bodyColor = vec3(0.1, 0.105, 0.125) * (0.45 + 0.8 * key) * occl + vec3(pow(ndh, 28.0) * 0.3) + rimColor * 0.55;
  }
  bodyColor *= mix(0.1, 1.0, smoothstep(-0.2, 0.2, facing));
  float bodyAlpha = smoothstep(uFade, uFade + 0.55, aRobot.y);

  // Dust: soft lavender specks, dimmer in the distance. Wordmark: white to violet, left to right.
  vec3 dustColor = mix(vec3(0.62, 0.45, 1.0), vec3(0.93, 0.9, 1.0), aRand.z) * mix(1.0, 0.55, smoothstep(8.0, 19.0, dist));
  float sweep = smoothstep(-uTextHalfWidth, uTextHalfWidth, aText.x);
  vec3 textColor = mix(vec3(0.97, 0.95, 1.0), vec3(0.78, 0.5, 1.0), sweep) * (0.9 + 0.2 * aRand.z);

  vec3 color = mix(waveColor, bodyColor, ease);
  color = mix(mix(color, dustColor, dustE), textColor, textE);
  float alpha = mix(waveAlpha, bodyAlpha, ease);
  alpha = mix(mix(alpha, 0.4, dustE), 1.0, textE);

  vColor = color + vec3(0.45, 0.25, 0.55) * influence;
  vAlpha = alpha * uOpacity;
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vShade;
varying float vGlow;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0; // 0 at the centre, 1 at the edge
  if (r2 > 1.0 || vAlpha < 0.02) discard;
  // Anti-aliased rim instead of a hard cut-out.
  float edge = 1.0 - smoothstep(0.62, 1.0, r2);
  // Body dots: a small highlight up-left and a darker rim, so each reads as a bead.
  float bead = 1.0 + vShade * (0.28 - 0.42 * r2 + 0.18 * (1.0 - smoothstep(0.0, 0.35, dot(c + vec2(0.14, -0.14), c + vec2(0.14, -0.14)) * 4.0)));
  // Lights: hot centre fading into a halo.
  float glow = exp(-r2 * 2.6);
  vec3 color = vColor * mix(bead, 0.55 + 1.1 * glow, vGlow);
  // Lights keep an opaque core: a soft see-through halo would still write depth and blank out
  // the neighbouring lights' cores, which shows as dark speckles in a dense strip.
  float alpha = vAlpha * mix(edge, smoothstep(0.3, 0.55, glow), vGlow);
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Points filling the letters of the wordmark, in world units on the z = 0 plane, centred on
 * (0, centerY) and `width` wide. Rendered once on a 2D canvas and sampled where the ink is.
 */
function wordmarkPoints(count: number, width: number, centerY: number): Float32Array {
  const out = new Float32Array(count * 3);
  const font = '700 200px "Inter Variable", Inter, "Segoe UI", system-ui, sans-serif';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return out;
  ctx.font = font;
  const m = ctx.measureText(WORDMARK);
  const w = Math.ceil(m.width) + 20;
  const h = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + 20;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(WORDMARK, 10, 10 + m.actualBoundingBoxAscent);
  const data = ctx.getImageData(0, 0, w, h).data;
  const ink: number[] = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) if (data[(y * w + x) * 4 + 3]! > 140) ink.push(x, y);
  }
  const cells = ink.length / 2;
  if (!cells) return out;
  const scale = width / w;
  for (let i = 0; i < count; i++) {
    // Spread the particles over every inked cell (golden-ratio stride), jittered inside it.
    const c = Math.floor(((i * 0.6180339887) % 1) * cells);
    const px = ink[c * 2]! + Math.random() * 2;
    const py = ink[c * 2 + 1]! + Math.random() * 2;
    out[i * 3] = (px - w / 2) * scale;
    out[i * 3 + 1] = centerY - (py - h / 2) * scale;
    out[i * 3 + 2] = (Math.random() - 0.5) * 0.12;
  }
  return out;
}

export class RobotScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;
  private points: THREE.Points;
  private clock = new THREE.Clock();
  private raf = 0;
  private loading = new AbortController();
  private robotReady = false;
  private disposed = false;
  private target: SceneState = { assemble: 0, x: 0, y: 0, scale: 1, rotY: 0, dust: 0, text: 0, opacity: 1, fade: -1.05 };
  private current: SceneState = { ...this.target };
  private pointer = new THREE.Vector2(0, 0);
  private pointerActive = 0;
  private mouseStrength = 0;
  private headRot = new THREE.Vector2();
  private robotMatrix = new THREE.Matrix4();
  private visible = true;
  private reduced: boolean;
  private count: number;
  private textAspect = 0;

  constructor(private canvas: HTMLCanvasElement, options: { count: number; reducedMotion: boolean }) {
    this.reduced = options.reducedMotion;
    this.count = options.count;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setClearColor(0x000000, 0);

    this.camera.position.set(0, 0.6, CAMERA_Z);
    this.camera.lookAt(0, 0.6, 0);

    const { count } = options;
    const wave = new Float32Array(count * 2);
    const rand = new Float32Array(count * 4);
    // The ceiling grid: u across (-1..1), v from the nearest row (0) to the horizon (1).
    const cols = Math.round(Math.sqrt(count * 2.2));
    const rows = Math.ceil(count / cols);
    for (let i = 0; i < count; i++) {
      wave[i * 2] = ((i % cols) / (cols - 1)) * 2 - 1;
      wave[i * 2 + 1] = Math.floor(i / cols) / Math.max(rows - 1, 1);
      for (let k = 0; k < 4; k++) rand[i * 4 + k] = Math.random();
    }
    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3)); // unused: positions come from the shader
    g.setAttribute('aWave', new THREE.BufferAttribute(wave, 2));
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
    g.setAttribute('aText', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    this.setRobot({
      count,
      positions: new Float32Array(count * 3),
      normals: new Float32Array(count * 3),
      tones: new Float32Array(count),
      headWeights: new Float32Array(count),
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 },
        uAssemble: { value: 0 },
        uDust: { value: 0 },
        uText: { value: 0 },
        uOpacity: { value: 1 },
        uFade: { value: -1.05 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uWaveSize: { value: count > 50000 ? 0.85 : count > 30000 ? 1 : 0.85 },
        // Denser clouds get finer dots so the surface stays crisp instead of turning into a blur.
        uBodySize: { value: count > 50000 ? 1.65 : count > 30000 ? 1.8 : 2.2 },
        uAspect: { value: 1 },
        uMouseStrength: { value: 0 },
        uPointer: { value: this.pointer },
        uHeadRot: { value: this.headRot },
        uRobotModel: { value: this.robotMatrix },
        uRobotScale: { value: 1 },
        uTextHalfWidth: { value: 4 },
      },
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false; // positions are computed in the shader
    this.scene.add(this.points);

    this.loadRobot(count);
    this.resize();
    // The wordmark needs the real font; lay it out again once Inter has loaded.
    void document.fonts?.load('700 100px "Inter Variable"').then(() => this.layoutWordmark(true)).catch(() => undefined);
    this.loop();
  }

  setState(state: SceneState) {
    this.target = state;
    if (this.reduced) this.current = { ...state, assemble: this.robotReady ? state.assemble : 0 };
  }

  /** nx, ny in -1..1 (NDC) */
  setPointer(nx: number, ny: number, active: boolean) {
    if (active) this.pointer.set(nx, ny);
    this.pointerActive = active ? 1 : 0;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.material.uniforms.uPixelRatio!.value = this.renderer.getPixelRatio();
    this.material.uniforms.uAspect!.value = this.camera.aspect;
    this.layoutWordmark(false);
  }

  /** Half the visible height/width at the robot's depth, for responsive placement. */
  viewExtent(): { halfW: number; halfH: number } {
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.position.z;
    return { halfW: halfH * this.camera.aspect, halfH };
  }

  /** The wordmark spans most of the width, in the upper part of the screen (the page's closing CTA sits below). */
  private layoutWordmark(force: boolean) {
    if (!force && Math.abs(this.camera.aspect - this.textAspect) < 0.01) return;
    this.textAspect = this.camera.aspect;
    const { halfW, halfH } = this.viewExtent();
    const width = Math.min(halfW * 1.7, halfH * 3.4);
    const centerY = 0.6 + halfH * (halfW / halfH < 0.95 ? 0.42 : 0.36);
    const attr = this.geometry.getAttribute('aText') as THREE.BufferAttribute;
    attr.array.set(wordmarkPoints(this.count, width, centerY));
    attr.needsUpdate = true;
    this.material.uniforms.uTextHalfWidth!.value = width / 2;
  }

  private setRobot(cloud: RobotCloud) {
    const g = this.geometry;
    g.setAttribute('aRobot', new THREE.BufferAttribute(cloud.positions, 3));
    g.setAttribute('aNormal', new THREE.BufferAttribute(cloud.normals, 3));
    g.setAttribute('aTone', new THREE.BufferAttribute(cloud.tones, 1));
    g.setAttribute('aHead', new THREE.BufferAttribute(cloud.headWeights, 1));
  }

  /** The wave renders right away; the robot's points load as one small file and swap in when ready. */
  private loadRobot(count: number) {
    loadRobotCloud(cloudUrl, count, this.loading.signal)
      .then((cloud: RobotCloud) => {
        if (this.disposed) return;
        this.setRobot(cloud);
        this.robotReady = true;
        if (this.reduced) this.current.assemble = this.target.assemble;
      })
      .catch(() => {
        // Without the robot the page still works: the particles stay a wave and become the wordmark.
      });
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible || document.hidden) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    // Frame-rate independent smoothing: placement follows the scroll closely, while the shape
    // changes (assembly, dust, wordmark) glide behind it so fast scrolling still looks calm.
    const k = this.reduced ? 1 : 1 - Math.pow(0.0015, dt);
    const kShape = this.reduced ? 1 : 1 - Math.pow(0.06, dt);
    const c = this.current;
    const t = this.target;
    c.assemble = lerp(c.assemble, this.robotReady ? t.assemble : 0, kShape);
    c.dust = lerp(c.dust, t.dust, kShape);
    c.text = lerp(c.text, t.text, kShape);
    c.x = lerp(c.x, t.x, k);
    c.y = lerp(c.y, t.y, k);
    c.scale = lerp(c.scale, t.scale, k);
    c.rotY = lerp(c.rotY, t.rotY, k);
    c.opacity = lerp(c.opacity, t.opacity, k);
    c.fade = lerp(c.fade, t.fade, k);

    // Head follows the cursor (or idles gently).
    const time = this.clock.elapsedTime;
    const px = this.pointerActive ? this.pointer.x : Math.sin(time * 0.35) * 0.25;
    const py = this.pointerActive ? this.pointer.y : Math.sin(time * 0.27) * 0.12;
    const relX = px - c.x / this.viewExtent().halfW; // look towards the pointer relative to the robot
    this.headRot.x = lerp(this.headRot.x, THREE.MathUtils.clamp(relX * 0.55, -0.6, 0.6), 0.08);
    this.headRot.y = lerp(this.headRot.y, THREE.MathUtils.clamp(-py * 0.3, -0.3, 0.3), 0.08);
    this.mouseStrength = lerp(this.mouseStrength, this.pointerActive, 0.08);

    this.robotMatrix.compose(
      new THREE.Vector3(c.x, c.y, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, c.rotY, 0)),
      new THREE.Vector3(c.scale, c.scale, c.scale),
    );

    const u = this.material.uniforms;
    u.uTime!.value = this.reduced ? 0 : time;
    u.uAssemble!.value = c.assemble;
    u.uDust!.value = c.dust;
    u.uText!.value = c.text;
    u.uOpacity!.value = c.opacity;
    u.uFade!.value = c.fade;
    u.uMouseStrength!.value = this.reduced ? 0 : this.mouseStrength;
    u.uRobotScale!.value = c.scale;
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.loading.abort();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}
