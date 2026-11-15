import { COUNTS } from './config';
import type { Ground } from './ground';
import { Kind, gridPart, type MeshData } from './kind';
import { clamp, damp, lerp, rng, smoothstep, wrapAngle, type Vec3 } from './math';
import { SCENE_PRELUDE, type Renderer } from './renderer';
import fishCode from './shaders/fish.wgsl?raw';
import crabCode from './shaders/crab.wgsl?raw';
import anemoneCode from './shaders/anemone.wgsl?raw';
import starCode from './shaders/star.wgsl?raw';
import weedCode from './shaders/weed.wgsl?raw';

export interface Senses {
  pointer: [number, number] | null;
  speed: number;
  stillFor: number;
  surge: number;
  night: number;
}

type FishMode = 'rest' | 'swim' | 'dart' | 'hide' | 'inspect';

interface Fish {
  x: number;
  z: number;
  y: number;
  heading: number;
  speed: number;
  mode: FishMode;
  timer: number;
  target: [number, number];
  fright: number;
  phase: number;
  amp: number;
  bend: number;
  turn: number;
  pitch: number;
  length: number;
  variety: number;
  seed: number;
  flare: number;
  burst: number;
  wakeTimer: number;
}

type CrabMode = 'walk' | 'pause' | 'retract';

interface Crab {
  x: number;
  z: number;
  heading: number;
  up: Vec3;
  size: number;
  ext: number;
  mode: CrabMode;
  timer: number;
  target: [number, number];
  gait: number;
  wave: number;
  waveTimer: number;
  seed: number;
  variety: number;
  hue: number;
  away: [number, number] | null;
}

interface Anemone {
  pos: Vec3;
  up: Vec3;
  size: number;
  open: number;
  closedFor: number;
  seed: number;
  variety: number;
}

interface Star {
  pos: Vec3;
  up: Vec3;
  size: number;
  rot: number;
  variety: number;
  seed: number;
  curl: number;
}

const MOUTH: [number, number] = [1.05, -0.55];
const CRUISE = 0.16;
const DART = 1.15;

function fishMesh(): MeshData {
  const v: number[] = [];
  const i: number[] = [];
  gridPart(v, i, 0, 44, 16, true);
  gridPart(v, i, 1, 28, 3);
  gridPart(v, i, 2, 6, 8);
  gridPart(v, i, 3, 5, 8);
  gridPart(v, i, 4, 5, 8);
  gridPart(v, i, 5, 12, 2);
  return { vertices: new Float32Array(v), indices: new Uint32Array(i) };
}

function crabMesh(): MeshData {
  const v: number[] = [];
  const i: number[] = [];
  gridPart(v, i, 0, 96, 16, true);
  for (let k = 1; k <= 10; k++) gridPart(v, i, k, 12, 6, true);
  return { vertices: new Float32Array(v), indices: new Uint32Array(i) };
}

function anemoneMesh(): MeshData {
  const v: number[] = [];
  const i: number[] = [];
  gridPart(v, i, 0, 8, 28, true);
  gridPart(v, i, 1, 5, 28, true);
  for (let k = 0; k < 40; k++) gridPart(v, i, 2 + k, 8, 5, true);
  return { vertices: new Float32Array(v), indices: new Uint32Array(i) };
}

function starMesh(): MeshData {
  const v: number[] = [];
  const i: number[] = [];
  gridPart(v, i, 0, 16, 180, true);
  return { vertices: new Float32Array(v), indices: new Uint32Array(i) };
}

function weedMesh(): MeshData {
  const v: number[] = [];
  const i: number[] = [];
  gridPart(v, i, 0, 16, 2);
  return { vertices: new Float32Array(v), indices: new Uint32Array(i) };
}

export class Life {
  drops: [number, number, number, number][] = [];
  private random: () => number;
  private fish: Fish[] = [];
  private crabs: Crab[] = [];
  private anemones: Anemone[] = [];
  private stars: Star[] = [];
  private shelters: [number, number][] = [];
  private kinds: { fish: Kind; crabs: Kind; anemones: Kind; stars: Kind; weeds: Kind };
  private time = 0;
  private surge = 0;

