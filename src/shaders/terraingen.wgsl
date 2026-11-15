// Builds the rock shelf, the pool basin, the gully and the sea floor once at
// start-up. Writes height, sand, occlusion and crack masks to a texture and
// the bare heights to a buffer the CPU reads back for the creatures.

@group(0) @binding(0) var terrainOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<storage, read_write> heightsOut: array<f32>;

fn ellipse(p: vec2f, c: vec2f, r: vec2f) -> f32 {
  return (length((p - c) / r) - 1.0) * min(r.x, r.y);
}

fn poolSdf(p: vec2f) -> f32 {
  let warp = vec2f(fbm3(p * 0.9 + 3.1), fbm3(p * 0.9 + 7.7)) - 0.5;
  let q = p + warp * 0.34;
  var d = ellipse(q, vec2f(0.0, 0.42), vec2f(2.0, 1.12));
  d = smin(d, ellipse(q, vec2f(-1.35, 0.8), vec2f(0.95, 0.72)), 0.5);
  d = smin(d, ellipse(q, vec2f(1.42, 0.12), vec2f(0.85, 0.82)), 0.5);
  d = smax(d, -ellipse(q, vec2f(-0.45, -0.45), vec2f(0.42, 0.26)), 0.22);
  d += (fbm(p * 1.8) - 0.5) * 0.22 + (fbm(p * 5.0) - 0.5) * 0.08;
  return d;
}

fn segmentDistance(p: vec2f, a: vec2f, b: vec2f) -> vec2f {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return vec2f(length(p - a - ab * t), t);
}

fn channelSdf(p: vec2f) -> vec2f {
  let q = vec2f(p.x - sin(p.y * 2.3) * 0.12, p.y);
  let s = segmentDistance(q, vec2f(1.0, -0.4), vec2f(1.25, -3.1));
  let width = 0.15 + 0.05 * vnoise(p * 3.0);
  return vec2f(s.x - width, s.y);
}

fn seaSdf(p: vec2f) -> f32 {
  let edge = -2.85 + (fbm(vec2f(p.x * 0.4, 1.3)) - 0.5) * 1.5;
  return p.y - edge;
}

fn rockWarp(p: vec2f) -> vec2f {
  return p + (vec2f(fbm3(p * 0.5), fbm3(p * 0.5 + 5.2)) - 0.5) * 1.2;
}

fn crackMask(p: vec2f) -> f32 {
  let q = rockWarp(p);
  let v = voronoi(q * 0.95 + vec2f(fbm3(p * 3.0)) * 0.35);
  let width = mix(0.012, 0.05, vnoise(p * 2.3));
  let present = smoothstep(0.4, 0.6, vnoise(p * 0.8 + 2.0));
  return (1.0 - smoothstep(0.0, width, v.y)) * present;
}

fn rockHeight(p: vec2f) -> f32 {
  let q = rockWarp(p);
  var h = 0.06 + 0.1 * smoothstep(-2.2, 2.2, p.y) + 0.12 * (fbm(q * 0.45) - 0.5);
  // Weathered bedding: terraces that follow the noise contours.
  let t = fbm(q * 0.8 + 1.3) * 7.0;
  let terrace = floor(t) + smoothstep(0.25, 0.75, fract(t));
  h += 0.022 * (terrace - 3.5);
  // Rounded, ridged weathering.
  let ridge = 1.0 - abs(2.0 * fbm(q * 2.4) - 1.0);
  h += 0.024 * ridge * ridge;
  h -= 0.032 * crackMask(p);
  h += 0.012 * (fbm(p * 6.0) - 0.5);
  return h;
}

