// The rock shelf, pool bed and sea floor as one displaced grid.

override columns: u32 = 640u;
override rows: u32 = 468u;
const EXTEND: f32 = 1.45;

struct TerrainOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
}

fn gridPoint(index: u32) -> vec3f {
  let c = index % columns;
  let r = index / columns;
  let g = vec2f(f32(c), f32(r)) / vec2f(f32(columns - 1u), f32(rows - 1u));
  let xz = TERRAIN_CENTER + (g * 2.0 - 1.0) * TERRAIN_HALF * EXTEND;
  return vec3f(xz.x, terrainHeight(xz), xz.y);
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> TerrainOut {
  let p = gridPoint(index);
  var o: TerrainOut;
  o.position = frame.viewProj * vec4f(p, 1.0);
  o.world = p;
  return o;
}

@vertex
fn vsShadow(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return frame.sunViewProj * vec4f(gridPoint(index), 1.0);
}

fn detailHeight(p: vec2f) -> f32 {
  return fbm(p * 9.0) * 0.6 + vnoise(p * 38.0) * 0.25;
}

fn barnacles(p: vec2f) -> vec3f {
  // x: coverage, y: shell rim, z: dark centre
  let v = voronoi(p * 30.0);
  let present = step(0.3, v.z);
  let r = v.x / (0.35 + 0.2 * v.w);
  let shell = (1.0 - smoothstep(0.75, 0.95, r)) * present;
  let hole = (1.0 - smoothstep(0.18, 0.3, r)) * present;
  return vec3f(shell, smoothstep(0.4, 0.8, r) * shell, hole);
}

fn mussels(p: vec2f) -> vec2f {
  let q = mat2x2f(0.8, 0.6, -0.6, 0.8) * p;
  let v = voronoi(q * vec2f(24.0, 48.0));
  let body = 1.0 - smoothstep(0.35, 0.55, v.x);
  return vec2f(body, v.z);
}

@fragment
fn fs(in: TerrainOut) -> SceneOut {
  let p = in.world;
  let data = terrainData(p.xz);
  let ao = data.z;
  let crack = data.w;
  let sand = data.y;
  let rel = p.y;
  let v = normalize(frame.camera.xyz - p);
  let dist = length(frame.camera.xyz - p);

  // Normal from the height texture plus fine rock grain.
  var n = terrainNormal(p.xz, 0.012);
  let e = 0.004;
  let near = 1.0 - smoothstep(4.0, 10.0, dist);
  let dh = vec2f(
    detailHeight(p.xz + vec2f(e, 0.0)) - detailHeight(p.xz - vec2f(e, 0.0)),
    detailHeight(p.xz + vec2f(0.0, e)) - detailHeight(p.xz - vec2f(0.0, e)),
  ) / (2.0 * e) * 0.03 * near;
  n = normalize(n + vec3f(-dh.x, 0.0, -dh.y));
  let cavity = clamp(0.5 + (detailHeight(p.xz) - 0.45) * 1.6, 0.0, 1.0);

  let tone = fbm(p.xz * 1.3);
  let warm = fbm3(p.xz * 0.5 + 9.0);
  let grain = vnoise(p.xz * 60.0) * 0.5 + vnoise(p.xz * 150.0) * 0.5;
  let basalt = vec3f(0.055, 0.056, 0.062);
  let brown = vec3f(0.19, 0.155, 0.12);
  let weathered = vec3f(0.33, 0.31, 0.28);
  var rock = mix(basalt, brown, smoothstep(0.3, 0.7, warm));
  rock = mix(rock, weathered, smoothstep(0.45, 0.8, tone) * 0.8);
  rock *= 0.8 + grain * 0.35;
  // Thin quartz veins.
  let vein = abs(sin(dot(p.xz, vec2f(0.6, -0.8)) * 7.0 + fbm(p.xz * 1.5) * 9.0));
  rock = mix(rock, vec3f(0.55, 0.53, 0.5), (1.0 - smoothstep(0.0, 0.035, vein)) * smoothstep(0.55, 0.7, vnoise(p.xz * 0.9)) * 0.7);
  rock *= mix(0.75, 1.1, cavity);
  var albedo = rock;
  var rough = 0.7;
  var specular = 0.3;
  var translucency = 0.0;

  let water = waterSurface(p.xz).x;
  let under = water - p.y;
  let seaSide = 1.0 - smoothstep(-2.3, -1.3, p.z);

  if (under > 0.0) {
    // Below the surface: coralline crust, red and green algae, gravel, sand.
    let coral = smoothstep(0.55, 0.66, fbm(p.xz * 3.6 + 5.0)) * smoothstep(-0.02, -0.05, rel);
    let film = smoothstep(0.35, 0.7, fbm3(p.xz * 3.0 - 2.0));
    albedo = mix(rock * vec3f(0.75, 0.9, 0.7), vec3f(0.09, 0.11, 0.04), film * 0.65);
    let redWeed = smoothstep(0.6, 0.72, fbm(p.xz * 5.0 + 17.0)) * (1.0 - coral);
    albedo = mix(albedo, vec3f(0.18, 0.04, 0.05), redWeed * 0.8);
    let crust = vnoise(p.xz * 40.0) * 0.6 + vnoise(p.xz * 9.0) * 0.4;
    let pink = mix(vec3f(0.22, 0.08, 0.12), vec3f(0.42, 0.22, 0.27), crust);
    albedo = mix(albedo, pink * mix(0.8, 1.1, cavity), coral * (1.0 - crack));
    let peb = voronoi(p.xz * 13.0 + vec2f(fbm3(p.xz * 6.0), fbm3(p.xz * 6.0 + 3.0)) * 0.9);
    let hue = peb.z;
    var pebColor = mix(vec3f(0.12, 0.115, 0.11), vec3f(0.42, 0.39, 0.34), hue);
    pebColor = mix(pebColor, vec3f(0.3, 0.18, 0.12), step(0.82, peb.w));
    pebColor *= mix(0.85, 1.05, smoothstep(0.0, 0.3, 0.45 - peb.x));
    let gravel = smoothstep(0.1, 0.3, -rel) * (1.0 - smoothstep(0.32, 0.48, peb.x)) * smoothstep(0.4, 0.6, fbm3(p.xz * 1.7 + 8.0));
    albedo = mix(albedo, pebColor, gravel * (1.0 - coral) * 0.7);
    let grains = vnoise(p.xz * 160.0) * 0.14 + 0.93;
    let shells = step(0.86, vnoise(p.xz * 90.0)) * 0.3;
    albedo = mix(albedo, vec3f(0.48, 0.42, 0.32) * grains + shells, sand);
    // Open sea floor: dark weed and rock.
    albedo = mix(albedo, vec3f(0.04, 0.05, 0.025) * (0.6 + tone), smoothstep(0.45, 0.8, under) * seaSide);
    albedo *= 0.7;
    rough = 0.55;
    specular = 0.2;
  } else {
    let height = rel - max(water, 0.0);
    // Intertidal bands: green weed and barnacles low down, mussels on the
    // seaward side, dark lichen above, orange lichen on the dry tops.
    let low = 1.0 - smoothstep(0.03, 0.1, rel + (tone - 0.5) * 0.04);
    let ulva = smoothstep(0.5, 0.62, fbm(p.xz * 3.0 + 31.0)) * (1.0 - smoothstep(0.0, 0.035, height)) * (1.0 - seaSide);
    let b = barnacles(p.xz);
    let barnacleZone = (1.0 - smoothstep(0.02, 0.06, height)) * smoothstep(0.35, 0.55, fbm3(p.xz * 2.5 + 1.0)) * near;
    albedo = mix(albedo, mix(vec3f(0.42, 0.4, 0.36), vec3f(0.66, 0.64, 0.58), b.y), b.x * barnacleZone);
    albedo = mix(albedo, vec3f(0.04, 0.035, 0.03), b.z * barnacleZone);

    let m = mussels(p.xz);
    let musselZone = low * seaSide * smoothstep(0.4, 0.6, fbm3(p.xz * 1.8 + 3.0));
    let musselColor = mix(vec3f(0.02, 0.025, 0.04), vec3f(0.1, 0.08, 0.06), smoothstep(0.75, 1.0, m.y));
    albedo = mix(albedo, musselColor, m.x * musselZone);
    albedo = mix(albedo, vec3f(0.07, 0.17, 0.03) * (0.8 + grain * 0.4), ulva * 0.85);

    let blackBand = smoothstep(0.04, 0.09, rel) * (1.0 - smoothstep(0.1, 0.15, rel));
    albedo = mix(albedo, albedo * 0.5, blackBand * 0.8);
    let lichenField = smoothstep(0.55, 0.7, fbm3(p.xz * 1.6 + 11.0));
    let lichen = smoothstep(0.62, 0.7, fbm(p.xz * 9.0)) * lichenField * smoothstep(0.13, 0.18, rel);
    albedo = mix(albedo, vec3f(0.55, 0.32, 0.08), lichen * 0.75);
    let pale = smoothstep(0.66, 0.74, fbm(p.xz * 7.0 - 7.0)) * smoothstep(0.15, 0.2, rel);
    albedo = mix(albedo, vec3f(0.4, 0.4, 0.35), pale * 0.45);

    // Wet near the waterline and where the sea washes over.
    let wet = 1.0 - smoothstep(0.008, 0.045, height);
    albedo *= mix(1.0, 0.6, wet);
    rough = mix(0.72, 0.28, wet * (1.0 - b.x * barnacleZone * 0.6));
    specular = mix(0.25, 0.8, wet);
    rough = mix(rough, 0.25, m.x * musselZone);
    translucency = ulva * 0.2;
  }

  let crackShade = crack * smoothstep(-0.03, 0.0, rel);
  albedo *= mix(1.0, 0.35, crackShade);
  let s = Surface(albedo, rough, specular, ao * mix(1.0, 0.5, crackShade), translucency);
  let color = shade(p, n, v, s, in.position.xy);
  return sceneOut(color, p);
}
