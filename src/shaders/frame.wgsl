// Per-frame uniforms and the world textures every render pass can read.

struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  sunViewProj: mat4x4f,
  camera: vec4f,      // xyz eye, w time
  resolution: vec4f,  // w, h, 1/w, 1/h
  sunDir: vec4f,      // xyz toward the light, w frame index
  sunColor: vec4f,    // rgb radiance, w sun disc strength
  skyZenith: vec4f,   // rgb, w intensity
  skyHorizon: vec4f,  // rgb, w stars
  absorption: vec4f,  // rgb per metre, w unused
  scatter: vec4f,     // rgb, w amount
  grade: vec4f,       // exposure, night, bioluminescence, pixel footprint
  pointer: vec4f,     // xz, active, speed
  ocean: vec4f,       // swell amplitude, surge z, surge height, surge width
  extra: vec4f,       // tide 0..1, wind, caustic strength, surge activity
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var terrainTex: texture_2d<f32>;
@group(0) @binding(2) var surfaceA: texture_2d<f32>;
@group(0) @binding(3) var surfaceB: texture_2d<f32>;
@group(0) @binding(4) var linearClamp: sampler;

fn terrainUv(xz: vec2f) -> vec2f {
  return (xz - TERRAIN_CENTER) / (2.0 * TERRAIN_HALF) + 0.5;
}

fn simUv(xz: vec2f) -> vec2f {
  return (xz - SIM_CENTER) / (2.0 * SIM_HALF) + 0.5;
}

fn terrainData(xz: vec2f) -> vec4f {
  return textureSampleLevel(terrainTex, linearClamp, terrainUv(xz), 0.0);
}

fn terrainHeight(xz: vec2f) -> f32 {
  return terrainData(xz).x;
}

fn terrainNormal(xz: vec2f, e: f32) -> vec3f {
  let hx = terrainHeight(xz + vec2f(e, 0.0)) - terrainHeight(xz - vec2f(e, 0.0));
  let hz = terrainHeight(xz + vec2f(0.0, e)) - terrainHeight(xz - vec2f(0.0, e));
  return normalize(vec3f(-hx, 2.0 * e, -hz));
}

fn simWeight(xz: vec2f) -> f32 {
  let q = abs(xz - SIM_CENTER) - (SIM_HALF - 0.05);
  return 1.0 - smoothstep(-0.06, 0.0, max(q.x, q.y));
}

// Height and slopes of the water: simulated inside the pool area, the
// analytic sea outside it.
fn waterSurface(xz: vec2f) -> vec3f {
  let w = simWeight(xz);
  let sea = ocean(xz, frame.camera.w, frame.ocean);
  if (w <= 0.0) {
    return sea;
  }
  let s = textureSampleLevel(surfaceA, linearClamp, simUv(xz), 0.0).xyz;
  return mix(sea, s, w);
}

fn waterExtras(xz: vec2f) -> vec2f {
  let w = simWeight(xz);
  if (w <= 0.0) {
    return vec2f(0.0);
  }
  return textureSampleLevel(surfaceB, linearClamp, simUv(xz), 0.0).xy * w;
}

fn skyColor(dir: vec3f) -> vec3f {
  let up = clamp(dir.y, 0.0, 1.0);
  var c = mix(frame.skyHorizon.rgb, frame.skyZenith.rgb, pow(up, 0.6)) * frame.skyZenith.w;
  let sd = max(dot(dir, frame.sunDir.xyz), 0.0);
  c += frame.sunColor.rgb * (pow(sd, 1600.0) * 60.0 * frame.sunColor.w + pow(sd, 12.0) * 0.12);
  if (frame.skyHorizon.w > 0.0) {
    let cell = dir.xz / max(dir.y, 0.05) * 90.0;
    let v = voronoi(cell);
    let star = smoothstep(0.08, 0.0, v.x) * step(0.82, v.z) * (0.5 + v.w);
    c += vec3f(0.8, 0.85, 1.0) * star * frame.skyHorizon.w * up;
  }
  return c;
}

fn skyAmbient(n: vec3f) -> vec3f {
  let t = n.y * 0.5 + 0.5;
  return mix(frame.skyHorizon.rgb * 0.6, frame.skyZenith.rgb, t) * frame.skyZenith.w;
}

fn ign(pixel: vec2f) -> f32 {
  let p = pixel + f32(u32(frame.sunDir.w) % 32u) * 5.588238;
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

fn ggx(n: vec3f, v: vec3f, l: vec3f, rough: f32) -> f32 {
  let h = normalize(v + l);
  let nh = max(dot(n, h), 0.0);
  let nl = max(dot(n, l), 0.0);
  let nv = max(dot(n, v), 1e-3);
  let a = rough * rough;
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  let dist = a2 / (PI * d * d);
  let k = a * 0.5;
  let g = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);
  let f = 0.04 + 0.96 * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  return dist * g * f / (4.0 * nv + 1e-4);
}

fn fullscreen(index: u32) -> vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}
