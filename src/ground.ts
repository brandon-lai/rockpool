import { TERRAIN } from './config';
import type { Vec3 } from './math';

/** CPU copy of the generated terrain, for placing and steering creatures. */
export class Ground {
  constructor(private readonly heights: Float32Array) {}

  height(x: number, z: number): number {
    const [w, h] = TERRAIN.size;
    const u = ((x - TERRAIN.center[0]) / (2 * TERRAIN.half[0]) + 0.5) * w - 0.5;
    const v = ((z - TERRAIN.center[1]) / (2 * TERRAIN.half[1]) + 0.5) * h - 0.5;
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(u)));
    const y0 = Math.max(0, Math.min(h - 2, Math.floor(v)));
    const fx = Math.max(0, Math.min(1, u - x0));
    const fy = Math.max(0, Math.min(1, v - y0));
    const i = y0 * w + x0;
    const a = this.heights[i];
    const b = this.heights[i + 1];
    const c = this.heights[i + w];
    const d = this.heights[i + w + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  normal(x: number, z: number, e = 0.03): Vec3 {
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    const n: Vec3 = [-hx, 2 * e, -hz];
    const l = Math.hypot(...n);
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  /** Inside the pool proper (not the gully or the sea) and at least this deep. */
  inPool(x: number, z: number, depth = 0.05): boolean {
    return z > -1.05 && Math.abs(x) < 2.5 && z < 1.85 && this.height(x, z) < -depth;
  }
}
