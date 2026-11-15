// Water height field over the pool, gully and a strip of sea.
// state: x height, y vertical velocity, z foam, w bioluminescent glow.
// mask: 0 dry rock, 1 water, 2 open edge driven by the sea.

struct Sim {
  step: vec4f,          // substep dt, pool wave speed, damping, viscosity
  clock: vec4f,         // time, wind, drain rate, frame dt
  pointer: vec4f,       // segment start xz, end xz
  pointerShape: vec4f,  // radius, strength, active, glow gain
  drops: array<vec4f, 16>,
  counts: vec4f,        // drop count, sea wave speed
  ocean: vec4f,
}

@group(0) @binding(0) var<uniform> sim: Sim;
@group(1) @binding(0) var<storage, read_write> state: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> mask: array<f32>;
@group(1) @binding(2) var<storage, read_write> next: array<vec4f>;
@group(1) @binding(3) var terrain: texture_2d<f32>;
@group(1) @binding(4) var surfaceA: texture_storage_2d<rgba16float, write>;
@group(1) @binding(5) var surfaceB: texture_storage_2d<rgba16float, write>;

fn cellSize() -> f32 {
  return 2.0 * SIM_HALF.x / f32(SIM_SIZE.x);
}

fn cellIndex(c: vec2i) -> i32 {
  let k = clamp(c, vec2i(0), SIM_SIZE - 1);
  return k.y * SIM_SIZE.x + k.x;
}

fn cellPosition(c: vec2i) -> vec2f {
  return SIM_CENTER - SIM_HALF + (vec2f(c) + 0.5) * cellSize();
}

fn terrainAt(p: vec2f) -> f32 {
  let uv = (p - TERRAIN_CENTER) / (2.0 * TERRAIN_HALF) + 0.5;
  let texel = clamp(vec2i(uv * vec2f(TERRAIN_SIZE)), vec2i(0), TERRAIN_SIZE - 1);
  return textureLoad(terrain, texel, 0).x;
}

fn segmentDistance(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
  return length(p - a - ab * t);
}

@compute @workgroup_size(8, 8)
fn initMask(@builtin(global_invocation_id) id: vec3u) {
  let c = vec2i(id.xy);
  if (any(c >= SIM_SIZE)) {
    return;
  }
  let p = cellPosition(c);
  let wet = terrainAt(p) < -0.004;
  let edge = c.x < 2 || c.y < 2 || c.x >= SIM_SIZE.x - 2 || c.y >= SIM_SIZE.y - 2;
  var m = select(0.0, 1.0, wet);
  if (wet && edge) {
    m = 2.0;
  }
  mask[cellIndex(c)] = m;
  state[cellIndex(c)] = vec4f(0.0);
  next[cellIndex(c)] = vec4f(0.0);
}

@compute @workgroup_size(8, 8)
fn force(@builtin(global_invocation_id) id: vec3u) {
  let c = vec2i(id.xy);
  if (any(c >= SIM_SIZE)) {
    return;
  }
  let i = cellIndex(c);
  if (mask[i] < 0.5) {
    return;
  }
  let p = cellPosition(c);
  var s = state[i];
  let dt = sim.clock.w;
  var energy = 0.0;

  for (var k = 0; k < i32(sim.counts.x); k++) {
    let d = sim.drops[k];
    let r2 = dot(p - d.xy, p - d.xy);
    let push = d.w * exp(-r2 / (d.z * d.z));
    s.x -= push;
    energy += abs(push) * 120.0;
  }

  if (sim.pointerShape.z > 0.0) {
    let dist = segmentDistance(p, sim.pointer.xy, sim.pointer.zw);
    let r = sim.pointerShape.x;
    let push = sim.pointerShape.y * exp(-dist * dist / (r * r));
    s.x -= push;
    s.w += exp(-dist * dist / (r * r * 4.0)) * sim.pointerShape.w * dt;
  }

  // Wind ripples, gusting across the pool.
  let t = sim.clock.x;
  let gust = smoothstep(0.25, 0.75, vnoise(p * 0.6 + vec2f(t * 0.21, -t * 0.13)));
  let chop = (vnoise(p * 11.0 + vec2f(t * 1.7, -t * 1.1)) - 0.5) +
    (vnoise(p * 23.0 - vec2f(t * 2.9, t * 2.3)) - 0.5) * 0.6;
  s.y += chop * (0.25 + gust) * sim.clock.y * dt * 5.0;
  s.w += energy;
  state[i] = s;
}