  constructor(
    renderer: Renderer,
    private readonly ground: Ground,
    seed: number,
  ) {
    this.random = rng(seed);
    const d = renderer.device;
    const L = renderer.layouts;
    this.kinds = {
      fish: new Kind(d, 'fish', SCENE_PRELUDE + fishCode, fishMesh(), COUNTS.fish, 16, L),
      crabs: new Kind(d, 'crabs', SCENE_PRELUDE + crabCode, crabMesh(), COUNTS.crabs, 16, L),
      anemones: new Kind(d, 'anemones', SCENE_PRELUDE + anemoneCode, anemoneMesh(), COUNTS.anemones, 12, L),
      stars: new Kind(d, 'stars', SCENE_PRELUDE + starCode, starMesh(), COUNTS.stars, 12, L),
      weeds: new Kind(d, 'weeds', SCENE_PRELUDE + weedCode, weedMesh(), COUNTS.weeds, 12, L),
    };
    renderer.kinds = [this.kinds.weeds, this.kinds.anemones, this.kinds.stars, this.kinds.crabs, this.kinds.fish];
    this.findShelters();
    this.spawnFish();
    this.spawnCrabs();
    this.spawnAnemones();
    this.spawnStars();
    this.spawnWeeds();
  }

  // ------------------------------------------------------------ placement

  private poolPoint(minDepth: number, maxDepth = 1, tries = 400): [number, number] | null {
    for (let t = 0; t < tries; t++) {
      const x = lerp(-2.4, 2.4, this.random());
      const z = lerp(-1.0, 1.75, this.random());
      const h = this.ground.height(x, z);
      if (this.ground.inPool(x, z, minDepth) && -h <= maxDepth) return [x, z];
    }
    return null;
  }

