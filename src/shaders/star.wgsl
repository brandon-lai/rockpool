// Sea stars: a five-armed disc draped over the rock, arm tips slowly curling.

struct Star {
  a: vec4f, // position xyz, size
  b: vec4f, // up normal xyz, rotation
  c: vec4f, // variety, seed, curl, unused
}

@group(2) @binding(0) var<storage, read> stars: array<Star>;

fn tangentBasis(up: vec3f) -> mat2x3f {
  var refAxis = vec3f(0.0, 0.0, 1.0);
  if (abs(up.z) > 0.9) {
    refAxis = vec3f(1.0, 0.0, 0.0);
  }
  let t1 = normalize(cross(up, refAxis));
  let t2 = cross(up, t1);
  return mat2x3f(t1, t2);
}

fn arm(theta: f32, rot: f32) -> f32 {
  return pow(0.5 + 0.5 * cos(5.0 * (theta - rot)), 1.7);
}

fn starPoint(st: Star, u: f32, theta: f32) -> vec3f {
  let size = st.a.w;
  let up = normalize(st.b.xyz);
  let tb = tangentBasis(up);
  let rot = st.b.w;
  let a = arm(theta, rot);
  let armIndex = floor(((theta - rot) / TAU * 5.0) + 0.5);
  let armLen = 1.0 + (hashCell(vec2i(i32(armIndex), i32(st.c.y * 50.0))).x - 0.5) * 0.18;
  let radius = size * (0.3 + 0.7 * a * armLen);
  let thick = size * 0.17 * pow(max(1.0 - pow(u, 1.5), 0.0), 0.6) * (0.35 + 0.65 * a) + size * 0.015;
  let curl = st.c.z * pow(u, 3.0) * size * 0.25 * a * (0.6 + 0.4 * sin(frame.camera.w * 0.25 + armIndex * 1.7 + st.c.y));
  let dir = tb[0] * cos(theta) + tb[1] * sin(theta);
  return st.a.xyz + dir * u * radius + up * (thick + curl);
}

struct Placed {
  world: vec3f,
  normal: vec3f,
  local: vec2f,
}

fn place(vertex: vec4f, st: Star) -> Placed {
  let u = max(vertex.y, 0.002);
  let theta = vertex.z * TAU;
  let p = starPoint(st, u, theta);
  let du = starPoint(st, min(u + 0.01, 1.0), theta) - starPoint(st, max(u - 0.01, 0.0), theta);
  let dt = starPoint(st, u, theta + 0.01) - starPoint(st, u, theta - 0.01);
  var n = normalize(cross(du, dt));
  if (dot(n, st.b.xyz) < 0.0) {
    n = -n;
  }
  var o: Placed;
  o.world = p;
  o.normal = n;
  o.local = vec2f(cos(theta), sin(theta)) * u * (0.3 + 0.7 * arm(theta, st.b.w));
  return o;
}

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec2f,
  @location(3) @interpolate(flat) id: u32,
}

@vertex
fn vs(@location(0) vertex: vec4f, @builtin(instance_index) id: u32) -> VsOut {
  let p = place(vertex, stars[id]);
  var o: VsOut;
  o.position = frame.viewProj * vec4f(p.world, 1.0);
  o.world = p.world;
  o.normal = p.normal;
  o.local = p.local;
  o.id = id;
  return o;
}

@vertex
fn vsShadow(@location(0) vertex: vec4f, @builtin(instance_index) id: u32) -> @builtin(position) vec4f {
  return frame.sunViewProj * vec4f(place(vertex, stars[id]).world, 1.0);
}

@fragment
fn fs(in: VsOut) -> SceneOut {
  let st = stars[in.id];
  let variety = i32(st.c.x + 0.5);
  var base = array<vec3f, 3>(vec3f(0.62, 0.22, 0.04), vec3f(0.26, 0.05, 0.17), vec3f(0.55, 0.12, 0.08));
  let n = normalize(in.normal);
  let v = normalize(frame.camera.xyz - in.world);
  let cells = voronoi(in.local * 16.0 + st.c.y * 7.0);
  let spines = 1.0 - smoothstep(0.08, 0.2, cells.x);
  let net = 1.0 - smoothstep(0.02, 0.08, cells.y);
  var albedo = base[variety] * (0.85 + 0.3 * vnoise(in.local * 30.0));
  albedo = mix(albedo, vec3f(0.82, 0.74, 0.6), spines * 0.75);
  albedo = mix(albedo, base[variety] * 0.6, net * 0.4);
  let s = Surface(albedo, 0.55, 0.45, 1.0, 0.1);
  let color = shade(in.world, n, v, s, in.position.xy);
  return sceneOut(color, in.world);
}