fn neighbour(c: vec2i, center: vec4f) -> vec4f {
  let k = cellIndex(c);
  return select(center, state[k], mask[k] > 0.5);
}

fn bilinearFoam(p: vec2f) -> vec2f {
  let g = (p - (SIM_CENTER - SIM_HALF)) / cellSize() - 0.5;
  let b = vec2i(floor(g));
  let f = fract(g);
  let a = state[cellIndex(b)].zw;
  let bb = state[cellIndex(b + vec2i(1, 0))].zw;
  let cc = state[cellIndex(b + vec2i(0, 1))].zw;
  let d = state[cellIndex(b + vec2i(1, 1))].zw;
  return mix(mix(a, bb, f.x), mix(cc, d, f.x), f.y);
}

@compute @workgroup_size(8, 8)
fn step(@builtin(global_invocation_id) id: vec3u) {
  let c = vec2i(id.xy);
  if (any(c >= SIM_SIZE)) {
    return;
  }
  let i = cellIndex(c);
  let m = mask[i];
  let center = state[i];
  let dt = sim.step.x;
  let p = cellPosition(c);

  if (m < 0.5) {
    next[i] = vec4f(0.0, 0.0, center.z * 0.9, 0.0);
    return;
  }
  if (m > 1.5) {
    let o = ocean(p, sim.clock.x, sim.ocean);
    next[i] = vec4f(o.x, 0.0, center.z * 0.98, center.w * 0.95);
    return;
  }

  let l = neighbour(c - vec2i(1, 0), center);
  let r = neighbour(c + vec2i(1, 0), center);
  let d = neighbour(c - vec2i(0, 1), center);
  let u = neighbour(c + vec2i(0, 1), center);
  let size = cellSize();
  let lap = (l + r + d + u - 4.0 * center) / (size * size);

  let depth = -terrainAt(p);
  let speed = mix(sim.step.y, sim.counts.y, smoothstep(0.32, 0.48, depth));
  var v = center.y + dt * (speed * speed * lap.x + sim.step.w * lap.y);
  v *= sim.step.z;
  var h = center.x + dt * v;
  h -= h * sim.clock.z * dt;

  // Foam and glow drift down the surface slope and fade.
  let grad = vec2f(r.x - l.x, u.x - d.x) / (2.0 * size);
  let flow = -grad * 2.5 + vec2f(0.0, 0.02);
  let carried = bilinearFoam(p - flow * dt);
  let churn = max(abs(v) - 0.09, 0.0) * 9.0 + max(length(grad) - 0.35, 0.0) * 2.0;
  let foam = clamp((carried.x + churn * dt) * exp(-0.45 * dt), 0.0, 1.5);
  let glow = clamp((carried.y + churn * dt * 3.0) * exp(-0.9 * dt), 0.0, 2.0);

  next[i] = vec4f(h, v, foam, glow);
}

@compute @workgroup_size(8, 8)
fn surface(@builtin(global_invocation_id) id: vec3u) {
  let c = vec2i(id.xy);
  if (any(c >= SIM_SIZE)) {
    return;
  }
  let s = state[cellIndex(c)];
  let size = cellSize();
  let wet = mask[cellIndex(c)] > 0.5;
  let hl = select(s.x, state[cellIndex(c - vec2i(1, 0))].x, mask[cellIndex(c - vec2i(1, 0))] > 0.5);
  let hr = select(s.x, state[cellIndex(c + vec2i(1, 0))].x, mask[cellIndex(c + vec2i(1, 0))] > 0.5);
  let hd = select(s.x, state[cellIndex(c - vec2i(0, 1))].x, mask[cellIndex(c - vec2i(0, 1))] > 0.5);
  let hu = select(s.x, state[cellIndex(c + vec2i(0, 1))].x, mask[cellIndex(c + vec2i(0, 1))] > 0.5);
  let slope = vec2f(hr - hl, hu - hd) / (2.0 * size);
  textureStore(surfaceA, c, select(vec4f(0.0), vec4f(s.x, slope, s.y), wet));
  textureStore(surfaceB, c, vec4f(s.z, s.w, select(0.0, 1.0, wet), 0.0));
}
