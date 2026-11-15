// Composites the water over the lit scene: finds the surface along each
// view ray, then mixes the refracted scene below (absorbed and hazed by the
// depth of water it crossed) with reflected sky and rock, sun glints, foam
// and, at night, glowing plankton.

@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(1) var sceneDist: texture_2d<f32>;
@group(1) @binding(2) var shadowMap: texture_depth_2d;
@group(1) @binding(3) var shadowSampler: sampler_comparison;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  var o: VsOut;
  o.position = fullscreen(index);
  o.uv = vec2f(o.position.x * 0.5 + 0.5, 0.5 - o.position.y * 0.5);
  return o;
}

fn surfaceShadow(p: vec3f) -> f32 {
  let clip = frame.sunViewProj * vec4f(p, 1.0);
  let uv = vec2f(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
    return 1.0;
  }
  var sum = 0.0;
  for (var i = 0; i < 4; i++) {
    let a = f32(i) * 1.5708 + 0.4;
    sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(cos(a), sin(a)) * 2.0 / SHADOW_SIZE, clip.z - 0.001);
  }
  return sum * 0.25;
}

fn microRipples(p: vec2f, footprint: f32) -> vec2f {
  let t = frame.camera.w;
  let e = 0.006;
  let fade = 1.0 - smoothstep(0.004, 0.02, footprint);
  let wind = frame.extra.y;
  let q = p * 22.0 + vec2f(t * 0.9, -t * 0.6);
  let r = mat2x2f(0.8, 0.6, -0.6, 0.8) * p * 37.0 - vec2f(t * 1.3, t * 0.4);
  let gx = (vnoise(q + vec2f(e * 22.0, 0.0)) - vnoise(q - vec2f(e * 22.0, 0.0))) +
    (vnoise(r + vec2f(e * 37.0, 0.0)) - vnoise(r - vec2f(e * 37.0, 0.0))) * 0.5;
  let gz = (vnoise(q + vec2f(0.0, e * 22.0)) - vnoise(q - vec2f(0.0, e * 22.0))) +
    (vnoise(r + vec2f(0.0, e * 37.0)) - vnoise(r - vec2f(0.0, e * 37.0))) * 0.5;
  return vec2f(gx, gz) * (0.06 + 0.25 * wind) * fade;
}

fn rockReflection(p: vec3f, r: vec3f) -> vec4f {
  var travel = 0.03;
  for (var i = 0; i < 14; i++) {
    let q = p + r * travel;
    let h = terrainHeight(q.xz);
    if (h > q.y) {
      let n = terrainNormal(q.xz, 0.02);
      let lit = frame.sunColor.rgb * max(dot(n, frame.sunDir.xyz), 0.0) * 0.5 + skyAmbient(n);
      let tone = mix(0.07, 0.2, fbm3(q.xz * 1.3));
      return vec4f(lit * tone, 1.0);
    }
    travel *= 1.32;
  }
  return vec4f(0.0);
}

