// Seaweed: rockweed straps, sea lettuce and surfgrass, rooted on the rock.
// Fronds lean with the moving water and lie flat where they reach the
// surface.

struct Weed {
  a: vec4f, // base xyz, length
  b: vec4f, // up normal xyz, width
  c: vec4f, // heading, seed, variety, unused
}

@group(2) @binding(0) var<storage, read> weeds: array<Weed>;

fn centerline(w: Weed, u: f32, flow: vec2f) -> vec3f {
  let up = normalize(w.b.xyz);
  let heading = vec3f(cos(w.c.x), 0.0, sin(w.c.x));
  let t = frame.camera.w;
  let seed = w.c.y;
  let wobble = vec3f(sin(t * 0.9 + seed * 7.0 + u * 2.0), 0.0, cos(t * 0.7 + seed * 3.0 - u * 2.5)) * 0.18;
  let push = vec3f(flow.x, 0.0, flow.y) * 3.0 + wobble;
  let rise = select(0.75, 0.95, w.c.z > 1.5);
  var p = w.a.xyz + (up * rise + heading * (1.0 - rise) * 1.4) * w.a.w * u + push * w.a.w * u * u;
  let surface = waterSurface(p.xz).x - 0.004;
  if (p.y > surface) {
    // Float along the surface rather than poke through it.
    let over = p.y - surface;
    p = vec3f(p.x + heading.x * over * 0.8, surface - over * 0.02, p.z + heading.z * over * 0.8);
  }
  return p;
}

struct Placed {
  world: vec3f,
  normal: vec3f,
  uv: vec2f,
}

fn place(vertex: vec4f, w: Weed) -> Placed {
  let u = vertex.y;
  let v = vertex.z - 0.5;
  let flowSample = textureSampleLevel(surfaceA, linearClamp, simUv(w.a.xz), 0.0);
  let flow = -flowSample.yz * 0.6;
  let c = centerline(w, u, flow);
  let next = centerline(w, min(u + 0.04, 1.0), flow);
  let prev = centerline(w, max(u - 0.04, 0.0), flow);
  let tangent = normalize(next - prev + vec3f(1e-6));
  let twist = w.c.y * 6.0 + u * 2.0;
  var side = normalize(cross(tangent, vec3f(cos(twist), 0.4, sin(twist))));
  let variety = i32(w.c.z + 0.5);
  var width = w.b.w;
  if (variety == 0) {
    width *= 0.45 * (1.0 - 0.45 * u) + 0.08;
  } else if (variety == 1) {
    width *= (0.35 + 0.9 * sin(min(u * 1.3, 1.0) * PI)) ;
  } else {
    width *= 0.1;
  }
  let ruffle = select(0.0, sin(v * 18.0 + u * 30.0 + w.c.y) * 0.25, variety == 1);
  let n = normalize(cross(side, tangent));
  var o: Placed;
  o.world = c + side * v * width + n * ruffle * width * abs(v);
  o.normal = n;
  o.uv = vec2f(u, v);
  return o;
}

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) id: u32,
}

@vertex
fn vs(@location(0) vertex: vec4f, @builtin(instance_index) id: u32) -> VsOut {
  let p = place(vertex, weeds[id]);
  var o: VsOut;
  o.position = frame.viewProj * vec4f(p.world, 1.0);
  o.world = p.world;
  o.normal = p.normal;
  o.uv = p.uv;
  o.id = id;
  return o;
}

@vertex
fn vsShadow(@location(0) vertex: vec4f, @builtin(instance_index) id: u32) -> @builtin(position) vec4f {
  return frame.sunViewProj * vec4f(place(vertex, weeds[id]).world, 1.0);
}

@fragment
fn fs(in: VsOut, @builtin(front_facing) front: bool) -> SceneOut {
  let w = weeds[in.id];
  var n = normalize(in.normal);
  if (!front) {
    n = -n;
  }
  let v = normalize(frame.camera.xyz - in.world);
  let variety = i32(w.c.z + 0.5);
  var base = array<vec3f, 3>(vec3f(0.2, 0.15, 0.04), vec3f(0.12, 0.3, 0.05), vec3f(0.07, 0.26, 0.06));
  var albedo = base[variety] * (0.85 + 0.3 * vnoise(in.uv * vec2f(20.0, 4.0) + w.c.y));
  if (variety == 0) {
    // Midrib and air bladders on the rockweed.
    let rib = 1.0 - smoothstep(0.0, 0.08, abs(in.uv.y));
    albedo = mix(albedo, albedo * 0.6, rib);
    let bladder = smoothstep(0.7, 0.9, sin(in.uv.x * 26.0 + w.c.y) * 0.5 + 0.5) * smoothstep(0.25, 0.05, abs(in.uv.y));
    albedo = mix(albedo, vec3f(0.32, 0.26, 0.07), bladder * 0.7);
  }
  if (variety == 1) {
    albedo = mix(albedo, albedo * 1.35, smoothstep(0.3, 0.5, abs(in.uv.y)));
  }
  let s = Surface(albedo, 0.35, 0.55, 1.0, 0.7);
  let color = shade(in.world, n, v, s, in.position.xy);
  return sceneOut(color, in.world);
}
