// Hermit crabs: a logarithmic spiral shell, with legs, claws, eyestalks and
// antennae that pull back into the aperture when the crab retracts.

struct Crab {
  a: vec4f, // position xyz, heading
  b: vec4f, // ground normal xyz, shell size
  c: vec4f, // extension 0..1, gait phase, seed, variety
  d: vec4f, // claw wave, shell wobble, shell hue, unused
}

@group(2) @binding(0) var<storage, read> crabs: array<Crab>;

const TURNS: f32 = 3.1;
const GROWTH: f32 = 2.7;
const D0: f32 = 0.55;
const H0: f32 = 0.8;
const A0: f32 = 0.52;

struct Basis {
  fwd: vec3f,
  side: vec3f,
  up: vec3f,
  e1: vec3f,
  e2: vec3f,
  e3: vec3f,
  apex: vec3f,
  aperture: vec3f,
  size: f32,
}

fn basisOf(c: Crab) -> Basis {
  var b: Basis;
  b.up = normalize(c.b.xyz);
  let h = vec3f(cos(c.a.w), 0.0, sin(c.a.w));
  b.fwd = normalize(h - b.up * dot(h, b.up));
  b.side = normalize(cross(b.fwd, b.up));
  b.size = c.b.w;
  let wobble = c.d.y;
  b.e3 = normalize(-b.fwd * 0.85 + b.up * (0.5 + wobble * 0.1) + b.side * wobble * 0.15);
  b.e1 = normalize(cross(b.up, b.e3));
  b.e2 = cross(b.e3, b.e1);
  let apertureLocal = (b.e2 * D0 - b.e3 * H0) * b.size;
  b.aperture = c.a.xyz + b.up * b.size * 0.42 + b.fwd * b.size * 0.1;
  b.apex = b.aperture - apertureLocal;
  return b;
}

struct Placed {
  world: vec3f,
  normal: vec3f,
  uv: vec2f,
}

fn shellPoint(b: Basis, t: f32, theta: f32) -> Placed {
  let g = exp(GROWTH * (t - 1.0));
  let phi = (t - 1.0) * TURNS * TAU + PI * 0.5;
  let radial = b.e1 * cos(phi) + b.e2 * sin(phi);
  let center = b.apex + (radial * D0 - b.e3 * H0) * g * b.size;
  let a = A0 * g * b.size;
  let n = radial * cos(theta) + b.e3 * sin(theta);
  var o: Placed;
  o.world = center + n * a;
  o.normal = n;
  o.uv = vec2f(t, theta);
  return o;
}

fn tube(p0: vec3f, p1: vec3f, p2: vec3f, u: f32, theta: f32, r0: f32, r1: f32) -> Placed {
  var a = p0;
  var bb = p1;
  var k = u * 2.0;
  if (u > 0.5) {
    a = p1;
    bb = p2;
    k = u * 2.0 - 1.0;
  }
  let t = normalize(bb - a + vec3f(1e-5, 0.0, 0.0));
  var refAxis = vec3f(0.0, 1.0, 0.0);
  if (abs(t.y) > 0.9) {
    refAxis = vec3f(1.0, 0.0, 0.0);
  }
  let n1 = normalize(cross(t, refAxis));
  let n2 = cross(t, n1);
  let r = mix(r0, r1, u) * sqrt(max(sin(min(u * 12.0, 1.0) * PI * 0.5), 0.05)) * sqrt(max(1.0 - pow(u, 8.0), 0.05));
  let n = n1 * cos(theta) + n2 * sin(theta);
  var o: Placed;
  o.world = mix(a, bb, k) + n * r;
  o.normal = n;
  o.uv = vec2f(u, theta);
  return o;
}

fn place(vertex: vec4f, c: Crab) -> Placed {
  let b = basisOf(c);
  let part = i32(vertex.x + 0.5);
  let u = vertex.y;
  let theta = vertex.z * TAU;
  if (part == 0) {
    return shellPoint(b, u, theta);
  }
  let R = b.size;
  let ext = c.c.x;
  let A = b.aperture - b.up * R * 0.12;
  let hidden = b.aperture + b.e3 * R * 0.25;
  let k = part - 1;
  var p0 = A;
  var p1 = A;
  var p2 = A;
  var r0 = 0.07 * R;
  var r1 = 0.035 * R;
  let ground = -0.5 * R;

  if (k < 4) {
    let sgn = select(-1.0, 1.0, k < 2);
    let j = f32(k % 2);
    let g = c.c.y + j * PI + select(PI, 0.0, sgn > 0.0);
    let lift = max(sin(g), 0.0) * 0.22 * R;
    let swing = cos(g) * 0.16 * R;
    p0 = A + b.fwd * (0.3 - 0.18 * j) * R + b.side * sgn * 0.22 * R;
    p2 = A + b.fwd * ((0.62 - 0.55 * j) * R + swing) + b.side * sgn * 0.95 * R + b.up * (ground + lift);
    p1 = mix(p0, p2, 0.45) + b.up * 0.42 * R + b.side * sgn * 0.12 * R;
  } else if (k < 6) {
    let sgn = select(-1.0, 1.0, k == 4);
    let big = select(0.72, 1.0, k == 4);
    let wave = c.d.x * select(0.0, 1.0, k == 4);
    p0 = A + b.fwd * 0.3 * R + b.side * sgn * 0.14 * R + b.up * 0.05 * R;
    p1 = A + b.fwd * 0.55 * R + b.side * sgn * 0.32 * R * big + b.up * (0.12 + wave * 0.3) * R;
    p2 = A + b.fwd * (0.9 + wave * 0.15) * R * big + b.side * sgn * 0.16 * R + b.up * (-0.08 + wave * 0.4) * R;
    r0 = 0.08 * R * big;
    r1 = 0.17 * R * big;
  } else if (k < 8) {
    let sgn = select(-1.0, 1.0, k == 6);
    p0 = A + b.fwd * 0.38 * R + b.side * sgn * 0.07 * R + b.up * 0.18 * R;
    p2 = p0 + (b.fwd * 0.22 + b.up * 0.3 + b.side * sgn * 0.06) * R;
    p1 = mix(p0, p2, 0.5);
    r0 = 0.035 * R;
    r1 = 0.07 * R;
  } else {
    let sgn = select(-1.0, 1.0, k == 8);
    let sway = sin(frame.camera.w * 2.3 + c.c.z * 9.0 + sgn) * 0.25;
    p0 = A + b.fwd * 0.42 * R + b.side * sgn * 0.05 * R + b.up * 0.14 * R;
    p1 = p0 + (b.fwd * 0.5 + b.side * sgn * (0.2 + sway * 0.4) + b.up * 0.25) * R;
    p2 = p1 + (b.fwd * 0.55 + b.side * sgn * (0.35 + sway) + b.up * 0.05) * R;
    r0 = 0.014 * R;
    r1 = 0.008 * R;
  }
  p0 = mix(hidden, p0, ext);
  p1 = mix(hidden, p1, ext);
  p2 = mix(hidden, p2, ext);
  var o = tube(p0, p1, p2, u, theta, r0 * ext, r1 * ext);
  o.uv = vec2f(u, f32(part));
  return o;
}

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) id: u32,
  @location(4) @interpolate(flat) part: f32,
}

