import { SHADOW, SIM } from './config';
import { Ground } from './ground';
import { clockLabel, lookAt, tideAt, tideLabel, type Look } from './look';
import { clamp, damp, invert, lerp, lookAt as viewMatrix, multiply, normalize, ortho, perspective, transform, type Vec3 } from './math';
import { Renderer, SIM_FLOATS } from './renderer';
import { Life } from './life';
import { Sound } from './sound';

export interface HourInfo {
  name: string;
  clock: string;
  tide: string;
  background: string;
}

interface Surge {
  age: number;
  height: number;
  reachedPool: boolean;
}

const SURGE_START = -5.2;
const SURGE_SPEED = 1.45;
const SURGE_WIDTH = 0.38;
const MAX_DROPS = 16;

export class App {
  readonly renderer: Renderer;
  readonly sound = new Sound();
  life!: Life;
  ground!: Ground;

  hour: number;
  private hourTarget: number;
  time = 0;
  private frameIndex = 0;
  private last = 0;
  private look: Look;
  private eye: Vec3 = [0, 4, 4];
  private viewProj = new Float32Array(16);
  private invViewProj = new Float32Array(16);
  private sway = [0, 0];
  private renderScale = 1;
  private slowFrames = 0;
  private fastFrames = 0;
  private revealed = 0;

  private surge: Surge | null = null;
  private nextSurge = 6;

