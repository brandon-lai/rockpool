// Sea anemones: a column, an oral disc and two rings of tentacles that sway
// with the water and fold in when the anemone closes.

struct Anemone {
  a: vec4f, // base position xyz, size
  b: vec4f, // up normal xyz, open 0..1
  c: vec4f, // flow x, flow z, seed, variety
}

@group(2) @binding(0) var<storage, read> anemones: array<Anemone>;

const TENTACLES: f32 = 40.0;

struct Placed {
  world: vec3f,
  normal: vec3f,
  uv: vec2f,
}

fn tangentBasis(up: vec3f) -> mat2x3f {
  var refAxis = vec3f(0.0, 0.0, 1.0);
  if (abs(up.z) > 0.9) {
    refAxis = vec3f(1.0, 0.0, 0.0);
  }
  let t1 = normalize(cross(up, refAxis));
  let t2 = cross(up, t1);
  return mat2x3f(t1, t2);
}

fn place(vertex: vec4f, an: Anemone) -> Placed {
  let part = i32(vertex.x + 0.5);
  let u = vertex.y;
  let v = vertex.z;
  let base = an.a.xyz;
  let size = an.a.w;
  let up = normalize(an.b.xyz);
  let open = an.b.w;
  let seed = an.c.z;
  let tb = tangentBasis(up);
  let height = size * mix(0.22, 0.6, open);
  let discR = size * mix(0.28, 0.55, open);
  var o: Placed;

  if (part == 0) {
    let theta = v * TAU;
    let radial = tb[0] * cos(theta) + tb[1] * sin(theta);
    let squat = 1.0 - u * u * (1.0 - open) * 0.55;
    let r = size * mix(0.5, 0.42, u) * squat * (1.0 + 0.05 * sin(theta * 7.0 + seed));
    let lean = vec3f(an.c.x, 0.0, an.c.y) * u * u * size * 0.4;
    o.world = base + up * (u * height - size * 0.06) + radial * r + lean;
    o.normal = normalize(radial + up * (u * u * (1.0 - open) * 0.8));
    o.uv = vec2f(u, theta);
  } else if (part == 1) {
    let theta = v * TAU;
    let radial = tb[0] * cos(theta) + tb[1] * sin(theta);
    let lean = vec3f(an.c.x, 0.0, an.c.y) * size * 0.4;
    o.world = base + up * (height - u * u * size * 0.04) + radial * (1.0 - u) * mix(discR * 1.05, size * 0.3, 1.0 - open) + lean;
    o.normal = normalize(up + radial * (1.0 - u) * 0.2);
    o.uv = vec2f(1.0 - u, theta);
  } else {
    let k = f32(part - 2);
    let ring = k % 2.0;
    let alpha = (k + ring * 0.5) / TENTACLES * TAU + seed;
    let radial = tb[0] * cos(alpha) + tb[1] * sin(alpha);
    let across = cross(up, radial);
    let lean = vec3f(an.c.x, 0.0, an.c.y) * size * 0.4;
    let start = base + up * height + radial * discR * select(0.95, 0.72, ring > 0.5) + lean;
    let rnd = hashCell(vec2i(i32(k), i32(seed * 100.0))).x;
    let len = size * (0.5 + 0.3 * rnd) * mix(0.06, 1.0, open) * select(1.0, 0.8, ring > 0.5);
    let lift = mix(1.25, select(0.35, 0.7, ring > 0.5), open);
    let outward = mix(-0.35, cos(lift), open);
    let t = frame.camera.w;
    let wobble = across * sin(t * 1.4 + k * 1.3 + seed) * 0.18 + radial * sin(t * 0.9 + k * 0.7) * 0.08;
    let flow = vec3f(an.c.x, 0.0, an.c.y) * 2.2;
    let dir = radial * outward + up * sin(lift);
    let curve = (wobble + flow) * u * u - up * u * u * 0.45 * open;
    let center = start + (dir * u + curve) * len;
    let next = start + (dir * (u + 0.05) + (wobble + flow) * (u + 0.05) * (u + 0.05) - up * (u + 0.05) * (u + 0.05) * 0.45 * open) * len;
    let tangent = normalize(next - center + vec3f(1e-6));
    let n1 = normalize(cross(tangent, across + vec3f(1e-4)));
    let n2 = cross(tangent, n1);
    let theta = v * TAU;
    let tip = sqrt(max(1.0 - pow(u, 6.0), 0.0));
    let r = size * 0.06 * (1.0 - 0.4 * u) * tip * mix(0.5, 1.0, open);
    let n = n1 * cos(theta) + n2 * sin(theta);
    o.world = center + n * r;
    o.normal = n;
    o.uv = vec2f(u, 10.0 + k);
  }
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
  let p = place(vertex, anemones[id]);
  var o: VsOut;
  o.position = frame.viewProj * vec4f(p.world, 1.0);
  o.world = p.world;
  o.normal = p.normal;
  o.uv = p.uv;
  o.id = id;
  o.part = vertex.x;
  return o;
}

