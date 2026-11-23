// World layout. x runs right, y up, z toward the viewer. The open sea lies
// at -z (top of the screen); the pool sits in the middle, joined to the sea
// by a narrow gully.

export const EMBED =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('embed');

export const WATER_LEVEL = 0;

export const TERRAIN = {
  center: [0, -0.6] as const,
  half: [5.2, 3.8] as const,
  size: [1024, 744] as const,
};

export const SIM = {
  center: [0, -0.5] as const,
  half: [2.6, 2.4] as const,
  size: (EMBED ? [240, 224] : [416, 384]) as readonly [number, number],
};

export const CAUSTIC = {
  size: (EMBED ? [448, 416] : [832, 768]) as readonly [number, number],
  grid: (EMBED ? [160, 148] : [288, 266]) as readonly [number, number],
  plane: -0.22,
  margin: 0.35,
};

export const SHADOW = {
  size: EMBED ? 1024 : 2048,
  center: [0, -0.6] as const,
  half: 4.6,
};

export const COUNTS = { fish: 7, crabs: 4, anemones: 13, stars: 3, weeds: 84 };

export const MESH = {
  terrain: (EMBED ? [320, 234] : [640, 468]) as readonly [number, number],
  terrainShadow: (EMBED ? [144, 108] : [256, 188]) as readonly [number, number],
};

/** WGSL constants derived from the config, prepended to every shader. */
export function wgslConstants(): string {
  const v2 = (a: readonly number[]) => `vec2f(${a.map((n) => n.toFixed(5)).join(', ')})`;
  return /* wgsl */ `
const TERRAIN_CENTER = ${v2(TERRAIN.center)};
const TERRAIN_HALF = ${v2(TERRAIN.half)};
const TERRAIN_SIZE = vec2i(${TERRAIN.size[0]}, ${TERRAIN.size[1]});
const SIM_CENTER = ${v2(SIM.center)};
const SIM_HALF = ${v2(SIM.half)};
const SIM_SIZE = vec2i(${SIM.size[0]}, ${SIM.size[1]});
const CAUSTIC_PLANE: f32 = ${CAUSTIC.plane.toFixed(4)};
const CAUSTIC_MARGIN: f32 = ${CAUSTIC.margin.toFixed(4)};
const SHADOW_SIZE: f32 = ${SHADOW.size}.0;
const WATER_IOR: f32 = 1.333;
`;
}
