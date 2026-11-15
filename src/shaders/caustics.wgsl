// Sun caustics: refract a grid of sun rays through the simulated surface and
// measure how much each little patch of the grid is squeezed or stretched
// where it lands. Drawn once per colour channel with a slightly different
// refractive index for a faint rainbow fringe.

override columns: u32 = 288u;
override rows: u32 = 266u;
override ior: f32 = 1.333;

struct CausticOut {
  @builtin(position) position: vec4f,
  @location(0) still: vec2f,
  @location(1) bent: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> CausticOut {
  let c = index % columns;
  let r = index / columns;
  let g = vec2f(f32(c), f32(r)) / vec2f(f32(columns - 1u), f32(rows - 1u));
  let xz = SIM_CENTER + (g * 2.0 - 1.0) * (SIM_HALF + CAUSTIC_MARGIN);
  let s = textureSampleLevel(surfaceA, linearClamp, simUv(xz), 0.0);
  let n = normalize(vec3f(-s.y, 1.0, -s.z));
  let flatDir = refract(-frame.sunDir.xyz, vec3f(0.0, 1.0, 0.0), 1.0 / ior);
  let dir = refract(-frame.sunDir.xyz, n, 1.0 / ior);
  let start = vec3f(xz.x, s.x, xz.y);
  let travel = (CAUSTIC_PLANE - s.x) / min(dir.y, -0.05);
  let hit = start + dir * travel;
  // Shift back by the calm-water offset so a still pool maps 1:1.
  let calm = (CAUSTIC_PLANE) / min(flatDir.y, -0.05);
  let bent = hit.xz - flatDir.xz * calm;
  let uv = simUv(bent);
  var o: CausticOut;
  o.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  o.still = xz;
  o.bent = bent;
  return o;
}

@fragment
fn fs(in: CausticOut) -> @location(0) vec4f {
  let stillArea = abs(determinant(mat2x2f(dpdx(in.still), dpdy(in.still))));
  let bentArea = abs(determinant(mat2x2f(dpdx(in.bent), dpdy(in.bent))));
  let intensity = min(stillArea / max(bentArea, 1e-12), 7.0);
  return vec4f(vec3f(intensity), 1.0);
}