fn foamPattern(p: vec2f, t: f32) -> f32 {
  let v = voronoi(p * 26.0 + vec2f(fbm3(p * 4.0 + t * 0.2)) * 2.0);
  let bubbles = smoothstep(0.02, 0.12, v.y);
  let streaks = fbm3(p * 9.0 + vec2f(t * 0.15, t * 0.3));
  return mix(bubbles, 1.0, smoothstep(0.55, 0.8, streaks));
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let px = vec2i(in.position.xy);
  let scene = textureLoad(sceneColor, px, 0);
  let dist = textureLoad(sceneDist, px, 0).x;
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let farPoint = frame.invViewProj * vec4f(ndc, 1.0, 1.0);
  let origin = frame.camera.xyz;
  let dir = normalize(farPoint.xyz / farPoint.w - origin);
  if (dir.y > -0.002) {
    return scene;
  }

  var travel = -origin.y / dir.y;
  for (var i = 0; i < 3; i++) {
    let q = origin + dir * travel;
    travel = (waterSurface(q.xz).x - origin.y) / dir.y;
  }
  if (travel > dist - 0.0004) {
    return scene;
  }

  let t = frame.camera.w;
  let p = origin + dir * travel;
  let sample = waterSurface(p.xz);
  let extras = waterExtras(p.xz);
  let footprint = travel * frame.grade.w;
  let ripple = microRipples(p.xz, footprint);
  let n = normalize(vec3f(-sample.y - ripple.x, 1.0, -sample.z - ripple.y));
  let calm = normalize(vec3f(-sample.y * 0.75 - ripple.x * 0.3, 1.0, -sample.z * 0.75 - ripple.y * 0.3));
  let view = -dir;
  let cosine = clamp(dot(n, view), 0.0, 1.0);
  let fresnel = 0.02 + 0.98 * pow(1.0 - cosine, 5.0);

  // Refraction: look into the scene along the bent ray.
  let below = max(dist - travel, 0.0);
  let bent = refract(dir, calm, 1.0 / WATER_IOR);
  let unbent = refract(dir, vec3f(0.0, 1.0, 0.0), 1.0 / WATER_IOR);
  let reach = min(below, 0.8);
  let aimed = p + (bent - unbent) * reach * 1.3 + dir * reach;
  let clip = frame.viewProj * vec4f(aimed, 1.0);
  let size = frame.resolution.xy;
  let shiftedUv = clamp(vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5), vec2f(0.0), vec2f(0.999));
  let shiftedPx = vec2i(shiftedUv * size);
  let shiftedDist = textureLoad(sceneDist, shiftedPx, 0).x;
  let useShifted = shiftedDist > travel + 0.004;
  let seen = select(scene.rgb, textureSampleLevel(sceneColor, linearClamp, shiftedUv, 0.0).rgb, useShifted);
  let span = select(below, max(shiftedDist - travel, 0.0), useShifted);

  let absorb = frame.absorption.rgb;
  let transmit = exp(-absorb * span);
  let shadow = surfaceShadow(p);
  let light = frame.sunColor.rgb * max(frame.sunDir.y, 0.0) * (0.3 + 0.7 * shadow) + skyAmbient(vec3f(0.0, 1.0, 0.0));
  let medium = absorb + 0.05;
  let deep = smoothstep(0.35, 1.2, span);
  let hazeColor = mix(frame.scatter.rgb, vec3f(0.03, 0.16, 0.2), deep * 0.85);
  let haze = hazeColor * frame.scatter.w * light * (1.0 - exp(-medium * span)) / medium * 0.35;

  // Reflection: rocks if the reflected ray hits them, else the sky.
  var r = reflect(dir, n);
  r.y = max(r.y, 0.02);
  let rock = rockReflection(p, normalize(r));
  let reflection = mix(skyColor(normalize(r)), rock.rgb, rock.a);

  let glint = frame.sunColor.rgb * frame.sunColor.w * shadow * 0.6 *
    (ggx(n, view, frame.sunDir.xyz, 0.035) * 0.6 + ggx(n, view, frame.sunDir.xyz, 0.09) * 0.12 + ggx(n, view, frame.sunDir.xyz, 0.22) * 0.04);

  var color = (1.0 - fresnel) * (seen * transmit + haze) + fresnel * reflection + glint;

  // Foam: from the simulation, around the outer rocks and on the surge.
  let terrainH = terrainHeight(p.xz);
  let shore = 1.0 - smoothstep(0.0, 0.05 + 0.04 * frame.extra.w, sample.x - terrainH);
  let seaSide = 1.0 - smoothstep(-2.7, -1.6, p.z);
  let crest = smoothstep(0.035, 0.07, sample.x) * seaSide;
  let pattern = foamPattern(p.xz, t);
  let foamAmount = clamp(extras.x * 1.2 + (shore * (0.35 + frame.extra.w) * seaSide + crest) * pattern, 0.0, 1.0) * pattern;
  let foamColor = vec3f(0.9, 0.93, 0.95) * light * 0.95;
  color = mix(color, foamColor, foamAmount * 0.9);

  // Plankton glow at night where the water is disturbed.
  let sparkle = smoothstep(0.6, 0.95, vnoise(p.xz * 140.0 + t * 3.0));
  color += vec3f(0.15, 0.65, 1.0) * extras.y * frame.grade.z * (0.35 + 1.6 * sparkle);

  // Soften the line where water meets rock.
  let edge = smoothstep(0.0, 0.006, span);
  color = mix(scene.rgb, color, edge);
  return vec4f(color, 1.0);
}