@vertex
fn vs(@location(0) vertex: vec4f, @builtin(instance_index) id: u32) -> VsOut {
  let p = place(vertex, crabs[id]);
  var o: VsOut;
  o.position = frame.viewProj * vec4f(p.world, 1.0);
  o.world = p.world;
  o.normal = p.normal;
  o.uv = select(vec2f(vertex.y, vertex.z), p.uv, vertex.x > 0.5);
  o.id = id;
  o.part = vertex.x;
  return o;
}

@vertex
fn vsShadow(@location(0) vertex: vec4f, @builtin(instance_index) id: u32) -> @builtin(position) vec4f {
  return frame.sunViewProj * vec4f(place(vertex, crabs[id]).world, 1.0);
}

@fragment
fn fs(in: VsOut, @builtin(front_facing) front: bool) -> SceneOut {
  let c = crabs[in.id];
  var n = normalize(in.normal);
  if (!front) {
    n = -n;
  }
  let v = normalize(frame.camera.xyz - in.world);
  let part = i32(in.part + 0.5);
  let variety = i32(c.c.w + 0.5);
  var albedo = vec3f(0.3);
  var rough = 0.5;
  var spec = 0.4;

  if (part == 0) {
    let t = in.uv.x;
    let theta = in.uv.y * TAU;
    let hue = c.d.z;
    var shells = array<vec3f, 4>(vec3f(0.18, 0.13, 0.09), vec3f(0.05, 0.045, 0.05), vec3f(0.42, 0.28, 0.16), vec3f(0.3, 0.27, 0.22));
    let base = shells[i32(hue * 3.99)];
    let cords = smoothstep(0.3, 0.9, sin(theta * 9.0) * 0.5 + 0.5);
    let growth = sin(t * 260.0 + vnoise(vec2f(theta * 3.0, t * 20.0)) * 4.0) * 0.5 + 0.5;
    let bands = smoothstep(0.4, 0.7, vnoise(vec2f(t * 30.0, theta * 2.0) + c.c.z));
    albedo = base * (0.75 + cords * 0.3) * (0.9 + growth * 0.15);
    albedo = mix(albedo, base * 1.9 + 0.05, bands * 0.35);
    // Worn apex.
    albedo = mix(albedo, vec3f(0.5, 0.45, 0.4), smoothstep(0.25, 0.0, t) * 0.6);
    // Encrusting coralline and tiny barnacles.
    let crust = smoothstep(0.62, 0.75, fbm3(vec2f(t * 8.0, theta) + c.c.z * 3.0));
    albedo = mix(albedo, vec3f(0.45, 0.25, 0.3), crust * 0.7);
    rough = 0.45;
    spec = 0.5;
  } else {
    let u = in.uv.x;
    var limb = array<vec3f, 3>(vec3f(0.55, 0.12, 0.05), vec3f(0.12, 0.12, 0.35), vec3f(0.3, 0.22, 0.08));
    var accent = array<vec3f, 3>(vec3f(0.85, 0.82, 0.75), vec3f(0.75, 0.35, 0.08), vec3f(0.6, 0.55, 0.4));
    let base = limb[variety % 3];
    let band = smoothstep(0.75, 0.9, sin(u * 18.0) * 0.5 + 0.5);
    albedo = mix(base, accent[variety % 3], band * 0.7);
    if (part >= 5 && part <= 6) {
      let granules = step(0.75, vnoise(in.world.xz * 900.0));
      albedo = mix(albedo, accent[variety % 3], granules * smoothstep(0.5, 0.8, u));
      albedo = mix(albedo, vec3f(0.08, 0.03, 0.02), smoothstep(0.93, 1.0, u));
    }
    if (part == 7 || part == 8) {
      albedo = mix(albedo, vec3f(0.01), smoothstep(0.82, 0.9, u));
      rough = mix(0.5, 0.1, smoothstep(0.82, 0.9, u));
      spec = 1.2;
    }
    if (part >= 9) {
      albedo = vec3f(0.55, 0.25, 0.12);
    }
  }
  let s = Surface(albedo, rough, spec, 1.0, 0.25);
  let color = shade(in.world, n, v, s, in.position.xy);
  return sceneOut(color, in.world);
}