fn boulders(p: vec2f) -> f32 {
  var centers = array<vec4f, 7>(
    vec4f(-0.95, 0.15, 0.32, -0.09),
    vec4f(0.55, 0.85, 0.26, -0.12),
    vec4f(-1.75, 0.95, 0.24, 0.035),
    vec4f(1.35, 0.4, 0.3, -0.07),
    vec4f(0.2, 0.05, 0.18, -0.16),
    vec4f(-0.25, 1.0, 0.2, -0.13),
    vec4f(1.75, -0.25, 0.22, 0.05),
  );
  var h = -10.0;
  for (var i = 0; i < 7; i++) {
    let c = centers[i];
    let n = fbm3(p * 5.0 + f32(i) * 7.0) - 0.5;
    let r = length((p - c.xy) / vec2f(1.0, 0.8)) / (c.z * (1.0 + n * 0.3));
    let dome = sqrt(max(1.0 - r * r, 0.0));
    h = max(h, select(-10.0, c.w - (1.0 - dome) * 0.35, r < 1.0));
  }
  return h;
}

fn bedHeight(p: vec2f, inside: f32) -> f32 {
  let depth = 0.09 + 0.3 * smoothstep(0.0, 0.85, inside) * (0.7 + 0.6 * fbm3(p * 0.8));
  var h = -depth + 0.03 * (fbm(p * 3.0) - 0.5);
  // Pebbles in the deeper flats.
  let peb = voronoi(p * 13.0);
  h += 0.006 * (1.0 - smoothstep(0.1, 0.5, peb.x)) * smoothstep(0.15, 0.5, inside) * smoothstep(0.4, 0.6, fbm3(p * 1.7 + 8.0));
  h = smax(h, boulders(p), 0.05);
  return h;
}

fn heightAt(p: vec2f) -> vec2f {
  let rock = rockHeight(p);
  let pool = poolSdf(p);
  let inside = max(-pool, 0.0);
  let bed = bedHeight(p, inside);
  // Steep, slightly undercut walls.
  var h = mix(bed, rock, smoothstep(-0.07, 0.05, pool + (fbm3(p * 3.0) - 0.5) * 0.06));

  let ch = channelSdf(p);
  let sill = -0.035 - 0.05 * smoothstep(0.55, 1.0, ch.y) - 0.015 * vnoise(p * 6.0);
  h = min(h, mix(sill, h, smoothstep(-0.03, 0.05, ch.x)));

  let sea = seaSdf(p);
  let stacks = voronoi(p * 1.3);
  let sr = stacks.x / (0.3 + 0.15 * stacks.w) + (fbm3(p * 4.0) - 0.5) * 0.5;
  let stack = select(0.0, 0.16 * sqrt(max(1.0 - sr * sr, 0.0)), stacks.z > 0.62);
  let seaFloor = -1.3 + 0.5 * fbm(p * 1.2) + pow(stack / 0.16, 0.5) * 1.45 * smoothstep(-1.1, -0.3, sea);
  h = mix(seaFloor, h, smoothstep(-0.7, 0.12, sea));

  // Keep everything outside the simulated area dry unless it is open sea.
  let q = abs(p - SIM_CENTER) - (SIM_HALF - 0.08);
  let outside = smoothstep(-0.05, 0.05, max(q.x, q.y)) * smoothstep(-0.1, 0.4, sea);
  h = mix(h, max(h, 0.02 + 0.02 * fbm3(p * 3.0)), outside);

  let sand = smoothstep(0.35, 0.75, inside) * smoothstep(0.45, 0.65, fbm3(p * 1.1 + 4.0));
  return vec2f(h, sand);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let cell = vec2i(id.xy);
  if (any(cell >= TERRAIN_SIZE)) {
    return;
  }
  let uv = (vec2f(cell) + 0.5) / vec2f(TERRAIN_SIZE);
  let p = TERRAIN_CENTER + (uv * 2.0 - 1.0) * TERRAIN_HALF;
  let hs = heightAt(p);

  // Occlusion: how far the neighbourhood rises above this point.
  var around = 0.0;
  for (var i = 0; i < 8; i++) {
    let a = f32(i) * TAU / 8.0;
    around += heightAt(p + vec2f(cos(a), sin(a)) * 0.07).x;
  }
  around /= 8.0;
  let ao = 1.0 - clamp((around - hs.x) * 7.0, 0.0, 0.7);

  textureStore(terrainOut, cell, vec4f(hs.x, hs.y, ao, crackMask(p)));
  heightsOut[cell.y * TERRAIN_SIZE.x + cell.x] = hs.x;
}
