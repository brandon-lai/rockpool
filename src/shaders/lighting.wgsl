// Sun, sky, caustics and shadows for anything drawn in the main scene pass.

@group(1) @binding(0) var causticTex: texture_2d<f32>;
@group(1) @binding(1) var shadowMap: texture_depth_2d;
@group(1) @binding(2) var shadowSampler: sampler_comparison;

fn shadowAt(world: vec3f, n: vec3f, pixel: vec2f) -> f32 {
  let p = world + n * 0.012;
  let clip = frame.sunViewProj * vec4f(p, 1.0);
  let uv = vec2f(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || clip.z > 1.0) {
    return 1.0;
  }
  let angle = ign(pixel) * TAU;
  let rot = mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle));
  var sum = 0.0;
  for (var i = 0; i < 8; i++) {
    let r = sqrt((f32(i) + 0.5) / 8.0);
    let a = f32(i) * 2.39996;
    let o = rot * vec2f(cos(a), sin(a)) * r * 2.2 / SHADOW_SIZE;
    sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, clip.z - 0.0008);
  }
  return sum / 8.0;
}

// Direction sunlight travels once it is inside the water.
fn refractedSun() -> vec3f {
  let l = frame.sunDir.xyz;
  let r = refract(-l, vec3f(0.0, 1.0, 0.0), 1.0 / WATER_IOR);
  return select(r, vec3f(0.0, -1.0, 0.0), length(r) < 0.5);
}

fn causticAt(world: vec3f) -> vec3f {
  let d = refractedSun();
  // The caustic map is indexed by where the sun ray entered the surface.
  let t = (0.0 - world.y) / min(d.y, -0.05);
  let q = world + d * t;
  let uv = simUv(q.xz);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
    return vec3f(1.0);
  }
  return textureSampleLevel(causticTex, linearClamp, uv, 0.0).rgb;
}

struct Surface {
  albedo: vec3f,
  rough: f32,
  specular: f32,
  ao: f32,
  translucency: f32,
}

fn shade(world: vec3f, n: vec3f, v: vec3f, s: Surface, pixel: vec2f) -> vec3f {
  let water = waterSurface(world.xz);
  let depth = water.x - world.y;
  let shadow = shadowAt(world, n, pixel);

  if (depth > 0.0) {
    let toLight = -refractedSun();
    let ndl = max(dot(n, toLight), 0.0);
    let wrap = max(dot(-n, toLight), 0.0) * s.translucency;
    let path = depth / max(toLight.y, 0.15);
    let through = exp(-frame.absorption.rgb * path);
    let fade = smoothstep(0.0, 0.025, depth);
    let caustic = mix(vec3f(1.0), causticAt(world), frame.extra.z * fade);
    let sun = frame.sunColor.rgb * (ndl + wrap) * through * caustic * shadow;
    let ambient = skyAmbient(n) * exp(-frame.absorption.rgb * depth * 1.4) * s.ao;
    let spec = ggx(n, v, toLight, max(s.rough, 0.2)) * s.specular * frame.sunColor.rgb * through * shadow;
    return s.albedo * (sun + ambient) + spec * caustic;
  }

  let l = frame.sunDir.xyz;
  let ndl = max(dot(n, l), 0.0);
  let wrap = max(dot(-n, l), 0.0) * s.translucency;
  let sun = frame.sunColor.rgb * (ndl + wrap) * shadow;
  let ambient = skyAmbient(n) * s.ao;
  let spec = ggx(n, v, l, s.rough) * s.specular * frame.sunColor.rgb * shadow;
  let r = reflect(-v, n);
  let env = skyColor(normalize(vec3f(r.x, max(r.y, 0.02), r.z))) * s.specular * 0.06 * (1.0 - s.rough) * s.ao;
  return s.albedo * (sun + ambient) + spec + env;
}

struct SceneOut {
  @location(0) color: vec4f,
  @location(1) dist: vec4f,
}

fn sceneOut(color: vec3f, world: vec3f) -> SceneOut {
  var o: SceneOut;
  o.color = vec4f(color, 1.0);
  o.dist = vec4f(length(world - frame.camera.xyz), 0.0, 0.0, 1.0);
  return o;
}
