// Blennies, gobies and sculpins: a tube body bent along a swimming spine,
// with a long dorsal fin, tail, anal fin and fanned pectorals. All shape and
// markings come from the instance data and the vertex's (part, u, v).

struct Fish {
  a: vec4f, // position xyz, heading
  b: vec4f, // length, swim phase, amplitude, bend
  c: vec4f, // pitch, seed, variety, pectoral flare
  d: vec4f, // breathing, unused...
}

@group(2) @binding(0) var<storage, read> fish: array<Fish>;

const BODY_CENTER: f32 = 0.42;

struct Frame3 {
  center: vec3f,
  fwd: vec3f,
  side: vec3f,
  len: f32,
  phase: f32,
  amp: f32,
  bend: f32,
  pitch: f32,
}

fn frameOf(f: Fish) -> Frame3 {
  var k: Frame3;
  k.center = f.a.xyz;
  k.fwd = vec3f(cos(f.a.w), 0.0, sin(f.a.w));
  k.side = vec3f(-sin(f.a.w), 0.0, cos(f.a.w));
  k.len = f.b.x;
  k.phase = f.b.y;
  k.amp = f.b.z;
  k.bend = f.b.w;
  k.pitch = f.c.x;
  return k;
}

fn halfWidth(s: f32) -> f32 {
  var w = 0.0;
  if (s < 0.2) {
    let k = (0.2 - s) / 0.2;
    w = 0.1 * pow(max(1.0 - k * k, 0.0), 0.55);
  } else {
    w = 0.1 * mix(1.0, 0.18, smoothstep(0.2, 0.97, s));
  }
  return w * sqrt(clamp((1.0 - s) / 0.02, 0.0, 1.0));
}

fn halfHeight(s: f32) -> f32 {
  var h = 0.0;
  if (s < 0.17) {
    let k = (0.17 - s) / 0.17;
    h = 0.11 * pow(max(1.0 - k * k, 0.0), 0.5);
  } else {
    h = 0.11 * mix(1.0, 0.32, smoothstep(0.17, 0.95, s));
  }
  return h * sqrt(clamp((1.0 - s) / 0.02, 0.0, 1.0));
}

fn lateral(k: Frame3, s: f32) -> f32 {
  let envelope = 0.1 + 0.9 * s * s;
  return sin(k.phase - s * TAU * 0.85) * k.amp * envelope + k.bend * (s - 0.15) * (s - 0.15) * 0.6;
}

fn spine(k: Frame3, s: f32) -> vec3f {
  let offset = (BODY_CENTER - s) * k.len;
  return k.center + k.fwd * offset * cos(k.pitch) + k.side * lateral(k, s) * k.len + vec3f(0.0, offset * sin(k.pitch), 0.0);
}

fn tangent(k: Frame3, s: f32) -> vec3f {
  return normalize(spine(k, s + 0.01) - spine(k, s - 0.01));
}

struct Placed {
  world: vec3f,
  normal: vec3f,
  s: f32,
  angle: f32,
}

fn place(vertex: vec4f, f: Fish) -> Placed {
  let k = frameOf(f);
  let part = i32(vertex.x + 0.5);
  let u = vertex.y;
  let v = vertex.z;
  let up = vec3f(0.0, 1.0, 0.0);
  var o: Placed;
  o.s = u;
  o.angle = 0.0;
  let t = f.c.y * 13.0 + frame.camera.w;

  if (part == 0) {
    let s = u;
    let back = tangent(k, s);
    let side = normalize(cross(up, back));
    let theta = v * TAU;
    let w = halfWidth(s) * k.len;
    let h = halfHeight(s) * k.len * select(1.0, 0.8, sin(theta) < 0.0);
    o.world = spine(k, s) + side * cos(theta) * w + up * sin(theta) * h;
    o.normal = normalize(side * cos(theta) / max(w, 1e-4) + up * sin(theta) / max(h, 1e-4) - back * 0.3 * (1.0 - smoothstep(0.0, 0.12, s)));
    o.angle = theta;
  } else if (part == 1) {
    // Long dorsal fin.
    let s = mix(0.18, 0.9, u);
    let height = k.len * 0.075 * (0.55 + 0.45 * sin(u * PI)) * (1.0 - 0.25 * u);
    let flutter = sin(t * 7.0 - u * 9.0) * 0.12 * v;
    let side = normalize(cross(up, tangent(k, s)));
    o.world = spine(k, s) + up * (halfHeight(s) * k.len * 0.92 + v * height) + side * flutter * height;
    o.normal = side;
    o.s = s;
    o.angle = 7.0 + v;
  } else if (part == 2) {
    // Tail fan.
    let base = spine(k, 0.97);
    let back = -tangent(k, 0.96);
    let side = normalize(cross(up, back));
    let spread = (v - 0.5) * 1.3;
    let r = u * k.len * 0.17 * (1.0 - 0.15 * abs(v - 0.5) * 2.0);
    let flex = sin(k.phase - 5.6) * k.amp * u * 0.6;
    o.world = base + back * cos(spread) * r + up * sin(spread) * r * 1.1 + side * flex * r * 3.0;
    o.normal = side;
    o.s = 0.97 + u * 0.1;
    o.angle = 8.0 + v;
  } else if (part == 3 || part == 4) {
    // Pectoral fans, propped out when resting.
    let sgn = select(-1.0, 1.0, part == 4);
    let s0 = 0.2;
    let back = -tangent(k, s0);
    let side = normalize(cross(up, -back)) * sgn;
    let anchor = spine(k, s0) + side * halfWidth(s0) * k.len * 0.85 - up * halfHeight(s0) * k.len * 0.35;
    let flare = f.c.w;
    let beat = sin(t * 5.0 + sgn) * 0.25 * (1.0 - flare);
    let phi = v * mix(0.7, 1.7, flare) + beat;
    let dir = normalize(back * cos(phi) + side * sin(phi) - up * 0.3 * flare);
    let r = u * k.len * 0.17 * (0.75 + 0.25 * sin(v * PI));
    o.world = anchor + dir * r;
    o.normal = normalize(cross(dir, normalize(back * -sin(phi) + side * cos(phi))));
    o.s = s0;
    o.angle = 9.0 + v;
  } else {
    // Anal fin.
    let s = mix(0.5, 0.88, u);
    let side = normalize(cross(up, tangent(k, s)));
    let height = k.len * 0.045 * sin(u * PI * 0.9 + 0.2);
    o.world = spine(k, s) - up * (halfHeight(s) * k.len * 0.75 + v * height);
    o.normal = side;
    o.s = s;
    o.angle = 10.0 + v;
  }
  return o;
}

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) id: u32,
  @location(3) s: f32,
  @location(4) angle: f32,
}