  private pointer = {
    screen: [0, 0] as [number, number],
    world: null as [number, number] | null,
    previous: null as [number, number] | null,
    speed: 0,
    stillFor: 0,
    active: false,
    pressed: false,
  };
  private drops: [number, number, number, number][] = [];
  private onHour: (info: HourInfo) => void;
  private lastLabel = '';
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    private readonly canvas: HTMLCanvasElement,
    onHour: (info: HourInfo) => void,
    startHour: number,
  ) {
    this.renderer = new Renderer(device, context, format);
    this.onHour = onHour;
    this.hour = startHour;
    this.hourTarget = startHour;
    this.look = lookAt(startHour);
  }

  async init(seed: number) {
    await this.renderer.buildTerrain();
    this.ground = new Ground(this.renderer.heights!);
    this.life = new Life(this.renderer, this.ground, seed);
    this.bindInput();
    this.last = performance.now();
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- input

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('pointermove', (e) => this.onPointer(e));
    c.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary) return;
      this.onPointer(e);
      this.pointer.pressed = true;
      const w = this.pointer.world;
      if (w) this.touch(w, 1);
    });
    const release = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      this.pointer.pressed = false;
      if (e.pointerType !== 'mouse') this.pointer.active = false;
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', () => {
      this.pointer.active = false;
      this.pointer.world = null;
    });
    addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey) return;
        this.hourTarget += e.deltaY * 0.0035;
      },
      { passive: true },
    );
    // Two-finger vertical swipe moves the clock on touch screens.
    let twoFinger: number | null = null;
    c.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          if (twoFinger !== null) this.hourTarget += (twoFinger - y) * 0.012;
          twoFinger = y;
          this.pointer.active = false;
        }
      },
      { passive: false },
    );
    c.addEventListener('touchend', () => (twoFinger = null));
    addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') this.hourTarget -= 0.5;
      if (e.key === 'ArrowDown') this.hourTarget += 0.5;
    });
  }

  private onPointer(e: PointerEvent) {
    if (!e.isPrimary) return;
    const r = this.canvas.getBoundingClientRect();
    this.pointer.screen = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    this.pointer.active = e.pointerType === 'mouse' || e.pressure > 0 || this.pointer.pressed;
  }

  /** Project a screen position onto the water plane. */
  private screenToWater(sx: number, sy: number): [number, number] | null {
    const ndc: [number, number, number, number] = [sx * 2 - 1, 1 - sy * 2, 1, 1];
    const far = transform(this.invViewProj, ndc);
    const p: Vec3 = [far[0] / far[3], far[1] / far[3], far[2] / far[3]];
    const d = normalize([p[0] - this.eye[0], p[1] - this.eye[1], p[2] - this.eye[2]]);
    if (d[1] > -1e-3) return null;
    const t = -this.eye[1] / d[1];
    return [this.eye[0] + d[0] * t, this.eye[2] + d[2] * t];
  }

  /** A deliberate touch: a splash, and anything close by reacts. */
  touch(at: [number, number], strength: number) {
    if (this.ground.height(at[0], at[1]) < -0.005) {
      this.addDrop(at[0], at[1], 0.028, 0.0045 * strength);
      this.sound.plip(strength);
    }
    this.life.touch(at, strength);
  }

  addDrop(x: number, z: number, radius: number, strength: number) {
    if (this.drops.length >= MAX_DROPS) this.drops.shift();
    this.drops.push([x, z, radius, strength]);
  }

  // ---------------------------------------------------------------- frame

  private loop = (now: number) => {
    const raw = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(raw, 1 / 30);
    this.adaptResolution(raw);
    this.frame(dt);
    requestAnimationFrame(this.loop);
  };

  private adaptResolution(raw: number) {
    if (raw > 1 / 42) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (raw < 1 / 58) this.fastFrames++;
    else this.fastFrames = 0;
    if (this.slowFrames > 40 && this.renderScale > 0.55) {
      this.renderScale = Math.max(0.55, this.renderScale * 0.85);
      this.slowFrames = 0;
    } else if (this.fastFrames > 240 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale * 1.1);
      this.fastFrames = 0;
    }
  }

  frame(dt: number) {
    this.time += dt;
    this.frameIndex++;
    this.revealed = Math.min(1, this.revealed + dt / 1.6);

    this.hour = lerp(this.hour, this.hourTarget, damp(4, dt));
    this.look = lookAt(this.hour);
    this.reportHour();

    const dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.renderer.resize(Math.max(1, Math.round(cw * this.renderScale)), Math.max(1, Math.round(ch * this.renderScale)));

    this.updateCamera(dt);
    this.updatePointer(dt);
    this.updateSurge(dt);
    const tide = tideAt(this.hour);
    this.life.update(dt, this.time, {
      pointer: this.pointer.active ? this.pointer.world : null,
      speed: this.pointer.speed,
      stillFor: this.pointer.stillFor,
      surge: this.surgeActivity(),
      night: this.look.night,
    });
    for (const d of this.life.drops) this.addDrop(...d);
    this.life.drops.length = 0;
    this.sound.update(dt, {
      tide,
      surge: this.surgeActivity(),
      stir: this.pointer.active && this.pointer.world && this.ground.height(...this.pointer.world) < 0 ? Math.min(this.pointer.speed, 1.5) : 0,
    });

    this.writeFrame(tide);
    const substeps = Math.max(1, Math.ceil(dt / 0.0052));
    this.writeSim(dt, substeps, tide);
    this.renderer.render({ dt, substeps, data: this.renderer.simData }, this.time, this.look.exposure * this.revealed);
    this.drops.length = 0;
  }

  private reportHour() {
    const info: HourInfo = {
      name: this.look.name,
      clock: clockLabel(this.hour),
      tide: tideLabel(this.hour),
      background: this.look.background,
    };
    const key = `${info.name}|${info.clock}|${info.tide}`;
    if (key !== this.lastLabel) {
      this.lastLabel = key;
      this.onHour(info);
    }
  }

  private updateCamera(dt: number) {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const aspect = w / h;
    const portrait = aspect < 0.9;
    const fov = ((portrait ? 44 : 34) * Math.PI) / 180;
    const debug = new URLSearchParams(location.search);
    const zoom = Number(debug.get('zoom')) || 1;
    const at = (debug.get('at') ?? '').split(',').map(Number);
    const pitch = ((portrait ? 64 : 54) * Math.PI) / 180;
    // Fit the pool's width to the screen.
    // On tall screens the camera turns side-on so the pool's long axis runs
    // down the screen, with the sea off to the right.
    const needWidth = portrait ? 2.9 : 5.1;
    const needHeight = portrait ? 4.7 : 3.9;
    const tanV = Math.tan(fov / 2);
    const distance = Math.max(needHeight / (2 * tanV) * 1.05, needWidth / (2 * tanV * aspect)) / zoom;
    const target: Vec3 = at.length === 2 && at.every(Number.isFinite) ? [at[0], 0, at[1]] : [0, 0, portrait ? 0.25 : -0.15];

    const sx = this.pointer.active && !this.reducedMotion.matches ? this.pointer.screen[0] - 0.5 : 0;
    const sy = this.pointer.active && !this.reducedMotion.matches ? this.pointer.screen[1] - 0.5 : 0;
    this.sway[0] = lerp(this.sway[0], sx, damp(1.5, dt));
    this.sway[1] = lerp(this.sway[1], sy, damp(1.5, dt));
    const yaw = (portrait ? Math.PI / 2 : 0) + this.sway[0] * 0.035;
    const p = pitch + this.sway[1] * 0.025;
    this.eye = [
      target[0] + Math.sin(yaw) * Math.cos(p) * distance,
      target[1] + Math.sin(p) * distance,
      target[2] + Math.cos(yaw) * Math.cos(p) * distance,
    ];
    const view = viewMatrix(this.eye, target, [0, 1, 0]);
    const proj = perspective(fov, aspect, 0.1, 60);
    this.viewProj = multiply(proj, view);
    this.invViewProj = invert(this.viewProj);
  }

  private updatePointer(dt: number) {
    const p = this.pointer;
    p.previous = p.world;
    p.world = p.active ? this.screenToWater(p.screen[0], p.screen[1]) : null;
    if (p.world && p.previous && dt > 0) {
      const moved = Math.hypot(p.world[0] - p.previous[0], p.world[1] - p.previous[1]);
      p.speed = lerp(p.speed, moved / dt, damp(12, dt));
      p.stillFor = p.speed < 0.04 ? p.stillFor + dt : 0;
    } else {
      p.speed = 0;
      p.stillFor = 0;
    }
  }

  private updateSurge(dt: number) {
    const tide = tideAt(this.hour);
    if (this.surge) {
      this.surge.age += dt;
      const front = SURGE_START + this.surge.age * SURGE_SPEED;
      if (!this.surge.reachedPool && front > -2.6) {
        this.surge.reachedPool = true;
        this.sound.wash(this.surge.height / 0.08);
        this.life.onSurge(this.surge.height / 0.08);
      }
      if (front > 3.5) this.surge = null;
    } else {
      this.nextSurge -= dt;
      if (this.nextSurge <= 0) {
        const size = 0.5 + Math.random() * 0.5;
        this.surge = { age: 0, height: lerp(0.035, 0.09, tide) * size + 0.01, reachedPool: false };
        this.nextSurge = lerp(26, 9, tide) * (0.7 + Math.random() * 0.6);
      }
    }
  }

  private surgeActivity() {
    if (!this.surge) return 0;
    const front = SURGE_START + this.surge.age * SURGE_SPEED;
    return clamp(1 - Math.abs(front + 2.4) / 2.2, 0, 1) * (this.surge.height / 0.08);
  }

  private oceanParams(tide: number): [number, number, number, number] {
    const swell = lerp(0.012, 0.028, tide);
    if (!this.surge) return [swell, -100, 0, SURGE_WIDTH];
    const front = SURGE_START + this.surge.age * SURGE_SPEED;
    const fadeIn = clamp(this.surge.age / 1.2, 0, 1);
    return [swell, front, this.surge.height * fadeIn, SURGE_WIDTH];
  }

  private writeFrame(tide: number) {
    const f = this.renderer.frameData;
    const l = this.look;
    f.set(this.viewProj, 0);
    f.set(this.invViewProj, 16);
    f.set(this.sunMatrix(l.sunDir), 32);
    f.set([...this.eye, this.time], 48);
    const r = this.renderer;
    f.set([r.width, r.height, 1 / r.width, 1 / r.height], 52);
    f.set([...l.sunDir, this.frameIndex], 56);
    f.set([...l.sunColor, l.sunDisc], 60);
    f.set([...l.zenith, l.skyIntensity], 64);
    f.set([...l.horizon, l.stars], 68);
    f.set([...l.absorption, 0], 72);
    f.set([...l.scatter, l.scatterAmount], 76);
    const fov = ((this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1) < 0.9 ? 44 : 34) * Math.PI) / 180;
    const footprint = (2 * Math.tan(fov / 2)) / Math.max(r.height, 1);
    f.set([l.exposure, l.night, l.night * 1.4, footprint], 80);
    const pw = this.pointer.world;
    f.set([pw ? pw[0] : 0, pw ? pw[1] : 0, pw ? 1 : 0, this.pointer.speed], 84);
    f.set(this.oceanParams(tide), 88);
    f.set([tide, 0.35 + 0.4 * tide, 1, this.surgeActivity()], 92);
  }

  private sunMatrix(sun: Vec3) {
    const c: Vec3 = [SHADOW.center[0], 0, SHADOW.center[1]];
    const dist = 8;
    const eye: Vec3 = [c[0] + sun[0] * dist, c[1] + sun[1] * dist, c[2] + sun[2] * dist];
    const up: Vec3 = Math.abs(sun[1]) > 0.98 ? [0, 0, -1] : [0, 1, 0];
    const view = viewMatrix(eye, c, up);
    const h = SHADOW.half;
    return multiply(ortho(-h, h, -h, h, 0.5, dist * 2), view);
  }

  private writeSim(dt: number, substeps: number, tide: number) {
    const s = this.renderer.simData;
    s.fill(0);
    const sub = dt / substeps;
    s.set([sub, 0.62, Math.pow(0.3, sub), 0.0015], 0);
    s.set([this.time, 0.35 + 0.4 * tide, 0.05, dt], 4);
    const p = this.pointer;
    const inWater = p.active && p.world && p.previous;
    if (inWater) {
      s.set([p.previous![0], p.previous![1], p.world![0], p.world![1]], 8);
      const strength = Math.min(p.speed, 2.5) * 0.0011;
      s.set([0.03, strength, 1, 1.5 + p.speed * 3], 12);
    }
    const drops = this.drops.slice(-MAX_DROPS);
    drops.forEach((d, i) => s.set(d, 16 + i * 4));
    s.set([drops.length, 1.35, 0, 0], 80);
    s.set(this.oceanParams(tide), 84);
    void SIM_FLOATS;
    void SIM;
  }
}
