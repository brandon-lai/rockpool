// Pure helpers shared by every shader: hashing, noise, the open-sea waves.

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;

fn pcg2(v: vec2u) -> vec2u {
  var x = v * 1664525u + 1013904223u;
  x.x += x.y * 1664525u;
  x.y += x.x * 1664525u;
  x = x ^ (x >> vec2u(16u));
  x.x += x.y * 1664525u;
  x.y += x.x * 1664525u;
  x = x ^ (x >> vec2u(16u));
  return x;
}

fn hashCell(c: vec2i) -> vec2f {
  return vec2f(pcg2(bitcast<vec2u>(c))) * (1.0 / 4294967295.0);
}

fn hash1(x: f32) -> f32 {
  return hashCell(vec2i(i32(floor(x * 131.0)), 17)).x;
}

fn vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hashCell(i).x;
  let b = hashCell(i + vec2i(1, 0)).x;
  let c = hashCell(i + vec2i(0, 1)).x;
  let d = hashCell(i + vec2i(1, 1)).x;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Five octaves, roughly 0..1.
fn fbm(p: vec2f) -> f32 {
  var q = p;
  var sum = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 5; i++) {
    sum += vnoise(q) * amp;
    q = mat2x2f(1.6, 1.2, -1.2, 1.6) * q + vec2f(3.1, 1.7);
    amp *= 0.5;
  }
  return sum / 0.96875;
}

fn fbm3(p: vec2f) -> f32 {
  var q = p;
  var sum = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 3; i++) {
    sum += vnoise(q) * amp;
    q = mat2x2f(1.6, 1.2, -1.2, 1.6) * q + vec2f(3.1, 1.7);
    amp *= 0.5;
  }
  return sum / 0.875;
}

// x: distance to nearest point, y: gap to second nearest, zw: cell random.
fn voronoi(p: vec2f) -> vec4f {
  let n = floor(p);
  let f = fract(p);
  var f1 = 8.0;
  var f2 = 8.0;
  var id = vec2f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let o = hashCell(vec2i(n + g));
      let r = g + o - f;
      let d = dot(r, r);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = o;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec4f(sqrt(f1), sqrt(f2) - sqrt(f1), id);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn smax(a: f32, b: f32, k: f32) -> f32 {
  return -smin(-a, -b, k);
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// The open sea: swells rolling in toward +z, plus one travelling surge.
// o.x swell amplitude, o.y surge front z, o.z surge height, o.w surge width.
// Returns height and its x/z slopes.
fn ocean(p: vec2f, t: f32, o: vec4f) -> vec3f {
  var dirs = array<vec2f, 4>(vec2f(0.12, 1.0), vec2f(-0.3, 1.0), vec2f(0.42, 1.0), vec2f(-0.06, 1.0));
  var lens = array<f32, 4>(2.8, 1.75, 1.15, 0.72);
  var amps = array<f32, 4>(1.0, 0.55, 0.32, 0.18);
  var h = 0.0;
  var g = vec2f(0.0);
  for (var i = 0; i < 4; i++) {
    let d = normalize(dirs[i]);
    let k = TAU / lens[i];
    let w = sqrt(9.81 * k) * 0.72;
    let ph = dot(d, p) * k - w * t + f32(i) * 1.9;
    let a = amps[i] * o.x;
    h += a * sin(ph);
    g += a * k * cos(ph) * d;
  }
  if (o.z > 0.0) {
    let s = (p.y - o.y) / o.w;
    let lateral = 0.85 + 0.15 * sin(p.x * 1.7 + o.y * 0.8);
    let env = o.z * exp(-s * s) * lateral;
    h += env;
    g.y += env * (-2.0 * s / o.w);
  }
  return vec3f(h, g);
}