@vertex
fn vs(@location(0) vertex: vec4f, @builtin(instance_index) id: u32) -> VsOut {
  let p = place(vertex, fish[id]);
  var o: VsOut;
  o.position = frame.viewProj * vec4f(p.world, 1.0);
  o.world = p.world;
  o.normal = p.normal;
  o.id = id;
  o.s = p.s;
  o.angle = p.angle;
  return o;
}

@vertex
fn vsShadow(@location(0) vertex: vec4f, @builtin(instance_index) id: u32) -> @builtin(position) vec4f {
  return frame.sunViewProj * vec4f(place(vertex, fish[id]).world, 1.0);
}

fn palette(variety: i32) -> array<vec3f, 3> {
  if (variety == 0) {
    return array<vec3f, 3>(vec3f(0.3, 0.33, 0.13), vec3f(0.07, 0.08, 0.03), vec3f(0.62, 0.6, 0.38));
  }
  if (variety == 1) {
    return array<vec3f, 3>(vec3f(0.42, 0.26, 0.11), vec3f(0.1, 0.055, 0.03), vec3f(0.7, 0.56, 0.36));
  }
  if (variety == 2) {
    return array<vec3f, 3>(vec3f(0.55, 0.47, 0.33), vec3f(0.16, 0.12, 0.08), vec3f(0.85, 0.8, 0.66));
  }
  // A bright orange juvenile with blue flecks.
  return array<vec3f, 3>(vec3f(0.9, 0.28, 0.03), vec3f(0.6, 0.12, 0.02), vec3f(0.15, 0.35, 0.9));
}

@fragment
fn fs(in: VsOut, @builtin(front_facing) front: bool) -> SceneOut {
  let f = fish[in.id];
  let seed = f.c.y;
  let pal = palette(i32(f.c.z + 0.5));
  var n = normalize(in.normal);
  if (!front) {
    n = -n;
  }
  let v = normalize(frame.camera.xyz - in.world);
  var albedo = pal[0];
  var rough = 0.35;
  var spec = 0.7;
  var translucency = 0.2;

  if (in.angle < 6.5) {
    let s = in.s;
    let theta = in.angle;
    let top = sin(theta);
    let around = vec2f(s * 11.0, theta * 1.6);
    let mottle = fbm3(around + seed);
    let saddle = smoothstep(0.55, 0.78, sin(s * TAU * 3.0 + seed + mottle * 2.5) * 0.5 + 0.5) * smoothstep(-0.4, 0.2, top);
    albedo = mix(pal[0], pal[1], saddle * 0.85);
    albedo = mix(albedo, pal[1], smoothstep(0.58, 0.72, mottle) * 0.6);
    let dots = voronoi(vec2f(s * 46.0, theta * 6.0) + seed);
    albedo = mix(albedo, pal[2], (1.0 - smoothstep(0.08, 0.2, dots.x)) * step(0.55, dots.z) * 0.8);
    albedo = mix(albedo, pal[2] * 1.1, smoothstep(-0.25, -0.75, top));
    // Eyes high on the head.
    let eyeAngle = select(TAU - 0.55, 0.55, cos(theta) > 0.0);
    let ed = length(vec2f((s - 0.075) * 1.0, (theta - eyeAngle) * 0.055));
    let r = 0.024;
    let iris = 1.0 - smoothstep(r * 0.9, r, ed);
    let pupil = 1.0 - smoothstep(r * 0.5, r * 0.6, ed);
    albedo = mix(albedo, vec3f(0.5, 0.35, 0.08), iris);
    albedo = mix(albedo, vec3f(0.01), pupil);
    rough = mix(0.35, 0.08, iris);
    spec = mix(0.7, 1.4, iris);
  } else {
    // Fins: translucent with banded rays.
    let across = fract(in.angle);
    let rays = smoothstep(0.6, 1.0, sin(across * 60.0) * 0.5 + 0.5);
    let bands = smoothstep(0.4, 0.8, sin(in.s * 70.0 + across * 4.0 + seed) * 0.5 + 0.5);
    albedo = mix(pal[0] * 0.9, pal[2] * 0.8, rays * 0.5);
    albedo = mix(albedo, pal[1], bands * 0.5);
    translucency = 0.8;
    rough = 0.5;
    spec = 0.3;
  }

  let s = Surface(albedo, rough, spec, 1.0, translucency);
  let color = shade(in.world, n, v, s, in.position.xy);
  return sceneOut(color, in.world);
}