@vertex
fn vsShadow(@location(0) vertex: vec4f, @builtin(instance_index) id: u32) -> @builtin(position) vec4f {
  return frame.sunViewProj * vec4f(place(vertex, anemones[id]).world, 1.0);
}

@fragment
fn fs(in: VsOut, @builtin(front_facing) front: bool) -> SceneOut {
  let an = anemones[in.id];
  var n = normalize(in.normal);
  if (!front) {
    n = -n;
  }
  let v = normalize(frame.camera.xyz - in.world);
  let variety = i32(an.c.w + 0.5);
  let part = i32(in.part + 0.5);
  var column = array<vec3f, 4>(vec3f(0.2, 0.25, 0.15), vec3f(0.08, 0.25, 0.13), vec3f(0.36, 0.03, 0.05), vec3f(0.3, 0.3, 0.26));
  var tentacle = array<vec3f, 4>(vec3f(0.36, 0.5, 0.3), vec3f(0.12, 0.5, 0.28), vec3f(0.46, 0.04, 0.06), vec3f(0.36, 0.4, 0.32));
  var tip = array<vec3f, 4>(vec3f(0.85, 0.32, 0.55), vec3f(0.3, 0.75, 0.5), vec3f(0.55, 0.08, 0.1), vec3f(0.6, 0.18, 0.62));
  var albedo = column[variety];
  var translucency = 0.3;
  var rough = 0.4;

  if (part == 0) {
    let spots = voronoi(vec2f(in.uv.y * 4.0, in.uv.x * 8.0) + an.c.z);
    albedo = mix(albedo, albedo * 0.45, (1.0 - smoothstep(0.1, 0.3, spots.x)) * step(0.5, spots.z));
    // Beadlets carry blue warts under the tentacles.
    if (variety == 2) {
      let bead = (1.0 - smoothstep(0.12, 0.2, spots.x)) * smoothstep(0.8, 0.95, in.uv.x);
      albedo = mix(albedo, vec3f(0.08, 0.18, 0.6), bead);
    }
  } else if (part == 1) {
    let stripes = smoothstep(0.4, 0.9, sin(in.uv.y * 12.0) * 0.5 + 0.5);
    albedo = mix(tentacle[variety] * 0.7, tip[variety] * 0.6, stripes * in.uv.x * 0.7);
    albedo = mix(albedo, vec3f(0.06, 0.03, 0.03), smoothstep(0.25, 0.1, in.uv.x));
  } else {
    albedo = mix(tentacle[variety], tip[variety], smoothstep(0.55, 0.95, in.uv.x));
    translucency = 0.6;
    rough = 0.3;
  }
  // A faint green glow from the fluorescent ones at night.
  var glow = vec3f(0.0);
  if (variety == 1 && part > 0) {
    glow = vec3f(0.05, 0.4, 0.2) * frame.grade.y * 0.08;
  }
  let s = Surface(albedo, rough, 0.6, 1.0, translucency);
  let color = shade(in.world, n, v, s, in.position.xy) + glow;
  return sceneOut(color, in.world);
}
