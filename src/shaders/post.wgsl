// Bloom (downsample chain, then tent upsample) and the final grade:
// exposure, Khronos PBR Neutral tone mapping, vignette, grain.

struct Post {
  params: vec4f,  // exposure, bloom strength, vignette, grain
  texel: vec4f,   // source texel size xy, threshold, time
  look: vec4f,    // saturation, contrast, unused, unused
}

@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var postSampler: sampler;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var o: VsOut;
  o.position = vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(corner.x, 1.0 - corner.y);
  return o;
}

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(source, postSampler, uv, 0.0).rgb;
}

@fragment
fn down(in: VsOut) -> @location(0) vec4f {
  let t = post.texel.xy;
  let uv = in.uv;
  var c = tap(uv) * 0.125;
  c += (tap(uv + vec2f(-t.x, -t.y)) + tap(uv + vec2f(t.x, -t.y)) + tap(uv + vec2f(-t.x, t.y)) + tap(uv + vec2f(t.x, t.y))) * 0.125;
  c += (tap(uv + vec2f(-2.0 * t.x, 0.0)) + tap(uv + vec2f(2.0 * t.x, 0.0)) + tap(uv + vec2f(0.0, -2.0 * t.y)) + tap(uv + vec2f(0.0, 2.0 * t.y))) * 0.0625;
  c += (tap(uv + vec2f(-2.0 * t.x, -2.0 * t.y)) + tap(uv + vec2f(2.0 * t.x, -2.0 * t.y)) + tap(uv + vec2f(-2.0 * t.x, 2.0 * t.y)) + tap(uv + vec2f(2.0 * t.x, 2.0 * t.y))) * 0.03125;
  if (post.texel.z > 0.0) {
    let l = max(c.r, max(c.g, c.b));
    let knee = post.texel.z * 0.5;
    let soft = clamp(l - post.texel.z + knee, 0.0, 2.0 * knee);
    let w = max(soft * soft / (4.0 * knee + 1e-4), l - post.texel.z) / max(l, 1e-4);
    c *= w;
  }
  return vec4f(c, 1.0);
}

@fragment
fn up(in: VsOut) -> @location(0) vec4f {
  let t = post.texel.xy;
  let uv = in.uv;
  var c = tap(uv) * 4.0;
  c += (tap(uv + vec2f(-t.x, 0.0)) + tap(uv + vec2f(t.x, 0.0)) + tap(uv + vec2f(0.0, -t.y)) + tap(uv + vec2f(0.0, t.y))) * 2.0;
  c += tap(uv + vec2f(-t.x, -t.y)) + tap(uv + vec2f(t.x, -t.y)) + tap(uv + vec2f(-t.x, t.y)) + tap(uv + vec2f(t.x, t.y));
  return vec4f(c / 16.0, 1.0);
}

fn neutral(color: vec3f) -> vec3f {
  let start = 0.8 - 0.04;
  let desat = 0.15;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = color - offset;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) {
    return c;
  }
  let d = 1.0 - start;
  let newPeak = 1.0 - d * d / (peak + d - start);
  c *= newPeak / peak;
  let g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
  return mix(c, vec3f(newPeak), g);
}

fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash(p: vec2f) -> f32 {
  return hashCell(vec2i(p)).x;
}

@fragment
fn composite(in: VsOut) -> @location(0) vec4f {
  let uv = in.uv;
  var c = tap(uv);
  c += textureSampleLevel(bloomTex, postSampler, uv, 0.0).rgb * post.params.y;
  c *= post.params.x;
  let centre = uv - 0.5;
  let aspect = post.texel.y / post.texel.x;
  let d = length(centre * vec2f(aspect, 1.0)) / max(aspect, 1.0) * 1.6;
  c *= 1.0 - smoothstep(0.45, 1.25, d) * post.params.z;
  c = neutral(max(c, vec3f(0.0)));
  let l = luminance(c);
  c = mix(vec3f(l), c, post.look.x);
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  c = toSrgb(c);
  c = (c - 0.5) * post.look.y + 0.5;
  let seed = floor(in.position.xy) + fract(post.texel.w) * vec2f(1931.0, 2713.0);
  let grain = hash(seed) + hash(seed + 71.0) - 1.0;
  c += grain * post.params.w + (hash(seed + 13.0) - 0.5) / 255.0;
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
