import { useEffect, useRef } from 'react';
import type { RobotScene, SceneState } from './RobotScene';

/**
 * Fixed full-screen layer behind the landing page: violet glow, a giant headline behind the robot,
 * and the WebGL particle scene. Sections opt into the choreography with `data-robot`:
 *   hero   — tall sticky section: the wave "ceiling" assembles into the robot while the page stays put
 *   right  — robot close-up on the right, text on the left
 *   center — robot recedes to the middle
 *   left   — robot close-up on the left, text on the right
 *   dust   — the robot dissolves into particles drifting over the whole page
 *   text   — last screen: the particles gather into the "GetCons" wordmark
 * Progress is also exposed as CSS variables: --gc-hero (0..1 assembly), --gc-meet (giant text).
 */

type Stage = SceneState & { meet: number };
interface Key {
  at: number;
  s: Stage;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function placements(scene: RobotScene) {
  const { halfW, halfH } = scene.viewExtent();
  const narrow = halfW / halfH < 0.95; // portrait phones / small tablets
  // Robot space: head top at y 2.4, chest plate 0.1..1.0, waist rings -1.2..-0.7, knees -3.8,
  // feet -6.0; shoulders reach x ±1.2. The camera looks at y = 0.6.
  const bottom = 0.6 - halfH;
  const fit = (scale: number) => (narrow ? Math.min(scale, (halfW * 1.9) / 3.8) : scale);

  // The assembled robot: the whole figure from the knees up (robot y -3.9..2.4, 6.3 tall) stands
  // between the corner texts, so its black chest plate, ringed waist and arms read at once.
  const centerScale = narrow ? Math.min((halfH * 1.12) / 5.0, (halfW * 1.7) / 2.6) : Math.min(1.25, (halfH * 1.72) / 6.3);
  // Phones: the copy fills the bottom of the screen, so the robot stands in the upper part.
  const centerY = narrow ? 0.6 + 0.78 * halfH - 2.4 * centerScale : bottom + 3.9 * centerScale;
  const center: Stage = { assemble: 1, x: 0, y: centerY, scale: centerScale, rotY: -0.38, dust: 0, text: 0, opacity: 1, fade: narrow ? -2.6 : -4.1, meet: 1 };
  const wave: Stage = { ...center, assemble: 0, meet: 0 };

  // Close-ups beside the text: big head and shoulders, the far shoulder cropped by the screen
  // edge; the near shoulder (x ≈ 1.1 after the turn) stops just past the middle, short of the text.
  const closeScale = narrow ? fit(1.3) : Math.min(3.6, halfH * 0.95, (halfW * 0.62) / 1.14);
  const headY = 0.6 + 0.1 * halfH - 1.9 * closeScale; // head a little above the middle, shoulders below
  const right: Stage = { ...center, meet: 0, fade: -1.05, x: narrow ? 0 : halfW * 0.56, y: narrow ? bottom + 1.05 * closeScale : headY, scale: closeScale, rotY: narrow ? 0 : -0.38, opacity: narrow ? 0.28 : 1 };
  const left: Stage = { ...right, x: narrow ? 0 : -halfW * 0.56, rotY: narrow ? 0 : 0.4 };

  // Behind the channel cards: the whole figure at full height (feet at robot y ≈ -6, head at 2.4),
  // faint, so it reads as a backdrop through the frosted cards rather than competing with them.
  const smallScale = Math.min(narrow ? 0.5 : 0.82, (halfH * 1.7) / 8.4);
  const middle: Stage = { ...center, meet: 0, fade: -7, rotY: -0.3, y: bottom + 0.25 + 6.0 * smallScale, scale: smallScale, opacity: narrow ? 0.22 : 0.3 };
  const dust: Stage = { ...left, dust: 1, opacity: 1 };
  const text: Stage = { ...dust, text: 1 };
  return { wave, center, right, middle, left, dust, text };
}

function buildKeys(scene: RobotScene): Key[] {
  const vh = window.innerHeight;
  const top = (el: Element) => el.getBoundingClientRect().top + window.scrollY;
  const p = placements(scene);
  const keys: Key[] = [];
  const hero = document.querySelector('[data-robot="hero"]');
  if (hero) {
    const t = top(hero);
    const run = Math.max(hero.clientHeight - vh, vh);
    // The assembly takes most of the pinned run, so it unfolds slowly.
    keys.push({ at: t, s: p.wave }, { at: t + run * 0.05, s: p.wave }, { at: t + run * 0.88, s: p.center }, { at: t + run, s: p.center });
  }
  const hold = (selector: string, s: Stage) => {
    const el = document.querySelector(selector);
    if (!el) return;
    const mid = top(el) + el.clientHeight / 2 - vh / 2;
    const span = Math.max(el.clientHeight * 0.18, vh * 0.12);
    keys.push({ at: mid - span, s }, { at: mid + span, s });
  };
  hold('[data-robot="right"]', p.right);
  hold('[data-robot="center"]', p.middle);
  hold('[data-robot="left"]', p.left);
  const dust = document.querySelector('[data-robot="dust"]');
  if (dust) {
    const t = top(dust);
    keys.push({ at: t - vh * 0.7, s: p.left }, { at: t + vh * 0.1, s: p.dust });
  }
  // The last screen: its top is the end of the page, where the wordmark is complete.
  const text = document.querySelector('[data-robot="text"]');
  if (text) {
    const t = top(text);
    keys.push({ at: t - vh * 0.85, s: p.dust }, { at: t - vh * 0.05, s: p.text });
  }
  return keys.sort((a, b) => a.at - b.at);
}

function sample(keys: Key[], y: number): Stage {
  if (!keys.length) throw new Error('no keys');
  if (y <= keys[0]!.at) return keys[0]!.s;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (y <= b.at) {
      const t = smooth(clamp01((y - a.at) / Math.max(b.at - a.at, 1)));
      const out = {} as Stage;
      for (const k of Object.keys(a.s) as (keyof Stage)[]) out[k] = a.s[k] + (b.s[k] - a.s[k]) * t;
      return out;
    }
  }
  return keys[keys.length - 1]!.s;
}