  private findShelters() {
    for (let t = 0; t < 3000 && this.shelters.length < 18; t++) {
      const p = this.poolPoint(0.14, 1, 1);
      if (!p) continue;
      const h = this.ground.height(...p);
      let wall = 0;
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        if (this.ground.height(p[0] + Math.cos(ang) * 0.22, p[1] + Math.sin(ang) * 0.22) > h + 0.1) wall++;
      }
      if (wall >= 2 && this.shelters.every((s) => Math.hypot(s[0] - p[0], s[1] - p[1]) > 0.35)) this.shelters.push(p);
    }
    if (this.shelters.length < 4) {
      for (let k = 0; k < 6; k++) {
        const p = this.poolPoint(0.12);
        if (p) this.shelters.push(p);
      }
    }
  }

  private spawnFish() {
    for (let k = 0; k < COUNTS.fish; k++) {
      const p = this.poolPoint(0.12) ?? [0, 0.4];
      const length = lerp(0.26, 0.38, this.random());
      this.fish.push({
        x: p[0],
        z: p[1],
        y: this.ground.height(...p) + length * 0.1,
        heading: this.random() * Math.PI * 2,
        speed: 0,
        mode: 'rest',
        timer: this.random() * 4,
        target: p,
        fright: 0,
        phase: this.random() * 10,
        amp: 0.03,
        bend: 0,
        turn: 0,
        pitch: 0,
        length,
        variety: k === 0 ? 3 : k % 3,
        seed: this.random() * 100,
        flare: 1,
        burst: 0,
        wakeTimer: 0,
      });
    }
  }

  private spawnCrabs() {
    for (let k = 0; k < COUNTS.crabs; k++) {
      const p = this.poolPoint(0.03, 0.35) ?? [0.3, 0.5];
      this.crabs.push({
        x: p[0],
        z: p[1],
        heading: this.random() * Math.PI * 2,
        up: this.ground.normal(...p),
        size: lerp(0.085, 0.11, this.random()),
        ext: 1,
        mode: 'pause',
        timer: this.random() * 3,
        target: p,
        gait: this.random() * 6,
        wave: 0,
        waveTimer: 3 + this.random() * 8,
        seed: this.random() * 100,
        variety: k % 3,
        hue: this.random(),
        away: null,
      });
    }
  }

  private spawnAnemones() {
    let tries = 0;
    while (this.anemones.length < COUNTS.anemones && tries++ < 6000) {
      const p = this.poolPoint(0.03, 0.22, 1);
      if (!p) continue;
      const n = this.ground.normal(p[0], p[1], 0.04);
      // Prefer walls and boulder flanks.
      if (n[1] > 0.93 && this.random() > 0.15) continue;
      if (this.anemones.some((a) => Math.hypot(a.pos[0] - p[0], a.pos[2] - p[1]) < 0.22)) continue;
      const variety = this.random() < 0.4 ? 0 : this.random() < 0.5 ? 1 : this.random() < 0.6 ? 2 : 3;
      const up: Vec3 = [n[0] * 0.8, n[1] * 0.8 + 0.2, n[2] * 0.8];
      const l = Math.hypot(...up);
      this.anemones.push({
        pos: [p[0], this.ground.height(...p), p[1]],
        up: [up[0] / l, up[1] / l, up[2] / l],
        size: lerp(0.09, 0.15, this.random()) * (variety === 1 ? 1.3 : 1),
        open: 1,
        closedFor: 0,
        seed: this.random() * 100,
        variety,
      });
    }
    this.kinds.anemones.count = this.anemones.length;
  }

  private spawnStars() {
    // One out on the wet rock at the waterline, the rest under water.
    for (let k = 0; k < COUNTS.stars; k++) {
      let p: [number, number] | null = null;
      for (let t = 0; t < 2000 && !p; t++) {
        const x = lerp(-2.4, 2.4, this.random());
        const z = lerp(-1.0, 1.75, this.random());
        const h = this.ground.height(x, z);
        const ok = k === 0 ? h > 0.0 && h < 0.03 && this.near(x, z, -0.05) : h < -0.06 && h > -0.25 && z > -1.0;
        if (ok) p = [x, z];
      }
      if (!p) continue;
      this.stars.push({
        pos: [p[0], this.ground.height(...p) - 0.004, p[1]],
        up: this.ground.normal(p[0], p[1], 0.06),
        size: lerp(0.12, 0.17, this.random()),
        rot: this.random() * Math.PI * 2,
        variety: k === 1 ? 1 : k === 2 ? 2 : 0,
        seed: this.random() * 100,
        curl: 0.2 + this.random() * 0.5,
      });
    }
    this.kinds.stars.count = this.stars.length;
  }

  /** Is there water of at least this depth within reach? */
  private near(x: number, z: number, below: number) {
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      if (this.ground.height(x + Math.cos(ang) * 0.12, z + Math.sin(ang) * 0.12) < below) return true;
    }
    return false;
  }

  private spawnWeeds() {
    const data = this.kinds.weeds.data;
    let n = 0;
    const put = (x: number, z: number, variety: number) => {
      if (n >= COUNTS.weeds) return;
      const h = this.ground.height(x, z);
      const up = this.ground.normal(x, z, 0.04);
      const length = variety === 2 ? lerp(0.25, 0.42, this.random()) : variety === 1 ? lerp(0.12, 0.24, this.random()) : lerp(0.14, 0.28, this.random());
      const width = variety === 1 ? lerp(0.1, 0.17, this.random()) : lerp(0.06, 0.1, this.random());
      data.set([x, h - 0.004, z, length, ...up, width, this.random() * Math.PI * 2, this.random() * 100, variety, 0], n * 12);
      n++;
    };
    // Rockweed tufts around the rim, surfgrass in the gully, sea lettuce
    // scattered in the pool.
    for (let t = 0; t < 4000 && n < COUNTS.weeds * 0.4; t++) {
      const x = lerp(-2.4, 2.4, this.random());
      const z = lerp(-1.1, 1.8, this.random());
      const h = this.ground.height(x, z);
      if (h > -0.05 && h < 0.015 && this.near(x, z, -0.06)) {
        const tuft = 2 + Math.floor(this.random() * 4);
        for (let k = 0; k < tuft; k++) put(x + (this.random() - 0.5) * 0.08, z + (this.random() - 0.5) * 0.08, 0);
      }
    }
    for (let t = 0; t < 4000 && n < COUNTS.weeds * 0.7; t++) {
      const z = lerp(-2.5, -0.6, this.random());
      const x = 1.0 + Math.sin(z * 2.3) * 0.12 + lerp(-0.25, 0.3, this.random()) + (z + 0.4) * -0.09;
      if (this.ground.height(x, z) < -0.025) put(x, z, 2);
    }
    for (let t = 0; t < 4000 && n < COUNTS.weeds; t++) {
      const p = this.poolPoint(0.04, 0.2, 1);
      if (p) put(p[0], p[1], 1);
    }
    this.kinds.weeds.count = n;
  }

  // ------------------------------------------------------------ reactions

  touch(at: [number, number], strength: number) {
    for (const f of this.fish) {
      const d = Math.hypot(f.x - at[0], f.z - at[1]);
      if (d < 0.75 * strength) this.startle(f, at);
    }
    for (const c of this.crabs) {
      if (Math.hypot(c.x - at[0], c.z - at[1]) < 0.3) this.retract(c, at);
    }
    for (const a of this.anemones) {
      if (Math.hypot(a.pos[0] - at[0], a.pos[2] - at[1]) < a.size + 0.08) a.closedFor = 6 + this.random() * 5;
    }
  }

  onSurge(size: number) {
    this.surge = size;
    for (const f of this.fish) {
      if (Math.hypot(f.x - MOUTH[0], f.z - MOUTH[1]) < 0.9 && this.random() < 0.6 * size) this.startle(f, MOUTH);
    }
    for (const c of this.crabs) {
      if (Math.hypot(c.x - MOUTH[0], c.z - MOUTH[1]) < 0.7 && size > 0.6) this.retract(c, MOUTH);
    }
  }

  private startle(f: Fish, from: [number, number]) {
    if (f.mode === 'dart') return;
    f.fright = 1;
    f.mode = 'dart';
    // The nearest shelter that isn't toward the threat.
    let best: [number, number] | null = null;
    let score = Infinity;
    for (const s of this.shelters) {
      const toS = Math.hypot(s[0] - f.x, s[1] - f.z);
      const fromThreat = Math.hypot(s[0] - from[0], s[1] - from[1]);
      const sc = toS - fromThreat * 0.8;
      if (fromThreat > 0.45 && sc < score) {
        score = sc;
        best = s;
      }
    }
    f.target = best ?? [f.x + (f.x - from[0]) * 2, f.z + (f.z - from[1]) * 2];
    f.timer = 3;
  }

  private retract(c: Crab, from: [number, number]) {
    c.mode = 'retract';
    c.timer = 3 + this.random() * 4;
    c.away = from;
  }

  // ------------------------------------------------------------ update

  update(dt: number, time: number, senses: Senses) {
    this.time = time;
    this.surge = lerp(this.surge, senses.surge, damp(2, dt));
    this.updateFish(dt, senses);
    this.updateCrabs(dt, senses);
    this.updateAnemones(dt, senses);
    this.pack();
  }

  private updateFish(dt: number, senses: Senses) {
    const p = senses.pointer;
    // Only the two nearest calm fish come over to inspect a still hand.
    const curious = new Set<Fish>();
    if (p && senses.stillFor > 1.0 && this.ground.height(...p) < -0.04) {
      [...this.fish]
        .filter((f) => f.fright < 0.3 && f.mode !== 'hide' && Math.hypot(f.x - p[0], f.z - p[1]) < 1.4)
        .sort((a, b) => Math.hypot(a.x - p[0], a.z - p[1]) - Math.hypot(b.x - p[0], b.z - p[1]))
        .slice(0, 2)
        .forEach((f) => curious.add(f));
    }

    for (const f of this.fish) {
      f.fright = Math.max(0, f.fright - dt * 0.25);
      if (p && senses.speed > 0.55 && Math.hypot(f.x - p[0], f.z - p[1]) < 0.55 + senses.speed * 0.15) this.startle(f, p);

      if (curious.has(f) && f.mode !== 'dart') {
        f.mode = 'inspect';
      } else if (f.mode === 'inspect') {
        f.mode = 'swim';
        f.target = this.poolPoint(0.1) ?? [f.x, f.z];
      }

      let desiredSpeed = 0;
      let turnLimit = 3.2;
      switch (f.mode) {
        case 'rest':
          f.timer -= dt;
          if (f.timer <= 0) {
            f.mode = 'swim';
            f.target = this.wanderTarget(f);
          }
          break;
        case 'swim': {
          f.burst -= dt;
          if (f.burst <= 0) f.burst = 0.5 + this.random() * 0.9;
          const pulse = f.burst > 0.35 ? 1.5 : 0.35;
          desiredSpeed = CRUISE * pulse;
          if (Math.hypot(f.target[0] - f.x, f.target[1] - f.z) < 0.08) {
            f.mode = 'rest';
            f.timer = 2 + this.random() * 6;
          }
          break;
        }
        case 'dart':
          desiredSpeed = DART;
          turnLimit = 8;
          f.timer -= dt;
          if (Math.hypot(f.target[0] - f.x, f.target[1] - f.z) < 0.1 || f.timer < 0) {
            f.mode = 'hide';
            f.timer = 4 + this.random() * 5;
          }
          break;
        case 'hide':
          f.timer -= dt;
          if (f.timer <= 0) {
            f.mode = 'rest';
            f.timer = 1 + this.random() * 2;
          }
          break;
        case 'inspect': {
          const dx = p![0] - f.x;
          const dz = p![1] - f.z;
          const d = Math.hypot(dx, dz);
          const stand = f.length * 0.65;
          f.target = [p![0] - (dx / (d || 1)) * stand, p![1] - (dz / (d || 1)) * stand];
          desiredSpeed = d > stand + 0.05 ? CRUISE * 0.9 : 0;
          if (d < stand + 0.08) {
            // Face the hand and nibble at it now and then.
            const want = Math.atan2(dz, dx);
            f.heading += clamp(wrapAngle(want - f.heading), -2 * dt, 2 * dt);
            f.wakeTimer -= dt;
            if (f.wakeTimer <= 0) {
              f.wakeTimer = 1.2 + this.random() * 1.5;
              this.drops.push([p![0], p![1], 0.012, 0.0009]);
            }
          }
          break;
        }
      }

      // Steering toward the target, around walls and other fish.
      let want = Math.atan2(f.target[1] - f.z, f.target[0] - f.x);
      if (desiredSpeed > 0) {
        const look = 0.12 + f.speed * 0.25;
        const clear = (a: number) => this.ground.inPool(f.x + Math.cos(a) * look, f.z + Math.sin(a) * look, 0.05);
        if (!clear(f.heading)) {
          want = clear(f.heading + 0.9) ? f.heading + 0.9 : clear(f.heading - 0.9) ? f.heading - 0.9 : f.heading + Math.PI;
        }
        let px = 0;
        let pz = 0;
        for (const o of this.fish) {
          if (o === f) continue;
          const dx = f.x - o.x;
          const dz = f.z - o.z;
          const d = Math.hypot(dx, dz);
          const r = (f.length + o.length) * 0.5;
          if (d < r && d > 1e-4) {
            px += (dx / d) * (1 - d / r);
            pz += (dz / d) * (1 - d / r);
          }
        }
        if (px || pz) want = Math.atan2(Math.sin(want) + pz * 2, Math.cos(want) + px * 2);
        const delta = clamp(wrapAngle(want - f.heading), -turnLimit * dt, turnLimit * dt);
        f.heading = wrapAngle(f.heading + delta);
        f.turn = lerp(f.turn, delta / Math.max(dt, 1e-4), damp(10, dt));
      } else {
        f.turn = lerp(f.turn, 0, damp(5, dt));
      }
      f.speed = lerp(f.speed, desiredSpeed, damp(desiredSpeed > f.speed ? 9 : 4, dt));

      const nx = f.x + Math.cos(f.heading) * f.speed * dt;
      const nz = f.z + Math.sin(f.heading) * f.speed * dt;
      if (this.ground.inPool(nx, nz, 0.035)) {
        f.x = nx;
        f.z = nz;
      } else {
        f.heading = wrapAngle(f.heading + Math.PI * 0.6);
        f.speed *= 0.3;
      }

      const bed = this.ground.height(f.x, f.z);
      const rest = bed + f.length * 0.09;
      const targetY = f.mode === 'inspect' ? Math.max(rest, -0.075) : f.mode === 'swim' || f.mode === 'dart' ? rest + 0.02 : rest;
      const oldY = f.y;
      f.y = lerp(f.y, Math.min(targetY, -0.03), damp(3, dt));
      f.pitch = lerp(f.pitch, clamp(((f.y - oldY) / Math.max(dt, 1e-4)) / Math.max(f.speed, 0.15), -0.5, 0.5), damp(4, dt));
      f.phase += dt * (3 + f.speed * 30);
      f.amp = lerp(f.amp, clamp(0.025 + f.speed * 0.32, 0, 0.19), damp(5, dt));
      f.bend = lerp(f.bend, clamp(-f.turn * 0.12, -0.7, 0.7), damp(8, dt));
      f.flare = lerp(f.flare, f.mode === 'rest' || f.mode === 'hide' || (f.mode === 'inspect' && f.speed < 0.05) ? 1 : 0.25, damp(4, dt));

      // Wakes when swimming fast near the top.
      if (f.y > -0.1 && f.speed > 0.35) {
        f.wakeTimer -= dt;
        if (f.wakeTimer <= 0) {
          f.wakeTimer = 0.08;
          this.drops.push([f.x, f.z, 0.03, 0.0007 * f.speed]);
        }
      }
    }
  }

  private wanderTarget(f: Fish): [number, number] {
    let best: [number, number] = [f.x, f.z];
    for (let t = 0; t < 30; t++) {
      const a = this.random() * Math.PI * 2;
      const r = 0.2 + this.random() * 0.9;
      const x = f.x + Math.cos(a) * r;
      const z = f.z + Math.sin(a) * r;
      if (this.ground.inPool(x, z, 0.08)) {
        best = [x, z];
        break;
      }
    }
    return best;
  }

  private updateCrabs(dt: number, senses: Senses) {
    const p = senses.pointer;
    for (const c of this.crabs) {
      if (p && senses.speed > 0.6 && Math.hypot(c.x - p[0], c.z - p[1]) < 0.35 && c.mode !== 'retract') this.retract(c, p);
      let speed = 0;
      switch (c.mode) {
        case 'retract':
          c.ext = Math.max(0, c.ext - dt * 5);
          c.timer -= dt;
          if (c.timer <= 0) {
            c.mode = 'pause';
            c.timer = 1.5;
          }
          break;
        case 'pause':
          c.ext = Math.min(1, c.ext + dt * 0.7);
          c.timer -= dt;
          if (c.timer <= 0 && c.ext > 0.95) {
            c.mode = 'walk';
            c.timer = 4 + this.random() * 8;
            c.target = this.crabTarget(c);
            c.away = null;
          }
          break;
        case 'walk': {
          c.ext = Math.min(1, c.ext + dt * 0.7);
          speed = 0.045;
          const want = Math.atan2(c.target[1] - c.z, c.target[0] - c.x);
          c.heading = wrapAngle(c.heading + clamp(wrapAngle(want - c.heading), -1.2 * dt, 1.2 * dt));
          c.timer -= dt;
          if (c.timer <= 0 || Math.hypot(c.target[0] - c.x, c.target[1] - c.z) < 0.05) {
            c.mode = 'pause';
            c.timer = 2 + this.random() * 6;
          }
          break;
        }
      }
      if (speed > 0) {
        const nx = c.x + Math.cos(c.heading) * speed * dt;
        const nz = c.z + Math.sin(c.heading) * speed * dt;
        if (this.ground.inPool(nx, nz, 0.025)) {
          c.x = nx;
          c.z = nz;
        } else {
          c.target = this.crabTarget(c);
        }
        c.gait += dt * speed * 140;
      }
      c.up = lerp3(c.up, this.ground.normal(c.x, c.z, c.size * 0.8), damp(4, dt));
      c.waveTimer -= dt;
      if (c.waveTimer <= 0) {
        c.waveTimer = 5 + this.random() * 10;
        c.wave = 1;
      }
      c.wave = Math.max(0, c.wave - dt * 0.8);
    }
  }

  private crabTarget(c: Crab): [number, number] {
    for (let t = 0; t < 30; t++) {
      let a = this.random() * Math.PI * 2;
      if (c.away) {
        const away = Math.atan2(c.z - c.away[1], c.x - c.away[0]);
        a = away + (this.random() - 0.5) * 1.2;
      }
      const r = 0.15 + this.random() * 0.5;
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      if (this.ground.inPool(x, z, 0.03)) return [x, z];
    }
    return [c.x, c.z];
  }

  private updateAnemones(dt: number, senses: Senses) {
    const p = senses.pointer;
    for (const a of this.anemones) {
      // A slow hand brushing over it counts as a touch.
      if (p && senses.speed < 0.35 && Math.hypot(a.pos[0] - p[0], a.pos[2] - p[1]) < a.size * 0.7) {
        a.closedFor = Math.max(a.closedFor, 5);
      }
      a.closedFor = Math.max(0, a.closedFor - dt);
      const target = a.closedFor > 0 ? 0 : 1;
      a.open = lerp(a.open, target, damp(target > a.open ? 0.5 : 3.5, dt));
    }
  }

  // ------------------------------------------------------------ upload

  private pack() {
    const fd = this.kinds.fish.data;
    this.fish.forEach((f, i) => {
      fd.set([f.x, f.y, f.z, f.heading, f.length, f.phase, f.amp, f.bend, f.pitch, f.seed, f.variety, f.flare, 0, 0, 0, 0], i * 16);
    });

    const cd = this.kinds.crabs.data;
    this.crabs.forEach((c, i) => {
      const y = this.ground.height(c.x, c.z);
      const wave = Math.sin((1 - c.wave) * Math.PI) * (c.wave > 0 ? 1 : 0);
      const wobble = c.mode === 'walk' ? Math.sin(c.gait * 0.5) * 0.15 : 0;
      cd.set([c.x, y, c.z, c.heading, ...c.up, c.size, smoothstep(0, 1, c.ext), c.gait, c.seed, c.variety, wave, wobble, c.hue, 0], i * 16);
    });

    const ad = this.kinds.anemones.data;
    const t = this.time;
    this.anemones.forEach((a, i) => {
      const toMouth = [a.pos[0] - MOUTH[0], a.pos[2] - MOUTH[1]];
      const dm = Math.hypot(toMouth[0], toMouth[1]) || 1;
      const push = this.surge * 0.12 * Math.max(0, 1 - dm / 2.5);
      const fx = Math.sin(t * 0.5 + a.seed) * 0.03 + (toMouth[0] / dm) * push;
      const fz = Math.cos(t * 0.43 + a.seed * 1.3) * 0.03 + (toMouth[1] / dm) * push;
      ad.set([...a.pos, a.size, ...a.up, a.open, fx, fz, a.seed, a.variety], i * 12);
    });

    const sd = this.kinds.stars.data;
    this.stars.forEach((s, i) => {
      sd.set([...s.pos, s.size, ...s.up, s.rot, s.variety, s.seed, s.curl, 0], i * 12);
    });
  }
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  const v: Vec3 = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
