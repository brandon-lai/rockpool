import { clamp, hexToLinear, lerp, normalize, type Vec3 } from './math';

// The time of day is a set of keyframes; everything in between is blended.
// At night the "sun" is the moon.

interface Key {
  hour: number;
  name: string;
  background: string;
  sun: [azimuth: number, elevation: number];
  sunColor: string;
  sunIntensity: number;
  sunDisc: number;
  zenith: string;
  horizon: string;
  skyIntensity: number;
  stars: number;
  absorption: Vec3;
  scatter: string;
  scatterAmount: number;
  exposure: number;
  night: number;
}

const KEYS: Key[] = [
  { hour: 0, name: 'Night', background: '#05080f', sun: [-14, 46], sunColor: '#a9bcff', sunIntensity: 0.32, sunDisc: 0.2, zenith: '#0a1430', horizon: '#1d2944', skyIntensity: 0.22, stars: 1, absorption: [2.2, 0.8, 0.6], scatter: '#0d2a3a', scatterAmount: 0.4, exposure: 2.6, night: 1 },
  { hour: 5.6, name: 'Dawn', background: '#2b2633', sun: [-60, 7], sunColor: '#ffad7a', sunIntensity: 1.6, sunDisc: 0.7, zenith: '#5d6a9c', horizon: '#f0b096', skyIntensity: 0.6, stars: 0.25, absorption: [1.4, 0.62, 0.7], scatter: '#3a5a50', scatterAmount: 0.6, exposure: 1.35, night: 0.25 },
  { hour: 8.5, name: 'Morning', background: '#3b4a46', sun: [-18, 44], sunColor: '#fff0dc', sunIntensity: 3.1, sunDisc: 1, zenith: '#5f8fc8', horizon: '#cfe0ea', skyIntensity: 0.85, stars: 0, absorption: [1.35, 0.6, 0.72], scatter: '#3a6440', scatterAmount: 0.6, exposure: 0.82, night: 0 },
  { hour: 12.5, name: 'Midday', background: '#8fb4bd', sun: [-6, 64], sunColor: '#ffffff', sunIntensity: 3.5, sunDisc: 1, zenith: '#5a92d6', horizon: '#d8e8f0', skyIntensity: 1, stars: 0, absorption: [1.25, 0.52, 0.66], scatter: '#4a7a58', scatterAmount: 0.45, exposure: 0.74, night: 0 },
  { hour: 17.3, name: 'Golden hour', background: '#3a2a1c', sun: [22, 19], sunColor: '#ffc27e', sunIntensity: 2.6, sunDisc: 1, zenith: '#7f8fbf', horizon: '#f2c495', skyIntensity: 0.75, stars: 0, absorption: [1.4, 0.6, 0.72], scatter: '#5a5a30', scatterAmount: 0.6, exposure: 1.05, night: 0 },
  { hour: 19.8, name: 'Dusk', background: '#141a2c', sun: [48, 5], sunColor: '#d898b4', sunIntensity: 1.1, sunDisc: 0.6, zenith: '#2a3468', horizon: '#c0849a', skyIntensity: 0.45, stars: 0.4, absorption: [2.0, 0.7, 0.55], scatter: '#2a2a4a', scatterAmount: 0.45, exposure: 1.6, night: 0.45 },
  { hour: 21.6, name: 'Night', background: '#05080f', sun: [-14, 46], sunColor: '#a9bcff', sunIntensity: 0.32, sunDisc: 0.2, zenith: '#0a1430', horizon: '#1d2944', skyIntensity: 0.22, stars: 1, absorption: [2.2, 0.8, 0.6], scatter: '#0d2a3a', scatterAmount: 0.4, exposure: 2.6, night: 1 },
  { hour: 24, name: 'Night', background: '#05080f', sun: [-14, 46], sunColor: '#a9bcff', sunIntensity: 0.32, sunDisc: 0.2, zenith: '#0a1430', horizon: '#1d2944', skyIntensity: 0.22, stars: 1, absorption: [2.2, 0.8, 0.6], scatter: '#0d2a3a', scatterAmount: 0.4, exposure: 2.6, night: 1 },
];

export interface Look {
  name: string;
  background: string;
  sunDir: Vec3;
  sunColor: Vec3;
  sunDisc: number;
  zenith: Vec3;
  horizon: Vec3;
  skyIntensity: number;
  stars: number;
  absorption: Vec3;
  scatter: Vec3;
  scatterAmount: number;
  exposure: number;
  night: number;
}

const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function sunVector(az: number, el: number): Vec3 {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  // Azimuth 0 points out to sea (-z), positive turns toward +x.
  return normalize([Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)]);
}

export function lookAt(hour: number): Look {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].hour <= h) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const raw = clamp((h - a.hour) / (b.hour - a.hour), 0, 1);
  const t = raw * raw * (3 - 2 * raw);
  const night = lerp(a.night, b.night, t);

  // Swap the light from sun to moon through the dark middle of the blend
  // rather than sweeping the direction across the sky.
  let sunDir: Vec3;
  const aDir = sunVector(a.sun[0], a.sun[1]);
  const bDir = sunVector(b.sun[0], b.sun[1]);
  if (a.night !== b.night && Math.abs(a.night - b.night) > 0.5) {
    sunDir = t < 0.5 ? aDir : bDir;
  } else {
    sunDir = normalize(mix3(aDir, bDir, t));
  }
  const dip = a.night !== b.night && Math.abs(a.night - b.night) > 0.5 ? 1 - Math.sin(t * Math.PI) * 0.85 : 1;
  const intensity = lerp(a.sunIntensity, b.sunIntensity, t) * dip;
  const sunColor = mix3(hexToLinear(a.sunColor), hexToLinear(b.sunColor), t).map((c) => c * intensity) as Vec3;

  return {
    name: t < 0.5 ? a.name : b.name,
    background: t < 0.5 ? a.background : b.background,
    sunDir,
    sunColor,
    sunDisc: lerp(a.sunDisc, b.sunDisc, t),
    zenith: mix3(hexToLinear(a.zenith), hexToLinear(b.zenith), t),
    horizon: mix3(hexToLinear(a.horizon), hexToLinear(b.horizon), t),
    skyIntensity: lerp(a.skyIntensity, b.skyIntensity, t),
    stars: lerp(a.stars, b.stars, t),
    absorption: mix3(a.absorption, b.absorption, t),
    scatter: mix3(hexToLinear(a.scatter), hexToLinear(b.scatter), t),
    scatterAmount: lerp(a.scatterAmount, b.scatterAmount, t),
    exposure: lerp(a.exposure, b.exposure, t),
    night,
  };
}

/** Semi-diurnal tide, 0 at low water and 1 at high. */
export function tideAt(hour: number) {
  return 0.5 + 0.5 * Math.cos((2 * Math.PI * (hour - 4.3)) / 12.42);
}

export function tideLabel(hour: number) {
  const now = tideAt(hour);
  const soon = tideAt(hour + 0.2);
  if (now > 0.86) return 'High tide';
  if (now < 0.14) return 'Low tide';
  return soon > now ? 'Rising tide' : 'Falling tide';
}

export function clockLabel(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  const whole = Math.floor(h);
  const minutes = Math.floor((h - whole) * 6) * 10;
  return `${whole}:${String(minutes).padStart(2, '0')}`;
}