export function RobotBackdrop({ meetText }: { meetText: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    let scene: RobotScene | null = null;
    let keys: Key[] = [];
    let disposed = false;
    let frame = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const update = () => {
      frame = 0;
      if (!scene || !keys.length) return;
      const y = window.scrollY;
      const s = sample(keys, y);
      scene.setState(s);
      scene.setVisible(s.opacity > 0.01);
      root.style.setProperty('--gc-hero', s.assemble.toFixed(3));
      root.style.setProperty('--gc-meet', s.meet.toFixed(3));
      root.dataset.gcMeet = s.meet > 0.75 ? '1' : '0';
      root.dataset.gcHeroHidden = s.assemble > 0.3 ? '1' : '0';
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const rebuild = () => {
      if (!scene) return;
      scene.resize();
      keys = buildKeys(scene);
      update();
    };
    const onPointer = (e: PointerEvent) => {
      scene?.setPointer((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1, true);
    };
    const onLeave = () => scene?.setPointer(0, 0, false);
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') onLeave(); // a finger lifted: no hover left behind
    };

    root.style.setProperty('--gc-hero', '0');
    root.style.setProperty('--gc-meet', '0');

    void import('./RobotScene').then(({ RobotScene }) => {
      if (disposed || !canvasRef.current) return;
      try {
        scene = new RobotScene(canvasRef.current, {
          // More points on big screens: a finer, more detailed surface.
          count: window.innerWidth < 768 ? 18000 : 68000,
          reducedMotion: reduced,
        });
      } catch {
        return; // no WebGL: the page still works, just without the robot
      }
      rebuild();
      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', rebuild);
      window.addEventListener('pointermove', onPointer, { passive: true });
      window.addEventListener('pointerup', onUp, { passive: true });
      window.addEventListener('pointercancel', onLeave, { passive: true });
      document.documentElement.addEventListener('pointerleave', onLeave);
      resizeObserver.observe(document.body);
    });

    // Layout changes (fonts, images, language switch) move the sections: re-measure.
    const resizeObserver = new ResizeObserver(() => rebuild());

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', rebuild);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onLeave);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      scene?.dispose();
      root.style.removeProperty('--gc-hero');
      root.style.removeProperty('--gc-meet');
      delete root.dataset.gcMeet;
      delete root.dataset.gcHeroHidden;
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      <div className="absolute inset-0 bg-[radial-gradient(70%_60%_at_80%_110%,rgba(147,51,234,0.38),transparent_70%),radial-gradient(60%_50%_at_10%_-10%,rgba(124,58,237,0.22),transparent_70%)]" />
      <div
        className="absolute inset-x-0 top-[13vh] text-center text-[clamp(2.6rem,9.2vw,10.5rem)] leading-none font-semibold tracking-[-0.05em] whitespace-nowrap text-white/[0.13] blur-[1.5px] transition-opacity duration-300"
        style={{ opacity: 'max(0, calc((var(--gc-meet, 0) - 0.45) * 1.8))' }}
      >
        {meetText}
      </div>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
